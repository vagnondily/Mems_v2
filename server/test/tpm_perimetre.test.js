import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import request from "supertest";
import pg from "pg";

/* Suivi tiers — le PÉRIMÈTRE géographique du contrat. Le contrat définit les
   communes (ou districts) éligibles ; un plan mensuel ne peut affecter que des
   zones qui en relèvent. */

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.TPM_DATABASE_URL
  || "postgres://mems:mems_dev_pw@127.0.0.1:5432/mems_tpm";
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
  if(!(await sys.query("SELECT 1 FROM pg_database WHERE datname=$1", [nom])).rowCount)
    await sys.query(`CREATE DATABASE ${nom}`);
  await sys.end();
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await admin.query("DROP SCHEMA IF EXISTS test CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.end();
}
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db, close } = await import("../src/db.js");
await db.prepare("UPDATE users SET must_change_pw=0 WHERE email=?").run("admin@test.local");
after(async () => { await close(); });

let tok;
const H = () => ({ Authorization: `Bearer ${tok}` });

test("périmètre TPM : un plan n'affecte que des zones que le contrat confie", async () => {
  tok = (await request(app).post("/api/auth/login")
    .send({ email:"admin@test.local", password:"MotDePasseTest2026" })).body.token;
  assert.ok(tok);

  /* Deux communes sous DEUX districts différents : l'une servira de zone
     éligible, l'autre de zone hors périmètre. Prises dans le référentiel de
     démonstration, dont les pcodes sont générés à chaque semis. */
  const commA = await db.prepare(
    "SELECT pcode, name, parent_pcode FROM geo_unit WHERE level='adm3' ORDER BY path LIMIT 1").get();
  const districtA = commA.parent_pcode;
  const commB = await db.prepare(
    "SELECT pcode, name FROM geo_unit WHERE level='adm3' AND parent_pcode<>? ORDER BY path LIMIT 1")
    .get(districtA);
  assert.ok(commA.pcode && commB.pcode && commA.pcode !== commB.pcode);

  /* Un contrat actif du jeu de démonstration, et un plan neuf pour un mois
     libre (2031-01 n'est pas semé). */
  const contrat = await db.prepare("SELECT id, tpm_id, ref FROM tpm_contract WHERE status='actif' LIMIT 1").get();
  assert.ok(contrat, "le jeu de démonstration porte un contrat actif");
  const plan = await request(app).post("/api/tpm/plans").set(H())
    .send({ tpm_id:contrat.tpm_id, contract_id:contrat.id, year:2031, month:0 });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  const planId = plan.body.id;

  const poserZone = (geo_pcode) => request(app).put(`/api/tpm/plans/${planId}/zones`).set(H())
    .send({ zones:[{ geo_pcode, team_label:"Équipe 1", supervisors:1, agents:2, days:5 }] });

  /* ── Périmètre vide : aucune borne, toute commune du référentiel passe ─── */
  const libre = await poserZone(commB.pcode);
  assert.equal(libre.status, 200, JSON.stringify(libre.body));

  /* ── On confie au contrat la SEULE commune A ─────────────────────────── */
  const perim = await request(app).put(`/api/tpm/contracts/${contrat.id}/zones`).set(H())
    .send({ zones:[commA.pcode] });
  assert.equal(perim.status, 200, JSON.stringify(perim.body));
  assert.equal(perim.body.zones.length, 1);
  assert.equal(perim.body.zones[0].geo_pcode, commA.pcode);
  assert.ok(perim.body.zones[0].zone, "le périmètre est rendu avec le nom résolu de la commune");

  /* La commune B (hors périmètre) est refusée, en la nommant. */
  const refus = await poserZone(commB.pcode);
  assert.equal(refus.status, 422, JSON.stringify(refus.body));
  assert.match(refus.body.error, /hors du périmètre/);
  assert.ok(refus.body.details.some(d => d.message === commB.pcode));

  /* La commune A (dans le périmètre) passe. */
  const ok = await poserZone(commA.pcode);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.plan.zones[0].geo_pcode, commA.pcode);

  /* ── On confie le DISTRICT de A : sa commune A devient éligible par héritage ── */
  const perimDistrict = await request(app).put(`/api/tpm/contracts/${contrat.id}/zones`).set(H())
    .send({ zones:[districtA] });
  assert.equal(perimDistrict.status, 200, JSON.stringify(perimDistrict.body));
  const parHeritage = await poserZone(commA.pcode);
  assert.equal(parHeritage.status, 200,
    "une commune sous un district affecté est éligible par héritage du chemin");
  /* Mais B, sous un autre district, reste hors périmètre. */
  assert.equal((await poserZone(commB.pcode)).status, 422);

  /* ── Le plan expose le périmètre éligible pour borner le sélecteur ─────── */
  const detail = await request(app).get(`/api/tpm/plans/${planId}`).set(H());
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.plan.eligibleZones), "le détail du plan porte le périmètre");
  assert.ok(detail.body.plan.eligibleZones.some(z => z.geo_pcode === districtA));

  /* ── Un pcode absent du référentiel est refusé à la définition du périmètre ── */
  const faux = await request(app).put(`/api/tpm/contracts/${contrat.id}/zones`).set(H())
    .send({ zones:["PCODE-QUI-N-EXISTE-PAS"] });
  assert.equal(faux.status, 422, JSON.stringify(faux.body));
  assert.match(faux.body.error, /absentes du référentiel/);

  /* ── Vider le périmètre rétablit l'absence de borne ───────────────────── */
  const vider = await request(app).put(`/api/tpm/contracts/${contrat.id}/zones`).set(H())
    .send({ zones:[] });
  assert.equal(vider.status, 200);
  assert.equal(vider.body.zones.length, 0);
  assert.equal((await poserZone(commB.pcode)).status, 200,
    "sans périmètre, la commune B repasse");
});
