/* Export du répertoire des localités.

   Deux défauts fermés ici. Le premier, le seul qui perde des données : l'export
   ne sortait que la PAGE affichée (plafonnée à 200 lignes), donc 200 fokontany
   sur ~18 000 sans le moindre avertissement. `collecterLocalites` récupère la
   TOTALITÉ du jeu filtré en paginant le point d'API (qui plafonne chaque appel).
   Le second : Excel mange les zéros non significatifs d'un p-code qu'il croit
   numérique — `csvLocalites` force donc les p-codes en TEXTE.

   Ce module ne dépend de rien à dessein : il se teste tel quel, et sa logique de
   pagination reçoit son lecteur en argument plutôt que d'appeler `api` en direct. */

const COLS_LOC = ["adm1", "adm2", "adm3", "adm4", "pcode", "lat", "lon"];

/* Séparateur virgule, guillemets doublés, retours de ligne et point-virgule
   protégés — mêmes règles que toCSV (components/ui.jsx), gardées identiques pour
   qu'un même fichier se relise des deux côtés. */
const echapper = (v) => {
  v = v === undefined || v === null ? "" : String(v);
  return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

/* La formule ="…" dit à Excel « ceci est du texte » sans altérer la valeur : un
   p-code « 0102030004 » garde ses zéros de tête au lieu de devenir 102030004. Un
   lecteur de CSV qui ignore la convention Excel lit la formule telle quelle —
   c'est le prix, assumé, de p-codes intacts dans l'outil qui les ouvre le plus. */
const pcodeTexte = (v) => {
  v = v === undefined || v === null ? "" : String(v);
  return v === "" ? "" : '="' + v.replace(/"/g, '""') + '"';
};

/* En-tête UTF-8 (﻿) : sans lui, Excel lit les accents en Latin-1 et casse
   « région » en « rÃ©gion ». */
function csvLocalites(rows) {
  const corps = (rows || []).map((r) =>
    COLS_LOC.map((c) => (c === "pcode" ? echapper(pcodeTexte(r[c])) : echapper(r[c]))).join(","));
  return "﻿" + [COLS_LOC.join(","), ...corps].join("\n");
}

/* Récupère tout le jeu filtré, pas la page. `lecteur(offset, limit)` rend
   `{ rows, total }` — la signature du point d'API géo. On pagine jusqu'au total
   annoncé, par tranches bornées au plafond du serveur. `plafond` est une sécurité
   DURE : atteinte, on ne tronque pas en silence — on rend `tronque:true` et
   l'appelant le DIT à l'écran. */
async function collecterLocalites(lecteur, { chunk = 1000, plafond = 100000 } = {}) {
  const premier = await lecteur(0, chunk);
  const total = premier.total ?? premier.rows.length;
  let rows = premier.rows.slice();
  for (let off = chunk; off < total && rows.length < plafond; off += chunk) {
    const suite = await lecteur(off, chunk);
    if (!suite.rows || !suite.rows.length) break;   /* le serveur n'a plus rien à rendre */
    rows = rows.concat(suite.rows);
  }
  if (rows.length > plafond) rows = rows.slice(0, plafond);
  return { rows, total, tronque: rows.length < total };
}

export { COLS_LOC, collecterLocalites, csvLocalites };
