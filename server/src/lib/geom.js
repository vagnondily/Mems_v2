import { db, tx } from "../db.js";
import { resolveUnit, LEVELS } from "./geo.js";
import { dissoudre } from "./dissoudre.js";

/* ═══════════════════════════════════════════════════════════════════════
   Géométries administratives — simplification et service.

   Un fond de carte administratif se heurte à un problème de volume, pas de
   principe. Le découpage de Madagascar compte près de 18 000 fokontany ; leurs
   contours en pleine résolution représentent des dizaines de millions de
   sommets, et un navigateur qui en reçoit ne serait-ce que le dixième ne les
   affiche pas — il s'arrête.

   Deux réponses, appliquées ensemble :

     on SIMPLIFIE à l'import (Douglas-Peucker), et on garde les deux versions ;
     on ne SERT jamais un niveau entier au-delà de ce que l'écran peut montrer.

   La tolérance dépend du niveau, parce que l'échelle d'affichage en dépend : une
   région se regarde à l'échelle du pays, un fokontany à celle de la commune.
   Simplifier un fokontany aussi grossièrement qu'une région le réduirait à un
   triangle ; simplifier une région aussi finement qu'un fokontany ne servirait à
   rien tout en pesant cent fois plus.
   ═══════════════════════════════════════════════════════════════════════ */

/* Tolérance de simplification, en degrés. 0,01° vaut environ 1,1 km à ces
   latitudes ; 0,001° environ 110 m. */
export const TOLERANCE = { adm0:0.02, adm1:0.01, adm2:0.005, adm3:0.002, adm4:0.001 };

/* Douglas-Peucker. La distance est calculée dans le plan des degrés, sans
   projection : l'erreur d'anisotropie est de l'ordre du cosinus de la latitude
   (~0,9 à Madagascar) et n'a aucune conséquence sur une simplification dont le
   but est de retirer des sommets invisibles à l'écran. Projeter d'abord aurait
   coûté un aller-retour par point pour un gain nul. */
function simplifyRing(pts, tol){
  if(pts.length <= 4) return pts;
  const t2 = tol * tol;
  const garder = new Uint8Array(pts.length);
  garder[0] = garder[pts.length - 1] = 1;

  /* Pile explicite plutôt que récursion : un anneau côtier peut compter des
     dizaines de milliers de points, et la récursion déborderait. */
  const pile = [[0, pts.length - 1]];
  while(pile.length){
    const [a, b] = pile.pop();
    if(b - a < 2) continue;
    const [x1, y1] = pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1;
    const norme = dx*dx + dy*dy;
    let pire = -1, dMax = -1;
    for(let i = a + 1; i < b; i++){
      const [x, y] = pts[i];
      let d;
      if(norme === 0){ const ex = x - x1, ey = y - y1; d = ex*ex + ey*ey; }
      else {
        let u = ((x - x1)*dx + (y - y1)*dy) / norme;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = x1 + u*dx, py = y1 + u*dy;
        const ex = x - px, ey = y - py; d = ex*ex + ey*ey;
      }
      if(d > dMax){ dMax = d; pire = i; }
    }
    if(dMax > t2){ garder[pire] = 1; pile.push([a, pire], [pire, b]); }
  }
  const out = [];
  for(let i = 0; i < pts.length; i++) if(garder[i]) out.push(pts[i]);
  /* Un anneau doit rester fermé et compter au moins un triangle. Sous ce seuil la
     simplification a détruit la forme : on rend l'original, qui est de toute façon
     minuscule. */
  if(out.length < 4) return pts;
  if(out[0][0] !== out[out.length-1][0] || out[0][1] !== out[out.length-1][1]) out.push(out[0]);
  return out;
}

const compte = (g) => {
  if(!g) return 0;
  if(g.type === "Polygon") return g.coordinates.reduce((t, r) => t + r.length, 0);
  if(g.type === "MultiPolygon")
    return g.coordinates.reduce((t, p) => t + p.reduce((u, r) => u + r.length, 0), 0);
  return 0;
};

export function simplify(geometry, tol){
  if(!geometry) return null;
  if(geometry.type === "Polygon")
    return { type:"Polygon",
      coordinates: geometry.coordinates.map(r => simplifyRing(r, tol)) };
  if(geometry.type === "MultiPolygon")
    return { type:"MultiPolygon",
      /* Un îlot réduit à moins d'un triangle disparaît : à l'échelle où cette
         version sert, il ne représentait plus rien de visible. */
      coordinates: geometry.coordinates
        .map(p => p.map(r => simplifyRing(r, tol)).filter(r => r.length >= 4))
        .filter(p => p.length) };
  return geometry;
}

export function bbox(geometry){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const balayer = (r) => { for(const [x, y] of r){
    if(x < x0) x0 = x; if(x > x1) x1 = x;
    if(y < y0) y0 = y; if(y > y1) y1 = y; } };
  if(geometry?.type === "Polygon") geometry.coordinates.forEach(balayer);
  else if(geometry?.type === "MultiPolygon")
    geometry.coordinates.forEach(p => p.forEach(balayer));
  if(!Number.isFinite(x0)) return null;
  return { min_lon:x0, min_lat:y0, max_lon:x1, max_lat:y1 };
}

/* Centroïde du plus grand anneau extérieur. Sert à replacer une unité dont le
   référentiel ne portait pas de coordonnées : importer des contours donne donc
   aussi les points, et l'inverse n'était pas vrai. */
export function centroid(geometry){
  const anneaux = geometry?.type === "Polygon" ? [geometry.coordinates[0]]
    : geometry?.type === "MultiPolygon" ? geometry.coordinates.map(p => p[0]) : [];
  let best = null, bestA = -1;
  for(const r of anneaux){
    if(!r || r.length < 4) continue;
    let a = 0, cx = 0, cy = 0;
    for(let i = 0, j = r.length - 1; i < r.length; j = i++){
      const f = r[j][0]*r[i][1] - r[i][0]*r[j][1];
      a += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f;
    }
    a *= 0.5;
    if(Math.abs(a) < 1e-12) continue;
    if(Math.abs(a) > bestA){ bestA = Math.abs(a); best = [cx/(6*a), cy/(6*a)]; }
  }
  return best;
}

/* ── Écriture ────────────────────────────────────────────────────────
   Par lots, parce que l'ensemble ne passe pas dans une requête. Le client envoie
   le premier lot avec `reset`, et le millésime se souvient de ce qu'il porte.

   `niveau` (chantier S8, point 6) borne le dépôt à UN niveau administratif.
   Un pays se cartographie à plusieurs mailles — régions, districts, communes,
   fokontany — et chaque maille arrive dans son propre fichier. Deux effets,
   tous deux nécessaires pour que les dépôts successifs s'ajoutent au lieu de
   se remplacer :

     — `reset` ne vide QUE ce niveau. Sans cela, déposer les régions effacerait
       les communes déjà chargées, et le multi-niveau serait impossible ;
     — un contour qui se résout à un AUTRE niveau est rejeté, avec son motif.
       C'est la garde qui manque le plus : un fichier de communes déposé dans
       l'emplacement des régions s'écrirait sans erreur, et la carte afficherait
       1 701 contours sous l'étiquette « régions » sans que rien ne le dise. */
/* `exec` (optionnel) : un exécuteur `db`-compatible. Fourni, l'écriture des
   contours se fait DESSUS, dans la transaction déjà ouverte par l'appelant —
   c'est ce qui permet à l'import de shapefile d'englober l'écriture du millésime
   ET celle des contours dans un seul tout atomique. Les lectures (le tableau des
   unités, la résolution par nom) passent aussi par cet exécuteur, pour VOIR les
   unités que le même appelant vient d'écrire sans les avoir encore validées.
   Absent, la fonction ouvre sa propre transaction, comportement autonome. */
export async function writeGeometries({ versionId, features, reset, source, niveau = null }, exec = null){
  let écrites = 0, points = 0, simples = 0;
  const rejets = [];
  const corps = async (db) => {
    const unites = Object.fromEntries((await db.prepare(
      "SELECT pcode, level, lat, lon FROM geo_unit WHERE version_id=?").all(versionId))
      .map(u => [u.pcode, u]));

    /* Rattachement d'un contour à son unité.

       Par p-code quand le fichier en porte un ET qu'il figure dans le millésime.
       Sinon PAR LE CHEMIN DE NOMS, comme les sites et le plan de distribution :
       les p-codes du référentiel sont dérivés du chemin normalisé, et un fichier de
       contours porte rarement les mêmes que le fichier de découpage dont on a
       importé l'arbre. Exiger le p-code aurait fait échouer l'import sur un fichier
       parfaitement valide, sans dire pourquoi. */
    const resoudre = async (f) => {
      if(f.pcode && unites[f.pcode]) return f.pcode;
      if(f.names){
        const m = await resolveUnit(f.names, versionId, db);
        if(m?.pcode) return m.pcode;
      }
      return null;
    };

    const ins = db.prepare(`INSERT INTO geo_geom
      (pcode,version_id,level,geometry,simple,min_lon,min_lat,max_lon,max_lat,points,points_simple,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(pcode,version_id) DO UPDATE SET
        level=excluded.level, geometry=excluded.geometry, simple=excluded.simple,
        min_lon=excluded.min_lon, min_lat=excluded.min_lat,
        max_lon=excluded.max_lon, max_lat=excluded.max_lat,
        points=excluded.points, points_simple=excluded.points_simple, source=excluded.source`);
    /* Un contour donne un point : on comble les unités sans coordonnées, sans
       écraser celles qui en ont déjà — le référentiel peut porter des centroïdes
       officiels, meilleurs qu'un calcul. */
    const majPoint = db.prepare(
      "UPDATE geo_unit SET lat=?, lon=? WHERE pcode=? AND version_id=? AND (lat IS NULL OR lon IS NULL)");

    if(reset){
      if(niveau) await db.prepare("DELETE FROM geo_geom WHERE version_id=? AND level=?")
        .run(versionId, niveau);
      else await db.prepare("DELETE FROM geo_geom WHERE version_id=?").run(versionId);
    }
    for(const f of features){
      const pcode = await resoudre(f);
      const u = pcode ? unites[pcode] : null;
      if(!u){ rejets.push({ pcode: f.pcode || Object.values(f.names || {}).filter(Boolean).join(" / "),
        message:"unité introuvable dans le millésime — ni par p-code ni par chemin de noms" });
        continue; }
      if(niveau && u.level !== niveau){
        rejets.push({ pcode, message:`ce contour désigne une unité de niveau ${u.level}, `
          + `or le dépôt annonce ${niveau} — vérifiez le fichier ou le niveau choisi` });
        continue;
      }
      const g = f.geometry;
      if(!g || !["Polygon","MultiPolygon"].includes(g.type)){
        rejets.push({ pcode, message:"géométrie ni Polygon ni MultiPolygon" }); continue; }
      const box = bbox(g);
      if(!box){ rejets.push({ pcode, message:"géométrie vide" }); continue; }
      /* Un contour dont les coordonnées sortent du domaine des degrés vient d'un
         fichier en projection métrique : le rejeter avec son motif vaut mieux que
         de dessiner l'océan Atlantique. */
      if(box.min_lon < -180 || box.max_lon > 180 || box.min_lat < -90 || box.max_lat > 90){
        rejets.push({ pcode,
          message:"coordonnées hors du domaine géographique — le fichier n'est probablement pas en WGS 84" });
        continue;
      }
      const s = simplify(g, TOLERANCE[u.level] ?? 0.002);
      const np = compte(g), ns = compte(s);
      await ins.run(pcode, versionId, u.level, JSON.stringify(g), JSON.stringify(s),
        box.min_lon, box.min_lat, box.max_lon, box.max_lat, np, ns, source || null);
      const c = centroid(s);
      if(c) await majPoint.run(c[1], c[0], pcode, versionId);
      écrites++; points += np; simples += ns;
    }
    const total = (await db.prepare("SELECT COUNT(*) c FROM geo_geom WHERE version_id=?").get(versionId)).c;
    await db.prepare(`UPDATE geo_version SET geom_units=?, geom_source=COALESCE(?,geom_source),
                geom_at=now() WHERE id=?`).run(total, source || null, versionId);
  };
  if(exec) await corps(exec);
  else await tx(corps);
  return { écrites, points, simples, rejets: rejets.slice(0, 20), rejetes: rejets.length };
}

/* ── Lecture ─────────────────────────────────────────────────────────
   Un niveau, éventuellement sous un parent. `detail` demande la pleine
   résolution ; par défaut on rend la version simplifiée, qui est celle dont un
   écran a besoin neuf fois sur dix. */
export async function readGeometries({ versionId, level, parent, detail = false, limit = 2000 }){
  const where = ["g.version_id = ?"]; const args = [versionId];
  if(level){ where.push("g.level = ?"); args.push(level); }
  if(parent){
    const p = await db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?")
      .get(versionId, parent);
    if(!p) return { features:[], tronque:false };
    where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%");
  }
  const rows = await db.prepare(`
    SELECT g.pcode, g.level, ${detail ? "g.geometry" : "COALESCE(g.simple, g.geometry)"} geom,
           g.min_lon, g.min_lat, g.max_lon, g.max_lat, u.name, u.parent_pcode
    FROM geo_geom g JOIN geo_unit u ON u.pcode = g.pcode AND u.version_id = g.version_id
    WHERE ${where.join(" AND ")} ORDER BY u.path LIMIT ?`).all(...args, limit + 1);

  const tronque = rows.length > limit;
  return {
    tronque,
    features: rows.slice(0, limit).map(x => ({
      type:"Feature",
      properties:{ pcode:x.pcode, level:x.level, name:x.name, parent:x.parent_pcode,
                   bbox:[x.min_lon, x.min_lat, x.max_lon, x.max_lat] },
      /* `geom` (geometry/simple) est jsonb : pg la rend déjà en objet. */
      geometry: x.geom,
    })),
  };
}

/* Le cadre d'un ensemble d'unités : ce sur quoi la carte doit se caler. Calculé
   en SQL sur les cadres déjà stockés, jamais en parcourant les contours. */
export async function extent({ versionId, level, parent }){
  const where = ["g.version_id = ?"]; const args = [versionId];
  if(level){ where.push("g.level = ?"); args.push(level); }
  if(parent){
    const p = await db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?")
      .get(versionId, parent);
    if(p){ where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%"); }
  }
  const b = await db.prepare(`SELECT MIN(g.min_lon) w, MIN(g.min_lat) s, MAX(g.max_lon) e,
    MAX(g.max_lat) n, COUNT(*) c FROM geo_geom g
    JOIN geo_unit u ON u.pcode=g.pcode AND u.version_id=g.version_id
    WHERE ${where.join(" AND ")}`).get(...args);
  return b?.c ? { west:b.w, south:b.s, east:b.e, north:b.n, units:b.c } : null;
}

/* ── Dériver les niveaux supérieurs ──────────────────────────────────
   Les contours d'un district sont ceux de ses communes RÉUNIES. Un seul
   fichier — le plus fin — suffit donc à donner tous les niveaux au-dessus,
   ce qui est exactement la situation : le bureau a le découpage aux
   communes, pas celui des districts ni des régions.

   La dérivation remonte de proche en proche, et chaque étage part de celui
   qu'on vient de calculer : dix fois moins de sommets à coudre qu'en
   repartant du plus fin, pour un résultat identique — les frontières
   intérieures sont déjà tombées à l'étage d'avant.

   Un parent à la fois : ses enfants sont lus, dissous, écrits, relâchés.
   Tenir les 1 701 communes d'un pays en mémoire pour en faire 119 districts
   n'apporterait rien qu'un pic de mémoire.

   Vit ici et non dans la route, parce que le semis des données réelles
   (`seed-reel.js`) en a besoin autant qu'elle : deux implémentations de la
   même remontée finiraient par diverger. */
/* `exec` (optionnel) : un exécuteur `db`-compatible. Fourni, toutes les lectures
   ET les écritures (via writeGeometries, à qui il est transmis) passent par lui,
   pour qu'un appelant ayant déjà ouvert une transaction y englobe la dérivation.
   Absent, chaque lot d'écriture ouvre sa propre transaction, comme avant — la
   dérivation n'était pas atomique dans son ensemble à l'origine. */
export async function deriverNiveaux({ versionId, source = null, remplacerExistants = false, auto = false },
                                     exec = db){
  const porte = Object.fromEntries((await geomSummary(versionId, exec)).map(x => [x.level, x.units]));
  const depart = source || [...LEVELS].reverse().find(l => porte[l] > 0);
  if(!depart) return { erreur:"aucun contour dans ce millésime", statut:409 };
  if(!porte[depart]) return { erreur:`le niveau ${depart} ne porte aucun contour`, statut:409 };
  const i0 = LEVELS.indexOf(depart);
  if(i0 <= 0) return { erreur:`${depart} est le niveau le plus haut : rien à dériver au-dessus`,
                       statut:409 };

  const enfantsDe = exec.prepare(
    `SELECT g.geometry FROM geo_geom g
     JOIN geo_unit u ON u.pcode=g.pcode AND u.version_id=g.version_id
     WHERE g.version_id=? AND g.level=? AND u.parent_pcode=?`);
  /* Un niveau porte-t-il des contours DÉRIVÉS (par opposition à un fichier
     officiel) ? La dérivation automatique ne rafraîchit QUE ce qui a été
     calculé — jamais un contour importé à la main, qui vaut mieux qu'un
     calcul. La marque est la source, posée par writeGeometries. */
  const estDerive = async (niveau) => {
    /* PostgreSQL ne SUM pas un booléen (SQLite comptait true=1) : on compte par
       un CASE explicite. `d` peut revenir en chaîne (bigint) selon le pilote,
       d'où Number(). */
    const r = await exec.prepare(
      `SELECT COUNT(*) c, SUM(CASE WHEN source LIKE 'dérivé%' THEN 1 ELSE 0 END) d
       FROM geo_geom WHERE version_id=? AND level=?`)
      .get(versionId, niveau);
    return r.c > 0 && Number(r.d) === Number(r.c);
  };

  /* Un lot d'écriture reçoit l'exécuteur seulement si l'appelant en a fourni un :
     autrement writeGeometries ouvre sa propre transaction par lot (parité). */
  const execLot = exec === db ? null : exec;

  const etapes = [];
  for(let i = i0; i > 0; i--){
    const enfant = LEVELS[i], parent = LEVELS[i - 1];
    const parents = await exec.prepare("SELECT pcode FROM geo_unit WHERE version_id=? AND level=?")
      .all(versionId, parent);
    if(!parents.length){ etapes.push({ niveau:parent, saute:"aucune unité à ce niveau" }); continue; }
    /* Un contour officiel vaut mieux qu'un contour calculé : un niveau déjà
       pourvu n'est pas écrasé sans qu'on le demande.
       — Mode manuel : `remplacerExistants` tranche.
       — Mode AUTO (après (re)dépôt d'un niveau plus fin) : on rafraîchit un
         niveau supérieur s'il est VIDE ou entièrement DÉRIVÉ, jamais s'il
         porte des contours officiels. */
    const bloque = porte[parent]
      && (auto ? !(await estDerive(parent)) : !remplacerExistants);
    if(bloque){
      etapes.push({ niveau:parent,
        saute: auto
          ? `${porte[parent]} contour(s) officiels — non écrasés par la dérivation automatique`
          : `${porte[parent]} contour(s) déjà présents — cochez le remplacement pour recalculer` });
      continue;
    }

    let ecrites = 0, approximatifs = 0, sansEnfant = 0, premier = true, lot = [];
    const motifs = [];
    const vider = async () => {
      if(!lot.length) return;
      const b = await writeGeometries({ versionId, features:lot, reset:premier,
        source:`dérivé de ${enfant}`, niveau:parent }, execLot);
      premier = false; ecrites += b.écrites; lot = [];
    };
    for(const p of parents){
      /* `geometry` est jsonb : pg la rend déjà en objet (aucun JSON.parse). */
      const geoms = (await enfantsDe.all(versionId, enfant, p.pcode))
        .map(x => x.geometry)
        .filter(Boolean);
      if(!geoms.length){ sansEnfant++; continue; }
      const d = dissoudre(geoms);
      if(!d.geometry){ sansEnfant++; continue; }
      if(d.approximatif){ approximatifs++;
        if(motifs.length < 5) motifs.push({ pcode:p.pcode, motif:d.motif }); }
      lot.push({ pcode:p.pcode, geometry:d.geometry });
      if(lot.length >= 20) await vider();
    }
    await vider();
    porte[parent] = ecrites;
    etapes.push({ niveau:parent, depuis:enfant, unites:parents.length, ecrites,
      approximatifs, sansEnfant, motifs });
  }
  return { source:depart, etapes,
    total: etapes.reduce((a, e) => a + (e.ecrites || 0), 0),
    approximatifs: etapes.reduce((a, e) => a + (e.approximatifs || 0), 0) };
}

/* Ce que le millésime porte, par niveau. L'écran de configuration doit pouvoir
   dire « les régions et les districts ont leurs contours, les communes non ». */
export async function geomSummary(versionId, exec = db){
  return exec.prepare(`SELECT level, COUNT(*) units, SUM(points) points,
    SUM(points_simple) points_simple FROM geo_geom WHERE version_id=?
    GROUP BY level ORDER BY level`).all(versionId);
}
