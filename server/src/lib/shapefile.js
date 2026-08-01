/* JSZip arrive avec exceljs, déjà au manifeste : l'importer ici pour lire une
   archive .zip n'ajoute aucune dépendance — même choix que lib/import.js. */
import JSZip from "jszip";

/* ═══════════════════════════════════════════════════════════════════════
   Lecture d'un shapefile CÔTÉ SERVEUR, sans parseur tiers.

   Le navigateur lisait le fichier lui-même. C'est le même schéma que SheetJS
   pour les classeurs : un gros parseur embarqué dans le navigateur de chaque
   utilisateur pour une fenêtre de configuration que seuls les administrateurs
   ouvrent. MEMS a retiré `xlsx` du frontend pour cette raison, et fait lire les
   XLSForms par le serveur (POST /api/xlsform/parse) ; ce fichier applique le même
   principe au découpage administratif.

   Le format est public et simple, on le lit à la main :

     .shp  en-tête de 100 octets (code fichier et longueur en GROS-boutiste,
           type et emprise en PETIT-boutiste), puis des enregistrements de
           longueur déclarée — bbox, numParts, numPoints, parts[], points[] ;
     .dbf  en-tête de 32 octets + 32 par champ, puis une ligne par enregistrement
           préfixée d'un octet de suppression ;
     APPARIEMENT par ORDRE : l'enregistrement i du .shp décrit la ligne i du .dbf.
           C'est la garantie du format — il n'y a pas d'autre lien entre les deux.

   Le .shx (index des positions) n'est pas requis : les enregistrements .shp se
   parcourent par leur longueur déclarée, l'un après l'autre.
   ═══════════════════════════════════════════════════════════════════════ */

export const TYPE_POLYGONE = 5;

/* Le nombre d'enregistrements accepté est borné indépendamment de la taille :
   un .dbf de lignes minuscules pourrait en annoncer des millions. Madagascar au
   fokontany en compte ~18 000 ; cette marge les couvre largement. */
const RECORDS_MAX = 200_000;

/* Garde anti-bombe d'archive, même esprit que verifierArchiveXlsx : on refuse un
   taux d'expansion absurde AVANT toute décompression. Un .shp est peu
   compressible (des doubles), le plafond absolu suffit donc à couvrir un pays. */
const ARCHIVE_MAX_ABSOLU = 256 * 1024 * 1024;

/* Un défaut de fichier n'est pas une panne du serveur : ce code permet à la
   route de le rendre en 422 avec son motif exact, comme le fait l'import Excel
   (code « ARCHIVE ») — l'utilisateur seul peut corriger son fichier. */
const refus = (message) => { const e = new Error(message); e.code = "SHAPEFILE"; return e; };

/* Les valeurs .dbf du jeu PAM sont en UTF-8 (« Activités » y est écrit sur deux
   octets) mais un vieux .dbf peut être en Windows-1252. On lit en UTF-8 et l'on
   ne retombe sur latin1 que si le décodage a produit un caractère de
   remplacement — même heuristique que le lecteur qui vivait dans le navigateur. */
const decoderTexte = (buf) => {
  const utf8 = buf.toString("utf8");
  return (utf8.includes("�") ? buf.toString("latin1") : utf8).replace(/\0.*$/s, "").trim();
};

/* ── En-tête .shp ─────────────────────────────────────────────────────── */
export function lireEnteteShp(buf){
  if(!buf || buf.length < 100)
    throw refus("fichier .shp trop court pour porter son en-tête (100 octets attendus)");
  /* Le code fichier ESRI (9994) est en gros-boutiste : c'est la signature du
     format, un fichier qui ne la porte pas n'est pas un .shp. */
  if(buf.readInt32BE(0) !== 9994)
    throw refus("ce fichier n'est pas un .shp : la signature ESRI (9994) est absente de l'en-tête");
  const typeShp = buf.readInt32LE(32);
  const emprise = {
    xmin: buf.readDoubleLE(36), ymin: buf.readDoubleLE(44),
    xmax: buf.readDoubleLE(52), ymax: buf.readDoubleLE(60),
  };
  return { typeShp, emprise, longueurDeclaree: buf.readInt32BE(24) * 2 };
}

/* ── Anneaux ESRI vers géométrie GeoJSON ──────────────────────────────
   Le format ne marque pas les trous par un champ : il les distingue par le SENS
   de parcours — anneau extérieur horaire, trou anti-horaire. On s'en sert pour
   REGROUPER (un extérieur ouvre un polygone, un trou complète le dernier) sans en
   dépendre pour le rendu : Leaflet ne regarde pas le sens. En coordonnées
   géographiques (x = longitude, y = latitude), l'aire signée négative est le sens
   horaire. */
function aireSignee(r){
  let a = 0;
  for(let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}
function anneauxVersGeometrie(anneaux){
  const polys = [];
  for(const r of anneaux){
    /* GeoJSON exige un anneau fermé : on referme si le fichier ne l'a pas fait. */
    const ferme = (r.length && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1])
      ? r : [...r, r[0]];
    if(ferme.length < 4) continue;                 /* moins d'un triangle : rien à dessiner */
    if(aireSignee(ferme) < 0 || !polys.length) polys.push([ferme]);   /* extérieur */
    else polys[polys.length - 1].push(ferme);                          /* trou */
  }
  if(!polys.length) return null;
  return polys.length === 1
    ? { type: "Polygon", coordinates: polys[0] }
    : { type: "MultiPolygon", coordinates: polys };
}

/* Un enregistrement polygone : bbox (ignorée), numParts, numPoints, indices de
   parts, puis les points. Les bornes sont vérifiées contre le tampon — un fichier
   forgé qui annonce plus de points qu'il n'en porte doit rendre `null`, pas faire
   lever une lecture hors bornes. */
function polygoneDepuis(buf, debut){
  const numParts = buf.readInt32LE(debut + 36);
  const numPoints = buf.readInt32LE(debut + 40);
  if(numParts <= 0 || numPoints <= 0 || numParts > numPoints) return null;
  const base = debut + 44 + numParts * 4;
  if(base + numPoints * 16 > buf.length) return null;
  const parts = [];
  for(let i = 0; i < numParts; i++) parts.push(buf.readInt32LE(debut + 44 + i * 4));
  const anneaux = [];
  for(let i = 0; i < numParts; i++){
    const a = parts[i], b = i + 1 < numParts ? parts[i + 1] : numPoints;
    const r = [];
    for(let k = a; k < b; k++){
      const o = base + k * 16;
      r.push([buf.readDoubleLE(o), buf.readDoubleLE(o + 8)]);   /* [lon, lat] */
    }
    if(r.length > 2) anneaux.push(r);
  }
  return anneauxVersGeometrie(anneaux);
}

/* ── Géométries .shp, dans l'ordre des enregistrements ────────────────
   Le parcours est STREAMANT : chaque géométrie est passée à un rappel et n'est
   jamais retenue par ce niveau. C'est ce qui permet au commit d'écrire les
   contours EN BASE par lots sans jamais tenir en mémoire les 17 500 polygones
   d'un découpage au fokontany — dont le GeoJSON pèse des centaines de mégaoctets. */
export function parcourirGeometriesShp(buf, cb, { maxRecords = RECORDS_MAX } = {}){
  const { typeShp } = lireEnteteShp(buf);
  /* Refus net de tout ce qui n'est pas un polygone : un fichier de points ou de
     lignes ne décrit pas un découpage en communes, et le laisser passer
     produirait un fond de carte vide sans le moindre message. */
  if(typeShp !== TYPE_POLYGONE)
    throw refus(`type de géométrie ${typeShp} non pris en charge : seul le polygone `
      + "(type 5) décrit un découpage administratif");

  let p = 100, i = 0;
  while(p + 8 <= buf.length){
    /* En-tête d'enregistrement : longueur du contenu en mots de 16 bits,
       gros-boutiste — la seule partie gros-boutiste après l'en-tête de fichier. */
    const clen = buf.readInt32BE(p + 4) * 2;
    const debut = p + 8;
    if(clen <= 0 || debut + clen > buf.length) break;   /* enregistrement tronqué : on s'arrête au sain */
    const t = buf.readInt32LE(debut);
    /* Le type 0 (« enregistrement nul ») est permis au sein d'un fichier de
       polygones : la commune n'a alors pas de contour, ce n'est pas une erreur. */
    cb(i, t === TYPE_POLYGONE ? polygoneDepuis(buf, debut) : null);
    i++;
    if(i > maxRecords)
      throw refus(`fichier .shp trop volumineux : plus de ${maxRecords} enregistrements`);
    p = debut + clen;
  }
  return i;
}

/* Toutes les géométries d'un coup, pour l'appelant qui peut se le permettre (petit
   fichier, test). Le commit, lui, passe par le parcours streamant ci-dessus. */
export function lireGeometriesShp(buf, opts){
  const geoms = [];
  parcourirGeometriesShp(buf, (i, g) => geoms.push(g), opts);
  return geoms;
}

/* ── Table attributaire .dbf ──────────────────────────────────────────── */
export function lireDbf(buf, { maxRecords = RECORDS_MAX } = {}){
  if(!buf || buf.length < 32)
    throw refus("table attributaire .dbf trop courte pour porter son en-tête");
  const nbDeclare = buf.readUInt32LE(4);
  const tailleEntete = buf.readUInt16LE(8);
  const tailleLigne = buf.readUInt16LE(10);
  if(tailleEntete < 33 || tailleLigne < 1 || tailleEntete > buf.length)
    throw refus("en-tête .dbf incohérent : le fichier est corrompu ou n'est pas un .dbf");

  const champs = [];
  let p = 32;
  /* Descripteurs de 32 octets chacun, terminés par 0x0D : nom sur 11 octets,
     type en 11, longueur en 16. */
  while(p < tailleEntete - 1 && buf[p] !== 0x0D){
    champs.push({ nom: decoderTexte(buf.subarray(p, p + 11)),
      type: String.fromCharCode(buf[p + 11]), longueur: buf[p + 16] });
    p += 32;
  }
  if(!champs.length) throw refus("aucune colonne dans la table attributaire .dbf");

  /* Le nombre annoncé peut mentir — fichier tronqué, ou en-tête gonflé pour faire
     boucler le serveur : la lecture s'arrête à ce que le tampon contient vraiment,
     et le total reste plafonné. */
  const enregistrements = [];
  let off = tailleEntete;
  for(let i = 0; i < nbDeclare && off + tailleLigne <= buf.length; i++){
    /* Premier octet : marque de suppression. 0x2A (« * ») = ligne supprimée. */
    if(buf[off] !== 0x2A){
      const o = {}; let c = off + 1;
      for(const f of champs){
        const v = decoderTexte(buf.subarray(c, c + f.longueur));
        o[f.nom] = (f.type === "N" || f.type === "F")
          ? (v === "" ? null : Number(v.replace(",", "."))) : v;
        c += f.longueur;
      }
      enregistrements.push(o);
    }
    off += tailleLigne;
    if(enregistrements.length > maxRecords)
      throw refus(`table attributaire trop volumineuse : plus de ${maxRecords} lignes`);
  }
  return { champs, enregistrements };
}

/* ── Correspondance colonne → variable MEMS ───────────────────────────
   Les cibles sont les champs qu'attend `buildUnits` : les noms adm0…adm4, les
   p-codes par niveau, et les coordonnées de centroïde éventuelles. C'est la même
   démarche que le registre des champs des connecteurs (lib/champs.js) : une liste
   déclarée, des motifs qui PROPOSENT une correspondance sans jamais l'imposer —
   un autre pays a d'autres intitulés de colonnes, mais un jeu COD-AB standard
   n'exige aucune saisie. */
export const CIBLES = [
  { cle: "adm0", label: "Nom niveau 0 (pays)",      motifs: [/^adm0[_ ]?(en|fr|name|nm)?$/i, /^pays$/i, /^country/i] },
  { cle: "adm1", label: "Nom niveau 1 (région)",    motifs: [/^adm1[_ ]?(en|fr|name|nm)?$/i, /^r[ée]gion/i, /^province/i] },
  { cle: "adm2", label: "Nom niveau 2 (district)",  motifs: [/^adm2[_ ]?(en|fr|name|nm)?$/i, /^district/i, /^d[ée]partement/i] },
  { cle: "adm3", label: "Nom niveau 3 (commune)",   motifs: [/^adm3[_ ]?(en|fr|name|nm)?$/i, /^commune/i] },
  { cle: "adm4", label: "Nom niveau 4 (fokontany)", motifs: [/^adm4[_ ]?(en|fr|name|nm)?$/i, /^fokontany/i, /^village/i, /^localit/i] },
  { cle: "pcode0", label: "P-code niveau 0", motifs: [/^adm0[_ ]?p?code$/i] },
  { cle: "pcode1", label: "P-code niveau 1", motifs: [/^adm1[_ ]?p?code$/i] },
  { cle: "pcode2", label: "P-code niveau 2", motifs: [/^adm2[_ ]?p?code$/i] },
  { cle: "pcode3", label: "P-code niveau 3", motifs: [/^adm3[_ ]?p?code$/i] },
  { cle: "pcode4", label: "P-code niveau 4", motifs: [/^adm4[_ ]?p?code$/i] },
  { cle: "lat", label: "Latitude du centroïde (optionnel)",  motifs: [/^lat(itude)?$/i, /^y$/i, /^point_y$/i, /^centroid_y$/i] },
  { cle: "lon", label: "Longitude du centroïde (optionnel)", motifs: [/^lon(g|gitude)?$/i, /^x$/i, /^point_x$/i, /^centroid_x$/i] },
];
const CLES_CIBLES = new Set(CIBLES.map(c => c.cle));
const CIBLES_PUBLIQUES = CIBLES.map(({ cle, label }) => ({ cle, label }));
const NIVEAUX_NOM = ["adm0", "adm1", "adm2", "adm3", "adm4"];
const NIVEAUX_PCODE = ["pcode0", "pcode1", "pcode2", "pcode3", "pcode4"];

/* La correspondance proposée : chaque colonne n'est prise qu'une fois, et les
   cibles spécifiques (adm3, pcode3) sont examinées avant les génériques, pour que
   « ADM3_PCODE » aille bien à pcode3 et non au nom adm3. */
export function mappingParDefaut(nomsColonnes){
  const pris = new Set(); const out = {};
  for(const cible of CIBLES){
    for(const col of nomsColonnes){
      if(pris.has(col)) continue;
      if(cible.motifs.some(re => re.test(col))){ out[cible.cle] = col; pris.add(col); break; }
    }
  }
  return out;
}

/* Ne retient d'un mapping reçu que des cibles connues pointant vers des colonnes
   réelles. Une valeur vide est un choix explicite (« aucune colonne ») et prime
   donc sur la détection ; c'est ainsi qu'on DÉBRANCHE un rattrapage automatique
   qu'on ne veut pas. */
function nettoyerMapping(mapping, noms){
  if(!mapping || typeof mapping !== "object") return {};
  const cols = new Set(noms); const out = {};
  for(const [cle, col] of Object.entries(mapping)){
    if(!CLES_CIBLES.has(cle)) continue;
    if(col === "" || col == null){ out[cle] = ""; continue; }
    if(cols.has(col)) out[cle] = col;
  }
  return out;
}

const echantillonColonne = (enr, nom) => {
  const out = [];
  for(const e of enr){
    const v = e[nom];
    if(v == null || v === "") continue;
    const s = String(v);
    if(!out.includes(s)) out.push(s);
    if(out.length >= 3) break;
  }
  return out;
};

/* ── Lecture des attributs (le .dbf), sans les géométries ──────────────
   Rend les lignes plates qu'attend buildUnits, la correspondance retenue et les
   colonnes détectées pour le volet de mapping. Séparée de la lecture des
   géométries pour que le commit puisse construire l'arbre PUIS écrire les contours
   par lots, sans jamais tenir les deux en mémoire à la fois. */
export function lireTable({ dbf, mapping } = {}, { maxRecords = RECORDS_MAX } = {}){
  if(!dbf)
    throw refus("table attributaire .dbf absente : elle porte les noms et les p-codes des unités");
  const table = lireDbf(dbf, { maxRecords });
  const noms = table.champs.map(c => c.nom);
  const parDefaut = mappingParDefaut(noms);
  const eff = { ...parDefaut, ...nettoyerMapping(mapping, noms) };

  const val = (attrs, cle) => {
    const col = eff[cle];
    if(!col) return "";
    const v = attrs?.[col];
    return v == null ? "" : String(v).trim();
  };
  const lignes = table.enregistrements.map(attrs => {
    const ligne = {};
    for(const c of NIVEAUX_NOM) ligne[c] = val(attrs, c);
    for(const c of NIVEAUX_PCODE) ligne[c] = val(attrs, c);
    const lat = val(attrs, "lat"), lon = val(attrs, "lon");
    if(lat !== "") ligne.lat = lat;
    if(lon !== "") ligne.lon = lon;
    return ligne;
  });

  return {
    colonnes: table.champs.map(c => ({ nom: c.nom, type: c.type, longueur: c.longueur,
      exemples: echantillonColonne(table.enregistrements, c.nom) })),
    mapping: eff, mappingParDefaut: parDefaut, cibles: CIBLES_PUBLIQUES, lignes,
  };
}

/* Ce qu'un contour porte pour être rattaché : le p-code du niveau le plus profond
   renseigné (celui que buildUnits attribue à l'unité), et le chemin de noms (le
   repli, comme pour les sites — writeGeometries résout par l'un ou l'autre). Rend
   null pour une ligne qu'aucune colonne ne nomme : son contour n'irait nulle part. */
export function attributsContour(ligne){
  if(!ligne) return null;
  if(![...NIVEAUX_NOM, ...NIVEAUX_PCODE].some(c => ligne[c])) return null;
  const pcode = ["pcode4", "pcode3", "pcode2", "pcode1", "pcode0"]
    .map(k => ligne[k]).find(Boolean) || undefined;
  const names = {};
  for(const c of ["adm1", "adm2", "adm3", "adm4"]) if(ligne[c]) names[c] = ligne[c];
  return { pcode, names };
}

/* ── L'aperçu ──────────────────────────────────────────────────────────
   Rend tout ce que l'écran d'aperçu montre. `withFeatures` est FAUX par défaut
   pour l'aperçu : les géométries sont parcourues pour être COMPTÉES, jamais
   retenues — un aperçu ne renvoie qu'un échantillon et des compteurs, pas 17 500
   contours. Le commit, lui, ne passe pas par ici : il lit la table, écrit l'arbre,
   puis STREAME les géométries en base (voir la route). */
export function construire({ shp, dbf, prj, mapping } = {},
                           { maxRecords = RECORDS_MAX, withFeatures = false } = {}){
  const table = lireTable({ dbf, mapping }, { maxRecords });
  const entete = shp ? lireEnteteShp(shp) : null;

  const features = [];
  let avecGeometrie = 0, sansGeometrie = 0, shpRecords = 0;
  let sansAttribut = 0;
  for(const ligne of table.lignes) if(!attributsContour(ligne)) sansAttribut++;

  if(shp){
    /* Appariement par ORDRE : la géométrie i décrit la ligne i du .dbf. */
    shpRecords = parcourirGeometriesShp(shp, (i, g) => {
      if(g) avecGeometrie++; else sansGeometrie++;
      if(withFeatures && g){
        const at = attributsContour(table.lignes[i]);
        if(at) features.push({ ...at, geometry: g });
      }
    }, { maxRecords });
    /* Les lignes .dbf au-delà des enregistrements .shp n'ont pas de contour. */
    sansGeometrie += Math.max(0, table.lignes.length - shpRecords);
  }

  return {
    colonnes: table.colonnes, mapping: table.mapping,
    mappingParDefaut: table.mappingParDefaut, cibles: table.cibles,
    lignes: table.lignes, features,
    resume: {
      records: table.lignes.length,
      shpRecords,
      apparies: shp ? Math.min(table.lignes.length, shpRecords) : 0,
      avecGeometrie, sansGeometrie, sansAttribut,
      typeShp: entete ? entete.typeShp : null,
      emprise: entete ? entete.emprise : null,
      projection: prj ? decoderTexte(prj).slice(0, 160) : null,
    },
  };
}

/* ── Dépôt : archive .zip OU fichiers séparés ─────────────────────────
   Les deux formes sont acceptées. Le .zip est le plus commode — il compresse et
   passe sous le plafond du corps de requête — mais un utilisateur doit pouvoir
   déposer .shp + .dbf (+ .prj) séparément. Cette fonction ramène les deux cas à un
   même triplet de tampons. */
export async function extraireArchiveGeo(buffer){
  let zip;
  try{ zip = await JSZip.loadAsync(buffer); }
  catch(e){ throw refus("archive .zip illisible : ce n'est pas une archive valide"); }

  /* Garde anti-bombe sur les tailles ANNONCÉES, avant toute décompression. */
  let total = 0;
  for(const e of Object.values(zip.files)) if(!e.dir) total += e._data?.uncompressedSize || 0;
  const plafond = Math.min(ARCHIVE_MAX_ABSOLU, buffer.length * 200);
  if(total > plafond)
    throw refus(`archive refusée : ${Math.round(total / 1048576)} Mo une fois décompressée `
      + `pour ${Math.round(buffer.length / 1024)} Ko reçus — taux d'expansion anormal`);

  const trouver = (ext) => {
    const nom = Object.keys(zip.files).find(n => {
      const base = n.split("/").pop();
      /* On ignore les copies « ._MACOSX » et les fichiers cachés commençant par un point. */
      return n.toLowerCase().endsWith(ext) && base && !base.startsWith(".") && !zip.files[n].dir;
    });
    return nom ? zip.files[nom] : null;
  };
  const lire = async (e) => (e ? Buffer.from(await e.async("nodebuffer")) : null);
  const shp = await lire(trouver(".shp"));
  const dbf = await lire(trouver(".dbf"));
  const prj = await lire(trouver(".prj"));
  if(!shp && !dbf) throw refus("l'archive ne contient ni .shp ni .dbf");
  return { shp, dbf, prj };
}
