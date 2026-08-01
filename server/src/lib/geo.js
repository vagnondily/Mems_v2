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
export function buildUnits(rows, { allowDuplicates = false } = {}){
  const byKey = new Map();          /* chemin normalisé -> unité */
  const rejected = [];

  /* L'IDENTITÉ d'une unité est son CHEMIN complet, pas son p-code. Dans une base
     réelle, un même p-code profond peut désigner deux unités légitimes portées par
     des chemins différents — le fokontany « Berano Ville » rattaché à deux communes
     voisines. On ne refuse donc jamais le fichier, et on ne devine jamais lequel
     est le bon :

       — on SIGNALE toujours ces p-codes en double (collisions), pour que la source
         puisse être corrigée ou l'ambiguïté acceptée en connaissance de cause ;
       — `allowDuplicates` tranche ce qu'on ÉCRIT. Faux (défaut) : le premier trouvé
         l'emporte, les suivants ne créent pas de ligne — un rattachement par p-code
         reste alors sans ambiguïté. Vrai : les deux entrent, et le doublon reçoit un
         code dérivé de son chemin pour ne pas heurter la clé primaire (pcode,
         version) — les deux unités existent, le chemin faisant foi.

     Conséquence, dans les deux cas : le rattachement PAR NOM reste sûr ; PAR P-CODE,
     le premier trouvé l'emporte. C'est un fait de la donnée, pas un défaut du code. */
  const vus = new Map();            /* p-code candidat -> premier chemin qui l'a pris */
  const collMap = new Map();        /* p-code candidat -> ensemble des chemins concernés */

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
        const candidat = explicit || derivePcode(level, normPath);

        /* Le candidat est-il déjà pris par un AUTRE chemin ? Alors c'est une
           collision : on la mémorise, et on décide de ce qu'on en fait. */
        let pcode = candidat, doublon = false;
        if(vus.has(candidat) && vus.get(candidat) !== normPath){
          doublon = true;
          if(!collMap.has(candidat)) collMap.set(candidat, new Set([vus.get(candidat)]));
          collMap.get(candidat).add(normPath);
          /* Accepté : le doublon reçoit un code dérivé de son chemin, unique par
             construction, pour que les deux unités coexistent. */
          if(allowDuplicates) pcode = derivePcode(level, normPath);
        }
        if(!vus.has(candidat)) vus.set(candidat, normPath);

        /* La profondeur dans le chemin se compte depuis le premier niveau
           renseigné, pas depuis adm0 qui peut être absent. */
        pathCodes = [...pathCodes.slice(0, k - first), pcode];
        unit = { pcode, parent_pcode:parentPcode, level, name:names[k],
                 name_norm:normalizeName(names[k]), path:pathCodes.join("/"),
                 lat:null, lon:null, _norm:normPath,
                 /* Doublon non dédoublonné : à écarter à l'écriture (premier gagne). */
                 _doublon: doublon && !allowDuplicates };
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

  const collisions = [...collMap].map(([pcode, chemins]) => ({ pcode, chemins:[...chemins] }));
  /* Sans acceptation des doublons, le premier trouvé l'emporte : les unités en
     doublon ne créent pas de ligne. Avec, elles sont là (code dérivé). Dans les
     deux cas, les p-codes de `units` sont uniques — la clé primaire est sauve. */
  const units = [...byKey.values()].filter(u => !u._doublon);
  return { units, rejected, collisions,
    counts: Object.fromEntries(LEVELS.map(l => [l, units.filter(u=>u.level===l).length])) };
}

/* Écrit un millésime complet en une transaction, et le rend courant. */
export function writeVersion({ label, source, units, userId = null, makeCurrent = true,
                              country = null }){
  const id = newId("gv");
  /* Le millésime appartient à un pays. À défaut de précision, c'est le pays
     courant : un découpage importé décrit le pays qu'on est en train de servir.
     La résolution est faite ici et non dans chaque appelant — la route d'import,
     le script en ligne de commande et le jeu de démonstration passent tous par
     cette fonction, et trois rattachements séparés finiraient par diverger. */
  const pays = country
    || db.prepare("SELECT code FROM country WHERE is_current=1").get()?.code
    || null;
  tx(() => {
    db.prepare(`INSERT INTO geo_version (id,label,source,imported_by,units,is_current,country)
                VALUES (?,?,?,?,?,0,?)`).run(id, label, source ?? null, userId, units.length, pays);
    const ins = db.prepare(`INSERT INTO geo_unit
      (pcode,version_id,parent_pcode,level,name,name_norm,path,lat,lon)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    for(const u of units)
      ins.run(u.pcode, id, u.parent_pcode, u.level, u.name, u.name_norm, u.path, u.lat, u.lon);
    if(makeCurrent){
      /* On ne désactive que le millésime du même pays : activer un découpage
         congolais ne doit pas retirer le référentiel malgache à ceux qui
         travaillent dessus. */
      db.prepare("UPDATE geo_version SET is_current=0 WHERE is_current=1 AND country IS ?").run(pays);
      db.prepare("UPDATE geo_version SET is_current=1 WHERE id=?").run(id);
    }
  })();
  return id;
}

/* Le référentiel courant est celui du PAYS courant. Chaque pays a son millésime
   actif, et changer de pays n'y touche pas : il n'y a donc aucun état à retenir,
   et un aller-retour entre deux pays ne bascule pas silencieusement sur un autre
   millésime que celui qu'on avait choisi.

   Le repli sur « n'importe quel millésime courant » couvre la base dont aucun
   pays n'est configuré — migration non appliquée, ou millésime importé avant
   qu'elle le soit. */
export function currentVersion(){
  const pays = db.prepare("SELECT code FROM country WHERE is_current=1").get()?.code;
  if(pays){
    const v = db.prepare("SELECT * FROM geo_version WHERE is_current=1 AND country=?").get(pays);
    if(v) return v;
    /* Le pays courant n'a pas de découpage : on ne rend PAS celui d'un autre pays.
       Afficher la géographie du Congo sous le vocabulaire malgache serait l'erreur
       la plus difficile à voir de toutes. */
    return null;
  }
  return db.prepare("SELECT * FROM geo_version WHERE is_current=1").get() || null;
}

/* ── Rapprochement d'un libellé vers le référentiel ────────────────────
   On descend l'arbre niveau par niveau en comparant les formes normalisées :
   chaque niveau est cherché parmi les seuls enfants du niveau retenu au-dessus.
   C'est ce qui lève l'ambiguïté — plusieurs communes du pays portent le même nom,
   mais une seule s'appelle ainsi dans ce district.

   Retourne l'unité la plus profonde atteinte, et à quel niveau la descente s'est
   arrêtée. Un rattachement partiel (commune trouvée, fokontany inconnu) vaut mieux
   qu'un rattachement faux : l'appelant décide s'il l'accepte. */
export function resolveUnit(names, versionId){
  const v = versionId || currentVersion()?.id;
  if(!v) return { pcode:null, level:null, matched:[], ambiguous:false };

  const byParent = db.prepare(
    `SELECT pcode, name, level FROM geo_unit WHERE version_id=? AND parent_pcode IS ? AND name_norm=?`);
  const byLevel = db.prepare(
    `SELECT pcode, name, level FROM geo_unit WHERE version_id=? AND level=? AND name_norm=?`);

  let parent = null, found = null, matched = [], ambiguous = false;
  for(const level of LEVELS){
    const raw = names[level];
    if(!raw) continue;
    const norm = normalizeName(raw);
    if(!norm) continue;
    /* Au premier niveau rencontré on cherche par niveau ; ensuite, uniquement
       parmi les enfants de ce qui a déjà été retenu. */
    const hits = parent === null && !found
      ? byLevel.all(v, level, norm)
      : byParent.all(v, parent, norm);
    if(hits.length !== 1){
      if(hits.length > 1) ambiguous = true;
      break;                     /* inconnu ou ambigu : on s'arrête à ce qu'on tient */
    }
    found = hits[0]; parent = found.pcode; matched.push(level);
  }
  return { pcode: found?.pcode ?? null, level: found?.level ?? null, name: found?.name ?? null,
           matched, ambiguous };
}

/* Les libellés d'affichage redescendent du rattachement : ils ne sont plus saisis,
   donc ils ne peuvent plus diverger du référentiel. */
export function labelsFor(pcode, versionId){
  const v = versionId || currentVersion()?.id;
  const out = { adm1:"", adm2:"", adm3:"", adm4:"", lat:null, lon:null };
  if(!v || !pcode) return out;
  let cur = db.prepare("SELECT * FROM geo_unit WHERE version_id=? AND pcode=?").get(v, pcode);
  if(cur){ out.lat = cur.lat; out.lon = cur.lon; }
  while(cur){
    if(cur.level in out) out[cur.level] = cur.name;
    cur = cur.parent_pcode
      ? db.prepare("SELECT * FROM geo_unit WHERE version_id=? AND pcode=?").get(v, cur.parent_pcode)
      : null;
  }
  return out;
}

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
