/* ═══════════════════════════════════════════════════════════════════════
   IMPORT DES SITES PAR TAG — la donnée de base à mapper sur adm 1 à 4

   « Regarde dans "List Sites per Tag" pour les POI/sites par activité, à
   intégrer comme donnée de base à mapper avec la configuration adm 1 à 4 ;
   prévoir une identification liée au point GPS au besoin. »

   Le classeur porte, feuille « Sites », 2 872 points d'intérêt : un nom
   (POIName), un code (POI_code, parfois 0 ou vide), un tag d'activité, le
   chemin administratif adm1→adm4 (noms ET p-codes) et des coordonnées GPS.
   Ce script les verse dans la table `sites`, en les rattachant à l'arbre
   administratif COURANT.

   Trois partis pris, tous vérifiables :

     — Le RATTACHEMENT se fait par le CHEMIN DE NOMS (resolveUnit), comme le
       linker `link-geo.js` : les p-codes du fichier peuvent différer de ceux
       du millésime chargé, mais les noms, eux, se retrouvent dans l'arbre.
       Le `geo_pcode` résolu redonne ensuite les libellés canoniques adm1→adm4.

     — L'IDENTITÉ tient d'abord au POI_code quand il est présent et unique ;
       sinon elle est DÉRIVÉE DU POINT GPS (« GPS<lat>_<lon> »), exactement la
       demande — deux sites au même point restent un doublon qu'on voit, pas
       deux identités inventées. À défaut de tout, un index. Le POI_code
       d'origine est conservé comme `external_code`.

     — Le tag d'activité du fichier (un libellé long : « School feeding
       (on-site) »…) est rapproché du référentiel d'activités par le nom ; s'il
       matche, le site porte le tag et la catégorie réels, sinon le libellé
       brut. On ne rattache jamais à une activité qui n'existe pas.

   Idempotent par `code` : relancé, il met à jour au lieu de dupliquer.

   Usage :  node src/import-sites.js ["List Sites per Tag.xlsx"] [--sheet Sites]
                                     [--dry] [--limit N]
   ═══════════════════════════════════════════════════════════════════════ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import { db, migrate, tx } from "./db.js";
import { log } from "./lib/logger.js";
import { newId } from "./lib/crypto.js";
import { currentVersion, resolveUnit, labelsFor, normalizeName } from "./lib/geo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, def=null) => { const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i+1] && !args[i+1].startsWith("--") ? args[i+1] : true) : def; };
const fichier = args.find(a => !a.startsWith("--") && /\.xlsx?$/i.test(a))
  || path.join(here, "..", "..", "docs", "List Sites per Tag.xlsx");
const nomFeuille = String(flag("sheet") || "Sites");
const dry = !!flag("dry");
const limite = Number(flag("limit")) || Infinity;

if(!fs.existsSync(fichier)){
  console.error(`Fichier introuvable : ${fichier}`);
  console.error(`Usage : node src/import-sites.js ["List Sites per Tag.xlsx"] [--sheet Sites] [--dry]`);
  process.exit(1);
}

/* Les colonnes de la feuille « Sites », par leur en-tête (ligne 2). On lit par
   NOM d'en-tête et non par index fixe : une colonne ajoutée en amont ne décale
   pas la lecture. */
const ENTETES = {
  name:   ["POIName", "POI Name", "Site"],
  code:   ["POI_code", "POI code", "POICode"],
  tag:    ["Activity_tag", "Activity tag", "Tag"],
  adm1:   ["Adm1Name"], adm2:["Adm2Name"], adm3:["Adm3Name"], adm4:["Adm4Name"],
  adm1c:  ["Adm1Code"], adm2c:["Adm2Code"], adm3c:["Adm3Code"], adm4c:["Adm4Code"],
  lat:    ["Latitude", "Lat"], lon:["Longitude", "Lon", "Long"],
  office: ["Field_office", "Field office", "Bureau"],
};

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
const nombre = (v) => { const n = parseFloat(String(txt(v)).replace(",", ".")); return Number.isFinite(n) ? n : null; };

async function main(){
  migrate(path.join(here, "..", "migrations"));

  const version = currentVersion();
  if(!version){
    console.error("Aucun découpage administratif courant : chargez d'abord le shapefile du pays "
      + "(npm run seed:reel, ou l'onglet Pays).");
    process.exit(1);
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fichier);
  const ws = wb.getWorksheet(nomFeuille);
  if(!ws){ console.error(`Feuille « ${nomFeuille} » absente du classeur.`); process.exit(1); }

  /* La ligne d'en-tête : la première qui porte « POIName » (ou un de ses
     synonymes). Les feuilles réelles ont une ligne de titre au-dessus. */
  let ligneEntete = 0, colonne = {};
  for(let r = 1; r <= Math.min(6, ws.rowCount); r++){
    /* `.values` est un tableau 1-based troué : l'index 0 et les cellules vides
       y sont `undefined`. On normalise avant de comparer. */
    const brut = ws.getRow(r).values;
    const cells = Array.from({ length: brut.length }, (_, i) => propre(brut[i]));
    const trouve = {};
    for(const [cle, noms] of Object.entries(ENTETES)){
      const idx = cells.findIndex(c => c && noms.some(n => c.toLowerCase() === n.toLowerCase()));
      if(idx > 0) trouve[cle] = idx;
    }
    if(trouve.name && trouve.tag){ ligneEntete = r; colonne = trouve; break; }
  }
  if(!ligneEntete){
    console.error("En-tête introuvable : la feuille doit porter au moins « POIName » et « Activity_tag ».");
    process.exit(1);
  }

  /* Le référentiel d'activités, pour rapprocher le libellé long du fichier d'un
     tag réel. On indexe par nom normalisé. */
  const activites = db.prepare("SELECT id, name, tag FROM activity_categories").all();
  const actParNom = new Map(activites.map(a => [normalizeName(a.name), a]));
  const rapprocherActivite = (libelle) => {
    const norm = normalizeName(libelle);
    if(!norm) return null;
    if(actParNom.has(norm)) return actParNom.get(norm);
    /* Rapprochement souple : le libellé du fichier contient le nom d'activité,
       ou l'inverse (« School feeding (on-site) » ⊃ « School Feeding »). */
    for(const a of activites){
      const an = normalizeName(a.name);
      if(an && (norm.includes(an) || an.includes(norm))) return a;
    }
    return null;
  };

  /* `existants` (code → id) porte l'idempotence CROISÉE : un code déjà en base
     est mis à jour, pas réinséré. `codesVus` ne dédoublonne QUE ce passage-ci —
     préchargé depuis la base, il empêcherait de RÉUTILISER un code existant et
     ferait tout réinsérer à chaque relance. */
  const existants = new Map(db.prepare("SELECT id, code FROM sites").all().map(r => [r.code, r.id]));
  const codesVus = new Set();

  /* L'identité : POI_code s'il est présent, non nul et unique ; sinon dérivée du
     point GPS ; sinon un index. Le code doit être UNIQUE (contrainte de la table). */
  const codeGps = (lat, lon) => (lat != null && lon != null)
    ? `GPS${lat.toFixed(5)}_${lon.toFixed(5)}`.replace(/[^\w.\-]/g, "") : null;

  const bilan = { lus:0, ecrits:0, crees:0, majs:0, rattaches:0, parGps:0, sansGeo:0,
                  activiteMatch:0, ignores:0 };
  let indexAuto = 0;

  const ins = db.prepare(`INSERT INTO sites
    (id,code,name,status,activity_tag,category_id,program_area,site_type,
     adm1,adm2,adm3,adm4,geo_pcode,urban_area,lat,lon,external_code,antenne)
    VALUES (@id,@code,@name,'Active',@activity_tag,@category_id,@program_area,@site_type,
     @adm1,@adm2,@adm3,@adm4,@geo_pcode,@urban_area,@lat,@lon,@external_code,@antenne)`);
  const upd = db.prepare(`UPDATE sites SET name=@name, activity_tag=@activity_tag,
     category_id=COALESCE(@category_id, category_id),
     adm1=@adm1, adm2=@adm2, adm3=@adm3, adm4=@adm4, geo_pcode=@geo_pcode,
     lat=COALESCE(@lat,lat), lon=COALESCE(@lon,lon),
     external_code=COALESCE(@external_code, external_code), antenne=@antenne,
     rev=rev+1, updated_at=datetime('now') WHERE id=@id`);

  const lignes = [];
  for(let r = ligneEntete + 1; r <= ws.rowCount && lignes.length < limite; r++){
    const row = ws.getRow(r);
    const g = (cle) => colonne[cle] ? propre(row.getCell(colonne[cle]).value) : "";
    const name = g("name");
    if(!name) continue;                       /* ligne vide mise en forme */
    lignes.push({
      name, poiCode: g("code"), tag: g("tag"),
      adm1: g("adm1"), adm2: g("adm2"), adm3: g("adm3"), adm4: g("adm4"),
      lat: nombre(row.getCell(colonne.lat)?.value), lon: nombre(row.getCell(colonne.lon)?.value),
      office: g("office"),
    });
  }
  bilan.lus = lignes.length;

  const ecrire = () => tx(() => {
    for(const l of lignes){
      /* Rattachement par chemin de noms → p-code du millésime courant. */
      const res = resolveUnit({ adm1:l.adm1, adm2:l.adm2, adm3:l.adm3, adm4:l.adm4 }, version.id);
      const geoPcode = res.pcode || null;
      const lab = geoPcode ? labelsFor(geoPcode, version.id) : null;
      if(geoPcode) bilan.rattaches++; else bilan.sansGeo++;

      /* Identité : POI_code valide et unique, sinon GPS, sinon index. */
      let code = "";
      const brut = String(l.poiCode || "").trim();
      if(brut && brut !== "0" && !codesVus.has(brut)) code = brut;
      else {
        const gps = codeGps(l.lat, l.lon);
        if(gps && !codesVus.has(gps)){ code = gps; bilan.parGps++; }
        else { do { code = `POI-${String(++indexAuto).padStart(5,"0")}`; } while(codesVus.has(code)); }
      }
      codesVus.add(code);

      const act = rapprocherActivite(l.tag);
      if(act) bilan.activiteMatch++;

      const rec = {
        id: existants.get(code) || newId("site"),
        code, name: l.name,
        activity_tag: act ? act.tag : (l.tag ? l.tag.slice(0, 40) : null),
        category_id: act ? act.id : null,
        program_area: null, site_type: null,
        /* Libellés canoniques du référentiel quand le rattachement a réussi ;
           sinon les noms du fichier, pour ne pas perdre l'information. */
        adm1: lab?.adm1 || l.adm1 || null, adm2: lab?.adm2 || l.adm2 || null,
        adm3: lab?.adm3 || l.adm3 || null, adm4: lab?.adm4 || l.adm4 || null,
        geo_pcode: geoPcode,
        urban_area: "Non",
        lat: l.lat ?? lab?.lat ?? null, lon: l.lon ?? lab?.lon ?? null,
        external_code: brut && brut !== "0" ? brut : null,
        antenne: l.office || null,
      };
      if(dry) continue;
      if(existants.has(code)){ upd.run(rec); bilan.majs++; }
      else { ins.run(rec); existants.set(code, rec.id); bilan.crees++; }
      bilan.ecrits++;
    }
  })();   /* `tx` rend la transaction ; il faut l'exécuter — le `()` manquant écrivait zéro. */

  if(dry){
    /* En simulation on parcourt quand même pour compter le rattachement. */
    for(const l of lignes){
      const res = resolveUnit({ adm1:l.adm1, adm2:l.adm2, adm3:l.adm3, adm4:l.adm4 }, version.id);
      if(res.pcode) bilan.rattaches++; else bilan.sansGeo++;
      if(rapprocherActivite(l.tag)) bilan.activiteMatch++;
    }
  } else {
    ecrire();
  }

  log.info(dry ? "import des sites (simulation)" : "import des sites terminé", {
    fichier: path.basename(fichier), millesime: version.label,
    lus: bilan.lus, crees: bilan.crees, majs: bilan.majs,
    rattaches: bilan.rattaches, sansGeo: bilan.sansGeo,
    identiteParGps: bilan.parGps, activiteReconnue: bilan.activiteMatch });
  return bilan;
}

main().catch(e => { log.error("import des sites en échec", { erreur: e.message }); process.exit(1); });
