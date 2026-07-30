import { db } from "../db.js";
import { currentVersion } from "./geo.js";

/* ═══════════════════════════════════════════════════════════════════════
   Périmètre géographique d'un utilisateur — une seule définition.

   Elle était écrite trois fois, dans trois routes, avec trois formulations
   légèrement différentes. Une règle de sécurité dupliquée est une règle qui
   finit par diverger : c'est exactement ce qui était arrivé à la matrice des
   droits, déjà désynchronisée quand je l'ai trouvée.

   Deux axes distincts, qu'il ne faut pas confondre :

     le RÔLE dit ce qu'on peut faire      (lire, modifier, valider, administrer)
     le PÉRIMÈTRE dit où on peut le faire (quelles unités administratives)

   Un administrateur n'a pas de périmètre : il voit tout. Un compte rattaché à un
   bureau est borné aux unités attribuées à ce bureau.
   ═══════════════════════════════════════════════════════════════════════ */

const BORNÉS = ["viewer", "editor", "validator"];

/* Les unités attribuées à un bureau, telles qu'on les a déclarées. */
export function declaredFor(officeId){
  if(!officeId) return [];
  const v = currentVersion(); if(!v) return [];
  return db.prepare(`
    SELECT os.geo_pcode, gu.path, gu.name, gu.level
    FROM office_scope os
    JOIN geo_unit gu ON gu.pcode = os.geo_pcode AND gu.version_id = ?
    WHERE os.office_id = ?
    ORDER BY gu.path`).all(v.id, officeId);
}

/* Repli tant qu'aucun périmètre n'est déclaré : on le déduit des données
   existantes, comme avant. Sans ce repli, activer la migration 007 priverait
   d'un coup tous les comptes de terrain de leur accès. */
function inferred(officeId){
  const v = currentVersion(); if(!v) return [];
  return db.prepare(`
    SELECT DISTINCT gu.pcode geo_pcode, gu.path, gu.name, gu.level
    FROM geo_unit gu
    WHERE gu.version_id = ? AND gu.pcode IN (
      SELECT geo_pcode FROM sites WHERE office_id = ? AND geo_pcode IS NOT NULL
      UNION SELECT geo_pcode FROM pdd WHERE office_id = ? AND geo_pcode IS NOT NULL)
    ORDER BY gu.path`).all(v.id, officeId, officeId);
}

/* Le périmètre d'un utilisateur.

   `paths` est vide et `unbounded` vaut true pour qui n'est pas borné : c'est la
   forme qu'attendent les appelants pour dire « aucun filtre ». */
export function scopeOf(user){
  const borné = BORNÉS.includes(user?.role) && user?.office_id;
  if(!borné) return { unbounded:true, paths:[], units:[], source:"aucun" };

  const declared = declaredFor(user.office_id);
  const units = declared.length ? declared : inferred(user.office_id);
  return {
    unbounded: false,
    paths: units.map(u => u.path),
    units,
    /* L'appelant peut ainsi signaler qu'un bureau fonctionne encore sur déduction. */
    source: declared.length ? "déclaré" : (units.length ? "déduit" : "vide"),
  };
}

/* Un chemin est-il dans le périmètre ?

   La comparaison va dans les deux sens, volontairement. Si le bureau se voit
   attribuer un district, il couvre ses communes (descendantes) ; mais une vue
   par région doit aussi montrer la région qui contient ce district, sinon
   l'utilisateur ne verrait rien au-dessus de son propre niveau. */
export const covers = (scope, path) =>
  scope.unbounded ||
  scope.paths.some(p => path === p || path.startsWith(p + "/") || p.startsWith(path + "/"));

/* Les unités STRICTEMENT dans le périmètre, à un niveau donné : pour l'écriture,
   où l'on ne veut pas des ancêtres mais seulement ce qui est réellement couvert. */
export function unitsIn(scope, level){
  const v = currentVersion(); if(!v) return [];
  const all = db.prepare(
    `SELECT pcode, path, name FROM geo_unit WHERE version_id=? AND level=? ORDER BY path`)
    .all(v.id, level);
  if(scope.unbounded) return all;
  return all.filter(u => scope.paths.some(p => u.path === p || u.path.startsWith(p + "/")));
}

/* Fragment SQL réutilisable, pour filtrer en base plutôt qu'en mémoire. */
export function pathClause(scope, alias = "u"){
  if(scope.unbounded) return { sql:"", args:[] };
  if(!scope.paths.length) return { sql:" AND 1=0", args:[] };   /* périmètre vide : rien */
  const parts = scope.paths.map(() => `(${alias}.path = ? OR ${alias}.path LIKE ?)`);
  const args = scope.paths.flatMap(p => [p, p + "/%"]);
  return { sql:` AND (${parts.join(" OR ")})`, args };
}

/* Sites et lignes de plan rattachés à des unités hors du périmètre déclaré.
   Ce n'est pas une erreur — les données peuvent précéder la déclaration — mais
   c'est une incohérence à montrer plutôt qu'à taire. */
export function outsideDeclared(officeId){
  const declared = declaredFor(officeId);
  if(!declared.length) return { sites:0, pdd:0, declared:false };
  const v = currentVersion();
  const dedans = new Set(db.prepare(
    `SELECT pcode, path FROM geo_unit WHERE version_id=?`).all(v.id)
    .filter(u => declared.some(d => u.path === d.path || u.path.startsWith(d.path + "/")))
    .map(u => u.pcode));
  const compte = (table) => db.prepare(
    `SELECT geo_pcode FROM ${table} WHERE office_id=? AND geo_pcode IS NOT NULL`)
    .all(officeId).filter(r => !dedans.has(r.geo_pcode)).length;
  return { sites: compte("sites"), pdd: compte("pdd"), declared:true };
}
