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

  /* Retirer une ligne du corps doit la supprimer en base. */
  const r2 = await request(app).put("/api/collections/reportTemplates")
    .set("Authorization", `Bearer ${adminToken}`).send({ rows: rows.slice(0, 1) });
  assert.equal(r2.body.removed, rows.length - 1);
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
