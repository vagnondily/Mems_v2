import { useState } from "react";
import { Download, FileText, Filter, Sparkles } from "lucide-react";
import { Btn, Card, Empty, Field, Input, Note, Select, TableWrap, Tabs, Td, Th, download, toCSV } from "../components/ui.jsx";
import { LEVELS, computeMMR, fmt, n, pct, siteScore } from "../lib/calc.js";
import { D_ADJUST } from "../lib/constants.js";
import { alertes } from "../lib/alerts.js";

/* ══════════════════ Rapports ══════════════════ */
function Reports({ db, set, sub, setSub, notify, can }){
  return (
    <div className="space-y-4">
      {sub==="extract" && <Extract db={db} notify={notify} />}
      {sub==="build" && <ReportBuilder db={db} set={set} notify={notify} can={can} />}
    </div>);
}

function Extract({ db, notify }){
  const [formId,setFormId] = useState(db.odkForms[0]?.id || "");
  const [from,setFrom] = useState(`${db.year}-01-01`); const [to,setTo] = useState(`${db.year}-12-31`);
  const [site,setSite] = useState(""); const [cols,setCols] = useState(null);
  const form = db.odkForms.find(f=>f.id===formId);
  const all = form?.rows || [];
  const fields = Object.keys(all[0]||{});
  const selected = cols || fields;
  const rows = all.filter(r => {
    const d = r[form?.dateField] || r.visit_date || r.today;
    if(d && from && String(d) < from) return false;
    if(d && to && String(d) > to) return false;
    if(site && String(r[form?.siteField]||r.site_id||"") !== site) return false;
    return true; });
  const label = (c) => (form?.labels||{})[c] || c;
  return (
    <>
      <Note>L'extraction porte sur les données déjà récupérées du formulaire. Les libellés affichés proviennent
        du XLSForm joint dans <b>Paramètres → ODK Central</b> ; à défaut, les noms techniques des champs sont utilisés.</Note>
      <div className="grid gap-4" style={{gridTemplateColumns:"320px 1fr"}}>
        <Card title="Filtres">
          <Field label="Formulaire"><Select value={formId} onChange={e=>{setFormId(e.target.value);setCols(null);}}
            options={db.odkForms.map(f=>[f.id, f.name])} /></Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="Du"><Input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></Field>
            <Field label="Au"><Input type="date" value={to} onChange={e=>setTo(e.target.value)} /></Field>
          </div>
          <Field label="Site"><Select value={site} onChange={e=>setSite(e.target.value)} empty="Tous les sites"
            options={db.sites.map(s=>[s.id, `${s.id} — ${s.poi}`])} /></Field>
          <Field label="Colonnes à extraire">
            <div className="mh240 overflow-auto border border-slate-200 rounded p-2 space-y-1">
              {fields.map(c=>(
                <label key={c} className="flex items-center gap-2 f115">
                  <input type="checkbox" checked={selected.includes(c)}
                    onChange={e=>setCols(e.target.checked ? [...selected,c] : selected.filter(x=>x!==c))} />
                  <span className="truncate" title={label(c)}>{label(c)}</span></label>))}
            </div></Field>
          <div className="flex gap-2">
            <Btn size="sm" icon={Download} disabled={!rows.length}
              onClick={()=>{ download(`extraction_${form?.formId}.csv`, toCSV(rows, selected), "text/csv"); notify("Extraction CSV téléchargée","ok"); }}>CSV</Btn>
            <Btn size="sm" kind="sec" icon={Download} disabled={!rows.length}
              onClick={()=>{ download(`extraction_${form?.formId}.json`, JSON.stringify(rows,null,2), "application/json"); notify("Extraction JSON téléchargée","ok"); }}>JSON</Btn>
          </div>
        </Card>
        <Card flush title="Aperçu de l'extraction" subtitle={`${fmt(rows.length)} lignes sur ${fmt(all.length)} · ${selected.length} colonnes`}>
          {rows.length ? (
            <TableWrap max="mh62">
              <thead><tr>{selected.map(c=><Th key={c}>{label(c)}</Th>)}</tr></thead>
              <tbody>{rows.slice(0,100).map((r,i)=>(
                <tr key={i} className="hover:bg-sky-50">{selected.map(c=>
                  <Td key={c} className={String(r[c]??"")===""?"text-slate-300":""}>{String(r[c]??"∅")}</Td>)}</tr>))}</tbody>
            </TableWrap>
          ) : <Empty icon={Filter} title="Aucune ligne" text="Élargissez la période ou choisissez un autre formulaire." />}
        </Card>
      </div>
    </>);
}

/* ── Générateur de rapport infographique ── */
const BLOCKS = [
  ["kpi","Chiffres clés","Exigence de suivi, sites actifs, bénéficiaires, taux de réalisation"],
  ["coverage","Couverture par bureau","Sites actifs, planifiés et suivis, avec le taux de réalisation"],
  ["activity","Plan et réalisé par activité","Comparaison mensuelle des visites planifiées et réalisées"],
  ["outputs","Bénéficiaires planifiés et atteints","Cumul par catégorie d'activité avec les ajustements"],
  ["outcomes","Indicateurs de résultat","Référence, dernière mesure et valeur planifiée"],
  ["sites","Liste des sites","Tableau détaillé des sites avec priorité et couverture"],
  ["tasks","Points d'attention","Échéances manquées et actions à mener"],
];
function reportData(db, opt){
  const mmr = computeMMR(db, db.year);
  const sites = db.sites;
  const active = sites.filter(s=>s.status!=="Inactive");
  const planned = sites.reduce((t,s)=>t+s.plan.filter(p=>p.planned).length,0);
  const done = sites.reduce((t,s)=>t+s.plan.filter(p=>p.done).length,0);
  return {
    mmr, kpis: [
      ["Exigence minimale de suivi", mmr.pct+" %"],
      ["Sites actifs", fmt(active.length)],
      ["Bénéficiaires ciblés", fmt(active.reduce((t,s)=>t+n(s.beneficiaries),0))],
      ["Visites planifiées", fmt(planned)],
      ["Visites réalisées", fmt(done)],
      ["Taux de réalisation", pct(done,planned)+" %"],
    ],
    coverage: db.lists.offices.map(o => { const g=sites.filter(s=>s.subOffice===o);
      const p=g.reduce((t,s)=>t+s.plan.filter(x=>x.planned).length,0);
      const d=g.reduce((t,s)=>t+s.plan.filter(x=>x.done).length,0);
      return { office:o, actifs:g.filter(s=>s.status!=="Inactive").length, planifie:p, realise:d, taux:pct(d,p) };
    }).filter(x=>x.actifs),
    activity: db.lists.tags.map(t => { const g=sites.filter(s=>s.activityTag===t.code);
      const p=g.reduce((a,s)=>a+s.plan.filter(x=>x.planned).length,0);
      const d=g.reduce((a,s)=>a+s.plan.filter(x=>x.done).length,0);
      return { tag:t.code, label:t.label, plan:p, real:d, taux:pct(d,p) }; }).filter(x=>x.plan||x.real),
    outputs: db.lists.tags.map(t => { const g=db.outputs.filter(o=>o.tag===t.code);
      return { tag:t.code, planned:g.reduce((a,o)=>a+n(o.planned),0), actual:g.reduce((a,o)=>a+n(o.actual),0),
        adjust:[...new Set(g.map(o=>o.adjust).filter(a=>a&&a!=="none"))]
          .map(a=>(D_ADJUST.find(x=>x[0]===a)||[])[1]).join(", ") }; }).filter(x=>x.planned||x.actual),
    outcomes: db.indicators.map(ind => { const vals=db.outcomes.filter(o=>o.indicator===ind.id);
      const last=vals.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
      const base=vals.find(v=>/référence|baseline/i.test(v.round));
      return { id:ind.id, name:ind.name, unit:ind.unit, dir:ind.dir, base:base?base.value:null,
        last:last?last.value:null, planned:last?n(last.planned)||ind.target:ind.target }; }).filter(x=>x.last!==null),
    sites: sites.map(s => ({ id:s.id, poi:s.poi, office:s.subOffice, adm:[s.adm1,s.adm2,s.adm3].filter(Boolean).join(", "),
      tag:s.activityTag, status:s.status, benef:s.beneficiaries, prio:LEVELS[siteScore(s, db.weights, db).level].label,
      planned:s.plan.filter(p=>p.planned).length, done:s.plan.filter(p=>p.done).length })),
    tasks: alertes(db).slice(0,15),
  };
}
function reportHTML(db, tpl, opt){
  const D = reportData(db, opt);
  const esc = (v) => String(v??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const bar = (v,tone) => `<div class="bar"><i class="${tone}" style="width:${Math.min(100,v)}%"></i></div>`;
  const tone = v => v>=80?"ok":v>=50?"warn":"bad";
  const intro = (tpl.intro||"").replace(/\{(\w+)\}/g, (_,k)=>({ org:db.settings.org, periode:opt.periode,
    annee:db.year, unite:db.settings.unit })[k] ?? `{${k}}`);
  const B = {
    kpi: () => `<section><h2>Chiffres clés</h2><div class="kpis">${
      D.kpis.map(([l,v])=>`<div class="kpi"><span>${esc(l)}</span><b>${esc(v)}</b></div>`).join("")}</div></section>`,
    coverage: () => `<section><h2>Couverture par bureau</h2><table><thead><tr><th>Bureau</th><th class="n">Sites actifs</th>
      <th class="n">Planifiées</th><th class="n">Réalisées</th><th>Taux</th></tr></thead><tbody>${
      D.coverage.map(r=>`<tr><td>${esc(r.office)}</td><td class="n">${r.actifs}</td><td class="n">${r.planifie}</td>
        <td class="n">${r.realise}</td><td>${bar(r.taux,tone(r.taux))}<span class="pc">${r.taux} %</span></td></tr>`).join("")}
      </tbody></table></section>`,
    activity: () => `<section><h2>Plan et réalisé par activité</h2><table><thead><tr><th>Activité</th>
      <th class="n">Planifiées</th><th class="n">Réalisées</th><th>Taux</th></tr></thead><tbody>${
      D.activity.map(r=>`<tr><td><b>${esc(r.tag)}</b> ${esc(r.label)}</td><td class="n">${r.plan}</td>
        <td class="n">${r.real}</td><td>${bar(r.taux,tone(r.taux))}<span class="pc">${r.taux} %</span></td></tr>`).join("")}
      </tbody></table></section>`,
    outputs: () => `<section><h2>Bénéficiaires planifiés et atteints</h2><table><thead><tr><th>Activité</th>
      <th class="n">Planifiés</th><th class="n">Atteints</th><th>Réalisation</th><th>Ajustements</th></tr></thead><tbody>${
      D.outputs.map(r=>{ const p=pct(r.actual,r.planned);
        return `<tr><td><b>${esc(r.tag)}</b></td><td class="n">${fmt(r.planned)}</td><td class="n">${fmt(r.actual)}</td>
        <td>${bar(p,tone(p))}<span class="pc">${p} %</span></td><td class="muted">${esc(r.adjust||"—")}</td></tr>`; }).join("")}
      </tbody></table></section>`,
    outcomes: () => `<section><h2>Indicateurs de résultat</h2><table><thead><tr><th>Indicateur</th><th class="n">Référence</th>
      <th class="n">Dernière mesure</th><th class="n">Planifié</th><th>Sens</th></tr></thead><tbody>${
      D.outcomes.map(r=>{ const ok = r.dir==="up" ? r.last>=r.planned : r.last<=r.planned;
        return `<tr><td>${esc(r.name)}</td><td class="n">${r.base??"—"}</td>
        <td class="n"><b class="${ok?"good":"bad"}">${r.last}</b></td><td class="n">${r.planned}</td>
        <td class="muted">${r.dir==="up"?"à maximiser":"à minimiser"}</td></tr>`; }).join("")}
      </tbody></table></section>`,
    sites: () => `<section><h2>Sites</h2><table><thead><tr><th>ID</th><th>Point d'intérêt</th><th>Bureau</th>
      <th>Emplacement</th><th>Activité</th><th class="n">Bénéf.</th><th>Priorité</th><th class="n">Plan.</th><th class="n">Réal.</th></tr></thead><tbody>${
      D.sites.map(s=>`<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.poi)}</td><td>${esc(s.office)}</td>
        <td class="muted">${esc(s.adm)}</td><td>${esc(s.tag)}</td><td class="n">${fmt(s.benef)}</td>
        <td>${esc(s.prio)}</td><td class="n">${s.planned}</td><td class="n">${s.done}</td></tr>`).join("")}
      </tbody></table></section>`,
    tasks: () => `<section><h2>Points d'attention</h2><ul class="tasks">${
      D.tasks.map(t=>`<li><span class="pill ${t.prio}">${esc(t.prio)}</span> <b>${esc(t.kind)}</b> — ${esc(t.text)}</li>`).join("")}
      </ul></section>`,
  };
  const body = (tpl.blocks||[]).map(b => B[b] ? B[b]() : "").join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${esc(tpl.name)} — ${esc(db.settings.org)}</title>
<style>
:root{--b:#007DBC;--bd:#085387;--ok:#689e18;--warn:#F7B825;--bad:#c5192d;--l:#e2e8ec;--t2:#5a6872}
*{box-sizing:border-box}body{margin:0;font-family:'Open Sans',system-ui,-apple-system,Segoe UI,sans-serif;
color:#031c2d;background:#f2f5f7;font-size:13px;line-height:1.55}
.page{max-width:920px;margin:0 auto;background:#fff}
header.hd{background:linear-gradient(140deg,var(--bd),#19486a);color:#fff;padding:34px 40px}
header.hd h1{margin:0;font-size:27px;font-weight:300;letter-spacing:-.02em}
header.hd .meta{opacity:.82;font-size:12.5px;margin-top:8px}
.intro{padding:22px 40px;border-bottom:1px solid var(--l);white-space:pre-wrap;color:var(--t2)}
section{padding:24px 40px;border-bottom:1px solid var(--l)}
h2{font-size:15px;margin:0 0 14px;color:var(--bd);text-transform:uppercase;letter-spacing:.06em}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--l);border:1px solid var(--l)}
.kpi{background:#fff;padding:16px 18px}
.kpi span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--t2);font-weight:700}
.kpi b{display:block;font-size:27px;font-weight:300;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--t2);
padding:7px 9px;border-bottom:2px solid var(--l);background:#f8fafc}
td{padding:7px 9px;border-bottom:1px solid #eef2f5}
.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--t2)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--t2)}
.good{color:var(--ok)}.bad{color:var(--bad)}
.bar{display:inline-block;width:74px;height:6px;background:var(--l);border-radius:3px;overflow:hidden;vertical-align:middle}
.bar i{display:block;height:100%;background:var(--b)}.bar i.ok{background:var(--ok)}
.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}
.pc{margin-left:8px;font-variant-numeric:tabular-nums;font-size:11.5px}
.tasks{margin:0;padding:0;list-style:none}.tasks li{padding:7px 0;border-bottom:1px solid #eef2f5}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:700;margin-right:6px}
.pill.haute{background:#fbe9eb;color:#8b1220}.pill.moyenne{background:#fdf4e0;color:#7a5504}
.pill.basse{background:#eef2f5;color:var(--t2)}
footer.ft{padding:18px 40px;font-size:11px;color:var(--t2)}
@media print{body{background:#fff}.page{max-width:none}section{page-break-inside:avoid}}
</style></head><body><div class="page">
<header class="hd"><h1>${esc(tpl.name)}</h1>
<div class="meta">${esc(db.settings.org)} — ${esc(db.settings.unit)} · ${esc(opt.periode)} · établi le ${new Date().toLocaleDateString("fr-FR")}</div></header>
${intro ? `<div class="intro">${esc(intro)}</div>` : ""}
${body}
<footer class="ft">Document produit par MEMS · exercice ${db.year}</footer>
</div></body></html>`;
}
function ReportBuilder({ db, set, notify, can }){
  const [tplId,setTplId] = useState(db.reportTemplates[0]?.id || "");
  const [periode,setPeriode] = useState(`Exercice ${db.year}`);
  const [html,setHtml] = useState("");
  const tpl = db.reportTemplates.find(t=>t.id===tplId) || db.reportTemplates[0];
  const toggle = (b) => set(d => { const t=d.reportTemplates.find(x=>x.id===tplId); if(!t) return d;
    t.blocks = t.blocks.includes(b) ? t.blocks.filter(x=>x!==b) : [...t.blocks, b]; return d; });
  const build = () => { if(!tpl) return; setHtml(reportHTML(db, tpl, { periode })); notify("Rapport généré","ok"); };
  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"340px 1fr"}}>
      <div className="space-y-4">
        <Card title="Modèle et période">
          <Field label="Modèle de rapport"><Select value={tplId} onChange={e=>setTplId(e.target.value)}
            options={db.reportTemplates.map(t=>[t.id,t.name])} /></Field>
          <Field label="Période affichée"><Input value={periode} onChange={e=>setPeriode(e.target.value)} /></Field>
          <p className="f115 text-slate-500 leading-relaxed mb-3">
            Les modèles, leur texte d'introduction et leurs champs dynamiques se gèrent dans
            Paramètres → Modèles de rapport.</p>
          <div className="flex gap-2">
            <Btn icon={Sparkles} onClick={build}>Générer</Btn>
            <Btn kind="sec" icon={Download} disabled={!html}
              onClick={()=>{ download(`${(tpl?.name||"rapport").replace(/\W+/g,"_")}.html`, html, "text/html"); notify("Rapport téléchargé","ok"); }}>Télécharger</Btn>
          </div>
        </Card>
        <Card title="Sections du rapport" subtitle="Cochez les blocs à inclure">
          {BLOCKS.map(([b,l,d])=>(
            <label key={b} className="flex items-start gap-2.5 py-2 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={!!tpl?.blocks?.includes(b)} disabled={!can("edit")} onChange={()=>toggle(b)} />
              <span><span className="f13 font-medium text-slate-800 block">{l}</span>
                <span className="f115 text-slate-500">{d}</span></span></label>))}
        </Card>
      </div>
      <Card flush title="Aperçu du rapport" subtitle={html ? "Rendu final, prêt à imprimer ou à partager" : "Choisissez les sections puis générez"}>
        {html
          ? <iframe title="apercu" srcDoc={html} className="w-full mh68 border-0" style={{height:"70vh"}} />
          : <Empty icon={FileText} title="Aucun rapport généré"
              text="Sélectionnez un modèle et les sections souhaitées, puis lancez la génération pour obtenir un document mis en page." />}
      </Card>
    </div>);
}

export { BLOCKS, Extract, ReportBuilder, Reports, reportData, reportHTML };
