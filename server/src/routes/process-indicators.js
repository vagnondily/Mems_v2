import { Router } from "express";
import ExcelJS from "exceljs";
import { db } from "../db.js";

/* ══════════════════ Indicateurs de suivi de processus ══════════════════
   Le référentiel extrait des XLSForms (table process_indicator). Lecture ouverte
   à tout compte authentifié — c'est de la donnée de référence, sans propriétaire.
   Le tableau de bord lit le RÉSUMÉ (compact) servi dans /state ; cette route sert
   la liste complète, la structure par module, et l'export Excel « name / label ». */

const r = Router();

/* Résumé compact, par activité puis par module. Assez léger pour /state, assez
   riche pour dessiner la structure du suivi de processus sur le tableau de bord. */
export async function resumeProcessus(){
  const rows = await db.prepare(`SELECT activity_tag, activity_label, form_file, form_title,
      module, COUNT(*) n FROM process_indicator WHERE active=1
      GROUP BY activity_tag, module ORDER BY activity_tag, n DESC`).all();
  const total = (await db.prepare("SELECT COUNT(*) c FROM process_indicator WHERE active=1").get()).c;
  if(!total) return { total:0, activites:[] };

  const parAct = new Map();
  for(const g of rows){
    const cle = g.activity_tag || g.form_file;
    if(!parAct.has(cle)) parAct.set(cle, {
      tag: g.activity_tag || "", label: g.activity_label || g.form_title || g.form_file,
      form: g.form_file, formTitle: g.form_title || "", total: 0, modules: [] });
    const a = parAct.get(cle);
    a.total += g.n;
    if(g.module) a.modules.push({ nom: g.module, n: g.n });
  }
  const activites = [...parAct.values()].sort((a, b) => b.total - a.total);
  return { total, activites };
}

/* Liste complète, filtrable par activité ou par formulaire. Plafonnée : le
   référentiel entier tient en mémoire mais n'a pas à voyager d'un coup. */
r.get("/", async (req, res) => {
  const { activity, form, module, limit } = req.query;
  const conds = ["active=1"]; const params = [];
  if(activity){ conds.push("activity_tag=?"); params.push(String(activity)); }
  if(form){ conds.push("form_file=?"); params.push(String(form)); }
  if(module){ conds.push("module=?"); params.push(String(module)); }
  const lim = Math.min(5000, Math.max(1, Number(limit) || 5000));
  const rows = await db.prepare(`SELECT id, activity_tag, activity_label, form_file, form_title,
      module, module_code, var_name, var_type, label, choices_json, ord
      FROM process_indicator WHERE ${conds.join(" AND ")}
      ORDER BY activity_tag, form_file, ord LIMIT ?`).all(...params, lim);
  res.json({
    rows: rows.map(x => ({ ...x, choices: x.choices_json ?? null })),
    total: (await db.prepare(`SELECT COUNT(*) c FROM process_indicator WHERE ${conds.join(" AND ")}`).get(...params)).c,
    resume: await resumeProcessus(),
  });
});

/* Export Excel du référentiel — « les variables name et label dans un
   référentiel Excel ». Une feuille par activité, plus une feuille de synthèse. */
r.get("/export", async (req, res, next) => {
  try{
    const rows = await db.prepare(`SELECT activity_tag, activity_label, form_file, form_title,
        module, var_name, var_type, label FROM process_indicator WHERE active=1
        ORDER BY activity_tag, form_file, ord`).all();
    const wb = new ExcelJS.Workbook();
    wb.creator = "MEMS";
    const synth = wb.addWorksheet("Synthèse");
    synth.columns = [
      { header:"Activité", key:"tag", width:12 },
      { header:"Libellé activité", key:"label", width:34 },
      { header:"Formulaire", key:"form", width:44 },
      { header:"Indicateurs", key:"n", width:12 },
    ];
    const resume = await resumeProcessus();
    for(const a of resume.activites) synth.addRow({ tag:a.tag, label:a.label, form:a.form, n:a.total });
    synth.getRow(1).font = { bold:true };

    /* Une feuille par activité : name, label, type, module. */
    const parTag = new Map();
    for(const x of rows){ const k = x.activity_tag || x.form_file; (parTag.get(k) || parTag.set(k, []).get(k)).push(x); }
    for(const [k, liste] of parTag){
      const nom = (k || "form").replace(/[^\w -]+/g, "").slice(0, 28) || "form";
      const ws = wb.addWorksheet(nom);
      ws.columns = [
        { header:"name", key:"var_name", width:34 },
        { header:"label", key:"label", width:70 },
        { header:"type", key:"var_type", width:18 },
        { header:"module", key:"module", width:34 },
      ];
      ws.getRow(1).font = { bold:true };
      for(const x of liste) ws.addRow(x);
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="indicateurs_suivi_processus.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  }catch(e){ next(e); }
});

export default r;
