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
test("cloisonnement : visites, distributions, paramètres et journal suivent le bureau", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${t}`);
  assert.equal(st.status, 200);

  /* Chaque collection doit contenir exactement les lignes du bureau — ni plus, ni moins —
     et le jeu d'essai doit comporter des lignes d'ailleurs, sans quoi le test ne prouve rien. */
  for(const [table, key, label] of [["visits","visits","visites"],
                                    ["pdd","pdd","distributions"],
                                    ["coverage_params","params","paramètres"]]){
    const sien = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE office_id=?`).get(office.id).c;
    const ailleurs = db.prepare(
      `SELECT COUNT(*) c FROM ${table} WHERE office_id IS NULL OR office_id<>?`).get(office.id).c;
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
