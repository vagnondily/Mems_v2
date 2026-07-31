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
/* ═══════════════════════════════════════════════════════════════════════
   Évaluation des formules de couverture.

   Ces expressions sont écrites par l'utilisateur dans Paramètres → Calculs : elles
   décident de l'intervalle minimal entre deux visites, de la fréquence requise et de
   la faisabilité du plan. C'est le cœur de la planification fondée sur le risque.

   Elles étaient évaluées par `new Function(...)`. Cela fonctionnait en développement
   et NE FONCTIONNAIT PAS EN PRODUCTION : la politique de sécurité du contenu
   n'autorise que les scripts de même origine, sans `unsafe-eval`, et le navigateur
   refuse donc de construire une fonction depuis une chaîne. L'erreur était attrapée,
   et chaque formule rendait 0.

   Conséquence, invisible parce que silencieuse : l'exigence minimale de suivi
   affichait « 0 visite requise » et « 0 % » quelles que soient les données, les
   paramètres de couverture montraient des colonnes de zéros, et le plan de visites
   n'était fondé sur rien. Le seul indice était un écran qui semblait mal renseigné.

   On n'ajoute évidemment pas `unsafe-eval` pour faire marcher un calcul : ce serait
   ouvrir l'exécution de code arbitraire dans toute l'application pour six formules
   d'arithmétique. On écrit donc l'interpréteur — une descente récursive de trente
   lignes, qui ne peut rien faire d'autre que du calcul.

   Grammaire, du moins prioritaire au plus :

     expression := terme (('+' | '-') terme)*
     terme      := facteur (('*' | '/') facteur)*
     facteur    := ('-' | '+')? primaire
     primaire   := nombre | variable | fonction '(' expression (',' expression)* ')'
                 | '(' expression ')'
   ═══════════════════════════════════════════════════════════════════════ */

const FN_IMPL = { max:Math.max, min:Math.min, round:Math.round, abs:Math.abs,
                  sqrt:Math.sqrt, floor:Math.floor, ceil:Math.ceil };

/* Découpage en éléments : nombres, identifiants, opérateurs. Tout le reste a déjà
   été refusé par le contrôle des caractères autorisés. */
function lexer(expr){
  const out = []; let i = 0;
  while(i < expr.length){
    const c = expr[i];
    if(c === " "){ i++; continue; }
    if(/[0-9.]/.test(c)){
      let j = i; while(j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const v = Number(expr.slice(i, j));
      if(!Number.isFinite(v)) throw new Error(`nombre invalide : ${expr.slice(i, j)}`);
      out.push({ t:"num", v }); i = j; continue;
    }
    if(/[a-zA-Z_]/.test(c)){
      let j = i; while(j < expr.length && /[a-zA-Z0-9_]/.test(expr[j])) j++;
      out.push({ t:"id", v:expr.slice(i, j) }); i = j; continue;
    }
    if("+-*/(),".includes(c)){ out.push({ t:c }); i++; continue; }
    throw new Error(`caractère inattendu : ${c}`);
  }
  return out;
}

function parser(tokens, scope){
  let k = 0;
  const suivant = () => tokens[k];
  const avaler = (t) => {
    if(!tokens[k] || (t && tokens[k].t !== t)) throw new Error(`« ${t} » attendu`);
    return tokens[k++];
  };

  function expression(){
    let v = terme();
    while(suivant() && (suivant().t === "+" || suivant().t === "-")){
      const op = avaler().t;
      const d = terme();
      v = op === "+" ? v + d : v - d;
    }
    return v;
  }
  function terme(){
    let v = facteur();
    while(suivant() && (suivant().t === "*" || suivant().t === "/")){
      const op = avaler().t;
      const d = facteur();
      /* Une division par zéro rendrait l'infini, qui se propage en silence dans
         tous les totaux. On la refuse : une formule impossible doit se voir. */
      if(op === "/" && d === 0) throw new Error("division par zéro");
      v = op === "*" ? v * d : v / d;
    }
    return v;
  }
  function facteur(){
    if(suivant()?.t === "-"){ avaler("-"); return -facteur(); }
    if(suivant()?.t === "+"){ avaler("+"); return facteur(); }
    return primaire();
  }
  function primaire(){
    const t = suivant();
    if(!t) throw new Error("expression incomplète");
    if(t.t === "num"){ avaler("num"); return t.v; }
    if(t.t === "("){ avaler("("); const v = expression(); avaler(")"); return v; }
    if(t.t === "id"){
      avaler("id");
      if(suivant()?.t === "("){
        const fn = FN_IMPL[t.v];
        if(!fn) throw new Error(`fonction inconnue : ${t.v}`);
        avaler("(");
        const args = [expression()];
        while(suivant()?.t === ","){ avaler(","); args.push(expression()); }
        avaler(")");
        return fn(...args);
      }
      if(!(t.v in scope)) throw new Error(`variable inconnue : ${t.v}`);
      return Number(scope[t.v]) || 0;
    }
    throw new Error("expression invalide");
  }

  const v = expression();
  if(k !== tokens.length) throw new Error("expression mal formée");
  return v;
}

function evalFormula(expr, scope){
  if(!expr || !SAFE_CHARS.test(expr)) return { ok:false, value:0, err:"Caractère non autorisé dans l'expression" };
  /* Les contrôles d'origine restent : ils rejettent tôt, avec un message clair, ce
     que l'interpréteur rejetterait de toute façon. */
  if(/\.\s*[a-zA-Z_]/.test(expr)) return { ok:false, value:0, err:"L'accès aux propriétés est interdit" };
  const allowed = new Set([...Object.keys(scope), ...FNS]);
  const bad = (expr.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) || []).find(t => !allowed.has(t));
  if(bad) return { ok:false, value:0, err:`Variable inconnue : ${bad}` };
  try{
    const v = parser(lexer(expr), scope);
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

export { FNS, KEY, LEVELS, POP_BASE_YEAR, RULE_TYPES, SAFE_CHARS, applyRules, clsx, codeOf, computeMMR, computeParam, evalFormula, fmt, legacyScore, monthsSince, n, paramFor, pct, populationFor, profileColumn, r1, r2, r5, siteRequirement, siteScore, uid };
