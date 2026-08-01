/* ═══════════════════════════════════════════════════════════════════════
   La chaîne ODK, côté API : verser, rattacher, dater, marquer, situer.

   Elle prolonge `POST /api/odk-forms/:id/pull` (routes/odk.js), qui tire les
   soumissions et les met en cache dans `odk_forms.raw`. Ce cache n'est pas
   touché ici : il reste ce qu'il est, une copie brute du dernier tirage, et
   c'est lui qu'on lit pour alimenter `submissions`. Les deux étapes restent
   distinctes à dessein — on doit pouvoir re-verser un cache déjà tiré après
   avoir corrigé un code externe, sans rappeler ODK Central.

   Le cloisonnement par bureau s'applique à tout, y compris au RAPPROCHEMENT :
   un compte rattaché à un bureau n'attache ses soumissions qu'aux sites de ce
   bureau. Sans cela, deux sites homonymes de deux bureaux se voleraient leurs
   soumissions au premier import.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { requireCap } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { newId } from "../lib/crypto.js";
import { rejouerRattachement } from "../lib/rattachement.js";
import { ingerer, suiviParPeriode, appliquerSuivi, positionsObservees,
         dernieresVisitesOdk, combinerDerniereVisite } from "../lib/soumissions.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

const audit = (req, action, id, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'odk','submissions',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name,
         req.user.office_id || "", id, action, texte);

/* ── Liste ────────────────────────────────────────────────────────────
   `resolution=non_resolues` est la file de travail : ce que l'ingestion n'a pas
   su rattacher, avec le motif exact. C'est la raison d'être de la colonne
   `resolution_motif` — une soumission orpheline sans explication n'apprend rien
   à celui qui doit la corriger. */
r.get("/submissions", (req, res) => {
  const q = z.object({
    site_id: z.string().max(64).optional(),
    form_id: z.string().max(200).optional(),
    resolution: z.enum(["toutes", "resolues", "non_resolues"]).default("toutes"),
    debut: z.string().max(10).optional(), fin: z.string().max(10).optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error: "filtres invalides" });
  const f = q.data;
  const bureau = officeBound(req.user);

  const where = []; const args = [];
  /* Une soumission NON RÉSOLUE n'appartient à aucun bureau : elle reste visible
     de tous les comptes, sinon personne ne pourrait la réclamer. Le
     cloisonnement ne porte donc que sur celles qui sont rattachées. */
  if(bureau){ where.push("(s.site_id IS NULL OR si.office_id = ?)"); args.push(bureau); }
  if(f.site_id){ where.push("s.site_id = ?"); args.push(f.site_id); }
  if(f.form_id){ where.push("s.form_id = ?"); args.push(f.form_id); }
  if(f.resolution === "resolues") where.push("s.site_id IS NOT NULL");
  if(f.resolution === "non_resolues") where.push("s.site_id IS NULL");
  if(f.debut){ where.push("s.svy_date >= ?"); args.push(f.debut); }
  if(f.fin){ where.push("s.svy_date <= ?"); args.push(f.fin); }
  const clause = where.length ? "WHERE " + where.join(" AND ") : "";

  /* `raw` n'est délibérément pas servi ici. Il porte la soumission ENTIÈRE, donc
     potentiellement des réponses de ménage : il est conservé pour rejouer le
     rattachement, pas pour être listé à l'écran. Le sortir d'une route de liste
     le ferait voyager par milliers de lignes sans que personne l'ait demandé. */
  const rows = db.prepare(`
    SELECT s.id, s.form_id, s.instance_id, s.submitted_at, s.svy_date, s.site_code_raw,
           s.site_name_raw, s.activity_tag, s.site_id, s.geo_pcode, s.lat, s.lon, s.gps_accuracy,
           s.resolution_passe, s.resolution_motif, s.resolution_confiance, s.created_at,
           si.code AS site_code, si.name AS site_name
    FROM submissions s LEFT JOIN sites si ON si.id = s.site_id
    ${clause} ORDER BY s.svy_date DESC, s.id LIMIT ? OFFSET ?`).all(...args, f.limit, f.offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM submissions s
    LEFT JOIN sites si ON si.id = s.site_id ${clause}`).get(...args).c;
  const nonResolues = db.prepare(`SELECT COUNT(*) c FROM submissions WHERE site_id IS NULL`).get().c;
  res.json({ total, nonResolues, rows });
});

/* ── Ingestion ────────────────────────────────────────────────────────
   Trois provenances possibles, une seule mécanique :
     — une source ODK déjà tirée : on relit `odk_forms.raw` ;
     — un connecteur porteur de correspondances : elles sont appliquées telles
       quelles, par `appliquer()` (lib/mapping.js) ;
     — des enregistrements collés dans la requête, pour vérifier ou rattraper.

   Réservée à l'administration : elle écrit dans le référentiel opérationnel et
   déclenche un rattachement en masse. */
r.post("/submissions/ingest", requireCap("admin"), (req, res, next) => {
  const p = z.object({
    odk_form_id: z.string().max(64).optional(),
    connector_id: z.string().max(64).optional(),
    form_id: z.string().max(200).optional(),
    enregistrements: z.array(z.record(z.any())).max(20000).optional(),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "demande d'ingestion invalide" });
  const { odk_form_id, connector_id, enregistrements } = p.data;

  let source = null, formId = p.data.form_id || null;
  if(odk_form_id){
    source = db.prepare("SELECT * FROM odk_forms WHERE id=?").get(odk_form_id);
    if(!source) return res.status(404).json({ error: "source ODK introuvable" });
    formId = formId || source.form_id;
  }

  let mappings = null;
  if(connector_id){
    const c = db.prepare("SELECT * FROM connector WHERE id=?").get(connector_id);
    if(!c) return res.status(404).json({ error: "connecteur introuvable" });
    const bureau = officeBound(req.user);
    if(bureau && c.office_id !== bureau)
      return res.status(404).json({ error: "connecteur introuvable" });
    mappings = db.prepare(`SELECT * FROM connector_mapping
                           WHERE connector_id=? AND entity='submission'
                           ORDER BY position, mems_field`).all(c.id);
    if(!mappings.length) return res.status(422).json({ error:
      `le connecteur « ${c.name} » ne porte aucune correspondance pour l'entité « submission ». `
      + "Déclarez-les dans Paramètres → Connecteurs, ou versez sans connecteur pour laisser la "
      + "détection par défaut proposer les variables." });
    formId = formId || J(c.config, {}).formId || c.name;
  }

  const lignes = enregistrements?.length ? enregistrements
    : (source ? J(source.raw, []) : null);
  if(!lignes) return res.status(422).json({ error:
    "rien à verser : indiquez une source ODK déjà tirée (odk_form_id) ou fournissez des "
    + "enregistrements. Le tirage se fait par POST /api/odk-forms/:id/pull." });
  if(!Array.isArray(lignes)) return res.status(422).json({ error:
    "le cache de cette source ODK n'est pas une liste de soumissions : re-tirez-la." });
  if(!lignes.length) return res.json({ lues: 0, crees: 0, misAJour: 0, resolues: 0,
    nonResolues: 0, sansIdentifiant: 0, parPasse: {}, correspondances: [], incompletes: [],
    avertissement: "cette source n'a aucune soumission en cache : tirez-la d'abord." });
  if(!formId) return res.status(422).json({ error:
    "identifiant de formulaire absent : précisez form_id, ou versez depuis une source ODK." });

  try{
    const bilan = ingerer({ enregistrements: lignes, form_id: formId,
      odk_form_id: source?.id || null, connector_id: connector_id || null,
      mappings, office_id: officeBound(req.user) });
    audit(req, "ingest", source?.id || connector_id || null,
      `Soumissions versées — ${formId} : ${bilan.lues} lue(s), ${bilan.crees} créée(s), `
      + `${bilan.misAJour} mise(s) à jour, ${bilan.nonResolues} non rattachée(s)`);
    res.json({ ...bilan,
      avertissement: bilan.sansIdentifiant
        ? `${bilan.sansIdentifiant} soumission(s) sans identifiant d'instance : un identifiant `
          + "déterministe a été calculé à partir du contenu. Une soumission modifiée chez la "
          + "source apparaîtra alors comme nouvelle — faites porter « instance_id » par la source."
        : null });
  }catch(e){
    if(e.code === "MAPPING_TRANSFORM") return res.status(422).json({ error: e.message });
    next(e);
  }
});

/* Rejoue le rattachement sans re-tirer : c'est ce qu'on fait après avoir
   renseigné un code externe sur un site, ou créé le site qui manquait. */
r.post("/submissions/rattacher", requireCap("admin"), (req, res) => {
  const p = z.object({
    ids: z.array(z.string().max(64)).max(20000).optional(),
    toutes: z.boolean().default(false),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "demande de rattachement invalide" });
  const bilan = rejouerRattachement({ ids: p.data.ids || null,
    seulementNonResolues: !p.data.toutes, office_id: officeBound(req.user) });
  audit(req, "rattacher", null,
    `Rattachement rejoué — ${bilan.examinees} examinée(s), ${bilan.rattachees} rattachée(s), `
    + `${bilan.detachees} détachée(s)`);
  res.json(bilan);
});

/* ── Dernière visite ──────────────────────────────────────────────────
   Les deux valeurs côte à côte, et laquelle prime. Voir la note de
   lib/soumissions.js : la date ODK est observée, la date saisie est une
   convention de planification posée au 15 du mois. */
r.get("/submissions/derniere-visite", (req, res) => {
  const q = z.object({ site_id: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(6000).default(2000) }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error: "filtres invalides" });
  const bureau = officeBound(req.user);
  const where = []; const args = [];
  if(bureau){ where.push("office_id = ?"); args.push(bureau); }
  if(q.data.site_id){ where.push("id = ?"); args.push(q.data.site_id); }
  const sites = db.prepare(`SELECT id, code, name, last_visit FROM sites
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY code LIMIT ?`)
    .all(...args, q.data.limit);
  const odk = dernieresVisitesOdk({ office_id: bureau });
  res.json({ rows: sites.map(s => ({ id: s.id, code: s.code, name: s.name,
    soumissions: odk.get(s.id)?.soumissions || 0,
    ...combinerDerniereVisite(s.last_visit, odk.get(s.id)?.derniere) })) });
});

/* ── « Déjà suivi » ───────────────────────────────────────────────────
   En lecture : quels sites ont été suivis sur la fenêtre, d'après les
   soumissions. La fenêtre est un paramètre — voir `fenetre()` et Q15c. */
r.get("/submissions/suivi", (req, res) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(0).max(11).optional(),
    debut: z.string().max(10).optional(), fin: z.string().max(10).optional(),
    site_id: z.string().max(64).optional(), activity_tag: z.string().max(20).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error: "filtres invalides" });
  res.json(suiviParPeriode({ ...q.data, office_id: officeBound(req.user) }));
});

/* En écriture : marque `site_months.done` et crée les visites manquantes.
   Relancer ne double rien — voir les trois garde-fous de `appliquerSuivi`. */
r.post("/submissions/suivi", requireCap("edit"), (req, res, next) => {
  const p = z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(0).max(11).optional(),
    site_id: z.string().max(64).optional(), activity_tag: z.string().max(20).optional(),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "demande de marquage invalide" });
  try{
    const bilan = appliquerSuivi({ ...p.data, office_id: officeBound(req.user) });
    audit(req, "suivi", null,
      `Suivi marqué depuis les soumissions — ${bilan.periode.debut} à ${bilan.periode.fin} : `
      + `${bilan.sites} site(s), ${bilan.marques} nouvellement marqué(s), `
      + `${bilan.visitesCreees} visite(s) créée(s)`);
    res.json(bilan);
  }catch(e){
    if(e.code === "SUIVI_PERIODE") return res.status(422).json({ error: e.message });
    next(e);
  }
});

/* ── Positions observées ──────────────────────────────────────────────
   La couche GPS demandée (« les coordonnées GPS qui ressortiront des data
   sets »). Elle est SÉPARÉE de la position déclarée du site, qu'elle ne modifie
   jamais : `ecart_m` donne la distance entre les deux quand les deux existent,
   ce qui rend Q25 décidable sur des mesures. */
r.get("/submissions/positions", (req, res) => {
  const q = z.object({
    site_id: z.string().max(64).optional(), form_id: z.string().max(200).optional(),
    debut: z.string().max(10).optional(), fin: z.string().max(10).optional(),
    limit: z.coerce.number().int().min(1).max(20000).default(5000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error: "filtres invalides" });
  const points = positionsObservees({ ...q.data, limite: q.data.limit,
    office_id: officeBound(req.user) });
  const bornes = points.reduce((b, p) => ({
    minLat: Math.min(b.minLat, p.lat), maxLat: Math.max(b.maxLat, p.lat),
    minLon: Math.min(b.minLon, p.lon), maxLon: Math.max(b.maxLon, p.lon) }),
    { minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });
  res.json({ count: points.length, bounds: points.length ? bornes : null, points });
});

export default r;
