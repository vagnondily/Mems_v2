/* ═══════════════════════════════════════════════════════════════════════
   Le vocabulaire du découpage administratif.

   « Régions / Districts / Communes / Fokontany » est le vocabulaire de
   Madagascar. Il figurait en dur dans huit endroits de deux fichiers, alors que
   cette première version sert Madagascar et que d'autres pays suivront : la RDC a
   des Provinces, Territoires, Secteurs et Groupements ; l'Éthiopie des Regions,
   Zones, Woredas et Kebeles. Le schéma, lui, n'a jamais connu que `adm0` à
   `adm4` — c'était la seule couche neutre.

   Les libellés viennent maintenant de la configuration du pays, servie avec
   l'état initial. Une seule fonction les rend, et c'est la seule porte d'entrée :
   un neuvième endroit qui les réécrirait finirait par diverger des huit autres.
   ═══════════════════════════════════════════════════════════════════════ */

/* Repli quand la configuration manque — base neuve, ou état pas encore chargé.
   On rend le code du niveau plutôt qu'un vocabulaire inventé : un écran qui
   affiche « adm3 » signale qu'il manque une configuration ; un écran qui affiche
   « Commune » sur un pays qui n'en a pas ment. */
const brut = (level) => ({ one:level, many:level });

/* Les cinq codes du schéma, dans l'ordre. Volontairement redéclarés ici et non
   importés de calc.js : `LEVELS` y désigne les niveaux de PRIORITÉ de suivi
   (faible, moyenne, haute), et réutiliser le nom aurait produit une confusion
   silencieuse entre deux notions qui n'ont rien à voir. */
export const ADM = ["adm0", "adm1", "adm2", "adm3", "adm4"];

export function niveau(db, level, plural = false){
  const l = db?.country?.levels?.[level] || brut(level);
  return plural ? (l.many || l.one) : l.one;
}

/* Les niveaux sous forme de paires [code, libellé], pour les listes déroulantes
   et les en-têtes de colonnes. `from` et `to` bornent la plage : la cartographie
   ne propose pas le pays, la saisie de site ne propose pas l'inverse. */
export function niveaux(db, { from = "adm1", to = "adm4", plural = true } = {}){
  const a = ADM.indexOf(from), b = ADM.indexOf(to);
  return ADM.slice(a < 0 ? 0 : a, (b < 0 ? ADM.length : b) + 1)
    .map(l => [l, niveau(db, l, plural)]);
}

/* Le nom du pays, pour les titres et les exports. */
export const paysNom = (db) => db?.country?.name || "";
