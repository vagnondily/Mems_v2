import { useMemo, useState } from "react";
import { Activity, CalendarRange, Check, ClipboardList, Database, Download, FileText, Target, Users } from "lucide-react";
import { PolarAngleAxis, Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, RadialBar, RadialBarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Select, Stat, TableWrap, Td, Th } from "../components/ui.jsx";
import { computeMMR, fmt, monthsSince, n, pct, r1, r2, siteRequirement } from "../lib/calc.js";
import { C, D_TAGS, MONTHS, MONTHS_L, SERIES } from "../lib/constants.js";
import { pddAgg, pddRates, rate } from "./Planning.jsx";
import { AlertesApercu } from "./Alerts.jsx";

/* ══════════════════ Accueil ══════════════════ */
function Home({ db, me, go }){
  const [mFilter,setMFilter] = useState("all");
  const mmr = useMemo(()=>computeMMR(db, db.year), [db]);
  const nowM = new Date().getMonth();

  const last3 = useMemo(()=>{ const out=[];
    for(let k=2;k>=0;k--){ const m=nowM-k; if(m<0) continue;
      out.push({ mois:MONTHS[m],
        "Sites actifs": db.sites.filter(s=>s.status!=="Inactive" && s.plan[m]?.activeMonth!==false).length,
        "Visites planifiées": db.sites.reduce((t,s)=>t+(s.plan[m]?.planned?1:0),0),
        "Sites visités": db.visits.filter(v=>new Date(v.date).getMonth()===m && new Date(v.date).getFullYear()===db.year).length }); }
    return out; },[db,nowM]);

  const byTag = useMemo(()=>{ const rows={};
    db.sites.forEach(s => { const lbl = (D_TAGS.find(t=>t[0]===s.activityTag)||[s.activityTag,s.activityTag])[1];
      rows[s.activityTag] = rows[s.activityTag] || { activite: lbl.slice(0,26), plan:0, reached:0 };
      s.plan.forEach((p,i)=>{ if(mFilter!=="all" && i!==+mFilter) return;
        if(p.planned) rows[s.activityTag].plan++; if(p.done) rows[s.activityTag].reached++; }); });
    return Object.values(rows).filter(r=>r.plan||r.reached); },[db,mFilter]);

  const annualKeys = useMemo(()=>[...new Set(db.sites.map(s=>s.activityTag))],[db]);
  const annual = useMemo(()=>MONTHS.map((m,i)=>{ const row={mois:m};
    annualKeys.forEach(k => { row[k] = db.sites.filter(s=>s.activityTag===k).reduce((t,s)=>t+(s.plan[i]?.done?1:0),0); });
    return row; }),[db,annualKeys]);
  const annualByTag = useMemo(()=>annualKeys.map(k => { const g=db.sites.filter(s=>s.activityTag===k);
    const p=g.reduce((t,s)=>t+s.plan.filter(x=>x.planned).length,0);
    const d=g.reduce((t,s)=>t+s.plan.filter(x=>x.done).length,0);
    return { tag:k, plan:p, done:d, pct:pct(d,p) }; }).sort((a,b)=>b.pct-a.pct),[db,annualKeys]);

  const dist = useMemo(()=>{
    const lines = db.pdd || [];
    const bureaux = [...new Set(lines.map(l=>l.bureau))].sort();
    const chart = bureaux.map(b => { const bl = lines.filter(l=>l.bureau===b);
      const gd = pddAgg(bl.filter(l=>l.actType==="GD")), pv = pddAgg(bl.filter(l=>l.actType==="PREVMA"));
      return { bureau:b, "Taux de distributions GD (%)": gd.distribution===null?0:r2(gd.distribution*100),
        "Taux de distributions PREVMA (%)": pv.distribution===null?0:r2(pv.distribution*100) }; });
    return { chart, all: pddAgg(lines), pending: lines.filter(l=>!n(l.distributed)).length,
      byMonth: [...new Set(lines.map(l=>l.month))].sort((a,b)=>a-b).map(mi=>{ const ml=lines.filter(l=>l.month===mi);
        const a=pddAgg(ml); return { mois:MONTHS[mi], "Bénéficiaires": a.benef===null?0:r2(a.benef*100),
          "Réception": a.reception===null?0:r2(a.reception*100), "Distribution": a.distribution===null?0:r2(a.distribution*100) }; }) };
  },[db]);

  const recent = db.audit.slice().sort((a,b)=>b.at.localeCompare(a.at));
  return (
    <div className="space-y-4">
      {/* Le titre et le salut sont rendus par la coquille : c'est elle qui sait où
          l'on est. Ne restent ici que les deux raccourcis, qui sont du contenu. */}
      <div className="flex justify-end gap-2 flex-wrap">
        <Btn kind="sec" icon={CalendarRange} onClick={()=>go("suivi","monitoring")}>Plan de suivi</Btn>
        <Btn icon={FileText} onClick={()=>go("reports","build")}>Générer un rapport</Btn>
      </div>

      <div className="grid gap-4" style={{gridTemplateColumns:"minmax(270px,320px) 1fr"}}>
        <Card title="Exigence minimale de suivi" subtitle={`Réalisé rapporté au requis, au prorata de ${mmr.elapsed} mois`}>
          <div className="flex flex-col items-center">
            <div className="relative w-44 h-24 overflow-hidden">
              <ResponsiveContainer width="100%" height={190}>
                <RadialBarChart innerRadius="72%" outerRadius="100%" startAngle={180} endAngle={0}
                  data={[{ v:Math.min(100,mmr.pct), fill: mmr.pct>=80?C.ok : mmr.pct>=50?C.warn : C.bad }]}>
                  {/* Un graphique polaire attend un axe polaire : XAxis n'y a pas sa place. */}
                  <PolarAngleAxis type="number" domain={[0,100]} angleAxisId={0} tick={false} />
                  <RadialBar dataKey="v" cornerRadius={4} background={{fill:"#e8edf1"}} />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="absolute inset-x-0 bottom-1 text-center">
                <div className="text-4xl font-light tabular-nums leading-none"
                  style={{color: mmr.pct>=80?C.ok : mmr.pct>=50?"#b5820b" : C.bad}}>{mmr.pct}%</div></div>
            </div>
            <div className="grid grid-cols-2 gap-3 w-full mt-4 pt-4 border-t border-slate-100 text-center">
              <div><div className="text-xl font-light tabular-nums text-slate-800">{fmt(mmr.done)}</div>
                <div className="f11 text-slate-500">visites réalisées</div></div>
              <div><div className="text-xl font-light tabular-nums text-slate-800">{fmt(mmr.required)}</div>
                <div className="f11 text-slate-500">visites requises</div></div>
            </div>
            <div className="w-full mt-3 pt-3 border-t border-slate-100 f12 text-slate-600 flex justify-between">
              <span>Sites couverts au moins une fois</span>
              <b className="tabular-nums">{mmr.visitedSites}/{mmr.activeSites} · {mmr.coverage}%</b></div>
          </div>
        </Card>
        <Card title="Trois derniers mois" subtitle="Sites actifs, visites planifiées et sites visités">
          <ResponsiveContainer width="100%" height={228}>
            <ComposedChart data={last3} margin={{top:6,right:6,left:-18,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
              <XAxis dataKey="mois" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
              <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}} />
              <Legend wrapperStyle={{fontSize:11}} />
              <Bar dataKey="Sites actifs" fill="#cfe0ea" radius={[2,2,0,0]} barSize={26} />
              <Bar dataKey="Visites planifiées" fill={C.brandL} radius={[2,2,0,0]} barSize={26} />
              <Line type="monotone" dataKey="Sites visités" stroke={C.ok} strokeWidth={2.5} dot={{r:3.5}} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* L'aperçu remplace un tableau de cent trente-neuf lignes tronqué à quarante
          sans le dire. Il donne les natures et leurs comptes ; la liste complète a sa
          destination, ouverte par la cloche ou par ce bouton. */}
      <AlertesApercu db={db} go={go} />

      <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr"}}>
        <Card title="Plan et réalisé par catégorie d'activité"
          right={<Select value={mFilter} onChange={e=>setMFilter(e.target.value)} className="mi-py1 mi-xs mi-wauto"
            options={[["all","Toute l'année"], ...MONTHS_L.map((m,i)=>[String(i),m])]} />}>
          {byTag.length ? (
            <ResponsiveContainer width="100%" height={252}>
              <BarChart data={byTag} layout="vertical" margin={{top:4,right:16,left:8,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" horizontal={false} />
                <XAxis type="number" tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="activite" width={150} tick={{fontSize:10.5,fill:C.t2}} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}} />
                <Legend wrapperStyle={{fontSize:11}} />
                <Bar dataKey="plan" name="Planifié" fill={C.brandL} radius={[0,2,2,0]} barSize={9} />
                <Bar dataKey="reached" name="Réalisé" fill={C.ok} radius={[0,2,2,0]} barSize={9} />
              </BarChart></ResponsiveContainer>
          ) : <Empty icon={Target} title="Aucune donnée sur la période" />}
        </Card>
        <Card title="Information annuelle" subtitle="Réalisations mensuelles réparties par activité">
          <div className="flex gap-4">
            <div className="w-32 shrink-0">
              <div className="text-3xl font-light tabular-nums text-slate-800">
                {pct(annualByTag.reduce((t,a)=>t+a.done,0), annualByTag.reduce((t,a)=>t+a.plan,0))}%</div>
              <div className="f11 text-slate-500 mb-3">réalisation totale</div>
              <div className="space-y-2 mh190 overflow-auto pr-1">
                {annualByTag.map(a=>(<div key={a.tag}>
                  <div className="flex justify-between f105 text-slate-600 mb-0.5"><span>{a.tag}</span><b className="tabular-nums">{a.pct}%</b></div>
                  <Bar2 value={a.pct} tone={a.pct>=80?"ok":a.pct>=50?"warn":"bad"} /></div>))}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <ResponsiveContainer width="100%" height={252}>
                <AreaChart data={annual} margin={{top:6,right:6,left:-20,bottom:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                  <XAxis dataKey="mois" tick={{fontSize:10,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                  <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{fontSize:11,borderRadius:3,border:"1px solid "+C.line}} />
                  {annualKeys.map((k,i)=>(<Area key={k} type="monotone" dataKey={k} stackId="1"
                    stroke={SERIES[i%SERIES.length]} fill={SERIES[i%SERIES.length]} fillOpacity={.55} />))}
                </AreaChart></ResponsiveContainer>
            </div>
          </div>
        </Card>
      </div>

      {(db.pdd||[]).length>0 && (
        <Card flush title="État des distributions" subtitle="Réalisation du plan de distribution, par bureau de terrain et par mois"
          right={<><Badge tone={dist.all.distribution>=0.9?"g":dist.all.distribution>=0.6?"y":"r"}>
              Taux global de distributions {rate(dist.all.distribution)}</Badge>
            {dist.pending>0 && <Badge tone="y">{dist.pending} ligne(s) sans réalisation</Badge>}
            <Btn size="sm" kind="sec" icon={ClipboardList} onClick={()=>go("programme","distribution")}>Saisir les réalisations</Btn></>}>
          <div className="grid gap-px bg-slate-200 border-b border-slate-200"
            style={{gridTemplateColumns:"repeat(auto-fit,minmax(176px,1fr))"}}>
            <Stat label="Bénéficiaires servis" value={fmt(dist.all.benefActual)}
              sub={`sur ${fmt(dist.all.benefPlanned)} planifiés`} icon={Users} />
            <Stat label="Taux bénéficiaires" value={rate(dist.all.benef)}
              tone={dist.all.benef>=0.9?"ok":dist.all.benef>=0.6?"warn":"bad"} icon={Target} />
            <Stat label="Taux de réception" value={rate(dist.all.reception)}
              tone={dist.all.reception>=0.9?"ok":dist.all.reception>=0.6?"warn":"bad"} icon={Download} />
            <Stat label="Taux de distributions" value={rate(dist.all.distribution)}
              tone={dist.all.distribution>=0.9?"ok":dist.all.distribution>=0.6?"warn":"bad"} icon={Activity} />
            <Stat label="Lignes de PDD" value={fmt(dist.all.count)} sub={`${dist.chart.length} bureaux`} icon={ClipboardList} />
          </div>
          <div className="grid gap-4 p-4" style={{gridTemplateColumns:"1.5fr 1fr"}}>
            <div>
              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Taux de distributions par bureau</div>
              <ResponsiveContainer width="100%" height={264}>
                <BarChart data={dist.chart} margin={{top:18,right:8,left:-12,bottom:24}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                  <XAxis dataKey="bureau" tick={{fontSize:10,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false}
                    angle={-18} textAnchor="end" height={52} interval={0} />
                  <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} tickFormatter={v=>v+" %"} />
                  <Tooltip contentStyle={{fontSize:11,borderRadius:3}} formatter={v=>r2(v)+" %"} />
                  <Legend wrapperStyle={{fontSize:10.5}} />
                  <Bar dataKey="Taux de distributions GD (%)" fill={C.brandD} radius={[2,2,0,0]} barSize={22} />
                  <Bar dataKey="Taux de distributions PREVMA (%)" fill={C.orange} radius={[2,2,0,0]} barSize={22} />
                </BarChart></ResponsiveContainer>
            </div>
            <div>
              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Évolution mensuelle des trois taux</div>
              <ResponsiveContainer width="100%" height={264}>
                <LineChart data={dist.byMonth} margin={{top:18,right:8,left:-14,bottom:24}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                  <XAxis dataKey="mois" tick={{fontSize:10,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                  <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} tickFormatter={v=>v+" %"} />
                  <Tooltip contentStyle={{fontSize:11,borderRadius:3}} formatter={v=>r2(v)+" %"} />
                  <Legend wrapperStyle={{fontSize:10.5}} />
                  <Line type="monotone" dataKey="Bénéficiaires" stroke={C.brand} strokeWidth={2.2} dot={{r:3}} />
                  <Line type="monotone" dataKey="Réception" stroke={C.aqua} strokeWidth={2.2} dot={{r:3}} />
                  <Line type="monotone" dataKey="Distribution" stroke={C.ok} strokeWidth={2.4} dot={{r:3.5}} />
                </LineChart></ResponsiveContainer>
            </div>
          </div>
        </Card>)}

      <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr"}}>
        {[["Mise à jour de la planification", recent.filter(a=>a.kind==="plan").slice(0,5), CalendarRange],
          ["Mise à jour des données par bureau", recent.filter(a=>a.kind==="odk").slice(0,5), Database]].map(([title,list,Icon])=>(
          <Card key={title} title={title} subtitle="Interventions des bureaux de terrain">
            {list.length ? (
              <ul className="divide-y divide-slate-100 -my-1">{list.map(a=>(
                <li key={a.id} className="py-2.5 flex items-start gap-3">
                  <Icon size={15} className="text-slate-300 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1"><div className="f13 text-slate-800">{a.text}</div>
                    <div className="f11 text-slate-500 mt-0.5">{a.user} · {a.office} · {new Date(a.at).toLocaleString("fr-FR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</div></div>
                </li>))}</ul>
            ) : <Empty icon={Icon} title="Aucune activité récente" />}
          </Card>))}
      </div>
    </div>);
}

export { Home };
