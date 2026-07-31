import { rate } from "../views/Planning.jsx";
import { D_FORMULAS, D_WEIGHTS, sitePriority } from "./constants.js";

/* ══════════════════ Utilitaires ══════════════════ */
const uid = (p="id") => p + Math.random().toString(36).slice(2,9);
const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
const r1 = (v) => Math.round(v*10)/10;
const r2 = (v) => Math.round(v*100)/100;
const r5 = (v) => Math.round(v*1e5)/1e5;
const pct = (a,b) => (b>0 ? Math.round(a/b*100) : 0);
const fmt = (v) => (Number.isFinite(+v) ? +v : 0).toLocaleString("fr-FR");
const clsx = (...a) => a.filter(Boolean).join(" ");
const monthsSince = (d) => { if(!d) return null; const t=new Date(d); if(isNaN(t)) return null;
  return Math.max(0,(Date.now()-t.getTime())/(1000*60*60*24*30.44)); };
const codeOf = (list, label) => (list.find(x=>x[0]===label)||[])[1] || "";

async function sha256(txt){
  try{ const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
  catch(e){ let h=0; for(let i=0;i<txt.length;i++){ h=(h*31+txt.charCodeAt(i))|0; } return "fb"+(h>>>0).toString(16); }
}
const KEY = "mems:v4";

/* ══════════════════ Calculs métier ══════════════════ */
function siteScore(s, weights, db){
  if(db){ const p = sitePriority(s, db);
    return { points:p.priority, max:6, pct: Math.min(100, Math.round(p.priority/6*100)),
             level:p.level, detail:p }; }
  return legacyScore(s, weights);
}
function legacyScore(s, weights){
  const W = weights || D_WEIGHTS; let total = 0;
  const add = (k, code) => { total += n((W[k]?.pts||{})[code]); };
  add("security", s.security ?? 0); add("synergies", s.synergies ?? 0);
  add("newPartner", s.newPartner ?? 0); add("expPartner", s.expPartner ?? 0);
  add("issueIPM", s.issueIPM ?? 0); add("issueReport", s.issueReport ?? 0);
  add("issueCFM", s.issueCFM ?? 0); add("fraud", s.fraud ?? 0);
  const th = W.benef?.th || [500,2000,5000]; const b = n(s.beneficiaries);
  add("benef", b<th[0]?0 : b<th[1]?1 : b<th[2]?2 : 3);
  const ms = monthsSince(s.lastVisit);
  add("recency", ms===null ? 5 : Math.min(5, Math.floor(ms/2)));
  let max = 0; Object.values(W).forEach(w => { max += Math.max(0, ...Object.values(w.pts||{}).map(n)); });
  const p = max ? Math.round(total/max*100) : 0;
  return { points: total, max, pct: p, level: p>=60?3 : p>=35?2 : 1 };
}
const LEVELS = { 1:{label:"Faible", cls:"bg-lime-50 text-lime-800 border-lime-200"},
                 2:{label:"Moyenne", cls:"bg-amber-50 text-amber-800 border-amber-200"},
                 3:{label:"Haute", cls:"bg-rose-50 text-rose-800 border-rose-200"} };

const FNS = ["max","min","round","abs","sqrt","floor","ceil"];
const SAFE_CHARS = /^[a-zA-Z0-9_+\-*/() ,.]*$/;
function evalFormula(expr, scope){
  if(!expr || !SAFE_CHARS.test(expr)) return { ok:false, value:0, err:"Caractère non autorisé dans l'expression" };
  if(/\.\s*[a-zA-Z_]/.test(expr)) return { ok:false, value:0, err:"L'accès aux propriétés est interdit" };
  const keys = Object.keys(scope);
  const allowed = new Set([...keys, ...FNS]);
  const bad = (expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).find(t => !allowed.has(t));
  if(bad) return { ok:false, value:0, err:`Variable inconnue : ${bad}` };
  try{
    const fn = new Function(...keys, ...FNS, `"use strict"; return (${expr});`);
    const v = fn(...keys.map(k=>scope[k]), Math.max, Math.min, Math.round, Math.abs, Math.sqrt, Math.floor, Math.ceil);
    return Number.isFinite(v) ? { ok:true, value:v } : { ok:false, value:0, err:"Résultat non numérique" };
  }catch(e){ return { ok:false, value:0, err:e.message }; }
}
function computeParam(row, sites, formulas){
  const F = Object.fromEntries((formulas||D_FORMULAS).map(f=>[f.id,f.expr]));
  const nbSites = sites.filter(s => s.subOffice===row.office && s.activityTag===row.tag && s.status!=="Inactive").length;
  const duration = n(row.duration), riskLevel = n(row.riskLevel)||1, feasiblePerMonth = n(row.feasiblePerMonth);
  const g = (id, sc) => evalFormula(F[id], sc).value;
  const minInterval = riskLevel ? g("minInterval",{duration,riskLevel}) : 0;
  const minFreq = minInterval ? g("minFreq",{duration,minInterval}) : 0;
  const targetPerMonth = minInterval ? g("targetPerMonth",{nbSites,minInterval}) : 0;
  const feasibilityRatio = targetPerMonth ? g("feasibilityRatio",{feasiblePerMonth,targetPerMonth}) : 0;
  const adjustedFreq = g("adjustedFreq",{minFreq,feasibilityRatio});
  const adjustedInterval = adjustedFreq ? g("adjustedInterval",{duration,adjustedFreq}) : (minInterval||1);
  return { nbSites, duration, riskLevel, feasiblePerMonth, minInterval, minFreq,
           targetPerMonth, feasibilityRatio, adjustedFreq, adjustedInterval };
}
const paramFor = (db, s) => db.params.find(p => p.office===s.subOffice && p.tag===s.activityTag) || null;
function siteRequirement(db, site){
  const p = paramFor(db, site); if(!p) return { required:0, interval:0 };
  const c = computeParam(p, db.sites, db.formulas);
  return { required: Math.max(0, Math.round(c.adjustedFreq)), interval: r1(c.adjustedInterval) };
}
function computeMMR(db, year){
  const now = new Date();
  const elapsed = now.getFullYear()===year ? now.getMonth()+1 : (now.getFullYear()>year?12:0);
  let required = 0, done = 0, activeSites = 0, visitedSites = 0;
  db.sites.filter(s=>s.status!=="Inactive").forEach(s => {
    activeSites++;
    required += siteRequirement(db, s).required * (elapsed/12);
    const v = db.visits.filter(v => v.siteId===s.id && new Date(v.date).getFullYear()===year).length;
    done += v; if(v>0) visitedSites++;
  });
  return { pct: pct(done, Math.round(required)), required: Math.round(required), done,
           activeSites, visitedSites, coverage: pct(visitedSites, activeSites), elapsed };
}

/* ── Population : base 2018 projetée par taux de croissance, ou valeur saisie ── */
const POP_BASE_YEAR = 2018;
function populationFor(db, key, year){
  const rec = (db.population||[]).find(p => p.key===key);
  if(!rec) return null;
  if(rec.values && rec.values[year] !== undefined && rec.values[year] !== "") return { value:n(rec.values[year]), source:"saisie" };
  const base = n(rec.base), rate = n(rec.rate)/100;
  if(!base) return null;
  return { value: Math.round(base * Math.pow(1+rate, year - POP_BASE_YEAR)), source:"estimation" };
}

/* ── Moteur d'apurement : règles déclaratives exécutées dans le navigateur ── */
const RULE_TYPES = [
  ["dropEmpty","Supprimer les lignes dont le champ est vide"],
  ["dropDup","Supprimer les doublons sur le champ"],
  ["keepIf","Conserver si le champ est égal à la valeur"],
  ["dropIf","Supprimer si le champ est égal à la valeur"],
  ["range","Conserver si la valeur numérique est comprise entre deux bornes"],
  ["toNumber","Convertir le champ en nombre"],
  ["trim","Supprimer les espaces superflus"],
  ["rename","Renommer le champ"],
  ["recode","Remplacer une valeur par une autre"],
];
function applyRules(rows, rules){
  let out = rows.map(r => ({ ...r }));
  const log = [];
  (rules||[]).filter(r=>r.active!==false).forEach(rule => {
    const before = out.length;
    const f = rule.field, v = rule.value, v2 = rule.value2;
    switch(rule.type){
      case "dropEmpty": out = out.filter(r => r[f]!==undefined && r[f]!==null && String(r[f]).trim()!==""); break;
      case "dropDup": { const seen = new Set();
        out = out.filter(r => { const k = String(r[f]); if(seen.has(k)) return false; seen.add(k); return true; }); break; }
      case "keepIf": out = out.filter(r => String(r[f]) === String(v)); break;
      case "dropIf": out = out.filter(r => String(r[f]) !== String(v)); break;
      case "range": out = out.filter(r => { const x = parseFloat(r[f]); return Number.isFinite(x) && x >= n(v) && x <= n(v2); }); break;
      case "toNumber": out.forEach(r => { const x = parseFloat(r[f]); r[f] = Number.isFinite(x) ? x : null; }); break;
      case "trim": out.forEach(r => { if(typeof r[f]==="string") r[f] = r[f].trim(); }); break;
      case "rename": out.forEach(r => { if(f in r){ r[v] = r[f]; delete r[f]; } }); break;
      case "recode": out.forEach(r => { if(String(r[f]) === String(v)) r[f] = v2; }); break;
      default: break;
    }
    log.push({ rule: rule.type, field:f, before, after: out.length, removed: before - out.length });
  });
  return { rows: out, log };
}
/* ── Indicateurs de performance : formules admin sur les variables ODK ──

   evalFormula (ci-dessus) sert aux paramètres de couverture : de l'arithmétique
   pure sur quelques variables nommées. L'audit des XLSForms MDG a montré que
   les scores de performance ne sont pas de l'arithmétique pure — ce sont des
   conditions imbriquées sur des réponses codées (« =oui », seuils, catégories
   textuelles), avec souvent une pondération dont le dénominateur ne
   correspond plus au maximum réel une fois le formulaire modifié sur le
   terrain (voir les incohérences relevées sur GD_PREVMA, MIARO_PROD et
   NutritionAIM). D'où un évaluateur distinct, plus permissif sur la syntaxe
   (comparaisons, opérateur ternaire, chaînes) mais tout aussi cloisonné :
   pas d'accès aux propriétés, pas d'affectation, pas d'appel hors de la
   liste blanche. */
const IND_FNS = ["max","min","round","abs","sqrt","floor","ceil"];
const IND_CHARS = /^[a-zA-Z0-9_+\-*/()\s,.!<>=&|?:§]*$/;
const STRING_LITERAL = /'[^']*'|"[^"]*"/g;
function hasBareAssignment(withoutStrings){
  return /=/.test(withoutStrings.replace(/===|!==|==|!=|<=|>=/g, ""));
}
function evalIndicator(expr, scope){
  if(!expr) return { ok:false, value:null, err:"formule vide" };
  if(/=>/.test(expr)) return { ok:false, value:null, err:"opérateur « => » non autorisé" };
  const masked = expr.replace(STRING_LITERAL, "§");
  if(!IND_CHARS.test(masked)) return { ok:false, value:null, err:"caractère non autorisé dans la formule" };
  if(hasBareAssignment(masked)) return { ok:false, value:null, err:"« = » seul non autorisé — utilisez « == »" };
  if(/\.\s*[a-zA-Z_]/.test(masked)) return { ok:false, value:null, err:"l'accès aux propriétés est interdit" };
  const keys = Object.keys(scope);
  const allowed = new Set([...keys, ...IND_FNS]);
  const bad = (masked.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).find(t => !allowed.has(t));
  if(bad) return { ok:false, value:null, err:`variable ou fonction inconnue : ${bad}` };
  try{
    const fn = new Function(...keys, ...IND_FNS, `"use strict"; return (${expr});`);
    const v = fn(...keys.map(k=>scope[k]), Math.max, Math.min, Math.round, Math.abs, Math.sqrt, Math.floor, Math.ceil);
    if(v === undefined || (typeof v === "number" && !Number.isFinite(v)))
      return { ok:false, value:null, err:"résultat non calculable (division par zéro ?)" };
    if(typeof v === "object") return { ok:false, value:null, err:"une formule doit renvoyer un nombre, un texte ou vrai/faux" };
    return { ok:true, value:v };
  }catch(e){ return { ok:false, value:null, err:e.message }; }
}
/* Une valeur de ligne qui ressemble à un nombre en devient un, pour que les
   comparaisons (>=, <) fonctionnent sans que l'administrateur ait à convertir
   chaque champ ; les autres restent en l'état pour les comparaisons de texte. */
const numish = (v) => { if(v===null || v===undefined || String(v).trim()==="") return v;
  return /^-?\d+(\.\d+)?$/.test(String(v).trim()) ? parseFloat(v) : v; };
function applyFormulas(rows, formulas){
  const active = (formulas||[]).filter(f => f.active!==false && f.field && f.expr);
  const errors = {};
  const out = rows.map(r => {
    const row = { ...r };
    const scope = Object.fromEntries(Object.entries(row).map(([k,v]) => [k, numish(v)]));
    for(const f of active){
      const res = evalIndicator(f.expr, scope);
      row[f.field] = res.ok ? res.value : null;
      scope[f.field] = row[f.field];
      if(!res.ok){ (errors[f.id] ||= { name:f.name||f.field, count:0, sample:res.err }).count++; }
    }
    return row;
  });
  return { rows: out, errors };
}
function profileColumn(rows, field){
  const vals = rows.map(r => r[field]);
  const nonEmpty = vals.filter(v => v!==undefined && v!==null && String(v).trim()!=="");
  const nums = nonEmpty.map(v => parseFloat(v)).filter(Number.isFinite);
  const uniq = new Set(nonEmpty.map(String)).size;
  const stat = { total: vals.length, missing: vals.length - nonEmpty.length, unique: uniq };
  if(nums.length && nums.length >= nonEmpty.length * 0.8){
    const sorted = [...nums].sort((a,b)=>a-b);
    stat.numeric = true;
    stat.mean = r2(nums.reduce((t,x)=>t+x,0)/nums.length);
    stat.min = sorted[0]; stat.max = sorted[sorted.length-1];
    stat.median = sorted[Math.floor(sorted.length/2)];
  }
  return stat;
}

export { FNS, IND_FNS, KEY, LEVELS, POP_BASE_YEAR, RULE_TYPES, SAFE_CHARS, applyFormulas, applyRules, clsx, codeOf, computeMMR, computeParam, evalFormula, evalIndicator, fmt, legacyScore, monthsSince, n, paramFor, pct, populationFor, profileColumn, r1, r2, r5, siteRequirement, siteScore, uid };
