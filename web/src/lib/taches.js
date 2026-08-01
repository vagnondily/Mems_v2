import { monthsSince, n, r1, siteRequirement } from "./calc.js";
import { D_ROLES, MONTHS_L } from "./constants.js";

/* ══════════════════ Tâches et notifications ══════════════════
   Une tâche n'est pas une donnée : elle est DÉDUITE de l'état à chaque rendu.
   Rien n'est stocké, donc rien ne se périme — une échéance honorée disparaît
   d'elle-même, sans qu'aucun écran n'ait à « fermer » quoi que ce soit.

   Ce module ne dépend d'aucune vue, à dessein : la coquille l'appelle pour sa
   cloche et l'accueil pour le générateur de rapports. Une seule dérivation, donc
   un seul décompte — deux listes divergentes seraient pires que pas de cloche. */

/* Trois niveaux, et l'ordre dans lequel ils se lisent. Le libellé et la teinte
   accompagnent le code : l'appelant n'a pas à retraduire ce qu'on sait ici. */
const SEVERITES = [
  ["urgent",       "Urgent",        "r"],
  ["a_surveiller", "À surveiller",  "y"],
  ["information",  "Information",   "n"],
];
const RANG = { urgent:0, a_surveiller:1, information:2 };

/* Quantité planifiée d'une ligne de distribution : tonnage pour les vivres,
   montant pour les transferts. La règle est celle de l'écran des distributions ;
   elle est redite ici parce que `lib/` ne doit dépendre d'aucune vue — l'importer
   de views/Planning.jsx ferait entrer un écran entier dans la barre du haut. */
const quantitePlanifiee = (l) => l.modality === "Food" ? n(l.tonnage) : n(l.amount);

/* Les tâches d'un compte donné.

   `me` et `onglets` sont facultatifs : sans eux la dérivation est complète, ce
   dont le générateur de rapports a besoin — il décrit la situation du pays, pas
   celle d'un poste de travail.

   Le cloisonnement s'appuie sur D_ROLES, la matrice de droits déjà partagée avec
   le serveur, et sur la liste d'onglets qu'App a résolue (resolveTabs). Aucune
   seconde matrice : une tâche qui contredirait la navigation serait un piège. */
function tachesUtilisateur(db, me, onglets){
  if(!db) return [];
  const droits = D_ROLES[me?.role] || {};
  const complet = !me;
  /* Sans bureau de rattachement, ou avec un rôle d'administration, la vue est
     nationale — même règle qu'au registre des sites et au plan de processus. */
  const national = complet || !me.office || !!droits.admin;
  const aMoi = (bureau) => national || bureau === me.office;
  const peut = (f) => complet || !!droits[f];
  const nowM = new Date().getMonth();
  const out = [];
  /* Une tâche qui mène à une destination fermée au compte est une impasse : on
     ne la montre pas plutôt que de la rendre inerte au clic. */
  const poser = (t) => { if(complet || !onglets || onglets.includes(t.vers[0])) out.push(t); };

  (db.sites || []).filter(s => s.status !== "Inactive" && aMoi(s.subOffice)).forEach(s => {
    const manquees = (s.plan || []).filter((p,i) => p.planned && !p.done && i < nowM).length;
    if(manquees) poser({ id:`visite-retard:${s.id}`, severite:"urgent",
      titre:"Visite en retard",
      detail:`${s.poi} — ${manquees} échéance(s) de visite non honorée(s)`,
      contexte:`${s.subOffice} · ${s.adm3}`, vers:["suivi","monitoring"] });

    const ms = monthsSince(s.lastVisit); const req = siteRequirement(db, s);
    if(req.interval && (ms === null || ms > req.interval * 1.5))
      poser({ id:`intervalle:${s.id}`, severite: ms === null ? "urgent" : "a_surveiller",
        titre:"Intervalle de suivi dépassé",
        detail:`${s.poi} — ${ms === null ? "jamais visité" : r1(ms)+" mois depuis la dernière visite"}`
          + `, intervalle requis ${req.interval} mois`,
        contexte:`${s.subOffice} · ${s.adm3}`, vers:["suivi","monitoring"] });
  });

  /* Saisir une réalisation suppose le droit d'écrire : réclamer la saisie à un
     lecteur, c'est lui demander ce que l'interface lui refuse par ailleurs. */
  if(peut("edit")) (db.pdd || []).filter(l => aMoi(l.bureau)).forEach(l => {
    if(l.month < nowM && !n(l.distributed) && l.status !== "cancelled")
      poser({ id:`distribution-vide:${l.id}`,
        severite: l.month < nowM - 1 ? "urgent" : "a_surveiller",
        titre:"Distribution non renseignée",
        detail:`${l.commune} — ${MONTHS_L[l.month]}, ${l.actType} ${l.modality} : aucune quantité distribuée saisie`,
        contexte:l.bureau, vers:["programme","distribution"] });

    const planifie = quantitePlanifiee(l);
    if(n(l.distributed) && planifie && n(l.distributed) / planifie < 0.5 && l.month <= nowM)
      poser({ id:`distribution-faible:${l.id}`, severite:"a_surveiller",
        titre:"Taux de distribution faible",
        detail:`${l.commune} — ${MONTHS_L[l.month]}, ${l.actType} : `
          + `${(n(l.distributed) / planifie * 100).toFixed(2)} % du planifié distribué`,
        contexte:l.bureau, vers:["programme","distribution"] });
  });

  /* Une validation en attente ne concerne que les comptes qui valident : c'est
     exactement ce que dit `validate` dans D_ROLES, un éditeur n'y peut rien. */
  if(peut("validate")){
    const attente = (db.visits || []).filter(v => v.status === "À valider").length;
    if(attente) poser({ id:"validation", severite:"a_surveiller",
      titre:"Validation en attente",
      detail:`${attente} soumission(s) de suivi de processus attendent une validation`,
      contexte: me?.office || "tous les bureaux", vers:["suivi","monitoring"] });
  }

  if(peut("edit")) (db.params || [])
    .filter(p => !n(p.feasiblePerMonth) && aMoi(p.office)).forEach(p =>
      poser({ id:`parametre:${p.id}`, severite:"a_surveiller",
        titre:"Paramètre de couverture incomplet",
        detail:`Capacité mensuelle non renseignée — ${p.office} / ${p.tag}`,
        contexte:"paramétrage", vers:["suivi","params"] }));

  /* Les résultats n'ont aucune dimension « bureau » : ils sont mesurés par région,
     et le serveur les sert à tout le monde pour cette raison. Les rappeler à un
     bureau de terrain lui confierait une saisie nationale dont il n'est pas
     comptable — cette famille reste donc aux comptes à portée nationale. */
  if(national && peut("edit")) (db.indicators || []).forEach(ind => {
    if(!(db.outcomes || []).some(o => o.indicator === ind.id))
      poser({ id:`indicateur:${ind.id}`, severite:"information",
        titre:"Indicateur sans mesure",
        detail:`${ind.name.slice(0,60)} — aucune mesure enregistrée`,
        contexte:"indicateurs", vers:["programme","results"] });
  });

  return out.sort((a,b) => RANG[a.severite] - RANG[b.severite]);
}

/* ── Marquage « lu » ────────────────────────────────────────────────────────
   Les tâches étant déduites, il n'existe côté serveur aucune notification, donc
   aucun endroit où écrire « celle-ci a été vue ». On garde l'ensemble des
   identifiants masqués dans le navigateur, par compte.

   Limites assumées, et il faut les connaître avant de s'y fier : rien n'est
   partagé entre deux postes ni entre deux navigateurs du même agent — ce qui est
   lu au bureau reste non lu sur le portable —, et vider le cache remet tout à
   zéro. Il n'y a pas non plus d'historique : on ne saura jamais qui a vu quoi ni
   quand, ni si une échéance a été vue puis ignorée.

   Faire mieux demande une table côté serveur — disons
   notification_read(user_id, task_id, seen_at) — alimentée par cette même
   dérivation, avec une route pour la lire et l'écrire. Le marquage suivrait alors
   le compte et non le poste, et l'historique deviendrait exploitable
   (délai moyen de prise en compte, échéances vues et laissées de côté). */
const CLE = "mems.notifications.lues.";

const stockage = () => {
  try{ return typeof window !== "undefined" ? window.localStorage : null; }
  catch(e){ return null; }   /* stockage refusé (navigation privée) : on s'en passe */
};

function lireLues(userId){
  const s = stockage(); if(!s || !userId) return new Set();
  try{ const v = JSON.parse(s.getItem(CLE + userId) || "[]");
    return new Set(Array.isArray(v) ? v : []); }
  catch(e){ return new Set(); }
}

function ecrireLues(userId, ids){
  const s = stockage(); if(!s || !userId) return;
  try{ s.setItem(CLE + userId, JSON.stringify([...ids])); }catch(e){}
}

/* On ne retient que les identifiants encore dérivés. C'est ce qui fait qu'une
   tâche masquée, disparue parce que la situation s'est réglée, redevient une
   notification si la même condition redevient vraie plus tard. */
function elaguerLues(lues, taches){
  const vivants = new Set(taches.map(t => t.id));
  return new Set([...lues].filter(id => vivants.has(id)));
}

export { SEVERITES, ecrireLues, elaguerLues, lireLues, tachesUtilisateur };
