import { monthsSince, n, r1, siteRequirement } from "./calc.js";
import { MONTHS_L } from "./constants.js";

/* ═══════════════════════════════════════════════════════════════════════
   Ce qui attend une action — une seule définition.

   C'était une fonction locale de l'écran d'accueil, qui en affichait les quarante
   premières lignes dans un tableau. Trois problèmes, constatés en ouvrant
   l'application comme un utilisateur de terrain :

     — cent trente-neuf lignes sur la page d'accueil, dont on ne lit jamais que les
       trois premières. Une liste qu'on ne lit pas est une liste qui ne sert pas ;
     — la coupure à quarante n'était dite nulle part : les quatre-vingt-dix-neuf
       autres n'existaient tout simplement pas pour l'utilisateur ;
     — rien ne signalait une nouveauté ailleurs dans l'application : il fallait
       revenir à l'accueil pour savoir qu'un plan attendait une validation.

   La liste vit donc ici, la cloche de l'en-tête en compte les priorités hautes, et
   une destination dédiée les présente groupées par nature. L'accueil n'en garde
   qu'un aperçu.

   Chaque alerte porte de quoi la résoudre : `go` est la destination qui la traite.
   Une alerte sans issue est un reproche, pas une aide.
   ═══════════════════════════════════════════════════════════════════════ */

/* L'ordre des natures est celui de l'urgence métier, non l'alphabet : ce qui bloque
   quelqu'un d'autre passe avant ce qui ne bloque que soi. */
export const NATURES = [
  { id:"validation", label:"En attente de validation",
    text:"Quelqu'un attend une décision de votre part." },
  { id:"retard",     label:"Échéances non honorées",
    text:"Une visite ou une distribution prévue n'a pas été faite." },
  { id:"intervalle", label:"Intervalle de suivi dépassé",
    text:"Le site n'a pas été vu depuis plus longtemps que l'exigence minimale." },
  { id:"budget",     label:"Budget et dépenses",
    text:"Un plafond approché, un budget non chiffré, une dépense non renseignée." },
  { id:"saisie",     label:"Données manquantes",
    text:"Une valeur attendue n'a pas été saisie : le calcul qui en dépend est faux ou vide." },
  { id:"config",     label:"Configuration incomplète",
    text:"Un paramètre absent empêche un calcul de fonctionner." },
];

const PRIO = { haute:0, moyenne:1, basse:2 };

export function alertes(db){
  if(!db) return [];
  const t = [];
  const nowM = new Date().getMonth();
  const push = (a) => t.push(a);

  /* ── Sites : visites manquées et intervalle dépassé ─────────────── */
  (db.sites || []).filter(s => s.status !== "Inactive").forEach(s => {
    const missed = (s.plan || []).filter((p,i) => p.planned && !p.done && i < nowM).length;
    if(missed) push({ id:"m"+s.id, prio:"haute", nature:"retard", kind:"Visite en retard",
      text:`${s.poi} — ${missed} échéance(s) de visite non honorée(s)`,
      ctx:`${s.subOffice} · ${s.adm3}`, go:["suivi","monitoring"] });
    const ms = monthsSince(s.lastVisit); const req = siteRequirement(db, s);
    if(req.interval && (ms === null || ms > req.interval * 1.5))
      push({ id:"i"+s.id, prio: ms === null ? "haute" : "moyenne", nature:"intervalle",
        kind:"Intervalle dépassé",
        text:`${s.poi} — ${ms === null ? "jamais visité" : r1(ms)+" mois depuis la dernière visite"}, intervalle requis ${req.interval} mois`,
        ctx:`${s.subOffice} · ${s.adm3}`, go:["suivi","monitoring"] });
  });

  /* ── Plan de distribution ───────────────────────────────────────── */
  (db.pdd || []).forEach(l => {
    if(l.month < nowM && !n(l.distributed) && l.status !== "cancelled")
      push({ id:"pdd"+l.id, prio: l.month < nowM-1 ? "haute" : "moyenne", nature:"saisie",
        kind:"Distribution non renseignée",
        text:`${l.commune} — ${MONTHS_L[l.month]}, ${l.actType} ${l.modality} : aucune quantité distribuée saisie`,
        ctx:l.bureau, go:["programme","distribution"] });
    const planifie = n(l.benefPlanned) || n(l.tonnage) || n(l.amount);
    const fait = n(l.distributed);
    if(fait && planifie && fait / planifie < 0.5 && l.month <= nowM)
      push({ id:"pddlow"+l.id, prio:"moyenne", nature:"retard", kind:"Taux de distribution faible",
        text:`${l.commune} — ${MONTHS_L[l.month]}, ${l.actType} : moins de la moitié du planifié distribué`,
        ctx:l.bureau, go:["programme","distribution"] });
  });

  /* ── Validations en attente ─────────────────────────────────────── */
  const pending = (db.visits || []).filter(v => v.status === "À valider").length;
  if(pending) push({ id:"val", prio:"haute", nature:"validation", kind:"Visites à valider",
    text:`${pending} soumission(s) de suivi de processus attendent une validation`,
    ctx:"suivi de processus", go:["suivi","monitoring"] });

  /* ── Configuration ──────────────────────────────────────────────── */
  (db.params || []).filter(p => !n(p.feasiblePerMonth)).forEach(p =>
    push({ id:"p"+p.id, prio:"moyenne", nature:"config", kind:"Capacité mensuelle absente",
      text:`Sans capacité mensuelle, la faisabilité du plan de ${p.office} ne peut pas être calculée — ${p.tag}`,
      ctx:"paramètres de couverture", go:["suivi","params"] }));

  /* Un site sans rattachement au découpage n'apparaît dans aucun agrégat
     géographique : il est compté nulle part, ce qui se voit sur la carte mais ne se
     comprend pas. */
  const orphelins = (db.sites || []).filter(s => !s.geo_pcode).length;
  if(orphelins) push({ id:"geo", prio:"moyenne", nature:"config",
    kind:"Sites sans rattachement géographique",
    text:`${orphelins} site(s) ne sont rattachés à aucune unité du découpage : ils n'entrent dans aucun total par région ou district`,
    ctx:"registre des sites", go:["suivi","sites"] });

  /* ── Indicateurs sans mesure ────────────────────────────────────── */
  (db.indicators || []).forEach(ind => {
    if(!(db.outcomes || []).some(o => o.indicator === ind.id))
      push({ id:"o"+ind.id, prio:"basse", nature:"saisie", kind:"Indicateur sans valeur",
        text:`${ind.name.slice(0,70)} — aucune mesure enregistrée`,
        ctx:"indicateurs de résultat", go:["programme","results"] });
  });

  return t.sort((a,b) => PRIO[a.prio] - PRIO[b.prio]);
}

/* Regroupement par nature, dans l'ordre déclaré, natures vides écartées. */
export function parNature(liste){
  return NATURES.map(nat => ({
    ...nat,
    items: liste.filter(a => a.nature === nat.id),
  })).filter(g => g.items.length);
}

export const compte = (liste, prio) => liste.filter(a => a.prio === prio).length;
