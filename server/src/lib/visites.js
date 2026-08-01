/* ═══════════════════════════════════════════════════════════════════════
   Les visites, et ce qui distingue celle qu'on a saisie de celle qu'on a
   observée.

   La voie normale d'une visite est le formulaire ODK : il la date au jour
   déclaré de collecte, la situe, et la rattache à une soumission conservée
   entière (migration 017). La saisie à la main est le rattrapage — formulaire
   non rempli, appareil à plat, soumission perdue, visite antérieure au
   déploiement du formulaire. On ne la supprime pas : le terrain en a besoin. On
   la borne, et on lui demande de dire pourquoi.

   ── Une seule déclaration de la liste ────────────────────────────────
   `MOTIFS_MANUELS` est servi tel quel au client par /api/state, à côté de
   `country` et `settings` qui partent déjà avec l'état initial. Aucune copie
   côté navigateur, aucun CHECK recopié en SQL, aucune route dédiée : six objets
   ne valent pas un aller-retour de plus avant le premier affichage, et une liste
   écrite à deux endroits dérive au premier ajout. C'est exactement le défaut que
   traîne aujourd'hui l'écran d'import avec ses `KINDS` recopiés dans
   ActualData.jsx alors que le serveur sert /kinds.

   `noteObligatoire` porte la seule règle qui se juge sur le corps de la requête :
   « Autre » n'explique rien à lui seul. Elle est appliquée par zod
   (lib/validate.js) et lue par l'interface pour présenter le champ comme
   obligatoire — même donnée, deux usages, une déclaration.

   `saisissable` distingue les motifs qu'un opérateur peut choisir de celui que
   la migration 019 a écrit pour l'existant. `inconnu_anterieur` dit franchement
   que personne ne connaît la raison de ces lignes ; il s'affiche, il ne se
   choisit jamais. Sans cette distinction, il deviendrait la case fourre-tout des
   saisies à venir, c'est-à-dire l'inverse de ce que la règle cherche.
   ═══════════════════════════════════════════════════════════════════════ */

import { db } from "../db.js";

export const MOTIFS_MANUELS = [
  { id:"formulaire_non_rempli", libelle:"Formulaire non rempli sur le terrain",
    noteObligatoire:false, saisissable:true },
  { id:"appareil_indisponible", libelle:"Appareil indisponible (panne, batterie)",
    noteObligatoire:false, saisissable:true },
  { id:"soumission_perdue", libelle:"Soumission perdue ou jamais envoyée",
    noteObligatoire:false, saisissable:true },
  { id:"anterieure_formulaire", libelle:"Visite antérieure au déploiement du formulaire",
    noteObligatoire:false, saisissable:true },
  { id:"autre", libelle:"Autre", noteObligatoire:true, saisissable:true },
  { id:"inconnu_anterieur", libelle:"Motif inconnu — visite enregistrée avant la règle",
    noteObligatoire:false, saisissable:false },
];

export const motifsSaisissables = () => MOTIFS_MANUELS.filter(m => m.saisissable);
export const motifParId = (id) => MOTIFS_MANUELS.find(m => m.id === id) || null;
export const libelleMotif = (id) => motifParId(id)?.libelle || "";

/* « AAAA-MM », la maille de la grille mensuelle. Le mois est indexé à partir de
   zéro dans tout le produit — c'est ce que porte `site_months.month` et ce que
   rend `Date#getMonth()` côté navigateur — d'où le +1 ici et nulle part ailleurs. */
export const cleMois = (year, month) => `${year}-${String(month + 1).padStart(2, "0")}`;

export const visitesDuMois = (site_id, year, month) =>
  db.prepare(`SELECT id, origin, submission_id, manual_reason, manual_note
              FROM visits WHERE site_id=? AND visit_date LIKE ?`)
    .all(site_id, `${cleMois(year, month)}%`);

/* Une visite qu'aucun écran de planification ne peut retirer. La garde regarde
   les DEUX colonnes, pas seulement `submission_id` : celle-ci est en
   ON DELETE SET NULL vers `submissions` (migration 017), donc une soumission
   retirée laisse derrière elle une visite bel et bien venue du terrain, mais
   sans son identifiant. Ne peut être supprimé par la grille mensuelle que ce que
   la grille mensuelle a créé. */
export const estProtegee = (v) => !!v.submission_id || v.origin === "odk";

/* ── La porte de sortie d'une visite issue d'ODK ──────────────────────
   La grille mensuelle refuse de retirer une visite venue d'un formulaire, et
   renvoie vers le détachement de la soumission. Encore faut-il que ce geste
   fasse ce qu'il annonce : tant qu'il ne touchait que `submissions.site_id`, la
   visite restait, le refus se répétait à l'identique, et un suivi appliqué au
   mauvais mois était définitif — aucune route du dépôt ne supprime une visite.
   Détacher une soumission retire donc la visite qu'elle a fait naître, et rend
   `site_months.done` à ce que le reste du mois soutient encore.

   La visite manuelle du même mois n'est pas touchée : elle n'est pas née de
   cette soumission, et le geste inverse de « appliquer le suivi » ne va pas
   au-delà de ce que « appliquer le suivi » avait écrit. */
export function retirerVisiteDeSoumission(submission_id){
  const visites = db.prepare(
    "SELECT id, site_id, visit_date FROM visits WHERE submission_id=?").all(submission_id);
  if(!visites.length) return { visites:0, mois:[] };
  db.prepare("DELETE FROM visits WHERE submission_id=?").run(submission_id);

  /* Le mois retombe à « non réalisé » SEULEMENT s'il ne reste rien pour le
     soutenir : une saisie à la main faite avant l'ingestion documente toujours
     le mois, et la démarquer serait un second mensonge. */
  const mois = [];
  const reste = db.prepare(
    "SELECT COUNT(*) c FROM visits WHERE site_id=? AND visit_date LIKE ?");
  const demarquer = db.prepare(
    "UPDATE site_months SET done=0 WHERE site_id=? AND year=? AND month=? AND done=1");
  for(const v of visites){
    const cle = String(v.visit_date || "").slice(0, 7);
    const [an, m] = cle.split("-").map(Number);
    if(!an || !m) continue;
    if(reste.get(v.site_id, `${cle}%`).c) continue;
    if(demarquer.run(v.site_id, an, m - 1).changes) mois.push({ site_id:v.site_id, mois:cle });
  }
  return { visites: visites.length, mois };
}
