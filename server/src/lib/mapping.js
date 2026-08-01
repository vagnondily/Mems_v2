/* ═══════════════════════════════════════════════════════════════════════
   Application d'une correspondance de variables — le code écrit une fois.

   lib/champs.js déclare CE QU'ON PEUT alimenter dans MEMS. Ce fichier fait le
   reste : lire une valeur dans un enregistrement source, la convertir, dire ce
   qui manque. Il ne connaît ni ODK, ni Foundry, ni le format d'un classeur —
   et c'est tout l'intérêt : `appliquer()` est le seul chemin par lequel une
   donnée externe devient une donnée MEMS, quelle que soit sa provenance.
   Brancher une source de plus, c'est écrire des lignes en base, pas du code.

   ── Pourquoi un jeu FERMÉ de transformations ──────────────────────────
   La tentation est d'accepter une expression (« une petite formule, juste pour
   ce cas-là »). Ce serait ouvrir l'exécution de code fourni par un utilisateur
   sur le serveur, et rendre chaque branchement illisible pour qui le reprend.
   Les douze transformations ci-dessous couvrent ce que les quatre XLSForms du
   bureau Madagascar et un dataset de chiffres demandent réellement. Il en
   manquera : la bonne réponse sera d'en ajouter une ici, nommée, documentée et
   testée, pas d'ouvrir une porte.

   ── Ce que ces transformations ne font PAS ────────────────────────────
   Elles ne devinent pas. Une valeur illisible devient `null` — jamais 0, jamais
   une date d'aujourd'hui, jamais une chaîne vide qui passerait pour une saisie.
   Un champ obligatoire resté vide est signalé, pas comblé. C'est ce qui permet
   à l'aperçu de dire « cette ligne ne passera pas » avant tout import.
   ═══════════════════════════════════════════════════════════════════════ */

const vide = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/* Un nombre écrit par un humain, ou par un tableur, ou par une API.
   « 1 234,56 » (français), « 1,234.56 » (anglais), « 1234.56 » et l'espace
   insécable des exports Excel arrivent tous ici. La règle est explicite plutôt
   que devinée : s'il y a un point ET une virgule, le dernier des deux est le
   séparateur décimal ; s'il n'y a qu'une virgule, elle est décimale. */
function versNombre(v){
  if(vide(v)) return null;
  if(typeof v === "number") return Number.isFinite(v) ? v : null;
  if(typeof v === "boolean") return v ? 1 : 0;
  let s = String(v).replace(/[\s  ]/g, "").replace(/[^\d.,+-eE]/g, "");
  const dernierPoint = s.lastIndexOf("."), derniereVirgule = s.lastIndexOf(",");
  if(dernierPoint >= 0 && derniereVirgule >= 0){
    s = derniereVirgule > dernierPoint
      ? s.replace(/\./g, "").replace(",", ".")     /* 1.234,56 */
      : s.replace(/,/g, "");                       /* 1,234.56 */
  } else if(derniereVirgule >= 0){
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/* Une date au format que MEMS stocke partout : AAAA-MM-JJ.

   Le format « jour/mois/année » est lu comme tel, et non « mois/jour/année ».
   C'est une convention, pas une déduction : 03/04/2026 est ambigu et aucune
   heuristique ne le lèvera. Le bureau Madagascar écrit en français, ses
   XLSForms rendent des dates ISO ; le cas jj/mm/aaaa existe surtout dans les
   exports de tableur, où la convention locale s'applique. Toute autre forme
   devient null plutôt qu'une date fausse. */
function versDateIso(v){
  if(vide(v)) return null;
  if(v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if(iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if(fr){
    const [, j, m, a] = fr;
    if(+m >= 1 && +m <= 12 && +j >= 1 && +j <= 31)
      return `${a}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
    return null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* Un geopoint ODK est une chaîne de quatre nombres séparés par des espaces :
   « latitude longitude altitude précision ». Certaines API rendent plutôt un
   objet, ou un point GeoJSON — dont les coordonnées sont dans l'ordre INVERSE
   (longitude d'abord). Les trois formes sont acceptées ; toute autre rend null.

   Les bornes sont vérifiées : un geopoint mal découpé donne des valeurs
   aberrantes qui, non filtrées, déplacent un site à l'autre bout du monde. */
function versGeopoint(v){
  if(vide(v)) return null;
  if(typeof v === "object" && !Array.isArray(v)){
    if(Array.isArray(v.coordinates) && v.coordinates.length >= 2)
      return borner(Number(v.coordinates[1]), Number(v.coordinates[0]),
        v.coordinates[2], v.accuracy ?? v.precision);
    if(v.latitude !== undefined || v.longitude !== undefined)
      return borner(Number(v.latitude), Number(v.longitude),
        v.altitude, v.accuracy ?? v.precision);
    return null;
  }
  const parts = String(v).trim().split(/[\s,;]+/).filter(x => x !== "");
  if(parts.length < 2) return null;
  const lat = Number(parts[0]), lon = Number(parts[1]);
  return borner(lat, lon, parts[2], parts[3]);
}
/* Les deux composantes de queue sont facultatives : un geopoint saisi à la main
   ou recopié d'un tableur n'en porte souvent aucune. Elles rendent `null` plutôt
   que 0 — une précision de zéro mètre se lirait comme un relevé parfait, ce qui
   est l'inverse de « précision inconnue ». Une précision négative est refusée
   pour la même raison : elle n'a aucun sens physique. */
function borner(lat, lon, altitude, precision){
  if(!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if(lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const nb = (x) => {
    if(x === null || x === undefined || (typeof x === "string" && x.trim() === "")) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };
  const p = nb(precision);
  return { lat, lon, altitude: nb(altitude), precision: p !== null && p >= 0 ? p : null };
}

/* Le geopoint découpé en entier, pour les appelants qui en veulent les quatre
   composantes d'un coup — l'ingestion des soumissions, qui écrit lat, lon et
   précision sur la même ligne. Trois appels aux transformations feraient trois
   analyses de la même chaîne, et surtout laisseraient croire que les trois
   valeurs peuvent venir de trois sources différentes. */
export const decouperGeopoint = versGeopoint;

const VRAI = new Set(["1", "true", "vrai", "oui", "o", "yes", "y", "x", "on"]);
const FAUX = new Set(["0", "false", "faux", "non", "n", "no", "off"]);

/* ── Le jeu fermé ────────────────────────────────────────────────────── */
export const TRANSFORMATIONS = {
  brut: {
    label: "Aucune (valeur brute)",
    note: "La valeur passe telle quelle. À réserver aux champs déjà au bon format : "
      + "aucune vérification n'est faite.",
    fn: (v) => (v === undefined ? null : v),
  },
  texte: {
    label: "Texte",
    note: "Convertit en texte et retire les espaces de bord. Une chaîne vide devient nulle, "
      + "pour qu'un champ obligatoire rempli d'espaces soit vu comme manquant.",
    fn: (v) => (vide(v) ? null : String(v).trim()),
  },
  nombre: {
    label: "Nombre",
    note: "Accepte « 1 234,56 », « 1,234.56 » et « 1234.56 ». Une valeur illisible devient "
      + "nulle, jamais zéro : zéro est une information, l'absence en est une autre.",
    fn: versNombre,
  },
  entier: {
    label: "Entier",
    note: "Comme « Nombre », puis arrondi au plus proche. Arrondir plutôt que tronquer : "
      + "sur des effectifs, 3,7 personnes déclarées vaut 4, pas 3.",
    fn: (v) => { const n = versNombre(v); return n === null ? null : Math.round(n); },
  },
  booleen: {
    label: "Oui / Non",
    note: "Rend 1 ou 0. Reconnaît 1/0, true/false, oui/non, yes/no, o/n, x. "
      + "Toute autre valeur devient nulle plutôt que « non ».",
    fn: (v) => {
      if(vide(v)) return null;
      if(typeof v === "boolean") return v ? 1 : 0;
      if(typeof v === "number") return v ? 1 : 0;
      const s = String(v).trim().toLowerCase();
      if(VRAI.has(s)) return 1;
      if(FAUX.has(s)) return 0;
      return null;
    },
  },
  date_iso: {
    label: "Date (AAAA-MM-JJ)",
    note: "Normalise une date en AAAA-MM-JJ. Les formes ISO et jj/mm/aaaa sont lues ; "
      + "jj/mm/aaaa est une convention assumée, pas une déduction.",
    fn: versDateIso,
  },
  majuscules: {
    label: "Majuscules",
    note: "Texte, converti en majuscules. Utile pour aligner des codes saisis à la main.",
    fn: (v) => (vide(v) ? null : String(v).trim().toUpperCase()),
  },
  minuscules: {
    label: "Minuscules",
    note: "Texte, converti en minuscules.",
    fn: (v) => (vide(v) ? null : String(v).trim().toLowerCase()),
  },
  trim: {
    label: "Espaces retirés",
    note: "Retire les espaces de bord et réduit les suites d'espaces internes à un seul. "
      + "Un nom recopié depuis un tableur en porte souvent deux.",
    fn: (v) => (vide(v) ? null : String(v).replace(/[\s ]+/g, " ").trim()),
  },
  pcode: {
    label: "P-code normalisé",
    note: "Majuscules, et tout ce qui n'est ni lettre ni chiffre est retiré : « mg 232 09050001 » "
      + "et « MG23209050001 » deviennent le même code. Ne valide PAS l'existence du p-code — "
      + "le rattachement au référentiel reste une étape distincte, qui doit pouvoir échouer visiblement.",
    fn: (v) => {
      if(vide(v)) return null;
      const s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
      return s === "" ? null : s;
    },
  },
  geopoint_lat: {
    label: "Latitude d'un geopoint",
    note: "Extrait la latitude d'un geopoint ODK « lat lon altitude précision ». "
      + "Accepte aussi {latitude, longitude} et un point GeoJSON. Hors bornes, rend null.",
    fn: (v) => versGeopoint(v)?.lat ?? null,
  },
  geopoint_lon: {
    label: "Longitude d'un geopoint",
    note: "Extrait la longitude du même geopoint. Attention : en GeoJSON les coordonnées sont "
      + "dans l'ordre inverse (longitude d'abord) — c'est traité ici, pas chez l'appelant.",
    fn: (v) => versGeopoint(v)?.lon ?? null,
  },
  /* Ajoutée pour l'ingestion des soumissions : la précision est la quatrième
     composante du geopoint ODK, et c'est la seule des quatre qui permette
     d'écarter un relevé au lieu d'y croire. La règle du fichier a été suivie —
     une transformation de plus, nommée, documentée et testée, plutôt qu'un
     découpage improvisé chez l'appelant. */
  geopoint_precision: {
    label: "Précision d'un geopoint",
    note: "Extrait la précision en mètres, quatrième composante d'un geopoint ODK "
      + "« lat lon altitude précision ». Absente ou négative, elle rend null : « précision "
      + "inconnue » et « précision de zéro mètre » ne doivent pas se confondre.",
    fn: (v) => versGeopoint(v)?.precision ?? null,
  },
};

export const NOMS_TRANSFORMATIONS = Object.keys(TRANSFORMATIONS);

/* La forme servie à l'écran de réglage : la liste fermée, avec son explication.
   L'écran ne tient aucune copie de cette liste, pour la même raison que pour le
   registre des champs — deux listes finissent par diverger. */
export const transformationsPubliques = () =>
  NOMS_TRANSFORMATIONS.map(cle => ({ cle, label: TRANSFORMATIONS[cle].label, note: TRANSFORMATIONS[cle].note }));

/* ── Lecture d'une valeur dans l'enregistrement source ────────────────
   Le chemin est d'abord essayé TEL QUEL comme clé : le client ODK aplatit les
   groupes, et une source peut très bien porter une clé contenant un point
   (« Technical_module.DPName »). Ce n'est qu'à défaut qu'on le lit comme un
   chemin JSON, avec les notations pointée et indicée. */
export function lireChemin(source, chemin){
  if(!source || typeof source !== "object") return undefined;
  if(chemin === null || chemin === undefined || chemin === "") return undefined;
  const cle = String(chemin);
  if(Object.hasOwn(source, cle)) return source[cle];

  const segments = cle.replace(/\[(\d+)\]/g, ".$1").split(".").filter(s => s !== "");
  let courant = source;
  for(const s of segments){
    if(courant === null || courant === undefined) return undefined;
    if(typeof courant !== "object") return undefined;
    courant = Array.isArray(courant) ? courant[Number(s)] : courant[s];
  }
  return courant;
}

/* ── Le cœur ──────────────────────────────────────────────────────────
   `appliquer(mappings, enregistrementSource)` rend l'objet MEMS et la liste des
   champs obligatoires restés vides.

   Les correspondances sont celles de la table `connector_mapping` : mêmes noms
   de colonnes, pour qu'une ligne lue en base s'utilise sans traduction.

   `options.obligatoires` complète le drapeau `required` porté par chaque
   correspondance : le registre des champs sait ce qui est indispensable à
   l'entité (une soumission sans instance_id), la correspondance sait ce qui est
   indispensable à CE branchement. L'union des deux fait foi, et un champ
   obligatoire pour lequel aucune correspondance n'a été déclarée est signalé
   comme manquant lui aussi — c'est le cas le plus courant d'un mapping inachevé.

   Une transformation inconnue lève une erreur au lieu de retomber sur « brut » :
   c'est un défaut de configuration, pas une donnée douteuse, et le taire ferait
   passer des valeurs non converties pour des valeurs converties. */
export function appliquer(mappings, enregistrementSource, options = {}){
  const obligatoiresEntite = new Set(options.obligatoires || []);
  const valeurs = {};
  const manquants = [];
  const traites = new Set();

  const ordonnees = [...(mappings || [])].sort(
    (a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));

  for(const m of ordonnees){
    const champ = m?.mems_field;
    if(!champ) continue;
    const nomTransfo = m.transform || "brut";
    const transfo = TRANSFORMATIONS[nomTransfo];
    if(!transfo){
      const e = new Error(`transformation inconnue : « ${String(nomTransfo).slice(0, 40)} ». `
        + `Transformations disponibles : ${NOMS_TRANSFORMATIONS.join(", ")}.`);
      e.code = "MAPPING_TRANSFORM";
      throw e;
    }
    traites.add(champ);

    const brut = lireChemin(enregistrementSource, m.source_path);
    let valeur = transfo.fn(brut);

    /* La valeur de repli passe par la MÊME transformation que la valeur lue :
       sans cela, un défaut « 0 » entrerait en texte là où la source entre en
       nombre, et deux lignes du même import n'auraient pas le même type. */
    if(vide(valeur) && !vide(m.default_value)) valeur = transfo.fn(m.default_value);

    const requis = m.required === 1 || m.required === true || obligatoiresEntite.has(champ);
    if(vide(valeur)){
      if(requis) manquants.push({
        champ,
        source: m.source_path || null,
        motif: m.source_path
          ? (brut === undefined
              ? `la variable « ${m.source_path} » est absente de l'enregistrement source`
              : `la variable « ${m.source_path} » est vide ou illisible pour la transformation « ${nomTransfo} »`)
          : "aucune variable source n'est déclarée pour ce champ obligatoire",
      });
      /* On n'écrit pas la clé : un champ absent doit être absent, pas nul. Une
         clé posée à null écraserait une valeur existante lors d'une mise à jour. */
      continue;
    }
    valeurs[champ] = valeur;
  }

  /* Les obligatoires que personne n'a même essayé de brancher. */
  for(const champ of obligatoiresEntite){
    if(traites.has(champ)) continue;
    manquants.push({ champ, source: null,
      motif: "champ obligatoire de l'entité : aucune correspondance n'a été déclarée" });
  }

  return { valeurs, manquants };
}

/* Appliquer à un échantillon, en gardant l'avant et l'après côte à côte.
   C'est ce que sert l'aperçu : montrer ce qu'une correspondance produit sur de
   vraies lignes, avant tout import. */
export function appliquerLot(mappings, enregistrements, options = {}){
  return (enregistrements || []).map(src => {
    const { valeurs, manquants } = appliquer(mappings, src, options);
    return { avant: src, apres: valeurs, manquants };
  });
}
