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

   Troisième cas, ajouté ensuite : le bureau pays. Ses staffs sont rattachés à un
   bureau — donc bornés par la règle ci-dessus — mais leur travail porte sur
   l'ensemble des sites. Les passer administrateurs aurait résolu la visibilité en
   leur donnant au passage la gestion des comptes : la mauvaise réponse, puisque
   c'est l'autre axe. Le bureau porte donc un `scope_mode` ; s'il vaut 'national',
   les comptes qui en dépendent ne sont pas bornés, sans que leur rôle change.
   ═══════════════════════════════════════════════════════════════════════ */

const BORNÉS = ["viewer", "editor", "validator"];

/* Un bureau dont le périmètre est le pays entier. Toute valeur inattendue de
   `scope_mode` retombe sur le périmètre déclaré, c'est-à-dire le plus restreint :
   une donnée abîmée ne doit jamais élargir un accès. */
export async function isNational(officeId){
  if(!officeId) return false;
  const o = await db.prepare("SELECT scope_mode FROM offices WHERE id=?").get(officeId);
  return o?.scope_mode === "national";
}

/* Le bureau auquel un compte est cloisonné, ou null s'il voit tout.
   Les routes qui filtrent par `office_id` — et non par géographie — passent par
   ici, pour que la règle du bureau national vaille aussi pour elles. */
export async function officeBound(user){
  const borné = BORNÉS.includes(user?.role) && user?.office_id;
  if(!borné) return null;
  return (await isNational(user.office_id)) ? null : user.office_id;
}

/* Le prestataire auquel un compte appartient, ou null.

   Troisième forme de cloisonnement, après le rôle et le bureau. Un compte rattaché
   à un TPM ne voit que les plans de son propre TPM, quel que soit son rôle et quel
   que soit le mode de périmètre de son bureau : c'est un intervenant externe, pas
   un membre du bureau. La restriction s'applique donc AVANT celle du bureau, et
   même à un administrateur — un administrateur rattaché à un prestataire serait
   une erreur de saisie, et la lecture la plus prudente est de le borner. */
export function tpmBound(user){
  return user?.tpm_id || null;
}

/* Les unités attribuées à un bureau, telles qu'on les a déclarées. */
export async function declaredFor(officeId){
  if(!officeId) return [];
  const v = await currentVersion(); if(!v) return [];
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
async function inferred(officeId){
  const v = await currentVersion(); if(!v) return [];
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
export async function scopeOf(user){
  const borné = BORNÉS.includes(user?.role) && user?.office_id;
  if(!borné) return { unbounded:true, paths:[], units:[], source:"aucun" };
  if(await isNational(user.office_id))
    return { unbounded:true, paths:[], units:[], source:"national" };

  const declared = await declaredFor(user.office_id);
  const units = declared.length ? declared : await inferred(user.office_id);
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
export async function unitsIn(scope, level){
  const v = await currentVersion(); if(!v) return [];
  const all = await db.prepare(
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
export async function outsideDeclared(officeId){
  const declared = await declaredFor(officeId);
  if(!declared.length) return { sites:0, pdd:0, declared:false };
  const v = await currentVersion();
  const toutes = await db.prepare(`SELECT pcode, path FROM geo_unit WHERE version_id=?`).all(v.id);
  const dedans = new Set(toutes
    .filter(u => declared.some(d => u.path === d.path || u.path.startsWith(d.path + "/")))
    .map(u => u.pcode));
  const compte = async (table) => {
    const rows = await db.prepare(
      `SELECT geo_pcode FROM ${table} WHERE office_id=? AND geo_pcode IS NOT NULL`).all(officeId);
    return rows.filter(r => !dedans.has(r.geo_pcode)).length;
  };
  return { sites: await compte("sites"), pdd: await compte("pdd"), declared:true };
}
