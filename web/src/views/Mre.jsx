import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Banknote, CalendarRange, Check, ClipboardList, Download, Pencil, Plus,
         RefreshCw, Save, Target, Trash2, Wallet } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line,
         ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Note, Select, Stat, StatRow,
         TableWrap, Td, Th, download, inputCls, toCSV } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { clsx, fmt, n, r2 } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ═══════════════════════════════════════════════════════════════════════
   Plan MRE — suivi, revue et évaluation.

   L'écran présentait une liste d'activités annuelles avec, pour chacune, des lignes
   de coût. Ce n'était pas un plan MRE : les classeurs de référence du bureau pays en
   décrivent un autre, en deux parties liées.

     1. Le PLAN DE SUIVI, par indicateur du cadre logique : d'où vient la donnée,
        par quelle méthode, qui la collecte, à quelle fréquence, et dans quel
        rapport elle est utilisée. C'est la partie que l'outil ne savait pas
        exprimer du tout — il connaissait la cible d'un indicateur, jamais la
        mécanique qui le produit.

     2. La BUDGÉTISATION, par activité : entité responsable, catégorie de coût,
        fréquence trimestrielle sur PLUSIEURS années, coût unitaire. Le budget d'une
        année vaut ( Σ des quatre trimestres ) × coût unitaire — la formule du
        classeur, qui dit quand l'argent est consommé, ce qu'un montant annuel ne
        dit pas.

   L'ancien plan devait étaler les lignes sans mois sur la durée de l'activité, avec
   un arrondi à somme conservée : une approximation qu'on défendait faute de mieux.
   Il n'y a plus rien à approximer — chaque occurrence est déclarée dans son
   trimestre.
   ═══════════════════════════════════════════════════════════════════════ */

const VUES = [
  ["plan",      "Plan de suivi par indicateur"],
  ["budget",    "Budgétisation des activités"],
  ["execution", "Exécution budgétaire"],
];

const money = (v, cur) => `${fmt(Math.round(v || 0))}${cur ? " " + cur : ""}`;

/* Grille de quatre trimestres, en lecture. Un trimestre vide reste visible : le
   calendrier se lit d'un coup d'œil, et un trou est une information. */
function Trimestres({ q }){
  return (
    <div className="flex gap-0.5"
         title={q ? `T1 ${q[0]} · T2 ${q[1]} · T3 ${q[2]} · T4 ${q[3]}` : "aucune occurrence"}>
      {[0,1,2,3].map(i => {
        const v = q?.[i] || 0;
        return (
          <span key={i} className={clsx("w-6 h-5 grid place-items-center rounded f105 font-semibold",
            v ? "bg-sky-100 text-sky-800" : "bg-slate-50 text-slate-300")}>{v || "·"}</span>);
      })}
    </div>);
}

export default function MreView({ db, me, notify, can }){
  const [vue, setVue]   = useState("budget");
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [edit, setEdit] = useState(null);      /* activité ouverte en sous-page */
  const [f, setF] = useState({ kind:"", entity:"" });

  const charger = useCallback(async () => {
    const q = new URLSearchParams({ year:String(year) });
    Object.entries(f).forEach(([k,v]) => { if(v) q.set(k, v); });
    try{ setData(await api.mre("?" + q)); }
    catch(e){ notify(e.message, "err"); setData({ rows:[], totals:{}, referentiel:{} }); }
  }, [year, f, notify]);
  useEffect(()=>{ charger(); }, [charger]);

  if(!data) return <Empty icon={ClipboardList} title="Chargement du plan MRE…" />;
  const ref = data.referentiel || {};
  const t = data.totals || {};
  const cur = t.currency;
  const annees = [...new Set([year, ...(data.parAnnee||[]).map(x=>x.year),
    new Date().getFullYear(), new Date().getFullYear()+1])].sort();

  if(edit) return (
    <Activite activity={edit} db={db} ref2={ref} year={year} can={can} notify={notify}
      onClose={()=>{ setEdit(null); charger(); }} onSaved={(a)=>setEdit(a)} />);

  const barre = (
    <>
      <Select value={year} onChange={e=>setYear(n(e.target.value))}
        options={annees.map(y=>[y,String(y)])} className="mi-py1 mi-xs mi-wauto" />
      <Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger}>Actualiser</Btn>
    </>);

  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap">
        {VUES.map(([id,label])=>(
          <button key={id} onClick={()=>setVue(id)}
            className={clsx("px-3 py-1.5 rounded f125 border transition-colors",
              vue===id ? "bd-brand bg-sky-50 c-bd font-semibold"
                       : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")}>{label}</button>))}
      </div>

      {vue === "plan" && <PlanIndicateurs db={db} can={can} notify={notify} />}

      {vue === "budget" && (<>
        <StatRow>
          <Stat label={`Activités au plan ${year}`} value={t.activites ?? 0} icon={ClipboardList}
            sub={`${t.occurrences || 0} occurrence(s) prévue(s)`} />
          <Stat label={`Budget ${year}`} value={cur ? money(t.budget, cur) : fmt(Math.round(t.budget||0))}
            icon={Wallet}
            sub={t.devises?.length > 1 ? `devises mêlées : ${t.devises.join(", ")}` : "fréquence × coût unitaire"} />
          <Stat label="Budget de tout le plan"
            value={cur ? money(t.budgetTotal, cur) : fmt(Math.round(t.budgetTotal||0))}
            icon={CalendarRange} sub={`${(data.parAnnee||[]).length} exercice(s)`} />
          <Stat label="Sans calendrier" value={t.sansFrequence ?? 0} icon={Target}
            tone={t.sansFrequence ? "warn" : "ok"} sub="ni occurrence, ni budget" />
        </StatRow>

        {(data.parAnnee||[]).length > 1 && (
          <Card title="Le plan dans le temps" subtitle="Budget par exercice, toutes activités confondues">
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={data.parAnnee} margin={{top:6,right:8,left:4,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="year" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false}
                       tickFormatter={v=>fmt(Math.round(v))} width={70} />
                <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}}
                         formatter={(v,k)=>[money(v,cur), k]} />
                <Legend wrapperStyle={{fontSize:11}} />
                {/* L'exercice consulté est mis en avant : sur un plan de cinq ans,
                    on perd sinon lequel on est en train de lire. */}
                {/* `fill` sur la série ET sur chaque barre : sans le premier, la
                    pastille de légende se dessine en noir, faute de couleur déclarée. */}
                <Bar dataKey="budget" name="Budget" fill={C.brand} radius={[2,2,0,0]} barSize={40}>
                  {data.parAnnee.map(x=>(
                    <Cell key={x.year} fill={x.year === year ? C.brand : "#cfe0ea"} />))}
                </Bar>
                <Line type="monotone" dataKey="spent" name="Dépensé" stroke={C.ok} strokeWidth={2.5} dot={{r:3}} />
              </ComposedChart>
            </ResponsiveContainer>
          </Card>)}

        <Card flush title={`Budgétisation ${year}`}
          subtitle="Une activité, un coût unitaire, des occurrences par trimestre — le budget en découle"
          right={<>
            <Select value={f.entity} onChange={e=>setF(x=>({...x, entity:e.target.value}))}
              empty="Interne et externe" options={Object.entries(ref.entities||{})}
              className="mi-py1 mi-xs mi-wauto" />
            <Select value={f.kind} onChange={e=>setF(x=>({...x, kind:e.target.value}))}
              empty="Toutes les natures" options={Object.entries(ref.kinds||{})}
              className="mi-py1 mi-xs mi-wauto" />
            {barre}
            {can("edit") && <Btn size="sm" icon={Plus}
              onClick={()=>setEdit({ _nouveau:true, year, currency:"USD", kind:"suivi",
                                     unit_cost:0, frequences:{}, depenses:{} })}>
              Ajouter une activité</Btn>}
          </>}>
          {!data.rows.length
            ? <Empty icon={ClipboardList} title="Aucune activité à ce plan"
                text="Une activité MRE porte un coût unitaire et un nombre d'occurrences par trimestre." />
            : (<TableWrap max="mh520">
                <thead><tr><Th>Réf.</Th><Th>Activité</Th><Th>Entité</Th><Th>Catégorie de coût</Th>
                  <Th>{year}</Th><Th num>Coût unitaire</Th><Th num>Budget {year}</Th>
                  <Th num>Budget total</Th><Th /></tr></thead>
                <tbody>{data.rows.map(a=>{
                  const an = a.budgetParAnnee?.[year];
                  return (
                    <tr key={a.id} className="hover:bg-sky-50 cursor-pointer" onClick={()=>setEdit(a)}>
                      <Td className="f115 text-slate-500">{a.ref || "—"}</Td>
                      <Td className="mw420">
                        <div className="font-medium text-slate-800">{a.title}</div>
                        <div className="f105 text-slate-400">
                          {a.kindLabel}{a.office ? ` · ${a.office}` : " · plan national"}
                          {a.responsible ? ` · ${a.responsible}` : ""}</div>
                      </Td>
                      <Td><Badge tone={a.entity === "externe" ? "y" : "n"}>
                        {a.entity === "externe" ? "externe" : a.entity === "interne" ? "interne" : "—"}</Badge></Td>
                      <Td className="f115 text-slate-600 mw420">{a.cost_category || "—"}
                        {a.highLabel && <div className="f105 text-slate-400">{a.highLabel}</div>}</Td>
                      <Td><Trimestres q={a.frequences?.[year]} /></Td>
                      <Td num className="f115">{money(a.unit_cost, "")}</Td>
                      <Td num data-budget={an?.montant || 0} className="font-semibold">
                        {an ? money(an.montant, cur ? "" : a.currency) : "—"}
                        {an && <div className="f105 text-slate-400 font-normal">
                          {an.occurrences} × {fmt(Math.round(a.unit_cost))}</div>}</Td>
                      <Td num className="text-slate-600">{money(a.budget, cur ? "" : a.currency)}</Td>
                      <Td className="text-right" onClick={e=>e.stopPropagation()}>
                        <Btn size="sm" kind="sec" onClick={()=>setEdit(a)}>Ouvrir</Btn></Td>
                    </tr>);
                })}</tbody>
                <tfoot><tr className="bg-slate-50 font-semibold">
                  <Td colSpan={6} className="text-slate-600">Total du plan {year}</Td>
                  <Td num data-budget-total={t.budget}>{money(t.budget, cur)}</Td>
                  <Td num>{money(t.budgetTotal, cur)}</Td><Td /></tr></tfoot>
              </TableWrap>)}
        </Card>

        <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr"}}>
          <Card title={`Charge trimestrielle ${year}`}
            subtitle="Quand les occurrences tombent — et donc quand l'argent part">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={data.parTrimestre} margin={{top:6,right:8,left:4,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="label" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false}
                       tickFormatter={v=>fmt(Math.round(v))} width={70} />
                <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}}
                         formatter={(v)=>money(v,cur)} />
                <Bar dataKey="budget" name="Budget" fill={C.brand} radius={[2,2,0,0]} barSize={44} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
          <Card title="Budget par catégorie de coût"
            subtitle="La ligne d'imputation : où part l'argent">
            {!data.parCategorie?.length ? <Empty title="Aucune catégorie renseignée"
              text="Renseignez la catégorie de coût de haut niveau sur chaque activité." /> : (
              <div className="space-y-2.5">
                {data.parCategorie.map(c=>(
                  <div key={c.category}>
                    <div className="flex justify-between f125 text-slate-700 mb-1">
                      <span>{c.label}</span>
                      <b className="tabular-nums">{money(c.budget, cur)}</b></div>
                    <Bar2 value={t.budget ? (c.budget / t.budget) * 100 : 0} />
                    <div className="f105 text-slate-400 mt-0.5">{c.n} activité(s)</div>
                  </div>))}
              </div>)}
          </Card>
        </div>
      </>)}

      {vue === "execution" && <Execution data={data} year={year} cur={cur} barre={barre}
        onOpen={setEdit} />}
    </div>);
}

/* ── Exécution budgétaire ───────────────────────────────────────────── */
function Execution({ data, year, cur, barre, onOpen }){
  const t = data.totals || {};
  const rows = data.rows.filter(a => a.budgetParAnnee?.[year] || a.depenses?.[year]);
  return (
    <>
      <StatRow>
        <Stat label={`Budget ${year}`} value={money(t.budget, cur)} icon={Wallet} />
        <Stat label="Dépense constatée" value={money(t.spent, cur)} icon={Banknote}
          sub={t.execution != null ? `${t.execution} % des activités engagées` : "aucune dépense saisie"} />
        <Stat label="Activités engagées" value={rows.filter(a=>a.depenses?.[year]).length} icon={Check}
          sub={`sur ${rows.length} au plan`} />
        <Stat label="Écart" value={money((t.budget||0) - (t.spent||0), cur)} icon={Target}
          tone={(t.spent||0) > (t.budget||0) ? "bad" : "ok"} />
      </StatRow>

      <Card flush title={`Exécution budgétaire ${year}`}
        subtitle="Ce qui était prévu, ce qui a été payé — l'écart se lit sans second classeur"
        right={barre}>
        {!rows.length ? <Empty icon={Banknote} title="Rien à exécuter sur cet exercice" /> : (
          <TableWrap max="mh520">
            <thead><tr><Th>Réf.</Th><Th>Activité</Th><Th num>Budget {year}</Th>
              <Th num>Dépense constatée</Th><Th>Exécution</Th><Th>Statut</Th><Th /></tr></thead>
            <tbody>{rows.map(a=>{
              const b = a.budgetParAnnee?.[year]?.montant || 0;
              const d = a.depenses?.[year]?.amount;
              const ex = b && d != null ? Math.round((d / b) * 1000) / 10 : null;
              return (
                <tr key={a.id} className="hover:bg-sky-50 cursor-pointer" onClick={()=>onOpen(a)}>
                  <Td className="f115 text-slate-500">{a.ref || "—"}</Td>
                  <Td className="font-medium text-slate-800 mw420">{a.title}</Td>
                  <Td num>{money(b, cur ? "" : a.currency)}</Td>
                  {/* Nul n'est pas zéro : « pas encore dépensé » et « dépense nulle »
                      sont deux états différents, et les confondre afficherait une
                      exécution de 0 % là où il n'y en a simplement pas. */}
                  <Td num className={d == null ? "text-slate-400" : ""}>
                    {d == null ? "non renseignée" : money(d, cur ? "" : a.currency)}</Td>
                  <Td>{ex == null ? <span className="text-slate-400 f115">—</span> : (
                    <div className="flex items-center gap-2">
                      <Bar2 value={Math.min(100, ex)} tone={ex > 105 ? "bad" : ex > 90 ? "warn" : "ok"} />
                      <span className="tabular-nums f115 w-12 text-right">{ex} %</span>
                    </div>)}</Td>
                  <Td><Badge tone={a.status === "realise" ? "g" : a.status === "en_cours" ? "b" : "n"}>
                    {a.status}</Badge></Td>
                  <Td className="text-right" onClick={e=>e.stopPropagation()}>
                    <Btn size="sm" kind="sec" onClick={()=>onOpen(a)}>Saisir</Btn></Td>
                </tr>);
            })}</tbody>
          </TableWrap>)}
      </Card>
    </>);
}

/* ── Une activité : sous-page, et non fenêtre ───────────────────────── */
function Activite({ activity, db, ref2, year, can, notify, onClose, onSaved }){
  const neuf = !!activity._nouveau;
  const [a, setA] = useState(activity);
  const [busy, setBusy] = useState(false);
  const u = (k,v) => setA(p => ({ ...p, [k]:v }));

  /* Le calendrier en édition : un tableau d'exercices, chacun avec ses quatre
     trimestres. L'exercice consulté est toujours proposé — sinon il faudrait
     l'ajouter avant de pouvoir saisir quoi que ce soit. */
  const [freq, setFreq] = useState(() => {
    const base = {};
    for(const [an, qs] of Object.entries(activity.frequences || {})) base[an] = [...qs];
    if(!base[year]) base[year] = [0,0,0,0];
    return base;
  });
  const [dep, setDep] = useState(() => {
    const d = {};
    for(const [an, x] of Object.entries(activity.depenses || {})) d[an] = x.amount;
    return d;
  });

  const annees = Object.keys(freq).map(Number).sort();
  const budgetAnnee = (an) => r2((freq[an] || []).reduce((t,x)=>t+n(x), 0) * n(a.unit_cost));
  const budgetTotal = r2(annees.reduce((t,an)=>t+budgetAnnee(an), 0));

  const enregistrer = async () => {
    setBusy(true);
    const corps = { year:a.year || year, ref:a.ref || null, title:a.title, kind:a.kind || "suivi",
      purpose:a.purpose || null, method:a.method || null, office_id:a.office_id || null,
      activity_tag:a.activity_tag || null, indicator_id:a.indicator_id || null,
      geo_pcode:a.geo_pcode || null, responsible:a.responsible || null,
      entity:a.entity || null, cost_category:a.cost_category || null,
      high_category:a.high_category || null, unit_cost:n(a.unit_cost),
      sample:a.sample === "" || a.sample == null ? null : n(a.sample),
      status:a.status || "planifie", funding:a.funding || null,
      currency:a.currency || "USD", note:a.note || null };
    if(!neuf) corps.rev = a.rev;
    try{
      const r = neuf ? await api.createMre(corps) : await api.updateMre(a.id, corps);
      const id = r.activity.id;
      /* Le calendrier et la dépense partent ensuite : ils appartiennent à
         l'activité, et l'utilisateur les a sous les yeux au même moment. */
      const rows = annees.map(an => ({ year:an, q:(freq[an]||[0,0,0,0]).map(x=>n(x)) }));
      let dernier = await api.mreFrequencies(id, { rev:r.activity.rev, rows });
      const dRows = Object.entries(dep)
        .filter(([,v]) => v !== "" && v != null)
        .map(([an,v]) => ({ year:Number(an), amount:n(v) }));
      if(dRows.length) dernier = await api.mreSpend(id, { rows:dRows });
      notify("Activité enregistrée", "ok");
      onSaved(dernier.activity);
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const supprimer = async () => {
    if(!confirm(`Supprimer « ${a.title} » et son calendrier ?`)) return;
    try{ await api.deleteMre(a.id); notify("Activité supprimée", "ok"); onClose(); }
    catch(e){ notify(e.message, "err"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Btn kind="sec" size="sm" icon={ArrowLeft} onClick={onClose}>Tout le plan</Btn>
        <div className="f13 font-semibold text-slate-800">
          {neuf ? "Nouvelle activité MRE" : a.title}
          {!neuf && a.ref && <span className="f115 font-normal text-slate-500 ml-2">{a.ref}</span>}</div>
        <div className="ml-auto flex gap-2">
          {!neuf && can("del") && <Btn kind="sec" size="sm" icon={Trash2} onClick={supprimer}>Supprimer</Btn>}
          {can("edit") && <Btn icon={Save} disabled={busy || !(a.title||"").trim()} onClick={enregistrer}>
            {busy ? "Enregistrement…" : "Enregistrer"}</Btn>}
        </div>
      </div>

      <Card title="Identité de l'activité"
        subtitle="Ce qu'on entreprend, pour répondre à quelle question, et par quelle méthode">
        <div className="grid grid-cols-4 gap-x-4">
          <Field label="Intitulé" className="col-span-3">
            <Input value={a.title||""} onChange={e=>u("title",e.target.value)}
              placeholder="Enquête post-distribution — premier semestre" /></Field>
          <Field label="Référence" hint="Unique dans l'année et le pays">
            <Input value={a.ref||""} onChange={e=>u("ref",e.target.value)} placeholder="MRE-04" /></Field>
          <Field label="Nature">
            <Select value={a.kind||"suivi"} onChange={e=>u("kind",e.target.value)}
              options={Object.entries(ref2.kinds||{})} /></Field>
          <Field label="Entité responsable" hint="Équipe interne, ou achat de service">
            <Select value={a.entity||""} onChange={e=>u("entity",e.target.value)}
              empty="— à préciser —" options={Object.entries(ref2.entities||{})} /></Field>
          <Field label="Bureau porteur" hint="Vide = plan national">
            <Select value={a.office_id||""} onChange={e=>u("office_id",e.target.value)}
              empty="Plan national" options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
          <Field label="Responsable">
            <Input value={a.responsible||""} onChange={e=>u("responsible",e.target.value)} /></Field>
          <Field label="À quelle question l'activité répond" className="col-span-2">
            <Input value={a.purpose||""} onChange={e=>u("purpose",e.target.value)} /></Field>
          <Field label="Méthode de collecte ou d'analyse" className="col-span-2">
            <Input value={a.method||""} onChange={e=>u("method",e.target.value)} /></Field>
          <Field label="Indicateur suivi" hint="Le lien avec le cadre logique">
            <Select value={a.indicator_id||""} onChange={e=>u("indicator_id",e.target.value)}
              empty="— aucun —"
              options={(db.indicators||[]).map(i=>[i.key, `${i.id} — ${i.name.slice(0,50)}`])} /></Field>
          <Field label="Activité programme"><Input value={a.activity_tag||""}
            onChange={e=>u("activity_tag",e.target.value)} placeholder="URT, ACL…" /></Field>
          <Field label="Taille d'échantillon"><Input type="number" value={a.sample ?? ""}
            onChange={e=>u("sample",e.target.value)} /></Field>
          <Field label="Statut">
            <Select value={a.status||"planifie"} onChange={e=>u("status",e.target.value)}
              options={(ref2.statuses||[]).map(s=>[s,s])} /></Field>
        </div>
      </Card>

      <Card title="Coût et calendrier"
        subtitle="Le budget n'est pas saisi : il vaut ( Σ des occurrences du trimestre ) × coût unitaire">
        <div className="grid grid-cols-4 gap-x-4">
          <Field label="Coût unitaire" hint="Ce que coûte UNE occurrence de l'activité">
            <Input type="number" value={a.unit_cost ?? 0} onChange={e=>u("unit_cost",e.target.value)} /></Field>
          <Field label="Devise"><Input maxLength={3} value={a.currency||"USD"}
            onChange={e=>u("currency",e.target.value.toUpperCase())} /></Field>
          <Field label="Catégorie d'activité" hint="Le vocabulaire du classeur de référence">
            <Select value={a.cost_category||""} onChange={e=>u("cost_category",e.target.value)}
              empty="— à préciser —"
              options={Object.values(ref2.categories||{}).flatMap(c => c.sub.map(s=>[s, s]))} /></Field>
          <Field label="Catégorie de coût" hint="La ligne d'imputation budgétaire">
            <Select value={a.high_category||""} onChange={e=>u("high_category",e.target.value)}
              empty="— à préciser —" options={Object.entries(ref2.highCategories||{})} /></Field>
        </div>

        <Field label="Occurrences par trimestre"
          hint="Une ligne par exercice : un plan pluriannuel se saisit ici, sans changer d'écran.">
          <TableWrap>
            <thead><tr><Th>Exercice</Th><Th num>T1</Th><Th num>T2</Th><Th num>T3</Th><Th num>T4</Th>
              <Th num>Occurrences</Th><Th num>Budget</Th><Th num>Dépense constatée</Th><Th /></tr></thead>
            <tbody>{annees.map(an=>(
              <tr key={an}>
                <Td className="font-medium text-slate-800">{an}</Td>
                {[0,1,2,3].map(q=>(
                  <Td key={q} num>
                    <input type="number" min="0" value={freq[an]?.[q] ?? 0}
                      className={clsx(inputCls,"mi-py1 w-16 text-right")}
                      onChange={e=>setFreq(p=>{ const g={...p}; const l=[...(g[an]||[0,0,0,0])];
                        l[q] = e.target.value === "" ? 0 : Number(e.target.value); g[an]=l; return g; })} />
                  </Td>))}
                <Td num className="font-semibold">{(freq[an]||[]).reduce((t,x)=>t+n(x),0)}</Td>
                <Td num className="font-semibold">{money(budgetAnnee(an), a.currency)}</Td>
                <Td num>
                  <input type="number" min="0" placeholder="non renseignée" value={dep[an] ?? ""}
                    className={clsx(inputCls,"mi-py1 w-32 text-right")}
                    onChange={e=>setDep(p=>({ ...p, [an]: e.target.value }))} /></Td>
                <Td className="text-right">
                  <button onClick={()=>{ setFreq(p=>{ const g={...p}; delete g[an]; return g; });
                                         setDep(p=>{ const g={...p}; delete g[an]; return g; }); }}
                    className="text-slate-400 hover:text-rose-600 p-1" title="Retirer cet exercice">
                    <Trash2 size={14}/></button></Td>
              </tr>))}</tbody>
            <tfoot><tr className="bg-slate-50 font-semibold">
              <Td colSpan={6} className="text-slate-600">Budget de l'activité, tous exercices</Td>
              <Td num>{money(budgetTotal, a.currency)}</Td><Td colSpan={2} /></tr></tfoot>
          </TableWrap>
          <div className="mt-2">
            <Btn size="sm" kind="sec" icon={Plus}
              onClick={()=>setFreq(p=>({ ...p, [Math.max(...annees, year) + 1]:[0,0,0,0] }))}>
              Ajouter un exercice</Btn>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Source de financement">
            <Input value={a.funding||""} onChange={e=>u("funding",e.target.value)} /></Field>
          <Field label="Note">
            <Input value={a.note||""} onChange={e=>u("note",e.target.value)} /></Field>
        </div>
      </Card>
    </div>);
}

/* ── Plan de suivi par indicateur ───────────────────────────────────── */
function PlanIndicateurs({ db, can, notify }){
  const [edit, setEdit] = useState(null);
  const rows = db.indicators || [];
  const renseignes = rows.filter(i => i.data_source).length;

  const exporter = () => download("plan-suivi-indicateurs.csv", toCSV(rows.map(i=>({
    code:i.id, indicateur:i.name, cible_odd:i.sdg_target || "", effet:i.outcome || "",
    activite:i.activity_category || "", cible:i.target, unite:i.unit,
    source:i.data_source || "", methode:i.method || "", reference:i.baseline || "",
    responsable:i.responsible || "", frequence:i.freq || "", rapports:i.reports || "",
  })), ["code","indicateur","cible_odd","effet","activite","cible","unite","source","methode",
        "reference","responsable","frequence","rapports"]), "text/csv");

  return (
    <>
      <Note>Cette partie est le <b>plan de suivi</b> proprement dit : pour chaque indicateur du cadre
        logique — d'où vient la donnée, par quelle méthode elle est collectée, comment la référence est
        établie, qui collecte, à quelle fréquence, et dans quel rapport l'information est utilisée.
        <br /><br />
        Les indicateurs eux-mêmes — code, intitulé, cible, sens — se déclarent dans
        <b> Paramètres → Indicateurs</b>. Ici on décrit <b>comment on les obtient</b>, ce qui est
        exactement la question à laquelle un plan de suivi répond.</Note>

      <Card flush title="Plan de suivi par indicateur"
        subtitle={`${rows.length} indicateur(s) · ${renseignes} décrit(s)`}
        right={<Btn size="sm" kind="sec" icon={Download} onClick={exporter} disabled={!rows.length}>
          Exporter</Btn>}>
        {!rows.length ? <Empty icon={Target} title="Aucun indicateur déclaré"
          text="Déclarez-les dans Paramètres → Indicateurs, puis revenez décrire comment ils sont collectés." /> : (
          <TableWrap max="mh520">
            <thead><tr><Th>Indicateur</Th><Th>Source de données</Th><Th>Méthode de collecte</Th>
              <Th>Établissement de la référence</Th><Th>Responsable</Th><Th>Fréquence</Th>
              <Th>Rapports</Th><Th /></tr></thead>
            <tbody>{rows.map(i=>(
              <tr key={i.key} className="hover:bg-sky-50">
                <Td className="mw420">
                  <div className="font-medium text-slate-800">{i.id}</div>
                  <div className="f105 text-slate-500 whitespace-normal">{i.name}</div>
                  {i.activity_category && <div className="f105 text-slate-400">{i.activity_category}</div>}
                </Td>
                {/* Ce qui manque est signalé plutôt que laissé vide : un plan de
                    suivi incomplet est une information, pas un tableau propre. */}
                {["data_source","method","baseline","responsible","freq","reports"].map(k=>(
                  <Td key={k} className={clsx("f115 whitespace-normal mw420",
                    i[k] ? "text-slate-700" : "text-amber-700")}>
                    {i[k] || "à renseigner"}</Td>))}
                <Td className="text-right">{can("edit") &&
                  <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEdit(i)}>Décrire</Btn>}</Td>
              </tr>))}</tbody>
          </TableWrap>)}
      </Card>

      {edit && <IndicateurPlan indicateur={edit} notify={notify} onClose={()=>setEdit(null)} />}
    </>);
}

/* La description d'un indicateur. Carte dépliée sous le tableau plutôt que fenêtre :
   douze champs dans une modale donnaient douze lignes serrées qu'on ne relisait pas. */
function IndicateurPlan({ indicateur, notify, onClose }){
  const [f, setF] = useState(indicateur);
  const [busy, setBusy] = useState(false);
  const u = (k,v) => setF(p => ({ ...p, [k]:v }));
  const champs = [
    ["data_source","Source de données","Registre de distribution, formulaire ODK, rapport du partenaire…"],
    ["method","Méthode de collecte","Entretien ménage, observation de site, étude sur dossier…"],
    ["baseline","Établissement de la référence","Enquête de base, valeur du cycle précédent, aucune référence…"],
    ["responsible","Responsabilité de la collecte","Unité suivi-évaluation, partenaire coopérant, prestataire…"],
    ["freq","Fréquence de suivi","Mensuelle, semestrielle, annuelle…"],
    ["reports","Rapports où l'information est utilisée","Rapport annuel pays, revue à mi-parcours…"],
    ["use_note","Quand, comment et par qui","Ce qu'on en fait concrètement, et à quelle échéance"],
  ];
  const enregistrer = async () => {
    setBusy(true);
    try{
      await api.updateIndicatorPlan(f.key, {
        ...Object.fromEntries(champs.map(([k]) => [k, f[k] || null])),
        sdg_target:f.sdg_target || null, outcome:f.outcome || null,
        outcome_category:f.outcome_category || null, activity_ref:f.activity_ref || null,
        activity_category:f.activity_category || null,
      });
      notify("Plan de suivi enregistré — rechargez pour le voir partout", "ok");
      onClose();
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };
  return (
    <Card title={`Plan de suivi — ${f.id}`} subtitle={f.name}
      right={<><Btn kind="sec" onClick={onClose}>Fermer</Btn>
        <Btn icon={Save} disabled={busy} onClick={enregistrer}>
          {busy ? "Enregistrement…" : "Enregistrer"}</Btn></>}>
      <div className="grid grid-cols-3 gap-x-4">
        <Field label="Cible ODD"><Input value={f.sdg_target||""}
          onChange={e=>u("sdg_target",e.target.value)} placeholder="2.1 Accès à la nourriture" /></Field>
        <Field label="Effet stratégique"><Input value={f.outcome||""}
          onChange={e=>u("outcome",e.target.value)} /></Field>
        <Field label="Catégorie d'effet"><Input value={f.outcome_category||""}
          onChange={e=>u("outcome_category",e.target.value)} /></Field>
        <Field label="Activité du programme"><Input value={f.activity_ref||""}
          onChange={e=>u("activity_ref",e.target.value)} placeholder="Activité 01" /></Field>
        <Field label="Catégorie d'activité" className="col-span-2"><Input value={f.activity_category||""}
          onChange={e=>u("activity_category",e.target.value)}
          placeholder="1.2 Transfert de ressources non conditionnel" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-x-4">
        {champs.map(([k,label,hint])=>(
          <Field key={k} label={label} hint={hint}>
            <Input value={f[k]||""} onChange={e=>u(k,e.target.value)} /></Field>))}
      </div>
    </Card>);
}
