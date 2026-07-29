import { Activity } from "lucide-react";
import { Planning } from "../views/Planning.jsx";
import { monthsSince, n, pct, r1, r2, siteRequirement } from "./calc.js";

/* ══════════════════════════════════════════════════════════════════════
   MEMS — Monitoring Evaluation Management System
   ═════════════════════════════════════════════════════════════════════ */

const C = { brand:"#007DBC", brandD:"#085387", brandL:"#4792c7", navy:"#19486a", aqua:"#26bde2",
  ok:"#689e18", warn:"#F7B825", bad:"#c5192d", orange:"#fd6925", magenta:"#dd1367",
  t1:"#031c2d", t2:"#5a6872", t3:"#8c9ba5", line:"#e2e8ec", bg:"#f2f5f7" };
const SERIES = [C.brand, C.ok, C.warn, C.orange, C.aqua, C.magenta, C.navy, C.brandL];
const MONTHS = ["Jan","Fév","Mar","Avr","Mai","Juin","Juil","Août","Sep","Oct","Nov","Déc"];
const MONTHS_L = ["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];

const CSS = `@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap');
*{box-sizing:border-box}
html,body{margin:0;padding:0;min-height:100%;height:100%}
body,input,select,textarea,button,pre,code{font-family:'Open Sans',system-ui,-apple-system,'Segoe UI',sans-serif}
body{background:#edf2f7;color:#0f172a;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
button,select,textarea{font:inherit;color:inherit}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#cbd5dd;border-radius:5px}
::-webkit-scrollbar-track{background:transparent}
.f8{font-size:8px}.f9{font-size:9px}.f95{font-size:9.5px}.f10{font-size:10px}.f105{font-size:10.5px}
.f11{font-size:11px}.f115{font-size:11.5px}.f12{font-size:12px}.f125{font-size:12.5px}.f13{font-size:13px}
.f15{font-size:15px}.f17{font-size:17px}.f23{font-size:23px}
.mi-f115{font-size:11.5px !important}.mi-f12{font-size:12px !important}.mi-xs{font-size:12px !important}
.mi-tc{text-align:center !important}.mi-py1{padding-top:4px !important;padding-bottom:4px !important}
.mi-py05{padding-top:2px !important;padding-bottom:2px !important}
.mi-px1{padding-left:4px !important;padding-right:4px !important}.mi-wauto{width:auto !important}
.c-bi{color:#0b77c2}.c-bd{color:#085387}.c-deep{color:#03293d}
.bd-brand{border-color:#007DBC}.bdt-brand{border-top-color:#007DBC}.bd-warn{border-color:#F7B825}
.bg-brand{background-color:#007DBC}.bg-bd{background-color:#085387}.bg-ok{background-color:#689e18}
.bl3{border-left-width:3px}.bb3{border-bottom-width:3px}.bd3{border-width:3px}
.mh190{max-height:190px}.mh240{max-height:240px}.mh280{max-height:280px}.mh300{max-height:300px}
.mh340{max-height:340px}.mh420{max-height:420px}.mh440{max-height:440px}
.mh55{max-height:55vh}.mh62{max-height:62vh}.mh65{max-height:65vh}.mh68{max-height:68vh}
.mw220{max-width:220px}.mw240{max-width:240px}.mw300{max-width:300px}.mw320{max-width:320px}
.mw420{max-width:420px}.mw1520{max-width:1520px}
.mnw52{min-width:52px}.mnw260{min-width:260px}.w38{width:38px}.w46{width:46%}.h22{height:22px}
.top3{top:3px}.lf3{left:3px}.lf21{left:21px}.pl18{padding-left:18px}.z60{z-index:60}
.m-input{width:100%;min-height:42px;padding:10px 12px;font-size:13px;border:1px solid #cbd5e1;border-radius:0.85rem;background:#f8fafc;color:#1e293b;line-height:1.5;transition:border-color .2s,box-shadow .2s;}
.m-input:hover{border-color:#94a3b8}
.m-input:focus{outline:none;border-color:#007DBC;box-shadow:0 0 0 0.25rem rgba(0,125,188,.18)}
.m-input[readonly]{background:#f8fafc;color:#64748b}
.m-btn-primary,.m-btn-sec,.m-btn-ghost,.m-btn-danger{border-width:1px;border-style:solid;border-radius:0.85rem;transition:background .2s,color .2s,border-color .2s;}
.m-btn-primary{background:#0b77c2;color:#fff;border-color:#0b77c2}
.m-btn-primary:hover{background:#085387;border-color:#085387}
.m-btn-sec{background:#fff;color:#0b77c2;border-color:#cbd5e1}
.m-btn-sec:hover{background:#f8fafc;border-color:#007DBC;color:#085387}
.m-btn-ghost{background:transparent;color:#0b77c2;border-color:transparent}
.m-btn-ghost:hover{background:#f1f5f9}
.m-btn-danger{background:#c5192d;color:#fff;border-color:#c5192d}
.m-btn-danger:hover{background:#9c1424;border-color:#9c1424}
.m-ico{transition:color .12s}.m-ico:hover{color:#0b77c2}
.m-cell{width:100%;height:32px;font-size:11px;font-weight:700;border:0;background:transparent;border-radius:2px;cursor:pointer}
.m-cell:hover{box-shadow:inset 0 0 0 2px #26bde2}
.m-cell2{padding:8px 0;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer}
.m-cell2:hover{box-shadow:inset 0 0 0 2px #26bde2}
.m-hatch{background:repeating-linear-gradient(45deg,#f6f8f9,#f6f8f9 3px,#eceff2 3px,#eceff2 6px)}
.m-code{font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:12px;line-height:1.6;
  background:#0f172a;color:#e2e8f0;border-radius:0.75rem;padding:12px;width:100%;border:0;resize:vertical}
.m-code:focus{outline:2px solid #007DBC}
input[type=checkbox],input[type=radio]{accent-color:#007DBC;width:14px;height:14px}
@media (prefers-reduced-motion:reduce){*{animation:none !important;transition:none !important}}`;

/* ══════════════════ Référentiels et codifications ══════════════════ */
const D_STATUS = [["Active","Actif"],["Inactive","Inactif"]];
const D_POI_SUB = [
  ["Aéroport","APT"],["Point de distribution","FDP"],["Formation sanitaire","HEAL"],["Marché","MKT"],
  ["Unité de stockage mobile","MSU"],["Entrepôt partenaire","CP_WH"],["Port","PT"],["Gare ferroviaire","TRN"],
  ["Camp de déplacés","CMP"],["École","SCH"],["Commerce détaillant","SH"],["Installation de stockage","STOR"],
  ["Site de télécommunication","TC"],["Bureau","OFF"],["Entrepôt principal","ST"],["Atelier","WS"],
];
const D_TAGS = [
  ["URT","Transferts de ressources non conditionnels"],["ACL","Création d'actifs et moyens d'existence"],
  ["CAR","Adaptation climatique et gestion des risques"],["SMP","Programmes en milieu scolaire"],
  ["NTA","Traitement de la malnutrition"],["MPA","Prévention de la malnutrition"],
  ["SAMS","Appui aux marchés des petits producteurs"],["EPA","Préparation aux urgences"],
  ["AAM","Analyse, évaluation et suivi"],
];
const D_URBAN = [["Non","Zone rurale"],["Oui","Zone urbaine"]];
const D_SECURITY = [[0,"0 — Aucune restriction"],[1,"1 — Restriction modérée"],[3,"3 — Restriction stricte"],[99,"99 — Zone interdite"]];
const D_MODALITY = ["Espèces","Coupons","Vivres","Renforcement de capacités","Mixte"];
const D_OFFICES = ["Bureau de terrain d'Ambovombe","Bureau de terrain d'Ampanihy","Bureau de terrain de Toliara",
  "Bureau de terrain de Manakara","Bureau central d'Antananarivo"];
const D_PARTNERS = ["Partenaire A","Partenaire B","Partenaire C","Partenaire D","Partenaire E"];
const D_ADJUST = [["none","Aucun ajustement"],["up","Extension de la couverture"],["down","Réduction de la couverture"],["new","Nouveau ciblage"]];

/* Masterlist d'indicateurs de résultat, entièrement modifiable dans les paramètres */
const D_INDICATORS = [
  { id:"FCS",  name:"Score de consommation alimentaire — ménages en consommation acceptable", unit:"%", target:80, dir:"up",   basket:"Consommation alimentaire", method:"Enquête ménage", freq:"Semestriel" },
  { id:"rCSI", name:"Indice réduit des stratégies d'adaptation",                               unit:"idx",target:12, dir:"down", basket:"Stratégies d'adaptation", method:"Enquête ménage", freq:"Semestriel" },
  { id:"LCSI", name:"Stratégies d'adaptation des moyens d'existence — aucune stratégie",       unit:"%", target:60, dir:"up",   basket:"Stratégies d'adaptation", method:"Enquête ménage", freq:"Annuel" },
  { id:"FES",  name:"Part des dépenses consacrées à l'alimentation",                           unit:"%", target:65, dir:"down", basket:"Économie du ménage",      method:"Enquête ménage", freq:"Annuel" },
  { id:"MAD",  name:"Régime alimentaire minimum acceptable — enfants 6 à 23 mois",             unit:"%", target:35, dir:"up",   basket:"Nutrition",               method:"Enquête ménage", freq:"Annuel" },
  { id:"MAMR", name:"Taux de guérison du traitement de la malnutrition aiguë modérée",         unit:"%", target:75, dir:"up",   basket:"Nutrition",               method:"Registres des sites", freq:"Mensuel" },
  { id:"MAMD", name:"Taux d'abandon du traitement de la malnutrition aiguë modérée",           unit:"%", target:15, dir:"down", basket:"Nutrition",               method:"Registres des sites", freq:"Mensuel" },
  { id:"RET",  name:"Taux de rétention scolaire",                                              unit:"%", target:90, dir:"up",   basket:"Éducation",               method:"Registres scolaires", freq:"Annuel" },
  { id:"COV",  name:"Couverture du programme de prévention",                                   unit:"%", target:70, dir:"up",   basket:"Couverture",              method:"Enquête de couverture", freq:"Annuel" },
  { id:"ADH",  name:"Adhérence — participation à un nombre suffisant de distributions",        unit:"%", target:80, dir:"up",   basket:"Couverture",              method:"Suivi post-distribution", freq:"Trimestriel" },
];

const TABS_ALL = [["home","Accueil"],["planning","Planning"],["actual","Actual Data"],
  ["analytics","Analyses"],["reports","Rapports"],["settings","Paramètres"]];
const D_ROLES = {
  super:  { label:"Super-utilisateur", tabs:TABS_ALL.map(t=>t[0]), edit:true, del:true, validate:true, admin:true, sync:true },
  admin:  { label:"Administrateur",    tabs:TABS_ALL.map(t=>t[0]), edit:true, del:true, validate:true, admin:true, sync:true },
  validator:{label:"Validateur",       tabs:["home","planning","actual","analytics","reports"], edit:true, del:false, validate:true, admin:false, sync:true },
  editor: { label:"Éditeur",           tabs:["home","planning","actual","analytics","reports"], edit:true, del:false, validate:false,admin:false, sync:true },
  viewer: { label:"Lecteur",           tabs:["home","planning","actual","reports"],              edit:false,del:false, validate:false,admin:false, sync:false },
};

const D_WEIGHTS = {
  security:   { label:"Situation sécuritaire",             pts:{0:0,1:2,3:4,99:0} },
  synergies:  { label:"Synergies de programme",            pts:{0:2,1:0} },
  newPartner: { label:"Nouveau partenaire",                pts:{0:0,1:3} },
  expPartner: { label:"Expérience du partenaire",          pts:{0:0,1:2,2:4} },
  issueIPM:   { label:"Problèmes du suivi interne",        pts:{0:0,1:2,2:4} },
  issueReport:{ label:"Problèmes des rapports partenaire", pts:{0:0,1:2,2:4} },
  issueCFM:   { label:"Problèmes du mécanisme de plainte", pts:{0:0,1:2,2:4} },
  fraud:      { label:"Fraude et corruption",              pts:{0:0,1:3,2:6} },
  benef:      { label:"Nombre de bénéficiaires",           pts:{0:0,1:1,2:2,3:3}, th:[500,2000,5000] },
  recency:    { label:"Ancienneté de la dernière visite",  pts:{0:0,1:1,2:2,3:3,4:4,5:5} },
};

const D_FORMULAS = [
  { id:"minInterval", label:"Intervalle minimum requis (mois)", expr:"duration / riskLevel", vars:["duration","riskLevel"], desc:"Durée d'opération divisée par le niveau de risque", core:true },
  { id:"minFreq", label:"Fréquence minimale requise", expr:"duration / minInterval", vars:["duration","minInterval"], desc:"Nombre de visites attendues sur la durée", core:true },
  { id:"targetPerMonth", label:"Sites ciblés par mois", expr:"nbSites / minInterval", vars:["nbSites","minInterval"], desc:"Charge mensuelle théorique", core:true },
  { id:"feasibilityRatio", label:"Ratio de faisabilité", expr:"feasiblePerMonth / targetPerMonth", vars:["feasiblePerMonth","targetPerMonth"], desc:"Capacité rapportée à la cible", core:true },
  { id:"adjustedFreq", label:"Fréquence ajustée", expr:"minFreq * feasibilityRatio", vars:["minFreq","feasibilityRatio"], desc:"Fréquence corrigée par la capacité réelle", core:true },
  { id:"adjustedInterval", label:"Intervalle ajusté (mois)", expr:"max(1, duration / adjustedFreq)", vars:["duration","adjustedFreq"], desc:"Intervalle réellement tenable, plancher à un mois", core:true },
];
/* Variables disponibles dans l'éditeur de calculs */
const CALC_VARS = [
  ["duration","Durée d'opération en mois","Paramètres de couverture"],
  ["riskLevel","Niveau de risque de 1 à 3","Paramètres de couverture"],
  ["nbSites","Nombre de sites actifs du couple bureau × activité","Registre des sites"],
  ["feasiblePerMonth","Capacité mensuelle de visites déclarée","Paramètres de couverture"],
  ["minInterval","Intervalle minimum requis","Calcul dérivé"],
  ["minFreq","Fréquence minimale requise","Calcul dérivé"],
  ["targetPerMonth","Sites ciblés par mois","Calcul dérivé"],
  ["feasibilityRatio","Ratio de faisabilité","Calcul dérivé"],
  ["adjustedFreq","Fréquence ajustée","Calcul dérivé"],
  ["adjustedInterval","Intervalle ajusté","Calcul dérivé"],
  ["beneficiaries","Nombre de bénéficiaires du site","Registre des sites"],
  ["population","Population de la zone pour l'année en cours","Module population"],
  ["visitsDone","Visites réalisées sur l'exercice","Suivi de processus"],
  ["visitsPlanned","Visites planifiées sur l'exercice","Plan de suivi"],
  ["score","Score de risque du site sur 100","Registre des sites"],
];

/* ══════════════════ Référentiels repris du plan de suivi ══════════════════ */
const ACT_CATEGORIES = [
  "Unconditional resource transfers to support access to food",
  "Asset creation and livelihood support activities",
  "Climate adaptation and risk management activities",
  "School meal activities",
  "Nutrition treatment activities",
  "Malnutrition prevention activities",
  "Smallholder agricultural market support activities",
  "Individual capacity strengthening activities",
  "Institutional capacity strengthening activities",
];
const PROG_AREAS = [
  ["Unconditional Resource Transfers (URT)", ["General Distribution","HIV/TB Mitigation & Safety Nets"]],
  ["Asset Creation and Livelihood (ACL)", ["Food assistance for asset","Food assistance for training"]],
  ["Action to protect against climate shocks", ["Forecast-based Anticipatory Actions","Macro Insurance","Micro/Meso Insurance","Other Climate adaptation and risk management Activities"]],
  ["School based programmes (SMP)", ["School feeding (on-site)","School feeding (take-home rations)","School feeding (alternative modalities)"]],
  ["Malnutrition treatment programme (NTA)", ["Treatment of moderate acute malnutrition","HIV/TB Care & treatment","Therapeutic feeding"]],
  ["Malnutrition prevention programme (NPA)", ["Prevention of acute malnutrition","Prevention of stunting","Prevention of micronutrient deficiencies"]],
  ["Smallholder agricultural market support (SAMS)", ["Smallholder agricultural market support activities"]],
];
const CAT_TO_AREA = {
  "Unconditional resource transfers to support access to food":"Unconditional Resource Transfers (URT)",
  "Asset creation and livelihood support activities":"Asset Creation and Livelihood (ACL)",
  "Climate adaptation and risk management activities":"Action to protect against climate shocks",
  "School meal activities":"School based programmes (SMP)",
  "Nutrition treatment activities":"Malnutrition treatment programme (NTA)",
  "Malnutrition prevention activities":"Malnutrition prevention programme (NPA)",
  "Smallholder agricultural market support activities":"Smallholder agricultural market support (SAMS)",
};
const SITE_TYPES = ["FDP","Health Center","School","Warehouse","Market","Community site","Other (smallholder farmers, communities)"];
const MONITORING_TYPES = ["Distribution monitoring","Activity Implementation Monitoring","Post-distribution monitoring","Outcome monitoring"];
const DURATIONS = ["Under 3 months","3-6 months","6-12 months","Over 12 months"];
const MODALITY_TYPES = ["Cash","Voucher","Food","Capacity Strengthening","Mix"];
const D_MMR = PROG_AREAS.map(([area], _i) => {
  const school = /School/.test(area), nta = /NTA/.test(area), npa = /NPA/.test(area), urt = /URT/.test(area);
  return { id:"mmr"+_i, area, cashVoucher: urt ? "No" : "",
    duration: (nta||npa||school) ? "6-12 months" : "3-6 months",
    siteType: school ? "School" : nta ? "Health Center" : (urt||npa) ? "FDP" : "Other (smallholder farmers, communities)",
    monitoring: (urt||npa) ? "Distribution monitoring" : "Activity Implementation Monitoring",
    guidance: "Chaque site doit être visité au moins une fois par an.", coef: 1 };
});

/* Barème de priorité repris du plan de suivi.
   Quatre sous-scores, puis priorité = drapeaux urgents + nouveau partenaire/ancienneté + moyenne. */
const D_SCORING = {
  caseload: { label:"Taille de la charge (bénéficiaires)", thresholds:[200,1000], pts:[0,1,2] },
  flagLevel: { label:"Seuil de déclenchement des drapeaux urgents", value:2, pts:2 },
  overdue: { label:"Points quand l'intervalle requis est dépassé", pts:3 },
  newPartner: { label:"Points nouveau partenaire ou visite en retard", pts:2 },
  high: { label:"Seuil de priorité haute", value:2 },
  medium: { label:"Seuil de priorité moyenne", value:1 },
};
function caseloadScore(benef, sc){
  const th = (sc && sc.caseload.thresholds) || [200,1000];
  const pts = (sc && sc.caseload.pts) || [0,1,2];
  const b = n(benef);
  return b < th[0] ? pts[0] : b < th[1] ? pts[1] : pts[2];
}
/* Reproduit : Score Last visite, Urgent Red flags, New partner and time since last visit, average, Priority */
function sitePriority(s, db){
  const sc = (db && db.scoring) || D_SCORING;
  const req = db ? siteRequirement(db, s) : { interval:0 };
  const months = monthsSince(s.lastVisit);
  /* 0 si l'intervalle requis n'est pas encore atteint, sinon pénalité */
  const scoreLastVisit = (!s.subOffice || !(s.poi||s.siteName)) ? 0
    : (req.interval && months !== null && req.interval > months) ? 0 : n(sc.overdue.pts);
  const lvl = n(sc.flagLevel.value);
  const urgentFlags = (n(s.issueIPM)>=lvl || n(s.issueReport)>=lvl || n(s.issueCFM)>=lvl
    || n(s.expPartner)>=lvl || n(s.fraud)>0) ? n(sc.flagLevel.pts) : 0;
  const newPartnerTime = (n(s.newPartner) + scoreLastVisit === 0) ? 0 : n(sc.newPartner.pts);
  const caseload = caseloadScore(s.beneficiaries, sc);
  const parts = [n(s.issueIPM), n(s.issueReport), n(s.issueCFM), n(s.fraud), n(s.expPartner), n(s.synergies), caseload];
  const average = parts.reduce((t,x)=>t+x,0) / parts.length;
  const priority = Math.round(urgentFlags + newPartnerTime + average);
  const level = priority >= n(sc.high.value) ? 3 : priority >= n(sc.medium.value) ? 2 : 1;
  return { scoreLastVisit, urgentFlags, newPartnerTime, caseload, average:r2(average), priority, level,
           monthsSinceVisit: months===null ? null : r1(months), requiredInterval: req.interval };
}
/* Colonnes dérivées du plan mensuel, reprises des formules de la feuille bureau */
function siteDerived(s, db){
  const plan = s.plan || [];
  const activeSite = plan.some(p=>p.activeMonth!==false) ? 1 : 0;
  const planCount = plan.filter(p=>p.planned).length;
  const visitCount = plan.filter(p=>p.done).length;
  const p = sitePriority(s, db);
  const monthsRemaining = 12 - (new Date().getMonth()+1);
  const sitesToBePlanned = (planCount < p.priority || visitCount < p.priority) ? Math.max(0, p.priority - visitCount) : 0;
  const visitsToBePlanned = sitesToBePlanned === 0 ? 0
    : (monthsRemaining >= sitesToBePlanned ? sitesToBePlanned : Math.ceil(monthsRemaining / sitesToBePlanned));
  return { activeSite, planCount, visitCount, monthsRemaining, sitesToBePlanned, visitsToBePlanned,
           visitedOnce: visitCount===1?1:0, visitedTwice: visitCount===2?1:0,
           visitedThrice: visitCount===3?1:0, visitedFourPlus: visitCount>3?1:0, ...p };
}
/* Tableau de couverture : actif, prévu, réalisé et les trois taux, par mois */
function coverageRows(db, category, scope){
  const sites = db.sites.filter(s => (!category || s.activityCategory===category)
    && (!scope || s.subOffice===scope));
  const mk = (fn) => MONTHS.map((_,mi)=>fn(mi));
  const active = mk(mi => sites.filter(s => s.status!=="Inactive" && (s.plan[mi]||{}).activeMonth!==false).length);
  const plan   = mk(mi => sites.filter(s => (s.plan[mi]||{}).planned).length);
  const actual = mk(mi => sites.filter(s => (s.plan[mi]||{}).done).length);
  return { sites: sites.length, active, plan, actual,
    plannedCoverage: mk(mi => pct(plan[mi], active[mi])),
    visited:          mk(mi => pct(actual[mi], plan[mi])),
    actualCoverage:   mk(mi => pct(actual[mi], active[mi])),
    cumul: { active: Math.max(0,...active), plan: plan.reduce((t,x)=>t+x,0), actual: actual.reduce((t,x)=>t+x,0) } };
}

export { ACT_CATEGORIES, C, CALC_VARS, CAT_TO_AREA, CSS, DURATIONS, D_ADJUST, D_FORMULAS, D_INDICATORS, D_MMR, D_MODALITY, D_OFFICES, D_PARTNERS, D_POI_SUB, D_ROLES, D_SCORING, D_SECURITY, D_STATUS, D_TAGS, D_URBAN, D_WEIGHTS, MODALITY_TYPES, MONITORING_TYPES, MONTHS, MONTHS_L, PROG_AREAS, SERIES, SITE_TYPES, TABS_ALL, caseloadScore, coverageRows, siteDerived, sitePriority };
