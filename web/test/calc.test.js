import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeDom } from "./harness.mjs";

/* ─────────────────────────────────────────────────────────────────────
   Test unitaire de l'évaluateur d'indicateurs de performance (calc.js) :
   pas de serveur, pas de rendu — seulement le bac à sable d'expressions
   que l'administrateur utilisera pour recalculer les scores de performance
   sur les jeux de données ODK (voir Analyses → Jeux de données → Formules).
   calc.js entre dans un cycle d'imports avec Planning.jsx (composant React) ;
   il est donc bundlé comme le fait déjà e2e.test.js pour App.jsx, plutôt que
   chargé nativement par Node.
   ───────────────────────────────────────────────────────────────────── */
const OUT = path.resolve("test/_calc.mjs");
let calc;
before(async () => {
  makeDom("http://127.0.0.1:1/api");
  execFileSync("npx", ["esbuild", "src/lib/calc.js", "--bundle", "--format=esm",
    "--loader:.jsx=jsx", "--jsx=automatic",
    "--external:react", "--external:react-dom", "--external:recharts", "--external:lucide-react",
    `--outfile=${OUT}`], { stdio:"pipe" });
  calc = await import(OUT);
});
after(() => { try{ fs.unlinkSync(OUT); }catch(e){} });

test("evalIndicator : arithmétique, comparaisons, ternaire et chaînes", () => {
  const r1 = calc.evalIndicator("a + b * 2", { a:1, b:2 });
  assert.equal(r1.ok, true); assert.equal(r1.value, 5);

  const r2 = calc.evalIndicator("a >= 80 ? 'Excellent' : a >= 50 ? 'Adequat' : 'A ameliorer'", { a:82 });
  assert.equal(r2.ok, true); assert.equal(r2.value, "Excellent");

  const r3 = calc.evalIndicator("statut == '1' ? 100 : 0", { statut:"1" });
  assert.equal(r3.ok, true); assert.equal(r3.value, 100);
});

test("evalIndicator : refuse ce qui sort du cloisonnement", () => {
  assert.equal(calc.evalIndicator("a = 5", { a:1 }).ok, false);
  assert.equal(calc.evalIndicator("a => a", { a:1 }).ok, false);
  assert.equal(calc.evalIndicator("process.exit()", {}).ok, false);
  assert.equal(calc.evalIndicator("a.constructor", { a:1 }).ok, false);
  assert.equal(calc.evalIndicator("inconnueVariable + 1", { a:1 }).ok, false);
});

test("evalIndicator : une division par zéro est signalée, pas silencieuse", () => {
  const r = calc.evalIndicator("a / b", { a:1, b:0 });
  assert.equal(r.ok, false);
});

test("applyFormulas : enchaîne les formules et journalise les erreurs par variable", () => {
  const rows = [{ SvyDate:"2026-01-01", MOFoodReceivedMatch:"1", DPName:"Site A" },
                { SvyDate:"2026-01-02", MOFoodReceivedMatch:"0", DPName:"Site B" }];
  const formulas = [
    { id:"f1", name:"Score réception", field:"score_recep", expr:"MOFoodReceivedMatch=='1' ? 100 : 0" },
    { id:"f2", name:"Classe", field:"classe", expr:"score_recep >= 80 ? 'Bon' : 'Insuffisant'" },
    { id:"f3", name:"Formule cassée", field:"casse", expr:"variableInexistante + 1" },
  ];
  const { rows: out, errors } = calc.applyFormulas(rows, formulas);
  assert.equal(out[0].score_recep, 100); assert.equal(out[0].classe, "Bon");
  assert.equal(out[1].score_recep, 0); assert.equal(out[1].classe, "Insuffisant");
  assert.equal(out[0].casse, null);
  assert.equal(errors.f3.count, 2);
});
