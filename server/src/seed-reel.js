import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { db, migrate, tx } from "./db.js";
import { log } from "./lib/logger.js";
import { newId } from "./lib/crypto.js";
import { buildUnits, writeVersion } from "./lib/geo.js";
import { deriverNiveaux, writeGeometries } from "./lib/geom.js";
import { lireTable, parcourirGeometriesShp, attributsContour } from "./lib/shapefile.js";

/* ═══════════════════════════════════════════════════════════════════════
   SEMIS DES DONNÉES RÉELLES  (chantier S8, point 5)

   « Dans les settings utilise mes data réels et stocke-les comme valeurs
   par défaut de MEMS. »

   Décision, prise mot pour mot sur cette phrase : ce sont les TABLES
   RÉELLES qui sont préremplies, pas des constantes `D_*` du navigateur.
   Une valeur par défaut codée en dur ne se corrige pas, ne se date pas, ne
   se trace pas et disparaît au prochain écran ; une table se paramètre —
   c'est tout l'objet des quatre lots précédents.

   Ce script lit les fichiers déposés dans `docs/` et remplit :

     1. les ACTIVITÉS      — `WFP Indicator Master List_UpdMai_2025.xlsx`,
                             onglet « Annex 5 Activity tags » (58 tags).
     2. les INDICATEURS    — le même classeur, quatre onglets :
                             Annex 2 Outcome (94)  → CRF / outcome
                             Annex 3 Output (157)  → CRF / output
                             Detailed Output (566) → CRF / other_output
                             Annex 4 Crosscutting (25) → CRF / crosscutting
                             chacun avec sa CATÉGORIE thématique, filtrable.
     3. le DÉCOUPAGE       — `mdg_bnd_adm3_com_pam_2025.shp/.dbf`, l'arbre
                             adm0→adm3 de Madagascar et ses 1 701 contours.

   ── Idempotent, et jamais destructeur ────────────────────────────────
   Chaque référentiel est mis à jour PAR SON CODE : relancer le script
   corrige et complète, il ne duplique pas et n'efface rien. Ce qui a été
   saisi à la main sur une ligne existante (une cible, un panier d'analyse)
   est PRÉSERVÉ : le classeur ne les porte pas, il n'a pas à les écraser.
   Le découpage, lui, crée un millésime — c'est la sémantique du référentiel
   géographique —, et le script s'abstient si le même est déjà chargé.

   Usage :  npm run seed:reel [-- --docs <dossier>] [--sans-geo] [--force-geo]
   ═══════════════════════════════════════════════════════════════════════ */

const here = path.dirname(fileURLToPath(import.meta.url));
migrate(path.join(here, "..", "migrations"));

const args = process.argv.slice(2);
const optionValeur = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
const DOCS = path.resolve(optionValeur("--docs", path.join(here, "..", "..", "docs")));
const SANS_GEO = args.includes("--sans-geo");
const FORCE_GEO = args.includes("--force-geo");

const CLASSEUR = "WFP Indicator Master List_UpdMai_2025.xlsx";
const SHP = "mdg_bnd_adm3_com_pam_2025.shp";
const DBF = "mdg_bnd_adm3_com_pam_2025.dbf";

const fichier = (nom) => path.join(DOCS, nom);
const existe = (nom) => fs.existsSync(fichier(nom));

/* Une cellule Excel n'est pas toujours une chaîne : formule, texte enrichi,
   lien. On ne veut que ce que l'œil lit. */
const txt = (v) => {
  if(v == null) return "";
  if(typeof v === "object"){
    if(Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if(v.text != null) return String(v.text);
    if(v.result != null) return String(v.result);
    return "";
  }
  return String(v);
};
const propre = (v) => txt(v).replace(/\s+/g, " ").trim();

/* Lecture d'un onglet en lignes plates.

   Deux particularités du classeur, apprises en le lisant plutôt qu'en le
   supposant : les en-têtes tiennent sur DEUX lignes (cellules fusionnées),
   et la colonne de catégorie n'est répétée qu'au changement de groupe. D'où
   la première ligne de données déclarée par appelant, et le report de la
   dernière catégorie non vide. */
function lireOnglet(wb, nom, premiereLigne, colonnes){
  const ws = wb.getWorksheet(nom);
  if(!ws) return [];
  const out = []; let derniereCat = "";
  for(let r = premiereLigne; r <= ws.rowCount; r++){
    const row = ws.getRow(r);
    const g = (c) => (c ? propre(row.getCell(c).value) : "");
    const code = g(colonnes.code), libelle = g(colonnes.nom);
    /* Les onglets se terminent par des centaines de lignes vides mises en
       forme : une ligne sans code ni libellé n'est pas une donnée. */
    if(!code || !libelle) continue;
    const cat = g(colonnes.categorie);
    if(cat) derniereCat = cat;
    out.push({ code, libelle, categorie: derniereCat,
      statut: g(colonnes.statut), unite: g(colonnes.unite), extra: g(colonnes.extra) });
  }
  return out;
}

/* ── 1. Les activités ────────────────────────────────────────────────
   L'onglet « Annex 5 Activity tags » EST le référentiel d'activités du
   PAM : un intitulé, un acronyme (le tag, donc le code), et le type
   d'intervention qui les regroupe.

   La colonne « Type of interventions » ne porte pas un libellé mais un
   TITRE DE GROUPE, répété sur chaque ligne : « Activity Tags under which
   Tier 1 and Tier 2 beneficiaries are targeted ». Soixante-dix caractères
   de phrase dans une colonne « domaine programme » que les écrans
   affichent en tête de colonne et proposent en filtre — ce serait illisible
   partout. Les trois groupes du classeur sont donc nommés ici, une fois,
   et rien d'autre n'est interprété : le tag, l'intitulé et l'appartenance
   viennent tels quels du fichier. */
const GROUPES_INTERVENTION = [
  [/tier 1 and tier 2/i,          "Bénéficiaires de niveau 1 et 2"],
  [/institutional capacity/i,     "Renforcement des capacités institutionnelles"],
  [/service delivery/i,           "Prestation de services"],
];
const domaineDe = (titre) =>
  (GROUPES_INTERVENTION.find(([re]) => re.test(titre || ""))?.[1]) || (titre || "").slice(0, 120) || null;

/* Les domaines ainsi posés doivent EXISTER dans la liste paramétrable des
   domaines (chantier S8-1), sinon les activités chargées désigneraient un
   code absent de son propre référentiel — exactement l'orphelin que les
   quatre lots précédents empêchent. Le semis les crée s'ils manquent. */
function assurerDomaines(codes){
  const ins = db.prepare(`INSERT INTO list_item (id,type,code,label,sort_order,note)
                          VALUES (?,'domaine',?,?,?,?)`);
  let n = 0, ordre = db.prepare(
    "SELECT COALESCE(MAX(sort_order),0) m FROM list_item WHERE type='domaine'").get().m;
  for(const code of codes){
    if(!code) continue;
    if(db.prepare("SELECT 1 FROM list_item WHERE type='domaine' AND code=?").get(code)) continue;
    ins.run(newId("li"), code, code, ++ordre, "Créé par le semis des données réelles (Annex 5).");
    n++;
  }
  return n;
}

function semerActivites(wb){
  const lignes = lireOnglet(wb, "Annex 5 Activity tags", 2,
    { nom:3, code:4, categorie:1, extra:5 });
  if(!lignes.length) return { lues:0, crees:0, majs:0 };

  /* L'identité d'une activité est son TAG, et lui seul (migration 028) :
     « liste des activités = activity tag (valeur unique) ». Le rapprochement
     se fait donc par tag. Le nom, lui, reste unique en base — s'il est déjà
     pris par une AUTRE activité, on le désambiguïse par le tag plutôt que
     de perdre la ligne : les 58 tags du classeur doivent tous exister. */
  const parTag = new Map(db.prepare("SELECT * FROM activity_categories").all()
    .map(a => [a.tag.toUpperCase(), a]));
  const nomPris = new Map(db.prepare("SELECT * FROM activity_categories").all()
    .map(a => [a.name.toLowerCase(), a]));
  let crees = 0, majs = 0, domaines = 0, renommes = 0;

  tx(() => {
    domaines = assurerDomaines([...new Set(lignes.map(l => domaineDe(l.categorie)))]);
    for(const l of lignes){
      /* Le classeur porte quelques acronymes espacés (« FBA _CCS ») : c'est
         une coquille de saisie, pas un code différent. */
      const tag = l.code.replace(/\s+/g, "").toUpperCase();
      const domaine = domaineDe(l.categorie);
      const existant = parTag.get(tag);
      if(existant){
        /* Le nom et le domaine se mettent à jour ; le TAG ne bouge pas —
           c'est la clé de jointure, et la règle du chantier vaut aussi pour
           un chargement en masse. Le renommage a sa route, en cascade. */
        const autre = nomPris.get(l.libelle.toLowerCase());
        const nom = (autre && autre.id !== existant.id) ? `${l.libelle} (${tag})` : l.libelle;
        if(nom !== l.libelle) renommes++;
        db.prepare(`UPDATE activity_categories SET name=?, program_area=?, rev=rev+1 WHERE id=?`)
          .run(nom, domaine || existant.program_area || null, existant.id);
        nomPris.set(nom.toLowerCase(), existant);
        majs++;
      } else {
        const id = newId("act");
        const pris = nomPris.get(l.libelle.toLowerCase());
        const nom = pris ? `${l.libelle} (${tag})` : l.libelle;
        if(pris) renommes++;
        db.prepare(`INSERT INTO activity_categories (id,name,tag,program_area,active)
                    VALUES (?,?,?,?,1)`).run(id, nom, tag, domaine);
        parTag.set(tag, { id, tag, name:nom });
        nomPris.set(nom.toLowerCase(), { id, tag, name:nom });
        crees++;
      }
    }
  })();
  return { lues:lignes.length, crees, majs, domaines, renommes };
}

/* ── 2. La masterlist d'indicateurs, par catégorie ───────────────────
   Quatre onglets, quatre natures dans le cadre de résultats. Le `level`
   dit l'onglet, la `category` le thème à l'intérieur — c'est cette
   dernière que l'écran filtre. */
const ONGLETS_INDICATEURS = [
  { nom:"Annex 2 Outcome Indicators", premiere:3, level:"outcome",
    cols:{ categorie:1, statut:3, code:4, nom:5 } },
  { nom:"Annex 3 Output Indicators", premiere:3, level:"output",
    cols:{ categorie:1, statut:3, code:4, nom:5 } },
  { nom:"Detailed Output Indicators", premiere:2, level:"other_output",
    cols:{ categorie:1, code:4, nom:5, statut:6, unite:8 } },
  { nom:"Annex 4 Crosscutting indicators", premiere:3, level:"crosscutting",
    cols:{ categorie:1, statut:2, code:3, nom:4 } },
];

/* Le classeur écrit le statut de six façons (« Deactivated », « Inactive »,
   « Deacivated », « Deactivated in 2024 »…). Un indicateur retiré du cadre
   reste dans le référentiel — il a des valeurs historiques — mais n'est pas
   proposé : on le charge, en le marquant. */
const estActif = (s) => !/deac|inactiv/i.test(s || "");

function semerIndicateurs(wb){
  const bilan = { lues:0, crees:0, majs:0, parNiveau:{} };
  const existants = new Map(db.prepare("SELECT * FROM indicators").all().map(i => [i.code, i]));

  tx(() => {
    for(const onglet of ONGLETS_INDICATEURS){
      const lignes = lireOnglet(wb, onglet.nom, onglet.premiere, onglet.cols);
      bilan.parNiveau[onglet.level] = lignes.length;
      bilan.lues += lignes.length;
      for(const l of lignes){
        const actif = estActif(l.statut);
        /* L'unité n'est donnée que par l'onglet détaillé ; ailleurs elle se
           déduit de l'intitulé — « Percentage of… » est un pourcentage,
           « Number of… » un nombre. Mieux vaut cette lecture, vérifiable sur
           le texte, qu'un « % » posé sur tout. */
        const unite = l.unite || (/^percentage|^proportion|rate$/i.test(l.libelle) ? "%"
          : /^number|^total/i.test(l.libelle) ? "nb" : "%");
        const ex = existants.get(l.code);
        if(ex){
          /* Ce que le classeur porte est mis à jour ; ce qu'il ne porte pas
             — la cible, le sens, la méthode, le panier d'analyse du bureau —
             est laissé tel quel. Un chargement de référentiel ne défait pas
             une saisie. */
          db.prepare(`UPDATE indicators SET name=?, kind='crf', level=?, category=?,
                      method=COALESCE(NULLIF(method,''),?), rev=rev+1 WHERE id=?`)
            .run(l.libelle, onglet.level, l.categorie || null,
                 actif ? null : "Retiré du cadre de résultats", ex.id);
          bilan.majs++;
        } else {
          db.prepare(`INSERT INTO indicators (id,code,name,basket,unit,target,direction,
                      method,frequency,kind,level,category)
                      VALUES (?,?,?,?,?,0,'up',?,?,'crf',?,?)`)
            .run(newId("ind"), l.code, l.libelle, l.categorie || null, unite,
                 actif ? null : "Retiré du cadre de résultats", null,
                 onglet.level, l.categorie || null);
          bilan.crees++;
        }
      }
    }
  })();
  return bilan;
}

/* ── 3. Le découpage administratif de Madagascar ─────────────────────
   Le même chemin que la route d'import (`POST /api/geo/shapefile/commit`) :
   la table attributaire construit l'arbre, puis les géométries sont
   STREAMÉES par lots depuis le .shp. Le fichier pèse 23 Mo et porte 1 701
   polygones ; les tenir tous en mémoire d'un coup ferait enfler le
   processus sans aucun gain. */
function semerDecoupage(){
  if(!existe(SHP)) return { saute:"aucun shapefile dans le dossier docs" };
  const label = "Madagascar — communes (PAM 2025)";
  const dejaLa = db.prepare("SELECT id FROM geo_version WHERE label=?").get(label);
  if(dejaLa && !FORCE_GEO)
    return { saute:`« ${label} » est déjà chargé (--force-geo pour en créer un nouveau millésime)` };

  const shp = fs.readFileSync(fichier(SHP));
  const dbf = existe(DBF) ? fs.readFileSync(fichier(DBF)) : null;
  const table = lireTable({ dbf });
  const { units, counts, collisions } = buildUnits(table.lignes, { allowDuplicates:false });
  if(!units.length) return { erreur:"aucune unité exploitable dans le shapefile" };

  let versionId, ecrites = 0, rejetes = 0;
  const LOT = 500;
  tx(() => {
    versionId = writeVersion({ label, source:SHP, units, userId:null, makeCurrent:true });
    let lot = [], premier = true;
    const vider = () => {
      if(!lot.length) return;
      const b = writeGeometries({ versionId, features:lot, reset:premier, source:SHP });
      premier = false; ecrites += b.écrites; rejetes += b.rejetes || 0;
      lot = [];
    };
    parcourirGeometriesShp(shp, (i, g) => {
      if(!g) return;
      const at = attributsContour(table.lignes[i]);
      if(!at) return;
      lot.push({ ...at, geometry:g });
      if(lot.length >= LOT) vider();
    });
    vider();
  })();
  /* Le fichier ne porte QUE les communes, mais sa table attributaire porte
     l'arbre entier : districts, régions et pays sont les mêmes polygones
     réunis par parent. On les dérive donc dans la foulée, sans quoi la carte
     n'aurait qu'un seul niveau de breakdown alors que la donnée en permet
     quatre. */
  const derive = deriverNiveaux({ versionId });

  return { versionId, unites:units.length, counts, contours:ecrites, rejetes,
           collisions:collisions.length,
           derives: derive.erreur ? null : derive };
}

/* ── Exécution ───────────────────────────────────────────────────── */
if(!fs.existsSync(DOCS)){
  log.error("dossier de documents introuvable", { dossier:DOCS });
  process.exit(1);
}

const bilan = {};
if(existe(CLASSEUR)){
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fichier(CLASSEUR));
  bilan.activites = semerActivites(wb);
  bilan.indicateurs = semerIndicateurs(wb);
  log.info("activités chargées", bilan.activites);
  log.info("indicateurs chargés", { ...bilan.indicateurs.parNiveau,
    crees:bilan.indicateurs.crees, majs:bilan.indicateurs.majs });
} else {
  log.warn("classeur d'indicateurs absent : activités et indicateurs non chargés",
    { attendu: fichier(CLASSEUR) });
}

if(SANS_GEO){
  log.info("découpage administratif ignoré (--sans-geo)");
} else {
  bilan.geo = semerDecoupage();
  if(bilan.geo.saute) log.warn("découpage non chargé", { raison:bilan.geo.saute });
  else if(bilan.geo.erreur) log.error("découpage refusé", { raison:bilan.geo.erreur });
  else {
    log.info("découpage chargé", { unites:bilan.geo.unites, communes:bilan.geo.counts?.adm3,
      contours:bilan.geo.contours });
    if(bilan.geo.derives?.total) log.info("niveaux supérieurs dérivés", Object.fromEntries(
      bilan.geo.derives.etapes.filter(e => e.ecrites).map(e => [e.niveau, e.ecrites])));
  }
}

/* Le journal d'audit garde trace du chargement : c'est une écriture massive
   dans des référentiels partagés, elle ne doit pas être anonyme. */
db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
            VALUES (?,NULL,'semis données réelles','plan','referentiels','import',?)`)
  .run(newId("aud"),
    `Données réelles chargées depuis docs/ — ${bilan.activites?.lues || 0} activité(s), `
    + `${bilan.indicateurs?.lues || 0} indicateur(s)`
    + (bilan.geo?.unites ? `, ${bilan.geo.unites} unité(s) géographiques` : ""));

const compte = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
log.info("semis des données réelles terminé", {
  activites: compte("activity_categories"),
  indicateurs: compte("indicators"),
  unitesGeo: compte("geo_unit"),
  contours: compte("geo_geom"),
});
