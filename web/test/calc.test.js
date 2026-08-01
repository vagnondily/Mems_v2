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
let calc, periode;
before(async () => {
  makeDom("http://127.0.0.1:1/api");
  execFileSync("npx", ["esbuild", "src/lib/calc.js", "--bundle", "--format=esm",
    "--loader:.jsx=jsx", "--jsx=automatic",
    "--external:react", "--external:react-dom", "--external:recharts", "--external:lucide-react",
    `--outfile=${OUT}`], { stdio:"pipe" });
  calc = await import(OUT);
  /* periode.js ne dépend d'aucun composant : il se charge tel quel, sans passer
     par esbuild — ce qui vérifie au passage qu'il reste bien sans dépendance. */
  periode = await import(path.resolve("src/lib/periode.js"));
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

/* ─────────────────────────────────────────────────────────────────────
   Modèle de période partagé par Rapports et Analyses (periode.js).
   Ce qui se teste ici est ce sur quoi les deux écrans doivent s'accorder :
   le découpage de l'année, les années réellement proposées au choix, et
   les libellés — puisqu'ils partent aussi dans les fichiers exportés.
   ───────────────────────────────────────────────────────────────────── */

test("période : un mois appartient à son trimestre, et à lui seul", () => {
  const T = (t) => ({ annee:2026, gran:"trimestre", valeur:t });
  /* Les quatre bornes de trimestre : c'est là que se logent les erreurs de ±1. */
  for(const [t, dedans] of [[1,[1,2,3]], [2,[4,5,6]], [3,[7,8,9]], [4,[10,11,12]]]){
    for(let m = 1; m <= 12; m++)
      assert.equal(periode.moisDansPeriode(m, T(t)), dedans.includes(m),
        `mois ${m} dans T${t}`);
    assert.deepEqual(periode.moisDeLaPeriode(T(t)), dedans);
  }
});

test("période : l'année entière prend tout, un mois ne prend que lui", () => {
  const annee = { annee:2026, gran:"annee", valeur:0 };
  for(let m = 1; m <= 12; m++) assert.equal(periode.moisDansPeriode(m, annee), true);
  assert.equal(periode.moisDeLaPeriode(annee).length, 12);

  const mars = { annee:2026, gran:"mois", valeur:3 };
  assert.equal(periode.moisDansPeriode(3, mars), true);
  assert.equal(periode.moisDansPeriode(4, mars), false);
  assert.deepEqual(periode.moisDeLaPeriode(mars), [3]);

  /* Hors bornes ou pas un mois : faux, jamais une exception au milieu d'un rendu. */
  for(const m of [0, 13, -1, null, undefined, "mars", 1.5])
    assert.equal(periode.moisDansPeriode(m, annee), false, `mois invalide ${m}`);
});

test("période : une période mal formée retombe sur quelque chose d'exploitable", () => {
  assert.deepEqual(periode.normalisePeriode(undefined, 2026), { annee:2026, gran:"annee", valeur:0 });
  assert.deepEqual(periode.normalisePeriode({ annee:"2025", gran:"trimestre", valeur:"3" }),
    { annee:2025, gran:"trimestre", valeur:3 });
  /* Un trimestre 9 n'existe pas : il est ramené dans les bornes plutôt que de
     produire une période vide dont personne ne comprendrait le résultat. */
  assert.equal(periode.normalisePeriode({ annee:2026, gran:"trimestre", valeur:9 }).valeur, 4);
  assert.equal(periode.normalisePeriode({ annee:2026, gran:"mois", valeur:0 }).valeur, 1);
  assert.equal(periode.normalisePeriode({ annee:2026, gran:"n'importe quoi" }).gran, "annee");
});

test("période : une date tombe dans la période par son année ET son mois", () => {
  const t2 = { annee:2026, gran:"trimestre", valeur:2 };
  assert.equal(periode.dateDansPeriode("2026-04-01", t2), true);
  assert.equal(periode.dateDansPeriode("2026-06-30", t2), true);
  assert.equal(periode.dateDansPeriode("2026-07-01", t2), false);
  /* Même mois, autre année : c'est le piège que le filtre doit attraper. */
  assert.equal(periode.dateDansPeriode("2025-05-12", t2), false);
  assert.equal(periode.dateDansPeriode("", t2), false);
  assert.equal(periode.dateDansPeriode("pas une date", t2), false);

  /* Le premier jour d'un trimestre reste dans son trimestre quel que soit le
     fuseau du poste : la chaîne ISO est lue telle qu'elle est écrite. */
  assert.deepEqual(periode.anneeMoisDe("2026-04-01"), { annee:2026, mois:4 });
  assert.deepEqual(periode.anneeMoisDe("2026-01-01T00:00:00Z"), { annee:2026, mois:1 });
});

test("période : les bornes calendaires couvrent la période, février compris", () => {
  assert.deepEqual(periode.bornesPeriode({ annee:2026, gran:"annee" }),
    { du:"2026-01-01", au:"2026-12-31" });
  assert.deepEqual(periode.bornesPeriode({ annee:2026, gran:"trimestre", valeur:2 }),
    { du:"2026-04-01", au:"2026-06-30" });
  assert.deepEqual(periode.bornesPeriode({ annee:2026, gran:"mois", valeur:2 }),
    { du:"2026-02-01", au:"2026-02-28" });
  assert.deepEqual(periode.bornesPeriode({ annee:2024, gran:"mois", valeur:2 }),
    { du:"2024-02-01", au:"2024-02-29" });
});

test("période : les libellés disent l'année, et le suffixe de fichier se trie seul", () => {
  const an = { annee:2026, gran:"annee", valeur:0 };
  const t3 = { annee:2026, gran:"trimestre", valeur:3 };
  const aout = { annee:2025, gran:"mois", valeur:8 };

  assert.equal(periode.libellePeriode(an), "Année 2026");
  assert.equal(periode.libellePeriode(t3), "T3 2026 (juillet à septembre)");
  assert.equal(periode.libellePeriode(aout), "Août 2025");

  assert.equal(periode.libelleCourtPeriode(an), "2026");
  assert.equal(periode.libelleCourtPeriode(t3), "T3 2026");

  /* Aucun libellé ne doit taire l'année : c'est elle qui manquait au rapport. */
  for(const p of [an, t3, aout]){
    assert.match(periode.libellePeriode(p), new RegExp(String(p.annee)));
    assert.match(periode.libelleCourtPeriode(p), new RegExp(String(p.annee)));
  }

  assert.equal(periode.suffixePeriode(an), "2026");
  assert.equal(periode.suffixePeriode(t3), "2026-T3");
  assert.equal(periode.suffixePeriode(aout), "2025-08");
  assert.deepEqual(["2026-01","2026-02","2026-10"].slice().sort(),
    ["2026-01","2026-02","2026-10"], "le suffixe mensuel s'ordonne comme le calendrier");
});

test("période : les années proposées sont celles que portent les données", () => {
  const db = {
    year: 2026,
    visits: [{ date:"2026-03-04" }, { date:"2024-11-30" }, { date:"" }, { date:"illisible" }],
    outcomes: [{ date:"2023-07-01" }, { date:"2026-02-02" }],
    pdd: [{ year:2025 }, { year:2026 }, { year:null }],
    outputs: [],
  };
  /* Décroissant : le plus récent en tête, c'est celui qu'on ouvre. */
  assert.deepEqual(periode.anneesDisponibles(db), [2026, 2025, 2024, 2023]);

  /* Aucune année inventée autour de l'exercice : un magasin sans historique ne
     propose que l'exercice chargé. */
  assert.deepEqual(periode.anneesDisponibles({ year:2026, visits:[], outcomes:[], pdd:[] }), [2026]);
  /* L'exercice chargé figure toujours, même sans une seule ligne datée. */
  assert.deepEqual(periode.anneesDisponibles({ year:2030 }), [2030]);
  /* Une date aberrante ne crée pas une option absurde. */
  assert.deepEqual(periode.anneesDisponibles({ year:2026, visits:[{ date:"1899-01-01" }] }), [2026]);
});

test("période : les mois écoulés proratisent l'exigence sans anticiper", () => {
  const juin2026 = new Date(2026, 5, 15);   /* 15 juin 2026 */
  const m = (p) => periode.moisEcoules(p, juin2026);

  assert.equal(m({ annee:2026, gran:"annee" }), 6);          /* janvier à juin */
  assert.equal(m({ annee:2026, gran:"trimestre", valeur:1 }), 3);  /* révolu */
  assert.equal(m({ annee:2026, gran:"trimestre", valeur:2 }), 3);  /* en cours, entamé */
  assert.equal(m({ annee:2026, gran:"trimestre", valeur:4 }), 0);  /* à venir : rien à exiger */
  assert.equal(m({ annee:2025, gran:"annee" }), 12);         /* exercice clos */
  assert.equal(m({ annee:2027, gran:"annee" }), 0);          /* exercice futur */
});

test("période : changer de granularité tombe sur la période en cours", () => {
  const septembre2026 = new Date(2026, 8, 3);
  assert.equal(periode.valeurDefaut("trimestre", 2026, septembre2026), 3);
  assert.equal(periode.valeurDefaut("mois", 2026, septembre2026), 9);
  assert.equal(periode.valeurDefaut("annee", 2026, septembre2026), 0);
  /* Sur un autre exercice, « en cours » n'a pas de sens : on repart du début. */
  assert.equal(periode.valeurDefaut("trimestre", 2024, septembre2026), 1);
  assert.equal(periode.valeurDefaut("mois", 2024, septembre2026), 1);
});
