import { db } from "../db.js";
import { currentVersion } from "./geo.js";
import { ctx } from "./ctx.js";

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
export function isNational(officeId){
  if(!officeId) return false;
  const o = db.prepare("SELECT scope_mode FROM offices WHERE id=?").get(officeId);
  return o?.scope_mode === "national";
}

/* Le bureau auquel un compte est cloisonné, ou null s'il voit tout.
   Les routes qui filtrent par `office_id` — et non par géographie — passent par
   ici, pour que la règle du bureau national vaille aussi pour elles. */
export function officeBound(user){
  const borné = BORNÉS.includes(user?.role) && user?.office_id;
  if(!borné) return null;
  return isNational(user.office_id) ? null : user.office_id;
}

/* Le pays auquel un compte est cloisonné, ou null s'il n'est borné à aucun.

   C'est la couche la plus haute du cloisonnement, au-dessus du bureau : une
   instance sert plusieurs pays, et un compte de Madagascar n'a rien à voir dans
   les données du Congo. Elle ne dépend PAS du rôle — contrairement au bureau, qui
   ne borne que les rôles opérationnels : un administrateur de bureau pays
   administre son pays, pas l'instance entière. Seul un compte volontairement créé
   sans pays — un bureau régional, l'administrateur de l'instance — traverse les
   frontières.

           pays  →  bureau  →  périmètre géographique
           ↑ ici    ↑ officeBound   ↑ scopeOf                                     */
export function countryBound(user){
  if(user?.country_code) return user.country_code;
  /* Un compte non borné qui a choisi un pays y travaille comme les autres : il ne
     voit plus les trois pays mais celui-là. Sans choix, il n'y a pas de filtre —
     c'est la vue d'ensemble, et c'est ce qui permet de configurer le pays suivant.

     Le contexte n'est lu que pour l'utilisateur de la requête. `countryBound` est
     aussi appelé avec un AUTRE compte — l'écran des comptes montre le périmètre de
     chacun — et rendre là le filtre du demandeur ferait mentir cette colonne. */
  const c = ctx();
  if(user && c.user && user.id === c.user.id) return c.countryFilter || null;
  return null;
}

/* Filtre de pays en SQL, pour une table qui porte `country_code`.

   Les lignes sans pays sont VOLONTAIREMENT incluses. Trois raisons, dans l'ordre :
   elles datent d'avant le rattachement et les cacher ferait disparaître des données
   d'un écran sans un mot ; un prestataire ou un bureau peut être régional, donc
   sans pays unique ; et une suppression silencieuse est le pire signal possible pour
   une donnée mal rattachée — mieux vaut la voir et la corriger. */
export function countryClause(user, alias = "t", column = "country_code"){
  const pays = countryBound(user);
  if(!pays) return { sql:"", args:[] };
  return { sql:` AND (${alias}.${column} = ? OR ${alias}.${column} IS NULL)`, args:[pays] };
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

/* Filtre par bureau ET par pays, pour une table qui porte `office_id` : sites,
   visites, paramètres de couverture, plan de distribution.

   Ces tables ne portent pas de pays — décision de la migration 015, pour qu'il ne
   puisse pas diverger de celui de leur bureau. Le pays s'y lit donc à travers le
   bureau, ce que fait la sous-requête. Un compte borné à un bureau n'a pas besoin du
   pays : son bureau est déjà dans un seul pays. */
export function officeClause(user, alias = "t"){
  const bureau = officeBound(user);
  if(bureau) return { sql:` AND ${alias}.office_id = ?`, args:[bureau] };
  const pays = countryBound(user);
  if(!pays) return { sql:"", args:[] };
  return {
    sql:` AND (${alias}.office_id IS NULL OR ${alias}.office_id IN
              (SELECT id FROM offices WHERE country_code = ? OR country_code IS NULL))`,
    args:[pays],
  };
}

/* Le bureau désigné est-il dans le périmètre de l'appelant ?

   Le filtre en lecture ne suffit pas : les écritures reçoivent un `office_id` venu du
   formulaire, et sans cette vérification un compte de Madagascar créerait un site
   dans un bureau du Congo en changeant un champ. Rend le niveau du refus, pour que
   l'appelant réponde 403 (« un autre bureau », qui existe et se nomme) ou 404 (« un
   autre pays », dont on ne confirme même pas l'existence). */
export function officeReach(user, officeId){
  const bureau = officeBound(user);
  if(bureau && officeId !== bureau) return "bureau";
  const pays = countryBound(user);
  if(!pays || !officeId) return null;
  const o = db.prepare("SELECT country_code FROM offices WHERE id=?").get(officeId);
  return (o && o.country_code && o.country_code !== pays) ? "pays" : null;
}

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
  if(isNational(user.office_id))
    return { unbounded:true, paths:[], units:[], source:"national" };

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
