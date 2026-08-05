import { z } from "zod";
import ExcelJS from "exceljs";
/* JSZip est la bibliothèque d'archives d'ExcelJS lui-même : l'importer ici
   n'ajoute aucune dépendance, et garantit qu'on lit l'archive exactement comme
   la lira ExcelJS un instant plus tard. */
import JSZip from "jszip";
import { db, tx } from "../db.js";
import { newId } from "./crypto.js";
import { ecrireEntrees } from "./codes.js";
import { MOTIF_SOURCE_RESERVEE, estSourceReservee } from "./alias.js";
import { currentVersion, resolveUnit, labelsFor } from "./geo.js";
import { scopeOf, unitsIn } from "./scope.js";

/* ═══════════════════════════════════════════════════════════════════════
   Import par fichier — définition des types.

   Principe directeur : on réconcilie par CLÉ MÉTIER, jamais par position dans
   le fichier et jamais par remplacement de collection. Conséquence directe :
   deux bureaux qui téléversent le même mois touchent des clés disjointes et ne
   s'effacent pas mutuellement. Une ligne absente du fichier n'est pas supprimée.

   Le modèle est pré-rempli avec les lignes du périmètre de l'utilisateur, et la
   colonne de clé est verrouillée : il remplit des cases, il ne saisit pas de clé.

   ── La portée : ce que le cadre supposait sans le dire ───────────────
   Le cadre a été écrit pour deux types dont la clé est un p-code géographique,
   et trois hypothèses en avaient découlé, câblées : une ligne sans p-code connu
   du millésime est rejetée, une ligne hors du périmètre du bureau aussi, et il
   faut un millésime courant plus une unité dans le périmètre pour seulement
   produire un modèle. Elles sont justes pour `caseload` et `pdd` ; elles n'ont
   aucun sens pour un référentiel de codes école, dont les entrées ne portent
   souvent AUCUNE géographie — c'est même la raison d'être de ce référentiel.

   D'où `portee`, déclarée EXPLICITEMENT sur chacun des trois types plutôt que
   déduite d'une absence : c'est une décision de cloisonnement, elle se lit, elle
   ne se devine pas. « geo » conserve les cinq gardes ; « national » les
   débranche, et l'écriture est alors réservée à `admin` (voir le type `codes`).
   ═══════════════════════════════════════════════════════════════════════ */

const NUM = (max = 1e9) => z.preprocess(
  v => (v === "" || v == null ? 0 : typeof v === "string" ? Number(String(v).replace(/[  ]/g, "")) : v),
  z.number().int().min(0).max(max));

const STR = (max = 200) => z.preprocess(
  v => (v == null ? "" : String(v).trim()), z.string().max(max));

/* ── Type « population et ciblage » ────────────────────────────────── */
const caseload = {
  label: "Population et ciblage",
  cap: "edit",
  portee: "geo",
  /* La clé métier : une unité, une période, une activité. */
  key: (r) => `${r.geo_pcode}|${r.year}|${r.month ?? ""}|${r.activity_tag}`,
  columns: [
    { header:"P-code",           field:"geo_pcode", width:18, locked:true, key:true,
      hint:"Ne pas modifier : c'est la clé de rapprochement" },
    { header:"Région",           field:"adm1",  width:20, locked:true, info:true },
    { header:"District",         field:"adm2",  width:20, locked:true, info:true },
    { header:"Commune",          field:"adm3",  width:20, locked:true, info:true },
    { header:"Année",            field:"year",  width:8,  locked:true, key:true },
    { header:"Mois",             field:"month", width:10, key:true,
      hint:"Vide = valeur annuelle. Sinon 1 à 12." },
    { header:"Activité",         field:"activity_tag", width:12, key:true,
      hint:"Vide = total toutes activités, dédoublonné" },
    { header:"Population",       field:"population",  width:14 },
    { header:"Ménages",          field:"households",  width:12 },
    { header:"Personnes ciblées",field:"targeted",    width:17 },
    { header:"Ménages ciblés",   field:"targeted_hh", width:15 },
    { header:"Source",           field:"source",      width:30,
      hint:"D'où viennent ces chiffres : INSTAT RGPH-3, projection, enquête…" },
  ],
  schema: z.object({
    geo_pcode: z.string().min(1).max(64),
    year: z.coerce.number().int().min(2000).max(2100),
    /* Le fichier porte les mois de 1 à 12 ; la base les stocke de 0 à 11. */
    month: z.preprocess(v => {
      if(v === "" || v == null) return null;
      const n = Number(v); return Number.isFinite(n) ? n - 1 : NaN;
    }, z.number().int().min(0).max(11).nullable()),
    activity_tag: STR(20),
    population: NUM(), households: NUM(), targeted: NUM(), targeted_hh: NUM(),
    source: STR(200),
  }),
  /* Contrôles métier, au-delà de la forme. */
  check: (r) => {
    if(r.targeted > r.population && r.population > 0)
      return { field:"Personnes ciblées",
        message:`${r.targeted.toLocaleString("fr-FR")} ciblés pour ${r.population.toLocaleString("fr-FR")} habitants` };
    if(r.targeted_hh > r.households && r.households > 0)
      return { field:"Ménages ciblés",
        message:`${r.targeted_hh.toLocaleString("fr-FR")} ménages ciblés pour ${r.households.toLocaleString("fr-FR")}` };
    return null;
  },
  /* État courant, indexé par clé, pour calculer le diff. */
  current: async (scope) => {
    const rows = await db.prepare("SELECT * FROM caseload").all();
    const out = {};
    for(const c of rows){
      if(scope && !scope.has(c.geo_pcode)) continue;
      out[`${c.geo_pcode}|${c.year}|${c.month ?? ""}|${c.activity_tag}`] = c;
    }
    return out;
  },
  compare: ["population","households","targeted","targeted_hh","source"],
  /* Le modèle liste toutes les activités possibles pour chaque unité. Celles que
     l'utilisateur ne remplit pas ne doivent pas créer de lignes à zéro : elles
     n'ont rien à dire, ce n'est pas la même chose qu'un chiffre nul mesuré. */
  blank: (r) => !r.population && !r.households && !r.targeted && !r.targeted_hh && !r.source,
  /* `exec` : l'exécuteur de requêtes. commitBatch nous passe SON client de
     transaction pour que ces écritures partagent le même ROLLBACK que la mise à
     jour du lot ; à défaut (appel direct), le pool. */
  apply: async (rows, ctx, exec = db) => {
    const find = exec.prepare(`SELECT id FROM caseload
      WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS ?`);
    const ins = exec.prepare(`INSERT INTO caseload
      (id,geo_pcode,level,year,month,activity_tag,population,households,targeted,targeted_hh,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = exec.prepare(`UPDATE caseload SET population=?, households=?, targeted=?,
      targeted_hh=?, source=?, rev=rev+1, updated_at=now() WHERE id=?`);
    let crees = 0, modifies = 0;
    for(const x of rows){
      const cur = await find.get(x.geo_pcode, x.year, x.activity_tag, x.month);
      if(cur){ await upd.run(x.population, x.households, x.targeted, x.targeted_hh, x.source || null, cur.id); modifies++; }
      else { await ins.run(newId("cl"), x.geo_pcode, x.level || "adm3", x.year, x.month, x.activity_tag,
        x.population, x.households, x.targeted, x.targeted_hh, x.source || null); crees++; }
    }
    return { crees, modifies };
  },
  /* Lignes du modèle : une par unité du périmètre, pour l'année courante. */
  seed: async ({ year, units, tags }) => {
    const out = [];
    for(const u of units){
      const l = labelsFor(u.pcode);
      for(const tag of ["", ...tags]){
        const cur = await db.prepare(`SELECT * FROM caseload
          WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS NULL`).get(u.pcode, year, tag);
        out.push({ geo_pcode:u.pcode, adm1:l.adm1, adm2:l.adm2, adm3:l.adm3,
          year, month:"", activity_tag:tag,
          population:cur?.population ?? "", households:cur?.households ?? "",
          targeted:cur?.targeted ?? "", targeted_hh:cur?.targeted_hh ?? "",
          source:cur?.source ?? "" });
      }
    }
    return out;
  },
};

/* ── Type « plan de distribution » ─────────────────────────────────── */
const pdd = {
  label: "Plan de distribution",
  cap: "edit",
  portee: "geo",
  key: (r) => `${r.geo_pcode}|${r.year}|${r.month}|${r.act_type}|${r.modality}`,
  columns: [
    { header:"P-code",       field:"geo_pcode", width:18, locked:true, key:true,
      hint:"Ne pas modifier : c'est la clé de rapprochement" },
    { header:"Région",       field:"adm1",    width:18, locked:true, info:true },
    { header:"District",     field:"adm2",    width:18, locked:true, info:true },
    { header:"Commune",      field:"adm3",    width:18, locked:true, info:true },
    { header:"Année",        field:"year",    width:8,  locked:true, key:true },
    { header:"Mois",         field:"month",   width:8,  key:true, hint:"1 à 12" },
    { header:"Type",         field:"act_type",width:12, key:true, enum:["GD","PREVMA"] },
    { header:"Modalité",     field:"modality",width:12, key:true, enum:["Food","Cash","Voucher"] },
    { header:"Bureau",       field:"bureau",  width:14 },
    { header:"Produit",      field:"commodity", width:20 },
    { header:"Jours",        field:"days",    width:8 },
    { header:"Bénéf. planifiés", field:"benef_planned", width:17 },
    { header:"Ménages",      field:"households", width:12 },
    { header:"Tonnage (t)",  field:"tonnage", width:12 },
    { header:"Montant",      field:"amount",  width:14 },
    { header:"Bénéf. servis",field:"benef_actual", width:14 },
    { header:"Reçu",         field:"received",width:12 },
    { header:"Distribué",    field:"distributed", width:12 },
    { header:"Statut",       field:"status",  width:12,
      enum:["planned","ongoing","done","cancelled"] },
  ],
  schema: z.object({
    geo_pcode: z.string().min(1).max(64),
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.preprocess(v => { const n = Number(v); return Number.isFinite(n) ? n - 1 : NaN; },
      z.number().int().min(0).max(11)),
    act_type: z.string().min(1).max(40),
    modality: z.enum(["Food","Cash","Voucher"]),
    bureau: STR(120), commodity: STR(120),
    days: NUM(366), benef_planned: NUM(), households: NUM(),
    tonnage: z.preprocess(v => (v === "" || v == null ? 0 : Number(v)), z.number().min(0)),
    amount:  z.preprocess(v => (v === "" || v == null ? 0 : Number(v)), z.number().min(0)),
    benef_actual: NUM(),
    received:    z.preprocess(v => (v === "" || v == null ? 0 : Number(v)), z.number().min(0)),
    distributed: z.preprocess(v => (v === "" || v == null ? 0 : Number(v)), z.number().min(0)),
    status: z.enum(["planned","ongoing","done","cancelled"]).default("planned"),
  }),
  check: (r) => {
    if(r.benef_actual > r.benef_planned * 1.5 && r.benef_planned > 0)
      return { field:"Bénéf. servis",
        message:`${r.benef_actual.toLocaleString("fr-FR")} servis pour ${r.benef_planned.toLocaleString("fr-FR")} planifiés — écart supérieur à 50 %` };
    if(r.distributed > r.received && r.received > 0)
      return { field:"Distribué", message:`distribué (${r.distributed}) supérieur au reçu (${r.received})` };
    return null;
  },
  current: async (scope) => {
    const rows = await db.prepare("SELECT * FROM pdd WHERE geo_pcode IS NOT NULL").all();
    const out = {};
    for(const p of rows){
      if(scope && !scope.has(p.geo_pcode)) continue;
      out[`${p.geo_pcode}|${p.year}|${p.month}|${p.act_type}|${p.modality}`] = p;
    }
    return out;
  },
  compare: ["bureau","commodity","days","benef_planned","households","tonnage","amount",
            "benef_actual","received","distributed","status"],
  blank: (r) => !r.benef_planned && !r.benef_actual && !r.households
             && !r.tonnage && !r.amount && !r.days,
  /* `exec` : cf. caseload.apply — le client de transaction de commitBatch, ou le
     pool à défaut. */
  apply: async (rows, ctx, exec = db) => {
    const find = exec.prepare(`SELECT id FROM pdd
      WHERE geo_pcode=? AND year=? AND month=? AND act_type=? AND modality=?`);
    const ins = exec.prepare(`INSERT INTO pdd
      (id,year,month,act_type,activity_tag,office_id,bureau,geo_pcode,region,district,commune,
       modality,commodity,days,benef_planned,households,tonnage,amount,benef_actual,received,
       distributed,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = exec.prepare(`UPDATE pdd SET bureau=?, commodity=?, days=?, benef_planned=?,
      households=?, tonnage=?, amount=?, benef_actual=?, received=?, distributed=?, status=?,
      rev=rev+1, updated_at=now() WHERE id=?`);
    let crees = 0, modifies = 0;
    for(const x of rows){
      const cur = await find.get(x.geo_pcode, x.year, x.month, x.act_type, x.modality);
      if(cur){
        await upd.run(x.bureau || null, x.commodity || null, x.days, x.benef_planned, x.households,
          x.tonnage, x.amount, x.benef_actual, x.received, x.distributed, x.status, cur.id);
        modifies++;
      } else {
        const l = labelsFor(x.geo_pcode);
        await ins.run(newId("pdd"), x.year, x.month, x.act_type,
          x.act_type === "GD" ? "URT_GD" : "URT_PREV", ctx.officeId || null,
          x.bureau || "—", x.geo_pcode, l.adm1 || null, l.adm2 || null, l.adm3 || null,
          x.modality, x.commodity || null, x.days, x.benef_planned, x.households,
          x.tonnage, x.amount, x.benef_actual, x.received, x.distributed, x.status);
        crees++;
      }
    }
    return { crees, modifies };
  },
  seed: async ({ year, units }) => {
    const out = [];
    for(const u of units){
      const l = labelsFor(u.pcode);
      const rows = await db.prepare(`SELECT * FROM pdd WHERE geo_pcode=? AND year=? ORDER BY month`)
        .all(u.pcode, year);
      if(rows.length){
        for(const p of rows) out.push({ geo_pcode:u.pcode, adm1:l.adm1, adm2:l.adm2, adm3:l.adm3,
          year, month:p.month+1, act_type:p.act_type, modality:p.modality, bureau:p.bureau,
          commodity:p.commodity||"", days:p.days, benef_planned:p.benef_planned,
          households:p.households, tonnage:p.tonnage, amount:p.amount,
          benef_actual:p.benef_actual, received:p.received, distributed:p.distributed,
          status:p.status });
      } else {
        out.push({ geo_pcode:u.pcode, adm1:l.adm1, adm2:l.adm2, adm3:l.adm3, year, month:"",
          act_type:"GD", modality:"Food", bureau:"", commodity:"", days:"", benef_planned:"",
          households:"", tonnage:"", amount:"", benef_actual:"", received:"", distributed:"",
          status:"planned" });
      }
    }
    return out;
  },
};

/* ── Type « référentiel de codes d'identification » ────────────────────
   Le troisième occupant du cadre, et le premier de portée nationale. Il charge
   les listes de codes que les formulaires emploient pour désigner un site sans
   passer par le référentiel p-code : les 1 251 codes école de SMP d'abord, les
   247 codes ZAP ensuite, les suivants sans nouvelle ligne de code.

   Le droit exigé est `admin`, plus élevé que les deux autres types. La raison
   n'est pas la difficulté du geste mais sa portée : un référentiel national
   chargé de travers empoisonne le rattachement de TOUS les bureaux, pas
   seulement de celui qui l'a chargé. Même arbitrage que POST /api/geo/bulk. */
const codes = {
  label: "Référentiel de codes d'identification",
  cap: "admin",
  portee: "national",
  key: (r) => `${r.referentiel}|${r.code}`,
  /* « Code » EN PREMIER, et ce n'est pas un détail de présentation : le garde de
     ligne blanche sonde la PREMIÈRE colonne `key:true` du tableau. Avec
     « Référentiel » en tête — colonne pré-remplie —, toute ligne dont le code est
     resté vide serait analysée puis rejetée, et le compte de rejets mentirait. */
  columns: [
    { header:"Code",        field:"code",        width:16, key:true,
      hint:"Le code tel que la source l'écrit — c'est lui la clé" },
    { header:"Référentiel", field:"referentiel", width:18, locked:true, key:true,
      hint:"rempli, ne pas modifier" },
    { header:"Libellé",     field:"libelle",     width:36,
      hint:"Le nom de l'école, du point, de la zone…" },
    { header:"P-code",      field:"geo_pcode",   width:18,
      hint:"Facultatif : beaucoup de ces codes n'ont aucune géographie connue" },
    { header:"Région",      field:"adm1",        width:18, info:true },
    { header:"District",    field:"adm2",        width:18, info:true },
    { header:"Commune",     field:"adm3",        width:18, info:true },
    { header:"Fokontany",   field:"adm4",        width:18, info:true },
    { header:"Code du site MEMS", field:"site_code", width:18,
      hint:"À ne remplir que pour FORCER le rattachement à un site précis" },
    { header:"Source",      field:"source",      width:24,
      hint:"D'où vient cette liste : fichier du bureau, note officielle…" },
    { header:"Note",        field:"note",        width:30 },
  ],
  schema: z.object({
    /* Les codes SMP sont des ENTIERS dans les fichiers du bureau (603140007) et
       un tableur les livre en nombre. Les refuser obligerait l'opérateur à
       reformater sa colonne, donc à se tromper une fois. */
    code: z.preprocess(v => (v == null ? "" : String(v).trim()),
      z.string().min(1).max(80)),
    referentiel: z.preprocess(v => (v == null ? "" : String(v).trim()),
      z.string()
        .min(1, "référentiel absent de la ligne et de la feuille d'identification du "
              + "fichier : téléchargez le modèle plutôt que de recréer le fichier")
        .max(60)
        .refine(v => !estSourceReservee(v), MOTIF_SOURCE_RESERVEE)),
    libelle: STR(200), geo_pcode: STR(64),
    adm1: STR(120), adm2: STR(120), adm3: STR(120), adm4: STR(120),
    site_code: STR(40), source: STR(120), note: STR(300),
  }),
  /* Le seul contrôle métier possible ici : une géographie DÉCLARÉE doit exister.
     Une géographie absente n'est pas une erreur — c'est le cas SMP, et la raison
     pour laquelle ce référentiel existe. Sans millésime courant, il n'y a rien
     contre quoi vérifier : ne pas rejeter, sous peine de faire rentrer par la
     fenêtre la dépendance géographique que la portée nationale vient d'ôter. */
  check: async (r) => {
    if(!r.geo_pcode) return null;
    const v = currentVersion();
    if(!v) return null;
    const connu = await db.prepare("SELECT 1 FROM geo_unit WHERE version_id=? AND pcode=?")
      .get(v.id, r.geo_pcode);
    return connu ? null : { field:"P-code",
      message:`« ${r.geo_pcode} » est absent du millésime courant du référentiel géographique — `
        + "laissez la colonne vide si vous ne connaissez pas l'unité" };
  },
  /* Indexé par la clé métier, tous référentiels confondus : la clé les distingue
     déjà, et deux référentiels ne peuvent pas se marcher dessus. */
  current: async () => {
    const out = {};
    for(const e of await db.prepare("SELECT * FROM code_referentiel").all())
      out[`${e.referentiel}|${e.code}`] = e;
    return out;
  },
  compare: ["libelle","geo_pcode","adm1","adm2","adm3","adm4","site_code","source","note"],
  /* Pas de `blank` : une entrée sans libellé reste une entrée. Un code seul, sans
     rien d'autre, est déjà une information — c'est le code que la source emploie,
     et le rapprochement saura peut-être le rattacher par son seul préfixe. */
  /* TODO-PG: `ecrireEntrees` vit dans lib/codes.js (hors du périmètre de ce
     passage) et écrit encore par le `db` importé au niveau de SON module — le
     pool — sans accepter d'exécuteur. On lui relaie donc `exec`, mais tant que
     lib/codes.js ne le prend pas en compte, l'écriture d'un référentiel de codes
     ne partage PAS le ROLLBACK de commitBatch (contrairement à caseload/pdd
     ci-dessus). À corriger côté lib/codes.js : faire accepter à `ecrireEntrees`
     un exécuteur optionnel, exactement comme regenerate() dans lib/tpm.js. */
  apply: async (rows, ctx, exec = db) => ecrireEntrees(rows, ctx, exec),
  /* Les entrées DÉJÀ chargées pour ce référentiel : le modèle sert donc aussi à
     corriger une liste existante. Au tout premier chargement il rend zéro ligne,
     et c'est pour ce cas que `completer` existe — sans lui, aucune ligne collée
     par l'opérateur ne porterait le nom du référentiel. */
  seed: async ({ referentiel }) => await db.prepare(
    `SELECT code, referentiel, libelle, geo_pcode, adm1, adm2, adm3, adm4,
            site_code, source, note
     FROM code_referentiel WHERE referentiel=? ORDER BY code`).all(referentiel || ""),
  /* ── Les deux crochets facultatifs du cadre ──────────────────────────
     `completer` fait hériter la ligne d'une constante du lot, lue dans la
     feuille d'identification. Le cas normal est un opérateur qui colle 1 251
     lignes portant code et libellé : lui demander de recopier le nom du
     référentiel sur chacune serait inventer une corvée. Une valeur écrite sur la
     ligne l'emporte toujours — un fichier peut légitimement en mêler deux. */
  completer: (values, ctx) => {
    const ecrit = String(values.referentiel ?? "").trim();
    if(ecrit || !ctx?.referentiel) return values;
    return { ...values, referentiel: ctx.referentiel };
  },
  /* Ce qui identifie une ligne dans l'aperçu des rejets. Sans lui, la colonne
     « Unité » resterait vide pour tout type non géographique, et l'opérateur
     lirait vingt motifs sans savoir de quelles lignes ils parlent. */
  designation: (p) => [p?.code, p?.libelle].filter(Boolean).join(" — "),
};

export const KINDS = { caseload, pdd, codes };

/* ── Modèle Excel ────────────────────────────────────────────────────
   Pré-rempli, colonnes de clé verrouillées, listes déroulantes sur les
   énumérations, et une cellule cachée qui identifie le type et le millésime :
   un modèle périmé est refusé avec un message clair plutôt qu'importé de travers. */
export async function buildTemplate(kind, ctx){
  const def = KINDS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = "MEMS"; wb.created = new Date();

  const ws = wb.addWorksheet("Saisie", {
    views: [{ state:"frozen", xSplit:1, ySplit:2 }],
    pageSetup: { orientation:"landscape", fitToPage:true },
  });

  /* Ligne 1 : intitulés. Ligne 2 : aide de saisie.

     Le verrou est porté par la COLONNE et non par les seules cellules
     pré-remplies. Sans cela, un modèle dont `seed()` ne rend aucune ligne — le
     premier chargement d'un référentiel de codes, exactement le cas pour lequel
     il existe — sortait entièrement verrouillé : la boucle `rows.forEach`
     ci-dessous ne s'exécutant pas, aucune cellule ne recevait `locked:false`, et
     le tableur refusait la frappe comme le collage sur toute la zone de saisie.
     Un style de colonne, lui, s'applique aux cellules encore vides. */
  ws.columns = def.columns.map(c => ({ key:c.field, width:c.width || 14,
    style: { protection: { locked: !!c.locked } } }));
  const head = ws.getRow(1);
  const hint = ws.getRow(2);
  def.columns.forEach((c, i) => {
    const cell = head.getCell(i+1);
    cell.value = c.header;
    /* Les deux lignes d'en-tête restent verrouillées quoi qu'il arrive : elles
       ne sont pas de la saisie, et `readUpload` reconnaît les colonnes par leur
       intitulé — un intitulé réécrit fait échouer l'import entier. */
    cell.protection = { locked:true };
    cell.font = { bold:true, color:{ argb:"FFFFFFFF" }, size:10 };
    cell.fill = { type:"pattern", pattern:"solid",
      fgColor:{ argb: c.locked ? "FF5A6872" : "FF085387" } };
    cell.alignment = { vertical:"middle", horizontal:"center", wrapText:true };
    cell.border = { bottom:{ style:"thin", color:{ argb:"FFCBD5E1" } } };

    const h = hint.getCell(i+1);
    h.value = c.hint || (c.locked ? "rempli, ne pas modifier" : c.enum ? c.enum.join(" / ") : "");
    h.protection = { locked:true };
    h.font = { italic:true, size:8, color:{ argb:"FF8C9BA5" } };
    h.alignment = { vertical:"top", wrapText:true };
  });
  head.height = 32; hint.height = 26;

  /* Lignes de données, pré-remplies. */
  const rows = await def.seed(ctx);
  rows.forEach(r => {
    const row = ws.addRow(def.columns.map(c => r[c.field] ?? ""));
    def.columns.forEach((c, i) => {
      const cell = row.getCell(i+1);
      cell.font = { size:10 };
      if(c.locked){
        /* Protégée et grisée : l'utilisateur remplit des cases, il ne saisit pas de clé. */
        cell.protection = { locked:true };
        cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFF1F5F9" } };
        cell.font = { size:10, color:{ argb:"FF5A6872" } };
      } else {
        cell.protection = { locked:false };
      }
      if(c.enum){
        cell.dataValidation = { type:"list", allowBlank:true,
          formulae:[`"${c.enum.join(",")}"`], showErrorMessage:true,
          errorTitle:"Valeur non autorisée",
          error:`Choisissez parmi : ${c.enum.join(", ")}` };
      }
    });
  });

  /* La protection empêche de casser les clés sans empêcher la saisie.
     Sans mot de passe : c'est un garde-fou, pas un verrou de sécurité —
     le serveur revalide tout de toute façon. */
  await ws.protect("", { selectLockedCells:true, selectUnlockedCells:true,
    formatCells:false, insertRows:true, deleteRows:true, sort:true, autoFilter:true });

  /* Feuille d'identification : lue au téléversement, masquée à l'utilisateur. */
  const meta = wb.addWorksheet("_mems");
  meta.addRow(["kind", kind]);
  meta.addRow(["geoVersion", ctx.versionId || ""]);
  meta.addRow(["year", ctx.year ?? ""]);
  /* La constante de lot d'un type national : c'est elle dont `completer` fait
     hériter les lignes que l'opérateur colle sans recopier le nom du référentiel. */
  meta.addRow(["referentiel", ctx.referentiel || ""]);
  meta.addRow(["generatedAt", new Date().toISOString()]);
  meta.addRow(["office", ctx.officeLabel || "tous les bureaux"]);
  meta.state = "veryHidden";

  return wb;
}

/* ── Garde-fou avant toute décompression ─────────────────────────────
   `wb.xlsx.load()` inflate intégralement chaque entrée de l'archive, sans plafond
   et sans vérifier que l'entrée appartient au paquet OOXML. Un .xlsx de 300 Ko
   contenant une entrée de 300 Mo de zéros — une archive parfaitement valide, que
   n'importe quel outil de compression produit — fait donc gonfler le processus
   jusqu'à sa mort. À la limite de téléversement (MAX_BODY_MB, 25 Mo), l'expansion
   se compte en gigaoctets : une seule requête suffit, le limiteur de débit n'y
   change rien, et `restart: unless-stopped` relance le serveur pour la suivante.
   Le droit exigé est « edit », c'est-à-dire le rôle le plus distribué du terrain.

   Deux contrôles, sur ce que l'archive ANNONCE — donc sans rien décompresser :

   — le nom de chaque entrée doit appartenir au paquet OOXML. Un classeur Excel ne
     contient rien d'autre ; le reste est un passager clandestin ;
   — la somme des tailles décompressées reste sous le plus petit de 200 Mo et de
     100 fois la taille du fichier reçu. Le facteur laisse largement passer un vrai
     classeur — du XML, qui se comprime autour de 10:1 — tout en fermant la porte
     aux rapports de 1000:1 dont vit l'attaque.

   Limite assumée : un en-tête peut mentir sur la taille inflatée. S'en prémunir
   vraiment supposerait d'inflater soi-même chaque entrée derrière un compteur,
   donc de réécrire la lecture d'ExcelJS. Ce contrôle-ci arrête l'attaque telle
   qu'elle se monte en pratique, en quinze lignes et sans dépendance nouvelle. */
const ENTREES_OOXML = /^(\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/)/;
const INFLATION_MAX_ABSOLUE = 200 * 1024 * 1024;
const INFLATION_MAX_FACTEUR = 100;

const refusArchive = (message) => { const e = new Error(message); e.code = "ARCHIVE"; return e; };

export async function verifierArchiveXlsx(buffer){
  let zip;
  try{ zip = await JSZip.loadAsync(buffer); }
  catch(e){ throw refusArchive("Fichier illisible : ce n'est pas une archive .xlsx valide."); }

  const plafond = Math.min(INFLATION_MAX_ABSOLUE, buffer.length * INFLATION_MAX_FACTEUR);
  let total = 0;
  for(const [nom, entree] of Object.entries(zip.files)){
    if(!ENTREES_OOXML.test(nom)) throw refusArchive(
      `Ce fichier contient une entrée étrangère au format Excel (« ${nom.slice(0,80)} ») : `
      + "il a été fabriqué ou modifié en dehors d'un tableur. "
      + "Téléchargez le modèle et remplissez-le sans le reconstruire.");
    if(entree.dir) continue;
    total += entree._data?.uncompressedSize || 0;
    if(total > plafond) throw refusArchive(
      `Ce fichier annonce au moins ${Math.round(total / 1048576)} Mo une fois décompressé pour `
      + `${Math.round(buffer.length / 1024)} Ko reçus : le rapport est trop grand pour un classeur `
      + "réel. Il est refusé sans être ouvert.");
  }
}

/* ── Lecture d'un fichier téléversé ────────────────────────────────── */
export async function readUpload(kind, buffer){
  const def = KINDS[kind];
  /* Avant tout le reste : rien n'est inflaté tant que l'archive n'est pas jugée sûre. */
  await verifierArchiveXlsx(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const meta = {};
  const ms = wb.getWorksheet("_mems");
  if(ms) ms.eachRow(r => { meta[String(r.getCell(1).value)] = r.getCell(2).value; });

  /* L'identification passe avant l'examen des colonnes : un modèle du mauvais type
     doit être reconnu comme tel, pas signalé comme un fichier mal formé. */
  if(meta.kind && meta.kind !== kind){
    const e = new Error(`ce fichier est un modèle « ${meta.kind} », pas « ${kind} »`);
    e.code = "WRONG_KIND"; e.meta = meta; throw e;
  }

  const ws = wb.getWorksheet("Saisie") || wb.worksheets.find(w => w.name !== "_mems");
  if(!ws) throw new Error("Le fichier ne contient aucune feuille « Saisie ».");

  /* Les intitulés sont reconnus par leur libellé, pas par leur position :
     un utilisateur qui déplace une colonne ne casse pas l'import. */
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col] = String(cell.value ?? "").trim(); });
  const byHeader = {};
  def.columns.forEach(c => {
    const col = headers.findIndex(h => h === c.header);
    if(col > 0) byHeader[c.field] = col;
  });
  const manquantes = def.columns.filter(c => c.key && byHeader[c.field] === undefined);
  if(manquantes.length)
    throw new Error(`Colonnes de clé absentes : ${manquantes.map(c=>c.header).join(", ")}. `
      + "Téléchargez le modèle plutôt que de recréer le fichier.");

  /* Les colonnes que le fichier NE PORTE PAS. `cellVal` rend "" pour chacune, ce
     qui est indiscernable d'une case vidée à la main : un opérateur qui
     reconstruit sa feuille depuis son propre système en n'en gardant que trois
     colonnes effaçait ainsi toutes les autres sur chaque ligne réimportée. Un
     fichier qui ne parle pas d'une colonne ne dit rien d'elle — même règle que
     pour un PUT partiel sur une fiche de site. */
  const absentes = def.columns.filter(c => byHeader[c.field] === undefined).map(c => c.field);

  const cellVal = (row, field) => {
    const col = byHeader[field]; if(!col) return "";
    const v = row.getCell(col).value;
    if(v == null) return "";
    if(typeof v === "object"){
      if("result" in v) return v.result ?? "";      /* formule */
      if("text" in v) return v.text ?? "";          /* texte enrichi */
      if(v instanceof Date) return v.toISOString().slice(0,10);
      return String(v);
    }
    return v;
  };

  const raw = [];
  ws.eachRow((row, n) => {
    if(n <= 2) return;                               /* intitulés et aide */
    const o = {};
    for(const c of def.columns) o[c.field] = cellVal(row, c.field);
    /* Une ligne dont la clé est vide est une ligne blanche, pas une erreur. */
    if(!String(o[def.columns.find(c=>c.key).field] ?? "").trim()) return;
    raw.push({ line:n, values:o });
  });
  return { meta, rows:raw, sheet:ws.name, absentes };
}

/* ── Analyse : valider, comparer, sans rien écrire ─────────────────── */
export async function analyse(kind, raw, ctx){
  const def = KINDS[kind];
  /* Un type national n'a ni p-code obligatoire ni bureau propriétaire : ses deux
     gardes géographiques sont débranchées, et le millésime n'est même pas lu —
     sur une installation sans référentiel chargé, `known` serait vide et tout
     serait rejeté au premier oubli de cette condition. */
  const geo = def.portee === "geo";
  const v = geo ? currentVersion() : null;
  const known = v
    ? new Set((await db.prepare("SELECT pcode FROM geo_unit WHERE version_id=?").all(v.id)).map(x=>x.pcode))
    : new Set();
  const courant = await def.current(ctx.scope);
  const enTete = def.columns.find(c => c.key)?.header || "clé";
  /* Une colonne absente du fichier ne peut pas être une modification : la
     comparer reviendrait à lire un silence comme un effacement. */
  const absentes = new Set(ctx.absentes || []);
  const comparees = def.compare.filter(f => !absentes.has(f));

  const result = [];
  const vus = new Set();
  let vides = 0;

  for(const { line, values: brut } of raw){
    /* Une ligne peut hériter d'une constante du lot avant d'être validée : c'est
       ainsi que le nom du référentiel se pose sur des lignes simplement collées. */
    const values = def.completer ? def.completer(brut, ctx) : brut;
    const parsed = def.schema.safeParse(values);
    if(!parsed.success){
      const i0 = parsed.error.issues[0];
      const col = def.columns.find(c => c.field === i0.path[0]);
      result.push({ line, action:"reject", field: col?.header || String(i0.path[0]),
        message: i0.message, payload: values });
      continue;
    }
    const r = parsed.data;

    if(geo && !known.has(r.geo_pcode)){
      result.push({ line, action:"reject", field:"P-code",
        message:"absent du référentiel courant", payload:r });
      continue;
    }
    /* Portée : un fichier contenant d'autres bureaux est refusé ligne à ligne,
       quoi qu'il contienne. C'est une entrée utilisateur comme une autre. */
    if(geo && ctx.scope && !ctx.scope.has(r.geo_pcode)){
      result.push({ line, action:"reject", field:"P-code",
        message:"hors du périmètre de votre bureau", payload:r });
      continue;
    }
    const k = def.key(r);
    if(vus.has(k)){
      result.push({ line, action:"reject", field: enTete,
        message: geo
          ? "ligne en doublon dans le fichier — même unité, même période, même activité"
          : "ligne en doublon dans le fichier — cette clé y figure déjà",
        payload:r });
      continue;
    }
    vus.add(k);

    /* Ligne pré-remplie que l'utilisateur n'a pas renseignée : on passe, sans
       créer d'enregistrement à zéro et sans la compter comme un rejet. */
    if(def.blank && def.blank(r) && !courant[k]){ vides++; continue; }

    const pb = await def.check(r);
    if(pb){ result.push({ line, action:"reject", ...pb, payload:r }); continue; }

    const avant = courant[k];
    if(!avant){ result.push({ line, action:"create", payload:r }); continue; }

    const change = comparees.filter(f => {
      const a = avant[f] ?? "", b = r[f] ?? "";
      return typeof a === "number" || typeof b === "number"
        ? Number(a) !== Number(b) : String(a) !== String(b);
    });
    if(!change.length){ result.push({ line, action:"unchanged", payload:r }); continue; }
    result.push({ line, action:"update", payload:r,
      before: Object.fromEntries(change.map(f => [f, avant[f]])),
      message: change.map(f => {
        const col = def.columns.find(c => c.field === f);
        return `${col?.header || f} : ${avant[f] ?? "—"} → ${r[f] ?? "—"}`;
      }).join(" · ") });
  }
  return { rows:result, vides };
}

/* ── Enregistrement du lot ─────────────────────────────────────────── */
export async function saveBatch({ kind, user, filename, rows, absentes = [] }){
  const id = newId("imp");
  const summary = {
    crees:     rows.filter(r => r.action === "create").length,
    modifies:  rows.filter(r => r.action === "update").length,
    inchanges: rows.filter(r => r.action === "unchanged").length,
    rejetes:   rows.filter(r => r.action === "reject").length,
    /* Voyage avec le lot, et non à côté : l'aperçu et la confirmation sont deux
       requêtes distinctes, et ce que l'écriture doit ignorer se décide à la
       lecture du fichier. */
    absentes,
  };
  await tx(async (db) => {
    await db.prepare(`INSERT INTO import_batch (id,kind,user_id,user_label,office_id,filename,summary)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, kind, user.id, user.first_name, user.office_id || null,
           filename || null, JSON.stringify(summary));
    const ins = db.prepare(`INSERT INTO import_row (batch_id,line,action,field,message,payload,before)
                            VALUES (?,?,?,?,?,?,?)`);
    for(const r of rows)
      await ins.run(id, r.line, r.action, r.field || null, r.message || null,
        JSON.stringify(r.payload), r.before ? JSON.stringify(r.before) : null);
  });
  return { id, summary };
}

export async function readBatch(id){
  const b = await db.prepare("SELECT * FROM import_batch WHERE id=?").get(id);
  if(!b) return null;
  const rows = await db.prepare("SELECT * FROM import_row WHERE batch_id=? ORDER BY line").all(id);
  /* TODO-PG: `summary`, `payload` et `before` restent lus ici comme du TEXT JSON
     (JSON.parse), conformément à la liste des colonnes jsonb communiquée pour ce
     portage (connector.config, mre_activity.months — import_batch.summary et
     import_row.payload/before n'y figurent pas). À vérifier contre le schéma
     Postgres réel : si l'une de ces trois colonnes a été déclarée jsonb, le
     JSON.parse correspondant doit être retiré (pg la rend déjà en objet/tableau). */
  return { ...b, summary: JSON.parse(b.summary || "{}"),
    rows: rows.map(r => ({ line:r.line, action:r.action, field:r.field, message:r.message,
      payload: JSON.parse(r.payload), before: r.before ? JSON.parse(r.before) : null })) };
}

/* ── Application ───────────────────────────────────────────────────── */
export async function commitBatch(id, user){
  const b = await readBatch(id);
  if(!b) return { error:"lot introuvable", status:404 };
  if(b.status === "committed") return { error:"ce lot a déjà été appliqué", status:409 };
  if(b.status === "cancelled") return { error:"ce lot a été annulé", status:409 };

  const def = KINDS[b.kind];
  const aEcrire = b.rows.filter(r => r.action === "create" || r.action === "update")
    .map(r => r.payload);

  let res = { crees:0, modifies:0 };
  await tx(async (db) => {
    /* CE client de transaction (`db`) est passé à `def.apply` comme troisième
       argument : caseload.apply et pdd.apply (ce fichier) écrivent ainsi sur la
       même connexion que l'UPDATE/INSERT ci-dessous, donc dans le même ROLLBACK.
       Le type « codes » relaie l'exécuteur à `ecrireEntrees` (lib/codes.js), qui
       ne le prend pas encore en compte — voir le TODO-PG sur codes.apply. */
    if(aEcrire.length) res = await def.apply(aEcrire,
      { officeId: user.office_id || b.office_id, batchId: id,
        absentes: b.summary.absentes || [] }, db);
    await db.prepare(`UPDATE import_batch SET status='committed', committed_at=now() WHERE id=?`)
      .run(id);
    await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'plan',?,?,'import',?)`)
      .run(newId("aud"), user.id, user.first_name, b.kind, id,
           `Import ${def.label} : ${res.crees} créé(s), ${res.modifies} modifié(s), `
           + `${b.summary.inchanges} inchangé(s), ${b.summary.rejetes} rejeté(s)`);
  });
  return { ...res, inchanges:b.summary.inchanges, rejetes:b.summary.rejetes };
}

/* ── Périmètre : les unités que l'utilisateur peut toucher ───────────
   Une seule définition, partagée avec les autres routes (lib/scope.js). */
export async function scopeFor(user){
  const scope = await scopeOf(user);
  const units = await unitsIn(scope, "adm3");
  return { units, scope: scope.unbounded ? null : new Set(units.map(u => u.pcode)),
           source: scope.source };
}
