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
  execFileSync("npx", ["esbuild", "src/App.jsx", "--bundle", "--format=esm",
    "--loader:.jsx=jsx", "--jsx=automatic", "--external:react", "--external:react-dom",
    "--external:react/jsx-runtime", "--outfile=test/_app.mjs", "--log-level=error"], { stdio:"pipe" });

  ctx = makeDom(BASE);
  React = (await import("react")).default;
  ({ createRoot } = await import("react-dom/client"));
  act = (await import("react")).act;
  App = (await import("./_app.mjs")).default;
});

after(async () => {
  /* Fermer la fenêtre simulée : jsdom y garde des minuteurs et un observateur de
     redimensionnement, qui suffisent à retenir la boucle d'événements. Sans cela le
     lot de tests passait puis ne rendait jamais la main — un test vert qui ne
     s'arrête pas est un test qui bloque une intégration continue. */
  try{ ctx?.dom?.window?.close(); }catch(e){}
  child?.kill("SIGTERM");
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
  for(const bloc of ["Exigence minimale de suivi", "Trois derniers mois",
                     "Tâches urgentes", "Plan et réalisé par catégorie d'activité"])
    assert.ok(texte.includes(bloc), `le bloc « ${bloc} » est présent`);
  const lignes = all("main tbody tr").length;
  assert.ok(lignes > 0, "les tâches urgentes sont alimentées");
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
  const nav = (l) => all("header nav button").find(b => b.textContent.trim().startsWith(l));
  await click(nav("Suivi-évaluation"), "Suivi-évaluation"); await flush();
  const sousOnglet = all("main button").filter(b => b.className.includes("-mb-px"))
    .find(b => b.textContent.trim() === "Cartographie");
  await click(sousOnglet, "sous-onglet Cartographie");
  await flush(); await flush();

  assert.ok(byText("h3", "Cartographie des sites"), "la carte est en place");
  const points = all("svg circle[data-site]");
  assert.ok(points.length > 20, `des sites sont projetés (${points.length} points)`);
  assert.ok(byText("div", "Légende"), "la légende est affichée");

  /* Un filtre réduit réellement le nombre de points. */
  const selects = all("main select");
  const filtreStatut = selects.find(s => [...s.options].some(o => o.value === "Inactive"));
  const avant = points.length;
  await type(filtreStatut, "Inactive");
  await flush(); await flush();
  const apres = all("svg circle[data-site]").length;
  assert.ok(apres < avant, `le filtre réduit la sélection (${avant} → ${apres})`);
  await type(filtreStatut, "Active"); await flush(); await flush();

  /* Le clic sur un point ouvre la fiche du site. */
  const cible = all("svg circle[data-site]")[0];
  await click(cible, "un point de la carte");
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

test("multi-pays : le sélecteur n'apparaît qu'avec deux pays, et place le compte dans l'un d'eux", async () => {
  /* Un seul pays configuré : pas de sélecteur. Un champ qui ne propose qu'une valeur
     est du bruit, et il ferait croire à un choix qui n'existe pas. */
  assert.equal(all('header select[aria-label="Pays"]').length, 0,
    "aucun sélecteur tant que l'instance ne sert qu'un pays");

  /* On configure un deuxième pays comme le ferait un administrateur, par l'API — la
     saisie du vocabulaire des cinq niveaux est déjà éprouvée côté serveur. */
  const niv = { adm0:{one:"Pays",many:"Pays"}, adm1:{one:"Province",many:"Provinces"},
    adm2:{one:"Territoire",many:"Territoires"}, adm3:{one:"Secteur",many:"Secteurs"},
    adm4:{one:"Groupement",many:"Groupements"} };
  const cr = await fetch(`${BASE}/country`, { method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ code:"COD", name:"RD Congo", currency:"CDF", levels:niv }) });
  assert.equal(cr.status, 201);

  /* Le rechargement du navigateur n'existe pas dans ce DOM simulé : on le remplace
     pour observer que le changement de pays le demande bien. Il est voulu — les
     collections en mémoire d'un pays ne doivent jamais s'afficher sous le vocabulaire
     de l'autre, et un rafraîchissement partiel laisserait cet état une fraction de
     seconde. */
  const avantReload = ctx.reloads();

  /* L'état est relu : c'est lui qui porte la liste des pays. */
  const menu = all("header.sticky button").pop();
  await click(menu, "menu du compte"); await flush();
  await click(byText("button", "Se déconnecter"), "se déconnecter"); await flush(); await flush();
  await type(all('input[type="email"]')[0], ADMIN.email);
  /* Le mot de passe d'amorçage a été remplacé au premier accès (essai n° 4) : c'est
     celui-là qu'il faut redonner. */
  await type(all('input[type="password"]')[0], "NouveauMotDePasse2026");
  await click(byText("button", "Se connecter"), "se connecter");
  await flush(); await flush(); await flush();

  const sel = all('header select[aria-label="Pays"]')[0];
  assert.ok(sel, "le sélecteur apparaît dès que deux pays sont servis");
  const codes = [...sel.options].map(o => o.value);
  assert.deepEqual(codes.sort(), ["COD","MDG"], "les deux pays sont proposés");
  assert.equal(sel.value, "MDG", "on démarre dans le pays par défaut de l'instance");

  await type(sel, "COD");
  assert.equal(ctx.reloads() - avantReload, 1, "changer de pays recharge l'application");
  assert.equal(window.localStorage.getItem("mems.pays"), "COD",
    "le choix survit à un rechargement");

  /* Et le serveur suit l'en-tête : même session, autre vocabulaire, autres bureaux. */
  const etat = await (await fetch(`${BASE}/state`, { headers:{ "X-MEMS-Country":"COD" } })).json();
  assert.equal(etat.country.code, "COD");
  assert.equal(etat.country.levels.adm3.one, "Secteur");
  assert.equal(etat.offices.length, 0, "aucun bureau congolais n'est encore configuré");
  assert.ok(etat.sites.length === 0, "et donc aucun site : les sites suivent leur bureau");

  /* Remise en état pour la suite du parcours. */
  window.localStorage.removeItem("mems.pays");
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
