import { Router } from "express";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { labelsFor, currentVersion, resolveUnit } from "../lib/geo.js";
import { requireCap } from "../lib/auth.js";
import { officeBound as scopeOf } from "../lib/scope.js";
import { validate, schemas } from "../lib/validate.js";
import { combinerDerniereVisite, derniereVisiteOdk } from "../lib/soumissions.js";
import { listerAlias, synchroniserCodeParDefaut } from "../lib/alias.js";
import { cleMois, estProtegee, libelleMotif, visitesDuMois } from "../lib/visites.js";
import { z } from "zod";

const r = Router();
const audit = (req, action, entity_id, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'plan','sites',?,?,?)`)
    .run(newId("aud"), req.user.id, `${req.user.first_name} ${req.user.last_name||""}`.trim(),
         req.user.office_id||"", entity_id, action, text);

/* Un compte rattaché à un bureau ne voit et ne modifie que ses propres sites —
   sauf si ce bureau est déclaré national. La règle vient de lib/scope.js : elle
   était réécrite ici et dans analytics.js, et ces copies auraient ignoré le
   bureau pays. */
async function assertScope(req, site){
  const s = await scopeOf(req.user);
  if(s && site && site.office_id !== s){
    const e = new Error("ce site relève d'un autre bureau"); e.status = 403; throw e;
  }
}

r.get("/", async (req, res) => {
  const q = z.object({
    search: z.string().max(120).optional(), office_id: z.string().max(64).optional(),
    status: z.enum(["Active","Inactive"]).optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const f = q.data;
  const scope = await scopeOf(req.user);
  const where = []; const args = [];
  if(scope){ where.push("office_id = ?"); args.push(scope); }
  else if(f.office_id){ where.push("office_id = ?"); args.push(f.office_id); }
  if(f.status){ where.push("status = ?"); args.push(f.status); }
  if(f.search){ where.push("(name LIKE ? OR code LIKE ? OR adm3 LIKE ?)");
    const s = `%${f.search}%`; args.push(s,s,s); }
  /* La date issue des soumissions ODK accompagne la liste, sans remplacer la
     valeur saisie : les deux colonnes voyagent ensemble, `last_visit_effective`
     dit laquelle prime. Un appel de plus par site serait autrement inévitable
     dès qu'un écran affiche « dernière visite » sur une liste de 200 lignes. */
  /* Sous-requêtes CORRÉLÉES, et non une jointure sur un agrégat global : la forme
     précédente — LEFT JOIN (SELECT … GROUP BY site_id) — obligeait SQLite à
     regrouper TOUTE la table `submissions`, tous sites confondus, avant d'appliquer
     le LIMIT. On payait donc l'agrégation de centaines de milliers de lignes pour
     n'en afficher que deux cents, et ce coût grandissait avec la base sans rien
     changer à l'écran. Corrélées, les deux sous-requêtes ne sont évaluées que pour
     les lignes effectivement retenues, et `idx_submissions_site_date` les sert. */
  const sql = `SELECT sites.*,
                      (SELECT MAX(svy_date) FROM submissions
                       WHERE site_id = sites.id AND svy_date IS NOT NULL) AS last_visit_odk,
                      COALESCE((SELECT MAX(svy_date) FROM submissions
                                WHERE site_id = sites.id AND svy_date IS NOT NULL),
                               sites.last_visit) AS last_visit_effective,
                      (SELECT COUNT(*) FROM submissions
                       WHERE site_id = sites.id AND svy_date IS NOT NULL) AS submissions
               FROM sites
               ${where.length ? "WHERE "+where.join(" AND ") : ""}
               ORDER BY code LIMIT ? OFFSET ?`;
  const rows = await db.prepare(sql).all(...args, f.limit, f.offset);
  const total = (await db.prepare(`SELECT COUNT(*) c FROM sites ${where.length ? "WHERE "+where.join(" AND ") : ""}`)
    .get(...args)).c;
  res.json({ total, rows });
});

/* ── Audit GPS des points — portage fidèle de docs/app.R ──────────────
   L'outil R (« PAM GPS AUDIT TOOL ») fait trois choses, reprises ici une à une :

   1. CENTROÏDE de la commune d'accueil (app.R : group_by adm1/adm2/adm3 →
      st_union → st_centroid). MEMS stocke déjà ce centroïde par unité
      (geo_unit.lat/lon), calculé à l'import du shapefile — on le lit tel quel.

   2. DISTANCE point→centroïde (app.R : `get_route_safe`). app.R tente d'abord un
      itinéraire routier OSRM ; en cas d'échec — ce qui est le cas hors ligne — il
      RETOMBE sur la distance planaire × 1,3 (`round(d * 1.3, 2)`). Aucun serveur de
      routage n'étant joignable ici, on applique EXACTEMENT ce repli : distance à
      vol d'oiseau (haversine) × 1,3, arrondie à deux décimales — une estimation de
      distance ROUTIÈRE, pas à vol d'oiseau. C'est la formule d'app.R, pas une
      approximation de notre cru.

   3. ATTRIBUTION du bureau de terrain (app.R : `fo_name_lookup`, code → nom). MEMS
      attribue déjà chaque site à un bureau (office_id) ; on rend ce nom, et on
      liste la table de correspondance des Field Offices de Madagascar pour mémoire.

   En plus d'app.R : on vérifie que le point tombe dans la BOÎTE ENGLOBANTE de sa
   commune (geo_geom) — l'équivalent léger du « le point est-il DANS le polygone ». */
const R_TERRE = 6371;
const FACTEUR_ROUTIER = 1.3;   /* app.R : round(d * 1.3, 2) en repli hors OSRM */
function haversineKm(aLat, aLon, bLat, bLon){
  const rad = d => d * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(aLat))*Math.cos(rad(bLat))*Math.sin(dLon/2)**2;
  return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
}
/* La table des Field Offices de Madagascar, telle qu'app.R la déclare
   (fo_name_lookup) — reproduite pour mémoire et pour nommer un bureau au besoin. */
const FIELD_OFFICES_MDG = { 1:"Bekily", 2:"Fort Dauphin", 3:"Antananarivo", 4:"Manakara",
  6:"Ambovombe", 7:"Tsihombe", 9:"Ampanihy", 10:"Tulear" };
const RANG_VERDICT = { unmatched:3, outside:2, far:1, ok:0 };

/* L'audit d'UN point — la même logique qu'app.R, appliquée à un seul site pour
   qu'elle se lance AUTOMATIQUEMENT à l'ajout ou à la correction d'un site (« qu'il
   lance ce genre d'audit dans l'ajout des sites »). Rend null s'il n'y a pas de
   GPS ou pas de référentiel — l'appelant n'a alors rien à signaler. */
async function auditerPointUnique(site, seuil = 15){
  if(site.lat == null || site.lon == null) return null;
  const v = await currentVersion(); if(!v) return null;
  let u = await db.prepare("SELECT pcode, name, lat, lon FROM geo_unit WHERE version_id=? AND level='adm3' AND pcode=?")
    .get(v.id, site.geo_pcode);
  if(!u){ const rr = await resolveUnit({ adm1:site.adm1, adm2:site.adm2, adm3:site.adm3 }, v.id);
    if(rr.pcode) u = await db.prepare("SELECT pcode, name, lat, lon FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, rr.pcode); }
  if(!u || u.lat == null) return { verdict:"unmatched", commune:null, dist:null, inBbox:null };
  const dist = Math.round(haversineKm(site.lat, site.lon, u.lat, u.lon) * FACTEUR_ROUTIER * 100) / 100;
  const bb = await db.prepare("SELECT min_lon,min_lat,max_lon,max_lat FROM geo_geom WHERE version_id=? AND pcode=?").get(v.id, u.pcode);
  const inBbox = bb ? (site.lon>=bb.min_lon && site.lon<=bb.max_lon && site.lat>=bb.min_lat && site.lat<=bb.max_lat) : null;
  const verdict = inBbox === false ? "outside" : dist > seuil ? "far" : "ok";
  return { verdict, commune:u.name, dist, inBbox, cLat:u.lat, cLon:u.lon };
}

r.get("/gps-audit", async (req, res) => {
  const q = z.object({
    seuil: z.coerce.number().min(0.5).max(500).default(15),   /* km au-delà desquels on alerte */
    limit: z.coerce.number().int().min(1).max(6000).default(4000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"paramètres invalides" });
  const { seuil, limit } = q.data;

  const v = await currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel géographique courant" });

  const scope = await scopeOf(req.user);
  const where = ["lat IS NOT NULL", "lon IS NOT NULL"]; const args = [];
  if(scope){ where.push("office_id = ?"); args.push(scope); }
  const sites = await db.prepare(
    `SELECT id, name, code, adm1, adm2, adm3, adm4, lat, lon, geo_pcode, activity_tag, office_id
     FROM sites WHERE ${where.join(" AND ")} LIMIT ?`).all(...args, limit);

  /* Les communes (adm3) du millésime courant, avec leur centroïde (geo_unit.lat/lon)
     et leur boîte englobante (geo_geom). */
  const communes = Object.fromEntries((await db.prepare(
    "SELECT pcode, name, lat, lon FROM geo_unit WHERE version_id=? AND level='adm3'").all(v.id))
    .map(u => [u.pcode, u]));
  const bbox = Object.fromEntries((await db.prepare(
    "SELECT pcode, min_lon, min_lat, max_lon, max_lat FROM geo_geom WHERE version_id=? AND level='adm3'").all(v.id))
    .map(g => [g.pcode, g]));
  /* Le bureau (Field Office) de chaque site — l'attribution qu'app.R fait par
     fo_name_lookup ; MEMS la tient déjà par office_id. */
  const bureaux = Object.fromEntries((await db.prepare("SELECT id, name FROM offices").all()).map(o => [o.id, o.name]));

  const bilan = { total:0, ok:0, far:0, outside:0, unmatched:0, sansContour:0 };
  const rows = [];
  for(const s of sites){
    bilan.total++;
    const office = bureaux[s.office_id] || null;
    /* La commune d'accueil : par p-code s'il désigne une commune, sinon résolue
       par le NOM (adm1→adm3), exactement comme le rattachement du registre. */
    let u = communes[s.geo_pcode];
    if(!u){ const rr = await resolveUnit({ adm1:s.adm1, adm2:s.adm2, adm3:s.adm3 }, v.id);
      if(rr.pcode) u = communes[rr.pcode]; }
    if(!u || u.lat == null || u.lon == null){
      bilan.unmatched++;
      rows.push({ id:s.id, name:s.name, code:s.code, tag:s.activity_tag, office, adm1:s.adm1, adm2:s.adm2, adm3:s.adm3,
        lat:s.lat, lon:s.lon, commune:null, cLat:null, cLon:null, dist:null, inBbox:null, verdict:"unmatched" });
      continue;
    }
    /* Distance ROUTIÈRE estimée, façon app.R : vol d'oiseau × 1,3, 2 décimales. */
    const dist = Math.round(haversineKm(s.lat, s.lon, u.lat, u.lon) * FACTEUR_ROUTIER * 100) / 100;
    const bb = bbox[u.pcode];
    const inBbox = bb ? (s.lon >= bb.min_lon && s.lon <= bb.max_lon && s.lat >= bb.min_lat && s.lat <= bb.max_lat) : null;
    if(inBbox === null) bilan.sansContour++;
    let verdict = "ok";
    if(inBbox === false) verdict = "outside";
    else if(dist > seuil) verdict = "far";
    bilan[verdict]++;
    rows.push({ id:s.id, name:s.name, code:s.code, tag:s.activity_tag, office, adm1:s.adm1, adm2:s.adm2, adm3:s.adm3,
      lat:s.lat, lon:s.lon, commune:u.name, cLat:u.lat, cLon:u.lon, dist, inBbox, verdict });
  }
  rows.sort((a, b) => (RANG_VERDICT[b.verdict] - RANG_VERDICT[a.verdict]) || ((b.dist || 0) - (a.dist || 0)));

  res.json({ seuil, methode:"app.R (vol d'oiseau × 1,3, repli hors OSRM)", fieldOffices:FIELD_OFFICES_MDG,
    version:{ id:v.id, label:v.label }, bilan, rows: rows.slice(0, 2500) });
});

r.get("/:id", async (req, res) => {
  const s = await db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!s) return res.status(404).json({ error:"site introuvable" });
  await assertScope(req, s);
  /* La fiche porte les DEUX dates de dernière visite. Le site garde la sienne,
     saisie ; la date issue des soumissions ODK est calculée à la demande et
     prime à l'affichage — voir lib/soumissions.js pour le pourquoi. */
  /* `aliases` s'ajoute, il ne remplace rien : `site.external_code` reste le code
     par défaut que la fiche affiche et modifie. Un site désigné autrement par
     chaque formulaire porte plusieurs codes (migration 018), et la fiche est le
     seul endroit où l'on peut les voir tous. */
  res.json({ site:s, months: await db.prepare("SELECT * FROM site_months WHERE site_id=?").all(s.id),
    aliases: await listerAlias(s.id),
    derniereVisite: combinerDerniereVisite(s.last_visit, await derniereVisiteOdk(s.id)) });
});


/* Le rattachement fait foi : quand un site porte un geo_pcode, ses libellés
   administratifs et ses coordonnées en descendent, plutôt que d'être saisis
   séparément — c'est ce qui les empêche de diverger du référentiel. */
async function applyGeo(b){
  if(!b.geo_pcode) return b;
  const l = await labelsFor(b.geo_pcode);
  if(!l.adm1 && !l.adm2 && !l.adm3 && !l.adm4) return b;   /* p-code inconnu : on n'écrase rien */
  b.adm1 = l.adm1 || null; b.adm2 = l.adm2 || null;
  b.adm3 = l.adm3 || null; b.adm4 = l.adm4 || null;
  /* Les coordonnées propres au site priment : une école n'est pas au centroïde
     de son fokontany. Celles du référentiel ne servent que de repli. */
  if(b.lat == null) b.lat = l.lat;
  if(b.lon == null) b.lon = l.lon;
  return b;
}

r.post("/", requireCap("edit"), validate(schemas.site), async (req, res) => {
  const b = await applyGeo(req.body);
  const scope = await scopeOf(req.user);
  if(scope) b.office_id = scope;
  if(await db.prepare("SELECT 1 FROM sites WHERE code=?").get(b.code))
    return res.status(409).json({ error:"un site porte déjà ce code" });
  const id = newId("site");
  const cols = Object.keys(b).filter(k=>k!=="id");
  await db.prepare(`INSERT INTO sites (id,${cols.join(",")}) VALUES (?,${cols.map(()=>"?").join(",")})`)
    .run(id, ...cols.map(k=>b[k]));
  /* Le code par défaut est miroité dans la table des codes externes, pour que la
     liste des codes d'un site soit complète en une requête. Voir lib/alias.js. */
  synchroniserCodeParDefaut(id, b.external_code);
  await audit(req, "create", id, `Site créé — ${b.name}`);
  const nouveau = await db.prepare("SELECT * FROM sites WHERE id=?").get(id);
  /* Audit GPS automatique à l'ajout : le point est jugé contre le centroïde de sa
     commune d'accueil (méthode app.R) ; l'écran peut alerter si le verdict n'est
     pas « conforme », sans que l'utilisateur ait à lancer l'audit à la main. */
  res.status(201).json({ site: nouveau, gpsCheck: await auditerPointUnique(nouveau) });
});

/* Modification : schéma PARTIEL, et c'est essentiel.
 *
 * Avec le schéma complet, tout champ facultatif absent de la requête ressortait
 * de zod transformé en `null` (nullableStr fait `.nullish().transform(v => v ?? null)`),
 * et l'UPDATE ci-dessous, bâti sur Object.keys du corps validé, l'écrivait tel
 * quel. Autrement dit un PUT ne portant que le nom EFFAÇAIT l'antenne, la
 * catégorie, l'activité, le type de site, la durée — et le code externe, donc le
 * rattachement des soumissions à venir. C'est le même défaut que celui corrigé
 * sur PUT /api/users/:id, sur une table où il fait plus de dégâts encore.
 *
 * En partiel, un champ absent reste `undefined` et n'entre pas dans l'UPDATE,
 * tandis qu'un `null` ENVOYÉ reste un null : effacer volontairement une valeur
 * reste possible, ce qui n'aurait pas été le cas avec une simple fusion. */
r.put("/:id", requireCap("edit"), validate(schemas.site.partial()), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"site introuvable" });
  await assertScope(req, cur);
  const b = await applyGeo(req.body); const scope = await scopeOf(req.user);
  if(scope) b.office_id = scope;
  /* Révision : si le client renvoie celle qu'il a lue et qu'elle a changé depuis,
     quelqu'un d'autre a modifié ce site pendant sa saisie. On refuse plutôt que
     d'écraser en silence, et on rend la version courante pour qu'il puisse comparer. */
  if(b.rev !== undefined && Number(b.rev) !== cur.rev)
    return res.status(409).json({
      error:"ce site a été modifié pendant votre saisie. Rechargez pour repartir de la version à jour.",
      revEnvoyee:Number(b.rev), revCourante:cur.rev, courant:cur });
  delete b.rev;
  /* Les contrôles portent sur la valeur qui FERA foi après écriture, donc sur
     l'existant quand le champ n'est pas envoyé — sinon ils raisonneraient sur
     un `undefined` et laisseraient passer un doublon de code. */
  const code = b.code !== undefined ? b.code : cur.code;
  const nom  = b.name !== undefined ? b.name : cur.name;
  const dup = await db.prepare("SELECT id FROM sites WHERE code=? AND id<>?").get(code, cur.id);
  if(dup) return res.status(409).json({ error:"un autre site porte déjà ce code" });
  const cols = Object.keys(b).filter(k => k !== "id" && b[k] !== undefined);
  if(!cols.length) return res.json({ site: cur });   /* rien à écrire, rien à incrémenter */
  await db.prepare(`UPDATE sites SET ${cols.map(k=>k+"=?").join(",")}, rev=rev+1, updated_at=now() WHERE id=?`)
    .run(...cols.map(k=>b[k]), cur.id);
  /* Seulement si le code par défaut est ENVOYÉ : un PUT partiel qui ne le
     mentionne pas n'a pas à toucher aux codes du site. Et corriger ce code
     retire l'ancien du jeu — un code désavoué ne doit pas continuer à rattacher
     des soumissions en douce. Les alias importés, eux, ne bougent pas. */
  if(b.external_code !== undefined) synchroniserCodeParDefaut(cur.id, b.external_code);
  await audit(req, "update", cur.id, `Site modifié — ${nom}`);
  res.json({ site: await db.prepare("SELECT * FROM sites WHERE id=?").get(cur.id) });
});

r.delete("/:id", requireCap("del"), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"site introuvable" });
  await assertScope(req, cur);
  await db.prepare("DELETE FROM sites WHERE id=?").run(cur.id);   /* cascade sur site_months et visits */
  await audit(req, "delete", cur.id, `Site supprimé — ${cur.name}`);
  res.json({ ok:true });
});

/* Grille mensuelle : une écriture par cellule.
 *
 * « Visite ne devrais pas etre saisie que dans le cas echeant ou il y a eu une
 * visite mais qu un formulaire n a pas ete remplie et meme si c est le cas il
 * faudrait expliquer pourquoi. » La voie normale d'une visite est le formulaire
 * ODK ; cocher ici est un rattrapage, et un rattrapage se justifie. D'où quatre
 * cas distincts, et non plus un simple « crée ou supprime ».
 *
 * Le cas (a) répare une perte de données : jusqu'ici décocher la case faisait un
 * DELETE sur « une » visite du mois, prise sans ORDER BY et sans regarder d'où
 * elle venait. Une visite issue d'ODK, portant son `submission_id` et sa date
 * déclarée de collecte, s'effaçait donc d'un clic depuis un écran de
 * planification — y compris par accident, un client dont l'état est antérieur au
 * dernier tirage envoyant `done=false` en croyant ne changer que le missionnaire.
 * La garde est double, et pour deux raisons différentes : le contrôle préalable
 * pour pouvoir DIRE pourquoi c'est refusé, la clause WHERE du DELETE pour le
 * GARANTIR — une protection qui ne tient qu'à un SELECT préalable se perd à la
 * première exécution concurrente (migration 017, ligne 122). */
r.put("/:id/months", requireCap("edit"), validate(schemas.siteMonth), async (req, res) => {
  const site = await db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!site) return res.status(404).json({ error:"site introuvable" });
  await assertScope(req, site);
  const m = req.body;
  const mois = cleMois(m.year, m.month);
  const visites = await visitesDuMois(site.id, m.year, m.month);
  const protegees = visites.filter(estProtegee);
  const manuelles = visites.filter(v => !estProtegee(v));

  /* (a) Décocher un mois documenté par une soumission. Refus AVANT toute
     écriture, `site_months` compris : accepter en gardant done=1 contredirait le
     geste sans le dire, et accepter en posant done=0 laisserait une grille qui
     affirme « pas de visite » en face d'une visite réelle. Le message nomme le
     geste de rechange, et demande de recharger : la détection côté client se fait
     sur une projection plafonnée et filtrée par bureau, elle peut donc être en
     retard sur ce que le serveur voit. */
  if(!m.done && protegees.length){
    const s = protegees.find(v => v.submission_id);
    return res.status(409).json({
      error: `${mois} — ce mois porte une visite issue d'un formulaire ODK`
        + (s ? ` (soumission ${s.submission_id})` : "")
        + " : elle ne se retire pas depuis le plan. "
        /* Le geste de rechange est nommé là où il se trouve VRAIMENT — et il
           retire désormais la visite avec la soumission, sans quoi ce refus
           renverrait à un remède qui ne remédie à rien. Quand la soumission a
           disparu, la visite reste sans porte de sortie : le dire vaut mieux
           que prescrire un détachement impossible. */
        + (s ? "Si elle est erronée, détachez ou corrigez la soumission dans "
             + "Programme → Soumissions ODK — le détachement retire aussi cette visite —, "
             + "puis rechargez le plan."
             : "Elle ne porte plus d'identifiant de soumission : la soumission qui l'a "
             + "produite a été supprimée, et la visite ne peut plus être retirée depuis "
             + "aucun écran."),
      mois, visitesProtegees: protegees.length });
  }

  /* (c) Cocher un mois vierge sans dire pourquoi. Le détail suit la forme de
     validate() pour que l'interface le lise sans cas particulier. */
  if(m.done && !protegees.length && !manuelles.length && !m.manual_reason){
    return res.status(422).json({
      error: "la voie normale d'une visite est le formulaire ODK. Si la visite a bien eu lieu "
        + "sans formulaire, choisissez le motif qui l'explique avant d'enregistrer.",
      details: [{ champ:"manual_reason", message:"motif de la saisie à la main attendu" }] });
  }

  /* (b) Une soumission documente déjà ce mois : rien à créer, et aucun motif à
     exiger — ce n'est pas une exception, c'est le cas normal. */
  const couvertParOdk = m.done && protegees.length > 0;
  let visite = "aucune";
  await tx(async (db) => {
    await db.prepare(`INSERT INTO site_months (site_id,year,month,active,planned,done,cp_name,monitor,report,moda)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(site_id,year,month) DO UPDATE SET
                  active=?, planned=?, done=?, cp_name=?,
                  monitor=?, report=?, moda=?`)
      .run(site.id, m.year, m.month, m.active?1:0, m.planned?1:0, m.done?1:0, m.cp_name, m.monitor, m.report, m.moda,
           m.active?1:0, m.planned?1:0, m.done?1:0, m.cp_name, m.monitor, m.report, m.moda);
    if(couvertParOdk){ /* (b) : la soumission fait foi, la grille se contente de la refléter */ }
    /* (d) Une saisie existe déjà : pas de doublon. Mais un motif envoyé REMPLACE
       celui de la ligne — sans quoi corriger un motif choisi par erreur
       supposerait de supprimer la visite, c'est-à-dire de faire disparaître la
       donnée pour réparer son étiquette. */
    else if(m.done && manuelles.length){
      /* La note n'est réécrite que si la requête la PORTE. Absente, elle est
         conservée : corriger un motif ne doit pas effacer la précision écrite
         six mois plus tôt, que l'appelant n'avait aucune raison de recopier — et
         qu'il ne connaît pas toujours, la projection des visites étant plafonnée
         et filtrée par bureau. Envoyer `manual_note:null` reste le geste
         explicite pour l'effacer. */
      const noteRecue = Object.hasOwn(m, "manual_note");
      const note = noteRecue ? (m.manual_note ?? null) : null;
      /* Rien n'a bougé : le journal n'a pas à annoncer une correction. Il n'est
         rendu qu'à ses soixante dernières lignes, et trois agents complétant
         leurs fiches de mission en évacueraient tout le reste en une séance. */
      const change = manuelles.some(v => v.manual_reason !== m.manual_reason
        || (noteRecue && (v.manual_note || null) !== note));
      if(m.manual_reason && change){
        /* Même clause de garde que le DELETE, et pour la même raison : ce que
           cette route peut réécrire est exactement ce qu'elle a pu créer. Une
           ligne issue d'un formulaire ne se voit pas attribuer un motif de
           rattrapage, fût-ce par une transaction concurrente. */
        await db.prepare(`UPDATE visits SET manual_reason=?${noteRecue ? ", manual_note=?" : ""}
                    WHERE site_id=? AND visit_date LIKE ?
                      AND origin='manuelle' AND submission_id IS NULL`)
          .run(m.manual_reason, ...(noteRecue ? [note] : []), site.id, `${mois}%`);
        visite = "corrigee";
      } else visite = "conservee";
    }
    else if(m.done){
      /* Le 15 du mois est une convention : la saisie ne sait pas quel jour. La
         visite issue d'ODK, elle, porte la date déclarée de collecte. */
      const date = `${mois}-15`;
      await db.prepare(`INSERT INTO visits (id,site_id,office_id,visit_date,activity_tag,monitor,
                                      form_id,status,origin,manual_reason,manual_note,created_by)
                  VALUES (?,?,?,?,?,?,'saisie','À valider','manuelle',?,?,?)`)
        .run(newId("visit"), site.id, site.office_id, date, site.activity_tag, m.monitor,
             m.manual_reason, m.manual_note ?? null, req.user.id);
      await db.prepare("UPDATE sites SET last_visit=? WHERE id=? AND (last_visit IS NULL OR last_visit < ?)")
        .run(date, site.id, date);
      visite = "creee";
    }
    /* La garantie est portée par la clause WHERE, pas par le contrôle préalable,
       et elle vaut au pluriel : sur une base ayant accumulé deux saisies le même
       mois, décocher les retire toutes — ce que l'ancien `.get()` sans ORDER BY
       ne faisait qu'au hasard, en en laissant une derrière lui. */
    else if((await db.prepare(`DELETE FROM visits WHERE site_id=? AND visit_date LIKE ?
                        AND origin='manuelle' AND submission_id IS NULL`)
      .run(site.id, `${mois}%`)).changes){
      visite = "supprimee";
      /* La date de dernière visite saisie ne survit pas à la visite qui l'a
         posée : sans cela le site continuait d'annoncer le 15 d'un mois vide, et
         le score de risque, l'ancienneté et la priorité se calculaient sur une
         visite fantôme. On ne touche QUE la valeur que cette route avait écrite
         — la convention du 15 du mois — et on la remplace par la dernière saisie
         restante, jamais par une date ODK, qui est servie à côté et non à la
         place (voir `combinerDerniereVisite`). */
      await db.prepare(`UPDATE sites SET last_visit=
                    (SELECT MAX(visit_date) FROM visits WHERE site_id=? AND origin='manuelle')
                  WHERE id=? AND last_visit=?`).run(site.id, site.id, `${mois}-15`);
    }
  });

  await audit(req, "plan", site.id, `Fiche mensuelle mise à jour — ${site.name}`);
  /* Une ligne dédiée par saisie à la main, portant le motif en clair : le
     journal doit permettre de relire six mois plus tard pourquoi une visite ne
     vient d'aucun formulaire, sans avoir à rouvrir la fiche. */
  if(visite === "creee" || visite === "corrigee")
    await audit(req, "plan", site.id, `${mois} — visite saisie à la main `
      + `${visite === "creee" ? "" : "(motif corrigé) "}: ${libelleMotif(m.manual_reason)}`
      + `${m.manual_note ? ` — ${m.manual_note}` : ""} — ${site.name}`);
  if(visite === "supprimee")
    await audit(req, "plan", site.id, `${mois} — visite saisie à la main retirée — ${site.name}`);

  const message = couvertParOdk
    ? `${mois} — une soumission ODK documente déjà ce mois : le suivi est enregistré, `
      + "aucune visite saisie à la main n'a été créée."
    : "";
  res.json({ ok:true, visite, couvertParOdk, message });
});

/* Modification groupée : un seul champ, une liste d'identifiants, une transaction. */
const BULK_FIELDS = new Set(["office_id","activity_tag","poi_subtype","modality","partner_id",
  "urban_area","status","security","responsible","antenne","category_id","site_type"]);
r.post("/bulk", requireCap("edit"), async (req, res) => {
  const p = z.object({ ids: z.array(z.string().max(64)).min(1).max(5000),
    field: z.string().max(40), value: z.union([z.string().max(200), z.number(), z.null()]) })
    .safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"requête groupée invalide" });
  const { ids, field, value } = p.data;
  if(!BULK_FIELDS.has(field))
    return res.status(422).json({ error:`le champ « ${field} » n'est pas modifiable en masse` });
  const scope = await scopeOf(req.user);
  /* Le WHERE ci-dessous limite QUELLES lignes sont touchées (celles du bureau du
     compte), mais pas la VALEUR écrite : sans ce garde, un compte cloisonné
     pourrait réaffecter en masse ses propres sites à un AUTRE bureau — les
     transférer ou les orpheliner. `POST /` et `PUT /:id` forcent déjà
     office_id=scope pour l'interdire à l'unité ; on tient le même invariant en
     masse. Un compte national/super (scope null) reste libre de réaffecter. */
  if(field === "office_id" && scope)
    return res.status(403).json({ error:"un compte rattaché à un bureau ne peut pas réaffecter ses sites à un autre bureau en masse" });
  /* `rev=rev+1` n'est pas optionnel : PUT /:id refuse en 409 quand le rev envoyé
     ne correspond plus (verrou optimiste anti-écrasement). Si le bulk laissait rev
     inchangé, un éditeur ayant chargé le site avant la modification groupée
     conserverait le même rev, son PUT passerait le contrôle et écraserait en
     silence ce que le bulk vient d'écrire. On incrémente donc rev comme le fait
     PUT /:id et l'import Excel. */
  let n = 0;
  /* Une valeur que la base refuse — un statut hors ('Active','Inactive'), une clé
     étrangère inconnue — remontait en « erreur interne » 500, c'est-à-dire en panne
     du serveur, alors que c'est une saisie à corriger. On la nomme : l'opérateur qui
     lance une modification sur 500 sites doit lire CE QUI ne passe pas, pas un
     message qui l'envoie ouvrir un ticket. */
  try{
    await tx(async (db) => {
      const stmt = db.prepare(`UPDATE sites SET ${field}=?, rev=rev+1, updated_at=now()
                               WHERE id=? ${scope ? "AND office_id=?" : ""}`);
      for(const id of ids) n += (await stmt.run(value, id, ...(scope?[scope]:[]))).changes;
    });
  }catch(e){
    /* Wording PostgreSQL : « violates check/foreign key/not-null/unique
       constraint » (SQLite disait « CHECK constraint »…). Insensible à la casse. */
    if(/check constraint|foreign key|not[- ]null|unique|violates/i.test(e.message))
      return res.status(422).json({ error:
        `la valeur « ${value === null ? "(vide)" : value} » n'est pas admise pour le champ `
        + `« ${field} » : la base l'a refusée. Aucun site n'a été modifié.` });
    throw e;
  }
  await audit(req, "bulk", null, `Modification groupée de ${n} site(s) — ${field}`);
  res.json({ updated:n });
});
export default r;
