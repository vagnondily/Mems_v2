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
const OUT_CONST = path.resolve("test/_constants.mjs");
let calc, constants, periode, exportGeo;
before(async () => {
  makeDom("http://127.0.0.1:1/api");
  const bundle = (src, out) => execFileSync("npx", ["esbuild", src, "--bundle", "--format=esm",
    "--loader:.jsx=jsx", "--jsx=automatic",
    "--external:react", "--external:react-dom", "--external:recharts", "--external:lucide-react",
    `--outfile=${out}`], { stdio:"pipe" });
  bundle("src/lib/calc.js", OUT);
  /* Le barème de priorité vit dans constants.js, qui entre dans le même cycle
     d'imports : il se bundle donc de la même façon. */
  bundle("src/lib/constants.js", OUT_CONST);
  calc = await import(OUT);
  constants = await import(OUT_CONST);
  /* periode.js ne dépend d'aucun composant : il se charge tel quel, sans passer
     par esbuild — ce qui vérifie au passage qu'il reste bien sans dépendance. */
  periode = await import(path.resolve("src/lib/periode.js"));
  /* exportGeo.js ne dépend d'aucun composant non plus : il se charge tel quel. */
  exportGeo = await import(path.resolve("src/lib/exportGeo.js"));
});
after(() => { for(const f of [OUT, OUT_CONST]){ try{ fs.unlinkSync(f); }catch(e){} } });

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
   Score de risque et date de dernière visite.
   Le serveur sert trois dates par site : celle cochée dans la grille mensuelle,
   celle observée dans les soumissions ODK, et l'arbitrage des deux. Ce qui se
   teste ici est que le CALCUL suit l'arbitrage — un site réellement visité ne
   doit plus remonter en tête des priorités faute de case cochée — sans rien
   changer aux sites qu'aucune soumission n'a jamais touchés.
   ───────────────────────────────────────────────────────────────────── */
const ilYAMois = (m) => new Date(Date.now() - m * 30.44 * 86400000).toISOString().slice(0, 10);

/* Site nu : aucun drapeau levé, charge sous le premier seuil. Tout ce qui bouge
   d'un cas à l'autre ne peut donc venir que de la date de dernière visite. */
const siteNu = (id, dates) => ({ id, poi:"Site " + id, subOffice:"BT", activityTag:"URT",
  status:"Active", beneficiaries:100, security:0, synergies:0, newPartner:0, expPartner:0,
  issueIPM:0, issueReport:0, issueCFM:0, fraud:0, plan:[], ...dates });

/* Le nombre de sites entre dans le calcul de l'intervalle requis : on complète
   toujours à quatre pour que cet intervalle vaille 4 mois quel que soit le cas
   testé — ni les 12 mois ni le 1 mois des jeux d'essai ne l'encadrent par hasard. */
const dbPour = (...sites) => ({
  sites: [...sites, ...Array.from({ length: Math.max(0, 4 - sites.length) },
    (_, i) => siteNu("remplissage" + i, { lastVisit:"" }))],
  visits: [],
  params: [{ id:"p1", office:"BT", tag:"URT", duration:12, riskLevel:3, feasiblePerMonth:1 }],
});

test("dernière visite : l'observée prime sur la saisie, une donnée sans ODK ne bouge pas", () => {
  const d = calc.derniereVisite;
  assert.equal(d({ lastVisit:"2025-03-04" }), "2025-03-04");
  assert.equal(d({ lastVisit:"2025-03-04", lastVisitOdk:"2026-06-10", lastVisitEffective:"2026-06-10" }), "2026-06-10");
  /* Arbitrage absent — site chargé par un serveur plus ancien, ou objet fabriqué
     par un test : l'observée reste la référence. */
  assert.equal(d({ lastVisit:"2025-03-04", lastVisitOdk:"2026-06-10" }), "2026-06-10");
  /* Champs servis mais vides : on retombe sur la saisie, pas sur « jamais visité ». */
  assert.equal(d({ lastVisit:"2025-03-04", lastVisitOdk:"", lastVisitEffective:"" }), "2025-03-04");
  assert.equal(d({}), "");
  assert.equal(d(undefined), "");
});

test("score de risque : un site visité selon ODK cesse d'être prioritaire", () => {
  const saisieSeule = siteNu("saisie", { lastVisit: ilYAMois(12) });
  const vuParOdk = siteNu("odk", { lastVisit: ilYAMois(12),
    lastVisitOdk: ilYAMois(1), lastVisitEffective: ilYAMois(1) });
  const db = dbPour(saisieSeule, vuParOdk);
  assert.equal(calc.siteRequirement(db, vuParOdk).interval, 4, "intervalle requis du jeu d'essai");

  const pSaisie = constants.sitePriority(saisieSeule, db);
  const pOdk = constants.sitePriority(vuParOdk, db);
  assert.equal(pSaisie.scoreLastVisit, 3);      /* 12 mois pour un intervalle de 4 : en retard */
  assert.equal(pOdk.scoreLastVisit, 0);         /* visité il y a 1 mois : dans les temps */
  assert.equal(pOdk.monthsSinceVisit < 2, true, "l'ancienneté se compte depuis la date observée");
  assert.equal(pSaisie.priority, 2); assert.equal(pSaisie.level, 3);
  assert.equal(pOdk.priority, 0);    assert.equal(pOdk.level, 1);

  /* Le score sur 100 du registre et le barème historique suivent la même bascule. */
  assert.equal(calc.siteScore(saisieSeule, null, db).pct, 33);
  assert.equal(calc.siteScore(vuParOdk, null, db).pct, 0);
  assert.equal(calc.legacyScore(saisieSeule).points, 7);
  assert.equal(calc.legacyScore(vuParOdk).points, 2);

  /* siteDerived relaie sitePriority : ce qu'il reste à planifier suit aussi. */
  assert.equal(constants.siteDerived(saisieSeule, db).sitesToBePlanned, 2);
  assert.equal(constants.siteDerived(vuParOdk, db).sitesToBePlanned, 0);
});

test("score de risque : sans aucune donnée ODK, le score est celui d'avant", () => {
  const ancien = siteNu("ancien", { lastVisit: ilYAMois(12) });
  const jamais = siteNu("jamais", { lastVisit:"" });
  const db = dbPour(ancien, jamais);

  const p = constants.sitePriority(ancien, db);
  assert.equal(p.scoreLastVisit, 3); assert.equal(p.newPartnerTime, 2);
  assert.equal(p.priority, 2); assert.equal(p.level, 3);
  assert.equal(p.monthsSinceVisit, 12);
  assert.deepEqual(calc.legacyScore(ancien), { points:7, max:39, pct:18, level:1 });

  /* Jamais visité : le calcul ne connaît toujours aucune date, et pénalise au maximum. */
  const pJamais = constants.sitePriority(jamais, db);
  assert.equal(pJamais.monthsSinceVisit, null);
  assert.equal(pJamais.scoreLastVisit, 3);
  assert.equal(calc.legacyScore(jamais).points, 7);

  /* Un site dont l'arbitrage servi pointe sur la saisie se comporte exactement
     comme le site fabriqué qui ne porte que la saisie. */
  const arbitre = siteNu("arbitre", { lastVisit: ilYAMois(12), lastVisitEffective: ilYAMois(12) });
  assert.deepEqual(constants.sitePriority(arbitre, db), p);
  assert.deepEqual(calc.legacyScore(arbitre), calc.legacyScore(ancien));
});

test("score de risque : l'ordre de priorité change quand l'observée est plus récente", () => {
  const a = siteNu("a", { lastVisit: ilYAMois(12) });
  const b = siteNu("b", { lastVisit: ilYAMois(12),
    lastVisitOdk: ilYAMois(1), lastVisitEffective: ilYAMois(1) });
  const db = dbPour(a, b);
  const parScore = (liste) => liste.slice()
    .sort((x, y) => calc.siteScore(y, null, db).pct - calc.siteScore(x, null, db).pct)
    .map(s => s.id);

  /* Privés de leurs champs ODK, les deux sites sont indiscernables : c'est donc
     bien la date observée, et elle seule, qui renvoie « b » en fin de liste. */
  const sansOdk = (s) => ({ ...s, lastVisitOdk:undefined, lastVisitEffective:undefined });
  assert.equal(calc.siteScore(sansOdk(a), null, db).pct, calc.siteScore(sansOdk(b), null, db).pct);
  assert.deepEqual(parScore([b, a]), ["a", "b"]);
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

test("origine des visites : la saisie à la main se distingue, et son motif se lit", () => {
  /* La garde regarde les DEUX marqueurs, comme celle du serveur : supprimer une
     soumission délie la visite (ON DELETE SET NULL) sans la supprimer, et une
     visite venue du terrain sans son identifiant reste venue du terrain. */
  assert.equal(calc.visiteOdk({ origin:"odk", submissionId:"sub1" }), true);
  assert.equal(calc.visiteOdk({ origin:"odk", submissionId:"" }), true);
  assert.equal(calc.visiteOdk({ origin:"manuelle", submissionId:"sub1" }), true);
  assert.equal(calc.visiteOdk({ origin:"manuelle", submissionId:"" }), false);
  /* Un client servi par une instance non redéployée ne reçoit pas la colonne :
     l'absence d'origine ne doit pas faire passer un rattrapage pour de l'ODK. */
  assert.equal(calc.visiteOdk({}), false);
  assert.equal(calc.visiteOdk(undefined), false);

  const db = { year:2026, visits:[
    { id:"a", siteId:"s1", date:"2026-05-03", origin:"odk", submissionId:"sub1" },
    { id:"b", siteId:"s1", date:"2026-05-15", origin:"manuelle", motif:"autre", motifNote:"pluie" },
    { id:"c", siteId:"s1", date:"2026-06-15", origin:"manuelle" },
    { id:"d", siteId:"s2", date:"2026-05-15", origin:"manuelle" },
    { id:"e", siteId:"s1", date:"", origin:"manuelle" },
  ] };
  /* Mai est l'indice 4 : le mois est indexé à partir de zéro partout dans le
     produit, y compris dans la clé de la grille mensuelle du serveur. */
  assert.deepEqual(calc.visitesDuMois(db, "s1", 4).map(v=>v.id), ["a","b"]);
  assert.deepEqual(calc.visitesDuMois(db, "s1", 5).map(v=>v.id), ["c"]);
  assert.deepEqual(calc.visitesDuMois(db, "s1", 0).map(v=>v.id), []);
  /* Aucune visite chargée : les trois écrans qui appellent ceci doivent rendre. */
  assert.deepEqual(calc.visitesDuMois({ year:2026 }, "s1", 4), []);
  assert.deepEqual(calc.visitesDuMois(undefined, "s1", 4), []);

  /* La liste des motifs n'existe que sur le serveur et arrive avec l'état
     initial. Absente, on retombe sur l'identifiant brut plutôt que de faire
     tomber le rendu — le bilan e2e échoue sur la moindre exception. */
  const avecListe = { motifsVisiteManuelle:[
    { id:"autre", libelle:"Autre", noteObligatoire:true, saisissable:true }] };
  assert.equal(calc.motifLisible(avecListe, "autre"), "Autre");
  assert.equal(calc.motifLisible(avecListe, "inconnu_anterieur"), "inconnu_anterieur");
  assert.equal(calc.motifLisible({}, "autre"), "autre");
  assert.equal(calc.motifLisible(undefined, "autre"), "autre");
  assert.equal(calc.motifLisible(avecListe, ""), "");
});

test("motifs de visite : celui de la reprise s'affiche, il ne se renvoie jamais", () => {
  /* La distinction que ce test verrouille : `inconnu_anterieur` est écrit par la
     migration 019 sur TOUTES les visites antérieures à la règle, mais il est hors
     de l'énumération de zod (server/src/lib/validate.js). Un écran qui le
     préremplit puis le renvoie tel quel fait refuser la fiche entière — jusqu'au
     décochage — sur chaque mois déjà coché d'une installation existante. */
  const db = { motifsVisiteManuelle:[
    { id:"autre", libelle:"Autre", noteObligatoire:true, saisissable:true },
    { id:"inconnu_anterieur", libelle:"Motif inconnu — visite enregistrée avant la règle",
      noteObligatoire:false, saisissable:false }] };
  assert.equal(calc.motifSaisissable(db, "autre"), true);
  assert.equal(calc.motifSaisissable(db, "inconnu_anterieur"), false);
  /* Il reste lisible : l'écran doit pouvoir DIRE ce que porte la ligne. */
  assert.equal(calc.motifLisible(db, "inconnu_anterieur"),
    "Motif inconnu — visite enregistrée avant la règle");
  /* Un motif inconnu de la liste, et une instance non redéployée qui ne la sert
     pas : dans les deux cas rien n'est saisissable, donc rien n'est renvoyé. */
  assert.equal(calc.motifSaisissable(db, "parce_que"), false);
  assert.equal(calc.motifSaisissable(db, ""), false);
  assert.equal(calc.motifSaisissable(db, undefined), false);
  assert.equal(calc.motifSaisissable({}, "autre"), false);
  assert.equal(calc.motifSaisissable(undefined, "autre"), false);
});

/* ─────────────────────────────────────────────────────────────────────
   Export du répertoire des localités (lib/exportGeo.js).
   Le défaut fermé : l'export ne sortait que la PAGE affichée (plafonnée à
   200 lignes), donc 200 fokontany sur ~18 000 sans le moindre avertissement.
   On vérifie ici que la collecte récupère la TOTALITÉ du jeu filtré en
   paginant, que le p-code part en TEXTE et que le BOM UTF-8 est en tête.
   ───────────────────────────────────────────────────────────────────── */
test("collecterLocalites : pagine jusqu'au total, ne s'arrête pas à la première page", async () => {
  /* Un jeu de 450 unités servi par pages de 200 : la page seule en rendrait 200,
     la collecte doit toutes les rapporter. */
  const total = 450;
  const toutes = Array.from({ length: total }, (_, i) => ({ adm4: "Fkt " + i, pcode: "MG" + i }));
  let appels = 0;
  const lecteur = async (offset, limit) => {
    appels++;
    return { rows: toutes.slice(offset, offset + limit), total };
  };
  const { rows, total: rendu, tronque } = await exportGeo.collecterLocalites(lecteur, { chunk: 200 });
  assert.equal(rendu, 450);
  assert.equal(rows.length, 450, "toutes les localités sont récupérées, pas seulement la page");
  assert.ok(rows.length > 200, "l'export dépasse la page affichée");
  assert.equal(tronque, false, "rien n'est tronqué en silence");
  assert.equal(appels, 3, "trois appels paginés (200 + 200 + 50)");
});

test("collecterLocalites : le plafond de sécurité est signalé, jamais muet", async () => {
  const total = 5000;
  const lecteur = async (offset, limit) => ({
    rows: Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({ pcode: "P" + (offset + i) })),
    total,
  });
  const { rows, tronque } = await exportGeo.collecterLocalites(lecteur, { chunk: 1000, plafond: 2000 });
  assert.equal(rows.length, 2000, "la collecte s'arrête au plafond");
  assert.equal(tronque, true, "et le dit — l'appelant en avertit l'utilisateur à l'écran");
});

test("csvLocalites : BOM UTF-8, p-codes en texte, guillemets échappés, toutes les lignes", () => {
  const rows = [
    { adm1: "Région A", adm2: "District B", adm3: "Commune C", adm4: "Fkt D",
      pcode: "0102030004", lat: -22.1, lon: 45.3 },
    { adm1: 'Nom, "à virgule"', adm2: "", adm3: "", adm4: "", pcode: "MG01", lat: "", lon: "" },
  ];
  const csv = exportGeo.csvLocalites(rows);
  assert.ok(csv.charCodeAt(0) === 0xfeff, "le fichier commence par un BOM UTF-8 (accents Excel)");
  const lignes = csv.split("\n");
  assert.equal(lignes.length, 3, "en-tête + deux lignes de données");
  assert.ok(lignes[0].replace(/^﻿/, "").startsWith("adm1,adm2,adm3,adm4,pcode,lat,lon"),
    "l'en-tête porte les colonnes attendues");
  /* Le p-code à zéros de tête part en formule texte : Excel ne le tronque pas. */
  assert.ok(csv.includes('"=""0102030004"""'),
    "le p-code est forcé en texte pour préserver les zéros non significatifs");
  /* Le champ à virgule et guillemets est protégé selon la règle CSV. */
  assert.ok(csv.includes('"Nom, ""à virgule"""'), "les guillemets et virgules sont échappés");
});
