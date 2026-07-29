import { Router } from "express";
import { db } from "../db.js";
import { currentVersion } from "../lib/geo.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

/* Vue agrégée consommée par le client au démarrage.
   Chaque collection provient de sa table : aucune donnée n'est stockée en vrac. */
r.get("/state", (req, res) => {
  const u = req.user;
  const scoped = u.role === "viewer" || u.role === "editor" || u.role === "validator";
  const officeFilter = (scoped && u.office_id) ? u.office_id : null;

  const offices = db.prepare("SELECT * FROM offices ORDER BY name").all();
  const officeName = Object.fromEntries(offices.map(o=>[o.id, o.name]));
  const partners = db.prepare("SELECT * FROM partners ORDER BY name").all();
  const partnerName = Object.fromEntries(partners.map(p=>[p.id, p.name]));
  const cats = db.prepare("SELECT * FROM activity_categories ORDER BY name").all();
  const catName = Object.fromEntries(cats.map(c=>[c.id, c.name]));

  const siteRows = officeFilter
    ? db.prepare("SELECT * FROM sites WHERE office_id=? ORDER BY code").all(officeFilter)
    : db.prepare("SELECT * FROM sites ORDER BY code").all();
  const year = new Date().getFullYear();
  const months = db.prepare("SELECT * FROM site_months WHERE year=?").all(year);
  const byId = {};
  siteRows.forEach(s => { byId[s.id] = Array.from({length:12}, () =>
    ({ planned:false, done:false, activeMonth:true, cp:"", monitor:"", report:"", moda:"" })); });
  months.forEach(m => { const a = byId[m.site_id]; if(!a) return;
    a[m.month] = { planned:!!m.planned, done:!!m.done, activeMonth:!!m.active,
      cp:m.cp_name||"", monitor:m.monitor||"", report:m.report||"", moda:m.moda||"" }; });

  const sites = siteRows.map(s => ({
    id:s.id, code:s.code, poi:s.name, status:s.status,
    subOffice: officeName[s.office_id] || "", office_id:s.office_id,
    antenne:s.antenne||"", activityCategory: catName[s.category_id] || "", category_id:s.category_id,
    activityTag:s.activity_tag||"", programArea:s.program_area||"", programTag:s.program_tag||"",
    poiSubtype:s.poi_subtype||"", siteType:s.site_type||"", monitoringType:s.monitoring_type||"",
    duration:s.duration||"", adm1:s.adm1||"", adm2:s.adm2||"", adm3:s.adm3||"", adm4:s.adm4||"",
    urbanArea:s.urban_area, lat:s.lat, lon:s.lon, security:s.security, modality:s.modality||"",
    beneficiaries:s.beneficiaries, partner: partnerName[s.partner_id] || "", partner_id:s.partner_id,
    responsible:s.responsible||"", lastVisit:s.last_visit||"",
    synergies:s.synergies, newPartner:s.new_partner, expPartner:s.exp_partner,
    issueIPM:s.issue_ipm, issueReport:s.issue_report, issueCFM:s.issue_cfm, fraud:s.fraud,
    plan: byId[s.id],
  }));

  const params = (officeFilter
    ? db.prepare("SELECT * FROM coverage_params WHERE office_id=?").all(officeFilter)
    : db.prepare("SELECT * FROM coverage_params").all()
  ).map(p => ({
    id:p.id, csp:p.csp||"", office: officeName[p.office_id]||"", office_id:p.office_id,
    tag:p.activity_tag, category: catName[p.category_id]||"", category_id:p.category_id,
    duration:p.duration, riskLevel:p.risk_level, feasiblePerMonth:p.feasible_per_month }));

  const visits = (officeFilter
    ? db.prepare("SELECT * FROM visits WHERE office_id=? ORDER BY visit_date DESC LIMIT 5000").all(officeFilter)
    : db.prepare("SELECT * FROM visits ORDER BY visit_date DESC LIMIT 5000").all()
  ).map(v => ({
    id:v.id, siteId:v.site_id, date:v.visit_date, office: officeName[v.office_id]||"",
    tag:v.activity_tag||"", monitor:v.monitor||"", form:v.form_id||"", status:v.status }));

  const indicators = db.prepare("SELECT * FROM indicators ORDER BY code").all().map(i => ({
    id:i.code, key:i.id, name:i.name, basket:i.basket||"", unit:i.unit,
    target:i.target, dir:i.direction, method:i.method||"", freq:i.frequency||"" }));
  const indByKey = Object.fromEntries(indicators.map(i=>[i.key, i.id]));

  /* Les résultats n'ont aucune dimension « bureau » dans le schéma : ils sont mesurés par
     région (adm1), pas par bureau. Un cloisonnement correct suppose la table de portée
     géographique (office_scope) ; d'ici là, ils restent visibles de tous — c'est assumé,
     ce sont des indicateurs agrégés, non des données opérationnelles nominatives. */
  const outcomes = db.prepare("SELECT * FROM outcomes").all().map(o => ({
    id:o.id, indicator: indByKey[o.indicator_id] || "", indicator_id:o.indicator_id,
    adm1:o.adm1||"", round:o.round_label||"", planned:o.planned, value:o.value,
    date:o.collected_at||"", sample:o.sample }));

  const outputs = db.prepare("SELECT * FROM outputs WHERE year=?").all(year).map(o => ({
    id:o.id, tag:o.activity_tag, month:o.month, planned:o.planned,
    actual:o.actual, adjust:o.adjust, note:o.note||"" }));

  const popRows = db.prepare("SELECT * FROM population ORDER BY area_key").all();
  const popVals = db.prepare("SELECT * FROM population_values").all();
  const population = popRows.map(p => ({ id:p.id, key:p.area_key, level:p.level,
    base:p.base, rate:p.rate,
    values: Object.fromEntries(popVals.filter(v=>v.population_id===p.id).map(v=>[v.year, v.value])) }));

  const pdd = (officeFilter
    ? db.prepare("SELECT * FROM pdd WHERE office_id=? ORDER BY year, month, bureau").all(officeFilter)
    : db.prepare("SELECT * FROM pdd ORDER BY year, month, bureau").all()
  ).map(p => ({
    /* office_id doit figurer ici : le client renvoie la collection telle qu'il l'a reçue,
       et un champ absent est réécrit à NULL par la synchronisation — le rattachement au
       bureau était donc effacé à chaque enregistrement du plan de distribution. */
    id:p.id, office_id:p.office_id, year:p.year, month:p.month, wbs:p.wbs||"",
    actType:p.act_type, tag:p.activity_tag||"",
    actMain:p.act_main||"", bureau:p.bureau, region:p.region||"", district:p.district||"",
    commune:p.commune||"", partner: partnerName[p.partner_id]||"", partner_id:p.partner_id,
    modality:p.modality, commodity:p.commodity||"", days:p.days,
    benefPlanned:p.benef_planned, households:p.households, tonnage:p.tonnage, amount:p.amount,
    benefActual:p.benef_actual, received:p.received, distributed:p.distributed,
    status:p.status, note:p.note||"" }));

  /* Le découpage administratif ne transite plus par /state : à ~18 000 fokontany,
     il pesait plus que tout le reste réuni et se retrouvait tronqué à 4 000 lignes.
     L'interface interroge /api/geo/levels au fur et à mesure de ce qu'elle affiche. */
  const gv = currentVersion();
  const geoVersion = gv ? {
    id:gv.id, label:gv.label, units:gv.units, importedAt:gv.imported_at,
    counts: Object.fromEntries(db.prepare(
      `SELECT level, COUNT(*) c FROM geo_unit WHERE version_id=? GROUP BY level`)
      .all(gv.id).map(x => [x.level, x.c])),
  } : null;

  const odkForms = db.prepare("SELECT * FROM odk_forms").all().map(f => ({
    id:f.id, name:f.name, formId:f.form_id, project:f.project||"", kind:f.kind,
    tag:f.activity_tag||"", siteField:f.site_field||"", dateField:f.date_field||"",
    labels: J(f.labels, {}), records:f.records, last:f.last_pull||"",
    hasToken: !!f.token_enc, rows: [] }));

  const settings = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map(s => [s.key, J(s.value, s.value)]));

  res.json({
    year, me: { id:u.id, role:u.role, office_id:u.office_id },
    offices, partners, categories: cats, sites, params, visits, indicators, outcomes,
    outputs, population, pdd, geoVersion, odkForms, settings,
    outcomePlan: Object.fromEntries(
      Object.entries(db.prepare("SELECT * FROM outcome_plan WHERE year=?").all(year)
        .reduce((acc,r2) => { const code = indByKey[r2.indicator_id]; if(!code) return acc;
          (acc[code] = acc[code] || Array(12).fill(false))[r2.month] = !!r2.planned; return acc; }, {}))),
    datasets: db.prepare("SELECT * FROM datasets").all().map(d => ({
      id:d.id, name:d.name, formId:d.form_id, raw:J(d.raw,[]), rules:J(d.rules,[]), createdAt:d.created_at })),
    scripts: db.prepare("SELECT * FROM scripts").all().map(s => ({
      id:s.id, name:s.name, lang:s.language, stage:s.stage, datasetId:s.dataset_id,
      code:s.code, notes:s.notes||"", runs:J(s.runs,[]) })),
    reportTemplates: db.prepare("SELECT * FROM report_templates").all().map(t => ({
      id:t.id, name:t.name, blocks:J(t.blocks,[]), intro:t.intro||"" })),
    dashboards: db.prepare("SELECT * FROM dashboards").all().map(d => ({
      id:d.id, name:d.name, widgets:J(d.widgets,[]) })),
    /* Le journal révèle qui fait quoi : il suit le même cloisonnement que les données. */
    audit: (officeFilter
      ? db.prepare(`SELECT * FROM audit WHERE kind<>'securite' AND office=?
                    ORDER BY at DESC LIMIT 60`).all(officeName[officeFilter] || "")
      : db.prepare("SELECT * FROM audit WHERE kind<>'securite' ORDER BY at DESC LIMIT 60").all()
    ).map(a => ({ id:a.id, at:a.at, user:a.user_label||"", office:a.office||"", kind:a.kind, text:a.text })),
    users: (u.role==="super" || u.role==="admin")
      ? db.prepare("SELECT id,email,first_name,last_name,title,office_id,role,tabs,active FROM users ORDER BY first_name").all()
          .map(x => ({ ...x, tabs:J(x.tabs,[]), active:!!x.active }))
      : [],
  });
});
export default r;
