import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { buildUnits, writeVersion, currentVersion, LEVELS } from "../lib/geo.js";
import { countryBound, scopeOf, declaredFor, unitsIn, outsideDeclared } from "../lib/scope.js";
import { ctxCountry } from "../lib/ctx.js";
import { extent, geomSummary, readGeometries, writeGeometries } from "../lib/geom.js";

const r = Router();

/* Toutes les lectures portent sur le millésime courant. Sans référentiel chargé,
   les routes répondent vide plutôt que d'échouer : l'interface reste utilisable. */
const version = () => currentVersion();

/* Un fokontany porte ses ancêtres : quatre jointures sur la chaîne des parents.
   Le niveau détermine à quoi correspond chaque ancêtre. */
const ANCESTRY = `
  LEFT JOIN geo_unit p1 ON p1.version_id=u.version_id AND p1.pcode=u.parent_pcode
  LEFT JOIN geo_unit p2 ON p2.version_id=u.version_id AND p2.pcode=p1.parent_pcode
  LEFT JOIN geo_unit p3 ON p3.version_id=u.version_id AND p3.pcode=p2.parent_pcode
  LEFT JOIN geo_unit p4 ON p4.version_id=u.version_id AND p4.pcode=p3.parent_pcode`;

const shape = (x) => {
  const depth = LEVELS.indexOf(x.level);
  const out = { pcode:x.pcode, level:x.level, name:x.name, lat:x.lat, lon:x.lon,
                parent_pcode:x.parent_pcode };
  /* p1 est le parent direct, donc le niveau juste au-dessus. */
  [x.p1, x.p2, x.p3, x.p4].forEach((nm, i) => {
    const lvl = LEVELS[depth-1-i]; if(lvl && nm != null) out[lvl] = nm; });
  out[x.level] = x.name;
  return out;
};

/* ── Listes en cascade ───────────────────────────────────────────────
   Un appel par niveau, piloté par le code du parent. Le navigateur ne charge
   jamais les 18 000 fokontany : il demande les enfants de ce qu'il affiche. */
r.get("/levels", (req, res) => {
  const q = z.object({
    parent: z.string().max(64).optional(),
    level:  z.enum(LEVELS).optional(),
    limit:  z.coerce.number().int().min(1).max(5000).default(3000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const v = version();
  if(!v) return res.json({ level:null, rows:[], version:null });

  const { parent, level, limit } = q.data;
  let rows;
  if(parent){
    rows = db.prepare(`SELECT pcode, name, level FROM geo_unit
      WHERE version_id=? AND parent_pcode=? ORDER BY name LIMIT ?`).all(v.id, parent, limit);
  } else if(level){
    rows = db.prepare(`SELECT pcode, name, level FROM geo_unit
      WHERE version_id=? AND level=? ORDER BY name LIMIT ?`).all(v.id, level, limit);
  } else {
    /* Sans parent : on entre par les régions. Le pays est un niveau technique,
       il n'a pas à être choisi dans une liste — sauf s'il est tout ce qu'on a. */
    const present = new Set(db.prepare(
      `SELECT DISTINCT level FROM geo_unit WHERE version_id=?`).all(v.id).map(x => x.level));
    const top = LEVELS.find(l => l !== "adm0" && present.has(l)) || (present.has("adm0") ? "adm0" : null);
    rows = top ? db.prepare(`SELECT pcode, name, level FROM geo_unit
      WHERE version_id=? AND level=? ORDER BY name LIMIT ?`).all(v.id, top, limit) : [];
  }
  res.json({ level: rows[0]?.level ?? null, rows,
    version: { id:v.id, label:v.label, units:v.units } });
});

/* ── Répertoire paginé ─────────────────────────────────────────────── */
r.get("/", (req, res) => {
  const q = z.object({
    parent: z.string().max(64).optional(),
    level:  z.enum(LEVELS).optional(),
    search: z.string().max(120).optional(),
    limit:  z.coerce.number().int().min(1).max(1000).default(300),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const v = version();
  if(!v) return res.json({ total:0, rows:[], version:null });

  const { parent, level, search, limit, offset } = q.data;
  const where = ["u.version_id = ?"]; const args = [v.id];
  if(level){ where.push("u.level = ?"); args.push(level); }
  if(parent){
    /* Tout ce qui descend du parent, à n'importe quelle profondeur : le chemin
       matérialisé évite une récursion. */
    const p = db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, parent);
    if(!p) return res.json({ total:0, rows:[], version:{ id:v.id, label:v.label } });
    where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%");
  }
  if(search){
    where.push("(u.name LIKE ? OR u.name_norm LIKE ? OR u.pcode LIKE ?)");
    const s = `%${search}%`; args.push(s, s.toLowerCase(), s);
  }
  const w = "WHERE " + where.join(" AND ");
  const total = db.prepare(`SELECT COUNT(*) c FROM geo_unit u ${w}`).get(...args).c;
  const rows = db.prepare(
    `SELECT u.pcode, u.level, u.name, u.parent_pcode, u.lat, u.lon,
            p1.name p1, p2.name p2, p3.name p3, p4.name p4
     FROM geo_unit u ${ANCESTRY} ${w}
     ORDER BY u.path LIMIT ? OFFSET ?`).all(...args, limit, offset);
  res.json({ total, rows: rows.map(shape),
    version: { id:v.id, label:v.label, units:v.units } });
});

/* ── Couverture géographique ─────────────────────────────────────────
   « Quelles unités ne portent aucun site ? » — la question que le modèle plat
   ne savait pas poser. Un site rattaché à un fokontany compte aussi pour sa
   commune, son district et sa région : le comptage se fait par préfixe de chemin.

   Deux requêtes plutôt qu'une jointure sur LIKE : à quelques milliers de sites
   le regroupement en mémoire est exact et instantané, là où la jointure
   comparerait chaque unité à chaque site. */
r.get("/coverage", (req, res) => {
  const q = z.object({
    parent: z.string().max(64).optional(),
    level:  z.enum(["adm1","adm2","adm3","adm4"]).default("adm3"),
    limit:  z.coerce.number().int().min(1).max(5000).default(1000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const v = version();
  if(!v) return res.json({ level:q.data.level, total:0, covered:0, rows:[], version:null });

  const { parent, level, limit } = q.data;
  const where = ["u.version_id = ?", "u.level = ?"]; const args = [v.id, level];
  if(parent){
    const p = db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, parent);
    if(!p) return res.json({ level, total:0, covered:0, rows:[], version:{ id:v.id, label:v.label } });
    where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%");
  }
  const units = db.prepare(
    `SELECT u.pcode, u.name, u.path, p1.name p1, p2.name p2, p3.name p3, p4.name p4
     FROM geo_unit u ${ANCESTRY}
     WHERE ${where.join(" AND ")} ORDER BY u.path LIMIT ?`).all(...args, limit);

  /* Chaque site apporte le chemin de l'unité à laquelle il est rattaché.
     Le cloisonnement par bureau s'applique ici comme partout ailleurs. */
  const scoped = !scopeOf(req.user).unbounded;
  const sites = db.prepare(
    `SELECT s.status, s.last_visit, gu.path
     FROM sites s JOIN geo_unit gu ON gu.pcode = s.geo_pcode AND gu.version_id = ?
     ${scoped ? "WHERE s.office_id = ?" : ""}`).all(...(scoped ? [v.id, req.user.office_id] : [v.id]));

  const rows = units.map(u => {
    const mine = sites.filter(s => s.path === u.path || s.path.startsWith(u.path + "/"));
    const last = mine.map(s => s.last_visit).filter(Boolean).sort().pop() || "";
    const depth = LEVELS.indexOf(level);
    const out = { pcode:u.pcode, name:u.name, sites:mine.length,
      active: mine.filter(s => s.status === "Active").length,
      inactive: mine.filter(s => s.status === "Inactive").length,
      lastVisit: last };
    [u.p1, u.p2, u.p3, u.p4].forEach((nm, i) => {
      const lvl = LEVELS[depth-1-i]; if(lvl && nm != null) out[lvl] = nm; });
    return out;
  });

  res.json({ level, total: rows.length, covered: rows.filter(x => x.sites > 0).length,
    sitesLinked: sites.length,
    sitesUnlinked: db.prepare(
      `SELECT COUNT(*) c FROM sites WHERE geo_pcode IS NULL ${scoped ? "AND office_id=?" : ""}`)
      .get(...(scoped ? [req.user.office_id] : [])).c,
    rows, version:{ id:v.id, label:v.label } });
});

/* ── Millésimes ────────────────────────────────────────────────────── */
r.get("/versions", (req, res) => {
  /* Les millésimes d'un autre pays ne s'affichent pas : ils décrivent une géographie
     dans laquelle l'appelant ne travaille pas, et un clic malheureux sur « rendre
     courant » y déplacerait tout son écran. Le filtre suit le pays de la requête et
     non celui du compte : un administrateur d'instance qui se place au Congo veut la
     liste du Congo. */
  const pays = ctxCountry()?.code || null;
  res.json({ rows: db.prepare(`SELECT v.*, u.first_name AS by_name
    FROM geo_version v LEFT JOIN users u ON u.id=v.imported_by
    WHERE (v.country IS ? OR ? IS NULL) ORDER BY v.imported_at DESC`).all(pays, pays).map(x => ({
      id:x.id, label:x.label, source:x.source, units:x.units,
      importedAt:x.imported_at, importedBy:x.by_name || "", current: !!x.is_current,
      /* L'état des contours accompagne le millésime : sans lui l'écran de
         configuration ne saurait pas s'il y a un fond de carte à afficher. */
      geom: { units:x.geom_units || 0, source:x.geom_source || "", at:x.geom_at || null,
              parNiveau: x.geom_units ? geomSummary(x.id) : [] } })) });
});

r.put("/versions/:id/current", requireCap("admin"), (req, res) => {
  const v = db.prepare("SELECT * FROM geo_version WHERE id=?").get(req.params.id);
  if(!v) return res.status(404).json({ error:"millésime introuvable" });
  /* Activer le millésime d'un autre pays changerait la géographie de ce pays-là
     depuis un écran qui n'y appartient pas. Introuvable, pour ne pas le confirmer. */
  const mien = countryBound(req.user);
  if(mien && v.country && v.country !== mien)
    return res.status(404).json({ error:"millésime introuvable" });
  db.transaction(() => {
    /* Un courant par pays : activer un millésime ne retire pas le référentiel des
       autres pays configurés. */
    db.prepare("UPDATE geo_version SET is_current=0 WHERE is_current=1 AND country IS ?")
      .run(v.country ?? null);
    db.prepare("UPDATE geo_version SET is_current=1 WHERE id=?").run(v.id);
  })();
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','geo_version',?,'activate',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, v.id,
         `Référentiel courant : « ${v.label} » (${v.units} unités)`);
  res.json({ ok:true, current:v.id });
});

/* ── Import ────────────────────────────────────────────────────────── */
r.post("/bulk", requireCap("admin"), validate(schemas.geoBulk), (req, res) => {
  const { rows, label, source } = req.body;
  const { units, rejected, collisions, counts } = buildUnits(rows);
  if(collisions.length) return res.status(409).json({
    error:"collision de code : un même p-code désigne deux unités différentes",
    details: collisions.slice(0,10).map(c => ({ pcode:c.pcode, chemins:[c.a, c.b] })) });
  if(!units.length) return res.status(422).json({
    error:"aucune unité exploitable : vérifiez la correspondance des colonnes" });

  const id = writeVersion({
    label: label || `Import du ${new Date().toISOString().slice(0,10)}`,
    source: source || null, units, userId: req.user.id });

  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','geo_version',?,'import',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, id,
         `Référentiel importé : ${units.length} unités (${counts.adm3||0} communes, ${counts.adm4||0} fokontany)`);

  res.json({ versionId:id, imported:units.length, counts,
    rejected: rejected.length, rejectedSample: rejected.slice(0,10) });
});


/* ── Géométries administratives ──────────────────────────────────────
   Le référentiel ne portait que des points ; la carte projetait des cercles sur
   un fond vide. Une commune non couverte était donc invisible — c'est un vide, et
   un vide ne se dessine pas avec des points.

   L'import se fait par LOTS. Les contours d'un pays entier ne passent pas dans un
   corps de requête, et les charger d'un coup en mémoire serveur reviendrait à
   déplacer le problème. Le client découpe, envoie, et le premier lot porte
   `reset` : sans lui, deux imports successifs mêleraient leurs contours. */
r.post("/geometry", requireCap("admin"), (req, res) => {
  const p = z.object({
    versionId: z.string().max(64).optional(),
    reset: z.boolean().default(false),
    source: z.string().max(200).optional(),
    features: z.array(z.object({
      /* L'un ou l'autre : le p-code s'il figure dans le millésime, sinon le chemin
         de noms, que le serveur résout comme il résout celui d'un site. */
      pcode: z.string().max(64).optional(),
      names: z.object({ adm0:z.string().max(120).optional(), adm1:z.string().max(120).optional(),
        adm2:z.string().max(120).optional(), adm3:z.string().max(120).optional(),
        adm4:z.string().max(120).optional() }).optional(),
      geometry: z.object({
        type: z.enum(["Polygon", "MultiPolygon"]),
        /* La géométrie n'est pas validée sommet par sommet : un contour de commune
           compte des milliers de points, et Zod y passerait plus de temps que la
           simplification elle-même. La validation utile — domaine des degrés,
           anneaux fermés — est faite par lib/geom.js, une fois. */
        coordinates: z.any(),
      }),
    })).min(1).max(400),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"lot de géométries invalide",
    details:p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });

  const v = p.data.versionId
    ? db.prepare("SELECT * FROM geo_version WHERE id=?").get(p.data.versionId)
    : version();
  if(!v) return res.status(409).json({ error:"aucun millésime : chargez d'abord un découpage" });

  const bilan = writeGeometries({ versionId:v.id, features:p.data.features,
    reset:p.data.reset, source:p.data.source });

  /* Une seule entrée au journal par import, posée au premier lot : une ligne par
     lot noierait le journal sous cent entrées pour un seul geste. */
  if(p.data.reset)
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'plan','geo_geom',?,'import',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name, v.id,
           `Import de contours administratifs${p.data.source ? ` — ${p.data.source}` : ""}`);
  res.json(bilan);
});

r.get("/geometry", (req, res) => {
  const q = z.object({
    level: z.enum(LEVELS).optional(),
    parent: z.string().max(64).optional(),
    /* Pas de z.coerce.boolean : Boolean("false") vaut true, et « detail=false »
       aurait donc demandé la pleine résolution — exactement l'inverse. */
    detail: z.enum(["true","false","1","0"]).optional()
      .transform(v => v === "true" || v === "1"),
    limit: z.coerce.number().int().min(1).max(4000).default(1200),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const v = version();
  if(!v) return res.json({ type:"FeatureCollection", features:[], extent:null, version:null });

  const { features, tronque } = readGeometries({ versionId:v.id, ...q.data });
  res.json({
    type:"FeatureCollection", features,
    /* Le cadre porte sur l'ENSEMBLE demandé, pas sur ce qui a été renvoyé : caler
       la carte sur un extrait tronqué la ferait sauter à chaque changement de
       filtre. */
    extent: extent({ versionId:v.id, level:q.data.level, parent:q.data.parent }),
    tronque, version:{ id:v.id, label:v.label },
  });
});

r.delete("/geometry", requireCap("admin"), (req, res) => {
  const v = version();
  if(!v) return res.status(409).json({ error:"aucun millésime courant" });
  const n = db.prepare("DELETE FROM geo_geom WHERE version_id=?").run(v.id).changes;
  db.prepare("UPDATE geo_version SET geom_units=0, geom_source=NULL, geom_at=NULL WHERE id=?").run(v.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','geo_geom',?,'delete',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, v.id,
         `Contours administratifs retirés — ${n} unité(s)`);
  res.json({ ok:true, supprimes:n });
});

/* ── Périmètre géographique des bureaux ──────────────────────────────
   Déclaratif : on attribue à un bureau les unités qu'il couvre, à n'importe quel
   niveau. Le périmètre effectif est tout ce qui en descend. Tant qu'un bureau n'a
   rien de déclaré, il est déduit de ses données — le champ `source` le dit. */
r.get("/scope", (req, res) => {
  const v = version();
  const offices = db.prepare("SELECT id, name, code, kind FROM offices ORDER BY name").all();
  res.json({ rows: offices.map(o => {
    const sc = scopeOf({ role:"editor", office_id:o.id });
    const hors = outsideDeclared(o.id);
    return { office_id:o.id, name:o.name, code:o.code, kind:o.kind,
      source: sc.source,
      units: declaredFor(o.id).map(u => ({ pcode:u.geo_pcode, name:u.name, level:u.level })),
      /* Combien d'unités le périmètre couvre réellement, une fois descendu. */
      communes: v ? unitsIn(sc, "adm3").length : 0,
      horsPerimetre: hors.declared ? { sites:hors.sites, pdd:hors.pdd } : null };
  }) });
});

r.put("/scope/:officeId", requireCap("admin"), (req, res) => {
  const office = db.prepare("SELECT * FROM offices WHERE id=?").get(req.params.officeId);
  if(!office) return res.status(404).json({ error:"bureau introuvable" });
  const p = z.object({ pcodes: z.array(z.string().max(64)).max(2000) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"liste d'unités invalide" });

  const v = version();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant" });
  const connus = new Set(db.prepare("SELECT pcode FROM geo_unit WHERE version_id=?")
    .all(v.id).map(x => x.pcode));
  const inconnus = p.data.pcodes.filter(c => !connus.has(c));
  if(inconnus.length) return res.status(422).json({
    error:"certaines unités sont absentes du référentiel courant",
    details: inconnus.slice(0,10).map(c => ({ champ:"pcode", message:c })) });

  db.transaction(() => {
    db.prepare("DELETE FROM office_scope WHERE office_id=?").run(office.id);
    const ins = db.prepare(`INSERT INTO office_scope (office_id,geo_pcode,created_by)
                            VALUES (?,?,?)`);
    for(const c of p.data.pcodes) ins.run(office.id, c, req.user.id);
  })();

  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','office_scope',?,'update',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, office.id,
         `Périmètre de ${office.name} : ${p.data.pcodes.length} unité(s) attribuée(s)`);

  const sc = scopeOf({ role:"editor", office_id:office.id });
  res.json({ ok:true, attribuees:p.data.pcodes.length,
    communes: unitsIn(sc, "adm3").length, source:sc.source });
});

export default r;
