import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { Activity, Check, ClipboardList, Download, Globe, Link2, ListChecks, Pencil, Plus, Save, Target, Trash2, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Field, Input, Modal, Note, Select, Stat, StatRow, TableWrap, Tabs, Td, Th } from "../components/ui.jsx";
import { POP_BASE_YEAR, clsx, computeMMR, fmt, n, pct, populationFor, uid } from "../lib/calc.js";
import { C, D_ADJUST, MONTHS, MONTHS_L, SERIES } from "../lib/constants.js";
import { DistributionActual, rate } from "./Planning.jsx";
import { SitesModule } from "./Settings.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Actual Data ══════════════════ */
function ActualData({ db, set, sub, setSub, me, notify, can, go }){
  const items = [["summary","Résumé global"],["process","Suivi de processus"],["sites","Sites"],["map","Cartographie"],["distrib","Distributions"],["output","Outputs et population"],["outcome","Outcomes"],["sources","Sources de données"]];
  return (
    <div className="space-y-4">
      <PageHead title="Actual Data" text="Données réellement collectées : soumissions ODK Central, couverture des sites, produits livrés et indicateurs de résultat." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="summary" && <ActualSummary db={db} />}
      {sub==="process" && <ProcessData db={db} set={set} notify={notify} can={can} go={go} />}
      {sub==="sites" && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="actual" />}
      {sub==="distrib" && <DistributionActual db={db} set={set} notify={notify} can={can} />}
      {sub==="output" && <OutputData db={db} set={set} notify={notify} can={can} />}
      {sub==="outcome" && <OutcomeData db={db} set={set} notify={notify} can={can} go={go} />}
      {sub==="sources" && <Sources db={db} set={set} notify={notify} can={can} />}
    </div>);
}

function ActualSummary({ db }){
  const benef = db.sites.filter(s=>s.status!=="Inactive").reduce((t,s)=>t+n(s.beneficiaries),0);
  const mmr = computeMMR(db, db.year);
  const outPlan = db.outputs.reduce((t,o)=>t+n(o.planned),0);
  const outReal = db.outputs.reduce((t,o)=>t+n(o.actual),0);
  const byMonth = MONTHS.map((m,i)=>({ mois:m,
    Planifié: db.outputs.filter(o=>o.month===i).reduce((t,o)=>t+o.planned,0),
    Atteint:  db.outputs.filter(o=>o.month===i).reduce((t,o)=>t+o.actual,0) }));
  const pop = db.population.reduce((t,p)=>{ const v=populationFor(db,p.key,db.year); return t+(v?v.value:0); },0);
  return (
    <>
      <StatRow>
        <Stat label="Bénéficiaires ciblés" value={fmt(benef)} sub="Sites actifs du registre" icon={Users} />
        <Stat label="Bénéficiaires atteints" value={fmt(outReal)} sub={`${pct(outReal,outPlan)}% du planifié`}
          tone={pct(outReal,outPlan)>=80?"ok":"warn"} icon={Target} />
        <Stat label="Population des zones" value={fmt(pop)} sub={`Estimation ${db.year}`} icon={Globe} />
        <Stat label="Soumissions de suivi" value={fmt(db.visits.length)}
          sub={`${db.visits.filter(v=>v.status==="À valider").length} à valider`} icon={ClipboardList} />
        <Stat label="Exigence minimale" value={mmr.pct+"%"} tone={mmr.pct>=80?"ok":mmr.pct>=50?"warn":"bad"}
          sub={`${mmr.done} / ${mmr.required} visites`} icon={Activity} />
      </StatRow>
      <div className="grid gap-4" style={{gridTemplateColumns:"1.4fr 1fr"}}>
        <Card title="Bénéficiaires planifiés et atteints" subtitle="Toutes activités confondues">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={byMonth} margin={{top:6,right:6,left:-8,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
              <XAxis dataKey="mois" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
              <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}} formatter={v=>fmt(v)} />
              <Legend wrapperStyle={{fontSize:11}} />
              <Bar dataKey="Planifié" fill={C.brandL} radius={[2,2,0,0]} barSize={16} />
              <Bar dataKey="Atteint" fill={C.ok} radius={[2,2,0,0]} barSize={16} />
            </ComposedChart></ResponsiveContainer>
        </Card>
        <Card title="Sources ODK Central" flush subtitle="Dernière extraction par formulaire">
          <TableWrap max="mh300">
            <thead><tr><Th>Formulaire</Th><Th>Type</Th><Th>Extraction</Th><Th num>Enreg.</Th></tr></thead>
            <tbody>{db.odkForms.map(f=>(
              <tr key={f.id}><Td><div className="font-medium">{f.name}</div>
                  <div className="f11 text-slate-400">/v1/projects/…/{f.formId}</div></Td>
                <Td><Badge tone="b">{ {process:"Processus", output:"Output", outcome:"Outcome", sites:"Sites"}[f.kind] }</Badge></Td>
                <Td className="text-slate-500">{f.last || "—"}</Td><Td num>{fmt(f.records)}</Td></tr>))}
            </tbody></TableWrap>
        </Card>
      </div>
    </>);
}

/* ── Suivi de processus : activités reliées à leurs données ODK ── */
function ProcessData({ db, set, notify, can, go }){
  const [fStatus,setFStatus] = useState(""); const [fTag,setFTag] = useState("");
  const rows = db.visits.filter(v=>(!fStatus||v.status===fStatus)&&(!fTag||v.tag===fTag))
    .slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,300);
  const validate = async (id) => {
    try{
      await api.setVisitStatus(id, "Validé");
      set(d => { const v = d.visits.find(x=>x.id===id); if(v) v.status = "Validé"; return d; });
      notify("Visite validée","ok");
    }catch(e){ notify(e.message, "err"); }
  };
  const activities = db.lists.tags.map(t => {
    const sites = db.sites.filter(s=>s.activityTag===t.code);
    const form = db.odkForms.find(f=>f.tag===t.code && f.kind==="process");
    const v = db.visits.filter(x=>x.tag===t.code);
    const planned = sites.reduce((a,s)=>a+s.plan.filter(p=>p.planned).length,0);
    return { ...t, nbSites:sites.length, form, visits:v.length, planned,
      pending:v.filter(x=>x.status==="À valider").length, rate:pct(v.length,planned) };
  }).filter(a=>a.nbSites);
  return (
    <>
      <Card flush title="Activités et sources ODK Central associées"
        subtitle="Chaque catégorie d'activité est reliée au formulaire qui alimente son suivi de processus">
        <TableWrap max="mh340">
          <thead><tr><Th>Activité</Th><Th>Formulaire ODK Central</Th><Th num>Sites</Th><Th num>Planifiées</Th>
            <Th num>Soumissions</Th><Th num>À valider</Th><Th>Couverture</Th><Th /></tr></thead>
          <tbody>{activities.map(a=>(
            <tr key={a.code} className="hover:bg-sky-50">
              <Td><Badge tone="b">{a.code}</Badge> <span className="ml-2 text-slate-700">{a.label}</span></Td>
              <Td>{a.form ? <><span className="font-medium">{a.form.name}</span>
                  <span className="f11 text-slate-400 ml-2">{a.form.formId}</span></>
                : <span className="text-amber-700 f12">Aucun formulaire associé</span>}</Td>
              <Td num>{a.nbSites}</Td><Td num>{a.planned}</Td><Td num>{a.visits}</Td>
              <Td num>{a.pending ? <Badge tone="y">{a.pending}</Badge> : "—"}</Td>
              <Td><div className="flex items-center gap-2"><Bar2 value={a.rate} tone={a.rate>=80?"ok":a.rate>=50?"warn":"bad"} />
                <span className="tabular-nums f115">{a.rate}%</span></div></Td>
              <Td className="text-right"><Btn size="sm" kind="ghost" icon={Link2} onClick={()=>go("settings","odk")}>Configurer</Btn></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <Card flush title="Soumissions de suivi de processus"
        subtitle={`${db.visits.length} enregistrements · ${db.visits.filter(v=>v.status==="À valider").length} en attente`}
        right={<><Select value={fTag} onChange={e=>setFTag(e.target.value)} empty="Toutes les activités"
            options={db.lists.tags.map(t=>t.code)} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fStatus} onChange={e=>setFStatus(e.target.value)} empty="Tous les statuts"
            options={["Validé","À valider","Erreur"]} className="mi-py1 mi-xs mi-wauto" /></>}>
        <TableWrap>
          <thead><tr><Th>Date</Th><Th>Site</Th><Th>Bureau</Th><Th>Activité</Th><Th>Moniteur</Th><Th>Formulaire</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{rows.map(v=>{ const s = db.sites.find(x=>x.id===v.siteId);
            return (<tr key={v.id} className="hover:bg-sky-50">
              <Td className="f115">{v.date}</Td>
              <Td><div className="font-medium">{s?.poi || v.siteId}</div><div className="f11 text-slate-400">{v.siteId} · {s?.adm3}</div></Td>
              <Td>{v.office}</Td><Td><Badge tone="b">{v.tag}</Badge></Td><Td>{v.monitor}</Td>
              <Td className="f11 text-slate-500">{v.form}</Td>
              <Td><Badge tone={v.status==="Validé"?"g":v.status==="Erreur"?"r":"y"}>{v.status}</Badge></Td>
              <Td className="text-right">{can("validate") && v.status!=="Validé" &&
                <Btn size="sm" kind="ghost" icon={Check} onClick={()=>validate(v.id)}>Valider</Btn>}</Td>
            </tr>); })}</tbody>
        </TableWrap>
      </Card>
    </>);
}

/* ── Outputs et population ── */
function OutputData({ db, set, notify, can }){
  const [tab,setTab] = useState("outputs"); const [year,setYear] = useState(db.year);
  const cell = (tag,mi) => db.outputs.find(o=>o.tag===tag && o.month===mi);
  const upsert = (tag,mi,patch) => set(d => { let o = d.outputs.find(x=>x.tag===tag && x.month===mi);
    if(!o){ o = { id:uid("o"), tag, month:mi, planned:0, actual:0, adjust:"none", note:"" }; d.outputs.push(o); }
    Object.assign(o, patch); return d; });
  const totals = db.lists.tags.map(t => { const g = db.outputs.filter(o=>o.tag===t.code);
    return { ...t, planned:g.reduce((a,o)=>a+n(o.planned),0), actual:g.reduce((a,o)=>a+n(o.actual),0) };
  }).filter(t=>t.planned||t.actual);
  return (
    <>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["outputs","Bénéficiaires par activité"],["population","Population des zones"]]} />
      {tab==="outputs" ? (
        <>
          <Note>Pour chaque mois, saisissez les bénéficiaires planifiés et atteints, et qualifiez l'ajustement :
            extension de la couverture, réduction, ou nouveau ciblage. Ces mentions expliquent les écarts au moment du rapportage.</Note>
          <Card flush title="Bénéficiaires planifiés et atteints par activité"
            subtitle="Saisie mensuelle, avec le motif d'ajustement de la couverture">
            <TableWrap>
              <thead><tr><Th>Activité</Th><Th>Mois</Th><Th num>Planifiés</Th><Th num>Atteints</Th>
                <Th num>Écart</Th><Th>Ajustement</Th><Th>Commentaire</Th></tr></thead>
              <tbody>{db.lists.tags.flatMap(t => MONTHS.map((m,mi) => {
                const o = cell(t.code, mi); if(!o && mi > new Date().getMonth()) return null;
                const p = n(o?.planned), a = n(o?.actual);
                return (
                  <tr key={t.code+mi} className="hover:bg-sky-50">
                    <Td><Badge tone="b">{t.code}</Badge></Td><Td className="text-slate-600">{MONTHS_L[mi]}</Td>
                    <Td num><input type="number" value={p||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{planned:n(e.target.value)})}
                      className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                    <Td num><input type="number" value={a||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{actual:n(e.target.value)})}
                      className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                    <Td num className={a>=p?"text-lime-700":"text-rose-700"}>{p?fmt(a-p):"—"}</Td>
                    <Td><select value={o?.adjust||"none"} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{adjust:e.target.value})}
                      className="px-1.5 py-0.5 f115 border border-slate-200 rounded">
                      {D_ADJUST.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Td>
                    <Td><input value={o?.note||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{note:e.target.value})} placeholder="Motif ou précision"
                      className="w-56 px-1.5 py-0.5 f12 border border-slate-200 rounded" /></Td>
                  </tr>); }).filter(Boolean))}</tbody>
            </TableWrap>
          </Card>
          <Card title="Cumul par activité">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={totals} margin={{top:6,right:6,left:-8,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="code" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{fontSize:12,borderRadius:3}} formatter={v=>fmt(v)} />
                <Legend wrapperStyle={{fontSize:11}} />
                <Bar dataKey="planned" name="Planifiés" fill={C.brandL} radius={[2,2,0,0]} />
                <Bar dataKey="actual" name="Atteints" fill={C.ok} radius={[2,2,0,0]} />
              </BarChart></ResponsiveContainer>
          </Card>
        </>
      ) : (
        <>
          <Note>La population est projetée à partir d'une base <b>{POP_BASE_YEAR}</b> et d'un taux d'accroissement annuel :
            population estimée = base × (1 + taux)<sup>année − {POP_BASE_YEAR}</sup>. Toute valeur saisie manuellement
            pour une année donnée prend le pas sur l'estimation et apparaît en gras.</Note>
          <Card flush title="Population par zone" subtitle={`Base ${POP_BASE_YEAR}, taux d'accroissement et valeurs saisies`}
            right={can("edit") && <Btn size="sm" icon={Plus}
              onClick={()=>set(d=>{ d.population.push({ key:"Nouvelle zone", level:"adm2", base:0, rate:2.5, values:{} }); return d; })}>Ajouter une zone</Btn>}>
            <TableWrap>
              <thead><tr><Th>Zone</Th><Th>Niveau</Th><Th num>Base {POP_BASE_YEAR}</Th><Th num>Taux (%)</Th>
                {[db.year-2,db.year-1,db.year,db.year+1].map(y=><Th key={y} num>{y}</Th>)}<Th /></tr></thead>
              <tbody>{db.population.map((p,i)=>(
                <tr key={i} className="hover:bg-sky-50">
                  <Td><input value={p.key} disabled={!can("edit")} onChange={e=>set(d=>{ d.population[i].key=e.target.value; return d; })}
                    className="w-40 px-1.5 py-0.5 f12 border border-transparent hover:border-slate-300 rounded" /></Td>
                  <Td><select value={p.level} disabled={!can("edit")} onChange={e=>set(d=>{ d.population[i].level=e.target.value; return d; })}
                    className="px-1.5 py-0.5 f115 border border-slate-200 rounded">
                    {[["adm1","Niveau 1"],["adm2","Niveau 2"],["adm3","Niveau 3"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Td>
                  <Td num><input type="number" value={p.base} disabled={!can("edit")} onChange={e=>set(d=>{ d.population[i].base=n(e.target.value); return d; })}
                    className="w-28 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  <Td num><input type="number" step="0.1" value={p.rate} disabled={!can("edit")} onChange={e=>set(d=>{ d.population[i].rate=n(e.target.value); return d; })}
                    className="w-20 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                  {[db.year-2,db.year-1,db.year,db.year+1].map(y=>{ const v=populationFor(db,p.key,y);
                    return (<Td key={y} num>
                      <input value={(p.values&&p.values[y])??""} disabled={!can("edit")}
                        placeholder={v?fmt(v.value):"—"} onChange={e=>set(d=>{ d.population[i].values = d.population[i].values||{};
                          d.population[i].values[y] = e.target.value; return d; })}
                        className={clsx("w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded",
                          v && v.source==="saisie" && "font-bold text-slate-900")} /></Td>); })}
                  <Td className="text-right">{can("del") && <button onClick={()=>set(d=>{ d.population.splice(i,1); return d; })}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
                </tr>))}</tbody>
            </TableWrap>
          </Card>
          <Card title="Projection de population" subtitle="Estimations issues de la base et du taux d'accroissement">
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={Array.from({length:10},(_,k)=>{ const y=POP_BASE_YEAR+k; const row={annee:String(y)};
                db.population.slice(0,6).forEach(p=>{ const v=populationFor(db,p.key,y); row[p.key]= v?v.value:0; }); return row; })}
                margin={{top:6,right:6,left:6,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="annee" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} width={62} tickFormatter={v=>fmt(v)} />
                <Tooltip contentStyle={{fontSize:11,borderRadius:3}} formatter={v=>fmt(v)} />
                <Legend wrapperStyle={{fontSize:10.5}} />
                {db.population.slice(0,6).map((p,i)=>(
                  <Line key={p.key} type="monotone" dataKey={p.key} stroke={SERIES[i%SERIES.length]} strokeWidth={2} dot={false} />))}
              </LineChart></ResponsiveContainer>
          </Card>
        </>)}
    </>);
}

/* ── Outcomes ── */
function OutcomeData({ db, set, notify, can, go }){
  const [edit,setEdit] = useState(null); const [fInd,setFInd] = useState("");
  const rows = db.outcomes.filter(o=>!fInd||o.indicator===fInd)
    .slice().sort((a,b)=>b.date.localeCompare(a.date));
  const summary = db.indicators.map(ind => {
    const vals = db.outcomes.filter(o=>o.indicator===ind.id);
    const last = vals.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
    const base = vals.find(v=>/référence|baseline/i.test(v.round));
    const planned = last ? n(last.planned) || ind.target : ind.target;
    const ok = last ? (ind.dir==="up" ? last.value >= planned : last.value <= planned) : null;
    const prog = last ? (ind.dir==="up" ? pct(last.value, planned) : pct(planned, last.value)) : 0;
    return { ...ind, base: base?base.value:null, last: last?last.value:null, planned, ok, prog:Math.min(150,prog) };
  });
  const save = (row) => { set(d => { const i=d.outcomes.findIndex(x=>x.id===row.id);
      if(i>=0) d.outcomes[i]=row; else d.outcomes.push({ ...row, id:uid("c") }); return d; });
    setEdit(null); notify("Valeur enregistrée","ok"); };
  return (
    <>
      <Note>Les indicateurs proviennent de la masterlist définie dans <b>Paramètres → Indicateurs</b>, où elle peut être
        exportée. On saisit ici la valeur planifiée et la valeur observée pour chaque ronde de collecte.
        Le sens de progression dépend de l'indicateur : certains doivent augmenter, d'autres diminuer.</Note>
      <Card flush title="Situation par indicateur" subtitle="Référence, dernière mesure, valeur planifiée"
        right={<Btn size="sm" kind="sec" icon={ListChecks} onClick={()=>go("settings","indicators")}>Gérer la masterlist</Btn>}>
        <TableWrap max="mh420">
          <thead><tr><Th>Indicateur</Th><Th>Panier</Th><Th num>Référence</Th><Th num>Dernière mesure</Th>
            <Th num>Planifié</Th><Th>Sens</Th><Th>Progression</Th></tr></thead>
          <tbody>{summary.map(r=>(
            <tr key={r.id} className="hover:bg-sky-50">
              <Td><div className="font-medium text-slate-800 mw320 truncate" title={r.name}>{r.name}</div>
                <div className="f11 text-slate-400">{r.id} · {r.method} · {r.freq}</div></Td>
              <Td className="text-slate-600">{r.basket}</Td>
              <Td num>{r.base ?? "—"}</Td>
              <Td num><b className={r.ok===null?"":r.ok?"text-lime-700":"text-rose-700"}>{r.last ?? "—"}</b></Td>
              <Td num>{r.planned}{r.unit==="%"?" %":""}</Td>
              <Td><Badge tone="n">{r.dir==="up"?"↑ à maximiser":"↓ à minimiser"}</Badge></Td>
              <Td><div className="flex items-center gap-2"><Bar2 value={r.prog} tone={r.ok?"ok":r.prog>=80?"warn":"bad"} />
                <span className="tabular-nums f115">{r.prog}%</span></div></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <Card flush title="Valeurs collectées" subtitle="Planification et mesures par ronde et par zone"
        right={<><Select value={fInd} onChange={e=>setFInd(e.target.value)} empty="Tous les indicateurs"
            options={db.indicators.map(i=>[i.id,i.id])} className="mi-py1 mi-xs mi-wauto" />
          {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ indicator:db.indicators[0]?.id, adm1:"",
            round:"Suivi", planned:db.indicators[0]?.target, value:0, date:new Date().toISOString().slice(0,10), sample:0 })}>Ajouter une valeur</Btn>}</>}>
        <TableWrap max="mh420">
          <thead><tr><Th>Indicateur</Th><Th>Zone</Th><Th>Ronde</Th><Th>Date</Th>
            <Th num>Planifié</Th><Th num>Observé</Th><Th num>Échantillon</Th><Th /></tr></thead>
          <tbody>{rows.map(o=>{ const ind=db.indicators.find(i=>i.id===o.indicator);
            const ok = ind ? (ind.dir==="up" ? o.value>=n(o.planned) : o.value<=n(o.planned)) : null;
            return (<tr key={o.id} className="hover:bg-sky-50">
              <Td><Badge tone="b">{o.indicator}</Badge></Td><Td>{o.adm1||"—"}</Td><Td>{o.round}</Td>
              <Td className="f115">{o.date}</Td><Td num>{o.planned}</Td>
              <Td num><b className={ok?"text-lime-700":"text-rose-700"}>{o.value}</b></Td>
              <Td num className="text-slate-500">{fmt(o.sample)}</Td>
              <Td className="text-right">{can("edit") &&
                <button onClick={()=>setEdit(o)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                {can("del") && <button onClick={()=>set(d=>{ d.outcomes=d.outcomes.filter(x=>x.id!==o.id); return d; })}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
            </tr>); })}</tbody>
        </TableWrap>
      </Card>
      <OutcomeModal open={!!edit} row={edit} db={db} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function OutcomeModal({ open, row, db, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(row||{}); },[row]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const ind = db.indicators.find(i=>i.id===f.indicator);
  return (
    <Modal open onClose={onClose} title={row?.id?"Modifier la valeur":"Nouvelle valeur d'indicateur"}
      subtitle={ind?ind.name:""}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Indicateur"><Select value={f.indicator||""} onChange={e=>{ const i=db.indicators.find(x=>x.id===e.target.value);
          setF(p=>({...p, indicator:e.target.value, planned:i?i.target:p.planned})); }}
          options={db.indicators.map(i=>[i.id, `${i.id} — ${i.name.slice(0,44)}`])} /></Field>
        <Field label="Zone"><Select value={f.adm1||""} onChange={e=>u("adm1",e.target.value)} empty="Toutes zones"
          options={[...new Set(db.geo.map(g=>g.adm1))]} /></Field>
        <Field label="Ronde de collecte"><Input value={f.round||""} onChange={e=>u("round",e.target.value)} placeholder="Référence, Suivi S1, Finale" /></Field>
        <Field label="Date de collecte"><Input type="date" value={f.date||""} onChange={e=>u("date",e.target.value)} /></Field>
        <Field label={`Valeur planifiée${ind?" ("+ind.unit+")":""}`}><Input type="number" step="0.1" value={f.planned??0} onChange={e=>u("planned",n(e.target.value))} /></Field>
        <Field label={`Valeur observée${ind?" ("+ind.unit+")":""}`}><Input type="number" step="0.1" value={f.value??0} onChange={e=>u("value",n(e.target.value))} /></Field>
        <Field label="Taille de l'échantillon"><Input type="number" value={f.sample??0} onChange={e=>u("sample",n(e.target.value))} /></Field>
      </div>
      {ind && <Note tone={(ind.dir==="up" ? n(f.value)>=n(f.planned) : n(f.value)<=n(f.planned)) ? "ok":"warn"}>
        Cet indicateur doit {ind.dir==="up"?"augmenter":"diminuer"}. Avec une valeur observée de {f.value} pour un
        objectif de {f.planned}, la cible est {(ind.dir==="up" ? n(f.value)>=n(f.planned) : n(f.value)<=n(f.planned))?"atteinte":"non atteinte"}.
      </Note>}
    </Modal>);
}

/* ── Sources de données ── */
function Sources({ db, set, notify, can }){
  const pull = (f) => { set(d => { const x = d.odkForms.find(y=>y.id===f.id);
      if(x){ x.last = new Date().toLocaleString("fr-FR"); x.records += Math.floor(Math.random()*40); }
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:"Bureau central",
        kind:"odk", text:`Extraction ODK Central — ${f.name}` }); return d; });
    notify(`Extraction lancée sur ${f.name}`,"ok"); };
  return (
    <>
      <Note tone="warn"><b>Lecture des données.</b> Les jeux sont appelés sur ODK Central via
        <code className="bg-white px-1.5 py-0.5 rounded mx-1 f115">{db.settings.odkBase}/v1/projects/&#123;projet&#125;/forms/&#123;formulaire&#125;.svc/Submissions</code>
        avec un jeton porté par l'en-tête d'autorisation. Depuis un navigateur, l'appel n'aboutit que si le serveur
        autorise l'origine de cette page. La configuration complète se fait dans Paramètres → ODK Central.</Note>
      <Card flush title="Formulaires connectés" subtitle="Chaque formulaire alimente une partie de l'application">
        <TableWrap max="mh420">
          <thead><tr><Th>Formulaire</Th><Th>Identifiant</Th><Th>Type de données</Th><Th>Champ site</Th>
            <Th>XLSForm</Th><Th num>Enreg.</Th><Th>Dernière extraction</Th><Th /></tr></thead>
          <tbody>{db.odkForms.map(f=>(
            <tr key={f.id} className="hover:bg-sky-50">
              <Td className="font-medium">{f.name}</Td><Td className="f115">{f.formId}</Td>
              <Td><Badge tone="b">{ {process:"Suivi de processus", output:"Output", outcome:"Outcome", sites:"Registre des sites"}[f.kind] }</Badge></Td>
              <Td className="f115 text-slate-500">{f.siteField || "auto"}</Td>
              <Td>{f.xlsform ? <Badge tone="g">{f.xlsform.name} · {Object.keys(f.labels||{}).length} libellés</Badge> : <Badge>Non joint</Badge>}</Td>
              <Td num>{fmt(f.records)}</Td><Td className="text-slate-500">{f.last || "—"}</Td>
              <Td className="text-right">{can("sync") && <Btn size="sm" kind="ghost" icon={Download} onClick={()=>pull(f)}>Extraire</Btn>}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
    </>);
}

export { ActualData, ActualSummary, OutcomeData, OutcomeModal, OutputData, ProcessData, Sources };
