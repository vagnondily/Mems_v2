/* ═══════════════════════════════════════════════════════════════════════
   Enregistrement de sources ODK Central à partir de leurs XLSForms.

   Usage :
     node src/import-odk-forms.js <fichier.xlsx> [<fichier2.xlsx> …] [options]
     node src/import-odk-forms.js formulaires/*.xlsx --write

   Options :
     --write             applique l'enregistrement (par défaut : analyse seule)
     --kind <valeur>     process|output|outcome|sites (défaut : process)
     --tag <code>        force l'activité rattachée, pour tous les fichiers passés
     --site-field <nom>  force le champ site (sinon détecté automatiquement)
     --date-field <nom>  force le champ date (sinon détecté automatiquement)
     --project <id>      identifiant de projet ODK Central (à défaut, laissé vide)

   Chaque fichier est un XLSForm (feuilles survey / choices / settings) tel
   qu'exporté par XLSForm Online, KoboToolbox ou ODK Central. Le script :
     - lit form_id et form_title dans la feuille settings ;
     - construit le dictionnaire nom → libellé depuis la feuille survey
       (label::Français (fr) ou label::French (fr), sinon label::English (en)) —
       la même logique que le rattachement de XLSForm fait depuis
       Paramètres → ODK Central dans l'interface, mais lue depuis un script
       au lieu du navigateur ;
     - devine le champ qui identifie le site et celui qui porte la date de
       l'enquête, à partir de motifs observés sur les formulaires MDG de
       suivi de processus ; ajustez avec --site-field / --date-field si la
       détection se trompe sur un formulaire différent.

   Le jeton d'accès et l'identifiant de projet ODK Central ne sont jamais
   lus dans le fichier : ce sont des informations de déploiement, à saisir
   dans Paramètres → ODK Central une fois la source enregistrée.

   Une source déjà enregistrée (même form_id et même projet) est mise à jour
   plutôt que dupliquée : les libellés et les champs proposés sont
   rafraîchis, l'identité (id) et le jeton existants sont conservés.
   ═══════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { db, migrate, tx } from "./db.js";
import { log } from "./lib/logger.js";
import { newId } from "./lib/crypto.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await migrate(path.join(here, "..", "migrations"));

const args = process.argv.slice(2);
const flag = (name, def=null) => { const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i+1] && !args[i+1].startsWith("--") ? args[i+1] : true) : def; };
const files = args.filter((a, i) => !a.startsWith("--") && !args[i-1]?.startsWith("--"));
const write = !!flag("write");
const kind = flag("kind", "process");
const forceTag = flag("tag", null);
const forceSite = flag("site-field", null);
const forceDate = flag("date-field", null);
const project = flag("project", "") || null;

if(!files.length){
  console.error("Usage : node src/import-odk-forms.js <fichier.xlsx> [...] [--write] [--kind process] [--tag SMP]");
  process.exit(1);
}
if(!["process","output","outcome","sites"].includes(kind)){
  console.error(`--kind invalide : « ${kind} ». Valeurs possibles : process, output, outcome, sites.`);
  process.exit(1);
}

/* Motifs qui désignent usuellement le site dans les formulaires MDG de suivi
   de processus, par ordre de priorité : la première variable dont le nom ou
   le libellé correspond l'emporte. Le repère Adm4Code / ADMIN4 est
   volontairement en dernier : c'est un repère géographique de repli, pas
   l'identité du site. */
const SITE_PATTERNS = [
  /^(DPName|POIName|opb_name|train_op_name|SiteName|FRSiteName)$/i,
  /point de distribution|site (miaro|farne)|nom du site|s[ée]lectionner l.?opb|^[ée]cole$/i,
  /^Adm4Code/i,
];
const DATE_PATTERNS = [/^SvyDate$/i, /date de l.?enqu[êe]te/i];

function guessField(vars, patterns){
  for(const re of patterns){
    const hit = vars.find(v => re.test(v.name) || re.test(v.label));
    if(hit) return hit.name;
  }
  return null;
}

async function readXlsForm(file){
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const readHeaders = (ws) => { const h = []; ws.getRow(1).eachCell((cell,col) => {
    h[col] = String(cell.value ?? "").trim(); }); return h; };
  const col = (headers, name) => headers.findIndex(h => h === name);

  const settingsWs = wb.getWorksheet("settings");
  const settings = {};
  if(settingsWs){
    const headers = readHeaders(settingsWs);
    const row2 = settingsWs.getRow(2);
    headers.forEach((h, c) => { if(h) settings[h] = row2.getCell(c).value; });
  }

  const surveyWs = wb.getWorksheet("survey");
  if(!surveyWs) throw new Error(`${file} : feuille "survey" introuvable — ce n'est pas un XLSForm.`);
  const headers = readHeaders(surveyWs);
  const nameCol = col(headers, "name"), typeCol = col(headers, "type");
  if(nameCol < 0) throw new Error(`${file} : la feuille "survey" n'a pas de colonne "name".`);
  const labelCols = ["label::Français (fr)","label::French (fr)","label::English (en)","label"]
    .map(h => col(headers, h)).filter(c => c > 0);

  const vars = [];
  const labels = {};
  surveyWs.eachRow((row, n) => {
    if(n === 1) return;
    const name = String(row.getCell(nameCol).value ?? "").trim();
    if(!name) return;
    const type = typeCol > 0 ? String(row.getCell(typeCol).value ?? "").trim() : "";
    let label = "";
    for(const c of labelCols){ const v = row.getCell(c).value; if(v){ label = String(v).trim(); break; } }
    if(label) labels[name] = label;
    vars.push({ name, type, label });
  });

  return { settings, vars, labels };
}

const results = [];
for(const file of files){
  if(!fs.existsSync(file)){ console.error(`Fichier introuvable : ${file}`); process.exit(1); }
  const { settings, vars, labels } = await readXlsForm(file);
  const formId = String(settings.form_id || path.basename(file, path.extname(file))).trim();
  const name = String(settings.form_title || formId).trim();
  const siteField = forceSite || guessField(vars, SITE_PATTERNS);
  const dateField = forceDate || guessField(vars, DATE_PATTERNS);
  results.push({ file, formId, name, siteField, dateField, labels, nVars: vars.length });
}

console.log(`\n${results.length} formulaire(s) analysé(s) :\n`);
for(const r of results){
  console.log(`• ${r.name}`);
  console.log(`    fichier        ${path.basename(r.file)}`);
  console.log(`    form_id        ${r.formId}`);
  console.log(`    variables      ${r.nVars} (${Object.keys(r.labels).length} libellés extraits)`);
  console.log(`    champ site     ${r.siteField || "— non détecté, utilisez --site-field"}`);
  console.log(`    champ date     ${r.dateField || "— non détecté, utilisez --date-field"}`);
  console.log(`    activité (tag) ${forceTag || "— à définir dans Paramètres → ODK Central"}`);
  console.log("");
}

if(!write){
  console.log("Analyse seule : rien n'a été écrit. Relancez avec --write pour enregistrer ces sources.");
  process.exit(0);
}

let created = 0, updated = 0;
await tx(async (db) => {
  for(const r of results){
    /* SQLite traite `IS ?` comme une égalité NULL-safe (NULL = NULL vaut vrai) ;
       Postgres n'accepte `IS` qu'avec NULL/TRUE/FALSE/UNKNOWN littéraux, pas avec
       un paramètre lié. `IS NOT DISTINCT FROM` est l'opérateur standard exact
       pour la même sémantique — correction de dialecte, pas de logique. */
    const existing = await db.prepare("SELECT id FROM odk_forms WHERE form_id=? AND project IS NOT DISTINCT FROM ?").get(r.formId, project);
    const cols = {
      name: r.name, form_id: r.formId, project, kind,
      activity_tag: forceTag || null, site_field: r.siteField, date_field: r.dateField,
      labels: JSON.stringify(r.labels),
    };
    const keys = Object.keys(cols);
    if(existing){
      await db.prepare(`UPDATE odk_forms SET ${keys.map(k=>k+"=?").join(",")}, rev=rev+1 WHERE id=?`)
        .run(...keys.map(k=>cols[k]), existing.id);
      updated++;
    } else {
      const id = newId("odkf");
      await db.prepare(`INSERT INTO odk_forms (id,${keys.join(",")}) VALUES (?,${keys.map(()=>"?").join(",")})`)
        .run(id, ...keys.map(k=>cols[k]));
      created++;
    }
  }
});
log.info("sources ODK Central enregistrées", { created, updated });
console.log(`✓ ${created} créée(s), ${updated} mise(s) à jour.`);
console.log("Complétez le jeton d'accès (et l'identifiant de projet si nécessaire) dans Paramètres → ODK Central : "
  + "ils ne sont jamais lus depuis le fichier XLSForm.");
