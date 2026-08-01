import { Router } from "express";
import { db } from "../db.js";
import { currentVersion } from "../lib/geo.js";
import { officeBound } from "../lib/scope.js";
import { currentCountry } from "../lib/country.js";
import { dernieresVisitesOdk } from "../lib/soumissions.js";
import { MOTIFS_MANUELS } from "../lib/visites.js";
import { schemasAuthPublics, CAUSES_AUTH } from "../lib/authSortante.js";
import { can } from "../lib/auth.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

/* Vue agrégée consommée par le client au démarrage.
   Chaque collection provient de sa table : aucune donnée n'est stockée en vrac. */
r.get("/state", (req, res) => {
  const u = req.user;
  /* Une seule définition du cloisonnement par bureau, partagée avec la géographie :
     un bureau déclaré national n'en cloisonne aucun de ses comptes. */
  const officeFilter = officeBound(u);
  /* Ce que l'état initial dit de plus à un administrateur. La règle de la maison
     est qu'aucun secret ne sort ; celle-ci est plus fine et vaut d'être nommée :
     ce qui n'est pas un secret mais n'est utile qu'à l'administration ne descend
     pas plus bas qu'elle. */
  const admin = can(u, "admin");

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
  /* « Date de dernière visite = dernière date de suivi disponible dans odk selon
     svydate. » Elle est servie À CÔTÉ de la valeur saisie, jamais à sa place :
     `lastVisit` reste ce que quelqu'un a coché, `lastVisitOdk` est ce que le
     terrain a déclaré, et `lastVisitEffective` dit laquelle l'emporte — l'ODK,
     parce qu'elle est observée là où la saisie est une convention posée au 15 du
     mois par la grille mensuelle. Voir lib/soumissions.js. */
  const odkVisites = dernieresVisitesOdk({ office_id: officeFilter });
  const months = db.prepare("SELECT * FROM site_months WHERE year=?").all(year);
  const byId = {};
  siteRows.forEach(s => { byId[s.id] = Array.from({length:12}, () =>
    ({ planned:false, done:false, activeMonth:true, cp:"", monitor:"", report:"", moda:"" })); });
  months.forEach(m => { const a = byId[m.site_id]; if(!a) return;
    a[m.month] = { planned:!!m.planned, done:!!m.done, activeMonth:!!m.active,
      cp:m.cp_name||"", monitor:m.monitor||"", report:m.report||"", moda:m.moda||"" }; });

  const sites = siteRows.map(s => ({
    id:s.id, code:s.code, poi:s.name, status:s.status,
    /* Le code que porte la source de collecte pour désigner ce site. Il doit
       voyager jusqu'au navigateur : sans lui, la fiche du registre l'écraserait
       en enregistrant, et le rattachement des soumissions se romprait. */
    externalCode: s.external_code || "",
    subOffice: officeName[s.office_id] || "", office_id:s.office_id,
    antenne:s.antenne||"", activityCategory: catName[s.category_id] || "", category_id:s.category_id,
    activityTag:s.activity_tag||"", programArea:s.program_area||"", programTag:s.program_tag||"",
    poiSubtype:s.poi_subtype||"", siteType:s.site_type||"", monitoringType:s.monitoring_type||"",
    duration:s.duration||"", rev:s.rev, geo_pcode:s.geo_pcode||null,
    adm1:s.adm1||"", adm2:s.adm2||"", adm3:s.adm3||"", adm4:s.adm4||"",
    urbanArea:s.urban_area, lat:s.lat, lon:s.lon, security:s.security, modality:s.modality||"",
    beneficiaries:s.beneficiaries, partner: partnerName[s.partner_id] || "", partner_id:s.partner_id,
    responsible:s.responsible||"", lastVisit:s.last_visit||"",
    lastVisitOdk: odkVisites.get(s.id)?.derniere || "",
    lastVisitEffective: odkVisites.get(s.id)?.derniere || s.last_visit || "",
    submissions: odkVisites.get(s.id)?.soumissions || 0,
    synergies:s.synergies, newPartner:s.new_partner, expPartner:s.exp_partner,
    issueIPM:s.issue_ipm, issueReport:s.issue_report, issueCFM:s.issue_cfm, fraud:s.fraud,
    plan: byId[s.id],
  }));

  const params = (officeFilter
    ? db.prepare("SELECT * FROM coverage_params WHERE office_id=?").all(officeFilter)
    : db.prepare("SELECT * FROM coverage_params").all()
  ).map(p => ({
    id:p.id, rev:p.rev, csp:p.csp||"", office: officeName[p.office_id]||"", office_id:p.office_id,
    tag:p.activity_tag, category: catName[p.category_id]||"", category_id:p.category_id,
    duration:p.duration, riskLevel:p.risk_level, feasiblePerMonth:p.feasible_per_month }));

  const visits = (officeFilter
    ? db.prepare("SELECT * FROM visits WHERE office_id=? ORDER BY visit_date DESC LIMIT 5000").all(officeFilter)
    : db.prepare("SELECT * FROM visits ORDER BY visit_date DESC LIMIT 5000").all()
  ).map(v => ({
    id:v.id, siteId:v.site_id, date:v.visit_date, office: officeName[v.office_id]||"",
    tag:v.activity_tag||"", monitor:v.monitor||"", form:v.form_id||"", status:v.status,
    /* D'où vient la visite, et pourquoi si personne n'a rempli de formulaire.
       Sans ces quatre champs aucun écran ne peut distinguer une preuve de terrain
       d'un rattrapage, ni la grille mensuelle savoir qu'un mois est déjà couvert.
       `created_by` n'est délibérément pas projeté : le journal d'audit dit déjà
       qui, avec un libellé lisible plutôt qu'un identifiant. */
    origin:v.origin, motif:v.manual_reason||"", motifNote:v.manual_note||"",
    submissionId:v.submission_id||"" }));

  const indicators = db.prepare("SELECT * FROM indicators ORDER BY code").all().map(i => ({
    id:i.code, key:i.id, rev:i.rev, name:i.name, basket:i.basket||"", unit:i.unit,
    target:i.target, dir:i.direction, method:i.method||"", freq:i.frequency||"",
    /* Deux natures d'un même objet (migration 022) : le CRF porte un `level`
       de cadre logique, l'XLSForm de processus porte l'`activity` qu'il suit. */
    kind:i.kind||"crf", level:i.level||"", activity:i.activity||"",
    /* La catégorie thématique de la masterlist (migration 027) : c'est par
       elle que l'écran filtre 842 indicateurs, elle voyage donc avec eux. */
    category:i.category||"" }));
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

  const pdd = (officeFilter
    ? db.prepare("SELECT * FROM pdd WHERE office_id=? ORDER BY year, month, bureau").all(officeFilter)
    : db.prepare("SELECT * FROM pdd ORDER BY year, month, bureau").all()
  ).map(p => ({
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

  const odkForms = db.prepare("SELECT * FROM odk_forms").all().map(f => ({
    id:f.id, rev:f.rev, name:f.name, formId:f.form_id, project:f.project||"", kind:f.kind,
    tag:f.activity_tag||"", siteField:f.site_field||"", dateField:f.date_field||"",
    labels: J(f.labels, {}), records:f.records, last:f.last_pull||"",
    /* La présence du justificatif, jamais sa valeur — et le schéma sous lequel il
       est présenté, qui n'en est pas un et dont l'écran a besoin pour demander les
       bons champs. Le badge « présent / manquant » se lisait jusqu'ici sur le jeton
       général du NAVIGATEUR, que le serveur ne reçoit jamais : il affichait donc
       « présent » pour une source qui n'avait rien, et le tirage échouait juste après. */
    hasToken: !!f.token_enc,
    authSchema: f.auth_schema || "porteur",
    /* L'identifiant du compte de service — le courriel ODK Central, la moitié
       NOMMÉE du couple — ne part que vers l'administration, seule habilitée à
       ouvrir la fiche qui le contient. `odk_forms` n'est cloisonné par aucun
       bureau : servi à tout compte authentifié, ce champ donnait à un lecteur de
       terrain de n'importe quelle antenne le nom de connexion du compte ODK
       Central, avec l'adresse du serveur déjà publiée dans `settings.odkBase`.
       Ce n'est pas un secret au sens de la maison ; rien n'oblige pour autant à
       le servir plus bas que l'administration. */
    ...(admin ? { authIdentifiant: f.auth_identifiant || "" } : {}),
    rows: J(f.raw, []) }));

  const settings = Object.fromEntries(
    db.prepare("SELECT key, value FROM settings").all().map(s => [s.key, J(s.value, s.value)]));

  res.json({
    year, me: { id:u.id, role:u.role, office_id:u.office_id },
    offices, partners, categories: cats, sites, params, visits, indicators, outcomes,
    outputs, population, pdd, geoVersion, country, odkForms, settings,
    /* La liste fermée des motifs de saisie à la main, servie telle qu'elle est
       déclarée dans lib/visites.js. Elle part avec l'état initial pour la même
       raison que `country` et `settings` : la grille mensuelle en a besoin dès
       qu'on ouvre une cellule, et un aller-retour dédié pour six objets se
       paierait avant le premier affichage. Le client n'en garde aucune copie. */
    motifsVisiteManuelle: MOTIFS_MANUELS,
    /* La table fermée des schémas d'authentification sortante, servie telle
       qu'elle est déclarée dans lib/authSortante.js — même raison que la ligne
       au-dessus : l'écran des sources ODK en a besoin dès qu'on ouvre une fiche,
       et il n'en tient aucune copie. La route des connecteurs la sert aussi, à
       partir de la même fonction : c'est une seule vérité, livrée par deux
       portes, parce que l'écran des connecteurs ne passe pas par l'état global. */
    schemasAuth: schemasAuthPublics(),
    /* La taxonomie des causes d'échec, servie avec sa table. L'écran affiche un
       libellé par cause : le laisser recopier cette liste, c'est se garantir qu'il
       affichera un jour un code brut pour une cause ajoutée côté serveur. */
    causesAuth: CAUSES_AUTH,
    outcomePlan: Object.fromEntries(
      Object.entries(db.prepare("SELECT * FROM outcome_plan WHERE year=?").all(year)
        .reduce((acc,r2) => { const code = indByKey[r2.indicator_id]; if(!code) return acc;
          (acc[code] = acc[code] || Array(12).fill(false))[r2.month] = !!r2.planned; return acc; }, {}))),
    datasets: db.prepare("SELECT * FROM datasets").all().map(d => ({
      id:d.id, rev:d.rev, name:d.name, formId:d.form_id, raw:J(d.raw,[]), rules:J(d.rules,[]),
      formulas:J(d.formulas,[]), createdAt:d.created_at })),
    scripts: db.prepare("SELECT * FROM scripts").all().map(s => ({
      id:s.id, rev:s.rev, name:s.name, lang:s.language, stage:s.stage, datasetId:s.dataset_id,
      code:s.code, notes:s.notes||"", runs:J(s.runs,[]) })),
    reportTemplates: db.prepare("SELECT * FROM report_templates").all().map(t => ({
      id:t.id, rev:t.rev, name:t.name, blocks:J(t.blocks,[]), intro:t.intro||"" })),
    dashboards: db.prepare("SELECT * FROM dashboards").all().map(d => ({
      id:d.id, rev:d.rev, name:d.name, widgets:J(d.widgets,[]) })),
    /* Le journal révèle qui fait quoi : il suit le même cloisonnement que les données.

       `rowid DESC` en second critère, et ce n'est pas un ornement : `at` est un
       `datetime('now')`, donc à la SECONDE. Une minute chargée y écrit soixante
       lignes portant le même horodatage, et l'index `idx_audit_at` les rend alors
       dans l'ordre d'insertion CROISSANT — c'est-à-dire que « les 60 plus
       récentes » retenait, à l'intérieur de la seconde la plus récente, les plus
       ANCIENNES, et coupait les dernières écrites. Exactement l'inverse de ce que
       la requête annonce. Le journal de la console d'administration
       (routes/admin.js) départage déjà ses égalités ; celui-ci ne le faisait pas. */
    audit: (officeFilter
      ? db.prepare(`SELECT * FROM audit WHERE kind<>'securite' AND office=?
                    ORDER BY at DESC, rowid DESC LIMIT 60`).all(officeName[officeFilter] || "")
      : db.prepare(`SELECT * FROM audit WHERE kind<>'securite'
                    ORDER BY at DESC, rowid DESC LIMIT 60`).all()
    ).map(a => ({ id:a.id, at:a.at, user:a.user_label||"", office:a.office||"", kind:a.kind, text:a.text })),
    users: (u.role==="super" || u.role==="admin")
      ? db.prepare("SELECT id,email,username,first_name,last_name,title,office_id,tpm_id,role,tabs,active FROM users ORDER BY first_name").all()
          .map(x => ({ ...x, username:x.username||"", tabs:J(x.tabs,[]), active:!!x.active }))
      : [],
  });
});
export default r;
