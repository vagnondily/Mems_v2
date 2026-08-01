import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
/* La suite entière tient dans une poignée de secondes, donc dans une seule
   fenêtre du limiteur de débit : passé 600 requêtes elle se mettrait à
   échouer en 429, et l'échec se déplacerait au gré des tests ajoutés. Même
   raison que RATE_LOGIN_MAX juste au-dessus — on neutralise ici ce que la
   production règle à 600. */
process.env.RATE_API_MAX = "100000";
process.env.BCRYPT_ROUNDS = "4";          /* tests rapides ; la production reste à 12 */
process.env.FORCE_SEED = "1";
/* Le serveur ODK Central simulé plus bas tourne en http sur la boucle locale — que le
   correctif A5 refuse désormais par défaut. C'est exactement le cas que la liste
   blanche existe pour couvrir : un exploitant désigne nommément son serveur interne. */
process.env.ODK_ALLOWED_HOSTS = "127.0.0.1";
/* Même raison pour les connecteurs sortants (Foundry, HTTP) : le faux serveur
   Foundry plus bas tourne en http sur la boucle locale. La liste est renseignée,
   donc elle fait seule autorité — ce qui permet aussi de vérifier qu'un hôte
   absent de la liste est refusé, sans dépendre d'une résolution DNS réelle. */
process.env.CONNECTOR_ALLOWED_HOSTS = "127.0.0.1";

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

test("sites : un PUT partiel n'efface pas les champs qu'il n'envoie pas", async () => {
  /* Le corps validé par zod portait TOUS les champs facultatifs, transformés en
     null quand ils étaient absents ; l'UPDATE les écrivait tels quels. Renommer
     un site effaçait donc son code externe — et avec lui le rattachement de ses
     futures soumissions — sans le moindre message. */
  const cree = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"TEST-PARTIEL", name:"Site partiel", external_code:"MG23210070009001",
            antenne:"Antenne Sud", activity_tag:"URT", site_type:"École",
            beneficiaries:900, security:1 });
  assert.equal(cree.status, 201);
  const id = cree.body.site.id;

  const maj = await request(app).put(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Site partiel renommé" });
  assert.equal(maj.status, 200);

  const apres = db.prepare("SELECT * FROM sites WHERE id=?").get(id);
  assert.equal(apres.name, "Site partiel renommé", "le champ envoyé est bien écrit");
  assert.equal(apres.external_code, "MG23210070009001", "le code externe survit");
  assert.equal(apres.antenne, "Antenne Sud");
  assert.equal(apres.activity_tag, "URT");
  assert.equal(apres.site_type, "École");
  assert.equal(apres.code, "TEST-PARTIEL");
  assert.equal(apres.beneficiaries, 900);

  /* Effacer volontairement reste possible : c'est un null ENVOYÉ, pas un champ
     absent — la distinction que le schéma complet ne savait pas faire. */
  const vide = await request(app).put(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ external_code:null });
  assert.equal(vide.status, 200);
  assert.equal(db.prepare("SELECT external_code FROM sites WHERE id=?").get(id).external_code, null);

  /* Et le code externe voyage jusqu'au client : sans cela la fiche du registre
     le renverrait vide au prochain enregistrement. */
  await request(app).put(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ external_code:"MG23209050001" });
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const vu = st.body.sites.find(s => s.id === id);
  assert.equal(vu?.externalCode, "MG23209050001", "GET /api/state porte le code externe");

  await request(app).delete(`/api/sites/${id}`).set("Authorization", `Bearer ${adminToken}`);
});

test("grille mensuelle : cocher « réalisé » crée la visite manuelle, motivée et signée", async () => {
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const site = st.body.sites.find(s => s.status === "Active");
  const year = st.body.year;
  const before = db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c;
  const r = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ month:11, year, active:true, planned:true, done:true, monitor:"Testeur",
            manual_reason:"formulaire_non_rempli" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.visite, "creee");
  const after = db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c;
  assert.equal(after, before + 1);
  const s = db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id);
  assert.ok(s.last_visit.startsWith(`${year}-12`));

  /* Ce qui distingue désormais un rattrapage d'une preuve de terrain : l'origine,
     le motif, et qui l'a saisi. Sans les trois, la ligne serait indiscernable
     d'une visite issue d'un formulaire. */
  const v = db.prepare(`SELECT * FROM visits WHERE site_id=? AND visit_date LIKE ?`)
    .get(site.id, `${year}-12%`);
  assert.equal(v.origin, "manuelle");
  assert.equal(v.manual_reason, "formulaire_non_rempli");
  assert.equal(v.submission_id, null);
  assert.ok(v.created_by, "la visite dit qui l'a saisie");
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
  /* Le refus est le même ; ce qui le prononce a changé. Il était posé en tête de
     route, inconditionnel, au motif que « tous les schémas exigent un justificatif
     durable » — ce qui est faux du schéma « Aucune (source publique) », que
     l'écran propose. C'est donc le SCHÉMA de la source qui décide, par
     `porteurAuth`, et le tirage rend exactement ce que l'épreuve de connexion
     rend sur la même ligne. Ici le schéma est « Porteur », qui exige bien un
     jeton, et l'absence se dit avant tout appel sortant. */
  const f = await odkForm({ name:"Sans jeton", formId:"testform-notoken", token:"" });
  const avant = odkMockRequests.length;
  const r = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 422);
  assert.equal(r.body.cause, "AUTH_ABSENT");
  assert.match(r.body.error, /n'a pas de justificatif complet/);
  assert.match(r.body.error, /chaque source porte le sien/,
    "le refus dit pourquoi aucune autre source ne lui prêtera le sien");
  assert.equal(odkMockRequests.length, avant,
    "un justificatif manquant se constate sans sortir sur le réseau");
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

/* Lot S — le mot de passe provisoire est GÉNÉRÉ, pas choisi (demande du 01/08).
   Sans mot de passe fourni, la création en forge un, le renvoie une seule fois, et
   il ouvre — borné — jusqu'à son remplacement. */
test("création sans mot de passe : le provisoire est généré et rendu une fois", async () => {
  const cree = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"genere@test.local", first_name:"Généré", role:"viewer", tabs:["home"], active:true });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  const prov = cree.body.provisionalPassword;
  assert.ok(prov && prov.length >= 12, "un provisoire est renvoyé");
  assert.equal(cree.body.user.must_change_pw ?? true, true);

  /* Il ouvre la connexion, avec le drapeau de changement obligatoire. */
  const lr = await login("genere@test.local", prov);
  assert.equal(lr.status, 200, "le provisoire généré ouvre la connexion");
  assert.equal(lr.body.user.must_change_pw, true);

  /* Il n'est jamais renvoyé une seconde fois : /state ne porte aucun secret. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const etat = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  const vu = etat.users.find(x => x.email === "genere@test.local");
  assert.ok(vu && !("provisionalPassword" in vu) && !("pw_hash" in vu),
    "aucun secret n'accompagne le compte dans l'état");
});

/* Lot S — l'administrateur ne connaît pas le mot de passe : il DÉCLENCHE une
   réinitialisation, le provisoire s'affiche une fois, les sessions tombent. */
test("réinitialisation admin : provisoire généré, sessions fermées, changement imposé", async () => {
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"reset@test.local", password:"ResetMotDePasse1", first_name:"Reset",
            role:"editor", tabs:["home"], active:true });
  motDePasseAdopte("reset@test.local");
  const ouverte = (await login("reset@test.local", "ResetMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${ouverte}`)).status, 200);

  const cible = db.prepare("SELECT id FROM users WHERE email='reset@test.local'").get();
  const reset = await request(app).post(`/api/users/${cible.id}/reset-password`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const prov = reset.body.provisionalPassword;
  assert.ok(prov && prov.length >= 12);

  /* La session ouverte avant le reset est révoquée. */
  assert.equal((await request(app).get("/api/state").set("Authorization", `Bearer ${ouverte}`)).status, 401,
    "la session d'avant le reset ne vaut plus");
  /* L'ancien mot de passe ne vaut plus ; le provisoire ouvre, avec changement imposé. */
  assert.equal((await login("reset@test.local", "ResetMotDePasse1")).status, 401);
  const lr = await login("reset@test.local", prov);
  assert.equal(lr.status, 200);
  assert.equal(lr.body.user.must_change_pw, true);
  /* La route de réinitialisation est sous le garde `requireCap("admin")` du routeur
     entier (déjà éprouvé : un lecteur reçoit 403 sur /api/users). */
});

/* Lot S — « créer un username » : identifiant de connexion, unique, utilisable à la
   place du courriel. */
test("identifiant : self-service, unicité, et connexion par identifiant", async () => {
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"ident@test.local", password:"IdentMotDePasse1", first_name:"Ident",
            role:"editor", tabs:["home"], active:true });
  motDePasseAdopte("ident@test.local");
  const t = (await login("ident@test.local", "IdentMotDePasse1")).body.token;

  const set = await request(app).put("/api/auth/username").set("Authorization", `Bearer ${t}`)
    .send({ username:"Ident.Field" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.user.username, "ident.field", "l'identifiant est normalisé en minuscules");

  /* La connexion aboutit par l'identifiant comme par le courriel. */
  assert.equal((await login("ident.field", "IdentMotDePasse1")).status, 200,
    "on se connecte par l'identifiant");
  assert.equal((await login("ident@test.local", "IdentMotDePasse1")).status, 200,
    "le courriel reste un moyen de connexion");

  /* Un deuxième compte ne peut pas prendre le même identifiant, ni un identifiant
     qui usurpe le courriel d'un autre. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"ident2@test.local", password:"Ident2MotDePasse1", first_name:"Ident2",
            role:"editor", tabs:["home"], active:true });
  motDePasseAdopte("ident2@test.local");
  const t2 = (await login("ident2@test.local", "Ident2MotDePasse1")).body.token;
  const collision = await request(app).put("/api/auth/username").set("Authorization", `Bearer ${t2}`)
    .send({ username:"ident.field" });
  assert.equal(collision.status, 409, "un identifiant déjà pris est refusé");
  const usurpe = await request(app).put("/api/auth/username").set("Authorization", `Bearer ${t2}`)
    .send({ username:"ident@test.local" });
  assert.equal(usurpe.status, 422, "un « @ » dans l'identifiant est refusé");

  /* Un format hors charte est refusé ; vide, l'identifiant se retire. */
  assert.equal((await request(app).put("/api/auth/username").set("Authorization", `Bearer ${t}`)
    .send({ username:"a b" })).status, 422);
  const vide = await request(app).put("/api/auth/username").set("Authorization", `Bearer ${t}`)
    .send({ username:"" });
  assert.equal(vide.status, 200);
  assert.equal(vide.body.user.username, "");
  assert.equal((await login("ident.field", "IdentMotDePasse1")).status, 401,
    "l'identifiant retiré ne connecte plus");
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

/* Chantier P — deux natures d'indicateur (migration 022). Un CRF porte un niveau
   de cadre logique, un XLSForm porte l'activité qu'il suit ; les deux transitent
   par la même collection et se relisent avec leur nature intacte. */
test("indicateurs : les natures CRF et XLSForm font l'aller-retour", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;

  const ecrit = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [
      { code:"OUT-PROC", name:"Couverture des visites", kind:"xlsform",
        activity:"ACT1", unit:"%", target:80, direction:"up", frequency:"Mensuel" },
      { code:"OTH-OUT", name:"Other output test", kind:"crf",
        level:"other_output", basket:"Nutrition", unit:"nombre", target:12, direction:"up" },
    ] });
  assert.equal(ecrit.status, 200, JSON.stringify(ecrit.body));
  assert.equal(ecrit.body.created, 2);

  /* Le stockage porte bien les colonnes de la migration. */
  const proc = db.prepare("SELECT * FROM indicators WHERE code=?").get("OUT-PROC");
  assert.equal(proc.kind, "xlsform");
  assert.equal(proc.activity, "ACT1");
  assert.equal(proc.level, null, "un XLSForm n'a pas de niveau de cadre logique");
  const oth = db.prepare("SELECT * FROM indicators WHERE code=?").get("OTH-OUT");
  assert.equal(oth.kind, "crf");
  assert.equal(oth.level, "other_output");

  /* La projection d'état rend les deux natures, l'ancienne masterlist restant CRF. */
  const etat = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  const vuProc = etat.indicators.find(i => i.id === "OUT-PROC");
  assert.equal(vuProc.kind, "xlsform");
  assert.equal(vuProc.activity, "ACT1");
  assert.ok(etat.indicators.every(i => i.kind === "crf" || i.kind === "xlsform"),
    "toute ligne a une nature");
  assert.ok(etat.indicators.some(i => i.kind === "crf"),
    "les indicateurs d'avant la migration sont des CRF");

  /* Un niveau hors liste est refusé : le champ est contraint, pas libre. */
  const refus = await request(app).put("/api/collections/indicators")
    .set("Authorization", `Bearer ${t}`)
    .send({ rows: [{ code:"BAD", name:"x", kind:"crf", level:"impact", direction:"up" }] });
  assert.equal(refus.status, 422, "un niveau de cadre logique inconnu est rejeté");
});

/* Chantier S6 — « un éditeur peut être attribué à planifier les suivis ». La
   configuration de planification (MRE + calendrier de collecte) se persiste par une
   route en droit ÉDITEUR, distincte des réglages admin ; le calendrier va dans sa
   table `outcome_plan`, plus dans le blob settings. */
test("planification : un éditeur enregistre MRE et calendrier, hors des réglages admin", async () => {
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"planif@test.local", password:"PlanifMotDePasse1", first_name:"Planif",
            role:"editor", tabs:["home","suivi"], active:true });
  motDePasseAdopte("planif@test.local");
  const t = (await login("planif@test.local", "PlanifMotDePasse1")).body.token;

  /* L'éditeur n'a PAS le droit sur les réglages admin : la séparation est réelle. */
  const settings = await request(app).put("/api/settings").set("Authorization", `Bearer ${t}`)
    .send({ mmr:[{ id:"x" }] });
  assert.equal(settings.status, 403, "les réglages restent réservés à l'admin");

  /* Un code d'indicateur réel, pour le calendrier. */
  const etat0 = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  const code = etat0.indicators[0].id;

  const enreg = await request(app).put("/api/planning-config").set("Authorization", `Bearer ${t}`)
    .send({ mmr:[{ id:"mmr0", area:"School Feeding", coef:1.5, duration:"6-12 months",
                   siteType:"School", monitoring:"Distribution monitoring" }],
            outcomePlan:{ [code]: [true,false,false,true,false,false,false,false,false,false,false,false] } });
  assert.equal(enreg.status, 200, JSON.stringify(enreg.body));

  const etat = (await request(app).get("/api/state").set("Authorization", `Bearer ${t}`)).body;
  assert.equal(etat.settings.mmr[0].coef, 1.5, "le MRE est relu du dictionnaire de réglages");
  assert.deepEqual(etat.outcomePlan[code].map(Boolean),
    [true,false,false,true,false,false,false,false,false,false,false,false],
    "le calendrier est relu de sa table, mois par mois");

  /* La table `outcome_plan` porte les deux mois cochés, et rien de plus pour ce code. */
  const année = new Date().getFullYear();
  const ind = db.prepare("SELECT id FROM indicators WHERE code=?").get(code);
  const mois = db.prepare("SELECT month FROM outcome_plan WHERE indicator_id=? AND year=? ORDER BY month")
    .all(ind.id, année).map(r => r.month);
  assert.deepEqual(mois, [0,3], "seuls les mois cochés existent dans la table");
  /* Le reflet dans settings est purgé : il n'ombre plus la table. */
  assert.equal(db.prepare("SELECT 1 FROM settings WHERE key='outcomePlan'").get(), undefined);

  /* Décocher un mois le fait DISPARAÎTRE (remplacement de l'année, pas ajout). */
  await request(app).put("/api/planning-config").set("Authorization", `Bearer ${t}`)
    .send({ outcomePlan:{ [code]: [true,false,false,false,false,false,false,false,false,false,false,false] } });
  const apres = db.prepare("SELECT month FROM outcome_plan WHERE indicator_id=? AND year=?").all(ind.id, année);
  assert.deepEqual(apres.map(r=>r.month), [0], "le mois décoché a bien disparu");

  /* Un lecteur ne planifie pas : la route exige le droit d'édition. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecplan@test.local", password:"LecPlanMotDePasse1", first_name:"LecPlan",
            role:"viewer", tabs:["home"], active:true });
  motDePasseAdopte("lecplan@test.local");
  const tv = (await login("lecplan@test.local", "LecPlanMotDePasse1")).body.token;
  const refus = await request(app).put("/api/planning-config").set("Authorization", `Bearer ${tv}`)
    .send({ mmr:[{ id:"y" }] });
  assert.equal(refus.status, 403, "un lecteur ne peut pas planifier");
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

/* Chantier S4/S7 — le référentiel des activités devient éditable, sur le modèle
   des bureaux : lecture ouverte, écriture admin, suppression refusée si référencée. */
test("activités : lecture, création, révision optimiste et refus de suppression si référencée", async () => {
  const liste = await request(app).get("/api/activities").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(liste.status, 200);
  assert.ok(Array.isArray(liste.body.activities) && liste.body.activities.length > 0);
  assert.ok("usage" in liste.body.activities[0], "chaque activité porte son décompte de références");

  /* Création + refus du doublon de nom. */
  const cree = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Activité d'essai", tag:"tst", program_area:"Résilience" });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  assert.equal(cree.body.activity.tag, "TST", "le tag est mis en majuscules");
  const id = cree.body.activity.id;
  const doublon = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"activité d'essai", tag:"AUT" });
  assert.equal(doublon.status, 409, "un nom déjà pris est refusé");

  /* Révision périmée refusée. */
  const stale = await request(app).put(`/api/activities/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Renommée", tag:"TST", rev:999 });
  assert.equal(stale.status, 409, "une révision périmée est refusée");
  const maj = await request(app).put(`/api/activities/${id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Renommée", tag:"TST", rev:cree.body.activity.rev });
  assert.equal(maj.status, 200);
  assert.equal(db.prepare("SELECT name FROM activity_categories WHERE id=?").get(id).name, "Renommée");

  /* Une activité référencée par un site ne se supprime pas : on la désactive. */
  const référencée = db.prepare(
    "SELECT id FROM activity_categories WHERE id IN (SELECT category_id FROM sites) LIMIT 1").get();
  if(référencée){
    const orphelins = () => db.prepare("SELECT COUNT(*) c FROM sites WHERE category_id IS NULL").get().c;
    const avant = orphelins();
    const refus = await request(app).delete(`/api/activities/${référencée.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(refus.status, 409);
    assert.ok(refus.body.usage.sites > 0);
    assert.equal(orphelins(), avant, "aucun site détaché");
  }

  /* L'activité neuve, sans référence, se supprime. */
  const del = await request(app).delete(`/api/activities/${id}`).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 200);

  /* Un éditeur lit mais n'écrit pas : le référentiel est de l'administration. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"actedit@test.local", password:"ActEditMotDePasse1", first_name:"ActEdit",
            role:"editor", tabs:["home"], active:true });
  motDePasseAdopte("actedit@test.local");
  const te = (await login("actedit@test.local", "ActEditMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/activities").set("Authorization", `Bearer ${te}`)).status, 200);
  const refusEdit = await request(app).post("/api/activities").set("Authorization", `Bearer ${te}`)
    .send({ name:"Interdite", tag:"NON" });
  assert.equal(refusEdit.status, 403, "un éditeur ne crée pas d'activité");
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

/* ═══════════════════════════════════════════════════════════════════════
   Connecteurs et correspondance des variables (chantier « mapping générique »)

   Ce que ces tests verrouillent est exactement ce que la demande visait : une
   source se branche par de la configuration, la correspondance se vérifie AVANT
   tout import, le registre des champs ne vit qu'à un seul endroit, et le jeton
   d'accès ne ressort jamais.

   Faute d'instance Palantir Foundry — et cet environnement n'a pas d'accès
   réseau sortant libre — le connecteur Foundry est éprouvé contre un serveur
   simulé en mémoire : il prouve l'URL construite, l'en-tête d'autorisation, la
   lecture CSV et la traduction des erreurs, pas le comportement d'un vrai
   Foundry. C'est dit ici pour que personne ne lise l'inverse dans un test vert.
   ═══════════════════════════════════════════════════════════════════════ */
let foundryMock, foundryUrl, foundryRequetes;
{
  foundryRequetes = [];
  foundryMock = http.createServer((req, res) => {
    foundryRequetes.push({ url: req.url, auth: req.headers.authorization });
    if(/dataset\.refuse/.test(req.url)){
      res.statusCode = 403; res.setHeader("Content-Type", "application/json"); return res.end("{}");
    }
    if(/readTable/.test(req.url)){
      res.setHeader("Content-Type", "text/csv");
      /* Deux lignes de chiffres de bénéficiaires, avec un millier séparé par une
         espace et un p-code écrit en minuscules espacées : le cas réel d'un
         export, pas une donnée déjà propre. */
      return res.end("pcode,annee,mois,planifie,atteint\n"
        + "mg 232 09050001,2026,3,\"1 200\",1150\n"
        + "MG23209050002,2026,3,900,880\n");
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise(r => foundryMock.listen(0, "127.0.0.1", r));
  foundryUrl = `http://127.0.0.1:${foundryMock.address().port}`;
  after(() => foundryMock.close());
}

const creerConnecteur = async (corps, jeton = adminToken) =>
  request(app).post("/api/connectors").set("Authorization", `Bearer ${jeton}`).send(corps);

test("connecteurs : le registre des champs MEMS est servi par le serveur, pas recopié dans l'écran", async () => {
  const r = await request(app).get("/api/connectors/champs")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);

  const cles = r.body.entites.map(e => e.cle);
  for(const e of ["site", "submission", "beneficiaire", "reception"])
    assert.ok(cles.includes(e), `l'entité ${e} est déclarée`);

  const benef = r.body.entites.find(e => e.cle === "beneficiaire");
  assert.ok(benef.champs.find(c => c.nom === "geo_pcode").obligatoire,
    "un chiffre de bénéficiaires sans p-code ne se rattache à rien");
  assert.ok(benef.champs.some(c => c.nom === "atteints"));
  assert.ok(r.body.entites.find(e => e.cle === "reception").champs.some(c => c.nom === "tonnage_recu"));
  assert.ok(r.body.entites.every(e => e.champs.every(c => c.note && c.note.length > 10)),
    "chaque champ porte son explication : c'est ce qui rend l'écran utilisable sans documentation");

  const transformations = r.body.transformations.map(t => t.cle);
  for(const t of ["brut", "texte", "nombre", "entier", "booleen", "date_iso", "majuscules",
                  "minuscules", "trim", "pcode", "geopoint_lat", "geopoint_lon"])
    assert.ok(transformations.includes(t), `la transformation ${t} est servie`);
});

test("connecteurs : création, et le jeton est chiffré au repos sans jamais ressortir de l'API", async () => {
  const c = await creerConnecteur({
    name: "Foundry — bénéficiaires", kind: "foundry", base_url: foundryUrl,
    config: { datasetRid: "ri.foundry.main.dataset.benef" },
    secret: "jeton-foundry-tres-secret", active: true });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal(c.body.connector.hasSecret, true);
  assert.ok(!/jeton-foundry-tres-secret/.test(JSON.stringify(c.body)));

  const stocke = db.prepare("SELECT secret_enc FROM connector WHERE id=?").get(c.body.connector.id);
  assert.ok(stocke.secret_enc && !stocke.secret_enc.includes("jeton-foundry"),
    "le jeton est chiffré en base, comme celui des sources ODK");

  const liste = await request(app).get("/api/connectors").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(liste.status, 200);
  assert.ok(!/jeton-foundry-tres-secret/.test(JSON.stringify(liste.body)),
    "la liste n'expose que la présence du jeton");
  assert.equal(liste.body.rows.find(x => x.id === c.body.connector.id).hasSecret, true);

  /* Modifier sans redonner le jeton ne l'efface pas : sinon toute correction de
     libellé obligerait à ressaisir un secret que personne n'a sous la main. */
  const maj = await request(app).put(`/api/connectors/${c.body.connector.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Foundry — bénéficiaires (national)", kind: "foundry", base_url: foundryUrl,
            config: { datasetRid: "ri.foundry.main.dataset.benef" }, active: true, rev: 1 });
  assert.equal(maj.status, 200, JSON.stringify(maj.body));
  assert.equal(maj.body.connector.hasSecret, true);

  /* Un secret glissé dans la configuration ressortirait en clair : refusé. */
  const fuite = await creerConnecteur({ name: "Fuite", kind: "http",
    base_url: "https://exemple.org", config: { apiKey: "abc" } });
  assert.equal(fuite.status, 422);
  assert.match(fuite.body.error, /secrets/);
});

test("connecteurs : les correspondances sont validées contre le registre, puis enregistrées", async () => {
  const c = (await creerConnecteur({ name: "Soumissions GD_PREVMA", kind: "odk",
    base_url: "https://odk.exemple.org", config: { project: "1", formId: "GD_PREVMA" } })).body.connector;

  const champInconnu = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", mappings: [
      { entity: "submission", mems_field: "colonne_inventee", source_path: "X" }] });
  assert.equal(champInconnu.status, 422);
  assert.match(JSON.stringify(champInconnu.body.details), /champ inconnu/);

  const transfoInconnue = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", mappings: [
      { entity: "submission", mems_field: "site_code", source_path: "DPName", transform: "formule_maison" }] });
  assert.equal(transfoInconnue.status, 422);
  assert.match(JSON.stringify(transfoInconnue.body.details), /transformation inconnue/);

  const entiteInconnue = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "menage", mappings: [{ entity: "menage", mems_field: "code", source_path: "X" }] });
  assert.equal(entiteInconnue.status, 422);

  const bon = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", mappings: [
      { entity: "submission", mems_field: "instance_id", source_path: "__id", transform: "texte" },
      { entity: "submission", mems_field: "form_id", source_path: "form_id", transform: "texte" },
      { entity: "submission", mems_field: "site_code", source_path: "DPName", transform: "pcode" }] });
  assert.equal(bon.status, 200, JSON.stringify(bon.body));
  assert.equal(bon.body.enregistrees, 3);

  const relu = await request(app).get(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(relu.status, 200);
  assert.equal(relu.body.rows.length, 3);
  assert.equal(relu.body.rows.find(m => m.mems_field === "site_code").transform, "pcode");

  /* Un champ déclaré deux fois se départagerait par l'ordre d'écriture, c'est-à-dire par hasard. */
  const doublon = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", mappings: [
      { entity: "submission", mems_field: "site_code", source_path: "DPName" },
      { entity: "submission", mems_field: "site_code", source_path: "POIName" }] });
  assert.equal(doublon.status, 422);
  assert.match(JSON.stringify(doublon.body.details), /deux fois/);
});

test("connecteurs : l'aperçu applique les transformations — geopoint découpé, nombre à la française", async () => {
  const c = (await creerConnecteur({ name: "Aperçu soumissions", kind: "odk",
    base_url: "https://odk.exemple.org", config: {} })).body.connector;

  await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", mappings: [
      { entity: "submission", mems_field: "instance_id", source_path: "__id", transform: "texte" },
      { entity: "submission", mems_field: "form_id", source_path: "form_id", transform: "texte" },
      { entity: "submission", mems_field: "site_code", source_path: "DPName", transform: "pcode" },
      { entity: "submission", mems_field: "svy_date", source_path: "SvyDate", transform: "date_iso" },
      { entity: "submission", mems_field: "lat", source_path: "HHCoord", transform: "geopoint_lat" },
      { entity: "submission", mems_field: "lon", source_path: "HHCoord", transform: "geopoint_lon" },
      { entity: "submission", mems_field: "gps_accuracy", source_path: "precision", transform: "nombre" }] });

  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", echantillon: [{
      __id: "uuid:9f2c", form_id: "MDG_GD_PREVMA_v2",
      DPName: "mg 232 09050001", SvyDate: "2026-03-01T08:12:00Z",
      /* La forme réelle d'un geopoint ODK : latitude, longitude, altitude, précision. */
      HHCoord: "-23.354871 43.667201 12.0 5.2", precision: "5,2" }] });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body.manquants));
  assert.equal(r.body.lignesLues, 1);
  const apres = r.body.lignes[0].apres;
  assert.equal(apres.site_code, "MG23209050001", "le p-code est normalisé, pas recopié");
  assert.equal(apres.svy_date, "2026-03-01");
  assert.equal(apres.lat, -23.354871);
  assert.equal(apres.lon, 43.667201);
  assert.equal(apres.gps_accuracy, 5.2, "« 5,2 » est un nombre, pas du texte");
  /* L'avant est rendu tel quel : c'est ce qui permet de comparer sans deviner. */
  assert.equal(r.body.lignes[0].avant.HHCoord, "-23.354871 43.667201 12.0 5.2");
});

test("connecteurs : l'aperçu refuse quand un champ obligatoire reste vide, et dit lequel", async () => {
  const c = (await creerConnecteur({ name: "Aperçu incomplet", kind: "csv", config: {} })).body.connector;

  /* Correspondances fournies dans la demande : on vérifie AVANT d'enregistrer. */
  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission",
      mappings: [
        { entity: "submission", mems_field: "instance_id", source_path: "__id", transform: "texte" },
        { entity: "submission", mems_field: "site_code", source_path: "DPName", transform: "pcode" }],
      echantillon: [{ __id: "uuid:1", DPName: "   " }] });

  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, "une correspondance incomplète ne doit pas se déclarer bonne");
  const champsManquants = r.body.manquants.map(m => m.champ);
  assert.ok(champsManquants.includes("site_code"),
    "le p-code réduit à des espaces est vu comme manquant, pas comme une chaîne vide");
  assert.ok(champsManquants.includes("form_id"),
    "un obligatoire jamais branché est signalé lui aussi");
  assert.ok(r.body.manquants.every(m => m.motif && m.motif.length > 10),
    "chaque manque est motivé : sans le motif, on cherche pendant une heure");
  assert.deepEqual(r.body.lignes[0].apres.site_code, undefined,
    "un champ manquant est absent, jamais posé à null — un null écraserait l'existant à l'import");
});

test("connecteurs : les suggestions proposent avec un score, et n'enregistrent rien", async () => {
  const c = (await creerConnecteur({ name: "Suggestions", kind: "odk",
    base_url: "https://odk.exemple.org", config: {} })).body.connector;

  const r = await request(app).post(`/api/connectors/${c.id}/suggestions`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "submission", variables: [
      { name: "Technical_module", type: "begin_group", label: "Module technique" },
      { name: "SvyDate", type: "date", label: "Date de l'enquête" },
      { name: "DPName", type: "select_one dp", label: "Point de distribution" },
      { name: "HHCoord", type: "geopoint", label: "Coordonnées GPS" },
      { name: "EnuName", type: "text", label: "Enquêteur" }] });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applique, false, "la route propose, elle n'écrit pas");
  const par = Object.fromEntries(r.body.suggestions.map(s => [s.mems_field, s]));
  assert.equal(par.svy_date.source_path, "SvyDate");
  assert.equal(par.svy_date.transform, "date_iso");
  assert.ok(par.svy_date.score >= 0.9);
  assert.equal(par.site_code.source_path, "DPName");
  assert.equal(par.lat.source_path, "HHCoord");
  assert.equal(par.lat.transform, "geopoint_lat", "un geopoint ne se lit pas comme un nombre");
  assert.equal(par.lon.transform, "geopoint_lon");
  assert.ok(r.body.suggestions.every(s => s.motif && s.motif.length > 5),
    "chaque proposition dit sur quoi elle se fonde");
  /* Rien n'a été enregistré : c'est la garantie que l'humain garde la main. */
  const mappings = await request(app).get(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(mappings.body.rows.length, 0);
  /* Les lignes de structure d'un XLSForm ne sont jamais des candidates. */
  assert.ok(!JSON.stringify(r.body.suggestions).includes("Technical_module"));
});

test("connecteurs : la liste est cloisonnée par bureau, comme le reste", async () => {
  const bureau = db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get();
  const autre = db.prepare("SELECT id FROM offices WHERE id<>? LIMIT 1").get(bureau.id);

  const mien = (await creerConnecteur({ name: "Réceptions du bureau", kind: "csv",
    config: {}, office_id: bureau.id })).body.connector;
  const sien = (await creerConnecteur({ name: "Réceptions d'ailleurs", kind: "csv",
    config: {}, office_id: autre.id })).body.connector;

  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  const liste = await request(app).get("/api/connectors").set("Authorization", `Bearer ${te}`);
  assert.equal(liste.status, 200);
  const vus = liste.body.rows.map(x => x.id);
  assert.ok(vus.includes(mien.id), "le compte voit le connecteur de son bureau");
  assert.ok(!vus.includes(sien.id), "et aucun de ceux des autres bureaux");
  assert.ok(!vus.some(id => liste.body.rows.find(x => x.id === id).office_id !== bureau.id),
    "y compris les connecteurs sans bureau, comme pour l'écriture des collections");

  /* Nommer l'identifiant ne suffit pas non plus. */
  assert.equal((await request(app).get(`/api/connectors/${sien.id}/mappings`)
    .set("Authorization", `Bearer ${te}`)).status, 404);

  /* L'écriture — et l'aperçu, qui déchiffre le jeton et rend les lignes source —
     restent réservés à l'administration. */
  for(const appel of [
    () => request(app).post("/api/connectors").set("Authorization", `Bearer ${te}`)
      .send({ name: "Tentative", kind: "csv", config: {} }),
    () => request(app).put(`/api/connectors/${mien.id}`).set("Authorization", `Bearer ${te}`)
      .send({ name: "Tentative", kind: "csv", config: {} }),
    () => request(app).put(`/api/connectors/${mien.id}/mappings`).set("Authorization", `Bearer ${te}`)
      .send({ entity: "reception", mappings: [] }),
    () => request(app).post(`/api/connectors/${mien.id}/apercu`).set("Authorization", `Bearer ${te}`)
      .send({ entity: "reception", echantillon: [{}] }),
    () => request(app).delete(`/api/connectors/${mien.id}`).set("Authorization", `Bearer ${te}`),
  ]) assert.equal((await appel()).status, 403);
});

test("connecteur Foundry : le dataset est lu, mappé, et les chiffres arrivent en nombres", async () => {
  const c = (await creerConnecteur({ name: "Foundry — chiffres", kind: "foundry",
    base_url: foundryUrl, config: { datasetRid: "ri.foundry.main.dataset.chiffres", branche: "master" },
    secret: "jeton-foundry-lecture" })).body.connector;

  await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "beneficiaire", mappings: [
      { entity: "beneficiaire", mems_field: "geo_pcode", source_path: "pcode", transform: "pcode" },
      { entity: "beneficiaire", mems_field: "annee", source_path: "annee", transform: "entier" },
      { entity: "beneficiaire", mems_field: "mois", source_path: "mois", transform: "entier" },
      { entity: "beneficiaire", mems_field: "planifies", source_path: "planifie", transform: "entier" },
      { entity: "beneficiaire", mems_field: "atteints", source_path: "atteint", transform: "entier" }] });

  const avant = foundryRequetes.length;
  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`).send({ entity: "beneficiaire", limite: 5 });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.provenance, /lecture distante/);
  assert.equal(r.body.lignesLues, 2);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.manquants));
  assert.equal(r.body.lignes[0].apres.geo_pcode, "MG23209050001");
  assert.equal(r.body.lignes[0].apres.planifies, 1200, "« 1 200 » est un entier, pas une chaîne");
  assert.equal(r.body.lignes[1].apres.atteints, 880);

  const appel = foundryRequetes[avant];
  assert.ok(appel, "le serveur est bien allé lire la source");
  assert.equal(appel.auth, "Bearer jeton-foundry-lecture", "le jeton part en en-tête, jamais dans l'URL");
  assert.match(appel.url, /\/api\/v2\/datasets\/ri\.foundry\.main\.dataset\.chiffres\/readTable/);
  assert.match(appel.url, /rowLimit=5/);
  assert.match(appel.url, /branchName=master/);

  /* Un refus de la source est une erreur de configuration, pas une panne du serveur. */
  const refuse = (await creerConnecteur({ name: "Foundry — refusé", kind: "foundry",
    base_url: foundryUrl, config: { datasetRid: "ri.foundry.main.dataset.refuse" },
    secret: "mauvais-jeton" })).body.connector;
  const rr = await request(app).post(`/api/connectors/${refuse.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "beneficiaire", mappings: [
      { entity: "beneficiaire", mems_field: "geo_pcode", source_path: "pcode" }] });
  assert.equal(rr.status, 422);
  assert.match(rr.body.error, /refusé/);
});

test("connecteur : /variables lit la source et rend ses colonnes pour le pré-remplissage", async () => {
  /* Le maillon du peuplement automatique : à l'enregistrement, l'écran teste la
     connexion puis découvre les colonnes SANS qu'on colle quoi que ce soit. */
  const c = (await creerConnecteur({ name: "Foundry — découverte", kind: "foundry",
    base_url: foundryUrl, config: { datasetRid: "ri.foundry.main.dataset.chiffres", branche: "master" },
    secret: "jeton-foundry-lecture" })).body.connector;

  const r = await request(app).post(`/api/connectors/${c.id}/variables`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.provenance, /lecture distante/);
  assert.ok(r.body.lignesLues > 0, "des lignes ont été lues");
  const noms = r.body.variables.map(v => v.name);
  /* Les colonnes du dataset simulé — celles que les listes déroulantes offriront. */
  for(const col of ["pcode", "annee", "mois", "planifie", "atteint"])
    assert.ok(noms.includes(col), `la colonne « ${col} » figure dans les variables : ${noms.join(", ")}`);

  /* Une nature que le serveur ne sait pas lire seul (csv) refuse, avec le geste. */
  const csv = (await creerConnecteur({ name: "Collé", kind: "csv", config: {} })).body.connector;
  const rc = await request(app).post(`/api/connectors/${csv.id}/variables`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(rc.status, 422);
  assert.match(rc.body.error, /XLSForm|échantillon/);

  /* Réservé à l'administration comme l'aperçu : elle déchiffre un jeton. */
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await request(app).post(`/api/connectors/${c.id}/variables`)
    .set("Authorization", `Bearer ${te}`).send({})).status, 403);
});

test("connecteurs : une adresse hors liste blanche n'est jamais appelée (SSRF)", async () => {
  const c = (await creerConnecteur({ name: "Métadonnées de l'hébergeur", kind: "foundry",
    base_url: "http://169.254.169.254", config: { datasetRid: "peu-importe" },
    secret: "x" })).body.connector;
  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "beneficiaire", mappings: [
      { entity: "beneficiaire", mems_field: "geo_pcode", source_path: "pcode" }] });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /CONNECTOR_ALLOWED_HOSTS/);
});

test("connecteurs : supprimer un connecteur emporte ses correspondances", async () => {
  const c = (await creerConnecteur({ name: "Éphémère", kind: "csv", config: {} })).body.connector;
  await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "reception", mappings: [
      { entity: "reception", mems_field: "geo_pcode", source_path: "pcode", transform: "pcode" },
      { entity: "reception", mems_field: "tonnage_recu", source_path: "mt", transform: "nombre" }] });

  const del = await request(app).delete(`/api/connectors/${c.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.mappingsSupprimees, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM connector_mapping WHERE connector_id=?")
    .get(c.id).c, 0);
  assert.equal((await request(app).get(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)).status, 404);
});

test("connecteurs : la valeur par défaut passe par la même transformation que la valeur lue", async () => {
  const c = (await creerConnecteur({ name: "Réceptions collées", kind: "csv", config: {} })).body.connector;
  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "reception",
      mappings: [
        { entity: "reception", mems_field: "geo_pcode", source_path: "code", transform: "pcode" },
        /* L'année n'est pas dans le fichier : elle vaut celle de la campagne. */
        { entity: "reception", mems_field: "annee", source_path: "annee", transform: "entier",
          default_value: "2026" },
        { entity: "reception", mems_field: "mois", source_path: "mois", transform: "entier" },
        { entity: "reception", mems_field: "tonnage_recu", source_path: "recu", transform: "nombre" }],
      echantillon: [{ code: "mg 232-090 50001", mois: "3", recu: "12,5" }] });

  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, JSON.stringify(r.body.manquants));
  const apres = r.body.lignes[0].apres;
  assert.equal(apres.annee, 2026, "le défaut arrive en entier, pas en texte : sinon deux lignes du "
    + "même import n'auraient pas le même type");
  assert.equal(apres.geo_pcode, "MG23209050001");
  assert.equal(apres.tonnage_recu, 12.5);

  /* Une transformation hors du jeu fermé est refusée à l'aperçu comme à
     l'enregistrement : un aperçu plus permissif enverrait travailler pour rien. */
  const zzz = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "reception", echantillon: [{ code: "X" }],
      mappings: [{ entity: "reception", mems_field: "geo_pcode", source_path: "code",
        transform: "regex_maison" }] });
  assert.equal(zzz.status, 422);
  assert.match(JSON.stringify(zzz.body.details), /transformation inconnue/);
});

/* ═══════════════════════════════════════════════════════════════════════
   AUTHENTIFICATION SORTANTE — le schéma est une donnée, pas une hypothèse

   Ce qui est éprouvé ici, c'est le COMPORTEMENT, contre un serveur simulé en
   mémoire : la suite tourne sans réseau, et elle ne prouve donc rien du
   comportement d'une vraie instance ODK Central ou KoboToolbox. Ce qu'elle
   prouve, en revanche, ne dépend d'aucune supposition :

     — l'en-tête réellement émis, mot-clé compris, pour chacun des six schémas ;
     — qu'une source déclarée AVANT la migration 021 continue d'émettre
       exactement `Bearer <jeton>`, sans ressaisie ;
     — qu'une session expirée est renouvelée UNE fois et une seule ;
     — qu'un échec de renouvellement se signale et ne se rejoue pas, et qu'un
       justificatif corrigé lève ce blocage sur-le-champ ;
     — que deux tirages simultanés n'ouvrent qu'une seule session ;
     — que chacune des causes d'échec rend son propre message ;
     — qu'aucun secret ne sort d'aucune de ces réponses.

   Le serveur simulé ci-dessous imite les DEUX familles à la fois — ouverture de
   session façon ODK Central, clé d'API et refus façon KoboToolbox — parce que
   c'est le croisement des deux qui a fait le défaut : un seul schéma codé en dur
   pour des sources qui n'en attendent pas le même.
   ═══════════════════════════════════════════════════════════════════════ */

/* Le chiffrement au repos, pour planter des justificatifs comme la base les
   porte. Nommé autrement que le `encrypt` importé plus bas : deux `const` du
   même nom dans le même module ne coexistent pas. */
const { encrypt: chiffrer } = await import("../src/lib/crypto.js");

const AUTH = {
  courriel: "agent@odk.test",
  motDePasse: "MotDePasseOdk2026",
  cleKobo: "cle-api-kobo-40-caracteres-exactement-x",
  jetonFixe: "jeton-fixe-de-la-source",
};
const basique = (id, mdp) => "Basic " + Buffer.from(`${id}:${mdp}`, "utf8").toString("base64");

let srcMock, srcUrl, srcRequetes, srcSessions;
{
  srcRequetes = [];
  /* `emises` compte les ouvertures de session : c'est le chiffre sur lequel
     reposent « une seule fois » et « une seule en vol ». `courante` est le seul
     jeton accepté — une session périmée est donc simplement un jeton qui n'est
     plus `courante`, exactement comme chez ODK Central, où la vérification se
     fait à chaque requête. */
  srcSessions = { emises: 0, courante: null, refuseIdentifiants: false,
    refuseToujours: false, lenteurMs: 0,
    /* Ce que la source ANNONCE comme échéance. `dureeMs` la raccourcit —
       `sessionLifetime` est un réglage de l'exploitant ODK, rien n'oblige qu'il
       dépasse la marge de renouvellement de MEMS. `expireIllisible` rend une
       valeur qui n'est pas une date : le module se veut tolérant sur la forme de
       la réponse, encore faut-il que ce qu'il met en cache reste calculable. */
    dureeMs: null, expireIllisible: null,
    /* La source ne répond plus du tout : la panne d'une seconde, la bascule de
       proxy. Ce n'est PAS un refus, et les deux ne s'expient pas pareil. */
    injoignable: false };

  const json = (res, code, corps, entetes = {}) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    for(const [k, v] of Object.entries(entetes)) res.setHeader(k, v);
    res.end(JSON.stringify(corps));
  };
  /* Le refus de KoboToolbox, tel que kpi/authentication.py le produit : le
     `WWW-Authenticate` nomme le schéma attendu, et c'est le SEUL signal qui
     sépare « mauvais mot-clé » de « mauvais jeton ». */
  const refusKobo = (res, attendu, detail) =>
    json(res, 401, { detail }, { "WWW-Authenticate": attendu });

  srcMock = http.createServer(async (req, res) => {
    const auth = req.headers.authorization;
    const chemin = req.url.split("?")[0];
    srcRequetes.push({ url: req.url, chemin, methode: req.method, auth });

    /* ── Ouverture de session, façon ODK Central ── */
    if(chemin === "/v1/sessions" && req.method === "POST"){
      let corps = ""; for await (const c of req) corps += c;
      if(srcSessions.injoignable) return req.socket.destroy();
      if(srcSessions.lenteurMs) await new Promise(r => setTimeout(r, srcSessions.lenteurMs));
      const d = JSON.parse(corps || "{}");
      if(srcSessions.refuseIdentifiants || d.email !== AUTH.courriel || d.password !== AUTH.motDePasse)
        return json(res, 401, { message: "Could not authenticate with the provided credentials.",
          code: 401.2 });
      srcSessions.emises++;
      srcSessions.courante = `session-${srcSessions.emises}`;
      return json(res, 200, { token: srcSessions.courante, csrf: "peu-importe",
        expiresAt: srcSessions.expireIllisible
          || new Date(Date.now() + (srcSessions.dureeMs || 3600_000)).toISOString(),
        createdAt: new Date().toISOString() });
    }

    const sessionValide = () => !srcSessions.refuseToujours
      && !!srcSessions.courante && auth === `Bearer ${srcSessions.courante}`;

    if(chemin === "/v1/users/current"){
      if(!sessionValide()) return json(res, 401,
        { message: "Could not authenticate with the provided credentials.", code: 401.2 });
      return json(res, 200, { id: 7, email: AUTH.courriel });
    }

    /* Un formulaire dont le nom commence par « sans-droit » répond 403 : compte
       reconnu, action interdite. Il est examiné AVANT le cas général, sans quoi
       le cas général l'absorberait et 403 ne serait jamais produit. */
    if(/^\/v1\/projects\/[^/]+\/forms\/sans-droit[^/]*\.svc\/Submissions$/.test(chemin))
      return json(res, 403, { message: "The authenticated actor does not have rights to perform "
        + "that action.", code: 403.1 });

    /* Un formulaire qui refuse en 401 même sous une session valide : jeton révoqué
       entre deux appels, proxy inverse qui filtre la voie OData. C'est le seul
       chemin par lequel l'étape 2 de l'épreuve rencontre un 401 après une étape 1
       réussie — et donc le seul qui montre si son message dit vrai. */
    if(/^\/v1\/projects\/[^/]+\/forms\/refus-401[^/]*\.svc\/Submissions$/.test(chemin))
      return json(res, 401, { message: "Could not authenticate.", code: 401.2 });

    /* Le tirage OData, réservé à une session valide : c'est le cœur du test de
       renouvellement — un jeton périmé y revient en 401 sans autre indice. */
    if(/^\/v1\/projects\/[^/]+\/forms\/[^/]+\.svc\/Submissions$/.test(chemin)){
      if(!sessionValide()) return json(res, 401,
        { message: "Could not authenticate with the provided credentials.", code: 401.2 });
      return json(res, 200, { value: [{ __id: "sess1", SvyDate: "2026-04-01", EnuName: "Session" }] });
    }

    /* ── Clé d'API et lecture, façon KoboToolbox ── */
    if(chemin === "/token/"){
      if(auth !== basique(AUTH.courriel, AUTH.motDePasse))
        return json(res, 401, { detail: "Invalid username/password." });
      return json(res, 200, { token: AUTH.cleKobo });
    }
    /* Rend `true` quand la demande est refusée — la réponse est alors déjà écrite. */
    const koboRefuse = (bon) => {
      if(!auth || !/^Token /.test(auth)){
        refusKobo(res, "Session", "Authentication credentials were not provided."); return true;
      }
      if(auth !== `Token ${bon}`){ refusKobo(res, "Token", "Invalid token."); return true; }
      return false;
    };
    if(chemin === "/me/"){
      if(koboRefuse(AUTH.cleKobo)) return;
      return json(res, 200, { username: "agent" });
    }
    if(/^\/api\/v2\/assets\/[^/]+\/data\/$/.test(chemin)){
      if(koboRefuse(AUTH.cleKobo)) return;
      return json(res, 200, { count: 2, next: null, previous: null, results: [
        { pcode: "mg 232 09050001", annee: "2026", mois: "4", planifie: "1 400", atteint: "1 380" },
        { pcode: "MG23209050002", annee: "2026", mois: "4", planifie: "700", atteint: "690" }] });
    }

    /* ── Points d'entrée neutres, pour lire l'en-tête réellement émis ── */
    if(chemin === "/entetes")
      return json(res, 200, { results: [{ recu: auth === undefined ? null : auth }] });
    /* Un refus SANS le moindre indice : ni code Problem, ni WWW-Authenticate.
       C'est le cas où aucune des cinq causes n'est démontrable, et où le message
       doit le dire au lieu d'en désigner une au hasard. */
    if(chemin === "/muet"){ res.statusCode = 401; return res.end("refusé"); }
    /* Le 403 de Django REST Framework — donc de KoboToolbox — quand
       l'authentifieur en tête de liste n'expose pas de `WWW-Authenticate` : le
       code dit 403, le corps dit qu'aucun justificatif n'a été fourni. */
    if(chemin === "/403drf")
      return json(res, 403, { detail: "Authentication credentials were not provided." });
    /* Le même refus, mais la source NOMME le mot-clé qu'elle attendait. Seul le
       code HTTP diffère du 401 équivalent : le diagnostic ne doit pas en dépendre. */
    if(chemin === "/403token")
      return json(res, 403, { detail: "Invalid token." }, { "WWW-Authenticate": "Token" });

    json(res, 404, { detail: "Not found." });
  });
  await new Promise(r => srcMock.listen(0, "127.0.0.1", r));
  srcUrl = `http://127.0.0.1:${srcMock.address().port}`;
  after(() => srcMock.close());
}

const dernierAppel = (chemin) => [...srcRequetes].reverse().find(q => q.chemin === chemin);
const compter = (chemin) => srcRequetes.filter(q => q.chemin === chemin).length;

/* Un connecteur « http » qui interroge /entetes : le plus court chemin pour
   observer ce qui part réellement dans l'en-tête, schéma par schéma. */
const connecteurEntetes = async (nom, extra) => (await creerConnecteur({
  name: nom, kind: "http", base_url: srcUrl, config: { chemin: "/entetes" },
  ...extra })).body.connector;

const apercuDe = (id) => request(app).post(`/api/connectors/${id}/apercu`)
  .set("Authorization", `Bearer ${adminToken}`)
  .send({ entity: "beneficiaire", limite: 1, mappings: [
    { entity: "beneficiaire", mems_field: "geo_pcode", source_path: "pcode" }] });

test("authentification sortante : chaque schéma émet SON en-tête, et « Bearer » n'est plus une hypothèse", async () => {
  /* Le point que la demande vise : un jeton Kobo présenté en « Bearer » est
     refusé alors qu'il est bon. Le mot-clé doit donc venir de la source, pas du
     code — et se vérifier octet par octet, pas de confiance. */
  const cas = [
    ["porteur",  { secret: AUTH.jetonFixe }, `Bearer ${AUTH.jetonFixe}`],
    ["jeton",    { secret: AUTH.jetonFixe }, `Token ${AUTH.jetonFixe}`],
    ["basique",  { secret: AUTH.motDePasse, auth_identifiant: AUTH.courriel },
                 basique(AUTH.courriel, AUTH.motDePasse)],
    ["aucun",    {}, null],
  ];
  for(const [schema, extra, attendu] of cas){
    const c = await connecteurEntetes(`En-tête — ${schema}`, { auth_schema: schema, ...extra });
    const r = await apercuDe(c.id);
    assert.equal(r.status, 200, `${schema} : ${JSON.stringify(r.body)}`);
    assert.equal(dernierAppel("/entetes").auth, attendu ?? undefined,
      `le schéma « ${schema} » doit émettre exactement « ${attendu ?? "aucun en-tête"} »`);
  }

  /* Les deux schémas qui DÉRIVENT un second secret : ce qui part n'est pas ce
     qui a été saisi. C'est littéralement le « token à part » de la demande. */
  const cSession = await connecteurEntetes("En-tête — session ODK", {
    auth_schema: "odk_session", auth_identifiant: AUTH.courriel, secret: AUTH.motDePasse });
  assert.equal((await apercuDe(cSession.id)).status, 200);
  assert.equal(dernierAppel("/entetes").auth, `Bearer ${srcSessions.courante}`,
    "le jeton émis est la SESSION dérivée, jamais le mot de passe saisi");
  assert.ok(!srcRequetes.some(q => String(q.auth || "").includes(AUTH.motDePasse)),
    "le mot de passe ne part jamais dans un en-tête d'autorisation Bearer ou Token");

  const cKobo = await connecteurEntetes("En-tête — clé Kobo dérivée", {
    auth_schema: "kobo_jeton", auth_identifiant: AUTH.courriel, secret: AUTH.motDePasse });
  assert.equal((await apercuDe(cKobo.id)).status, 200);
  assert.equal(dernierAppel("/entetes").auth, `Token ${AUTH.cleKobo}`,
    "la clé d'API obtenue en Basic repart ensuite sous le mot-clé « Token »");
  /* Elle n'expire pas : un second appel ne la redemande pas. */
  const avant = compter("/token/");
  assert.equal((await apercuDe(cKobo.id)).status, 200);
  assert.equal(compter("/token/"), avant,
    "une clé d'API Kobo ne périme pas : elle est obtenue une fois, pas à chaque appel");
});

test("authentification sortante : la table des schémas est servie par le serveur, jamais recopiée dans l'écran", async () => {
  for(const chemin of ["/api/connectors/champs", "/api/state"]){
    const r = await request(app).get(chemin).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(r.status, 200);
    const table = r.body.schemasAuth;
    assert.ok(Array.isArray(table), `${chemin} sert la table des schémas`);
    for(const cle of ["aucun", "porteur", "jeton", "basique", "odk_session", "kobo_jeton"])
      assert.ok(table.some(x => x.cle === cle), `${chemin} déclare le schéma ${cle}`);
    /* Chaque entrée porte de quoi bâtir l'écran sans rien deviner : ce qu'il faut
       demander, et où l'administrateur trouve ce justificatif chez la source. */
    for(const s of table){
      assert.ok(s.libelle && s.note && s.note.length > 30, `${s.cle} : libellé et explication`);
      assert.ok(s.ou_trouver, `${s.cle} : où trouver le justificatif`);
      assert.ok(Array.isArray(s.champs), `${s.cle} : les champs à demander`);
    }
    const session = table.find(x => x.cle === "odk_session");
    assert.equal(session.derive, true);
    assert.equal(session.perissable, true, "une session ODK expire");
    assert.equal(table.find(x => x.cle === "kobo_jeton").perissable, false,
      "une clé d'API Kobo n'expire pas — la table sait exprimer les deux");
    assert.equal(session.chemin.defaut, "/v1/sessions");
  }
});

test("authentification sortante : une source déclarée AVANT la migration continue d'émettre Bearer, sans ressaisie", async () => {
  /* La ligne est insérée sans nommer `auth_schema` ni `auth_identifiant` : c'est
     exactement l'état d'une source existante au moment où la migration 021
     s'applique. Rien n'est ressaisi, et l'en-tête doit être identique à l'octet
     près à ce qu'il était avant le chantier. */
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind)
              VALUES ('odkf_heritee','Source héritée','testform','9',?,'process')`)
    .run(chiffrer("jeton-de-test"));
  const f = db.prepare("SELECT * FROM odk_forms WHERE id='odkf_heritee'").get();
  assert.equal(f.auth_schema, "porteur", "la migration a posé « porteur » par défaut");
  assert.equal(f.auth_identifiant, null);

  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: odkMockUrl });
  const avant = odkMockRequests.length;
  const r = await request(app).post("/api/odk-forms/odkf_heritee/pull")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.records, 3);
  assert.ok(odkMockRequests.slice(avant).length > 0);
  assert.ok(odkMockRequests.slice(avant).every(q => q.auth === "Bearer jeton-de-test"),
    "le jeton collé part tel quel, sous le même mot-clé qu'avant la migration");
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_heritee'").run();

  /* L'autre moitié de la reprise, celle qu'on oublie : un connecteur réseau SANS
     secret n'émettait aucun en-tête et fonctionnait donc sur une source publique.
     La migration écrit noir sur blanc ce qu'il faisait déjà, plutôt que de le
     refuser du jour au lendemain au nom d'un justificatif qu'il n'a jamais eu. */
  const { default: SQLiteReprise } = await import("better-sqlite3");
  const avant021 = new SQLiteReprise(path.join(os.tmpdir(), `mems-reprise-${Date.now()}.db`));
  try{
    const dossier = path.resolve("./migrations");
    for(const nom of fs.readdirSync(dossier).filter(x => x.endsWith(".sql")).sort()){
      if(nom.startsWith("021")) continue;
      avant021.exec(fs.readFileSync(path.join(dossier, nom), "utf8"));
    }
    avant021.prepare("INSERT INTO connector (id,name,kind,base_url,secret_enc) VALUES (?,?,?,?,?)")
      .run("c_public", "Export public", "http", "https://ouvert.test", null);
    avant021.prepare("INSERT INTO connector (id,name,kind,base_url,secret_enc) VALUES (?,?,?,?,?)")
      .run("c_prive", "Export privé", "http", "https://ferme.test", "deja-chiffre");
    avant021.prepare("INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind) VALUES (?,?,?,?,?,?)")
      .run("f_avant", "Source d'avant", "F", "1", "deja-chiffre", "process");

    avant021.exec(fs.readFileSync(path.join(dossier, "021_auth_sortante.sql"), "utf8"));

    const lu = (id) => avant021.prepare("SELECT auth_schema FROM connector WHERE id=?").get(id).auth_schema;
    assert.equal(lu("c_public"), "aucun",
      "un connecteur qui n'émettait aucun en-tête continue de n'en émettre aucun");
    assert.equal(lu("c_prive"), "porteur", "celui qui avait un secret garde le schéma d'avant");
    assert.equal(avant021.prepare("SELECT auth_schema FROM odk_forms WHERE id='f_avant'").get().auth_schema,
      "porteur", "une source ODK existante garde « Bearer »");
    assert.equal(avant021.pragma("integrity_check", { simple:true }), "ok");
    assert.equal(avant021.pragma("foreign_key_check").length, 0);
  } finally {
    const f = avant021.name; avant021.close();
    for(const x of [f, f + "-wal", f + "-shm"]) if(fs.existsSync(x)) fs.unlinkSync(x);
  }
});

/* Une source ODK réglée en « session » : c'est le cas B de la demande — ODK
   Central ne délivre pas de jeton permanent à un compte web. */
const sourceSession = async (id, nom, formId, identifiant = AUTH.courriel,
                             motDePasse = AUTH.motDePasse) => {
  /* La suppression préalable vaut aussi purge du cache de session : le
     déclencheur de la migration 021 emporte la ligne de `source_session`. Chaque
     test repart donc d'un état net sans avoir à le dire. */
  db.prepare("DELETE FROM odk_forms WHERE id=?").run(id);
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind,auth_schema,auth_identifiant)
              VALUES (?,?,?,'1',?,'process','odk_session',?)`)
    .run(id, nom, formId, chiffrer(motDePasse), identifiant);
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: srcUrl });
  return db.prepare("SELECT * FROM odk_forms WHERE id=?").get(id);
};
const tirer = (id) => request(app).post(`/api/odk-forms/${id}/pull`)
  .set("Authorization", `Bearer ${adminToken}`);
/* `odk_forms` impose l'unicité du couple (projet, formulaire) : chaque source de
   test porte donc son propre identifiant de formulaire. */
const soumissionsDe = (formId) => compter(`/v1/projects/1/forms/${formId}.svc/Submissions`);

test("authentification sortante : une session expirée est renouvelée UNE fois, et une seule", async () => {
  await sourceSession("odkf_sess", "Session ODK", "sess");
  srcSessions.refuseToujours = false;
  srcSessions.refuseIdentifiants = false;

  /* Premier tirage : aucune session en cache, MEMS en ouvre une. */
  const emises0 = srcSessions.emises;
  assert.equal((await tirer("odkf_sess")).status, 200);
  assert.equal(srcSessions.emises, emises0 + 1, "une session ouverte, pas deux");

  /* Second tirage : la session est encore valable, on ne la redemande pas.
     C'est ce qui distingue un cache d'une ouverture à chaque appel. */
  assert.equal((await tirer("odkf_sess")).status, 200);
  assert.equal(srcSessions.emises, emises0 + 1, "la session en cache est réutilisée");

  /* La source périme la session dans son dos, SANS que l'échéance annoncée soit
     passée : c'est le cas « une date d'expiration annoncée peut mentir ». Le
     401 doit donc suffire à déclencher le renouvellement. */
  srcSessions.courante = "session-perimee-cote-source";
  const appels0 = soumissionsDe("sess");
  const r = await tirer("odkf_sess");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(srcSessions.emises, emises0 + 2, "exactement un renouvellement");
  assert.equal(soumissionsDe("sess"), appels0 + 2,
    "un refus, un renouvellement, un rejeu — et rien de plus");
});

test("authentification sortante : un refus qui persiste après renouvellement ne boucle pas, et nomme son hypothèse", async () => {
  await sourceSession("odkf_boucle", "Session obstinée", "boucle");
  srcSessions.refuseIdentifiants = false;
  srcSessions.refuseToujours = false;
  /* Un premier tirage réussi met une session en cache : on isole ainsi le
     RENOUVELLEMENT de l'ouverture initiale, qui n'est pas la même chose. */
  assert.equal((await tirer("odkf_boucle")).status, 200);

  /* La source continue d'ouvrir des sessions mais refuse désormais tout appel :
     le justificatif est frais et pourtant rejeté. Sans garde-fou, on
     renouvellerait indéfiniment. */
  srcSessions.refuseToujours = true;
  const emises0 = srcSessions.emises;
  const appels0 = soumissionsDe("boucle");

  const r = await tirer("odkf_boucle");
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.equal(r.body.cause, "AUTH_SCHEMA");
  assert.match(r.body.error, /renouvelé à l'instant/);
  assert.match(r.body.error, /Ce n'est pas un verdict/,
    "le diagnostic se formule en hypothèse nommée, pas en verdict");
  assert.equal(srcSessions.emises, emises0 + 1, "un seul renouvellement, jamais deux");
  assert.equal(soumissionsDe("boucle"), appels0 + 2,
    "deux appels au plus : l'original et le rejeu");
  srcSessions.refuseToujours = false;
});

test("authentification sortante : un échec d'ouverture se signale, ne se rejoue pas, et se débloque en corrigeant", async () => {
  await sourceSession("odkf_echec", "Mot de passe faux", "echec", AUTH.courriel, "mauvais-mot-de-passe");
  srcSessions.refuseToujours = false;
  const tentatives0 = compter("/v1/sessions");

  const un = await tirer("odkf_echec");
  assert.equal(un.status, 422, JSON.stringify(un.body));
  assert.equal(un.body.cause, "AUTH_SESSION");
  assert.match(un.body.error, /courriel ou mot de passe refusé/);
  assert.equal(compter("/v1/sessions"), tentatives0 + 1, "une tentative d'ouverture");

  /* Le deuxième tirage ne doit RIEN redemander à la source : l'échec est
     consigné et rendu tel quel. C'est la différence entre signaler et marteler. */
  const deux = await tirer("odkf_echec");
  assert.equal(deux.status, 422);
  assert.equal(deux.body.cause, "AUTH_SESSION");
  assert.match(deux.body.error, /n'est pas rejoué/);
  assert.match(deux.body.error, /courriel ou mot de passe refusé/,
    "la cause du premier échec est conservée et rendue, pas remplacée par un message vague");
  assert.equal(compter("/v1/sessions"), tentatives0 + 1,
    "aucune nouvelle tentative tant que le justificatif n'a pas changé");
  assert.ok(db.prepare(`SELECT echec_motif FROM source_session
                        WHERE source_kind='odk_forms' AND source_id='odkf_echec'`).get().echec_motif,
    "le motif est consigné en base, donc affichable à l'administrateur");

  /* Corriger le mot de passe change l'empreinte du justificatif : le blocage
     tombe sans que personne n'ait eu à vider un cache. */
  db.prepare("UPDATE odk_forms SET token_enc=? WHERE id='odkf_echec'").run(chiffrer(AUTH.motDePasse));
  const trois = await tirer("odkf_echec");
  assert.equal(trois.status, 200, JSON.stringify(trois.body));
  assert.equal(compter("/v1/sessions"), tentatives0 + 2,
    "le justificatif corrigé relance une tentative, immédiatement");
});

test("authentification sortante : deux tirages simultanés n'ouvrent qu'une seule session", async () => {
  await sourceSession("odkf_concur", "Deux tirages", "concur");
  srcSessions.refuseToujours = false;
  /* Sans le partage de la promesse en cours, les deux appels constateraient
     l'absence de cache en même temps et ouvriraient chacun leur session. La
     lenteur simulée garantit que le second démarre bien avant que le premier
     n'ait fini. */
  srcSessions.lenteurMs = 120;
  const emises0 = srcSessions.emises;
  const [a, b] = await Promise.all([tirer("odkf_concur"), tirer("odkf_concur")]);
  srcSessions.lenteurMs = 0;
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(srcSessions.emises, emises0 + 1,
    "une seule session ouverte pour deux tirages concurrents");
});

test("authentification sortante : chaque cause d'échec rend son propre message", async () => {
  const messages = new Map();
  const noter = (cause, message) => {
    assert.ok(cause, `cause attendue, message rendu : ${message}`);
    assert.ok(!messages.has(cause) || messages.get(cause) === message,
      `la cause ${cause} doit rendre un message stable`);
    messages.set(cause, message);
  };

  /* 1. AUTH_ABSENT — se constate sans sortir sur le réseau. */
  const absent = (await creerConnecteur({ name: "Sans justificatif", kind: "http",
    base_url: srcUrl, config: { chemin: "/entetes" }, auth_schema: "porteur" })).body.connector;
  const appels0 = srcRequetes.length;
  const rAbsent = await apercuDe(absent.id);
  assert.equal(rAbsent.status, 422, JSON.stringify(rAbsent.body));
  assert.equal(rAbsent.body.cause, "AUTH_ABSENT");
  assert.match(rAbsent.body.error, /n'a pas de justificatif complet/);
  assert.equal(srcRequetes.length, appels0,
    "un justificatif manquant se constate avant de sortir, pas après un 401");
  noter(rAbsent.body.cause, rAbsent.body.error);

  /* 2. AUTH_SCHEMA — le mot-clé émis n'est pas celui que la source attendait.
     C'est le défaut Kobo, dans sa forme exacte : le jeton est bon, le mot-clé non.
     Le message rend le mot-clé annoncé ET le schéma déclarable à essayer : chez
     Kobo, « Session » n'est pas un schéma qu'on puisse choisir — c'est la façon
     dont Django REST Framework dit qu'aucun authentifieur n'a reconnu l'en-tête.
     Un test qui figeait « adoptez celui qu'elle réclame » figeait la mauvaise
     consigne ; voir le test dédié plus bas. */
  const mauvaisSchema = (await creerConnecteur({ name: "Kobo en Bearer", kind: "kobo",
    base_url: srcUrl, config: { uid: "aXyZ" }, auth_schema: "porteur",
    secret: AUTH.cleKobo })).body.connector;
  const rSchema = await apercuDe(mauvaisSchema.id);
  assert.equal(rSchema.status, 422, JSON.stringify(rSchema.body));
  assert.equal(rSchema.body.cause, "AUTH_SCHEMA");
  assert.match(rSchema.body.error, /« Bearer »/);
  assert.match(rSchema.body.error, /« Session »/);
  assert.match(rSchema.body.error, /Jeton \(Token\)/);
  noter(rSchema.body.cause, rSchema.body.error);

  /* 3. AUTH_SESSION — la session n'a pas pu être ouverte. */
  await sourceSession("odkf_echec_bis", "Session impossible", "echec-bis", AUTH.courriel, "faux");
  const rSess = await tirer("odkf_echec_bis");
  assert.equal(rSess.status, 422);
  assert.equal(rSess.body.cause, "AUTH_SESSION");
  noter(rSess.body.cause, rSess.body.error);

  /* 4. AUTH_DROITS — authentifié, mais sans droit. 403 et 401 ne se confondent
     plus : c'est le gain de diagnostic le moins cher du chantier. */
  await sourceSession("odkf_droits", "Sans droit sur le formulaire", "sans-droit-a");
  srcSessions.refuseToujours = false;
  const rDroits = await tirer("odkf_droits");
  assert.equal(rDroits.status, 422, JSON.stringify(rDroits.body));
  assert.equal(rDroits.body.cause, "AUTH_DROITS");
  assert.match(rDroits.body.error, /droits/);
  assert.match(rDroits.body.error, /CHEZ LA SOURCE/);
  noter(rDroits.body.cause, rDroits.body.error);

  /* 5. AUTH_HOTE — refusé avant tout appel par la garde anti-SSRF. */
  const horsListe = (await creerConnecteur({ name: "Hôte refusé", kind: "http",
    base_url: "http://169.254.169.254", config: { chemin: "/entetes" },
    auth_schema: "porteur", secret: "x" })).body.connector;
  const rHote = await apercuDe(horsListe.id);
  assert.equal(rHote.status, 422);
  assert.equal(rHote.body.cause, "AUTH_HOTE");
  assert.match(rHote.body.error, /CONNECTOR_ALLOWED_HOSTS/);

  /* 6. AUTH_REFUS — la source refuse sans rien dire. Le message le DIT, au lieu
     d'accuser le jeton comme le faisait le texte unique d'avant. */
  const muet = (await creerConnecteur({ name: "Refus muet", kind: "http",
    base_url: srcUrl, config: { chemin: "/muet" }, auth_schema: "jeton",
    secret: AUTH.jetonFixe })).body.connector;
  const rMuet = await apercuDe(muet.id);
  assert.equal(rMuet.status, 422, JSON.stringify(rMuet.body));
  assert.equal(rMuet.body.cause, "AUTH_REFUS");
  assert.match(rMuet.body.error, /sans qu'elle en précise la cause/);
  assert.match(rMuet.body.error, /n'expire pas/,
    "le message explique ce que ce schéma-là implique, au lieu d'énumérer cinq causes");
  noter(rMuet.body.cause, rMuet.body.error);

  /* Aucun des messages n'est le message fourre-tout d'avant, et ils sont tous
     différents les uns des autres. */
  const textes = [...messages.values(), rHote.body.error];
  assert.equal(new Set(textes).size, textes.length, "cinq causes, cinq messages distincts");
  for(const t of textes)
    assert.ok(!/jeton absent, expiré, ou sans droit/.test(t),
      "le message qui confondait trois causes a disparu");
});

test("connecteur KoboToolbox : la nature « kobo » est réellement lue, avec le mot-clé qu'elle attend", async () => {
  /* Avant ce chantier, un connecteur Kobo était déclarable mais mort : l'aperçu
     répondait qu'une source de ce type « n'est pas lue par le serveur », tout en
     exigeant son adresse de base. */
  const c = (await creerConnecteur({ name: "Kobo — bénéficiaires", kind: "kobo",
    base_url: srcUrl, config: { uid: "aXyZ123" }, auth_schema: "jeton",
    secret: AUTH.cleKobo })).body.connector;

  await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity: "beneficiaire", mappings: [
      { entity: "beneficiaire", mems_field: "geo_pcode", source_path: "pcode", transform: "pcode" },
      { entity: "beneficiaire", mems_field: "annee", source_path: "annee", transform: "entier" },
      { entity: "beneficiaire", mems_field: "mois", source_path: "mois", transform: "entier" },
      { entity: "beneficiaire", mems_field: "planifies", source_path: "planifie", transform: "entier" },
      { entity: "beneficiaire", mems_field: "atteints", source_path: "atteint", transform: "entier" }] });

  const r = await request(app).post(`/api/connectors/${c.id}/apercu`)
    .set("Authorization", `Bearer ${adminToken}`).send({ entity: "beneficiaire", limite: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.provenance, /lecture distante \(kobo/);
  assert.equal(r.body.lignesLues, 2);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.manquants));
  assert.equal(r.body.lignes[0].apres.geo_pcode, "MG23209050001");
  assert.equal(r.body.lignes[0].apres.planifies, 1400);

  const appel = dernierAppel("/api/v2/assets/aXyZ123/data/");
  assert.ok(appel, "le serveur va bien lire l'asset Kobo");
  assert.equal(appel.auth, `Token ${AUTH.cleKobo}`, "mot-clé « Token », jamais « Bearer »");
  assert.match(appel.url, /limit=5/, "la pagination de Kobo est celle de Kobo, pas celle d'OData");

  /* Un uid manquant se dit à la déclaration, pas au premier aperçu. */
  const sansUid = await creerConnecteur({ name: "Kobo sans uid", kind: "kobo",
    base_url: srcUrl, config: {}, auth_schema: "jeton", secret: "x" });
  assert.equal(sansUid.status, 422);
  assert.match(sansUid.body.error, /uid/);
});

test("épreuve de connexion : un diagnostic utilisable, et jamais le secret", async () => {
  await sourceSession("odkf_epreuve", "Épreuve", "epreuve");
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;

  const ok = await request(app).post("/api/odk-forms/odkf_epreuve/test")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(ok.body.etapes.length, 2, "deux étapes : le justificatif, puis CE formulaire");
  assert.equal(ok.body.etapes[0].etape, "justificatif");
  assert.equal(ok.body.etapes[0].schema_employe, "odk_session");
  assert.equal(ok.body.etapes[0].mot_cle, "Bearer");
  assert.equal(ok.body.etapes[0].hote_verifie, true);
  assert.equal(ok.body.etapes[0].code_http, 200);
  assert.equal(ok.body.etapes[0].indices.present, true);
  assert.equal(ok.body.etapes[0].indices.longueur, AUTH.motDePasse.length);
  assert.equal(ok.body.etapes[1].etape, "formulaire");

  /* Les deux étapes ne disent pas la même chose, et c'est tout leur intérêt :
     un justificatif valide qui n'ouvre pas CE formulaire se voit à l'étape 2. */
  await sourceSession("odkf_epreuve2", "Épreuve sans droit", "sans-droit-b");
  const partiel = await request(app).post("/api/odk-forms/odkf_epreuve2/test")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(partiel.body.ok, false);
  assert.equal(partiel.body.etapes[0].ok, true, "le compte est bon");
  assert.equal(partiel.body.etapes[1].cause, "AUTH_DROITS", "les droits sur le formulaire, non");

  /* Côté connecteurs, la même épreuve, avec le même engagement sur le secret. */
  const c = (await creerConnecteur({ name: "Épreuve Kobo", kind: "kobo", base_url: srcUrl,
    config: { uid: "aXyZ" }, auth_schema: "jeton", secret: AUTH.cleKobo })).body.connector;
  const rc = await request(app).post(`/api/connectors/${c.id}/test`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(rc.body.ok, true, JSON.stringify(rc.body));
  assert.equal(rc.body.etapes[0].mot_cle, "Token");
  assert.equal(dernierAppel("/me/").auth, `Token ${AUTH.cleKobo}`,
    "l'épreuve vise un point d'entrée qui ne lit aucune donnée");

  /* Aucun secret, sous aucune forme, dans aucune de ces réponses. */
  for(const corps of [ok, partiel, rc].map(x => JSON.stringify(x.body))){
    for(const secret of [AUTH.motDePasse, AUTH.cleKobo, AUTH.jetonFixe])
      assert.ok(!corps.includes(secret), "l'épreuve ne renvoie jamais le secret");
    for(const cle of ['"token"', '"secret"', '"password"', '"token_enc"', '"secret_enc"',
                      '"jeton_enc"'])
      assert.ok(!corps.includes(cle), `l'épreuve expose le champ ${cle}`);
    /* Pas davantage les quatre derniers caractères : la maison ne rend que la
       présence, et la longueur — qui diagnostique un copier-coller tronqué. */
    assert.ok(!corps.includes(AUTH.cleKobo.slice(-4)), "aucun fragment du secret ne sort");
  }

  /* Et l'épreuve est réservée à l'administration, comme le tirage et l'aperçu :
     elle déchiffre un secret et sort sur le réseau au nom du bureau. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecteur-epreuve@test.local", password:"LecteurEpreuve2026", first_name:"Lecteur",
            role:"viewer", tabs:["home"], active:true });
  motDePasseAdopte("lecteur-epreuve@test.local");
  const lr = await login("lecteur-epreuve@test.local", "LecteurEpreuve2026");
  assert.equal(lr.status, 200, JSON.stringify(lr.body));
  assert.equal((await request(app).post(`/api/connectors/${c.id}/test`)
    .set("Authorization", `Bearer ${lr.body.token}`)).status, 403);
  assert.equal((await request(app).post("/api/odk-forms/odkf_epreuve/test")
    .set("Authorization", `Bearer ${lr.body.token}`)).status, 403);
});

test("authentification sortante : le jeton dérivé est chiffré au repos et ne sort par aucune route", async () => {
  await sourceSession("odkf_cache", "Cache chiffré", "cache");
  srcSessions.refuseToujours = false;
  assert.equal((await tirer("odkf_cache")).status, 200);

  const ligne = db.prepare(`SELECT * FROM source_session
                            WHERE source_kind='odk_forms' AND source_id='odkf_cache'`).get();
  assert.ok(ligne, "la session dérivée est bien mise en cache");
  assert.ok(ligne.jeton_enc && !ligne.jeton_enc.includes(srcSessions.courante),
    "le jeton de session est chiffré comme tout secret au repos, malgré sa courte vie");
  assert.ok(ligne.expire_le, "l'échéance annoncée par la source est conservée telle quelle");
  assert.ok(!ligne.empreinte.includes(AUTH.motDePasse),
    "l'empreinte ne porte pas le mot de passe : c'est un HMAC, pas une copie");

  /* La session vit à part des tables éditées à la main : la renouveler ne doit
     pas incrémenter `rev` et provoquer un 409 chez l'administrateur qui édite
     tranquillement sa fiche. */
  const rev0 = db.prepare("SELECT rev FROM odk_forms WHERE id='odkf_cache'").get().rev;
  srcSessions.courante = "perimee-encore";
  assert.equal((await tirer("odkf_cache")).status, 200);
  const rev1 = db.prepare("SELECT rev FROM odk_forms WHERE id='odkf_cache'").get().rev;
  assert.equal(rev1, rev0 + 1,
    "le tirage incrémente `rev` une fois — le renouvellement de session, lui, ne l'a pas touché");

  for(const chemin of ["/api/state", "/api/connectors", "/api/connectors/champs"]){
    const corps = JSON.stringify((await request(app).get(chemin)
      .set("Authorization", `Bearer ${adminToken}`)).body);
    for(const secret of [AUTH.motDePasse, AUTH.cleKobo, AUTH.jetonFixe, ligne.jeton_enc])
      assert.ok(!corps.includes(secret), `${chemin} laisse sortir un secret`);
    for(const cle of ['"token_enc"', '"secret_enc"', '"jeton_enc"', '"secret"', '"password"'])
      assert.ok(!corps.includes(cle), `${chemin} expose le champ ${cle}`);
  }

  /* Supprimer la source emporte le jeton dérivé qu'elle avait ouvert : un secret,
     même éphémère, ne survit pas à ce qu'il déverrouille. */
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_cache'").run();
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM source_session
                           WHERE source_kind='odk_forms' AND source_id='odkf_cache'`).get().c, 0);
});

test("authentification sortante : la pagination ne peut pas faire sortir l'appel de l'hôte vérifié", async () => {
  /* `@odata.nextLink` est une URL ABSOLUE fabriquée par le serveur distant. La
     suivre telle quelle rendait la garde anti-SSRF contournable par la source
     elle-même — et l'en-tête d'autorisation partait avec.

     La refuser dès que l'origine diffère fermait bien la faille, mais cassait un
     déploiement légitime : chez ODK Central le lien est composé du réglage
     `default.domain` de l'INSTANCE, qui n'a aucune raison d'être l'adresse par
     laquelle MEMS la joint. On ne retient donc du lien que le chemin, et on le
     rattache à l'origine du premier appel — la source choisit la page suivante,
     jamais le serveur où aller la chercher. */
  const { pullSubmissions, verifierBaseOdk } = await import("../src/lib/odkClient.js");
  const { porteurAuth } = await import("../src/lib/authSortante.js");

  /* L'hôte vers lequel la source essaie de faire partir l'appel. Il compte ses
     requêtes : c'est la seule preuve qui vaille que rien n'y est allé. */
  let recuesAilleurs = 0;
  const ailleurs = http.createServer((req, res) => { recuesAilleurs++; res.end("{}"); });
  await new Promise(r => ailleurs.listen(0, "127.0.0.1", r));
  const ailleursUrl = `http://127.0.0.1:${ailleurs.address().port}`;

  const vues = [];
  const menteur = http.createServer((req, res) => {
    vues.push(req.url);
    res.setHeader("Content-Type", "application/json");
    /* Page 1 : un lien qui désigne un AUTRE hôte, exactement comme le ferait une
       instance dont `default.domain` diffère — ou une instance compromise. */
    if(vues.length === 1) return res.end(JSON.stringify({ value: [{ __id: "p1" }],
      "@odata.nextLink": `${ailleursUrl}/v1/projects/1/forms/f.svc/Submissions?%24skiptoken=abc` }));
    res.end(JSON.stringify({ value: [{ __id: "p2" }] }));
  });
  await new Promise(r => menteur.listen(0, "127.0.0.1", r));
  const menteurUrl = `http://127.0.0.1:${menteur.address().port}`;

  const porteur = porteurAuth({ nature: "odk_forms", id: "peu-importe", schema: "porteur",
    secret: "jeton", baseUrl: menteurUrl, verifierBase: verifierBaseOdk, codeErreur: "ODK_AUTH" });
  let tirage;
  try{
    tirage = await pullSubmissions({ baseUrl: menteurUrl, project: "1", formId: "f", porteur });
  } finally { menteur.close(); ailleurs.close(); }

  assert.equal(recuesAilleurs, 0,
    "aucun appel — et donc aucun en-tête d'autorisation — ne part vers l'hôte que la source désigne");
  assert.equal(tirage.pages, 2, "la pagination est suivie, sur l'hôte vérifié");
  assert.equal(tirage.rows.length, 2);
  assert.match(vues[1], /skiptoken=abc/i,
    "le chemin et la requête du lien sont repris tels quels — seule l'origine est imposée");
});

/* ═══════════════════════════════════════════════════════════════════════
   LOT DE CORRECTIONS — ce que la relecture adverse a trouvé.

   Chaque test ci-dessous a d'abord échoué contre le code livré. Ils sont écrits
   par DÉFAUT CORRIGÉ et non par fonction, parce que c'est ainsi qu'ils se
   relisent : le titre dit ce qui était faux, le corps montre le cas qui le
   prouvait.
   ═══════════════════════════════════════════════════════════════════════ */

test("connecteur : un enregistrement qui ne parle pas d'authentification n'y touche pas", async () => {
  /* Le défaut : `auth_schema` portait `.default("porteur")`. Un client qui ignore
     ce champ neuf — script d'exploitation, écran d'une version antérieure —
     renvoyait la fiche sans lui, et le mot de passe d'un compte de service
     repartait alors en clair comme jeton porteur, sous un mot-clé que personne
     n'avait choisi. routes/collections.js évitait explicitement ce piège pour les
     sources ODK ; il était reconduit ici. */
  const c = (await creerConnecteur({ name: "Partenaire — Basic", kind: "http", base_url: srcUrl,
    config: { chemin: "/entetes" }, auth_schema: "basique",
    auth_identifiant: "svc@partenaire.org", secret: "MotDePasseDuCompteDeService" })).body.connector;
  assert.equal(c.auth_schema, "basique");
  assert.equal((await apercuDe(c.id)).status, 200);
  assert.equal(dernierAppel("/entetes").auth, basique("svc@partenaire.org", "MotDePasseDuCompteDeService"));

  const r = await request(app).put(`/api/connectors/${c.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: c.name, kind: c.kind, base_url: c.base_url, config: c.config, rev: c.rev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connector.auth_schema, "basique", "le schéma n'est pas réécrit par défaut");
  assert.equal(r.body.connector.auth_identifiant, "svc@partenaire.org",
    "l'identifiant n'est pas effacé par un corps qui ne le porte pas");

  assert.equal((await apercuDe(c.id)).status, 200);
  assert.equal(dernierAppel("/entetes").auth, basique("svc@partenaire.org", "MotDePasseDuCompteDeService"),
    "le mot de passe ne repart pas en « Bearer » après un enregistrement muet");

  /* L'autre moitié du même défaut : un connecteur réseau sans secret, que la
     migration 021 a basculé en « aucun » pour qu'il continue de fonctionner. */
  const ouvert = (await creerConnecteur({ name: "Export public", kind: "http", base_url: srcUrl,
    config: { chemin: "/entetes" }, auth_schema: "aucun" })).body.connector;
  const r2 = await request(app).put(`/api/connectors/${ouvert.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Export public renommé", kind: "http", base_url: srcUrl,
            config: { chemin: "/entetes" }, rev: ouvert.rev });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.connector.auth_schema, "aucun");
  assert.equal((await apercuDe(ouvert.id)).status, 200,
    "la source publique n'est pas refusée après un enregistrement qui ne parlait pas d'authentification");

  /* Et le champ reste MODIFIABLE : facultatif ne veut pas dire ignoré. */
  const r3 = await request(app).put(`/api/connectors/${ouvert.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Export public renommé", kind: "http", base_url: srcUrl,
            config: { chemin: "/entetes" }, auth_schema: "jeton", secret: AUTH.jetonFixe,
            rev: r2.body.connector.rev });
  assert.equal(r3.status, 200, JSON.stringify(r3.body));
  assert.equal(r3.body.connector.auth_schema, "jeton");
  const r4 = await request(app).put(`/api/connectors/${c.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: c.name, kind: c.kind, base_url: c.base_url, config: c.config,
            auth_schema: "basique", auth_identifiant: "", rev: r.body.connector.rev });
  assert.equal(r4.status, 422, "un identifiant vidé sur un schéma qui en exige un est refusé");
});

test("justificatif illisible : les deux routes disent la même chose, et disent la bonne", async () => {
  /* Une clé de chiffrement changée, ou une base recopiée d'une autre instance :
     `decrypt` rend null. Le lot livré rendait alors AUTH_ABSENT « renseignez-le »
     avec des indices qui se contredisaient (présent, longueur nulle), et le
     tirage ODK disait l'inverse de l'épreuve sur la MÊME ligne. */
  const c = (await creerConnecteur({ name: "Secret abîmé", kind: "http", base_url: srcUrl,
    config: { chemin: "/entetes" }, auth_schema: "porteur", secret: AUTH.jetonFixe })).body.connector;
  db.prepare("UPDATE connector SET secret_enc='enp6enp6enp6enp6enp6enp6enp6enp6enp6' WHERE id=?").run(c.id);

  const test = await request(app).post(`/api/connectors/${c.id}/test`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(test.status, 200);
  assert.equal(test.body.etapes[0].cause, "AUTH_ILLISIBLE");
  assert.match(test.body.etapes[0].message, /clé/);
  assert.match(test.body.etapes[0].message, /DATA_KEY/);
  assert.equal(test.body.etapes[0].indices.present, true);
  assert.equal(test.body.etapes[0].indices.lisible, false,
    "« présent » et « longueur 0 » ne peuvent pas être vrais ensemble : l'indice le dit");

  const apercu = await apercuDe(c.id);
  assert.equal(apercu.status, 422);
  assert.equal(apercu.body.cause, "AUTH_ILLISIBLE", "l'aperçu rend la même cause que l'épreuve");

  /* La même ligne abîmée, côté ODK : le tirage rendait 500 « ressaisissez-le »
     et l'épreuve 422 « renseignez-le » — deux verdicts opposés. */
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_kaput'").run();
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind,auth_schema)
              VALUES ('odkf_kaput','Source abîmée','kaput','1','enp6enp6enp6enp6enp6enp6','process','porteur')`).run();
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: srcUrl });

  const tOdk = await request(app).post("/api/odk-forms/odkf_kaput/test")
    .set("Authorization", `Bearer ${adminToken}`);
  const pOdk = await tirer("odkf_kaput");
  assert.equal(tOdk.body.etapes[0].cause, "AUTH_ILLISIBLE");
  assert.equal(pOdk.status, 422, JSON.stringify(pOdk.body));
  assert.equal(pOdk.body.cause, "AUTH_ILLISIBLE", "le tirage et l'épreuve nomment la même cause");
  assert.equal(tOdk.body.etapes[0].message, pOdk.body.error, "et rendent le même message");
});

test("identifiant du compte de service : servi à l'administration, pas au premier compte venu", async () => {
  /* Ce n'est pas un secret au sens de la maison, et c'est bien pour cela qu'il
     est sorti sans qu'on y prenne garde : c'est la moitié NOMMÉE d'un couple.
     Servi à tout compte authentifié, il donnait à un lecteur de terrain le nom de
     connexion du compte de service, avec l'adresse du serveur déjà publiée. */
  const c = (await creerConnecteur({ name: "Bailleur — Basic", kind: "http", base_url: srcUrl,
    config: { chemin: "/entetes" }, auth_schema: "basique",
    auth_identifiant: "compte.de.service@bailleur.org", secret: "mdp" })).body.connector;
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_ident'").run();
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind,auth_schema,auth_identifiant)
              VALUES ('odkf_ident','Source nommée','ident','1',?,'process','odk_session','agent.odk@wfp.org')`)
    .run(chiffrer(AUTH.motDePasse));

  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"lecteur-ident@test.local", password:"LecteurIdent2026", first_name:"Lecteur",
            role:"viewer", tabs:["home"], active:true });
  motDePasseAdopte("lecteur-ident@test.local");
  const jetonLecteur = (await login("lecteur-ident@test.local", "LecteurIdent2026")).body.token;

  const etatLecteur = await request(app).get("/api/state").set("Authorization", `Bearer ${jetonLecteur}`);
  assert.equal(etatLecteur.status, 200);
  assert.ok(!JSON.stringify(etatLecteur.body).includes("agent.odk@wfp.org"),
    "un lecteur ne reçoit pas le courriel du compte de service ODK Central");
  assert.equal(etatLecteur.body.odkForms.find(f => f.id === "odkf_ident").hasToken, true,
    "il continue de voir ce dont l'écran a besoin : la présence du justificatif");

  const listeLecteur = await request(app).get("/api/connectors")
    .set("Authorization", `Bearer ${jetonLecteur}`);
  assert.ok(!JSON.stringify(listeLecteur.body).includes("compte.de.service@bailleur.org"),
    "ni l'identifiant Basic d'un connecteur");

  /* L'administration, elle, en a besoin : c'est elle qui remplit la fiche. */
  const etatAdmin = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(etatAdmin.body.odkForms.find(f => f.id === "odkf_ident").authIdentifiant,
    "agent.odk@wfp.org");
  assert.equal((await request(app).get("/api/connectors").set("Authorization", `Bearer ${adminToken}`))
    .body.rows.find(x => x.id === c.id).auth_identifiant, "compte.de.service@bailleur.org");
});

test("épreuve de connexion : un 2xx sur un point d'entrée public ne vaut pas « justificatif accepté »", async () => {
  /* Le défaut : pour les natures « http » et « foundry », l'épreuve sonde le
     chemin réglé — souvent « / » — et déclarait « justificatif accepté » sur
     n'importe quel 2xx. Une page publique répond 200 à un secret entièrement
     faux, et l'écran affichait un feu vert que tout aperçu démentait. */
  const public_ = (await creerConnecteur({ name: "Source ouverte", kind: "http", base_url: srcUrl,
    config: { chemin: "/entetes" }, auth_schema: "porteur",
    secret: "UN-JETON-COMPLETEMENT-FAUX" })).body.connector;
  const r = await request(app).post(`/api/connectors/${public_.id}/test`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.etapes[0].code_http, 200);
  assert.equal(r.body.etapes[0].verdict, "indetermine",
    "un point d'entrée qui répond aussi sans justificatif ne prouve rien");
  assert.ok(!/justificatif accepté/.test(r.body.etapes[0].message),
    `l'épreuve ne doit pas conclure : ${r.body.etapes[0].message}`);
  assert.match(r.body.etapes[0].message, /sans aucun\s+justificatif/);

  /* Et là où le point d'entrée exige vraiment une authentification, le verdict
     revient — prouvé, cette fois, en refaisant l'appel sans justificatif. */
  const kobo = (await creerConnecteur({ name: "Épreuve prouvée", kind: "http", base_url: srcUrl,
    config: { chemin: "/me/", cheminEpreuve: "/me/" }, auth_schema: "jeton",
    secret: AUTH.cleKobo })).body.connector;
  const rk = await request(app).post(`/api/connectors/${kobo.id}/test`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(rk.body.etapes[0].verdict, "accepte", JSON.stringify(rk.body.etapes[0]));
  assert.match(rk.body.etapes[0].message, /sans justificatif/,
    "le verdict s'appuie sur le refus constaté en l'absence de justificatif");
});

test("épreuve de connexion : un 404 ne se rend pas en « la source n'a pas accepté l'appel »", async () => {
  const c = (await creerConnecteur({ name: "Chemin absent", kind: "http", base_url: srcUrl,
    config: { chemin: "/nulle-part" }, auth_schema: "jeton", secret: AUTH.jetonFixe })).body.connector;
  const r = await request(app).post(`/api/connectors/${c.id}/test`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.body.etapes[0].code_http, 404);
  assert.equal(r.body.etapes[0].ok, false, "`ok` est posé, jamais laissé absent");
  assert.equal(r.body.etapes[0].verdict, "indetermine");
  assert.equal(r.body.etapes[0].cause, null,
    "sans cause nommée, l'écran n'a pas à afficher un refus d'authentification");
});

test("épreuve Foundry : le chemin éprouvé est celui que la lecture appellera", async () => {
  /* `{rid}` n'était pas substitué : l'épreuve appelait « /api/v2/datasets/
     %7Brid%7D/readTable », récoltait un 404, et accusait un chemin correct. */
  const c = (await creerConnecteur({ name: "Foundry — gabarit", kind: "foundry",
    base_url: foundryUrl, config: { datasetRid: "ri.dataset.42",
      chemin: "/api/v2/datasets/{rid}/readTable" },
    auth_schema: "porteur", secret: AUTH.jetonFixe })).body.connector;
  const avant = foundryRequetes.length;
  await request(app).post(`/api/connectors/${c.id}/test`).set("Authorization", `Bearer ${adminToken}`);
  const appels = foundryRequetes.slice(avant).map(q => q.url);
  assert.ok(appels.length, "l'épreuve appelle bien la source");
  assert.ok(!appels.some(u => /%7Brid%7D|\{rid\}/i.test(u)),
    `le gabarit doit être résolu, pas envoyé tel quel : ${appels.join(", ")}`);
  assert.ok(appels.some(u => u.includes("ri.dataset.42")),
    `l'épreuve vise l'adresse réelle du dataset : ${appels.join(", ")}`);
});

test("connecteur Kobo hérité : il reste modifiable, sans qu'on lui invente un uid", async () => {
  /* Un connecteur « kobo » est déclarable depuis la migration 016 : ceux d'alors
     portent le couple projet / formulaire d'ODK, que l'écran leur proposait à
     tort. Exiger `config.uid` de tout enregistrement les rendait immodifiables —
     ni renommables, ni désactivables, ni rattachables à un bureau. */
  db.prepare(`INSERT INTO connector (id,name,kind,base_url,config,secret_enc,auth_schema)
              VALUES ('conn_kobo_vieux','Kobo pays','kobo',?,'{"project":"1","formId":"abc"}',?,'jeton')`)
    .run(srcUrl, chiffrer(AUTH.cleKobo));
  const c = db.prepare("SELECT * FROM connector WHERE id='conn_kobo_vieux'").get();

  const r = await request(app).put("/api/connectors/conn_kobo_vieux")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Kobo pays (inactif)", kind: "kobo", base_url: srcUrl,
            config: { project: "1", formId: "abc" }, active: false, rev: c.rev });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.connector.active, false);

  /* Il reste illisible tant que l'uid manque — mais c'est la LECTURE qui le dit,
     au moment où l'on essaie de lire, avec le geste à faire. */
  const ap = await apercuDe("conn_kobo_vieux");
  assert.equal(ap.status, 422);
  assert.match(ap.body.error, /uid/);

  /* Et un uid déjà là ne s'efface pas par mégarde. */
  const avecUid = await request(app).put("/api/connectors/conn_kobo_vieux")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Kobo pays", kind: "kobo", base_url: srcUrl, config: { uid: "aXyZ" },
            rev: r.body.connector.rev });
  assert.equal(avecUid.status, 200);
  const sansUid = await request(app).put("/api/connectors/conn_kobo_vieux")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name: "Kobo pays", kind: "kobo", base_url: srcUrl, config: {},
            rev: avecUid.body.connector.rev });
  assert.equal(sansUid.status, 422, "on ne retire pas un uid qui était là");
  /* La création, elle, l'exige toujours. */
  assert.equal((await creerConnecteur({ name: "Kobo neuf", kind: "kobo", base_url: srcUrl,
    config: {}, auth_schema: "jeton", secret: "x" })).status, 422);
});

test("source ODK sans justificatif déclaré : le tirage et l'épreuve disent la même chose", async () => {
  /* Le schéma « Aucune (source publique) » est proposé par le sélecteur. Le
     tirage refusait pourtant toute source sans `token_enc`, avant même de lire le
     schéma, en réclamant un jeton que ce schéma déclare inutile. */
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_ouverte'").run();
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,kind,auth_schema)
              VALUES ('odkf_ouverte','Source publique','ouverte','1','process','aucun')`).run();
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: srcUrl });

  const t = await request(app).post("/api/odk-forms/odkf_ouverte/test")
    .set("Authorization", `Bearer ${adminToken}`);
  const p = await tirer("odkf_ouverte");
  assert.equal(t.body.etapes[0].cause, "AUTH_ABSENT");
  assert.equal(p.status, 422, JSON.stringify(p.body));
  assert.equal(p.body.cause, "AUTH_ABSENT", "la même cause des deux côtés");
  assert.ok(!/renseignez-lui un jeton dédié/.test(p.body.error),
    "on ne réclame pas un jeton pour un schéma qui déclare qu'il n'en faut pas");
  assert.match(p.body.error, /déclarée sans justificatif/);
});

test("épreuve ODK : une étape escamotée ne vaut pas une étape réussie", async () => {
  /* `etapes.every(x => x.ok)` sur la seule étape restante rendait « ok », donc un
     bandeau vert, à une source dont le tirage refuse en 422 la seconde d'après. */
  db.prepare("DELETE FROM odk_forms WHERE id='odkf_sans_projet'").run();
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind,auth_schema,auth_identifiant)
              VALUES ('odkf_sans_projet','Sans projet','sansprojet','','x','process','odk_session',?)`)
    .run(AUTH.courriel);
  db.prepare("UPDATE odk_forms SET token_enc=? WHERE id='odkf_sans_projet'").run(chiffrer(AUTH.motDePasse));
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;

  const r = await request(app).post("/api/odk-forms/odkf_sans_projet/test")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.etapes[0].ok, true, "le justificatif est bon, et le reste");
  assert.equal(r.body.etapes.length, 2, "l'étape « formulaire » est rendue, même sans appel");
  assert.equal(r.body.etapes[1].ok, false);
  assert.match(r.body.etapes[1].message, /identifiant de projet/);
  assert.equal(r.body.ok, false, "une épreuve annoncée en deux étapes n'en escamote pas une");
});

test("épreuve ODK : l'étape 2 ne parle pas d'un renouvellement qu'elle n'a pas tenté", async () => {
  /* `sonder` n'appelle jamais `appelAuthentifie` : il ne renouvelle rien. La
     branche « le justificatif n'a pas pu être renouvelé » était donc toujours
     fausse à l'étape 2 — laquelle ne s'exécute qu'après une étape 1 réussie,
     c'est-à-dire après un renouvellement qui a marché. */
  await sourceSession("odkf_etape2", "Refus à l'étape 2", "refus-401-a");
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;
  const r = await request(app).post("/api/odk-forms/odkf_etape2/test")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.body.etapes[0].ok, true, JSON.stringify(r.body.etapes[0]));
  assert.equal(r.body.etapes[1].ok, false);
  assert.equal(r.body.etapes[1].code_http, 401);
  assert.ok(!/n'a pas pu être renouvelé/.test(r.body.etapes[1].message),
    `rien n'a été renouvelé à l'étape 2 : ${r.body.etapes[1].message}`);
  assert.equal(r.body.etapes[1].cause, "AUTH_REFUS",
    "la session vient d'être acceptée à l'étape 1 : la cause du refus n'est pas déterminable");

  /* Un refus de DROITS, lui, reste nommé : c'est la raison d'être de l'étape 2. */
  await sourceSession("odkf_etape2b", "Sans droit à l'étape 2", "sans-droit-c");
  const b = await request(app).post("/api/odk-forms/odkf_etape2b/test")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(b.body.etapes[1].cause, "AUTH_DROITS");
});

test("diagnostic : un 403 ne prouve pas qu'un justificatif ait été accepté", async () => {
  /* La branche 403 passait avant « rien n'a été présenté » et avant « la source a
     nommé le mot-clé qu'elle attendait ». Un connecteur déclaré sans
     justificatif se voyait donc répondre « le justificatif est accepté, mais il
     n'a pas les droits » — alors qu'aucun en-tête n'avait été émis. */
  const rien = (await creerConnecteur({ name: "403 sans justificatif", kind: "http",
    base_url: srcUrl, config: { chemin: "/403drf" }, auth_schema: "aucun" })).body.connector;
  const a = await apercuDe(rien.id);
  assert.equal(a.status, 422, JSON.stringify(a.body));
  assert.equal(a.body.cause, "AUTH_ABSENT", "MEMS n'a rien présenté : c'est la cause");
  assert.ok(!/est accepté par la source/.test(a.body.error), a.body.error);

  /* Même corps, même code : le mot-clé annoncé prime aussi sur le 403. */
  const mauvais = (await creerConnecteur({ name: "403 mot-clé", kind: "http", base_url: srcUrl,
    config: { chemin: "/403token" }, auth_schema: "porteur", secret: AUTH.cleKobo })).body.connector;
  const b = await apercuDe(mauvais.id);
  assert.equal(b.body.cause, "AUTH_SCHEMA", JSON.stringify(b.body));
  assert.match(b.body.error, /Jeton \(Token\)/,
    "le remède nomme un schéma que l'administrateur peut réellement choisir");

  /* Et un vrai refus de droits reste un refus de droits. */
  await sourceSession("odkf_403", "Sans droit", "sans-droit-d");
  srcSessions.refuseToujours = false;
  const d = await tirer("odkf_403");
  assert.equal(d.body.cause, "AUTH_DROITS");
});

test("diagnostic : « Session » n'est pas un schéma, et le message ne l'ordonne plus", async () => {
  /* Chez KoboToolbox, « Session » dans `WWW-Authenticate` signifie qu'AUCUN
     authentifieur n'a reconnu l'en-tête — le module le sait, son propre
     commentaire le dit. Le message ordonnait pourtant « adoptez celui qu'elle
     réclame » : l'administrateur choisissait alors « Session ODK Central », le
     seul libellé contenant ce mot, et MEMS se mettait à poster courriel et mot de
     passe sur /v1/sessions d'un serveur Kobo. */
  const c = (await creerConnecteur({ name: "Kobo en Bearer", kind: "kobo", base_url: srcUrl,
    config: { uid: "aXyZ" }, auth_schema: "porteur", secret: AUTH.cleKobo })).body.connector;
  const r = await apercuDe(c.id);
  assert.equal(r.body.cause, "AUTH_SCHEMA", JSON.stringify(r.body));
  assert.match(r.body.error, /« Bearer »/);
  assert.match(r.body.error, /Jeton \(Token\)/, "le schéma à essayer est nommé");
  assert.ok(!/pour celui qu'elle réclame/.test(r.body.error),
    "on n'ordonne pas d'adopter un mot-clé qui ne désigne aucun schéma déclarable");
  assert.match(r.body.error, /aucun de ses authentifieurs/i,
    "le message dit ce que « Session » veut réellement dire");
});

test("session courte : une durée de vie inférieure à la marge n'ouvre pas une session par appel", async () => {
  /* `reste <= marge` déclarait le cache vide à chaque lecture dès que la source
     annonçait une échéance plus proche que la marge de renouvellement. Un tirage
     de cinquante pages ouvrait alors cinquante sessions, chacune coûtant une
     vérification de mot de passe chez la source. */
  await sourceSession("odkf_courte", "Session courte", "courte");
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;
  srcSessions.dureeMs = 60_000;                 /* plus court que AUTH_SESSION_MARGIN_S */
  try{
    const emises0 = srcSessions.emises;
    for(let i = 0; i < 4; i++) assert.equal((await tirer("odkf_courte")).status, 200);
    assert.equal(srcSessions.emises, emises0 + 1,
      "quatre tirages, une seule ouverture : la marge ne peut pas excéder la durée de vie annoncée");

    /* Même chose quand l'échéance annoncée est illisible : la recopier telle
       quelle faisait déclarer le cache périmé à chaque lecture, indéfiniment. */
    await sourceSession("odkf_illisible", "Échéance illisible", "illisible");
    srcSessions.dureeMs = null; srcSessions.expireIllisible = "24h";
    const emises1 = srcSessions.emises;
    for(let i = 0; i < 4; i++) assert.equal((await tirer("odkf_illisible")).status, 200);
    assert.equal(srcSessions.emises, emises1 + 1, "une échéance illisible n'est pas une échéance passée");
    const ligne = db.prepare(`SELECT expire_le FROM source_session
                              WHERE source_kind='odk_forms' AND source_id='odkf_illisible'`).get();
    assert.ok(!Number.isNaN(Date.parse(ligne.expire_le)),
      "ce qui est mis en cache est une date, pas la chaîne reçue telle quelle");
  } finally { srcSessions.dureeMs = null; srcSessions.expireIllisible = null; }
});

test("session : un silence de la source n'efface pas une session valable et ne bloque rien", async () => {
  /* Une panne d'une seconde chez la source détruisait une session valable six
     heures ET bloquait la source cinq minutes, avec un message qui accusait un
     justificatif qui n'avait jamais été en cause. */
  await sourceSession("odkf_hoquet", "Hoquet", "hoquet");
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;
  assert.equal((await tirer("odkf_hoquet")).status, 200);
  const jetonAvant = db.prepare(`SELECT jeton_enc FROM source_session
                                 WHERE source_kind='odk_forms' AND source_id='odkf_hoquet'`).get().jeton_enc;

  /* La source ne répond plus : l'épreuve, qui force l'ouverture, échoue. */
  srcSessions.injoignable = true;
  const t = await request(app).post("/api/odk-forms/odkf_hoquet/test")
    .set("Authorization", `Bearer ${adminToken}`);
  srcSessions.injoignable = false;
  assert.equal(t.body.ok, false);
  assert.equal(t.body.etapes[0].cause, "AUTH_SESSION");

  const apres = db.prepare(`SELECT jeton_enc, echec_le FROM source_session
                            WHERE source_kind='odk_forms' AND source_id='odkf_hoquet'`).get();
  assert.equal(apres.jeton_enc, jetonAvant, "la session valable survit à la panne d'un tiers");
  assert.equal(apres.echec_le, null, "et la source n'est pas bloquée pour cinq minutes");
  assert.equal((await tirer("odkf_hoquet")).status, 200,
    "la source revenue, le tirage repart sans attendre le délai de blocage");
});

test("session : changer de justificatif pendant une ouverture en vol ne rend pas l'ancienne", async () => {
  /* `enVol` était indexée sur « nature:id » sans l'empreinte : le porteur du
     NOUVEAU compte recevait la session ouverte avec l'ANCIEN, et l'épreuve
     prononçait un verdict sur des identifiants jamais présentés à la source. */
  const { porteurAuth } = await import("../src/lib/authSortante.js");
  const { verifierBaseOdk } = await import("../src/lib/odkClient.js");
  srcSessions.refuseToujours = false; srcSessions.refuseIdentifiants = false;
  srcSessions.lenteurMs = 200;
  const commun = { nature: "odk_forms", id: "odkf_en_vol", schema: "odk_session",
    baseUrl: srcUrl, verifierBase: verifierBaseOdk, codeErreur: "ODK_AUTH" };
  try{
    const ancien = porteurAuth({ ...commun, identifiant: AUTH.courriel, secret: "ancien-mot-de-passe" });
    const nouveau = porteurAuth({ ...commun, identifiant: AUTH.courriel, secret: AUTH.motDePasse });
    const [a, b] = await Promise.all([
      ancien.enTetes({ forcer: true }).then(x => x, e => ({ erreur: e.message })),
      new Promise(r => setTimeout(r, 40)).then(() => nouveau.enTetes({ forcer: true })),
    ]);
    assert.ok(a.erreur, "l'ancien mot de passe est refusé, et c'est lui qui est refusé");
    assert.equal(b.Authorization, `Bearer ${srcSessions.courante}`,
      "le porteur au BON mot de passe reçoit SA session, pas le verdict de l'autre");
  } finally { srcSessions.lenteurMs = 0; }
});

test("source qui n'achève jamais sa réponse : elle ne fige pas MEMS pour toujours", async () => {
  /* Le délai était désarmé à l'arrivée des EN-TÊTES, le corps lu après sans
     aucune échéance. Une source qui répond « 200 » puis se tait figeait la
     promesse d'ouverture — partagée par `enVol` — et rendait la source
     définitivement injoignable pour tout le serveur, jusqu'au redémarrage. */
  const { porteurAuth } = await import("../src/lib/authSortante.js");
  const { verifierBaseOdk } = await import("../src/lib/odkClient.js");
  const ouvertes = [];
  const muet = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.write("{");            /* le corps commence et ne finit jamais */
    ouvertes.push(res);
  });
  await new Promise(r => muet.listen(0, "127.0.0.1", r));
  const muetUrl = `http://127.0.0.1:${muet.address().port}`;
  const ancienDelai = process.env.AUTH_SESSION_TIMEOUT_S;
  process.env.AUTH_SESSION_TIMEOUT_S = "1";
  try{
    const p = () => porteurAuth({ nature: "odk_forms", id: "odkf_muette", schema: "odk_session",
      identifiant: AUTH.courriel, secret: AUTH.motDePasse, baseUrl: muetUrl,
      verifierBase: verifierBaseOdk, codeErreur: "ODK_AUTH" });
    const un = await p().enTetes().then(() => null, e => e);
    assert.ok(un, "l'appel se règle au lieu de rester en suspens");
    /* Et la source suivante — porteur NEUF — n'hérite pas d'une promesse morte. */
    const deux = await p().enTetes().then(() => null, e => e);
    assert.ok(deux, "un second appel se règle lui aussi, il n'attend pas le premier indéfiniment");
  } finally {
    if(ancienDelai === undefined) delete process.env.AUTH_SESSION_TIMEOUT_S;
    else process.env.AUTH_SESSION_TIMEOUT_S = ancienDelai;
    for(const r of ouvertes) r.end();
    muet.close();
    db.prepare("DELETE FROM source_session WHERE source_id='odkf_muette'").run();
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   Chaîne ODK : soumissions, rattachement aux sites, dernière visite, GPS.

   « Et si 01 sites existe sur les bases de données alors on note qu'il a été
   suivi, lier par site name, activité, date je crois. Date de dernière visite =
   dernière date de suivi disponible dans odk selon svydate. »

   Les fixtures ci-dessous reproduisent le cas réel documenté dans
   docs/A_FAIRE.md (chantier O) : deux points de distribution partageant le code
   `MG51507010014` dans GD_PREVMA, un code MIARO de 16 caractères dont seul le
   préfixe de 13 est un p-code, et deux homonymes que rien ne départage.
   ═══════════════════════════════════════════════════════════════════════ */

const CODE_AMBIGU = "MG51507010014";
const siteLotC = {};

const creerSiteLotC = async (corps) => {
  const r = await request(app).post("/api/sites").set("Authorization", `Bearer ${adminToken}`)
    .send(corps);
  assert.equal(r.status, 201, `création du site ${corps.code} refusée : ${JSON.stringify(r.body)}`);
  return r.body.site;
};

const verser = (corps) => request(app).post("/api/submissions/ingest")
  .set("Authorization", `Bearer ${adminToken}`).send(corps);

test("soumissions : le référentiel de test est en place (codes ambigus, homonymes, p-code)", async () => {
  /* Les deux points de distribution que GD_PREVMA confond sous un seul code —
     `allow_choice_duplicates='yes'` l'autorise, et sept codes sont dans ce cas. */
  siteLotC.androka = await creerSiteLotC({ code:"LOTC-A", external_code:CODE_AMBIGU,
    name:"Androka Betohoke", activity_tag:"URT_GD", geo_pcode:CODE_AMBIGU, lat:-25.0300, lon:45.1200 });
  siteLotC.betsibarike = await creerSiteLotC({ code:"LOTC-B", external_code:CODE_AMBIGU,
    name:"Betsibarike", activity_tag:"URT_GD", geo_pcode:CODE_AMBIGU });
  /* Sans code externe : seul le préfixe p-code de 13 caractères le rattache. */
  siteLotC.csb = await creerSiteLotC({ code:"LOTC-C", name:"CSB Tsihombé",
    activity_tag:"NTA", geo_pcode:"MG23210070009", last_visit:"2026-01-15",
    lat:-25.3100, lon:45.4900 });
  /* Deux homonymes de même activité, dans deux unités différentes. */
  siteLotC.homonymeA = await creerSiteLotC({ code:"LOTC-D", name:"EPP Homonyme",
    activity_tag:"SMP", geo_pcode:"MG23299990001" });
  siteLotC.homonymeB = await creerSiteLotC({ code:"LOTC-E", name:"EPP Homonyme",
    activity_tag:"SMP", geo_pcode:"MG23299990002" });

  assert.equal(db.prepare("SELECT COUNT(*) c FROM sites WHERE external_code=?").get(CODE_AMBIGU).c, 2,
    "le code externe n'est délibérément pas unique : l'ambiguïté doit pouvoir entrer en base");
});

test("soumissions : rattachement par nom de site croisé avec l'activité", async () => {
  const r = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    /* Ni code, ni p-code : seuls le nom et l'activité peuvent rattacher. Le nom
       est écrit autrement que dans le référentiel — accent, casse, ponctuation —
       ce que la normalisation doit absorber. */
    { instance_id:"lotc-nom-1", SvyDate:"2026-05-04",
      site_name:"csb  tsihombe", activity_tag:"nta" },
  ]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resolues, 1, JSON.stringify(r.body));

  const s = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-nom-1");
  assert.equal(s.site_id, siteLotC.csb.id);
  assert.equal(s.resolution_passe, "nom_activite");
  assert.match(s.resolution_motif, /croisé avec l'activité/);
  assert.ok(s.resolution_confiance > 0 && s.resolution_confiance < 1,
    "un rapprochement par nom n'est pas une égalité de codes : sa confiance est inférieure");
});

test("soumissions : deux candidats égaux valent non résolu, jamais un tirage au sort", async () => {
  const r = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    /* Le code ambigu, sans nom pour départager : c'est le cas des sept codes
       GD_PREVMA relevés dans les XLSForms. */
    { instance_id:"lotc-ambigu-1", DPName:CODE_AMBIGU, SvyDate:"2026-05-06" },
    /* Le même code, mais le nom tranche entre les deux prétendants. */
    { instance_id:"lotc-ambigu-2", DPName:CODE_AMBIGU, SvyDate:"2026-05-07",
      site_name:"BETSIBARIKE", activity_tag:"URT_GD" },
    /* Deux homonymes de même activité : le nom ne tranche plus rien. */
    { instance_id:"lotc-homonyme", SvyDate:"2026-05-08",
      site_name:"epp homonyme", activity_tag:"SMP" },
  ]});
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const ambigu = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-ambigu-1");
  assert.equal(ambigu.site_id, null, "aucun des deux sites n'est choisi au hasard");
  assert.match(ambigu.resolution_motif, /désigne 2 sites/);
  assert.match(ambigu.resolution_motif, /Androka Betohoke/);
  assert.match(ambigu.resolution_motif, /Betsibarike/);
  assert.equal(ambigu.resolution_confiance, 0);

  const departage = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-ambigu-2");
  assert.equal(departage.site_id, siteLotC.betsibarike.id,
    "le nom départage les deux porteurs du même code — sans jamais sortir de cette paire");
  assert.equal(departage.resolution_passe, "nom_activite");

  const homonyme = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-homonyme");
  assert.equal(homonyme.site_id, null);
  assert.match(homonyme.resolution_motif, /rien ne les départage/);
});

test("soumissions : rattachement par préfixe p-code, et par code externe exact", async () => {
  const r = await verser({ form_id:"MIARO_PROD", enregistrements: [
    /* Code MIARO de 16 caractères : p-code adm4 de 13 suivi d'un numéro d'ordre.
       Aucune longueur n'est écrite en dur — c'est le référentiel qui décide. */
    { instance_id:"lotc-pcode-1", POIName:"MG23210070009001", SvyDate:"2026-05-09" },
  ]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-pcode-1");
  assert.equal(s.site_id, siteLotC.csb.id);
  assert.equal(s.resolution_passe, "pcode_adm4");

  /* Un code externe non ambigu : égalité stricte, confiance maximale. */
  await request(app).put(`/api/sites/${siteLotC.homonymeA.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ ...siteLotC.homonymeA, external_code:"MG23299990001999", rev:siteLotC.homonymeA.rev });
  const r2 = await verser({ form_id:"NutritionAIM", enregistrements: [
    { instance_id:"lotc-code-1", DPName:"MG23299990001999", SvyDate:"2026-05-10" }]});
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  const s2 = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-code-1");
  assert.equal(s2.site_id, siteLotC.homonymeA.id);
  assert.equal(s2.resolution_passe, "code_externe");
  assert.equal(s2.resolution_confiance, 1);
});

test("soumissions : l'ingestion est idempotente par instance_id", async () => {
  const lot = { form_id:"GD_PREVMA_v2", enregistrements: [
    { instance_id:"lotc-idem-1", DPName:CODE_AMBIGU, SvyDate:"2026-06-01",
      site_name:"Androka Betohoke", activity_tag:"URT_GD" },
    { instance_id:"lotc-idem-2", SvyDate:"2026-06-02", site_name:"csb tsihombe", activity_tag:"NTA" },
  ]};
  const un = await verser(lot);
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.crees, 2);
  assert.equal(un.body.misAJour, 0);
  const apres1 = db.prepare("SELECT COUNT(*) c FROM submissions").get().c;

  const deux = await verser(lot);
  assert.equal(deux.status, 200);
  assert.equal(deux.body.crees, 0, "le second versement ne crée rien");
  assert.equal(deux.body.misAJour, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM submissions").get().c, apres1,
    "deux tirages successifs se recouvrent au lieu de doubler");

  /* L'identité de ligne est conservée : sans cela, les visites déjà créées
     depuis une soumission pointeraient dans le vide au tirage suivant. */
  const ids = db.prepare("SELECT id FROM submissions WHERE instance_id IN ('lotc-idem-1','lotc-idem-2')")
    .all().map(x => x.id);
  const troisieme = await verser(lot);
  assert.equal(troisieme.status, 200);
  assert.deepEqual(
    db.prepare("SELECT id FROM submissions WHERE instance_id IN ('lotc-idem-1','lotc-idem-2')")
      .all().map(x => x.id), ids);

  /* Une soumission sans identifiant d'instance reçoit une empreinte
     déterministe : le même enregistrement versé deux fois reste une seule ligne,
     et l'API le dit au lieu de le taire. */
  const sansId = { form_id:"SMP_2025", enregistrements: [
    { Adm4Code_SMP:"603140007", SvyDate:"2026-06-03", site_name:"csb tsihombe", activity_tag:"NTA" }]};
  const a = await verser(sansId);
  assert.equal(a.body.crees, 1);
  assert.equal(a.body.sansIdentifiant, 1);
  assert.match(a.body.avertissement, /identifiant d'instance/);
  const b = await verser(sansId);
  assert.equal(b.body.crees, 0);
  assert.equal(b.body.misAJour, 1);
});

test("soumissions : la dernière visite vient de svy_date, sans détruire la valeur saisie", async () => {
  const fiche = await request(app).get(`/api/sites/${siteLotC.csb.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(fiche.status, 200);
  const d = fiche.body.derniereVisite;
  /* La valeur saisie n'a pas bougé : c'est la garantie demandée. */
  assert.equal(d.last_visit, "2026-01-15");
  assert.equal(fiche.body.site.last_visit, "2026-01-15");
  /* La plus récente des svy_date rattachées à ce site, tous formulaires confondus. */
  const attendue = db.prepare("SELECT MAX(svy_date) d FROM submissions WHERE site_id=?")
    .get(siteLotC.csb.id).d;
  assert.equal(d.last_visit_odk, attendue);
  assert.ok(d.last_visit_odk > d.last_visit);
  assert.equal(d.last_visit_effective, d.last_visit_odk, "l'observée prime sur la convention saisie");
  assert.equal(d.last_visit_source, "odk");

  const liste = await request(app).get("/api/submissions/derniere-visite?site_id=" + siteLotC.csb.id)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(liste.status, 200);
  assert.equal(liste.body.rows[0].last_visit, "2026-01-15");
  assert.equal(liste.body.rows[0].last_visit_odk, attendue);
  assert.ok(liste.body.rows[0].soumissions >= 3);

  /* Un site sans aucune soumission rattachée continue d'afficher la sienne. */
  const sansOdk = await request(app).get(`/api/sites/${siteLotC.homonymeB.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(sansOdk.body.derniereVisite.last_visit_odk, null);
  assert.equal(sansOdk.body.derniereVisite.last_visit_source, null);

  /* La carte sert les deux colonnes : elle ne peut pas afficher une date de
     terrain si le serveur ne la lui envoie pas. */
  const carte = await request(app).get("/api/analytics/map?year=2026")
    .set("Authorization", `Bearer ${adminToken}`);
  const point = carte.body.sites.find(x => x.id === siteLotC.csb.id);
  assert.ok(point, "le site de test figure sur la carte");
  assert.equal(point.last_visit, "2026-01-15");
  assert.equal(point.last_visit_odk, attendue);
  assert.equal(point.last_visit_effective, attendue);
});

test("soumissions : le geopoint est découpé en latitude, longitude et précision", async () => {
  const r = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    /* La forme exacte d'un geopoint ODK : « lat lon altitude précision ». */
    { instance_id:"lotc-gps-1", SvyDate:"2026-05-12", site_name:"csb tsihombe",
      activity_tag:"NTA", HHCoord:"-25.3142 45.4931 37.5 8" },
    /* Sans altitude ni précision : les deux doivent rendre null, jamais zéro —
       « précision inconnue » et « précision de zéro mètre » ne sont pas la même
       information. */
    { instance_id:"lotc-gps-2", SvyDate:"2026-05-13", site_name:"csb tsihombe",
      activity_tag:"NTA", HHCoord:"-25.3000 45.5000" },
  ]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const un = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-gps-1");
  assert.equal(un.lat, -25.3142);
  assert.equal(un.lon, 45.4931);
  assert.equal(un.gps_accuracy, 8);
  const deux = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-gps-2");
  assert.equal(deux.gps_accuracy, null);

  /* Q25 n'est pas tranchée : la position déclarée du site n'est pas touchée. */
  const site = db.prepare("SELECT lat, lon FROM sites WHERE id=?").get(siteLotC.csb.id);
  assert.equal(site.lat, -25.3100);
  assert.equal(site.lon, 45.4900);

  /* Elle est servie comme une couche distincte, avec l'écart aux deux positions —
     c'est cette mesure qui permettra de trancher Q25 sur des chiffres. */
  const pos = await request(app).get(`/api/submissions/positions?site_id=${siteLotC.csb.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(pos.status, 200);
  const p = pos.body.points.find(x => x.instance_id === "lotc-gps-1");
  assert.ok(p, "la position observée est servie");
  assert.equal(p.site_lat, -25.3100);
  assert.ok(p.ecart_m > 0 && p.ecart_m < 5000, `écart attendu de quelques centaines de mètres, reçu ${p.ecart_m}`);
  assert.ok(pos.body.bounds);
});

test("soumissions : une soumission non résolue le reste, et reste visible", async () => {
  const inconnu = "MG99988877766";
  const r = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    { instance_id:"lotc-orphelin", DPName:inconnu, SvyDate:"2026-05-20",
      site_name:"EPP Introuvable", activity_tag:"URT_GD" }]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.nonResolues, 1);

  const liste = await request(app).get("/api/submissions?resolution=non_resolues")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(liste.status, 200);
  const o = liste.body.rows.find(x => x.instance_id === "lotc-orphelin");
  assert.ok(o, "elle n'est ni jetée ni rattachée d'office : elle est en attente, et visible");
  assert.equal(o.site_id, null);
  assert.ok(o.resolution_motif.length > 20, "le motif dit pourquoi, pas seulement que");
  assert.match(o.resolution_motif, /aucun site ne porte le code/);
  assert.equal(o.site_code_raw, inconnu, "le code saisi est conservé tel quel");

  /* Rejouer le rattachement sans rien changer au référentiel ne la résout pas :
     c'est le contraire d'un résolveur qui finit par céder. */
  const rejeu = await request(app).post("/api/submissions/rattacher")
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(rejeu.status, 200);
  assert.equal(db.prepare("SELECT site_id FROM submissions WHERE instance_id=?")
    .get("lotc-orphelin").site_id, null);

  /* Elle se résout dès que le référentiel apprend le code — sans re-tirer depuis
     ODK Central, ce qui est le point du stockage de `raw`. */
  await creerSiteLotC({ code:"LOTC-F", external_code:inconnu, name:"EPP Introuvable",
    activity_tag:"URT_GD" });
  const rejeu2 = await request(app).post("/api/submissions/rattacher")
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(rejeu2.status, 200);
  assert.ok(rejeu2.body.rattachees >= 1, JSON.stringify(rejeu2.body));
  assert.ok(db.prepare("SELECT site_id FROM submissions WHERE instance_id=?")
    .get("lotc-orphelin").site_id, "le code enfin connu la rattache");
});

test("soumissions : « déjà suivi » marque le mois et crée une visite, sans jamais la doubler", async () => {
  const lecture = await request(app).get("/api/submissions/suivi?year=2026&month=4")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(lecture.status, 200);
  assert.equal(lecture.body.periode.debut, "2026-05-01");
  assert.equal(lecture.body.periode.fin, "2026-05-31");
  const vu = lecture.body.rows.find(x => x.site_id === siteLotC.csb.id);
  assert.ok(vu, "le site a bien des soumissions sur mai 2026");
  assert.equal(vu.suivi, true);

  const un = await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:4 });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.ok(un.body.marques >= 1);
  assert.ok(un.body.visitesCreees >= 1);

  const mois = db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=4")
    .get(siteLotC.csb.id);
  assert.equal(mois.done, 1);
  const visites = db.prepare(
    "SELECT * FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'").all(siteLotC.csb.id);
  assert.equal(visites.length, 1);
  assert.ok(visites[0].submission_id, "la visite dit de quelle soumission elle vient");
  /* Datée du jour DÉCLARÉ de collecte, pas du 15 du mois que pose la saisie. */
  assert.notEqual(visites[0].visit_date, "2026-05-15");

  const deux = await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:4 });
  assert.equal(deux.status, 200);
  assert.equal(deux.body.visitesCreees, 0, "relancer ne double pas les visites");
  assert.ok(deux.body.dejaMarques >= 1);
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'")
    .get(siteLotC.csb.id).c, 1);

  /* La grille mensuelle n'a pas d'autre maille qu'un mois civil : demander une
     fenêtre libre en écriture est refusé, pas approximé. */
  const libre = await request(app).get("/api/submissions/suivi?debut=2026-05-01&fin=2026-06-30")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(libre.status, 200);
  assert.equal(libre.body.periode.mois, null);
});

/* ═══════════════════════════════════════════════════════════════════════
   La visite saisie à la main est une exception justifiée  (lot A)

   Ces trois tests dépendent de la fixture posée juste au-dessus : le mois de
   mai 2026 du site `siteLotC.csb` porte désormais UNE visite issue d'ODK, avec
   son `submission_id`. C'est le seul endroit du dépôt où une telle visite
   existe, d'où leur emplacement — placés plus haut, ils passeraient sans la
   correction et ne prouveraient rien.
   ═══════════════════════════════════════════════════════════════════════ */

test("grille mensuelle : décocher ne supprime jamais une visite issue d'ODK", async () => {
  const avant = db.prepare(
    "SELECT * FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'").all(siteLotC.csb.id);
  assert.equal(avant.length, 1);
  assert.ok(avant[0].submission_id, "la fixture porte bien une visite issue d'une soumission");

  /* Le geste exact qui détruisait la donnée : décocher la case du mois depuis le
     plan. Un client dont l'état est antérieur au dernier tirage ODK l'envoie sans
     même vouloir toucher à la visite — il croit ne changer que le missionnaire. */
  const r = await request(app).put(`/api/sites/${siteLotC.csb.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:4, active:true, planned:true, done:false, monitor:"Testeur" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /formulaire ODK/);
  assert.match(r.body.error, /rechargez/, "le refus dit quoi faire, pas seulement que c'est refusé");

  const apres = db.prepare(
    "SELECT * FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'").all(siteLotC.csb.id);
  assert.equal(apres.length, 1, "la preuve de terrain survit au décochage");
  assert.equal(apres[0].id, avant[0].id);
  assert.equal(apres[0].submission_id, avant[0].submission_id);
  assert.equal(apres[0].origin, "odk");
  /* Rien n'a été écrit du tout : une grille qui afficherait « pas de visite » en
     face d'une visite réelle serait un second mensonge. */
  assert.equal(db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=4")
    .get(siteLotC.csb.id).done, 1);
});

test("grille mensuelle : cocher sans motif est refusé, et le refus dit quoi faire", async () => {
  const site = await creerSiteLotC({ code:"LOTA-MOTIF", name:"EPP Motif", activity_tag:"SMP" });
  const envoyer = (corps) => request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:6, active:true, planned:true, done:true, ...corps });

  const sansMotif = await envoyer({});
  assert.equal(sansMotif.status, 422, JSON.stringify(sansMotif.body));
  assert.match(sansMotif.body.error, /formulaire ODK/, "le refus rappelle quelle est la voie normale");
  assert.match(sansMotif.body.error, /choisissez le motif/);
  assert.equal(sansMotif.body.details[0].champ, "manual_reason");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c, 0);

  /* Liste fermée : un motif inventé par le client n'entre pas en base. */
  const horsListe = await envoyer({ manual_reason:"parce_que" });
  assert.equal(horsListe.status, 422);

  /* `inconnu_anterieur` existe, mais la migration seule l'écrit : il documente le
     passé, il n'ouvre pas une case fourre-tout pour les saisies à venir. */
  const reprise = await envoyer({ manual_reason:"inconnu_anterieur" });
  assert.equal(reprise.status, 422, "le motif de reprise n'est pas saisissable");

  const autreSansNote = await envoyer({ manual_reason:"autre" });
  assert.equal(autreSansNote.status, 422);
  assert.equal(autreSansNote.body.details[0].champ, "manual_note");
  assert.match(autreSansNote.body.details[0].message, /précisez/);

  const ok = await envoyer({ manual_reason:"appareil_indisponible", manual_note:"batterie à plat" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.visite, "creee");
  const v = db.prepare("SELECT * FROM visits WHERE site_id=?").get(site.id);
  assert.equal(v.origin, "manuelle");
  assert.equal(v.manual_reason, "appareil_indisponible");
  assert.equal(v.manual_note, "batterie à plat");

  /* L'interface ne peut rien afficher que /api/state ne porte pas — et la liste
     des motifs n'existe qu'ici, elle n'est recopiée nulle part côté client. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const vue = st.body.visits.find(x => x.id === v.id);
  assert.equal(vue.origin, "manuelle");
  assert.equal(vue.motif, "appareil_indisponible");
  assert.equal(vue.motifNote, "batterie à plat");
  assert.equal(vue.submissionId, "");
  const motif = st.body.motifsVisiteManuelle.find(x => x.id === "appareil_indisponible");
  assert.equal(motif.libelle, "Appareil indisponible (panne, batterie)");
  assert.equal(st.body.motifsVisiteManuelle.find(x => x.id === "autre").noteObligatoire, true);
  assert.equal(st.body.motifsVisiteManuelle.find(x => x.id === "inconnu_anterieur").saisissable, false);

  /* La trace d'audit porte le motif en clair : relire six mois plus tard pourquoi
     une visite ne vient d'aucun formulaire ne doit pas supposer d'ouvrir la fiche. */
  assert.ok(st.body.audit.some(a => a.text.includes("Appareil indisponible (panne, batterie)")
    && a.text.includes("batterie à plat")), "le journal porte le motif de la saisie");

  /* Un motif choisi par erreur se corrige. Sans cela, la seule façon de réparer
     l'étiquette serait de supprimer la donnée. */
  const corrige = await envoyer({ manual_reason:"soumission_perdue" });
  assert.equal(corrige.status, 200);
  assert.equal(corrige.body.visite, "corrigee");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c, 1,
    "corriger le motif ne crée pas un doublon");
  assert.equal(db.prepare("SELECT manual_reason FROM visits WHERE id=?").get(v.id).manual_reason,
    "soumission_perdue");

  /* Décocher retire bien la saisie à la main : le lot borne la saisie, il ne la
     supprime pas — et ce qu'elle a créé, elle peut le reprendre. */
  const retrait = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:6, active:true, planned:true, done:false });
  assert.equal(retrait.status, 200);
  assert.equal(retrait.body.visite, "supprimee");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c, 0);
});

test("grille mensuelle : un mois déjà couvert par ODK ne se saisit pas deux fois", async () => {
  const avant = db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'")
    .get(siteLotC.csb.id).c;
  const r = await request(app).put(`/api/sites/${siteLotC.csb.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:4, active:true, planned:true, done:true, monitor:"Testeur" });
  /* Aucun motif envoyé, et pourtant accepté : exiger une justification ici
     reviendrait à faire inventer une explication à une visite qui n'a rien d'une
     exception — la soumission la documente déjà. */
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.couvertParOdk, true);
  assert.equal(r.body.visite, "aucune");
  assert.match(r.body.message, /soumission ODK documente déjà ce mois/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=? AND visit_date LIKE '2026-05%'")
    .get(siteLotC.csb.id).c, avant, "le mois n'est pas doublé en silence");
});

test("grille mensuelle : le remède que le refus prescrit en est un — détacher la soumission retire sa visite", async () => {
  const site = await creerSiteLotC({ code:"LOTA-DETACH", name:"EPP Détachement", activity_tag:"SMP" });
  const v = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-detach-1", SvyDate:"2026-09-08",
      site_name:"EPP Détachement", activity_tag:"SMP" }]});
  assert.equal(v.body.resolues, 1, JSON.stringify(v.body));
  const sub = soumission("lota-detach-1");
  assert.equal(sub.site_id, site.id);

  const suivi = await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:8, site_id:site.id });
  assert.equal(suivi.status, 200, JSON.stringify(suivi.body));
  assert.equal(suivi.body.visitesCreees, 1);

  /* Le refus reste entier : une visite issue d'un formulaire ne se retire pas du
     plan. Mais il nomme un geste qui existe, à l'endroit où il se trouve — la
     destination « Actual Data » n'est plus montée nulle part, et aucun onglet ne
     s'appelle « Suivi de processus ». */
  const refus = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:8, active:true, planned:true, done:false });
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.match(refus.body.error, /Programme → Soumissions ODK/);
  assert.ok(!/Actual Data/.test(refus.body.error), "le refus ne renvoie pas vers un écran inexistant");

  /* Et le geste prescrit fait ce qu'il annonce. Jusqu'ici il ne touchait que
     `submissions.site_id` : la visite restait, le même 409 revenait mot pour mot,
     et un suivi appliqué au mauvais site gonflait ses indicateurs pour toujours —
     aucune route du dépôt ne supprime une visite. */
  const det = await request(app).post(`/api/submissions/${sub.id}/detacher`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(det.status, 200, JSON.stringify(det.body));
  assert.equal(det.body.visitesRetirees, 1);
  assert.deepEqual(det.body.moisDemarques, [{ site_id:site.id, mois:"2026-09" }]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c, 0);
  assert.equal(db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=8")
    .get(site.id).done, 0, "le mois retombe à « non réalisé » : plus rien ne le documente");
  /* La soumission, elle, survit : détacher rend la question au résolveur. */
  assert.equal(db.prepare("SELECT COUNT(*) c FROM submissions WHERE id=?").get(sub.id).c, 1);
  assert.ok(db.prepare(`SELECT text FROM audit WHERE entity_id=? AND action='detacher'`).get(sub.id)
    .text.includes("visite(s) issue(s) de cette soumission retirée(s)"),
    "le journal dit que la visite est partie avec le détachement");

  const apres = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:8, active:true, planned:true, done:false });
  assert.equal(apres.status, 200, "le décochage passe une fois la soumission détachée");
});

test("grille mensuelle : re-rattacher une soumission ne laisse pas de visite fantôme sur l'ancien site", async () => {
  /* Le cas de terrain : la passe `nom_seul` a rattaché la soumission au mauvais
     site, quelqu'un la déplace. Sans retrait, l'ancien site gardait une visite
     et un mois « réalisé » indélébiles — ils gonflaient sa couverture et son
     Visit Count pour toujours, puisque aucune route ne supprime une visite. */
  const faux = await creerSiteLotC({ code:"LOTA-FANTOME-A", name:"EPP Fantôme A", activity_tag:"SMP" });
  const vrai = await creerSiteLotC({ code:"LOTA-FANTOME-B", name:"EPP Fantôme B", activity_tag:"SMP" });
  await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-fantome-1", SvyDate:"2026-11-12",
      site_name:"EPP Fantôme A", activity_tag:"SMP" }]});
  const sub = soumission("lota-fantome-1");
  assert.equal(sub.site_id, faux.id);
  await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:10, site_id:faux.id });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(faux.id).c, 1);

  const r = await request(app).post(`/api/submissions/${sub.id}/rattacher-a`)
    .set("Authorization", `Bearer ${adminToken}`).send({ site_id: vrai.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.visitesRetirees, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(faux.id).c, 0);
  assert.equal(db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=10")
    .get(faux.id).done, 0);
  /* Le bon site ne reçoit pas la visite d'office : marquer le suivi reste un
     geste explicite, et c'est lui qui date la visite sur la période choisie. */
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(vrai.id).c, 0);
  const suivi = await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:10, site_id:vrai.id });
  assert.equal(suivi.body.visitesCreees, 1);
});

test("grille mensuelle : une soumission arrivée APRÈS la saisie à la main relie la ligne au lieu de la laisser orpheline", async () => {
  /* La protection du lot dépendait de l'ORDRE d'arrivée : soumission d'abord, la
     visite était protégée ; saisie d'abord, la ligne restait manuelle et un
     décochage effaçait la seule trace d'un mois pourtant documenté. */
  const site = await creerSiteLotC({ code:"LOTA-ORDRE", name:"EPP Ordre", activity_tag:"SMP" });
  const saisie = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:9, active:true, planned:true, done:true,
            manual_reason:"appareil_indisponible", manual_note:"batterie à plat" });
  assert.equal(saisie.body.visite, "creee");
  const v0 = db.prepare("SELECT * FROM visits WHERE site_id=?").get(site.id);
  assert.equal(v0.origin, "manuelle");

  const v = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-ordre-1", SvyDate:"2026-10-20", site_name:"EPP Ordre", activity_tag:"SMP" }]});
  assert.equal(v.body.resolues, 1, JSON.stringify(v.body));
  const suivi = await request(app).post("/api/submissions/suivi")
    .set("Authorization", `Bearer ${adminToken}`).send({ year:2026, month:9, site_id:site.id });
  assert.equal(suivi.status, 200, JSON.stringify(suivi.body));
  assert.equal(suivi.body.visitesCreees, 0, "aucun doublon : le mois n'a qu'une visite");
  assert.equal(suivi.body.visitesPromues, 1);

  const v1 = db.prepare("SELECT * FROM visits WHERE site_id=?").all(site.id);
  assert.equal(v1.length, 1);
  assert.equal(v1[0].id, v0.id, "c'est la MÊME ligne : la couverture ne compte pas deux fois");
  assert.equal(v1[0].submission_id, soumission("lota-ordre-1").id);
  assert.equal(v1[0].origin, "odk");
  assert.equal(v1[0].visit_date, "2026-10-20", "la date observée remplace la convention du 15");
  assert.equal(v1[0].manual_reason, null, "le motif de rattrapage tombe : le formulaire existe");

  const refus = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:9, active:true, planned:true, done:false });
  assert.equal(refus.status, 409, "le mois est désormais documenté, il ne se décoche plus");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(site.id).c, 1);
});

test("grille mensuelle : décocher rend la date de dernière visite à ce qui reste", async () => {
  const site = await creerSiteLotC({ code:"LOTA-DERNIERE", name:"EPP Dernière", activity_tag:"SMP" });
  assert.equal(db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id).last_visit, null);
  const cocher = (month, corps) => request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month, active:true, planned:true, done:true, ...corps });

  await cocher(2, { manual_reason:"soumission_perdue" });
  await cocher(6, { manual_reason:"soumission_perdue" });
  assert.equal(db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id).last_visit,
    "2026-07-15");

  /* Le site annonçait la date d'une visite qui n'existe plus : monthsSince, la
     priorité et le score de risque se calculaient sur une visite fantôme. */
  const retrait = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:6, active:true, planned:true, done:false });
  assert.equal(retrait.body.visite, "supprimee");
  assert.equal(db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id).last_visit,
    "2026-03-15", "elle retombe sur la saisie précédente, pas sur le vide");

  const dernier = await request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:2, active:true, planned:true, done:false });
  assert.equal(dernier.body.visite, "supprimee");
  assert.equal(db.prepare("SELECT last_visit FROM sites WHERE id=?").get(site.id).last_visit, null);
});

test("grille mensuelle : corriger un motif ne perd pas la précision écrite, et le journal ne signale que les vraies corrections", async () => {
  const site = await creerSiteLotC({ code:"LOTA-NOTE", name:"EPP Note", activity_tag:"SMP" });
  const envoyer = (corps) => request(app).put(`/api/sites/${site.id}/months`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ year:2026, month:3, active:true, planned:true, done:true, ...corps });
  const ligne = () => db.prepare("SELECT manual_reason, manual_note FROM visits WHERE site_id=?")
    .get(site.id);
  const corrections = () => db.prepare("SELECT COUNT(*) c FROM audit WHERE entity_id=? AND text LIKE ?")
    .get(site.id, "%(motif corrigé)%").c;

  await envoyer({ manual_reason:"formulaire_non_rempli", manual_note:"pluie battante, piste coupée" });
  assert.deepEqual(ligne(), { manual_reason:"formulaire_non_rempli",
    manual_note:"pluie battante, piste coupée" });

  /* Un appel qui ne corrige QUE le motif ne parle pas de la note : l'effacer
     ferait disparaître sans trace une explication écrite six mois plus tôt — et
     l'interface elle-même ne connaît pas toujours la note, la projection des
     visites étant plafonnée et filtrée par bureau. */
  const corr = await envoyer({ manual_reason:"soumission_perdue" });
  assert.equal(corr.body.visite, "corrigee");
  assert.deepEqual(ligne(), { manual_reason:"soumission_perdue",
    manual_note:"pluie battante, piste coupée" });
  assert.equal(corrections(), 1);

  /* Ré-enregistrer la fiche sans rien changer au motif n'est pas une correction :
     le journal n'est rendu qu'à ses soixante dernières lignes, et trois agents
     qui complètent leurs fiches en évacueraient tout le reste. */
  const rien = await envoyer({ manual_reason:"soumission_perdue", report:"MR-2026-04" });
  assert.equal(rien.body.visite, "conservee");
  assert.equal(corrections(), 1, "aucune ligne « motif corrigé » pour une correction qui n'a pas eu lieu");
  assert.equal(db.prepare("SELECT report FROM site_months WHERE site_id=? AND year=2026 AND month=3")
    .get(site.id).report, "MR-2026-04", "le reste de la fiche est bien enregistré");

  /* Effacer la note reste possible, mais explicitement. */
  const vide = await envoyer({ manual_reason:"soumission_perdue", manual_note:null });
  assert.equal(vide.body.visite, "corrigee");
  assert.equal(ligne().manual_note, null);
  assert.equal(corrections(), 2);
});

test("soumissions : un connecteur porteur de correspondances passe par appliquer(), pas par la détection", async () => {
  const c = (await creerConnecteur({ name:"ODK — NutritionAIM", kind:"odk",
    base_url:"https://odk.exemple.org", config:{ project:"1", formId:"NutritionAIM" } })).body.connector;
  const m = await request(app).put(`/api/connectors/${c.id}/mappings`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ entity:"submission", mappings: [
      { entity:"submission", mems_field:"instance_id", source_path:"uuid", transform:"texte" },
      /* Le formulaire nomme ses variables autrement : c'est exactement ce que la
         couche de correspondance existe pour absorber, sans une ligne de code. */
      { entity:"submission", mems_field:"site_name", source_path:"NomDuPoint", transform:"trim" },
      { entity:"submission", mems_field:"activity_tag", source_path:"Programme", transform:"majuscules" },
      { entity:"submission", mems_field:"svy_date", source_path:"DateReleve", transform:"date_iso" },
      { entity:"submission", mems_field:"lat", source_path:"Position", transform:"geopoint_lat" },
      { entity:"submission", mems_field:"lon", source_path:"Position", transform:"geopoint_lon" },
      { entity:"submission", mems_field:"gps_accuracy", source_path:"Position",
        transform:"geopoint_precision" }] });
  assert.equal(m.status, 200, JSON.stringify(m.body));

  const r = await verser({ connector_id:c.id, form_id:"NutritionAIM", enregistrements: [
    { uuid:"lotc-conn-1", NomDuPoint:"CSB TSIHOMBE", Programme:"nta",
      DateReleve:"14/05/2026", Position:"-25.3150 45.4940 30 12" }]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("lotc-conn-1");
  assert.equal(s.site_id, siteLotC.csb.id);
  assert.equal(s.svy_date, "2026-05-14", "la date française est normalisée par la transformation déclarée");
  assert.equal(s.gps_accuracy, 12);
  assert.equal(s.connector_id, c.id);

  /* Un connecteur sans correspondance pour cette entité est refusé avec le
     chemin de correction, plutôt que rattrapé en silence par la détection. */
  const vide = (await creerConnecteur({ name:"ODK — sans correspondance", kind:"odk",
    base_url:"https://odk.exemple.org", config:{} })).body.connector;
  const ko = await verser({ connector_id:vide.id, form_id:"X",
    enregistrements:[{ instance_id:"x" }] });
  assert.equal(ko.status, 422);
  assert.match(ko.body.error, /aucune correspondance/);
});

test("soumissions : le tirage ODK conserve l'identifiant d'instance, et le cache se verse tel quel", async () => {
  await request(app).put("/api/settings").set("Authorization", `Bearer ${adminToken}`)
    .send({ odkBase: odkMockUrl });
  /* La source « testform » existe déjà — `odk_forms` est unique sur (projet,
     formulaire), et c'est bien elle qu'on veut : on reprend la chaîne là où le
     test du tirage l'a laissée, plutôt que d'en déclarer une seconde. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const f = st.body.odkForms.find(x => x.formId === "testform" && x.project === "1");
  assert.ok(f, "la source ODK de test est déjà déclarée");
  const pull = await request(app).post(`/api/odk-forms/${f.id}/pull`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(pull.status, 200, JSON.stringify(pull.body));

  /* `__id` était écarté avec le reste des champs système d'OData : sans lui, deux
     tirages du même formulaire créaient des doublons au lieu de se recouvrir. */
  const cache = JSON.parse(db.prepare("SELECT raw FROM odk_forms WHERE id=?").get(f.id).raw);
  assert.ok(cache.every(x => x.instance_id), "chaque soumission du cache porte son identifiant");

  const un = await verser({ odk_form_id:f.id });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.crees, 3);
  const deux = await verser({ odk_form_id:f.id });
  assert.equal(deux.body.crees, 0);
  assert.equal(deux.body.misAJour, 3);

  /* La détection par défaut ne devine pas en silence : elle rend les
     correspondances retenues, variable source par champ MEMS. */
  const parChamp = Object.fromEntries(un.body.correspondances.map(x => [x.mems_field, x.source_path]));
  assert.equal(parChamp.instance_id, "instance_id");
  assert.equal(parChamp.svy_date, "SvyDate");
  assert.equal(parChamp.site_code, "DPName");
});

/* ═══════════════════════════════════════════════════════════════════════
   Codes externes multiples et rattachement manuel (chantier O, lot A).

   Trois manques que la chaîne ODK laissait ouverts :

     — un site n'a pas UN code externe. GD_PREVMA l'appelle par un p-code
       fokontany, MIARO par ce p-code suivi d'un numéro d'ordre, SMP par un
       ENTIER hors référentiel (603140007). Avec une colonne unique, brancher
       le second formulaire écrasait le premier ;
     — le bureau possède la liste des 1 251 codes école, et MEMS n'avait aucun
       moyen de l'avaler ;
     — devant une soumission que le résolveur refuse (à raison) de trancher,
       aucun geste humain n'existait. La file de travail montrait le problème
       sans permettre de le résoudre.
   ═══════════════════════════════════════════════════════════════════════ */

const ajouterCode = (siteId, corps) => request(app).post(`/api/sites/${siteId}/aliases`)
  .set("Authorization", `Bearer ${adminToken}`).send(corps);
const listerCodes = (siteId) => request(app).get(`/api/sites/${siteId}/aliases`)
  .set("Authorization", `Bearer ${adminToken}`);
const importerCodes = (corps) => request(app).post("/api/site-aliases/import")
  .set("Authorization", `Bearer ${adminToken}`).send(corps);
const soumission = (instance) =>
  db.prepare("SELECT * FROM submissions WHERE instance_id=?").get(instance);

test("codes externes : un même site porte plusieurs codes selon la source qui le désigne", async () => {
  /* Volontairement sans p-code : c'est le cas SMP, où le code de la source
     n'appartient à aucun référentiel géographique et ne se déduit de rien. Seule
     une correspondance déclarée peut rattacher. */
  const site = await creerSiteLotC({ code:"LOTA-SMP", external_code:"GDPREV-99001",
    name:"EPP Ambovombe Sud", activity_tag:"SMP" });

  /* Le code par défaut de la fiche est miroité dans la liste des codes : la
     fiche et la liste ne peuvent pas se contredire. */
  const avant = await listerCodes(site.id);
  assert.equal(avant.status, 200);
  assert.equal(avant.body.defaut, "GDPREV-99001");
  assert.deepEqual(avant.body.rows.map(x => x.code), ["GDPREV-99001"]);

  const ajout = await ajouterCode(site.id, { code:"603140007", source:"SMP_2025",
    note:"liste des 1 251 codes école du bureau" });
  assert.equal(ajout.status, 201, JSON.stringify(ajout.body));
  assert.equal(ajout.body.rows.length, 2,
    "un site porte PLUSIEURS codes : déclarer le second n'efface pas le premier");

  /* La fiche de site les sert tous, à côté du code par défaut qu'elle continue
     d'afficher — le frontend existant n'a rien à changer pour continuer à
     fonctionner, et tout à lire pour montrer le reste. */
  const fiche = await request(app).get(`/api/sites/${site.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(fiche.body.site.external_code, "GDPREV-99001");
  assert.equal(fiche.body.aliases.length, 2);

  /* Chacun des deux codes rattache — et le motif dit LEQUEL a servi. Deux
     versements distincts : la détection par défaut choisit une seule variable
     source par champ pour tout un lot, ce qui est le comportement attendu. */
  const parSmp = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-smp-1", Adm4Code_SMP:"603140007", SvyDate:"2026-07-02" }]});
  assert.equal(parSmp.status, 200, JSON.stringify(parSmp.body));
  const s1 = soumission("lota-smp-1");
  assert.equal(s1.site_id, site.id,
    "un code hors référentiel p-code rattache quand même, dès qu'une correspondance le déclare");
  assert.equal(s1.resolution_passe, "code_externe");
  assert.equal(s1.resolution_confiance, 1);
  assert.match(s1.resolution_motif, /SMP_2025/, "le motif nomme l'alias par lequel il a conclu");

  const parDefaut = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    { instance_id:"lota-smp-2", DPName:"GDPREV-99001", SvyDate:"2026-07-03" }]});
  assert.equal(parDefaut.status, 200, JSON.stringify(parDefaut.body));
  const s2 = soumission("lota-smp-2");
  assert.equal(s2.site_id, site.id);
  assert.match(s2.resolution_motif, /fiche du site/,
    "un rattachement par la colonne et un rattachement par alias ne se lisent pas pareil");

  /* Corriger le code par défaut REMPLACE son miroir et lui seul : l'alias
     importé ne bouge pas, et l'ancien code cesse de rattacher. Un code
     explicitement désavoué qui continuerait à opérer en douce serait le
     reproche exact qu'on ferait à une table qui ne serait qu'un historique. */
  const maj = await request(app).put(`/api/sites/${site.id}`)
    .set("Authorization", `Bearer ${adminToken}`).send({ external_code:"GDPREV-99002" });
  assert.equal(maj.status, 200, JSON.stringify(maj.body));
  const apres = await listerCodes(site.id);
  assert.deepEqual(apres.body.rows.map(x => x.code).sort(), ["603140007", "GDPREV-99002"]);

  const ancien = await verser({ form_id:"GD_PREVMA_v2", enregistrements: [
    { instance_id:"lota-ancien", DPName:"GDPREV-99001", SvyDate:"2026-07-04" }]});
  assert.equal(ancien.status, 200, JSON.stringify(ancien.body));
  assert.equal(soumission("lota-ancien").site_id, null,
    "le code retiré de la fiche ne rattache plus rien");

  /* Le miroir ne se supprime pas par la porte des alias : la fiche est le seul
     endroit d'où l'on modifie le code par défaut. */
  const miroir = apres.body.rows.find(x => x.code === "GDPREV-99002");
  const refus = await request(app).delete(`/api/site-aliases/${miroir.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refus.status, 409);
  assert.match(refus.body.error, /code par défaut/);
});

test("codes externes : l'import d'une table de correspondance est idempotent et n'escamote rien", async () => {
  const un = await creerSiteLotC({ code:"LOTA-I1", name:"EPP Import Un", activity_tag:"SMP" });
  const deux = await creerSiteLotC({ code:"LOTA-I2", name:"EPP Import Deux", activity_tag:"SMP" });

  const premier = await importerCodes({ source:"SMP_2025", lignes: [
    /* Un tableur livre les codes SMP en NOMBRE : les refuser obligerait chaque
       appelant à les convertir, donc à se tromper une fois. */
    { code: 603140021, site_code:"LOTA-I1" },
    { code: "603140022", site_code:"LOTA-I2" },
    /* Un second code pour la même école, désignée cette fois par son identifiant. */
    { code: "603140023", site_id: un.id, note:"code de l'ancien recensement" },
    { code: "603140099", site_code:"LOTA-INCONNU" },
    { site_code:"LOTA-I1" },
  ]});
  assert.equal(premier.status, 200, JSON.stringify(premier.body));
  assert.equal(premier.body.lues, 5);
  assert.equal(premier.body.crees, 3);
  /* Les lignes perdues sont LISTÉES. Un import qui avalerait 1 251 lignes en
     n'en rattachant que 900 sans dire lesquelles manquent ne serait pas un
     import, ce serait une perte de données lente. */
  assert.equal(premier.body.sitesIntrouvables.length, 1);
  assert.equal(premier.body.sitesIntrouvables[0].site_code, "LOTA-INCONNU");
  assert.equal(premier.body.sitesIntrouvables[0].code, "603140099");
  assert.equal(premier.body.invalides.length, 1);
  assert.match(premier.body.avertissement, /n'ont PAS été importées/);

  const second = await importerCodes({ source:"SMP_2025", lignes: [
    { code: 603140021, site_code:"LOTA-I1" },
    { code: "603140022", site_code:"LOTA-I2" },
    { code: "603140023", site_id: un.id },
  ]});
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.crees, 0, "rejouer le même fichier ne crée rien");
  assert.equal(second.body.dejaPresents, 3);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM site_external_code WHERE source='SMP_2025'").get().c,
    4, "trois lignes importées, plus celle du test précédent : aucun doublon");

  /* Le rattachement s'en sert immédiatement, sans re-tirer depuis ODK. */
  const r = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-imp-1", Adm4Code_SMP:"603140022", SvyDate:"2026-07-10" }]});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(soumission("lota-imp-1").site_id, deux.id);

  /* Un code déclaré pour deux sites reste ambigu. L'import le dit au lieu de le
     laisser découvrir au premier tirage — et ce qu'il annonce comme ambigu est
     exactement ce que le résolveur refusera de trancher. */
  const doublon = await importerCodes({ source:"GD_PREVMA", lignes: [
    { code:"603140021", site_code:"LOTA-I2" }]});
  assert.equal(doublon.status, 200, JSON.stringify(doublon.body));
  assert.equal(doublon.body.crees, 1);
  assert.equal(doublon.body.codesAmbigus.length, 1);
  assert.equal(doublon.body.codesAmbigus[0].code, "603140021");
  assert.equal(doublon.body.codesAmbigus[0].sites.length, 2);
  assert.match(doublon.body.remarque, /plusieurs sites/);

  const ambigu = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-imp-2", Adm4Code_SMP:"603140021", SvyDate:"2026-07-11" }]});
  assert.equal(ambigu.status, 200, JSON.stringify(ambigu.body));
  const a = soumission("lota-imp-2");
  assert.equal(a.site_id, null, "deux sites pour un code : aucun n'est choisi au hasard");
  assert.match(a.resolution_motif, /désigne 2 sites/);
});

test("soumissions : le rattachement manuel est tracé, il apprend, et rien ne l'écrase", async () => {
  const site = await creerSiteLotC({ code:"LOTA-M", name:"EPP Manuelle", activity_tag:"SMP" });
  const versement = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-manuel-1", Adm4Code_SMP:"603140777", SvyDate:"2026-07-20" }]});
  assert.equal(versement.status, 200, JSON.stringify(versement.body));
  const brute = soumission("lota-manuel-1");
  assert.equal(brute.site_id, null, "le résolveur ne devine pas un code qu'il ne connaît pas");

  const fait = await request(app).post(`/api/submissions/${brute.id}/rattacher-a`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ site_id: site.id, creer_alias: true });
  assert.equal(fait.status, 200, JSON.stringify(fait.body));
  assert.equal(fait.body.alias.cree, true);

  const decidee = db.prepare("SELECT * FROM submissions WHERE id=?").get(brute.id);
  assert.equal(decidee.site_id, site.id);
  assert.equal(decidee.resolution_passe, "manuel");
  assert.equal(decidee.resolution_confiance, 1,
    "un humain qui désigne un site ne « ressemble » pas à ce site : il l'identifie");
  assert.match(decidee.resolution_motif, /à la main par/);
  assert.match(decidee.resolution_motif, /603140777/, "le motif garde le code d'origine");

  const trace = db.prepare(`SELECT * FROM audit WHERE entity='submissions' AND entity_id=?
                            AND action='rattacher-manuel'`).get(brute.id);
  assert.ok(trace, "la décision entre au journal : qui, quoi, depuis quel bureau");
  assert.match(trace.text, /EPP Manuelle/);
  assert.ok(trace.user_id, "le journal nomme un compte, pas « le système »");

  /* L'alias créé à la volée est ce qui fait qu'on ne refait pas le geste à la
     soumission suivante : celle-ci se rattache toute seule. */
  const suivante = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-manuel-2", Adm4Code_SMP:"603140777", SvyDate:"2026-07-21" }]});
  assert.equal(suivante.status, 200, JSON.stringify(suivante.body));
  const auto = soumission("lota-manuel-2");
  assert.equal(auto.site_id, site.id);
  assert.equal(auto.resolution_passe, "code_externe");
  assert.match(auto.resolution_motif, /SMP_2025/);

  /* Le rejeu automatique, même demandé sur TOUTES les soumissions, ne défait
     jamais une décision humaine — et il dit combien il en a préservées. */
  const rejeu = await request(app).post("/api/submissions/rattacher")
    .set("Authorization", `Bearer ${adminToken}`).send({ toutes: true });
  assert.equal(rejeu.status, 200, JSON.stringify(rejeu.body));
  assert.ok(rejeu.body.protegees >= 1, JSON.stringify(rejeu.body));
  const apresRejeu = db.prepare("SELECT * FROM submissions WHERE id=?").get(brute.id);
  assert.equal(apresRejeu.resolution_passe, "manuel");
  assert.equal(apresRejeu.resolution_confiance, 1);

  /* Ni le re-versement du même tirage, qui ramène les mêmes instance_id à
     chaque appel d'ODK Central. La garantie est portée par la base. */
  const reverse = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lota-manuel-1", Adm4Code_SMP:"603140777", SvyDate:"2026-07-20" }]});
  assert.equal(reverse.status, 200, JSON.stringify(reverse.body));
  assert.equal(reverse.body.manuelsPreserves, 1);
  assert.equal(db.prepare("SELECT resolution_passe FROM submissions WHERE id=?")
    .get(brute.id).resolution_passe, "manuel");

  /* Le détachement, tout aussi tracé : c'est la porte de sortie sans laquelle
     une erreur de désignation serait définitive. */
  const detache = await request(app).post(`/api/submissions/${brute.id}/detacher`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(detache.status, 200, JSON.stringify(detache.body));
  const nue = db.prepare("SELECT * FROM submissions WHERE id=?").get(brute.id);
  assert.equal(nue.site_id, null);
  assert.equal(nue.resolution_passe, null, "détacher rend la question au résolveur");
  assert.equal(nue.resolution_confiance, 0);
  assert.match(nue.resolution_motif, /détaché à la main par/);
  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE entity='submissions' AND entity_id=?
                        AND action='detacher'`).get(brute.id), "le détachement est journalisé");

  /* Et puisque la question lui est rendue, le rejeu la reprend — l'alias créé
     plus haut la tranche désormais sans intervention. */
  const rejeu2 = await request(app).post("/api/submissions/rattacher")
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(rejeu2.status, 200, JSON.stringify(rejeu2.body));
  const reprise = db.prepare("SELECT * FROM submissions WHERE id=?").get(brute.id);
  assert.equal(reprise.site_id, site.id);
  assert.equal(reprise.resolution_passe, "code_externe");

  const deuxFois = await request(app).post(`/api/submissions/${brute.id}/detacher`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(deuxFois.status, 200);
  const encore = await request(app).post(`/api/submissions/${brute.id}/detacher`)
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(encore.status, 409, "détacher ce qui ne l'est pas est refusé, pas ignoré");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Référentiel de codes d'identification, chargé depuis Excel (lot B).

   La migration 018 avait livré le MÉCANISME — un site porte plusieurs codes —
   mais pas la LISTE. Ce lot ouvre le canal : un troisième type d'import, de
   portée NATIONALE, et un rapprochement séparé qui pose les alias.

   Ce que ces tests éprouvent, dans l'ordre :
     — que la portée nationale débranche réellement les gardes géographiques du
       cadre, SANS les débrancher pour les deux types qui les exigent ;
     — que l'import reste ce qu'il est : aperçu qui n'écrit rien, écriture
       idempotente par clé métier, ligne fautive rejetée avec un motif utile ;
     — que le rapprochement pose des alias, DIT ce qu'il n'a pas su rattacher
       des deux côtés, et refuse de conclure sur une preuve faible ;
     — que le droit exigé est bien « admin », et non « edit ».

   La section est placée après celle des codes externes parce qu'elle s'appuie
   sur son registre de sites — homonymes compris, qui sont ici le cas d'échec.
   ═══════════════════════════════════════════════════════════════════════════ */

const REF_CODES = "SMP_TEST_2026";
const siteLotB = {};

async function modeleCodes(token, referentiel = REF_CODES){
  const r = await request(app)
    .get(`/api/import/codes/template?referentiel=${encodeURIComponent(referentiel)}`)
    .set("Authorization", `Bearer ${token}`).buffer(true)
    .parse((res, cb) => { const d = []; res.on("data", c => d.push(c));
                          res.on("end", () => cb(null, Buffer.concat(d))); });
  assert.equal(r.status, 200,
    `le modèle « ${referentiel} » se télécharge : ${String(r.body).slice(0, 300)}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body);
  return wb;
}
/* Ajoute une entrée au modèle. `Code` d'abord, comme dans le tableau des
   colonnes : c'est cette colonne que sonde le garde de ligne blanche. */
const ajouterEntree = (ws, c, code, libelle, extra = {}) => {
  const row = ws.addRow([]);
  row.getCell(c["Code"]).value = code;
  row.getCell(c["Référentiel"]).value = REF_CODES;
  if(libelle !== undefined) row.getCell(c["Libellé"]).value = libelle;
  for(const [h, v] of Object.entries(extra)) row.getCell(c[h]).value = v;
  return row;
};
const rapprocherCodes = (token = adminToken, ref = REF_CODES) =>
  request(app).post(`/api/code-referentiels/${encodeURIComponent(ref)}/rapprocher`)
    .set("Authorization", `Bearer ${token}`).send({});
const entree = (code) => db.prepare("SELECT * FROM code_referentiel WHERE referentiel=? AND code=?")
  .get(REF_CODES, code);

test("référentiel de codes : le registre de sites du lot est en place", async () => {
  /* Trois voies de rapprochement, une par site : la désignation explicite, le
     p-code, et le nom seul — cette dernière volontairement sous le seuil. */
  siteLotB.designe  = await creerSiteLotC({ code:"LOTB-1", name:"EPP Lot B Désignée",
    activity_tag:"SMP" });
  siteLotB.parPcode = await creerSiteLotC({ code:"LOTB-2", name:"EPP Lot B Fokontany",
    activity_tag:"SMP", geo_pcode:"MG23288880002" });
  siteLotB.parNom   = await creerSiteLotC({ code:"LOTB-3", name:"EPP Lot B Nom Unique",
    activity_tag:"SMP" });
  assert.ok(siteLotB.designe.id && siteLotB.parPcode.id && siteLotB.parNom.id);
});

test("référentiel de codes : le modèle se télécharge sans millésime géographique, là où l'import géographique le refuse", async () => {
  /* On retire le millésime courant : sans lui, `scopeFor` rend un périmètre vide
     et le cadre refuse de produire un modèle. C'est LA preuve que la portée
     nationale débranche les deux gardes — et que la portée « geo » les garde. */
  const courant = db.prepare("SELECT id FROM geo_version WHERE is_current=1").all().map(x => x.id);
  db.prepare("UPDATE geo_version SET is_current=0").run();
  try{
    const geo = await request(app).get("/api/import/caseload/template")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(geo.status, 409, "la garde géographique tient toujours pour « caseload »");
    assert.match(geo.body.error, /référentiel géographique courant/);

    const wb = await modeleCodes(adminToken);
    const ws = wb.getWorksheet("Saisie");
    const c = colonnes(ws);
    assert.equal(Object.keys(c)[0], "Code",
      "« Code » est la première colonne clé : c'est elle que sonde le garde de ligne blanche");
    for(const h of ["Code","Référentiel","Libellé","P-code","Code du site MEMS","Source","Note"])
      assert.ok(c[h], `la colonne « ${h} » est présente`);
    assert.equal(ws.rowCount, 2,
      "au premier chargement le modèle n'a que ses deux lignes d'en-tête : rien n'est encore chargé");

    const meta = wb.getWorksheet("_mems");
    const kv = {}; meta.eachRow(r => { kv[String(r.getCell(1).value)] = String(r.getCell(2).value ?? ""); });
    assert.equal(kv.kind, "codes");
    assert.equal(kv.referentiel, REF_CODES,
      "le nom du référentiel voyage avec le fichier : c'est de lui que les lignes héritent");
  } finally {
    for(const id of courant) db.prepare("UPDATE geo_version SET is_current=1 WHERE id=?").run(id);
  }

  /* Sans nom de référentiel, il n'y a pas de clé métier : le modèle est refusé
     plutôt que produit sous un nom inventé. */
  const sansNom = await request(app).get("/api/import/codes/template")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(sansNom.status, 422);
  assert.match(sansNom.body.error, /précisez le référentiel/);
});

test("référentiel de codes : la prévisualisation n'écrit rien, la confirmation écrit, rejouer ne change plus rien", async () => {
  const wb = await modeleCodes(adminToken);
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);

  /* Un tableur livre les codes SMP en NOMBRE : le premier est donc passé tel quel. */
  ajouterEntree(ws, c, 603140001, "EPP Lot B Désignée", { "Code du site MEMS":"LOTB-1",
    "Source":"liste des 1 251 codes école" });
  ajouterEntree(ws, c, "MG23288880002", "EPP Lot B Fokontany");
  ajouterEntree(ws, c, "603140003", "EPP Lot B Nom Unique");
  ajouterEntree(ws, c, "603140004", "EPP Homonyme");
  ajouterEntree(ws, c, "603140005", "EPP Absente Du Registre");

  const prev = await televerser(adminToken, wb, "codes");
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.resume.crees, 5);
  assert.equal(prev.body.resume.rejetes, 0, JSON.stringify(prev.body.rejets));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM code_referentiel WHERE referentiel=?")
    .get(REF_CODES).c, 0, "rien n'est écrit à la prévisualisation");

  const ok = await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.crees, 5);
  assert.equal(entree("603140001").libelle, "EPP Lot B Désignée");
  assert.equal(entree("603140001").site_code, "LOTB-1");
  assert.ok(entree("603140001").import_batch_id, "l'entrée garde le lot qui l'a écrite");

  /* Rejouer le MÊME fichier : la réconciliation se fait par la clé métier
     (référentiel, code), donc plus rien ne change. */
  const encore = await televerser(adminToken, wb, "codes");
  assert.equal(encore.status, 200, JSON.stringify(encore.body));
  assert.equal(encore.body.resume.crees, 0);
  assert.equal(encore.body.resume.modifies, 0);
  assert.equal(encore.body.resume.inchanges, 5);

  /* Une correction de libellé, elle, se voit — et l'aperçu la nomme avant écriture. */
  const corr = await modeleCodes(adminToken);
  const wsc = corr.getWorksheet("Saisie"); const cc = colonnes(wsc);
  assert.equal(wsc.rowCount, 7, "le modèle revient rempli des cinq entrées déjà chargées");
  for(let n = 3; n <= wsc.rowCount; n++){
    if(String(wsc.getRow(n).getCell(cc["Code"]).value) !== "603140005") continue;
    wsc.getRow(n).getCell(cc["Libellé"]).value = "EPP Absente Du Registre (corrigée)";
  }
  const diff = await televerser(adminToken, corr, "codes");
  assert.equal(diff.body.resume.modifies, 1, JSON.stringify(diff.body.resume));
  assert.match(diff.body.apercu.modifies[0].message, /corrigée/);
  assert.match(diff.body.apercu.modifies[0].unite, /603140005/,
    "l'aperçu identifie la ligne par son code, pas par une unité administrative qu'elle n'a pas");
});

test("référentiel de codes : une ligne sans référentiel hérite de celui du fichier, un fichier fabriqué à la main est refusé avec le geste à faire", async () => {
  const wb = await modeleCodes(adminToken);
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);
  /* Le cas normal : l'opérateur colle 1 251 lignes portant code et libellé, sans
     recopier le nom du référentiel sur chacune. */
  const row = ws.addRow([]);
  row.getCell(c["Code"]).value = "603140006";
  row.getCell(c["Libellé"]).value = "EPP Héritée";
  const prev = await televerser(adminToken, wb, "codes");
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.resume.crees, 1, JSON.stringify(prev.body.rejets));
  await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(entree("603140006").referentiel, REF_CODES,
    "la ligne a hérité du référentiel porté par la feuille d'identification");

  /* Un fichier reconstruit à la main n'a pas cette feuille : il n'y a alors rien
     à hériter, et le motif doit dire quoi faire plutôt que laisser chercher. */
  const nu = new ExcelJS.Workbook();
  const wsn = nu.addWorksheet("Saisie");
  wsn.addRow(["Code","Référentiel","Libellé"]);
  wsn.addRow(["", "", ""]);
  wsn.addRow(["603140007", "", "EPP Sans Feuille d'Identification"]);
  const brut = await televerser(adminToken, nu, "codes");
  assert.equal(brut.status, 200, JSON.stringify(brut.body));
  assert.equal(brut.body.resume.rejetes, 1);
  assert.equal(brut.body.rejets[0].champ, "Référentiel");
  assert.match(brut.body.rejets[0].message, /téléchargez le modèle/);
  assert.match(brut.body.rejets[0].unite, /603140007/);
});

test("référentiel de codes : le rapprochement pose les alias, est idempotent, et refuse de conclure sous le seuil de preuve", async () => {
  const bilan = await rapprocherCodes();
  assert.equal(bilan.status, 200, JSON.stringify(bilan.body));
  const b = bilan.body;
  assert.equal(b.lues, 6, "les six entrées chargées sont confrontées au registre");

  /* Deux rattachements, sur deux preuves différentes et toutes deux suffisantes :
     la désignation explicite, et le p-code du fokontany. */
  assert.equal(b.rattachees, 2, JSON.stringify(b));
  assert.equal(b.alias, 2);
  assert.equal(entree("603140001").site_id, siteLotB.designe.id);
  assert.equal(entree("603140001").rapproche_passe, "designe");
  assert.equal(entree("MG23288880002").site_id, siteLotB.parPcode.id);
  assert.equal(entree("MG23288880002").rapproche_passe, "pcode_adm4");

  /* L'alias porte la SOURCE du référentiel : c'est ce qui rend le rattachement
     relisible six mois plus tard, et ce qui distingue un code importé en masse
     du code saisi sur la fiche du site. */
  const alias = db.prepare("SELECT * FROM site_external_code WHERE source=?").all(REF_CODES);
  assert.equal(alias.length, 2);
  assert.deepEqual(alias.map(a => a.code).sort(), ["603140001","MG23288880002"]);
  assert.ok(alias.every(a => /référentiel/.test(a.note || "")), "la note dit d'où vient le code");

  /* ── Le seuil de preuve, et le cliquet qu'il évite ────────────────────
     « EPP Lot B Nom Unique » ne se rapproche que par son nom : une seule
     ressemblance, à 0,4. L'entrée retient la piste et son motif, mais NE pose
     aucun alias — sans quoi le rapprochement suivant retrouverait ce code à
     confiance 1,0 et une hypothèse serait devenue une certitude sans témoin. */
  assert.ok(b.aConfirmerTotal >= 1, JSON.stringify(b.aConfirmer));
  const faible = b.aConfirmer.find(x => x.code === "603140003");
  assert.ok(faible, JSON.stringify(b.aConfirmer));
  assert.equal(faible.passe, "nom_seul");
  assert.ok(faible.confiance < b.seuil, `${faible.confiance} doit rester sous ${b.seuil}`);
  assert.equal(entree("603140003").site_id, null, "une piste faible ne rattache rien");
  assert.equal(entree("603140003").rapproche_passe, "nom_seul",
    "elle est tout de même enregistrée : c'est ce qui permet de la confirmer à la main");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM site_external_code WHERE code=?")
    .get("603140003").c, 0, "aucun alias n'est posé sous le seuil");

  /* Le journal reprend le bilan ENTIER, échecs compris. */
  const trace = db.prepare(`SELECT * FROM audit WHERE entity='code_referentiel' AND entity_id=?
                            ORDER BY rowid DESC`).get(REF_CODES);
  assert.ok(trace, "le rapprochement entre au journal");
  assert.match(trace.text, /sans site/);
  assert.match(trace.text, /à confirmer/);

  /* Rejouer : rien de plus n'est posé. Le second passage est même PLUS FORT que
     le premier, puisque les alias posés alimentent désormais l'index — d'où la
     passe « code externe » sur l'entrée que la désignation avait tranchée. */
  const deux = await rapprocherCodes();
  assert.equal(deux.status, 200, JSON.stringify(deux.body));
  assert.equal(deux.body.alias, 0, "aucun alias en double");
  assert.equal(deux.body.dejaPresents, 2);
  assert.equal(deux.body.rattachees, 2);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM site_external_code WHERE source=?")
    .get(REF_CODES).c, 2);

  /* Et la conséquence de tout le lot : une soumission SMP portant ce code
     entier, qui n'est le p-code de rien, se rattache désormais toute seule. */
  const v = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lotb-1", Adm4Code_SMP:"603140001", SvyDate:"2026-08-01" }]});
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const s = soumission("lotb-1");
  assert.equal(s.site_id, siteLotB.designe.id,
    "c'est ce que le lot débloque : SMP devient rattachable");
  assert.match(s.resolution_motif, new RegExp(REF_CODES));
});

test("référentiel de codes : le bilan NOMME ce qu'il n'a pas su faire, dans les deux sens", async () => {
  const r = await rapprocherCodes();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;

  /* ── Les entrées sans site : comptées ET nommées, avec leur motif ────
     Un compte seul ne se corrige pas. « EPP Homonyme » existe deux fois dans le
     registre : le résolveur refuse de trancher, et le bilan le dit. */
  assert.ok(b.sansSiteTotal >= 2, JSON.stringify(b.sansSite));
  const homonyme = b.sansSite.find(x => x.code === "603140004");
  assert.ok(homonyme, JSON.stringify(b.sansSite));
  assert.match(homonyme.motif, /EPP Homonyme/);
  const absente = b.sansSite.find(x => x.code === "603140005");
  assert.ok(absente, "l'entrée dont aucun site ne porte le nom est listée elle aussi");
  assert.match(absente.motif, /aucun site/);

  /* ── Les sites sans entrée : VENTILÉS PAR ACTIVITÉ, jamais en brut ───
     Pour une liste d'écoles, les centaines de points de distribution URT sans
     entrée sont normaux. Un total brut afficherait un chiffre alarmant et faux,
     et l'écran serait ignoré au bout de deux semaines. */
  assert.ok(Array.isArray(b.sitesSansEntree));
  assert.ok(b.sitesSansEntree.length > 1, "plusieurs activités sont distinguées");
  assert.ok(b.sitesSansEntree.every(x => typeof x.tag === "string" && Number.isInteger(x.sites)));
  const tousSites = db.prepare("SELECT COUNT(*) c FROM sites").get().c;
  const couverts = db.prepare(`SELECT COUNT(DISTINCT site_id) c FROM code_referentiel
                               WHERE referentiel=? AND site_id IS NOT NULL`).get(REF_CODES).c;
  assert.equal(b.sitesSansEntree.reduce((a, x) => a + x.sites, 0), tousSites - couverts,
    "la ventilation couvre exactement les sites que le référentiel n'atteint pas");
  const smp = b.sitesSansEntree.find(x => x.tag === "SMP");
  assert.ok(smp && smp.sites >= 1, "l'activité qui nous intéresse figure nommément");

  /* L'état se relit sans rien recalculer ni écrire : quatre compteurs qui
     s'additionnent au total, plus la même ventilation. */
  const etat = await request(app).get(`/api/code-referentiels/${REF_CODES}/etat`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(etat.status, 200);
  const e = etat.body;
  assert.equal(e.entrees, 6);
  assert.equal(e.rattachees + e.aConfirmer + e.sansSite + e.jamaisRapprochees, e.entrees,
    "la partition est stricte : rien ne se perd entre les quatre compteurs");
  assert.equal(e.rattachees, 2);
  assert.equal(e.seuil, 0.7);

  /* La liste est cherchable sur le code ET sur le libellé. */
  const liste = await request(app).get(`/api/code-referentiels/${REF_CODES}?q=Homonyme`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(liste.status, 200);
  assert.equal(liste.body.total, 1);
  assert.equal(liste.body.rows[0].code, "603140004");
  assert.ok(liste.body.rows[0].rapproche_motif, "la ligne dit pourquoi elle n'est pas rattachée");

  const rattaches = await request(app).get(`/api/code-referentiels/${REF_CODES}?rattache=oui`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(rattaches.body.total, 2);
  assert.ok(rattaches.body.rows.every(x => x.siteNom), "le site rattaché est nommé");

  /* Les référentiels chargés, avec leurs compteurs : ce que l'écran lit d'abord. */
  const tous = await request(app).get("/api/code-referentiels")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(tous.status, 200);
  const mien = tous.body.rows.find(x => x.referentiel === REF_CODES);
  assert.ok(mien, JSON.stringify(tous.body.rows));
  assert.equal(mien.entrees, 6);
  assert.equal(mien.rattachees, 2);
});

test("référentiel de codes : un compte « edit » ne charge ni ne rapproche — c'est une donnée nationale", async () => {
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;

  /* Il lit : un code école validé par tous n'est pas un secret de bureau, et le
     cacher obligerait chaque bureau à tenir sa copie. */
  const lecture = await request(app).get("/api/code-referentiels")
    .set("Authorization", `Bearer ${te}`);
  assert.equal(lecture.status, 200, "la lecture est ouverte à tout compte authentifié");

  /* Il n'écrit pas : une table chargée de travers empoisonne le rattachement de
     TOUS les bureaux, pas seulement du sien. */
  const modele = await request(app).get(`/api/import/codes/template?referentiel=${REF_CODES}`)
    .set("Authorization", `Bearer ${te}`);
  assert.equal(modele.status, 403);
  assert.match(modele.body.error, /admin/);

  const wb = await modeleCodes(adminToken);
  const envoi = await televerser(te, wb, "codes");
  assert.equal(envoi.status, 403, JSON.stringify(envoi.body));

  const rap = await rapprocherCodes(te);
  assert.equal(rap.status, 403, JSON.stringify(rap.body));

  /* Un référentiel jamais chargé se distingue d'un référentiel vide : on ne
     rapproche pas dans le vide en annonçant zéro rattachement. */
  const inconnu = await rapprocherCodes(adminToken, "REFERENTIEL_INEXISTANT");
  assert.equal(inconnu.status, 404);
  assert.match(inconnu.body.error, /importez d'abord le fichier/);
});

test("référentiel de codes : le modèle du premier chargement se remplit — la zone de saisie n'est pas verrouillée", async () => {
  /* Le défaut que ce test ferme : la protection de feuille était posée, mais les
     seules cellules déverrouillées étaient produites par la boucle des lignes
     pré-remplies. Sur un référentiel neuf, `seed()` n'en rend aucune — le modèle
     sortait donc entièrement verrouillé, et l'écran promettait pourtant « au
     premier chargement il est vide, et vous y collez vos lignes ». */
  const wb = await modeleCodes(adminToken, "SMP_MODELE_NEUF");
  const ws = wb.getWorksheet("Saisie");
  assert.equal(ws.rowCount, 2, "aucune ligne pré-remplie : c'est bien le cas du premier chargement");
  const c = colonnes(ws);

  assert.ok(ws.sheetProtection?.sheet, "la feuille reste protégée : les clés ne se cassent pas");
  /* Le verrou est porté par la COLONNE, donc il vaut pour les cellules encore
     vides — celles que l'opérateur va remplir. */
  assert.equal(ws.getCell(3, c["Code"]).style.protection.locked, false);
  assert.equal(ws.getCell(3, c["Libellé"]).style.protection.locked, false);
  assert.equal(ws.getCell(500, c["Code du site MEMS"]).style.protection.locked, false,
    "coller mille lignes reste possible, pas seulement les premières");
  assert.notEqual(ws.getCell(3, c["Référentiel"]).style.protection?.locked, false,
    "la colonne pré-remplie, elle, reste verrouillée");
});

test("référentiel de codes : corriger une désignation retire l'alias devenu faux au lieu d'en poser un second", async () => {
  /* Le bureau s'est trompé de site dans son fichier et le corrige. Sans retrait
     de l'alias d'hier, le code désignait DEUX sites : le résolveur refusait de
     trancher, et la correction cassait le rattachement qu'elle venait débloquer. */
  const corr = await modeleCodes(adminToken);
  const ws = corr.getWorksheet("Saisie"); const c = colonnes(ws);
  for(let n = 3; n <= ws.rowCount; n++){
    if(String(ws.getRow(n).getCell(c["Code"]).value) !== "603140001") continue;
    ws.getRow(n).getCell(c["Code du site MEMS"]).value = "LOTB-3";
  }
  const prev = await televerser(adminToken, corr, "codes");
  assert.equal(prev.body.resume.modifies, 1, JSON.stringify(prev.body.resume));
  await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${adminToken}`);

  const r = await rapprocherCodes();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.aliasRetires, 1, "l'alias périmé est retiré, et le bilan le dit");
  assert.equal(entree("603140001").site_id, siteLotB.parNom.id);

  const alias = db.prepare("SELECT site_id FROM site_external_code WHERE code=? AND source=?")
    .all("603140001", REF_CODES);
  assert.equal(alias.length, 1, "un code, une source, un site");
  assert.equal(alias[0].site_id, siteLotB.parNom.id);
  assert.ok(!r.body.codesAmbigus.some(x => x.code === "603140001"),
    "le code n'est plus ambigu : c'est tout l'objet du retrait");

  /* La conséquence, mesurée là où elle compte : la soumission suivante se
     rattache au site corrigé au lieu de retomber « non résolue ». */
  const v = await verser({ form_id:"SMP_2025", enregistrements: [
    { instance_id:"lotb-corrige", Adm4Code_SMP:"603140001", SvyDate:"2026-08-02" }]});
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(soumission("lotb-corrige").site_id, siteLotB.parNom.id);
});

test("référentiel de codes : une entrée qui PERD son site est comptée et nommée, pas effacée en silence", async () => {
  /* Relancer le rapprochement est présenté comme sûr. Il l'est pour les alias ;
     il ne l'est pas pour les rattachements quand le registre a bougé entre-temps.
     Le taire, c'est laisser découvrir six mois plus tard un écran qui affiche
     « 0 rattachée » sans que personne n'ait rien fait. */
  const site = siteLotB.parNom;
  const renommer = (code) => request(app).put(`/api/sites/${site.id}`)
    .set("Authorization", `Bearer ${adminToken}`).send({ code, name:site.name });
  assert.equal((await renommer("LOTB-3B")).status, 200);

  const r = await rapprocherCodes();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.detacheesTotal, 1, JSON.stringify(r.body.detachees));
  assert.equal(r.body.detachees[0].code, "603140001");
  assert.match(r.body.detachees[0].motif, /ne désigne aucun site/,
    "le motif dit pourquoi, et donc quoi corriger");
  assert.match(r.body.detachement, /ont PERDU le site/);
  assert.equal(entree("603140001").site_id, null);

  const trace = db.prepare(`SELECT * FROM audit WHERE entity='code_referentiel' AND entity_id=?
                            ORDER BY rowid DESC`).get(REF_CODES);
  assert.match(trace.text, /1 détachée/);

  /* L'alias posé au passage précédent, lui, survit : il n'est retiré que par une
     conclusion CONTRAIRE, jamais par une absence de conclusion. C'est ce qui
     permet de réparer le fichier sans avoir tout perdu entre-temps. */
  assert.equal(db.prepare("SELECT COUNT(*) c FROM site_external_code WHERE code=? AND source=?")
    .get("603140001", REF_CODES).c, 1);

  assert.equal((await renommer("LOTB-3")).status, 200);
  const remis = await rapprocherCodes();
  assert.equal(remis.body.detacheesTotal, 0);
  assert.equal(entree("603140001").site_id, site.id, "le fichier corrigé, le rattachement revient");
});

test("référentiel de codes : le motif ne nomme pas les sites d'un autre bureau", async () => {
  /* La jointure sur `sites` est bornée au bureau de l'appelant, et l'entrée
     rattachée ailleurs est signalée sans être nommée. Le motif du résolveur, lui,
     partait tel quel — et il NOMME les sites, code MEMS compris : il suffisait de
     lire la colonne « Pourquoi » pour énumérer les sites d'un autre bureau, y
     compris les homonymes du registre national. */
  const bureaux = db.prepare("SELECT id FROM offices WHERE kind='field' ORDER BY name").all();
  const mien = db.prepare("SELECT office_id FROM users WHERE email=?").get("terrain@test.local").office_id;
  const ailleurs = bureaux.find(o => o.id !== mien).id;
  const codes = [siteLotB.designe.id, siteLotB.parPcode.id, siteLotB.parNom.id];
  const avant = codes.map(id => db.prepare("SELECT office_id FROM sites WHERE id=?").get(id).office_id);
  const poser = (o) => codes.forEach(id =>
    db.prepare("UPDATE sites SET office_id=? WHERE id=?").run(o, id));
  poser(ailleurs);
  try{
    const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
    const l = await request(app).get(`/api/code-referentiels/${REF_CODES}?limit=500`)
      .set("Authorization", `Bearer ${te}`);
    assert.equal(l.status, 200, JSON.stringify(l.body));
    /* Les libellés du référentiel, eux, restent servis : ils viennent du fichier
       du bureau qui l'a chargé, pas du registre des sites — c'est une donnée
       nationale, et la masquer obligerait chaque bureau à tenir sa copie. Ce qui
       ne doit pas sortir, c'est ce que le résolveur a lu DANS le registre. */
    const motifs = l.body.rows.map(x => x.rapproche_motif || "").join(" ");
    assert.ok(!/LOTB-/.test(motifs), "aucun code MEMS d'un autre bureau ne sort");
    assert.ok(!/« EPP Lot B/.test(motifs), "aucun nom de site d'un autre bureau non plus");
    const rattachee = l.body.rows.find(x => x.site_id);
    assert.ok(rattachee, JSON.stringify(l.body.rows.map(x => x.code)));
    assert.equal(rattachee.siteNom, null);
    assert.equal(rattachee.rattacheHorsBureau, true, "l'existence du rattachement, elle, est dite");
    assert.match(rattachee.rapproche_motif, /autre bureau/);

    /* Un compte non borné, lui, garde le motif entier : c'est la seule chose qui
       permette de corriger une entrée. */
    const admin = await request(app).get(`/api/code-referentiels/${REF_CODES}?limit=500`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.ok(/EPP Lot B/.test(JSON.stringify(admin.body)));
  } finally {
    codes.forEach((id, i) =>
      db.prepare("UPDATE sites SET office_id=? WHERE id=?").run(avant[i], id));
  }
});

test("référentiel de codes : les motifs parlent de l'entrée du fichier, jamais d'une soumission", async () => {
  /* Le résolveur est partagé avec l'ingestion ODK, et ses motifs sont rédigés
     pour une soumission. Servis tels quels à un opérateur qui vient de charger un
     tableur, ils expliquent sa ligne en parlant d'un objet qu'il n'a jamais
     manipulé. Même règle, même code, un mot près. */
  const motifs = db.prepare("SELECT code, rapproche_motif FROM code_referentiel WHERE referentiel=?")
    .all(REF_CODES).filter(x => x.rapproche_motif);
  assert.ok(motifs.length >= 5);
  const fautif = motifs.find(x => /soumission/.test(x.rapproche_motif));
  assert.equal(fautif, undefined, `le motif de ${fautif?.code} parle encore d'une soumission`);
  assert.ok(motifs.some(x => /l'entrée/.test(x.rapproche_motif)),
    "et il nomme ce que l'opérateur regarde vraiment");
});

test("référentiel de codes : recharger un fichier amputé d'une colonne ne vide pas cette colonne", async () => {
  /* Le cas réel : l'opérateur reconstruit sa feuille depuis son propre système en
     n'y gardant que le code, le référentiel et le libellé. `readUpload` rend ""
     pour les colonnes absentes, ce qui était indiscernable d'une case vidée à la
     main : le code du site MEMS et la source repartaient à NULL sur chacune des
     lignes réimportées. Un fichier qui ne parle pas d'une colonne n'en dit rien —
     même règle que pour un PUT partiel sur une fiche de site. */
  const wb = await modeleCodes(adminToken);
  const ws = wb.getWorksheet("Saisie"); const c = colonnes(ws);
  ajouterEntree(ws, c, "603140011", "EPP Colonne Absente",
    { "Code du site MEMS":"LOTB-2", "Source":"fichier du bureau" });
  const pose = await televerser(adminToken, wb, "codes");
  await request(app).post(`/api/import/batches/${pose.body.batch}/commit`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(entree("603140011").site_code, "LOTB-2");

  const nu = new ExcelJS.Workbook();
  const wsn = nu.addWorksheet("Saisie");
  wsn.addRow(["Code","Référentiel","Libellé"]);
  wsn.addRow(["", "", ""]);
  wsn.addRow(["603140011", REF_CODES, "EPP Colonne Absente (corrigée)"]);
  const prev = await televerser(adminToken, nu, "codes");
  assert.equal(prev.status, 200, JSON.stringify(prev.body));
  assert.equal(prev.body.resume.modifies, 1, JSON.stringify(prev.body.resume));
  assert.match(prev.body.apercu.modifies[0].message, /corrigée/);
  assert.ok(!/Code du site MEMS/.test(prev.body.apercu.modifies[0].message),
    "une colonne absente n'est pas présentée comme une modification");

  const ok = await request(app).post(`/api/import/batches/${prev.body.batch}/commit`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const e = entree("603140011");
  assert.equal(e.libelle, "EPP Colonne Absente (corrigée)", "ce que le fichier dit est écrit");
  assert.equal(e.site_code, "LOTB-2", "ce dont il ne parle pas est conservé");
  assert.equal(e.source, "fichier du bureau");
});

test("référentiel de codes : le nom réservé au miroir de la fiche de site est refusé", async () => {
  /* Le nom d'un référentiel devient la `source` de ses alias. Baptisé « fiche du
     site », il tombe sous le delete-then-insert de `synchroniserCodeParDefaut` :
     la première correction de code externe sur une fiche efface tous ses codes,
     pendant que l'écran continue d'afficher un rattachement qui ne rattache plus
     rien. La réserve posée en tête de lib/alias.js devient donc opposable. */
  const modele = await request(app).get("/api/import/codes/template?referentiel=fiche%20du%20site")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(modele.status, 422, "le modèle n'est même pas produit");
  assert.match(modele.body.error, /réservé au code par défaut/);

  const rap = await rapprocherCodes(adminToken, "Fiche Du Site");
  assert.equal(rap.status, 422, "la casse ne contourne pas la réserve");
  assert.match(rap.body.error, /réservé au code par défaut/);

  const lecture = await request(app).get("/api/code-referentiels/fiche%20du%20site")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(lecture.status, 422);

  /* Et la ligne collée dans un fichier ne le contourne pas davantage : c'est une
     entrée utilisateur comme une autre, refusée avec son motif. */
  const nu = new ExcelJS.Workbook();
  const wsn = nu.addWorksheet("Saisie");
  wsn.addRow(["Code","Référentiel","Libellé"]);
  wsn.addRow(["", "", ""]);
  wsn.addRow(["603140012", "fiche du site", "EPP Nom Réservé"]);
  const brut = await televerser(adminToken, nu, "codes");
  assert.equal(brut.body.resume.rejetes, 1, JSON.stringify(brut.body.resume));
  assert.equal(brut.body.rejets[0].champ, "Référentiel");
  assert.match(brut.body.rejets[0].message, /réservé au code par défaut/);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Exécution des scripts d'analyse R et SPSS sur le serveur.

   Ces tests portent sur une fonction qui exécute du code arbitraire : ils
   vérifient d'abord ce qui l'empêche de s'ouvrir toute seule, puis ce qui la
   borne quand elle est ouverte.

   Deux familles, volontairement distinctes :
     — les tests de MÉCANIQUE (environnement expurgé, délai, troncature,
       fichiers produits, nettoyage) passent par un interpréteur d'essai : un
       script shell de trois lignes déclaré comme n'importe quel interpréteur.
       Ce qu'ils éprouvent — le bac de travail, l'environnement, le groupe de
       processus — appartient à lib/moteur.js et non à R ; les faire dépendre
       d'une installation de R rendrait muet le jour où elle manque exactement
       ce qui doit rester vérifié ;
     — les tests d'EXÉCUTION RÉELLE lancent Rscript et pspp. Ils sont
       conditionnés à leur présence et annoncent leur absence au lieu de la
       masquer.
   ═══════════════════════════════════════════════════════════════════════════ */

const bacAnalyse = fs.mkdtempSync(path.join(os.tmpdir(), "mems-analyse-test-"));
process.env.ANALYSIS_WORKDIR = path.join(bacAnalyse, "travaux");
fs.mkdirSync(process.env.ANALYSIS_WORKDIR, { recursive:true });
after(() => fs.rmSync(bacAnalyse, { recursive:true, force:true }));

/* Interpréteur d'essai : il ignore les options et exécute le dernier argument
   — le fichier de script — avec sh. Vu du serveur c'est un interpréteur comme
   un autre, déclaré par la même variable et lancé par le même code. */
const FAUX_INTERPRETEUR = path.join(bacAnalyse, "faux-interpreteur");
fs.writeFileSync(FAUX_INTERPRETEUR,
  '#!/bin/sh\nfor a in "$@"; do f="$a"; done\nexec /bin/sh "$f"\n', { mode:0o755 });

const trouverBinaire = (nom) => {
  try{ return execFileSync("which", [nom], { encoding:"utf8" }).trim() || null; }
  catch{ return null; }
};
const RSCRIPT = trouverBinaire("Rscript");
const PSPP = trouverBinaire("pspp");

let nAnalyse = 0;
const creerJeu = (lignes) => {
  const id = `ds_essai_${++nAnalyse}`;
  db.prepare("INSERT INTO datasets (id,name,raw) VALUES (?,?,?)")
    .run(id, "Jeu d'essai", JSON.stringify(lignes));
  return id;
};
const creerScript = ({ lang="R", code="", jeu=null }={}) => {
  const id = `sc_essai_${++nAnalyse}`;
  db.prepare(`INSERT INTO scripts (id,name,language,stage,dataset_id,code,notes)
              VALUES (?,?,?,'analysis',?,?,'')`)
    .run(id, `Analyse d'essai ${nAnalyse}`, lang, jeu, code);
  return id;
};
/* Les réglages sont posés le temps de l'appel puis rendus : la configuration
   d'analyse est relue à chaque exécution, c'est ce qui rend ces tests possibles
   sans redémarrer le serveur. */
async function lancerAnalyse({ code, lang="R", jeu=null, reglages={}, corps={}, jeton=null }){
  const anciens = {};
  for(const [k,v] of Object.entries(reglages)){ anciens[k] = process.env[k]; process.env[k] = v; }
  try{
    const id = creerScript({ lang, code, jeu });
    /* Sans jeu de données relié, la route exige des lignes explicites : un
       script d'analyse qui n'analyse rien est une erreur de saisie, pas un cas
       normal. Les essais qui n'ont pas besoin de données envoient donc [] . */
    const charge = (jeu || corps.lignes) ? corps : { ...corps, lignes: [] };
    return await request(app).post(`/api/scripts/${id}/executer`)
      .set("Authorization", `Bearer ${jeton || adminToken}`).send(charge);
  }finally{
    for(const [k,v] of Object.entries(anciens))
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}
const travauxRestants = () => fs.readdirSync(path.join(process.env.ANALYSIS_WORKDIR, "mems-analyse"))
  .filter(n => n.startsWith("travail-"));

test("scripts d'analyse : sans interpréteur déclaré la fonction est absente, et le 503 dit comment l'activer", async () => {
  delete process.env.ANALYSIS_R; delete process.env.ANALYSIS_SPSS;

  const etat = await request(app).get("/api/scripts/moteurs")
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(etat.status, 200);
  assert.equal(etat.body.actif, false, "aucun interpréteur ne doit être actif par défaut");
  assert.deepEqual(etat.body.moteurs.map(m => m.lang).sort(), ["R","SPSS"]);
  assert.ok(etat.body.moteurs.every(m => !m.disponible && /n'est pas renseignée/.test(m.raison)));

  const id = creerScript({ code:"echo bonjour" });
  const r = await request(app).post(`/api/scripts/${id}/executer`)
    .set("Authorization", `Bearer ${adminToken}`).send({ lignes:[] });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /ANALYSIS_R/);
  assert.match(r.body.error, /ANALYSIS_SPSS/);
  assert.match(r.body.error, /aucun script/);

  /* Un nom d'exécutable relatif s'en remettrait au PATH du serveur : refusé
     aussi, et pour une raison qui se lit. */
  const relatif = await lancerAnalyse({ code:"echo bonjour", reglages:{ ANALYSIS_R:"Rscript" }});
  assert.equal(relatif.status, 503);
  assert.match(relatif.body.error, /chemin absolu/);

  const absent = await lancerAnalyse({ code:"echo bonjour",
    reglages:{ ANALYSIS_R: path.join(bacAnalyse, "nulle-part") }});
  assert.equal(absent.status, 503);
  assert.match(absent.body.error, /introuvable|exécutable/);
});

test("scripts d'analyse : un administrateur qui n'est pas super-utilisateur est refusé", async () => {
  const cree = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"admin-simple@test.local", password:"AdminSimple2026x", first_name:"Admin",
            last_name:"Simple", role:"admin", tabs:["home"], active:true });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  motDePasseAdopte("admin-simple@test.local");
  const jeton = (await login("admin-simple@test.local", "AdminSimple2026x")).body.token;

  /* Ce compte a bel et bien la capacité « admin » : le journal de sécurité,
     qui l'exige, lui répond. Le refus qui suit ne vient donc pas d'un manque
     de droits d'administration, mais de la distinction super/admin. */
  assert.equal((await request(app).get("/api/audit")
    .set("Authorization", `Bearer ${jeton}`)).status, 200);

  /* Interpréteur déclaré et utilisable : rien d'autre que le rôle ne bloque. */
  const r = await lancerAnalyse({ code:"echo bonjour", jeton,
    reglages:{ ANALYSIS_R: FAUX_INTERPRETEUR }});
  assert.equal(r.status, 403);
  assert.match(r.body.error, /super-utilisateur/);
  assert.equal((await request(app).get("/api/scripts/moteurs")
    .set("Authorization", `Bearer ${jeton}`)).status, 403);

  /* Et le super-utilisateur, lui, passe : le refus est bien une question de rôle. */
  const ok = await lancerAnalyse({ code:"echo bonjour", reglages:{ ANALYSIS_R: FAUX_INTERPRETEUR }});
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("scripts d'analyse : le script n'hérite d'AUCUNE variable de l'application", async () => {
  const code = [
    'echo "JWT=[$JWT_SECRET]"',
    'echo "CLE=[$DATA_KEY]"',
    'echo "BASE=[$DB_FILE]"',
    'echo "AMORCE=[$BOOTSTRAP_PASSWORD]"',
    'echo "ODK=[$ODK_ALLOWED_HOSTS]"',
    'echo "---"',
    'env | sort',
  ].join("\n");
  const r = await lancerAnalyse({ code, reglages:{ ANALYSIS_R: FAUX_INTERPRETEUR }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ex = r.body.execution;
  assert.equal(ex.statut, "ok", ex.erreur);

  for(const v of ["JWT","CLE","BASE","AMORCE","ODK"])
    assert.match(ex.sortie, new RegExp(`^${v}=\\[\\]$`, "m"),
      `${v} devait être vide dans l'environnement de l'enfant`);
  assert.ok(!ex.sortie.includes("x".repeat(48)), "le secret de signature n'a pas fuité");
  assert.ok(!ex.sortie.includes("y".repeat(48)), "la clé de chiffrement n'a pas fuité");
  assert.ok(!ex.sortie.includes("MotDePasseTest2026"), "le mot de passe d'amorçage n'a pas fuité");
  assert.ok(!/test\.db/.test(ex.sortie), "le chemin de la base n'a pas fuité");

  /* L'environnement complet, et pas seulement les variables qu'on a pensé à
     interroger : tout ce que l'enfant voit tient dans la liste blanche, plus
     ce que le shell se pose lui-même (PWD, SHLVL…). */
  const bloc = ex.sortie.split("---\n")[1] || "";
  const noms = bloc.split("\n").map(l => l.split("=")[0]).filter(Boolean);
  const blanche = new Set(["PATH","HOME","TMPDIR","LANG","LC_ALL","PWD","SHLVL","_","OLDPWD","IFS","PS1","PS2","PS4"]);
  assert.deepEqual(noms.filter(n => !blanche.has(n)), [],
    "aucune variable hors liste blanche ne doit atteindre le script");
  assert.match(bloc, /^PATH=\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(bloc, /^HOME=.*mems-analyse.*foyer$/m,
    "HOME pointe dans le bac de travail, jamais sur celui du compte serveur");
  assert.match(bloc, /^TMPDIR=.*mems-analyse.*foyer$/m);
});

test("scripts d'analyse : le délai dépassé tue le script ET les processus qu'il a lancés", async () => {
  const temoin = path.join(bacAnalyse, "temoin-groupe.txt");
  /* Le petit-fils écrit HORS du répertoire de travail : s'il survivait au
     nettoyage comme à la mort de son père, son témoin resterait. Tuer le seul
     pid du script le laisserait précisément vivre. */
  const code = [
    `/bin/sh -c 'sleep 5; : > ${temoin}' &`,
    "sleep 60",
  ].join("\n");
  const t0 = Date.now();
  const r = await lancerAnalyse({ code, reglages:{
    ANALYSIS_R: FAUX_INTERPRETEUR, ANALYSIS_TIMEOUT_S:"1", ANALYSIS_KILL_GRACE_S:"1" }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.execution.statut, "delai");
  assert.match(r.body.execution.message, /délai dépassé/);
  assert.ok(Date.now() - t0 < 20_000, "la requête ne doit pas attendre la fin du script");

  await new Promise(res => setTimeout(res, 7000));
  assert.equal(fs.existsSync(temoin), false,
    "le processus lancé par le script devait mourir avec son groupe");
  assert.deepEqual(travauxRestants(), [], "le répertoire de travail est supprimé même après un délai dépassé");
});

test("scripts d'analyse : une sortie trop longue est coupée et annoncée comme tronquée", async () => {
  const code = [
    "i=0",
    "while [ $i -lt 400 ]; do",
    "  echo '0123456789012345678901234567890123456789012345678901234567890123456789'",
    "  i=$((i + 1))",
    "done",
    "j=0",
    "while [ $j -lt 400 ]; do",
    "  echo 'erreur 0123456789012345678901234567890123456789012345678901234567890' >&2",
    "  j=$((j + 1))",
    "done",
  ].join("\n");
  const r = await lancerAnalyse({ code, reglages:{
    ANALYSIS_R: FAUX_INTERPRETEUR, ANALYSIS_MAX_OUTPUT_KB:"1" }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ex = r.body.execution;
  assert.equal(ex.statut, "ok");
  assert.equal(ex.tronque, true);
  assert.equal(ex.sortieTronquee, true);
  assert.equal(ex.erreurTronquee, true);
  assert.equal(Buffer.byteLength(ex.sortie), 1024, "la sortie est coupée au plafond, pas au-delà");
  assert.equal(Buffer.byteLength(ex.erreur), 1024);

  const trace = db.prepare(`SELECT * FROM audit WHERE entity='scripts' AND action='execute'
                            ORDER BY at DESC, rowid DESC LIMIT 1`).get();
  assert.match(trace.text, /sortie tronquée/, "le journal dit aussi que la sortie a été coupée");
});

test("scripts d'analyse : données transmises par CSV local, fichiers produits servis, répertoire effacé, exécution journalisée", async () => {
  const jeu = creerJeu([
    { site:"A", note:'un guillemet " et, une virgule', n:1 },
    { site:"B", note:"un retour\nligne", n:2 },
  ]);
  const code = [
    "cp donnees.csv copie-des-donnees.csv",
    /* Le script tel qu'il a réellement été exécuté : sert à prouver que les
       données n'y ont pas été interpolées. */
    "cp analyse.R script-tel-quel.txt",
    "pwd > ou-suis-je.txt",
    "mkdir un-dossier",
    "ln -s /etc/passwd lien-vers-passwd",
    "echo cache > .fichier-cache",
  ].join("\n");
  const avant = new Date().toISOString();
  const r = await lancerAnalyse({ code, jeu, reglages:{ ANALYSIS_R: FAUX_INTERPRETEUR }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ex = r.body.execution;
  assert.equal(ex.statut, "ok", ex.erreur);
  assert.equal(ex.code, 0);
  assert.equal(ex.lignes, 2);

  assert.deepEqual(ex.fichiers.map(f => f.nom).sort(),
    ["copie-des-donnees.csv","ou-suis-je.txt","script-tel-quel.txt"],
    "ni le dossier, ni le lien symbolique, ni le fichier caché ne sont récupérés");
  assert.ok(ex.fichiers.every(f => f.octets > 0), "chaque fichier produit est annoncé avec sa taille");
  assert.ok(ex.fichiersEcartes.some(m => /lien-vers-passwd/.test(m)),
    "un lien symbolique posé par le script est écarté, et le dire est plus utile que le taire");
  assert.ok(ex.fichiersEcartes.some(m => /un-dossier/.test(m)));

  const csv = ex.fichiers.find(f => f.nom === "copie-des-donnees.csv");
  const tele = await request(app).get(csv.url).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(tele.status, 200);
  assert.match(tele.headers["content-disposition"], /attachment/,
    "un fichier produit ne se rend jamais dans la page : il se télécharge");
  const contenu = tele.text || tele.body.toString();
  assert.match(contenu, /^site,note,n$/m);
  assert.match(contenu, /"un guillemet "" et, une virgule"/, "le CSV échappe guillemets et virgules");

  /* Le code exécuté ne contient pas une seule valeur du jeu de données : elles
     ont voyagé par le fichier, jamais par le script. */
  const src = ex.fichiers.find(f => f.nom === "script-tel-quel.txt");
  const vu = await request(app).get(src.url).set("Authorization", `Bearer ${adminToken}`);
  assert.equal(vu.status, 200);
  const texteScript = vu.text || vu.body.toString();
  assert.ok(!/un guillemet|retour/.test(texteScript), "aucune donnée n'est interpolée dans le code");

  /* Le script lit son jeu de données par un chemin relatif : son répertoire
     courant est le bac de travail, il n'a aucune notion du disque du serveur. */
  const ou = ex.fichiers.find(f => f.nom === "ou-suis-je.txt");
  const pwd = await request(app).get(ou.url).set("Authorization", `Bearer ${adminToken}`);
  assert.match((pwd.text || pwd.body.toString()).trim(), /mems-analyse\/travail-/);

  assert.deepEqual(travauxRestants(), [], "le répertoire de travail ne survit pas à l'exécution");

  const trace = db.prepare(`SELECT * FROM audit WHERE entity='scripts' AND action='execute'
                            AND at >= ? ORDER BY at DESC, rowid DESC LIMIT 1`).get(avant.slice(0,19).replace("T"," "));
  assert.ok(trace, "toute exécution est journalisée");
  assert.equal(trace.kind, "securite");
  assert.equal(trace.user_id, db.prepare("SELECT id FROM users WHERE email='admin@test.local'").get().id);
  assert.match(trace.text, /exécuté sur le serveur/);
  assert.match(trace.text, /code de sortie 0/);
  assert.match(trace.text, / s —/, "la durée figure au journal");
  assert.match(trace.text, /3 fichier\(s\) produit\(s\)/);

  /* Ce qui n'est pas au manifeste n'existe pas : ni remontée d'arborescence, ni
     fichier écarté, ni exécution inconnue. */
  const base = `/api/scripts/executions/${ex.id}/fichiers`;
  for(const nom of ["..%2f..%2f..%2fetc%2fpasswd", "lien-vers-passwd", ".fichier-cache"]){
    const nok = await request(app).get(`${base}/${nom}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(nok.status, 404, nom);
  }
  assert.equal((await request(app).get(`/api/scripts/executions/exec_inconnu/fichiers/x.csv`)
    .set("Authorization", `Bearer ${adminToken}`)).status, 404);

  /* Les résultats appartiennent à qui a lancé l'analyse : un autre
     super-utilisateur ne les lit pas. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"super-deux@test.local", password:"SuperDeuxMdp2026", first_name:"Super",
            last_name:"Deux", role:"super", tabs:["home"], active:true });
  motDePasseAdopte("super-deux@test.local");
  const autre = (await login("super-deux@test.local", "SuperDeuxMdp2026")).body.token;
  assert.equal((await request(app).get(csv.url).set("Authorization", `Bearer ${autre}`)).status, 404);
});

test("scripts d'analyse : un jeu de données au-delà du plafond est refusé avant tout lancement", async () => {
  const jeu = creerJeu([{ a:1 },{ a:2 },{ a:3 }]);
  const r = await lancerAnalyse({ code:"echo bonjour", jeu, reglages:{
    ANALYSIS_R: FAUX_INTERPRETEUR, ANALYSIS_MAX_ROWS:"2" }});
  assert.equal(r.status, 413);
  assert.match(r.body.error, /3 lignes/);
});

test("scripts d'analyse : exécution réelle d'un script R", { skip: RSCRIPT ? false
  : "Rscript n'est pas installé sur cette machine : la chaîne R n'a pas pu être éprouvée" }, async () => {
  const jeu = creerJeu([
    { site:"A", n:1 }, { site:"A", n:3 }, { site:"B", n:5 },
  ]);
  const code = [
    'donnees <- read.csv("donnees.csv", stringsAsFactors = FALSE)',
    'cat("lignes:", nrow(donnees), "\\n")',
    'cat("secret:[", Sys.getenv("JWT_SECRET"), "]\\n", sep = "")',
    'resume <- aggregate(n ~ site, data = donnees, FUN = sum)',
    'print(resume)',
    'write.csv(resume, "resultats.csv", row.names = FALSE)',
    'pdf("graphique.pdf"); plot(donnees$n); invisible(dev.off())',
  ].join("\n");
  const r = await lancerAnalyse({ code, jeu, reglages:{ ANALYSIS_R: RSCRIPT }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ex = r.body.execution;
  assert.equal(ex.statut, "ok", `${ex.erreur}\n${ex.sortie}`);
  assert.equal(ex.code, 0);
  assert.match(ex.moteur, /Rscript/);
  assert.match(ex.sortie, /lignes: 3/);
  assert.match(ex.sortie, /secret:\[\]/, "R non plus ne voit le secret de signature");
  assert.deepEqual(ex.fichiers.map(f => f.nom).sort(), ["graphique.pdf","resultats.csv"]);

  const res = await request(app).get(ex.fichiers.find(f => f.nom === "resultats.csv").url)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(res.status, 200);
  const csv = res.text || res.body.toString();
  assert.match(csv, /"A",4/);
  assert.match(csv, /"B",5/);
  assert.deepEqual(travauxRestants(), []);
});

test("scripts d'analyse : exécution réelle d'un script SPSS", { skip: PSPP ? false
  : "pspp n'est pas installé sur cette machine : la chaîne SPSS n'a pas pu être éprouvée" }, async () => {
  const jeu = creerJeu([{ site:"A", n:1 }, { site:"B", n:3 }, { site:"C", n:5 }]);
  const code = [
    "GET DATA /TYPE=TXT /FILE='donnees.csv' /DELIMITERS=\",\" /FIRSTCASE=2",
    "  /VARIABLES=site A8 n F8.0.",
    "DESCRIPTIVES VARIABLES=n.",
    "SAVE TRANSLATE /OUTFILE='resultats.csv' /TYPE=CSV /REPLACE.",
  ].join("\n");
  const r = await lancerAnalyse({ code, lang:"SPSS", jeu, reglages:{ ANALYSIS_SPSS: PSPP }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ex = r.body.execution;
  assert.equal(ex.statut, "ok", `${ex.erreur}\n${ex.sortie}`);
  assert.match(ex.moteur, /pspp/);
  assert.match(ex.sortie, /Mean|Moyenne/);
  assert.ok(ex.fichiers.some(f => f.nom === "resultats.csv"),
    `pspp devait produire resultats.csv, fichiers : ${JSON.stringify(ex.fichiers)}`);
  assert.deepEqual(travauxRestants(), []);
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMINISTRATION DE L'INSTANCE — ce qui sépare `super` de `admin`

   Jusqu'ici la matrice CAPS (lib/auth.js) donnait à `super` et à `admin`
   exactement les mêmes quatre capacités : le rôle `super` existait sans rien
   apporter. Ce qui suit lui donne un contenu — non pas « plus de droits sur
   les mêmes objets », mais un objet différent : l'instance elle-même.

   Les tests ci-dessous éprouvent quatre familles de routes et, pour chacune,
   les trois mêmes questions : un administrateur non super est-il refusé, la
   trace est-elle écrite, et un secret peut-il sortir.

   ═══════════════════════════════════════════════════════════════════════════ */

const ADMIN = "/api/admin";
const { dossierSauvegardes } = await import("../src/lib/sauvegarde.js");
const verrou = await import("../src/lib/sauvegarde.js");
const { default: SQLite } = await import("better-sqlite3");
const { encrypt } = await import("../src/lib/crypto.js");

/* Le `jti` est dans la charge utile du jeton : le lire évite de deviner
   quelle ligne de `sessions` correspond à quelle connexion quand plusieurs
   tombent dans la même seconde. */
const jtiDe = (jeton) =>
  JSON.parse(Buffer.from(jeton.split(".")[1], "base64url").toString()).jti;

const superId = () => db.prepare("SELECT id FROM users WHERE email='admin@test.local'").get().id;
const auSuper = (r) => r.set("Authorization", `Bearer ${adminToken}`);

after(() => fs.rmSync(dossierSauvegardes(), { recursive:true, force:true }));

test("instance : un administrateur non super est refusé sur CHACUNE des routes", async () => {
  const r = await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"admin-instance@test.local", password:"AdminInstanceMotDePasse1",
            first_name:"Admin", last_name:"Simple", role:"admin", tabs:["home"], active:true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  motDePasseAdopte("admin-instance@test.local");
  const t = (await login("admin-instance@test.local", "AdminInstanceMotDePasse1")).body.token;
  const lui = db.prepare("SELECT id FROM users WHERE email='admin-instance@test.local'").get().id;

  /* Il est bien administrateur au sens de la matrice : la gestion des comptes,
     des bureaux et des référentiels lui reste ouverte. C'est ce qui donne son
     sens au reste du test — ce n'est pas un compte diminué. */
  assert.equal((await request(app).get("/api/users")
    .set("Authorization", `Bearer ${t}`)).status, 200);
  assert.equal((await request(app).get("/api/offices")
    .set("Authorization", `Bearer ${t}`)).status, 200);

  const routes = [
    ["get",    `${ADMIN}/journal`],
    ["get",    `${ADMIN}/journal/facettes`],
    ["get",    `${ADMIN}/base`],
    ["post",   `${ADMIN}/base/checkpoint`],
    ["post",   `${ADMIN}/base/vacuum`],
    ["post",   `${ADMIN}/sauvegarde`],
    ["get",    `${ADMIN}/sauvegardes`],
    ["get",    `${ADMIN}/sauvegardes/quelconque.db`],
    ["get",    `${ADMIN}/sauvegardes/quelconque.db/controle`],
    ["delete", `${ADMIN}/sauvegardes/quelconque.db`],
    ["post",   `${ADMIN}/restauration`],
    ["post",   "/api/auth/sessions/purge"],
    ["delete", "/api/auth/sessions/sess_quelconque"],
    ["delete", `/api/auth/users/${lui}/sessions`],
  ];
  for(const [m, chemin] of routes){
    const rep = await request(app)[m](chemin).set("Authorization", `Bearer ${t}`)
      .send({ fichier:"x.db", confirmation:"RESTAURER" });
    assert.equal(rep.status, 403, `${m.toUpperCase()} ${chemin} doit être refusé`);
    assert.match(rep.body.error, /super/, `${m.toUpperCase()} ${chemin}`);
  }

  /* Le refus vaut aussi pour REGARDER les sessions d'autrui — fermer la
     session d'un tiers commence par savoir qu'elle existe. */
  for(const q of ["?tous=1", `?user_id=${superId()}`]){
    const rep = await request(app).get(`/api/auth/sessions${q}`)
      .set("Authorization", `Bearer ${t}`);
    assert.equal(rep.status, 403, `GET /api/auth/sessions${q}`);
  }
  /* Mais ses PROPRES sessions restent lisibles : la route existante n'est pas
     fermée au passage, elle est seulement complétée. */
  const miennes = await request(app).get("/api/auth/sessions")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(miennes.status, 200);
  assert.equal(miennes.body.portee, "compte");
  assert.ok(miennes.body.sessions.some(s => s.courante && s.active));

  /* Et le super, lui, passe partout : sans quoi le test ci-dessus prouverait
     seulement que les routes n'existent pas. */
  assert.equal((await auSuper(request(app).get(`${ADMIN}/base`))).status, 200);
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal`))).status, 200);
});

test("sessions : révoquer une session la rend inutilisable au prochain appel", async () => {
  const t = (await login("admin-instance@test.local", "AdminInstanceMotDePasse1")).body.token;
  const jti = jtiDe(t);
  assert.equal((await request(app).get("/api/auth/me")
    .set("Authorization", `Bearer ${t}`)).status, 200, "la session est vivante avant révocation");

  const cible = db.prepare("SELECT id FROM users WHERE email='admin-instance@test.local'").get().id;
  const vue = await auSuper(request(app).get(`/api/auth/sessions?user_id=${cible}`));
  assert.equal(vue.status, 200);
  assert.equal(vue.body.portee, "autre_compte");
  assert.ok(vue.body.sessions.some(s => s.id === jti && s.active));

  const rev = await auSuper(request(app).delete(`/api/auth/sessions/${jti}`));
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  assert.equal(rev.body.revoquee, jti);
  assert.equal(rev.body.courante, false);

  /* Le point de bascule : le porteur du jeton n'obtient plus rien. Le jeton
     JWT est pourtant toujours valide et non expiré — c'est bien la session en
     base qui décide, comme le veut lib/auth.js. */
  assert.equal((await request(app).get("/api/auth/me")
    .set("Authorization", `Bearer ${t}`)).status, 401);
  assert.equal((await request(app).get("/api/state")
    .set("Authorization", `Bearer ${t}`)).status, 401);

  const trace = db.prepare(
    "SELECT * FROM audit WHERE entity='sessions' AND action='revoke' AND entity_id=?").get(jti);
  assert.ok(trace, "la révocation est journalisée");
  assert.equal(trace.kind, "securite");
  assert.match(trace.text, /admin-instance@test\.local/);

  /* Rejouer ne casse rien et ne ment pas : l'état voulu est déjà atteint. */
  const encore = await auSuper(request(app).delete(`/api/auth/sessions/${jti}`));
  assert.equal(encore.status, 200);
  assert.equal(encore.body.deja_revoquee, true);

  assert.equal((await auSuper(request(app).delete("/api/auth/sessions/sess_inexistante"))).status, 404);
});

test("sessions : révocation en masse, et la protection de sa propre session", async () => {
  const r = await auSuper(request(app).post("/api/users"))
    .send({ email:"super2@test.local", password:"SecondSuperMotDePasse1", first_name:"Second",
            last_name:"Super", role:"super", tabs:["home"], active:true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  motDePasseAdopte("super2@test.local");
  const moi = db.prepare("SELECT id FROM users WHERE email='super2@test.local'").get().id;

  const a = (await login("super2@test.local", "SecondSuperMotDePasse1")).body.token;
  const b = (await login("super2@test.local", "SecondSuperMotDePasse1")).body.token;
  const c = (await login("super2@test.local", "SecondSuperMotDePasse1")).body.token;
  const commeA = (req) => req.set("Authorization", `Bearer ${a}`);

  /* ── Refus par défaut de se couper soi-même en désignant sa session ── */
  const refus = await commeA(request(app).delete(`/api/auth/sessions/${jtiDe(a)}`));
  assert.equal(refus.status, 409);
  assert.equal(refus.body.courante, true);
  assert.match(refus.body.error, /confirmer=1/);
  assert.equal((await commeA(request(app).get("/api/auth/me"))).status, 200,
    "le refus n'a évidemment rien révoqué");

  /* ── Révocation en masse : la session courante est préservée par défaut ── */
  const masse = await commeA(request(app).delete(`/api/auth/users/${moi}/sessions`));
  assert.equal(masse.status, 200, JSON.stringify(masse.body));
  assert.equal(masse.body.courante_preservee, true);
  assert.equal(masse.body.courante_revoquee, false);
  assert.equal(masse.body.revoquees, 2, "b et c fermées, a conservée");
  for(const mort of [b, c])
    assert.equal((await request(app).get("/api/auth/me")
      .set("Authorization", `Bearer ${mort}`)).status, 401);
  assert.equal((await commeA(request(app).get("/api/auth/me"))).status, 200,
    "celle qui a lancé l'opération fonctionne encore");
  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE entity='sessions' AND action='revoke_all'
                        AND entity_id=?`).get(moi), "la révocation en masse est journalisée");

  /* ── Et l'inclusion explicite, qui elle coupe bien l'appelant ── */
  const tout = await commeA(request(app).delete(`/api/auth/users/${moi}/sessions?inclure_courante=1`));
  assert.equal(tout.status, 200);
  assert.equal(tout.body.courante_revoquee, true);
  assert.equal(tout.body.courante_preservee, false);
  assert.equal((await commeA(request(app).get("/api/auth/me"))).status, 401,
    "la réponse est arrivée, le coup d'après non — c'est ce qui était annoncé");

  /* ── La confirmation explicite sur une session désignée ── */
  const d = (await login("super2@test.local", "SecondSuperMotDePasse1")).body.token;
  const suicide = await request(app).delete(`/api/auth/sessions/${jtiDe(d)}?confirmer=1`)
    .set("Authorization", `Bearer ${d}`);
  assert.equal(suicide.status, 200, JSON.stringify(suicide.body));
  assert.equal(suicide.body.courante, true);
  assert.equal((await request(app).get("/api/auth/me")
    .set("Authorization", `Bearer ${d}`)).status, 401);

  assert.equal((await auSuper(request(app).delete("/api/auth/users/user_inconnu/sessions"))).status, 404);
});

test("sessions : la purge efface les sessions closes et n'effleure pas les vivantes", async () => {
  const moi = superId();
  const monJti = jtiDe(adminToken);
  db.prepare(`INSERT INTO sessions (id,user_id,issued_at,expires_at,revoked)
              VALUES ('sess_expiree_essai',?,datetime('now','-9 hours'),datetime('now','-1 hour'),0)`).run(moi);
  db.prepare(`INSERT INTO sessions (id,user_id,issued_at,expires_at,revoked)
              VALUES ('sess_revoquee_essai',?,datetime('now'),datetime('now','+8 hours'),1)`).run(moi);
  /* Une session close mais RÉCENTE, pour éprouver la fenêtre de conservation. */
  db.prepare(`INSERT INTO sessions (id,user_id,issued_at,expires_at,revoked)
              VALUES ('sess_recente_close',?,datetime('now'),datetime('now','-1 minute'),0)`).run(moi);

  /* Avec une fenêtre de trente jours, rien de ce qui a été émis aujourd'hui ne
     part — pas même ce qui est déjà mort. */
  const menagee = await auSuper(request(app).post("/api/auth/sessions/purge?jours=30"));
  assert.equal(menagee.status, 200, JSON.stringify(menagee.body));
  assert.equal(menagee.body.supprimees, 0);
  assert.ok(db.prepare("SELECT 1 FROM sessions WHERE id='sess_recente_close'").get());

  const avant = db.prepare("SELECT COUNT(*) c FROM sessions").get().c;
  const vivantesAvant = db.prepare(
    "SELECT id FROM sessions WHERE revoked=0 AND expires_at > datetime('now')").all().map(s => s.id);
  assert.ok(vivantesAvant.includes(monJti), "la session du super est bien vivante avant la purge");

  const purge = await auSuper(request(app).post("/api/auth/sessions/purge"));
  assert.equal(purge.status, 200, JSON.stringify(purge.body));
  assert.equal(purge.body.avant, avant);
  assert.ok(purge.body.supprimees >= 3);

  for(const morte of ["sess_expiree_essai", "sess_revoquee_essai", "sess_recente_close"])
    assert.equal(db.prepare("SELECT 1 FROM sessions WHERE id=?").get(morte), undefined,
      `${morte} devait être purgée`);

  /* LE point du test : aucune session vivante n'a disparu, et celle qui a
     lancé la purge marche toujours. */
  const vivantesApres = db.prepare(
    "SELECT id FROM sessions WHERE revoked=0 AND expires_at > datetime('now')").all().map(s => s.id);
  assert.deepEqual(vivantesApres.sort(), vivantesAvant.sort());
  assert.equal(purge.body.restantes, vivantesAvant.length);
  assert.equal((await auSuper(request(app).get("/api/auth/me"))).status, 200);

  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE entity='sessions' AND action='purge'`).get(),
    "la purge est journalisée");
});

test("journal d'audit : filtres, période, recherche et pagination", async () => {
  /* Le genre `securite` est précisément celui que /api/state masque à tous
     (state.js, `kind<>'securite'`) : les connexions et les échecs de connexion
     n'étaient lisibles par personne. */
  const sec = await auSuper(request(app).get(`${ADMIN}/journal?kind=securite&taille=5`));
  assert.equal(sec.status, 200);
  assert.ok(sec.body.total > 5, `journal de sécurité trop court : ${sec.body.total}`);
  assert.equal(sec.body.lignes.length, 5);
  assert.ok(sec.body.lignes.every(l => l.kind === "securite"));
  assert.equal(sec.body.pages, Math.ceil(sec.body.total / 5));

  /* Pagination : la page 2 n'est pas la page 1, et les deux tiennent dans le
     total annoncé. */
  const p2 = await auSuper(request(app).get(`${ADMIN}/journal?kind=securite&taille=5&page=2`));
  assert.equal(p2.body.total, sec.body.total);
  assert.equal(p2.body.page, 2);
  const idsP1 = sec.body.lignes.map(l => l.id);
  assert.ok(p2.body.lignes.every(l => !idsP1.includes(l.id)), "aucun recouvrement entre les pages");

  const echecs = await auSuper(request(app).get(`${ADMIN}/journal?action=login_failed`));
  assert.ok(echecs.body.total > 0);
  assert.ok(echecs.body.lignes.every(l => l.action === "login_failed"));

  const parEntite = await auSuper(request(app).get(`${ADMIN}/journal?entity=sites`));
  assert.ok(parEntite.body.total > 0);
  assert.ok(parEntite.body.lignes.every(l => l.entity === "sites"));

  const moi = superId();
  const parCompte = await auSuper(request(app).get(`${ADMIN}/journal?user_id=${moi}`));
  assert.ok(parCompte.body.total > 0);
  assert.ok(parCompte.body.lignes.every(l => l.user_id === moi));

  /* Combinaison de filtres : le total ne peut que se resserrer. */
  const croise = await auSuper(request(app)
    .get(`${ADMIN}/journal?user_id=${moi}&kind=securite&entity=sessions`));
  assert.ok(croise.body.total > 0);
  assert.ok(croise.body.total <= parCompte.body.total);
  assert.ok(croise.body.lignes.every(l =>
    l.user_id === moi && l.kind === "securite" && l.entity === "sessions"));

  /* Période. `at` est écrit par datetime('now'), donc en UTC : la borne se
     compare à une date UTC. Une date seule doit couvrir la journée entière —
     c'est le piège que la borne haute complétée à 23:59:59 évite. */
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const duJour = await auSuper(request(app)
    .get(`${ADMIN}/journal?depuis=${aujourdhui}&jusqu_a=${aujourdhui}`));
  assert.ok(duJour.body.total > 0, "les traces du jour doivent être dans l'intervalle du jour");
  const total = (await auSuper(request(app).get(`${ADMIN}/journal`))).body.total;
  assert.equal(duJour.body.total, total, "tout le journal de ce test date d'aujourd'hui");
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?depuis=2099-01-01`))).body.total, 0);
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?jusqu_a=2000-01-01`))).body.total, 0);

  /* Recherche libre sur le libellé, jokers LIKE neutralisés : « %_% » ne doit
     pas ramener tout le journal. */
  const texte = await auSuper(request(app).get(`${ADMIN}/journal?q=Connexion`));
  assert.ok(texte.body.total > 0);
  assert.ok(texte.body.lignes.every(l => /Connexion/i.test(l.text)));
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?q=%25`))).body.total, 0,
    "« % » est cherché comme un caractère, pas comme un joker");

  /* Entrées invalides : refusées, pas silencieusement ignorées. */
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?depuis=hier`))).status, 422);
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?taille=5000`))).status, 422);
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?page=0`))).status, 422);
  assert.equal((await auSuper(request(app).get(`${ADMIN}/journal?filtre_invente=1`))).status, 422);

  const f = await auSuper(request(app).get(`${ADMIN}/journal/facettes`));
  assert.equal(f.status, 200);
  assert.ok(f.body.kinds.some(k => k.v === "securite"));
  assert.ok(f.body.actions.some(a => a.v === "login"));
  assert.ok(f.body.comptes.some(c => c.user_id === moi));
  assert.ok(f.body.bornes.premier <= f.body.bornes.dernier);
});

test("santé de la base : état complet, entretien mesuré, et pas deux à la fois", async () => {
  const b = await auSuper(request(app).get(`${ADMIN}/base`));
  assert.equal(b.status, 200);
  assert.equal(b.body.integrite.integrity_check, "ok");
  assert.equal(b.body.integrite.violations_cles_etrangeres, 0);
  assert.equal(b.body.integrite.conforme, true);
  assert.ok(b.body.fichier.principal > 0, "la taille du fichier est rapportée");
  assert.equal(b.body.reglages.journal_mode, "wal");
  assert.ok(b.body.tables.length >= 45);
  assert.equal(b.body.tables.find(t => t.nom === "users").lignes,
               db.prepare("SELECT COUNT(*) c FROM users").get().c);
  assert.ok(b.body.migrations.length >= 18);
  assert.ok(b.body.migrations.every(m => m.name.endsWith(".sql") && m.applied_at));
  assert.equal(b.body.entretien_en_cours, null);

  /* Les deux entretiens : ils bloquent, ils disent combien de temps. */
  const ck = await auSuper(request(app).post(`${ADMIN}/base/checkpoint`));
  assert.equal(ck.status, 200, JSON.stringify(ck.body));
  assert.equal(typeof ck.body.ms, "number");
  assert.ok(ck.body.resultat && typeof ck.body.resultat.busy === "number");
  assert.ok(ck.body.avant && ck.body.apres);

  const vac = await auSuper(request(app).post(`${ADMIN}/base/vacuum`));
  assert.equal(vac.status, 200, JSON.stringify(vac.body));
  assert.equal(typeof vac.body.ms, "number");
  assert.equal(typeof vac.body.gain, "number");

  /* La base sort indemne des deux opérations — c'est la seule chose qui
     compte vraiment quand on réécrit un fichier de production. */
  const apres = await auSuper(request(app).get(`${ADMIN}/base`));
  assert.equal(apres.body.integrite.conforme, true);
  assert.equal(apres.body.tables.find(t => t.nom === "users").lignes,
               b.body.tables.find(t => t.nom === "users").lignes);

  for(const action of ["checkpoint", "vacuum"])
    assert.ok(db.prepare("SELECT 1 FROM audit WHERE entity='base' AND action=?").get(action),
      `${action} est journalisé`);

  /* ── Deux entretiens en parallèle : refusés ──
     On prend le verrou à la main plutôt que de lancer deux requêtes et
     d'espérer qu'elles se croisent : better-sqlite3 étant synchrone, un
     VACUUM ne rend jamais la main en cours de route et le croisement ne
     serait pas reproductible. La sauvegarde, elle, rend la main — c'est
     exactement pour ce cas que le verrou existe. */
  assert.equal(verrou.prendreVerrou("essai", "test"), true);
  assert.equal(verrou.prendreVerrou("second essai", "test"), false,
    "le verrou ne se prend pas deux fois");
  try{
    for(const [m, chemin] of [["post", `${ADMIN}/base/checkpoint`],
                              ["post", `${ADMIN}/base/vacuum`],
                              ["post", `${ADMIN}/sauvegarde`]]){
      const rep = await auSuper(request(app)[m](chemin));
      assert.equal(rep.status, 409, `${chemin} pendant un entretien`);
      assert.match(rep.body.error, /en cours/);
      assert.equal(rep.body.entretien_en_cours.operation, "essai");
    }
    const pendant = await auSuper(request(app).get(`${ADMIN}/base`));
    assert.equal(pendant.body.entretien_en_cours.operation, "essai");
  }finally{ verrou.rendreVerrou(); }

  assert.equal((await auSuper(request(app).post(`${ADMIN}/base/checkpoint`))).status, 200,
    "le verrou rendu, l'entretien repasse");
});

test("sauvegarde : fichier SQLite valide, relisible, téléchargeable et tracé", async () => {
  const cree = await auSuper(request(app).post(`${ADMIN}/sauvegarde`));
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  const s = cree.body.sauvegarde;
  assert.match(s.nom, /^mems-\d{14}-[0-9A-Z]{4}\.db$/);
  assert.equal(s.integrite, "ok");
  assert.ok(s.octets > 0 && s.pages > 0);
  assert.equal(typeof s.ms, "number");

  /* Le cœur de l'exigence : le fichier produit est une base SQLite qu'on
     rouvre, qui passe integrity_check, et qui contient bien les données. Une
     copie à chaud du fichier en mode WAL échouerait ici. */
  const chemin = path.join(dossierSauvegardes(), s.nom);
  assert.ok(fs.existsSync(chemin));
  const copie = new SQLite(chemin, { readonly:true, fileMustExist:true });
  try{
    assert.equal(copie.pragma("integrity_check", { simple:true }), "ok");
    assert.equal(copie.pragma("foreign_key_check").length, 0);
    for(const t of ["users", "sites", "sessions", "_migrations"])
      assert.equal(copie.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c,
                   db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c,
                   `la table ${t} doit être copiée intégralement`);
    /* `audit` est comparée à part : la trace de la sauvegarde elle-même est
       écrite APRÈS la copie, la base vivante a donc une ligne d'avance. C'est
       le comportement voulu — une sauvegarde ne peut pas contenir le récit de
       sa propre création. */
    const dansCopie = copie.prepare("SELECT COUNT(*) c FROM audit").get().c;
    const vivante = db.prepare("SELECT COUNT(*) c FROM audit").get().c;
    assert.ok(dansCopie > 0 && dansCopie === vivante - 1,
      `journal copié : ${dansCopie} lignes contre ${vivante} en base`);
    assert.ok(copie.prepare("SELECT 1 FROM sites LIMIT 1").get(), "la sauvegarde n'est pas vide");
  }finally{ copie.close(); }

  const liste = await auSuper(request(app).get(`${ADMIN}/sauvegardes`));
  assert.equal(liste.status, 200);
  assert.ok(liste.body.sauvegardes.some(x => x.nom === s.nom && x.octets === s.octets));

  const ctrl = await auSuper(request(app).get(`${ADMIN}/sauvegardes/${s.nom}/controle`));
  assert.equal(ctrl.body.controle.lisible, true);
  assert.equal(ctrl.body.controle.violations, 0);
  assert.ok(ctrl.body.controle.tables >= 45);

  /* Téléchargeable, et ce qui sort est octet pour octet le fichier vérifié. */
  const dl = await auSuper(request(app).get(`${ADMIN}/sauvegardes/${s.nom}`));
  assert.equal(dl.status, 200);
  assert.match(dl.headers["content-disposition"], new RegExp(s.nom));
  assert.ok(Buffer.isBuffer(dl.body));
  assert.equal(dl.body.length, fs.statSync(chemin).size);
  const recu = path.join(dossierSauvegardes(), "recu-par-http.db");
  fs.writeFileSync(recu, dl.body);
  const relu = new SQLite(recu, { readonly:true, fileMustExist:true });
  try{
    assert.equal(relu.pragma("integrity_check", { simple:true }), "ok",
      "le fichier tel qu'il sort par HTTP est une base SQLite valide");
    assert.equal(relu.prepare("SELECT COUNT(*) c FROM users").get().c,
                 db.prepare("SELECT COUNT(*) c FROM users").get().c);
  }finally{ relu.close(); fs.unlinkSync(recu); }

  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE entity='base' AND action='sauvegarde'
                        AND entity_id=?`).get(s.nom), "la création est journalisée");
  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE entity='base' AND action='telechargement'
                        AND entity_id=?`).get(s.nom), "le téléchargement est journalisé");

  /* Un nom venu du client ne construit jamais un chemin : ni remontée, ni
     chemin absolu, ni fichier hors du dossier des sauvegardes. */
  for(const mauvais of ["..%2F..%2Fdata%2Ftest.db", "%2Fetc%2Fpasswd",
                        "..%2Fmems.db", "sauvegarde.txt", "..%2E%2Fx.db"]){
    const rep = await auSuper(request(app).get(`${ADMIN}/sauvegardes/${mauvais}`));
    assert.equal(rep.status, 404, `téléchargement de « ${mauvais} » doit être refusé`);
  }
  assert.ok(fs.existsSync(path.resolve("./data/test.db")), "la base d'essai est toujours là");

  const jetable = (await auSuper(request(app).post(`${ADMIN}/sauvegarde`))).body.sauvegarde.nom;
  const sup = await auSuper(request(app).delete(`${ADMIN}/sauvegardes/${jetable}`));
  assert.equal(sup.status, 200);
  assert.ok(!fs.existsSync(path.join(dossierSauvegardes(), jetable)));
  assert.equal((await auSuper(request(app).delete(`${ADMIN}/sauvegardes/${jetable}`))).status, 404);
  assert.ok(db.prepare(`SELECT 1 FROM audit WHERE action='suppression_sauvegarde'
                        AND entity_id=?`).get(jetable));
});

test("administration : aucune route ne laisse sortir un secret", async () => {
  /* On plante des secrets reconnaissables, pour que l'absence de fuite ne soit
     pas due à l'absence de donnée. */
  const EN_CLAIR = "JETON-ODK-SECRET-A-NE-JAMAIS-SORTIR";
  const chiffre = encrypt(EN_CLAIR);
  db.prepare(`INSERT INTO odk_forms (id,name,form_id,project,token_enc,kind)
              VALUES ('odkf_secret','Formulaire témoin','F_TEMOIN','P1',?,'process')`).run(chiffre);
  const empreinte = db.prepare("SELECT pw_hash FROM users WHERE email='admin@test.local'").get().pw_hash;
  assert.ok(empreinte?.startsWith("$2"), "le témoin est bien une empreinte bcrypt");
  assert.equal(db.prepare("SELECT token_enc FROM odk_forms WHERE id='odkf_secret'").get().token_enc,
               chiffre, "le témoin chiffré est bien en base");

  const s = (await auSuper(request(app).post(`${ADMIN}/sauvegarde`))).body.sauvegarde;
  const reponses = [];
  for(const chemin of [`${ADMIN}/base`, `${ADMIN}/journal?taille=200`, `${ADMIN}/journal/facettes`,
                       `${ADMIN}/sauvegardes`, `${ADMIN}/sauvegardes/${s.nom}/controle`,
                       "/api/auth/sessions?tous=1", "/api/auth/sessions"]){
    const r = await auSuper(request(app).get(chemin));
    assert.equal(r.status, 200, chemin);
    reponses.push([chemin, JSON.stringify(r.body)]);
  }
  reponses.push(["checkpoint",
    JSON.stringify((await auSuper(request(app).post(`${ADMIN}/base/checkpoint`))).body)]);
  reponses.push(["purge",
    JSON.stringify((await auSuper(request(app).post("/api/auth/sessions/purge?jours=3650"))).body)]);

  /* Les deux épreuves de connexion entrent dans le même balayage : ce sont les
     seules routes qui DÉCHIFFRENT un secret pour s'en servir et rendent ensuite
     un diagnostic. Une garantie « aucune route ne laisse sortir un secret » qui
     ne couvrirait pas les nouvelles routes ne garantirait plus grand-chose.
     Le connecteur témoin porte le même secret en clair que la source ODK, pour
     que la recherche ci-dessous cherche quelque chose qui existe. */
  const temoinConn = (await auSuper(request(app).post("/api/connectors"))
    .send({ name: "Connecteur témoin", kind: "http", base_url: "https://exemple.invalide",
            config: { chemin: "/x" }, auth_schema: "porteur", secret: EN_CLAIR })).body.connector;
  reponses.push(["épreuve ODK",
    JSON.stringify((await auSuper(request(app).post("/api/odk-forms/odkf_secret/test"))).body)]);
  reponses.push(["épreuve connecteur",
    JSON.stringify((await auSuper(request(app).post(`/api/connectors/${temoinConn.id}/test`))).body)]);
  reponses.push(["liste des connecteurs",
    JSON.stringify((await auSuper(request(app).get("/api/connectors"))).body)]);

  for(const [chemin, corps] of reponses){
    for(const interdit of [EN_CLAIR, chiffre, empreinte, "MotDePasseTest2026",
                           "SecondSuperMotDePasse1", "AdminInstanceMotDePasse1"])
      assert.ok(!corps.includes(interdit), `${chemin} laisse sortir un secret`);
    /* On cherche des CLÉS JSON, pas des sous-chaînes : `password_change` est un
       nom d'action légitime du journal, et le confondre avec une fuite ferait
       échouer le test pour une bonne raison — ce qui revient à ne plus rien
       garantir du tout. */
    for(const cle of ['"pw_hash"', '"token_enc"', '"secret_enc"', '"password"', '"token"'])
      assert.ok(!corps.includes(cle), `${chemin} expose le champ ${cle}`);
  }

  /* Le fichier de sauvegarde, lui, contient bien ces colonnes — c'est la base.
     Ce qui compte est qu'il n'y ait RIEN EN CLAIR : bcrypt d'un côté, AES-GCM
     de l'autre, et la clé de déchiffrement dans l'environnement, jamais dans
     le fichier. Un sauvegarde volée ne rend pas un jeton ODK. */
  const octets = fs.readFileSync(path.join(dossierSauvegardes(), s.nom));
  assert.ok(!octets.includes(Buffer.from(EN_CLAIR)),
    "le jeton en clair ne doit apparaître nulle part dans la sauvegarde");
  assert.ok(!octets.includes(Buffer.from("MotDePasseTest2026")),
    "aucun mot de passe en clair dans la sauvegarde");
  assert.ok(octets.includes(Buffer.from(chiffre)), "le chiffré, lui, est bien sauvegardé");
  assert.ok(octets.includes(Buffer.from(empreinte)), "l'empreinte bcrypt aussi");
  /* Ce sont les VALEURS des clés qu'on cherche, pas leurs noms : « DATA_KEY »
     apparaît légitimement dans du code de script stocké en base, et confondre
     les deux ferait échouer le test sans rien prouver. Si ces deux valeurs sont
     absentes du fichier, alors une sauvegarde volée ne déchiffre rien et ne
     signe aucun jeton — c'est toute la garantie. */
  for(const cle of [process.env.DATA_KEY, process.env.JWT_SECRET])
    assert.ok(!octets.includes(Buffer.from(cle)),
      "les clés vivent dans l'environnement, jamais dans la base");

  db.prepare("DELETE FROM odk_forms WHERE id='odkf_secret'").run();
});

/* Ce test doit rester le DERNIER du fichier : il ramène la base à l'état
   qu'elle avait quelques lignes plus haut. Tout ce qui a été créé avant la
   sauvegarde y est — donc rien de ce que les tests précédents ont vérifié
   n'est perdu — mais ce qui naîtrait après lui serait effacé. */
test("restauration : confirmation exigée, filet automatique, et retour exact", async () => {
  const s = (await auSuper(request(app).post(`${ADMIN}/sauvegarde`))).body.sauvegarde;

  /* Un changement postérieur à la sauvegarde : c'est lui qui prouvera que la
     restauration a réellement remplacé le contenu. */
  const cree = await auSuper(request(app).post("/api/sites"))
    .send({ code:"TEMOIN-RESTAURATION", name:"Site témoin de restauration", status:"Active" });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  const temoin = cree.body.site.id;
  assert.ok(db.prepare("SELECT 1 FROM sites WHERE id=?").get(temoin));

  /* ── Ce qui est refusé ── */
  const sansMot = await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:s.nom, confirmation:"oui" });
  assert.equal(sansMot.status, 422);
  assert.match(sansMot.body.error, /RESTAURER/);
  assert.equal((await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:s.nom })).status, 422, "la confirmation est un champ requis");
  assert.equal((await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:"inexistante.db", confirmation:"RESTAURER" })).status, 404);
  assert.equal((await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:"../test.db", confirmation:"RESTAURER" })).status, 404);
  assert.ok(db.prepare("SELECT 1 FROM sites WHERE id=?").get(temoin),
    "aucun refus n'a touché à la base");

  /* Un fichier qui n'est pas une base : refusé à la relecture, pas à mi-course. */
  fs.writeFileSync(path.join(dossierSauvegardes(), "pas-une-base.db"), "bonjour");
  const pasUneBase = await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:"pas-une-base.db", confirmation:"RESTAURER" });
  assert.equal(pasUneBase.status, 422);
  assert.match(pasUneBase.body.error, /inexploitable|illisible/);

  /* Une sauvegarde d'un autre niveau de schéma : refusée AVANT de commencer,
     parce qu'un « INSERT … SELECT * » entre schémas divergents écrirait dans
     les mauvaises colonnes. */
  const autreNiveau = path.join(dossierSauvegardes(), "autre-niveau.db");
  fs.copyFileSync(path.join(dossierSauvegardes(), s.nom), autreNiveau);
  const bricole = new SQLite(autreNiveau);
  bricole.prepare("DELETE FROM _migrations WHERE name=(SELECT MAX(name) FROM _migrations)").run();
  bricole.close();
  const divergente = await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:"autre-niveau.db", confirmation:"RESTAURER" });
  assert.equal(divergente.status, 422);
  assert.match(divergente.body.error, /migration/);
  assert.ok(db.prepare("SELECT 1 FROM sites WHERE id=?").get(temoin),
    "un refus de schéma ne laisse aucune trace sur la base");

  /* ── La restauration elle-même ── */
  const avant = (await auSuper(request(app).get(`${ADMIN}/sauvegardes`))).body.sauvegardes.length;
  const r = await auSuper(request(app).post(`${ADMIN}/restauration`))
    .send({ fichier:s.nom, confirmation:"RESTAURER" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.restaure, s.nom);
  assert.equal(r.body.apres.integrite, "ok");
  assert.equal(r.body.apres.violations, 0);
  assert.ok(r.body.tables >= 45);

  /* Le filet : une sauvegarde de l'état d'AVANT a été prise toute seule, et
     elle est exploitable — sans quoi restaurer le mauvais fichier serait sans
     retour. */
  assert.ok(r.body.sauvegarde_prealable, "une sauvegarde préalable est obligatoire");
  const filet = path.join(dossierSauvegardes(), r.body.sauvegarde_prealable);
  assert.ok(fs.existsSync(filet));
  const relu = new SQLite(filet, { readonly:true, fileMustExist:true });
  try{
    assert.equal(relu.pragma("integrity_check", { simple:true }), "ok");
    assert.ok(relu.prepare("SELECT 1 FROM sites WHERE id=?").get(temoin),
      "le filet contient bien l'état d'avant, témoin compris");
  }finally{ relu.close(); }
  assert.equal((await auSuper(request(app).get(`${ADMIN}/sauvegardes`))).body.sauvegardes.length,
    avant + 1, "exactement une sauvegarde de plus : le filet");

  /* La preuve que le contenu a bien été remplacé. */
  assert.equal(db.prepare("SELECT 1 FROM sites WHERE id=?").get(temoin), undefined,
    "le site créé après la sauvegarde a disparu avec la restauration");
  assert.equal((await auSuper(request(app).get(`/api/sites/${temoin}`))).status, 404);

  /* La trace est écrite APRÈS le remplacement — écrite avant, elle aurait été
     effacée par la restauration, la table `audit` étant elle aussi remplacée. */
  const trace = db.prepare(
    "SELECT * FROM audit WHERE entity='base' AND action='restauration'").get();
  assert.ok(trace, "la restauration est journalisée et la trace survit à la restauration");
  assert.equal(trace.kind, "securite");
  assert.ok(trace.text.includes(s.nom) && trace.text.includes(r.body.sauvegarde_prealable));

  /* La session de l'appelant figurait dans la sauvegarde : elle survit, et
     c'est annoncé. La base reste intègre et pleinement utilisable. */
  assert.equal(r.body.session_toujours_valide, true);
  assert.equal(r.body.compte_toujours_present, true);
  assert.equal(r.body.avertissement, null);
  assert.equal((await auSuper(request(app).get("/api/auth/me"))).status, 200);
  const sante = await auSuper(request(app).get(`${ADMIN}/base`));
  assert.equal(sante.body.integrite.conforme, true);
  assert.ok(sante.body.tables.find(t => t.nom === "users").lignes > 0);
  assert.equal((await auSuper(request(app).get("/api/state"))).status, 200,
    "l'application fonctionne normalement après la restauration");
});

/* ═══════════════════════════════════════════════════════════════════════
   Téléversement d'un shapefile.

   Le découpage de démonstration porte des p-codes synthétiques ; charger les
   vraies communes se fait en déposant le shapefile, que le SERVEUR lit — pas le
   navigateur. Ces tests forgent un shapefile minuscule OCTET PAR OCTET (c'est le
   format qu'on parse) plutôt que d'embarquer le vrai fichier de 23 Mo : deux ou
   trois polygones suffisent à éprouver le comportement.

   Ce qu'ils verrouillent : la lecture du type et des coordonnées, l'appariement
   .shp ↔ .dbf PAR ORDRE, le refus d'un type non polygone, la correspondance des
   colonnes comme vrai levier, le comptage des sites orphelins, et un commit qui
   crée un millésime courant avec ses contours. */

/* Une table attributaire .dbf : en-tête de 32 o + 32 o par champ, terminateur
   0x0D, puis une ligne par enregistrement préfixée d'un octet de suppression. */
function forgeDbf(champs, lignes){
  const rlen = 1 + champs.reduce((s, c) => s + c.len, 0);
  const hlen = 32 + 32 * champs.length + 1;
  const buf = Buffer.alloc(hlen + lignes.length * rlen + 1);
  buf[0] = 0x03;
  buf.writeUInt32LE(lignes.length, 4);
  buf.writeUInt16LE(hlen, 8);
  buf.writeUInt16LE(rlen, 10);
  let p = 32;
  for(const c of champs){
    buf.write(c.nom, p, "latin1");
    buf[p + 11] = (c.type || "C").charCodeAt(0);
    buf[p + 16] = c.len;
    p += 32;
  }
  buf[p] = 0x0D; p += 1;
  for(const row of lignes){
    buf[p] = 0x20; let c = p + 1;
    for(const f of champs){
      buf.fill(0x20, c, c + f.len);
      buf.write(String(row[f.nom] ?? "").slice(0, f.len), c, "utf8");
      c += f.len;
    }
    p += rlen;
  }
  buf[p] = 0x1A;
  return buf;
}

/* Un .shp : en-tête de 100 o (code fichier et longueur en gros-boutiste, type et
   emprise en petit-boutiste), puis un enregistrement polygone par forme. Chaque
   forme est une liste d'anneaux, chaque anneau une liste de [lon, lat]. */
function forgeShp(formes, { typeEntete = 5 } = {}){
  const recs = formes.map((anneaux, i) => {
    const numParts = anneaux.length;
    const numPoints = anneaux.reduce((s, r) => s + r.length, 0);
    const contenu = 4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints;
    const rec = Buffer.alloc(8 + contenu);
    rec.writeInt32BE(i + 1, 0);
    rec.writeInt32BE(contenu / 2, 4);
    const s = 8;
    rec.writeInt32LE(5, s);
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for(const r of anneaux) for(const [x, y] of r){
      if(x < xmin) xmin = x; if(x > xmax) xmax = x; if(y < ymin) ymin = y; if(y > ymax) ymax = y; }
    rec.writeDoubleLE(xmin, s + 4); rec.writeDoubleLE(ymin, s + 12);
    rec.writeDoubleLE(xmax, s + 20); rec.writeDoubleLE(ymax, s + 28);
    rec.writeInt32LE(numParts, s + 36);
    rec.writeInt32LE(numPoints, s + 40);
    let off = s + 44, acc = 0;
    for(const r of anneaux){ rec.writeInt32LE(acc, off); off += 4; acc += r.length; }
    for(const r of anneaux) for(const [x, y] of r){
      rec.writeDoubleLE(x, off); rec.writeDoubleLE(y, off + 8); off += 16; }
    return rec;
  });
  const corps = Buffer.concat(recs);
  const h = Buffer.alloc(100);
  h.writeInt32BE(9994, 0);
  h.writeInt32BE((100 + corps.length) / 2, 24);
  h.writeInt32LE(1000, 28);
  h.writeInt32LE(typeEntete, 32);
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for(const anneaux of formes) for(const r of anneaux) for(const [x, y] of r){
    if(x < xmin) xmin = x; if(x > xmax) xmax = x; if(y < ymin) ymin = y; if(y > ymax) ymax = y; }
  if(Number.isFinite(xmin)){
    h.writeDoubleLE(xmin, 36); h.writeDoubleLE(ymin, 44);
    h.writeDoubleLE(xmax, 52); h.writeDoubleLE(ymax, 60); }
  return Buffer.concat([h, corps]);
}

/* Un carré fermé, de côté 0,5°, à l'emplacement donné : de quoi distinguer trois
   communes par leur seule position. */
const carreSh = (lon, lat) => [[[lon, lat], [lon + 0.5, lat], [lon + 0.5, lat + 0.5],
  [lon, lat + 0.5], [lon, lat]]];

/* Trois communes COD-AB, dans l'ordre : Alpha en (46,-25), Beta en (47,-24),
   Gamma en (48,-23). L'ordre du .shp et celui du .dbf se correspondent. */
const CHAMPS_MDG = [
  { nom: "ADM1_PCODE", len: 10 }, { nom: "ADM1_EN", len: 12 },
  { nom: "ADM2_PCODE", len: 10 }, { nom: "ADM2_EN", len: 12 },
  { nom: "ADM3_PCODE", len: 10 }, { nom: "ADM3_EN", len: 12 },
];
const LIGNES_MDG = [
  { ADM1_PCODE:"MG53", ADM1_EN:"Anosy", ADM2_PCODE:"MG53519", ADM2_EN:"Amboasary", ADM3_PCODE:"MG0001", ADM3_EN:"Alpha" },
  { ADM1_PCODE:"MG53", ADM1_EN:"Anosy", ADM2_PCODE:"MG53519", ADM2_EN:"Amboasary", ADM3_PCODE:"MG0002", ADM3_EN:"Beta" },
  { ADM1_PCODE:"MG53", ADM1_EN:"Anosy", ADM2_PCODE:"MG53519", ADM2_EN:"Amboasary", ADM3_PCODE:"MG0003", ADM3_EN:"Gamma" },
];
const shpMdg = () => forgeShp([carreSh(46, -25), carreSh(47, -24), carreSh(48, -23)]);
const dbfMdg = () => forgeDbf(CHAMPS_MDG, LIGNES_MDG);

const apercuShp = (token, { shp, dbf, zip, mapping } = {}) => {
  let req = request(app).post("/api/geo/shapefile/apercu").set("Authorization", `Bearer ${token}`);
  if(zip) req = req.attach("fichier", zip, "decoupage.zip");
  else { if(shp !== null) req = req.attach("fichier", shp ?? shpMdg(), "d.shp");
    req = req.attach("fichier", dbf ?? dbfMdg(), "d.dbf"); }
  if(mapping) req = req.field("mapping", JSON.stringify(mapping));
  return req;
};
const commitShp = (token, { shp, dbf, mapping, label } = {}) => {
  let req = request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${token}`)
    .attach("fichier", shp ?? shpMdg(), "d.shp")
    .attach("fichier", dbf ?? dbfMdg(), "d.dbf");
  if(mapping) req = req.field("mapping", JSON.stringify(mapping));
  if(label) req = req.field("label", label);
  return req;
};

test("shapefile : l'aperçu lit le type, apparie .shp/.dbf par ordre, et ne rien écrit", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const avant = db.prepare("SELECT COUNT(*) c FROM geo_version").get().c;

  const r = await apercuShp(t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resume.typeShp, 5);
  assert.equal(r.body.resume.records, 3);
  assert.equal(r.body.resume.apparies, 3);
  assert.equal(r.body.resume.avecGeometrie, 3);
  assert.equal(r.body.resume.sansGeometrie, 0);

  /* La correspondance est proposée seule, à partir des intitulés COD-AB. */
  assert.equal(r.body.mapping.adm3, "ADM3_EN");
  assert.equal(r.body.mapping.pcode3, "ADM3_PCODE");
  /* Les colonnes sont listées avec un échantillon, pour le volet de mapping. */
  assert.ok(r.body.colonnes.find(c => c.nom === "ADM3_EN")?.exemples.includes("Alpha"));

  /* L'arbre est reconstruit sans rien écrire : 1 région, 1 district, 3 communes. */
  assert.equal(r.body.arbre.counts.adm1, 1);
  assert.equal(r.body.arbre.counts.adm2, 1);
  assert.equal(r.body.arbre.counts.adm3, 3);
  assert.equal(r.body.arbre.total, 5);
  assert.equal(r.body.echantillon.length, 3);

  assert.equal(db.prepare("SELECT COUNT(*) c FROM geo_version").get().c, avant,
    "l'aperçu n'a créé aucun millésime");
});

test("shapefile : un type non polygone est refusé avec son motif", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* En-tête déclarant le type 1 (points) : le fichier ne décrit pas un découpage. */
  const shpPoints = forgeShp([], { typeEntete: 1 });
  const r = await apercuShp(t, { shp: shpPoints });
  assert.equal(r.status, 422);
  assert.ok(/polygone|type/.test(r.body.error), r.body.error);
});

test("shapefile : la correspondance des colonnes est un vrai levier", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* Des intitulés opaques que rien ne reconnaît : sans correspondance, l'arbre
     reste vide ; avec, il se construit. C'est ce qui prouve que le mapping décide. */
  const champs = [{ nom:"N1", len:12 }, { nom:"N2", len:12 }, { nom:"N3", len:12 }, { nom:"C3", len:10 }];
  const lignes = [
    { N1:"Anosy", N2:"Amboasary", N3:"Alpha", C3:"MG0001" },
    { N1:"Anosy", N2:"Amboasary", N3:"Beta",  C3:"MG0002" },
    { N1:"Anosy", N2:"Amboasary", N3:"Gamma", C3:"MG0003" },
  ];
  const dbf = forgeDbf(champs, lignes);

  const sans = await apercuShp(t, { dbf });
  assert.equal(sans.status, 200);
  assert.equal(sans.body.arbre.total, 0, "sans correspondance, aucune unité n'est construite");

  const avec = await apercuShp(t, { dbf,
    mapping: { adm1:"N1", adm2:"N2", adm3:"N3", pcode3:"C3" } });
  assert.equal(avec.body.arbre.total, 5, "avec correspondance, l'arbre se construit");
  assert.equal(avec.body.arbre.counts.adm3, 3);
});

test("shapefile : l'aperçu chiffre les sites qui deviendront orphelins", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* Un site rattaché à un p-code que le nouveau découpage ne portera pas. */
  db.prepare("UPDATE sites SET geo_pcode=? WHERE id=(SELECT id FROM sites LIMIT 1)")
    .run("XORPHELINTEST");

  const r = await apercuShp(t);
  assert.equal(r.status, 200);
  assert.ok(r.body.orphelins.orphelins >= 1, "au moins le site témoin devient orphelin");
  assert.ok(r.body.orphelins.sitesRattaches >= r.body.orphelins.orphelins);
  /* Aucun p-code du nouveau découpage ne figure parmi les orphelins : ce sont
     bien des sites que le basculement DÉTACHE, pas des faux positifs. */
  assert.ok(r.body.orphelins.echantillon.every(s => !/^MG000/.test(s.geo_pcode)));
});

test("shapefile : le commit crée un millésime courant avec ses contours, et lit les coordonnées", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await commitShp(t, { label:"Communes forgées" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 5, "1 région + 1 district + 3 communes");
  assert.equal(r.body.geom.écrites, 3, "trois contours rattachés");

  /* Le millésime est courant et porte ses contours. */
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${t}`);
  const courant = v.body.rows.find(x => x.current);
  assert.equal(courant.label, "Communes forgées");
  assert.equal(courant.geom.units, 3);

  /* Appariement PAR ORDRE : la commune de l'enregistrement i porte le contour de
     la forme i. Alpha (rec 0) est en lon≈46, Beta (rec 1) en 47, Gamma (rec 2) en 48.
     Un appariement inversé placerait Alpha en 48 — c'est ce que l'on vérifie. */
  const lu = await request(app).get("/api/geo/geometry?level=adm3&detail=true")
    .set("Authorization", `Bearer ${t}`);
  const bbox = Object.fromEntries(lu.body.features.map(f => [f.properties.pcode, f.properties.bbox]));
  assert.ok(bbox["MG0001"][0] >= 46 && bbox["MG0001"][2] <= 46.6, JSON.stringify(bbox["MG0001"]));
  assert.ok(bbox["MG0002"][0] >= 47 && bbox["MG0002"][2] <= 47.6, JSON.stringify(bbox["MG0002"]));
  assert.ok(bbox["MG0003"][0] >= 48 && bbox["MG0003"][2] <= 48.6, JSON.stringify(bbox["MG0003"]));
});

test("shapefile : le commit relève les sites devenus orphelins", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  db.prepare("UPDATE sites SET geo_pcode=? WHERE id=(SELECT id FROM sites LIMIT 1)")
    .run("XENCOREORPHELIN");
  const r = await commitShp(t);
  assert.equal(r.status, 200);
  assert.ok(r.body.orphelins.orphelins >= 1);
  assert.ok(/orphelin/.test(r.body.message));
  /* Le journal garde trace de l'import et du coût, rattachée à CE millésime. */
  const trace = db.prepare(
    "SELECT text FROM audit WHERE entity='geo_version' AND action='import' AND entity_id=?")
    .get(r.body.versionId);
  assert.ok(trace && /orphelin/.test(trace.text), trace?.text);
});

test("shapefile : dépôt en une archive .zip, même résultat que les fichiers séparés", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("mdg.shp", shpMdg());
  zip.file("mdg.dbf", dbfMdg());
  zip.file("mdg.prj", "GEOGCS[\"GCS_WGS_1984\"]");
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  const r = await apercuShp(t, { zip: buf });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.arbre.total, 5);
  assert.equal(r.body.arbre.counts.adm3, 3);
  assert.equal(r.body.resume.avecGeometrie, 3);
});

test("shapefile : idempotence — un second commit rebâtit le millésime courant sans erreur", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const un = await commitShp(t, { label:"Rejeu 1" });
  const deux = await commitShp(t, { label:"Rejeu 2" });
  assert.equal(un.status, 200);
  assert.equal(deux.status, 200);
  assert.equal(deux.body.imported, 5);
  assert.equal(deux.body.geom.écrites, 3);
  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${t}`);
  const courants = v.body.rows.filter(x => x.current);
  assert.equal(courants.length, 1, "un seul millésime courant");
  assert.equal(courants[0].label, "Rejeu 2");
});

test("shapefile : téléversement réservé aux administrateurs", async () => {
  const te = (await login("terrain@test.local", "TerrainMotDePasse1")).body.token;
  assert.equal((await apercuShp(te)).status, 403);
  assert.equal((await commitShp(te)).status, 403);
});

/* ── Un .shp SANS .dbf : les polygones seuls ────────────────────────────
   « Comme QGIS » : le seul .shp doit afficher les contours tout de suite, sous
   des identités provisoires « Polygone N », sans exiger la table attributaire.
   Le .dbf déposé ensuite les nomme et les rattache — le flux avec-.dbf, lui,
   reste intact (tous les tests ci-dessus le prouvent). */
const apercuShpSeul = (token, shp) =>
  request(app).post("/api/geo/shapefile/apercu").set("Authorization", `Bearer ${token}`)
    .attach("fichier", shp ?? shpMdg(), "d.shp");

test("shapefile : sans .dbf, l'aperçu propose des identités « Polygone N » et ne rien écrit", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const avant = db.prepare("SELECT COUNT(*) c FROM geo_version").get().c;

  const r = await apercuShpSeul(t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.resume.sansDbf, true, "l'aperçu signale l'absence de table attributaire");
  assert.equal(r.body.resume.records, 3);
  assert.equal(r.body.resume.avecGeometrie, 3);
  assert.equal(r.body.colonnes.length, 0, "aucune colonne attributaire sans .dbf");
  /* Trois polygones provisoires, à un niveau unique, prêts à s'afficher. */
  assert.equal(r.body.arbre.counts.adm3, 3);
  assert.equal(r.body.arbre.total, 3);
  assert.ok(r.body.echantillon.some(u => /Polygone 1/.test(u.name)), JSON.stringify(r.body.echantillon));

  assert.equal(db.prepare("SELECT COUNT(*) c FROM geo_version").get().c, avant,
    "l'aperçu n'a créé aucun millésime");
});

test("shapefile : sans .dbf, le commit importe les polygones seuls, devient courant et les affiche", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shpMdg(), "d.shp").field("label", "Polygones seuls");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.imported, 3, "trois polygones provisoires");
  assert.equal(r.body.geom.écrites, 3, "trois contours affichables");

  const v = await request(app).get("/api/geo/versions").set("Authorization", `Bearer ${t}`);
  const courant = v.body.rows.find(x => x.current);
  assert.equal(courant.label, "Polygones seuls");
  assert.equal(courant.geom.units, 3);

  /* Les contours s'affichent : le service de géométries les rend au niveau adm3,
     nommés « Polygone N » — appariés PAR ORDRE aux enregistrements du .shp. */
  const lu = await request(app).get("/api/geo/geometry?level=adm3")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(lu.body.features.length, 3, "les polygones seuls s'affichent sur la carte");
  assert.ok(lu.body.features.every(f => /Polygone/.test(f.properties.name)), JSON.stringify(
    lu.body.features.map(f => f.properties.name)));
});

/* ── Rattachement du millésime au PAYS ──────────────────────────────────
   Le découpage se configure depuis la fiche du pays courant, qui envoie son code.
   Le millésime doit s'y rattacher, et la bascule du courant ne toucher que CE
   pays : c'est ce qui évite le bug multi-pays (importer sous un pays écraserait
   le référentiel d'un autre). */
test("shapefile : le millésime est rattaché au pays passé, et la bascule ne touche que ce pays", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* Un second pays configuré, laissé non courant : Madagascar reste courant. */
  const niv = { adm0:{one:"Pays",many:"Pays"}, adm1:{one:"Province",many:"Provinces"},
    adm2:{one:"Territoire",many:"Territoires"}, adm3:{one:"Secteur",many:"Secteurs"},
    adm4:{one:"Groupement",many:"Groupements"} };
  await request(app).post("/api/country").set("Authorization", `Bearer ${t}`)
    .send({ code:"ETH", name:"Éthiopie", currency:"ETB", levels:niv });

  const mdgAvant = db.prepare("SELECT id FROM geo_version WHERE country='MDG' AND is_current=1").get();

  const r = await request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shpMdg(), "d.shp").attach("fichier", dbfMdg(), "d.dbf")
    .field("country", "eth").field("label", "Découpage ETH");
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const row = db.prepare("SELECT country, is_current FROM geo_version WHERE id=?").get(r.body.versionId);
  assert.equal(row.country, "ETH", "le millésime est rattaché au pays passé (code normalisé)");
  assert.equal(row.is_current, 1, "et courant DANS son pays");

  /* Le millésime malgache n'est pas touché : la bascule est cloisonnée par pays. */
  assert.equal(db.prepare("SELECT is_current FROM geo_version WHERE id=?").get(mdgAvant.id).is_current, 1,
    "le millésime courant de Madagascar reste courant");
  /* Et l'application, dont le pays courant reste Madagascar, sert toujours SON
     découpage, pas celui d'Éthiopie qu'on vient d'importer. */
  const g = await request(app).get("/api/geo/levels").set("Authorization", `Bearer ${t}`);
  assert.ok(g.body.rows.length > 0, "le référentiel servi reste celui du pays courant");

  /* Un code pays inconnu est refusé avec son motif — l'écriture est validée. */
  const mauvais = await request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shpMdg(), "d.shp").attach("fichier", dbfMdg(), "d.dbf")
    .field("country", "ZZZ");
  assert.equal(mauvais.status, 422);
  assert.ok(/inconnu/.test(mauvais.body.error), mauvais.body.error);
});

/* ═══════════════════════════════════════════════════════════════════════
   P-codes en double : présentés, jamais fatals.

   L'identité d'une unité est son CHEMIN, pas son p-code. Un même code profond
   peut désigner deux unités légitimes portées par deux chemins différents — le
   cas réel « Berano Ville » (MG53519050003) rattaché à deux communes voisines.
   L'import ne refuse donc jamais le fichier : il signale les doublons, et une
   option décide de ce qu'on écrit — le premier trouvé, ou les deux. */

const ROWS_BERANO = [
  { adm1:"Anosy", adm2:"Amboasary Atsimo", adm3:"Tanandava Sud", adm4:"Berano Ville",
    pcode1:"MG53", pcode2:"MG53519", pcode4:"MG53519050003" },
  { adm1:"Anosy", adm2:"Amboasary Atsimo", adm3:"Berano", adm4:"Berano Ville",
    pcode1:"MG53", pcode2:"MG53519", pcode4:"MG53519050003" },
];

test("bulk : un p-code en double ne fait pas échouer l'import — premier trouvé par défaut", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Berano premier gagne", rows: ROWS_BERANO });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  /* Deux communes distinctes (chemins différents), mais un seul fokontany stocké :
     le premier l'emporte, l'autre est signalé, rien n'est refusé. */
  assert.equal(r.body.counts.adm3, 2);
  assert.equal(r.body.counts.adm4, 1);
  assert.equal(r.body.collisions, 1);
  assert.equal(r.body.collisionsSample[0].pcode, "MG53519050003");
  assert.equal(r.body.collisionsSample[0].chemins.length, 2);
});

test("bulk : avec l'option, les deux chemins entrent (chemin faisant foi)", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const r = await request(app).post("/api/geo/bulk").set("Authorization", `Bearer ${t}`)
    .send({ label:"Berano les deux", rows: ROWS_BERANO, allowDuplicates: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  /* Les deux fokontany existent : le doublon a reçu un code dérivé de son chemin. */
  assert.equal(r.body.counts.adm4, 2);
  assert.equal(r.body.collisions, 1, "le doublon reste signalé même quand il est accepté");
});

test("shapefile : les p-codes en double sont présentés à l'aperçu, et le commit exige un consentement", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const champs = [
    { nom:"ADM1_EN", len:12 }, { nom:"ADM2_EN", len:16 }, { nom:"ADM3_EN", len:16 },
    { nom:"ADM4_EN", len:16 }, { nom:"ADM1_PCODE", len:10 }, { nom:"ADM2_PCODE", len:10 },
    { nom:"ADM4_PCODE", len:14 },
  ];
  const lignes = [
    { ADM1_EN:"Anosy", ADM2_EN:"Amboasary Atsimo", ADM3_EN:"Tanandava Sud", ADM4_EN:"Berano Ville",
      ADM1_PCODE:"MG53", ADM2_PCODE:"MG53519", ADM4_PCODE:"MG53519050003" },
    { ADM1_EN:"Anosy", ADM2_EN:"Amboasary Atsimo", ADM3_EN:"Berano", ADM4_EN:"Berano Ville",
      ADM1_PCODE:"MG53", ADM2_PCODE:"MG53519", ADM4_PCODE:"MG53519050003" },
  ];
  const dbf = forgeDbf(champs, lignes);
  const shp = forgeShp([carreSh(46, -25), carreSh(47, -24)]);

  /* Aperçu : les doublons sont montrés, avec leurs chemins. Rien n'est refusé. */
  const ap = await request(app).post("/api/geo/shapefile/apercu").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shp, "b.shp").attach("fichier", dbf, "b.dbf");
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.collisionsTotal, 1);
  assert.equal(ap.body.collisions[0].pcode, "MG53519050003");
  assert.equal(ap.body.collisions[0].chemins.length, 2);

  /* Commit sans consentement : garde NON fatale (422), qui explique et liste — pas
     un 409 aveugle. Le fichier n'est pas perdu, il repart dès la case cochée. */
  const bloque = await request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shp, "b.shp").attach("fichier", dbf, "b.dbf");
  assert.equal(bloque.status, 422);
  assert.ok(/double/.test(bloque.body.error), bloque.body.error);
  assert.equal(bloque.body.collisions[0].pcode, "MG53519050003");

  /* Avec l'option, les deux chemins entrent, et le millésime bascule. */
  const ok = await request(app).post("/api/geo/shapefile/commit").set("Authorization", `Bearer ${t}`)
    .attach("fichier", shp, "b.shp").attach("fichier", dbf, "b.dbf")
    .field("allowDuplicates", "true").field("label", "Berano accepté");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.counts.adm4, 2, "les deux fokontany sont importés");
  assert.equal(ok.body.collisions, 1, "le doublon reste signalé");
});

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8 — Listes paramétrables typées, en maître-détail.

   Une route pour onze référentiels : ce qui doit être vérifié, c'est que
   le comportement soit LE MÊME pour une liste générique (`list_item`) et
   pour une liste native (`activity_categories`, `partners`…), et que
   l'usage soit compté sur les VRAIES tables filles.
   ═══════════════════════════════════════════════════════════════════════ */
test("listes typées : le rail des types est servi avec ses compteurs", async () => {
  const r = await request(app).get("/api/listes").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  const cles = r.body.types.map(t => t.cle);
  for(const attendu of ["denrees","modalites","partenaires","types_partenariat",
                        "tiers","sous_types_pi","types_site","types_suivi","durees","domaines"])
    assert.ok(cles.includes(attendu), `le type « ${attendu} » figure au rail : ${cles.join(", ")}`);

  /* « Activités » a QUITTÉ le rail des listes typées : elle a son onglet propre
     (plus riche), et deux endroits pour la même liste étaient la redondance à
     supprimer. Elle reste servie par la route :cle (usage, renommage en cascade),
     mais n'apparaît plus dans le rail. */
  assert.ok(!cles.includes("activites"), "les activités ne figurent plus au rail (onglet dédié)");
  const activites = await request(app).get("/api/listes/activites").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(activites.status, 200, "mais la route :cle des activités reste servie");

  const denrees = r.body.types.find(t => t.cle === "denrees");
  assert.equal(denrees.native, false, "les denrées vivent dans la table générique");
  assert.ok(denrees.items >= 12, "les denrées sont semées par la migration");
});

test("listes typées : une liste générique se lit, se crée, se modifie et se supprime", async () => {
  const lu = await request(app).get("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(lu.status, 200);
  assert.equal(lu.body.type.label, "Denrées et commodités");
  assert.ok(lu.body.items.some(x => x.code === "Riz"), "le code est la valeur portée par pdd.commodity");
  assert.ok(lu.body.type.liens.some(l => l.table === "pdd" && l.colonne === "commodity"),
    "l'écran reçoit la déclaration des tables filles, il ne la recopie pas");

  const cree = await request(app).post("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"Manioc", label:"Manioc séché", ordre:20 });
  assert.equal(cree.status, 201, JSON.stringify(cree.body));
  const item = cree.body.item;
  assert.equal(item.usageTotal, 0, "un item neuf n'est référencé nulle part");

  /* Doublon de code, puis de libellé — les deux sont refusés, par type. */
  assert.equal((await request(app).post("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"Manioc", label:"Autre chose" })).status, 409);
  assert.equal((await request(app).post("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"Manioc2", label:"manioc séché" })).status, 409);
  /* Mais le même code dans une AUTRE liste passe : les listes ne se mélangent pas. */
  const ailleurs = await request(app).post("/api/listes/types_site")
    .set("Authorization", `Bearer ${adminToken}`).send({ code:"Manioc", label:"Champ de manioc" });
  assert.equal(ailleurs.status, 201, JSON.stringify(ailleurs.body));
  await request(app).delete(`/api/listes/types_site/${ailleurs.body.item.id}`)
    .set("Authorization", `Bearer ${adminToken}`);

  /* Verrou optimiste. */
  const stale = await request(app).put(`/api/listes/denrees/${item.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:item.code, label:"Manioc frais", rev:999 });
  assert.equal(stale.status, 409, "une révision périmée est refusée");
  const maj = await request(app).put(`/api/listes/denrees/${item.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:item.code, label:"Manioc frais", rev:item.rev });
  assert.equal(maj.status, 200, JSON.stringify(maj.body));
  assert.equal(maj.body.item.label, "Manioc frais");

  const del = await request(app).delete(`/api/listes/denrees/${item.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM list_item WHERE id=?").get(item.id).c, 0);
});

test("listes typées : un champ propre est contrôlé contre la liste qu'il désigne", async () => {
  /* Le type de partenariat d'un partenaire est le CODE d'une autre liste :
     un code inconnu fabriquerait exactement l'orphelin que le gestionnaire
     est censé empêcher. */
  const faux = await request(app).post("/api/listes/partenaires")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"PART_X", label:"Partenaire d'essai", champs:{ partnership_type:"INEXISTANT" } });
  assert.equal(faux.status, 422, JSON.stringify(faux.body));
  assert.ok(/n'existe pas dans la liste/.test(faux.body.details[0].message), faux.body.details[0].message);

  const bon = await request(app).post("/api/listes/partenaires")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"PART_X", label:"Partenaire d'essai", champs:{ partnership_type:"ONG_NAT" } });
  assert.equal(bon.status, 201, JSON.stringify(bon.body));
  assert.equal(bon.body.item.champs.partnership_type, "ONG_NAT");
  /* Et le type de partenariat compte désormais un usage : il ne se supprime plus. */
  const typePart = (await request(app).get("/api/listes/types_partenariat")
    .set("Authorization", `Bearer ${adminToken}`)).body.items.find(x => x.code === "ONG_NAT");
  assert.equal(typePart.usageTotal, 1, "l'usage remonte depuis partners.partnership_type");
  const refus = await request(app).delete(`/api/listes/types_partenariat/${typePart.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refus.status, 409);

  await request(app).delete(`/api/listes/partenaires/${bon.body.item.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
});

test("listes typées : l'usage se compte sur les vraies tables filles, et retient la suppression", async () => {
  /* Une activité du semis est portée par des sites : la liste doit le voir
     par sa clé étrangère ET par le tag. */
  const r = await request(app).get("/api/listes/activites").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(r.status, 200);
  const utilisee = r.body.items.find(x => x.usageTotal > 0);
  assert.ok(utilisee, "au moins une activité du semis est référencée");
  assert.ok(utilisee.usage.some(u => u.table === "sites"), JSON.stringify(utilisee.usage));

  const avant = db.prepare("SELECT COUNT(*) c FROM sites WHERE category_id IS NULL").get().c;
  const refus = await request(app).delete(`/api/listes/activites/${utilisee.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refus.status, 409);
  assert.ok(refus.body.usage.length, "le refus énumère ce qui retient l'item");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sites WHERE category_id IS NULL").get().c, avant,
    "aucun site n'a été détaché par la tentative");

  /* La désactivation, elle, passe — c'est l'issue que le refus propose. */
  const off = await request(app).put(`/api/listes/activites/${utilisee.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:utilisee.code, label:utilisee.label, active:false, rev:utilisee.rev,
            champs:utilisee.champs });
  assert.equal(off.status, 200);
  assert.equal(off.body.item.active, false);
  await request(app).put(`/api/listes/activites/${utilisee.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:utilisee.code, label:utilisee.label, active:true, rev:off.body.item.rev,
            champs:utilisee.champs });
});

test("listes typées : la validation d'une liste tombe dès qu'un item change", async () => {
  const val = await request(app).post("/api/listes/durees/valider")
    .set("Authorization", `Bearer ${adminToken}`).send({});
  assert.equal(val.status, 200);
  assert.ok(val.body.validation.at, "la validation est datée");
  assert.ok(val.body.validation.par, "et signée");

  const lu = await request(app).get("/api/listes/durees").set("Authorization", `Bearer ${adminToken}`);
  assert.ok(lu.body.validation, "l'écran voit la liste comme validée");

  const it = lu.body.items[0];
  await request(app).put(`/api/listes/durees/${it.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ code:it.code, label:it.label + " ", rev:it.rev });
  const apres = await request(app).get("/api/listes/durees").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(apres.body.validation, null,
    "une liste modifiée après sa relecture n'est plus une liste relue");
});

test("catalogue de rations : la première charge officielle est servie, et la collection se complète", async () => {
  /* « Une ration, une ligne » : le catalogue officiel (migration 031) est semé,
     et une convention composée est plusieurs lignes de même libellé. */
  const st = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  assert.equal(st.status, 200);
  const cat = st.body.rationCatalog;
  assert.ok(Array.isArray(cat) && cat.length >= 20, `le catalogue officiel est semé : ${cat?.length} ligne(s)`);
  const gd = cat.filter(l => l.label.startsWith("GD / GFD"));
  assert.ok(gd.length >= 3, "GD standard porte riz + légumineuses + huile");
  assert.ok(gd.some(l => l.commodity === "Riz" && l.grams === 400), JSON.stringify(gd));
  assert.ok(gd.every(l => l.activityTag === "GD"), "l'activité par défaut voyage");

  /* Le catalogue est une collection synchronisée : on l'édite comme les autres. */
  const w = await request(app).put("/api/collections/rationCatalog").set("Authorization", `Bearer ${adminToken}`)
    .send({ rows: [{ id:"rc_test_conv", label:"Convention d'essai", commodity:"Riz", grams:250,
      activityTag:"GD", note:"essai", sort:999 }] });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(w.body.created, 1);
  const st2 = await request(app).get("/api/state").set("Authorization", `Bearer ${adminToken}`);
  const ajoute = st2.body.rationCatalog.find(l => l.id === "rc_test_conv");
  assert.ok(ajoute, "la ligne ajoutée est servie");
  assert.equal(ajoute.grams, 250);
  assert.equal(ajoute.activityTag, "GD");
});

test("catalogue de rations : la denrée qu'il utilise ne se supprime pas (lien en cascade)", async () => {
  /* Le lien ration_catalog.commodity ajouté au registre des listes : renommer une
     denrée y cascade, et on ne supprime pas une denrée qu'une convention utilise. */
  const r = await request(app).get("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`);
  const riz = r.body.items.find(x => x.code === "Riz");
  assert.ok(riz, "la denrée Riz existe");
  assert.ok(riz.usage.some(u => u.table === "ration_catalog"),
    `l'usage compte le catalogue de rations : ${JSON.stringify(riz.usage)}`);
  const del = await request(app).delete(`/api/listes/denrees/${riz.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(del.status, 409, "une denrée utilisée par le catalogue ne se supprime pas");
});

test("listes typées : lecture ouverte, écriture réservée à l'administration", async () => {
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"listedit@test.local", password:"ListEditMotDePasse1", first_name:"ListEdit",
            role:"editor", tabs:["home"], active:true });
  motDePasseAdopte("listedit@test.local");
  const t = (await login("listedit@test.local", "ListEditMotDePasse1")).body.token;
  assert.equal((await request(app).get("/api/listes").set("Authorization", `Bearer ${t}`)).status, 200);
  assert.equal((await request(app).get("/api/listes/denrees").set("Authorization", `Bearer ${t}`)).status, 200);
  const refus = await request(app).post("/api/listes/denrees").set("Authorization", `Bearer ${t}`)
    .send({ code:"Interdit", label:"Interdit" });
  assert.equal(refus.status, 403, "un éditeur ne configure pas les référentiels");
  assert.equal((await request(app).get("/api/listes/inconnue").set("Authorization", `Bearer ${t}`)).status, 404);
});

test("listes typées : le plan de distribution accepte une modalité hors des trois d'origine", async () => {
  /* La migration 026 lève l'énumération de `pdd.modality` : la liste des
     modalités se paramètre, donc le schéma ne peut plus la figer. Les
     fichiers réels du bureau portent déjà une modalité hybride. */
  const ligne = db.prepare("SELECT * FROM pdd LIMIT 1").get();
  assert.ok(ligne, "le semis a rempli le plan de distribution");
  db.prepare("UPDATE pdd SET modality='Mix' WHERE id=?").run(ligne.id);
  assert.equal(db.prepare("SELECT modality FROM pdd WHERE id=?").get(ligne.id).modality, "Mix");
  db.prepare("UPDATE pdd SET modality=? WHERE id=?").run(ligne.modality, ligne.id);
  /* Et la reconstruction de la table n'a rien perdu : la contrainte de statut
     et les index sont toujours là. */
  assert.throws(() => db.prepare("UPDATE pdd SET status='n''importe quoi' WHERE id=?").run(ligne.id));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pdd'")
    .all().map(x => x.name);
  for(const n of ["idx_pdd_period","idx_pdd_bureau","idx_pdd_geo_pcode"])
    assert.ok(idx.includes(n), `l'index ${n} a été recréé (${idx.join(", ")})`);
});

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8-2 — Intégrité référentielle.

   « Si une liste est enregistrée et a été déjà utilisée, impossible de
   l'effacer (possibilité de mettre à jour mais le code d'identification
   reste pour ne pas perdre les données). »
   ═══════════════════════════════════════════════════════════════════════ */
test("intégrité : le code d'identification est préservé par la mise à jour", async () => {
  const lu = await request(app).get("/api/listes/denrees").set("Authorization", `Bearer ${adminToken}`);
  const riz = lu.body.items.find(x => x.code === "Riz");

  const refus = await request(app).put(`/api/listes/denrees/${riz.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"RIZ_LOCAL", label:riz.label, rev:riz.rev });
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.ok(/clé de jointure/.test(refus.body.error), refus.body.error);
  assert.ok(/renommer-code/.test(refus.body.voie), "la réponse nomme la voie sûre");
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(riz.id).code, "Riz",
    "rien n'a été écrit");

  /* Le reste de l'item, lui, se met à jour sans réserve. */
  const maj = await request(app).put(`/api/listes/denrees/${riz.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"Riz", label:"Riz blanc", note:"Denrée principale", rev:riz.rev });
  assert.equal(maj.status, 200, JSON.stringify(maj.body));
  assert.equal(maj.body.item.label, "Riz blanc");
  assert.equal(maj.body.item.code, "Riz", "le code n'a pas bougé");
  await request(app).put(`/api/listes/denrees/${riz.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ code:"Riz", label:"Riz", rev:maj.body.item.rev });
});

test("intégrité : le tag d'une activité ne se renomme pas depuis l'écran des activités", async () => {
  /* Dix colonnes portent ce tag en texte, sans clé étrangère pour les
     retenir : le réécrire ici laissait des lignes désigner un code disparu,
     silencieusement. */
  const act = db.prepare(
    "SELECT * FROM activity_categories WHERE tag IN (SELECT activity_tag FROM sites) LIMIT 1").get();
  assert.ok(act, "une activité du semis est portée par des sites");
  const avant = db.prepare("SELECT COUNT(*) c FROM sites WHERE activity_tag=?").get(act.tag).c;

  const refus = await request(app).put(`/api/activities/${act.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name:act.name, tag:act.tag + "X", rev:act.rev });
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.ok(/clé de jointure/.test(refus.body.error), refus.body.error);
  assert.equal(db.prepare("SELECT tag FROM activity_categories WHERE id=?").get(act.id).tag, act.tag);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sites WHERE activity_tag=?").get(act.tag).c, avant,
    "aucun site n'a perdu son tag");

  /* Le nom, le domaine et le statut se modifient normalement. */
  const maj = await request(app).put(`/api/activities/${act.id}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .send({ name:act.name + " (révisée)", tag:act.tag, program_area:act.program_area, rev:act.rev });
  assert.equal(maj.status, 200, JSON.stringify(maj.body));
  await request(app).put(`/api/activities/${act.id}`).set("Authorization", `Bearer ${adminToken}`)
    .send({ name:act.name, tag:act.tag, program_area:act.program_area, rev:maj.body.activity.rev });
});

test("intégrité : le refus de suppression d'une activité compte les douze colonnes, pas deux", async () => {
  /* Une activité dont AUCUN site ne porte la clé étrangère mais dont des
     lignes portent le tag était supprimable : les deux clés étrangères
     répondaient zéro, et dix colonnes de texte restaient à désigner un code
     disparu. */
  const cree = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Activité orpheline d'essai", tag:"ORPH" });
  assert.equal(cree.status, 201);
  const id = cree.body.activity.id;
  db.prepare(`INSERT INTO outputs (id,activity_tag,year,month,planned,actual)
              VALUES ('out_orph','ORPH',2026,0,10,0)`).run();

  const apres = await request(app).get("/api/activities").set("Authorization", `Bearer ${adminToken}`);
  const vue = apres.body.activities.find(a => a.id === id);
  assert.equal(vue.usage.sites, 0, "aucune clé étrangère ne la retient");
  assert.equal(vue.usageTotal, 1, "mais une ligne de produits porte son tag");
  assert.ok(vue.usageDetail.some(u => u.table === "outputs"), JSON.stringify(vue.usageDetail));

  const refus = await request(app).delete(`/api/activities/${id}`)
    .set("Authorization", `Bearer ${adminToken}`);
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.equal(refus.body.usageTotal, 1);

  db.prepare("DELETE FROM outputs WHERE id='out_orph'").run();
  assert.equal((await request(app).delete(`/api/activities/${id}`)
    .set("Authorization", `Bearer ${adminToken}`)).status, 200);
});

test("intégrité : désactiver est un geste à part, qui ne touche à rien d'autre", async () => {
  const lu = await request(app).get("/api/listes/types_suivi").set("Authorization", `Bearer ${adminToken}`);
  const it = lu.body.items[0];

  const off = await request(app).put(`/api/listes/types_suivi/${it.id}/actif`)
    .set("Authorization", `Bearer ${adminToken}`).send({ active:false, rev:it.rev });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.item.active, false);
  assert.equal(off.body.item.label, it.label, "le libellé n'a pas été touché");
  assert.equal(off.body.item.code, it.code, "le code non plus");

  /* Le verrou optimiste vaut aussi pour ce geste. */
  const stale = await request(app).put(`/api/listes/types_suivi/${it.id}/actif`)
    .set("Authorization", `Bearer ${adminToken}`).send({ active:true, rev:it.rev });
  assert.equal(stale.status, 409, "la révision d'avant la désactivation est refusée");

  const on = await request(app).put(`/api/listes/types_suivi/${it.id}/actif`)
    .set("Authorization", `Bearer ${adminToken}`).send({ active:true, rev:off.body.item.rev });
  assert.equal(on.status, 200);
  assert.equal(on.body.item.active, true);
});

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8-3 — Renommage de code EN CASCADE, réservé au super.

   « Si le super user change un code d'identification, tout ce qui lui est
   relié devrait aussi changer avec. » Ce n'est pas un supprimer-recréer :
   une transaction réécrit la table maîtresse ET toutes ses filles.
   ═══════════════════════════════════════════════════════════════════════ */
let superToken;
/* Depuis le point 4 du chantier, un renommage se valide sur SON PLAN : on
   demande la correspondance, on la lit, puis on renvoie son jeton. Ce
   raccourci fait les deux appels — c'est exactement ce que fait l'écran. */
const renommer = async (cle, id, nouveau, mode, token) => {
  const plan = await request(app).post(`/api/listes/${cle}/${id}/renommer-code/plan`)
    .set("Authorization", `Bearer ${token}`).send({ nouveau });
  if(plan.status !== 200) return plan;
  return request(app).post(`/api/listes/${cle}/${id}/renommer-code`)
    .set("Authorization", `Bearer ${token}`)
    .send({ nouveau, mode, jeton: plan.body.plan.jeton });
};
test("renommage : préparation d'un compte super pour la cascade", async () => {
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"supercode@test.local", password:"SuperCodeMotDePasse1", first_name:"SuperCode",
            role:"super", tabs:["home"], active:true });
  motDePasseAdopte("supercode@test.local");
  superToken = (await login("supercode@test.local", "SuperCodeMotDePasse1")).body.token;
  assert.ok(superToken);
});

test("renommage : un administrateur ne renomme pas un code, seul le super le peut", async () => {
  /* Le compte d'amorçage est `super` : c'est un compte de rôle ADMIN qu'il
     faut ici, sans quoi le test constaterait un succès et croirait à un refus. */
  await request(app).post("/api/users").set("Authorization", `Bearer ${adminToken}`)
    .send({ email:"admincode@test.local", password:"AdminCodeMotDePasse1", first_name:"AdminCode",
            role:"admin", tabs:["home"], active:true });
  motDePasseAdopte("admincode@test.local");
  const t = (await login("admincode@test.local", "AdminCodeMotDePasse1")).body.token;

  const it = (await request(app).get("/api/listes/denrees")
    .set("Authorization", `Bearer ${t}`)).body.items.find(x => x.code === "Sorgho");
  const refus = await request(app).post(`/api/listes/denrees/${it.id}/renommer-code`)
    .set("Authorization", `Bearer ${t}`).send({ nouveau:"Sorgho blanc" });
  assert.equal(refus.status, 403, JSON.stringify(refus.body));
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, "Sorgho");
});

test("renommage : la cascade réécrit la table maîtresse ET toutes ses filles, en une transaction", async () => {
  const it = (await request(app).get("/api/listes/denrees")
    .set("Authorization", `Bearer ${superToken}`)).body.items.find(x => x.code === "Sorgho");

  /* On accroche des lignes filles réelles au code, dans le plan de distribution. */
  const cibles = db.prepare("SELECT id FROM pdd LIMIT 3").all().map(x => x.id);
  assert.ok(cibles.length >= 1, "le semis a rempli le plan de distribution");
  for(const id of cibles) db.prepare("UPDATE pdd SET commodity='Sorgho' WHERE id=?").run(id);
  /* Le semis en pose déjà : ce qui compte est le total réel, pas les trois
     lignes que ce test vient d'accrocher. */
  const attendues = db.prepare("SELECT COUNT(*) c FROM pdd WHERE commodity='Sorgho'").get().c;
  assert.ok(attendues >= cibles.length);

  const r = await renommer("denrees", it.id, "Sorgho blanc", "renommer", superToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, "renommer");
  assert.equal(r.body.total, attendues, "toutes les lignes filles ont suivi");
  assert.ok(r.body.tables.some(t => t.table === "pdd" && t.colonne === "commodity"));
  /* Le contrôle d'après-coup : plus rien ne porte l'ancien code. */
  assert.equal(r.body.reliquat, 0, "aucune ligne ne désigne encore l'ancien code");

  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, "Sorgho blanc",
    "l'item a changé de code — il n'a pas été supprimé puis recréé");
  assert.equal(it.id, db.prepare("SELECT id FROM list_item WHERE code='Sorgho blanc' AND type='denree'")
    .get().id, "c'est le MÊME item, avec le même identifiant");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE commodity='Sorgho'").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE commodity='Sorgho blanc'").get().c,
    attendues);
});

test("renommage : un tag d'activité entraîne les dix colonnes qui le portent", async () => {
  const act = db.prepare(
    "SELECT * FROM activity_categories WHERE tag IN (SELECT activity_tag FROM sites) LIMIT 1").get();
  const compter = (t, c, v) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${c}=?`).get(v).c;
  const avant = {
    sites:  compter("sites", "activity_tag", act.tag),
    params: compter("coverage_params", "activity_tag", act.tag),
    fk:     compter("sites", "category_id", act.id),
  };
  assert.ok(avant.sites > 0, "des sites portent ce tag");

  const nouveau = act.tag + "_2026";
  const r = await renommer("activites", act.id, nouveau, "renommer", superToken);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(compter("sites", "activity_tag", act.tag), 0, "plus aucun site sur l'ancien tag");
  assert.equal(compter("sites", "activity_tag", nouveau), avant.sites);
  assert.equal(compter("coverage_params", "activity_tag", nouveau), avant.params);
  /* La clé étrangère n'a PAS bougé : ce n'est pas une fusion, l'item est le même. */
  assert.equal(compter("sites", "category_id", act.id), avant.fk);
  assert.equal(r.body.reliquat, 0);

  /* Et l'intégrité de la base n'a pas souffert du passage. */
  const sante = await request(app).get("/api/health");
  assert.equal(sante.body.database.foreignKeyViolations, 0);

  /* Retour à l'état d'origine, pour ne pas troubler les tests suivants. */
  await renommer("activites", act.id, act.tag, "renommer", superToken);
  assert.equal(compter("sites", "activity_tag", act.tag), avant.sites);
});

test("renommage : viser un code déjà pris est une FUSION, qui ne se devine pas", async () => {
  const items = (await request(app).get("/api/listes/denrees")
    .set("Authorization", `Bearer ${superToken}`)).body.items;
  const source = items.find(x => x.code === "Dattes");
  const cible  = items.find(x => x.code === "Huile");

  /* Demander « renommer » vers un code pris : refusé, et le plan est rendu
     pour que l'écran puisse montrer ce que la fusion ferait. */
  const refus = await renommer("denrees", source.id, "Huile", "renommer", superToken);
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.ok(/FUSION/.test(refus.body.error), refus.body.error);
  assert.equal(refus.body.plan.mode, "fusionner");
  assert.equal(refus.body.plan.cible.code, "Huile");
  assert.ok(db.prepare("SELECT 1 FROM list_item WHERE id=?").get(source.id), "rien n'a été écrit");

  /* Confirmée, la fusion reporte les lignes et fait disparaître l'item source. */
  const ligne = db.prepare("SELECT id FROM pdd LIMIT 1").get();
  db.prepare("UPDATE pdd SET commodity='Dattes' WHERE id=?").run(ligne.id);
  const ok = await renommer("denrees", source.id, "Huile", "fusionner", superToken);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.mode, "fusionner");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM list_item WHERE id=?").get(source.id).c, 0,
    "l'item d'origine a disparu");
  assert.equal(db.prepare("SELECT commodity FROM pdd WHERE id=?").get(ligne.id).commodity, "Huile",
    "sa ligne fille a été reportée sur la cible");
  assert.ok(db.prepare("SELECT 1 FROM list_item WHERE id=?").get(cible.id), "la cible est intacte");
});

test("renommage : un code identique, vide ou trop long est refusé sans rien écrire", async () => {
  const it = (await request(app).get("/api/listes/types_site")
    .set("Authorization", `Bearer ${superToken}`)).body.items[0];
  for(const [corps, statut] of [[{ nouveau:it.code }, 422], [{ nouveau:"" }, 422],
                                [{ nouveau:"x".repeat(90) }, 422]]){
    for(const chemin of ["renommer-code", "renommer-code/plan"]){
      const r = await request(app).post(`/api/listes/types_site/${it.id}/${chemin}`)
        .set("Authorization", `Bearer ${superToken}`).send(corps);
      assert.equal(r.status, statut, JSON.stringify(r.body));
    }
  }
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, it.code);
});

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8-4 — Mappage puis validation explicite.

   « Si je fais une mise à jour d'un paramètre interconnecté, toujours
   procéder à un mappage puis validation pour ne pas perdre des données. »
   ═══════════════════════════════════════════════════════════════════════ */
test("mappage : le plan chiffre l'impact table par table sans rien écrire", async () => {
  const it = (await request(app).get("/api/listes/modalites")
    .set("Authorization", `Bearer ${superToken}`)).body.items.find(x => x.code === "Voucher");
  const lignes = db.prepare("SELECT id FROM pdd LIMIT 2").all().map(x => x.id);
  for(const id of lignes) db.prepare("UPDATE pdd SET modality='Voucher' WHERE id=?").run(id);
  const attendu = db.prepare("SELECT COUNT(*) c FROM pdd WHERE modality='Voucher'").get().c;

  const r = await request(app).post(`/api/listes/modalites/${it.id}/renommer-code/plan`)
    .set("Authorization", `Bearer ${superToken}`).send({ nouveau:"Coupon" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const plan = r.body.plan;
  assert.equal(plan.mode, "renommer");
  assert.equal(plan.ancien, "Voucher");
  assert.equal(plan.nouveau, "Coupon");
  const corr = plan.correspondances.find(c => c.table === "pdd" && c.colonne === "modality");
  assert.ok(corr, JSON.stringify(plan.correspondances));
  assert.equal(corr.lignes, attendu);
  assert.equal(corr.de, "Voucher");
  assert.equal(corr.vers, "Coupon");
  assert.ok(plan.jeton && plan.jeton.length >= 16, "le plan porte son empreinte");

  /* Le mappage n'écrit RIEN : c'est toute sa raison d'être. */
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, "Voucher");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE modality='Voucher'").get().c, attendu);
});

test("validation : sans jeton, l'écriture est refusée et le plan est rendu", async () => {
  const it = (await request(app).get("/api/listes/modalites")
    .set("Authorization", `Bearer ${superToken}`)).body.items.find(x => x.code === "Voucher");
  const r = await request(app).post(`/api/listes/modalites/${it.id}/renommer-code`)
    .set("Authorization", `Bearer ${superToken}`).send({ nouveau:"Coupon", mode:"renommer" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(/mappage|correspondance/.test(r.body.error), r.body.error);
  assert.ok(r.body.plan.jeton, "le refus rend le plan, pour que l'écran le montre");
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, "Voucher");
});

test("validation : un plan périmé est refusé — on ne valide que ce qu'on a vu", async () => {
  const it = (await request(app).get("/api/listes/modalites")
    .set("Authorization", `Bearer ${superToken}`)).body.items.find(x => x.code === "Voucher");
  const p1 = await request(app).post(`/api/listes/modalites/${it.id}/renommer-code/plan`)
    .set("Authorization", `Bearer ${superToken}`).send({ nouveau:"Coupon" });
  const jetonVu = p1.body.plan.jeton;
  const impactVu = p1.body.plan.total;

  /* La base bouge entre l'affichage et le clic : une ligne de plus porte le code. */
  const autre = db.prepare("SELECT id FROM pdd WHERE modality<>'Voucher' LIMIT 1").get();
  db.prepare("UPDATE pdd SET modality='Voucher' WHERE id=?").run(autre.id);

  const refus = await request(app).post(`/api/listes/modalites/${it.id}/renommer-code`)
    .set("Authorization", `Bearer ${superToken}`)
    .send({ nouveau:"Coupon", mode:"renommer", jeton:jetonVu });
  assert.equal(refus.status, 409, JSON.stringify(refus.body));
  assert.ok(/a changé depuis/.test(refus.body.error), refus.body.error);
  assert.ok(refus.body.plan.total > impactVu, "le plan à jour compte la ligne apparue");
  assert.equal(db.prepare("SELECT code FROM list_item WHERE id=?").get(it.id).code, "Voucher",
    "rien n'a été écrit");

  /* Revalidé sur le plan À JOUR, le renommage passe. */
  const ok = await request(app).post(`/api/listes/modalites/${it.id}/renommer-code`)
    .set("Authorization", `Bearer ${superToken}`)
    .send({ nouveau:"Coupon", mode:"renommer", jeton:refus.body.plan.jeton });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.total, refus.body.plan.total);
  assert.equal(ok.body.reliquat, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM pdd WHERE modality='Voucher'").get().c, 0);
});

test("mappage : le plan d'une fusion annonce la disparition de l'item d'origine", async () => {
  const items = (await request(app).get("/api/listes/types_suivi")
    .set("Authorization", `Bearer ${superToken}`)).body.items;
  const source = items.find(x => x.code === "Post-distribution monitoring");
  const r = await request(app).post(`/api/listes/types_suivi/${source.id}/renommer-code/plan`)
    .set("Authorization", `Bearer ${superToken}`).send({ nouveau:"Distribution monitoring" });
  assert.equal(r.status, 200);
  assert.equal(r.body.plan.mode, "fusionner");
  assert.ok(r.body.plan.avertissements.some(a => /SUPPRIMÉ/.test(a)),
    JSON.stringify(r.body.plan.avertissements));
  assert.ok(r.body.plan.cible.code === "Distribution monitoring");
  /* Toujours rien d'écrit. */
  assert.ok(db.prepare("SELECT 1 FROM list_item WHERE id=?").get(source.id));
});

test("mappage : le plan est réservé au super, comme l'écriture qu'il prépare", async () => {
  const t = (await login("admincode@test.local", "AdminCodeMotDePasse1")).body.token;
  const it = (await request(app).get("/api/listes/durees")
    .set("Authorization", `Bearer ${t}`)).body.items[0];
  const r = await request(app).post(`/api/listes/durees/${it.id}/renommer-code/plan`)
    .set("Authorization", `Bearer ${t}`).send({ nouveau:"Autre durée" });
  assert.equal(r.status, 403, "un plan qui ne mène à aucune écriture possible n'a pas à être servi");
});

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8-5 — Semis des DONNÉES RÉELLES.

   « Dans les settings utilise mes data réels et stocke-les comme valeurs
   par défaut de MEMS. » Ce test lance le vrai script sur les vrais
   fichiers de `docs/`, dans une base à part pour ne pas troubler la
   suite. Il ne vaut que si les fichiers sont là : sur une copie du dépôt
   sans les documents, il se déclare non applicable plutôt que d'échouer.
   ═══════════════════════════════════════════════════════════════════════ */
const DOCS = path.resolve("../docs");
const CLASSEUR_REEL = path.join(DOCS, "WFP Indicator Master List_UpdMai_2025.xlsx");
const SHP_REEL = path.join(DOCS, "mdg_bnd_adm3_com_pam_2025.shp");
const SITES_REEL = path.join(DOCS, "List Sites per Tag.xlsx");

test("données réelles : activités et masterlist d'indicateurs chargées depuis le classeur du PAM",
  { skip: fs.existsSync(CLASSEUR_REEL) ? false : "docs/ ne contient pas le classeur du PAM" },
  async () => {
    const base = path.resolve("./data/test-reel.db");
    for(const f of [base, base+"-wal", base+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
    execFileSync(process.execPath, ["src/seed-reel.js", "--sans-geo"],
      { stdio:"pipe", env:{ ...process.env, DB_FILE:base } });

    const { default: Database } = await import("better-sqlite3");
    const d2 = new Database(base, { readonly:true });
    try{
      /* Les activités : l'onglet « Annex 5 Activity tags » en porte 58. */
      const actifs = d2.prepare("SELECT COUNT(*) c FROM activity_categories").get().c;
      assert.equal(actifs, 58, "les 58 tags d'activité du classeur sont chargés");
      const gd = d2.prepare("SELECT * FROM activity_categories WHERE tag='GD'").get();
      assert.equal(gd.name, "General Distribution", "le tag GD porte son intitulé réel");
      assert.ok(gd.program_area, "et son groupe d'intervention");
      /* Le domaine posé existe dans SA liste : le semis ne fabrique pas d'orphelin. */
      assert.ok(d2.prepare("SELECT 1 FROM list_item WHERE type='domaine' AND code=?")
        .get(gd.program_area), "le domaine est présent dans la liste des domaines");

      /* Les indicateurs : quatre onglets, quatre niveaux, chacun avec ses
         catégories thématiques — c'est ce qui rend l'écran filtrable. */
      const parNiveau = Object.fromEntries(d2.prepare(
        "SELECT level, COUNT(*) c FROM indicators GROUP BY level").all().map(x => [x.level, x.c]));
      assert.equal(parNiveau.outcome, 94,      "Annex 2 Outcome");
      assert.equal(parNiveau.output, 157,      "Annex 3 Output");
      assert.equal(parNiveau.other_output, 566,"Detailed Output");
      assert.equal(parNiveau.crosscutting, 25, "Annex 4 Crosscutting");
      assert.equal(parNiveau.sdg, 66,          "Annex 1 SDGs (codes dédoublonnés)");
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM indicators").get().c, 908);
      /* Les colonnes riches de la masterlist (migration 032) sont bien remplies
         par sous-groupe : statut partout, applicabilité en outcome, type et
         indicateur intermédiaire en détaillé. */
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM indicators WHERE status IS NOT NULL").get().c > 800,
        "le statut brut est chargé");
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM indicators WHERE level='outcome' AND applicability IS NOT NULL").get().c > 80,
        "l'applicabilité de l'Outcome est chargée");
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM indicators WHERE level='other_output' AND intermediate IS NOT NULL").get().c > 400,
        "l'indicateur intermédiaire du détaillé est chargé");
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM indicators WHERE kind<>'crf'").get().c, 0,
        "la masterlist est le cadre de résultats, pas du processus");
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM indicators WHERE category IS NULL").get().c, 0,
        "chaque indicateur porte sa catégorie");

      const fcs = d2.prepare("SELECT * FROM indicators WHERE name LIKE 'Food consumption score'").get();
      assert.ok(fcs, "le score de consommation alimentaire est là");
      assert.equal(fcs.level, "outcome");
      assert.equal(fcs.category, "1. Food security and essential needs");
      const cc = d2.prepare("SELECT * FROM indicators WHERE code='CC.1.1'").get();
      assert.equal(cc.category, "CC.1 Protection");
      assert.ok(d2.prepare("SELECT * FROM indicators WHERE code='A.1.1'").get().name
        .startsWith("Number of people receiving assistance"));

      /* Les catégories sont bien un axe de filtre : plusieurs par niveau. */
      const cats = d2.prepare(
        "SELECT COUNT(DISTINCT category) c FROM indicators WHERE level='outcome'").get().c;
      assert.equal(cats, 8, "les huit domaines programme de l'Annex 2");
    } finally { d2.close(); }
  });

test("données réelles : le semis est idempotent — relancé, il corrige sans dupliquer",
  { skip: fs.existsSync(CLASSEUR_REEL) ? false : "docs/ ne contient pas le classeur du PAM" },
  async () => {
    const base = path.resolve("./data/test-reel.db");
    execFileSync(process.execPath, ["src/seed-reel.js", "--sans-geo"],
      { stdio:"pipe", env:{ ...process.env, DB_FILE:base } });
    const { default: Database } = await import("better-sqlite3");
    const d2 = new Database(base, { readonly:true });
    try{
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM indicators").get().c, 908,
        "aucun doublon au second passage");
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM activity_categories").get().c, 58);
      /* La révision a bougé : les lignes ont bien été RELUES, pas ignorées. */
      assert.ok(d2.prepare("SELECT rev FROM indicators LIMIT 1").get().rev >= 2);
    } finally { d2.close(); }
  });

test("données réelles : le shapefile Madagascar donne l'arbre adm0→adm3 complet",
  { skip: fs.existsSync(SHP_REEL) ? false : "docs/ ne contient pas le shapefile Madagascar" },
  async () => {
    /* Le vrai fichier, lu par le vrai lecteur — mais sans écrire en base :
       ce test dit ce que le fichier CONTIENT, il ne bascule pas le millésime
       de la suite. */
    const { lireTable } = await import("../src/lib/shapefile.js");
    const { buildUnits } = await import("../src/lib/geo.js");
    const dbf = fs.readFileSync(SHP_REEL.replace(/\.shp$/, ".dbf"));
    const table = lireTable({ dbf });
    /* La correspondance des colonnes est trouvée seule sur un jeu COD-AB. */
    assert.equal(table.mapping.adm3, "ADM3_EN");
    assert.equal(table.mapping.pcode3, "ADM3_PCODE");
    const { units, counts, collisions } = buildUnits(table.lignes);
    assert.equal(counts.adm0, 1,     "un pays");
    assert.equal(counts.adm1, 24,    "les régions");
    assert.equal(counts.adm2, 120,   "les districts");
    assert.equal(counts.adm3, 1701,  "les communes");
    assert.equal(units.length, 1846);
    assert.equal(collisions.length, 0, "aucun p-code en double dans le fichier officiel");
  });

test("données réelles : les sites par tag sont importés, rattachés à l'arbre et géolocalisés",
  { skip: (fs.existsSync(SITES_REEL) && fs.existsSync(SHP_REEL))
      ? false : "docs/ ne contient pas le classeur des sites ou le shapefile Madagascar" },
  async () => {
    const base = path.resolve("./data/test-sites.db");
    for(const s of ["", "-shm", "-wal"]) { try{ fs.rmSync(base + s, { force:true }); }catch(e){} }
    /* Il faut l'arbre administratif (le shapefile) ET les activités (Annex 5)
       chargés avant : le rattachement se fait par chemin de noms, le tag long du
       fichier se rapproche d'une activité réelle. seed-reel charge les deux. */
    execFileSync(process.execPath, ["src/seed-reel.js"],
      { stdio:"pipe", env:{ ...process.env, DB_FILE:base } });
    execFileSync(process.execPath, ["src/import-sites.js"],
      { stdio:"pipe", env:{ ...process.env, DB_FILE:base } });

    const { default: Database } = await import("better-sqlite3");
    const d2 = new Database(base, { readonly:true });
    let total1;
    try{
      total1 = d2.prepare("SELECT COUNT(*) c FROM sites").get().c;
      assert.ok(total1 > 2000, `beaucoup de sites importés : ${total1}`);
      /* Chaque site importé est rattaché à l'arbre par son chemin de noms. */
      assert.equal(d2.prepare("SELECT COUNT(*) c FROM sites WHERE geo_pcode IS NULL").get().c, 0,
        "chaque site est rattaché à une unité administrative");
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM sites WHERE lat IS NOT NULL AND lon IS NOT NULL").get().c > 2000,
        "les sites portent leurs coordonnées GPS");
      /* Le tag long (« School feeding (on-site) »…) est rapproché d'une activité
         réelle du référentiel, qui pose le tag et la catégorie. */
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM sites WHERE category_id IS NOT NULL").get().c > 2000,
        "le tag du fichier est rapproché d'une activité du référentiel");
      /* Le POI_code d'origine est conservé comme code externe. */
      assert.ok(d2.prepare("SELECT COUNT(*) c FROM sites WHERE external_code IS NOT NULL").get().c > 2000,
        "le POI_code d'origine est conservé");
    } finally { d2.close(); }

    /* Idempotence : relancé, il met à jour au lieu de dupliquer. */
    execFileSync(process.execPath, ["src/import-sites.js"],
      { stdio:"pipe", env:{ ...process.env, DB_FILE:base } });
    const d3 = new Database(base, { readonly:true });
    try{
      assert.equal(d3.prepare("SELECT COUNT(*) c FROM sites").get().c, total1,
        "aucun doublon au second passage");
    } finally { d3.close(); }
  });

/* ═══════════════════════════════════════════════════════════════════════
   Chantier S8-6 — Un shapefile PAR NIVEAU sur le même millésime.

   « Durant la configuration pays, insérer plusieurs shapefiles : adm1 à
   adm4 pour pouvoir avoir un affichage par type de breakdown sur la carte
   après. » Le commit construit un millésime ; cette route-ci AJOUTE une
   maille de contours à celui qui existe.
   ═══════════════════════════════════════════════════════════════════════ */
/* Le millésime sur lequel portent les trois tests suivants. Il est pris du
   COMMIT qui vient de le créer, et non d'un `SELECT … WHERE is_current=1` :
   l'unicité du millésime courant est cloisonnée par pays (migration 013), et
   cette requête-là peut rendre le courant d'un autre pays. */
let vContours;
const deposerContours = (token, niveau, { shp, dbf, remplacer } = {}) => {
  let req = request(app).post("/api/geo/shapefile/contours")
    .set("Authorization", `Bearer ${token}`)
    .attach("fichier", shp ?? shpMdg(), "c.shp");
  if(dbf !== null) req = req.attach("fichier", dbf ?? dbfMdg(), "c.dbf");
  req = req.field("niveau", niveau);
  if(remplacer !== undefined) req = req.field("remplacer", String(remplacer));
  return req;
};

test("contours par niveau : un dépôt adm1 s'ajoute aux communes sans reconstruire l'arbre", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* On repart d'un millésime propre : l'arbre des trois communes COD-AB. */
  const commit = await commitShp(t, { label:"Millésime pour contours par niveau" });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  vContours = commit.body.versionId;
  const v = db.prepare("SELECT * FROM geo_version WHERE id=?").get(vContours);
  const versionsAvant = db.prepare("SELECT COUNT(*) c FROM geo_version").get().c;
  const unitesAvant = db.prepare("SELECT COUNT(*) c FROM geo_unit WHERE version_id=?").get(v.id).c;
  const adm3Avant = db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm3'").get(v.id).c;
  assert.ok(adm3Avant > 0, "le commit a posé les contours des communes");

  /* Un fichier de RÉGION : une seule colonne de niveau, donc une seule unité
     résolue — la région Anosy. Trois polygones y mènent, le dernier gagne. */
  const dbfRegion = forgeDbf([{ nom:"ADM1_PCODE", len:10 }, { nom:"ADM1_EN", len:12 }],
    LIGNES_MDG.map(l => ({ ADM1_PCODE:l.ADM1_PCODE, ADM1_EN:l.ADM1_EN })));
  const r = await deposerContours(t, "adm1", { dbf:dbfRegion });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.niveau ?? r.body.niveau, "adm1");
  assert.ok(r.body.écrites > 0, JSON.stringify(r.body));

  /* Aucun millésime créé, aucune unité touchée : c'est la différence avec le commit. */
  assert.equal(db.prepare("SELECT COUNT(*) c FROM geo_version").get().c, versionsAvant);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM geo_unit WHERE version_id=?").get(v.id).c,
    unitesAvant);
  /* Et les communes sont TOUJOURS là : déposer les régions ne les a pas effacées. */
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm3'").get(v.id).c, adm3Avant);
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm1'").get(v.id).c, 1);

  /* Le bilan par niveau vient du serveur, et il porte les deux mailles. */
  const niveaux = Object.fromEntries(r.body.parNiveau.map(x => [x.level, x.units]));
  assert.equal(niveaux.adm1, 1);
  assert.equal(niveaux.adm3, adm3Avant);

  /* La carte peut désormais demander l'une ou l'autre maille. */
  const carte1 = await request(app).get("/api/geo/geometry?level=adm1")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(carte1.body.features.length, 1);
  assert.equal(carte1.body.features[0].properties.level, "adm1");
  const carte3 = await request(app).get("/api/geo/geometry?level=adm3")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(carte3.body.features.length, adm3Avant);
});

test("contours par niveau : un fichier déposé au mauvais niveau est rejeté, pas écrit", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const v = db.prepare("SELECT * FROM geo_version WHERE id=?").get(vContours);
  const adm1Avant = db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm1'").get(v.id).c;

  /* Le fichier des COMMUNES annoncé comme régions : chaque polygone se résout
     à une commune, aucun n'est du niveau annoncé. */
  const r = await deposerContours(t, "adm1", { remplacer:false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.écrites, 0, "rien n'est écrit sous une étiquette fausse");
  assert.equal(r.body.rejetes, 3);
  assert.ok(/niveau adm3/.test(r.body.rejets[0].message), r.body.rejets[0].message);
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm1'").get(v.id).c, adm1Avant,
    "le niveau visé n'a pas bougé (dépôt sans remplacement)");
});

test("contours par niveau : le .dbf est exigé, et un millésime doit exister", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const sansDbf = await deposerContours(t, "adm2", { dbf:null });
  assert.equal(sansDbf.status, 422, JSON.stringify(sansDbf.body));
  assert.ok(/\.dbf est indispensable/.test(sansDbf.body.error), sansDbf.body.error);

  const mauvaisNiveau = await deposerContours(t, "adm9");
  assert.equal(mauvaisNiveau.status, 422);
});

test("contours par niveau : le retrait ne vise qu'une maille, et recompte le millésime", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const v = db.prepare("SELECT * FROM geo_version WHERE id=?").get(vContours);
  const adm3 = db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm3'").get(v.id).c;

  const r = await request(app).delete("/api/geo/geometry?level=adm1")
    .set("Authorization", `Bearer ${t}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.niveau, "adm1");
  assert.equal(r.body.supprimes, 1);
  assert.equal(r.body.reste, adm3, "les communes sont intactes");
  /* Le compteur du millésime est RECOMPTÉ, pas remis à zéro. */
  assert.equal(db.prepare("SELECT geom_units FROM geo_version WHERE id=?").get(v.id).geom_units,
    adm3);

  /* Sans niveau, tout part — et le millésime redevient sans contours. */
  const tout = await request(app).delete("/api/geo/geometry").set("Authorization", `Bearer ${t}`);
  assert.equal(tout.body.supprimes, adm3);
  assert.equal(tout.body.reste, 0);
  assert.equal(db.prepare("SELECT geom_units FROM geo_version WHERE id=?").get(v.id).geom_units, 0);
});

/* ═══════════════════════════════════════════════════════════════════════
   Dérivation des niveaux supérieurs par dissolution.

   « Pour le découpage géographique tu peux utiliser le dbf de adm3 ou adm4
   pour les dériver. » Un seul fichier — les communes — porte l'arbre
   entier dans sa table attributaire : les contours des districts et des
   régions sont ces mêmes polygones réunis par parent.
   ═══════════════════════════════════════════════════════════════════════ */
test("dissolution : deux carrés mitoyens n'en font qu'un, sans la frontière intérieure", async () => {
  const { dissoudre, sommets } = await import("../src/lib/dissoudre.js");
  /* Deux carrés qui partagent exactement l'arête x=1. Réunis, ils forment un
     rectangle de quatre coins — pas un assemblage de huit. */
  const gauche = { type:"Polygon", coordinates:[[[0,0],[0,1],[1,1],[1,0],[0,0]]] };
  const droite = { type:"Polygon", coordinates:[[[1,0],[1,1],[2,1],[2,0],[1,0]]] };
  const d = dissoudre([gauche, droite]);
  assert.equal(d.approximatif, false, d.motif);
  assert.equal(d.geometry.type, "Polygon");
  assert.equal(sommets(d.geometry), 5, "quatre coins et la fermeture");
  const xs = d.geometry.coordinates[0].map(p => p[0]);
  assert.equal(Math.min(...xs), 0);
  assert.equal(Math.max(...xs), 2);
  /* Le point (1,0) intérieur à l'arête disparue ne subsiste pas comme sommet
     isolé : la frontière est bien tombée. */
  assert.ok(!d.geometry.coordinates[0].some(p => p[0] === 1),
    JSON.stringify(d.geometry.coordinates[0]));
});

test("dissolution : deux carrés disjoints restent deux, et une enclave devient un trou", async () => {
  const { dissoudre } = await import("../src/lib/dissoudre.js");
  const a = { type:"Polygon", coordinates:[[[0,0],[0,1],[1,1],[1,0],[0,0]]] };
  const loin = { type:"Polygon", coordinates:[[[5,5],[5,6],[6,6],[6,5],[5,5]]] };
  const separes = dissoudre([a, loin]);
  assert.equal(separes.approximatif, false);
  assert.equal(separes.geometry.type, "MultiPolygon");
  assert.equal(separes.geometry.coordinates.length, 2);

  /* Un anneau carré (extérieur + trou) : le trou survit à la dissolution —
     c'est le cas de l'enclave appartenant à un autre parent. */
  const anneau = { type:"Polygon", coordinates:[
    [[0,0],[0,10],[10,10],[10,0],[0,0]],
    [[4,4],[6,4],[6,6],[4,6],[4,4]] ] };
  const d = dissoudre([anneau]);
  assert.equal(d.approximatif, false, d.motif);
  assert.equal(d.geometry.coordinates.length, 2, "l'extérieur et son trou");
});

test("dissolution : deux voisins qui ne partagent pas leurs sommets ne sont pas fusionnés d'office",
  async () => {
    const { dissoudre } = await import("../src/lib/dissoudre.js");
    /* Décalage de trois dix-millièmes de degré — une trentaine de mètres : les
       deux carrés se jouxtent à l'œil mais ne se touchent pas dans les données.
       La dissolution ne les recolle PAS : elle réunit ce qui est topologiquement
       adjacent, elle n'invente pas l'adjacence. La couture, elle, se referme
       parfaitement — chacun de son côté. */
    const a = { type:"Polygon", coordinates:[[[0,0],[0,1],[1,1],[1,0],[0,0]]] };
    const b = { type:"Polygon", coordinates:[[[1,0.0003],[1,1.0003],[2,1.0003],[2,0.0003],[1,0.0003]]] };
    const d = dissoudre([a, b]);
    assert.equal(d.approximatif, false, d.motif);
    assert.equal(d.geometry.type, "MultiPolygon");
    assert.equal(d.geometry.coordinates.length, 2, "les deux contours restent distincts");
  });

test("dérivation : les districts et la région naissent des communes du millésime", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  /* On repart du jeu COD-AB à trois communes : elles partagent une région et
     un district, l'arbre est donc adm1 → adm2 → adm3. */
  const commit = await commitShp(t, { label:"Millésime pour dérivation" });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  const vid = commit.body.versionId;
  const compte = (l) => db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level=?").get(vid, l).c;
  assert.equal(compte("adm3"), 3);
  assert.equal(compte("adm2"), 0, "rien au-dessus avant la dérivation");

  const r = await request(app).post("/api/geo/geometry/deriver")
    .set("Authorization", `Bearer ${t}`).send({});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, "adm3", "le niveau le plus fin sert de départ");
  assert.equal(compte("adm2"), 1, "le district est dérivé");
  assert.equal(compte("adm1"), 1, "la région aussi");
  assert.equal(compte("adm3"), 3, "et les communes sont intactes");

  /* Le cadre d'un parent dérivé est exactement celui de ses enfants réunis :
     c'est ce qui dit que rien n'a été perdu ni ajouté. */
  const cadre = db.prepare(`SELECT p.min_lon pl, p.min_lat pb, p.max_lon pr, p.max_lat pt,
      MIN(c.min_lon) cl, MIN(c.min_lat) cb, MAX(c.max_lon) cr, MAX(c.max_lat) ct
    FROM geo_geom p
    JOIN geo_unit u  ON u.pcode=p.pcode AND u.version_id=p.version_id
    JOIN geo_unit uc ON uc.parent_pcode=u.pcode AND uc.version_id=u.version_id
    JOIN geo_geom c  ON c.pcode=uc.pcode AND c.version_id=uc.version_id
    WHERE p.version_id=? AND p.level='adm2' GROUP BY p.pcode`).get(vid);
  assert.equal(cadre.pl, cadre.cl); assert.equal(cadre.pb, cadre.cb);
  assert.equal(cadre.pr, cadre.cr); assert.equal(cadre.pt, cadre.ct);

  /* Deuxième passage : un niveau déjà pourvu n'est pas recalculé en silence. */
  const encore = await request(app).post("/api/geo/geometry/deriver")
    .set("Authorization", `Bearer ${t}`).send({});
  assert.equal(encore.body.total, 0, JSON.stringify(encore.body.etapes));
  assert.ok(encore.body.etapes.some(e => /déjà présents/.test(e.saute || "")),
    JSON.stringify(encore.body.etapes));
  /* Sauf demande explicite. */
  const force = await request(app).post("/api/geo/geometry/deriver")
    .set("Authorization", `Bearer ${t}`).send({ remplacerExistants:true });
  assert.ok(force.body.total > 0, JSON.stringify(force.body));

  /* Et la carte sert désormais les trois mailles. */
  for(const [niv, n] of [["adm1",1],["adm2",1],["adm3",3]]){
    const c = await request(app).get(`/api/geo/geometry?level=${niv}`)
      .set("Authorization", `Bearer ${t}`);
    assert.equal(c.body.features.length, n, `la carte sert ${niv}`);
  }
});

test("dérivation : refusée sans contours, et réservée à l'administration", async () => {
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  await request(app).delete("/api/geo/geometry").set("Authorization", `Bearer ${t}`);
  const vide = await request(app).post("/api/geo/geometry/deriver")
    .set("Authorization", `Bearer ${t}`).send({});
  assert.equal(vide.status, 409, JSON.stringify(vide.body));
  assert.ok(/aucun contour/.test(vide.body.error), vide.body.error);

  const te = (await login("listedit@test.local", "ListEditMotDePasse1")).body.token;
  assert.equal((await request(app).post("/api/geo/geometry/deriver")
    .set("Authorization", `Bearer ${te}`).send({})).status, 403);
});

test("contours : redéposer un niveau fin dérive AUTOMATIQUEMENT les niveaux au-dessus", async () => {
  /* Demande utilisateur : « si je remplace le niveau 3 ou 4 seulement, le
     dériver devrait se faire automatiquement ». On repart d'un millésime
     propre à trois communes, sans niveaux supérieurs. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const commit = await commitShp(t, { label:"Millésime pour dérivation auto" });
  assert.equal(commit.status, 200, JSON.stringify(commit.body));
  const vid = commit.body.versionId;
  const compte = (l) => db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level=?").get(vid, l).c;
  assert.equal(compte("adm3"), 3);
  assert.equal(compte("adm2"), 0, "rien au-dessus au départ");
  assert.equal(compte("adm1"), 0);

  /* Un dépôt du niveau le plus fin (les communes), remplaçant. Aucune requête
     de dérivation n'est envoyée : elle doit partir seule. */
  const r = await deposerContours(t, "adm3", { remplacer:true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.écrites > 0, JSON.stringify(r.body));
  /* Le district et la région sont nés sans qu'on les demande. */
  assert.equal(compte("adm2"), 1, "le district dérivé automatiquement");
  assert.equal(compte("adm1"), 1, "la région dérivée automatiquement");
  /* Et la réponse le dit, en clair et par niveau. */
  assert.ok(r.body.derivation, "la réponse porte le compte-rendu de dérivation");
  assert.ok(r.body.derivation.etapes.some(e => e.niveau === "adm2" && e.ecrites > 0),
    JSON.stringify(r.body.derivation));
  assert.ok(r.body.derivation.etapes.some(e => e.niveau === "adm1" && e.ecrites > 0),
    JSON.stringify(r.body.derivation));
  assert.ok(/dériv/i.test(r.body.message), r.body.message);
  const niveaux = Object.fromEntries(r.body.parNiveau.map(x => [x.level, x.units]));
  assert.equal(niveaux.adm1, 1, "le bilan par niveau inclut les niveaux dérivés");
  assert.equal(niveaux.adm2, 1);

  /* Les contours dérivés portent bien la marque « dérivé de … » : c'est elle
     qui autorisera un futur rafraîchissement automatique sans écraser un import. */
  const src = db.prepare(
    "SELECT source FROM geo_geom WHERE version_id=? AND level='adm2' LIMIT 1").get(vid).source;
  assert.ok(/^dérivé/.test(src), src);
});

test("contours : la dérivation auto n'écrase PAS un niveau supérieur importé à la main", async () => {
  /* Le garde-fou : un contour officiel vaut mieux qu'un calcul. Si la région a
     été importée depuis un vrai fichier, redéposer les communes ne doit pas la
     remplacer par une dissolution. */
  const t = (await login("admin@test.local", "MotDePasseTest2026")).body.token;
  const commit = await commitShp(t, { label:"Millésime dérivation vs import" });
  const vid = commit.body.versionId;

  /* On importe une région « officielle » — source = nom de fichier, pas « dérivé ». */
  const dbfRegion = forgeDbf([{ nom:"ADM1_PCODE", len:10 }, { nom:"ADM1_EN", len:12 }],
    LIGNES_MDG.map(l => ({ ADM1_PCODE:l.ADM1_PCODE, ADM1_EN:l.ADM1_EN })));
  const imp = await deposerContours(t, "adm1", { dbf:dbfRegion });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const srcAvant = db.prepare(
    "SELECT source FROM geo_geom WHERE version_id=? AND level='adm1' LIMIT 1").get(vid).source;
  assert.ok(!/^dérivé/.test(srcAvant), `la région importée n'est pas marquée dérivée : ${srcAvant}`);

  /* On redépose les communes : adm2 (vide) doit se dériver, adm1 (officiel) NON. */
  const r = await deposerContours(t, "adm3", { remplacer:true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const srcApres = db.prepare(
    "SELECT source FROM geo_geom WHERE version_id=? AND level='adm1' LIMIT 1").get(vid).source;
  assert.equal(srcApres, srcAvant, "la région officielle est intacte");
  assert.ok((r.body.derivation?.etapes || []).some(e => e.niveau === "adm1" && e.saute),
    JSON.stringify(r.body.derivation));
  /* Le district, lui, était vide : il se dérive. */
  assert.equal(db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=? AND level='adm2'").get(vid).c, 1);
});

/* ═══════════════════════════════════════════════════════════════════════
   « Liste des activités = activity tag (valeur unique) ».

   Le tag est la clé de jointure de dix colonnes de texte : deux activités
   qui le partagent rendent ces colonnes ambiguës, et aucune requête ne
   peut dire laquelle des deux elles désignent (migration 028).
   ═══════════════════════════════════════════════════════════════════════ */
test("activité : le tag est unique, et le doublon est refusé en nommant l'activité en place", async () => {
  const existante = db.prepare("SELECT * FROM activity_categories LIMIT 1").get();
  const r = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Une autre activité qui vole un tag", tag: existante.tag.toLowerCase() });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.ok(new RegExp(existante.name.slice(0, 12)).test(r.body.error), r.body.error);
  assert.ok(/clé de jointure/.test(r.body.error), r.body.error);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM activity_categories WHERE tag=? COLLATE NOCASE")
    .get(existante.tag).c, 1);
});

test("activité : un tag espacé est normalisé, pas dédoublé", async () => {
  /* « FBA _CCS » et « FBA_CCS » sont le même tag : le classeur du PAM porte
     les deux écritures, et les laisser cohabiter ferait deux activités. */
  const a = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Activité à tag espacé", tag:"  tst _esp  " });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.activity.tag, "TST_ESP");

  const b = await request(app).post("/api/activities").set("Authorization", `Bearer ${adminToken}`)
    .send({ name:"Le même tag autrement écrit", tag:"TST _ ESP" });
  assert.equal(b.status, 409, "la seconde écriture du même tag est refusée");

  /* Et la base elle-même refuse, index unique à l'appui : la garde de la
     route n'est pas la seule défense. */
  assert.throws(() => db.prepare(
    "INSERT INTO activity_categories (id,name,tag) VALUES ('act_dbl','Doublon direct','tst_esp')").run(),
    /UNIQUE/);
  await request(app).delete(`/api/activities/${a.body.activity.id}`)
    .set("Authorization", `Bearer ${adminToken}`);
});

test("activité : aucun tag en double dans le référentiel servi", async () => {
  const r = await request(app).get("/api/activities").set("Authorization", `Bearer ${adminToken}`);
  const tags = r.body.activities.map(a => a.tag.toUpperCase());
  assert.equal(new Set(tags).size, tags.length,
    "la liste des activités est la liste des tags, chacun une fois");
  assert.ok(tags.every(t => t && !/\s/.test(t)), "aucun tag vide ni espacé");
});
