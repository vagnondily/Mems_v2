import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { buildUnits, writeVersion, currentVersion, LEVELS } from "../lib/geo.js";
import { countryBound, officeBound, scopeOf, declaredFor, unitsIn, outsideDeclared } from "../lib/scope.js";
import { ctxCountry } from "../lib/ctx.js";
import { extent, geomSummary, readGeometries, writeGeometries } from "../lib/geom.js";
import { locate, sitesALocaliser } from "../lib/locate.js";

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

/* ── Rattachement par les coordonnées ────────────────────────────────
   Un point GPS, une unité administrative. C'est la réponse à la situation la plus
   courante d'un registre repris d'un tableur : le site a été relevé au GPS, son nom
   de commune a été saisi autrement — ou pas du tout — et il n'entre donc dans aucun
   total par district, aucune couverture, aucun ciblage. Il apparaît sur la carte et
   nulle part ailleurs.

   La réponse est pourtant dans les données : le découpage sait où tombe ce point. */
r.post("/locate", (req, res) => {
  const p = z.object({
    lat: z.coerce.number().min(-90).max(90),
    lon: z.coerce.number().min(-180).max(180),
    level: z.enum(LEVELS).optional(),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"coordonnées invalides",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  res.json(locate(p.data.lat, p.data.lon, { level:p.data.level }));
});

/* Les sites sans rattachement, avec ce que les coordonnées permettent de proposer.

   Deux temps, volontairement : on PROPOSE d'abord, on applique ensuite. Écrire
   trois cents rattachements sans les montrer serait une opération de masse dont
   personne ne peut vérifier le résultat — et un rattachement faux est plus nuisible
   qu'une absence de rattachement, parce qu'il se fond dans les totaux. */
r.get("/orphans", (req, res) => {
  const q = z.object({ limit: z.coerce.number().int().min(1).max(2000).default(500) })
    .safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const bureau = officeBound(req.user);
  const sites = sitesALocaliser(bureau).slice(0, q.data.limit);
  const rows = sites.map(s => {
    const t = locate(s.lat, s.lon);
    return { id:s.id, code:s.code, name:s.name, lat:s.lat, lon:s.lon,
             office_id:s.office_id, saisi:{ adm1:s.adm1, adm2:s.adm2, adm3:s.adm3, adm4:s.adm4 },
             propose: t.error ? null : t, erreur: t.error || null };
  });
  const v = currentVersion();
  res.json({
    rows,
    /* Le compte total, distinct de ce qui est proposé : un site sans coordonnées ne
       peut pas être aidé ici, et le taire ferait croire le problème résolu. */
    total: db.prepare(`SELECT COUNT(*) c FROM sites WHERE geo_pcode IS NULL
                       ${bureau ? "AND office_id = ?" : ""}`).get(...(bureau ? [bureau] : [])).c,
    sansCoordonnees: db.prepare(`SELECT COUNT(*) c FROM sites WHERE geo_pcode IS NULL
                       AND (lat IS NULL OR lon IS NULL) ${bureau ? "AND office_id = ?" : ""}`)
      .get(...(bureau ? [bureau] : [])).c,
    referentiel: v ? { id:v.id, label:v.label } : null,
    contours: v ? db.prepare("SELECT COUNT(*) c FROM geo_geom WHERE version_id=?").get(v.id).c : 0,
  });
});

/* Application des rattachements proposés. La liste des identifiants est explicite :
   l'appelant a vu ce qu'il accepte, et peut avoir écarté les propositions douteuses.

   `minConfiance` borne ce qu'on accepte en masse. Par défaut, seules les certitudes
   géométriques — un point tombé dans un polygone. Accepter par défaut les
   rattachements « par proximité » ferait entrer des approximations à 20 km dans des
   totaux présentés ensuite comme des faits. */
r.post("/attach", requireCap("edit"), (req, res) => {
  const p = z.object({
    ids: z.array(z.string().max(64)).max(5000).optional(),
    minConfiance: z.enum(["certaine","probable","incertaine"]).default("certaine"),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"requête invalide" });
  const rang = { certaine:0, probable:1, incertaine:2 };
  const seuil = rang[p.data.minConfiance];

  const bureau = officeBound(req.user);
  const candidats = sitesALocaliser(bureau)
    .filter(s => !p.data.ids || p.data.ids.includes(s.id));

  const upd = db.prepare(`UPDATE sites SET geo_pcode=?, adm1=COALESCE(?,adm1), adm2=COALESCE(?,adm2),
                          adm3=COALESCE(?,adm3), adm4=COALESCE(?,adm4),
                          rev=rev+1, updated_at=datetime('now') WHERE id=?`);
  let rattaches = 0, ecartes = 0;
  const detail = [];
  tx(() => {
    for(const s of candidats){
      const t = locate(s.lat, s.lon);
      if(t.error || rang[t.confiance] > seuil){ ecartes++; continue; }
      /* Les libellés administratifs suivent le rattachement : c'est la règle du
         registre — le p-code fait foi, les noms en descendent. */
      upd.run(t.pcode, t.adm1 ?? null, t.adm2 ?? null, t.adm3 ?? null, t.adm4 ?? null, s.id);
      rattaches++;
      if(detail.length < 50) detail.push({ code:s.code, pcode:t.pcode, unite:t.name,
                                           methode:t.methode, distance:t.distance });
    }
  })();
  if(rattaches)
    db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,action,text)
                VALUES (?,?,?,?,'plan','sites','link',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
           req.user.office_id || "",
           `${rattaches} site(s) rattachés au découpage par leurs coordonnées` +
           (ecartes ? `, ${ecartes} écarté(s) faute de certitude` : ""));
  res.json({ rattaches, ecartes, detail });
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
      /* Le détail par niveau, et pas seulement le total : un écran qui annonce
         « 52 unités » sans dire combien de régions et combien de communes ne permet
         pas de vérifier qu'un import s'est bien passé. */
      counts: Object.fromEntries(db.prepare(
        `SELECT level, COUNT(*) c FROM geo_unit WHERE version_id=? GROUP BY level`)
        .all(x.id).map(r2 => [r2.level, r2.c])),
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

/* ══════════════════ La chaîne géographique tient-elle ? ══════════════════

   Le découpage, les coordonnées et les listes ne se parlent que par un fil très fin :
   le p-code. Un site porte le p-code d'une commune, une ligne de plan aussi, un
   périmètre de bureau également. Que ce fil casse quelque part et rien ne se voit :
   les écrans continuent d'afficher des nombres, simplement ils n'additionnent plus
   les mêmes choses.

   Les ruptures possibles ne sont pas nombreuses, et chacune se contrôle :

     — un p-code qui ne figure pas dans le millésime courant. Arrive après un
       réimport du découpage : les codes changent, les rattachements pointent dans
       le vide, et les totaux par zone tombent silencieusement à zéro ;

     — un enregistrement sans rattachement du tout. Il existe, il s'affiche dans sa
       liste, et il n'entre dans aucun total par district ni dans aucune couverture ;

     — un libellé qui contredit le p-code — « district : Bekily » sur un point rattaché
       à Tsihombe. L'un des deux est faux, et les filtres textuels et géographiques
       donneront des réponses différentes sur la même question ;

     — un point GPS qui ne tombe pas dans le polygone de l'unité à laquelle il est
       rattaché. C'est le contrôle le plus sévère, et le seul qui prouve vraiment que
       la carte et le registre parlent du même endroit.

   On ne corrige rien ici : on constate, on chiffre, et on nomme trois exemples. Une
   correction automatique sur des données de terrain serait une décision, pas un
   diagnostic. */
r.get("/coherence", (req, res) => {
  const v = currentVersion();
  if(!v) return res.json({ version:null,
    message:"aucun découpage administratif n'est chargé pour ce pays" });

  const unites = db.prepare(
    "SELECT pcode, path, level, name FROM geo_unit WHERE version_id=?").all(v.id);
  const parCode = Object.fromEntries(unites.map(u => [u.pcode, u]));
  const connu = (p) => !!parCode[p];

  /* Les noms des ancêtres d'une unité, par niveau : c'est à eux que se comparent les
     libellés recopiés dans les tables. */
  const nomsDe = (pcode) => {
    const u = parCode[pcode]; if(!u) return {};
    const out = {};
    for(const p of (u.path || "").split("/").filter(Boolean))
      if(parCode[p]) out[parCode[p].level] = parCode[p].name;
    return out;
  };

  const constats = [];
  const ajoute = (cle, titre, quoi, lignes, exemples = []) => constats.push({
    cle, titre, quoi, n:lignes, exemples: exemples.slice(0, 3) });

  /* ── Sites ── */
  const sites = db.prepare("SELECT * FROM sites").all();
  const inconnus = sites.filter(s => s.geo_pcode && !connu(s.geo_pcode));
  ajoute("sites_pcode_inconnu", "Sites rattachés à une unité qui n'existe plus",
    "Leur p-code ne figure pas dans le découpage courant : ils ne remontent dans aucun total par zone.",
    inconnus.length, inconnus.map(s => `${s.code} — ${s.name}`));

  const orphelins = sites.filter(s => !s.geo_pcode);
  const rattrapables = orphelins.filter(s => s.lat != null && s.lon != null);
  ajoute("sites_sans_rattachement", "Sites sans rattachement au découpage",
    rattrapables.length
      ? `${rattrapables.length} d'entre eux portent des coordonnées : le rattachement peut être retrouvé automatiquement.`
      : "Sans coordonnées, le rattachement doit être saisi à la main.",
    orphelins.length, orphelins.map(s => `${s.code} — ${s.name}`));

  ajoute("sites_sans_coordonnees", "Sites sans coordonnées",
    "Ils ne peuvent apparaître sur la carte ni être localisés automatiquement.",
    sites.filter(s => s.lat == null || s.lon == null).length,
    sites.filter(s => s.lat == null || s.lon == null).map(s => `${s.code} — ${s.name}`));

  const horsPlage = sites.filter(s => s.lat != null && s.lon != null &&
    (Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180));
  ajoute("sites_coordonnees_invalides", "Coordonnées hors plage WGS 84",
    "Attendues en degrés décimaux : latitude entre -90 et 90, longitude entre -180 et 180.",
    horsPlage.length, horsPlage.map(s => `${s.code} — ${s.lat}, ${s.lon}`));

  const desaccord = [];
  for(const s of sites){
    if(!s.geo_pcode || !connu(s.geo_pcode)) continue;
    const noms = nomsDe(s.geo_pcode);
    for(const lvl of LEVELS.slice(1)){
      if(s[lvl] && noms[lvl] && s[lvl] !== noms[lvl]){
        desaccord.push(`${s.code} — ${lvl} « ${s[lvl]} » au lieu de « ${noms[lvl]} »`);
        break;
      }
    }
  }
  ajoute("sites_libelles_contredits", "Libellés en désaccord avec le rattachement",
    "Le nom recopié dans le site contredit le découpage : les filtres par texte et par carte ne donneront pas la même réponse.",
    desaccord.length, desaccord);

  /* Le contrôle le plus sévère : le point tombe-t-il vraiment dans son unité ?
     Il suppose des contours chargés ; sans eux, on le déclare non vérifiable plutôt
     que réussi — dire « aucun écart » quand on n'a rien pu vérifier serait pire que
     de ne rien dire. */
  const contours = db.prepare(
    "SELECT COUNT(*) c FROM geo_geom WHERE version_id=?").get(v.id).c;
  let verifies = 0; const ailleurs = [];
  if(contours){
    for(const s of sites){
      if(!s.geo_pcode || s.lat == null || s.lon == null) continue;
      /* Un rattachement vers une unité disparue est déjà signalé plus haut ; le
         répéter ici, sous un nom introuvable, embrouillerait au lieu d'informer. */
      if(!connu(s.geo_pcode)) continue;
      const t = locate(Number(s.lat), Number(s.lon), { versionId:v.id });
      if(t.error || t.methode !== "contour") continue;
      verifies++;
      if(t.pcode !== s.geo_pcode)
        ailleurs.push(`${s.code} — rattaché à « ${parCode[s.geo_pcode]?.name} », tombe dans « ${t.name} »`);
    }
  }
  ajoute("sites_point_hors_unite", "Points GPS tombant hors de leur unité",
    contours
      ? `Contrôle géométrique effectué sur ${verifies} site(s) — c'est le seul qui prouve que la carte et le registre parlent du même endroit.`
      : "Non vérifiable : aucun contour n'est chargé pour ce découpage.",
    ailleurs.length, ailleurs);

  /* ── Plan de distribution ── */
  const pdd = db.prepare("SELECT * FROM pdd").all();
  ajoute("pdd_sans_rattachement", "Lignes de plan sans rattachement",
    "Elles n'entrent dans aucun total par commune, ni dans le rapprochement avec le ciblage.",
    pdd.filter(p => !p.geo_pcode).length,
    pdd.filter(p => !p.geo_pcode).map(p => `${p.commune || "(sans commune)"} — ${p.act_type}`));
  ajoute("pdd_pcode_inconnu", "Lignes de plan rattachées à une unité qui n'existe plus",
    "Même effet qu'un rattachement absent, en plus difficile à repérer.",
    pdd.filter(p => p.geo_pcode && !connu(p.geo_pcode)).length,
    pdd.filter(p => p.geo_pcode && !connu(p.geo_pcode)).map(p => `${p.commune} — ${p.act_type}`));

  const pddDes = [];
  for(const p of pdd){
    if(!p.geo_pcode || !connu(p.geo_pcode)) continue;
    const noms = nomsDe(p.geo_pcode);
    if((p.commune && noms.adm3 && p.commune !== noms.adm3) ||
       (p.district && noms.adm2 && p.district !== noms.adm2) ||
       (p.region && noms.adm1 && p.region !== noms.adm1))
      pddDes.push(`${p.commune} / ${p.district} — rattaché à « ${noms.adm3 || noms.adm2} »`);
  }
  ajoute("pdd_libelles_contredits", "Lignes de plan dont les libellés contredisent le rattachement",
    "Commune, district ou région recopiés ne correspondent pas au p-code porté par la ligne.",
    pddDes.length, pddDes);

  /* ── Ciblage et périmètres ── */
  const cl = db.prepare("SELECT * FROM caseload").all();
  ajoute("caseload_pcode_inconnu", "Lignes de ciblage rattachées à une unité qui n'existe plus",
    "Les personnes ciblées ne se rapprochent plus d'aucune commune du découpage courant.",
    cl.filter(c => !connu(c.geo_pcode)).length,
    cl.filter(c => !connu(c.geo_pcode)).map(c => `${c.geo_pcode} — ${c.year}`));

  const sc = db.prepare("SELECT * FROM office_scope").all();
  ajoute("perimetre_pcode_inconnu", "Périmètres de bureau pointant une unité qui n'existe plus",
    "Le bureau ne couvre alors plus rien, et ses comptes ne voient plus leurs propres données.",
    sc.filter(x => !connu(x.geo_pcode)).length,
    sc.filter(x => !connu(x.geo_pcode)).map(x => x.geo_pcode));

  /* Un bureau national n'a pas de périmètre, et c'est normal : il les couvre tous.
     Un bureau de terrain sans périmètre, en revanche, est un bureau dont les comptes
     voient tout — l'inverse de ce qu'on a voulu. */
  const bureaux = db.prepare("SELECT id, name, kind FROM offices").all();
  const declares = new Set(sc.map(x => x.office_id));
  const sansPerimetre = bureaux.filter(o => o.kind === "field" && !declares.has(o.id));
  ajoute("bureaux_sans_perimetre", "Bureaux de terrain sans périmètre déclaré",
    "Faute de périmètre, leurs comptes voient l'ensemble du pays au lieu de leur zone.",
    sansPerimetre.length, sansPerimetre.map(o => o.name));

  /* Ce qui pourrait être réparé tout de suite, sans décision humaine. */
  let parContour = 0, parProximite = 0;
  for(const s of rattrapables){
    const t = locate(Number(s.lat), Number(s.lon), { versionId:v.id });
    if(t.error) continue;
    if(t.methode === "contour") parContour++; else parProximite++;
  }

  res.json({
    version: { id:v.id, label:v.label },
    niveaux: db.prepare(
      "SELECT level, COUNT(*) c FROM geo_unit WHERE version_id=? GROUP BY level").all(v.id),
    contours: db.prepare(
      "SELECT level, COUNT(*) c FROM geo_geom WHERE version_id=? GROUP BY level").all(v.id),
    volumes: { sites:sites.length, pdd:pdd.length, caseload:cl.length, perimetres:sc.length },
    constats,
    ecarts: constats.reduce((t, c) => t + c.n, 0),
    reparable: { contour:parContour, proximite:parProximite },
  });
});

export default r;
