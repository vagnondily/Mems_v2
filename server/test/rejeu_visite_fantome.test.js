import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import request from "supertest";
import pg from "pg";

/* Régression : le rejeu en masse du rattachement (POST /submissions/rattacher,
   {toutes:true}) qui DÉTACHE une soumission (son code externe est devenu ambigu
   après l'ajout d'un second site) doit RETIRER la visite ODK qu'elle avait fait
   naître et redémarquer le mois — comme le font /detacher et /rattacher-a. Sinon
   une visite fantôme et un site_months.done=1 restaient sur l'ancien site,
   gonflant la couverture (grave à l'échelle de milliers de soumissions). */

/* Base Postgres dédiée à ce test, remise à zéro à chaque exécution — comme
   api.test.js. `mems_rejeu` est créée par le harnais CI / le poste local. */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.REJEU_DATABASE_URL
  || "postgres://mems:mems_dev_pw@127.0.0.1:5432/mems_rejeu";
process.env.JWT_SECRET = "x".repeat(48);
process.env.DATA_KEY = "y".repeat(48);
process.env.BOOTSTRAP_EMAIL = "admin@test.local";
process.env.BOOTSTRAP_PASSWORD = "MotDePasseTest2026";
process.env.RATE_LOGIN_MAX = "50";
process.env.RATE_API_MAX = "100000";
process.env.BCRYPT_ROUNDS = "4";
process.env.FORCE_SEED = "1";

{
  /* Créer la base si besoin (CI), puis repartir d'un schéma vide. */
  const sys = new pg.Client({ connectionString: process.env.DATABASE_URL.replace(/\/[^/]+$/, "/postgres") });
  await sys.connect();
  const nom = new URL(process.env.DATABASE_URL).pathname.slice(1);
  const existe = await sys.query("SELECT 1 FROM pg_database WHERE datname=$1", [nom]);
  if(!existe.rowCount) await sys.query(`CREATE DATABASE ${nom}`);
  await sys.end();

  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
}
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db, close } = await import("../src/db.js");
await db.prepare("UPDATE users SET must_change_pw=0 WHERE email=?").run("admin@test.local");
/* Fermer le pool à la fin, sinon node --test reste suspendu (voir api.test.js). */
after(async () => { await close(); });

let tok;
const H = () => ({ Authorization: `Bearer ${tok}` });

test("rejeu {toutes:true} : une soumission détachée n'abandonne ni visite fantôme ni mois réalisé", async () => {
  tok = (await request(app).post("/api/auth/login")
    .send({ email:"admin@test.local", password:"MotDePasseTest2026" })).body.token;
  assert.ok(tok);

  const a = await request(app).post("/api/sites").set(H())
    .send({ code:"REPRO-A", external_code:"REPRO-CODE", name:"Repro Site A", activity_tag:"SMP", adm4:"Fkt A" });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const siteA = a.body.site.id;

  const v = await request(app).post("/api/submissions/ingest").set(H())
    .send({ form_id:"SMP_2025", enregistrements:[
      { instance_id:"repro-1", SvyDate:"2026-11-12", site_code:"REPRO-CODE" }]});
  assert.equal(v.status, 200, JSON.stringify(v.body));
  const sub = await db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("repro-1");
  assert.equal(sub.site_id, siteA, "la soumission est rattachée à A par son code externe");

  const suivi = await request(app).post("/api/submissions/suivi").set(H())
    .send({ year:2026, month:10, site_id:siteA });
  assert.equal(suivi.status, 200, JSON.stringify(suivi.body));
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(siteA)).c, 1);
  assert.equal((await db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=10").get(siteA)).done, 1);

  /* Un second site porte le MÊME code externe → « REPRO-CODE » devient ambigu. */
  const b = await request(app).post("/api/sites").set(H())
    .send({ code:"REPRO-B", external_code:"REPRO-CODE", name:"Repro Site B", activity_tag:"NTA", adm4:"Fkt B" });
  assert.equal(b.status, 201, JSON.stringify(b.body));

  const rejeu = await request(app).post("/api/submissions/rattacher").set(H()).send({ toutes:true });
  assert.equal(rejeu.status, 200, JSON.stringify(rejeu.body));
  assert.equal((await db.prepare("SELECT site_id FROM submissions WHERE instance_id=?").get("repro-1")).site_id, null,
    "la soumission est détachée (code ambigu)");
  assert.ok(rejeu.body.detachees >= 1);

  /* Le correctif : plus de visite fantôme, plus de mois réalisé sur A. */
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(siteA)).c, 0,
    "la visite fantôme a été retirée de A");
  assert.equal((await db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=10").get(siteA)).done, 0,
    "le mois est retombé à non réalisé sur A");
  assert.equal((await db.prepare("SELECT COUNT(*) c FROM visits WHERE submission_id=?").get(sub.id)).c, 0,
    "aucune visite ne pointe encore sur la soumission détachée");
});
