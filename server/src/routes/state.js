import { Router } from "express";
import { db } from "../db.js";
import { config } from "../config.js";
import { currentVersion } from "../lib/geo.js";
import { countryBound, officeBound, officeClause } from "../lib/scope.js";
import { allCountries, currentCountry } from "../lib/country.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

/* Vue agrégée consommée par le client au démarrage.
   Chaque collection provient de sa table : aucune donnée n'est stockée en vrac. */
r.get("/state", (req, res) => {
  const u = req.user;
  /* Une seule définition du cloisonnement par bureau, partagée avec la géographie :
     un bureau déclaré national n'en cloisonne aucun de ses comptes. */
  const officeFilter = officeBound(u);
  /* Couche au-dessus du bureau : le pays. Un compte borné à un pays ne voit ni ses
     bureaux, ni — à travers eux — ses sites, visites et plans de distribution. */
  const paysFilter = countryBound(u);
  const oc = officeClause(u, "t");

  const offices = paysFilter
    ? db.prepare(`SELECT * FROM offices WHERE country_code=? OR country_code IS NULL
                  ORDER BY name`).all(paysFilter)
    : db.prepare("SELECT * FROM offices ORDER BY name").all();
  const officeName = Object.fromEntries(offices.map(o=>[o.id, o.name]));
  /* Les partenaires suivent le pays, comme les bureaux : ils sont conventionnés
     dans un pays et n'ont pas à apparaître dans les listes déroulantes d'un autre. */
  const partners = paysFilter
    ? db.prepare(`SELECT * FROM partners WHERE country_code=? OR country_code IS NULL
                  ORDER BY active DESC, name`).all(paysFilter)
    : db.prepare("SELECT * FROM partners ORDER BY active DESC, name").all();
  const partnerName = Object.fromEntries(partners.map(p=>[p.id, p.name]));
  const cats = db.prepare("SELECT * FROM activity_categories ORDER BY name").all();
  const catName = Object.fromEntries(cats.map(c=>[c.id, c.name]));

  const siteRows = db.prepare(
    `SELECT t.* FROM sites t WHERE 1=1 ${oc.sql} ORDER BY t.code`).all(...oc.args);
  /* ── L'exercice ────────────────────────────────────────────
     Tout ce qui est daté — grille mensuelle des sites, outputs, plan de collecte,
     plan de distribution — était figé sur l'année du calendrier. Il n'existait aucun
     moyen de consulter l'exercice précédent ni de préparer le suivant : au 1er
     janvier, le travail de l'année écoulée devenait invisible d'un seul coup.

     L'année demandée arrive en paramètre et vaut, à défaut, celle en cours — c'est
     l'exercice sur lequel on travaille neuf fois sur dix, et personne ne devrait
     avoir à le choisir pour commencer. */
  const enCours = new Date().getFullYear();
  const demande = Number.parseInt(req.query.year, 10);
  const year = Number.isFinite(demande) && demande >= 2000 && demande <= 2100 ? demande : enCours;

  /* Les exercices réellement disponibles, pour que le sélecteur ne propose pas des
     années vides. L'année en cours et la suivante y figurent toujours : on prépare un
     plan avant qu'il n'existe une seule ligne. */
  const annees = [...new Set([
    ...db.prepare("SELECT DISTINCT year y FROM outputs").all().map(r2 => r2.y),
    ...db.prepare("SELECT DISTINCT year y FROM pdd").all().map(r2 => r2.y),
    ...db.prepare("SELECT DISTINCT year y FROM site_months").all().map(r2 => r2.y),
    ...db.prepare(
      "SELECT DISTINCT CAST(strftime('%Y', visit_date) AS INTEGER) y FROM visits WHERE visit_date IS NOT NULL")
      .all().map(r2 => r2.y),
    enCours, enCours + 1, year,
  ])].filter(y => Number.isFinite(y) && y >= 2000 && y <= 2100).sort((a, b) => b - a);
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
    duration:s.duration||"", rev:s.rev, geo_pcode:s.geo_pcode||null,
    adm1:s.adm1||"", adm2:s.adm2||"", adm3:s.adm3||"", adm4:s.adm4||"",
    urbanArea:s.urban_area, lat:s.lat, lon:s.lon, security:s.security, modality:s.modality||"",
    beneficiaries:s.beneficiaries, partner: partnerName[s.partner_id] || "", partner_id:s.partner_id,
    responsible:s.responsible||"", lastVisit:s.last_visit||"",
    synergies:s.synergies, newPartner:s.new_partner, expPartner:s.exp_partner,
    issueIPM:s.issue_ipm, issueReport:s.issue_report, issueCFM:s.issue_cfm, fraud:s.fraud,
    plan: byId[s.id],
  }));

  const params = db.prepare(
    `SELECT t.* FROM coverage_params t WHERE 1=1 ${oc.sql}`).all(...oc.args).map(p => ({
    id:p.id, rev:p.rev, csp:p.csp||"", office: officeName[p.office_id]||"", office_id:p.office_id,
    tag:p.activity_tag, category: catName[p.category_id]||"", category_id:p.category_id,
    duration:p.duration, riskLevel:p.risk_level, feasiblePerMonth:p.feasible_per_month }));

  const visits = db.prepare(
    `SELECT t.* FROM visits t WHERE 1=1 ${oc.sql} ORDER BY t.visit_date DESC LIMIT 5000`)
    .all(...oc.args).map(v => ({
    id:v.id, siteId:v.site_id, date:v.visit_date, office: officeName[v.office_id]||"",
    tag:v.activity_tag||"", monitor:v.monitor||"", form:v.form_id||"", status:v.status }));

  const indicators = db.prepare("SELECT * FROM indicators ORDER BY code").all().map(i => ({
    id:i.code, key:i.id, rev:i.rev, name:i.name, basket:i.basket||"", unit:i.unit,
    target:i.target, dir:i.direction, method:i.method||"", freq:i.frequency||"",
    /* Les moyens de vérification du cadre de suivi-évaluation : sans eux, l'écran du
       plan MRE ne pourrait dire que ce qu'un indicateur vise, jamais comment on
       l'obtient. */
    sdg_target:i.sdg_target||"", outcome:i.outcome||"", outcome_category:i.outcome_category||"",
    activity_ref:i.activity_ref||"", activity_category:i.activity_category||"",
    data_source:i.data_source||"", baseline:i.baseline||"", responsible:i.responsible||"",
    reports:i.reports||"", use_note:i.use_note||"" }));
  const indByKey = Object.fromEntries(indicators.map(i=>[i.key, i.id]));

  /* Les résultats n'ont aucune dimension « bureau » dans le schéma : ils sont mesurés par
     région (adm1), pas par bureau. Un cloisonnement correct suppose la table de portée
     géographique (office_scope) ; d'ici là, ils restent visibles de tous — c'est assumé,
     ce sont des indicateurs agrégés, non des données opérationnelles nominatives. */
  const outcomes = db.prepare("SELECT * FROM outcomes").all().map(o => ({
    id:o.id, rev:o.rev, indicator: indByKey[o.indicator_id] || "", indicator_id:o.indicator_id,
    adm1:o.adm1||"", round:o.round_label||"", planned:o.planned, value:o.value,
    date:o.collected_at||"", sample:o.sample }));

  const outputs = db.prepare("SELECT * FROM outputs WHERE year=?").all(year).map(o => ({
    id:o.id, rev:o.rev, tag:o.activity_tag, month:o.month, planned:o.planned,
    actual:o.actual, adjust:o.adjust, note:o.note||"" }));

  const popRows = db.prepare("SELECT * FROM population ORDER BY area_key").all();
  const popVals = db.prepare("SELECT * FROM population_values").all();
  const population = popRows.map(p => ({ id:p.id, rev:p.rev, key:p.area_key, level:p.level,
    base:p.base, rate:p.rate,
    values: Object.fromEntries(popVals.filter(v=>v.population_id===p.id).map(v=>[v.year, v.value])) }));

  const pdd = db.prepare(
    `SELECT t.* FROM pdd t WHERE t.year = ? ${oc.sql} ORDER BY t.month, t.bureau`)
    .all(year, ...oc.args).map(p => ({
    /* office_id doit figurer ici : le client renvoie la collection telle qu'il l'a reçue,
       et un champ absent est réécrit à NULL par la synchronisation — le rattachement au
       bureau était donc effacé à chaque enregistrement du plan de distribution. */
    id:p.id, rev:p.rev, office_id:p.office_id, geo_pcode:p.geo_pcode||null,
    year:p.year, month:p.month, wbs:p.wbs||"",
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
    /* L'état des contours au démarrage : la cartographie doit savoir dès le premier
       rendu s'il y a un fond de carte, sans un aller-retour supplémentaire dont le
       résultat arriverait après le premier affichage. */
    geom: { units: gv.geom_units || 0, source: gv.geom_source || "", at: gv.geom_at || null,
      parNiveau: gv.geom_units ? db.prepare(
        `SELECT level, COUNT(*) units, SUM(points) points, SUM(points_simple) points_simple
         FROM geo_geom WHERE version_id=? GROUP BY level ORDER BY level`).all(gv.id) : [] },
  } : null;

  /* Le pays courant et le vocabulaire de son découpage. Il part avec l'état
     initial parce que chaque écran en a besoin pour nommer ses colonnes : le
     demander séparément afficherait « adm3 » le temps d'un aller-retour. */
  const country = currentCountry();
  /* La liste des pays ne part QUE vers un compte non borné : c'est lui qui porte le
     sélecteur d'en-tête. L'envoyer à un compte borné lui apprendrait quels autres
     pays existent sur l'instance, ce qui n'est pas son affaire — et son sélecteur
     n'aurait de toute façon rien à changer.

     La condition porte sur le COMPTE (`u.country_code`), pas sur le filtre de la
     requête : un administrateur d'instance qui vient de se placer au Congo doit
     encore voir la liste, sinon il ne pourrait plus en sortir. */
  const countries = u.country_code ? [] : allCountries().filter(c => c.active);

  const odkForms = db.prepare("SELECT * FROM odk_forms").all().map(f => ({
    id:f.id, rev:f.rev, name:f.name, formId:f.form_id, project:f.project||"", kind:f.kind,
    tag:f.activity_tag||"", siteField:f.site_field||"", dateField:f.date_field||"",
    labels: J(f.labels, {}), records:f.records, last:f.last_pull||"",
    hasToken: !!f.token_enc, rows: [] }));

  /* Ce que l'exploitant autorise comme fond de carte. Le client ne le devine pas :
     une URL de tuiles écrite dans l'interface serait chargée même là où la politique
     de sécurité l'interdit, et l'utilisateur verrait une carte grise sans savoir
     pourquoi. `hosts` vide signifie « aucun fond distant permis ». */
  const basemap = { url:config.tileUrl, attribution:config.tileAttribution,
                    autorise: config.tileHosts.length > 0 };

  const settings = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map(s => [s.key, J(s.value, s.value)]));

  res.json({
    year, annees, anneeEnCours: enCours,
    me: { id:u.id, role:u.role, office_id:u.office_id,
      country_code:u.country_code || null },
    offices, partners, categories: cats, sites, params, visits, indicators, outcomes,
    /* Les sous-types de point d'intérêt : la table existait, le semis la remplissait,
       et l'état ne la rendait pas. L'écran de configuration montrait donc une liste
       vide alors que les sites en portaient déjà les valeurs. */
    poiSubtypes: db.prepare("SELECT * FROM poi_subtypes ORDER BY label").all().map(p => ({
      id:p.id, rev:p.rev, label:p.label, code:p.code || "", note:p.note || "" })),
    outputs, population, pdd, geoVersion, country, countries, odkForms, settings, basemap,
    outcomePlan: Object.fromEntries(
      Object.entries(db.prepare("SELECT * FROM outcome_plan WHERE year=?").all(year)
        .reduce((acc,r2) => { const code = indByKey[r2.indicator_id]; if(!code) return acc;
          (acc[code] = acc[code] || Array(12).fill(false))[r2.month] = !!r2.planned; return acc; }, {}))),
    datasets: db.prepare("SELECT * FROM datasets").all().map(d => ({
      id:d.id, rev:d.rev, name:d.name, formId:d.form_id, raw:J(d.raw,[]), rules:J(d.rules,[]), createdAt:d.created_at })),
    scripts: db.prepare("SELECT * FROM scripts").all().map(s => ({
      id:s.id, rev:s.rev, name:s.name, lang:s.language, stage:s.stage, datasetId:s.dataset_id,
      code:s.code, notes:s.notes||"", runs:J(s.runs,[]) })),
    reportTemplates: db.prepare("SELECT * FROM report_templates").all().map(t => ({
      id:t.id, rev:t.rev, name:t.name, blocks:J(t.blocks,[]), intro:t.intro||"" })),
    dashboards: db.prepare("SELECT * FROM dashboards").all().map(d => ({
      id:d.id, rev:d.rev, name:d.name, widgets:J(d.widgets,[]) })),
    /* Le journal révèle qui fait quoi : il suit le même cloisonnement que les données. */
    audit: (() => {
      if(officeFilter) return db.prepare(`SELECT * FROM audit WHERE kind<>'securite' AND office=?
        ORDER BY at DESC LIMIT 60`).all(officeName[officeFilter] || "");
      /* Le journal ne porte que le NOM du bureau, pas son identifiant : on filtre donc
         sur les noms des bureaux visibles. Les lignes sans bureau restent — ce sont
         les actions de configuration, qui n'appartiennent à aucun pays. */
      if(paysFilter){
        const noms = offices.map(o => o.name);
        const q = noms.map(() => "?").join(",") || "''";
        return db.prepare(`SELECT * FROM audit WHERE kind<>'securite'
          AND (office IN (${q}) OR office IS NULL OR office='')
          ORDER BY at DESC LIMIT 60`).all(...noms);
      }
      return db.prepare("SELECT * FROM audit WHERE kind<>'securite' ORDER BY at DESC LIMIT 60").all();
    })().map(a => ({ id:a.id, at:a.at, user:a.user_label||"", office:a.office||"", kind:a.kind, text:a.text })),
    /* Les comptes suivent le filtre strict de /api/users : un administrateur borné à
       un pays ne voit ni les comptes d'un autre pays ni les comptes non bornés. */
    users: (u.role==="super" || u.role==="admin")
      ? db.prepare(`SELECT id,email,first_name,last_name,title,office_id,country_code,entity,
                           tpm_id,role,tabs,active
                    FROM users WHERE (? IS NULL OR country_code = ?) ORDER BY first_name`)
          .all(paysFilter, paysFilter)
          .map(x => ({ ...x, tabs:J(x.tabs,[]), active:!!x.active }))
      : [],
  });
});
export default r;
