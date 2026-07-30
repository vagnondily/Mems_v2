import { db } from "./../db.js";
import { currentVersion, LEVELS } from "./geo.js";

/* ═══════════════════════════════════════════════════════════════════════
   Où tombe ce point ?

   Un site porte des coordonnées relevées au GPS et, souvent, aucun rattachement au
   découpage : le nom de commune a été saisi autrement, ou pas du tout. Il apparaît
   alors comme un cercle sur la carte, mais n'entre dans aucun total par district,
   aucune couverture, aucun ciblage. C'est le cas le plus fréquent d'un registre
   repris d'un tableur.

   Or la réponse est dans les données : le point est quelque part, et le découpage
   dit où. On la cherche donc, plutôt que de demander à quelqu'un de retrouver à la
   main la commune de trois cents sites.

   DEUX méthodes, et la réponse dit toujours laquelle a servi :

     « contour »   le point est À L'INTÉRIEUR du polygone de l'unité. C'est une
                   certitude géométrique, pas une estimation.

     « proximité » aucun contour ne le contient — il n'y en a pas de chargé, ou le
                   point tombe en mer, ou juste au-delà d'une frontière. On rend
                   alors l'unité dont le CENTRE est le plus proche, avec la distance.

   La distinction n'est pas cosmétique. Un rattachement par proximité à 40 km n'a
   pas la même valeur qu'un point tombé dans un polygone, et l'écran doit pouvoir
   refuser le premier. Un outil qui rendrait « commune X » dans les deux cas ferait
   entrer des approximations dans des totaux qu'on présente ensuite à un bailleur.
   ═══════════════════════════════════════════════════════════════════════ */

/* Le point est-il dans l'anneau ? Lancer de rayon : on compte les intersections
   d'une demi-droite horizontale avec les segments. Impair = dedans.

   La comparaison `(yi > y) !== (yj > y)` traite les sommets exactement à la
   latitude du point sans les compter deux fois — c'est le piège classique de cet
   algorithme, et il produit des trous invisibles le long des parallèles. */
function dansAnneau(ring, lon, lat){
  let dedans = false;
  for(let i = 0, j = ring.length - 1; i < ring.length; j = i++){
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if((yi > lat) !== (yj > lat) &&
       lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dedans = !dedans;
  }
  return dedans;
}

/* Un polygone GeoJSON : premier anneau extérieur, les suivants sont des trous.
   Un point dans un trou n'est pas dans le polygone — une enclave se voit rarement
   sur un découpage administratif, mais elle existe, et l'ignorer donnerait un
   rattachement faux avec l'assurance d'un rattachement géométrique. */
function dansPolygone(coords, lon, lat){
  if(!coords?.length || !dansAnneau(coords[0], lon, lat)) return false;
  for(let i = 1; i < coords.length; i++)
    if(dansAnneau(coords[i], lon, lat)) return false;
  return true;
}

function dansGeometrie(g, lon, lat){
  if(!g) return false;
  if(g.type === "Polygon") return dansPolygone(g.coordinates, lon, lat);
  if(g.type === "MultiPolygon") return g.coordinates.some(p => dansPolygone(p, lon, lat));
  return false;
}

/* Distance approchée en kilomètres. Équirectangulaire corrigée à la latitude : à
   l'échelle d'un pays, l'écart avec la formule de haversine est de l'ordre du
   millième — sans commune mesure avec l'incertitude d'un relevé GPS de terrain. */
const RAYON = 6371;
export function distanceKm(lat1, lon1, lat2, lon2){
  const x = (lon2 - lon1) * Math.PI / 180 * Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
  const y = (lat2 - lat1) * Math.PI / 180;
  return Math.round(Math.sqrt(x*x + y*y) * RAYON * 100) / 100;
}

/* Le chemin d'une unité, en noms lisibles : c'est ce qu'on montre pour qu'un humain
   valide le rattachement proposé. Un p-code ne se vérifie pas à l'œil. */
export function unitLabels(pcode, versionId){
  const u = db.prepare("SELECT * FROM geo_unit WHERE pcode=? AND version_id=?").get(pcode, versionId);
  if(!u) return null;
  const noms = {};
  const chemin = (u.path || "").split("/").filter(Boolean);
  for(const p of chemin){
    const a = db.prepare("SELECT level, name FROM geo_unit WHERE pcode=? AND version_id=?")
      .get(p, versionId);
    if(a) noms[a.level] = a.name;
  }
  return { pcode:u.pcode, level:u.level, name:u.name, path:u.path, ...noms };
}

/* Le cœur : trouver l'unité qui contient ce point, au niveau le plus fin possible.

   On part du niveau le plus fin chargé et on remonte : un point est plus utile
   rattaché à son fokontany qu'à sa région, et le chemin porte de toute façon les
   ancêtres. Le filtre par cadre englobant vient d'abord — il élimine 99 % des
   candidats avec une comparaison de nombres, là où le lancer de rayon parcourt des
   centaines de sommets. */
export function locate(lat, lon, opts = {}){
  const v = opts.versionId ? { id:opts.versionId } : currentVersion();
  if(!v) return { error:"aucun découpage administratif n'est chargé pour ce pays" };
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return { error:"coordonnées absentes" };
  if(Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return { error:"coordonnées hors plage : attendues en degrés décimaux WGS 84" };

  /* Niveaux réellement disponibles en contours, du plus fin au plus large. */
  const niveaux = db.prepare(
    `SELECT DISTINCT level FROM geo_geom WHERE version_id=?`).all(v.id).map(r => r.level)
    .sort((a, b) => LEVELS.indexOf(b) - LEVELS.indexOf(a));

  const cible = opts.level && niveaux.includes(opts.level) ? [opts.level] : niveaux;

  for(const level of cible){
    const candidats = db.prepare(
      `SELECT pcode, geometry FROM geo_geom
       WHERE version_id=? AND level=?
         AND min_lon <= ? AND max_lon >= ? AND min_lat <= ? AND max_lat >= ?`)
      .all(v.id, level, lon, lon, lat, lat);
    for(const c of candidats){
      let g; try{ g = JSON.parse(c.geometry); }catch(e){ continue; }
      if(dansGeometrie(g, lon, lat))
        return { methode:"contour", confiance:"certaine", distance:0,
                 ...unitLabels(c.pcode, v.id) };
    }
  }

  /* Repli : l'unité dont le centre est le plus proche. On se limite au niveau le
     plus fin qui porte des coordonnées — remonter à la région donnerait toujours une
     réponse, et toujours une réponse inutile. */
  const rayonMax = opts.rayonKm ?? 25;
  for(const level of [...LEVELS].reverse()){
    const unites = db.prepare(
      `SELECT pcode, name, lat, lon FROM geo_unit
       WHERE version_id=? AND level=? AND lat IS NOT NULL AND lon IS NOT NULL`).all(v.id, level);
    if(!unites.length) continue;
    let meilleur = null;
    for(const u of unites){
      const d = distanceKm(lat, lon, u.lat, u.lon);
      if(!meilleur || d < meilleur.d) meilleur = { u, d };
    }
    if(meilleur && meilleur.d <= rayonMax)
      return { methode:"proximité",
               /* Au-delà de quelques kilomètres, un centre de commune ne prouve
                  rien : on le dit, et l'écran décide s'il accepte. */
               confiance: meilleur.d <= 5 ? "probable" : "incertaine",
               distance: meilleur.d, ...unitLabels(meilleur.u.pcode, v.id) };
    break;
  }
  return { error:"aucune unité trouvée à proximité de ce point" };
}

/* Les sites sans rattachement mais avec des coordonnées : ceux que l'on peut aider.
   Un site sans coordonnées ne relève pas de cette fonction — il faut aller le
   relever sur le terrain, et aucun calcul ne remplacera cela. */
export function sitesALocaliser(officeId = null){
  const args = [];
  let filtre = "";
  if(officeId){ filtre = " AND office_id = ?"; args.push(officeId); }
  return db.prepare(
    `SELECT id, code, name, lat, lon, adm1, adm2, adm3, adm4, office_id
     FROM sites
     WHERE geo_pcode IS NULL AND lat IS NOT NULL AND lon IS NOT NULL${filtre}
     ORDER BY code`).all(...args);
}
