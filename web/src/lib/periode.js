/* ══════════════════ Période d'analyse ══════════════════

   Une période, c'est une année et un découpage de cette année : l'année
   entière, un trimestre ou un mois. Les écrans Rapports et Analyses la
   partagent. La poser ici plutôt que dans chacun d'eux évite que « T2 » ne
   veuille pas dire la même chose des deux côtés, et surtout que le libellé
   imprimé sur un export diverge de celui affiché à l'écran — un rapport qui
   annonce une période et en agrège une autre est pire que pas de filtre.

   Ce module ne dépend de rien, à dessein : les noms de mois vivent dans
   constants.js, mais constants.js importe un composant React (Planning). Un
   modèle de période n'a aucune raison de traîner un graphe de vues derrière
   lui, ni dans le paquet envoyé au navigateur ni dans un test unitaire. Douze
   libellés recopiés coûtent moins cher que ce couplage.

   Les mois sont exposés de 1 à 12 — la numérotation qu'écrit et que lit un
   utilisateur. Le magasin, lui, les indexe de 0 à 11 (`site.plan[i]`,
   `outputs.month`, `Date#getMonth`) : la conversion se fait au point d'appel,
   une fois, plutôt que d'entretenir deux conventions dans ce fichier. */

const GRANULARITES = [
  ["annee", "Année entière"],
  ["trimestre", "Trimestre"],
  ["mois", "Mois"],
];
const GRANS = GRANULARITES.map(g => g[0]);

const MOIS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin",
                    "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const TOUS_LES_MOIS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pad2 = (v) => String(v).padStart(2, "0");

/* Les trois mois d'un trimestre, en 1-12. */
const moisDuTrimestre = (t) => { const d = (t - 1) * 3 + 1; return [d, d + 1, d + 2]; };

/* Une période toujours exploitable, quoi qu'on lui passe : les sélecteurs de
   l'interface renvoient des chaînes, les états sauvegardés peuvent dater d'une
   version antérieure, et un `valeur` hors bornes ferait silencieusement sortir
   un trimestre vide plutôt qu'une erreur visible. */
function normalisePeriode(periode, anneeDefaut){
  const annee = Number(periode?.annee) || Number(anneeDefaut) || new Date().getFullYear();
  const gran = GRANS.includes(periode?.gran) ? periode.gran : "annee";
  const max = gran === "trimestre" ? 4 : gran === "mois" ? 12 : 0;
  const brut = Number(periode?.valeur);
  const valeur = gran === "annee" ? 0
    : Math.min(max, Math.max(1, Number.isFinite(brut) ? Math.trunc(brut) : 1));
  return { annee, gran, valeur };
}

const periodeAnnee = (annee) => normalisePeriode({ annee, gran: "annee" });

/* Le découpage proposé pour la granularité choisie. L'écran n'a ainsi aucune
   liste de trimestres ou de mois à écrire lui-même. */
function optionsValeur(gran){
  if(gran === "trimestre") return [1, 2, 3, 4].map(t => {
    const [d, , f] = moisDuTrimestre(t);
    return [t, `T${t} — ${MOIS_LONGS[d - 1]} à ${MOIS_LONGS[f - 1]}`]; });
  if(gran === "mois") return MOIS_LONGS.map((m, i) => [i + 1, cap(m)]);
  return [];
}

/* Passer d'une granularité à l'autre sur l'exercice en cours doit tomber sur le
   trimestre ou le mois où l'on se trouve : c'est la période qu'on veut voir
   neuf fois sur dix, et janvier par défaut obligerait à un second réglage. */
function valeurDefaut(gran, annee, maintenant = new Date()){
  if(gran === "annee") return 0;
  if(Number(annee) !== maintenant.getFullYear()) return 1;
  const m = maintenant.getMonth() + 1;
  return gran === "trimestre" ? Math.ceil(m / 3) : m;
}

function moisDeLaPeriode(periode){
  const p = normalisePeriode(periode);
  if(p.gran === "mois") return [p.valeur];
  if(p.gran === "trimestre") return moisDuTrimestre(p.valeur);
  return [...TOUS_LES_MOIS];
}

/* Le mois est donné de 1 à 12. L'année de la période n'entre pas ici : c'est
   volontaire, les séries mensuelles du magasin (grille de suivi, outputs) sont
   déjà celles d'un exercice donné, et leur index n'en porte pas l'année. */
function moisDansPeriode(mois, periode){
  const m = Number(mois);
  if(!Number.isInteger(m) || m < 1 || m > 12) return false;
  const p = normalisePeriode(periode);
  if(p.gran === "mois") return m === p.valeur;
  if(p.gran === "trimestre") return Math.ceil(m / 3) === p.valeur;
  return true;
}

/* Les dates du magasin sont des chaînes ISO (« 2026-04-01 »). Les lire par
   `new Date()` puis `getMonth()` les décale d'un jour — donc parfois d'un mois,
   donc de trimestre — dès que le poste n'est pas à l'heure UTC : la chaîne est
   comprise comme minuit UTC et relue en heure locale. On lit donc le texte
   quand il en a la forme, et on ne retombe sur `Date` que pour le reste. */
const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?/;
function anneeMoisDe(valeur){
  if(valeur === null || valeur === undefined || valeur === "") return null;
  if(valeur instanceof Date)
    return Number.isNaN(valeur.getTime()) ? null
      : { annee: valeur.getFullYear(), mois: valeur.getMonth() + 1 };
  const m = ISO.exec(String(valeur).trim());
  if(m){ const mois = Number(m[2]);
    return mois >= 1 && mois <= 12 ? { annee: Number(m[1]), mois } : null; }
  const d = new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : { annee: d.getFullYear(), mois: d.getMonth() + 1 };
}

/* Pour les collections datées — visites, mesures de résultat — où l'année n'est
   pas celle de l'exercice chargé mais celle que porte la ligne. */
function dateDansPeriode(valeur, periode){
  const am = anneeMoisDe(valeur);
  if(!am) return false;
  const p = normalisePeriode(periode);
  return am.annee === p.annee && moisDansPeriode(am.mois, p);
}

/* Les bornes calendaires, pour les écrans qui filtrent par date et non par mois
   (l'extraction ODK). Le dernier jour se déduit du calendrier plutôt que d'une
   table 30/31 : février bissextile s'y règle tout seul. */
function bornesPeriode(periode){
  const p = normalisePeriode(periode);
  const mois = moisDeLaPeriode(p);
  const premier = mois[0], dernier = mois[mois.length - 1];
  const finDuMois = new Date(Date.UTC(p.annee, dernier, 0)).getUTCDate();
  return { du: `${p.annee}-${pad2(premier)}-01`, au: `${p.annee}-${pad2(dernier)}-${pad2(finDuMois)}` };
}

function libellePeriode(periode){
  const p = normalisePeriode(periode);
  if(p.gran === "mois") return `${cap(MOIS_LONGS[p.valeur - 1])} ${p.annee}`;
  if(p.gran === "trimestre"){
    const [d, , f] = moisDuTrimestre(p.valeur);
    return `T${p.valeur} ${p.annee} (${MOIS_LONGS[d - 1]} à ${MOIS_LONGS[f - 1]})`;
  }
  return `Année ${p.annee}`;
}

/* La même chose en assez court pour un sous-titre de carte ou une pastille. */
function libelleCourtPeriode(periode){
  const p = normalisePeriode(periode);
  if(p.gran === "mois") return `${cap(MOIS_LONGS[p.valeur - 1])} ${p.annee}`;
  if(p.gran === "trimestre") return `T${p.valeur} ${p.annee}`;
  return String(p.annee);
}

/* Ce qu'on colle à un nom de fichier : trié naturellement, sans accent ni
   espace, pour que douze exports mensuels s'ordonnent tout seuls dans un
   dossier. */
function suffixePeriode(periode){
  const p = normalisePeriode(periode);
  if(p.gran === "mois") return `${p.annee}-${pad2(p.valeur)}`;
  if(p.gran === "trimestre") return `${p.annee}-T${p.valeur}`;
  return String(p.annee);
}

/* Combien de mois de la période sont déjà entamés. Sert à proratiser une
   exigence annuelle sur la période : sans cela, un trimestre à venir
   afficherait une exigence que personne n'avait encore à honorer, et le taux de
   réalisation s'effondrerait sans qu'aucun retard n'existe. */
function moisEcoules(periode, maintenant = new Date()){
  const p = normalisePeriode(periode);
  const mois = moisDeLaPeriode(p);
  const anneeCourante = maintenant.getFullYear();
  if(p.annee < anneeCourante) return mois.length;
  if(p.annee > anneeCourante) return 0;
  const m = maintenant.getMonth() + 1;
  return mois.filter(x => x <= m).length;
}

/* Les années sur lesquelles il y a réellement quelque chose à lire.
   Proposer 2019-2030 en dur remplirait le sélecteur d'exercices vides et ferait
   croire à une perte de données à chaque essai. L'exercice chargé y figure
   toujours : c'est celui sur lequel le serveur a bâti la grille mensuelle, même
   si aucune visite n'y a encore été saisie. */
function anneesDisponibles(db){
  const vues = new Set();
  const ajoute = (v) => { const a = Number(v);
    if(Number.isInteger(a) && a >= 2000 && a <= 2100) vues.add(a); };
  const parDate = (d) => { const am = anneeMoisDe(d); if(am) ajoute(am.annee); };
  ajoute(db?.year);
  (db?.visits || []).forEach(v => parDate(v.date));
  (db?.outcomes || []).forEach(o => parDate(o.date));
  (db?.pdd || []).forEach(p => ajoute(p.year));
  (db?.outputs || []).forEach(o => ajoute(o.year));
  return [...vues].sort((a, b) => b - a);
}

export { GRANULARITES, MOIS_LONGS, anneeMoisDe, anneesDisponibles, bornesPeriode,
  dateDansPeriode, libelleCourtPeriode, libellePeriode, moisDansPeriode, moisDeLaPeriode,
  moisEcoules, normalisePeriode, optionsValeur, periodeAnnee, suffixePeriode, valeurDefaut };
