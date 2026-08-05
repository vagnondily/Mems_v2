import { Router } from "express";
import { db } from "../db.js";
import { z } from "zod";
import { officeBound as scopeOf } from "../lib/scope.js";

const r = Router();
/* Cloisonnement par bureau : voir lib/scope.js — définition unique. */

/* Points cartographiques : calculés côté serveur pour éviter d'envoyer le registre entier. */
r.get("/map", async (req, res) => {
  const q = z.object({
    office_id: z.string().max(64).optional(), adm1: z.string().max(120).optional(),
    adm2: z.string().max(120).optional(), category_id: z.string().max(64).optional(),
    activity_tag: z.string().max(20).optional(), status: z.enum(["Active","Inactive"]).optional(),
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const f = q.data;
  const scope = await scopeOf(req.user);
  const where = ["s.lat IS NOT NULL", "s.lon IS NOT NULL"]; const args = [];
  if(scope){ where.push("s.office_id = ?"); args.push(scope); }
  else if(f.office_id){ where.push("s.office_id = ?"); args.push(f.office_id); }
  for(const k of ["adm1","adm2"]) if(f[k]){ where.push(`s.${k} = ?`); args.push(f[k]); }
  if(f.category_id){ where.push("s.category_id = ?"); args.push(f.category_id); }
  if(f.activity_tag){ where.push("s.activity_tag = ?"); args.push(f.activity_tag); }
  if(f.status){ where.push("s.status = ?"); args.push(f.status); }

  const rows = await db.prepare(`
    SELECT s.id, s.code, s.name, s.status, s.lat, s.lon, s.adm1, s.adm2, s.adm3, s.adm4,
           /* Le p-code permet à la carte de rapporter chaque site à son contour :
              sans lui, l'aplat thématique devrait se rattacher par nom de commune,
              ce qui échoue sur les homonymes de deux districts différents. */
           s.geo_pcode,
           s.activity_tag, s.beneficiaries, s.security, s.last_visit, s.modality,
           /* Les deux dates de dernière visite voyagent ensemble, jamais l'une
              à la place de l'autre : last_visit est saisie (la grille mensuelle
              la pose au 15 du mois, par convention), last_visit_odk est
              observée — c'est la « dernière date de suivi disponible dans odk
              selon svydate ». L'observée prime, la saisie reste lisible ;
              écraser l'une par l'autre en base détruirait sans trace un travail
              de saisie. Voir lib/soumissions.js, combinerDerniereVisite. */
           v.derniere AS last_visit_odk,
           COALESCE(v.derniere, s.last_visit) AS last_visit_effective,
           CASE WHEN v.derniere IS NOT NULL THEN 'odk'
                WHEN s.last_visit IS NOT NULL THEN 'saisie' END AS last_visit_source,
           COALESCE(v.soumissions,0) AS submissions,
           o.name AS office, c.name AS category,
           COALESCE(m.planned,0) AS planned, COALESCE(m.done,0) AS done
    FROM sites s
    LEFT JOIN offices o ON o.id = s.office_id
    LEFT JOIN activity_categories c ON c.id = s.category_id
    LEFT JOIN (SELECT site_id, SUM(planned) planned, SUM(done) done
               FROM site_months WHERE year = ? GROUP BY site_id) m ON m.site_id = s.id
    LEFT JOIN (SELECT site_id, MAX(svy_date) derniere, COUNT(*) soumissions
               FROM submissions WHERE site_id IS NOT NULL AND svy_date IS NOT NULL
               GROUP BY site_id) v ON v.site_id = s.id
    WHERE ${where.join(" AND ")}
    ORDER BY s.code LIMIT 6000`).all(f.year, ...args);

  const bounds = rows.reduce((b,s)=>({
    minLat:Math.min(b.minLat,s.lat), maxLat:Math.max(b.maxLat,s.lat),
    minLon:Math.min(b.minLon,s.lon), maxLon:Math.max(b.maxLon,s.lon) }),
    { minLat:90, maxLat:-90, minLon:180, maxLon:-180 });
  res.json({ count: rows.length, bounds: rows.length ? bounds : null, sites: rows });
});

/* Couverture mensuelle par catégorie, agrégée en base plutôt qu'en mémoire du navigateur. */
r.get("/coverage", async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const scope = await scopeOf(req.user);
  const rows = await db.prepare(`
    SELECT COALESCE(c.name,'(non renseignée)') AS category, m.month,
           SUM(CASE WHEN m.active=1 AND s.status='Active' THEN 1 ELSE 0 END) AS active,
           SUM(m.planned) AS planned, SUM(m.done) AS done
    FROM site_months m
    JOIN sites s ON s.id = m.site_id
    LEFT JOIN activity_categories c ON c.id = s.category_id
    WHERE m.year = ? ${scope ? "AND s.office_id = ?" : ""}
    GROUP BY category, m.month ORDER BY category, m.month`)
    .all(year, ...(scope?[scope]:[]));
  res.json({ year, rows });
});

r.get("/summary", async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const scope = await scopeOf(req.user);
  const w = scope ? "WHERE office_id = ?" : "";
  const a = scope ? [scope] : [];
  res.json({
    year,
    sites: (await db.prepare(`SELECT COUNT(*) c FROM sites ${w}`).get(...a)).c,
    active: (await db.prepare(`SELECT COUNT(*) c FROM sites ${w ? w+" AND" : "WHERE"} status='Active'`).get(...a)).c,
    beneficiaries: (await db.prepare(`SELECT COALESCE(SUM(beneficiaries),0) s FROM sites ${w ? w+" AND" : "WHERE"} status='Active'`).get(...a)).s,
    visits: (await db.prepare(`SELECT COUNT(*) c FROM visits v JOIN sites s ON s.id=v.site_id
      WHERE v.visit_date LIKE ? ${scope ? "AND s.office_id=?" : ""}`).get(`${year}%`, ...a)).c,
    pending: (await db.prepare(`SELECT COUNT(*) c FROM visits v JOIN sites s ON s.id=v.site_id
      WHERE v.status='À valider' ${scope ? "AND s.office_id=?" : ""}`).get(...a)).c,
  });
});
export default r;
