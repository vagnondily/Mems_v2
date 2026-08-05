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
import { extraireIndicateursProcessus } from "./lib/process-xlsform.js";

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
await migrate(path.join(here, "..", "migrations"));

const args = process.argv.slice(2);
const optionValeur = (nom, defaut) => {
  const i = args.indexOf(nom);
  return i >= 0 && args[i + 1] ? args[i + 1] : defaut;
};
/* Où lire les fichiers de référence, dans l'ordre : option `--docs` / variable
   `MEMS_DATA_DIR`, puis le dossier `data/` du dépôt s'il porte le shapefile, puis
   `docs/` (fichiers d'origine versionnés). « Crée un dossier data et mets-y les
   données réelles » : ce dossier est ainsi la source préférée dès qu'il est
   peuplé, sans casser l'existant qui vit dans docs/. */
const resoudreSource = () => {
  const explicite = optionValeur("--docs", process.env.MEMS_DATA_DIR || "");
  if(explicite) return path.resolve(explicite);
  const dataDir = path.join(here, "..", "..", "data");
  try{ if(fs.existsSync(path.join(dataDir, "mdg_bnd_adm3_com_pam_2025.shp"))) return dataDir; }catch(e){}
  return path.join(here, "..", "..", "docs");
};
const DOCS = path.resolve(resoudreSource());
/* `let` et non `const` : le semis est aussi appelé PAR le serveur (route
   d'administration « charger les données de référence »), qui passe ses propres
   options plutôt que la ligne de commande. */
let SANS_GEO = args.includes("--sans-geo");
let FORCE_GEO = args.includes("--force-geo");

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
/* Le classeur SDG (Annex 1) porte des « Not available » COLLÉS au milieu de mots
   — « newNot availableborns », « workNot availableinjury » — vestige d'un
   rechercher-remplacer malheureux dans le fichier source, où un trait d'union a
   été remplacé par ce texte. Un « Not available » légitime est toujours entouré
   d'espaces ; celui-ci, coincé entre deux lettres, ne l'est jamais. On rétablit
   le trait d'union, sans toucher aux « Not available » isolés. */
const propre = (v) => txt(v)
  .replace(/([A-Za-z])Not available([A-Za-z])/g, "$1-$2")
  .replace(/\s+/g, " ").trim();

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
      statut: g(colonnes.statut), unite: g(colonnes.unite), extra: g(colonnes.extra),
      /* Colonnes de PERTINENCE, lues telles quelles : les activity tags
         auxquels l'indicateur s'applique, et ses cibles (genre, tiers de
         bénéficiaires). C'est ce que l'écran restitue « à quelles activités,
         pour quelles cibles ». */
      tags: g(colonnes.tags), gender: g(colonnes.gender),
      tier1: g(colonnes.tier1), tier23: g(colonnes.tier23), gran: g(colonnes.gran),
      /* Colonnes riches de la masterlist (migration 032), lues telles quelles.
         Une colonne absente de l'onglet reste vide — `g()` rend "" sur un index
         indéfini. */
      applicability: g(colonnes.applicability), reporting: g(colonnes.reporting),
      outputType: g(colonnes.outputType), unitInterp: g(colonnes.unitInterp),
      flexibility: g(colonnes.flexibility), followValue: g(colonnes.followValue),
      intermediate: g(colonnes.intermediate) });
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
/* `exec` (le client de transaction quand elle est appelée depuis l'intérieur
   d'une transaction, sinon l'import de module par défaut) : sous better-sqlite3
   une connexion unique rendait ceci sans objet, mais sous pg une transaction vit
   sur un client dédié (voir src/db.js) — appeler cette fonction avec l'import de
   module depuis l'intérieur du `tx()` de semerActivites ferait tourner ces
   requêtes sur une autre connexion du pool, hors de cette transaction. */
async function assurerDomaines(codes, exec = db){
  const ins = exec.prepare(`INSERT INTO list_item (id,type,code,label,sort_order,note)
                          VALUES (?,'domaine',?,?,?,?)`);
  let n = 0, ordre = (await exec.prepare(
    "SELECT COALESCE(MAX(sort_order),0) m FROM list_item WHERE type='domaine'").get()).m;
  for(const code of codes){
    if(!code) continue;
    if(await exec.prepare("SELECT 1 FROM list_item WHERE type='domaine' AND code=?").get(code)) continue;
    await ins.run(newId("li"), code, code, ++ordre, "Créé par le semis des données réelles (Annex 5).");
    n++;
  }
  return n;
}

async function semerActivites(wb){
  const lignes = lireOnglet(wb, "Annex 5 Activity tags", 2,
    { nom:3, code:4, categorie:1, extra:5 });
  if(!lignes.length) return { lues:0, crees:0, majs:0 };

  /* L'identité d'une activité est son TAG, et lui seul (migration 028) :
     « liste des activités = activity tag (valeur unique) ». Le rapprochement
     se fait donc par tag. Le nom, lui, reste unique en base — s'il est déjà
     pris par une AUTRE activité, on le désambiguïse par le tag plutôt que
     de perdre la ligne : les 58 tags du classeur doivent tous exister. */
  const parTag = new Map((await db.prepare("SELECT * FROM activity_categories").all())
    .map(a => [a.tag.toUpperCase(), a]));
  const nomPris = new Map((await db.prepare("SELECT * FROM activity_categories").all())
    .map(a => [a.name.toLowerCase(), a]));
  let crees = 0, majs = 0, domaines = 0, renommes = 0;

  await tx(async (db) => {
    domaines = await assurerDomaines([...new Set(lignes.map(l => domaineDe(l.categorie)))], db);
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
        await db.prepare(`UPDATE activity_categories SET name=?, program_area=?, rev=rev+1 WHERE id=?`)
          .run(nom, domaine || existant.program_area || null, existant.id);
        nomPris.set(nom.toLowerCase(), existant);
        majs++;
      } else {
        const id = newId("act");
        const pris = nomPris.get(l.libelle.toLowerCase());
        const nom = pris ? `${l.libelle} (${tag})` : l.libelle;
        if(pris) renommes++;
        await db.prepare(`INSERT INTO activity_categories (id,name,tag,program_area,active)
                    VALUES (?,?,?,?,1)`).run(id, nom, tag, domaine);
        parTag.set(tag, { id, tag, name:nom });
        nomPris.set(nom.toLowerCase(), { id, tag, name:nom });
        crees++;
      }
    }
  });
  return { lues:lignes.length, crees, majs, domaines, renommes };
}

/* ── 2. La masterlist d'indicateurs, par catégorie ───────────────────
   Quatre onglets, quatre natures dans le cadre de résultats. Le `level`
   dit l'onglet, la `category` le thème à l'intérieur — c'est cette
   dernière que l'écran filtre. */
const ONGLETS_INDICATEURS = [
  { nom:"Annex 2 Outcome Indicators", premiere:3, level:"outcome",
    cols:{ categorie:1, statut:3, code:4, nom:5, applicability:10, tags:12, gender:13,
           reporting:9 } },
  { nom:"Annex 3 Output Indicators", premiere:3, level:"output",
    cols:{ categorie:1, statut:3, code:4, nom:5, applicability:10, tags:12, gender:13,
           outputType:14, reporting:15, followValue:16 } },
  { nom:"Detailed Output Indicators", premiere:2, level:"other_output",
    cols:{ categorie:1, outputType:2, intermediate:3, code:4, nom:5, statut:6, unite:8,
           unitInterp:9, flexibility:10, followValue:12 } },
  { nom:"Annex 4 Crosscutting indicators", premiere:3, level:"crosscutting",
    cols:{ categorie:1, statut:2, code:3, nom:4, applicability:9, tags:12,
           tier1:9, tier23:10, gran:13 } },
  /* Annex 1 : les cibles et indicateurs des ODD (SDGs) auxquels le PAM
     contribue. Cinquième sous-groupe. Le nom d'onglet porte une espace finale
     dans le classeur — elle est reproduite telle quelle. */
  { nom:"Annex 1 SDGs ", premiere:2, level:"sdg",
    cols:{ categorie:3, code:4, nom:5, unite:8, statut:10 } },
];

/* ── Pertinence : à quelles ACTIVITÉS l'indicateur s'applique ─────────
   Le classeur écrit les tags de trois façons selon l'onglet :
     · Annex 2 : « *General Distribution (GD) *Food assistance for asset (FFA)… »
       → les codes sont entre parenthèses ;
     · Annex 4 : « GD, HIV/TB_M&SN, PMD, PREV… » → liste séparée par des virgules ;
     · Annex 3 : souvent une phrase (« All where direct beneficiaries… »).
   On extrait les jetons, on les confronte aux tags RÉELS chargés (Annex 5),
   et on ne retient que ceux qui existent — le reste est du texte d'aide, pas
   un rattachement. `tagsConnus` est un Set des tags normalisés. */
const normTag = (t) => String(t || "").replace(/\s+/g, "").toUpperCase();
function tagsDe(raw, tagsConnus){
  if(!raw) return [];
  const jetons = new Set();
  /* Codes entre parenthèses (Annex 2). */
  for(const m of raw.matchAll(/\(([^)]+)\)/g)) jetons.add(normTag(m[1]));
  /* Liste séparée par virgules / points-virgules / astérisques (Annex 4, et
     le reste des phrases : on tente chaque mot-jeton). */
  for(const part of raw.split(/[,;*\n]/)) {
    const t = normTag(part);
    if(t) jetons.add(t);
    /* Un fragment « Food assistance for asset (FFA) » : on a déjà (FFA) ;
       on tente aussi le dernier mot en capitales comme code. */
  }
  return [...jetons].filter(t => tagsConnus.has(t));
}

/* ── Cibles : genre et tiers de bénéficiaires ────────────────────────── */
function ciblesDe(l){
  const parts = [];
  const g = (l.gender || "").toLowerCase();
  if(/mandatory/.test(g)) parts.push("Désagrégation par genre (obligatoire)");
  else if(/optional/.test(g)) parts.push("Désagrégation par genre (facultative)");
  /* Annex 4 : tiers de ciblage CSP. « Applicable », « Yes »… = concerné. */
  const concerne = (v) => v && !/^(not applicable|no|n\/a|-)?$/i.test(v.trim()) && !/not applicable/i.test(v);
  if(concerne(l.tier1)) parts.push("Bénéficiaires Tier 1");
  if(concerne(l.tier23)) parts.push("Bénéficiaires Tier 2 & 3");
  if(l.gran && /activity/i.test(l.gran)) parts.push("Collecte par activité");
  return parts.join(" · ");
}

/* Le classeur écrit le statut de six façons (« Deactivated », « Inactive »,
   « Deacivated », « Deactivated in 2024 »…). Un indicateur retiré du cadre
   reste dans le référentiel — il a des valeurs historiques — mais n'est pas
   proposé : on le charge, en le marquant. */
const estActif = (s) => !/deac|inactiv/i.test(s || "");

async function semerIndicateurs(wb){
  const bilan = { lues:0, crees:0, majs:0, parNiveau:{}, avecTags:0 };
  const existants = new Map((await db.prepare("SELECT * FROM indicators").all()).map(i => [i.code, i]));
  /* Les tags réels, pour ne rattacher qu'à ce qui existe (Annex 5 déjà chargée). */
  const tagsConnus = new Set((await db.prepare("SELECT tag FROM activity_categories").all()).map(x => normTag(x.tag)));
  /* Un même code ne s'écrit qu'une fois par passage : l'onglet SDG répète le
     code d'un indicateur sur chacun de ses « related indicators », et deux
     onglets peuvent se croiser. Premier vu, premier gardé — sans quoi le second
     INSERT viole l'unicité de `code`. */
  const vus = new Set();

  await tx(async (db) => {
    for(const onglet of ONGLETS_INDICATEURS){
      const lignes = lireOnglet(wb, onglet.nom, onglet.premiere, onglet.cols);
      bilan.parNiveau[onglet.level] = lignes.length;
      bilan.lues += lignes.length;
      for(const l of lignes){
        if(vus.has(l.code)) continue;
        vus.add(l.code);
        const actif = estActif(l.statut);
        const tags = tagsDe(l.tags, tagsConnus);
        const activityTags = tags.join(",");
        const cibles = ciblesDe(l);
        if(tags.length) bilan.avecTags++;
        /* L'unité n'est donnée que par l'onglet détaillé ; ailleurs elle se
           déduit de l'intitulé — « Percentage of… » est un pourcentage,
           « Number of… » un nombre. Mieux vaut cette lecture, vérifiable sur
           le texte, qu'un « % » posé sur tout. */
        const unite = l.unite || (/^percentage|^proportion|rate$/i.test(l.libelle) ? "%"
          : /^number|^total/i.test(l.libelle) ? "nb" : "%");
        /* Colonnes riches de la masterlist (migration 032). `nn(v)` : une chaîne
           vide devient NULL, pour ne pas encombrer la base de "". */
        const nn = (v) => (v && String(v).trim()) ? String(v).trim() : null;
        const status = nn(l.statut), applicability = nn(l.applicability),
              reportingReq = nn(l.reporting), outputType = nn(l.outputType),
              unitInterp = nn(l.unitInterp), flexibility = nn(l.flexibility),
              followValue = nn(l.followValue), intermediate = nn(l.intermediate);
        const ex = existants.get(l.code);
        if(ex){
          /* Ce que le classeur porte est mis à jour ; ce qu'il ne porte pas
             — la cible, le sens, la méthode, le panier d'analyse du bureau —
             est laissé tel quel. Un chargement de référentiel ne défait pas
             une saisie. */
          await db.prepare(`UPDATE indicators SET name=?, kind='crf', level=?, category=?,
                      activity_tags=?, targets=?, status=?, applicability=?, reporting_req=?,
                      output_type=?, unit_interp=?, flexibility=?, follow_value=?, intermediate=?,
                      method=COALESCE(NULLIF(method,''),?), rev=rev+1 WHERE id=?`)
            .run(l.libelle, onglet.level, l.categorie || null, activityTags, cibles || null,
                 status, applicability, reportingReq, outputType, unitInterp, flexibility,
                 followValue, intermediate,
                 actif ? null : "Retiré du cadre de résultats", ex.id);
          bilan.majs++;
        } else {
          await db.prepare(`INSERT INTO indicators (id,code,name,basket,unit,target,direction,
                      method,frequency,kind,level,category,activity_tags,targets,
                      status,applicability,reporting_req,output_type,unit_interp,flexibility,
                      follow_value,intermediate)
                      VALUES (?,?,?,?,?,0,'up',?,?,'crf',?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(newId("ind"), l.code, l.libelle, l.categorie || null, unite,
                 actif ? null : "Retiré du cadre de résultats", null,
                 onglet.level, l.categorie || null, activityTags, cibles || null,
                 status, applicability, reportingReq, outputType, unitInterp, flexibility,
                 followValue, intermediate);
          bilan.crees++;
        }
      }
    }
  });
  return bilan;
}

/* ── 3. Le découpage administratif de Madagascar ─────────────────────
   Le même chemin que la route d'import (`POST /api/geo/shapefile/commit`) :
   la table attributaire construit l'arbre, puis les géométries sont
   STREAMÉES par lots depuis le .shp. Le fichier pèse 23 Mo et porte 1 701
   polygones ; les tenir tous en mémoire d'un coup ferait enfler le
   processus sans aucun gain. */
async function semerDecoupage(){
  if(!existe(SHP)) return { saute:"aucun shapefile dans le dossier docs" };
  const label = "Madagascar — communes (PAM 2025)";
  const dejaLa = await db.prepare("SELECT id FROM geo_version WHERE label=?").get(label);
  if(dejaLa && !FORCE_GEO)
    return { saute:`« ${label} » est déjà chargé (--force-geo pour en créer un nouveau millésime)` };

  const shp = fs.readFileSync(fichier(SHP));
  const dbf = existe(DBF) ? fs.readFileSync(fichier(DBF)) : null;
  const table = lireTable({ dbf });
  const { units, counts, collisions } = buildUnits(table.lignes, { allowDuplicates:false });
  if(!units.length) return { erreur:"aucune unité exploitable dans le shapefile" };

  let versionId, ecrites = 0, rejetes = 0;
  const LOT = 500;
  /* TODO-PG: writeVersion()/writeGeometries() (lib/geo.js, lib/geom.js) ouvrent
     chacune LEUR PROPRE transaction interne (via le même `tx()` que ce fichier) plutôt
     que d'accepter un client à utiliser — sous better-sqlite3 (connexion
     unique) cela ne changeait rien à l'atomicité globale ; sous pg, un batch de
     géométries commit dès la fin de son propre appel, indépendamment des
     autres. Réserve déjà documentée dans lib/tpm.js:regenerate() pour le même
     motif ; signalée ici plutôt que devinée, corriger proprement suppose de
     faire accepter un exécuteur `db` optionnel à ces fonctions, hors périmètre
     des 6 fichiers de cette conversion.

     `parcourirGeometriesShp` (lib/shapefile.js, hors périmètre) reste
     SYNCHRONE : son callback ne peut donc pas `await writeGeometries(...)`
     directement. Pour garder le flux par lots de LOT features (l'intérêt
     documenté ci-dessous — ne jamais tenir les 1 701 polygones en mémoire),
     chaque lot est enchaîné sur une CHAÎNE DE PROMESSES séquentielle plutôt que
     lancé en parallèle : les lots s'écrivent donc toujours dans l'ordre, un
     seul à la fois, et une erreur sur l'un interrompt bien la chaîne — la
     boucle synchrone continue de découper le fichier pendant que le lot
     précédent s'écrit, mais jamais deux lots ne s'écrivent en même temps. */
  let file = Promise.resolve();
  let lot = [], premier = true;
  const vider = () => {
    if(!lot.length) return;
    const features = lot; lot = [];
    const estPremier = premier; premier = false;
    file = file.then(async () => {
      const b = await writeGeometries({ versionId, features, reset:estPremier, source:SHP });
      ecrites += b.écrites; rejetes += b.rejetes || 0;
    });
  };
  versionId = await writeVersion({ label, source:SHP, units, userId:null, makeCurrent:true });
  parcourirGeometriesShp(shp, (i, g) => {
    if(!g) return;
    const at = attributsContour(table.lignes[i]);
    if(!at) return;
    lot.push({ ...at, geometry:g });
    if(lot.length >= LOT) vider();
  });
  vider();
  await file;
  /* Le fichier ne porte QUE les communes, mais sa table attributaire porte
     l'arbre entier : districts, régions et pays sont les mêmes polygones
     réunis par parent. On les dérive donc dans la foulée, sans quoi la carte
     n'aurait qu'un seul niveau de breakdown alors que la donnée en permet
     quatre. */
  const derive = await deriverNiveaux({ versionId });

  return { versionId, unites:units.length, counts, contours:ecrites, rejetes,
           collisions:collisions.length,
           derives: derive.erreur ? null : derive };
}

/* ── Le semis, réutilisable ───────────────────────────────────────────
   Le CLI et la route d'administration passent tous deux par ici. Les options
   remplacent les drapeaux de ligne de commande quand elles sont fournies. Rend
   un bilan chiffré plutôt que d'appeler process.exit — un appel depuis le
   serveur ne doit pas tuer le serveur. `quoi` borne ce qu'on charge :
   « tout » (défaut), « indicateurs » (activités + masterlist), « decoupage ». */
/* ── Indicateurs de suivi de processus, extraits des XLSForms ──
   « Extrais les variables name et label et mets-les dans un référentiel ; une
   fois qu'on clique sur le renflouement, ça entre aussi dedans. » On lit les
   formulaires de suivi de processus déposés dans DOCS et on remplit la table
   `process_indicator`. Le tag d'activité est déduit du nom du fichier. */
const FORMULAIRES_PROCESSUS = [
  { motif:/GD[_ ]?PREVMA|PREVMA/i,            tag:"GD",    label:"Distribution générale / PREVMA" },
  { motif:/SMP|SBP|scolaire/i,                tag:"SMP",   label:"Repas scolaires (SMP)" },
  { motif:/MIARO/i,                           tag:"MIARO", label:"MIARO — Résilience / Production" },
  { motif:/NUTRITION|PECMAM|AIM/i,            tag:"NUT",   label:"Nutrition (PECMAM / AIM)" },
  { motif:/RESILIENCE|SAMS/i,                 tag:"SAMS",  label:"Résilience (SAMS)" },
];
const classerFichierProcessus = (nom) =>
  FORMULAIRES_PROCESSUS.find(f => f.motif.test(nom)) || { tag:"", label:"" };

/* Repère les XLSForms de suivi de processus dans DOCS. */
function fichiersProcessus(){
  try{
    return fs.readdirSync(DOCS)
      .filter(f => /process[_ ]?monitoring|SMP[_ ]?20\d\d/i.test(f) && f.toLowerCase().endsWith(".xlsx"));
  }catch(e){ return []; }
}

async function semerIndicateursProcessus(){
  const fichiers = fichiersProcessus();
  if(!fichiers.length) return { fichiers:0, indicateurs:0, formulaires:[] };

  /* Lecture (asynchrone) d'abord, écriture (transaction) ensuite : ExcelJS lit
     en promesse — inchangé, l'écriture est maintenant elle aussi asynchrone
     (voir tx() plus bas), donc les deux pourraient en principe s'imbriquer,
     mais la lecture complète de tous les fichiers avant d'ouvrir la
     transaction d'écriture reste le comportement d'origine, préservé tel quel. */
  const paquets = [];
  for(const nom of fichiers){
    try{
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(fichier(nom));
      const { formTitle, rows } = extraireIndicateursProcessus(wb);
      const cls = classerFichierProcessus(nom);
      paquets.push({ nom, formTitle, cls, rows });
    }catch(e){ log.warn("XLSForm de processus illisible", { fichier:nom, raison:e.message }); }
  }

  let total = 0; const formulaires = [];
  /* `db.transaction(fn)` (better-sqlite3) n'existe plus : `tx(fn)` (src/db.js)
     est son remplacement direct, déjà importé en tête de fichier.
     `ins` utilisait des paramètres NOMMÉS (@col), propres à better-sqlite3 ;
     convertis en positionnels, dans l'ordre exact des colonnes déclarées
     (active,rev restent des littéraux 1,1, non paramétrés). */
  await tx(async (db) => {
    const ins = db.prepare(`INSERT INTO process_indicator
        (id, activity_tag, activity_label, form_file, form_title, module, module_code,
         var_name, var_type, label, choices_json, ord, active, rev)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`);
    const purge = db.prepare("DELETE FROM process_indicator WHERE form_file=?");
    for(const p of paquets){
      await purge.run(p.nom);
      /* Un même `name` peut réapparaître (questions rejouées dans des répétitions) :
         le référentiel garde la PREMIÈRE occurrence — une variable, une ligne. */
      const vus = new Set(); let ecrits = 0;
      for(const r of p.rows){
        if(vus.has(r.name)) continue; vus.add(r.name);
        await ins.run(newId("pi"), p.cls.tag, p.cls.label, p.nom,
          p.formTitle || "", r.module || "", r.moduleCode || "",
          r.name, r.type || "", r.label || "",
          r.choices ? JSON.stringify(r.choices) : null, r.ord);
        ecrits++;
      }
      total += ecrits;
      const modules = [...new Set(p.rows.map(r => r.module).filter(Boolean))].length;
      formulaires.push({ fichier:p.nom, tag:p.cls.tag, titre:p.formTitle,
        indicateurs:ecrits, modules });
    }
  });
  log.info("indicateurs de suivi de processus chargés",
    { fichiers:fichiers.length, indicateurs:total });
  return { fichiers:fichiers.length, indicateurs:total, formulaires };
}

export async function semerReel({ sansGeo, forceGeo, quoi = "tout" } = {}){
  if(sansGeo !== undefined) SANS_GEO = sansGeo;
  if(forceGeo !== undefined) FORCE_GEO = forceGeo;
  if(!fs.existsSync(DOCS)) return { erreur:"dossier de documents introuvable", dossier:DOCS };

  const bilan = {};
  const veut = (x) => quoi === "tout" || quoi === x;
  if(veut("indicateurs")){
    if(existe(CLASSEUR)){
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(fichier(CLASSEUR));
      bilan.activites = await semerActivites(wb);
      bilan.indicateurs = await semerIndicateurs(wb);
      log.info("activités chargées", bilan.activites);
      log.info("indicateurs chargés", { ...bilan.indicateurs.parNiveau,
        crees:bilan.indicateurs.crees, majs:bilan.indicateurs.majs });
    } else {
      bilan.classeurAbsent = fichier(CLASSEUR);
      log.warn("classeur d'indicateurs absent : activités et indicateurs non chargés",
        { attendu: fichier(CLASSEUR) });
    }
  }

  /* Les indicateurs de suivi de processus suivent le même bouton « indicateurs »
     (ils EN sont) mais restent extractibles seuls via quoi:"processus". */
  if(veut("indicateurs") || veut("processus")){
    bilan.processus = await semerIndicateursProcessus();
    if(bilan.processus.fichiers)
      log.info("suivi de processus chargé", { fichiers:bilan.processus.fichiers,
        indicateurs:bilan.processus.indicateurs });
  }

  if(veut("decoupage")){
    if(SANS_GEO){ log.info("découpage administratif ignoré (--sans-geo)"); }
    else {
      bilan.geo = await semerDecoupage();
      if(bilan.geo.saute) log.warn("découpage non chargé", { raison:bilan.geo.saute });
      else if(bilan.geo.erreur) log.error("découpage refusé", { raison:bilan.geo.erreur });
      else {
        log.info("découpage chargé", { unites:bilan.geo.unites, communes:bilan.geo.counts?.adm3,
          contours:bilan.geo.contours });
        if(bilan.geo.derives?.total) log.info("niveaux supérieurs dérivés", Object.fromEntries(
          bilan.geo.derives.etapes.filter(e => e.ecrites).map(e => [e.niveau, e.ecrites])));
      }
    }
  }

  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,NULL,'semis données réelles','plan','referentiels','import',?)`)
    .run(newId("aud"),
      `Données réelles chargées depuis docs/ — ${bilan.activites?.lues || 0} activité(s), `
      + `${bilan.indicateurs?.lues || 0} indicateur(s)`
      + (bilan.geo?.unites ? `, ${bilan.geo.unites} unité(s) géographiques` : ""));

  const compte = async (t) => (await db.prepare(`SELECT COUNT(*) c FROM ${t}`).get()).c;
  bilan.totaux = { activites: await compte("activity_categories"), indicateurs: await compte("indicators"),
                   unitesGeo: await compte("geo_unit"), contours: await compte("geo_geom") };
  log.info("semis des données réelles terminé", bilan.totaux);
  return bilan;
}

export { semerActivites, semerIndicateurs, semerDecoupage, semerIndicateursProcessus };

/* ── Exécution en ligne de commande ──────────────────────────────────
   Uniquement quand le fichier est lancé directement (`node src/seed-reel.js`),
   jamais quand il est importé par une route. */
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  const r = await semerReel();
  if(r.erreur){ log.error(r.erreur, { dossier:r.dossier }); process.exit(1); }
}
