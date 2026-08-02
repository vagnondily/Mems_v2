import { useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, ClipboardCheck, HelpCircle, Layers, LayoutGrid, Sprout, ShieldCheck, UserCog } from "lucide-react";
import { SUMM_DATA } from "../lib/processAnalyse.js";
import { api } from "../lib/api.js";
import { Card as CardUI } from "../components/ui.jsx";
import { clsx, fmt, pct } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Analyse du suivi de processus ══════════════════
   Reproduction fidèle du tableau de bord de référence WFP Madagascar
   (docs/dashboard_suivi_processus_WFP.html) : par activité, une synthèse pour le
   management/bailleurs, une salle de contrôle des indicateurs, une carte, la
   performance analytique, la qualité par module et la qualité de saisie par agent.

   Les DONNÉES sont l'INSTANTANÉ d'analyse produit sur MoDa (2025-2026) — leur
   STRUCTURE (activités → modules → indicateurs) recoupe le référentiel XLSForm
   vivant de MEMS ; les valeurs se rafraîchiront depuis les soumissions une fois
   la source connectée. Barème, couleurs et pages repris à l'identique. */

/* La grammaire de couleur est celle de TOUTE l'application (lib/constants.js), et
   non celle du document de référence. Le tableau de bord d'origine empruntait sa
   palette à Tailwind — émeraude, citron vert, rose vif — si bien que, dans le MÊME
   écran, la jauge « Couverture » du cockpit était olive/or/cramoisi et l'onglet
   « Analyse process » basculait tout en émeraude/citron/rose : deux verts pour
   « bon », deux rouges pour « alerte », côte à côte. Rien n'apprenait à l'œil ce
   que la couleur voulait dire. « Satisfaisant » reçoit une teinte CLAIRE du vert
   institutionnel, pour rester une nuance de « bon » et non une autre couleur. */
const HEX = { exc:C.ok, sat:"#8fbb4e", imp:C.warn, urg:C.bad, na:C.t3 };
const LAB = { exc:"Excellent", sat:"Satisfaisant", imp:"À améliorer", urg:"Action urgente", na:"Non évalué" };
const band = (v) => v == null ? "na" : v >= 80 ? "exc" : v >= 65 ? "sat" : v >= 50 ? "imp" : "urg";
const bp   = (p) => p == null ? "na" : p >= 80 ? "exc" : p >= 65 ? "sat" : p >= 50 ? "imp" : "urg";
const verdict = (cov, idx) =>
  (cov < 40 || idx < 50) ? { v:"Critique",     bg:C.bad,  d:"Intervention prioritaire : couverture et/ou qualité insuffisantes.", da:"Agir" }
  : (idx < 65 || cov < 65) ? { v:"Vigilance",  bg:C.warn, d:"Renforcer le suivi et cibler les sites les plus faibles.", da:"Surveiller" }
  : { v:"Satisfaisant", bg:C.ok, d:"Maintenir le dispositif et documenter les bonnes pratiques.", da:"Maintenir" };
const tArrow = (trend) => {
  if(!trend || trend.length < 2) return { a:"→", c:HEX.na, w:"stable", d:0 };
  const d = trend[trend.length-1].v - trend[trend.length-2].v;
  return d > 0 ? { a:"↑", c:HEX.exc, w:"en hausse", d } : d < 0 ? { a:"↓", c:HEX.urg, w:"en repli", d } : { a:"→", c:HEX.na, w:"stable", d:0 };
};

/* Résilience (SAMS) ne figurait pas dans l'instantané MoDa de référence : on
   l'ajoute comme activité à part entière, calculée sur le référentiel XLSForm
   vivant et les sites réels (conformité en attente de la collecte). */
const ATABS = [["_OV","Vue d'ensemble",LayoutGrid],["GD","GD/PREVMA",Activity],["SMP","SMP",Activity],
  ["MAM","PECMAM",Activity],["STUNT","Stunting",Activity],["SAMS","Résilience",Sprout]];
const ACCH = { SMP:"#0EA5E9", GD:"#7C3AED", MAM:"#EF4444", STUNT:"#10B981", SAMS:"#0D9488", _OV:"#123A5E" };
/* Pas de page « Carte » ici : la carte principale du cockpit (état par région)
   suffit — une seconde carte de Madagascar prêtait à confusion. */
const PAGES = [["synthese","Synthèse",ClipboardCheck],["controlroom","Salle de contrôle",ShieldCheck],
  ["performance","Performance",BarChart3],["qualite","Qualité",ClipboardCheck],
  ["agent","Agent",UserCog],["aide","Aide",HelpCircle]];

/* La carte est celle de l'application (components/ui.jsx), et non une seconde
   définition locale. L'ancienne divergeait sur trois points — en-tête px-4 py-3
   contre px-5 py-4, titre en gras contre demi-gras, sous-titre plus pâle — si bien
   que les cartes de cette page étaient un peu plus serrées et plus grasses que
   toutes les autres cartes de MEMS, dans le même écran. Une seule définition.
   L'enveloppe ci-dessous ne fait que traduire `sub` en `subtitle`, pour ne pas
   toucher aux quarante appels de ce fichier. */
const Card = ({ sub, ...reste }) => <CardUI subtitle={sub} {...reste} />;

/* ── KPI row ── */
function Kpis({ items }){
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(4,minmax(0,1fr))" }}>
      {items.map((k,i)=>(
        <div key={i} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 relative overflow-hidden">
          <div className="absolute top-0 left-4 h-[3px] w-9 rounded-b" style={{ background:k.cap }} />
          <div className="f105 font-bold uppercase tracking-wide text-slate-400 mt-1">{k.l}</div>
          <div className="f30 font-extrabold text-slate-900 leading-none mt-2 tabular-nums" style={{ color:k.c||undefined }}>{k.v}</div>
          <div className="f105 text-slate-400 mt-1.5">{k.s}</div>
        </div>))}
    </div>);
}

function VerdictBanner({ s }){
  const vd = verdict(s.coverage, s.index); const ar = tArrow(s.trend);
  return (
    <div className="rounded-2xl p-5 flex items-center gap-4 text-white shadow-sm"
      style={{ background:`linear-gradient(110deg, ${vd.bg}, ${vd.bg}cc)` }}>
      <div className="w-12 h-12 rounded-xl bg-white/15 grid place-items-center shrink-0"><Activity size={24}/></div>
      <div className="min-w-0">
        <div className="f10 font-bold uppercase tracking-wider text-white/70">Décision</div>
        <div className="f17 font-extrabold leading-tight">{vd.v} · {vd.da}</div>
        <div className="f115 text-white/85 mt-0.5">{vd.d}</div>
      </div>
      <div className="ml-auto text-right shrink-0">
        <div className="f30 font-extrabold leading-none tabular-nums">{s.index}<span className="f14">/100</span> <span className="f16" style={{ color:"#fff" }}>{ar.a}</span></div>
        <div className="f105 text-white/80 mt-1">indice · couv. {s.coverage}%</div>
      </div>
    </div>);
}

/* ── Donut des classes ── */
function Donut({ cls, total }){
  const order = ["urg","imp","sat","exc","na"];
  const sum = order.reduce((a,k)=>a+(cls[k]||0),0) || 1;
  const R=48, SW=15, C=2*Math.PI*R; let off=0;
  return (
    <div className="relative" style={{ width:120, height:120 }}>
      <svg width="120" height="120" className="-rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="#eef2f6" strokeWidth={SW} />
        {order.map(k=>{ const frac=(cls[k]||0)/sum; if(!frac) return null;
          const seg=<circle key={k} cx="60" cy="60" r={R} fill="none" stroke={HEX[k]} strokeWidth={SW}
            strokeDasharray={`${C*frac} ${C}`} strokeDashoffset={-off*C} />; off+=frac; return seg; })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="f17 font-extrabold text-slate-800 tabular-nums leading-none">{fmt(total)}</div>
        <div className="f9 text-slate-400">visites</div></div>
    </div>);
}

function ClassList({ cls }){
  return (
    <div className="space-y-1.5">
      {["exc","sat","imp","urg","na"].map(k=>(
        <div key={k} className="flex items-center gap-2 f115">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background:HEX[k] }} />
          <span className="text-slate-600 flex-1">{LAB[k]}</span>
          <span className="font-bold text-slate-800 tabular-nums">{fmt(cls[k]||0)}</span></div>))}
    </div>);
}

function Stack({ cls }){
  const order=["exc","sat","imp","urg","na"]; const sum=order.reduce((a,k)=>a+(cls[k]||0),0)||1;
  return (
    <div className="h-4 rounded-full overflow-hidden flex bg-slate-100">
      {order.map(k=>{ const w=(cls[k]||0)/sum*100; return w? <div key={k} style={{ width:`${w}%`, background:HEX[k] }} /> : null; })}
    </div>);
}

/* ── Radar des modules ── */
function Radar({ groups, color }){
  if(!groups || groups.length < 3) return <div className="f115 text-slate-400 p-4">Radar : au moins 3 modules requis.</div>;
  const W=300,H=250,cx=W/2,cy=H/2+6,R=88,n=groups.length;
  const pt=(i,r)=>{ const a=-Math.PI/2 + i*2*Math.PI/n; return [cx+Math.cos(a)*r, cy+Math.sin(a)*r]; };
  const poly=groups.map((g,i)=>pt(i, R*Math.max(0,Math.min(100,g.score))/100).join(",")).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      {[25,50,75,100].map(r=>(<polygon key={r} points={groups.map((_,i)=>pt(i,R*r/100).join(",")).join(" ")}
        fill="none" stroke="#E2E8F0" strokeWidth="1" />))}
      {groups.map((_,i)=>{ const [x,y]=pt(i,R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="#E2E8F0" />; })}
      <polygon points={poly} fill={color+"22"} stroke={color} strokeWidth="2" />
      {groups.map((g,i)=>{ const [x,y]=pt(i, R*Math.max(0,Math.min(100,g.score))/100);
        return <circle key={i} cx={x} cy={y} r="3" fill="#fff" stroke={HEX[bp(g.score)]} strokeWidth="2" />; })}
      {groups.map((g,i)=>{ const [x,y]=pt(i,R+14);
        return <text key={i} x={x} y={y} fontSize="8" fill="#64748B" textAnchor="middle" dominantBaseline="middle">{(g.name||"").slice(0,14)}</text>; })}
    </svg>);
}

function DimsBars({ dims }){
  return (
    <div className="space-y-2">
      {dims.map((d,i)=>(
        <div key={i} className="grid items-center gap-3" style={{ gridTemplateColumns:"150px 1fr 40px" }}>
          <span className="f115 text-slate-600 truncate" title={d.name}>{d.name}</span>
          <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full" style={{ width:`${Math.max(2,d.score)}%`, background:HEX[bp(d.score)] }} /></div>
          <span className="f115 font-bold text-right tabular-nums" style={{ color:HEX[bp(d.score)] }}>{d.score}</span>
        </div>))}
    </div>);
}

/* ── Salle de contrôle : mur d'indicateurs ── */
function ControlWall({ dimGroups }){
  return (
    <div className="space-y-4">
      {dimGroups.map((g,gi)=>(
        <div key={gi}>
          <div className="flex items-center gap-2 mb-2">
            <span className="f11 font-extrabold text-white px-2 py-0.5 rounded" style={{ background:HEX[bp(g.score)] }}>{g.score}</span>
            <span className="f125 font-semibold text-slate-800">{g.name}</span>
            <span className="f105 text-slate-400">{g.inds.length} ind.</span>
          </div>
          <div className="grid gap-2" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(150px,1fr))" }}>
            {g.inds.map((ind,ii)=>{ const c=HEX[bp(ind.pct)];
              return (
              <div key={ii} className="rounded-lg border border-slate-200 px-2.5 py-1.5 flex items-center gap-2"
                style={{ borderLeft:`3px solid ${c}` }} title={`${ind.label} — ${ind.pct}%`}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background:c }} />
                <span className="f105 text-slate-600 truncate flex-1">{ind.label}</span>
                <span className="f11 font-bold tabular-nums" style={{ color:c }}>{ind.pct}</span>
              </div>); })}
          </div>
        </div>))}
    </div>);
}

function RankList({ rows, showVisits }){
  return (
    <div className="space-y-2">
      {rows.map((b,i)=>(
        <div key={i} className="flex items-center gap-2.5">
          <span className="f105 font-bold text-slate-400 w-5 tabular-nums">{i+1}</span>
          <span className="f115 text-slate-700 w-28 truncate" title={b.name}>{b.name}</span>
          <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
            {b.index != null && <div className="h-full rounded-full" style={{ width:`${b.index}%`, background:HEX[bp(b.index)] }} />}</div>
          <span className="f115 font-bold text-right tabular-nums w-14" style={{ color:b.index!=null?HEX[bp(b.index)]:HEX.na }}>
            {b.index != null ? b.index : "—"}{showVisits && <span className="f10 text-slate-400"> · {fmt(b.visits)} vis.</span>}</span>
        </div>))}
    </div>);
}

/* ── Table qualité de saisie par agent ── */
function AgentTable({ agents }){
  const mv = Math.max(1, ...agents.map(a=>a.visits));
  const rows = [...agents].sort((a,b)=>b.visits-a.visits);
  return (
    <div className="overflow-x-auto">
      <table className="w-full f115">
        <thead><tr className="text-left text-slate-400 f10 uppercase tracking-wide border-b border-slate-100">
          <th className="py-2 pr-2">#</th><th className="pr-2">Agent</th><th className="pr-2">Visites saisies</th>
          <th className="pr-2">Taux de remplissage</th><th className="pr-2 text-right">% sans score</th><th className="text-right">Indice moy.</th></tr></thead>
        <tbody>
          {rows.map((a,i)=>{ const fc = a.fill>=70?HEX.exc:a.fill>=45?HEX.imp:HEX.urg;
            return (
            <tr key={i} className="border-b border-slate-50">
              <td className="py-1.5 pr-2 text-slate-400 tabular-nums">{i+1}</td>
              <td className="pr-2 text-slate-700 truncate max-w-[180px]">{a.name}</td>
              <td className="pr-2"><div className="flex items-center gap-1.5"><div className="h-2 rounded-full bg-slate-100 overflow-hidden flex-1 min-w-[60px]">
                <div className="h-full rounded-full" style={{ width:`${a.visits/mv*100}%`, background:"#2563EB" }} /></div>
                <span className="tabular-nums text-slate-500 f11">{fmt(a.visits)}</span></div></td>
              <td className="pr-2"><div className="flex items-center gap-1.5"><div className="h-2 rounded-full bg-slate-100 overflow-hidden flex-1 min-w-[60px]">
                <div className="h-full rounded-full" style={{ width:`${a.fill}%`, background:fc }} /></div>
                <span className="tabular-nums f11" style={{ color:fc }}>{a.fill}%</span></div></td>
              <td className={clsx("pr-2 text-right tabular-nums", a.naPct>20?"text-rose-600 font-semibold":"text-slate-500")}>{a.naPct}%</td>
              <td className="text-right font-bold tabular-nums" style={{ color:a.index!=null?HEX[band(a.index)]:HEX.na }}>{a.index!=null?a.index:"—"}</td>
            </tr>); })}
        </tbody>
      </table>
    </div>);
}

/* Sparkline de tendance de l'indice, ligne de base à 50. */
function Trend({ trend, color, h=120 }){
  if(!trend || !trend.length) return null;
  const W=360, H=h, pad=8, max=100;
  const xs=(i)=> trend.length>1 ? pad + i*(W-2*pad)/(trend.length-1) : W/2;
  const ys=(v)=> H-pad - (v/max)*(H-2*pad);
  const line=trend.map((t,i)=>`${xs(i)},${ys(t.v)}`).join(" ");
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
      <line x1={pad} y1={ys(50)} x2={W-pad} y2={ys(50)} stroke="#EF4444" strokeDasharray="4 4" strokeWidth="1" />
      <text x={W-pad} y={ys(50)-4} fontSize="9" fill="#EF4444" textAnchor="end">50</text>
      <polygon points={`${xs(0)},${H-pad} ${line} ${xs(trend.length-1)},${H-pad}`} fill={color} opacity="0.10" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" />
      {trend.map((t,i)=>(<circle key={i} cx={xs(i)} cy={ys(t.v)} r="2.6" fill="#fff" stroke={color} strokeWidth="1.5" />))}
    </svg>);
}

/* ══════════════════ Pages ══════════════════ */
function PageOverview({ go }){
  const o = SUMM_DATA._OV;
  return (<div className="space-y-3">
    <Kpis items={[
      { l:"Couverture globale", v:o.coverage+"%", cap:"#123A5E", s:`${fmt(o.monitored)}/${fmt(o.planned)} sites` },
      { l:"Visites", v:fmt(o.visits), cap:"#0D9488", s:"4 activités" },
      { l:"Indice pondéré", v:o.index, cap:HEX[band(o.index)], c:HEX[band(o.index)], s:"moyenne" },
      { l:"Sites urgents", v:o.urgentPct+"%", cap:"#EF4444", c:"#EF4444", s:`${fmt(o.classes.urg)} sites` },
    ]} />
    <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(4,minmax(0,1fr))" }}>
      {["SMP","GD","MAM","STUNT"].map(k=>{ const s=SUMM_DATA[k]; const vd=verdict(s.coverage,s.index);
        return (
        <button key={k} onClick={()=>go(k,"synthese")}
          className="text-left bg-white border border-slate-200 rounded-2xl shadow-sm p-4 hover:shadow-md transition-shadow"
          style={{ borderTop:`3px solid ${ACCH[k]}` }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="f105 font-extrabold text-white px-2 py-0.5 rounded" style={{ background:ACCH[k] }}>{k}</span>
            <span className="f10 font-bold text-white px-1.5 py-0.5 rounded ml-auto" style={{ background:vd.bg }}>{vd.v}</span>
          </div>
          <div className="f125 font-semibold text-slate-800 truncate">{s.label.split("·")[0].trim()}</div>
          <div className="flex items-center gap-3 my-2">
            <span className="f16 font-extrabold tabular-nums" style={{ color:HEX[bp(s.coverage)] }}>{s.coverage}%<span className="f10 text-slate-400 font-normal"> couv.</span></span>
            <span className="f16 font-extrabold tabular-nums" style={{ color:HEX[band(s.index)] }}>{s.index}<span className="f10 text-slate-400 font-normal">/100</span></span>
          </div>
          <Stack cls={s.classes} />
        </button>); })}
    </div>
    <div className="grid gap-3" style={{ gridTemplateColumns:"320px 1fr" }}>
      <Card title="Répartition globale">
        <div className="flex items-center gap-4"><Donut cls={o.classes} total={o.visits} /><div className="flex-1"><ClassList cls={o.classes} /></div></div></Card>
      <Card title="Indice par activité" sub="Couverture et indice de qualité, par activité">
        <div className="space-y-2.5">
          {["GD","SMP","MAM","STUNT"].map(k=>{ const s=SUMM_DATA[k];
            return (
            <div key={k} className="grid items-center gap-3" style={{ gridTemplateColumns:"120px 1fr 84px" }}>
              <span className="f115 text-slate-600 truncate">{s.label.split("·")[0].trim()}</span>
              <div className="h-3 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full" style={{ width:`${s.index}%`, background:HEX[band(s.index)] }} /></div>
              <span className="f11 text-right tabular-nums"><b style={{ color:HEX[band(s.index)] }}>{s.index}</b><span className="text-slate-400"> · {s.coverage}%</span></span>
            </div>); })}
        </div></Card>
    </div>
  </div>);
}

function PageSynthese({ s }){
  const dg = s.dimGroups || s.dims;
  return (<div className="space-y-3">
    <VerdictBanner s={s} />
    <Kpis items={[
      { l:"Couverture", v:s.coverage+"%", cap:ACCH[s._k], s:`${fmt(s.monitored)}/${fmt(s.planned)} · cible 80%` },
      { l:"Indice", v:s.index, cap:HEX[band(s.index)], c:HEX[band(s.index)], s:LAB[band(s.index)] },
      { l:"Action urgente", v:s.urgentPct+"%", cap:"#EF4444", c:"#EF4444", s:`${fmt(s.classes.urg)} sites < 50` },
      { l:"Visites", v:fmt(s.visits), cap:"#0D9488", s:`${s.naPct}% non évalué` },
    ]} />
    <div className="grid gap-3" style={{ gridTemplateColumns:"300px 1fr" }}>
      <Card title="Répartition"><div className="flex flex-col items-center gap-3"><Donut cls={s.classes} total={s.visits} /><div className="w-full"><ClassList cls={s.classes} /></div></div></Card>
      <Card title="Profil par module"><DimsBars dims={dg} /></Card>
    </div>
    <div className="grid gap-3" style={{ gridTemplateColumns:"1fr 1fr" }}>
      <Card title="Modules à renforcer en priorité" sub="Les 3 plus faibles">
        <div className="space-y-2">
          {dg.slice(0,3).map((d,i)=>{ const worst=[...d.inds].sort((a,b)=>a.pct-b.pct)[0];
            return (
            <div key={i} className="flex items-start gap-2">
              <span className="f105 font-bold text-white w-5 h-5 grid place-items-center rounded shrink-0" style={{ background:HEX[bp(d.score)] }}>{i+1}</span>
              <div className="min-w-0"><div className="f125 font-semibold text-slate-800">{d.name} — {d.score}%</div>
                {worst && <div className="f105 text-slate-500">Plus bas : « {worst.label} » ({worst.pct}%)</div>}</div>
            </div>); })}
        </div></Card>
      <Card title="Tendance de l'indice">
        <Trend trend={s.trend} color={ACCH[s._k]} />
        <div className="f115 text-slate-500 mt-1">Indice {tArrow(s.trend).w} ({tArrow(s.trend).d>=0?"+":""}{tArrow(s.trend).d} pts vs mois précédent)</div></Card>
    </div>
  </div>);
}

function PageControlRoom({ s }){
  const dg = s.dimGroups || s.dims;
  const all = dg.flatMap(g=>g.inds);
  const cnt = { exc:0, sat:0, imp:0, urg:0 };
  all.forEach(ind=>{ cnt[bp(ind.pct)]++; });
  const conform = all.length ? Math.round((cnt.exc+cnt.sat)/all.length*100) : 0;
  const cr = [["Indicateurs",all.length,"#2563EB"],["Conformes ≥65",conform+"%",HEX.exc],
    ["À surveiller",cnt.imp,HEX.imp],["Critiques",cnt.urg,HEX.urg],["Indice /100",s.index,HEX[band(s.index)]]];
  return (<div className="space-y-3">
    <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(5,minmax(0,1fr))" }}>
      {cr.map(([l,v,c],i)=>(
        <div key={i} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3.5">
          <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background:c }} /><span className="f10 font-bold uppercase tracking-wide text-slate-400">{l}</span></div>
          <div className="f26 font-extrabold text-slate-900 tabular-nums mt-1" style={{ color:c }}>{v}</div></div>))}
    </div>
    <Card title="Mur des indicateurs" sub="Balayez les cellules rouges — du module le plus faible au plus solide">
      <ControlWall dimGroups={dg} /></Card>
  </div>);
}

function PagePerformance({ s }){
  const dg = s.dimGroups || s.dims;
  const all = dg.flatMap(g=>g.inds);
  const top = [...all].sort((a,b)=>b.pct-a.pct).slice(0,6);
  const flop = [...all].sort((a,b)=>a.pct-b.pct).slice(0,6);
  const best = dg[dg.length-1], worst = dg[0]; const ar = tArrow(s.trend);
  const IndRows = ({ items }) => (
    <div className="space-y-1.5">{items.map((ind,i)=>{ const c=HEX[bp(ind.pct)];
      return (<div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns:"1fr 90px 34px" }}>
        <span className="f105 text-slate-600 truncate" title={ind.label}>{ind.label}</span>
        <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full" style={{ width:`${Math.max(2,ind.pct)}%`, background:c }} /></div>
        <span className="f11 font-bold text-right tabular-nums" style={{ color:c }}>{ind.pct}%</span></div>); })}</div>);
  return (<div className="space-y-3">
    <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(4,minmax(0,1fr))" }}>
      {[["Indice global",s.index+"/100",HEX[band(s.index)],LAB[band(s.index)]],
        ["Évolution N-1",`${ar.d>=0?"+":""}${ar.d} ${ar.a}`,ar.c,ar.w],
        ["Module le + fort",best.score+"%",HEX[bp(best.score)],best.name],
        ["Module le + faible",worst.score+"%",HEX[bp(worst.score)],worst.name]].map(([l,v,c,sub],i)=>(
        <div key={i} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
          <div className="f10 font-bold uppercase tracking-wide text-slate-400">{l}</div>
          <div className="f22 font-extrabold tabular-nums mt-1" style={{ color:c }}>{v}</div>
          <div className="f105 text-slate-400 mt-1 truncate" title={sub}>{sub}</div></div>))}
    </div>
    <div className="grid gap-3" style={{ gridTemplateColumns:"340px 1fr" }}>
      <Card title="Radar des dimensions" sub={`${dg.length} modules`}><Radar groups={dg} color={ACCH[s._k]} /></Card>
      <Card title="Tendance de l'indice"><Trend trend={s.trend} color={ACCH[s._k]} h={150} />
        <div className="f115 text-slate-500 mt-1">Indice {ar.w}. Objectif : franchir 65.</div></Card>
    </div>
    <Card title="Détail par module"><DimsBars dims={dg} /></Card>
    <div className="grid gap-3" style={{ gridTemplateColumns:"1fr 1fr" }}>
      <Card title="▲ Points forts" sub="Top 6 indicateurs"><IndRows items={top} /></Card>
      <Card title="▼ Points faibles" sub="Flop 6 indicateurs"><IndRows items={flop} /></Card>
    </div>
    <Card title="Comparaison des bureaux"><RankList rows={s.bureaux} showVisits /></Card>
  </div>);
}

function PageQualite({ s }){
  const dg = s.dimGroups || s.dims;
  return (
    <Card title="Indicateurs regroupés par module" sub="Triés du plus faible au plus solide">
      <div className="space-y-4">
        {dg.map((g,gi)=>(
          <div key={gi}>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-100">
              <span className="f125 font-semibold text-slate-800 flex-1">{g.name}</span>
              <span className="f105 text-slate-400">{g.inds.length} ind.</span>
              <span className="f11 font-extrabold text-white px-2 py-0.5 rounded" style={{ background:HEX[bp(g.score)] }}>{g.score}%</span></div>
            <div className="space-y-1.5">
              {[...g.inds].sort((a,b)=>a.pct-b.pct).map((ind,ii)=>{ const c=HEX[bp(ind.pct)];
                return (<div key={ii} className="grid items-center gap-2" style={{ gridTemplateColumns:"1fr 120px 40px" }}>
                  <span className="f105 text-slate-600 truncate" title={ind.label}>{ind.label}</span>
                  <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full" style={{ width:`${Math.max(2,ind.pct)}%`, background:c }} /></div>
                  <span className="f11 font-bold text-right tabular-nums" style={{ color:c }}>{ind.pct}%</span></div>); })}
            </div>
          </div>))}
      </div>
    </Card>);
}

function PageAgent({ s }){
  const agents = s.agents || [];
  const avgFill = agents.length ? Math.round(agents.reduce((a,x)=>a+x.fill,0)/agents.length) : 0;
  const low = agents.filter(a=>a.fill<50).length;
  const fc = avgFill>=70?HEX.exc:avgFill>=45?HEX.imp:HEX.urg;
  return (<div className="space-y-3">
    <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(4,minmax(0,1fr))" }}>
      {[["Agents actifs",s.nAgents||agents.length,"#123A5E"],["Remplissage moyen",avgFill+"%",fc],
        ["Saisie insuffisante",low,low>0?HEX.urg:"#123A5E"],["Complétude score",(100-s.naPct)+"%",HEX[bp(100-s.naPct)]]].map(([l,v,c],i)=>(
        <div key={i} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
          <div className="f10 font-bold uppercase tracking-wide text-slate-400">{l}</div>
          <div className="f22 font-extrabold tabular-nums mt-1" style={{ color:c }}>{v}</div></div>))}
    </div>
    <Card title="Qualité de saisie par agent" sub={`${agents.length} agent(s) · triés par volume`}><AgentTable agents={agents} /></Card>
  </div>);
}

function PageAide(){
  const rows = [["Excellent","≥ 80","#16A34A","Documenter"],["Satisfaisant","65 – 79","#84CC16","Consolider"],
    ["À améliorer","50 – 64","#F59E0B","Plan d'action"],["Action urgente","< 50","#EF4444","Intervention"],["Non évalué","(nul)","#94A3B8","—"]];
  return (
    <Card title="Seuils & audiences" sub="Barème de lecture du tableau de bord">
      <table className="w-full f115">
        <thead><tr className="text-left text-slate-400 f10 uppercase tracking-wide"><th className="py-2">Classe</th><th>Seuil</th><th>Couleur</th><th>Décision</th></tr></thead>
        <tbody>{rows.map((r,i)=>(<tr key={i} className="border-t border-slate-100">
          <td className="py-2 font-semibold text-slate-700">{r[0]}</td><td className="tabular-nums text-slate-600">{r[1]}</td>
          <td><span className="inline-block w-4 h-4 rounded" style={{ background:r[2] }} /></td><td className="text-slate-600">{r[3]}</td></tr>))}</tbody>
      </table>
    </Card>);
}

/* ── Résilience (SAMS) — activité CALCULÉE, hors instantané MoDa ──
   Structure tirée du référentiel XLSForm vivant, couverture des sites réels ; la
   conformité par indicateur attend la connexion du formulaire MoDa SAMS. */
function PageResilience({ db, notify }){
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => { let vivant = true;
    api.processIndicateurs("?activity=SAMS&limit=5000")
      .then(r => { if(vivant) setRows(r.rows || []); })
      .catch(e => { if(vivant){ setErr(e.message); notify?.("Chargement Résilience impossible : " + e.message, "err"); } });
    return () => { vivant = false; };
  }, []);
  const perf = useMemo(() => {
    const sites = (db.sites || []).filter(s => s.activityTag === "SAMS" && s.status !== "Inactive");
    const planned = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.planned).length, 0);
    const done = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.done).length, 0);
    const visits = (db.visits || []).filter(v => v.tag === "SAMS").length;
    return { sites: sites.length, planned, done, visits, coverage: pct(done, planned) };
  }, [db.sites, db.visits]);

  if(err) return <div className="f125 text-rose-600 p-4">{err}</div>;
  if(rows === null) return <div className="f125 text-slate-400 p-4">Chargement du référentiel Résilience…</div>;

  const modules = []; const parMod = new Map();
  for(const r of rows){ const m = r.module || "(sans module)";
    if(!parMod.has(m)){ parMod.set(m, []); modules.push(m); } parMod.get(m).push(r); }

  return (<div className="space-y-3">
    <div className="rounded-xl border border-teal-200 bg-teal-50 px-3.5 py-2 flex items-center gap-2 f105 text-teal-900">
      <Sprout size={14} className="shrink-0" />
      <span><b>Résilience (SAMS)</b> — structure issue du référentiel XLSForm vivant ; la <b>couverture</b> est réelle,
        la <b>conformité par indicateur</b> s'affichera dès la connexion du formulaire MoDa SAMS.</span>
    </div>
    <Kpis items={[
      { l:"Couverture", v:perf.coverage+"%", cap:ACCH.SAMS, c:HEX[bp(perf.coverage)], s:`${fmt(perf.done)}/${fmt(perf.planned)} visites planifiées` },
      { l:"Sites suivis", v:fmt(perf.sites), cap:"#0D9488", s:"tag SAMS" },
      { l:"Visites", v:fmt(perf.visits), cap:"#0EA5E9", s:"réalisées" },
      { l:"Indicateurs", v:fmt(rows.length), cap:"#7C3AED", s:`${modules.length} modules` },
    ]} />
    <Card title="Indicateurs par module" sub="Référentiel SAMS — conformité en attente de collecte">
      <div className="space-y-4">
        {modules.map(nom => { const liste = parMod.get(nom);
          return (
          <div key={nom}>
            <div className="flex items-center gap-2 mb-2 pb-1 border-b border-slate-100">
              <Layers size={14} className="text-slate-400" />
              <span className="f125 font-semibold text-slate-800 flex-1">{nom}</span>
              <span className="f105 text-slate-400">{liste.length} ind.</span>
              <span className="f10 font-bold text-white px-2 py-0.5 rounded" style={{ background:HEX.na }}>—</span></div>
            <div className="grid gap-2" style={{ gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))" }}>
              {liste.map(r => (
                <div key={r.id} className="rounded-lg border border-slate-200 px-2.5 py-1.5 flex items-center gap-2"
                  style={{ borderLeft:`3px solid ${HEX.na}` }}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background:HEX.na }} />
                  <span className="f105 text-slate-600 truncate flex-1" title={r.label || r.var_name}>{r.label || r.var_name}</span></div>))}
            </div>
          </div>); })}
      </div>
    </Card>
  </div>);
}

export function AnalyseProcessus({ db, notify }){
  const [act, setAct] = useState("_OV");
  const [page, setPage] = useState("synthese");
  const go = (a, p) => { setAct(a); setPage(p||"synthese"); };
  const s = useMemo(() => (act==="_OV" || act==="SAMS") ? null : { ...SUMM_DATA[act], _k:act }, [act]);

  const renduPage = () => {
    if(act==="_OV") return <PageOverview go={go} />;
    if(act==="SAMS") return <PageResilience db={db} notify={notify} />;
    switch(page){
      case "controlroom": return <PageControlRoom s={s} />;
      case "performance": return <PagePerformance s={s} />;
      case "qualite": return <PageQualite s={s} />;
      case "agent": return <PageAgent s={s} />;
      case "aide": return <PageAide />;
      default: return <PageSynthese s={s} />;
    }
  };

  return (
    <div className="space-y-3">
      {/* Bandeau de source — instantané d'analyse MoDa, structure alignée au référentiel vivant. */}
      <div className="rounded-xl border border-sky-200 bg-sky-50 px-3.5 py-2 flex items-center gap-2 f105 text-sky-900">
        <ClipboardCheck size={14} className="shrink-0" />
        <span>Reproduction du tableau de bord de suivi de processus — <b>instantané d'analyse MoDa 2025-2026</b>. La structure (activités → modules → indicateurs) recoupe le référentiel XLSForm ; les valeurs se rafraîchiront depuis les soumissions une fois la collecte connectée.</span>
      </div>
      {/* Onglets d'activité */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {ATABS.map(([k,l,Ic])=>(
          <button key={k} onClick={()=>go(k, page)}
            className={clsx("inline-flex items-center gap-1.5 px-3 py-1.5 f125 rounded-lg font-semibold transition-colors border",
              act===k ? "text-white shadow-sm border-transparent" : "bg-white text-slate-600 border-slate-200 hover:text-slate-900")}
            style={act===k ? { background:ACCH[k] } : undefined}>
            <Ic size={14}/>{l}</button>))}
      </div>
      {/* Onglets de page (masqués en vue d'ensemble et sur Résilience, vue unique) */}
      {act!=="_OV" && act!=="SAMS" && (
        <div className="flex items-center gap-1 flex-wrap border-b border-slate-200 pb-2">
          {PAGES.map(([k,l,Ic])=>(
            <button key={k} onClick={()=>setPage(k)}
              className={clsx("inline-flex items-center gap-1.5 px-2.5 py-1.5 f115 rounded-lg font-semibold transition-colors",
                /* « Actif » se dit partout ailleurs en bleu institutionnel (SideRail,
                   rail du cockpit) ; ici c'était un gris, qui se lit comme un état
                   désactivé. Même idiome que le reste. */
                page===k ? "bg-brand text-white shadow-sm" : "text-slate-500 hover:text-slate-800")}>
              <Ic size={13}/>{l}</button>))}
        </div>)}
      {renduPage()}
    </div>);
}

export default AnalyseProcessus;
