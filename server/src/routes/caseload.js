import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { currentVersion, LEVELS } from "../lib/geo.js";
import { scopeOf, covers } from "../lib/scope.js";

const r = Router();

/* ── Les nombres ─────────────────────────────────────────────────────
   Par unité et par période : population, ménages, personnes ciblées, puis le
   plan de distribution en regard. Trois taux en découlent :
     ciblage      = ciblés / population
     couverture   = bénéficiaires planifiés / ciblés
     réalisation  = bénéficiaires servis / planifiés                            */
r.get("/", async (req, res) => {
  const q = z.object({
    year:   z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    month:  z.coerce.number().int().min(0).max(11).optional(),
    level:  z.enum(["adm1","adm2","adm3","adm4"]).default("adm3"),
    parent: z.string().max(64).optional(),
    tag:    z.string().max(20).optional(),   /* activité ; absent = total dédoublonné */
    limit:  z.coerce.number().int().min(1).max(5000).default(2000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, month, level, parent, tag, limit } = q.data;

  const v = currentVersion();
  if(!v) return res.json({ year, month:month ?? null, level, rows:[], totals:null, version:null });

  /* Unités du niveau demandé, avec leurs ancêtres. */
  const where = ["u.version_id = ?", "u.level = ?"]; const args = [v.id, level];
  if(parent){
    const p = await db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, parent);
    if(!p) return res.json({ year, month:month ?? null, level, rows:[], totals:null });
    where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%");
  }
  const units = await db.prepare(
    `SELECT u.pcode, u.name, u.path, p1.name p1, p2.name p2, p3.name p3
     FROM geo_unit u
     LEFT JOIN geo_unit p1 ON p1.version_id=u.version_id AND p1.pcode=u.parent_pcode
     LEFT JOIN geo_unit p2 ON p2.version_id=u.version_id AND p2.pcode=p1.parent_pcode
     LEFT JOIN geo_unit p3 ON p3.version_id=u.version_id AND p3.pcode=p2.parent_pcode
     WHERE ${where.join(" AND ")} ORDER BY u.path LIMIT ?`).all(...args, limit);

  const scope = await scopeOf(req.user);
  const kept = units.filter(u => covers(scope, u.path));
  const codes = new Set(kept.map(u => u.pcode));

  /* Caseload : la valeur du mois si elle existe, sinon la valeur annuelle. */
  const cl = await db.prepare(
    `SELECT * FROM caseload WHERE year=? AND activity_tag=?
       AND (month IS NULL ${month !== undefined ? "OR month=?" : ""})`)
    .all(...(month !== undefined ? [year, tag || "", month] : [year, tag || ""]));

  /* Une valeur mensuelle l'emporte sur la valeur annuelle de la même unité. */
  const parUnite = {};
  for(const c of cl){
    const prev = parUnite[c.geo_pcode];
    if(!prev || (prev.month === null && c.month !== null)) parUnite[c.geo_pcode] = c;
  }

  /* La saisie se fait à la commune ; une vue par district ou par région doit
     donc agréger vers le haut. Les unités d'un même niveau ne se recouvrent pas,
     la somme est exacte — mais si le caseload est renseigné à plusieurs niveaux
     sous la même unité, on ne retient que le plus fin, sinon on compterait deux fois. */
  const allPaths = Object.fromEntries((await db.prepare(
    `SELECT pcode, path, level FROM geo_unit WHERE version_id=?`).all(v.id))
    .map(x => [x.pcode, x]));

  const agrege = (unit) => {
    const sous = Object.values(parUnite).filter(c => {
      const u = allPaths[c.geo_pcode];
      return u && (u.path === unit.path || u.path.startsWith(unit.path + "/"));
    });
    if(!sous.length) return {};
    const profondeur = Math.max(...sous.map(c => LEVELS.indexOf(allPaths[c.geo_pcode].level)));
    const fines = sous.filter(c => LEVELS.indexOf(allPaths[c.geo_pcode].level) === profondeur);
    if(fines.length === 1) return fines[0];
    const s = (k) => fines.reduce((t, x) => t + (x[k] || 0), 0);
    return { population:s("population"), households:s("households"),
      targeted:s("targeted"), targeted_hh:s("targeted_hh"),
      month: fines.some(x => x.month !== null) ? month ?? null : null,
      source: [...new Set(fines.map(x => x.source).filter(Boolean))].join(" · ").slice(0,200) };
  };
  const byCode = Object.fromEntries(kept.map(u => [u.pcode, agrege(u)]));

  /* Plan de distribution de la période, agrégé par unité. */
  const pdd = await db.prepare(
    `SELECT geo_pcode, SUM(benef_planned) planned, SUM(benef_actual) actual,
            SUM(households) hh, SUM(tonnage) tonnage, SUM(amount) amount, COUNT(*) lines
     FROM pdd WHERE year=? ${month !== undefined ? "AND month=?" : ""}
       ${tag ? "AND activity_tag=?" : ""} AND geo_pcode IS NOT NULL
     GROUP BY geo_pcode`)
    .all(...[year, ...(month !== undefined ? [month] : []), ...(tag ? [tag] : [])]);
  /* Le PDD peut pointer plus fin que le niveau demandé : on remonte par le chemin. */
  const pddPaths = Object.fromEntries((await db.prepare(
    `SELECT pcode, path FROM geo_unit WHERE version_id=?`).all(v.id)).map(x => [x.pcode, x.path]));
  const pddByUnit = {};
  for(const p of pdd){
    const pth = pddPaths[p.geo_pcode]; if(!pth) continue;
    const host = kept.find(u => pth === u.path || pth.startsWith(u.path + "/"));
    if(!host) continue;
    const a = pddByUnit[host.pcode] = pddByUnit[host.pcode]
      || { planned:0, actual:0, hh:0, tonnage:0, amount:0, lines:0 };
    for(const k of ["planned","actual","hh","tonnage","amount","lines"]) a[k] += p[k] || 0;
  }

  const depth = LEVELS.indexOf(level);
  const rate = (a, b) => b ? Math.round((a / b) * 1000) / 10 : null;

  const rows = kept.map(u => {
    const c = byCode[u.pcode] || {};
    const p = pddByUnit[u.pcode] || {};
    const out = {
      pcode:u.pcode, name:u.name,
      population: c.population ?? 0, households: c.households ?? 0,
      targeted: c.targeted ?? 0, targetedHh: c.targeted_hh ?? 0,
      source: c.source || "", periode: c.month === null || c.month === undefined ? "annuel" : "mensuel",
      planned: p.planned ?? 0, actual: p.actual ?? 0, lines: p.lines ?? 0,
      tonnage: Math.round((p.tonnage ?? 0) * 10) / 10, amount: p.amount ?? 0,
      tauxCiblage:    rate(c.targeted ?? 0, c.population ?? 0),
      tauxCouverture: rate(p.planned ?? 0, c.targeted ?? 0),
      tauxRealisation:rate(p.actual ?? 0, p.planned ?? 0),
    };
    [u.p1, u.p2, u.p3].forEach((nm, i) => {
      const lvl = LEVELS[depth-1-i]; if(lvl && nm != null) out[lvl] = nm; });
    return out;
  });

  const sum = (k) => rows.reduce((t, x) => t + (x[k] || 0), 0);
  const totals = {
    unites: rows.length,
    renseignees: rows.filter(x => x.population || x.targeted).length,
    population: sum("population"), households: sum("households"),
    targeted: sum("targeted"), planned: sum("planned"), actual: sum("actual"),
    tonnage: Math.round(sum("tonnage") * 10) / 10, amount: sum("amount"),
    tauxCiblage: rate(sum("targeted"), sum("population")),
    tauxCouverture: rate(sum("planned"), sum("targeted")),
    tauxRealisation: rate(sum("actual"), sum("planned")),
  };

  res.json({ year, month: month ?? null, level, tag: tag || "",
    /* Le total par activité n'est pas la somme des activités : une même personne
       peut être ciblée par deux programmes. L'appelant doit le savoir. */
    avertissement: tag ? null
      : "Les chiffres « toutes activités » proviennent de lignes propres, non de la somme des activités : une même personne peut être ciblée par plusieurs programmes.",
    rows, totals, version:{ id:v.id, label:v.label } });
});

/* Activités pour lesquelles un ciblage est renseigné, sur la période. */
r.get("/tags", async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  res.json({ rows: await db.prepare(
    `SELECT activity_tag tag, COUNT(*) n, SUM(targeted) targeted
     FROM caseload WHERE year=? AND activity_tag<>'' GROUP BY activity_tag ORDER BY activity_tag`)
    .all(year) });
});

/* ── Écriture ligne à ligne ─────────────────────────────────────────
   Volontairement pas une synchronisation de collection entière : deux bureaux
   qui saisissent le même mois touchent des unités disjointes et ne doivent pas
   s'effacer mutuellement. Les lignes absentes du corps ne sont pas supprimées. */
const rowSchema = z.object({
  geo_pcode: z.string().min(1).max(64),
  level: z.enum(["adm1","adm2","adm3","adm4"]).default("adm3"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(0).max(11).nullish(),
  activity_tag: z.string().max(20).default(""),
  population: z.coerce.number().int().min(0).default(0),
  households: z.coerce.number().int().min(0).default(0),
  targeted: z.coerce.number().int().min(0).default(0),
  targeted_hh: z.coerce.number().int().min(0).default(0),
  source: z.string().max(200).nullish().transform(v => v ?? null),
  note: z.string().max(500).nullish().transform(v => v ?? null),
});

r.put("/", requireCap("edit"), async (req, res) => {
  const parsed = z.object({ rows: z.array(rowSchema).min(1).max(20000) }).safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"données invalides",
    details: parsed.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });

  const v = currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant : chargez un millésime d'abord" });

  /* Le chemin de l'unité, pas seulement son existence : il faut pouvoir dire si
     elle tombe dans le périmètre du bureau de l'appelant. */
  const chemins = Object.fromEntries((await db.prepare(
    "SELECT pcode, path FROM geo_unit WHERE version_id=?").all(v.id)).map(x => [x.pcode, x.path]));

  /* Le même contrôle de portée que l'import Excel (lib/import.js) : ce flux-ci
     l'avait perdu en route — `scopeOf` était importé mais ne servait qu'en lecture,
     si bien qu'un compte cloisonné écrivait la population et le ciblage de
     n'importe quelle commune du pays par un simple appel direct.

     L'appartenance exigée est stricte, à la différence de `covers` qui retient aussi
     les ancêtres : voir une région parce qu'on en couvre un district est légitime,
     écrire la ligne de la région entière ne l'est pas. */
  const scope = await scopeOf(req.user);
  const dansPerimetre = (pcode) => {
    if(scope.unbounded) return true;
    const path = chemins[pcode]; if(!path) return false;
    return scope.paths.some(p => path === p || path.startsWith(p + "/"));
  };

  const rejets = [];
  const ok = parsed.data.rows.filter((r0, i) => {
    if(!chemins[r0.geo_pcode]){
      rejets.push({ ligne:i+1, pcode:r0.geo_pcode, message:"p-code absent du référentiel courant" });
      return false;
    }
    if(!dansPerimetre(r0.geo_pcode)){
      rejets.push({ ligne:i+1, pcode:r0.geo_pcode,
        message:"hors du périmètre de votre bureau" });
      return false;
    }
    if(r0.targeted > r0.population && r0.population > 0){
      rejets.push({ ligne:i+1, pcode:r0.geo_pcode,
        message:`${r0.targeted} ciblés pour ${r0.population} habitants` });
      return false;
    }
    return true;
  });

  let crees = 0, modifies = 0;

  await tx(async (db) => {
    const find = db.prepare(`SELECT id FROM caseload
      WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS ?`);
    const ins = db.prepare(`INSERT INTO caseload
      (id,geo_pcode,level,year,month,activity_tag,population,households,targeted,targeted_hh,source,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE caseload SET level=?, population=?, households=?, targeted=?,
      targeted_hh=?, source=?, note=?, rev=rev+1, updated_at=now() WHERE id=?`);
    for(const x of ok){
      const m = x.month ?? null;
      const cur = await find.get(x.geo_pcode, x.year, x.activity_tag, m);
      if(cur){
        await upd.run(x.level, x.population, x.households, x.targeted, x.targeted_hh, x.source, x.note, cur.id);
        modifies++;
      } else {
        await ins.run(newId("cl"), x.geo_pcode, x.level, x.year, m, x.activity_tag,
          x.population, x.households, x.targeted, x.targeted_hh, x.source, x.note);
        crees++;
      }
    }
  });

  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','caseload','sync',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name,
         `Population et ciblage : ${crees} créé(s), ${modifies} modifié(s)${rejets.length?`, ${rejets.length} rejeté(s)`:""}`);

  res.json({ crees, modifies, rejetes: rejets.length, rejets: rejets.slice(0,20) });
});

export default r;
