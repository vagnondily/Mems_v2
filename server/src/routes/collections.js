import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { encrypt } from "../lib/crypto.js";
import { requireCap, can } from "../lib/auth.js";

const r = Router();
const S = (max=200) => z.string().max(max).nullish().transform(v => v ?? null);
const N = (min=0, max=1e12) => z.coerce.number().min(min).max(max).default(0);
const I = (min=0, max=1e9) => z.coerce.number().int().min(min).max(max).default(0);
const B = z.union([z.boolean(), z.number(), z.string()]).transform(v =>
  (v===true || v===1 || v==="1" || v==="true") ? 1 : 0);

/* Chaque collection déclare sa table, le droit exigé, sa forme et sa projection en colonnes.
   Une écriture remplace la collection entière dans une transaction :
   les lignes absentes du corps sont supprimées, les autres insérées ou mises à jour. */
const COLLECTIONS = {
  params: { table:"coverage_params", cap:"edit",
    schema: z.object({ id:S(64), csp:S(40), office_id:z.string().max(64),
      category_id:S(64), tag:z.string().min(1).max(20),
      duration:I(0,12), riskLevel:I(1,3), feasiblePerMonth:I(0,1000) }),
    map: (x) => ({ csp:x.csp, office_id:x.office_id, category_id:x.category_id,
      activity_tag:x.tag, duration:x.duration, risk_level:x.riskLevel,
      feasible_per_month:x.feasiblePerMonth }) },

  outputs: { table:"outputs", cap:"edit",
    schema: z.object({ id:S(64), tag:z.string().min(1).max(20), year:I(2000,2100),
      month:I(0,11), planned:I(), actual:I(),
      adjust:z.enum(["none","up","down","new"]).default("none"), note:S(400) }),
    map: (x) => ({ activity_tag:x.tag, year:x.year, month:x.month, planned:x.planned,
      actual:x.actual, adjust:x.adjust, note:x.note }) },

  indicators: { table:"indicators", cap:"edit",
    schema: z.object({ id:S(64), code:z.string().min(1).max(20), name:z.string().min(1).max(300),
      basket:S(120), unit:z.string().max(20).default("%"), target:N(-1e6,1e6),
      direction:z.enum(["up","down"]).default("up"), method:S(200), frequency:S(40) }),
    map: (x) => ({ code:x.code, name:x.name, basket:x.basket, unit:x.unit,
      target:x.target, direction:x.direction, method:x.method, frequency:x.frequency }) },

  outcomes: { table:"outcomes", cap:"edit",
    schema: z.object({ id:S(64), indicator_id:z.string().min(1).max(64), adm1:S(120),
      round_label:S(80), planned:N(-1e6,1e6), value:N(-1e6,1e6),
      collected_at:S(20), sample:I() }),
    map: (x) => ({ indicator_id:x.indicator_id, adm1:x.adm1, round_label:x.round_label,
      planned:x.planned, value:x.value, collected_at:x.collected_at, sample:x.sample }) },

  population: { table:"population", cap:"edit",
    schema: z.object({ id:S(64), key:z.string().min(1).max(120),
      level:z.string().max(20).default("adm2"), base:I(), rate:N(-50,50) }),
    map: (x) => ({ area_key:x.key, level:x.level, base_year:2018, base:x.base, rate:x.rate }) },

  pdd: { table:"pdd", cap:"edit",
    schema: z.object({ id:S(64), year:I(2000,2100), month:I(0,11), wbs:S(40),
      actType:z.string().min(1).max(40), tag:S(20), actMain:S(200), office_id:S(64),
      bureau:z.string().min(1).max(120), region:S(120), district:S(120), commune:S(120),
      partner_id:S(64), modality:z.enum(["Food","Cash","Voucher"]).default("Food"),
      commodity:S(120), days:I(0,366), benefPlanned:I(), households:I(), tonnage:N(),
      amount:N(), benefActual:I(), received:N(), distributed:N(),
      status:z.enum(["planned","ongoing","done","cancelled"]).default("planned"), note:S(500) }),
    map: (x) => ({ year:x.year, month:x.month, wbs:x.wbs, act_type:x.actType,
      activity_tag:x.tag, act_main:x.actMain, office_id:x.office_id, bureau:x.bureau,
      region:x.region, district:x.district, commune:x.commune, partner_id:x.partner_id,
      modality:x.modality, commodity:x.commodity, days:x.days, benef_planned:x.benefPlanned,
      households:x.households, tonnage:x.tonnage, amount:x.amount, benef_actual:x.benefActual,
      received:x.received, distributed:x.distributed, status:x.status, note:x.note }) },

  reportTemplates: { table:"report_templates", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      blocks:z.array(z.string().max(40)).max(40).default([]), intro:S(4000) }),
    map: (x) => ({ name:x.name, blocks:JSON.stringify(x.blocks), intro:x.intro }) },

  dashboards: { table:"dashboards", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      widgets:z.array(z.record(z.any())).max(60).default([]) }),
    map: (x) => ({ name:x.name, widgets:JSON.stringify(x.widgets) }) },

  datasets: { table:"datasets", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160), formId:S(64),
      raw:z.array(z.record(z.any())).max(20000).default([]),
      rules:z.array(z.record(z.any())).max(200).default([]) }),
    map: (x) => ({ name:x.name, form_id:x.formId, raw:JSON.stringify(x.raw),
      rules:JSON.stringify(x.rules) }) },

  scripts: { table:"scripts", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      lang:z.enum(["R","SPSS"]).default("R"),
      stage:z.enum(["cleaning","analysis"]).default("analysis"),
      datasetId:S(64), code:z.string().max(200000).default(""), notes:S(2000),
      runs:z.array(z.record(z.any())).max(100).default([]) }),
    map: (x) => ({ name:x.name, language:x.lang, stage:x.stage, dataset_id:x.datasetId,
      code:x.code, notes:x.notes, runs:JSON.stringify(x.runs) }) },

  odkForms: { table:"odk_forms", cap:"admin",
    schema: z.object({ id:S(64), name:z.string().min(1).max(200),
      formId:z.string().min(1).max(120), project:S(40), token:S(400),
      kind:z.enum(["process","output","outcome","sites"]).default("process"),
      tag:S(20), siteField:S(120), dateField:S(120),
      labels:z.record(z.string().max(500)).default({}) }),
    map: (x) => ({ name:x.name, form_id:x.formId, project:x.project,
      kind:x.kind, activity_tag:x.tag, site_field:x.siteField, date_field:x.dateField,
      labels:JSON.stringify(x.labels),
      /* Le jeton n'est jamais conservé en clair ; laissé vide, l'existant est préservé. */
      ...(x.token ? { token_enc: encrypt(x.token) } : {}) }) },
};

r.put("/collections/:name", (req, res, next) => {
  const def = COLLECTIONS[req.params.name];
  if(!def) return res.status(404).json({ error:"collection inconnue" });
  if(!can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def.cap} » requis` });
  const parsed = z.object({ rows: z.array(def.schema).max(60000) }).safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"données invalides",
    details: parsed.error.issues.slice(0,10).map(i=>({ champ:i.path.join("."), message:i.message })) });

  const rows = parsed.data.rows;
  const keep = new Set();
  let created = 0, updated = 0, removed = 0;
  try{
    tx(() => {
      for(const raw of rows){
        const cols = def.map(raw);
        const id = raw.id && db.prepare(`SELECT 1 FROM ${def.table} WHERE id=?`).get(raw.id)
          ? raw.id : null;
        if(id){
          const keys = Object.keys(cols);
          db.prepare(`UPDATE ${def.table} SET ${keys.map(k=>k+"=?").join(",")} WHERE id=?`)
            .run(...keys.map(k=>cols[k]), id);
          keep.add(id); updated++;
        } else {
          const nid = raw.id || newId(req.params.name.slice(0,4));
          const keys = Object.keys(cols);
          db.prepare(`INSERT INTO ${def.table} (id,${keys.join(",")})
                      VALUES (?,${keys.map(()=>"?").join(",")})`)
            .run(nid, ...keys.map(k=>cols[k]));
          keep.add(nid); created++;
        }
      }
      const all = db.prepare(`SELECT id FROM ${def.table}`).all().map(x=>x.id);
      const del = db.prepare(`DELETE FROM ${def.table} WHERE id=?`);
      for(const id of all) if(!keep.has(id)){ del.run(id); removed++; }
    })();
  }catch(e){
    if(/FOREIGN KEY/.test(e.message))
      return res.status(409).json({ error:"référence invalide : une clé étrangère ne correspond à aucun enregistrement" });
    if(/UNIQUE/.test(e.message))
      return res.status(409).json({ error:"doublon : une contrainte d'unicité est violée" });
    return next(e);
  }
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan',?,'sync',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, req.params.name,
         `${req.params.name} : ${created} créé(s), ${updated} modifié(s), ${removed} supprimé(s)`);
  res.json({ created, updated, removed });
});

/* Réglages : dictionnaire clé-valeur, réservé aux administrateurs. */
r.put("/settings", requireCap("admin"), (req, res) => {
  const parsed = z.record(z.any()).safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"réglages invalides" });
  const FORBIDDEN = new Set(["apiToken","odkToken","jwtSecret"]);
  const stmt = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
                           ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  tx(() => { for(const [k,v] of Object.entries(parsed.data)){
    if(FORBIDDEN.has(k)) continue;                     /* aucun secret ne transite par ici */
    stmt.run(k, JSON.stringify(v)); } })();
  res.json({ ok:true });
});

/* Validation d'une visite : action métier distincte, tracée et réservée. */
r.put("/visits/:id/status", requireCap("validate"), (req, res) => {
  const p = z.object({ status: z.enum(["Validé","À valider","Erreur"]) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"statut invalide" });
  const v = db.prepare("SELECT * FROM visits WHERE id=?").get(req.params.id);
  if(!v) return res.status(404).json({ error:"visite introuvable" });
  db.prepare("UPDATE visits SET status=?, validated_by=?, validated_at=datetime('now') WHERE id=?")
    .run(p.data.status, req.user.id, v.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'odk','visits',?,'validate',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, v.id,
         `Visite ${p.data.status.toLowerCase()} — ${v.visit_date}`);
  res.json({ ok:true });
});

r.get("/audit", requireCap("admin"), (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit,10) || 100);
  res.json({ rows: db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit) });
});
export default r;
