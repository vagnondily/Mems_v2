import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { validate } from "../lib/validate.js";
import { newId } from "../lib/crypto.js";
import { requireSuper } from "../lib/auth.js";
import { sauvegarder, restaurer, verifier, listerSauvegardes, cheminSauvegarde,
         dossierSauvegardes, prendreVerrou, rendreVerrou, entretienEnCours }
  from "../lib/sauvegarde.js";

/* ═══════════════════════════════════════════════════════════════════════
   Administration de l'instance — réservée au super-utilisateur.

   `super` et `admin` avaient exactement les mêmes capacités (lib/auth.js,
   matrice CAPS) : le rôle existait sans rien apporter. Ce qui le distingue
   désormais n'est pas « plus de droits sur les mêmes objets » — un admin
   gère déjà comptes, bureaux et référentiels — mais un objet différent :
   l'INSTANCE elle-même. Sessions ouvertes, journal de sécurité, état du
   fichier de base, sauvegarde et restauration ne concernent pas la donnée
   métier ; ils concernent celui qui exploite le serveur.

   C'est aussi la raison pour laquelle ces routes sont toutes journalisées
   sous le genre `securite` : ce sont les seules actions de l'application
   qu'aucun autre contrôle ne borne. Le journal est le contre-pouvoir.

   Sur le SECRET : aucune route ci-dessous ne lit `pw_hash`, `token_enc` ni
   `secret_enc`. Les états de santé comptent des LIGNES, jamais leur contenu ;
   le journal d'audit ne porte que des libellés écrits par l'application. La
   seule sortie qui contienne ces colonnes est le fichier de sauvegarde, où
   elles restent respectivement des empreintes bcrypt et du chiffré AES-GCM
   dont la clé vit hors de la base (voir lib/sauvegarde.js). ═════════════ */

const r = Router();

/* Une seule ligne ferme tout le routeur : aucune route ci-dessous ne peut être
   ajoutée par mégarde sans le garde. L'authentification, elle, est posée au
   montage (index.js) comme pour tous les autres routeurs. */
r.use(requireSuper);

/* Toute action d'administration laisse une trace, sans exception. Le genre
   `securite` la tient hors du fil d'activité que /api/state sert à tous
   (state.js:176, `kind<>'securite'`) : l'entretien de l'instance n'est pas
   de l'activité métier, et n'a rien à faire dans le fil de chacun. */
const tracer = (req, { entity, entity_id = null, action, text }) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite',?,?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email, entity, entity_id, action, text);

/* ═══════════════════════════════════════════════════════════════════════
   2. JOURNAL D'AUDIT
   La table `audit` est écrite par une vingtaine de routes depuis l'origine et
   n'était lisible par personne : /api/state en sert soixante lignes, sans
   filtre, et masque justement le genre `securite` — donc les connexions, les
   échecs de connexion et les changements de mot de passe. Autant dire que la
   partie du journal qui sert à une enquête était la seule inaccessible.
   ═══════════════════════════════════════════════════════════════════════ */

/* Une date seule est ambiguë : `at <= '2026-08-01'` exclut tout le 1ᵉʳ août,
   parce que « 2026-08-01 09:12:00 » lui est supérieur en comparaison de
   chaînes. On complète donc la borne haute à la fin de la journée, et la
   borne basse à son début — ce que l'utilisateur veut dire quand il écrit
   une date sans heure. */
const JOUR = /^\d{4}-\d{2}-\d{2}$/;
const bornee = (v, fin) => !v ? null : (JOUR.test(v) ? `${v} ${fin ? "23:59:59" : "00:00:00"}` : v);

const dateFiltre = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/,
         "date attendue au format AAAA-MM-JJ ou AAAA-MM-JJ HH:MM:SS")
  .optional();

const journalQuery = z.object({
  depuis:  dateFiltre,
  jusqu_a: dateFiltre,
  user_id: z.string().max(64).optional(),
  kind:    z.string().max(40).optional(),
  entity:  z.string().max(60).optional(),
  action:  z.string().max(60).optional(),
  /* Recherche libre sur le libellé — c'est le seul champ rédigé. */
  q:       z.string().max(120).optional(),
  page:    z.coerce.number().int().min(1).default(1),
  taille:  z.coerce.number().int().min(1).max(200).default(50),
}).strict();

r.get("/journal", validate(journalQuery, "query"), (req, res) => {
  const f = req.query;
  const ou = []; const args = [];
  const ajout = (sql, valeur) => { if(valeur != null && valeur !== ""){ ou.push(sql); args.push(valeur); } };

  ajout("at >= ?", bornee(f.depuis, false));
  ajout("at <= ?", bornee(f.jusqu_a, true));
  ajout("user_id = ?", f.user_id);
  ajout("kind = ?", f.kind);
  ajout("entity = ?", f.entity);
  ajout("action = ?", f.action);
  /* `%` et `_` saisis par l'utilisateur sont des jokers LIKE : on les
     neutralise, sinon « 100 % » ramènerait tout le journal. */
  ajout("text LIKE ? ESCAPE '\\'", f.q
    ? `%${f.q.replace(/[\\%_]/g, c => "\\" + c)}%` : null);

  const where = ou.length ? `WHERE ${ou.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) c FROM audit ${where}`).get(...args).c;
  const lignes = db.prepare(
    `SELECT id, at, user_id, user_label, office, kind, entity, entity_id, action, text
     FROM audit ${where} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, f.taille, (f.page - 1) * f.taille);

  res.json({ total, page:f.page, taille:f.taille,
    pages: Math.max(1, Math.ceil(total / f.taille)), lignes });
});

/* Les valeurs réellement présentes, pour que les filtres ci-dessus soient
   proposables plutôt que devinables. */
r.get("/journal/facettes", (req, res) => {
  const distinct = (col) => db.prepare(
    `SELECT ${col} v, COUNT(*) n FROM audit WHERE ${col} IS NOT NULL
     GROUP BY ${col} ORDER BY n DESC`).all();
  const bornes = db.prepare("SELECT MIN(at) premier, MAX(at) dernier FROM audit").get();
  res.json({
    kinds: distinct("kind"), entities: distinct("entity"), actions: distinct("action"),
    comptes: db.prepare(
      `SELECT a.user_id, a.user_label, COUNT(*) n FROM audit a
       WHERE a.user_id IS NOT NULL GROUP BY a.user_id, a.user_label ORDER BY n DESC LIMIT 100`).all(),
    bornes,
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   3. SANTÉ ET ENTRETIEN DE LA BASE
   ═══════════════════════════════════════════════════════════════════════ */

const octetsDe = (chemin) => { try{ return fs.statSync(chemin).size; }catch{ return 0; } };

const tailles = () => {
  const base = path.resolve(config.dbFile);
  const principal = octetsDe(base), wal = octetsDe(base + "-wal"), shm = octetsDe(base + "-shm");
  return { chemin:base, principal, wal, shm, total: principal + wal + shm };
};

r.get("/base", (req, res) => {
  const violations = db.pragma("foreign_key_check");
  const pragma = (nom) => db.pragma(nom, { simple:true });
  /* `integrity_check` parcourt la base entière : on le lit UNE fois et on s'en
     sert deux, plutôt que de payer deux balayages pour la même réponse. */
  const integrite = pragma("integrity_check");
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`).all()
    /* On compte des lignes, jamais leur contenu : cette route ne doit rien
       laisser filtrer de la donnée, et surtout pas des tables qui portent des
       colonnes chiffrées. */
    .map(t => ({ nom:t.name, lignes: db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c }));

  res.json({
    fichier: tailles(),
    integrite: {
      integrity_check: integrite,
      violations_cles_etrangeres: violations.length,
      detail_violations: violations.slice(0, 50),
      conforme: integrite === "ok" && violations.length === 0,
    },
    reglages: {
      journal_mode: pragma("journal_mode"), page_size: pragma("page_size"),
      page_count: pragma("page_count"), freelist_count: pragma("freelist_count"),
      auto_vacuum: pragma("auto_vacuum"), foreign_keys: pragma("foreign_keys"),
      busy_timeout: pragma("busy_timeout"),
    },
    /* Les pages libres sont ce qu'un VACUUM récupérerait : c'est le seul
       chiffre qui permette de décider s'il vaut la peine d'être lancé. */
    recuperable_par_vacuum: pragma("freelist_count") * pragma("page_size"),
    tables,
    migrations: db.prepare("SELECT name, applied_at FROM _migrations ORDER BY name").all(),
    entretien_en_cours: entretienEnCours(),
    sauvegardes: listerSauvegardes().length,
  });
});

/* Les deux opérations d'entretien passent par le même sas : verrou pris,
   durée mesurée, verrou rendu quoi qu'il arrive. Elles bloquent — c'est leur
   nature — donc on refuse plutôt que d'empiler. */
function sousVerrou(operation, req, res, travail){
  const encours = entretienEnCours();
  if(encours) return res.status(409).json({
    error: `une opération d'entretien est déjà en cours (${encours.operation}, `
      + `depuis ${Math.round(encours.ms/1000)} s) : attendez qu'elle se termine`,
    entretien_en_cours: encours });
  prendreVerrou(operation, req.user.email);
  const t0 = Date.now();
  try{
    const sortie = travail();
    return res.json({ ok:true, operation, ms: Date.now() - t0, ...sortie });
  }finally{ rendreVerrou(); }
}

r.post("/base/checkpoint", (req, res) => sousVerrou("checkpoint", req, res, () => {
  const avant = tailles();
  /* TRUNCATE et pas PASSIVE : le but est de replier le WAL dans la base et de
     rendre la place, pas seulement d'avancer le curseur. `busy` à 1 signale
     qu'un lecteur tenait encore le journal — l'appel a fait ce qu'il a pu, et
     le dire est plus utile que de renvoyer un succès trompeur. */
  const [resultat] = db.pragma("wal_checkpoint(TRUNCATE)");
  const apres = tailles();
  tracer(req, { entity:"base", action:"checkpoint",
    text:`Point de contrôle WAL — ${avant.wal} → ${apres.wal} octets` });
  return { resultat, avant, apres, complet: resultat?.busy === 0 };
}));

r.post("/base/vacuum", (req, res) => sousVerrou("vacuum", req, res, () => {
  const avant = tailles();
  db.exec("VACUUM");
  const apres = tailles();
  tracer(req, { entity:"base", action:"vacuum",
    text:`VACUUM — ${avant.principal} → ${apres.principal} octets` });
  return { avant, apres, gain: avant.principal - apres.principal };
}));

/* ═══════════════════════════════════════════════════════════════════════
   4. SAUVEGARDE ET RESTAURATION
   ═══════════════════════════════════════════════════════════════════════ */

r.post("/sauvegarde", async (req, res, next) => {
  const encours = entretienEnCours();
  if(encours) return res.status(409).json({
    error:`une opération d'entretien est déjà en cours (${encours.operation})`,
    entretien_en_cours: encours });
  prendreVerrou("sauvegarde", req.user.email);
  try{
    const s = await sauvegarder({ motif:"manuelle" });
    tracer(req, { entity:"base", entity_id:s.nom, action:"sauvegarde",
      text:`Sauvegarde ${s.nom} — ${s.octets} octets en ${s.ms} ms, relue et conforme` });
    res.status(201).json({ ok:true, sauvegarde: {
      nom:s.nom, octets:s.octets, ms:s.ms, pages:s.pages,
      integrite:s.controle.integrite, tables:s.controle.tables.length,
      telechargement:`sauvegardes/${s.nom}` } });
  }catch(e){ next(e); }
  finally{ rendreVerrou(); }
});

r.get("/sauvegardes", (req, res) =>
  res.json({ dossier: dossierSauvegardes(), sauvegardes: listerSauvegardes() }));

/* Télécharger une sauvegarde, c'est sortir la base entière de la machine :
   l'acte le plus lourd de conséquence de toute l'API. Il est tracé comme tel. */
r.get("/sauvegardes/:nom", (req, res) => {
  const chemin = cheminSauvegarde(req.params.nom);
  if(!chemin || !fs.existsSync(chemin))
    return res.status(404).json({ error:"sauvegarde introuvable" });
  tracer(req, { entity:"base", entity_id:req.params.nom, action:"telechargement",
    text:`Sauvegarde ${req.params.nom} téléchargée (${octetsDe(chemin)} octets)` });
  log.warn("sauvegarde téléchargée", { fichier:req.params.nom, par:req.user.email });
  res.download(chemin, req.params.nom);
});

r.delete("/sauvegardes/:nom", (req, res) => {
  const chemin = cheminSauvegarde(req.params.nom);
  if(!chemin || !fs.existsSync(chemin))
    return res.status(404).json({ error:"sauvegarde introuvable" });
  const octets = octetsDe(chemin);
  fs.unlinkSync(chemin);
  tracer(req, { entity:"base", entity_id:req.params.nom, action:"suppression_sauvegarde",
    text:`Sauvegarde ${req.params.nom} supprimée (${octets} octets)` });
  res.json({ ok:true, supprime:req.params.nom });
});

/* Contrôler une sauvegarde sans la restaurer : la seule façon honnête de
   savoir qu'une sauvegarde vaut quelque chose est de l'ouvrir. */
r.get("/sauvegardes/:nom/controle", (req, res) => {
  const chemin = cheminSauvegarde(req.params.nom);
  if(!chemin || !fs.existsSync(chemin))
    return res.status(404).json({ error:"sauvegarde introuvable" });
  const c = verifier(chemin);
  res.json({ nom:req.params.nom, octets:octetsDe(chemin), controle: {
    lisible:c.lisible, integrite:c.integrite ?? null, violations:c.violations ?? null,
    tables:c.tables?.length ?? 0, migrations:c.migrations?.length ?? 0, motif:c.motif } });
});

const CONFIRMATION = "RESTAURER";
const restaurationBody = z.object({
  fichier: z.string().min(1).max(120),
  /* Une case à cocher se coche par réflexe ; un mot à recopier ne s'écrit pas
     par accident. C'est la confirmation explicite qu'exige le chantier K2. */
  confirmation: z.string(),
}).strict();

r.post("/restauration", validate(restaurationBody), async (req, res, next) => {
  if(req.body.confirmation !== CONFIRMATION) return res.status(422).json({
    error:`restauration non confirmée : renvoyez « confirmation »: "${CONFIRMATION}" `
      + "pour confirmer le remplacement intégral du contenu de la base" });

  const chemin = cheminSauvegarde(req.body.fichier);
  if(!chemin || !fs.existsSync(chemin))
    return res.status(404).json({ error:"sauvegarde introuvable" });

  const encours = entretienEnCours();
  if(encours) return res.status(409).json({
    error:`une opération d'entretien est déjà en cours (${encours.operation})`,
    entretien_en_cours: encours });
  prendreVerrou("restauration", req.user.email);

  const jti = req.jti, moi = { id:req.user.id, email:req.user.email };
  try{
    /* Filet obligatoire : on sauvegarde l'état ACTUEL avant de l'écraser.
       Sans cela une restauration du mauvais fichier serait sans retour. */
    const filet = await sauvegarder({ motif:"avant restauration" });
    const bilan = restaurer({ chemin, nom:req.body.fichier });

    /* La table `audit` vient d'être remplacée : la trace ne peut être écrite
       qu'ici, après le COMMIT. Et le compte qui a lancé l'opération n'existe
       peut-être plus dans la base restaurée — la clé étrangère refuserait la
       ligne, donc on retombe sur NULL en gardant le libellé. */
    const existeEncore = !!db.prepare("SELECT 1 FROM users WHERE id=?").get(moi.id);
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'securite','base',?,'restauration',?)`)
      .run(newId("aud"), existeEncore ? moi.id : null, moi.email, req.body.fichier,
           `Base restaurée depuis ${req.body.fichier} en ${bilan.ms} ms `
           + `(${bilan.tables} tables) — sauvegarde préalable : ${filet.nom}`);

    /* La table `sessions` a été remplacée elle aussi : la session courante
       n'existe plus si la sauvegarde est antérieure à la connexion. On le dit
       plutôt que de laisser l'appelant se faire éjecter sans comprendre. */
    const sessionVivante = !!db.prepare(
      `SELECT 1 FROM sessions WHERE id=? AND revoked=0 AND expires_at > datetime('now')`)
      .get(jti);

    res.json({ ok:true, restaure:req.body.fichier, ms:bilan.ms, tables:bilan.tables,
      apres: bilan.apres, sauvegarde_prealable: filet.nom,
      compte_toujours_present: existeEncore, session_toujours_valide: sessionVivante,
      avertissement: sessionVivante ? null
        : "votre session ne figure pas dans la sauvegarde restaurée : "
          + "le prochain appel sera refusé, reconnectez-vous" });
  }catch(e){ next(e); }
  finally{ rendreVerrou(); }
});

export default r;
