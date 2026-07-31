import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { Activity, AlertTriangle, CalendarRange, Check, ClipboardList, Download, Layers, MapPin, Pencil, Plus, RefreshCw, Save, Search, Target, Trash2, Upload, Users, X } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { clsx, computeParam, fmt, n, pct, r1, r2, siteScore, uid } from "../lib/calc.js";
import { ACT_CATEGORIES, C, DURATIONS, D_PARTNERS, MONITORING_TYPES, MONTHS, MONTHS_L, SITE_TYPES, coverageRows, siteDerived } from "../lib/constants.js";
import { PageHead } from "./Shell.jsx";
import { useGeoCascade } from "../lib/geo.js";

/* Conserve la valeur déjà enregistrée dans la liste, même absente du référentiel courant. */
const withCurrent = (list, v) => (v && !list.includes(v)) ? [v, ...list] : list;

/* ══════════════════ Grille mensuelle ══════════════════ */
function MonthGrid({ rows, labelOf, subOf, cellOf, onCell, footerOf }){
  return (
    <TableWrap>
      <thead><tr><Th className="sticky left-0 z-20">Élément</Th>
        {MONTHS.map(m=><Th key={m} num className="mi-tc mi-px1 w38">{m}</Th>)}
        <Th num>Prévu</Th><Th num>Réalisé</Th></tr></thead>
      <tbody>
        {rows.map((row,ri)=>{
          const cells = MONTHS.map((_,mi)=>cellOf(row,mi));
          const p = cells.filter(c=>c.planned).length, d = cells.filter(c=>c.done).length;
          return (
            <tr key={row.id||ri} className="hover:bg-sky-50 group">
              <Td className="sticky left-0 bg-white group-hover:bg-sky-50 z-10 mw300">
                <div className="truncate font-medium text-slate-800">{labelOf(row)}</div>
                {subOf && <div className="f11 text-slate-500 truncate">{subOf(row)}</div>}</Td>
              {cells.map((c,mi)=>{
                const cls = !c.activeMonth ? "m-hatch"
                  : c.planned && c.done ? "bg-ok text-white"
                  : c.planned && c.missed ? "bg-rose-100 text-rose-800"
                  : c.planned ? "bg-sky-200 text-sky-900"
                  : c.done ? "bg-lime-100 text-lime-800" : "";
                return (<td key={mi} className="p-0 border-b border-slate-100 w38">
                  <button onClick={()=>onCell&&onCell(row,mi)} title={`${MONTHS_L[mi]}`}
                    className={clsx("m-cell", cls)}>
                    {c.planned&&c.done?"✓":c.planned&&c.missed?"!":c.planned?"●":c.done?"✓":""}</button></td>); })}
              <Td num><b>{p}</b></Td><Td num className={d<p?"text-rose-700":"text-lime-700"}>{d}</Td>
            </tr>); })}
      </tbody>
      {footerOf && <tfoot><tr className="bg-slate-50 font-semibold">
        <Td className="sticky left-0 bg-slate-50 z-10">Total</Td>
        {MONTHS.map((_,mi)=><Td key={mi} num className="mi-tc mi-px1">{footerOf(mi)}</Td>)}
        <Td/><Td/></tr></tfoot>}
    </TableWrap>);
}
const MonthLegend = () => (
  <div className="flex flex-wrap items-center gap-4 f115 text-slate-500 px-4 py-2.5 border-b border-slate-100">
    {[["bg-sky-200","Planifié"],["bg-ok","Réalisé selon le plan"],["bg-lime-100","Réalisé hors plan"],
      ["bg-rose-100","Échéance manquée"],["bg-slate-200","Inactif ce mois"]].map(([c,l])=>(
      <span key={l} className="flex items-center gap-1.5"><i className={clsx("w-3 h-3 rounded-sm inline-block",c)} />{l}</span>))}
  </div>);

/* ══════════════════ Planning ══════════════════ */
function Planning({ db, set, me, sub, setSub, notify, can }){
  const items = [["overreaching","Paramètres de couverture"],["process","Plan de suivi des sites"],
    ["coverage","Couverture et MMR"],["distribution","Plan de distribution"],["outcomes","Plan des résultats"]];
  return (
    <div className="space-y-4">
      <PageHead title="Planning" text="Paramétrage de la couverture fondée sur le risque, puis déclinaison en plans mensuels de suivi, de distribution et de collecte des indicateurs." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="overreaching" && <Overreaching db={db} set={set} notify={notify} can={can} />}
      {sub==="process" && <ProcessPlan db={db} set={set} me={me} notify={notify} can={can} />}
      {sub==="coverage" && <CoveragePlan db={db} set={set} me={me} notify={notify} can={can} />}
      {sub==="distribution" && <DistributionPlan db={db} set={set} me={me} notify={notify} can={can} />}
      {sub==="outcomes" && <OutcomePlan db={db} set={set} notify={notify} can={can} />}
    </div>);
}

function Overreaching({ db, set, notify, can }){
  const [edit,setEdit] = useState(null);
  const rows = db.params.map(p => ({ ...p, c:computeParam(p, db.sites, db.formulas) }));
  const save = (row) => {
    set(d => { const i = d.params.findIndex(x=>x.id===row.id);
      if(i>=0) d.params[i] = row; else d.params.push({ ...row, id:uid("p") });
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:row.office,
        kind:"plan", text:`Paramètre de couverture ${i>=0?"modifié":"créé"} — ${row.office} / ${row.tag}` });
      return d; });
    setEdit(null); notify("Paramètre enregistré","ok"); };
  return (
    <>
      <Note>
        <b>Calculs appliqués.</b>{" "}
        {db.formulas.map(f => <span key={f.id} className="inline-block mr-4">{f.label}{" "}
          <code className="bg-white px-1.5 py-0.5 rounded f11">{f.expr}</code></span>)}
        <span className="block mt-1 opacity-80">Modifiables dans Paramètres → Calculs automatiques.</span>
      </Note>
      <Card flush title="Paramètres par bureau et activité"
        subtitle={`${rows.length} lignes · le nombre de sites est compté en direct dans le registre`}
        right={can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ id:null, csp:"",
          /* Les deux listes peuvent être vides sur une instance neuve : lire `[0].code`
             levait alors une erreur et l'écran entier disparaissait. */
          office:db.lists.offices[0] || "", tag:db.lists.tags[0]?.code || "",
          duration:12, riskLevel:2, feasiblePerMonth:0 })}>Ajouter</Btn>}>
        <TableWrap>
          <thead><tr>{["N°","Bureau","Activité"].map(h=><Th key={h}>{h}</Th>)}
            {["Durée","Sites","Risque","Interv. min.","Fréq. min.","Cible/mois","Faisable/mois","Ratio","Fréq. ajustée","Interv. ajusté"].map(h=><Th key={h} num>{h}</Th>)}
            <Th /></tr></thead>
          <tbody>{rows.map(r=>{ const c=r.c;
            const tone = c.feasibilityRatio>=1?"ok" : c.feasibilityRatio>=.6?"warn":"bad";
            return (
              <tr key={r.id} className="hover:bg-sky-50">
                <Td className="f11 text-slate-500">{r.csp||"—"}</Td><Td>{r.office}</Td>
                <Td><Badge tone="b">{r.tag}</Badge></Td>
                <Td num>{c.duration}</Td><Td num><b>{c.nbSites}</b></Td>
                <Td num><Badge tone={c.riskLevel===3?"r":c.riskLevel===2?"y":"g"}>{c.riskLevel}</Badge></Td>
                <Td num>{r1(c.minInterval)}</Td><Td num>{r1(c.minFreq)}</Td><Td num>{r1(c.targetPerMonth)}</Td>
                <Td num>{c.feasiblePerMonth}</Td>
                <Td num><div className="flex items-center gap-2 justify-end"><Bar2 value={c.feasibilityRatio*100} tone={tone} />{r1(c.feasibilityRatio)}</div></Td>
                <Td num>{r1(c.adjustedFreq)}</Td><Td num><b>{r1(c.adjustedInterval)}</b></Td>
                <Td className="text-right">
                  {can("edit") && <button onClick={()=>setEdit(r)} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>}
                  {can("del") && <button onClick={()=>{ set(d=>{ d.params=d.params.filter(x=>x.id!==r.id); return d; }); notify("Supprimé","ok"); }}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>}</Td>
              </tr>); })}</tbody>
        </TableWrap>
      </Card>
      <ParamModal open={!!edit} row={edit} db={db} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function ParamModal({ open, row, db, onClose, onSave }){
  const [f,setF] = useState(row||{});
  useEffect(()=>{ setF(row||{}); },[row]);
  if(!open) return null;
  const c = computeParam(f, db.sites, db.formulas); const u = (k,v)=>setF(p=>({...p,[k]:v}));
  return (
    <Modal open onClose={onClose} title={row?.id?"Modifier le paramètre":"Nouveau paramètre de couverture"}
      subtitle="Les colonnes calculées se mettent à jour en direct"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Numéro d'activité"><Input value={f.csp||""} onChange={e=>u("csp",e.target.value)} placeholder="ACT-2026-001" /></Field>
        <Field label="Bureau"><Select value={f.office||""} onChange={e=>u("office",e.target.value)} options={db.lists.offices} empty="—" /></Field>
        <Field label="Activity tag" className="col-span-2">
          <Select value={f.tag||""} onChange={e=>u("tag",e.target.value)} empty="—"
            options={db.lists.tags.map(t=>[t.code, `${t.code} — ${t.label}`])} /></Field>
        <Field label="Durée d'opération (mois)"><Input type="number" min="1" max="12" value={f.duration??12} onChange={e=>u("duration",n(e.target.value))} /></Field>
        <Field label="Niveau de risque"><Select value={f.riskLevel??2} onChange={e=>u("riskLevel",n(e.target.value))}
          options={[[1,"1 — Faible"],[2,"2 — Moyen"],[3,"3 — Élevé"]]} /></Field>
        <Field label="Visites faisables par mois" hint="Capacité réelle de l'équipe">
          <Input type="number" min="0" value={f.feasiblePerMonth??0} onChange={e=>u("feasiblePerMonth",n(e.target.value))} /></Field>
        <Field label="Nombre de sites" hint="Compté automatiquement">
          <Input value={c.nbSites} readOnly /></Field>
      </div>
      <div className="grid grid-cols-3 gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden">
        {[["Intervalle minimum", r1(c.minInterval)+" mois"],["Fréquence minimale", r1(c.minFreq)],
          ["Sites ciblés par mois", r1(c.targetPerMonth)],["Ratio de faisabilité", r1(c.feasibilityRatio)],
          ["Fréquence ajustée", r1(c.adjustedFreq)],["Intervalle ajusté", r1(c.adjustedInterval)+" mois"]].map(([l,v])=>(
          <div key={l} className="bg-white px-3 py-2.5"><div className="f10 uppercase tracking-wide font-bold text-slate-500">{l}</div>
            <div className="text-lg font-light tabular-nums text-slate-800 mt-0.5">{v}</div></div>))}
      </div>
    </Modal>);
}


/* ══════════════════ Couverture du suivi et exigences minimales ══════════════════ */
/* Couverture géographique : quelles unités administratives ne portent aucun site.
   C'est la question que le modèle plat ne savait pas poser — il n'y avait pas de
   ligne « commune » à laquelle rapporter quoi que ce soit. */
function GeoCoverage({ db, notify }){
  const [level,setLevel] = useState("adm3");
  const [sel,setSel] = useState({ adm1:"", adm2:"" });
  const [only,setOnly] = useState("");            /* "" | "vides" | "couverts" */
  const geo = useGeoCascade(sel);
  const [cov,setCov] = useState({ rows:[], total:0, covered:0, sitesUnlinked:0, loading:true });

  const parent = geo.codes.adm2 || geo.codes.adm1 || "";
  useEffect(() => {
    let alive = true;
    setCov(c => ({ ...c, loading:true }));
    const qs = new URLSearchParams({ level, limit:"2000" });
    if(parent) qs.set("parent", parent);
    api.geoCoverage("?"+qs)
      .then(r => { if(alive) setCov({ ...r, loading:false }); })
      .catch(e => { if(alive) setCov({ rows:[], total:0, covered:0, sitesUnlinked:0,
        loading:false, error:e.message }); });
    return () => { alive = false; };
  }, [level, parent]);

  const rows = cov.rows.filter(r =>
    only === "vides" ? r.sites === 0 : only === "couverts" ? r.sites > 0 : true);
  const LABEL = { adm1:"régions", adm2:"districts", adm3:"communes", adm4:"fokontany" };
  const taux = pct(cov.covered, cov.total);

  const exporter = () => {
    download(`couverture_${level}.csv`,
      toCSV(cov.rows.map(r => ({ Région:r.adm1||"", District:r.adm2||"", Commune:r.adm3||"",
        Unité:r.name, "P-code":r.pcode, Sites:r.sites, Actifs:r.active, Inactifs:r.inactive,
        "Dernière visite":r.lastVisit||"", Statut: r.sites ? "Couvert" : "Non couvert" })),
        ["Région","District","Commune","Unité","P-code","Sites","Actifs","Inactifs","Dernière visite","Statut"]),
      "text/csv");
    notify("Couverture géographique exportée","ok");
  };

  if(!db.geoVersion) return (
    <Note tone="warn"><b>Aucun référentiel chargé.</b> La couverture géographique se calcule
      à partir du découpage administratif. Chargez-le depuis Paramètres → Localités.</Note>);

  return (
    <>
      <Note>Croisement du référentiel administratif et du registre des sites : chaque unité
        porte le nombre de sites qui lui sont rattachés, directement ou par un niveau inférieur.
        Une unité à zéro est un <b>trou de couverture</b> — une zone où le programme n'a aucune
        présence enregistrée.</Note>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Select value={level} onChange={e=>setLevel(e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[["adm1","Par région"],["adm2","Par district"],["adm3","Par commune"],["adm4","Par fokontany"]]} />
        <Select value={sel.adm1} onChange={e=>setSel({ adm1:e.target.value, adm2:"" })}
          empty="Toutes les régions" options={geo.adm1.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" />
        <Select value={sel.adm2} onChange={e=>setSel(s=>({ ...s, adm2:e.target.value }))}
          empty="Tous les districts" options={geo.adm2.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto"
          disabled={!sel.adm1} />
        <Select value={only} onChange={e=>setOnly(e.target.value)} empty="Tout afficher"
          options={[["vides","Non couverts seulement"],["couverts","Couverts seulement"]]}
          className="mi-py1 mi-xs mi-wauto" />
        <Btn size="sm" kind="sec" icon={Download} onClick={exporter}
          disabled={!cov.rows.length}>Exporter</Btn>
      </div>

      <StatRow>
        <Stat label={`${LABEL[level].replace(/^./,c=>c.toUpperCase())} couvertes`}
          value={`${fmt(cov.covered)}/${fmt(cov.total)}`}
          sub={`${taux} % du découpage`} tone={taux>=80?"ok":taux>=40?"warn":"bad"} />
        <Stat label="Trous de couverture" value={fmt(cov.total - cov.covered)}
          sub={`${LABEL[level]} sans aucun site`} tone={cov.total-cov.covered?"warn":"ok"} />
        <Stat label="Sites rattachés" value={fmt(cov.sitesLinked || 0)} sub="au référentiel" />
        <Stat label="Sites non rattachés" value={fmt(cov.sitesUnlinked || 0)}
          sub={cov.sitesUnlinked ? "à rapprocher — voir README §3" : "aucun"}
          tone={cov.sitesUnlinked ? "bad" : "ok"} />
      </StatRow>

      {cov.sitesUnlinked > 0 && (
        <Note tone="warn"><b>{fmt(cov.sitesUnlinked)} site(s) ne sont rattachés à aucune unité</b> et
          ne comptent donc dans aucune ligne ci-dessous. Le rapprochement se lance en une commande :
          <code className="bg-white px-1 rounded mx-1">node src/link-geo.js --write</code>
          — il compare les libellés existants au référentiel en descendant l'arbre.</Note>)}

      <Card flush title={`Couverture par ${LABEL[level].replace(/s$/,"")}`}
        subtitle={cov.loading ? "Chargement…" : `${fmt(rows.length)} ligne(s) affichée(s) sur ${fmt(cov.total)}`}>
        <TableWrap max="mh520">
          <thead><tr>
            {level!=="adm1" && <Th>Région</Th>}
            {(level==="adm3"||level==="adm4") && <Th>District</Th>}
            {level==="adm4" && <Th>Commune</Th>}
            <Th>{LABEL[level].replace(/s$/,"").replace(/^./,c=>c.toUpperCase())}</Th>
            <Th>P-code</Th><Th num>Sites</Th><Th num>Actifs</Th><Th num>Inactifs</Th>
            <Th>Dernière visite</Th><Th>Statut</Th></tr></thead>
          <tbody>{rows.map(r=>(
            <tr key={r.pcode} className={clsx("hover:bg-sky-50", !r.sites && "bg-amber-50/40")}>
              {level!=="adm1" && <Td className="text-slate-500">{r.adm1||"—"}</Td>}
              {(level==="adm3"||level==="adm4") && <Td className="text-slate-500">{r.adm2||"—"}</Td>}
              {level==="adm4" && <Td className="text-slate-500">{r.adm3||"—"}</Td>}
              <Td className="font-medium text-slate-800">{r.name}</Td>
              <Td className="f115 c-bd">{r.pcode}</Td>
              <Td num><b>{r.sites||""}</b></Td>
              <Td num className="text-slate-600">{r.active||""}</Td>
              <Td num className="text-slate-400">{r.inactive||""}</Td>
              <Td className="f115 text-slate-500">{r.lastVisit||"—"}</Td>
              <Td>{r.sites
                ? <Badge tone="g">Couvert</Badge>
                : <Badge tone="y">Non couvert</Badge>}</Td>
            </tr>))}</tbody>
        </TableWrap>
        {!cov.loading && !rows.length && (
          <div className="px-4 py-8 text-center f125 text-slate-500">
            {cov.error ? cov.error : "Aucune unité dans cette sélection."}</div>)}
      </Card>
    </>);
}

function CoveragePlan({ db, set, me, notify, can }){
  const [scope,setScope] = useState(""); const [tab,setTab] = useState("plan");
  const cats = db.actCategories || ACT_CATEGORIES;
  const used = cats.filter(c => db.sites.some(s => s.activityCategory===c));
  const rowsFor = (c) => coverageRows(db, c, scope);
  const total = coverageRows(db, "", scope);

  const recap = (db.mmr||[]).map(g => {
    const sites = db.sites.filter(s => s.programArea===g.area && (!scope || s.subOffice===scope));
    const active = sites.filter(s=>s.status!=="Inactive");
    const toVisit = active.reduce((t,s)=>t+siteDerived(s,db).sitesToBePlanned,0);
    const counts = [1,2,3,4].map(k => active.filter(s => { const v=s.plan.filter(p=>p.done).length;
      return k===4 ? v>3 : v===k; }).length);
    const visited = active.filter(s=>s.plan.some(p=>p.done)).length;
    const requirement = Math.round(active.length * n(g.coef));
    return { ...g, active:active.length, toVisit, counts, visited, requirement,
      compliance: pct(visited, requirement || active.length) };
  }).filter(r=>r.active || r.requirement);

  const exportCov = () => { const out = [];
    used.forEach(c => { const r = rowsFor(c);
      [["Total number of active sites", r.active],["Total number of planned sites", r.plan],
       ["Total number of actual sites visited", r.actual],["Planned coverage (plan/total)", r.plannedCoverage],
       ["% Visited (actual/plan)", r.visited],["Actual coverage (actual/total)", r.actualCoverage]]
      .forEach(([lab,arr]) => out.push({ "Activity category":c, "Indicateur":lab,
        ...Object.fromEntries(MONTHS_L.map((m,i)=>[m, arr[i]])),
        Cumulative: arr.reduce((t,x)=>t+x,0) })); });
    download("monitoring_coverage_plan.csv", toCSV(out, Object.keys(out[0]||{})), "text/csv");
    notify("Plan de couverture exporté","ok"); };

  return (
    <>
      <Note>Repris du plan de suivi : pour chaque catégorie d'activité, les sites actifs, prévus et réellement
        visités mois par mois, puis les trois taux — couverture planifiée, part des prévus effectivement visités,
        et couverture réelle. La seconde vue rapproche ces réalisations de la guidance d'exigence minimale.</Note>
      <div className="flex items-center gap-2 mb-4">
        <Tabs className="flex-1" value={tab} onChange={setTab}
          items={[["plan","Monitoring Coverage Plan"],["recap","Site Coverage Recap et guidance MMR"],
                  ["geo","Couverture géographique"]]} />
        <Select value={scope} onChange={e=>setScope(e.target.value)} empty="Tous les bureaux"
          options={db.lists.offices} className="mi-py1 mi-xs mi-wauto" />
        <Btn size="sm" kind="sec" icon={Download} onClick={exportCov}>Exporter</Btn>
      </div>

      {tab==="geo" ? <GeoCoverage db={db} notify={notify} /> : tab==="plan" ? (
        <>
          <StatRow>
            <Stat label="Sites actifs" value={fmt(Math.max(0,...total.active))} icon={MapPin} />
            <Stat label="Visites prévues" value={fmt(total.cumul.plan)} icon={CalendarRange} />
            <Stat label="Visites réalisées" value={fmt(total.cumul.actual)} icon={Check}
              tone={pct(total.cumul.actual,total.cumul.plan)>=80?"ok":"warn"} />
            <Stat label="Couverture réelle" value={pct(
              db.sites.filter(s=>(!scope||s.subOffice===scope) && s.status!=="Inactive" && s.plan.some(p=>p.done)).length,
              db.sites.filter(s=>(!scope||s.subOffice===scope) && s.status!=="Inactive").length)+" %"}
              sub="Sites visités au moins une fois ÷ sites actifs" icon={Target} />
            <Stat label="Catégories suivies" value={used.length} sub={`sur ${cats.length}`} icon={Layers} />
          </StatRow>
          <Card flush title="Monitoring Coverage Plan" subtitle="Six lignes par catégorie d'activité, sur les douze mois">
            <TableWrap>
              <thead><tr><Th className="sticky left-0 z-20">Catégorie d'activité</Th><Th>Indicateur</Th><Th className="mi-tc">Type</Th>
                {MONTHS.map(m=><Th key={m} num className="mi-tc mi-px1">{m}</Th>)}<Th num>Cumul</Th></tr></thead>
              <tbody>{used.flatMap(c => { const r = rowsFor(c);
                const lines = [
                  ["Total number of active sites", r.active, "Active", false],
                  ["Total number of planned sites to visit", r.plan, "Plan", false],
                  ["Total number of actual sites visited", r.actual, "Actual", false],
                  ["Planned coverage (plan / total active)", r.plannedCoverage, "", true],
                  ["% Visited (actual / planned)", r.visited, "", true],
                  ["Actual coverage (actual / total active)", r.actualCoverage, "", true]];
                return lines.map(([lab,arr,kind,isPct],k)=>(
                  <tr key={c+k} className={clsx("hover:bg-sky-50", k===0 && "border-t-2 border-slate-200")}>
                    <Td className="sticky left-0 bg-white z-10 mw320">
                      {k===0 && <span className="font-medium text-slate-800">{c}</span>}</Td>
                    <Td className={clsx("f12", isPct?"text-slate-500":"text-slate-700 font-medium")}>{lab}</Td>
                    <Td className="mi-tc">{kind && <Badge tone={kind==="Active"?"n":kind==="Plan"?"b":"g"}>{kind}</Badge>}</Td>
                    {arr.map((v,mi)=>(
                      <Td key={mi} num className={clsx("mi-px1", isPct && (v>=80?"text-lime-700":v>=50?"text-amber-700":v>0?"text-rose-700":"text-slate-300"))}>
                        {isPct ? (v?v+" %":"—") : (v||"—")}</Td>))}
                    <Td num className="font-semibold">{isPct ? "—" : fmt(arr.reduce((t,x)=>t+x,0))}</Td>
                  </tr>)); })}</tbody>
            </TableWrap>
            {!used.length && <Empty icon={Layers} title="Aucune catégorie d'activité renseignée"
              text="Renseignez la catégorie d'activité des sites pour alimenter ce plan." />}
          </Card>
          <Card title="Couverture réelle par mois, toutes catégories">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={MONTHS.map((m,i)=>({ mois:m, Actifs:total.active[i], Prévus:total.plan[i],
                Réalisés:total.actual[i], "Couverture réelle":total.actualCoverage[i] }))}
                margin={{top:6,right:6,left:-14,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="mois" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis yAxisId="l" tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} />
                <YAxis yAxisId="r" orientation="right" tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} tickFormatter={v=>v+"%"} />
                <Tooltip contentStyle={{fontSize:11,borderRadius:3}} />
                <Legend wrapperStyle={{fontSize:11}} />
                <Bar yAxisId="l" dataKey="Actifs" fill="#cfe0ea" radius={[2,2,0,0]} />
                <Bar yAxisId="l" dataKey="Prévus" fill={C.brandL} radius={[2,2,0,0]} />
                <Bar yAxisId="l" dataKey="Réalisés" fill={C.ok} radius={[2,2,0,0]} />
                <Line yAxisId="r" type="monotone" dataKey="Couverture réelle" stroke={C.orange} strokeWidth={2.4} dot={{r:3}} />
              </ComposedChart></ResponsiveContainer>
          </Card>
        </>
      ) : (
        <>
          <Card flush title="Site Coverage Recap" subtitle="Exigence minimale de suivi par aire de programme"
            right={<><Badge tone="n">Taille d'opération : {db.settings.opSize || "Large"}</Badge>
              <Badge tone="y">Part de sites à priorité haute : {pct(db.sites.filter(s=>siteScore(s,db.weights,db).level===3).length, db.sites.length)} %</Badge></>}>
            <TableWrap>
              <thead><tr><Th>Aire de programme</Th><Th className="mi-tc">Modalité cash ou coupon</Th><Th>Durée de mise en œuvre</Th>
                <Th>Type de site</Th><Th>Type de suivi</Th><Th>Guidance MMR</Th>
                <Th num>Sites actifs</Th><Th num>Visites dues</Th>
                <Th num>1 fois</Th><Th num>2 fois</Th><Th num>3 fois</Th><Th num>4+ fois</Th>
                <Th num>Coefficient</Th><Th num>Exigence</Th><Th>Conformité</Th></tr></thead>
              <tbody>{recap.map((g,i)=>(
                <tr key={g.id} className="hover:bg-sky-50">
                  <Td className="font-medium text-slate-800 mw300">{g.area}</Td>
                  <Td className="mi-tc">{g.cashVoucher ? <Badge tone="b">{g.cashVoucher}</Badge> : <span className="text-slate-400">—</span>}</Td>
                  <Td><select value={g.duration} disabled={!can("edit")} onChange={e=>set(d=>{ d.mmr[i].duration=e.target.value; return d; })}
                    className="px-1.5 py-0.5 f115 border border-slate-200 rounded">{DURATIONS.map(x=><option key={x}>{x}</option>)}</select></Td>
                  <Td><select value={g.siteType} disabled={!can("edit")} onChange={e=>set(d=>{ d.mmr[i].siteType=e.target.value; return d; })}
                    className="px-1.5 py-0.5 f115 border border-slate-200 rounded">{SITE_TYPES.map(x=><option key={x}>{x}</option>)}</select></Td>
                  <Td><select value={g.monitoring} disabled={!can("edit")} onChange={e=>set(d=>{ d.mmr[i].monitoring=e.target.value; return d; })}
                    className="px-1.5 py-0.5 f115 border border-slate-200 rounded">{MONITORING_TYPES.map(x=><option key={x}>{x}</option>)}</select></Td>
                  <Td className="text-slate-600 mw300">{g.guidance}</Td>
                  <Td num><b>{fmt(g.active)}</b></Td><Td num>{fmt(g.toVisit)}</Td>
                  {g.counts.map((c,k)=><Td key={k} num className="text-slate-600">{c||"—"}</Td>)}
                  <Td num><input type="number" step="0.1" value={g.coef} disabled={!can("edit")}
                    onChange={e=>set(d=>{ d.mmr[i].coef=n(e.target.value); return d; })}
                    className="w-16 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  <Td num>{fmt(g.requirement)}</Td>
                  <Td><div className="flex items-center gap-2"><Bar2 value={g.compliance}
                    tone={g.compliance>=80?"ok":g.compliance>=50?"warn":"bad"} />
                    <span className="tabular-nums f115">{g.compliance} %</span></div></Td>
                </tr>))}</tbody>
            </TableWrap>
            {!recap.length && <Empty icon={Target} title="Aucune aire de programme renseignée"
              text="Renseignez l'aire de programme des sites pour calculer les exigences minimales." />}
          </Card>
          <Card title="Charge de suivi restante" subtitle="Sites restant à planifier et visites à programmer, par bureau">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart margin={{top:6,right:6,left:-14,bottom:0}}
                data={db.lists.offices.map(o=>{ const g=db.sites.filter(s=>s.subOffice===o && s.status!=="Inactive");
                  const d2=g.map(s=>siteDerived(s,db));
                  return { bureau:o.slice(0,15), "Sites à planifier":d2.reduce((t,x)=>t+(x.sitesToBePlanned?1:0),0),
                    "Visites à programmer":d2.reduce((t,x)=>t+x.visitsToBePlanned,0) }; }).filter(x=>x["Sites à planifier"]||x["Visites à programmer"])}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="bureau" tick={{fontSize:10,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{fontSize:11,borderRadius:3}} /><Legend wrapperStyle={{fontSize:11}} />
                <Bar dataKey="Sites à planifier" fill={C.warn} radius={[2,2,0,0]} />
                <Bar dataKey="Visites à programmer" fill={C.brand} radius={[2,2,0,0]} />
              </BarChart></ResponsiveContainer>
          </Card>
        </>)}
    </>);
}

function ProcessPlan({ db, set, me, notify, can }){
  const [fOffice,setFOffice] = useState(""); const [fTag,setFTag] = useState(""); const [cell,setCell] = useState(null);
  const nowM = new Date().getMonth();
  const rows = db.sites.filter(s => (!fOffice||s.subOffice===fOffice) && (!fTag||s.activityTag===fTag)
    && (!me.office || db.roles[me.role].admin || s.subOffice===me.office));
  const cellOf = (s,mi) => { const p = s.plan[mi]||{};
    return { planned:!!p.planned, done:!!p.done, activeMonth:p.activeMonth!==false && s.status!=="Inactive",
      missed: p.planned && !p.done && mi<nowM }; };
  const autoPlan = () => {
    set(d => { let count=0; const groups = {};
      d.sites.forEach(s => { const k=s.subOffice+"|"+s.activityTag; (groups[k]=groups[k]||[]).push(s); });
      Object.entries(groups).forEach(([k,list]) => {
        const [office,tag] = k.split("|");
        const p = d.params.find(x=>x.office===office && x.tag===tag);
        const c = p ? computeParam(p, d.sites, d.formulas) : null;
        const interval = c ? Math.max(1, Math.round(c.adjustedInterval)) : 4;
        const cap = c && c.feasiblePerMonth ? c.feasiblePerMonth : Infinity;
        const load = Array(12).fill(0);
        list.slice().sort((a,b)=>siteScore(b, d.weights, d).pct - siteScore(a, d.weights, d).pct).forEach(s => {
          s.plan = s.plan.map(x=>({ ...x, planned:false }));
          if(s.status==="Inactive" || s.security===99) return;
          let best=0, bl=Infinity;
          for(let o=0;o<interval && o<12;o++) if(load[o]<bl){ bl=load[o]; best=o; }
          for(let m=best;m<12;m+=interval){
            if(s.plan[m].activeMonth===false || load[m]>=cap) continue;
            s.plan[m].planned = true; load[m]++; count++; } }); });
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:me.office||"Bureau central",
        kind:"plan", text:`Plan de suivi régénéré — ${count} visites planifiées` });
      return d; });
    notify("Plan régénéré à partir des paramètres de couverture","ok"); };
  const totalP = rows.reduce((t,s)=>t+s.plan.filter(p=>p.planned).length,0);
  const totalD = rows.reduce((t,s)=>t+s.plan.filter(p=>p.done).length,0);
  return (
    <>
      <StatRow>
        <Stat label="Sites au plan" value={rows.length} sub={`${rows.filter(s=>s.status!=="Inactive").length} actifs`} icon={MapPin} />
        <Stat label="Visites planifiées" value={totalP} icon={CalendarRange} />
        <Stat label="Visites réalisées" value={totalD} tone={pct(totalD,totalP)>=80?"ok":"warn"} icon={Check} />
        <Stat label="Taux de réalisation" value={pct(totalD,totalP)+"%"} tone={pct(totalD,totalP)>=80?"ok":pct(totalD,totalP)>=50?"warn":"bad"} icon={Target} />
      </StatRow>
      <Card flush title="Plan mensuel des visites" subtitle="Cliquez sur une case pour ouvrir la fiche du mois"
        right={<><Select value={fOffice} onChange={e=>setFOffice(e.target.value)} empty="Tous les bureaux" options={db.lists.offices} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fTag} onChange={e=>setFTag(e.target.value)} empty="Toutes les activités" options={db.lists.tags.map(t=>t.code)} className="mi-py1 mi-xs mi-wauto" />
          {can("edit") && <Btn size="sm" icon={RefreshCw} onClick={autoPlan}>Générer le plan</Btn>}</>}>
        <MonthLegend />
        <MonthGrid rows={rows} labelOf={s=>s.poi} subOf={s=>`${s.id} · ${s.subOffice} · ${s.adm3} · ${s.activityTag}`}
          cellOf={cellOf} onCell={(s,mi)=>can("edit")&&setCell({site:s,mi})}
          footerOf={mi=>rows.filter(s=>s.plan[mi]?.planned).length||""} />
      </Card>
      <MonthCellModal cell={cell} db={db} set={set} onClose={()=>setCell(null)} notify={notify} />
    </>);
}
function MonthCellModal({ cell, db, set, onClose, notify }){
  const [f,setF] = useState({});
  useEffect(()=>{ if(cell){ const p = cell.site.plan[cell.mi]||{};
    setF({ activeMonth:p.activeMonth!==false, cp:p.cp||cell.site.partner||"", planned:!!p.planned,
      done:!!p.done, monitor:p.monitor||cell.site.responsible||"",
      report:p.report||"", moda:p.moda||"" }); } },[cell]);
  if(!cell) return null;
  const save = async () => {
    /* Le serveur crée la visite associée et met à jour la date de dernière visite. */
    try{
      await api.saveMonth(cell.site.id, { month:cell.mi, year:db.year, active:!!f.activeMonth,
        planned:!!f.planned, done:!!f.done, cp_name:f.cp || null, monitor:f.monitor || null,
        report:f.report || null, moda:f.moda || null });
    }catch(e){ notify(e.message, "err"); return; }
    set(d => { const s = d.sites.find(x=>x.id===cell.site.id); if(!s) return d;
      const before = s.plan[cell.mi]?.done;
      s.plan[cell.mi] = { ...s.plan[cell.mi], ...f };
      if(f.done && !before){ const date = new Date(d.year, cell.mi, 15).toISOString().slice(0,10);
        d.visits.push({ id:uid("v"), siteId:s.id, date, tag:s.activityTag, office:s.subOffice,
          monitor:f.monitor, form:"saisie", status:"À valider" }); s.lastVisit = date; }
      if(!f.done && before) d.visits = d.visits.filter(v =>
        !(v.siteId===s.id && new Date(v.date).getMonth()===cell.mi && new Date(v.date).getFullYear()===d.year));
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:s.subOffice,
        kind:"plan", text:`${MONTHS_L[cell.mi]} — ${s.poi} : ${f.planned?"visite planifiée":"planification retirée"}${f.done?", visite effectuée":""}` });
      return d; });
    onClose(); notify("Fiche du mois enregistrée","ok"); };
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  return (
    <Modal open onClose={onClose} title={`${MONTHS_L[cell.mi]} — ${cell.site.poi}`}
      subtitle={`${cell.site.id} · ${cell.site.subOffice} · ${cell.site.adm3} · ${cell.site.activityTag}`}
      footer={<><Btn kind="sec" icon={X} onClick={onClose}>Annuler</Btn><Btn icon={Check} onClick={save}>Enregistrer</Btn></>}>
      <Sw label="Site actif ce mois" on={f.activeMonth} onChange={v=>u("activeMonth",v)} />
      <Sw label="Visite planifiée" on={f.planned} onChange={v=>u("planned",v)} />
      <Sw label="Visite effectuée" on={f.done} onChange={v=>u("done",v)} />
      <div className="grid grid-cols-2 gap-x-4 mt-4">
        <Field label="CP Name — partenaire coopérant"><Select value={f.cp||""} onChange={e=>u("cp",e.target.value)} empty="—" options={db.lists.partners} /></Field>
        <Field label="Missionnaire"><Input value={f.monitor||""} onChange={e=>u("monitor",e.target.value)} /></Field>
        <Field label="Rapport de mission" hint="Référence ou lien du rapport"><Input value={f.report||""} onChange={e=>u("report",e.target.value)} /></Field>
        <Field label="Rapport MoDa" hint="Identifiant de la soumission"><Input value={f.moda||""} onChange={e=>u("moda",e.target.value)} /></Field>
      </div>
      <p className="f115 text-slate-500 leading-relaxed">Cocher « visite effectuée » crée une visite au statut
        <b> À valider</b> dans Actual Data et met à jour la date de dernière visite.</p>
    </Modal>);
}

/* ══════════════════ Plan de distribution (PDD) ══════════════════ */
const PDD_ACTS = [["GD","Distribution générale"],["PREVMA","Prévention de la malnutrition"],
  ["PECMAM","Traitement de la malnutrition"],["FFA","Création d'actifs"]];
const PDD_MODALITIES = [["Food","Food — vivres en nature"],["Cash","Cash — transfert monétaire"],["Voucher","Coupons"]];
const PDD_COMMODITIES = ["Riz","Sorgho","Maïs concassé","Maïs en grain","Légumineuses","Huile",
  "Super Cereal CSB+","Super Cereal CSB++","LNS-mq/Plumpy Doz","LNS-sq/Nutributter","Plumpy Sup","Dattes"];
const PDD_STATUS = [["planned","Planifiée"],["ongoing","En cours"],["done","Terminée"],["cancelled","Annulée"]];

/* Quantité planifiée : tonnage pour les vivres, montant pour les transferts */
function pddPlanned(l){
  return l.modality==="Food" ? { qty:n(l.tonnage), unit:"t" } : { qty:n(l.amount), unit:"MGA" };
}
function pddRates(l){
  const p = pddPlanned(l).qty;
  const rb = n(l.benefPlanned) ? n(l.benefActual)/n(l.benefPlanned) : null;
  const rr = p ? n(l.received)/p : null;
  const rd = p ? n(l.distributed)/p : null;
  return { benef:rb, reception:rr, distribution:rd };
}
const rate = (v) => v===null || v===undefined || !Number.isFinite(v) ? "—" : (v*100).toFixed(2)+" %";
const rateTone = (v) => v===null ? "n" : v>=0.9 ? "g" : v>=0.6 ? "y" : "r";

/* Agrégation d'un ensemble de lignes : somme des réalisés ÷ somme des planifiés */
function pddAgg(lines){
  let bp=0, ba=0;
  const groups = {};              /* une unité de mesure par modalité */
  lines.forEach(l => { const p = pddPlanned(l);
    bp += n(l.benefPlanned); ba += n(l.benefActual);
    const g = groups[l.modality] = groups[l.modality] || { unit:p.unit, planned:0, received:0, distributed:0, weight:0 };
    g.planned += p.qty; g.received += n(l.received); g.distributed += n(l.distributed); g.weight += n(l.benefPlanned); });
  const combine = (key) => {
    let num = 0, den = 0;
    Object.values(groups).forEach(g => { if(!g.planned) return;
      const w = g.weight || g.planned; num += (g[key]/g.planned) * w; den += w; });
    return den ? num/den : null;
  };
  const tot = (key) => Object.values(groups).reduce((t,g)=>t+g[key],0);
  return { benef: bp?ba/bp:null, reception: combine("received"), distribution: combine("distributed"),
           benefPlanned:bp, benefActual:ba, byModality:groups,
           qtyPlanned:tot("planned"), qtyReceived:tot("received"), qtyDistributed:tot("distributed"),
           count:lines.length };
}
function seedPDD(){
  const year = new Date().getFullYear();
  const pick = a => a[Math.floor(Math.random()*a.length)];
  const zones = [
    ["AMBOVOMBE","Androy","Ambovombe-Androy",["Ambanisarika","Anjeky Ankilikira","Maroalomainty","Sihanamaro"]],
    ["AMPANIHY","Atsimo-Andrefana","Ampanihy Ouest",["Ampanihy Ouest","Anavoha","Androipano","Ejeda"]],
    ["TULEAR","Atsimo-Andrefana","Toliara II",["Betioky","Sakaraha","Saint-Augustin"]],
    ["MANAKARA","Vatovavy","Manakara",["Ambila","Mahabako","Vohimasina"]],
    ["BEKILY","Androy","Bekily",["Beraketa","Bekitro","Tanandava"]],
    ["TSIHOMBE","Androy","Tsihombe",["Marovato","Nikoly","Antaritarika"]],
    ["TOLAGNARO","Anosy","Amboasary-Atsimo",["Ebelo","Ifotaka","Mahaly","Ranobe"]],
  ];
  const out = [];
  [5,6].forEach(mi => zones.forEach(([bureau,region,district,communes]) =>
    communes.forEach(commune => ["GD","PREVMA"].forEach(actType => {
      if(Math.random()<0.18) return;
      const modality = actType==="GD" ? pick(["Food","Food","Cash"]) : "Food";
      const benefPlanned = 1500 + Math.floor(Math.random()*22000);
      const days = actType==="GD" ? 15 : 30;
      const tonnage = modality==="Food" ? r2(benefPlanned*days*0.0006*(0.8+Math.random()*0.5)) : 0;
      const amount = modality==="Cash" ? Math.round(benefPlanned*days*1600) : 0;
      const covB = Math.random()<0.14 ? 0 : 0.55+Math.random()*0.5;
      const covR = Math.random()<0.1 ? 0 : 0.6+Math.random()*0.45;
      const covD = Math.random()<0.14 ? 0 : Math.min(covR, 0.5+Math.random()*0.75);
      out.push({ id:uid("pdd"), month:mi, year, wbs: actType==="GD"?"URT1":"URT2",
        actType, tag: actType==="GD" ? "URT_GD" : "URT_PREV",
        actMain: actType==="GD" ? "Distribution générale sécheresse" : "Prévention de la malnutrition aiguë",
        bureau, region, district, commune, partner: pick(D_PARTNERS),
        modality, commodity: modality==="Food" ? (actType==="GD" ? pick(["Riz","Sorgho"]) : pick(["Super Cereal CSB+","LNS-mq/Plumpy Doz"])) : "",
        days, benefPlanned, households: Math.round(benefPlanned/5), tonnage, amount,
        benefActual: Math.round(benefPlanned*covB), received: r2((modality==="Food"?tonnage:amount)*covR),
        distributed: r2((modality==="Food"?tonnage:amount)*covD),
        distDate:"", status: covD>0 ? "done" : "planned", note:"" });
    }))));
  return out;
}

/* ══════════════════ Concevoir le plan de distribution ══════════════════

   Le plan ne se concevait pas, il se SAISISSAIT : une ligne par commune, par mois,
   par activité, ajoutée une à une dans une fenêtre de vingt champs. Pour quelques
   centaines de communes sur douze mois, cela fait des milliers de lignes à taper,
   puis à retaper l'année suivante. Personne ne fait cela — on le fait dans un
   tableur, et l'application cesse de servir.

   Or le plan n'est pas une saisie, c'est une DÉRIVATION. On sait déjà, commune par
   commune, combien de personnes sont ciblées. Le reste en découle : les communes
   retenues, les mois retenus, un taux de couverture, une ration. Ce qui demande un
   jugement humain — quelles communes, quel taux, quels mois — se décide ici en six
   choix ; ce qui est mécanique se calcule.

   L'écran garde trois promesses :

     il MONTRE le ciblage de chaque commune avant qu'on la retienne, parce que
     planifier une commune sans ciblage produit une ligne à zéro bénéficiaire ;

     il CHIFFRE avant d'écrire — combien de lignes, de bénéficiaires, de tonnes —
     car un plan de six cents lignes ne se crée pas à l'aveugle ;

     il ne DOUBLONNE jamais en silence : ce qui existe déjà pour la même commune et
     le même mois est annoncé, et l'on choisit de le passer ou de le remplacer. */
function ConcevoirPdd({ db, notify, onFini, onQuitter }){
  const [act,setAct]       = useState("GD");
  const [tag,setTag]       = useState("URT");
  const [actMain,setMain]  = useState("Distribution générale");
  const [wbs,setWbs]       = useState("URT1");
  const [mod,setMod]       = useState("Food");
  const [denree,setDenree] = useState("Riz");
  const [jours,setJours]   = useState(30);
  const [partner,setPartner] = useState("");
  const [mois,setMois]     = useState([]);
  const [source,setSource] = useState("ciblage");
  const [couv,setCouv]     = useState(80);
  const [fixe,setFixe]     = useState(0);
  const [ration,setRation] = useState(0.6);
  const [transfert,setTransfert] = useState(1600);
  const [conflits,setConflits]   = useState("ignorer");
  const [sel,setSel]       = useState(() => new Set());
  const [zones,setZones]   = useState({ rows:[], loading:true });
  const [filtre,setFiltre] = useState({ adm1:"", adm2:"" });
  const [apercu,setApercu] = useState(null);
  const [busy,setBusy]     = useState("");

  /* Le ciblage dépend de l'activité : changer d'activité change les nombres, il faut
     donc relire — et repartir d'une sélection vide plutôt que de garder des communes
     retenues sur des chiffres qui ne sont plus les leurs. */
  useEffect(() => { let vivant = true;
    setZones(z => ({ ...z, loading:true }));
    api.pddZones(`?year=${db.year}&tag=${encodeURIComponent(tag)}`)
      .then(r => { if(!vivant) return; setZones({ rows:r.rows || [], loading:false, info:r });
                   setSel(new Set()); setApercu(null); })
      .catch(e => { if(vivant) setZones({ rows:[], loading:false, err:e.message }); });
    return () => { vivant = false; };
  }, [db.year, tag]);

  const rows = (zones.rows || []).filter(z =>
    (!filtre.adm1 || z.adm1 === filtre.adm1) && (!filtre.adm2 || z.adm2 === filtre.adm2));
  const regions   = [...new Set((zones.rows||[]).map(z=>z.adm1).filter(Boolean))].sort();
  const districts = [...new Set((zones.rows||[]).filter(z=>!filtre.adm1||z.adm1===filtre.adm1)
                     .map(z=>z.adm2).filter(Boolean))].sort();

  const retenues = rows.filter(z => sel.has(z.pcode));
  const cibleTotale = retenues.reduce((t,z) => t + (source==="fixe" ? n(fixe) : Math.round(z.targeted*n(couv)/100)), 0);
  const lignesPrevues = retenues.length * mois.length;

  const basculer = (pcode) => setSel(s => { const c = new Set(s);
    c.has(pcode) ? c.delete(pcode) : c.add(pcode); return c; });
  const toutes = () => setSel(s => rows.every(z=>s.has(z.pcode))
    ? new Set() : new Set(rows.map(z=>z.pcode)));
  const avecCiblage = () => setSel(new Set(rows.filter(z=>z.targeted>0).map(z=>z.pcode)));

  const corps = () => ({ year:db.year, months:mois, pcodes:[...sel],
    actType:act, tag, actMain, wbs, modality:mod, commodity: mod==="Food" ? denree : "",
    days:n(jours), partner_id: partner || null,
    source, couverture:n(couv), fixe:n(fixe),
    rationKg:n(ration), transfertJour:n(transfert), conflits });

  const voir = async () => {
    setBusy("apercu"); setApercu(null);
    try{ setApercu(await api.pddPreview(corps())); }
    catch(e){ notify(e.message, "err"); }
    finally{ setBusy(""); }
  };
  const ecrire = async () => {
    setBusy("gen");
    try{
      const r = await api.pddGenerate(corps());
      notify(`${r.creees} ligne(s) créée(s)` +
        (r.remplacees ? `, ${r.remplacees} remplacée(s)` : "") +
        (r.ignorees ? `, ${r.ignorees} déjà présente(s)` : ""), "ok");
      await onFini();
    }catch(e){ notify(e.message, "err"); }
    finally{ setBusy(""); }
  };

  const pret = retenues.length > 0 && mois.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Btn kind="sec" size="sm" onClick={onQuitter}>← Revenir au plan</Btn>
        <div className="f115 text-slate-500">
          Exercice {db.year} · le plan est dérivé du ciblage déjà saisi, commune par commune.</div>
      </div>

      <div className="grid gap-4" style={{gridTemplateColumns:"minmax(340px,1fr) minmax(420px,1.4fr)"}}>
        <div className="space-y-4">
          <Card title="① Ce que l'on distribue">
            <div className="grid grid-cols-2 gap-x-3">
              <Field label="Type d'activité">
                <Select value={act} options={PDD_ACTS} onChange={e=>setAct(e.target.value)} /></Field>
              <Field label="Code d'activité" hint="Celui du ciblage : il décide des nombres lus">
                <Select value={tag} options={db.lists.tags.map(t=>[t.code, `${t.code} — ${t.label}`])}
                  empty="Total dédoublonné" onChange={e=>setTag(e.target.value)} /></Field>
            </div>
            <Field label="Intitulé de l'activité">
              <Input value={actMain} onChange={e=>setMain(e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-x-3">
              <Field label="Ligne budgétaire (WBS)"><Input value={wbs} onChange={e=>setWbs(e.target.value)} /></Field>
              <Field label="Partenaire d'exécution">
                <Select value={partner} empty="À désigner plus tard"
                  options={(db.partners||[]).filter(p=>p.active!==false).map(p=>[p.id, p.name])}
                  onChange={e=>setPartner(e.target.value)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-x-3">
              <Field label="Modalité">
                <Select value={mod} options={PDD_MODALITIES} onChange={e=>setMod(e.target.value)} /></Field>
              <Field label="Jours de ration">
                <Input type="number" value={jours} onChange={e=>setJours(e.target.value)} /></Field>
            </div>
            {mod==="Food"
              ? <div className="grid grid-cols-2 gap-x-3">
                  <Field label="Denrée">
                    <Select value={denree} options={PDD_COMMODITIES} onChange={e=>setDenree(e.target.value)} /></Field>
                  <Field label="Ration" hint="kg par personne et par jour">
                    <Input type="number" step="0.01" value={ration} onChange={e=>setRation(e.target.value)} /></Field>
                </div>
              : <Field label="Transfert" hint={`${db.settings?.currency || "MGA"} par personne et par jour`}>
                  <Input type="number" value={transfert} onChange={e=>setTransfert(e.target.value)} /></Field>}
          </Card>

          <Card title="② Quand" subtitle={mois.length ? `${mois.length} mois retenus` : "Aucun mois retenu"}>
            <div className="flex flex-wrap gap-1.5">
              {MONTHS_L.map((m,i)=>(
                <button key={i} onClick={()=>setMois(x => x.includes(i) ? x.filter(y=>y!==i) : [...x,i].sort((a,b)=>a-b))}
                  className={clsx("px-2.5 py-1 rounded border f115 font-semibold transition-colors",
                    mois.includes(i) ? "bd-brand bg-sky-50 text-sky-900" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>
                  {m.slice(0,4)}</button>))}
            </div>
            <div className="flex gap-2 mt-3">
              <Btn size="sm" kind="ghost" onClick={()=>setMois([0,1,2,3,4,5,6,7,8,9,10,11])}>Toute l'année</Btn>
              <Btn size="sm" kind="ghost" onClick={()=>setMois([])}>Aucun</Btn>
            </div>
          </Card>

          <Card title="③ Combien de bénéficiaires">
            <Field label="Origine des nombres">
              <Select value={source} onChange={e=>setSource(e.target.value)}
                options={[["ciblage","À partir du ciblage saisi"],["fixe","Un nombre fixe par commune"]]} /></Field>
            {source==="ciblage"
              ? <Field label="Taux de couverture" hint="Part des personnes ciblées effectivement servies ce mois-là">
                  <Input type="number" value={couv} onChange={e=>setCouv(e.target.value)} /></Field>
              : <Field label="Bénéficiaires par commune et par mois">
                  <Input type="number" value={fixe} onChange={e=>setFixe(e.target.value)} /></Field>}
            <Field label="Lignes déjà présentes">
              <Select value={conflits} onChange={e=>setConflits(e.target.value)}
                options={[["ignorer","Les laisser telles quelles"],
                          ["remplacer","Les remplacer par les nouvelles"]]} /></Field>
          </Card>
        </div>

        <div className="space-y-4">
          <Card flush title="④ Où" subtitle={
            zones.loading ? "Lecture du ciblage…"
              : `${retenues.length} commune(s) retenue(s) sur ${rows.length}`}
            right={<div className="flex gap-1.5">
              <Btn size="sm" kind="ghost" onClick={avecCiblage}>Celles qui ont un ciblage</Btn>
              <Btn size="sm" kind="sec" onClick={toutes}>
                {rows.length && rows.every(z=>sel.has(z.pcode)) ? "Aucune" : "Toutes"}</Btn></div>}>
            <div className="flex flex-wrap gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
              <Select value={filtre.adm1} onChange={e=>setFiltre({ adm1:e.target.value, adm2:"" })}
                empty="Toutes les régions" options={regions} className="mi-py1 mi-xs mi-wauto" />
              <Select value={filtre.adm2} onChange={e=>setFiltre(f=>({ ...f, adm2:e.target.value }))}
                empty="Tous les districts" options={districts} className="mi-py1 mi-xs mi-wauto" />
            </div>
            {zones.err && <Note tone="warn">{zones.err}</Note>}
            {!zones.loading && !rows.length && <Empty title="Aucune commune dans votre périmètre"
              text="Chargez un découpage administratif et déclarez le périmètre des bureaux pour planifier ici." />}
            {!!rows.length && <TableWrap max="mh420">
              <thead><tr><Th /><Th>Commune</Th><Th>District</Th><Th>Bureau</Th>
                <Th num>Ciblés</Th><Th num>Prévu / mois</Th><Th>Déjà planifié</Th></tr></thead>
              <tbody>{rows.map(z => { const on = sel.has(z.pcode);
                const prevu = source==="fixe" ? n(fixe) : Math.round(z.targeted * n(couv) / 100);
                return (
                <tr key={z.pcode} onClick={()=>basculer(z.pcode)}
                  className={clsx("cursor-pointer", on ? "bg-sky-50" : "hover:bg-slate-50")}>
                  <Td><input type="checkbox" checked={on} readOnly /></Td>
                  <Td className="font-medium">{z.name}</Td>
                  <Td className="f115 text-slate-500">{z.adm2 || "—"}</Td>
                  <Td>{z.bureau ? <Badge>{z.bureau}</Badge>
                     : <span className="f10 text-amber-700">hors périmètre</span>}</Td>
                  <Td num className={clsx("tabular-nums", !z.targeted && "text-amber-700")}>
                    {z.targeted ? fmt(z.targeted) : "aucun"}</Td>
                  <Td num className="tabular-nums">{prevu ? fmt(prevu) : "—"}</Td>
                  <Td className="f105 text-slate-500">
                    {z.dejaPlanifie ? `${z.dejaPlanifie.mois.length} mois · ${fmt(z.dejaPlanifie.benef)} bénéf.` : "—"}</Td>
                </tr>); })}</tbody>
            </TableWrap>}
          </Card>

          <Card title="⑤ Vérifier, puis écrire"
            subtitle={pret ? `${fmt(lignesPrevues)} ligne(s) — ${retenues.length} commune(s) × ${mois.length} mois`
                           : "Retenez au moins une commune et un mois"}>
            {pret && <StatRow>
              <Stat label="Lignes à créer" value={fmt(lignesPrevues)} icon={ClipboardList} />
              <Stat label="Bénéficiaires par mois" value={fmt(cibleTotale)} icon={Users} />
              <Stat label={mod==="Food" ? "Tonnage par mois" : "Transferts par mois"}
                value={mod==="Food"
                  ? fmt(Math.round(cibleTotale * n(jours) * n(ration) / 1000)) + " t"
                  : fmt(cibleTotale * n(jours) * n(transfert))} icon={Layers} />
            </StatRow>}
            {apercu && <div className="mt-3">
              <Note tone={apercu.sansBenef ? "warn" : "info"}>
                <b>{fmt(apercu.lignes)} ligne(s)</b> seront écrites : {fmt(apercu.beneficiaires)} bénéficiaires
                sur l'ensemble des mois, {fmt(apercu.menages)} ménages
                {apercu.tonnage ? `, ${fmt(apercu.tonnage)} t` : ""}
                {apercu.montant ? `, ${fmt(apercu.montant)} ${db.settings?.currency || "MGA"}` : ""}.
                {apercu.ignorees ? ` ${apercu.ignorees} ligne(s) existent déjà et seront laissées telles quelles.` : ""}
                {apercu.remplacees ? ` ${apercu.remplacees} ligne(s) existantes seront remplacées.` : ""}
                {apercu.sansBenef ? ` ${apercu.sansBenef} commune(s) n'ont aucun ciblage : leurs lignes naîtront à zéro bénéficiaire.` : ""}
                {apercu.sansBureau ? ` ${apercu.sansBureau} commune(s) ne relèvent d'aucun bureau.` : ""}
              </Note>
            </div>}
            <div className="flex gap-2 mt-3">
              <Btn kind="sec" disabled={!pret || busy==="apercu"} onClick={voir}>
                {busy==="apercu" ? "Calcul…" : "Vérifier ce qui sera créé"}</Btn>
              <Btn icon={Check} disabled={!pret || !apercu || busy==="gen"} onClick={ecrire}>
                {busy==="gen" ? "Écriture…" : `Créer ${fmt(apercu?.lignes || lignesPrevues)} ligne(s)`}</Btn>
            </div>
            {!apercu && pret && <div className="f105 text-slate-400 mt-2">
              L'aperçu est obligatoire : il dit ce qui existe déjà, ce qui n'a pas de ciblage
              et ce qui ne relève d'aucun bureau — trois choses qu'on ne veut pas découvrir après coup.</div>}
          </Card>
        </div>
      </div>
    </div>);
}

/* Reprendre un mois vers d'autres : un plan de soudure se répète, avec des volumes
   qui varient peu. Le recopier à la main est exactement ce qu'une machine doit faire. */
function ReprendreMois({ db, notify, onFini, onFermer }){
  const [de,setDe] = useState(new Date().getMonth());
  const [vers,setVers] = useState([]);
  const [facteur,setFacteur] = useState(100);
  const [act,setAct] = useState("");
  const [conflits,setConflits] = useState("ignorer");
  const [busy,setBusy] = useState(false);
  const dispo = [...new Set((db.pdd||[]).map(l=>l.month))].sort((a,b)=>a-b);
  const nSource = (db.pdd||[]).filter(l => l.month===de && (!act || l.actType===act)).length;

  const lancer = async () => {
    setBusy(true);
    try{
      const r = await api.pddDuplicate({ year:db.year, fromMonth:de, toMonths:vers,
        actType: act || undefined, conflits, facteur: n(facteur)/100 });
      notify(`${r.creees} ligne(s) reprises` + (r.ignorees ? `, ${r.ignorees} déjà présentes` : ""), "ok");
      await onFini(); onFermer();
    }catch(e){ notify(e.message, "err"); }
    finally{ setBusy(false); }
  };

  return (
    <Modal open onClose={onFermer} title="Reprendre un mois vers d'autres"
      subtitle="Les réalisations ne sont jamais recopiées : elles n'ont pas eu lieu"
      footer={<><Btn kind="sec" onClick={onFermer}>Annuler</Btn>
        <Btn disabled={!vers.length || !nSource || busy} onClick={lancer}>
          {busy ? "Reprise…" : `Reprendre ${nSource} ligne(s) vers ${vers.length} mois`}</Btn></>}>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Mois d'origine" hint={`${nSource} ligne(s) dans ce mois`}>
          <Select value={String(de)} onChange={e=>setDe(+e.target.value)}
            options={MONTHS_L.map((m,i)=>[String(i), m + (dispo.includes(i) ? "" : " — vide")])} /></Field>
        <Field label="Activité" >
          <Select value={act} empty="Toutes" options={PDD_ACTS} onChange={e=>setAct(e.target.value)} /></Field>
      </div>
      <Field label="Mois de destination">
        <div className="flex flex-wrap gap-1.5">
          {MONTHS_L.map((m,i)=>(
            <button key={i} disabled={i===de}
              onClick={()=>setVers(x => x.includes(i) ? x.filter(y=>y!==i) : [...x,i].sort((a,b)=>a-b))}
              className={clsx("px-2.5 py-1 rounded border f115 font-semibold disabled:opacity-30",
                vers.includes(i) ? "bd-brand bg-sky-50 text-sky-900" : "border-slate-200 text-slate-600 hover:bg-slate-50")}>
              {m.slice(0,4)}</button>))}
        </div></Field>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Ajustement des volumes" hint="100 % reprend à l'identique">
          <Input type="number" value={facteur} onChange={e=>setFacteur(e.target.value)} /></Field>
        <Field label="Lignes déjà présentes">
          <Select value={conflits} onChange={e=>setConflits(e.target.value)}
            options={[["ignorer","Les laisser"],["remplacer","Les remplacer"]]} /></Field>
      </div>
    </Modal>);
}

function DistributionPlan({ db, set, me, notify, can, reload }){
  /* La conception occupe l'écran entier plutôt qu'une fenêtre : on y choisit des
     communes dans une liste de plusieurs centaines, et une fenêtre modale sur ce
     travail-là revient à travailler par le trou d'une serrure. */
  const [mode,setMode] = useState("liste");
  const [reprise,setReprise] = useState(false);
  const [q,setQ] = useState(""); const [fMonth,setFMonth] = useState(""); const [fBureau,setFBureau] = useState("");
  const [fAct,setFAct] = useState(""); const [fMod,setFMod] = useState(""); const [fDistrict,setFDistrict] = useState("");
  const [edit,setEdit] = useState(null); const [sel,setSel] = useState(new Set()); const [bulk,setBulk] = useState(false);
  const [page,setPage] = useState(1);
  const pdd = db.pdd || [];
  const rows = pdd.filter(l => {
    if(fMonth!=="" && l.month!==+fMonth) return false;
    if(fBureau && l.bureau!==fBureau) return false;
    if(fAct && l.actType!==fAct) return false;
    if(fMod && l.modality!==fMod) return false;
    if(fDistrict && l.district!==fDistrict) return false;
    if(q && ![l.commune,l.district,l.region,l.bureau,l.partner,l.commodity,l.actMain].join(" ").toLowerCase().includes(q.toLowerCase())) return false;
    return true; });
  const per = n(db.settings.pageSize)||25;
  const pages = Math.max(1, Math.ceil(rows.length/per));
  const shown = rows.slice((Math.min(page,pages)-1)*per, Math.min(page,pages)*per);
  const bureaux = [...new Set(pdd.map(l=>l.bureau))].sort();
  const districts = [...new Set(pdd.filter(l=>!fBureau||l.bureau===fBureau).map(l=>l.district))].sort();
  const agg = pddAgg(rows);
  const food = rows.filter(l=>l.modality==="Food").reduce((t,l)=>t+n(l.tonnage),0);
  const cash = rows.filter(l=>l.modality!=="Food").reduce((t,l)=>t+n(l.amount),0);

  const save = (l) => { set(d => { d.pdd = d.pdd||[]; const i=d.pdd.findIndex(x=>x.id===l.id);
      if(i>=0) d.pdd[i]={...d.pdd[i],...l}; else d.pdd.push({ ...l, id:uid("pdd") });
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:l.bureau,
        kind:"plan", text:`Ligne de PDD ${i>=0?"modifiée":"créée"} — ${l.commune} / ${l.actType}` });
      return d; }); setEdit(null); notify("Ligne enregistrée","ok"); };
  const applyBulk = (patch) => { set(d => { d.pdd.forEach(l=>{ if(sel.has(l.id)) Object.assign(l, patch); }); return d; });
    notify(`${sel.size} ligne(s) mise(s) à jour`,"ok"); setSel(new Set()); };
  const exportPDD = () => download(`pdd_${db.year}.csv`, toCSV(rows.map(l=>({ ...l,
    mois: MONTHS_L[l.month], tauxBeneficiaires: pddRates(l).benef, tauxReception: pddRates(l).reception,
    tauxDistribution: pddRates(l).distribution })),
    ["mois","year","wbs","actType","tag","actMain","bureau","region","district","commune","partner","modality",
     "commodity","days","benefPlanned","households","tonnage","amount","benefActual","received","distributed",
     "tauxBeneficiaires","tauxReception","tauxDistribution","status"]), "text/csv");
  const importPDD = (file) => { const rd=new FileReader();
    rd.onload=()=>{ const parsed=parseCSV(rd.result); if(!parsed.length){ notify("Fichier vide","err"); return; }
      const mi = (v)=>{ const k=MONTHS_L.findIndex(m=>m.toLowerCase()===String(v).toLowerCase().trim());
        return k>=0?k:(n(v)||0); };
      set(d=>{ d.pdd = d.pdd||[];
        parsed.forEach(r=>{ d.pdd.push({ id:uid("pdd"), month:mi(r.mois||r.month), year:n(r.year)||d.year,
          wbs:r.wbs||"", actType:r.actType||"GD", tag:r.tag||"", actMain:r.actMain||"",
          bureau:r.bureau||"", region:r.region||"", district:r.district||"", commune:r.commune||"",
          partner:r.partner||"", modality:r.modality||"Food", commodity:r.commodity||"", days:n(r.days),
          benefPlanned:n(r.benefPlanned), households:n(r.households), tonnage:n(r.tonnage), amount:n(r.amount),
          benefActual:n(r.benefActual), received:n(r.received), distributed:n(r.distributed),
          status:r.status||"planned", note:"" }); });
        return d; });
      notify(`${parsed.length} ligne(s) importée(s)`,"ok"); };
    rd.readAsText(file,"utf-8"); };
  const BFIELDS = [["bureau","Bureau de terrain",bureaux],["actType","Type d'activité",PDD_ACTS],
    ["modality","Modalité",PDD_MODALITIES],["commodity","Type de denrée",PDD_COMMODITIES],
    ["partner","Partenaire",db.lists.partners],["days","Jours de ration",[["15","15 jours"],["30","30 jours"]]],
    ["month","Mois du PDD",MONTHS_L.map((m,i)=>[String(i),m])],["status","Statut",PDD_STATUS]];

  /* Les lignes sont écrites par le serveur, pas par la file de synchronisation :
     on relit l'état pour les voir. */
  const relire = async () => { setMode("liste"); if(reload) await reload(); };

  if(mode === "concevoir")
    return <ConcevoirPdd db={db} notify={notify} onFini={relire} onQuitter={()=>setMode("liste")} />;

  return (
    <>
      {reprise && <ReprendreMois db={db} notify={notify} onFini={relire} onFermer={()=>setReprise(false)} />}
      <StatRow>
        <Stat label="Lignes de plan" value={fmt(rows.length)} sub={`${bureaux.length} bureaux de terrain`} icon={ClipboardList} />
        <Stat label="Bénéficiaires planifiés" value={fmt(agg.benefPlanned)} sub={`${fmt(agg.benefActual)} servis`} icon={Users} />
        <Stat label="Tonnage planifié" value={fmt(Math.round(food))+" t"} icon={Layers} />
        <Stat label="Transferts planifiés" value={fmt(Math.round(cash))} sub="MGA" icon={Target} />
        <Stat label="Taux de distributions" value={rate(agg.distribution)}
          tone={agg.distribution>=0.9?"ok":agg.distribution>=0.6?"warn":"bad"} sub="Distribué ÷ planifié" icon={Activity} />
      </StatRow>
      <Card flush title="Plan de distribution — PDD"
        subtitle="Une ligne par mois, bureau de terrain, commune, type d'activité et modalité">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          <div className="relative"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="Commune, district, partenaire…"
              className={clsx(inputCls,"pl-8 w-56 mi-py1")} /></div>
          <Select value={fMonth} onChange={e=>{setFMonth(e.target.value);setPage(1);}} empty="Tous les mois"
            options={MONTHS_L.map((m,i)=>[String(i),m])} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fBureau} onChange={e=>{setFBureau(e.target.value);setFDistrict("");setPage(1);}} empty="Tous les bureaux"
            options={bureaux} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fDistrict} onChange={e=>{setFDistrict(e.target.value);setPage(1);}} empty="Tous les districts"
            options={districts} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fAct} onChange={e=>{setFAct(e.target.value);setPage(1);}} empty="Toutes les activités"
            options={PDD_ACTS} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fMod} onChange={e=>{setFMod(e.target.value);setPage(1);}} empty="Toutes les modalités"
            options={PDD_MODALITIES} className="mi-py1 mi-xs mi-wauto" />
          <div className="ml-auto flex gap-2">
            <label><input type="file" accept=".csv" className="hidden" onChange={e=>e.target.files[0]&&importPDD(e.target.files[0])} />
              <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer"><Upload size={13}/> Importer</span></label>
            <Btn size="sm" kind="sec" icon={Download} onClick={exportPDD}>Exporter</Btn>
            {can("edit") && <Btn size="sm" kind={bulk?"primary":"sec"} icon={Layers}
              onClick={()=>{setBulk(b=>!b);setSel(new Set());}}>{bulk?"Quitter la sélection":"Modification groupée"}</Btn>}
            {can("edit") && <Btn size="sm" kind="sec" icon={RefreshCw} onClick={()=>setReprise(true)}>Reprendre un mois</Btn>}
            {can("edit") && <Btn size="sm" icon={Target} onClick={()=>setMode("concevoir")}>Concevoir le plan</Btn>}
            {can("edit") && <Btn size="sm" kind="ghost" icon={Plus} onClick={()=>setEdit({ month:new Date().getMonth(), year:db.year,
              wbs:"URT1", actType:"GD", tag:"URT_GD", actMain:"", bureau:bureaux[0]||"", region:"", district:"", commune:"",
              partner:db.lists.partners[0], modality:"Food", commodity:"Riz", days:15, benefPlanned:0, households:0,
              tonnage:0, amount:0, benefActual:0, received:0, distributed:0, status:"planned" })}>Ajouter une ligne</Btn>}
          </div>
        </div>
        {bulk && <PddBulkBar sel={sel} rows={rows} fields={BFIELDS}
          onSelectAll={()=>setSel(new Set(rows.map(l=>l.id)))} onClear={()=>setSel(new Set())}
          onApply={(f,v)=>applyBulk({ [f]: ["days","month"].includes(f) ? n(v) : v })} />}
        <TableWrap>
          <thead><tr>
            {bulk && <Th className="w-9"><input type="checkbox" checked={sel.size===shown.length&&shown.length>0}
              onChange={e=>setSel(e.target.checked ? new Set(shown.map(l=>l.id)) : new Set())} /></Th>}
            {["PDD mois de","Bureau de terrain","Région","District","Commune","Type d'activité","Activity tag",
              "Modalités","Type de denrée","Jours"].map(h=><Th key={h}>{h}</Th>)}
            {["Bénéficiaires planifiés","Ménages","Tonnage (t)","Montant (MGA)"].map(h=><Th key={h} num>{h}</Th>)}
            <Th>Partenaire</Th><Th>Statut</Th><Th />
          </tr></thead>
          <tbody>{shown.map(l=>(
            <tr key={l.id} className={clsx("hover:bg-sky-50", sel.has(l.id)&&"bg-sky-50", !bulk&&can("edit")&&"cursor-pointer")}
                onClick={()=>!bulk && can("edit") && setEdit(l)}>
              {bulk && <Td onClick={e=>e.stopPropagation()}><input type="checkbox" checked={sel.has(l.id)}
                onChange={e=>{ const x=new Set(sel); e.target.checked?x.add(l.id):x.delete(l.id); setSel(x); }} /></Td>}
              <Td className="f115">{MONTHS[l.month]}-{String(l.year).slice(2)}</Td>
              <Td className="font-medium text-slate-800">{l.bureau}</Td>
              <Td className="text-slate-600">{l.region}</Td><Td className="text-slate-600">{l.district}</Td>
              <Td className="font-medium">{l.commune}</Td>
              <Td><Badge tone={l.actType==="GD"?"b":"g"}>{l.actType}</Badge></Td>
              <Td className="f11 text-slate-500">{l.tag}</Td>
              <Td><Badge tone={l.modality==="Food"?"n":"y"}>{l.modality}</Badge></Td>
              <Td className="text-slate-600">{l.commodity||"—"}</Td><Td className="text-slate-600">{l.days}</Td>
              <Td num>{fmt(l.benefPlanned)}</Td><Td num className="text-slate-500">{fmt(l.households)}</Td>
              <Td num>{l.modality==="Food"?r2(l.tonnage):"—"}</Td>
              <Td num>{l.modality!=="Food"?fmt(Math.round(l.amount)):"—"}</Td>
              <Td className="text-slate-600">{l.partner}</Td>
              <Td><Badge tone={l.status==="done"?"g":l.status==="ongoing"?"y":l.status==="cancelled"?"r":"n"}>
                {(PDD_STATUS.find(x=>x[0]===l.status)||[])[1]}</Badge></Td>
              <Td className="text-right" onClick={e=>e.stopPropagation()}>
                {can("edit") && <button onClick={()=>setEdit(l)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                {can("del") && <button onClick={()=>set(d=>{ d.pdd=d.pdd.filter(x=>x.id!==l.id); return d; })}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
            </tr>))}</tbody>
        </TableWrap>
        {!rows.length && <Empty icon={ClipboardList} title="Aucune ligne de plan"
          text="Importez un PDD au format CSV ou ajoutez les lignes une à une." />}
        {rows.length>per && (
          <div className="flex items-center gap-3 px-4 py-2.5 border-t border-slate-100 f125 text-slate-600">
            <span>{(Math.min(page,pages)-1)*per+1} à {Math.min(page*per,rows.length)} sur {fmt(rows.length)}</span>
            <div className="ml-auto flex items-center gap-1">
              <Btn size="sm" kind="sec" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
              <span className="px-2 tabular-nums">{Math.min(page,pages)} / {pages}</span>
              <Btn size="sm" kind="sec" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Suivant</Btn></div>
          </div>)}
      </Card>
      <PddModal open={!!edit} line={edit} db={db} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function PddBulkBar({ sel, rows, fields, onSelectAll, onClear, onApply }){
  const [field,setField] = useState(fields[0][0]); const [val,setVal] = useState("");
  const cur = fields.find(f=>f[0]===field) || fields[0];
  return (
    <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-sky-50 border-b border-sky-200">
      <div className="f13 font-semibold text-sky-900 self-center">{sel.size} ligne(s) sélectionnée(s)</div>
      <Btn size="sm" kind="sec" onClick={onSelectAll}>Sélectionner les {rows.length} lignes filtrées</Btn>
      <div><div className="f11 font-semibold text-slate-600 mb-1">Champ à modifier</div>
        <Select value={field} onChange={e=>{setField(e.target.value);setVal("");}}
          options={fields.map(f=>[f[0],f[1]])} className="mi-py1 mi-xs mi-wauto" /></div>
      <div><div className="f11 font-semibold text-slate-600 mb-1">Nouvelle valeur</div>
        {cur[2].length
          ? <Select value={val} onChange={e=>setVal(e.target.value)} empty="—" options={cur[2]} className="mi-py1 mi-xs mi-wauto" />
          : <Input value={val} onChange={e=>setVal(e.target.value)} className="mi-py1 mi-xs w-40" />}</div>
      <Btn size="sm" icon={Check} disabled={!sel.size||val===""} onClick={()=>onApply(field,val)}>Appliquer</Btn>
      <Btn size="sm" kind="ghost" onClick={onClear}>Désélectionner</Btn>
    </div>);
}
function PddModal({ open, line, db, onClose, onSave }){
  const [f,setF] = useState({});
  /* Avant tout retour anticipé : un hook ne peut pas être conditionnel. */
  const geo = useGeoCascade({ adm1:f.region, adm2:f.district, adm3:f.commune });
  useEffect(()=>{ setF(line||{}); },[line]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const r = pddRates(f); const pl = pddPlanned(f);
  const regions = geo.adm1.map(x=>x.name);
  return (
    <Modal open wide onClose={onClose} title={line?.id?`PDD — ${f.commune}`:"Nouvelle ligne de plan"}
      subtitle="Planification, puis saisie des réalisations"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave({ ...f, geo_pcode: geo.pcode })}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="PDD mois de"><Select value={f.month??0} onChange={e=>u("month",n(e.target.value))}
          options={MONTHS_L.map((m,i)=>[i,m])} /></Field>
        <Field label="Année"><Input type="number" value={f.year??db.year} onChange={e=>u("year",n(e.target.value))} /></Field>
        <Field label="WBS"><Input value={f.wbs||""} onChange={e=>u("wbs",e.target.value)} /></Field>
        <Field label="Type d'activité"><Select value={f.actType||"GD"} onChange={e=>{ u("actType",e.target.value);
          u("tag", e.target.value==="GD"?"URT_GD":e.target.value==="PREVMA"?"URT_PREV":""); }} options={PDD_ACTS} /></Field>
        <Field label="Activity tag"><Input value={f.tag||""} onChange={e=>u("tag",e.target.value)} /></Field>
        <Field label="Activité principale" className="col-span-3"><Input value={f.actMain||""} onChange={e=>u("actMain",e.target.value)} /></Field>
        <Field label="Bureau de terrain"><Input value={f.bureau||""} onChange={e=>u("bureau",e.target.value)} /></Field>
        <Field label="Région"><Select value={f.region||""} empty="—" options={withCurrent(regions, f.region)}
          onChange={e=>{ u("region",e.target.value); u("district",""); u("commune",""); }} /></Field>
        {/* District et commune viennent du référentiel plutôt que d'une saisie libre :
            c'est ce qui rend l'agrégation « par commune » fiable. La valeur déjà
            enregistrée reste proposée même si elle n'y figure pas, pour ne rien effacer. */}
        <Field label="District"><Select value={f.district||""} empty="—" disabled={!f.region}
          onChange={e=>{ u("district",e.target.value); u("commune",""); }}
          options={withCurrent(geo.adm2.map(x=>x.name), f.district)} /></Field>
        <Field label="Commune"><Select value={f.commune||""} empty="—" disabled={!f.district}
          onChange={e=>u("commune",e.target.value)}
          options={withCurrent(geo.adm3.map(x=>x.name), f.commune)} /></Field>
        <Field label="Modalité"><Select value={f.modality||"Food"} onChange={e=>u("modality",e.target.value)} options={PDD_MODALITIES} /></Field>
        <Field label="Type de denrée"><Select value={f.commodity||""} onChange={e=>u("commodity",e.target.value)}
          empty="—" options={PDD_COMMODITIES} /></Field>
        <Field label="Jours de ration"><Input type="number" value={f.days??15} onChange={e=>u("days",n(e.target.value))} /></Field>
        <Field label="Partenaire"><Select value={f.partner||""} onChange={e=>u("partner",e.target.value)} empty="—" options={db.lists.partners} /></Field>
      </div>
      <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2 border-t border-slate-200 pt-3">Planification</div>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="Bénéficiaires planifiés"><Input type="number" value={f.benefPlanned??0} onChange={e=>u("benefPlanned",n(e.target.value))} /></Field>
        <Field label="Ménages"><Input type="number" value={f.households??0} onChange={e=>u("households",n(e.target.value))} /></Field>
        <Field label="Tonnage planifié (t)"><Input type="number" step="0.01" value={f.tonnage??0} onChange={e=>u("tonnage",n(e.target.value))} /></Field>
        <Field label="Montant planifié (MGA)"><Input type="number" value={f.amount??0} onChange={e=>u("amount",n(e.target.value))} /></Field>
      </div>
      <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2 border-t border-slate-200 pt-3">Réalisation</div>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="Bénéficiaires servis"><Input type="number" value={f.benefActual??0} onChange={e=>u("benefActual",n(e.target.value))} /></Field>
        <Field label={`Quantité reçue (${pl.unit})`}><Input type="number" step="0.01" value={f.received??0} onChange={e=>u("received",n(e.target.value))} /></Field>
        <Field label={`Quantité distribuée (${pl.unit})`}><Input type="number" step="0.01" value={f.distributed??0} onChange={e=>u("distributed",n(e.target.value))} /></Field>
        <Field label="Statut"><Select value={f.status||"planned"} onChange={e=>u("status",e.target.value)} options={PDD_STATUS} /></Field>
      </div>
      <div className="grid grid-cols-3 gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden">
        {[["Taux bénéficiaires", rate(r.benef), r.benef],["Taux de réception", rate(r.reception), r.reception],
          ["Taux de distributions", rate(r.distribution), r.distribution]].map(([l,v,x])=>(
          <div key={l} className="bg-white px-3 py-2.5">
            <div className="f10 uppercase tracking-wide font-bold text-slate-500">{l}</div>
            <div className={clsx("text-lg font-light tabular-nums mt-0.5",
              x===null?"text-slate-400":x>=0.9?"text-lime-700":x>=0.6?"text-amber-600":"text-rose-700")}>{v}</div></div>))}
      </div>
      <Field label="Observation" className="mt-3"><Input value={f.note||""} onChange={e=>u("note",e.target.value)} /></Field>
    </Modal>);
}


/* ══════════════════ Réalisation des distributions ══════════════════ */
function DistributionActual({ db, set, notify, can }){
  const [tab,setTab] = useState("saisie");
  const [fMonth,setFMonth] = useState(""); const [fBureau,setFBureau] = useState("");
  const [fAct,setFAct] = useState(""); const [fMod,setFMod] = useState(""); const [q,setQ] = useState("");
  const [page,setPage] = useState(1);
  const pdd = db.pdd || [];
  const rows = pdd.filter(l => {
    if(fMonth!=="" && l.month!==+fMonth) return false;
    if(fBureau && l.bureau!==fBureau) return false;
    if(fAct && l.actType!==fAct) return false;
    if(fMod && l.modality!==fMod) return false;
    if(q && ![l.commune,l.district,l.bureau,l.partner].join(" ").toLowerCase().includes(q.toLowerCase())) return false;
    return true; });
  const bureaux = [...new Set(pdd.map(l=>l.bureau))].sort();
  const modalities = [...new Set(pdd.map(l=>l.modality))];
  const months = [...new Set(pdd.map(l=>l.month))].sort((a,b)=>a-b);
  const per = n(db.settings.pageSize)||25;
  const pages = Math.max(1, Math.ceil(rows.length/per));
  const shown = rows.slice((Math.min(page,pages)-1)*per, Math.min(page,pages)*per);
  const upd = (id, k, v) => set(d => { const l = d.pdd.find(x=>x.id===id);
    if(l){ l[k] = n(v); if(k==="distributed" && n(v)>0 && l.status==="planned") l.status="done"; } return d; });
  const agg = pddAgg(rows);

  /* Tableau croisé : Modalité → Mois → Bureau, colonnes GD et PREVMA */
  const pivot = useMemo(()=>{
    const out = [];
    modalities.forEach(mod => {
      const modLines = rows.filter(l=>l.modality===mod);
      if(!modLines.length) return;
      out.push({ kind:"modality", label:mod, cells:pivotCells(modLines) });
      months.forEach(mi => {
        const mLines = modLines.filter(l=>l.month===mi); if(!mLines.length) return;
        bureaux.forEach(b => { const bl = mLines.filter(l=>l.bureau===b); if(!bl.length) return;
          out.push({ kind:"row", mod, month:mi, bureau:b, cells:pivotCells(bl) }); });
        out.push({ kind:"subtotal", mod, month:mi, label:`01/${String(mi+1).padStart(2,"0")}/${db.year} Total`, cells:pivotCells(mLines) });
      });
    });
    out.push({ kind:"grand", label:"Grand Total", cells:pivotCells(rows) });
    return out; },[rows, modalities.join(), months.join(), bureaux.join(), db.year]);

  function pivotCells(lines){
    const gd = pddAgg(lines.filter(l=>l.actType==="GD"));
    const pv = pddAgg(lines.filter(l=>l.actType==="PREVMA"));
    return { gd, pv };
  }
  const chart = bureaux.map(b => { const bl = rows.filter(l=>l.bureau===b);
    const gd = pddAgg(bl.filter(l=>l.actType==="GD")), pv = pddAgg(bl.filter(l=>l.actType==="PREVMA"));
    return { bureau:b, "Taux de distributions GD (%)": gd.distribution===null?0:r2(gd.distribution*100),
      "Taux de distributions PREVMA (%)": pv.distribution===null?0:r2(pv.distribution*100) }; });
  const exportPivot = () => { const out = [];
    pivot.forEach(p => out.push({ Modalités: p.kind==="modality"?p.label:(p.kind==="row"?p.mod:p.kind==="grand"?"":p.mod),
      "PDD mois de": p.kind==="row" ? `${MONTHS[p.month]}-${String(db.year).slice(2)}` : (p.kind==="subtotal"?p.label:""),
      "Bureau de terrain": p.kind==="row" ? p.bureau : (p.kind==="grand"?p.label:""),
      "Taux bénéficiaires (%) GD": rate(p.cells.gd.benef), "Taux de réception (%) GD": rate(p.cells.gd.reception),
      "Taux de distributions GD (%)": rate(p.cells.gd.distribution),
      "Taux bénéficiaires (%) PREVMA": rate(p.cells.pv.benef), "Taux de réception (%) PREVMA": rate(p.cells.pv.reception),
      "Taux de distributions PREVMA (%)": rate(p.cells.pv.distribution) }));
    download("etat_distributions.csv", toCSV(out, Object.keys(out[0]||{})), "text/csv");
    notify("État des distributions exporté","ok"); };

  return (
    <>
      <StatRow>
        <Stat label="Lignes suivies" value={fmt(rows.length)} icon={ClipboardList} />
        <Stat label="Taux bénéficiaires" value={rate(agg.benef)} tone={rateTone(agg.benef)==="g"?"ok":rateTone(agg.benef)==="y"?"warn":"bad"}
          sub={`${fmt(agg.benefActual)} / ${fmt(agg.benefPlanned)}`} icon={Users} />
        <Stat label="Taux de réception" value={rate(agg.reception)} tone={rateTone(agg.reception)==="g"?"ok":rateTone(agg.reception)==="y"?"warn":"bad"} icon={Download} />
        <Stat label="Taux de distributions" value={rate(agg.distribution)} tone={rateTone(agg.distribution)==="g"?"ok":rateTone(agg.distribution)==="y"?"warn":"bad"} icon={Target} />
        <Stat label="Lignes sans réalisation" value={rows.filter(l=>!n(l.distributed)).length} tone="warn" icon={AlertTriangle} />
      </StatRow>

      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["saisie","Saisie des réalisations"],["etat","État consolidé"]]} />

      <Card flush title={tab==="saisie" ? "Réalisation par ligne de PDD" : "État des distributions"}
        subtitle={tab==="saisie" ? "Saisissez les bénéficiaires servis, la quantité reçue et la quantité distribuée"
          : "Taux consolidés par modalité, mois et bureau de terrain, avec sous-totaux"}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          {tab==="saisie" && <div className="relative"><Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="Commune, district…"
              className={clsx(inputCls,"pl-8 w-48 mi-py1")} /></div>}
          <Select value={fMonth} onChange={e=>{setFMonth(e.target.value);setPage(1);}} empty="Tous les mois"
            options={months.map(m=>[String(m),MONTHS_L[m]])} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fBureau} onChange={e=>{setFBureau(e.target.value);setPage(1);}} empty="Tous les bureaux"
            options={bureaux} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fAct} onChange={e=>{setFAct(e.target.value);setPage(1);}} empty="Toutes les activités"
            options={PDD_ACTS} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fMod} onChange={e=>{setFMod(e.target.value);setPage(1);}} empty="Toutes les modalités"
            options={PDD_MODALITIES} className="mi-py1 mi-xs mi-wauto" />
          <Btn size="sm" kind="sec" icon={Download} className="ml-auto" onClick={exportPivot}>Exporter l'état</Btn>
        </div>

        {tab==="saisie" ? (
          <>
            <TableWrap>
              <thead><tr>
                {["Mois","Bureau","Commune","Activité","Modalité"].map(h=><Th key={h}>{h}</Th>)}
                {["Bénéf. planifiés","Bénéf. servis","Planifié","Reçu","Distribué"].map(h=><Th key={h} num>{h}</Th>)}
                {["Taux bénéficiaires","Taux de réception","Taux de distributions"].map(h=><Th key={h}>{h}</Th>)}
              </tr></thead>
              <tbody>{shown.map(l=>{ const r=pddRates(l); const pl=pddPlanned(l);
                return (<tr key={l.id} className="hover:bg-sky-50">
                  <Td className="f115">{MONTHS[l.month]}-{String(l.year).slice(2)}</Td>
                  <Td className="font-medium">{l.bureau}</Td><Td>{l.commune}</Td>
                  <Td><Badge tone={l.actType==="GD"?"b":"g"}>{l.actType}</Badge></Td>
                  <Td><Badge tone={l.modality==="Food"?"n":"y"}>{l.modality}</Badge></Td>
                  <Td num>{fmt(l.benefPlanned)}</Td>
                  <Td num><input type="number" value={l.benefActual??0} disabled={!can("edit")}
                    onChange={e=>upd(l.id,"benefActual",e.target.value)}
                    className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  <Td num className="text-slate-500">{pl.unit==="t"?r2(pl.qty):fmt(Math.round(pl.qty))}</Td>
                  <Td num><input type="number" step="0.01" value={l.received??0} disabled={!can("edit")}
                    onChange={e=>upd(l.id,"received",e.target.value)}
                    className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  <Td num><input type="number" step="0.01" value={l.distributed??0} disabled={!can("edit")}
                    onChange={e=>upd(l.id,"distributed",e.target.value)}
                    className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  {[r.benef,r.reception,r.distribution].map((v,i)=>(
                    <Td key={i}><div className="flex items-center gap-2">
                      <Bar2 value={v===null?0:v*100} tone={v===null?"":v>=0.9?"ok":v>=0.6?"warn":"bad"} />
                      <span className="tabular-nums f115">{rate(v)}</span></div></Td>))}
                </tr>); })}</tbody>
            </TableWrap>
            {!rows.length && <Empty icon={ClipboardList} title="Aucune ligne"
              text="Le plan de distribution alimente cette saisie : basculez sur « Plan de distribution » pour le créer." />}
            {rows.length>per && (
              <div className="flex items-center gap-3 px-4 py-2.5 border-t border-slate-100 f125 text-slate-600">
                <span>{(Math.min(page,pages)-1)*per+1} à {Math.min(page*per,rows.length)} sur {fmt(rows.length)}</span>
                <div className="ml-auto flex items-center gap-1">
                  <Btn size="sm" kind="sec" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
                  <span className="px-2 tabular-nums">{Math.min(page,pages)} / {pages}</span>
                  <Btn size="sm" kind="sec" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Suivant</Btn></div>
              </div>)}
          </>
        ) : (
          <TableWrap>
            <thead>
              <tr><Th className="mi-tc" >Modalités</Th><Th>PDD mois de</Th><Th>Bureau de terrain</Th>
                <Th num className="mi-tc">Taux bénéficiaires (%) GD</Th><Th num className="mi-tc">Taux de réception (%) GD</Th>
                <Th num className="mi-tc">Taux de distributions GD (%)</Th>
                <Th num className="mi-tc">Taux bénéficiaires (%) PREVMA</Th><Th num className="mi-tc">Taux de réception (%) PREVMA</Th>
                <Th num className="mi-tc">Taux de distributions PREVMA (%)</Th></tr>
            </thead>
            <tbody>{pivot.map((p,i)=>{
              const cls = p.kind==="modality" ? "bg-slate-100 font-semibold"
                : p.kind==="subtotal" ? "bg-sky-50 font-semibold"
                : p.kind==="grand" ? "bg-slate-800 text-white font-semibold" : "hover:bg-sky-50";
              const cell = (v) => (
                <Td num className={p.kind==="grand"?"":""}>
                  <span className={clsx("tabular-nums", v===null ? "text-slate-400"
                    : p.kind==="grand" ? "" : v>=0.9 ? "text-lime-700" : v>=0.6 ? "text-amber-700" : "text-rose-700")}>{rate(v)}</span></Td>);
              return (
                <tr key={i} className={cls}>
                  <Td>{p.kind==="modality" ? p.label : p.kind==="grand" ? "" : ""}</Td>
                  <Td>{p.kind==="row" ? `${MONTHS[p.month]}-${String(db.year).slice(2)}` : p.kind==="subtotal" ? p.label : ""}</Td>
                  <Td className="font-medium">{p.kind==="row" ? p.bureau : p.kind==="grand" ? p.label : ""}</Td>
                  {cell(p.cells.gd.benef)}{cell(p.cells.gd.reception)}{cell(p.cells.gd.distribution)}
                  {cell(p.cells.pv.benef)}{cell(p.cells.pv.reception)}{cell(p.cells.pv.distribution)}
                </tr>); })}</tbody>
          </TableWrap>)}
      </Card>

      <Card title="Taux de distributions par bureau de terrain" subtitle="Comparaison des deux types d'activité">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chart} margin={{top:22,right:10,left:-10,bottom:24}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
            <XAxis dataKey="bureau" tick={{fontSize:10.5,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false}
              angle={-18} textAnchor="end" height={54} interval={0} />
            <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} tickFormatter={v=>v+" %"} />
            <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}} formatter={v=>r2(v)+" %"} />
            <Legend wrapperStyle={{fontSize:11}} />
            <Bar dataKey="Taux de distributions GD (%)" fill={C.brandD} radius={[2,2,0,0]} barSize={26} />
            <Bar dataKey="Taux de distributions PREVMA (%)" fill={C.orange} radius={[2,2,0,0]} barSize={26} />
          </BarChart></ResponsiveContainer>
      </Card>
    </>);
}

function OutcomePlan({ db, set, notify, can }){
  const rows = db.indicators;
  const planned = db.outcomePlan || {};
  const cellOf = (r,mi) => ({ planned: !!(planned[r.id]||[])[mi],
    done: db.outcomes.some(x=>x.indicator===r.id && new Date(x.date).getMonth()===mi), activeMonth:true, missed:false });
  const toggle = (r,mi) => set(d => { d.outcomePlan = d.outcomePlan || {};
    d.outcomePlan[r.id] = d.outcomePlan[r.id] || Array(12).fill(false);
    d.outcomePlan[r.id][mi] = !d.outcomePlan[r.id][mi]; return d; });
  return (
    <>
      <Note>Calendrier de collecte par indicateur. La liste provient de la masterlist définie dans
        Paramètres → Indicateurs ; une case verte signale qu'une valeur a été enregistrée ce mois-là.</Note>
      <Card flush title="Plan de collecte des indicateurs de résultat">
        <MonthLegend />
        <MonthGrid rows={rows} labelOf={r=>r.name}
          subOf={r=>`${r.id} · ${r.basket} · ${r.method} · ${r.freq}`}
          cellOf={cellOf} onCell={(r,mi)=>can("edit")&&toggle(r,mi)} />
      </Card>
    </>);
}

export { CoveragePlan, DistributionActual, DistributionPlan, MonthCellModal, MonthGrid, MonthLegend, OutcomePlan, Overreaching, PDD_ACTS, PDD_COMMODITIES, PDD_MODALITIES, PDD_STATUS, ParamModal, PddBulkBar, PddModal, Planning, ProcessPlan, pddAgg, pddPlanned, pddRates, rate, rateTone, seedPDD };
