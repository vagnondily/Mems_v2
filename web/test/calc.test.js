import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* ═══════════════════════════════════════════════════════════════════════
   Les formules de couverture.

   Elles décident de l'intervalle minimal entre deux visites, de la fréquence
   requise et de la faisabilité du plan : tout le suivi fondé sur le risque en
   dépend. Elles étaient évaluées par `new Function(...)`, que la politique de
   sécurité du contenu refuse en production ; l'erreur était attrapée et chaque
   formule rendait 0. L'écran affichait « 0 visite requise » sans rien signaler.

   Une panne muette de ce genre ne se remarque qu'en lisant les chiffres, donc on
   l'épingle ici. Les cas ci-dessous ne vérifient pas seulement que l'arithmétique
   est juste : ils vérifient surtout que l'évaluation ABOUTIT, et que ce qui doit
   être refusé l'est explicitement plutôt qu'en rendant zéro.
   ═══════════════════════════════════════════════════════════════════════ */

/* `calc.js` importe des modules JSX que Node ne sait pas lire. On l'assemble donc
   avec l'outil qui construit déjà l'application, en laissant les bibliothèques de
   rendu à l'extérieur : rien de ce qu'on éprouve ici ne les touche. Le résultat est
   écrit sous `node_modules` pour que ces bibliothèques restées à l'extérieur se
   résolvent normalement — depuis /tmp, elles seraient introuvables. */
const ici = fileURLToPath(new URL(".", import.meta.url));
const dir = join(ici, "..", "node_modules", ".cache", "mems-test");
mkdirSync(dir, { recursive:true });
await build({
  entryPoints: [join(ici, "..", "src", "lib", "calc.js")],
  bundle: true, format: "esm", outfile: join(dir, "calc.mjs"), logLevel: "silent",
  external: ["react", "react-dom", "react/jsx-runtime", "recharts", "lucide-react", "xlsx"],
  loader: { ".js":"jsx", ".jsx":"jsx" },
});
writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
const { evalFormula, computeParam } = await import(pathToFileURL(join(dir, "calc.mjs")).href);

test("préparation : le module de calcul est assemblé et exporte ses fonctions", () => {
  assert.equal(typeof evalFormula, "function");
  assert.equal(typeof computeParam, "function");
});

test("formules : l'arithmétique aboutit et donne le bon résultat", () => {
  const cas = [
    ["1 + 2", {}, 3],
    ["2 * 3 + 1", {}, 7],
    ["1 + 2 * 3", {}, 7],                       // priorité du produit
    ["(1 + 2) * 3", {}, 9],
    ["10 / 4", {}, 2.5],
    ["-3 + 5", {}, 2],                          // moins unaire en tête
    ["2 * -3", {}, -6],                         // moins unaire après un opérateur
    ["1.5 + 0.25", {}, 1.75],
    ["duration / minInterval", { duration:12, minInterval:3 }, 4],
    ["max(1, minFreq)", { minFreq:0.4 }, 1],
    ["min(minFreq, feasibilityRatio)", { minFreq:6, feasibilityRatio:0.8 }, 0.8],
    ["round(nbSites / minInterval)", { nbSites:29, minInterval:3 }, 10],
    ["floor(7 / 2)", {}, 3],
    ["ceil(7 / 2)", {}, 4],
    ["abs(0 - 4)", {}, 4],
    ["sqrt(16)", {}, 4],
    ["max(0, min(1, feasibilityRatio))", { feasibilityRatio:1.4 }, 1],
  ];
  for(const [expr, scope, attendu] of cas){
    const r = evalFormula(expr, scope);
    assert.equal(r.ok, true, `« ${expr} » a échoué : ${r.err}`);
    assert.equal(r.value, attendu, `« ${expr} » = ${r.value}, attendu ${attendu}`);
  }
});

test("formules : les vraies expressions de couverture rendent autre chose que zéro", () => {
  /* Ce sont les expressions livrées par défaut. Le défaut corrigé les rendait
     toutes à 0 ; on vérifie donc la valeur ET le fait qu'elle ne soit pas nulle. */
  const chaine = [
    ["minInterval",      "duration / riskLevel",             { duration:12, riskLevel:3 },              4],
    ["minFreq",          "duration / minInterval",           { duration:12, minInterval:4 },            3],
    ["targetPerMonth",   "nbSites / minInterval",            { nbSites:29, minInterval:4 },             7.25],
    ["feasibilityRatio", "min(1, feasiblePerMonth / targetPerMonth)",
                                                             { feasiblePerMonth:4, targetPerMonth:7.25 }, 0.5517241379310345],
    ["adjustedFreq",     "minFreq * feasibilityRatio",       { minFreq:3, feasibilityRatio:0.5 },       1.5],
  ];
  for(const [nom, expr, scope, attendu] of chaine){
    const r = evalFormula(expr, scope);
    assert.equal(r.ok, true, `${nom} a échoué : ${r.err}`);
    assert.notEqual(r.value, 0, `${nom} est retombé à zéro`);
    assert.ok(Math.abs(r.value - attendu) < 1e-9, `${nom} = ${r.value}, attendu ${attendu}`);
  }
});

test("formules : ce qui est refusé l'est avec un motif, jamais en rendant zéro", () => {
  const refus = [
    ["1 / 0",              {},              /division par z/i],
    ["fetch(1)",           {},              /inconnue/i],
    ["window.location",    {},              /interdit|autoris/i],
    ["a + b",              { a:1 },         /inconnue.*b/i],
    ["1 +",                {},              /incompl|invalide/i],
    ["(1 + 2",             {},              /attendu/i],
    ["1 2",                {},              /mal form/i],
    ["",                   {},              /autoris/i],
  ];
  for(const [expr, scope, motif] of refus){
    const r = evalFormula(expr, scope);
    assert.equal(r.ok, false, `« ${expr} » aurait dû être refusée`);
    assert.equal(r.value, 0);
    assert.match(r.err, motif, `« ${expr} » : motif « ${r.err} » inattendu`);
  }
});

test("couverture : un paramètre complet donne une exigence exploitable", () => {
  /* Le bout de la chaîne, celui que l'accueil affiche. Avec un paramètre plein,
     aucune des grandeurs dérivées ne doit être nulle. */
  const sites = Array.from({ length:29 }, (_, i) =>
    ({ id:"s"+i, subOffice:"Ambovombe", activityTag:"Distribution", status:"Active" }));
  const c = computeParam(
    { office:"Ambovombe", tag:"Distribution", duration:12, riskLevel:2, feasiblePerMonth:4 },
    sites, null);
  assert.equal(c.nbSites, 29);
  for(const k of ["minInterval","minFreq","targetPerMonth","feasibilityRatio","adjustedFreq","adjustedInterval"])
    assert.ok(c[k] > 0, `${k} vaut ${c[k]} — la chaîne de calcul est rompue`);
  assert.ok(c.feasibilityRatio <= 1, "le ratio de faisabilité dépasse 1");
});
