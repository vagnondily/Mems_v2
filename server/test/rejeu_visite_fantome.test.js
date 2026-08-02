import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import request from "supertest";

/* Régression : le rejeu en masse du rattachement (POST /submissions/rattacher,
   {toutes:true}) qui DÉTACHE une soumission (son code externe est devenu ambigu
   après l'ajout d'un second site) doit RETIRER la visite ODK qu'elle avait fait
   naître et redémarquer le mois — comme le font /detacher et /rattacher-a. Sinon
   une visite fantôme et un site_months.done=1 restaient sur l'ancien site,
   gonflant la couverture (grave à l'échelle de milliers de soumissions). */

const DB = path.resolve("./data/test_rejeu_fantome.db");
process.env.NODE_ENV = "test";
process.env.DB_FILE = DB;
process.env.JWT_SECRET = "x".repeat(48);
process.env.DATA_KEY = "y".repeat(48);
process.env.BOOTSTRAP_EMAIL = "admin@test.local";
process.env.BOOTSTRAP_PASSWORD = "MotDePasseTest2026";
process.env.RATE_LOGIN_MAX = "50";
process.env.RATE_API_MAX = "100000";
process.env.BCRYPT_ROUNDS = "4";
process.env.FORCE_SEED = "1";

for(const f of [DB, DB+"-wal", DB+"-shm"]) if(fs.existsSync(f)) fs.unlinkSync(f);
fs.mkdirSync(path.dirname(DB), { recursive:true });
execFileSync(process.execPath, ["src/seed.js"], { stdio:"pipe", env: process.env });

const { default: app } = await import("../src/index.js");
const { db } = await import("../src/db.js");
db.prepare("UPDATE users SET must_change_pw=0 WHERE email=?").run("admin@test.local");

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
  const sub = db.prepare("SELECT * FROM submissions WHERE instance_id=?").get("repro-1");
  assert.equal(sub.site_id, siteA, "la soumission est rattachée à A par son code externe");

  const suivi = await request(app).post("/api/submissions/suivi").set(H())
    .send({ year:2026, month:10, site_id:siteA });
  assert.equal(suivi.status, 200, JSON.stringify(suivi.body));
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(siteA).c, 1);
  assert.equal(db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=10").get(siteA).done, 1);

  /* Un second site porte le MÊME code externe → « REPRO-CODE » devient ambigu. */
  const b = await request(app).post("/api/sites").set(H())
    .send({ code:"REPRO-B", external_code:"REPRO-CODE", name:"Repro Site B", activity_tag:"NTA", adm4:"Fkt B" });
  assert.equal(b.status, 201, JSON.stringify(b.body));

  const rejeu = await request(app).post("/api/submissions/rattacher").set(H()).send({ toutes:true });
  assert.equal(rejeu.status, 200, JSON.stringify(rejeu.body));
  assert.equal(db.prepare("SELECT site_id FROM submissions WHERE instance_id=?").get("repro-1").site_id, null,
    "la soumission est détachée (code ambigu)");
  assert.ok(rejeu.body.detachees >= 1);

  /* Le correctif : plus de visite fantôme, plus de mois réalisé sur A. */
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE site_id=?").get(siteA).c, 0,
    "la visite fantôme a été retirée de A");
  assert.equal(db.prepare("SELECT done FROM site_months WHERE site_id=? AND year=2026 AND month=10").get(siteA).done, 0,
    "le mois est retombé à non réalisé sur A");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM visits WHERE submission_id=?").get(sub.id).c, 0,
    "aucune visite ne pointe encore sur la soumission détachée");
});
