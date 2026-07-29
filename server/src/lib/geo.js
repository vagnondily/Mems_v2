import crypto from "node:crypto";
import { db, tx } from "../db.js";
import { newId } from "./crypto.js";

export const LEVELS = ["adm0","adm1","adm2","adm3","adm4"];

/* Forme de rapprochement d'un nom : sans accents, sans ponctuation, en minuscules.
   « Antanimora Sud » et « ANTANIMORA-SUD » se rejoignent ; c'est ce qui rend
   exploitable un fichier Excel saisi à la main. */
export function normalizeName(s){
  return String(s ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   /* accents */
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* Quand le fichier ne porte pas de code officiel, il en faut un tout de même —
   et il doit être stable d'un import à l'autre, sinon les données rattachées
   se détachent à chaque rechargement du référentiel. Il est donc dérivé du
   chemin normalisé, pas d'un compteur ni du hasard. */
export function derivePcode(level, normPath){
  const h = crypto.createHash("sha1").update(normPath).digest("base64url").slice(0, 10);
  return `X${LEVELS.indexOf(level)}${h}`;
}

/* Construit l'arbre à partir de lignes plates (adm0…adm4 en texte).
   Chaque ligne peut porter un code par niveau (pcode0…pcode4), ou un seul code
   pour son niveau le plus profond, ou aucun.

   Retourne la liste des unités, dédoublonnée : une commune présente sur
   quarante lignes de fokontany ne produit qu'une seule unité. */
export function buildUnits(rows){
  const byKey = new Map();          /* chemin normalisé -> unité */
  const rejected = [];

  rows.forEach((row, i) => {
    const names = LEVELS.map(l => String(row[l] ?? "").trim());
    if(!names.some(Boolean)){ rejected.push({ line:i+1, reason:"aucun niveau renseigné" }); return; }

    /* Premier et dernier niveaux réellement renseignés. Beaucoup de fichiers ne
       portent pas le pays : commencer à la région est parfaitement normal. */
    let first = -1, deepest = -1;
    for(let k=0;k<LEVELS.length;k++) if(names[k]){ if(first < 0) first = k; deepest = k; }

    /* Un trou au milieu ("région, puis rien, puis commune") rendrait l'arbre
       incohérent : la ligne est écartée plutôt que rattachée au mauvais parent. */
    for(let k=first;k<=deepest;k++){
      if(!names[k]){
        rejected.push({ line:i+1, reason:`niveau ${LEVELS[k]} vide alors que ${LEVELS[deepest]} est renseigné` });
        return;
      }
    }

    let parentPcode = null, normPath = "", pathCodes = [];
    for(let k=first;k<=deepest;k++){
      const level = LEVELS[k];
      normPath = normPath ? `${normPath}/${normalizeName(names[k])}` : normalizeName(names[k]);

      let unit = byKey.get(normPath);
      if(!unit){
        /* Code officiel du niveau s'il est fourni, sinon celui de la ligne
           lorsqu'on est au niveau le plus profond, sinon dérivé du chemin. */
        const explicit = String(row[`pcode${k}`] ?? "").trim()
          || (k === deepest ? String(row.pcode ?? "").trim() : "");
        const pcode = explicit || derivePcode(level, normPath);
        /* La profondeur dans le chemin se compte depuis le premier niveau
           renseigné, pas depuis adm0 qui peut être absent. */
        pathCodes = [...pathCodes.slice(0, k - first), pcode];
        unit = { pcode, parent_pcode:parentPcode, level, name:names[k],
                 name_norm:normalizeName(names[k]), path:pathCodes.join("/"),
                 lat:null, lon:null, _norm:normPath };
        byKey.set(normPath, unit);
      } else {
        pathCodes = unit.path.split("/");
      }
      /* Les coordonnées ne concernent que le niveau le plus profond de la ligne. */
      if(k === deepest){
        const lat = row.lat === "" || row.lat == null ? null : Number(row.lat);
        const lon = row.lon === "" || row.lon == null ? null : Number(row.lon);
        if(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat)<=90 && Math.abs(lon)<=180){
          unit.lat = lat; unit.lon = lon;
        }
      }
      parentPcode = unit.pcode;
    }
  });

  const units = [...byKey.values()];
  /* Un même pcode sur deux chemins différents casserait la clé primaire :
     on le signale plutôt que de laisser la base refuser l'import en bloc. */
  const seen = new Map(); const collisions = [];
  for(const u of units){
    if(seen.has(u.pcode)) collisions.push({ pcode:u.pcode, a:seen.get(u.pcode), b:u._norm });
    else seen.set(u.pcode, u._norm);
  }
  return { units, rejected, collisions,
    counts: Object.fromEntries(LEVELS.map(l => [l, units.filter(u=>u.level===l).length])) };
}

/* Écrit un millésime complet en une transaction, et le rend courant. */
export function writeVersion({ label, source, units, userId = null, makeCurrent = true }){
  const id = newId("gv");
  tx(() => {
    db.prepare(`INSERT INTO geo_version (id,label,source,imported_by,units,is_current)
                VALUES (?,?,?,?,?,0)`).run(id, label, source ?? null, userId, units.length);
    const ins = db.prepare(`INSERT INTO geo_unit
      (pcode,version_id,parent_pcode,level,name,name_norm,path,lat,lon)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for(const u of units)
      ins.run(u.pcode, id, u.parent_pcode, u.level, u.name, u.name_norm, u.path, u.lat, u.lon);
    if(makeCurrent){
      db.prepare("UPDATE geo_version SET is_current=0 WHERE is_current=1").run();
      db.prepare("UPDATE geo_version SET is_current=1 WHERE id=?").run(id);
    }
  })();
  return id;
}

export const currentVersion = () =>
  db.prepare("SELECT * FROM geo_version WHERE is_current=1").get() || null;

/* Reprise de l'ancienne table plate `geo` vers l'arbre, une seule fois.
   Sans elle, une base existante se retrouverait avec un référentiel vide. */
export function backfillFromLegacy(){
  if(db.prepare("SELECT COUNT(*) c FROM geo_version").get().c > 0) return null;
  const legacy = db.prepare("SELECT * FROM geo").all();
  if(!legacy.length) return null;
  const { units } = buildUnits(legacy.map(g => ({
    adm0:g.adm0, adm1:g.adm1, adm2:g.adm2, adm3:g.adm3, adm4:g.adm4,
    pcode:g.pcode, lat:g.lat, lon:g.lon })));
  if(!units.length) return null;
  const id = writeVersion({ label:"Reprise de l'ancien référentiel",
    source:"table geo (migration 002)", units });
  return { versionId:id, units:units.length, legacy:legacy.length };
}
