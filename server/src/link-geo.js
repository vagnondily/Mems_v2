/* ═══════════════════════════════════════════════════════════════════════
   Rattachement des données existantes au référentiel administratif.

   Les sites et le plan de distribution portent leurs niveaux administratifs en
   texte. Cette reprise les rapproche du référentiel courant par la forme
   normalisée des noms — sans accents, sans ponctuation, sans casse — en
   descendant l'arbre : chaque niveau est cherché parmi les seuls enfants du
   niveau retenu au-dessus, ce qui lève l'ambiguïté des homonymes.

   Usage :
     node src/link-geo.js            analyse et rapport, sans écrire
     node src/link-geo.js --write    applique le rattachement
     node src/link-geo.js --write --min adm3
                                     n'accepte que les rapprochements descendus
                                     au moins jusqu'à la commune

   Rien n'est écrasé : les lignes déjà rattachées ne sont pas touchées, sauf
   avec --relink.
   ═══════════════════════════════════════════════════════════════════════ */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, tx, migrate } from "./db.js";
import { log } from "./lib/logger.js";
import { resolveUnit, currentVersion, LEVELS } from "./lib/geo.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f, d) => { const i = args.indexOf(`--${f}`); return i >= 0 ? (args[i+1] || d) : d; };
const write = has("write"), relink = has("relink");
const minLevel = val("min", "adm3");
const minDepth = LEVELS.indexOf(minLevel);

const here = path.dirname(fileURLToPath(import.meta.url));
migrate(path.join(here, "..", "migrations"));

const v = currentVersion();
if(!v){ console.error("Aucun référentiel courant. Chargez-en un avec src/import-geo.js."); process.exit(1); }
console.log(`Référentiel courant : « ${v.label} » — ${v.units.toLocaleString("fr-FR")} unités\n`);

/* Chaque table déclare où lire ses libellés administratifs. */
const TARGETS = [
  { table:"sites", label:"sites", cols:{ adm1:"adm1", adm2:"adm2", adm3:"adm3", adm4:"adm4" },
    describe:(r)=>`${r.code} — ${r.name}` },
  { table:"pdd", label:"lignes de plan de distribution",
    cols:{ adm1:"region", adm2:"district", adm3:"commune" },
    describe:(r)=>`${r.commune || "?"} — ${r.act_type} ${r.year}/${String(r.month+1).padStart(2,"0")}` },
];

let grandTotal = 0, grandLinked = 0;
for(const t of TARGETS){
  const rows = db.prepare(`SELECT * FROM ${t.table}${relink ? "" : " WHERE geo_pcode IS NULL"}`).all();
  if(!rows.length){ console.log(`${t.label} : rien à rattacher.\n`); continue; }

  const byDepth = {}; const unresolved = []; const ambiguous = [];
  const plan = [];
  for(const r of rows){
    const names = {};
    for(const [lvl, col] of Object.entries(t.cols)) names[lvl] = r[col];
    const m = resolveUnit(names, v.id);
    const depth = m.level ? LEVELS.indexOf(m.level) : -1;
    if(depth >= minDepth){
      plan.push({ id:r.id, pcode:m.pcode });
      byDepth[m.level] = (byDepth[m.level] || 0) + 1;
    } else {
      (m.ambiguous ? ambiguous : unresolved).push({ r, m });
    }
  }

  console.log(`${t.label} : ${rows.length.toLocaleString("fr-FR")} ligne(s) à traiter`);
  for(const l of LEVELS) if(byDepth[l])
    console.log(`  rattachées jusqu'à ${l.padEnd(5)} ${String(byDepth[l]).padStart(6)}`);
  if(unresolved.length){
    console.log(`  non rapprochées      ${String(unresolved.length).padStart(6)}`);
    for(const u of unresolved.slice(0,8))
      console.log(`      ${t.describe(u.r)} — descente arrêtée après [${u.m.matched.join(" → ") || "rien"}]`);
    if(unresolved.length > 8) console.log(`      … et ${unresolved.length-8} autre(s)`);
  }
  if(ambiguous.length){
    console.log(`  ambiguës             ${String(ambiguous.length).padStart(6)}  (plusieurs unités portent ce nom)`);
    for(const a of ambiguous.slice(0,5)) console.log(`      ${t.describe(a.r)}`);
  }

  if(write && plan.length){
    const upd = db.prepare(`UPDATE ${t.table} SET geo_pcode=? WHERE id=?`);
    tx(() => { for(const p of plan) upd.run(p.pcode, p.id); })();
    console.log(`  ✓ ${plan.length.toLocaleString("fr-FR")} rattachement(s) écrit(s)`);
  }
  grandTotal += rows.length; grandLinked += plan.length;
  console.log("");
}

if(!write){
  console.log(`Analyse seule : ${grandLinked.toLocaleString("fr-FR")} rattachement(s) sur ${grandTotal.toLocaleString("fr-FR")} auraient été écrits.`);
  console.log("Relancez avec --write pour appliquer.");
} else {
  log.info("rattachement au référentiel appliqué",
    { millesime:v.label, rattaches:grandLinked, total:grandTotal });
}
