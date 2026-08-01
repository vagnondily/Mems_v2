import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeDom } from "./harness.mjs";

/* ─────────────────────────────────────────────────────────────────────
   Ce test démarre le vrai serveur, amorce une vraie base, puis rend
   l'application complète dans un DOM simulé et la pilote comme un
   utilisateur : connexion, navigation, cartographie, écriture, sortie.
   ───────────────────────────────────────────────────────────────────── */

const SERVER = path.resolve("../server");
const DB = path.join(SERVER, "data", "e2e.db");
const PORT = 4187;
const BASE = `http://127.0.0.1:${PORT}/api`;
const ADMIN = { email: "e2e@mems.local", password: "MotDePasseE2E2026" };

const env = { ...process.env,
  NODE_ENV: "test", DB_FILE: DB, PORT: String(PORT),
  JWT_SECRET: "e".repeat(48), DATA_KEY: "d".repeat(48),
  BOOTSTRAP_EMAIL: ADMIN.email, BOOTSTRAP_PASSWORD: ADMIN.password,
  BCRYPT_ROUNDS: "4", FORCE_SEED: "1", LOG_LEVEL: "error",
  CORS_ORIGINS: `http://127.0.0.1:${PORT}`,
  /* Explicitement vides : l'environnement du test hérite de celui de la machine,
     et une instance de développement qui aurait déclaré un interpréteur R ferait
     basculer l'écran des scripts dans son autre état. On fixe donc le cas testé
     — exécution serveur fermée — au lieu de le subir. */
  ANALYSIS_R: "", ANALYSIS_SPSS: "",
};

let child, ctx, React, createRoot, act, App;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const flush = async () => { await act(async () => { await sleep(90); }); };
const all = (sel) => [...document.querySelectorAll(sel)];
const byText = (sel, t) => all(sel).find(e => (e.textContent || "").trim().includes(t));
const byExact = (sel, t) => all(sel).find(e => (e.textContent || "").trim() === t);
const click = async (el, label) => {
  assert.ok(el, `élément introuvable : ${label}`);
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles:true }));
    await sleep(60);
  });
};
const type = async (el, value) => {
  const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  await act(async () => {
    el.dispatchEvent(new window.Event(el.tagName === "SELECT" ? "change" : "input", { bubbles:true }));
    await sleep(40);
  });
};

before(async () => {
  for(const f of [DB, DB+"-wal", DB+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
  fs.mkdirSync(path.dirname(DB), { recursive:true });
  execFileSync(process.execPath, ["src/seed.js"], { cwd: SERVER, env, stdio:"pipe" });

  child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER, env: { ...env, NODE_ENV: "production-like" }, stdio:"pipe" });
  child.stderr.on("data", d => { const s = String(d); if(!/ExperimentalWarning/.test(s)) process.stderr.write(s); });

  for(let i = 0; i < 60; i++){
    try{ const r = await fetch(`${BASE}/health`); if(r.ok) break; }catch(e){}
    await sleep(250);
  }
  const health = await (await fetch(`${BASE}/health`)).json();
  assert.equal(health.status, "ok");

  /* L'application est empaquetée telle quelle : c'est bien le code livré qui est testé. */
  /* Les feuilles de style et les images importées par les bibliothèques (le CSS
     de Leaflet et ses icônes) n'ont pas de sens dans jsdom, qui ne peint rien :
     on les vide plutôt que d'ajouter des chargeurs qui alourdiraient le bundle
     de test sans rien apprendre. Vite, lui, les traite normalement. */
  execFileSync("npx", ["esbuild", "src/App.jsx", "--bundle", "--format=esm",
    "--loader:.jsx=jsx", "--jsx=automatic", "--external:react", "--external:react-dom",
    "--external:react/jsx-runtime",
    "--loader:.css=empty", "--loader:.png=empty", "--loader:.svg=empty",
    "--outfile=test/_app.mjs", "--log-level=error"], { stdio:"pipe" });

  ctx = makeDom(BASE);
  React = (await import("react")).default;
  ({ createRoot } = await import("react-dom/client"));
  act = (await import("react")).act;
  App = (await import("./_app.mjs")).default;
});

after(async () => {
  /* Attendre la sortie effective, pas seulement l'envoi du signal : un enfant qui
     traîne garde ses tubes stdio ouverts, et le processus de test ne se termine
     alors jamais tout seul (voir le correctif de lib/api.js — un réessai programmé
     contre un serveur mort produit exactement ce symptôme). */
  if(child){
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try{ child.kill("SIGKILL"); }catch(e){} }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
  for(const f of [DB, DB+"-wal", DB+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
  if(fs.existsSync("test/_app.mjs")) fs.unlinkSync("test/_app.mjs");
});

test("démarrage : l'application atteint l'écran de connexion sans erreur", async () => {
  const root = createRoot(document.getElementById("root"));
  await act(async () => { root.render(React.createElement(App)); await sleep(500); });
  await flush(); await flush();
  assert.ok(byText("h2", "Connexion"), "l'écran de connexion s'affiche");
  assert.equal(ctx.errors.length, 0, "aucune erreur au démarrage");
});

test("sécurité : aucun identifiant n'est affiché ni présent dans le code livré", async () => {
  const shown = document.body.textContent;
  assert.ok(!/mot de passe\s*:/i.test(shown), "aucun mot de passe n'est proposé à l'écran");
  assert.ok(!shown.includes(ADMIN.password));
  const bundle = fs.readFileSync("test/_app.mjs", "utf8");
  for(const secret of [ADMIN.password, "mems2026", "admin@mems.org"])
    assert.ok(!bundle.includes(secret), `« ${secret} » ne doit pas figurer dans le code livré`);
  assert.ok(!/pw_hash|BOOTSTRAP_PASSWORD|JWT_SECRET/.test(bundle));
});

test("connexion : identifiants erronés refusés avec un message clair", async () => {
  await type(all("input[type=email]")[0], ADMIN.email);
  await type(all("input[type=password]")[0], "mauvais-mot-de-passe");
  await click(byText("button", "Se connecter"), "bouton de connexion");
  await flush();
  assert.ok(byText("div", "identifiants incorrects"), "le message d'échec s'affiche");
});

test("connexion : identifiants valides, puis changement de mot de passe imposé", async () => {
  await type(all("input[type=password]")[0], ADMIN.password);
  await click(byText("button", "Se connecter"), "connexion");
  await flush(); await flush();
  assert.ok(byText("h2", "Nouveau mot de passe"), "le premier accès impose un nouveau mot de passe");
  const champs = all("input[type=password]");
  await type(champs[0], "NouveauMotDePasse2026");
  await type(champs[1], "NouveauMotDePasse2026");
  await click(byText("button", "Enregistrer et entrer"), "valider le nouveau mot de passe");
  await flush(); await flush(); await flush();
  assert.ok(byText("div", "MEMS"), "la coquille de l'application est en place");
  assert.equal(ctx.errors.length, 0);
});

test("accueil : les données viennent du serveur et les indicateurs sont calculés", async () => {
  assert.ok(byText("h2", "Accueil"), "la page d'accueil s'affiche");
  const texte = document.body.textContent;
  /* « Tâches urgentes » ne figure plus dans cette liste : le tableau a quitté
     l'accueil pour la cloche de la barre du haut, éprouvée au test suivant. */
  for(const bloc of ["Exigence minimale de suivi", "Trois derniers mois",
                     "Plan et réalisé par catégorie d'activité", "Information annuelle"])
    assert.ok(texte.includes(bloc), `le bloc « ${bloc} » est présent`);
  assert.ok(!texte.includes("Tâches urgentes et actions à mener"),
    "le tableau des tâches a bien quitté l'accueil");
  assert.equal(ctx.errors.length, 0, "aucune erreur sur l'accueil");
});

test("notifications : la cloche compte les tâches, les liste et mène à l'écran concerné", async () => {
  const cloche = all("header [data-cloche]")[0];
  assert.ok(cloche, "la cloche est posée dans la barre du haut");

  /* La pastille porte le nombre brut : le texte affiché peut être « 99+ ». */
  const pastille = document.querySelector("header [data-cloche-compte]");
  assert.ok(pastille, "la pastille est présente");
  const urgentes = Number(pastille.getAttribute("data-cloche-compte"));
  assert.ok(urgentes > 0, `la pastille annonce des urgences (${urgentes})`);

  await click(cloche, "ouvrir les notifications"); await flush();
  assert.ok(byText("div", "Notifications"), "le panneau s'ouvre");
  const taches = all("[data-tache]");
  assert.ok(taches.length > 0, `le panneau liste des tâches (${taches.length})`);
  assert.ok(byText("button", "Tout marquer comme lu"), "le marquage comme lu est proposé");

  /* Cliquer une tâche referme le panneau et emmène à l'écran qui la résout. */
  const premiere = taches[0];
  const destination = premiere.getAttribute("data-tache");
  await click(premiere, `tâche ${destination}`); await flush(); await flush();
  assert.equal(all("[data-tache]").length, 0, "le panneau s'est refermé");
  assert.ok(!byText("main h2", "Accueil"), "l'écran a changé");
  assert.ok(all("main h2").length > 0, "la destination affiche un titre");
  assert.equal(ctx.errors.length, 0, "aucune erreur sur les notifications");
});

test("navigation : les cinq onglets s'ouvrent sans erreur", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  for(const onglet of ["Suivi-évaluation", "Programme", "Analyses", "Rapports", "Accueil"]){
    await click(nav(onglet), `onglet ${onglet}`);
    await flush();
    assert.ok(all("main h2").length > 0, `${onglet} affiche un titre`);
  }
  assert.equal(ctx.errors.length, 0, "aucune erreur pendant la navigation");
});

test("cartographie : points projetés, filtres actifs, fiche au clic", async () => {
  /* La cartographie est une destination de premier niveau depuis qu'elle est
     sortie de « Suivi-évaluation » : elle s'ouvre d'un seul clic, sans passer
     par un menu. */
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  await click(nav("Cartographie"), "destination Cartographie");
  await flush(); await flush();

  assert.ok(byText("h3", "Cartographie des sites"), "la carte est en place");
  /* Le fond de carte est rendu par Leaflet, qui gère son propre DOM et ne peint
     rien sous jsdom. Ce qui se teste ici est donc le répertoire des sites — la
     liste liée à la carte, qui est aussi la façon dont un utilisateur retrouve
     un site par son nom plutôt qu'à l'œil sur le fond. */
  const points = all("[data-site-item]");
  assert.ok(points.length > 20, `le répertoire liste les sites (${points.length} entrées)`);
  assert.ok(byText("div", "Légende"), "la légende est affichée");

  /* Un filtre réduit réellement la sélection. */
  const selects = all("main select");
  const filtreStatut = selects.find(s => [...s.options].some(o => o.value === "Inactive"));
  const avant = points.length;
  await type(filtreStatut, "Inactive");
  await flush(); await flush();
  const apres = all("[data-site-item]").length;
  assert.ok(apres < avant, `le filtre réduit la sélection (${avant} → ${apres})`);
  await type(filtreStatut, "Active"); await flush(); await flush();

  /* Le clic sur une entrée du répertoire ouvre la fiche du site. */
  const cible = all("[data-site-item]")[0];
  await click(cible, "un site du répertoire");
  await flush();
  assert.ok(byText("div", "Site sélectionné"), "la fiche du site s'ouvre");
  assert.ok(byText("dt", "Coordonnées"), "les coordonnées sont affichées");

  /* Le mode de coloration change la légende. */
  const modeSel = all("main select").find(s => [...s.options].some(o => o.value === "security"));
  await type(modeSel, "security"); await flush();
  assert.ok(document.body.textContent.includes("Aucune restriction"),
    "la légende suit le mode de coloration");
  assert.equal(ctx.errors.length, 0);
});

test("écriture : une modification est enregistrée sur le serveur et survit au rechargement", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  await click(nav("Suivi-évaluation"), "Suivi-évaluation"); await flush();
  const onglet = all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === "Paramètres de couverture");
  await click(onglet, "paramètres de couverture"); await flush();

  const champs = all("main tbody input[type=number]");
  const cible = champs.length ? champs[0] : null;
  if(cible){ await type(cible, "17"); }
  else {
    /* Le tableau est en lecture seule : on passe par la fiche d'édition. */
    const crayon = all("main tbody button")[0];
    await click(crayon, "modifier un paramètre"); await flush();
    const nb = all("input[type=number]");
    await type(nb[nb.length - 1], "17");
    await click(byText("footer button", "Enregistrer"), "enregistrer"); await flush();
  }
  await act(async () => { await sleep(1800); });   /* la file d'écriture se vide */

  const r = await fetch(`${BASE}/health`);
  assert.equal((await r.json()).database.foreignKeyViolations, 0,
    "l'écriture n'a introduit aucune incohérence référentielle");
});

test("plan MRE : la destination s'ouvre, le budget est calculé, la bascule fonctionne", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  await click(nav("Suivi-évaluation"), "Suivi-évaluation"); await flush();
  const onglet = all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === "Plan MRE et budget");
  await click(onglet, "sous-onglet Plan MRE et budget");
  await flush(); await flush(); await flush();

  assert.ok(byText("h3", "Plan MRE"), "le plan de l'année s'affiche");
  const texte = document.body.textContent;
  for(const bloc of ["Budget total", "Exécution budgétaire", "Budget par nature d'activité",
                     "Budget par catégorie de coût", "Charge mensuelle du plan"])
    assert.ok(texte.includes(bloc), `le bloc « ${bloc} » est présent`);

  /* Le budget affiché vient du serveur : on vérifie qu'il est chiffré, et que le
     total du plan égale bien la somme des budgets d'activité de la colonne. */
  const lignes = all("main tbody tr");
  assert.ok(lignes.length > 0, "le plan comporte des activités");
  /* On lit les valeurs brutes portées par les cellules, pas leur texte : le montant
     est groupé à la française (espace insécable fine) et suivi du nombre de lignes,
     les deux nombres se touchent. Même raison que `data-site` sur la carte. */
  const somme = all("main tbody td[data-budget]")
    .reduce((t, td) => t + Number(td.getAttribute("data-budget") || 0), 0);
  const total = Number(all("main tfoot td[data-budget-total]")[0]
    ?.getAttribute("data-budget-total") || 0);
  assert.ok(total > 0, "le total du plan est chiffré");
  assert.equal(Math.round(total), Math.round(somme),
    "le total du plan est bien la somme des budgets d'activité");

  /* La bascule montre l'exécution budgétaire — l'autre vue du même plan. */
  await click(byExact("button", "Exécution budgétaire"), "bascule vers l'exécution");
  await flush(); await flush();
  assert.ok(byText("h3", "Exécution budgétaire"), "la vue d'exécution s'affiche");
  assert.ok(document.body.textContent.includes("Dépense constatée"));
  assert.equal(ctx.errors.length, 0, "aucune erreur sur le plan MRE");
});

test("bureaux : l'écran de configuration liste les bureaux et leur périmètre", async () => {
  /* Ce que la liste de noms non persistée ne faisait pas : montrer la
     configuration réelle, y compris le bureau à périmètre national. */
  const menu = all("header.sticky button").pop();
  await click(menu, "menu du compte"); await flush();
  await click(byText("button", "Paramètres de l'application"), "paramètres");
  await flush(); await flush();
  const onglet = all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === "Bureaux");
  await click(onglet, "sous-onglet Bureaux");
  await flush(); await flush(); await flush();

  assert.ok(byText("h3", "Bureaux et antennes"), "la liste des bureaux s'affiche");
  assert.ok(document.body.textContent.includes("national — tous les sites"),
    "le bureau pays est signalé comme couvrant tous les sites");
  assert.ok(all("main tbody tr").length >= 2, "plusieurs bureaux sont listés");
  assert.equal(ctx.errors.length, 0, "aucune erreur sur l'écran des bureaux");
});

test("connecteurs : la table de correspondance est bâtie sur le registre servi par le serveur", async () => {
  /* Le point vérifié ici n'est pas cosmétique : les champs MEMS et les
     transformations affichés ne sont écrits nulle part dans le navigateur. S'ils
     apparaissent, c'est qu'ils viennent de GET /api/connectors/champs — donc du
     même registre que celui contre lequel l'enregistrement est validé. */
  const onglet = all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === "Connecteurs");
  await click(onglet, "sous-onglet Connecteurs");
  await flush(); await flush();

  assert.ok(document.body.textContent.includes("Une correspondance, pas du code"),
    "l'écran explique ce qu'il fait");
  assert.ok(byText("h4", "Aucun connecteur"), "aucun connecteur n'est déclaré au départ");

  await click(byText("button", "Nouveau"), "nouveau connecteur"); await flush();
  const champs = all(".z60 input");
  await type(champs[0], "Réceptions du partenaire");
  await click(byText(".z60 button", "Enregistrer"), "enregistrer le connecteur");
  await flush(); await flush();

  assert.ok(document.body.textContent.includes("Réceptions du partenaire"),
    "le connecteur créé apparaît dans la liste");

  await click(byText("main button", "Réceptions du partenaire"), "sélection du connecteur");
  await flush(); await flush();

  /* Les champs de l'entité « Site » viennent du serveur, avec leur type. */
  assert.ok(document.body.textContent.includes("geo_pcode"), "les champs MEMS sont listés");
  assert.ok(document.body.textContent.includes("beneficiaries"));
  const transformations = all("main option").map(o => o.textContent.trim());
  assert.ok(transformations.includes("P-code normalisé"),
    "le jeu fermé des transformations vient du serveur, pas d'une copie locale");
  assert.equal(ctx.errors.length, 0, "aucune erreur sur l'écran des connecteurs");
});

test("soumissions ODK : l'écran part du vide, puis montre la file de travail et ses motifs", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  const sousOnglet = (l) => all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === l);

  await click(nav("Programme"), "destination Programme"); await flush();
  await click(sousOnglet("Soumissions ODK"), "sous-onglet Soumissions ODK");
  await flush(); await flush();

  /* Le seed ne verse aucune soumission : l'écran s'ouvre donc sur le premier des
     deux vides, celui qu'on ne corrige pas en changeant de filtre. Il doit dire
     d'où viennent les soumissions plutôt que d'afficher un tableau sans lignes. */
  assert.ok(byText("h4", "Aucune soumission n'a encore été versée"),
    "l'état vide est explicite");
  assert.ok(document.body.textContent.includes("Paramètres → ODK Central"),
    "l'état vide explique d'où viennent les soumissions");
  assert.ok(byText("button", "Rejouer le rattachement"),
    "les actions d'administration sont proposées");

  /* Verser une source que personne n'a encore tirée ne verse rien — et c'est
     précisément le cas qu'un compte rendu doit savoir énoncer. Sans lui, le
     bouton semblerait sans effet, et l'utilisateur chercherait le défaut du
     mauvais côté de la chaîne. */
  const choixSource = all("main select")
    .find(s => [...s.options].some(o => o.textContent.includes("Suivi de processus")));
  assert.ok(choixSource, "la source ODK déclarée est proposée au versement");
  await type(choixSource, [...choixSource.options].find(o => o.value).value);
  await click(byText("main button", "Verser les soumissions"), "verser");
  await flush(); await flush();
  assert.ok(document.body.textContent.includes("cette source n'a aucune soumission en cache"),
    "le compte rendu dit qu'il faut d'abord tirer la source");
  assert.ok(byText("div", "Lues"), "le compte rendu du versement est chiffré");

  /* Deux soumissions versées par l'API, exactement ce que fait le bouton une fois
     la source tirée : l'une désigne un site réel par son code, l'autre un code
     inventé. C'est le couple minimal qui rend l'écran vérifiable — un
     rattachement réussi et un échec motivé. */
  const etat = await (await fetch(`${BASE}/state`)).json();
  const site = etat.sites[0];
  assert.ok(site?.code, "le référentiel de test porte au moins un site");

  const rep = await fetch(`${BASE}/submissions/ingest`, {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ form_id:"E2E_SUIVI", enregistrements:[
      { instance_id:"e2e-resolue", site_code:site.code, svy_date:"2026-05-04" },
      { instance_id:"e2e-orpheline", site_code:"CODE-INEXISTANT-E2E",
        site_name:"Site absent du référentiel", activity_tag:"URT", svy_date:"2026-05-05" },
    ] }),
  });
  const versement = await rep.json();
  assert.equal(rep.status, 200, JSON.stringify(versement));
  assert.equal(versement.resolues, 1, "le code d'un site réel se rattache");
  assert.equal(versement.nonResolues, 1, "le code inventé reste orphelin");

  await click(byText("main button", "Actualiser"), "actualiser l'écran");
  await flush(); await flush();

  /* L'état s'ouvre sur « non résolues » : c'est une file de travail, pas un
     inventaire. La soumission rattachée ne doit donc PAS y figurer. */
  const filtreEtat = all("main select").find(s => [...s.options].some(o => o.value === "non_resolues"));
  assert.ok(filtreEtat, "le filtre d'état est présent");
  assert.equal(filtreEtat.value, "non_resolues", "l'écran s'ouvre sur les non résolues");

  const lignes = all("[data-soumission]");
  assert.equal(lignes.length, 1, `seule la soumission non résolue est listée (${lignes.length})`);
  const texte = document.body.textContent;
  assert.ok(texte.includes("Site absent du référentiel"), "le nom brut du formulaire est affiché");
  assert.ok(texte.includes("non rattachée"), "l'absence de site est dite en toutes lettres");
  assert.ok(texte.includes("non résolu —"), "le motif explique l'échec");
  assert.ok(texte.includes("Répartition par passe de rattachement"), "le bandeau détaille les passes");

  /* Toutes les soumissions : la rattachée réapparaît, avec la passe qui l'a
     rattachée — celle du code externe, la seule qui vaille une égalité. */
  await type(filtreEtat, "toutes"); await flush(); await flush();
  assert.equal(all("[data-soumission]").length, 2, "les deux soumissions sont listées");
  assert.ok(document.body.textContent.includes("Code externe"),
    "la passe de rattachement est nommée sur la ligne résolue");

  /* Rejouer le rattachement rend un compte rendu chiffré, sans rien re-tirer. */
  await click(byText("main button", "Rejouer le rattachement"), "rejouer le rattachement");
  await flush(); await flush();
  assert.ok(document.body.textContent.includes("Rattachement rejoué sur toutes les soumissions"),
    "le compte rendu du rattachement s'affiche");
  assert.ok(byText("div", "Examinées"), "le compte rendu est chiffré");

  assert.equal(ctx.errors.length, 0, "aucune erreur sur l'écran des soumissions");
});

test("scripts d'analyse : l'exécution serveur s'annonce fermée au lieu de disparaître", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  const sousOnglet = (l) => all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === l);

  await click(nav("Analyses"), "destination Analyses"); await flush();
  await click(sousOnglet("Scripts d'analyse"), "sous-onglet Scripts d'analyse");
  await flush(); await flush();

  /* Aucun interpréteur n'est déclaré dans cet environnement : le serveur répond
     que la fonction est fermée, et l'écran doit le DIRE. Un bouton « Exécuter »
     simplement absent laisserait chercher un défaut de droits ou une panne, là
     où il s'agit d'un réglage volontaire du serveur. */
  const texte = document.body.textContent;
  assert.ok(texte.includes("L'exécution des scripts sur le serveur est désactivée"),
    "l'écran annonce que la fonction est fermée sur cette instance");
  assert.ok(texte.includes("ANALYSIS_R"), "la variable à renseigner est nommée");
  assert.ok(!byText("main button", "Exécuter"),
    "aucun bouton d'exécution n'est proposé tant qu'aucun interpréteur n'est disponible");
  /* Le travail hors ligne, lui, n'a pas bougé. */
  assert.ok(byText("main button", "Exporter") || byText("h4", "Aucun script"),
    "le téléchargement du script et des données reste offert");
  assert.equal(ctx.errors.length, 0, "aucune erreur sur l'écran des scripts");
});

test("administration : la destination existe pour le compte super et l'onglet Santé répond", async () => {
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  const sousOnglet = (l) => all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === l);

  /* Le compte d'amorçage est un super-utilisateur, mais sa liste d'onglets a été
     enregistrée avant que cette destination existe. Qu'elle apparaisse quand
     même est précisément ce qui se vérifie ici : la règle suit le RÔLE, sinon
     aucun compte déjà créé ne verrait jamais l'administration. */
  const dest = nav("Administration");
  assert.ok(dest, "la destination Administration est proposée au super-utilisateur");
  await click(dest, "destination Administration");
  await flush(); await flush();
  assert.ok(byText("main h2", "Administration"), "la console d'administration s'ouvre");

  /* Sessions : la liste vient de GET /api/auth/sessions?tous=1, réservé au rôle
     super — la session de l'appelant doit s'y reconnaître. */
  assert.ok(all("[data-session]").length >= 1, "au moins une session est listée");
  assert.ok(document.body.textContent.includes("la vôtre"),
    "la session courante est signalée comme telle");

  await click(sousOnglet("Santé"), "sous-onglet Santé");
  await flush(); await flush();

  /* Chacune de ces affirmations vient de la réponse du serveur, pas du rendu :
     l'intégrité, les réglages du moteur et les migrations appliquées ne sont
     écrits nulle part dans le navigateur. */
  const texte = document.body.textContent;
  assert.ok(texte.includes("Intégrité"), "l'état d'intégrité de la base est affiché");
  assert.ok(texte.includes("Conforme"), "la base de test est déclarée conforme");
  assert.ok(byText("h3", "Entretien"), "les opérations d'entretien sont proposées");
  assert.ok(byText("main button", "VACUUM"), "le VACUUM est offert, sous confirmation");
  assert.ok(byText("h3", "Migrations appliquées"), "les migrations appliquées sont listées");
  assert.ok(texte.includes("journal_mode"), "les réglages SQLite viennent du serveur");
  assert.ok(all("main tbody tr").length > 5, "les tables de la base sont dénombrées");

  /* Une action destructrice ne part pas au premier clic : elle énonce d'abord
     ce qu'elle va faire. */
  await click(byText("main button", "VACUUM"), "VACUUM");
  await flush();
  assert.ok(byText(".z60 h3", "Lancer un VACUUM sur la base ?"),
    "la confirmation nomme l'opération avant de la lancer");
  assert.ok(document.body.textContent.includes("bloque toute lecture et toute écriture"),
    "la confirmation dit ce que l'opération va provoquer");
  await click(byText(".z60 button", "Annuler"), "annuler le VACUUM");
  await flush();

  assert.equal(ctx.errors.length, 0, "aucune erreur sur la console d'administration");
});

test("déconnexion : la session est fermée et l'écran de connexion revient", async () => {
  const menu = all("header.sticky button").pop();
  await click(menu, "menu du compte"); await flush();
  await click(byText("button", "Se déconnecter"), "se déconnecter");
  await flush(); await flush();
  assert.ok(byText("h2", "Connexion"), "retour à l'écran de connexion");
  const r = await fetch(`${BASE}/state`);
  assert.equal(r.status, 401, "l'API refuse désormais l'accès");
});

test("bilan : aucune erreur de rendu sur l'ensemble du parcours", () => {
  assert.deepEqual(ctx.errors, [], ctx.errors.join("\n"));
});
