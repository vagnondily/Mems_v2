import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import request from "supertest";
import pg from "pg";

/* Le MIROIR (mode test) : un instantané isolé de la production dans le schéma
   `test`. On y écrit sans toucher à la prod, et il reste figé à l'instant du
   clic — écrire en prod ensuite ne remonte pas dans le miroir. */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.MIROIR_DATABASE_URL
  || "postgres://mems:mems_dev_pw@127.0.0.1:5432/mems_miroir";
process.env.JWT_SECRET = "x".repeat(48);
process.env.DATA_KEY = "y".repeat(48);
process.env.BOOTSTRAP_EMAIL = "admin@test.local";
process.env.BOOTSTRAP_PASSWORD = "MotDePasseTest2026";
process.env.RATE_LOGIN_MAX = "50";
process.env.RATE_API_MAX = "100000";
process.env.BCRYPT_ROUNDS = "4";
process.env.FORCE_SEED = "1";

{
  const sys = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\/[^/]+$/, "/postgres") });
  await sys.connect();
  const nom = new URL(process.env.DATABASE_URL).pathname.slice(1);
  const existe = await sys.query("SELECT 1 FROM pg_database WHERE datname=$1", [nom]);
  if(!existe.rowCount) await sys.query(`CREATE DATABASE ${nom}`);
  await sys.end();

  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  /* On repart d'un schéma public vide ET d'un éventuel schéma test résiduel. */
  await admin.query("DROP SCHEMA IF EXISTS test CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
}
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db, pool, close } = await import("../src/db.js");
await db.prepare("UPDATE users SET must_change_pw=0 WHERE email=?").run("admin@test.local");
after(async () => { await close(); });

let tok;
const H = (extra = {}) => ({ Authorization: `Bearer ${tok}`, ...extra });
const TEST = { "X-MEMS-Env": "test" };

/* Combien de sites dans un schéma, lu DIRECTEMENT (hors application). */
const sitesDans = async (schema) =>
  (await pool.query(`SELECT count(*)::int c FROM ${schema}.sites`)).rows[0].c;

test("miroir : activer clone la prod, on y écrit sans la toucher, il reste figé, désactiver le jette", async () => {
  tok = (await request(app).post("/api/auth/login")
    .send({ email:"admin@test.local", password:"MotDePasseTest2026" })).body.token;
  assert.ok(tok);

  /* ── Au départ, aucun miroir ─────────────────────────────────────────── */
  const etat0 = await request(app).get("/api/miroir").set(H());
  assert.equal(etat0.status, 200);
  assert.equal(etat0.body.actif, false, "aucun miroir avant activation");

  /* Une requête qui DEMANDE le miroir alors qu'il n'existe pas reste en prod :
     l'en-tête est sans effet tant qu'aucun miroir n'a été pris. */
  const avantSites = (await request(app).get("/api/sites?limit=1").set(H(TEST))).body;
  assert.ok(avantSites, "la requête « test » sans miroir répond quand même (sur la prod)");

  const prodSites0 = await sitesDans("public");
  assert.ok(prodSites0 > 0, "la démonstration a bien peuplé la production");

  /* ── Activer : instantané cloné ──────────────────────────────────────── */
  const act = await request(app).post("/api/miroir/activer").set(H());
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.actif, true);
  assert.ok(act.body.tables >= 50, `le clone reprend toutes les tables (${act.body.tables})`);
  assert.equal(act.body.lignes.sites, prodSites0, "le miroir part avec autant de sites que la prod");
  assert.ok(act.body.instantane, "l'instantané est daté");
  assert.equal(await sitesDans("test"), prodSites0, "le schéma test existe et est peuplé");

  /* ── Écrire DANS le miroir ne touche pas la prod ─────────────────────── */
  const creTest = await request(app).post("/api/sites").set(H(TEST))
    .send({ code:"MIROIR-1", name:"Site créé dans le miroir", activity_tag:"SMP", adm4:"Fkt Test" });
  assert.equal(creTest.status, 201, JSON.stringify(creTest.body));

  assert.equal(await sitesDans("test"), prodSites0 + 1, "le site est écrit dans le miroir");
  assert.equal(await sitesDans("public"), prodSites0, "la production est intacte");

  /* L'application le voit en mode test, pas en prod. */
  const vuTest = await request(app).get("/api/sites?search=MIROIR-1&limit=2000").set(H(TEST));
  assert.ok((vuTest.body.sites || vuTest.body.rows || []).some(s => s.code === "MIROIR-1"),
    "le site du miroir est visible en mode test");
  const vuProd = await request(app).get("/api/sites?search=MIROIR-1&limit=2000").set(H());
  assert.ok(!(vuProd.body.sites || vuProd.body.rows || []).some(s => s.code === "MIROIR-1"),
    "le site du miroir est invisible en production");

  /* ── Le miroir est FIGÉ : écrire en prod ne remonte pas dedans ────────── */
  const creProd = await request(app).post("/api/sites").set(H())
    .send({ code:"PROD-APRES", name:"Site créé en prod après l'instantané", activity_tag:"SMP", adm4:"Fkt Prod" });
  assert.equal(creProd.status, 201, JSON.stringify(creProd.body));
  assert.equal(await sitesDans("public"), prodSites0 + 1, "la prod a bien gagné son site");
  assert.equal(await sitesDans("test"), prodSites0 + 1,
    "le miroir n'a PAS vu la nouvelle écriture de prod : il reste l'instantané de l'instant t");
  const cherche = await request(app).get("/api/sites?search=PROD-APRES&limit=2000").set(H(TEST));
  assert.ok(!(cherche.body.sites || cherche.body.rows || []).some(s => s.code === "PROD-APRES"),
    "le site de prod postérieur à l'instantané n'apparaît pas dans le miroir");

  /* ── Rafraîchir reprend un instantané neuf ───────────────────────────── */
  const raf = await request(app).post("/api/miroir/rafraichir").set(H());
  assert.equal(raf.status, 200, JSON.stringify(raf.body));
  assert.equal(raf.body.lignes.sites, prodSites0 + 1, "le nouvel instantané inclut le site de prod");
  const chercheRaf = await request(app).get("/api/sites?search=PROD-APRES&limit=2000").set(H(TEST));
  assert.ok((chercheRaf.body.sites || chercheRaf.body.rows || []).some(s => s.code === "PROD-APRES"),
    "après rafraîchissement, le site de prod est dans le miroir");
  const chercheMir = await request(app).get("/api/sites?search=MIROIR-1&limit=2000").set(H(TEST));
  assert.ok(!(chercheMir.body.sites || chercheMir.body.rows || []).some(s => s.code === "MIROIR-1"),
    "le rafraîchissement a jeté l'ancien bac à sable : le site MIROIR-1 a disparu");

  /* ── Désactiver : le schéma test disparaît, la prod reste ─────────────── */
  const des = await request(app).post("/api/miroir/desactiver").set(H());
  assert.equal(des.status, 200, JSON.stringify(des.body));
  assert.equal(des.body.actif, false);
  const schema = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name='test'");
  assert.equal(schema.rowCount, 0, "le schéma test a été supprimé");
  assert.equal(await sitesDans("public"), prodSites0 + 1, "la production est intacte après désactivation");
  const etatFin = await request(app).get("/api/miroir").set(H());
  assert.equal(etatFin.body.actif, false);
});

test("miroir : activer est réservé au super-utilisateur", async () => {
  /* Un compte de terrain n'administre pas l'installation : il ne prend pas
     d'instantané. On crée un tel compte et on vérifie le refus. */
  const bureau = (await db.prepare("SELECT id FROM offices WHERE kind='field' LIMIT 1").get()).id;
  const hash = (await import("../src/lib/auth.js")).hashPassword;
  const { newId } = await import("../src/lib/crypto.js");
  const pw = await hash("TerrainMotDePasse1");
  await db.prepare(`INSERT INTO users (id,email,pw_hash,first_name,role,office_id,active,must_change_pw)
                    VALUES (?,?,?,?, 'viewer', ?, 1, 0)`)
    .run(newId("user"), "champ@test.local", pw, "Champ", bureau);
  const t = (await request(app).post("/api/auth/login")
    .send({ email:"champ@test.local", password:"TerrainMotDePasse1" })).body.token;
  assert.ok(t, "le compte de terrain se connecte");

  const refus = await request(app).post("/api/miroir/activer").set({ Authorization:`Bearer ${t}` });
  assert.equal(refus.status, 403, "activer le miroir est refusé au terrain");

  /* Lire l'état, en revanche, lui est ouvert. */
  const etat = await request(app).get("/api/miroir").set({ Authorization:`Bearer ${t}` });
  assert.equal(etat.status, 200);
});
