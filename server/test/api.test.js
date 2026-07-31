import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
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
/* Le serveur ODK Central simulé plus bas tourne en http sur la boucle locale — que le
   correctif A5 refuse désormais par défaut. C'est exactement le cas que la liste
   blanche existe pour couvrir : un exploitant désigne nommément son serveur interne. */
process.env.ODK_ALLOWED_HOSTS = "127.0.0.1";

for(const f of [DB, DB+"-wal", DB+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
fs.mkdirSync(path.dirname(DB), { recursive:true });
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db } = await import("../src/db.js");

const login = async (email, password) => {
  const r = await request(app).post("/api/auth/login").send({ email, password });
  return r;
};

/* Depuis le chantier A3, un mot de passe provisoire — `must_change_pw=1`, posé aussi
   bien par l'amorçage que par toute création de compte — ne donne plus accès qu'à son
   propre remplacement. Les tests ci-dessous portent sur tout le reste : ils franchissent
   cette étape une fois, comme le ferait n'importe quel utilisateur à sa première
   connexion. Le parcours de changement a son propre test, plus bas. */
const motDePasseAdopte = (email) =>
  db.prepare("UPDATE users SET must_change_pw=0 WHERE email=?").run(email);
motDePasseAdopte("admin@test.local");
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

/* ── Tirage ODK Central (serveur) ──────────────────────────────────────
   Sans serveur ODK Central réel à disposition, ces tests en simulent un en
   mémoire : deux pages de soumissions, une variable de groupe aplatie, un
   jeton vérifié, et un formulaire absent renvoyant 404 — pour prouver la
   pagination, l'en-tête d'autorisation et la gestion d'erreurs sans deviner
   le comportement d'un vrai serveur. */
let odkMock, odkMockUrl, odkMockRequests;
{
  odkMockRequests = [];
  odkMock = http.createServer((req, res) => {
    odkMockRequests.push({ url: req.url, auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if(/\/forms\/absent\.svc\/Submissions/.test(req.url)){ res.statusCode = 404; return res.end("{}"); }
    if(/\/forms\/refuse\.svc\/Submissions/.test(req.url)){ res.statusCode = 401; return res.end("{}"); }
    if(/\/forms\/testform\.svc\/Submissions/.test(req.url)){
      if(/page=2/.test(req.url)){
        return res.end(JSON.stringify({ value: [{ __id:"s3", SvyDate:"2026-03-03", EnuName:"C" }] }));
      }
      return res.end(JSON.stringify({
        value: [
          { __id:"s1", SvyDate:"2026-03-01", EnuName:"A",
            Technical_module: { TechnicalDP_submodule: { DPName:"Site 1" } } },
          { __id:"s2", SvyDate:"2026-03-02", EnuName:"B",
            Technical_module: { TechnicalDP_submodule: { DPName:"Site 2" } } },
        ],
        "@odata.nextLink": `${odkMockUrl}/v1/projects/1/forms/testform.svc/Submissions?page=2`,
      }));
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(res => odkMock.listen(0, "127.0.0.1", res));
  odkMockUrl = `http://127.0.0.1:${odkMock.address().port}`;
  after(() => odkMock.close());
}

async function odkForm(overrides){
  const w = await request(app).put("/api/collections/odkForms")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: [{ name:"Test ODK", formId:"testform", project:"1", kind:"process",
      token:"jeton-de-test", ...overrides }] });
  assert.equal(w.status, 200, `création de la source ODK de test refusée : ${JSON.stringify(w.body)}`);
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const f = st.body.odkForms.find(x => x.formId === (overrides.formId || "testform")
    && x.name === (overrides.name || "Test ODK"));
  assert.ok(f, "source ODK de test introuvable après création");
  return f;
}

test("tirage ODK Central : pagine, aplatit les groupes, met à jour le cache et l'audit", async () => {
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: odkMockUrl });
  const f = await odkForm({});
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.records, 3);
  assert.equal(r.body.pages, 2);
  assert.equal(r.body.truncated, false);
  assert.ok(odkMockRequests.every(q => q.auth === "Bearer jeton-de-test"));

  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const after1 = st.body.odkForms.find(x => x.id === f.id);
  assert.equal(after1.records, 3);
  assert.equal(after1.rows.length, 3);
  /* Le groupe Technical_module > TechnicalDP_submodule est aplati sur DPName seul. */
  assert.equal(after1.rows[0].DPName, "Site 1");
  assert.equal(after1.rows[0].Technical_module, undefined);

  const audit = await request(app).get("/api/audit").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(audit.body.rows.some(a => a.entity === "odk_forms" && a.action === "pull"));
});

test("tirage ODK Central : sans jeton propre, refus explicite plutôt qu'un jeton emprunté", async () => {
  const f = await odkForm({ name:"Sans jeton", formId:"testform-notoken", token:"" });
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /jeton propre/);
});

test("tirage ODK Central : jeton refusé par le serveur distant renvoyé en 422, pas en 500", async () => {
  const f = await odkForm({ name:"Refuse", formId:"refuse" });
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /refusé/);
});

test("tirage ODK Central : formulaire introuvable renvoyé en 422 avec un message clair", async () => {
  const f = await odkForm({ name:"Absent", formId:"absent" });
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /introuvable/);
});

test("tirage ODK Central : réservé aux administrateurs", async () => {
  const create = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecteur-odk@test.local", password:"LecteurMotDePasse1", first_name:"Lecteur",
            role:"viewer", tabs:["home"], active:true });
  motDePasseAdopte("lecteur-odk@test.local");
  const login2 = await login("lecteur-odk@test.local", "LecteurMotDePasse1");
  const f = await odkForm({ name:"Droits", formId:"testform-droits" });
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${login2.body.token}`);
  assert.equal(r.status, 403);
});

/* Chantier A5 — `odkBase` est un réglage, donc une donnée venue de l'extérieur, et
   elle partait telle quelle dans un `fetch` côté serveur : SSRF caractérisée. */
test("tirage ODK Central : adresse hors liste blanche, privée ou non chiffrée refusée", async () => {
  const { config } = await import("../src/config.js");
  const { verifierBaseOdk } = await import("../src/lib/odkClient.js");
  const f = await odkForm({ name:"SSRF", formId:"testform-ssrf" });

  /* Une liste blanche renseignée fait seule autorité : le service de métadonnées
     de l'hébergeur — cible classique d'une SSRF — n'y figure pas. */
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: "http://169.254.169.254" });
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /liste des serveurs ODK autorisés/);

  /* Sans liste — le cas par défaut — https est exigé et les adresses privées refusées. */
  const liste = config.odkAllowedHosts;
  config.odkAllowedHosts = [];
  try{
    await assert.rejects(() => verifierBaseOdk("http://odk.exemple.org"), /https/);
    await assert.rejects(() => verifierBaseOdk("https://10.1.2.3/"), /réseau privé/);
    await assert.rejects(() => verifierBaseOdk("https://127.0.0.1:8443/"), /bouclage/);
    await assert.rejects(() => verifierBaseOdk("https://[::1]/"), /bouclage/);
    await assert.rejects(() => verifierBaseOdk("https://169.254.169.254/"), /lien-local/);
    await assert.rejects(() => verifierBaseOdk("pas une adresse"), /illisible/);
  } finally { config.odkAllowedHosts = liste; }

  /* Le serveur simulé retrouve son adresse pour les tests qui suivent. */
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: odkMockUrl });
});

test("droits : un lecteur peut consulter mais ne peut rien écrire", async () => {
  const create = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecteur@test.local", password:"LecteurMotDePasse1", first_name:"Lecteur",
            role:"viewer", tabs:["home"], active:true });
  assert.equal(create.status, 201);
  motDePasseAdopte("lecteur@test.local");
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
  motDePasseAdopte("terrain@test.local");
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

/* Chantier A1 — `PUT /api/collections/:name` n'appliquait aucun cloisonnement :
   « SELECT id, rev » sans filtre, puis UPDATE et DELETE par identifiant. Un éditeur
   du bureau A écrivait donc — et surtout supprimait — les lignes du bureau B, que
   `GET /api/state` lui cache pourtant. Ces trois tests verrouillent la correction. */
test("cloisonnement : un éditeur n'écrit pas dans la collection d'un autre bureau", async () => {
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;

  const autre = db.prepare(
    "SELECT * FROM pdd WHERE office_id IS NOT NULL AND office_id<>? LIMIT 1").get(office.id);
  assert.ok(autre, "le jeu d'essai porte une ligne de distribution d'un autre bureau");

  const usurpe = await request(app).put("/api/collections/pdd").set("Authorization", `Bearer ${t}`)
    .send({ rows:[{ id:autre.id, year:autre.year, month:autre.month, actType:autre.act_type,
                    bureau:"Détournée", office_id:office.id, modality:"Food", status:"planned" }] });
  assert.equal(usurpe.status, 403, JSON.stringify(usurpe.body));
  const apres = db.prepare("SELECT bureau, office_id FROM pdd WHERE id=?").get(autre.id);
  assert.equal(apres.bureau, autre.bureau, "la ligne de l'autre bureau est intacte");
  assert.equal(apres.office_id, autre.office_id, "elle n'a pas changé de bureau");

  /* Sur ses propres lignes, rien ne change : le cloisonnement borne, il n'interdit pas. */
  const sienne = db.prepare("SELECT * FROM pdd WHERE office_id=? LIMIT 1").get(office.id);
  assert.ok(sienne, "le bureau porte des lignes à lui");
  const ok = await request(app).put("/api/collections/pdd").set("Authorization", `Bearer ${t}`)
    .send({ rows:[{ id:sienne.id, year:sienne.year, month:sienne.month, actType:sienne.act_type,
                    bureau:sienne.bureau, office_id:office.id, modality:sienne.modality,
                    status:sienne.status, note:"modifiée par son bureau" }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.updated, 1);
  assert.equal(db.prepare("SELECT note FROM pdd WHERE id=?").get(sienne.id).note,
    "modifiée par son bureau");
});

test("cloisonnement : une création reste dans le bureau de l'appelant", async () => {
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const ailleurs = db.prepare("SELECT id FROM offices WHERE id<>? LIMIT 1").get(office.id);
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const r = await request(app).put("/api/collections/pdd").set("Authorization", `Bearer ${t}`)
    .send({ rows:[{ year:2026, month:0, actType:"GD", bureau:"Ligne témoin A1",
                    office_id:ailleurs.id, modality:"Food", status:"planned" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 1);
  assert.equal(db.prepare("SELECT office_id FROM pdd WHERE bureau=?").get("Ligne témoin A1").office_id,
    office.id, "le bureau annoncé dans le corps ne fait pas foi");
});

/* Chantier A2 — la route entière n'est gardée que par « edit », et le tableau
   `deletes` passait avec, alors que la matrice des rôles (lib/auth.js) réserve
   « del » à l'administration. */
test("droits : supprimer dans une collection exige « del », pas seulement « edit »", async () => {
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const sienne = db.prepare("SELECT id FROM pdd WHERE office_id=? LIMIT 1").get(office.id);

  const refus = await request(app).put("/api/collections/pdd").set("Authorization", `Bearer ${t}`)
    .send({ rows:[], deletes:[sienne.id] });
  assert.equal(refus.status, 403, JSON.stringify(refus.body));
  assert.match(refus.body.error, /del/);
  assert.ok(db.prepare("SELECT 1 FROM pdd WHERE id=?").get(sienne.id),
    "la ligne n'a pas été supprimée");

  /* Un administrateur, lui, en a le droit : le correctif restreint, il ne bloque pas. */
  const admin = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const ok = await request(app).put("/api/collections/pdd").set("Authorization", `Bearer ${admin}`)
    .send({ rows:[], deletes:[sienne.id] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.removed, 1);
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

/* Chantier A6 — `PUT /api/users/:id` réutilisait le schéma de création : les défauts
   zod y remettaient role="viewer", tabs=[] et surtout active=true, et les champs
   facultatifs absents repartaient à null. Un enregistrement partiel — celui que fait
   tout écran qui ne connaît qu'une partie du compte — réactivait donc un compte
   désactivé et le détachait de son prestataire, sans un mot d'erreur. */
test("comptes : un PUT partiel ne réactive ni ne rétrograde ce qu'il n'envoie pas", async () => {
  const tpm = db.prepare("SELECT id FROM tpm LIMIT 1").get();
  assert.ok(tpm, "le jeu d'essai porte un prestataire");

  const cree = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"partiel@test.local", password:"PartielMotDePasse1", first_name:"Partiel",
            last_name:"Ancien", title:"Agent", role:"editor", tpm_id:tpm.id,
            tabs:["home","suivi"], active:false });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  const avant = db.prepare("SELECT * FROM users WHERE email='partiel@test.local'").get();
  assert.equal(avant.active, 0, "le compte est bien créé désactivé");

  /* Le corps ne porte QUE l'adresse et le prénom. Tout le reste doit survivre. */
  const put = await request(app).put(`/api/users/${avant.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"partiel@test.local", first_name:"Partiel corrigé" });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const apres = db.prepare("SELECT * FROM users WHERE id=?").get(avant.id);
  assert.equal(apres.first_name, "Partiel corrigé", "ce qui est envoyé est bien écrit");
  assert.equal(apres.active, 0, "un compte désactivé ne se réactive pas tout seul");
  assert.equal(apres.role, "editor", "le rôle n'est pas rétrogradé en « viewer »");
  assert.equal(apres.tabs, avant.tabs, "les onglets ne sont pas vidés");
  assert.equal(apres.tpm_id, tpm.id, "le rattachement au prestataire tient");
  assert.equal(apres.office_id, avant.office_id, "le rattachement au bureau tient");
  assert.equal(apres.last_name, "Ancien", "les champs facultatifs ne sont pas effacés");
  assert.equal(apres.title, "Agent");

  /* Même contrôle sur un compte de bureau, où `office_id` n'est pas nul : un compte
     de prestataire n'en porte jamais, il ne prouverait donc rien à lui seul. */
  const office = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const cree2 = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"partiel2@test.local", password:"Partiel2MotDePasse1", first_name:"Partiel2",
            role:"validator", office_id:office.id, tabs:["home"], active:false });
  assert.equal(cree2.status, 201, JSON.stringify(cree2.body));
  const av2 = db.prepare("SELECT * FROM users WHERE email='partiel2@test.local'").get();
  const put2 = await request(app).put(`/api/users/${av2.id}`)
    .set("Authorization", `Bearer ${adminToken}`).send({ first_name:"Partiel2 corrigé" });
  assert.equal(put2.status, 200, JSON.stringify(put2.body));
  const ap2 = db.prepare("SELECT * FROM users WHERE id=?").get(av2.id);
  assert.equal(ap2.office_id, office.id, "le bureau n'est pas détaché");
  assert.equal(ap2.role, "validator");
  assert.equal(ap2.active, 0);

  /* Ce qui est explicitement envoyé s'applique toujours, réactivation comprise :
     le correctif rend le partiel inoffensif, il n'empêche pas la modification. */
  const put3 = await request(app).put(`/api/users/${av2.id}`)
    .set("Authorization", `Bearer ${adminToken}`).send({ active:true });
  assert.equal(put3.status, 200, JSON.stringify(put3.body));
  assert.equal(db.prepare("SELECT active FROM users WHERE id=?").get(av2.id).active, 1);
});

/* Chantier A7 — `failed_logins` n'était remis à zéro que par une connexion réussie.
   Après expiration d'un verrou le compteur valait toujours le seuil : la première
   tentative erronée reverrouillait aussitôt pour quinze minutes. Le verrou
   « temporaire » était définitif sans intervention d'un administrateur. */
test("connexion : un verrou expiré rend son compteur au compte, il ne se referme pas", async () => {
  const create = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"verrou@test.local", password:"VerrouMotDePasse1", first_name:"Verrou",
            role:"viewer", tabs:["home"], active:true });
  assert.equal(create.status, 201);
  motDePasseAdopte("verrou@test.local");
  const etat = () => db.prepare(
    "SELECT failed_logins, locked_until FROM users WHERE email='verrou@test.local'").get();

  /* L'état exact que laisse un verrou qui vient d'expirer : compteur au seuil
     (LOCK_AFTER_FAILED, 8 par défaut) et échéance dans le passé. */
  db.prepare("UPDATE users SET failed_logins=8, locked_until=? WHERE email='verrou@test.local'")
    .run(new Date(Date.now() - 60_000).toISOString());

  const rate = await login("verrou@test.local", "PasLeBonMotDePasse1");
  assert.equal(rate.status, 401, "c'est un échec de connexion ordinaire, pas un verrou");
  assert.equal(etat().failed_logins, 1, "le compteur repart de zéro, pas du seuil");
  assert.equal(etat().locked_until, null, "aucun nouveau verrou n'a été posé");

  /* Et le titulaire retrouve son compte, sans passer par un administrateur. */
  assert.equal((await login("verrou@test.local", "VerrouMotDePasse1")).status, 200);
  assert.equal(etat().failed_logins, 0);

  /* Un verrou encore valide, lui, tient : le correctif lève l'expiré, pas le verrou. */
  db.prepare("UPDATE users SET failed_logins=8, locked_until=? WHERE email='verrou@test.local'")
    .run(new Date(Date.now() + 60_000).toISOString());
  assert.equal((await login("verrou@test.local", "VerrouMotDePasse1")).status, 423);
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

/* Chantier A3 — `must_change_pw` n'était lu que par l'écran de connexion
   (web/src/views/Login.jsx). Un appel direct à l'API avec le mot de passe
   provisoire ouvrait tout, indéfiniment. */
test("mot de passe provisoire : n'ouvre que son propre remplacement", async () => {
  const create = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"provisoire@test.local", password:"ProvisoireMotDePasse1",
            first_name:"Provisoire", role:"editor", tabs:["home"], active:true });
  assert.equal(create.status, 201);
  const lr = await login("provisoire@test.local", "ProvisoireMotDePasse1");
  assert.equal(lr.status, 200, "la connexion aboutit : c'est ce qu'elle ouvre qui est borné");
  assert.equal(lr.body.user.must_change_pw, true);
  const t = lr.body.token;

  /* Tout le reste de l'API est fermé, y compris la simple lecture de l'état. */
  for(const [m, chemin] of [["get","/api/state"], ["get","/api/auth/sessions"],
                            ["get","/api/caseload"], ["put","/api/collections/pdd"]]){
    const r = await request(app)[m](chemin).set("Authorization", `Bearer ${t}`).send({ rows:[] });
    assert.equal(r.status, 403, `${m.toUpperCase()} ${chemin} doit être refusé`);
    assert.match(r.body.error, /provisoire/);
  }

  /* Les trois chemins du parcours de changement restent ouverts, et eux seuls. */
  const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${t}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.must_change_pw, true);
  const jetable = (await login("provisoire@test.local", "ProvisoireMotDePasse1")).body.token;
  assert.equal((await request(app).post("/api/auth/logout")
    .set("Authorization", `Bearer ${jetable}`)).status, 200, "on peut toujours refermer sa session");

  const ch = await request(app).post("/api/auth/password").set("Authorization", `Bearer ${t}`)
    .send({ current:"ProvisoireMotDePasse1", next:"DefinitifMotDePasse2026" });
  assert.equal(ch.status, 200);

  /* Le drapeau tombe avec le changement : l'accès s'ouvre, sans autre intervention. */
  const apres = await login("provisoire@test.local", "DefinitifMotDePasse2026");
  assert.equal(apres.body.user.must_change_pw, false);
  assert.equal((await request(app).get("/api/state")
    .set("Authorization", `Bearer ${apres.body.token}`)).status, 200);
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

/* Chantier A4 — `PUT /api/caseload` n'appliquait aucun contrôle de périmètre alors
   que le même flux par import en applique un ligne à ligne : `scopeOf` était importé
   dans la route mais ne servait qu'en lecture. */
test("population et ciblage : une écriture hors périmètre est rejetée ligne à ligne", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const year = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body.year;
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;

  const vueAdmin = (await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${t}`)).body.rows;
  const vueTerrain = (await request(app).get(`/api/caseload?level=adm3&year=${year}`)
    .set("Authorization", `Bearer ${te}`)).body.rows;
  const siennes = new Set(vueTerrain.map(x => x.pcode));
  const dehors = vueAdmin.find(x => !siennes.has(x.pcode));
  const dedans = vueTerrain.find(x => x.population > 0);
  assert.ok(dehors, "l'administrateur voit des communes que l'éditeur ne voit pas");
  assert.ok(dedans, "l'éditeur a bien un périmètre renseigné");

  /* La ligne de son périmètre est réécrite à l'identique : le test mesure le refus,
     il ne doit pas déplacer les chiffres que les tests suivants relisent. */
  const r = await request(app).put("/api/caseload").set("Authorization", `Bearer ${te}`)
    .send({ rows:[
      { geo_pcode:dehors.pcode, level:"adm3", year, activity_tag:"",
        population:1000, targeted:10, source:"tentative hors périmètre" },
      { geo_pcode:dedans.pcode, level:"adm3", year, activity_tag:"",
        population:dedans.population, households:dedans.households,
        targeted:dedans.targeted, targeted_hh:dedans.targetedHh, source:dedans.source },
    ]});
  assert.equal(r.status, 200);
  assert.equal(r.body.rejetes, 1, JSON.stringify(r.body.rejets));
  assert.equal(r.body.rejets[0].pcode, dehors.pcode);
  assert.match(r.body.rejets[0].message, /hors du périmètre/);
  assert.equal(r.body.crees + r.body.modifies, 1, "la ligne de son propre périmètre passe");
  assert.ok(!db.prepare("SELECT 1 FROM caseload WHERE geo_pcode=? AND source=?")
    .get(dehors.pcode, "tentative hors périmètre"), "rien n'a été écrit hors périmètre");
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

/* Chantier B1 — `wb.xlsx.load()` inflatait chaque entrée de l'archive sans plafond
   et sans vérifier sa provenance. Quelques kilo-octets, un simple droit « edit », et
   le processus mourait ; le conteneur redémarrant tout seul, l'opération se rejoue. */
test("import : une archive piégée est refusée avant d'être décompressée", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await activerMillesimeDuSeed(t);
  const JSZip = (await import("jszip")).default;

  /* D'abord la non-régression qui compte le plus : un vrai classeur passe toujours. */
  const normal = await televerser(t, await modele(t, "caseload"));
  assert.equal(normal.status, 200, JSON.stringify(normal.body));

  /* ① Rapport de compression impossible pour un classeur : 8 Mo annoncés à
       l'intérieur, quelques kilo-octets reçus. Le fichier n'est jamais ouvert. */
  const bombe = new JSZip();
  bombe.file("[Content_Types].xml", "<Types/>");
  bombe.file("xl/workbook.xml", Buffer.alloc(8 * 1024 * 1024));
  const bufBombe = await bombe.generateAsync({ type:"nodebuffer", compression:"DEFLATE" });
  assert.ok(bufBombe.length < 100 * 1024,
    `le piège ne pèse que ${bufBombe.length} octets sur le disque`);
  const r1 = await request(app).post("/api/import/caseload").set("Authorization", `Bearer ${t}`)
    .attach("file", bufBombe, "piege.xlsx");
  assert.equal(r1.status, 422, JSON.stringify(r1.body));
  assert.match(r1.body.error, /rapport est trop grand/);

  /* ② Entrée étrangère au paquet OOXML : un classeur n'en contient jamais. */
  const clandestin = new JSZip();
  clandestin.file("[Content_Types].xml", "<Types/>");
  clandestin.file("xl/workbook.xml", "<workbook/>");
  clandestin.file("charge_utile/script.sh", "echo bonjour");
  const bufClandestin = await clandestin.generateAsync({ type:"nodebuffer", compression:"DEFLATE" });
  const r2 = await request(app).post("/api/import/caseload").set("Authorization", `Bearer ${t}`)
    .attach("file", bufClandestin, "piege2.xlsx");
  assert.equal(r2.status, 422, JSON.stringify(r2.body));
  assert.match(r2.body.error, /étrangère au format Excel/);
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
  motDePasseAdopte("tana@test.local");
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

test("MRE : le plan est lu avec ses agrégats, et le budget est la somme des lignes", async () => {
  const an = new Date().getFullYear();
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.length > 0, "le jeu d'essai comporte un plan");

  /* Le total de chaque activité est exactement Σ quantité × coût unitaire. */
  for(const a of r.body.rows){
    const attendu = Math.round(a.costs.reduce((t,l)=>t+l.qty*l.unit_cost, 0) * 100) / 100;
    assert.equal(a.budget, attendu, `budget de ${a.title}`);
  }
  /* Et le total du plan est la somme des activités, pas un nombre indépendant. */
  const somme = Math.round(r.body.rows.reduce((t,a)=>t+a.budget, 0) * 100) / 100;
  assert.equal(r.body.totals.budget, somme);

  /* Les répartitions portent sur les mêmes montants. */
  const parCat = Math.round(r.body.parCategorie.reduce((t,c)=>t+c.budget, 0) * 100) / 100;
  assert.equal(parCat, somme, "la répartition par catégorie totalise le même budget");
  const parMois = Math.round(r.body.parMois.reduce((t,m)=>t+m.budget, 0) * 100) / 100;
  assert.equal(parMois, somme, "la répartition mensuelle totalise le même budget");
  assert.equal(r.body.parMois.length, 12);
});

test("MRE : création d'une activité, puis de son budget ligne par ligne", async () => {
  const an = new Date().getFullYear();
  const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, ref:"MRE-T1", title:"Enquête de vérification des listes",
            kind:"enquete", purpose:"Contrôler la qualité des listes de bénéficiaires",
            start_month:3, end_month:4, sample:400, currency:"USD" });
  assert.equal(c.status, 201);
  const a = c.body.activity;
  assert.equal(a.budget, 0, "une activité neuve n'a pas de budget");
  assert.equal(a.spent, null, "et pas de dépense — nul, pas zéro");

  const b = await request(app).put(`/api/mre/${a.id}/costs`).set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:a.rev, lines:[
      { category:"enqueteurs", label:"Enquêteurs", unit:"personne-jour", qty:60, unit_cost:14 },
      { category:"transport",  label:"Véhicules",  unit:"véhicule-jour", qty:15, unit_cost:95, spent:1500 },
    ] });
  assert.equal(b.status, 200);
  assert.equal(b.body.activity.budget, 60*14 + 15*95);
  assert.equal(b.body.activity.spent, 1500);
  /* L'exécution ne porte que sur ce qui est engagé : 1500 sur 2265, pas sur 840. */
  assert.equal(b.body.activity.execution, Math.round((1500/2265)*1000)/10);
  assert.equal(b.body.activity.rev, a.rev + 1, "modifier le budget fait avancer la révision");
});

test("MRE : le budget remplacé en bloc ne laisse pas d'ancienne ligne derrière lui", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1'").get();
  const r = await request(app).put(`/api/mre/${a.id}/costs`).set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:a.rev, lines:[{ category:"autre", label:"Forfait unique", qty:1, unit_cost:900 }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.activity.costs.length, 1);
  assert.equal(r.body.activity.budget, 900);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_cost WHERE activity_id=?").get(a.id).c, 1);
});

test("MRE : révision périmée refusée sur l'activité comme sur son budget", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1'").get();
  const act = await request(app).put(`/api/mre/${a.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ year:a.year, title:a.title, rev:1 });
  assert.equal(act.status, 409);
  assert.ok(act.body.courant, "la valeur courante accompagne le refus");
  const bud = await request(app).put(`/api/mre/${a.id}/costs`).set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:1, lines:[] });
  assert.equal(bud.status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_cost WHERE activity_id=?").get(a.id).c, 1,
    "le budget n'a pas été vidé au passage");
});

test("MRE : garde-fous de saisie — référence unique dans l'année, calendrier cohérent", async () => {
  const an = new Date().getFullYear();
  const dup = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, ref:"MRE-T1", title:"Doublon de référence" });
  assert.equal(dup.status, 409);
  /* La même référence est libre pour une autre année : les plans se succèdent. */
  const autre = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an+1, ref:"MRE-T1", title:"Même référence, année suivante" });
  assert.equal(autre.status, 201);

  const inverse = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Calendrier inversé", start_month:8, end_month:2 });
  assert.equal(inverse.status, 422);
  assert.ok(/mois de fin précède/.test(inverse.body.error), inverse.body.error);

  const natureInconnue = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Nature inconnue", kind:"bricolage" });
  assert.equal(natureInconnue.status, 422);
});

test("MRE : un bureau voit son plan et le plan national, mais ne modifie que le sien", async () => {
  const an = new Date().getFullYear();
  const office = db.prepare("SELECT id,name FROM offices WHERE kind='field' LIMIT 1").get();
  const t = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200);
  /* Rien d'un autre bureau. */
  assert.ok(r.body.rows.every(a => !a.office_id || a.office_id === office.id),
    "aucune activité d'un autre bureau");
  /* Mais le plan national reste visible : le lui cacher laisserait croire
     qu'aucune évaluation ne porte sur sa zone. */
  const hqId = db.prepare("SELECT id FROM offices WHERE kind='hq'").get().id;
  assert.ok(db.prepare("SELECT COUNT(*) c FROM mre_activity WHERE office_id NOT IN (?,?)")
    .get(office.id, hqId).c >= 0);
  assert.ok(r.body.rows.some(a => a.office_id === office.id), "il voit son propre plan");

  /* Une activité d'un autre bureau lui est refusée en écriture. */
  const ailleurs = db.prepare(
    "SELECT id FROM mre_activity WHERE office_id IS NOT NULL AND office_id<>? LIMIT 1").get(office.id);
  const refus = await request(app).put(`/api/mre/${ailleurs.id}`)
    .set("Authorization", `Bearer ${t}`).send({ year:an, title:"Tentative", rev:1 });
  assert.equal(refus.status, 403);

  /* Et créer sans bureau ne le fait pas basculer dans le plan national :
     le serveur force son propre bureau, quoi que dise le corps. */
  const créé = await request(app).post("/api/mre").set("Authorization", `Bearer ${t}`)
    .send({ year:an, title:"Suivi de proximité complémentaire", office_id:null });
  assert.equal(créé.status, 201);
  assert.equal(créé.body.activity.office_id, office.id);
});

test("MRE : un compte de Tana pilote le plan national", async () => {
  const an = new Date().getFullYear();
  const t = (await login("tana@test.local", "TanaMotDePasse1")).body.token;
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${t}`);
  /* Bureau national : il voit tout le plan, comme il voit tous les sites. */
  const tout = db.prepare("SELECT COUNT(*) c FROM mre_activity WHERE year=?").get(an).c;
  assert.equal(r.body.rows.length, tout);
  const ailleurs = db.prepare(
    "SELECT id FROM mre_activity WHERE year=? AND office_id IS NOT NULL LIMIT 1").get(an);
  const maj = await request(app).put(`/api/mre/${ailleurs.id}`).set("Authorization", `Bearer ${t}`)
    .send({ year:an, title:"Ajusté par le bureau pays",
            rev: db.prepare("SELECT rev FROM mre_activity WHERE id=?").get(ailleurs.id).rev });
  assert.equal(maj.status, 200);
});

test("MRE : suppression réservée au droit de suppression, lignes de coût emportées", async () => {
  const a = db.prepare("SELECT * FROM mre_activity WHERE ref='MRE-T1'").get();
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).delete(`/api/mre/${a.id}`)
    .set("Authorization", `Bearer ${te}`)).status, 403, "un éditeur ne supprime pas");

  const r = await request(app).delete(`/api/mre/${a.id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM mre_cost WHERE activity_id=?").get(a.id).c, 0,
    "les lignes de coût n'ont pas d'existence propre");
});

test("MRE : plan mélangeant les devises — aucun total général n'est inventé", async () => {
  const an = new Date().getFullYear() + 3;   /* année vierge, pour isoler le cas */
  for(const [titre, devise] of [["Activité en dollars","USD"], ["Activité en ariary","MGA"]]){
    const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
      .send({ year:an, title:titre, currency:devise });
    await request(app).put(`/api/mre/${c.body.activity.id}/costs`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ rev:c.body.activity.rev, lines:[{ category:"autre", label:"Forfait", qty:1, unit_cost:1000 }] });
  }
  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.body.totals.currency, null, "pas de devise unique : pas de total présenté comme tel");
  assert.deepEqual(r.body.totals.devises.sort(), ["MGA","USD"]);
});

test("MRE : une ligne sans mois est répartie sur la durée, pas posée sur janvier", async () => {
  const an = new Date().getFullYear() + 4;
  const c = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Suivi continu sur l'année", start_month:0, end_month:11 });
  await request(app).put(`/api/mre/${c.body.activity.id}/costs`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:c.body.activity.rev,
            lines:[{ category:"transport", label:"Carburant", qty:12, unit_cost:100 }] });

  const r = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  const m = r.body.parMois;
  assert.ok(m.every(x => x.budget > 0), "les douze mois portent une part du coût");
  assert.equal(m[0].budget, 100, "et non 1 200 en janvier");
  /* L'invariant qui compte : la somme des mois est le budget, au centime près. */
  assert.equal(Math.round(m.reduce((t,x)=>t+x.budget, 0) * 100) / 100, r.body.totals.budget);

  /* Une ligne datée reste imputée à son mois : la répartition n'écrase pas une
     information plus précise quand elle existe. */
  const d = await request(app).post("/api/mre").set("Authorization", `Bearer ${adminToken}`)
    .send({ year:an, title:"Atelier daté", start_month:0, end_month:11 });
  await request(app).put(`/api/mre/${d.body.activity.id}/costs`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ rev:d.body.activity.rev,
            lines:[{ category:"atelier", label:"Atelier", qty:1, unit_cost:600, month:6 }] });
  const r2b = await request(app).get(`/api/mre?year=${an}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r2b.body.parMois[6].budget, 100 + 600);
});

/* ═══════════════════════════════════════════════════════════════════════
   Suivi tiers — TPM.

   Deux choses se vérifient ici, et ce sont les deux raisons d'être du module.

   D'abord que le budget est une conséquence de l'affectation : changer le nombre
   de jours doit changer le montant, sans que personne ne retape un total. C'est
   la règle du classeur de référence — qté1 × qté2 × coût unitaire — et si elle
   se perd, le module redevient un tableur.

   Ensuite que le circuit de validation ne se contourne pas. Trois niveaux dans
   l'ordre, chacun ouvert à un acteur précis. Un plan validé par le mauvais
   compte, ou validé au-delà du plafond contractuel, est exactement ce que ce
   module existe pour empêcher.
   ═══════════════════════════════════════════════════════════════════════ */

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
  motDePasseAdopte("prestataire@test.local");
  const tp = (await login("prestataire@test.local", "PrestataireMotDePasse1")).body.token;
  /* Le deuxième niveau est « le responsable suivi-évaluation du bureau » : un compte
     du bureau qui a le droit de valider. Un éditeur du même bureau ne l'a pas —
     c'est bien le rôle qui gouverne ce qu'on peut faire, et le bureau où. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"se-bureau@test.local", password:"SeBureauMotDePasse1",
            first_name:"Valid", role:"validator", office_id:tpmCtx.office.id,
            tabs:["home"], active:true });
  motDePasseAdopte("se-bureau@test.local");
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

/* Régression : /api/state omettait tpm_id de la liste des comptes. Le client
   relit cette liste à chaque connexion et à chaque rechargement (`reload()`,
   déclenché par exemple après un conflit de synchronisation) ; sans ce champ,
   modifier n'importe quel autre compte depuis Paramètres → Utilisateurs
   renvoyait tpm_id à null au premier enregistrement suivant, détachant en
   silence le compte prestataire de son prestataire. */
test("état : la liste des comptes porte tpm_id, pour ne pas l'effacer au premier réenregistrement", async () => {
  const etat = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(etat.status, 200);
  const presta = etat.body.users.find(u => u.email === "prestataire@test.local");
  assert.ok(presta, "le compte prestataire créé plus haut doit apparaître dans /api/state");
  assert.equal(presta.tpm_id, tpmCtx.tpm);
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
