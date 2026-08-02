/* ═══════════════════════════════════════════════════════════════════════
   Le référentiel de codes d'identification, côté API.

   Quatre gestes : lister les référentiels chargés avec leurs compteurs, feuilleter
   les entrées de l'un d'eux, lancer le rapprochement avec le registre des sites,
   et relire l'état de ce rapprochement sans le relancer.

   ── Un référentiel national n'a pas de bureau propriétaire ───────────
   `code_referentiel` ne porte AUCUN `office_id`, et la migration 020 dit pourquoi
   en toutes lettres. Le cloisonnement ne disparaît pas pour autant, il se déplace
   là où il a un sens :

     — la LECTURE est ouverte à tout compte authentifié. Un code école validé par
       tous n'est pas un secret de bureau, et le cacher obligerait chaque bureau à
       tenir sa copie — ce que le référentiel existe pour supprimer ;
     — l'ÉCRITURE exige `admin`, comme POST /api/geo/bulk et pour la même raison :
       une table chargée de travers empoisonne le rattachement de TOUS les
       bureaux, pas seulement de celui qui l'a chargée ;
     — le bureau réapparaît au SEUL endroit où des sites sont touchés : la
       consultation ne nomme que les sites du bureau de l'appelant (une entrée
       rattachée hors de son bureau est signalée comme telle, elle n'est pas
       présentée comme non rattachée), et le rapprochement construit son index
       avec `officeBound(req.user)`, exactement comme `importerCorrespondances`
       (lib/alias.js).

   Sur le rapprochement, ce dernier bornage ne filtre RIEN aujourd'hui, et il faut
   le dire plutôt que de laisser croire l'inverse : la capacité « admin » n'est
   détenue que par les rôles `admin` et `super`, qu'`officeBound` ne borne jamais.
   Il est écrit quand même parce que la règle appartient au geste et non au rôle
   qui le détient : le jour où un rôle borné obtient cette capacité, le
   cloisonnement s'applique sans qu'on ait à le redécouvrir.

   ── Pourquoi aucune suppression n'est offerte ────────────────────────
   Une ligne fautive se corrige en rechargeant le fichier : l'import est
   idempotent par la clé (referentiel, code), et il laisse un lot consultable —
   qui a chargé quoi, quand, et ce que cela a changé. Un DELETE ne laisserait rien
   de tel, et l'entrée disparue ne serait plus qu'un rattachement qui a cessé de
   fonctionner sans que personne sache quand. Le référentiel est la liste du
   bureau ; on la remplace, on ne l'ampute pas en douce.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from "express";
import { z } from "zod";
import { requireCap } from "../lib/auth.js";
import { MOTIF_SOURCE_RESERVEE, estSourceReservee } from "../lib/alias.js";
import { officeBound } from "../lib/scope.js";
import { newId } from "../lib/crypto.js";
import { db } from "../db.js";
import { etatRapprochement, lister, listerReferentiels, rapprocher } from "../lib/codes.js";

const r = Router();

/* Le nom d'un référentiel devient la `source` des alias qu'il pose : il ne peut
   donc pas être celui que lib/alias.js réserve au miroir de la fiche de site,
   sous peine de voir ces alias effacés par la première correction de fiche. */
const NOM = z.string().trim()
  .min(1, "nom de référentiel invalide")
  .max(60, "nom de référentiel invalide")
  .refine(v => !estSourceReservee(v), MOTIF_SOURCE_RESERVEE);
/* Le motif exact plutôt qu'un refus générique : « invalide » sur un nom qu'un
   administrateur vient de taper ne lui dit pas quoi corriger. */
const refuserNom = (res, nom) => res.status(422)
  .json({ error: nom.error.issues[0]?.message || "nom de référentiel invalide" });

/* ── Les référentiels chargés, avec leurs compteurs ──────────────────
   C'est ce que l'écran lit à l'ouverture : combien de codes, combien rattachés,
   combien restent. Ouvert à tout compte authentifié — voir l'en-tête. */
r.get("/", (req, res) => {
  res.json({ rows: listerReferentiels() });
});

/* ── Les entrées d'un référentiel, paginées et cherchables ───────────── */
r.get("/:referentiel", (req, res) => {
  const nom = NOM.safeParse(req.params.referentiel);
  if(!nom.success) return refuserNom(res, nom);
  const q = z.object({
    q: z.string().max(120).optional(),
    rattache: z.enum(["oui","non"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"paramètres de recherche invalides" });

  res.json({ referentiel: nom.data,
    ...lister({ referentiel: nom.data, q: q.data.q || "", rattache: q.data.rattache || "",
      limit: q.data.limit, offset: q.data.offset, office_id: officeBound(req.user) }) });
});

/* ── L'état du rapprochement, sans rien recalculer ni écrire ─────────── */
r.get("/:referentiel/etat", (req, res) => {
  const nom = NOM.safeParse(req.params.referentiel);
  if(!nom.success) return refuserNom(res, nom);
  res.json(etatRapprochement(nom.data, officeBound(req.user)));
});

/* ── Le rapprochement, geste explicite et journalisé ──────────────────
   Séparé de l'import parce que le scénario réel est « charger, voir ce qui
   manque, créer les sites manquants, RE-rapprocher ». Rejouable sans risque :
   l'écriture des alias est idempotente, et le second passage est plus fort que le
   premier puisqu'il dispose des alias posés au premier (voir lib/codes.js). */
r.post("/:referentiel/rapprocher", requireCap("admin"), (req, res) => {
  const nom = NOM.safeParse(req.params.referentiel);
  if(!nom.success) return refuserNom(res, nom);

  const bilan = rapprocher({ referentiel: nom.data, office_id: officeBound(req.user) });
  if(!bilan.lues) return res.status(404).json({
    error:`aucune entrée chargée pour le référentiel « ${nom.data} » : importez d'abord le fichier` });

  /* L'audit reprend le bilan ENTIER, échecs compris. Une ligne qui ne dirait que
     « 940 rattachées » laisserait croire six mois plus tard que le rapprochement
     avait réussi — alors que 311 écoles n'avaient pas de site. */
  const sansSuite = bilan.sitesSansEntree.reduce((a, x) => a + x.sites, 0);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'plan','code_referentiel',?,'rapprochement',?)`)
    .run(newId("aud"), req.user.id,
      `${req.user.first_name} ${req.user.last_name || ""}`.trim(), req.user.office_id || "",
      nom.data,
      `Rapprochement du référentiel « ${nom.data} » : ${bilan.lues} entrée(s) lues, `
      + `${bilan.rattachees} rattachée(s), ${bilan.alias} alias posé(s), `
      + `${bilan.aliasRetires} alias périmé(s) retiré(s), `
      + `${bilan.dejaPresents} déjà présent(s), ${bilan.detacheesTotal} détachée(s), `
      + `${bilan.aConfirmerTotal} à confirmer sous le `
      + `seuil de preuve (${bilan.seuil}), ${bilan.sansSiteTotal} sans site, `
      + `${sansSuite} site(s) du registre sans entrée, ${bilan.codesAmbigus.length} code(s) ambigu(s)`);

  res.json({ ...bilan,
    /* Un rapprochement qui « réussit » en laissant trois cents entrées au bord de
       la route n'a pas réussi. Le message le dit, à côté des listes. */
    avertissement: bilan.sansSiteTotal || bilan.aConfirmerTotal
      ? `${bilan.sansSiteTotal} entrée(s) n'ont trouvé aucun site et ${bilan.aConfirmerTotal} `
        + "reposent sur une preuve trop faible pour poser un code de reconnaissance. Elles ne "
        + "sont PAS rattachées, elles sont listées ci-dessous. Créez les sites manquants ou "
        + "renseignez la colonne « Code du site MEMS » du modèle, puis relancez le rapprochement."
      : null,
    /* Une entrée qui perd son site est le seul effet DESTRUCTEUR d'un geste
       présenté comme rejouable : il se dit en toutes lettres, avec la cause la
       plus fréquente, faute de quoi l'opérateur croit avoir relancé pour rien.

       Et il faut dire ce qui, à l'inverse, NE change PAS : le code de
       reconnaissance posé au passage précédent survit — il n'est retiré que par une
       conclusion contraire, jamais par une absence de conclusion, ce qui permet de
       réparer le fichier sans avoir tout perdu entre-temps. Sans cette phrase,
       « détachée » se lit comme « plus rien ne rattache », alors que les
       soumissions portant ce code continuent d'aller au même site. Deux faits
       opposés dont un seul était dit. */
    detachement: bilan.detacheesTotal
      ? `${bilan.detacheesTotal} entrée(s) ont PERDU le site auquel elles étaient rattachées : `
        + "le fichier ou le registre a changé depuis le dernier rapprochement (code MEMS corrigé "
        + "sur une fiche de site, désignation rectifiée dans le fichier). Elles sont listées "
        + "ci-dessous avec leur motif. Attention : le CODE DE RECONNAISSANCE posé au "
        + "rapprochement précédent reste en place, et les soumissions portant ce code continuent "
        + "d'être rattachées à l'ancien site. C'est voulu — il vous laisse réparer le fichier sans "
        + "tout perdre — mais si le rattachement lui-même était une erreur, retirez le code dans "
        + "« Codes de reconnaissance » du site concerné."
      : null,
    remarque: bilan.codesAmbigus.length
      ? `${bilan.codesAmbigus.length} code(s) désignent désormais plusieurs sites. Le résolveur `
        + "refusera de trancher entre eux : ces soumissions resteront à rattacher à la main."
      : null });
});

export default r;
