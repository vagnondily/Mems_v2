import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { newId } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { requireSuper } from "../lib/auth.js";
import {
  INTERPRETEURS, FICHIER_DONNEES,
  etatMoteur, etatMoteurs, moteurActif, placeLibre, executer, fichierResultat,
} from "../lib/moteur.js";

/* ═══════════════════════════════════════════════════════════════════════════
   Exécution des scripts d'analyse rédigés dans Analyses → Scripts d'analyse.

   L'interface les écrivait et les téléchargeait pour qu'ils soient exécutés
   ailleurs ; ces routes les exécutent sur le serveur. C'est de l'exécution de
   code arbitraire : les limites sont dans lib/moteur.js, qui dit aussi, en
   toutes lettres, ce que l'isolement ne garantit pas.

   Tout le routeur est réservé au super-utilisateur — pas à la capacité
   « admin », voir le pourquoi auprès de requireSuper dans lib/auth.js.
   ═══════════════════════════════════════════════════════════════════════════ */
const r = Router();
r.use(requireSuper);

/* Comment activer la fonction, dit à l'exploitant et non au journal : c'est la
   seule réponse utile quand un super-utilisateur clique sur « Exécuter » et que
   rien ne se passe. */
const commentActiver = () =>
  "l'exécution de scripts est désactivée. Déclarez le chemin absolu de "
  + Object.values(INTERPRETEURS).map(d => `${d.variable} (${d.libelle})`).join(" et/ou ")
  + " dans le fichier .env du serveur, puis redémarrez-le. Sans cela aucun script "
  + "n'est exécuté sur cette instance.";

/* Ce que l'interface a besoin de savoir avant d'afficher un bouton « Exécuter ».
   Répond 200 même quand rien n'est déclaré : c'est un état à afficher, pas un
   échec — le 503 est réservé à la tentative d'exécution elle-même. */
r.get("/moteurs", (req, res) => {
  res.json({ actif: moteurActif(), fichierDonnees: FICHIER_DONNEES, moteurs: etatMoteurs() });
});

const corps = z.object({
  /* Le jeu de données déjà apuré par l'interface. Absent, on retombe sur les
     lignes brutes enregistrées avec le jeu de données : les règles d'apurement
     sont appliquées côté client (web/src/views/Analytics.jsx), le serveur ne
     les rejoue pas et ne prétend pas le contraire. */
  lignes: z.array(z.record(z.any())).optional(),
});

r.post("/:id/executer", async (req, res, next) => {
  const script = await db.prepare("SELECT * FROM scripts WHERE id=?").get(req.params.id);
  if(!script) return res.status(404).json({ error:"script introuvable" });

  const moteur = etatMoteur(script.language);
  if(!moteur.disponible){
    /* Trois situations, trois réponses : la variable est renseignée mais
       fautive — on rend la raison exacte ; un autre interpréteur tourne mais
       pas celui-là — on le dit ; rien n'est déclaré — on explique comment
       activer la fonction, ce que personne d'autre ne dira à l'exploitant. */
    const error = moteur.declare
      ? `${moteur.libelle} n'est pas exécutable ici : ${moteur.raison}`
      : moteurActif()
        ? `${moteur.libelle} n'est pas déclaré sur cette instance (${moteur.variable})`
        : commentActiver();
    return res.status(503).json({ error, moteurs: etatMoteurs() });
  }

  const p = corps.safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error:"corps de requête invalide" });

  let lignes = p.data.lignes;
  if(!lignes){
    const ds = script.dataset_id
      ? await db.prepare("SELECT * FROM datasets WHERE id=?").get(script.dataset_id) : null;
    if(!ds) return res.status(422).json({
      error:"ce script n'est relié à aucun jeu de données ; reliez-en un ou transmettez « lignes »" });
    /* `datasets.raw` est du json (pas jsonb) : pg le renvoie déjà désérialisé,
       et le type `json` préserve l'ordre des colonnes — l'export CSV en dépend. */
    lignes = ds.raw;
    if(!Array.isArray(lignes)) lignes = [];
  }
  const lignesMax = config.analyse.lignesMax;
  if(lignes.length > lignesMax) return res.status(413).json({
    error:`jeu de données de ${lignes.length} lignes, au-delà de la limite de ${lignesMax}` });

  if(!placeLibre()) return res.status(429).json({
    error:"une autre analyse est en cours ; réessayez dans un instant" });

  executer({ lang:script.language, code:script.code, lignes, userId:req.user.id })
    .then(async x => {
      await journaliser(req, script, x);
      res.json({ execution: {
        id:x.id, statut:x.statut, moteur:x.moteur, langage:x.lang,
        code:x.code, signal:x.signal, dureeMs:x.dureeMs,
        lignes:x.lignes, sortie:x.sortie, erreur:x.erreur,
        /* Dit explicitement quand la sortie a été coupée : une conclusion tirée
           d'un tableau tronqué sans le savoir est une conclusion fausse. */
        tronque:x.tronque, sortieTronquee:x.sortieTronquee, erreurTronquee:x.erreurTronquee,
        fichiers: x.fichiers.map(f => ({ ...f,
          url:`/api/scripts/executions/${x.id}/fichiers/${encodeURIComponent(f.nom)}` })),
        fichiersEcartes: x.fichiersEcartes,
        message: x.statut === "delai"
          ? "délai dépassé : le script et tous les processus qu'il avait lancés ont été arrêtés"
          : x.message || null,
      } });
    })
    .catch(e => {
      if(e.indisponible) return res.status(503).json({ error:e.message });
      if(e.tropGros)     return res.status(413).json({ error:e.message });
      next(e);
    });
});

/* Les fichiers produits par le script — graphiques, CSV de sortie. Servis en
   pièce jointe et jamais rendus dans la page : un script qui écrit un .html ou
   un .svg le fait exécuter dans l'origine de MEMS s'il est affiché en ligne.
   Le nom repris dans l'en-tête a été filtré à la récolte (lib/moteur.js,
   NOM_SUR) : ni guillemet, ni retour à la ligne, donc rien à y injecter. */
r.get("/executions/:execId/fichiers/:nom", (req, res) => {
  const f = fichierResultat(req.params.execId, req.params.nom, req.user.id);
  if(!f) return res.status(404).json({
    error:"fichier introuvable, expiré, ou produit par l'exécution d'un autre compte" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${f.nom}"`);
  res.sendFile(f.chemin);
});

/* Toute exécution laisse une trace, réussie ou non : qui, quel script, quel
   interpréteur, combien de temps, avec quel code de sortie, et si la sortie a
   été tronquée. Le journal de sécurité — kind='securite' — parce qu'exécuter du
   code sur le serveur en relève, et non de l'activité courante du programme. */
async function journaliser(req, script, x){
  const detail = [
    x.moteur,
    `${(x.dureeMs/1000).toFixed(1)} s`,
    x.statut === "delai" ? "DÉLAI DÉPASSÉ, groupe de processus tué"
      : `code de sortie ${x.code === null ? "aucun" : x.code}`,
    `${x.lignes} lignes`,
    `${x.fichiers.length} fichier(s) produit(s)`,
    x.tronque ? "sortie tronquée" : "sortie complète",
  ].join(" — ");
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','scripts',?,'execute',?)`)
    .run(newId("aud"), req.user.id, req.user.email, script.id,
         `Script « ${script.name} » exécuté sur le serveur — ${detail}`);
  log.warn("script d'analyse exécuté", { script:script.id, par:req.user.id,
    moteur:x.moteur, statut:x.statut, ms:x.dureeMs });
}

export default r;
