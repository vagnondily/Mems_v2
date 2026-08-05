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
/* Même résolution de source que seed-reel : `MEMS_DATA_DIR`, puis `data/` s'il
   porte le classeur, puis `docs/`. Un chemin explicite en argument prime sur tout. */
const sourceSites = () => {
  const base = process.env.MEMS_DATA_DIR ? path.resolve(process.env.MEMS_DATA_DIR)
    : (() => { const d = path.join(here, "..", "..", "data");
        try{ if(fs.existsSync(path.join(d, "List Sites per Tag.xlsx"))) return d; }catch(e){}
        return path.join(here, "..", "..", "docs"); })();
  return path.join(base, "List Sites per Tag.xlsx");
};
const fichier = args.find(a => !a.startsWith("--") && /\.xlsx?$/i.test(a)) || sourceSites();
const nomFeuille = String(flag("sheet") || "Sites");
const dry = !!flag("dry");
const limite = Number(flag("limit")) || Infinity;

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

/* Réutilisable : le CLI ET la route d'administration l'appellent. Rend un bilan
   (ou `{ erreur }`) plutôt que d'appeler process.exit — un import lancé par le
   serveur ne doit pas tuer le serveur. */
export async function importerSites(){
  await migrate(path.join(here, "..", "migrations"));
  if(!fs.existsSync(fichier)) return { erreur:`Fichier introuvable : ${fichier}` };

  const version = await currentVersion();
  if(!version) return { erreur:"Aucun découpage administratif courant : chargez d'abord le shapefile du pays." };

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fichier);
  const ws = wb.getWorksheet(nomFeuille);
  if(!ws) return { erreur:`Feuille « ${nomFeuille} » absente du classeur.` };

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
  if(!ligneEntete)
    return { erreur:"En-tête introuvable : la feuille doit porter au moins « POIName » et « Activity_tag »." };

  /* Le référentiel d'activités, pour rapprocher le libellé long du fichier d'un
     tag réel. On indexe par nom normalisé. */
  const activites = await db.prepare("SELECT id, name, tag FROM activity_categories").all();
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
  const existants = new Map((await db.prepare("SELECT id, code FROM sites").all()).map(r => [r.code, r.id]));
  const codesVus = new Set();

  /* L'identité : POI_code s'il est présent, non nul et unique ; sinon dérivée du
     point GPS ; sinon un index. Le code doit être UNIQUE (contrainte de la table). */
  const codeGps = (lat, lon) => (lat != null && lon != null)
    ? `GPS${lat.toFixed(5)}_${lon.toFixed(5)}`.replace(/[^\w.\-]/g, "") : null;

  const bilan = { lus:0, ecrits:0, crees:0, majs:0, rattaches:0, parGps:0, sansGeo:0,
                  activiteMatch:0, ignores:0 };
  let indexAuto = 0;

  /* Les deux requêtes ci-dessous (préparées plus bas, DANS la transaction)
     utilisaient des paramètres NOMMÉS (@col), propres à better-sqlite3 : db.js
     ne traduit que des `?` positionnels (voir l'en-tête de src/db.js).
     Converties en positionnels ; pour `ins`, l'ordre des propriétés de `rec`
     (plus bas) est construit dans le MÊME ORDRE que la liste de colonnes, donc
     `Object.values(rec)` s'y accorde sans qu'on réordonne rien. Pour `upd`,
     l'ordre des `?` suit l'ordre d'apparition dans le texte SQL, listé
     explicitement à l'appel.

     Elles sont préparées à l'intérieur de `tx(async (db) => …)`, avec le `db`
     de la transaction, et non plus avec l'import de module comme avant cette
     conversion : sous better-sqlite3 une seule connexion physique existe, donc
     peu importait par quel `db` une requête était préparée — tout passait par
     elle. Sous pg, une transaction vit sur un client DÉDIÉ (voir src/db.js) ;
     les préparer avec l'import de module les ferait exécuter sur une autre
     connexion du pool, hors de cette transaction, et un rollback ne les
     annulerait plus. Les garder sur le client de la transaction est ce qui
     préserve exactement le comportement atomique d'origine. */

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

  const ecrire = () => tx(async (db) => {
    const ins = db.prepare(`INSERT INTO sites
      (id,code,name,status,activity_tag,category_id,program_area,site_type,
       adm1,adm2,adm3,adm4,geo_pcode,urban_area,lat,lon,external_code,antenne)
      VALUES (?,?,?,'Active',?,?,?,?,
       ?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE sites SET name=?, activity_tag=?,
       category_id=COALESCE(?, category_id),
       adm1=?, adm2=?, adm3=?, adm4=?, geo_pcode=?,
       lat=COALESCE(?,lat), lon=COALESCE(?,lon),
       external_code=COALESCE(?, external_code), antenne=?,
       rev=rev+1, updated_at=now() WHERE id=?`);
    for(const l of lignes){
      /* Rattachement par chemin de noms → p-code du millésime courant.
         TODO-PG: resolveUnit()/labelsFor() (lib/geo.js) parlent à la base via
         l'import direct de ../db.js (le pool), pas via le client de cette
         transaction — même réserve documentée dans lib/tpm.js:regenerate().
         Sans conséquence ici (elles ne font que LIRE le référentiel géo, déjà
         committé avant cet import), mais signalé plutôt que deviné. */
      const res = await resolveUnit({ adm1:l.adm1, adm2:l.adm2, adm3:l.adm3, adm4:l.adm4 }, version.id);
      const geoPcode = res.pcode || null;
      const lab = geoPcode ? await labelsFor(geoPcode, version.id) : null;
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
      if(existants.has(code)){
        await upd.run(rec.name, rec.activity_tag, rec.category_id, rec.adm1, rec.adm2, rec.adm3, rec.adm4,
          rec.geo_pcode, rec.lat, rec.lon, rec.external_code, rec.antenne, rec.id);
        bilan.majs++;
      }
      else { await ins.run(...Object.values(rec)); existants.set(code, rec.id); bilan.crees++; }
      bilan.ecrits++;
    }
  });   /* `tx` exécute la transaction directement (elle est maintenant `async`, pas une usine à fonction) : il faut l'attendre — voir l'appel plus bas. */

  if(dry){
    /* En simulation on parcourt quand même pour compter le rattachement. */
    for(const l of lignes){
      const res = await resolveUnit({ adm1:l.adm1, adm2:l.adm2, adm3:l.adm3, adm4:l.adm4 }, version.id);
      if(res.pcode) bilan.rattaches++; else bilan.sansGeo++;
      if(rapprocherActivite(l.tag)) bilan.activiteMatch++;
    }
  } else {
    await ecrire();
  }

  log.info(dry ? "import des sites (simulation)" : "import des sites terminé", {
    fichier: path.basename(fichier), millesime: version.label,
    lus: bilan.lus, crees: bilan.crees, majs: bilan.majs,
    rattaches: bilan.rattaches, sansGeo: bilan.sansGeo,
    identiteParGps: bilan.parGps, activiteReconnue: bilan.activiteMatch });
  return bilan;
}

/* Lancé directement en ligne de commande, pas quand une route l'importe. */
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  const r = await importerSites();
  if(r?.erreur){ log.error("import des sites en échec", { erreur:r.erreur }); process.exit(1); }
}
