import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { buildUnits, writeVersion, currentVersion, LEVELS } from "../lib/geo.js";

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

/* ── Millésimes ────────────────────────────────────────────────────── */
r.get("/versions", (req, res) => {
  res.json({ rows: db.prepare(`SELECT v.*, u.first_name AS by_name
    FROM geo_version v LEFT JOIN users u ON u.id=v.imported_by
    ORDER BY v.imported_at DESC`).all().map(x => ({
      id:x.id, label:x.label, source:x.source, units:x.units,
      importedAt:x.imported_at, importedBy:x.by_name || "", current: !!x.is_current })) });
});

r.put("/versions/:id/current", requireCap("admin"), (req, res) => {
  const v = db.prepare("SELECT * FROM geo_version WHERE id=?").get(req.params.id);
  if(!v) return res.status(404).json({ error:"millésime introuvable" });
  db.transaction(() => {
    db.prepare("UPDATE geo_version SET is_current=0 WHERE is_current=1").run();
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

export default r;
