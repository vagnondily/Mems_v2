import { Router } from "express";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { labelsFor } from "../lib/geo.js";
import { requireCap } from "../lib/auth.js";
import { officeBound as scopeOf } from "../lib/scope.js";
import { validate, schemas } from "../lib/validate.js";
import { combinerDerniereVisite, derniereVisiteOdk } from "../lib/soumissions.js";
import { listerAlias, synchroniserCodeParDefaut } from "../lib/alias.js";
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
function assertScope(req, site){
  const s = scopeOf(req.user);
  if(s && site && site.office_id !== s){
    const e = new Error("ce site relève d'un autre bureau"); e.status = 403; throw e;
  }
}

r.get("/", (req, res) => {
  const q = z.object({
    search: z.string().max(120).optional(), office_id: z.string().max(64).optional(),
    status: z.enum(["Active","Inactive"]).optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(200),
    offset: z.coerce.number().int().min(0).default(0),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const f = q.data;
  const scope = scopeOf(req.user);
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
  const sql = `SELECT sites.*, v.derniere AS last_visit_odk,
                      COALESCE(v.derniere, sites.last_visit) AS last_visit_effective,
                      COALESCE(v.soumissions,0) AS submissions
               FROM sites
               LEFT JOIN (SELECT site_id, MAX(svy_date) derniere, COUNT(*) soumissions
                          FROM submissions WHERE site_id IS NOT NULL AND svy_date IS NOT NULL
                          GROUP BY site_id) v ON v.site_id = sites.id
               ${where.length ? "WHERE "+where.join(" AND ") : ""}
               ORDER BY code LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...args, f.limit, f.offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM sites ${where.length ? "WHERE "+where.join(" AND ") : ""}`)
    .get(...args).c;
  res.json({ total, rows });
});

r.get("/:id", (req, res) => {
  const s = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!s) return res.status(404).json({ error:"site introuvable" });
  assertScope(req, s);
  /* La fiche porte les DEUX dates de dernière visite. Le site garde la sienne,
     saisie ; la date issue des soumissions ODK est calculée à la demande et
     prime à l'affichage — voir lib/soumissions.js pour le pourquoi. */
  /* `aliases` s'ajoute, il ne remplace rien : `site.external_code` reste le code
     par défaut que la fiche affiche et modifie. Un site désigné autrement par
     chaque formulaire porte plusieurs codes (migration 018), et la fiche est le
     seul endroit où l'on peut les voir tous. */
  res.json({ site:s, months: db.prepare("SELECT * FROM site_months WHERE site_id=?").all(s.id),
    aliases: listerAlias(s.id),
    derniereVisite: combinerDerniereVisite(s.last_visit, derniereVisiteOdk(s.id)) });
});


/* Le rattachement fait foi : quand un site porte un geo_pcode, ses libellés
   administratifs et ses coordonnées en descendent, plutôt que d'être saisis
   séparément — c'est ce qui les empêche de diverger du référentiel. */
function applyGeo(b){
  if(!b.geo_pcode) return b;
  const l = labelsFor(b.geo_pcode);
  if(!l.adm1 && !l.adm2 && !l.adm3 && !l.adm4) return b;   /* p-code inconnu : on n'écrase rien */
  b.adm1 = l.adm1 || null; b.adm2 = l.adm2 || null;
  b.adm3 = l.adm3 || null; b.adm4 = l.adm4 || null;
  /* Les coordonnées propres au site priment : une école n'est pas au centroïde
     de son fokontany. Celles du référentiel ne servent que de repli. */
  if(b.lat == null) b.lat = l.lat;
  if(b.lon == null) b.lon = l.lon;
  return b;
}

r.post("/", requireCap("edit"), validate(schemas.site), (req, res) => {
  const b = applyGeo(req.body);
  const scope = scopeOf(req.user);
  if(scope) b.office_id = scope;
  if(db.prepare("SELECT 1 FROM sites WHERE code=?").get(b.code))
    return res.status(409).json({ error:"un site porte déjà ce code" });
  const id = newId("site");
  const cols = Object.keys(b).filter(k=>k!=="id");
  db.prepare(`INSERT INTO sites (id,${cols.join(",")}) VALUES (?,${cols.map(()=>"?").join(",")})`)
    .run(id, ...cols.map(k=>b[k]));
  /* Le code par défaut est miroité dans la table des codes externes, pour que la
     liste des codes d'un site soit complète en une requête. Voir lib/alias.js. */
  synchroniserCodeParDefaut(id, b.external_code);
  audit(req, "create", id, `Site créé — ${b.name}`);
  res.status(201).json({ site: db.prepare("SELECT * FROM sites WHERE id=?").get(id) });
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
r.put("/:id", requireCap("edit"), validate(schemas.site.partial()), (req, res) => {
  const cur = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"site introuvable" });
  assertScope(req, cur);
  const b = applyGeo(req.body); const scope = scopeOf(req.user);
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
  const dup = db.prepare("SELECT id FROM sites WHERE code=? AND id<>?").get(code, cur.id);
  if(dup) return res.status(409).json({ error:"un autre site porte déjà ce code" });
  const cols = Object.keys(b).filter(k => k !== "id" && b[k] !== undefined);
  if(!cols.length) return res.json({ site: cur });   /* rien à écrire, rien à incrémenter */
  db.prepare(`UPDATE sites SET ${cols.map(k=>k+"=?").join(",")}, rev=rev+1, updated_at=datetime('now') WHERE id=?`)
    .run(...cols.map(k=>b[k]), cur.id);
  /* Seulement si le code par défaut est ENVOYÉ : un PUT partiel qui ne le
     mentionne pas n'a pas à toucher aux codes du site. Et corriger ce code
     retire l'ancien du jeu — un code désavoué ne doit pas continuer à rattacher
     des soumissions en douce. Les alias importés, eux, ne bougent pas. */
  if(b.external_code !== undefined) synchroniserCodeParDefaut(cur.id, b.external_code);
  audit(req, "update", cur.id, `Site modifié — ${nom}`);
  res.json({ site: db.prepare("SELECT * FROM sites WHERE id=?").get(cur.id) });
});

r.delete("/:id", requireCap("del"), (req, res) => {
  const cur = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"site introuvable" });
  assertScope(req, cur);
  db.prepare("DELETE FROM sites WHERE id=?").run(cur.id);   /* cascade sur site_months et visits */
  audit(req, "delete", cur.id, `Site supprimé — ${cur.name}`);
  res.json({ ok:true });
});

/* Grille mensuelle : une écriture par cellule, avec création de la visite associée. */
r.put("/:id/months", requireCap("edit"), validate(schemas.siteMonth), (req, res) => {
  const site = db.prepare("SELECT * FROM sites WHERE id=?").get(req.params.id);
  if(!site) return res.status(404).json({ error:"site introuvable" });
  assertScope(req, site);
  const m = req.body;
  tx(() => {
    db.prepare(`INSERT INTO site_months (site_id,year,month,active,planned,done,cp_name,monitor,report,moda)
                VALUES (@site_id,@year,@month,@active,@planned,@done,@cp_name,@monitor,@report,@moda)
                ON CONFLICT(site_id,year,month) DO UPDATE SET
                  active=@active, planned=@planned, done=@done, cp_name=@cp_name,
                  monitor=@monitor, report=@report, moda=@moda`)
      .run({ site_id:site.id, year:m.year, month:m.month,
             active:m.active?1:0, planned:m.planned?1:0, done:m.done?1:0,
             cp_name:m.cp_name, monitor:m.monitor, report:m.report, moda:m.moda });
    const date = `${m.year}-${String(m.month+1).padStart(2,"0")}-15`;
    const existing = db.prepare(
      "SELECT id FROM visits WHERE site_id=? AND visit_date LIKE ?").get(site.id, `${m.year}-${String(m.month+1).padStart(2,"0")}%`);
    if(m.done && !existing){
      db.prepare(`INSERT INTO visits (id,site_id,office_id,visit_date,activity_tag,monitor,form_id,status)
                  VALUES (?,?,?,?,?,?,'saisie','À valider')`)
        .run(newId("visit"), site.id, site.office_id, date, site.activity_tag, m.monitor);
      db.prepare("UPDATE sites SET last_visit=? WHERE id=? AND (last_visit IS NULL OR last_visit < ?)")
        .run(date, site.id, date);
    }
    if(!m.done && existing) db.prepare("DELETE FROM visits WHERE id=?").run(existing.id);
  })();
  audit(req, "plan", site.id, `Fiche mensuelle mise à jour — ${site.name}`);
  res.json({ ok:true });
});

/* Modification groupée : un seul champ, une liste d'identifiants, une transaction. */
const BULK_FIELDS = new Set(["office_id","activity_tag","poi_subtype","modality","partner_id",
  "urban_area","status","security","responsible","antenne","category_id","site_type"]);
r.post("/bulk", requireCap("edit"), (req, res) => {
  const p = z.object({ ids: z.array(z.string().max(64)).min(1).max(5000),
    field: z.string().max(40), value: z.union([z.string().max(200), z.number(), z.null()]) })
    .safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"requête groupée invalide" });
  const { ids, field, value } = p.data;
  if(!BULK_FIELDS.has(field))
    return res.status(422).json({ error:`le champ « ${field} » n'est pas modifiable en masse` });
  const scope = scopeOf(req.user);
  const stmt = db.prepare(`UPDATE sites SET ${field}=?, updated_at=datetime('now')
                           WHERE id=? ${scope ? "AND office_id=?" : ""}`);
  let n = 0;
  tx(() => { for(const id of ids) n += stmt.run(value, id, ...(scope?[scope]:[])).changes; })();
  audit(req, "bulk", null, `Modification groupée de ${n} site(s) — ${field}`);
  res.json({ updated:n });
});
export default r;
