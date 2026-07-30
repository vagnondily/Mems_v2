import { useEffect, useState } from "react";
import { BarChart3, CalendarRange, ChevronDown, Cog, Database, FileText, Globe, LayoutDashboard, LogOut } from "lucide-react";
import { Badge, BrandMark } from "../components/ui.jsx";
import { clsx } from "../lib/calc.js";
import { C } from "../lib/constants.js";
import { getWorkingCountry, setWorkingCountry } from "../lib/api.js";

/* ══════════════════ Coquille ══════════════════ */
const NAV = [
  { id:"home", label:"Accueil", icon:LayoutDashboard },
  /* Un sujet par destination : le prévu et le réalisé s'y basculent, ils ne se
     dupliquent plus. Le premier niveau suit les deux métiers, non la nature des données. */
  { id:"suivi", label:"Suivi-évaluation", icon:CalendarRange,
    sub:[["summary","Résumé global"],["monitoring","Suivi des sites"],
         ["mre","Plan MRE et budget"],["tpm","Suivi tiers"],
         ["coverage","Couverture et MMR"],["map","Cartographie"],
         ["sites","Registre des sites"],["params","Paramètres de couverture"]] },
  { id:"programme", label:"Programme", icon:Database,
    sub:[["distribution","Distributions"],["population","Population et outputs"],
         ["results","Résultats"],["import","Import Excel"],["sources","Sources de données"]] },
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

/* Sélecteur de pays — visible seulement pour un compte qui n'est borné à aucun :
   bureau régional, administrateur de l'instance. Le serveur ne renvoie la liste qu'à
   ceux-là (voir `countries` dans /api/state), donc l'absence de sélecteur n'est pas
   une décision de l'interface : c'est le reflet de ce que le compte a le droit de
   voir. Un compte rattaché à un pays n'a rien à choisir.

   Le changement recharge la page. C'est volontaire, et ce n'est pas de la paresse :
   l'application garde en mémoire tout un jeu de collections — sites, plans, découpage
   administratif, libellés des niveaux — et un rafraîchissement partiel laisserait
   momentanément des données d'un pays sous le vocabulaire de l'autre. C'est
   exactement l'erreur la plus difficile à voir, et un rechargement de deux secondes
   la rend impossible. */
function PaysCourant({ db }){
  const liste = db?.countries || [];
  if(liste.length < 2) return null;
  /* Le pays retenu localement ne fait pas foi : s'il a été désactivé ou supprimé
     depuis, le serveur a servi autre chose, et c'est ce qu'il faut montrer. */
  const garde = getWorkingCountry();
  const actuel = liste.some(c => c.code === garde) ? garde : (db?.country?.code || "");
  return (
    <label className="hidden md:flex items-center gap-1.5 f115 text-white/80"
      title="Pays dans lequel vous travaillez">
      <Globe size={14} className="opacity-80" />
      <select value={actuel} aria-label="Pays"
        onChange={e => { setWorkingCountry(e.target.value); window.location.reload(); }}
        className="bg-transparent text-white f115 font-semibold border-none outline-none cursor-pointer">
        {liste.map(c => (
          <option key={c.code} value={c.code} className="text-slate-800">{c.name}</option>))}
      </select>
    </label>);
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
      {/* ── En-tête ────────────────────────────────────────────────────
          Le bloc de marque était un cadre translucide de 44 px contenant un signe
          de 36 px, surmonté de deux lignes de texte dont la seconde à 8 px. Trois
          conséquences : le cadre transformait le signe en pastille grise
          illisible, la ligne de 8 px se lisait comme une salissure plutôt que
          comme une phrase, et le bloc occupait 260 px sur deux lignes dans une
          barre de 56 px où tout le reste tient sur une seule.

          Le signe est donc posé à même la barre, à sa taille lisible, suivi du
          seul mot « MEMS » et d'un filet qui sépare la marque de la navigation.
          L'intitulé complet a rejoint le pied de page, où il y a la place de le
          lire. Une marque n'a pas besoin de se répéter à chaque écran ; elle a
          besoin d'être reconnaissable. */}
      <header className="flex items-center gap-1 px-4 h-14 text-white sticky top-0 z-40" style={{background:C.brandD}}>
        <div className="flex items-center gap-2.5 shrink-0 pr-4 mr-2 h-8 border-r border-white/20">
          <BrandMark size={30} tone="light" />
          <span className="f15 font-bold tr14">MEMS</span>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto">
          {NAV.filter(x=>allowed.includes(x.id)).map(x => (
            <div key={x.id} className="relative" onClick={e=>e.stopPropagation()}>
              {/* Un seul signal pour l'onglet courant : le filet. Le fond teinté
                  et le texte blanc en plus faisaient trois marques pour une idée. */}
              <button onClick={()=>{ setTab(x.id); if(x.sub) setOpen(o=>o===x.id?null:x.id); }}
                className={clsx("flex items-center gap-1.5 px-3 h-14 f125 font-semibold whitespace-nowrap border-b-2 transition-colors",
                  tab===x.id ? "border-white text-white" : "border-transparent text-white/65 hover:text-white")}>
                <x.icon size={15} className={tab===x.id ? "" : "opacity-80"} />{x.label}
                {x.sub && <ChevronDown size={13} className="opacity-60" />}</button>
              {x.sub && open===x.id && (
                <div className="absolute left-0 top-14 bg-white rounded-b-xl shadow-xl border border-slate-200 mnw260 py-1.5 z-50">
                  {x.sub.map(([sid,slab]) => (
                    <button key={sid} onClick={()=>{setTab(x.id,sid);setOpen(null);}}
                      className={clsx("block w-full text-left px-4 py-1.5 f125 hover:bg-slate-50",
                        tab===x.id&&sub===sid ? "c-bd font-semibold bg-sky-50" : "text-slate-700")}>{slab}</button>))}
                </div>)}
            </div>))}
        </nav>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <PaysCourant db={db} />
          <SyncBadge sync={sync} />
          <div className="relative" onClick={e=>e.stopPropagation()}>
            {/* La pastille suffit à identifier le compte ; l'anneau et le fond
                translucide autour ajoutaient deux bordures sans rien dire. */}
            <button onClick={()=>setMenu(m=>!m)}
              className="flex items-center gap-2 pl-0.5 pr-2 py-0.5 rounded-full hover:bg-white/10 f125">
              <span className="w-7 h-7 rounded-full grid place-items-center f105 font-bold c-deep" style={{background:C.aqua}}>{initials||"?"}</span>
              <span className="hidden sm:inline text-white/90">{me.firstName}</span>
              <ChevronDown size={12} className="opacity-60" /></button>
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
      <main className="flex-1 mw1520 w-full mx-auto px-5 py-5">{children}</main>
      {/* L'intitulé complet vit ici : le pied de page est l'endroit où l'on a la
          place de le lire, et il n'a pas à occuper la barre à chaque écran. */}
      <footer className="border-t border-slate-200 bg-white px-5 py-3 flex items-center gap-3 f11 text-slate-500">
        {db.settings.logo && <img src={db.settings.logo} alt="" className="h-6 w-auto shrink-0"
          onError={e=>{ e.currentTarget.style.display="none"; }} />}
        <div>{db.settings.org} — {db.settings.unit}</div>
        <span className="ml-auto text-right">
          <b className="font-semibold text-slate-600">MEMS</b> · Monitoring and Evaluation
          Management System · exercice {db.year}</span>
      </footer>
    </div>);
}
/* Titre de page. Il était à 23 px en gras, suivi d'un paragraphe à 13 px, au-dessus
   de cartes dont les titres sont à 13 px : l'écart de hiérarchie était tel que le
   titre écrasait le contenu, et l'empilement titre + phrase + onglets + bascule
   repoussait les données sous la ligne de flottaison. Ramené à 19 px, avec la
   phrase en 12,5 px et une marge resserrée. La phrase reste : elle dit à quoi
   sert l'écran, ce qu'aucun titre de deux mots ne fait. */
const PageHead = ({ title, text, children }) => (
  <div className="flex items-start gap-4 flex-wrap mb-4">
    <div className="min-w-0">
      <h2 className="f19 font-semibold text-slate-900 leading-tight">{title}</h2>
      {text && <p className="f125 text-slate-500 mt-1 max-w-3xl leading-relaxed">{text}</p>}</div>
    <div className="ml-auto flex gap-2 flex-wrap">{children}</div>
  </div>);

export { SyncBadge, NAV, PageHead, Shell };
