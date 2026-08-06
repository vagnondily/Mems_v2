import { Note } from "../components/ui.jsx";
import { rate, seedPDD } from "../views/Planning.jsx";
import { n, r1, r5, uid } from "./calc.js";
import { ACT_CATEGORIES, CAT_TO_AREA, DURATIONS, D_FORMULAS, D_INDICATORS, D_MMR, D_MODALITY, D_OFFICES, D_PARTNERS, D_POI_SUB, D_ROLES, D_SCORING, D_TAGS, D_WEIGHTS, MONITORING_TYPES, MONTHS, PROG_AREAS, SITE_TYPES, niveauIndicateur } from "./constants.js";

/* ══════════════════ Jeu de données initial ══════════════════ */
const GEO = [
  ["Pays","Androy","Ampanihy","Beahitse"],["Pays","Androy","Ampanihy","Ejeda"],
  ["Pays","Androy","Tsihombe","Marovato"],["Pays","Anosy","Fort Dauphin","Manambaro"],
  ["Pays","Atsimo-Andrefana","Toliara","Betioky"],["Pays","Vatovavy","Manakara","Ambila"],
  ["Pays","Androy","Bekily","Beraketa"],["Pays","Androy","Ambovombe","Ambanisarika"],
  ["Pays","Analamanga","Antananarivo","Ambohidratrimo"],["Pays","Atsimo-Andrefana","Toliara","Sakaraha"],
];
function seedDB(){
  const year = new Date().getFullYear();
  const pick = a => a[Math.floor(Math.random()*a.length)];
  /* Effectifs et capacités repris du plan de suivi, réduits d'un tiers pour rester lisibles.
     [catégorie, nombre de sites, durée d'opération, niveau de risque, visites faisables par mois] */
  const PLAN = [
    ["Bureau de terrain d'Ambovombe", [
      ["Unconditional resource transfers to support access to food", 30, 6, 2, 4],
      ["School meal activities", 46, 9, 2, 12],
      ["Nutrition treatment activities", 38, 12, 2, 10],
      ["Malnutrition prevention activities", 13, 6, 1, 6],
      ["Asset creation and livelihood support activities", 2, 3, 1, 1]]],
    ["Bureau de terrain d'Ampanihy", [
      ["Unconditional resource transfers to support access to food", 21, 6, 2, 12],
      ["School meal activities", 43, 9, 2, 30],
      ["Nutrition treatment activities", 34, 12, 2, 12],
      ["Malnutrition prevention activities", 10, 6, 1, 10]]],
    ["Bureau de terrain de Toliara", [
      ["School meal activities", 31, 9, 2, 14],
      ["Nutrition treatment activities", 30, 12, 2, 9],
      ["Climate adaptation and risk management activities", 12, 6, 1, 5],
      ["Malnutrition prevention activities", 8, 6, 1, 4],
      ["Unconditional resource transfers to support access to food", 7, 6, 2, 3],
      ["Smallholder agricultural market support activities", 3, 3, 1, 2]]],
  ];
  const CAT_TAG = {
    "Unconditional resource transfers to support access to food":"URT",
    "Asset creation and livelihood support activities":"ACL",
    "Climate adaptation and risk management activities":"CAR",
    "School meal activities":"SMP",
    "Nutrition treatment activities":"NTA",
    "Malnutrition prevention activities":"MPA",
    "Smallholder agricultural market support activities":"SAMS" };
  const CAT_SITE = { "School meal activities":"École", "Nutrition treatment activities":"Formation sanitaire",
    "Malnutrition prevention activities":"Point de distribution",
    "Unconditional resource transfers to support access to food":"Point de distribution" };
  const sites = []; const specs = [];
  PLAN.forEach(([office, cats]) => cats.forEach(([cat, count, dur, risk, feas]) => {
    specs.push({ office, cat, dur, risk, feas, count });
    for(let k=0;k<count;k++) sites.push({ office, cat });
  }));
  sites.forEach((spec,i) => {
    const g = GEO[i % GEO.length];
    const cat = spec.cat;
    const subLabel = CAT_SITE[cat] || pick(D_POI_SUB)[0];
    const sub = D_POI_SUB.find(x=>x[0]===subLabel) || D_POI_SUB[0];
    const area = CAT_TO_AREA[cat] || "";
    const areaTags = (PROG_AREAS.find(a=>a[0]===area)||[null,[]])[1];
    Object.assign(spec, {
      id:"L"+String(i+1).padStart(4,"0"),
      status: i % 17 === 0 ? "Inactive" : "Active",
      poi: `${subLabel === "École" ? "EPP" : subLabel === "Formation sanitaire" ? "CSB" : "Site"} ${g[3]} ${i+1}`,
      poiSubtype: sub[0], activityTag: CAT_TAG[cat] || "URT", subOffice: spec.office,
      antenne: pick(["Bekily","Beloha","Tsihombe","Amboasary","Betioky","Manakara","Ambovombe"]),
      activityCategory: cat, programArea: area, programTag: pick(areaTags.length?areaTags:["—"]),
      siteType: pick(SITE_TYPES), monitoringType: pick(MONITORING_TYPES), duration: pick(DURATIONS),
      adm1: g[1], adm2: g[2], adm3: g[3], adm4: `Fokontany ${g[3]} ${(i%9)+1}`,
      urbanArea: i % 7 === 0 ? "Oui" : "Non",
      lat: r5(-25+Math.random()*8), lon: r5(44+Math.random()*4),
      security: pick([0,0,0,1,1,3]), modality: pick(D_MODALITY),
      beneficiaries: 200 + Math.floor(Math.random()*7000),
      partner: pick(D_PARTNERS), responsible: pick(["A. Rakoto","M. Rasoa","P. Rabe","S. Andria","L. Razafy"]),
      synergies: pick([0,0,1]), newPartner: pick([0,0,0,0,0,1]), expPartner: pick([0,0,0,0,1,1,2]),
      issueIPM: pick([0,0,0,0,1,1,2]), issueReport: pick([0,0,0,1]), issueCFM: pick([0,0,0,0,1,2]),
      fraud: pick([0,0,0,0,0,0,1]),
      lastVisit:"", plan: Array.from({length:12},()=>({planned:false,done:false,activeMonth:true,cp:"",monitor:"",report:"",moda:""})),
    });
  });
  const params = specs.filter((v,i,a)=>a.findIndex(x=>x.office===v.office&&x.cat===v.cat)===i)
    .map((sp,i) => ({ id:uid("p"), csp:`ACT-${year}-${String(i+1).padStart(3,"0")}`,
      office:sp.office, tag:CAT_TAG[sp.cat]||"URT", category:sp.cat,
      duration:sp.dur, riskLevel:sp.risk, feasiblePerMonth:sp.feas }));

  const visits = [];
  sites.forEach(s => { if(s.status==="Inactive") return;
    for(let k=0;k<2+Math.floor(Math.random()*3);k++){
      const m = Math.floor(Math.random()*6); s.plan[m].planned = true;
      if(Math.random()<0.68){ s.plan[m].done = true; s.plan[m].monitor = s.responsible;
        visits.push({ id:uid("v"), siteId:s.id, date:new Date(year,m,3+Math.floor(Math.random()*24)).toISOString().slice(0,10),
          tag:s.activityTag, office:s.subOffice, monitor:s.responsible, form:"340943", status:"Validé" }); } }
    const vs = visits.filter(v=>v.siteId===s.id).map(v=>v.date).sort();
    s.lastVisit = vs.length ? vs[vs.length-1] : ""; });
  /* quelques sites conservent une visite ancienne pour illustrer le dépassement d'intervalle */
  sites.filter((_,i)=>i%6===0).forEach(s => { if(!s.lastVisit)
    s.lastVisit = new Date(year-1, Math.floor(Math.random()*12), 12).toISOString().slice(0,10); });

  const outputs = [];
  D_TAGS.slice(0,6).forEach(t => MONTHS.forEach((m,i) => {
    if(i > new Date().getMonth()) return;
    const planned = 4000+Math.floor(Math.random()*9000);
    outputs.push({ id:uid("o"), tag:t[0], month:i, planned, actual: Math.round(planned*(0.62+Math.random()*0.45)),
      adjust: pick(["none","none","up","down","new"]), note:"" }); }));

  const outcomes = [];
  D_INDICATORS.forEach(o => ["Androy","Anosy","Atsimo-Andrefana","Vatovavy"].forEach(reg => {
    const base = o.dir==="up" ? o.target*(0.6+Math.random()*0.5) : o.target*(0.85+Math.random()*0.5);
    outcomes.push({ id:uid("c"), indicator:o.id, adm1:reg, round:"Référence", planned:o.target,
      value:r1(base), date:`${year}-02-15`, sample:180+Math.floor(Math.random()*300) });
    outcomes.push({ id:uid("c"), indicator:o.id, adm1:reg, round:"Suivi S1", planned:o.target,
      value:r1(o.dir==="up"? base*(1+Math.random()*0.25) : base*(0.78+Math.random()*0.18)),
      date:`${year}-06-20`, sample:180+Math.floor(Math.random()*300) }); }));

  const audit = ["Plan de suivi mis à jour","Extraction ODK Central — 128 soumissions",
    "Paramètres de couverture révisés","4 sites ajoutés au registre"].map((t,i)=>({
    id:uid("a"), at:new Date(Date.now()-i*8.6e7).toISOString(), user:pick(["A. Rakoto","M. Rasoa","P. Rabe"]),
    office:pick(D_OFFICES), kind: i%2 ? "odk" : "plan", text:t }));

  const rawRows = Array.from({length:120},(_,i)=>({
    _id: 1000+i, site_id: sites[i % sites.length].id, visit_date: new Date(year, i%6, 1+(i%27)).toISOString().slice(0,10),
    enumerator: pick(["A. Rakoto","M. Rasoa","P. Rabe"]),
    q_stock: i%13===0 ? "" : pick(["oui","non","oui","oui"]),
    q_score: i%17===0 ? "" : String(40+Math.floor(Math.random()*60)),
    q_benef: String(20+Math.floor(Math.random()*400)),
  }));

  return {
    year, sites, params, visits, outputs, outcomes, audit,
    indicators: D_INDICATORS.map(o => ({ ...o, level: o.level || niveauIndicateur(o.id) })),
    population: GEO.map(g => ({ key:g[2], level:"adm2", base: 40000+Math.floor(Math.random()*160000), rate: 2.7, values:{} }))
      .filter((v,i,a)=>a.findIndex(x=>x.key===v.key)===i),
    pdd: seedPDD(),
    odkForms: [
      { id:uid("f"), formId:"340943", name:"Suivi de processus — visite de site", kind:"process",
        server:"", token:"", siteField:"site_id", dateField:"visit_date", tag:"NTA",
        xlsform:null, labels:{}, records:1245, last:"", rows: rawRows },
      { id:uid("f"), formId:"341102", name:"Suivi post-distribution", kind:"outcome",
        server:"", token:"", siteField:"site_id", dateField:"today", tag:"URT",
        xlsform:null, labels:{}, records:876, last:"", rows: [] },
    ],
    datasets: [], scripts: [],
    lists: { offices:[...D_OFFICES], partners:[...D_PARTNERS], modalities:[...D_MODALITY],
      poiSub: D_POI_SUB.map(x=>({label:x[0], code:x[1]})), tags: D_TAGS.map(x=>({code:x[0], label:x[1]})) },
    geo: GEO.map(g => ({ id:uid("g"), adm0:g[0], adm1:g[1], adm2:g[2], adm3:g[3], adm4:"", code:"" })),
    weights: JSON.parse(JSON.stringify(D_WEIGHTS)),
    scoring: JSON.parse(JSON.stringify(D_SCORING)),
    mmr: JSON.parse(JSON.stringify(D_MMR)),
    actCategories: [...ACT_CATEGORIES],
    formulas: JSON.parse(JSON.stringify(D_FORMULAS)),
    roles: JSON.parse(JSON.stringify(D_ROLES)),
    users: [], dashboards: [{ id:uid("db"), name:"Vue générale", widgets:[
      { id:uid("w"), type:"bar", source:"sites", dim:"subOffice", measure:"count", title:"Sites par bureau" },
      { id:uid("w"), type:"pie", source:"sites", dim:"activityTag", measure:"beneficiaries", title:"Bénéficiaires par activité" }]}],
    reportTemplates: [
      { id:uid("t"), name:"Rapport mensuel de suivi", blocks:["kpi","coverage","activity","sites"],
        intro:"Rapport mensuel de suivi de processus\n\nPériode : {periode}\nOrganisation : {org}" },
      { id:uid("t"), name:"Note de couverture trimestrielle", blocks:["kpi","coverage"], intro:"Note de couverture\n\nPériode : {periode}" },
    ],
    settings: { org:"Bureau pays", unit:"Unité suivi et évaluation", logo:"", currency:"MGA",
      dateFmt:"DD/MM/YYYY", pageSize:25, syncInterval:30, notifications:true,
      apiToken:uid("tok")+uid(""), apiEnabled:false, odkBase:"https://odk-central.example.org" },
  };
}

export { GEO, seedDB };
