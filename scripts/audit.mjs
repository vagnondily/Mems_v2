#!/usr/bin/env node
/* Audit de dépendances qui échoue vraiment.
 *
 * L'étape de CI se terminait par « || true » : elle était verte quelle que soit
 * la vulnérabilité trouvée, et c'est ce qui a laissé passer xlsx pendant des
 * mois. Mais retirer simplement le « || true » ferait échouer la CI en
 * permanence sur des avis inatteignables, et quelqu'un finirait par remettre le
 * « || true ». Il faut donc une troisième voie : échouer sur tout avis nouveau,
 * et n'accepter que des exceptions NOMMÉES, JUSTIFIÉES et DATÉES.
 *
 * npm audit n'a pas d'option d'exclusion — ce script la fournit.
 *
 * Usage : node scripts/audit.mjs <dossier> [--omit-dev]
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

/* Exceptions acceptées. Chaque entrée doit porter une justification vérifiable
 * et une date de réexamen. Une exception sans justification est un « || true »
 * déguisé : ne pas en ajouter sans avoir démontré l'inatteignabilité. */
const ACCEPTEES = [
  {
    paquets: ["brace-expansion", "minimatch", "glob", "archiver", "archiver-utils",
              "zip-stream", "readdir-glob", "rimraf", "exceljs"],
    avis: "GHSA-mh99-v99m-4gvg",
    pourquoi: "Chaîne archiver tirée par exceljs. MEMS n'utilise que l'API non-streaming "
      + "(wb.xlsx.load / wb.xlsx.write), qui passe par JSZip et n'appelle jamais archiver ; "
      + "brace-expansion n'est atteint que par l'évaluation d'un motif glob, ce qu'aucun "
      + "fichier téléversé ne déclenche. Aucun correctif amont : exceljs 4.4.0 est la "
      + "dernière version publiée, et le « fix » proposé par npm est un retour en 3.4.0 "
      + "qui casse l'API utilisée.",
    reexamen: "2027-01-31",
  },
  {
    paquets: ["uuid"],
    avis: "GHSA-w5hq-g745-h8pq",
    pourquoi: "L'avis ne vise que v3/v5/v6 appelés avec l'argument buf. exceljs n'appelle "
      + "que v4() sans argument, et uuid@8.3.2 n'exporte même pas v6.",
    reexamen: "2027-01-31",
  },
];

const dossier = process.argv[2] || ".";
const omitDev = process.argv.includes("--omit-dev");

let rapport;
try{
  const args = ["audit", "--json", "--audit-level=high"];
  if(omitDev) args.push("--omit=dev");
  rapport = execFileSync("npm", args, { cwd: dossier, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}catch(e){
  /* npm audit sort en code non nul dès qu'il trouve quelque chose : c'est le cas
     nominal ici, la sortie JSON est sur stdout. */
  rapport = e.stdout;
  if(!rapport){
    console.error("audit : npm n'a rien renvoyé.", e.message);
    process.exit(2);
  }
}

const { vulnerabilities = {} } = JSON.parse(rapport);
const graves = Object.values(vulnerabilities).filter(v => v.severity === "high" || v.severity === "critical");

const estAcceptee = (v) => ACCEPTEES.some(a => a.paquets.includes(v.name));
const restantes = graves.filter(v => !estAcceptee(v));
const tolerees = graves.filter(estAcceptee);

console.log(`Audit de ${dossier}${omitDev ? " (production seulement)" : ""} :`);
console.log(`  ${graves.length} avis grave(s), dont ${tolerees.length} accepté(s) et documenté(s).`);
for(const a of ACCEPTEES){
  const touches = tolerees.filter(v => a.paquets.includes(v.name)).map(v => v.name);
  if(touches.length) console.log(`  · accepté ${a.avis} (${touches.join(", ")}) — réexamen ${a.reexamen}`);
}

if(!restantes.length){ console.log("  Aucun avis grave non traité."); process.exit(0); }

console.error("\nAvis graves NON traités :");
for(const v of restantes){
  const via = (v.via || []).map(x => typeof x === "string" ? x : x.title).filter(Boolean);
  console.error(`  ✗ ${v.name} (${v.severity}) — ${via.join(" ; ") || "voir npm audit"}`);
  console.error(`    correctif : ${v.fixAvailable ? JSON.stringify(v.fixAvailable) : "aucun"}`);
}
console.error("\nCorrigez-les, ou ajoutez une exception JUSTIFIÉE et DATÉE dans scripts/audit.mjs.");
process.exit(1);
