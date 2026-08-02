import { useMemo, useState } from "react";
import { Activity, Gauge, Layers, MapPin, ShieldCheck, Target } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { Empty, Select } from "../components/ui.jsx";
import { clsx, computeMMR, fmt, pct, siteScore } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Tableau de bord du suivi de processus ══════════════════
   « Un bailleur, le management vont le regarder ; on l'affiche en permanence sur
   un écran. Il faut que ça embellisse le bureau et montre facilement l'état réel
   de la situation. »

   D'où le parti pris : sobre, institutionnel, symétrique — une jauge de
   couverture lisible à distance, quatre chiffres-clés alignés, la couverture par
   activité en barres calmes, et un poste de contrôle en grille régulière. Palette
   bleu/gris + accents sémantiques (vert = bon, orange = attention, rouge =
   urgent). Tout est lu des DONNÉES RÉELLES, cloisonné comme le reste. Une
   sous-navigation permet de poser une seule section à l'écran. */

/* Le vert/orange/rouge de l'état — la seule grammaire de couleur des chiffres. */
const bande = (p) => p >= 80 ? { c:C.ok,   l:"Excellent",     t:"g" }
  : p >= 60 ? { c:"#84cc16", l:"Satisfaisant",  t:"g" }
  : p >= 40 ? { c:C.warn,   l:"À améliorer",   t:"y" }
  : { c:C.bad, l:"Critique", t:"r" };

/* Une teinte stable par activité, tirée d'une palette sobre — pour relier une
   barre à sa carte sans arc-en-ciel. */
const TEINTES = ["#007DBC","#0d9488","#7c3aed","#dd1367","#f59e0b","#0ea5e9","#10b981","#6366f1","#e11d48","#0891b2"];
const teinteAct = (i) => TEINTES[i % TEINTES.length];

function ProcessDashboard({ db }){
  const [annee,setAnnee] = useState(db.year);
  const [vue,setVue]     = useState("synthese");   /* synthese | activites | controle */
  const [actFiltre,setActFiltre] = useState("");

  const tags = db.lists?.tags || [];
  const activiteLabel = (tag) => (db.activities || []).find(a => a.tag === tag)?.name || tag;
  const mmr = useMemo(() => computeMMR(db, annee), [db, annee]);

  const parActivite = useMemo(() => tags.map((t, i) => {
    const sites = db.sites.filter(s => s.activityTag === t.code && s.status !== "Inactive");
    const visits = db.visits.filter(v => v.tag === t.code);
    const planned = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.planned).length, 0);
    const done = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.done).length, 0);
    const pending = visits.filter(v => v.status === "À valider").length;
    const rate = pct(done, planned);
    const scoreMoyen = sites.length
      ? Math.round(sites.reduce((a, s) => a + (siteScore(s, db.weights, db).pct || 0), 0) / sites.length) : 0;
    return { tag:t.code, nom:activiteLabel(t.code), color:teinteAct(i),
      sites:sites.length, visits:visits.length, planned, done, pending, rate, scoreMoyen };
  }).filter(a => a.sites || a.visits).sort((a, b) => b.sites - a.sites), [db, tags, annee]);

  const visibles = actFiltre ? parActivite.filter(a => a.tag === actFiltre) : parActivite;
  const totSites = db.sites.filter(s => s.status !== "Inactive").length;
  const totVisits = db.visits.length;
  const aValider = db.visits.filter(v => v.status === "À valider").length;
  const beneficiaires = db.sites.reduce((a, s) => a + (s.beneficiaries || 0), 0);
  const couv = mmr.required ? pct(mmr.done, mmr.required) : 0;
  const v = bande(couv);
  const donut = [{ v:couv }, { v:Math.max(0, 100 - couv) }];

  if(!totSites && !totVisits) return (
    <Empty icon={Gauge} title="Aucune donnée de suivi"
      text="Le tableau de bord s'alimente du registre des sites, du plan de suivi et des visites. Chargez la donnée de référence et planifiez le suivi." />);

  const NAV = [["synthese","Synthèse",Gauge],["activites","Par activité",Activity],["controle","Poste de contrôle",ShieldCheck]];

  return (
    <div className="space-y-5">
      {/* ── Barre de filtres globale ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
          {NAV.map(([cle,label,Ic])=>(
            <button key={cle} onClick={()=>setVue(cle)}
              className={clsx("flex items-center gap-1.5 px-3.5 py-1.5 f125 rounded-md font-semibold transition-colors",
                vue===cle ? "bg-brand text-white shadow-sm" : "text-slate-500 hover:text-slate-800")}>
              <Ic size={14}/> {label}</button>))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select value={actFiltre} onChange={e=>setActFiltre(e.target.value)} empty="Toutes les activités"
            options={parActivite.map(a=>[a.tag, `${a.tag} — ${a.nom}`])} className="mi-py1 mi-xs mi-wauto" />
          <Select value={String(annee)} onChange={e=>setAnnee(+e.target.value)} className="mi-py1 mi-xs mi-wauto"
            options={[db.year-1, db.year, db.year+1].map(y=>[String(y), String(y)])} />
        </div>
      </div>

      {vue==="synthese" && <>
        {/* ── Hero : jauge de couverture + situation ── */}
        <div className="grid gap-5" style={{ gridTemplateColumns:"minmax(300px,380px) 1fr" }}>
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6 flex flex-col items-center justify-center relative overflow-hidden">
            <div className="f105 font-bold uppercase tracking-wider text-slate-400 mb-1">Couverture du suivi</div>
            <div className="relative" style={{ width:220, height:150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={donut} dataKey="v" startAngle={210} endAngle={-30} innerRadius={68} outerRadius={92}
                    cx="50%" cy="72%" stroke="none" cornerRadius={6}>
                    <Cell fill={v.c} /><Cell fill="#eef2f6" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center" style={{ top:"18%" }}>
                <div className="f34 font-extrabold leading-none" style={{ color:v.c }}>{couv}<span className="f16">%</span></div>
                <div className="f11 font-semibold mt-1" style={{ color:v.c }}>{v.l}</div>
              </div>
            </div>
            <div className="f125 text-slate-500 text-center mt-1">
              <b className="text-slate-800">{fmt(mmr.done)}</b> visites réalisées<br/>sur <b className="text-slate-800">{fmt(mmr.required)}</b> requises · {annee}</div>
          </div>

          <div className="grid grid-cols-2 gap-5">
            {[{ l:"Sites suivis", v:fmt(totSites), s:`${parActivite.length} activité(s)`, ic:Target, c:C.brand },
              { l:"Soumissions", v:fmt(totVisits), s:`${fmt(aValider)} à valider`, ic:Activity, c:"#0ea5e9" },
              { l:"Bénéficiaires", v:fmt(beneficiaires), s:"registre des sites", ic:MapPin, c:"#0d9488" },
              { l:"Activités suivies", v:fmt(parActivite.length), s:"portant sites ou visites", ic:Layers, c:"#7c3aed" }].map(k=>(
              <div key={k.l} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 flex flex-col">
                <div className="flex items-center justify-between">
                  <span className="f105 font-bold uppercase tracking-wider text-slate-400">{k.l}</span>
                  <span className="w-8 h-8 rounded-lg grid place-items-center" style={{ background:k.c+"14", color:k.c }}><k.ic size={16}/></span>
                </div>
                <div className="f30 font-extrabold text-slate-900 mt-3 leading-none tabular-nums">{k.v}</div>
                <div className="f115 text-slate-500 mt-2">{k.s}</div>
              </div>))}
          </div>
        </div>

        {/* ── Aperçu couverture par activité (top) ── */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <div className="flex items-baseline justify-between mb-4">
            <div><div className="f14 font-bold text-slate-800">Couverture par activité</div>
              <div className="f115 text-slate-500">Visites réalisées sur planifiées</div></div>
            <button onClick={()=>setVue("activites")} className="f115 c-bd font-semibold hover:underline">Tout voir →</button>
          </div>
          <BarresActivite items={visibles.slice(0, 6)} />
        </div>
      </>}

      {vue==="activites" && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <div className="f14 font-bold text-slate-800 mb-1">Couverture du suivi par activité</div>
          <div className="f115 text-slate-500 mb-4">Toutes les activités, de la mieux couverte à la moins couverte</div>
          {visibles.length ? <BarresActivite items={visibles} />
            : <Empty icon={Activity} title="Aucune activité suivie" text="Rattachez des sites à une activité et planifiez leur suivi." />}
        </div>)}

      {vue==="controle" && (
        <div className="grid gap-4" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(250px, 1fr))" }}>
          {visibles.map(a => { const b = bande(a.rate);
            return (
            <div key={a.tag} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4"
              style={{ borderTop:`3px solid ${a.color}` }}>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background:b.c }} />
                <span className="f105 font-extrabold text-white px-1.5 py-0.5 rounded" style={{ background:a.color }}>{a.tag}</span>
                <span className="f30 font-extrabold ml-auto leading-none tabular-nums" style={{ color:b.c }}>{a.rate}<span className="f13">%</span></span>
              </div>
              <div className="f115 text-slate-500 leading-snug mb-3 truncate" title={a.nom}>{a.nom}</div>
              <div className="grid grid-cols-3 gap-2 text-center border-t border-slate-100 pt-3">
                <div><div className="f16 font-bold text-slate-800 leading-none tabular-nums">{fmt(a.sites)}</div><div className="f10 text-slate-400 mt-1">sites</div></div>
                <div><div className="f16 font-bold text-slate-800 leading-none tabular-nums">{fmt(a.visits)}</div><div className="f10 text-slate-400 mt-1">visites</div></div>
                <div><div className={clsx("f16 font-bold leading-none tabular-nums", a.pending?"text-amber-600":"text-slate-800")}>{fmt(a.pending)}</div><div className="f10 text-slate-400 mt-1">à valider</div></div>
              </div>
            </div>); })}
        </div>)}
    </div>);
}

/* Les barres de couverture par activité — alignées, calmes, une teinte par
   activité, la valeur en tête de bande sémantique. */
function BarresActivite({ items }){
  return (
    <div className="space-y-3">
      {items.map(a => { const b = bande(a.rate);
        return (
        <div key={a.tag} className="grid items-center gap-4" style={{ gridTemplateColumns:"200px 1fr 56px" }}>
          <div className="min-w-0 flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background:a.color }} />
            <span className="f125 font-semibold text-slate-800 shrink-0">{a.tag}</span>
            <span className="f11 text-slate-400 truncate" title={a.nom}>{a.nom}</span>
          </div>
          <div className="h-4 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width:`${Math.min(100, a.rate)}%`, background:a.color }} />
          </div>
          <div className="text-right f13 font-bold tabular-nums" style={{ color:b.c }}>{a.rate}%</div>
        </div>); })}
    </div>);
}

export { ProcessDashboard };
