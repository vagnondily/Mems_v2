import { db } from "../db.js";

/* ═══════════════════════════════════════════════════════════════════════
   Plan MRE — vocabulaire et calculs.

   Le vocabulaire vient des classeurs de référence du bureau pays, et non d'une
   invention de l'outil : la liste des activités de suivi, les catégories de coût et
   les entités responsables y sont des listes FERMÉES, parce qu'elles servent à
   consolider entre bureaux pays. Une catégorie inventée localement casse la
   consolidation sans que personne s'en aperçoive avant l'agrégation.

   Le calcul du budget est celui du classeur, à la lettre :

       budget d'une année = ( Σ des fréquences des quatre trimestres ) × coût unitaire

   C'est-à-dire : une activité n'a pas un budget, elle a un nombre d'occurrences et
   un coût par occurrence. La différence n'est pas cosmétique — elle dit QUAND
   l'argent est consommé, ce qu'un montant annuel ne dit pas, et elle rend le plan
   pluriannuel lisible sans changer d'écran.
   ═══════════════════════════════════════════════════════════════════════ */

/* La nature de l'activité. Elle gouverne la lecture du plan : on ne budgète pas une
   évaluation externe comme une visite de suivi de processus. */
export const KINDS = {
  suivi:      "Suivi de processus et de distribution",
  revue:      "Revue de programme",
  evaluation: "Évaluation",
  enquete:    "Enquête (post-distribution, base, finale)",
  etude:      "Étude ou analyse",
  capacite:   "Renforcement de capacités en suivi-évaluation",
};

/* Qui exécute. Le classeur ne connaît que deux valeurs, et elles suffisent : ce qui
   compte pour le budget est de savoir si la dépense est un coût de personnel interne
   ou un achat de service. */
export const ENTITIES = {
  interne: "Interne (équipe du bureau)",
  externe: "Externe (prestataire, cabinet, consultant)",
};

/* Les catégories d'activité de suivi, telles que la liste corporate les nomme.
   Chaque catégorie porte ses sous-catégories usuelles : ce sont elles qu'on retrouve
   dans les modèles de budget, et les nommer autrement rend l'export inutilisable. */
export const CATEGORIES = {
  outcome:    { label:"Suivi des effets (PDM, référence, enquêtes)",
    sub:["PDM (général)","Référence (général)","PDM transferts non conditionnels",
         "PDM cantines scolaires","Enquête nutritionnelle","PDM nutrition",
         "PDM création d'actifs / résilience","Collecte qualitative","Autre"] },
  population: { label:"Enquêtes en population",
    sub:["Évaluation d'urgence de la sécurité alimentaire (EFSA)",
         "Analyse globale de la sécurité alimentaire et de la vulnérabilité (CFSVA)",
         "Évaluation des besoins essentiels","mVAM","Analyse intégrée du contexte (ICA)",
         "Mission conjointe FAO/PAM (CFSAM)","Autre"] },
  process:    { label:"Suivi de processus et de distribution",
    sub:["Suivi sur site","Suivi de distribution","Suivi des partenaires",
         "Suivi tiers (prestataire)","Autre"] },
  review:     { label:"Revues et études thématiques",
    sub:["Revue à mi-parcours du CSP","Revue annuelle","Étude thématique",
         "Analyse de marché","Autre"] },
  evaluation: { label:"Évaluations",
    sub:["Évaluation décentralisée","Évaluation d'activité","Évaluation de portefeuille",
         "Évaluation d'impact","Autre"] },
  capacity:   { label:"Renforcement de capacités et systèmes",
    sub:["Formation du personnel","Formation des partenaires","Mécanisme de retour d'information",
         "Système de gestion des données","Équipement de collecte","Autre"] },
};

/* Les catégories de coût de haut niveau, qui sont celles du plan budgétaire de
   l'organisation. Elles ne se choisissent pas librement : c'est la ligne sur
   laquelle la dépense sera imputée. */
export const HIGH_CATEGORIES = {
  dsc_assessment: "DSC — coûts d'évaluation et d'enquête",
  dsc_monitoring: "DSC — coûts de suivi",
  dsc_evaluation: "DSC — coûts d'évaluation externe",
  isc_staff:      "Personnel suivi-évaluation",
  equipment:      "Équipement et licences",
  other:          "Autre",
};

export const STATUSES = ["planifie", "en_cours", "realise", "reporte", "annule"];
export const QUARTERS = ["T1", "T2", "T3", "T4"];

const r2 = (x) => Math.round(x * 100) / 100;

/* Les fréquences d'une activité, par année puis par trimestre. */
export function frequencies(activityId){
  const out = {};
  for(const f of db.prepare(
      "SELECT year, quarter, n FROM mre_frequency WHERE activity_id=? ORDER BY year, quarter").all(activityId)){
    (out[f.year] = out[f.year] || [0,0,0,0])[f.quarter] = f.n;
  }
  return out;
}

/* Le budget par année, et le total. Rien n'est stocké : c'est la formule du
   classeur, appliquée là où elle ne peut pas diverger d'un écran à l'autre. */
export function budget(activityId, unitCost){
  const freq = frequencies(activityId);
  const parAnnee = {};
  let total = 0, occurrences = 0;
  for(const [an, qs] of Object.entries(freq)){
    const n = qs.reduce((t, v) => t + v, 0);
    const montant = r2(n * (unitCost || 0));
    parAnnee[an] = { occurrences:n, montant };
    total = r2(total + montant); occurrences += n;
  }
  return { parAnnee, total, occurrences, freq };
}

/* La dépense constatée, par année. `null` n'est pas 0 : une année sans dépense
   saisie n'a pas une exécution de 0 %, elle n'en a pas. */
export function spending(activityId){
  const out = {};
  for(const s of db.prepare("SELECT year, amount, note FROM mre_spend WHERE activity_id=?").all(activityId))
    out[s.year] = { amount:s.amount, note:s.note || "" };
  return out;
}

/* La forme complète d'une activité, telle que l'écran et l'export la lisent. */
export function shape(a, labels = {}){
  const b = budget(a.id, a.unit_cost);
  const dep = spending(a.id);
  const depenseTotale = Object.values(dep).reduce((t, x) => t + (x.amount || 0), 0);
  const engagee = Object.values(dep).some(x => x.amount != null);
  return {
    id:a.id, year:a.year, ref:a.ref || "", title:a.title, kind:a.kind,
    kindLabel: KINDS[a.kind] || a.kind,
    purpose:a.purpose || "", method:a.method || "",
    entity:a.entity || null, entityLabel: ENTITIES[a.entity] || "",
    cost_category:a.cost_category || null, high_category:a.high_category || null,
    highLabel: HIGH_CATEGORIES[a.high_category] || "",
    office_id:a.office_id, office:a.office_name || "", activity_tag:a.activity_tag || "",
    indicator_id:a.indicator_id, indicator:a.indicator_code || "",
    geo_pcode:a.geo_pcode,
    portee: a.geo_pcode ? (labels?.[a.geo_pcode] || a.geo_pcode) : "National",
    responsible:a.responsible || "", sample:a.sample, status:a.status,
    funding:a.funding || "", currency:a.currency, note:a.note || "",
    rev:a.rev, updated_at:a.updated_at,

    unit_cost:a.unit_cost || 0,
    frequences:b.freq, occurrences:b.occurrences,
    budgetParAnnee:b.parAnnee, budget:b.total,
    depenses:dep, spent: engagee ? r2(depenseTotale) : null,
    execution: b.total && engagee ? Math.round((depenseTotale / b.total) * 1000) / 10 : null,
  };
}
