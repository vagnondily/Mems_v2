import { useMemo, useState } from "react";
import { Activity, Gauge, ShieldCheck, Target, TrendingUp } from "lucide-react";
import { Card, Empty, Note } from "../components/ui.jsx";
import { clsx, computeMMR, fmt, pct, siteScore } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ── Tableau de bord du suivi de processus ────────────────────────────
   « Je veux un petit dashboard pour le suivi du processus » (fichier de
   référence docs/dashboard_suivi_processus_WFP.html). On en reprend l'esprit —
   couverture & performance par activité, des indicateurs clés, un « poste de
   contrôle » par activité — mais alimenté par les DONNÉES RÉELLES de MEMS
   (registre des sites, plan de suivi, visites), pas par des chiffres figés.

   Le fichier partagé était une maquette statique ; ceci en est la version
   vivante, lue de l'état, cloisonnée comme le reste. */

/* Les couleurs par activité, reprises de la maquette de référence. Les activités
   inconnues reçoivent une couleur de repli — on ne perd personne. */
const COULEUR_ACT = { SMP:"#0EA5E9", GD:"#7C3AED", MAM:"#EF4444", STUN:"#10B981",
  STUNT:"#10B981", CTRL:"#0D9488", FFA:"#F59E0B", PREV:"#2563EB", URT:"#DB2777",
  MAM_PLW:"#EF4444", HIV:"#0891B2" };
const couleurAct = (tag) => COULEUR_ACT[tag] || "#64748B";

const bande = (p) => p >= 80 ? { c:"#16A34A", l:"Excellent" }
  : p >= 60 ? { c:"#84CC16", l:"Satisfaisant" }
  : p >= 40 ? { c:"#F59E0B", l:"À améliorer" }
  : { c:"#EF4444", l:"Urgent" };

function ProcessDashboard({ db }){
  const [annee] = useState(db.year);
  const tags = db.lists?.tags || [];
  const activiteLabel = (tag) => (db.activities || []).find(a => a.tag === tag)?.name || tag;

  const mmr = useMemo(() => computeMMR(db, annee), [db, annee]);

  /* La couverture et la performance par activité, lues du registre et du plan. */
  const parActivite = useMemo(() => tags.map(t => {
    const sites = db.sites.filter(s => s.activityTag === t.code && s.status !== "Inactive");
    const visits = db.visits.filter(v => v.tag === t.code);
    const planned = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.planned).length, 0);
    const done = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.done).length, 0);
    const pending = visits.filter(v => v.status === "À valider").length;
    const rate = pct(done, planned);
    const scoreMoyen = sites.length
      ? Math.round(sites.reduce((a, s) => a + (siteScore(s, db.weights, db).pct || 0), 0) / sites.length)
      : 0;
    return { tag:t.code, label:t.label, nom:activiteLabel(t.code), color:couleurAct(t.code),
      sites:sites.length, visits:visits.length, planned, done, pending, rate, scoreMoyen };
  }).filter(a => a.sites || a.visits).sort((a, b) => b.sites - a.sites), [db, tags, annee]);

  const totSites = db.sites.filter(s => s.status !== "Inactive").length;
  const totVisits = db.visits.length;
  const aValider = db.visits.filter(v => v.status === "À valider").length;
  const couvGlobale = mmr.required ? pct(mmr.done, mmr.required) : 0;
  const v = bande(couvGlobale);

  const kpis = [
    { l:"Sites suivis", v:fmt(totSites), s:`${parActivite.length} activité(s) suivie(s)`, c:C.brand, icon:Target },
    { l:"Soumissions", v:fmt(totVisits), s:`${fmt(aValider)} à valider`, c:"#0EA5E9", icon:Activity },
    { l:"Couverture (MMR)", v:`${couvGlobale}%`, s:`${fmt(mmr.done)} / ${fmt(mmr.required)} visites requises`, c:v.c, icon:Gauge },
    { l:"Verdict", v:v.l, s:"exigence minimale de suivi", c:v.c, icon:ShieldCheck },
  ];

  if(!totSites && !totVisits) return (
    <Empty icon={Gauge} title="Aucune donnée de suivi"
      text="Le tableau de bord s'alimente du registre des sites, du plan de suivi et des visites. Chargez la donnée de référence et planifiez le suivi." />);

  return (
    <div className="space-y-4">
      <Note>Couverture et performance du suivi de processus, <b>par activité</b>, lues des données réelles
        (registre des sites, plan de suivi, visites). Inspiré du tableau de bord WFP Madagascar, alimenté ici en direct.</Note>

      {/* ── Bandeau verdict ── */}
      <div className="rounded-2xl px-5 py-4 text-white flex items-center gap-4 shadow-sm"
        style={{ background:`linear-gradient(120deg, ${v.c}, ${v.c}cc)` }}>
        <div className="w-11 h-11 rounded-xl grid place-items-center shrink-0" style={{ background:"rgba(255,255,255,.2)" }}>
          <Gauge size={22} /></div>
        <div className="min-w-0">
          <div className="f16 font-bold">Couverture globale du suivi : {v.l.toLowerCase()}</div>
          <div className="f12 opacity-90">{fmt(mmr.done)} visites réalisées sur {fmt(mmr.required)} requises · exercice {annee}</div>
        </div>
        <div className="ml-auto text-right">
          <div className="f24 font-extrabold leading-none">{couvGlobale}%</div>
          <div className="f10 opacity-85">exigence minimale</div>
        </div>
      </div>

      {/* ── KPI ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {kpis.map(k => (
          <div key={k.l} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
            <div className="h-1 w-9 rounded mb-3" style={{ background:k.c }} />
            <div className="flex items-center gap-2">
              <k.icon size={14} className="text-slate-400" />
              <span className="f10 font-bold uppercase tracking-wide text-slate-500">{k.l}</span>
            </div>
            <div className="f24 font-extrabold text-slate-900 mt-2 leading-none">{k.v}</div>
            <div className="f11 text-slate-500 mt-1.5">{k.s}</div>
          </div>))}
      </div>

      {/* ── Couverture par activité (barres) ── */}
      <Card title="Couverture du suivi par activité" subtitle="Visites réalisées sur visites planifiées, par activité">
        {parActivite.length ? (
          <div className="space-y-2.5">
            {parActivite.map(a => (
              <div key={a.tag} className="grid items-center gap-3" style={{ gridTemplateColumns:"180px 1fr 84px" }}>
                <div className="min-w-0 flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background:a.color }} />
                  <span className="f125 font-semibold text-slate-800 truncate" title={a.nom}>{a.tag}</span>
                  <span className="f10 text-slate-400 truncate">{a.nom}</span>
                </div>
                <div className="h-3.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width:`${Math.min(100, a.rate)}%`, background:a.color }} />
                </div>
                <div className="text-right f125 font-bold tabular-nums" style={{ color:bande(a.rate).c }}>{a.rate}%</div>
              </div>))}
          </div>
        ) : <Empty icon={Activity} title="Aucune activité suivie" text="Rattachez des sites à une activité et planifiez leur suivi." />}
      </Card>

      {/* ── Poste de contrôle par activité ── */}
      <Card flush title="Poste de contrôle" subtitle="État du suivi par activité : sites, visites, en attente de validation, score moyen">
        <div className="p-4 grid gap-3" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(230px, 1fr))" }}>
          {parActivite.map(a => {
            const b = bande(a.rate);
            return (
            <div key={a.tag} className="border border-slate-200 rounded-xl p-3" style={{ borderLeft:`3px solid ${a.color}` }}>
              <div className="flex items-center gap-2 mb-2">
                <span className="f10 font-extrabold text-white px-1.5 py-0.5 rounded" style={{ background:a.color }}>{a.tag}</span>
                <span className="f105 text-slate-500 truncate flex-1" title={a.nom}>{a.nom}</span>
                <span className="f11 font-bold px-1.5 rounded text-white" style={{ background:b.c }}>{a.rate}%</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div><div className="f16 font-extrabold text-slate-800 leading-none">{fmt(a.sites)}</div><div className="f10 text-slate-400 mt-1">sites</div></div>
                <div><div className="f16 font-extrabold text-slate-800 leading-none">{fmt(a.visits)}</div><div className="f10 text-slate-400 mt-1">visites</div></div>
                <div><div className={clsx("f16 font-extrabold leading-none", a.pending ? "text-amber-600" : "text-slate-800")}>{fmt(a.pending)}</div><div className="f10 text-slate-400 mt-1">à valider</div></div>
              </div>
              <div className="mt-2.5">
                <div className="flex items-center justify-between f10 text-slate-400 mb-1"><span>Score moyen du registre</span><span className="font-semibold text-slate-600">{a.scoreMoyen}%</span></div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width:`${a.scoreMoyen}%`, background:bande(a.scoreMoyen).c }} /></div>
              </div>
            </div>); })}
        </div>
      </Card>

      {/* ── Classement de performance ── */}
      <Card title="Performance par activité" subtitle="Activités classées par couverture décroissante">
        <div className="space-y-1">
          {[...parActivite].sort((a, b) => b.rate - a.rate).map((a, i) => (
            <div key={a.tag} className="grid items-center gap-3 py-1.5 border-b border-slate-100 last:border-0"
              style={{ gridTemplateColumns:"24px 1fr 1fr 52px" }}>
              <span className="f125 font-extrabold text-slate-300 text-center">{i+1}</span>
              <span className="f125 font-semibold text-slate-800 truncate" title={a.nom}>
                <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background:a.color }} />{a.tag} — {a.nom}</span>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full" style={{ width:`${Math.min(100, a.rate)}%`, background:a.color }} /></div>
              <span className="text-right f125 font-bold tabular-nums text-slate-700">{a.rate}%</span>
            </div>))}
        </div>
      </Card>
    </div>);
}

export { ProcessDashboard };
