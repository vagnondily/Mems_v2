import { useEffect, useState } from "react";
import { BarChart3, CalendarRange, ChevronDown, Cog, Database, FileText, LayoutDashboard, LogOut } from "lucide-react";
import { Badge, BrandMark } from "../components/ui.jsx";
import { clsx } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Coquille ══════════════════ */
const NAV = [
  { id:"home", label:"Accueil", icon:LayoutDashboard },
  { id:"planning", label:"Planning", icon:CalendarRange,
    sub:[["overreaching","Paramètres de couverture"],["process","Plan de suivi des sites"],
         ["coverage","Couverture et MMR"],["distribution","Plan de distribution"],["outcomes","Plan des résultats"]] },
  { id:"actual", label:"Actual Data", icon:Database,
    sub:[["summary","Résumé global"],["process","Suivi de processus"],["sites","Sites"],["map","Cartographie"],["distrib","Distributions"],
         ["output","Outputs et population"],["outcome","Outcomes"],
         ["import","Import Excel"],["sources","Sources de données"]] },
  { id:"analytics", label:"Analyses", icon:BarChart3,
    sub:[["datasets","Jeux de données"],["scripts","Scripts d'analyse"],["viz","Visualisations"]] },
  { id:"reports", label:"Rapports", icon:FileText,
    sub:[["extract","Extraction ODK"],["build","Générateur de rapport"]] },
];

/* État d'enregistrement : l'utilisateur doit savoir si son travail est parti au serveur. */
function SyncBadge({ sync }){
  if(!sync) return null;
  const map = {
    saved: ["Enregistré", "bg-white/10 text-white/80"],
    dirty: ["Modifications en attente", "bg-amber-400/20 text-amber-100"],
    saving:["Enregistrement…", "bg-white/20 text-white"],
    error: ["Échec d'enregistrement", "bg-rose-500/30 text-rose-50"],
  };
  const [label, cls] = map[sync.state] || map.saved;
  return (
    <span title={sync.message || label}
      className={clsx("hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full f11 font-semibold", cls)}>
      <i className={clsx("w-1.5 h-1.5 rounded-full",
        sync.state==="error" ? "bg-rose-300" : sync.state==="saved" ? "bg-lime-300" : "bg-amber-300")} />
      {label}
    </span>);
}

/* `allowed` est calculé une seule fois par App (resolveTabs) et transmis ici :
   deux règles divergentes laissaient un compte sans aucune navigation. */
function Shell({ db, me, tab, sub, setTab, children, onLogout, sync, allowed = [] }){
  const [open,setOpen] = useState(null); const [menu,setMenu] = useState(false);
  useEffect(()=>{ const h=()=>{setOpen(null);setMenu(false);};
    window.addEventListener("click",h); return ()=>window.removeEventListener("click",h); },[]);
  const initials = (me.firstName?.[0]||"") + (me.lastName?.[0]||"");
  return (
    <div className="min-h-screen flex flex-col" style={{background:C.bg}}>
      <header className="flex items-center gap-4 px-5 h-14 text-white sticky top-0 z-40" style={{background:C.brandD}}>
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-11 h-11 rounded-3xl bg-white/10 border border-white/20 grid place-items-center">
            <BrandMark size={36} />
          </div>
          <div className="leading-tight">
            <div className="font-bold tracking-wide f17">MEMS</div>
            <div className="f8 font-light opacity-70 hidden sm:block">Monitoring &amp; Evaluation Management System</div>
          </div>
        </div>
        <nav className="flex items-center gap-0.5 ml-4 overflow-x-auto">
          {NAV.filter(x=>allowed.includes(x.id)).map(x => (
            <div key={x.id} className="relative" onClick={e=>e.stopPropagation()}>
              <button onClick={()=>{ setTab(x.id); if(x.sub) setOpen(o=>o===x.id?null:x.id); }}
                className={clsx("flex items-center gap-1.5 px-3 h-14 f13 font-semibold whitespace-nowrap bb3 transition-colors",
                  tab===x.id ? "border-white text-white bg-white/10" : "border-transparent text-white/80 hover:text-white hover:bg-white/[.07]")}>
                <x.icon size={15} />{x.label}{x.sub && <ChevronDown size={13} className="opacity-70" />}</button>
              {x.sub && open===x.id && (
                <div className="absolute left-0 top-14 bg-white rounded-b shadow-xl border border-slate-200 mnw260 py-1 z-50">
                  {x.sub.map(([sid,slab]) => (
                    <button key={sid} onClick={()=>{setTab(x.id,sid);setOpen(null);}}
                      className={clsx("block w-full text-left px-4 py-2 f13 hover:bg-slate-50",
                        tab===x.id&&sub===sid ? "c-bd font-semibold bg-sky-50" : "text-slate-700")}>{slab}</button>))}
                </div>)}
            </div>))}
        </nav>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <SyncBadge sync={sync} />
          <div className="relative" onClick={e=>e.stopPropagation()}>
            <button onClick={()=>setMenu(m=>!m)}
              className="flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-white/10 border border-white/20 hover:bg-white/20 f12">
              <span className="w-6 h-6 rounded-full grid place-items-center f10 font-bold c-deep" style={{background:C.aqua}}>{initials||"?"}</span>
              <span className="hidden sm:inline">{me.firstName}</span><ChevronDown size={12} className="opacity-70" /></button>
            {menu && (
              <div className="absolute right-0 top-10 bg-white rounded shadow-xl border border-slate-200 w-72 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="font-semibold text-slate-800 f13">{me.firstName} {me.lastName}</div>
                  <div className="f115 text-slate-500">{me.title}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="b">{db.roles[me.role]?.label}</Badge>
                    <Badge>{me.office || "Tous les bureaux"}</Badge></div>
                </div>
                {allowed.includes("settings") && (
                  <button onClick={()=>{setTab("settings");setMenu(false);}}
                    className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50">
                    <Cog size={14} /> Paramètres de l'application</button>)}
                <button onClick={onLogout} className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50 border-t border-slate-100">
                  <LogOut size={14} /> Se déconnecter</button>
              </div>)}
          </div>
        </div>
      </header>
      <main className="flex-1 mw1520 w-full mx-auto px-5 py-6">{children}</main>
      <footer className="border-t border-slate-200 bg-white px-5 py-3 flex items-center gap-3 f11 text-slate-500">
        {db.settings.logo && <img src={db.settings.logo} alt="" className="h-6 w-auto shrink-0"
          onError={e=>{ e.currentTarget.style.display="none"; }} />}
        <div>{db.settings.org} — {db.settings.unit}</div>
        <span className="ml-auto">MEMS · exercice {db.year}</span>
      </footer>
    </div>);
}
const PageHead = ({ title, text, children }) => (
  <div className="flex items-start gap-3 flex-wrap mb-5">
    <div><h2 className="f23 font-semibold text-slate-800">{title}</h2>
      {text && <p className="f13 text-slate-500 mt-1 max-w-3xl">{text}</p>}</div>
    <div className="ml-auto flex gap-2 flex-wrap">{children}</div>
  </div>);

export { SyncBadge, NAV, PageHead, Shell };
