/* ═══════════════════════════════════════════════════════════════════════
   Chargement du référentiel géographique complet.

   Usage :
     node src/import-geo.js <fichier.csv> --label "COD-AB v2023.1" [options]

   Options :
     --label <texte>    nom du millésime (obligatoire)
     --source <texte>   provenance, pour la traçabilité
     --sep <car>        séparateur (défaut : détecté entre , ; et tabulation)
     --map a=b,c=d      correspondance colonne du fichier → champ attendu
     --dry              analyse et rapport, sans écrire
     --keep-current     n'active pas le nouveau millésime

   Champs attendus : adm0, adm1, adm2, adm3, adm4, lat, lon,
                     pcode0…pcode4 (un code par niveau) ou pcode (niveau le plus profond).

   Les en-têtes usuels des jeux COD-AB (ADM1_FR, ADM2_PCODE, …) sont reconnus
   automatiquement. Sinon, --map permet de les désigner explicitement :
     --map "REGION=adm1,DISTRICT=adm2,COMMUNE=adm3,FOKONTANY=adm4"

   Le fichier n'est jamais chargé en mémoire d'un bloc : il est lu ligne à ligne.
   ═══════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate } from "./db.js";
import { log } from "./lib/logger.js";
import { buildUnits, writeVersion, LEVELS } from "./lib/geo.js";

const args = process.argv.slice(2);
const flag = (name, def=null) => { const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i+1] && !args[i+1].startsWith("--") ? args[i+1] : true) : def; };
const file  = args.find(a => !a.startsWith("--") && (args.indexOf(a) === 0 || !args[args.indexOf(a)-1]?.startsWith("--")));
const label = flag("label"), dry = !!flag("dry"), keepCurrent = !!flag("keep-current");

if(!file || !fs.existsSync(file)){
  console.error("Fichier introuvable. Usage : node src/import-geo.js <fichier.csv> --label \"…\"");
  process.exit(1);
}
if(!dry && (!label || label === true)){
  console.error("--label est obligatoire : il identifie le millésime du référentiel.");
  process.exit(1);
}

/* ── Reconnaissance des en-têtes ──────────────────────────────────────
   Les jeux COD-AB nomment les colonnes ADM1_FR / ADM1_EN / ADM1_PCODE, etc.
   On accepte aussi les intitulés métier courants en français. */
const PATTERNS = [
  [/^adm0[_ ]?(fr|en|name|nm)?$|^pays$|^country$/i,          "adm0"],
  [/^adm1[_ ]?(fr|en|name|nm)?$|^r[ée]gion$|^region$/i,      "adm1"],
  [/^adm2[_ ]?(fr|en|name|nm)?$|^district$/i,                "adm2"],
  [/^adm3[_ ]?(fr|en|name|nm)?$|^commune$/i,                 "adm3"],
  [/^adm4[_ ]?(fr|en|name|nm)?$|^fokontany$|^village$/i,     "adm4"],
  [/^adm0[_ ]?p?code$/i, "pcode0"], [/^adm1[_ ]?p?code$/i, "pcode1"],
  [/^adm2[_ ]?p?code$/i, "pcode2"], [/^adm3[_ ]?p?code$/i, "pcode3"],
  [/^adm4[_ ]?p?code$/i, "pcode4"],
  [/^p?code$/i, "pcode"],
  [/^lat(itude)?$|^y$/i, "lat"], [/^lon(g|gitude)?$|^x$/i, "lon"],
];
const guess = (header) => {
  const h = String(header).trim();
  for(const [re, field] of PATTERNS) if(re.test(h)) return field;
  return null;
};

/* ── Lecture CSV : guillemets, séparateurs et BOM gérés ─────────────── */
function splitLine(line, sep){
  const out = []; let cur = "", q = false;
  for(let i=0;i<line.length;i++){
    const c = line[i];
    if(q){
      if(c === '"'){ if(line[i+1] === '"'){ cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if(c === '"') q = true;
    else if(c === sep){ out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
const detectSep = (line) => {
  const counts = [[",",(line.match(/,/g)||[]).length], [";",(line.match(/;/g)||[]).length],
                  ["\t",(line.match(/\t/g)||[]).length]];
  return counts.sort((a,b)=>b[1]-a[1])[0][1] ? counts.sort((a,b)=>b[1]-a[1])[0][0] : ",";
};

const explicit = {};
if(flag("map") && flag("map") !== true)
  for(const pair of String(flag("map")).split(","))
    { const [k,v] = pair.split("="); if(k && v) explicit[k.trim()] = v.trim(); }

async function readRows(){
  const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  let header = null, sep = flag("sep") && flag("sep") !== true ? String(flag("sep")) : null;
  let mapping = null; const rows = []; let skipped = 0;

  for await (let line of rl){
    if(!line.trim()) continue;
    if(header === null){
      line = line.replace(/^﻿/, "");             /* BOM Excel */
      sep = sep || detectSep(line);
      header = splitLine(line, sep);
      mapping = header.map(h => explicit[h] || guess(h));
      const found = new Set(mapping.filter(Boolean));
      if(!LEVELS.some(l => found.has(l))){
        console.error(`\nAucune colonne de niveau administratif reconnue.\nEn-têtes lus : ${header.join(" | ")}`);
        console.error(`Utilisez --map, par exemple : --map "REGION=adm1,DISTRICT=adm2,COMMUNE=adm3,FOKONTANY=adm4"`);
        process.exit(1);
      }
      console.log(`Séparateur « ${sep === "\t" ? "tabulation" : sep} » · ${header.length} colonnes`);
      console.log("Correspondance retenue :");
      header.forEach((h,i) => { if(mapping[i]) console.log(`  ${h.padEnd(24)} → ${mapping[i]}`); });
      const ignored = header.filter((h,i) => !mapping[i]);
      if(ignored.length) console.log(`  (${ignored.length} colonne(s) ignorée(s) : ${ignored.slice(0,8).join(", ")}${ignored.length>8?"…":""})`);
      continue;
    }
    const cells = splitLine(line, sep);
    if(cells.length < 2){ skipped++; continue; }
    const row = {};
    mapping.forEach((field, i) => { if(field) row[field] = cells[i] ?? ""; });
    rows.push(row);
  }
  return { rows, skipped };
}

/* ── Exécution ────────────────────────────────────────────────────── */
const here = path.dirname(fileURLToPath(import.meta.url));
migrate(path.join(here, "..", "migrations"));

const { rows, skipped } = await readRows();
console.log(`\n${rows.length.toLocaleString("fr-FR")} ligne(s) lue(s)${skipped?` · ${skipped} ignorée(s) (malformées)`:""}`);

const { units, rejected, collisions, counts } = buildUnits(rows);

console.log("\nUnités construites :");
for(const l of LEVELS) if(counts[l]) console.log(`  ${l}  ${String(counts[l]).padStart(7)}`);
console.log(`  ────────────\n  total ${String(units.length).padStart(7)}`);

if(rejected.length){
  console.log(`\n${rejected.length} ligne(s) écartée(s) :`);
  for(const r of rejected.slice(0,10)) console.log(`  ligne ${r.line} — ${r.reason}`);
  if(rejected.length > 10) console.log(`  … et ${rejected.length-10} autre(s)`);
}
if(collisions.length){
  console.error(`\n${collisions.length} collision(s) de code : un même p-code désigne deux unités différentes.`);
  for(const c of collisions.slice(0,10)) console.error(`  ${c.pcode} : « ${c.a} » et « ${c.b} »`);
  console.error("\nImport interrompu : corrigez les codes du fichier source.");
  process.exit(1);
}

if(dry){ console.log("\n--dry : rien n'a été écrit."); process.exit(0); }
if(!units.length){ console.error("\nAucune unité exploitable, rien à écrire."); process.exit(1); }

const versionId = writeVersion({ label:String(label), source: flag("source") === true ? null : flag("source"),
  units, makeCurrent: !keepCurrent });

log.info("référentiel géographique importé",
  { millesime:String(label), unites:units.length, courant:!keepCurrent });
console.log(`\n✓ Millésime « ${label} » créé : ${units.length.toLocaleString("fr-FR")} unités${
  keepCurrent ? " (non activé, --keep-current)" : ", activé comme référentiel courant"}.`);
console.log(`  identifiant : ${versionId}`);
const cur = db.prepare("SELECT label, units FROM geo_version WHERE is_current=1").get();
if(cur) console.log(`  référentiel courant : « ${cur.label} » — ${cur.units.toLocaleString("fr-FR")} unités`);
