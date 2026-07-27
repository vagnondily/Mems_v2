import { Router } from "express";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { z } from "zod";

const r = Router();

r.get("/", (req, res) => {
  const q = z.object({
    adm1: z.string().max(120).optional(), adm2: z.string().max(120).optional(),
    adm3: z.string().max(120).optional(), search: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(300),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const f = q.data; const where = []; const args = [];
  for(const k of ["adm1","adm2","adm3"]) if(f[k]){ where.push(`${k} = ?`); args.push(f[k]); }
  if(f.search){ where.push("(adm3 LIKE ? OR adm4 LIKE ? OR pcode LIKE ?)");
    const s = `%${f.search}%`; args.push(s,s,s); }
  const w = where.length ? "WHERE "+where.join(" AND ") : "";
  res.json({
    total: db.prepare(`SELECT COUNT(*) c FROM geo ${w}`).get(...args).c,
    rows: db.prepare(`SELECT * FROM geo ${w} ORDER BY adm1,adm2,adm3,adm4 LIMIT ? OFFSET ?`)
      .all(...args, f.limit, f.offset),
  });
});

/* Niveaux distincts, pour alimenter les listes en cascade sans charger 17 500 lignes. */
r.get("/levels", (req, res) => {
  const q = z.object({ adm1:z.string().max(120).optional(), adm2:z.string().max(120).optional(),
    adm3:z.string().max(120).optional() }).parse(req.query);
  const one = (col, cond, args) => db.prepare(
    `SELECT DISTINCT ${col} v FROM geo WHERE ${col} IS NOT NULL AND ${col} <> ''
     ${cond} ORDER BY ${col} LIMIT 2000`).all(...args).map(x=>x.v);
  res.json({
    adm1: one("adm1", "", []),
    adm2: one("adm2", q.adm1 ? "AND adm1=?" : "", q.adm1?[q.adm1]:[]),
    adm3: one("adm3", q.adm2 ? "AND adm2=?" : (q.adm1 ? "AND adm1=?" : ""),
              q.adm2?[q.adm2]:(q.adm1?[q.adm1]:[])),
    adm4: q.adm3 ? one("adm4", "AND adm3=?", [q.adm3]) : [],
  });
});

/* Import en masse : transaction unique, insertions préparées, remplacement atomique. */
r.post("/bulk", requireCap("admin"), validate(schemas.geoBulk), (req, res) => {
  const { mode, rows } = req.body;
  const ins = db.prepare(`INSERT INTO geo (id,adm0,adm1,adm2,adm3,adm4,pcode,lat,lon)
                          VALUES (?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  tx(() => {
    if(mode === "replace"){
      db.prepare("UPDATE sites SET geo_id=NULL").run();
      db.prepare("DELETE FROM geo").run();
    }
    for(const g of rows){
      ins.run(newId("geo"), g.adm0, g.adm1, g.adm2, g.adm3, g.adm4, g.pcode,
              g.lat ?? null, g.lon ?? null);
      n++;
    }
  })();
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','geo','import',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, `${n} localités importées (${mode})`);
  res.json({ imported:n, total: db.prepare("SELECT COUNT(*) c FROM geo").get().c });
});
export default r;
