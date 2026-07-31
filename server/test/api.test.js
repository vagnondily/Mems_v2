import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

/* Base isolée, recréée à chaque exécution. */
const DB = path.resolve("./data/test.db");
process.env.NODE_ENV = "test";
process.env.DB_FILE = DB;
process.env.JWT_SECRET = "x".repeat(48);
process.env.DATA_KEY = "y".repeat(48);
process.env.BOOTSTRAP_EMAIL = "admin@test.local";
process.env.BOOTSTRAP_PASSWORD = "MotDePasseTest2026";
process.env.RATE_LOGIN_MAX = "50";
process.env.BCRYPT_ROUNDS = "4";          /* tests rapides ; la production reste à 12 */
process.env.FORCE_SEED = "1";

for(const f of [DB, DB+"-wal", DB+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
fs.mkdirSync(path.dirname(DB), { recursive:true });
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db } = await import("../src/db.js");

const login = async (email, password) => {
  const r = await request(app).post("/api/auth/login").send({ email, password });
  return r;
};
let adminToken;
const asAdmin = () => request(app).set ? null : null;

test("santé : la base est intègre et sans violation de clé étrangère", async () => {
  const r = await request(app).get("/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.body.status, "ok");
  assert.equal(r.body.database.foreignKeyViolations, 0);
  assert.equal(r.body.database.integrity, "ok");
});

test("connexion : refusée sans identifiants valides, sans révéler l'existence du compte", async () => {
  const inconnu = await login("personne@nulle.part", "MotDePasseTest2026");
  const mauvais = await login("admin@test.local", "mauvais");
  assert.equal(inconnu.status, 401);
  assert.equal(mauvais.status, 401);
  assert.equal(inconnu.body.error, mauvais.body.error);
});

test("connexion : réussie, jeton émis, mot de passe jamais renvoyé", async () => {
  const r = await login("admin@test.local", "MotDePasseTest2026");
  assert.equal(r.status, 200);
  assert.ok(r.body.token);
  adminToken = r.body.token;
  assert.equal(r.body.user.email, "admin@test.local");
  const body = JSON.stringify(r.body);
  assert.ok(!/pw_hash|password|MotDePasseTest2026/.test(body),
    "la réponse ne doit contenir aucune trace du mot de passe");
});

test("accès protégé : refusé sans jeton, accepté avec", async () => {
  assert.equal((await request(app).get("/api/state")).status, 401);
  const r = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.sites.length > 100);
  assert.ok(!/pw_hash/.test(JSON.stringify(r.body)));
});

test("état : les sites portent bien leur grille mensuelle à douze entrées", async () => {
  const r = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const s = r.body.sites[0];
  assert.equal(s.plan.length, 12);
  assert.ok(Object.hasOwn(s.plan[0], "report"));
  assert.ok(Object.hasOwn(s.plan[0], "moda"));
});

test("validation : un site hors bornes est rejeté avec le détail du champ", async () => {
  const r = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"TEST-1", name:"Site de test", security:7, beneficiaries:-5 });
  assert.equal(r.status, 422);
  assert.ok(r.body.details.some(d => d.champ === "security"));
});

test("sites : création, unicité du code, modification et suppression", async () => {
  const create = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"TEST-CRUD", name:"Site CRUD", beneficiaries:1200, security:1 });
  assert.equal(create.status, 201);
  const id = create.body.site.id;

  const dup = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"TEST-CRUD", name:"Doublon" });
  assert.equal(dup.status, 409);

  const upd = await request(app).put(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"TEST-CRUD", name:"Site CRUD modifié", beneficiaries:1500 });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.site.name, "Site CRUD modifié");

  const del = await request(app).delete(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 200);
  assert.equal((await request(app).get(`/api/sites/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)).status, 404);
});

test("grille mensuelle : cocher « réalisé » crée la visite et met à jour la dernière visite", async () => {
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const site = st.body.sites.find(s => s.status === "Active");
  const year = st.body.year;
  const before = db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c;
  const r = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ month:11, year, active:true, planned:true, done:true, monitor:"Testeur" });
  assert.equal(r.status, 200);
  const after = db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c;
  assert.equal(after, before + 1);
  const s = db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id);
  assert.ok(s.last_visit.startsWith(`${year}-12`));
});

test("modification groupée : seuls les champs autorisés passent", async () => {
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const ids = st.body.sites.slice(0, 5).map(s => s.id);
  const ok = await request(app).post("/api/sites/bulk").set("Authorization", `Bearer ${adminToken}`)
    .send({ ids, field:"modality", value:"Coupons" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.updated, 5);

  const ko = await request(app).post("/api/sites/bulk").set("Authorization", `Bearer ${adminToken}`)
    .send({ ids, field:"pw_hash", value:"tentative" });
  assert.equal(ko.status, 422);
});

test("collections : la synchronisation crée, met à jour et supprime en une transaction", async () => {
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const rows = st.body.reportTemplates.map(t => ({ ...t }));
  rows.push({ name:"Modèle ajouté par le test", blocks:["kpi"], intro:"" });
  const r = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${adminToken}`).send({ rows });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 1);
  const total = db.prepare("SELECT COUNT(*) c FROM report_templates").get().c;
  assert.equal(total, rows.length);

  /* Les révisions ont changé : un client relit l'état avant d'écrire à nouveau. */
  const frais = (await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`))
    .body.reportTemplates;

  /* Retirer une ligne du corps ne la supprime plus : il faut le demander.
     C'est ce qui empêche d'effacer les lignes qu'un collègue a ajoutées entre-temps. */
  const implicite = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${adminToken}`).send({ rows: frais.slice(0, 1) });
  assert.equal(implicite.body.removed, 0, "aucune suppression déduite");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM report_templates").get().c, rows.length);

  /* Suppression explicite. */
  const aSupprimer = db.prepare("SELECT id FROM report_templates").all()
    .map(x => x.id).slice(1);
  const dernier = (await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`))
    .body.reportTemplates;
  const explicite = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: dernier.slice(0, 1), deletes: aSupprimer });
  assert.equal(explicite.body.removed, aSupprimer.length);
});

test("listes de référence : une catégorie d'activité ajoutée survit au rechargement", async () => {
  /* Les catégories d'activité et les sous-types de point d'intérêt s'éditaient dans
     Paramètres → Général sans jamais être enregistrés : l'écran modifiait une
     projection en mémoire, aucune route ne les recevait. On ajoutait une catégorie,
     elle apparaissait dans toutes les listes déroulantes, et elle avait disparu au
     rechargement suivant. Le sous-type allait plus loin : l'état ne rendait même pas
     la table, si bien que l'écran affichait une liste vide sur des données présentes. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(Array.isArray(st.body.poiSubtypes), "les sous-types de point d'intérêt sont rendus par /state");
  assert.ok(st.body.poiSubtypes.length, "et le semis en a chargé");

  const id = "cat-test-" + Date.now();
  const cree = await request(app).put("/api/collections/activityCategories")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: [...st.body.categories, { id, name:"Cantines scolaires (test)", tag:"SFT",
                                            program_area:"Nutrition", active:true }] });
  assert.equal(cree.status, 200, cree.body.error);
  assert.equal(cree.body.created, 1);

  const relu = (await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`)).body;
  const posee = relu.categories.find(c => c.id === id);
  assert.ok(posee, "la catégorie est bien là après relecture de l'état");
  assert.equal(posee.tag, "SFT");

  /* Rien ne la référence encore : elle se supprime. */
  const oter = await request(app).put("/api/collections/activityCategories")
    .set("Authorization", `Bearer ${adminToken}`).send({ rows: relu.categories.filter(c=>c.id!==id),
      deletes: [id] });
  assert.equal(oter.body.removed, 1);
});

test("listes de référence : une catégorie portée par des sites ne se supprime pas", async () => {
  /* Le schéma détacherait les sites en silence (ON DELETE SET NULL) : des sites sans
     catégorie, hors de tous les filtres et de tous les totaux par activité. On refuse,
     et l'écran propose de désactiver — ce qui les retire des choix sans rien détacher. */
  const utilisee = db.prepare(
    `SELECT category_id id, COUNT(*) c FROM sites WHERE category_id IS NOT NULL
     GROUP BY category_id ORDER BY c DESC LIMIT 1`).get();
  assert.ok(utilisee, "le semis rattache des sites à une catégorie");

  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const r = await request(app).put("/api/collections/activityCategories")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: st.body.categories.filter(c => c.id !== utilisee.id), deletes: [utilisee.id] });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /référencée|désactivez/i);
  assert.equal(r.body.bloquees[0].usage.sites, utilisee.c);
  assert.ok(db.prepare("SELECT 1 FROM activity_categories WHERE id=?").get(utilisee.id),
    "la catégorie est intacte");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sites WHERE category_id=?").get(utilisee.id).c,
    utilisee.c, "aucun site n'a été détaché");
});

test("réglages : le barème et les formules de couverture sont conservés", async () => {
  /* Le barème de priorité, les formules de couverture et les coefficients trimestriels
     s'éditaient à l'écran et ne repartaient nulle part : ils étaient reconstruits
     depuis les constantes à chaque chargement. On modifiait une formule, on rechargeait,
     et l'on retrouvait celle d'origine — sans un message. */
  const formules = [{ id:"minInterval", label:"Intervalle minimal", expr:"duration / riskLevel", core:true }];
  const r = await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ formulas: formules, scoring: { medium:{ value:3 }, high:{ value:5 } } });
  assert.equal(r.status, 200);
  const relu = (await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`)).body;
  assert.equal(relu.settings.formulas[0].expr, "duration / riskLevel");
  assert.equal(relu.settings.scoring.high.value, 5);
});

test("collections : une référence inexistante renvoie un conflit, pas une erreur serveur", async () => {
  const r = await request(app).put("/api/collections/outcomes")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: [{ indicator_id:"inexistant", planned:1, value:1, sample:10 }] });
  assert.equal(r.status, 409);
});

test("jetons de source externe : chiffrés au repos, jamais renvoyés", async () => {
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const forms = st.body.odkForms.map(f => ({ ...f, token:"jeton-tres-secret-123" }));
  const w = await request(app).put("/api/collections/odkForms")
    .set("Authorization", `Bearer ${adminToken}`).send({ rows: forms });
  assert.equal(w.status, 200);
  const stored = db.prepare("SELECT token_enc FROM odk_forms LIMIT 1").get().token_enc;
  assert.ok(stored && !stored.includes("jeton-tres-secret"));
  const after = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(!/jeton-tres-secret/.test(JSON.stringify(after.body)));
  assert.equal(after.body.odkForms[0].hasToken, true);
});

test("droits : un lecteur peut consulter mais ne peut rien écrire", async () => {
  const create = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecteur@test.local", password:"LecteurMotDePasse1", first_name:"Lecteur",
            role:"viewer", tabs:["home"], active:true });
  assert.equal(create.status, 201);
  const lr = await login("lecteur@test.local", "LecteurMotDePasse1");
  assert.equal(lr.status, 200);
  const t = lr.body.token;
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).status, 200);
  const w = await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"NON", name:"Interdit" });
  assert.equal(w.status, 403);
  const u = await request(app).get("/api/users").set("Authorization", `Bearer ${t}`);
  assert.equal(u.status, 403);
});

test("cloisonnement : un compte rattaché à un bureau ne voit que ses sites", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"terrain@test.local", password:"TerrainMotDePasse1", first_name:"Terrain",
            role:"editor", office_id:office.id, tabs:["home"], active:true });
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  assert.ok(st.body.sites.length > 0);
  assert.ok(st.body.sites.every(s => s.office_id === office.id));
  assert.equal(st.body.users.length, 0, "un éditeur ne reçoit pas la liste des comptes");

  const autre = db.prepare("SELECT id FROM sites WHERE office_id<>? LIMIT 1").get(office.id);
  const r = await request(app).get(`/api/sites/${autre.id}`).set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 403);
});

/* Le cloisonnement ne valait que pour les sites : visites, distributions, paramètres et
   journal partaient en clair vers tous les bureaux. Ce test verrouille la correction. */
test("exercice : /state sert l'année demandée, et l'année en cours par défaut", async () => {
  /* Tout ce qui est daté était figé sur l'année du calendrier : au 1er janvier, le
     travail de l'exercice écoulé devenait invisible d'un seul coup, et rien ne
     permettait de préparer le suivant. */
  const enCours = new Date().getFullYear();

  const defaut = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(defaut.status, 200);
  assert.equal(defaut.body.year, enCours, "sans argument, l'exercice est celui en cours");
  assert.equal(defaut.body.anneeEnCours, enCours);
  assert.ok(Array.isArray(defaut.body.annees) && defaut.body.annees.length,
    "les exercices disponibles sont annoncés");
  assert.ok(defaut.body.annees.includes(enCours) && defaut.body.annees.includes(enCours + 1),
    "l'année en cours et la suivante sont toujours proposées — on prépare avant d'avoir des lignes");

  /* Un exercice explicite ne rend QUE ses lignes datées. */
  const precedent = await request(app).get(`/api/state?year=${enCours - 1}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(precedent.body.year, enCours - 1);
  assert.ok(precedent.body.pdd.every(p => p.year === enCours - 1),
    "le plan de distribution ne mélange pas les exercices");
  const attendu = db.prepare("SELECT COUNT(*) c FROM pdd WHERE year=?").get(enCours - 1).c;
  assert.equal(precedent.body.pdd.length, attendu);

  /* Une année absurde ne fait pas tomber la route : on retombe sur l'exercice en cours. */
  for(const mauvais of ["1066", "abcd", "99999", ""]){
    const r = await request(app).get(`/api/state?year=${mauvais}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(r.status, 200, `year=${mauvais} doit rester servi`);
    assert.equal(r.body.year, enCours, `year=${mauvais} retombe sur l'année en cours`);
  }
});

test("plan de distribution : il se dérive du ciblage au lieu de se saisir ligne à ligne", async () => {
  /* Le plan se SAISISSAIT : une ligne par commune, par mois, par activité, dans une
     fenêtre de vingt champs. Pour quelques centaines de communes sur douze mois, cela
     fait des milliers de lignes à taper puis à retaper l'année suivante — autant dire
     que le travail se ferait dans un tableur, et l'application ne servirait plus.

     Il se dérive maintenant du ciblage déjà connu commune par commune. */
  const an = new Date().getFullYear();

  const zones = await request(app).get(`/api/pdd/zones?year=${an}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(zones.status, 200);
  assert.ok(zones.body.rows.length, "des communes sont proposées dans le périmètre");
  const z = zones.body.rows[0];
  for(const champ of ["pcode","name","targeted","office_id","bureau"])
    assert.ok(champ in z, `la zone annonce « ${champ} »`);
  assert.ok(zones.body.rows.some(x => x.office_id),
    "le bureau responsable est résolu depuis le découpage — sinon les lignes naîtraient orphelines");

  const pcodes = zones.body.rows.filter(x => x.targeted > 0).map(x => x.pcode).slice(0, 4);
  assert.ok(pcodes.length, "le jeu d'essai porte un ciblage");
  const params = { year:an, months:[9,10], pcodes, actType:"GD_TEST", tag:"URT",
    actMain:"Distribution générale (test)", wbs:"URT1", modality:"Food", commodity:"Riz",
    days:30, source:"ciblage", couverture:50 };

  /* L'aperçu chiffre sans écrire : un plan de plusieurs centaines de lignes ne se
     crée pas à l'aveugle. */
  const vu = await request(app).post("/api/pdd/preview")
    .set("Authorization", `Bearer ${adminToken}`).send(params);
  assert.equal(vu.status, 200, vu.body.error);
  assert.equal(vu.body.lignes, pcodes.length * 2, "communes × mois");
  assert.ok(vu.body.beneficiaires > 0, "les bénéficiaires viennent du ciblage");
  assert.ok(vu.body.tonnage > 0, "le tonnage découle de la ration");
  const avant = db.prepare("SELECT COUNT(*) c FROM pdd WHERE act_type=?").get("GD_TEST").c;
  assert.equal(avant, 0, "l'aperçu n'a rien écrit");

  const gen = await request(app).post("/api/pdd/generate")
    .set("Authorization", `Bearer ${adminToken}`).send(params);
  assert.equal(gen.status, 201, gen.body.error);
  assert.equal(gen.body.creees, pcodes.length * 2);
  const creees = db.prepare("SELECT * FROM pdd WHERE act_type=?").all("GD_TEST");
  assert.equal(creees.length, pcodes.length * 2);
  assert.ok(creees.every(l => l.geo_pcode),
    "chaque ligne est rattachée au découpage — sans quoi elle ne remonte dans aucun total par zone");
  assert.ok(creees.every(l => l.office_id), "et rattachée à un bureau");

  /* Rejouer ne doit pas empiler des doublons en silence. */
  const rejeu = await request(app).post("/api/pdd/generate")
    .set("Authorization", `Bearer ${adminToken}`).send(params);
  assert.equal(rejeu.status, 409);
  assert.equal(rejeu.body.ignorees, pcodes.length * 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE act_type=?").get("GD_TEST").c,
    pcodes.length * 2, "rien n'a été ajouté");

  /* Reprendre un mois vers d'autres, avec un ajustement de volume. */
  const rep = await request(app).post("/api/pdd/duplicate")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, fromMonth:9, toMonths:[11], actType:"GD_TEST", facteur:0.5 });
  assert.equal(rep.status, 201, rep.body.error);
  assert.equal(rep.body.creees, pcodes.length);
  const source = db.prepare(
    "SELECT SUM(benef_planned) s FROM pdd WHERE act_type=? AND month=9").get("GD_TEST").s;
  const copie = db.prepare(
    "SELECT SUM(benef_planned) s FROM pdd WHERE act_type=? AND month=11").get("GD_TEST").s;
  assert.ok(Math.abs(copie - source / 2) <= pcodes.length,
    "les volumes suivent le facteur demandé");
  assert.equal(db.prepare(
    "SELECT SUM(benef_actual) s FROM pdd WHERE act_type=? AND month=11").get("GD_TEST").s, 0,
    "les réalisations ne se recopient jamais : elles n'ont pas eu lieu");

  db.prepare("DELETE FROM pdd WHERE act_type=?").run("GD_TEST");
});

test("plan de distribution : on ne génère pas hors de son périmètre", async () => {
  /* Le générateur écrit en masse ; c'est précisément là qu'un défaut de cloisonnement
     coûterait le plus cher. Un compte de terrain ne doit pas pouvoir semer six cents
     lignes dans les communes d'un autre bureau. */
  const an = new Date().getFullYear();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const toutes = (await request(app).get(`/api/pdd/zones?year=${an}`)
    .set("Authorization", `Bearer ${adminToken}`)).body.rows;
  const siennes = (await request(app).get(`/api/pdd/zones?year=${an}`)
    .set("Authorization", `Bearer ${t}`)).body.rows;
  assert.ok(siennes.length < toutes.length,
    "le compte de terrain ne voit qu'une partie des communes");

  const codesSiens = new Set(siennes.map(z => z.pcode));
  const etrangere = toutes.find(z => !codesSiens.has(z.pcode));
  assert.ok(etrangere, "le jeu d'essai comporte une commune hors de son périmètre");

  const r = await request(app).post("/api/pdd/generate").set("Authorization", `Bearer ${t}`)
    .send({ year:an, months:[5], pcodes:[etrangere.pcode], actType:"GD_HORS",
            tag:"URT", modality:"Food", days:30 });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /périmètre/i);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE act_type=?").get("GD_HORS").c, 0);
});

test("cohérence géographique : le contrôle voit ce qui casse le fil du p-code", async () => {
  /* Le découpage, les coordonnées et les listes ne se parlent que par le p-code.
     Qu'il casse quelque part — un réimport de découpage suffit — et rien ne se voit :
     les écrans continuent d'afficher des nombres, simplement ils n'additionnent plus
     les mêmes choses. Un contrôle qui ne trouverait jamais rien ne vaudrait rien ; on
     lui donne donc de vrais défauts à trouver. */
  const sain = await request(app).get("/api/geo/coherence")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(sain.status, 200);
  assert.ok(sain.body.version, "un découpage courant est chargé dans le jeu d'essai");
  assert.ok(sain.body.constats.length >= 10, "tous les postes de contrôle sont rendus");

  const trouve = (cle) => sain.body.constats.find(c => c.cle === cle);
  for(const cle of ["sites_pcode_inconnu","sites_sans_rattachement","sites_libelles_contredits",
                    "sites_point_hors_unite","pdd_sans_rattachement","caseload_pcode_inconnu"])
    assert.ok(trouve(cle), `le contrôle « ${cle} » existe`);

  /* On casse, on vérifie que c'est vu, on remet en état. */
  const site = db.prepare("SELECT * FROM sites WHERE geo_pcode IS NOT NULL LIMIT 1").get();
  const autre = db.prepare("SELECT * FROM sites WHERE geo_pcode IS NOT NULL AND id<>? LIMIT 1").get(site.id);
  const ligne = db.prepare("SELECT * FROM pdd WHERE geo_pcode IS NOT NULL LIMIT 1").get();
  db.prepare("UPDATE sites SET geo_pcode='XX_DISPARU' WHERE id=?").run(site.id);
  db.prepare("UPDATE sites SET adm2='District Inventé' WHERE id=?").run(autre.id);
  if(ligne) db.prepare("UPDATE pdd SET geo_pcode=NULL WHERE id=?").run(ligne.id);

  const casse = await request(app).get("/api/geo/coherence")
    .set("Authorization", `Bearer ${adminToken}`);
  const c = (cle) => casse.body.constats.find(x => x.cle === cle);
  assert.ok(c("sites_pcode_inconnu").n >= 1, "le rattachement vers une unité disparue est vu");
  assert.ok(c("sites_pcode_inconnu").exemples.length, "et nommé, pour qu'on puisse le retrouver");
  assert.ok(c("sites_libelles_contredits").n >= 1,
    "un libellé qui contredit le découpage est vu — les filtres par texte et par carte divergeraient");
  if(ligne) assert.ok(c("pdd_sans_rattachement").n >= 1,
    "une ligne de plan détachée est vue : elle n'entre dans aucun total par commune");
  assert.ok(casse.body.ecarts > sain.body.ecarts, "le total d'écarts a monté");

  db.prepare("UPDATE sites SET geo_pcode=? WHERE id=?").run(site.geo_pcode, site.id);
  db.prepare("UPDATE sites SET adm2=? WHERE id=?").run(autre.adm2, autre.id);
  if(ligne) db.prepare("UPDATE pdd SET geo_pcode=? WHERE id=?").run(ligne.geo_pcode, ligne.id);

  const remis = await request(app).get("/api/geo/coherence")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(remis.body.ecarts, sain.body.ecarts, "tout est revenu à l'état initial");
});

test("sauvegarde : le fichier est complet et ne contient aucun secret", async () => {
  /* Un fichier de sauvegarde circule par courriel et finit sur une clé USB. Il ne doit
     jamais suffire à se faire passer pour quelqu'un. */
  const r = await request(app).get("/api/backup").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.manifeste.format, "mems-sauvegarde/1");
  assert.ok(r.body.manifeste.postes.length > 10, "la sauvegarde couvre l'essentiel des tables");

  const brut = JSON.stringify(r.body);
  for(const secret of ["pw_hash", "token_enc", "reset_token"])
    assert.ok(!brut.includes(secret), `« ${secret} » ne doit jamais sortir dans une sauvegarde`);
  assert.ok(r.body.donnees.users?.length, "les comptes sont bien sauvegardés, sans leurs secrets");
  assert.ok(r.body.donnees.users.every(u => !("pw_hash" in u)));

  /* Un compte sans droit d'administration ne sauvegarde pas la base entière. */
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/backup").set("Authorization", `Bearer ${t}`)).status, 403);
});

test("restauration : elle montre ce qu'elle ferait avant de le faire", async () => {
  const sauv = (await request(app).get("/api/backup?parts=reportTemplates")
    .set("Authorization", `Bearer ${adminToken}`)).body;
  const modeles = sauv.donnees.reportTemplates;
  const avant = db.prepare("SELECT COUNT(*) c FROM report_templates").get().c;

  /* L'examen n'écrit rien. */
  const exam = await request(app).post("/api/backup/restore")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ donnees:{ reportTemplates:[...modeles, { id:"rt_restaure", name:"Modèle restauré",
            blocks:"[]", intro:"" }] }, mode:"completer", examiner:true });
  assert.equal(exam.status, 200);
  assert.equal(exam.body.examen, true);
  assert.equal(exam.body.plan[0].creees, 1, "une seule ligne est nouvelle");
  assert.equal(exam.body.plan[0].inchangees, modeles.length);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM report_templates").get().c, avant,
    "l'examen n'a rien écrit");

  /* L'écriture, elle, écrit — et seulement ce qui manquait. */
  const fait = await request(app).post("/api/backup/restore")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ donnees:{ reportTemplates:[...modeles, { id:"rt_restaure", name:"Modèle restauré",
            blocks:"[]", intro:"" }] }, mode:"completer", examiner:false });
  assert.equal(fait.status, 200);
  assert.equal(fait.body.creees, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM report_templates").get().c, avant + 1);
  db.prepare("DELETE FROM report_templates WHERE id='rt_restaure'").run();
});

test("restauration : elle refuse de détacher en silence ce qu'elle ne pourra pas recoller", async () => {
  /* Le piège de la restauration destructrice, et il ne se voit pas : le schéma détache
     les lignes dépendantes (ON DELETE SET NULL) au lieu de refuser. Remplacer les seuls
     partenaires, en réinsérant exactement les mêmes identifiants, laissait tous les
     sites sans partenaire — l'effacement précède la réécriture, et la réécriture ne
     recolle rien. On récupérait un fichier conforme et une base amputée d'un lien
     qu'aucun écran ne signale. */
  const sauv = (await request(app).get("/api/backup?parts=partners")
    .set("Authorization", `Bearer ${adminToken}`)).body;
  const lies = db.prepare("SELECT COUNT(*) c FROM sites WHERE partner_id IS NOT NULL").get().c;
  assert.ok(lies > 0, "le jeu d'essai rattache des sites à des partenaires");

  const exam = await request(app).post("/api/backup/restore")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ donnees:{ partners:sauv.donnees.partners }, mode:"remplacer", examiner:true });
  assert.ok(exam.body.detacherait >= lies, "l'examen chiffre les dégâts avant qu'ils n'arrivent");
  assert.ok(exam.body.plan[0].detacherait.some(d => d.table === "sites"));

  const refus = await request(app).post("/api/backup/restore")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ donnees:{ partners:sauv.donnees.partners }, mode:"remplacer", examiner:false });
  assert.equal(refus.status, 409);
  assert.match(refus.body.error, /détacherait/);
  assert.ok(refus.body.remede, "et l'on dit comment s'y prendre autrement");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sites WHERE partner_id IS NOT NULL").get().c,
    lies, "aucun rattachement n'a été perdu");
});

test("mise à jour : fermée par défaut, et rien ne vient de la requête", async () => {
  /* Un bouton qui va chercher du code sur internet et redémarre le serveur est un
     chemin d'exécution de code à distance. Deux garanties le tiennent, et ce sont
     elles qu'on éprouve ici :

       — l'installation décide, pas l'application. Sans UPDATE_MODE, la fonction
         n'existe pas, et la route le dit au lieu de faire semblant ;
       — le dépôt, la branche et la commande viennent de l'environnement du serveur.
         Une requête ne peut demander qu'« applique ce qui est configuré ». */
  const enTest = process.env.UPDATE_MODE;
  assert.ok(!enTest || enTest === "off",
    "le jeu d'essai tourne sans mise à jour installée — c'est le défaut attendu");

  /* /status répond 200 en disant « non installée » — voir le test dédié. Les ACTIONS,
     elles, doivent être refusées franchement. */
  for(const [methode, chemin] of [["post","/api/update/check"],
                                  ["post","/api/update/apply"]]){
    const r = await request(app)[methode](chemin).set("Authorization", `Bearer ${adminToken}`).send({});
    assert.equal(r.status, 501, `${chemin} doit annoncer que la fonction n'est pas installée`);
    assert.match(r.body.error, /n'a pas été installée/);
    assert.match(r.body.remede, /installation/i);
  }

  /* Et même installée, elle reste hors de portée de tout compte qui n'est pas
     super-utilisateur : administrer des données et remplacer le programme qui les
     traite ne sont pas du même ordre. */
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const r = await request(app).post("/api/update/apply")
    .set("Authorization", `Bearer ${t}`).send({ confirmation:"METTRE A JOUR" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /super/i);
});

test("demande d'accès : fermée par défaut, et le rôle ne se demande pas", async () => {
  /* Un compte ne pouvait naître que de la main d'un administrateur — sûr, mais goulot :
     la personne recrutée lundi attend, et travaille sur un tableur en attendant. La
     forme juste tient en deux verbes : elle DEMANDE, l'administrateur DÉCIDE.

     Encore faut-il que ce ne soit pas une porte dérobée. Trois choses le garantissent,
     et ce sont elles qu'on éprouve ici. */
  db.prepare("DELETE FROM settings WHERE key LIKE 'selfRegistration%'").run();
  db.prepare("DELETE FROM account_request").run();

  /* 1. Fermée par défaut. */
  assert.equal((await request(app).get("/api/requests/options")).body.ouverte, false);
  const fermee = await request(app).post("/api/requests")
    .send({ email:"quelquun@example.org", first_name:"Quelquun" });
  assert.equal(fermee.status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM account_request").get().c, 0);

  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ selfRegistration:true });
  assert.equal((await request(app).get("/api/requests/options")).body.ouverte, true);

  /* 2. Le rôle ne se demande pas. On l'envoie quand même, pour voir. */
  const dep = await request(app).post("/api/requests").send({
    email:"Nouvelle.Recrue@example.org", first_name:"Nouvelle", last_name:"Recrue",
    title:"Agent de suivi", entity:"se", motif:"Prise de poste",
    role:"super", tabs:["settings"], active:true });
  assert.equal(dep.status, 202);
  assert.equal(dep.body.recue, true);
  const dem = db.prepare("SELECT * FROM account_request WHERE email='nouvelle.recrue@example.org'").get();
  assert.ok(dem, "la demande est enregistrée");
  assert.equal(dem.status, "pending");
  assert.ok(!("role" in dem),
    "il n'existe aucune colonne « role » : le rôle ne peut donc pas être demandé");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email='nouvelle.recrue@example.org'").get().c,
    0, "une demande ne crée aucun compte");

  /* 3. La réponse ne dit jamais si l'adresse est connue — sinon ce formulaire serait
     un outil d'énumération de comptes offert à qui passe. */
  const reponses = [];
  for(const email of ["nouvelle.recrue@example.org",   /* déjà en attente */
                      "admin@test.local",              /* compte existant */
                      "inconnu.total@example.org"]){   /* inconnue */
    const r = await request(app).post("/api/requests").send({ email, first_name:"Essai" });
    reponses.push(`${r.status}|${JSON.stringify(r.body)}`);
  }
  assert.equal(new Set(reponses).size, 1,
    "les trois cas doivent être indiscernables de l'extérieur");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM account_request WHERE status='pending'").get().c, 2,
    "un doublon ne crée pas une seconde demande en attente");
});

test("demande d'accès : c'est l'administrateur qui décide, et lui seul", async () => {
  const dem = db.prepare(
    "SELECT * FROM account_request WHERE email='nouvelle.recrue@example.org'").get();
  assert.ok(dem);

  /* Personne d'autre ne voit ni ne décide. */
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/requests").set("Authorization", `Bearer ${t}`)).status, 403);
  assert.equal((await request(app).post(`/api/requests/${dem.id}/approve`)
    .set("Authorization", `Bearer ${t}`).send({ role:"editor" })).status, 403);
  assert.equal((await request(app).get("/api/requests")).status, 401);

  /* « super » ne s'accorde pas par ce chemin : il donne le contrôle total, y compris
     la mise à jour du code. Il se pose à la main, en connaissance de cause. */
  const trop = await request(app).post(`/api/requests/${dem.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`).send({ role:"super" });
  assert.equal(trop.status, 422);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE email=?").get(dem.email).c, 0);

  /* L'acceptation crée le compte avec le rôle CHOISI PAR L'ADMINISTRATEUR, et rend le
     mot de passe initial une seule fois. */
  const ok = await request(app).post(`/api/requests/${dem.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ role:"editor", tabs:["home","suivi"], note:"Confirmé par le chef de bureau" });
  assert.equal(ok.status, 201, ok.body.error);
  assert.ok(ok.body.motDePasse && ok.body.motDePasse.length >= 12);
  const u = db.prepare("SELECT * FROM users WHERE email=?").get(dem.email);
  assert.equal(u.role, "editor", "le rôle est celui de l'administrateur, pas du demandeur");
  assert.equal(u.must_change_pw, 1, "le mot de passe initial devra être changé");
  assert.ok(u.pw_hash && u.pw_hash !== ok.body.motDePasse,
    "seule l'empreinte est conservée, jamais le mot de passe");

  /* Le mot de passe rendu fonctionne réellement — un identifiant qu'on transmet et qui
     n'ouvre rien serait pire que pas d'identifiant du tout. */
  const co = await login(dem.email, ok.body.motDePasse);
  assert.equal(co.status, 200);
  assert.equal(co.body.user.must_change_pw, true);

  /* Et l'on ne rejoue pas une décision. */
  const rejeu = await request(app).post(`/api/requests/${dem.id}/approve`)
    .set("Authorization", `Bearer ${adminToken}`).send({ role:"admin" });
  assert.equal(rejeu.status, 409);

  db.prepare("DELETE FROM users WHERE email LIKE '%example.org'").run();
  db.prepare("DELETE FROM account_request").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'selfRegistration%'").run();
});

test("mise à jour : demander l'état n'est pas une action refusée", async () => {
  /* Un 501 sur /status faisait apparaître un appel en échec dans la console de tout
     administrateur ouvrant l'écran, pour une situation parfaitement normale — la
     fonction n'étant simplement pas installée. Une alerte qui se déclenche quand tout
     va bien est une alerte qu'on cesse de lire. */
  const r = await request(app).get("/api/update/status")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200, "l'état se demande toujours, même fonction fermée");
  assert.equal(r.body.disponible, false);
  assert.ok(r.body.remede, "et l'on dit où cela se règle");

  /* Les ACTIONS, elles, restent refusées. */
  for(const chemin of ["/api/update/check", "/api/update/apply"]){
    const a2 = await request(app).post(chemin).set("Authorization", `Bearer ${adminToken}`).send({});
    assert.equal(a2.status, 501, `${chemin} reste refusé`);
  }
});

test("cloisonnement : visites, distributions, paramètres et journal suivent le bureau", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  assert.equal(st.status, 200);

  /* Chaque collection doit contenir exactement les lignes du bureau — ni plus, ni moins —
     et le jeu d'essai doit comporter des lignes d'ailleurs, sans quoi le test ne prouve rien. */
  /* Le plan de distribution est en outre borné à l'exercice affiché : /state ne sert
     que l'année demandée, faute de quoi on ne pourrait ni relire l'exercice écoulé ni
     préparer le suivant. Le cloisonnement par bureau, lui, ne change pas. */
  const exercice = ` AND year = ${new Date().getFullYear()}`;
  for(const [table, key, label, an] of [["visits","visits","visites",""],
                                    ["pdd","pdd","distributions",exercice],
                                    ["coverage_params","params","paramètres",""]]){
    const sien = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE office_id=?${an}`).get(office.id).c;
    const ailleurs = db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE (office_id IS NULL OR office_id<>?)${an}`).get(office.id).c;
    assert.ok(ailleurs > 0, `le jeu d'essai contient des ${label} d'autres bureaux`);
    assert.equal(st.body[key].length, sien,
      `${label} : le bureau reçoit ses ${sien} ligne(s), et rien des ${ailleurs} autres`);
  }

  assert.ok(st.body.visits.every(v => v.office === office.name),
    "aucune visite d'un autre bureau");
  assert.ok(st.body.pdd.every(p => p.office_id === office.id),
    "aucune ligne de distribution d'un autre bureau");
  assert.ok(st.body.params.every(p => p.office_id === office.id),
    "aucun paramètre de couverture d'un autre bureau");
  assert.ok(st.body.audit.every(a => !a.office || a.office === office.name),
    "aucune entrée de journal d'un autre bureau");
});

test("identité : le nom du bureau accompagne le compte, pour l'affichage et le cloisonnement", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const r = await login("terrain@test.local", "TerrainMotDePasse1");
  assert.equal(r.body.user.office, office.name);
  const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${r.body.token}`);
  assert.equal(me.body.user.office, office.name);
  /* Un compte sans rattachement reste sans bureau : la chaîne vide, jamais « undefined ». */
  const sansBureau = await request(app).get("/api/auth/me")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(sansBureau.body.user.office, "");
});

test("comptes : politique de mot de passe et garde-fous d'administration", async () => {
  const faible = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"faible@test.local", password:"court", first_name:"Faible", role:"viewer" });
  assert.equal(faible.status, 422);

  const me = db.prepare("SELECT id FROM users WHERE email='admin@test.local'").get();
  const auto = await request(app).put(`/api/users/${me.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"admin@test.local", first_name:"Administrateur", role:"viewer", tabs:[], active:true });
  assert.equal(auto.status, 409, "un administrateur ne peut pas se retirer ses droits");

  const suppr = await request(app).delete(`/api/users/${me.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(suppr.status, 409);
});

test("changement de mot de passe : ferme les autres sessions", async () => {
  const first = (await login("lecteur@test.local", "LecteurMotDePasse1")).body.token;
  const second = (await login("lecteur@test.local", "LecteurMotDePasse1")).body.token;
  const ch = await request(app).post("/api/auth/password").set("Authorization", `Bearer ${second}`)
    .send({ current:"LecteurMotDePasse1", next:"NouveauMotDePasse2026" });
  assert.equal(ch.status, 200);
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${first}`)).status, 401);
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${second}`)).status, 200);
});

test("déconnexion : le jeton devient inutilisable", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  assert.equal((await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${t}`)).status, 200);
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).status, 401);
});

test("cartographie : points filtrés, bornes calculées, coordonnées valides", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).get("/api/analytics/map?status=Active").set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.count > 0);
  assert.ok(r.body.sites.every(s => Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180));
  assert.ok(r.body.bounds.minLat <= r.body.bounds.maxLat);
  assert.ok(r.body.sites.every(s => s.status === "Active"));
});

test("couverture : agrégation mensuelle cohérente avec la base", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).get("/api/analytics/coverage").set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  const total = r.body.rows.reduce((s, x) => s + x.done, 0);
  const direct = db.prepare("SELECT COALESCE(SUM(done),0) s FROM site_months WHERE year=?")
    .get(r.body.year).s;
  assert.equal(total, direct);
});

test("référentiel : l'import construit l'arbre complet et crée un millésime", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* 500 fokontany répartis sur 20 communes d'un même district. */
  const rows = Array.from({ length: 500 }, (_, i) => ({
    adm0:"Madagascar", adm1:"Androy", adm2:"Ambovombe-Androy",
    adm3:`Commune ${i%20}`, adm4:`Fokontany ${i}`, pcode:`MG${100000+i}`,
    lat:-25+(i%100)/100, lon:45+(i%100)/100 }));
  const r = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Test import", rows });
  assert.equal(r.status, 200);
  /* Les niveaux supérieurs sont déduits et dédoublonnés : 1 pays + 1 région
     + 1 district + 20 communes + 500 fokontany. */
  assert.deepEqual(r.body.counts, { adm0:1, adm1:1, adm2:1, adm3:20, adm4:500 });
  assert.equal(r.body.imported, 523);
  assert.equal(r.body.rejected, 0);

  /* Cascade : les enfants d'une unité se demandent par le code du parent. */
  const top = await request(app).get("/api/geo/levels").set("Authorization", `Bearer ${t}`);
  assert.equal(top.body.rows.length, 1, "un seul niveau adm1 dans ce jeu");
  const androy = top.body.rows[0];
  assert.equal(androy.name, "Androy");

  const districts = await request(app).get(`/api/geo/levels?parent=${androy.pcode}`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(districts.body.rows.length, 1);
  const communes = await request(app).get(`/api/geo/levels?parent=${districts.body.rows[0].pcode}`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(communes.body.rows.length, 20);

  /* Le répertoire est paginé : les 18 000 fokontany ne partent jamais d'un bloc. */
  const page = await request(app).get("/api/geo?level=adm4&limit=50")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(page.body.total, 500);
  assert.equal(page.body.rows.length, 50);
  /* Chaque fokontany porte ses ancêtres, résolus par la chaîne des parents. */
  const f = page.body.rows[0];
  assert.equal(f.adm1, "Androy");
  assert.equal(f.adm2, "Ambovombe-Androy");
  assert.ok(f.adm3.startsWith("Commune "));

  /* Le chemin matérialisé permet de descendre depuis n'importe quel niveau. */
  const sous = await request(app).get(`/api/geo?parent=${communes.body.rows[0].pcode}&level=adm4`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(sous.body.total, 25, "500 fokontany / 20 communes");
});

test("référentiel : millésimes successifs, un seul courant à la fois", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const before = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${t}`);
  const nb = before.body.rows.length;
  assert.ok(nb >= 1);
  assert.equal(before.body.rows.filter(v => v.current).length, 1, "un seul millésime courant");

  await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Millésime suivant", rows:[
      { adm1:"Atsimo-Andrefana", adm2:"Toliara II", adm3:"Belalanda", adm4:"Belalanda" }] });
  const after = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${t}`);
  assert.equal(after.body.rows.length, nb+1);
  assert.equal(after.body.rows.filter(v => v.current).length, 1);
  assert.equal(after.body.rows.find(v => v.current).label, "Millésime suivant");

  /* Revenir à un millésime antérieur ne perd rien : l'ancien est toujours là. */
  const ancien = after.body.rows.find(v => v.label === "Test import");
  const sw = await request(app).put(`/api/geo/versions/${ancien.id}/current`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(sw.status, 200);
  const now = await request(app).get("/api/geo?level=adm4&limit=1").set("Authorization", `Bearer ${t}`);
  assert.equal(now.body.total, 500, "le référentiel précédent est revenu");
});

test("référentiel : nom mal orthographié rapproché, ligne trouée écartée", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Test rapprochement", rows:[
      { adm1:"Androy", adm2:"Ambovombe-Androy", adm3:"Antanimora Sud", adm4:"A" },
      /* accents, casse et tiret différents : doit rejoindre la même commune */
      { adm1:"ANDROY", adm2:"Ambovombe Androy", adm3:"ANTANIMORA-SUD", adm4:"B" },
      /* niveau intermédiaire manquant : écartée plutôt que mal rattachée */
      { adm1:"Anosy", adm2:"", adm3:"Tolagnaro", adm4:"C" },
    ]});
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.adm1, 1, "une seule région malgré les variantes d'écriture");
  assert.equal(r.body.counts.adm3, 1, "une seule commune malgré les variantes d'écriture");
  assert.equal(r.body.counts.adm4, 2);
  assert.equal(r.body.rejected, 1, "la ligne trouée est écartée");
});

test("import de localités : hors plage géographique rejeté", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ mode:"merge", rows:[{ adm1:"X", lat:999, lon:0 }] });
  assert.equal(r.status, 422);
});

test("injection SQL : la chaîne est traitée comme une donnée, pas comme du code", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).get("/api/sites?search=' OR 1=1; DROP TABLE sites;--")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 0);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM sites").get().c > 100, "la table est intacte");
});

test("charge utile démesurée : rejetée sans faire tomber le serveur", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const rows = Array.from({ length: 70000 }, () => ({ name:"x", blocks:[], intro:"" }));
  const r = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`).send({ rows });
  assert.equal(r.status, 422);
});

test("journal d'audit : les actions sensibles laissent une trace", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).get("/api/audit?limit=200").set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  const kinds = new Set(r.body.rows.map(x => x.action));
  for(const a of ["login","create","delete","bulk"]) assert.ok(kinds.has(a), `action ${a} tracée`);
  assert.ok(!/MotDePasseTest2026/.test(JSON.stringify(r.body)));
});

test("route inconnue : anonyme refusé, authentifié informé", async () => {
  /* Sans jeton, l'API ne dit pas si la route existe : elle exige d'abord l'authentification. */
  const anon = await request(app).get("/api/nexistepas");
  assert.equal(anon.status, 401);
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const auth = await request(app).get("/api/nexistepas").set("Authorization", `Bearer ${t}`);
  assert.equal(auth.status, 404);
  assert.equal(auth.body.error, "ressource introuvable");
  assert.ok(!/at |\.js:/.test(JSON.stringify(auth.body)), "aucune trace interne ne fuit");
});

test("rattachement : un site pointe vers une unité, ses libellés en descendent", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* On repart d'un référentiel connu. */
  await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Test rattachement", rows:[
      { adm1:"Androy", adm2:"Ambovombe-Androy", adm3:"Ambovombe", adm4:"Ambovombe Centre",
        pcode:"MG81101001001", lat:-25.173, lon:46.087 },
      { adm1:"Androy", adm2:"Ambovombe-Androy", adm3:"Ambovombe", adm4:"Antanandava", pcode:"MG81101001002" },
      { adm1:"Androy", adm2:"Tsihombe", adm3:"Tsihombe", adm4:"Tsihombe Centre", pcode:"MG81103001001" },
    ]});

  /* Les libellés envoyés par le client sont faux : le serveur les remplace par
     ceux du référentiel, dérivés du rattachement. */
  const r = await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"LNK-001", name:"CSB II de contrôle", geo_pcode:"MG81101001001",
            adm1:"Saisie erronée", adm2:"Saisie erronée", adm3:"Saisie erronée", adm4:"Saisie erronée" });
  assert.equal(r.status, 201);
  assert.equal(r.body.site.adm1, "Androy");
  assert.equal(r.body.site.adm2, "Ambovombe-Androy");
  assert.equal(r.body.site.adm3, "Ambovombe");
  assert.equal(r.body.site.adm4, "Ambovombe Centre");
  /* Sans coordonnées propres, celles du référentiel servent de repli. */
  assert.equal(r.body.site.lat, -25.173);

  /* Les coordonnées propres au site priment : une école n'est pas au centroïde. */
  const r2 = await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"LNK-002", name:"École précise", geo_pcode:"MG81101001001", lat:-25.2, lon:46.1 });
  assert.equal(r2.body.site.lat, -25.2);

  /* Un p-code inconnu n'écrase rien : mieux vaut garder les libellés existants. */
  const r3 = await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"LNK-003", name:"Hors référentiel", geo_pcode:"INEXISTANT", adm1:"Conservé" });
  assert.equal(r3.body.site.adm1, "Conservé");
});

test("couverture : les unités sans aucun site sont identifiées", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const c = await request(app).get("/api/geo/coverage?level=adm4").set("Authorization", `Bearer ${t}`);
  assert.equal(c.status, 200);
  assert.equal(c.body.total, 3, "trois fokontany dans ce référentiel");
  /* Deux sites sont sur Ambovombe Centre, aucun sur les deux autres. */
  const centre = c.body.rows.find(x => x.name === "Ambovombe Centre");
  assert.equal(centre.sites, 2);
  assert.equal(c.body.covered, 1, "un seul fokontany couvert");
  assert.equal(c.body.rows.filter(x => x.sites === 0).length, 2, "deux trous de couverture");
  /* Les ancêtres accompagnent chaque unité. */
  assert.equal(centre.adm3, "Ambovombe");
  assert.equal(centre.adm1, "Androy");

  /* Un site rattaché à un fokontany compte aussi pour sa commune et sa région. */
  const parCommune = await request(app).get("/api/geo/coverage?level=adm3")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(parCommune.body.rows.find(x => x.name === "Ambovombe").sites, 2);
  assert.equal(parCommune.body.rows.find(x => x.name === "Tsihombe").sites, 0);

  /* Un site sans rattachement est compté à part plutôt qu'omis en silence des totaux. */
  await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"ORPHELIN-1", name:"Site sans rattachement" });
  const c2 = await request(app).get("/api/geo/coverage?level=adm4").set("Authorization", `Bearer ${t}`);
  assert.ok(c2.body.sitesUnlinked > 0, "le site sans rattachement est signalé");
});


/* Les tests précédents ont chargé d'autres millésimes ; le caseload du jeu d'essai
   est rattaché à celui du seed. On le réactive avant de mesurer quoi que ce soit. */
async function activerMillesimeDuSeed(token){
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${token}`);
  const seed = v.body.rows.find(x => x.label === "Jeu de démonstration");
  assert.ok(seed, "le millésime du jeu de démonstration existe");
  if(!seed.current)
    await request(app).put(`/api/geo/versions/${seed.id}/current`)
      .set("Authorization", `Bearer ${token}`);
}

test("population et ciblage : les trois taux se calculent par unité et par période", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const year = st.body.year;

  const c = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(c.status, 200);
  assert.ok(c.body.rows.length > 0, "des communes sont renseignées");

  const r = c.body.rows.find(x => x.population > 0 && x.planned > 0);
  assert.ok(r, "au moins une commune a population et distribution");
  assert.equal(r.tauxCiblage,     Math.round((r.targeted / r.population) * 1000) / 10);
  assert.equal(r.tauxCouverture,  Math.round((r.planned  / r.targeted)   * 1000) / 10);
  assert.equal(r.tauxRealisation, Math.round((r.actual   / r.planned)    * 1000) / 10);

  /* Le total « toutes activités » est dédoublonné : il est inférieur à la somme
     des activités, sinon une personne ciblée deux fois serait comptée deux fois. */
  const tags = await request(app).get(`/api/caseload/tags?year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  assert.ok(tags.body.rows.length >= 2, "plusieurs activités portent un ciblage");
  const sommeActivites = tags.body.rows.reduce((s, x) => s + x.targeted, 0);
  assert.ok(c.body.totals.targeted < sommeActivites,
    `total dédoublonné (${c.body.totals.targeted}) < somme des activités (${sommeActivites})`);
  assert.ok(/non de la somme des activités/.test(c.body.avertissement),
    "la réponse avertit que le total n'est pas la somme des activités");
});

test("population et ciblage : la saisie par commune remonte aux niveaux supérieurs", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const year = st.body.year;
  const parCommune = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  const parRegion  = await request(app).get(`/api/caseload?level=adm1&year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  assert.ok(parRegion.body.rows.length < parCommune.body.rows.length);
  /* L'agrégation ne perd ni n'invente rien : les totaux coïncident. */
  assert.equal(parRegion.body.totals.population, parCommune.body.totals.population);
  assert.equal(parRegion.body.totals.targeted,   parCommune.body.totals.targeted);
  assert.ok(parRegion.body.rows.some(r => r.population > 0), "les régions portent une population");
});

test("population et ciblage : écriture par ligne, sans effacer ce qui n'est pas envoyé", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const year = st.body.year;
  const avant = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  const cible = avant.body.rows.find(x => x.population > 0);

  const w = await request(app).put("/api/caseload").set("Authorization", `Bearer ${t}`)
    .send({ rows:[{ geo_pcode:cible.pcode, level:"adm3", year, activity_tag:"",
                    population: cible.population, households: cible.households,
                    targeted: 4242, source:"test" }] });
  assert.equal(w.status, 200);
  assert.equal(w.body.modifies, 1, "la ligne existante est mise à jour, pas dupliquée");

  const apres = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(apres.body.rows.find(x => x.pcode === cible.pcode).targeted, 4242);
  /* Les autres communes n'ont pas été touchées : c'est toute la différence avec
     une synchronisation de collection entière. */
  assert.equal(apres.body.rows.length, avant.body.rows.length);
  const autre = avant.body.rows.find(x => x.pcode !== cible.pcode && x.population > 0);
  assert.equal(apres.body.rows.find(x => x.pcode === autre.pcode).targeted, autre.targeted);
});

test("population et ciblage : les valeurs incohérentes sont rejetées avec leur motif", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const cible = (await request(app).get(`/api/caseload?level=adm3&year=${st.body.year}`)
    .set("Authorization", `Bearer ${t}`)).body.rows[0];

  const r = await request(app).put("/api/caseload").set("Authorization", `Bearer ${t}`)
    .send({ rows:[
      { geo_pcode:"PCODE_INEXISTANT", year:st.body.year, population:100, targeted:10 },
      { geo_pcode:cible.pcode, year:st.body.year, population:1000, targeted:9999 },
    ]});
  assert.equal(r.status, 200);
  assert.equal(r.body.rejetes, 2);
  assert.ok(/absent du référentiel/.test(r.body.rejets[0].message));
  assert.ok(/9999 ciblés pour 1000 habitants/.test(r.body.rejets[1].message));
  /* Un rejet partiel n'annule pas le reste : ici tout est rejeté, rien n'est écrit. */
  assert.equal(r.body.crees + r.body.modifies, 0);
});

/* ── Import par fichier ───────────────────────────────────────────────
   Le pipeline en trois temps : modèle pré-rempli, prévisualisation qui n'écrit
   rien, puis confirmation en une transaction. */
const ExcelJS = (await import("exceljs")).default;

async function modele(token, kind = "caseload", year = new Date().getFullYear()){
  const r = await request(app).get(`/api/import/${kind}/template?year=${year}`)
    .set("Authorization", `Bearer ${token}`).buffer(true)
    .parse((res, cb) => { const d = []; res.on("data", c => d.push(c));
                          res.on("end", () => cb(null, Buffer.concat(d))); });
  assert.equal(r.status, 200, "le modèle se télécharge");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body);
  return wb;
}
const colonnes = (ws) => { const c = {}; ws.getRow(1).eachCell((cell,i)=>{ c[String(cell.value)] = i; }); return c; };
async function televerser(token, wb, kind = "caseload"){
  const buf = await wb.xlsx.writeBuffer();
  return request(app).post(`/api/import/${kind}`).set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(buf), "saisie.xlsx");
}

test("import : le modèle est pré-rempli, ses clés verrouillées et son type identifié", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const wb = await modele(t);
  const ws = wb.getWorksheet("Saisie");
  assert.ok(ws, "la feuille de saisie existe");
  assert.ok(ws.rowCount > 2, "des lignes sont pré-remplies");
  assert.ok(ws.sheetProtection, "la feuille est protégée pour préserver les clés");

  const c = colonnes(ws);
  for(const h of ["P-code","Commune","Année","Activité","Population","Personnes ciblées"])
    assert.ok(c[h], `la colonne « ${h} » est présente`);

  /* La commune est pré-remplie : l'utilisateur remplit des cases, il ne saisit pas de clés. */
  const l3 = ws.getRow(3);
  assert.ok(String(l3.getCell(c["P-code"]).value).length > 3, "le p-code est rempli");
  assert.ok(String(l3.getCell(c["Commune"]).value).length > 1, "la commune est rappelée");
  /* Les cellules de mesure sont explicitement déverrouillées. */
  assert.equal(l3.getCell(c["Population"]).protection?.locked, false);

  /* Feuille d'identification, masquée : c'est elle qui permet de refuser un modèle périmé. */
  const meta = wb.getWorksheet("_mems");
  assert.equal(meta.state, "veryHidden");
  const kv = {}; meta.eachRow(r => { kv[String(r.getCell(1).value)] = String(r.getCell(2).value); });
  assert.equal(kv.kind, "caseload");
  assert.ok(kv.geoVersion, "le millésime du référentiel est inscrit");
});

test("import : la prévisualisation n'écrit rien, la confirmation applique", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const year = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body.year;
  const wb = await modele(t, "caseload", year);
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);

  /* On modifie une seule ligne de total, avec une valeur reconnaissable. */
  let cible = null;
  for(let n = 3; n <= ws.rowCount; n++){
    const row = ws.getRow(n);
    if(String(row.getCell(c["Activité"]).value ?? "") !== "") continue;
    row.getCell(c["Population"]).value = 123456;
    row.getCell(c["Personnes ciblées"]).value = 12345;
    row.getCell(c["Source"]).value = "test import";
    cible = String(row.getCell(c["P-code"]).value);
    break;
  }
  assert.ok(cible, "une ligne de total a été trouvée");

  const avant = (await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`)).body.rows.find(x => x.pcode === cible);

  const prev = await televerser(t, wb);
  assert.equal(prev.status, 200);
  assert.ok(prev.body.batch, "un lot est créé");
  assert.equal(prev.body.resume.modifies, 1, "une seule ligne change");
  /* Les lignes pré-remplies non renseignées ne créent pas d'enregistrements à zéro. */
  assert.ok(prev.body.resume.vides > 0, "les lignes vides sont écartées, pas créées");
  assert.ok(/Rien n'a encore été enregistré/.test(prev.body.message));

  /* Le point capital : la base est inchangée avant confirmation. */
  const pendant = (await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`)).body.rows.find(x => x.pcode === cible);
  assert.equal(pendant.population, avant.population, "rien n'est écrit à la prévisualisation");

  const ok = await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.modifies, 1);

  const apres = (await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`)).body.rows.find(x => x.pcode === cible);
  assert.equal(apres.population, 123456);
  assert.equal(apres.targeted, 12345);

  /* Rejouer le même lot est refusé : l'application est idempotente. */
  const rejoue = await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${t}`);
  assert.equal(rejoue.status, 409);

  /* Réimporter le même fichier ne change plus rien : la réconciliation est par clé. */
  const encore = await televerser(t, wb);
  assert.equal(encore.body.resume.crees, 0);
  assert.equal(encore.body.resume.modifies, 0);
});

test("import : les lignes fautives sont rejetées avec leur motif, sans bloquer les bonnes", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const year = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body.year;
  const wb = await modele(t, "caseload", year);
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);

  /* Une ligne valable, pour vérifier qu'un rejet partiel ne bloque pas le reste. */
  const bonne = ws.getRow(3);
  bonne.getCell(c["Activité"]).value = "";
  bonne.getCell(c["Population"]).value = 40000;
  bonne.getCell(c["Personnes ciblées"]).value = 9000;

  /* Plus de ciblés que d'habitants. */
  const l4 = ws.getRow(4);
  l4.getCell(c["Population"]).value = 1000;
  l4.getCell(c["Personnes ciblées"]).value = 9999;
  /* P-code inconnu. */
  const inconnu = ws.addRow([]);
  inconnu.getCell(c["P-code"]).value = "PCODE_QUI_NEXISTE_PAS";
  inconnu.getCell(c["Année"]).value = year;
  inconnu.getCell(c["Population"]).value = 500;
  /* Doublon de clé dans le fichier. */
  const doublon = ws.addRow([]);
  doublon.getCell(c["P-code"]).value = String(bonne.getCell(c["P-code"]).value);
  doublon.getCell(c["Année"]).value = year;
  doublon.getCell(c["Activité"]).value = "";
  doublon.getCell(c["Population"]).value = 7;

  const prev = await televerser(t, wb);
  assert.equal(prev.status, 200);
  assert.equal(prev.body.resume.rejetes, 3, "trois lignes rejetées");
  const motifs = prev.body.rejets.map(x => x.message).join(" | ");
  /* Les milliers sont séparés par une espace insécable étroite, pas une espace ordinaire. */
  assert.ok(/9\s?999 ciblés pour 1\s?000 habitants/.test(motifs), motifs);
  assert.ok(/absent du référentiel/.test(motifs), motifs);
  assert.ok(/doublon dans le fichier/.test(motifs), motifs);
  /* Le rejet est partiel : la ligne valable reste applicable. */
  assert.ok(prev.body.resume.modifies + prev.body.resume.crees >= 1,
    "les lignes valables restent applicables malgré les rejets — résumé : "
    + JSON.stringify(prev.body.resume));
});

test("import : un modèle d'un autre type ou d'un autre millésime est refusé", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const wb = await modele(t, "caseload");

  /* Téléversé comme plan de distribution : refusé sur l'identification. */
  const mauvaisType = await televerser(t, wb, "pdd");
  assert.equal(mauvaisType.status, 422);
  assert.ok(/modèle « caseload »/.test(mauvaisType.body.error), mauvaisType.body.error);

  /* Après changement de millésime, les p-codes ont pu changer : le modèle est périmé. */
  const imp = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Millésime pour test de péremption", rows:[
      { adm1:"Androy", adm2:"Ambovombe-Androy", adm3:"Ambovombe", adm4:"Centre" }] });
  assert.equal(imp.status, 200);
  const perime = await televerser(t, wb);
  assert.equal(perime.status, 409);
  assert.ok(/autre millésime/.test(perime.body.error), perime.body.error);
  await activerMillesimeDuSeed(t);
});

test("import : le périmètre du bureau est appliqué ligne à ligne", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  /* L'éditeur de terrain crée son propre modèle : il ne contient que son périmètre. */
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const sien = await modele(te);
  const wsSien = sien.getWorksheet("Saisie");
  const wbAdmin = await modele(t);
  assert.ok(wsSien.rowCount < wbAdmin.getWorksheet("Saisie").rowCount,
    "le modèle de l'éditeur est plus étroit que celui de l'administrateur");

  /* S'il glisse dans son fichier une unité hors de son périmètre, elle est rejetée. */
  const cAdmin = colonnes(wbAdmin.getWorksheet("Saisie"));
  const siens = new Set();
  const cSien = colonnes(wsSien);
  wsSien.eachRow((r,n) => { if(n>2) siens.add(String(r.getCell(cSien["P-code"]).value)); });
  let etranger = null;
  wbAdmin.getWorksheet("Saisie").eachRow((r,n) => {
    if(n<=2 || etranger) return;
    const p = String(r.getCell(cAdmin["P-code"]).value);
    if(!siens.has(p)) etranger = p;
  });
  assert.ok(etranger, "une unité hors périmètre existe dans le jeu d'essai");

  const intrus = wsSien.addRow([]);
  intrus.getCell(cSien["P-code"]).value = etranger;
  intrus.getCell(cSien["Année"]).value = new Date().getFullYear();
  intrus.getCell(cSien["Population"]).value = 12345;
  const prev = await televerser(te, sien);
  assert.equal(prev.status, 200);
  assert.ok(prev.body.rejets.some(x => /hors du périmètre/.test(x.message || "")),
    "l'unité d'un autre bureau est rejetée : un fichier est une entrée utilisateur comme une autre");
});

/* ── Concurrence ──────────────────────────────────────────────────────
   Deux pertes de données silencieuses existaient. Ces tests les verrouillent. */

test("concurrence : enregistrer n'efface plus la ligne ajoutée par un collègue", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;

  /* Bureau A charge l'état. */
  const vueDeA = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`))
    .body.reportTemplates.map(x => ({ ...x }));

  /* Bureau B ajoute une ligne, que A n'a jamais reçue. Il n'envoie QUE sa ligne :
     depuis que les suppressions sont explicites, un corps partiel est légitime. */
  const ajoutB = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ name:"Modèle du bureau B", blocks:["kpi"], intro:"ajouté par B" }] });
  assert.equal(ajoutB.body.created, 1);
  const apresB = db.prepare("SELECT COUNT(*) c FROM report_templates").get().c;

  /* A enregistre sa propre modification, à partir de sa vue périmée.
     Avant, la ligne de B disparaissait ici même, sans aucun signal. */
  const modifA = vueDeA.map((x,i) => i === 0 ? { ...x, intro:"modifié par A" } : x);
  const ecritureA = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`).send({ rows: modifA });
  assert.equal(ecritureA.status, 200);
  assert.equal(ecritureA.body.removed, 0, "A ne supprime rien : il n'a rien retiré");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM report_templates").get().c, apresB,
    "la ligne du bureau B a survécu à l'enregistrement du bureau A");
  assert.ok(db.prepare("SELECT 1 FROM report_templates WHERE name=?").get("Modèle du bureau B"),
    "la ligne du bureau B est toujours là, nommément");
});

test("concurrence : modifier la même ligne à deux est refusé, pas écrasé", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const etat = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  const cible = etat.indicators[0];
  assert.ok(cible.rev, "la révision de ligne est renvoyée par /state");

  /* A et B ont tous deux lu la révision `cible.rev`. */
  const ligne = (nom) => ({ id:cible.key, rev:cible.rev, code:cible.id, name:nom,
    basket:cible.basket, unit:cible.unit, target:cible.target,
    direction:cible.dir, method:cible.method, frequency:cible.freq });

  /* B enregistre le premier : accepté, la révision passe à rev+1. */
  const premier = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [ligne("Intitulé posé par B")] });
  assert.equal(premier.status, 200);
  assert.equal(db.prepare("SELECT rev FROM indicators WHERE id=?").get(cible.key).rev,
    cible.rev + 1, "la révision est incrémentée");

  /* A enregistre ensuite, avec la révision qu'il avait lue : refusé. */
  const second = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [ligne("Intitulé posé par A")] });
  assert.equal(second.status, 409, "l'écriture par-dessus une révision plus récente est refusée");
  assert.ok(/modifiée.*pendant votre saisie/.test(second.body.error), second.body.error);
  assert.equal(second.body.conflits[0].id, cible.key);
  assert.equal(second.body.conflits[0].revEnvoyee, cible.rev);
  assert.equal(second.body.conflits[0].revCourante, cible.rev + 1);
  /* Le serveur rend la valeur courante : l'interface peut montrer ce qui a changé. */
  assert.equal(second.body.courant[0].name, "Intitulé posé par B");

  /* Le travail de B est intact : rien n'a été écrasé. */
  assert.equal(db.prepare("SELECT name FROM indicators WHERE id=?").get(cible.key).name,
    "Intitulé posé par B");

  /* Avec la révision à jour, A peut enregistrer. */
  const rejoue = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ ...ligne("Intitulé final de A"), rev: cible.rev + 1 }] });
  assert.equal(rejoue.status, 200);
  assert.equal(db.prepare("SELECT name FROM indicators WHERE id=?").get(cible.key).name,
    "Intitulé final de A");
});

test("concurrence : deux corrections d'affilée sur la même ligne passent", async () => {
  /* Le verrou optimiste n'a de sens que si le serveur rend AUSSI le nouveau jeton.
     Sans cela, le client gardait la révision lue, le serveur venait de l'incrémenter,
     et le deuxième enregistrement d'affilée entrait en conflit avec sa propre écriture :
     « cette collection a été modifiée par Administrateur pendant votre saisie » —
     Administrateur étant soi-même. Corriger deux fois de suite était impossible sans
     recharger la page, et le message accusait un collègue.

     C'est le geste le plus banal de tous : on saisit, on se relit, on corrige. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const etat = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  const cible = etat.indicators[0];
  const ligne = (nom, rev) => ({ id:cible.key, rev, code:cible.id, name:nom,
    basket:cible.basket, unit:cible.unit, target:cible.target,
    direction:cible.dir, method:cible.method, frequency:cible.freq });

  const un = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`).send({ rows: [ligne("Première saisie", cible.rev)] });
  assert.equal(un.status, 200);
  assert.equal(un.body.revisions[cible.key], cible.rev + 1,
    "la réponse porte la révision telle qu'elle est après écriture");

  /* Le client rejoue avec ce que le serveur vient de lui rendre — pas avec ce qu'il
     avait lu. C'est exactement ce que fait la file d'écriture de l'interface. */
  const deux = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [ligne("Correction juste après", un.body.revisions[cible.key])] });
  assert.equal(deux.status, 200, deux.body.error);
  assert.equal(db.prepare("SELECT name FROM indicators WHERE id=?").get(cible.key).name,
    "Correction juste après");
  assert.equal(deux.body.revisions[cible.key], cible.rev + 2);
});

test("concurrence : une ligne créée annonce sa révision de départ", async () => {
  /* Une ligne neuve naît à la révision 1. Sans la rendre, la première correction qui
     suit sa création serait refusée — le cas de quiconque ajoute une ligne puis
     s'aperçoit d'une faute de frappe. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const id = "rt-neuf-" + Date.now();
  const cree = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ id, name:"Modèle neuf", blocks:["couverture"], intro:"" }] });
  assert.equal(cree.status, 200);
  assert.equal(cree.body.created, 1);
  assert.equal(cree.body.revisions[id], 1);

  const corrige = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ id, rev: cree.body.revisions[id], name:"Modèle neuf corrigé",
                     blocks:["couverture"], intro:"" }] });
  assert.equal(corrige.status, 200, corrige.body.error);
  assert.equal(corrige.body.revisions[id], 2);
  await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${t}`).send({ rows: [], deletes: [id] });
});

test("concurrence : un client qui n'envoie pas de révision reste accepté", async () => {
  /* Compatibilité : la révision est facultative. Sans elle, on retombe sur le
     comportement « dernier écrivain gagne », mais sans suppression implicite. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const ind = db.prepare("SELECT * FROM indicators LIMIT 1").get();
  const r = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ id:ind.id, code:ind.code, name:"Sans révision", unit:ind.unit,
                     target:ind.target, direction:ind.direction }] });
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT name FROM indicators WHERE id=?").get(ind.id).name, "Sans révision");
});

test("concurrence : un site modifié à deux mains est refusé avec sa version courante", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const cree = await request(app).post("/api/sites").set("Authorization", `Bearer ${t}`)
    .send({ code:"CONC-001", name:"Site témoin", beneficiaries:100 });
  assert.equal(cree.status, 201);
  const site = cree.body.site;
  assert.equal(site.rev, 1);

  const premier = await request(app).put(`/api/sites/${site.id}`).set("Authorization", `Bearer ${t}`)
    .send({ code:"CONC-001", name:"Nommé par B", rev:1 });
  assert.equal(premier.status, 200);
  assert.equal(premier.body.site.rev, 2, "la révision du site est incrémentée");

  const second = await request(app).put(`/api/sites/${site.id}`).set("Authorization", `Bearer ${t}`)
    .send({ code:"CONC-001", name:"Nommé par A", rev:1 });
  assert.equal(second.status, 409);
  assert.equal(second.body.revCourante, 2);
  assert.equal(second.body.courant.name, "Nommé par B", "la valeur courante accompagne le refus");
  assert.equal(db.prepare("SELECT name FROM sites WHERE id=?").get(site.id).name, "Nommé par B");

  await request(app).delete(`/api/sites/${site.id}`).set("Authorization", `Bearer ${t}`);
});

/* ── Périmètre géographique déclaré ───────────────────────────────────
   Le rôle dit ce qu'on peut faire, le périmètre dit où. Deux axes distincts. */

test("périmètre : déclaré au district, il donne accès à ses communes", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);

  const sc = await request(app).get("/api/geo/scope").set("Authorization", `Bearer ${t}`);
  assert.equal(sc.status, 200);
  const ambovombe = sc.body.rows.find(o => /Ambovombe/.test(o.name));
  assert.ok(ambovombe, "le bureau d'Ambovombe est listé");
  assert.equal(ambovombe.source, "déclaré", "son périmètre est déclaré, non déduit");
  assert.ok(ambovombe.units.length >= 1, "des unités lui sont attribuées");
  assert.ok(ambovombe.units.every(u => u.level === "adm2"), "attribuées au niveau district");
  /* Déclarer un district donne accès à ses communes : le périmètre descend. */
  assert.ok(ambovombe.communes > ambovombe.units.length,
    `${ambovombe.units.length} district(s) déclaré(s) → ${ambovombe.communes} commune(s) couverte(s)`);

  /* Le bureau central n'a pas de périmètre : il voit tout par son rôle. */
  const hq = sc.body.rows.find(o => o.kind === "hq");
  assert.equal(hq.units.length, 0);
});

test("périmètre : il borne réellement ce qu'un compte de terrain peut lire", async () => {
  const ta = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(ta);
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const year = (await request(app).get("/api/state").set("Authorization", `Bearer ${ta}`)).body.year;

  const vueAdmin = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${ta}`);
  const vueTerrain = await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${te}`);
  assert.ok(vueTerrain.body.rows.length > 0, "le compte de terrain voit ses communes");
  assert.ok(vueTerrain.body.rows.length < vueAdmin.body.rows.length,
    `terrain ${vueTerrain.body.rows.length} communes < admin ${vueAdmin.body.rows.length}`);

  /* Le périmètre est le même pour la couverture géographique : une seule définition. */
  const couv = await request(app).get("/api/geo/coverage?level=adm3")
    .set("Authorization", `Bearer ${te}`);
  assert.equal(couv.status, 200);
});

test("périmètre : le modifier change immédiatement ce qui est accessible", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();

  const avant = (await request(app).get("/api/geo/scope").set("Authorization", `Bearer ${t}`))
    .body.rows.find(o => o.office_id === office.id);

  /* On réduit le périmètre à une seule commune. */
  const uneCommune = db.prepare(`SELECT pcode FROM geo_unit
    WHERE version_id=(SELECT id FROM geo_version WHERE is_current=1) AND level='adm3' LIMIT 1`).get();
  const maj = await request(app).put(`/api/geo/scope/${office.id}`)
    .set("Authorization", `Bearer ${t}`).send({ pcodes:[uneCommune.pcode] });
  assert.equal(maj.status, 200);
  assert.equal(maj.body.communes, 1, "une commune déclarée, une commune couverte");
  assert.ok(maj.body.communes < avant.communes, "le périmètre s'est réduit");

  /* L'effet est immédiat sur le modèle d'import du compte concerné. */
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const wb = await modele(te);
  const pcodes = new Set();
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);
  ws.eachRow((r,n) => { if(n>2) pcodes.add(String(r.getCell(c["P-code"]).value)); });
  assert.equal(pcodes.size, 1, "le modèle ne contient plus que la commune déclarée");
  assert.ok(pcodes.has(uneCommune.pcode));

  /* On rétablit le périmètre d'origine. */
  await request(app).put(`/api/geo/scope/${office.id}`).set("Authorization", `Bearer ${t}`)
    .send({ pcodes: avant.units.map(u => u.pcode) });
});

test("périmètre : sans déclaration, il reste déduit des données — pas d'accès perdu", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const office = db.prepare(`SELECT o.id, o.name FROM offices o
    WHERE o.kind='field' AND EXISTS (SELECT 1 FROM sites WHERE office_id=o.id)
    ORDER BY o.name LIMIT 1`).get();
  const declare = db.prepare("SELECT geo_pcode FROM office_scope WHERE office_id=?").all(office.id);

  /* On efface la déclaration : le repli doit prendre le relais, sinon activer la
     migration priverait d'un coup tous les comptes de terrain de leur accès. */
  db.prepare("DELETE FROM office_scope WHERE office_id=?").run(office.id);
  const sansDeclaration = (await request(app).get("/api/geo/scope")
    .set("Authorization", `Bearer ${t}`)).body.rows.find(o => o.office_id === office.id);
  assert.equal(sansDeclaration.source, "déduit");
  assert.ok(sansDeclaration.communes > 0, "le périmètre déduit n'est pas vide");

  /* On rétablit. */
  const ins = db.prepare("INSERT INTO office_scope (office_id,geo_pcode) VALUES (?,?)");
  for(const d of declare) ins.run(office.id, d.geo_pcode);
  const retabli = (await request(app).get("/api/geo/scope")
    .set("Authorization", `Bearer ${t}`)).body.rows.find(o => o.office_id === office.id);
  assert.equal(retabli.source, "déclaré");
});

test("périmètre : une unité absente du référentiel est refusée", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const r = await request(app).put(`/api/geo/scope/${office.id}`)
    .set("Authorization", `Bearer ${t}`).send({ pcodes:["PCODE_QUI_NEXISTE_PAS"] });
  assert.equal(r.status, 422);
  assert.ok(/absentes du référentiel/.test(r.body.error), r.body.error);
  /* Rien n'a été écrit : le périmètre précédent est intact. */
  assert.ok(db.prepare("SELECT COUNT(*) c FROM office_scope WHERE office_id=?").get(office.id).c > 0);
});

test("périmètre : sa modification est réservée aux administrateurs et tracée", async () => {
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const refus = await request(app).put(`/api/geo/scope/${office.id}`)
    .set("Authorization", `Bearer ${te}`).send({ pcodes:[] });
  assert.equal(refus.status, 403);

  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const j = await request(app).get("/api/audit?limit=200").set("Authorization", `Bearer ${t}`);
  assert.ok(j.body.rows.some(x => x.entity === "office_scope"),
    "les changements de périmètre laissent une trace");
});

/* ═══════════════════════════════════════════════════════════════════════
   Bureaux : configuration réelle, et le cas du bureau pays.

   Deux choses sont vérifiées ici. D'abord que modifier un bureau modifie
   vraiment la base : l'écran de configuration écrivait dans une liste de noms
   dérivée qui n'était jamais renvoyée, donc la saisie était perdue au
   rechargement — la même famille de défaut que le panneau API. Ensuite que le
   bureau déclaré national ouvre bien tous les sites à ses comptes sans leur
   donner l'administration : c'est le besoin des staffs de Tana.
   ═══════════════════════════════════════════════════════════════════════ */

test("bureaux : la lecture expose la configuration, le périmètre effectif et les références", async () => {
  const r = await request(app).get("/api/offices").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.offices.length >= 2);
  const hq = r.body.offices.find(o => o.kind === "hq");
  assert.ok(hq, "le jeu d'essai comporte un bureau pays");
  assert.equal(hq.scope_mode, "national", "le bureau pays est national");
  const terrain = r.body.offices.find(o => o.kind === "field");
  assert.equal(terrain.scope_mode, "geo");
  assert.ok(terrain.usage.sites > 0, "les références sont comptées");
  assert.ok(typeof terrain.scope.communes === "number");
});

test("bureaux : création, renommage persistant et refus du doublon", async () => {
  const créé = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau de terrain de Farafangana", code:"FARAFANGANA",
            antennes:["Vangaindrano"], manager:"R. Andria" });
  assert.equal(créé.status, 201);
  const id = créé.body.office.id;
  assert.deepEqual(créé.body.office.antennes, ["Vangaindrano"]);

  const doublon = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"bureau de terrain de farafangana" });
  assert.equal(doublon.status, 409, "le nom est unique, sans égard à la casse");

  const maj = await request(app).put(`/api/offices/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau de terrain de Farafangana Sud", code:"FARAFANGANA",
            antennes:["Vangaindrano","Midongy"], rev: créé.body.office.rev });
  assert.equal(maj.status, 200);
  assert.equal(maj.body.office.rev, 2, "la révision avance");

  /* La preuve que ce n'est plus un no-op : la base porte le nouveau nom. */
  assert.equal(db.prepare("SELECT name FROM offices WHERE id=?").get(id).name,
    "Bureau de terrain de Farafangana Sud");
  /* Et l'état renvoyé au client aussi — c'est de là que vient la liste des bureaux. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(st.body.offices.some(o => o.name === "Bureau de terrain de Farafangana Sud"));
});

test("bureaux : révision périmée refusée, valeur courante renvoyée", async () => {
  const o = db.prepare("SELECT * FROM offices WHERE code='FARAFANGANA'").get();
  const r = await request(app).put(`/api/offices/${o.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:o.name, rev:1 });
  assert.equal(r.status, 409);
  assert.ok(/modifié entre-temps/.test(r.body.error), r.body.error);
  assert.equal(r.body.courant.rev, o.rev, "la valeur courante accompagne le refus");
});

test("bureaux : un bureau référencé ne peut pas être supprimé, seulement désactivé", async () => {
  const référencé = db.prepare(
    "SELECT id FROM offices WHERE id IN (SELECT office_id FROM sites) LIMIT 1").get();
  const orphelins = () => db.prepare("SELECT COUNT(*) c FROM sites WHERE office_id IS NULL").get().c;
  const avant = orphelins();
  const refus = await request(app).delete(`/api/offices/${référencé.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refus.status, 409);
  assert.ok(refus.body.usage.sites > 0);
  assert.ok(db.prepare("SELECT 1 FROM offices WHERE id=?").get(référencé.id), "rien n'a été supprimé");
  /* Et aucun site n'a été détaché au passage — c'est ce que ferait le ON DELETE SET NULL
     du schéma : des sites sans bureau, invisibles de tous les filtres. */
  assert.equal(orphelins(), avant, "aucun site détaché");

  /* Un bureau neuf, sans référence, se supprime bien. */
  const neuf = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau provisoire" });
  const del = await request(app).delete(`/api/offices/${neuf.body.office.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 200);
});

test("bureaux : désactiver un bureau portant des comptes actifs est refusé", async () => {
  const o = db.prepare(
    "SELECT * FROM offices WHERE id IN (SELECT office_id FROM users WHERE active=1) LIMIT 1").get();
  const r = await request(app).put(`/api/offices/${o.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:o.name, code:o.code, kind:o.kind, scope_mode:o.scope_mode,
            active:false, rev:o.rev });
  assert.equal(r.status, 409);
  assert.ok(/compte\(s\) actif\(s\)/.test(r.body.error), r.body.error);
  assert.equal(db.prepare("SELECT active FROM offices WHERE id=?").get(o.id).active, 1);
});

test("bureaux : l'écriture est réservée aux administrateurs", async () => {
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  /* La lecture reste ouverte : l'application a besoin des noms de bureaux. */
  assert.equal((await request(app).get("/api/offices").set("Authorization", `Bearer ${t}`)).status, 200);
  for(const [méthode, chemin] of [["post","/api/offices"], ["put","/api/offices/x"], ["delete","/api/offices/x"]]){
    const r = await request(app)[méthode](chemin).set("Authorization", `Bearer ${t}`).send({ name:"Essai" });
    assert.equal(r.status, 403, `${méthode.toUpperCase()} ${chemin} refusé`);
  }
});

test("bureau pays : un compte de Tana voit tous les sites sans être administrateur", async () => {
  const hq = db.prepare("SELECT id,name FROM offices WHERE kind='hq'").get();
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"tana@test.local", password:"TanaMotDePasse1", first_name:"Tana",
            role:"editor", office_id:hq.id, tabs:["home"], active:true });
  const t = (await login("tana@test.local", "TanaMotDePasse1")).body.token;

  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const total = db.prepare("SELECT COUNT(*) c FROM sites").get().c;
  assert.equal(st.body.sites.length, total, "tous les sites, pas seulement ceux de Tana");
  assert.ok(db.prepare("SELECT COUNT(*) c FROM sites WHERE office_id<>?").get(hq.id).c > 0,
    "le jeu d'essai comporte bien des sites d'autres bureaux");

  /* Le site d'un autre bureau est lisible, alors qu'il était refusé au compte de terrain. */
  const autre = db.prepare("SELECT id FROM sites WHERE office_id<>? LIMIT 1").get(hq.id);
  assert.equal((await request(app).get(`/api/sites/${autre.id}`)
    .set("Authorization", `Bearer ${t}`)).status, 200);

  /* Mais le rôle n'a pas bougé : pas d'administration. C'est tout l'intérêt de
     porter le périmètre sur le bureau et non sur le rôle. */
  assert.equal((await request(app).get("/api/users").set("Authorization", `Bearer ${t}`)).status, 403);
  assert.equal((await request(app).post("/api/offices").set("Authorization", `Bearer ${t}`)
    .send({ name:"Essai" })).status, 403);

  /* Le périmètre géographique suit la même règle : le ciblage national est lisible. */
  const cov = await request(app).get("/api/geo/coverage").set("Authorization", `Bearer ${t}`);
  assert.equal(cov.status, 200);
  const sc = await request(app).get("/api/geo/scope").set("Authorization", `Bearer ${t}`);
  assert.equal(sc.body.rows.find(x => x.office_id === hq.id).source, "national");
});

test("bureau pays : ramené au périmètre déclaré, le même compte est de nouveau cloisonné", async () => {
  const hq = db.prepare("SELECT * FROM offices WHERE kind='hq'").get();
  const r = await request(app).put(`/api/offices/${hq.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:hq.name, code:hq.code, kind:"hq", scope_mode:"geo", active:true, rev:hq.rev });
  assert.equal(r.status, 200);

  const t = (await login("tana@test.local", "TanaMotDePasse1")).body.token;
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  const siens = db.prepare("SELECT COUNT(*) c FROM sites WHERE office_id=?").get(hq.id).c;
  assert.equal(st.body.sites.length, siens, "le cloisonnement est revenu");
  assert.ok(st.body.sites.length < db.prepare("SELECT COUNT(*) c FROM sites").get().c);

  /* Rétabli, pour ne pas laisser la base d'essai dans un état trompeur. */
  const à_jour = db.prepare("SELECT rev FROM offices WHERE id=?").get(hq.id);
  await request(app).put(`/api/offices/${hq.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:hq.name, code:hq.code, kind:"hq", scope_mode:"national", active:true, rev:à_jour.rev });
  assert.equal(db.prepare("SELECT scope_mode FROM offices WHERE id=?").get(hq.id).scope_mode, "national");
});

test("bureaux : mode de périmètre inconnu refusé — une valeur libre élargirait un accès", async () => {
  const o = db.prepare("SELECT * FROM offices WHERE kind='field' LIMIT 1").get();
  const r = await request(app).put(`/api/offices/${o.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:o.name, scope_mode:"tout", rev:o.rev });
  assert.equal(r.status, 422);
  assert.equal(db.prepare("SELECT scope_mode FROM offices WHERE id=?").get(o.id).scope_mode, "geo");
});

/* ═══════════════════════════════════════════════════════════════════════
   Plan MRE et budget.

   Le point à verrouiller est le budget : il doit rester la somme de ses lignes,
   côté serveur. Si l'écran le recalculait de son côté, ou si un champ « total »
   existait à côté des lignes, les deux chiffres finiraient par diverger — et
   c'est le total qu'on présente au bailleur.
   ═══════════════════════════════════════════════════════════════════════ */

test("MRE : le budget est fréquence × coût unitaire, et les agrégats en découlent", async () => {
  const an = new Date().getFullYear();
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 0, "le jeu d'essai comporte un plan");

  /* La formule du classeur, à la lettre : ( Σ des quatre trimestres ) × coût unitaire. */
  for(const a of r.body.rows){
    const qs = a.frequences?.[an];
    const attendu = Math.round((qs ? qs.reduce((t,x)=>t+x, 0) : 0) * a.unit_cost * 100) / 100;
    assert.equal(a.budgetParAnnee?.[an]?.montant ?? 0, attendu, `budget ${an} de ${a.title}`);
  }
  const somme = Math.round(r.body.rows.reduce((t,a)=>t+(a.budgetParAnnee?.[an]?.montant||0), 0) * 100) / 100;
  assert.equal(r.body.totals.budget, somme, "le total de l'année est la somme des activités");

  /* La répartition trimestrielle n'est plus une convention : elle est déclarée,
     donc elle DOIT totaliser exactement le budget de l'année. */
  const parT = Math.round(r.body.parTrimestre.reduce((t,q)=>t+q.budget, 0) * 100) / 100;
  assert.equal(parT, somme);
  assert.equal(r.body.parTrimestre.length, 4);

  /* Le plan est pluriannuel : au moins une activité porte une année différente. */
  assert.ok(r.body.parAnnee.length >= 2, "le plan couvre plusieurs exercices");
  const totalPlan = Math.round(r.body.parAnnee.reduce((t,y)=>t+y.budget, 0) * 100) / 100;
  assert.equal(r.body.totals.budgetTotal, totalPlan,
    "le budget de tout le plan est la somme de ses années");
});

test("MRE : création d'une activité, puis de son calendrier trimestriel", async () => {
  const an = new Date().getFullYear();
  const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, ref:"MRE-T1", title:"Enquête de vérification des listes",
            kind:"enquete", purpose:"Contrôler la qualité des listes de bénéficiaires",
            entity:"externe", cost_category:"PDM (général)", high_category:"dsc_assessment",
            unit_cost:2500, sample:400, currency:"USD" });
  assert.equal(c.status, 201);
  const a = c.body.activity;
  assert.equal(a.budget, 0, "un coût unitaire sans occurrence ne fait pas un budget");
  assert.equal(a.spent, null, "et pas de dépense — nul, pas zéro");
  assert.equal(a.entityLabel.length > 0, true, "l'entité est rendue en clair");

  const f = await request(app).put(`/api/mre/${a.id}/frequencies`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:a.rev, rows:[{ year:an, q:[0,2,0,1] }, { year:an+1, q:[1,0,0,0] }] });
  assert.equal(f.status, 200);
  const x = f.body.activity;
  assert.equal(x.budgetParAnnee[an].montant, 3 * 2500);
  assert.equal(x.budgetParAnnee[an+1].montant, 1 * 2500);
  assert.equal(x.budget, 4 * 2500, "le budget de l'activité couvre toutes ses années");
  assert.equal(x.occurrences, 4);
  assert.equal(x.rev, a.rev + 1, "modifier le calendrier fait avancer la révision");

  /* La dépense se saisit par année, séparément du plan. */
  const d = await request(app).put(`/api/mre/${a.id}/spend`).set("Authorization", `Bearer ${adminToken}`)
    .send({ rows:[{ year:an, amount:6000 }] });
  assert.equal(d.status, 200);
  assert.equal(d.body.activity.spent, 6000);
  assert.equal(d.body.activity.execution, Math.round((6000/10000)*1000)/10);
});

test("MRE : le calendrier remplacé en bloc ne laisse pas d'ancien trimestre derrière lui", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1'").get();
  const an = a.year;
  const r = await request(app).put(`/api/mre/${a.id}/frequencies`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:a.rev, rows:[{ year:an, q:[0,0,0,1] }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.occurrences, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_frequency WHERE activity_id=?").get(a.id).c, 1,
    "un seul trimestre non nul est conservé, et l'année suivante a disparu");
  assert.equal(r.body.activity.budgetParAnnee[an+1], undefined);
});

test("MRE : révision périmée refusée sur l'activité comme sur son calendrier", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1'").get();
  const act = await request(app).put(`/api/mre/${a.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ year:a.year, title:a.title, rev:1 });
  assert.equal(act.status, 409);
  assert.ok(act.body.courant, "la valeur courante accompagne le refus");
  const cal = await request(app).put(`/api/mre/${a.id}/frequencies`)
    .set("Authorization", `Bearer ${adminToken}`).send({ rev:1, rows:[] });
  assert.equal(cal.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_frequency WHERE activity_id=?").get(a.id).c, 1,
    "le calendrier n'a pas été vidé au passage");
});

test("MRE : garde-fous de saisie — référence unique dans l'année, listes fermées", async () => {
  const an = new Date().getFullYear();
  const dup = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, ref:"MRE-T1", title:"Doublon de référence" });
  assert.equal(dup.status, 409);
  /* La même référence est libre pour une autre année : les plans se succèdent. */
  const autre = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an+1, ref:"MRE-T1", title:"Même référence, année suivante" });
  assert.equal(autre.status, 201);

  const natureInconnue = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Nature inconnue", kind:"bricolage" });
  assert.equal(natureInconnue.status, 422);

  /* L'entité et la catégorie de haut niveau sont des listes fermées : elles servent
     à consolider entre bureaux pays, et une valeur inventée casse l'agrégation
     sans que personne s'en aperçoive avant la consolidation. */
  const entiteInconnue = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Entité inventée", entity:"sous-traitant-du-cousin" });
  assert.equal(entiteInconnue.status, 422);
  const categorieInconnue = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Catégorie inventée", high_category:"divers-et-variés" });
  assert.equal(categorieInconnue.status, 422);

  /* Un trimestre hors bornes est refusé : la grille en a quatre, pas cinq. */
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1' AND year=?").get(an);
  const cinq = await request(app).put(`/api/mre/${a.id}/frequencies`)
    .set("Authorization", `Bearer ${adminToken}`).send({ rows:[{ year:an, q:[1,1,1,1,1] }] });
  assert.equal(cinq.status, 422);
});

test("MRE : un bureau voit son plan et le plan national, mais ne modifie que le sien", async () => {
  const an = new Date().getFullYear();
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.every(a => !a.office_id || a.office_id === office.id),
    "aucune activité d'un autre bureau");
  assert.ok(r.body.rows.some(a => a.office_id === office.id), "il voit son propre plan");

  const ailleurs = db.prepare(
    "SELECT id FROM mre_activity WHERE office_id IS NOT NULL AND office_id<>? LIMIT 1").get(office.id);
  const refus = await request(app).put(`/api/mre/${ailleurs.id}`)
    .set("Authorization", `Bearer ${t}`).send({ year:an, title:"Tentative", rev:1 });
  assert.equal(refus.status, 403);

  const cree = await request(app).post("/api/mre").set("Authorization", `Bearer ${t}`)
    .send({ year:an, title:"Suivi de proximité complémentaire", office_id:null });
  assert.equal(cree.status, 201);
  assert.equal(cree.body.activity.office_id, office.id);
});

test("MRE : un compte de Tana pilote le plan national", async () => {
  const an = new Date().getFullYear();
  const t = (await login("tana@test.local", "TanaMotDePasse1")).body.token;
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  /* Bureau national : il voit tout le plan de l'année, comme il voit tous les sites.
     « Du plan de l'année » veut dire : ce qui porte des occurrences cette année-là,
     ou ce qui n'en porte aucune et a été déclaré pour elle. */
  const tout = db.prepare(`SELECT COUNT(*) c FROM mre_activity a WHERE
      EXISTS (SELECT 1 FROM mre_frequency f WHERE f.activity_id=a.id AND f.year=?)
      OR (a.year=? AND NOT EXISTS (SELECT 1 FROM mre_frequency f2 WHERE f2.activity_id=a.id))`)
    .get(an, an).c;
  assert.equal(r.body.rows.length, tout);
  const ailleurs = db.prepare(
    "SELECT id FROM mre_activity WHERE year=? AND office_id IS NOT NULL LIMIT 1").get(an);
  const maj = await request(app).put(`/api/mre/${ailleurs.id}`).set("Authorization", `Bearer ${t}`)
    .send({ year:an, title:"Ajusté par le bureau pays",
            rev: db.prepare("SELECT rev FROM mre_activity WHERE id=?").get(ailleurs.id).rev });
  assert.equal(maj.status, 200);
});

test("MRE : suppression réservée au droit de suppression, calendrier emporté", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1' AND year=?")
    .get(new Date().getFullYear());
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).delete(`/api/mre/${a.id}`)
    .set("Authorization", `Bearer ${te}`)).status, 403, "un éditeur ne supprime pas");

  const r = await request(app).delete(`/api/mre/${a.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_frequency WHERE activity_id=?").get(a.id).c, 0,
    "le calendrier n'a pas d'existence propre");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_spend WHERE activity_id=?").get(a.id).c, 0);
});

test("MRE : plan mélangeant les devises — aucun total général n'est inventé", async () => {
  const an = new Date().getFullYear() + 3;   /* année vierge, pour isoler le cas */
  for(const [titre, devise] of [["Activité en dollars","USD"], ["Activité en ariary","MGA"]]){
    const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
      .send({ year:an, title:titre, currency:devise, unit_cost:1000 });
    await request(app).put(`/api/mre/${c.body.activity.id}/frequencies`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rev:c.body.activity.rev, rows:[{ year:an, q:[1,0,0,0] }] });
  }
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.body.totals.currency, null, "pas de devise unique : pas de total présenté comme tel");
  assert.deepEqual(r.body.totals.devises.sort(), ["MGA","USD"]);
});

test("MRE : une activité pluriannuelle appartient à chacune de ses années", async () => {
  const an = new Date().getFullYear() + 5;
  const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Suivi continu sur trois exercices", unit_cost:400 });
  await request(app).put(`/api/mre/${c.body.activity.id}/frequencies`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:c.body.activity.rev, rows:[
      { year:an,   q:[1,1,1,1] }, { year:an+1, q:[1,1,1,1] }, { year:an+2, q:[2,0,0,0] } ] });

  /* Déclarée en `an`, elle doit apparaître dans le plan de `an+1` : c'est tout
     l'intérêt du modèle pluriannuel, et un filtre sur l'année de déclaration
     l'aurait fait disparaître de l'exercice où elle se déroule pourtant. */
  const suivant = await request(app).get(`/api/mre?year=${an+1}`)
    .set("Authorization", `Bearer ${adminToken}`);
  const vue = suivant.body.rows.find(x => x.id === c.body.activity.id);
  assert.ok(vue, "l'activité figure au plan de l'année suivante");
  assert.equal(vue.budgetParAnnee[an+1].montant, 4 * 400);
  assert.equal(suivant.body.totals.budget, 4 * 400, "et le total de cette année-là ne compte qu'elle");

  /* La troisième année ne porte que deux occurrences, toutes au premier trimestre. */
  const troisieme = await request(app).get(`/api/mre?year=${an+2}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(troisieme.body.parTrimestre[0].occurrences, 2);
  assert.equal(troisieme.body.parTrimestre[1].occurrences, 0);
  assert.equal(troisieme.body.totals.budget, 2 * 400);
});

/* Contexte partagé par les essais du suivi tiers : ils se lisent dans l'ordre,
   chacun s'appuyant sur ce que le précédent a créé. */
let tpmCtx = {};

test("TPM : prestataire, contrat et barème — le budget dérive de l'affectation", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = await request(app).post("/api/tpm").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Prestataire d'essai", code:"ESSAI", office_id:office.id, contact:"R. Test" });
  assert.equal(t.status, 201);
  tpmCtx.tpm = t.body.id; tpmCtx.office = office;

  const c = await request(app).post("/api/tpm/contracts").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:tpmCtx.tpm, ref:"CTR-ESSAI-01", ceiling:10_000_000, currency:"MGA",
            start_date:"2026-01-01", end_date:"2026-12-31" });
  assert.equal(c.status, 201);
  tpmCtx.contract = c.body.id;

  const bareme = await request(app).put(`/api/tpm/contracts/${tpmCtx.contract}/rates`)
    .set("Authorization", `Bearer ${adminToken}`).send({ rates:[
      { driver:"superviseur", label:"Indemnité superviseur", unit:"pers-jour", unit_cost:70000 },
      { driver:"agent",       label:"Indemnité agent",       unit:"pers-jour", unit_cost:60000 },
      { driver:"vehicule",    label:"Location voiture",      unit:"véhicule-jour", unit_cost:300000 },
      { driver:"carburant",   label:"Carburant",             unit:"litre", unit_cost:5000 },
    ] });
  assert.equal(bareme.status, 200);

  const p = await request(app).post("/api/tpm/plans").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:tpmCtx.tpm, contract_id:tpmCtx.contract, year:2026, month:2, ref:"P-ESSAI" });
  assert.equal(p.status, 201);
  tpmCtx.plan = p.body.id;
  assert.equal(p.body.plan.budget, 0, "un plan sans affectation n'a pas de budget");

  /* Une zone : 2 superviseurs, 2 agents, 3 jours + 1 de déplacement, 1 véhicule, 45 litres. */
  const pcode = db.prepare("SELECT pcode FROM geo_unit WHERE level='adm3' LIMIT 1").get().pcode;
  const z = await request(app).put(`/api/tpm/plans/${tpmCtx.plan}/zones`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ zones:[{ geo_pcode:pcode, activity_tag:"URT", team_label:"TEAM1",
      supervisors:2, agents:2, days:3, travel_days:1, vehicles:1, fuel_litres:45, sites:6 }] });
  assert.equal(z.status, 200);

  /* Le montant attendu, calculé à la main comme le ferait le classeur. */
  const attendu = 2*4*70000 + 2*4*60000 + 1*4*300000 + 45*1*5000;
  assert.equal(z.body.plan.budget, attendu, "budget = Σ qté1 × qté2 × coût unitaire");
  assert.equal(z.body.plan.zones.length, 1);
  assert.equal(z.body.plan.zones[0].subtotal, attendu, "le sous-total de l'équipe est le même");
  assert.equal(z.body.plan.zones[0].lines.length, 4, "une ligne par poste du barème");
  assert.ok(z.body.plan.zones[0].lines.every(l => l.derived), "toutes dérivées du barème");
  /* Aucune ligne à quantité nulle : le plan ne porte pas « 0 véhicule ». */
  assert.ok(z.body.plan.zones[0].lines.every(l => l.qty1 > 0));

  /* Changer les jours change le montant, sans qu'aucun total ne soit saisi. */
  const z2 = await request(app).put(`/api/tpm/plans/${tpmCtx.plan}/zones`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:z.body.plan.rev, zones:[{ geo_pcode:pcode, activity_tag:"URT", team_label:"TEAM1",
      supervisors:2, agents:2, days:6, travel_days:1, vehicles:1, fuel_litres:45, sites:6 }] });
  const attendu2 = 2*7*70000 + 2*7*60000 + 1*7*300000 + 45*1*5000;
  assert.equal(z2.body.plan.budget, attendu2);
  assert.ok(attendu2 > attendu, "trois jours de plus coûtent plus cher");
});

test("TPM : une ligne ajustée à la main survit au recalcul de l'affectation", async () => {
  const avant = (await request(app).get(`/api/tpm/plans/${tpmCtx.plan}`)
    .set("Authorization", `Bearer ${adminToken}`)).body.plan;
  const lignes = avant.zones[0].lines.map(l => ({ zone_id:l.zone_id, driver:l.driver,
    label:l.label, unit:l.unit, qty1:l.qty1, qty2:l.qty2, unit_cost:l.unit_cost, derived:true }));
  /* Une ligne saisie, sans zone : les frais communs du classeur de référence. */
  lignes.push({ zone_id:null, driver:"forfait", label:"Groupe électrogène",
    unit:"groupe", qty1:1, qty2:1, unit_cost:80000, derived:false });
  const l = await request(app).put(`/api/tpm/plans/${tpmCtx.plan}/lines`)
    .set("Authorization", `Bearer ${adminToken}`).send({ rev:avant.rev, lines:lignes });
  assert.equal(l.status, 200);
  assert.equal(l.body.plan.communes.length, 1, "la ligne sans zone est un frais commun");
  const avecForfait = l.body.plan.budget;

  /* On rejoue l'affectation : les lignes dérivées sont refaites, la ligne saisie reste. */
  const pcode = avant.zones[0].geo_pcode;
  const z = await request(app).put(`/api/tpm/plans/${tpmCtx.plan}/zones`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:l.body.plan.rev, zones:[{ geo_pcode:pcode, activity_tag:"URT",
      supervisors:2, agents:2, days:6, travel_days:1, vehicles:1, fuel_litres:45, sites:6 }] });
  assert.equal(z.status, 200);
  assert.equal(z.body.plan.communes.length, 1, "le frais commun n'a pas été effacé");
  assert.equal(z.body.plan.budget, avecForfait, "et le montant est inchangé");
});

test("TPM : le circuit se franchit dans l'ordre et par le bon acteur", async () => {
  /* Un compte de prestataire, borné à son prestataire. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"prestataire@test.local", password:"PrestataireMotDePasse1",
            first_name:"Presta", role:"editor", tpm_id:tpmCtx.tpm, tabs:["home"], active:true });
  const tp = (await login("prestataire@test.local", "PrestataireMotDePasse1")).body.token;
  /* Le deuxième niveau est « le responsable suivi-évaluation du bureau » : un compte
     du bureau qui a le droit de valider. Un éditeur du même bureau ne l'a pas —
     c'est bien le rôle qui gouverne ce qu'on peut faire, et le bureau où. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"se-bureau@test.local", password:"SeBureauMotDePasse1",
            first_name:"Valid", role:"validator", office_id:tpmCtx.office.id,
            tabs:["home"], active:true });
  const te = (await login("se-bureau@test.local", "SeBureauMotDePasse1")).body.token;
  const editeur = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const tana = (await login("tana@test.local", "TanaMotDePasse1")).body.token;
  tpmCtx.tokens = { tp, te, tana, editeur };

  /* Rien n'est validable avant soumission. */
  const tot = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${adminToken}`).send({ decision:"valide" });
  assert.equal(tot.status, 409);
  assert.ok(/n'attend aucune validation/.test(tot.body.error), tot.body.error);

  const s = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/submit`)
    .set("Authorization", `Bearer ${tp}`);
  assert.equal(s.status, 200);
  assert.equal(s.body.plan.status, "soumis");

  /* Une fois soumis, le plan ne se modifie plus : valider un montant puis le
     laisser changer viderait la validation de son sens. */
  const fige = await request(app).put(`/api/tpm/plans/${tpmCtx.plan}/zones`)
    .set("Authorization", `Bearer ${adminToken}`).send({ zones:[] });
  assert.equal(fige.status, 409);
  assert.ok(/plus modifiable/.test(fige.body.error), fige.body.error);

  /* Niveau 1 : le prestataire. Le bureau ne peut pas sauter par-dessus — la
     transition attendue est celle du niveau 1, pas celle du niveau 2. */
  const p1 = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${tp}`).send({ decision:"valide" });
  assert.equal(p1.status, 200);
  assert.equal(p1.body.plan.status, "valide_tpm");
  assert.equal(p1.body.plan.reviews.length, 1);
  assert.equal(p1.body.plan.reviews[0].level, "tpm");
  assert.ok(p1.body.plan.reviews[0].amount > 0, "le montant validé est consigné");

  /* Niveau 2 : le bureau. Le prestataire n'y a pas accès, quel que soit son rôle —
     c'est la raison d'être du cloisonnement par prestataire. */
  const refus = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${tp}`).send({ decision:"valide" });
  assert.equal(refus.status, 403);
  assert.ok(/Suivi-évaluation du bureau/.test(refus.body.error), refus.body.error);

  /* Un éditeur du bureau n'a pas le droit de valider : le niveau reste ouvert. */
  const sansValidation = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${editeur}`).send({ decision:"valide" });
  assert.equal(sansValidation.status, 403);

  const p2 = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${te}`).send({ decision:"valide" });
  assert.equal(p2.status, 200, JSON.stringify(p2.body));
  assert.equal(p2.body.plan.status, "valide_bureau");

  /* Niveau 3 : le bureau pays. Un compte de terrain ne peut pas s'y substituer. */
  const refus3 = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${te}`).send({ decision:"valide" });
  assert.equal(refus3.status, 403);
  assert.ok(/bureau pays/.test(refus3.body.error), refus3.body.error);

  /* Le compte de Tana est éditeur, pas validateur : il lui manque le droit. */
  const sansDroit = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${tana}`).send({ decision:"valide" });
  assert.equal(sansDroit.status, 403);

  const p3 = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/review`)
    .set("Authorization", `Bearer ${adminToken}`).send({ decision:"valide" });
  assert.equal(p3.status, 200, JSON.stringify(p3.body));
  assert.equal(p3.body.plan.status, "valide_pays");
  assert.equal(p3.body.plan.reviews.length, 3, "les trois passages sont tracés");
  assert.deepEqual(p3.body.plan.reviews.map(r => r.level), ["tpm","bureau","pays"]);
  assert.ok(p3.body.plan.reviews.every(r => r.by), "chaque validation porte son auteur");
});

test("TPM : un renvoi doit être motivé et rouvre le plan à la modification", async () => {
  const office = tpmCtx.office;
  const p = await request(app).post("/api/tpm/plans").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:tpmCtx.tpm, contract_id:tpmCtx.contract, year:2026, month:3 });
  const id = p.body.id;
  const pcode = db.prepare("SELECT pcode FROM geo_unit WHERE level='adm3' LIMIT 1").get().pcode;
  await request(app).put(`/api/tpm/plans/${id}/zones`).set("Authorization", `Bearer ${adminToken}`)
    .send({ zones:[{ geo_pcode:pcode, supervisors:1, agents:1, days:2, vehicles:1, fuel_litres:20 }] });
  await request(app).post(`/api/tpm/plans/${id}/submit`).set("Authorization", `Bearer ${adminToken}`);

  const muet = await request(app).post(`/api/tpm/plans/${id}/review`)
    .set("Authorization", `Bearer ${adminToken}`).send({ decision:"renvoye" });
  assert.equal(muet.status, 422);
  assert.ok(/motivé/.test(muet.body.error), muet.body.error);

  const r = await request(app).post(`/api/tpm/plans/${id}/review`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ decision:"renvoye", comment:"Trois véhicules pour deux communes voisines." });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.status, "renvoye");
  assert.equal(r.body.plan.reviews.at(-1).comment, "Trois véhicules pour deux communes voisines.");
  /* Rouvert : c'est un retour au prestataire, pas un rejet définitif. */
  const modif = await request(app).put(`/api/tpm/plans/${id}/zones`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:r.body.plan.rev, zones:[{ geo_pcode:pcode, supervisors:1, agents:1, days:2,
      vehicles:1, fuel_litres:20 }] });
  assert.equal(modif.status, 200);
  tpmCtx.renvoye = id;
});

test("TPM : le plafond contractuel est vérifié à la validation finale", async () => {
  /* Un plan volontairement hors de portée du plafond restant. */
  const pcode = db.prepare("SELECT pcode FROM geo_unit WHERE level='adm3' LIMIT 1").get().pcode;
  const p = await request(app).post("/api/tpm/plans").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:tpmCtx.tpm, contract_id:tpmCtx.contract, year:2026, month:5 });
  const id = p.body.id;
  await request(app).put(`/api/tpm/plans/${id}/zones`).set("Authorization", `Bearer ${adminToken}`)
    .send({ zones:[{ geo_pcode:pcode, supervisors:20, agents:40, days:25, travel_days:4,
      vehicles:10, fuel_litres:4000 }] });

  /* La soumission avertit sans bloquer : tant que le plan circule il n'engage rien. */
  const s = await request(app).post(`/api/tpm/plans/${id}/submit`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(s.status, 200);
  assert.ok(/dépasse le disponible/.test(s.body.avertissement || ""), s.body.avertissement);

  await request(app).post(`/api/tpm/plans/${id}/review`).set("Authorization", `Bearer ${adminToken}`)
    .send({ decision:"valide" });
  await request(app).post(`/api/tpm/plans/${id}/review`).set("Authorization", `Bearer ${adminToken}`)
    .send({ decision:"valide" });
  /* Le troisième niveau refuse, avec les chiffres. */
  const bloc = await request(app).post(`/api/tpm/plans/${id}/review`)
    .set("Authorization", `Bearer ${adminToken}`).send({ decision:"valide" });
  assert.equal(bloc.status, 409);
  assert.ok(/disponibles sur le contrat/.test(bloc.body.error), bloc.body.error);
  assert.ok(bloc.body.requis > 0, "le montant manquant est chiffré");
  assert.equal(db.prepare("SELECT status FROM tpm_plan WHERE id=?").get(id).status, "valide_bureau",
    "le plan n'a pas avancé");

  /* Un avenant couvre le manque, et la validation passe. */
  const av = await request(app).post(`/api/tpm/contracts/${tpmCtx.contract}/amendments`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ ref:"AV-ESSAI", delta: Math.ceil(bloc.body.requis) + 1000,
            reason:"Extension du périmètre au district voisin", signed_at:"2026-05-20" });
  assert.equal(av.status, 201);
  const ok = await request(app).post(`/api/tpm/plans/${id}/review`)
    .set("Authorization", `Bearer ${adminToken}`).send({ decision:"valide" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.plan.status, "valide_pays");
  tpmCtx.engage = id;
});

test("TPM : un avenant ne peut pas ramener le plafond sous ce qui est engagé", async () => {
  const solde = (await request(app).get("/api/tpm").set("Authorization", `Bearer ${adminToken}`))
    .body.rows.find(t => t.id === tpmCtx.tpm).contrats[0].solde;
  assert.ok(solde.engage > 0, "des plans sont engagés");
  const r = await request(app).post(`/api/tpm/contracts/${tpmCtx.contract}/amendments`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ delta: -(solde.plafond), reason:"Réduction du contrat" });
  assert.equal(r.status, 409);
  assert.ok(/déjà engagés/.test(r.body.error), r.body.error);

  const nul = await request(app).post(`/api/tpm/contracts/${tpmCtx.contract}/amendments`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ delta:0, reason:"Sans effet" });
  assert.equal(nul.status, 422);
});

test("TPM : le solde distingue engagé, en cours et dépensé", async () => {
  const c = (await request(app).get("/api/tpm").set("Authorization", `Bearer ${adminToken}`))
    .body.rows.find(t => t.id === tpmCtx.tpm).contrats[0];
  const s = c.solde;
  assert.equal(s.plafond, Math.round((s.ceiling + s.avenants) * 100) / 100);
  assert.equal(s.disponible, Math.round((s.plafond - s.engage) * 100) / 100);
  assert.ok(s.engage > 0, "les plans validés au niveau pays sont engagés");
  /* Le plan renvoyé n'est ni engagé ni en cours : il est retourné à son auteur. */
  assert.ok(s.projete <= s.disponible, "le projeté retire ce qui circule encore");
});

test("TPM : une dépense ne se constate que sur un plan engagé, et le dépassement est signalé", async () => {
  const enCours = tpmCtx.renvoye;
  const refus = await request(app).post(`/api/tpm/plans/${enCours}/expenses`)
    .set("Authorization", `Bearer ${adminToken}`).send({ amount:1000 });
  assert.equal(refus.status, 409);
  assert.ok(/validé au niveau pays/.test(refus.body.error), refus.body.error);

  const plan = (await request(app).get(`/api/tpm/plans/${tpmCtx.plan}`)
    .set("Authorization", `Bearer ${adminToken}`)).body.plan;
  const ligne = plan.zones[0].lines[0];
  const d = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/expenses`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ line_id:ligne.id, amount:ligne.total, spent_on:"2026-03-20", ref:"FAC-1" });
  assert.equal(d.status, 201);
  assert.equal(d.body.plan.spent, ligne.total);
  assert.equal(d.body.plan.zones[0].lines[0].spent, ligne.total,
    "la dépense se rattache à sa ligne, pas seulement au plan");

  /* Une dépense qui dépasse n'est pas refusée — c'est un fait constaté — mais
     elle est signalée. L'effacer pour respecter un budget serait falsifier. */
  const gros = await request(app).post(`/api/tpm/plans/${tpmCtx.plan}/expenses`)
    .set("Authorization", `Bearer ${adminToken}`).send({ amount: plan.budget, ref:"FAC-2" });
  assert.equal(gros.status, 201);
  assert.ok(/dépasse le budget validé/.test(gros.body.avertissement || ""), gros.body.avertissement);
  assert.ok(gros.body.plan.execution > 100);
});

test("TPM : un compte de prestataire ne voit que son prestataire et n'administre rien", async () => {
  const { tp } = tpmCtx.tokens;
  const l = await request(app).get("/api/tpm").set("Authorization", `Bearer ${tp}`);
  assert.equal(l.status, 200);
  assert.equal(l.body.rows.length, 1, "un seul prestataire visible");
  assert.equal(l.body.rows[0].id, tpmCtx.tpm);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM tpm").get().c > 1,
    "la base en contient plusieurs — le test prouve donc quelque chose");

  const plans = await request(app).get("/api/tpm/plans").set("Authorization", `Bearer ${tp}`);
  assert.ok(plans.body.rows.every(p => p.tpm_id === tpmCtx.tpm));
  const ailleurs = db.prepare("SELECT id FROM tpm_plan WHERE tpm_id<>? LIMIT 1").get(tpmCtx.tpm);
  assert.equal((await request(app).get(`/api/tpm/plans/${ailleurs.id}`)
    .set("Authorization", `Bearer ${tp}`)).status, 403);

  /* Et il ne crée ni prestataire, ni contrat, ni compte. */
  for(const [m, chemin] of [["post","/api/tpm"], ["post","/api/tpm/contracts"], ["get","/api/users"]]){
    const r = await request(app)[m](chemin).set("Authorization", `Bearer ${tp}`).send({ name:"X" });
    assert.equal(r.status, 403, `${m.toUpperCase()} ${chemin}`);
  }
});

test("TPM : un compte rattaché à un prestataire ne peut pas être administrateur", async () => {
  const r = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"presta-admin@test.local", password:"PrestaAdminMotDePasse1",
            first_name:"Presta", role:"admin", tpm_id:tpmCtx.tpm, tabs:["home"], active:true });
  assert.equal(r.status, 422);
  assert.ok(/ne peut pas être administrateur/.test(r.body.error), r.body.error);

  /* Ni rattaché à la fois à un bureau et à un prestataire : les deux
     cloisonnements se contrediraient. */
  const deux = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"presta-bureau@test.local", password:"PrestaBureauMotDePasse1",
            first_name:"Presta", role:"editor", tpm_id:tpmCtx.tpm,
            office_id:tpmCtx.office.id, tabs:["home"], active:true });
  assert.equal(deux.status, 422);
});

test("TPM : les zones proposées viennent de la planification fondée sur le risque", async () => {
  const an = new Date().getFullYear();
  const r = await request(app).get(`/api/tpm/suggest?year=${an}&month=${new Date().getMonth()}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 0, "des zones sont proposées");
  for(const z of r.body.rows){
    assert.ok(z.geo_pcode && z.zone, "chaque proposition porte son unité");
    assert.ok(z.actifs > 0, "seules les zones à sites actifs sont proposées");
    assert.equal(z.ecart, Math.max(0, z.planifies - z.visites));
  }
  /* Le tri met en tête ce qui est prévu et non fait : c'est là qu'il faut aller. */
  const ecarts = r.body.rows.map(z => z.ecart);
  assert.deepEqual(ecarts, [...ecarts].sort((a,b)=>b-a),
    "les zones les moins couvertes viennent en premier");

  /* Un compte de terrain ne reçoit que ses propres zones. */
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const mien = await request(app).get(`/api/tpm/suggest?year=${an}`)
    .set("Authorization", `Bearer ${te}`);
  assert.ok(mien.body.rows.length <= r.body.rows.length);
});

test("TPM : un plan par prestataire et par mois, et un plan engagé ne se supprime pas", async () => {
  const dup = await request(app).post("/api/tpm/plans").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:tpmCtx.tpm, contract_id:tpmCtx.contract, year:2026, month:2 });
  assert.equal(dup.status, 409);
  assert.ok(/existe déjà pour ce prestataire et ce mois/.test(dup.body.error), dup.body.error);

  const del = await request(app).delete(`/api/tpm/plans/${tpmCtx.plan}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 409);
  assert.ok(/plan engagé/.test(del.body.error), del.body.error);

  /* Et un prestataire porteur de plans ne se supprime pas davantage. */
  const dtpm = await request(app).delete(`/api/tpm/${tpmCtx.tpm}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(dtpm.status, 409);
  assert.ok(dtpm.body.usage.plans > 0);
});

test("TPM : le plafond ne se modifie pas en place, seulement par avenant", async () => {
  const avant = db.prepare("SELECT ceiling FROM tpm_contract WHERE id=?").get(tpmCtx.contract).ceiling;
  const r = await request(app).put(`/api/tpm/contracts/${tpmCtx.contract}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ ref:"CTR-ESSAI-01", ceiling: avant * 10, currency:"MGA", status:"actif" });
  assert.equal(r.status, 200);
  assert.ok(/avenant/.test(r.body.avertissement || ""), r.body.avertissement);
  assert.equal(db.prepare("SELECT ceiling FROM tpm_contract WHERE id=?").get(tpmCtx.contract).ceiling,
    avant, "le plafond initial est intact");
});

/* ═══════════════════════════════════════════════════════════════════════
   Contours administratifs.

   Le référentiel ne portait que des points ; la carte projetait des cercles sur
   un fond vide, et une commune sans site n'apparaissait nulle part. Ce que ces
   tests verrouillent : le rattachement par chemin de noms (les p-codes sont
   dérivés, un fichier de contours porte rarement les mêmes), la simplification
   effective, et le refus d'un fichier qui n'est pas en degrés.
   ═══════════════════════════════════════════════════════════════════════ */

/* Un carré, subdivisible : de quoi fabriquer des contours cohérents sans
   dépendre d'un fichier externe. */
const carre = (lon, lat, taille) => ({ type:"Polygon", coordinates:[[
  [lon, lat], [lon+taille, lat], [lon+taille, lat+taille], [lon, lat+taille], [lon, lat] ]] });
/* Un contour volontairement dense, pour que la simplification ait de quoi retirer. */
const dense = (lon, lat, taille, n) => {
  const pts = [];
  for(let i = 0; i < n; i++){
    const a = (i / n) * 2 * Math.PI;
    /* Un cercle légèrement bruité : sans bruit, Douglas-Peucker garderait tout. */
    const r = taille * (0.5 + (i % 3) * 0.001);
    pts.push([lon + r*Math.cos(a), lat + r*Math.sin(a)]);
  }
  pts.push(pts[0]);
  return { type:"Polygon", coordinates:[pts] };
};

test("contours : rattachement par chemin de noms, pas seulement par p-code", async () => {
  const u = db.prepare(`SELECT u.pcode, u.name, u.level, p.name parent, g.name grand
    FROM geo_unit u
    LEFT JOIN geo_unit p ON p.version_id=u.version_id AND p.pcode=u.parent_pcode
    LEFT JOIN geo_unit g ON g.version_id=u.version_id AND g.pcode=p.parent_pcode
    WHERE u.level='adm3' LIMIT 3`).all();
  assert.ok(u.length >= 2, "le référentiel comporte des communes");

  const r = await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`)
    .send({ reset:true, source:"essai.shp", features: u.map((x, i) => ({
      /* Aucun p-code : uniquement les noms, comme un fichier de contours réel. */
      names:{ adm1:x.grand, adm2:x.parent, adm3:x.name },
      geometry: carre(45 + i, -20 - i, 0.5) })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.écrites, u.length, "toutes les unités ont été retrouvées par leur chemin");
  assert.equal(r.body.rejetes, 0);

  const lu = await request(app).get("/api/geo/geometry?level=adm3")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(lu.status, 200);
  assert.equal(lu.body.type, "FeatureCollection");
  assert.equal(lu.body.features.length, u.length);
  assert.ok(lu.body.features.every(f => f.properties.pcode && f.properties.name));
  /* Le cadre porte sur l'ensemble, et il encadre bien les carrés envoyés. */
  assert.ok(lu.body.extent.west >= 44.9 && lu.body.extent.east <= 47.6, JSON.stringify(lu.body.extent));

  /* Une unité inconnue est rejetée avec son motif, sans annuler le reste. */
  const mixte = await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`)
    .send({ features:[
      { names:{ adm3:"Commune Qui N'Existe Pas" }, geometry: carre(45, -20, 0.2) },
      { names:{ adm1:u[0].grand, adm2:u[0].parent, adm3:u[0].name }, geometry: carre(46, -21, 0.2) },
    ] });
  assert.equal(mixte.body.écrites, 1);
  assert.equal(mixte.body.rejetes, 1);
  assert.ok(/introuvable/.test(mixte.body.rejets[0].message), mixte.body.rejets[0].message);
});

test("contours : la simplification allège réellement, et les deux résolutions coexistent", async () => {
  const u = db.prepare("SELECT u.pcode, u.name, p.name parent FROM geo_unit u LEFT JOIN geo_unit p ON p.pcode=u.parent_pcode AND p.version_id=u.version_id WHERE u.level='adm2' LIMIT 1").get();
  const r = await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`)
    .send({ features:[{ names:{ adm1:u.parent, adm2:u.name }, geometry: dense(46, -22, 1, 900) }] });
  assert.equal(r.body.écrites, 1);

  const ligne = db.prepare("SELECT * FROM geo_geom WHERE pcode=?").get(u.pcode);
  assert.equal(ligne.points, 901, "la pleine résolution est conservée telle quelle");
  assert.ok(ligne.points_simple < ligne.points / 3,
    `la version simplifiée est nettement plus légère (${ligne.points_simple} sur ${ligne.points})`);
  assert.ok(ligne.points_simple >= 4, "et reste un polygone valide");

  /* La lecture par défaut sert la version simplifiée ; `detail` sert la fine. */
  const simple = await request(app).get(`/api/geo/geometry?level=adm2`)
    .set("Authorization", `Bearer ${adminToken}`);
  const fin = await request(app).get(`/api/geo/geometry?level=adm2&detail=true`)
    .set("Authorization", `Bearer ${adminToken}`);
  const nb = (b) => b.features[0].geometry.coordinates[0].length;
  assert.ok(nb(simple.body) < nb(fin.body),
    `la vue d'ensemble est plus légère que le zoom (${nb(simple.body)} vs ${nb(fin.body)})`);
});

test("contours : un fichier qui n'est pas en degrés est refusé avec son motif", async () => {
  const u = db.prepare("SELECT u.pcode, u.name, p.name parent FROM geo_unit u LEFT JOIN geo_unit p ON p.pcode=u.parent_pcode AND p.version_id=u.version_id WHERE u.level='adm2' LIMIT 1").get();
  const r = await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`)
    .send({ features:[{ names:{ adm1:u.parent, adm2:u.name },
      /* Coordonnées en mètres : une projection UTM, pas du WGS 84. */
      geometry: carre(512340, 7654320, 1000) }] });
  assert.equal(r.body.écrites, 0);
  assert.equal(r.body.rejetes, 1);
  assert.ok(/WGS 84/.test(r.body.rejets[0].message), r.body.rejets[0].message);
});

test("contours : le millésime dit ce qu'il porte, et /state le sait au démarrage", async () => {
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${adminToken}`);
  const courant = v.body.rows.find(x => x.current);
  assert.ok(courant.geom.units > 0, "le millésime compte ses contours");
  assert.ok(courant.geom.parNiveau.length > 0, "et les détaille par niveau");
  assert.ok(courant.geom.parNiveau.every(x => x.units > 0 && x.points > 0));

  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(st.body.geoVersion.geom.units, courant.geom.units,
    "la cartographie sait dès le premier rendu s'il y a un fond de carte");
});

test("contours : un contour comble les coordonnées manquantes sans écraser les existantes", async () => {
  const v = db.prepare("SELECT id FROM geo_version WHERE is_current=1").get();
  /* Une unité qu'on prive de coordonnées, comme le ferait un découpage sans centroïdes. */
  const cible = db.prepare(`SELECT u.pcode, u.name, p.name parent FROM geo_unit u
    LEFT JOIN geo_unit p ON p.pcode=u.parent_pcode AND p.version_id=u.version_id
    WHERE u.level='adm3' AND u.version_id=? LIMIT 1`).get(v.id);
  db.prepare("UPDATE geo_unit SET lat=NULL, lon=NULL WHERE pcode=? AND version_id=?")
    .run(cible.pcode, v.id);

  /* Une autre, dont on fixe les coordonnées : elles doivent survivre. */
  const gardee = db.prepare(`SELECT u.pcode, u.name, p.name parent FROM geo_unit u
    LEFT JOIN geo_unit p ON p.pcode=u.parent_pcode AND p.version_id=u.version_id
    WHERE u.level='adm3' AND u.version_id=? AND u.pcode<>? LIMIT 1`).get(v.id, cible.pcode);
  db.prepare("UPDATE geo_unit SET lat=-21.5, lon=46.5 WHERE pcode=? AND version_id=?")
    .run(gardee.pcode, v.id);

  await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`)
    .send({ features:[
      { pcode:cible.pcode,  geometry: carre(43, -25, 0.4) },
      { pcode:gardee.pcode, geometry: carre(48, -15, 0.4) },
    ] });

  const a = db.prepare("SELECT lat, lon FROM geo_unit WHERE pcode=? AND version_id=?").get(cible.pcode, v.id);
  assert.ok(a.lat != null && a.lon != null, "l'unité sans coordonnées en a reçu du contour");
  assert.ok(a.lon > 43 && a.lon < 43.5 && a.lat < -24.5, JSON.stringify(a));
  const b = db.prepare("SELECT lat, lon FROM geo_unit WHERE pcode=? AND version_id=?").get(gardee.pcode, v.id);
  assert.equal(b.lat, -21.5, "les coordonnées existantes ne sont pas écrasées");
  assert.equal(b.lon, 46.5);
});

test("contours : import réservé aux administrateurs, lecture ouverte", async () => {
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/geo/geometry?level=adm2")
    .set("Authorization", `Bearer ${te}`)).status, 200, "la lecture sert la carte de tous");
  assert.equal((await request(app).post("/api/geo/geometry").set("Authorization", `Bearer ${te}`)
    .send({ features:[{ pcode:"x", geometry: carre(45,-20,1) }] })).status, 403);
  assert.equal((await request(app).delete("/api/geo/geometry")
    .set("Authorization", `Bearer ${te}`)).status, 403);
});

test("contours : leur retrait est complet et remet le millésime à zéro", async () => {
  const r = await request(app).delete("/api/geo/geometry").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.supprimes > 0);
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(v.body.rows.find(x => x.current).geom.units, 0);
  const lu = await request(app).get("/api/geo/geometry?level=adm3").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(lu.body.features.length, 0);
  assert.equal(lu.body.extent, null);
});

/* ═══════════════════════════════════════════════════════════════════════
   Le pays comme configuration.

   Cette première version sert Madagascar, d'autres suivront. Ce que ces tests
   verrouillent n'est pas le multi-pays simultané — il n'existe pas — mais le fait
   que plus rien de spécifique à Madagascar ne soit écrit dans le code : les
   libellés des niveaux et la devise locale viennent de la configuration, et le
   millésime du découpage sait à quel pays il appartient.
   ═══════════════════════════════════════════════════════════════════════ */

test("pays : Madagascar est configuré, courant, et son vocabulaire est servi", async () => {
  const r = await request(app).get("/api/country").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  const mdg = r.body.rows.find(c => c.code === "MDG");
  assert.ok(mdg, "Madagascar est configuré");
  assert.equal(mdg.current, true);
  assert.equal(mdg.currency, "MGA");
  assert.equal(mdg.levels.adm3.one, "Commune");
  assert.equal(mdg.levels.adm4.many, "Fokontany");
  /* Les cinq niveaux sont nommés : un niveau manquant afficherait son code brut. */
  assert.deepEqual(r.body.levels, ["adm0","adm1","adm2","adm3","adm4"]);
  for(const l of r.body.levels){
    assert.ok(mdg.levels[l]?.one && mdg.levels[l]?.many, `${l} porte ses deux formes`);
  }

  /* L'interface reçoit le vocabulaire avec l'état initial : sans cela, chaque
     écran afficherait « adm3 » le temps d'un aller-retour supplémentaire. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(st.body.country.code, "MDG");
  assert.equal(st.body.country.levels.adm2.many, "Districts");
});

test("pays : le millésime du découpage sait à quel pays il appartient", async () => {
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(v.body.rows.length > 0);
  /* Le jeu d'essai a été semé après la migration : son millésime porte le pays. */
  const lignes = db.prepare("SELECT country FROM geo_version").all();
  assert.ok(lignes.every(x => x.country === "MDG"),
    "tous les millésimes sont rattachés — la migration rattrape les anciens, writeVersion les nouveaux");
});

test("pays : la devise d'un contrat vient de la configuration, non du code", async () => {
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const t = await request(app).post("/api/tpm").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Prestataire devise", office_id:office.id });
  /* Aucune devise passée : elle doit venir du pays courant, pas d'un « MGA »
     inscrit dans la route. */
  const c = await request(app).post("/api/tpm/contracts").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:t.body.id, ref:"CTR-DEVISE", ceiling:1_000_000 });
  assert.equal(c.status, 201);
  assert.equal(db.prepare("SELECT currency FROM tpm_contract WHERE id=?").get(c.body.id).currency,
    "MGA", "la devise locale du pays courant");

  /* On change la devise du pays : un contrat créé ensuite la reprend. */
  const mdg = db.prepare("SELECT * FROM country WHERE code='MDG'").get();
  await request(app).put("/api/country/MDG").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:mdg.name, currency:"EUR", levels:JSON.parse(mdg.levels),
            lat:mdg.lat, lon:mdg.lon, active:true, rev:mdg.rev });
  const c2 = await request(app).post("/api/tpm/contracts").set("Authorization", `Bearer ${adminToken}`)
    .send({ tpm_id:t.body.id, ref:"CTR-DEVISE-2", ceiling:1_000_000 });
  assert.equal(db.prepare("SELECT currency FROM tpm_contract WHERE id=?").get(c2.body.id).currency, "EUR");

  /* Remis en état : la base d'essai ne doit pas rester en euros. */
  const maj = db.prepare("SELECT rev FROM country WHERE code='MDG'").get();
  await request(app).put("/api/country/MDG").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:mdg.name, currency:"MGA", levels:JSON.parse(mdg.levels),
            lat:mdg.lat, lon:mdg.lon, active:true, rev:maj.rev });
});

test("pays : ajouter un pays exige les cinq niveaux et un code ISO à trois lettres", async () => {
  const niv = { adm0:{one:"Pays",many:"Pays"}, adm1:{one:"Province",many:"Provinces"},
    adm2:{one:"Territoire",many:"Territoires"}, adm3:{one:"Secteur",many:"Secteurs"},
    adm4:{one:"Groupement",many:"Groupements"} };

  const codeCourt = await request(app).post("/api/country").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"CD", name:"RD Congo", currency:"CDF", levels:niv });
  assert.equal(codeCourt.status, 422);

  const incomplet = await request(app).post("/api/country").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"COD", name:"RD Congo", currency:"CDF",
            levels:{ adm1:niv.adm1, adm2:niv.adm2 } });
  assert.equal(incomplet.status, 422, "les cinq niveaux sont exigés");

  const ok = await request(app).post("/api/country").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"cod", name:"RD Congo", currency:"CDF", levels:niv, lat:-4.0, lon:21.7 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.country.code, "COD", "le code est normalisé en majuscules");
  assert.equal(ok.body.country.current, false, "ajouter un pays ne le rend pas courant");
  assert.equal(ok.body.country.versions, 0, "et il n'a aucun découpage");

  const dup = await request(app).post("/api/country").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"COD", name:"Congo bis", currency:"CDF", levels:niv });
  assert.equal(dup.status, 409);
});

test("pays : chaque pays garde son millésime, et l'absence de découpage est dite", async () => {
  const avant = db.prepare("SELECT id FROM geo_version WHERE country='MDG' AND is_current=1").get();
  assert.ok(avant, "Madagascar a un millésime actif avant le changement");

  const r = await request(app).put("/api/country/COD/current").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.current.code, "COD");
  assert.equal(r.body.current.levels.adm3.one, "Secteur", "le vocabulaire a suivi");
  /* Aucun découpage pour la RDC : l'appelant est averti, et rien n'est présenté à
     sa place. Afficher la géographie de Madagascar sous un vocabulaire congolais
     serait l'erreur la plus difficile à voir de toutes. */
  assert.equal(r.body.referentiel, null);
  assert.ok(/Aucun découpage/.test(r.body.avertissement || ""), r.body.avertissement);

  /* Le millésime de Madagascar N'EST PAS désactivé : chaque pays garde le sien.
     Ma première version le désactivait puis « reprenait le plus récent » au
     retour — ce qui aurait remplacé sans le dire un millésime délibérément
     choisi. */
  assert.equal(db.prepare("SELECT is_current FROM geo_version WHERE id=?").get(avant.id).is_current, 1,
    "le millésime malgache reste celui de Madagascar");

  /* Mais il n'est pas servi : le référentiel courant est celui du pays courant,
     et l'application répond vide plutôt que d'échouer ou de mentir. */
  const g = await request(app).get("/api/geo/levels").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.rows, []);
  const cov = await request(app).get("/api/geo/coverage").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(cov.status, 200);

  /* Retour à Madagascar : c'est exactement le même millésime qui ressort. */
  const retour = await request(app).put("/api/country/MDG/current")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(retour.body.current.code, "MDG");
  assert.equal(retour.body.referentiel?.id, avant.id, "le millésime choisi est retrouvé, pas remplacé");
  const g2 = await request(app).get("/api/geo/levels").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(g2.body.rows.length > 0, "et le découpage est de nouveau servi");
});

test("pays : le pays courant ne se supprime ni ne se désactive", async () => {
  const del = await request(app).delete("/api/country/MDG").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 409);
  const mdg = db.prepare("SELECT * FROM country WHERE code='MDG'").get();
  const off = await request(app).put("/api/country/MDG").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:mdg.name, currency:mdg.currency, levels:JSON.parse(mdg.levels),
            active:false, rev:mdg.rev });
  assert.equal(off.status, 409);
  assert.ok(/pays courant/.test(off.body.error), off.body.error);

  /* Un pays sans découpage se supprime ; un pays qui en porte, non. */
  assert.equal((await request(app).delete("/api/country/COD")
    .set("Authorization", `Bearer ${adminToken}`)).status, 200);
});

test("pays : la configuration est réservée aux administrateurs, la lecture ouverte", async () => {
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/country").set("Authorization", `Bearer ${te}`)).status, 200,
    "tout compte lit le vocabulaire : ses écrans en ont besoin");
  for(const [m, chemin] of [["post","/api/country"], ["put","/api/country/MDG"],
                            ["put","/api/country/MDG/current"], ["delete","/api/country/MDG"]]){
    const r = await request(app)[m](chemin).set("Authorization", `Bearer ${te}`).send({ name:"X" });
    assert.equal(r.status, 403, `${m.toUpperCase()} ${chemin}`);
  }
});

/* ════════════════════════════════════════════════════════════════════════
   Une instance, plusieurs pays.

   Le cloisonnement se lit sur trois couches — pays, bureau, périmètre
   géographique — et c'est la première qui manquait. Ces essais la prennent par
   les deux bouts : ce qu'un compte borné NE voit pas, et ce qu'il ne peut pas
   écrire même en forçant le formulaire. La seconde question est la vraie : un
   filtre en lecture qu'une écriture contourne ne protège rien.
   ════════════════════════════════════════════════════════════════════════ */
const NIV_COD = { adm0:{one:"Pays",many:"Pays"}, adm1:{one:"Province",many:"Provinces"},
  adm2:{one:"Territoire",many:"Territoires"}, adm3:{one:"Secteur",many:"Secteurs"},
  adm4:{one:"Groupement",many:"Groupements"} };
const multi = {};

test("multi-pays : deux pays coexistent, chacun avec ses bureaux", async () => {
  const cod = await request(app).post("/api/country").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"COD", name:"RD Congo", currency:"CDF", levels:NIV_COD, lat:-4.0, lon:21.7 });
  assert.equal(cod.status, 201);

  /* L'administrateur de l'instance n'est borné à aucun pays : il désigne celui du
     bureau qu'il crée. Sans `country_code`, le bureau irait dans le pays par défaut
     de l'instance — ce qui est le comportement voulu, mais pas ce qu'on veut ici. */
  const kin = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau de Kinshasa", kind:"field", country_code:"COD" });
  assert.equal(kin.status, 201);
  assert.equal(kin.body.office.country_code, "COD");
  multi.kinshasa = kin.body.office.id;

  const mdg = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau de Fianarantsoa", kind:"field" });
  assert.equal(mdg.status, 201);
  assert.equal(mdg.body.office.country_code, "MDG",
    "sans pays demandé, le bureau va dans le pays par défaut de l'instance");
  multi.fianar = mdg.body.office.id;

  /* Un pays inexistant est refusé, pas rattaché au hasard : une entité qu'on
     retrouverait des mois plus tard dans le mauvais pays est pire qu'un refus. */
  const nulPart = await request(app).post("/api/offices").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Bureau de nulle part", kind:"field", country_code:"ZZZ" });
  assert.equal(nulPart.status, 422);
  assert.ok(/n'est pas configuré/.test(nulPart.body.error), nulPart.body.error);
});

test("multi-pays : un administrateur non borné voit tout, l'en-tête le place dans un pays", async () => {
  const tout = await request(app).get("/api/offices").set("Authorization", `Bearer ${adminToken}`);
  const codes = tout.body.offices.map(o => o.id);
  assert.ok(codes.includes(multi.kinshasa) && codes.includes(multi.fianar),
    "sans en-tête, l'administrateur d'instance voit les bureaux des deux pays");

  const congo = await request(app).get("/api/offices")
    .set("Authorization", `Bearer ${adminToken}`).set("X-MEMS-Country", "COD");
  const ids = congo.body.offices.map(o => o.id);
  assert.ok(ids.includes(multi.kinshasa), "placé au Congo, il voit Kinshasa");
  assert.ok(!ids.includes(multi.fianar), "et plus Fianarantsoa");

  /* Le vocabulaire suit le même en-tête : c'est la même requête qui nomme et qui
     filtre, et deux réponses différentes seraient invérifiables à l'écran. */
  const etat = await request(app).get("/api/state")
    .set("Authorization", `Bearer ${adminToken}`).set("X-MEMS-Country", "COD");
  assert.equal(etat.body.country.code, "COD");
  assert.equal(etat.body.country.levels.adm3.one, "Secteur");
  assert.ok(etat.body.countries.some(c => c.code === "MDG"),
    "un compte non borné reçoit la liste des pays : c'est lui qui porte le sélecteur");
});

test("multi-pays : un compte borné ne voit pas l'autre pays, et n'y écrit pas", async () => {
  /* Un administrateur DE PAYS : il administre son pays, pas l'instance. Le rôle dit
     ce qu'on peut faire, le pays où — ce sont deux axes distincts. */
  const cr = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"admin-mdg@test.local", password:"AdminMadagascar1", first_name:"Ravo",
            role:"admin", country_code:"MDG", tabs:["home"], active:true });
  assert.equal(cr.status, 201);
  assert.equal(cr.body.user.country_code, "MDG");
  const mg = (await login("admin-mdg@test.local", "AdminMadagascar1")).body.token;
  multi.mgToken = mg;

  const vus = await request(app).get("/api/offices").set("Authorization", `Bearer ${mg}`);
  const ids = vus.body.offices.map(o => o.id);
  assert.ok(ids.includes(multi.fianar));
  assert.ok(!ids.includes(multi.kinshasa), "le bureau congolais n'existe pas pour lui");

  /* L'en-tête ne lui sert à rien : un compte borné ne sort pas de son pays, et sa
     demande est ignorée silencieusement — lui répondre 403 lui apprendrait qu'un
     autre pays existe. */
  const force = await request(app).get("/api/offices")
    .set("Authorization", `Bearer ${mg}`).set("X-MEMS-Country", "COD");
  assert.equal(force.status, 200);
  assert.ok(!force.body.offices.some(o => o.id === multi.kinshasa));

  /* Le bureau congolais est introuvable, pas refusé : un 403 confirmerait qu'il
     existe, et un identifiant se devine par essais. */
  const modif = await request(app).put(`/api/offices/${multi.kinshasa}`)
    .set("Authorization", `Bearer ${mg}`).send({ name:"Bureau détourné", kind:"field" });
  assert.equal(modif.status, 404);

  /* Et l'écriture ne suit pas le formulaire : le pays du compte s'impose. */
  const cree = await request(app).post("/api/offices").set("Authorization", `Bearer ${mg}`)
    .send({ name:"Bureau tenté au Congo", kind:"field", country_code:"COD" });
  assert.equal(cree.status, 201);
  assert.equal(cree.body.office.country_code, "MDG",
    "le pays du compte gagne contre le champ du formulaire");
  await request(app).delete(`/api/offices/${cree.body.office.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
});

test("multi-pays : les sites suivent le pays de leur bureau", async () => {
  const site = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"COD-001", name:"Site congolais", office_id:multi.kinshasa,
            status:"Active", activity_tag:"ACT1" });
  assert.equal(site.status, 201);
  multi.siteCod = site.body.site.id;

  /* La table `sites` ne porte pas de pays — décision assumée de la migration 015,
     pour qu'il ne puisse pas diverger de celui du bureau. Le filtre passe donc par
     le bureau, et c'est ce qu'on vérifie ici. */
  const liste = await request(app).get("/api/sites?limit=2000")
    .set("Authorization", `Bearer ${multi.mgToken}`);
  assert.ok(!liste.body.rows.some(s => s.id === multi.siteCod));
  assert.equal((await request(app).get(`/api/sites/${multi.siteCod}`)
    .set("Authorization", `Bearer ${multi.mgToken}`)).status, 404);

  const etat = await request(app).get("/api/state").set("Authorization", `Bearer ${multi.mgToken}`);
  assert.ok(!etat.body.sites.some(s => s.id === multi.siteCod));
  assert.deepEqual(etat.body.countries, [],
    "un compte borné ne reçoit pas la liste des pays : il n'a rien à choisir");

  /* Rattacher un site à un bureau d'un autre pays est refusé à l'écriture. Sans
     cela, le filtre en lecture ne protégerait rien : il suffirait de changer un
     champ du formulaire. */
  const ailleurs = await request(app).post("/api/sites").set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ code:"MDG-XX1", name:"Site détourné", office_id:multi.kinshasa,
            status:"Active", activity_tag:"ACT1" });
  assert.equal(ailleurs.status, 422);
  assert.ok(/périmètre/.test(ailleurs.body.error), ailleurs.body.error);

  /* Même chose par la modification groupée, qui est la porte la plus large :
     elle prend une liste d'identifiants et un champ, dont `office_id`. */
  const groupe = await request(app).post("/api/sites/bulk")
    .set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ ids:[multi.siteCod], field:"office_id", value:multi.fianar });
  assert.equal(groupe.body.updated, 0, "aucun site d'un autre pays n'est touché");
  assert.equal(db.prepare("SELECT office_id FROM sites WHERE id=?").get(multi.siteCod).office_id,
    multi.kinshasa);
  const vers = await request(app).post("/api/sites/bulk")
    .set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ ids:[multi.siteCod], field:"office_id", value:multi.kinshasa });
  assert.equal(vers.status, 422, "et le bureau de destination est vérifié lui aussi");

  /* Les agrégats ne mélangent pas deux pays : un total faux est pire qu'un total
     absent, parce qu'on le croit. */
  const resume = await request(app).get("/api/analytics/summary")
    .set("Authorization", `Bearer ${multi.mgToken}`);
  const tous = await request(app).get("/api/analytics/summary")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(tous.body.sites, resume.body.sites + 1, "le seul site congolais est en dehors");
});

test("multi-pays : un administrateur de pays n'administre ni les autres pays ni les comptes sans pays", async () => {
  const comptes = await request(app).get("/api/users").set("Authorization", `Bearer ${multi.mgToken}`);
  assert.equal(comptes.status, 200);
  assert.ok(comptes.body.users.every(u => u.country_code === "MDG"),
    "ni les comptes d'un autre pays, ni les comptes non bornés — ces derniers voient tout");
  assert.ok(!comptes.body.users.some(u => u.email === "admin@test.local"));

  /* Le compte non borné est hors de portée : le modifier serait prendre la main sur
     toute l'instance depuis un pays. */
  const cible = db.prepare("SELECT id FROM users WHERE email='admin@test.local'").get();
  const pris = await request(app).put(`/api/users/${cible.id}`)
    .set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ email:"admin@test.local", first_name:"Repris", role:"viewer", tabs:[], active:true });
  assert.equal(pris.status, 404);

  /* Créer un compte sans pays serait créer un compte plus large que soi : refusé
     explicitement, parce que l'appelant a le droit d'administrer et doit savoir ce
     qu'il ne peut pas faire. */
  const global = await request(app).post("/api/users").set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ email:"global@test.local", password:"GlobalMotDePasse1", first_name:"Global",
            role:"viewer", country_code:"COD", tabs:["home"], active:true });
  assert.equal(global.status, 403);
  assert.ok(/votre pays/.test(global.body.error), global.body.error);

  const sien = await request(app).post("/api/users").set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ email:"local-mdg@test.local", password:"LocalMotDePasse1", first_name:"Local",
            role:"viewer", tabs:["home"], active:true });
  assert.equal(sien.status, 201);
  assert.equal(sien.body.user.country_code, "MDG",
    "un compte créé sans pays reçoit celui de son créateur, non l'absence de pays");
});

test("multi-pays : prestataires et plan MRE sont rattachés, et la référence MRE est unique par pays", async () => {
  const tp = await request(app).post("/api/tpm").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Prestataire congolais", office_id:multi.kinshasa, country_code:"COD" });
  assert.equal(tp.status, 201);
  const vus = await request(app).get("/api/tpm").set("Authorization", `Bearer ${multi.mgToken}`);
  assert.ok(!vus.body.rows.some(x => x.id === tp.body.id));
  assert.equal((await request(app).put(`/api/tpm/${tp.body.id}`)
    .set("Authorization", `Bearer ${multi.mgToken}`).send({ name:"Détourné" })).status, 404);

  /* La référence d'une activité MRE était unique pour toute l'instance : le premier
     pays à saisir « ME-2026-01 » l'interdisait au second, avec un message parlant
     d'un doublon invisible pour lui. Elle est désormais unique par pays. */
  const a1 = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, ref:"ME-2026-01", title:"Suivi de processus Madagascar", kind:"suivi" });
  assert.equal(a1.status, 201);
  const memeP = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, ref:"ME-2026-01", title:"Doublon dans le même pays", kind:"suivi" });
  assert.equal(memeP.status, 409, "dans un même pays, la référence reste unique");

  const a2 = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .set("X-MEMS-Country", "COD")
    .send({ year:2026, ref:"ME-2026-01", title:"Suivi de processus Congo", kind:"suivi" });
  assert.equal(a2.status, 201, "le même numéro est libre dans un autre pays");
  assert.equal(db.prepare("SELECT country_code FROM mre_activity WHERE id=?").get(a2.body.activity.id)
    .country_code, "COD");

  const planMg = await request(app).get("/api/mre?year=2026").set("Authorization", `Bearer ${multi.mgToken}`);
  assert.ok(planMg.body.rows.some(x => x.id === a1.body.activity.id));
  assert.ok(!planMg.body.rows.some(x => x.id === a2.body.activity.id),
    "deux plans pays ne s'additionnent pas dans un même total");
  assert.equal((await request(app).put(`/api/mre/${a2.body.activity.id}`)
    .set("Authorization", `Bearer ${multi.mgToken}`)
    .send({ year:2026, title:"Détourné", kind:"suivi" })).status, 404);
});

/* ════════════════════════════════════════════════════════════════════════
   Rattachement par les coordonnées.

   Le cas le plus courant d'un registre repris d'un tableur : le site a été relevé
   au GPS, son nom de commune saisi autrement — ou pas du tout. Il apparaît sur la
   carte et n'entre dans aucun total.
   ════════════════════════════════════════════════════════════════════════ */
/* Les essais qui précèdent importent des millésimes et effacent des contours : on ne
   s'appuie donc pas sur ce qu'ils laissent derrière eux. Chaque essai de rattachement
   pose SON contour, sur le millésime courant, et le retire ensuite. C'est aussi ce
   qui rend le test indépendant de toute géographie particulière. */
function poserContour(){
  const v = db.prepare("SELECT * FROM geo_version WHERE is_current=1").get();
  const u = db.prepare("SELECT * FROM geo_unit WHERE version_id=? AND level='adm3' LIMIT 1").get(v.id);
  assert.ok(u, "le millésime courant porte au moins une commune");
  /* Un carré d'un dixième de degré autour d'un point connu. */
  const lat = -21.5, lon = 46.5, d = 0.05;
  const g = JSON.stringify({ type:"Polygon", coordinates:[[
    [lon-d, lat-d], [lon+d, lat-d], [lon+d, lat+d], [lon-d, lat+d], [lon-d, lat-d]]] });
  db.prepare(`INSERT OR REPLACE INTO geo_geom
    (pcode,version_id,level,geometry,simple,min_lon,min_lat,max_lon,max_lat,points,points_simple)
    VALUES (?,?,?,?,?,?,?,?,?,5,5)`)
    .run(u.pcode, v.id, "adm3", g, g, lon-d, lat-d, lon+d, lat+d);
  return { v, u, lat, lon };
}
const retirerContour = (v) => db.prepare("DELETE FROM geo_geom WHERE version_id=?").run(v.id);

test("coordonnées : un point dans un contour est rattaché avec certitude", async () => {
  const { v, u, lat, lon } = poserContour();
  const r = await request(app).post("/api/geo/locate").set("Authorization", `Bearer ${adminToken}`)
    .send({ lat, lon });
  assert.equal(r.status, 200);
  assert.equal(r.body.methode, "contour", "le point est dans le polygone, pas à côté");
  assert.equal(r.body.confiance, "certaine");
  assert.equal(r.body.distance, 0);
  assert.equal(r.body.pcode, u.pcode);
  assert.ok(r.body.path.includes(u.pcode), "le chemin porte ses ancêtres");

  /* Juste à l'extérieur du carré : plus de certitude géométrique. Selon la distance
     aux centres connus, la réponse est une proximité ou rien — dans les deux cas,
     ce n'est PAS « contour », et c'est tout ce qui compte ici. */
  const dehors = await request(app).post("/api/geo/locate").set("Authorization", `Bearer ${adminToken}`)
    .send({ lat: lat + 0.5, lon: lon + 0.5 });
  assert.notEqual(dehors.body.methode, "contour");
  retirerContour(v);
});

test("coordonnées : un point très loin ne se rattache pas au hasard", async () => {
  /* Plein océan Austral, à des milliers de kilomètres : aucune unité ne doit être
     proposée. Un outil qui rendrait « commune X » ici ferait entrer n'importe quoi
     dans les totaux, avec l'assurance d'un calcul. */
  const r = await request(app).post("/api/geo/locate").set("Authorization", `Bearer ${adminToken}`)
    .send({ lat: -60, lon: 0 });
  assert.equal(r.status, 200);
  assert.ok(r.body.error, "aucune unité n'est proposée");
  assert.ok(!r.body.pcode);

  /* Et des coordonnées hors plage sont refusées à la porte. */
  const hors = await request(app).post("/api/geo/locate").set("Authorization", `Bearer ${adminToken}`)
    .send({ lat: 120, lon: 500 });
  assert.equal(hors.status, 422);
});

test("coordonnées : les sites orphelins sont proposés, puis rattachés sur décision", async () => {
  const { v, u, lat, lon } = poserContour();
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const id = "site_orphelin_test";
  /* Créé directement en base : la route de création rattache désormais toute seule,
     et c'est justement ce qu'on vérifie dans l'essai suivant. */
  db.prepare(`INSERT INTO sites (id,code,name,status,office_id,lat,lon,activity_tag)
              VALUES (?,?,?,'Active',?,?,?,'ACT1')`)
    .run(id, "ORPH-01", "Site sans rattachement", office.id, lat, lon);

  const prop = await request(app).get("/api/geo/orphans").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(prop.status, 200);
  const mien = prop.body.rows.find(x => x.id === id);
  assert.ok(mien, "l'orphelin figure dans les propositions");
  assert.equal(mien.propose?.methode, "contour");
  assert.equal(mien.propose?.pcode, u.pcode);

  /* Rien n'a encore été écrit : on propose d'abord, on applique ensuite. Trois cents
     rattachements écrits sans être montrés seraient invérifiables. */
  assert.equal(db.prepare("SELECT geo_pcode FROM sites WHERE id=?").get(id).geo_pcode, null);

  const pose = await request(app).post("/api/geo/attach").set("Authorization", `Bearer ${adminToken}`)
    .send({ ids:[id] });
  assert.equal(pose.status, 200);
  assert.equal(pose.body.rattaches, 1);
  const apres = db.prepare("SELECT geo_pcode, adm3 FROM sites WHERE id=?").get(id);
  assert.equal(apres.geo_pcode, u.pcode);
  assert.ok(apres.adm3, "les libellés administratifs descendent du rattachement");

  db.prepare("DELETE FROM sites WHERE id=?").run(id);
  retirerContour(v);
});

test("coordonnées : un site créé avec des coordonnées est rattaché sans qu'on le demande", async () => {
  const { v, u, lat, lon } = poserContour();
  const r = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"AUTO-01", name:"Site relevé au GPS", status:"Active",
            activity_tag:"ACT1", lat, lon });
  assert.equal(r.status, 201);
  assert.equal(r.body.site.geo_pcode, u.pcode, "le rattachement est trouvé à partir du point");
  assert.ok(r.body.site.adm3, "et les libellés en descendent");

  /* Un site SANS coordonnées reste sans rattachement : aucun calcul ne remplace un
     relevé de terrain, et inventer une commune serait pire que de ne rien dire. */
  const sans = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"AUTO-02", name:"Site sans coordonnées", status:"Active", activity_tag:"ACT1" });
  assert.equal(sans.status, 201);
  assert.equal(sans.body.site.geo_pcode, null);

  db.prepare("DELETE FROM sites WHERE id IN (?,?)").run(r.body.site.id, sans.body.site.id);
  retirerContour(v);
});
