import { z } from "zod";
import ExcelJS from "exceljs";
import { db, tx } from "../db.js";
import { newId } from "./crypto.js";
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
  current: (scope) => {
    const rows = db.prepare("SELECT * FROM caseload").all();
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
  apply: (rows) => {
    const find = db.prepare(`SELECT id FROM caseload
      WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS ?`);
    const ins = db.prepare(`INSERT INTO caseload
      (id,geo_pcode,level,year,month,activity_tag,population,households,targeted,targeted_hh,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE caseload SET population=?, households=?, targeted=?,
      targeted_hh=?, source=?, rev=rev+1, updated_at=datetime('now') WHERE id=?`);
    let crees = 0, modifies = 0;
    for(const x of rows){
      const cur = find.get(x.geo_pcode, x.year, x.activity_tag, x.month);
      if(cur){ upd.run(x.population, x.households, x.targeted, x.targeted_hh, x.source || null, cur.id); modifies++; }
      else { ins.run(newId("cl"), x.geo_pcode, x.level || "adm3", x.year, x.month, x.activity_tag,
        x.population, x.households, x.targeted, x.targeted_hh, x.source || null); crees++; }
    }
    return { crees, modifies };
  },
  /* Lignes du modèle : une par unité du périmètre, pour l'année courante. */
  seed: ({ year, units, tags }) => {
    const out = [];
    for(const u of units){
      const l = labelsFor(u.pcode);
      for(const tag of ["", ...tags]){
        const cur = db.prepare(`SELECT * FROM caseload
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
  current: (scope) => {
    const rows = db.prepare("SELECT * FROM pdd WHERE geo_pcode IS NOT NULL").all();
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
  apply: (rows, ctx) => {
    const find = db.prepare(`SELECT id FROM pdd
      WHERE geo_pcode=? AND year=? AND month=? AND act_type=? AND modality=?`);
    const ins = db.prepare(`INSERT INTO pdd
      (id,year,month,act_type,activity_tag,office_id,bureau,geo_pcode,region,district,commune,
       modality,commodity,days,benef_planned,households,tonnage,amount,benef_actual,received,
       distributed,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const upd = db.prepare(`UPDATE pdd SET bureau=?, commodity=?, days=?, benef_planned=?,
      households=?, tonnage=?, amount=?, benef_actual=?, received=?, distributed=?, status=?,
      rev=rev+1, updated_at=datetime('now') WHERE id=?`);
    let crees = 0, modifies = 0;
    for(const x of rows){
      const cur = find.get(x.geo_pcode, x.year, x.month, x.act_type, x.modality);
      if(cur){
        upd.run(x.bureau || null, x.commodity || null, x.days, x.benef_planned, x.households,
          x.tonnage, x.amount, x.benef_actual, x.received, x.distributed, x.status, cur.id);
        modifies++;
      } else {
        const l = labelsFor(x.geo_pcode);
        ins.run(newId("pdd"), x.year, x.month, x.act_type,
          x.act_type === "GD" ? "URT_GD" : "URT_PREV", ctx.officeId || null,
          x.bureau || "—", x.geo_pcode, l.adm1 || null, l.adm2 || null, l.adm3 || null,
          x.modality, x.commodity || null, x.days, x.benef_planned, x.households,
          x.tonnage, x.amount, x.benef_actual, x.received, x.distributed, x.status);
        crees++;
      }
    }
    return { crees, modifies };
  },
  seed: ({ year, units }) => {
    const out = [];
    for(const u of units){
      const l = labelsFor(u.pcode);
      const rows = db.prepare(`SELECT * FROM pdd WHERE geo_pcode=? AND year=? ORDER BY month`)
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

export const KINDS = { caseload, pdd };

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

  /* Ligne 1 : intitulés. Ligne 2 : aide de saisie. */
  ws.columns = def.columns.map(c => ({ key:c.field, width:c.width || 14 }));
  const head = ws.getRow(1);
  const hint = ws.getRow(2);
  def.columns.forEach((c, i) => {
    const cell = head.getCell(i+1);
    cell.value = c.header;
    cell.font = { bold:true, color:{ argb:"FFFFFFFF" }, size:10 };
    cell.fill = { type:"pattern", pattern:"solid",
      fgColor:{ argb: c.locked ? "FF5A6872" : "FF085387" } };
    cell.alignment = { vertical:"middle", horizontal:"center", wrapText:true };
    cell.border = { bottom:{ style:"thin", color:{ argb:"FFCBD5E1" } } };

    const h = hint.getCell(i+1);
    h.value = c.hint || (c.locked ? "rempli, ne pas modifier" : c.enum ? c.enum.join(" / ") : "");
    h.font = { italic:true, size:8, color:{ argb:"FF8C9BA5" } };
    h.alignment = { vertical:"top", wrapText:true };
  });
  head.height = 32; hint.height = 26;

  /* Lignes de données, pré-remplies. */
  const rows = def.seed(ctx);
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
  meta.addRow(["year", ctx.year]);
  meta.addRow(["generatedAt", new Date().toISOString()]);
  meta.addRow(["office", ctx.officeLabel || "tous les bureaux"]);
  meta.state = "veryHidden";

  return wb;
}

/* ── Lecture d'un fichier téléversé ────────────────────────────────── */
export async function readUpload(kind, buffer){
  const def = KINDS[kind];
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
  return { meta, rows:raw, sheet:ws.name };
}

/* ── Analyse : valider, comparer, sans rien écrire ─────────────────── */
export function analyse(kind, raw, ctx){
  const def = KINDS[kind];
  const v = currentVersion();
  const known = v
    ? new Set(db.prepare("SELECT pcode FROM geo_unit WHERE version_id=?").all(v.id).map(x=>x.pcode))
    : new Set();
  const courant = def.current(ctx.scope);

  const result = [];
  const vus = new Set();
  let vides = 0;

  for(const { line, values } of raw){
    const parsed = def.schema.safeParse(values);
    if(!parsed.success){
      const i0 = parsed.error.issues[0];
      const col = def.columns.find(c => c.field === i0.path[0]);
      result.push({ line, action:"reject", field: col?.header || String(i0.path[0]),
        message: i0.message, payload: values });
      continue;
    }
    const r = parsed.data;

    if(!known.has(r.geo_pcode)){
      result.push({ line, action:"reject", field:"P-code",
        message:"absent du référentiel courant", payload:r });
      continue;
    }
    /* Portée : un fichier contenant d'autres bureaux est refusé ligne à ligne,
       quoi qu'il contienne. C'est une entrée utilisateur comme une autre. */
    if(ctx.scope && !ctx.scope.has(r.geo_pcode)){
      result.push({ line, action:"reject", field:"P-code",
        message:"hors du périmètre de votre bureau", payload:r });
      continue;
    }
    const k = def.key(r);
    if(vus.has(k)){
      result.push({ line, action:"reject", field:"P-code",
        message:"ligne en doublon dans le fichier — même unité, même période, même activité",
        payload:r });
      continue;
    }
    vus.add(k);

    /* Ligne pré-remplie que l'utilisateur n'a pas renseignée : on passe, sans
       créer d'enregistrement à zéro et sans la compter comme un rejet. */
    if(def.blank && def.blank(r) && !courant[k]){ vides++; continue; }

    const pb = def.check(r);
    if(pb){ result.push({ line, action:"reject", ...pb, payload:r }); continue; }

    const avant = courant[k];
    if(!avant){ result.push({ line, action:"create", payload:r }); continue; }

    const change = def.compare.filter(f => {
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
export function saveBatch({ kind, user, filename, rows }){
  const id = newId("imp");
  const summary = {
    crees:     rows.filter(r => r.action === "create").length,
    modifies:  rows.filter(r => r.action === "update").length,
    inchanges: rows.filter(r => r.action === "unchanged").length,
    rejetes:   rows.filter(r => r.action === "reject").length,
  };
  tx(() => {
    db.prepare(`INSERT INTO import_batch (id,kind,user_id,user_label,office_id,filename,summary)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, kind, user.id, user.first_name, user.office_id || null,
           filename || null, JSON.stringify(summary));
    const ins = db.prepare(`INSERT INTO import_row (batch_id,line,action,field,message,payload,before)
                            VALUES (?,?,?,?,?,?,?)`);
    for(const r of rows)
      ins.run(id, r.line, r.action, r.field || null, r.message || null,
        JSON.stringify(r.payload), r.before ? JSON.stringify(r.before) : null);
  })();
  return { id, summary };
}

export function readBatch(id){
  const b = db.prepare("SELECT * FROM import_batch WHERE id=?").get(id);
  if(!b) return null;
  const rows = db.prepare("SELECT * FROM import_row WHERE batch_id=? ORDER BY line").all(id);
  return { ...b, summary: JSON.parse(b.summary || "{}"),
    rows: rows.map(r => ({ line:r.line, action:r.action, field:r.field, message:r.message,
      payload: JSON.parse(r.payload), before: r.before ? JSON.parse(r.before) : null })) };
}

/* ── Application ───────────────────────────────────────────────────── */
export function commitBatch(id, user){
  const b = readBatch(id);
  if(!b) return { error:"lot introuvable", status:404 };
  if(b.status === "committed") return { error:"ce lot a déjà été appliqué", status:409 };
  if(b.status === "cancelled") return { error:"ce lot a été annulé", status:409 };

  const def = KINDS[b.kind];
  const aEcrire = b.rows.filter(r => r.action === "create" || r.action === "update")
    .map(r => r.payload);

  let res = { crees:0, modifies:0 };
  tx(() => {
    if(aEcrire.length) res = def.apply(aEcrire, { officeId: user.office_id || b.office_id });
    db.prepare(`UPDATE import_batch SET status='committed', committed_at=datetime('now') WHERE id=?`)
      .run(id);
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'plan',?,?,'import',?)`)
      .run(newId("aud"), user.id, user.first_name, b.kind, id,
           `Import ${def.label} : ${res.crees} créé(s), ${res.modifies} modifié(s), `
           + `${b.summary.inchanges} inchangé(s), ${b.summary.rejetes} rejeté(s)`);
  })();
  return { ...res, inchanges:b.summary.inchanges, rejetes:b.summary.rejetes };
}

/* ── Périmètre : les unités que l'utilisateur peut toucher ───────────
   Une seule définition, partagée avec les autres routes (lib/scope.js). */
export function scopeFor(user){
  const scope = scopeOf(user);
  const units = unitsIn(scope, "adm3");
  return { units, scope: scope.unbounded ? null : new Set(units.map(u => u.pcode)),
           source: scope.source };
}
