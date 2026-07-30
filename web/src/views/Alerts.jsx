import { useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, ChevronRight } from "lucide-react";
import { Badge, Btn, Card, Empty } from "../components/ui.jsx";
import { clsx } from "../lib/calc.js";
import { alertes, compte, parNature } from "../lib/alerts.js";

/* ═══════════════════════════════════════════════════════════════════════
   À traiter — la destination de la cloche.

   L'accueil affichait cent trente-neuf lignes dans un tableau à quatre colonnes,
   tronqué à quarante sans le dire. On ne lit pas cent trente-neuf lignes ; on lit
   « quatorze sites jamais visités » puis on décide d'ouvrir ou non.

   D'où le pli par NATURE : chaque groupe donne son compte et sa phrase, et ne
   s'ouvre que si l'on veut la liste. Le groupe le plus urgent est ouvert d'emblée —
   arriver sur six titres fermés obligerait à cliquer pour apprendre quoi que ce
   soit.

   Chaque ligne mène à l'écran qui la résout. C'était déjà le cas et c'est
   l'essentiel : une alerte dont on ne peut rien faire est un reproche.
   ═══════════════════════════════════════════════════════════════════════ */

const TONE = { haute:"r", moyenne:"y", basse:"n" };

function Groupe({ groupe, ouvert, onToggle, go }){
  const hautes = compte(groupe.items, "haute");
  const Fleche = ouvert ? ChevronDown : ChevronRight;
  return (
    <div className="border border-slate-200 rounded bg-white overflow-hidden">
      <button onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
        <Fleche size={15} className="text-slate-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <b className="f13 text-slate-800">{groupe.label}</b>
            <Badge tone={hautes ? "r" : "n"}>{groupe.items.length}</Badge>
            {hautes > 0 && <span className="f11 text-rose-700">{hautes} en priorité haute</span>}
          </div>
          <div className="f115 text-slate-500 mt-0.5">{groupe.text}</div>
        </div>
      </button>
      {ouvert && (
        <ul className="border-t border-slate-100 divide-y divide-slate-100">
          {groupe.items.map(a => (
            <li key={a.id} className="flex items-start gap-3 px-4 py-2.5 hover:bg-sky-50/60">
              <Badge tone={TONE[a.prio]}>{a.prio}</Badge>
              <div className="min-w-0 flex-1">
                <div className="f125 text-slate-800">{a.text}</div>
                <div className="f11 text-slate-500 mt-0.5">{a.kind} · {a.ctx}</div>
              </div>
              {a.go && (
                <button onClick={()=>go(...a.go)}
                  className="shrink-0 flex items-center gap-1 f115 c-bd hover:underline whitespace-nowrap">
                  Traiter <ArrowRight size={13} /></button>)}
            </li>))}
        </ul>)}
    </div>);
}

export default function Alerts({ db, go }){
  const liste = useMemo(()=>alertes(db), [db]);
  const groupes = useMemo(()=>parNature(liste), [liste]);
  const [prio, setPrio] = useState("");
  const [ouverts, setOuverts] = useState(null);

  const filtres = prio ? groupes.map(g => ({ ...g, items:g.items.filter(a=>a.prio===prio) })).filter(g=>g.items.length)
                       : groupes;
  /* Le premier groupe est ouvert par défaut, les autres pliés. Une fois que
     l'utilisateur a touché à l'un d'eux, c'est son choix qui vaut. */
  const estOuvert = (id, i) => (ouverts ? ouverts.includes(id) : i === 0);
  const toggle = (id, i) => setOuverts(prev => {
    const base = prev || (filtres[0] ? [filtres[0].id] : []);
    return base.includes(id) ? base.filter(x=>x!==id) : [...base, id];
  });

  if(!liste.length) return (
    <Empty icon={Check} title="Rien à traiter"
      text="Aucune échéance dépassée, aucune validation en attente, aucune donnée manquante sur votre périmètre." />);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        {[["","Tout"],["haute","Priorité haute"],["moyenne","Moyenne"],["basse","Basse"]].map(([v,l])=>{
          const nb = v ? compte(liste, v) : liste.length;
          return (
            <button key={v||"all"} onClick={()=>{ setPrio(v); setOuverts(null); }} disabled={!nb}
              className={clsx("px-3 py-1.5 rounded-full f125 border transition-colors",
                prio===v ? "bd-brand bg-sky-50 c-bd font-semibold"
                         : nb ? "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              : "border-slate-100 bg-slate-50 text-slate-300 cursor-not-allowed")}>
              {l} <span className="tabular-nums">({nb})</span></button>);
        })}
        <span className="ml-auto f115 text-slate-500">
          {filtres.reduce((t,g)=>t+g.items.length,0)} élément(s) affiché(s) · {groupes.length} nature(s)</span>
      </div>

      <div className="space-y-2.5">
        {filtres.map((g,i)=>(
          <Groupe key={g.id} groupe={g} go={go}
            ouvert={estOuvert(g.id, i)} onToggle={()=>toggle(g.id, i)} />))}
      </div>
    </div>);
}

/* Aperçu pour l'accueil : les natures et leurs comptes, sans une seule ligne de
   détail. Trois lignes qui disent l'essentiel valent mieux qu'un tableau de
   quarante qu'on fait défiler sans le lire. */
export function AlertesApercu({ db, go }){
  const liste = useMemo(()=>alertes(db), [db]);
  const groupes = useMemo(()=>parNature(liste), [liste]);
  if(!liste.length) return (
    <Card title="À traiter" subtitle="Rien en attente sur votre périmètre">
      <Empty icon={Check} title="Toutes les échéances sont honorées" /></Card>);
  return (
    <Card title="À traiter" subtitle={`${liste.length} élément(s) · ${compte(liste,"haute")} en priorité haute`}
      right={<Btn size="sm" kind="sec" onClick={()=>go("alerts")}>Ouvrir la liste</Btn>}>
      <div className="space-y-1.5">
        {groupes.map(g=>{
          const hautes = compte(g.items,"haute");
          return (
            <button key={g.id} onClick={()=>go("alerts")}
              className="w-full flex items-center gap-3 px-3 py-2 rounded border border-slate-200 hover:bg-sky-50 text-left">
              <Badge tone={hautes ? "r" : "n"}>{g.items.length}</Badge>
              <span className="f125 text-slate-700 flex-1 min-w-0 truncate">{g.label}</span>
              <ArrowRight size={13} className="text-slate-400 shrink-0" />
            </button>);
        })}
      </div>
    </Card>);
}
