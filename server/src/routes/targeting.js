import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { currentVersion, LEVELS } from "../lib/geo.js";
import { scopeOf } from "../lib/scope.js";

/* ── Ciblage daté ─────────────────────────────────────────────────────
   Le ciblage se refait dans le temps ; on garde CHAQUE événement, daté, avec sa
   raison et son genre. Le « dernier ciblage » d'une unité pour une activité est
   la ligne à la date la plus récente. On sélectionne des districts/communes en
   amont, on leur affecte un ciblage (personnes, ménages, genre, raison, date),
   puis on peut extraire un classeur prérempli — seules les unités ciblées y
   figurent — modifiable puis réimportable dans le flux d'import existant. */
const r = Router();

/* Le chemin d'une unité (pour le cloisonnement par bureau) et son libellé. */
function chargerUnites(v){
  return Object.fromEntries(db.prepare(
    `SELECT u.pcode, u.name, u.path, u.level, p1.name p1, p2.name p2, p3.name p3
     FROM geo_unit u
     LEFT JOIN geo_unit p1 ON p1.version_id=u.version_id AND p1.pcode=u.parent_pcode
     LEFT JOIN geo_unit p2 ON p2.version_id=u.version_id AND p2.pcode=p1.parent_pcode
     LEFT JOIN geo_unit p3 ON p3.version_id=u.version_id AND p3.pcode=p2.parent_pcode
     WHERE u.version_id=?`).all(v.id).map(u => [u.pcode, u]));
}

const dansPerimetre = (scope, path) => scope.unbounded
  || (path && scope.paths.some(p => path === p || path.startsWith(p + "/")));

/* Les libellés d'ancêtres d'une unité, rangés par niveau (adm1/adm2/adm3…). */
function libellesAncetres(u){
  const out = {}; const depth = LEVELS.indexOf(u.level);
  [u.p1, u.p2, u.p3].forEach((nm, i) => { const lvl = LEVELS[depth-1-i];
    if(lvl && nm != null) out[lvl] = nm; });
  out[u.level] = u.name;
  return out;
}

/* GET /api/targeting — les ciblages datés de l'année, chacun rattaché à son
   unité, avec un drapeau « dernier » (le plus récent par unité × activité). */
r.get("/", (req, res) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    tag:  z.string().max(20).optional(),
    onlyLast: z.coerce.boolean().optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, tag, onlyLast } = q.data;

  const v = currentVersion();
  if(!v) return res.json({ year, rows:[], reasons:[] });
  const unites = chargerUnites(v);
  const scope = scopeOf(req.user);

  const where = ["year=?"]; const args = [year];
  if(tag !== undefined){ where.push("activity_tag=?"); args.push(tag); }
  const brut = db.prepare(
    `SELECT * FROM targeting WHERE ${where.join(" AND ")} ORDER BY targeted_at DESC, created_at DESC`)
    .all(...args);

  /* Le dernier par (unité, activité) : premier vu en ordre décroissant de date. */
  const vus = new Set();
  const rows = [];
  for(const t of brut){
    const u = unites[t.geo_pcode];
    if(!u || !dansPerimetre(scope, u.path)) continue;
    const cle = `${t.geo_pcode}|${t.activity_tag}`;
    const dernier = !vus.has(cle); vus.add(cle);
    if(onlyLast && !dernier) continue;
    rows.push({ id:t.id, pcode:t.geo_pcode, name:u.name, level:t.level,
      year:t.year, tag:t.activity_tag, targetedAt:t.targeted_at,
      targeted:t.targeted, targetedHh:t.targeted_hh, gender:t.gender||"",
      reason:t.reason||"", note:t.note||"", dernier, ...libellesAncetres(u) });
  }
  res.json({ year, rows, version:{ id:v.id, label:v.label } });
});

/* POST /api/targeting — enregistre UN ciblage (une date, une activité, une
   raison, un genre) sur une ou plusieurs unités sélectionnées en amont. */
const corpsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  activity_tag: z.string().max(20).default(""),
  targeted_at: z.string().min(4).max(20),        /* ISO date */
  gender: z.string().max(30).nullish().transform(v => v ?? null),
  reason: z.string().max(60).nullish().transform(v => v ?? null),
  note: z.string().max(500).nullish().transform(v => v ?? null),
  units: z.array(z.object({
    geo_pcode: z.string().min(1).max(64),
    level: z.enum(["adm1","adm2","adm3","adm4"]).default("adm3"),
    targeted: z.coerce.number().int().min(0).default(0),
    targeted_hh: z.coerce.number().int().min(0).default(0),
  })).min(1).max(5000),
});

r.post("/", requireCap("edit"), (req, res) => {
  const parsed = corpsSchema.safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"données invalides",
    details: parsed.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const d = parsed.data;

  const v = currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant : chargez un millésime d'abord" });
  const unites = chargerUnites(v);
  const scope = scopeOf(req.user);

  const rejets = [];
  const ok = d.units.filter((x, i) => {
    const u = unites[x.geo_pcode];
    if(!u){ rejets.push({ ligne:i+1, pcode:x.geo_pcode, message:"p-code absent du référentiel" }); return false; }
    if(!dansPerimetre(scope, u.path)){ rejets.push({ ligne:i+1, pcode:x.geo_pcode, message:"hors de votre périmètre" }); return false; }
    return true;
  });

  const ins = db.prepare(`INSERT INTO targeting
    (id,geo_pcode,level,year,activity_tag,targeted_at,targeted,targeted_hh,gender,reason,note,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  let crees = 0;
  tx(() => { for(const x of ok){
    ins.run(newId("tg"), x.geo_pcode, x.level, d.year, d.activity_tag, d.targeted_at,
      x.targeted, x.targeted_hh, d.gender, d.reason, d.note, req.user.id);
    crees++;
  } })();

  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','targeting','cibler',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name,
      `Ciblage daté du ${d.targeted_at}${d.activity_tag?` (${d.activity_tag})`:""}${d.reason?` — ${d.reason}`:""} : ${crees} unité(s)`);

  res.json({ crees, rejetes: rejets.length, rejets: rejets.slice(0,20) });
});

r.delete("/:id", requireCap("edit"), (req, res) => {
  const row = db.prepare("SELECT * FROM targeting WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({ error:"ciblage introuvable" });
  const v = currentVersion();
  const u = v && db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, row.geo_pcode);
  if(!dansPerimetre(scopeOf(req.user), u?.path)) return res.status(403).json({ error:"hors de votre périmètre" });
  db.prepare("DELETE FROM targeting WHERE id=?").run(req.params.id);
  res.json({ ok:true });
});

/* GET /api/targeting/extract — le classeur PRÉREMPLI des unités ciblées, et
   d'elles seules : le dernier ciblage par unité (× activité), modifiable puis
   réimportable. « Seules les unités ciblées s'afficheront dans l'extract. » */
r.get("/extract", async (req, res, next) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    tag:  z.string().max(20).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, tag } = q.data;

  const v = currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant" });
  const unites = chargerUnites(v);
  const scope = scopeOf(req.user);

  const where = ["year=?"]; const args = [year];
  if(tag !== undefined){ where.push("activity_tag=?"); args.push(tag); }
  const brut = db.prepare(
    `SELECT * FROM targeting WHERE ${where.join(" AND ")} ORDER BY targeted_at DESC, created_at DESC`)
    .all(...args);

  const vus = new Set(); const lignes = [];
  for(const t of brut){
    const u = unites[t.geo_pcode]; if(!u || !dansPerimetre(scope, u.path)) continue;
    const cle = `${t.geo_pcode}|${t.activity_tag}`; if(vus.has(cle)) continue; vus.add(cle);
    const anc = libellesAncetres(u);
    lignes.push({ region:anc.adm1||"", district:anc.adm2||"", commune:anc.adm3||"",
      pcode:t.geo_pcode, activite:t.activity_tag, date:t.targeted_at,
      cibles:t.targeted, menages:t.targeted_hh, genre:t.gender||"", raison:t.reason||"", note:t.note||"" });
  }

  try{
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ciblage", { views:[{ state:"frozen", ySplit:1 }] });
    ws.columns = [
      { header:"Région", key:"region", width:20 },
      { header:"District", key:"district", width:20 },
      { header:"Commune", key:"commune", width:22 },
      { header:"P-code", key:"pcode", width:16 },
      { header:"Activité", key:"activite", width:12 },
      { header:"Date du ciblage", key:"date", width:16 },
      { header:"Personnes ciblées", key:"cibles", width:16 },
      { header:"Ménages ciblés", key:"menages", width:15 },
      { header:"Genre", key:"genre", width:12 },
      { header:"Raison", key:"raison", width:16 },
      { header:"Note", key:"note", width:30 },
    ];
    ws.getRow(1).font = { bold:true };
    ws.getRow(1).fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF0B4F6C" } };
    ws.getRow(1).font = { bold:true, color:{ argb:"FFFFFFFF" } };
    for(const l of lignes) ws.addRow(l);

    const nom = `mems_ciblage_${year}${tag?`_${tag}`:""}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nom}"`);
    await wb.xlsx.write(res);
    res.end();
  }catch(e){ next(e); }
});

export default r;
