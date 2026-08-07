import { useCallback, useEffect, useState } from "react";
import { Banknote, CalendarRange, Check, Download, Pencil, Plus, Save, Target, Trash2, Wallet, X } from "lucide-react";
import { Aide, Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow,
         TableWrap, Td, Th, download, inputCls, toCSV } from "../components/ui.jsx";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api.js";
import { clsx, fmt, n } from "../lib/calc.js";
import { C, MONTHS } from "../lib/constants.js";

/* ═══════════════════════════════════════════════════════════════════════
   Plan MRE et budget — Monitoring, Review and Evaluation.

   L'application savait planifier des visites de site et des rounds
   d'indicateur ; elle ne savait pas dire ce que l'unité suivi-évaluation
   entreprend dans l'année, ni ce que cela coûte. Ces deux questions revenaient
   à chaque exercice budgétaire, et la réponse vivait dans un classeur tenu à
   part — donc jamais rapproché de ce que l'outil mesure.

   Un principe gouverne l'écran : le budget est la somme de ses lignes, jamais
   un montant saisi. Un total qu'on ne peut pas décomposer ne se défend pas
   devant un bailleur et ne se compare pas à la dépense. Les totaux affichés ici
   viennent du serveur, qui les calcule une fois pour l'écran, l'export et les
   rapports — trois calculs séparés finiraient par donner trois chiffres.
   ═══════════════════════════════════════════════════════════════════════ */

const MOIS = MONTHS;
const money = (v, cur) => (v == null ? "—" : `${fmt(Math.round(v))} ${cur || ""}`.trim());

const STATUT = {
  planifie:   ["Planifiée", "n"],
  en_cours:   ["En cours", "b"],
  realise:    ["Réalisée", "g"],
  reporte:    ["Reportée", "y"],
  annule:     ["Annulée", "r"],
};
const KIND_TONE = { suivi:C.brand, revue:"#7C3AED", evaluation:"#D97706",
  enquete:"#0891B2", etude:"#059669", capacite:"#DB2777" };

/* Bandeau de calendrier : une activité qui court de mars à juin se lit d'un
   coup d'œil. Douze cases, pas un diagramme de Gantt — la précision utile est
   le mois, et une échelle de temps continue laisserait croire à mieux. */
const rangeMois = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
function Calendrier({ months, start, end, tone }){
  /* Les mois cochés — désormais éventuellement discontinus (janvier + août). */
  const set = new Set(Array.isArray(months) && months.length ? months
    : (start != null ? rangeMois(start, end == null ? start : end) : []));
  if(!set.size) return <span className="text-slate-300">—</span>;
  return (
    <div className="flex gap-0.5" title={[...set].sort((a,b)=>a-b).map(i=>MOIS[i]).join(", ")}>
      {MOIS.map((m, i) => (
        <span key={i} className={clsx("w-2.5 h-3.5 rounded-sm", set.has(i) ? "" : "bg-slate-100")}
          style={set.has(i) ? { background: tone || C.brand } : undefined} />))}
    </div>);
}

export default function MreView({ db, me, notify, can }){
  const [volet, setVolet] = useState("plan");
  const [year, setYear]   = useState(new Date().getFullYear());
  const [kind, setKind]   = useState("");
  const [statut, setStatut] = useState("");
  const [data, setData]   = useState(null);
  const [edit, setEdit]   = useState(null);
  const [busy, setBusy]   = useState(false);
  /* Deux états que l'écran confondait. Changer d'année ou de filtre relançait la
     lecture en laissant les anciennes lignes affichées, sans le moindre repère :
     on lisait le plan de 2025 en croyant lire celui de 2026. Et un échec retombait
     sur un plan VIDE, indiscernable d'un plan légitimement vide une fois le toast
     évanoui — l'agent ne pouvait pas savoir s'il n'y avait rien ou si le serveur
     avait échoué. Les deux se disent maintenant, et l'erreur reste à l'écran. */
  const [chargement, setChargement] = useState(false);
  const [erreur, setErreur] = useState("");

  const charger = useCallback(async () => {
    const q = new URLSearchParams({ year:String(year) });
    if(kind) q.set("kind", kind);
    if(statut) q.set("status", statut);
    setChargement(true);
    try{ setData(await api.mre("?" + q)); setErreur(""); }
    catch(e){ notify(e.message, "err"); setErreur(e.message); setData({ rows:[], totals:null }); }
    finally{ setChargement(false); }
  }, [year, kind, statut, notify]);
  useEffect(()=>{ charger(); }, [charger]);

  const enregistrer = async (f, lignes) => {
    setBusy(true);
    const payload = {
      year: n(f.year) || year, ref:f.ref || null, title:(f.title||"").trim(), kind:f.kind || "suivi",
      purpose:f.purpose || null, method:f.method || null,
      office_id:f.office_id || null, activity_tag:f.activity_tag || null,
      indicator_id:f.indicator_id || null, geo_pcode:f.geo_pcode || null,
      responsible:f.responsible || null,
      /* Les mois de mise en œuvre, éventuellement discontinus. Ils priment ; le
         serveur en dérive start/end pour la compatibilité. */
      months: Array.isArray(f.months) ? [...f.months].sort((a,b)=>a-b) : [],
      start_month: f.start_month === "" || f.start_month == null ? null : n(f.start_month),
      end_month:   f.end_month   === "" || f.end_month   == null ? null : n(f.end_month),
      sample: f.sample === "" || f.sample == null ? null : n(f.sample),
      status:f.status || "planifie", funding:f.funding || null,
      currency:(f.currency || "USD").toUpperCase(), note:f.note || null,
    };
    if(f.id) payload.rev = f.rev;
    try{
      const r = f.id ? await api.updateMre(f.id, payload) : await api.createMre(payload);
      const id = r.activity.id;
      /* Le budget part dans un second appel, avec la révision que vient de
         renvoyer le premier : sans cela l'enregistrement se refuserait lui-même. */
      await api.saveMreCosts(id, r.activity.rev, (lignes||[])
        .filter(l => (l.label||"").trim() || n(l.qty) || n(l.unit_cost))
        .map(l => ({ category:l.category || "autre", label:l.label || null, unit:l.unit || null,
          qty:n(l.qty), unit_cost:n(l.unit_cost),
          spent: l.spent === "" || l.spent == null ? null : n(l.spent),
          month: l.month === "" || l.month == null ? null : n(l.month), note:l.note || null })));
      setEdit(null); await charger();
      notify("Activité et budget enregistrés", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const supprimer = async (a) => {
    if(!confirm(`Supprimer « ${a.title} » et ses ${a.costs.length} ligne(s) de budget ?`)) return;
    try{ await api.deleteMre(a.id); await charger(); notify("Activité supprimée", "ok"); }
    catch(e){ notify(e.message, "err"); }
  };

  const exporter = () => {
    /* Les mois RÉELS, et pas seulement le premier et le dernier. Une activité
       planifiée en janvier et en août a `start=0` et `end=7` — le serveur les
       dérive du minimum et du maximum pour compatibilité —, si bien qu'un fichier
       ne portant que « début : Janvier / fin : Août » se lit comme huit mois
       continus, quand l'écran n'en colore que deux. Le fichier remis au bailleur
       annonçait donc une période que personne n'a planifiée. La colonne « mois »
       porte la liste ; « debut »/« fin » restent, pour les lecteurs qui les
       attendent, mais ne sont plus la seule vérité disponible. */
    const moisDe = (a) => (a.months?.length
      ? a.months : (a.start_month != null && a.end_month != null
          ? Array.from({ length: a.end_month - a.start_month + 1 }, (_, i) => a.start_month + i)
          : [])).map(i => MOIS[i]).join(", ");
    const commun = (a) => ({ reference:a.ref, activite:a.title, type:a.kindLabel,
      bureau:a.office || "National", portee:a.portee, statut:(STATUT[a.status]||[])[0],
      mois: moisDe(a),
      debut: a.start_month!=null ? MOIS[a.start_month] : "",
      fin: a.end_month!=null ? MOIS[a.end_month] : "" });
    const lignes = (data?.rows || []).flatMap(a => a.costs.length
      ? a.costs.map(l => ({ ...commun(a), categorie:l.category, ligne:l.label, unite:l.unit,
          quantite:l.qty, cout_unitaire:l.unit_cost, budget:l.total, depense:l.spent ?? "", devise:a.currency }))
      : [{ ...commun(a), categorie:"", ligne:"(aucune ligne de budget)",
          quantite:"", cout_unitaire:"", budget:0, depense:"", devise:a.currency }]);
    download(`plan-mre-${year}.csv`, toCSV(lignes, ["reference","activite","type","bureau","portee",
      "statut","mois","debut","fin","categorie","ligne","unite","quantite","cout_unitaire","budget",
      "depense","devise"]), "text/csv");
  };

  if(!data) return <Empty icon={CalendarRange} title="Chargement du plan MRE…" />;
  const t = data.totals || {};
  const cur = t.currency;
  const rows = data.rows || [];
  const annees = [...new Set([year, new Date().getFullYear(), new Date().getFullYear()+1,
    new Date().getFullYear()-1])].sort();

  const filtres = (
    <>
      <Select value={year} onChange={e=>setYear(n(e.target.value))}
        options={annees.map(y=>[y,String(y)])} className="mi-py1 mi-xs mi-wauto" />
      <Select value={kind} onChange={e=>setKind(e.target.value)} empty="Tous les types"
        options={Object.entries(data.referentiel?.kinds || {})} className="mi-py1 mi-xs mi-wauto" />
      <Select value={statut} onChange={e=>setStatut(e.target.value)} empty="Tous les statuts"
        options={Object.entries(STATUT).map(([k,[l]])=>[k,l])} className="mi-py1 mi-xs mi-wauto" />
      {/* Le rechargement se voit : sans ce repère, changer d'année laissait les
          lignes de l'année précédente à l'écran, sans rien qui les démente. */}
      {chargement && <span className="f115 text-slate-500 animate-pulse">Lecture…</span>}
      <Btn size="sm" kind="sec" icon={Download} onClick={exporter}>Exporter</Btn>
      {can("edit") && <Btn size="sm" icon={Plus}
        onClick={()=>setEdit({ year, kind:"suivi", status:"planifie", currency:cur || "USD",
          office_id: me?.office_id || null, _lignes:[] })}>Ajouter une activité</Btn>}
    </>);

  return (
    <div className="space-y-4">
      <Aide
        faire={["Bâtir le plan MRE (Monitoring, Reporting, Evaluation) par activité et par mois, avec son budget prévisionnel.",
          "Basculer sur « Exécution budgétaire » pour saisir la dépense constatée et suivre l'écart au prévu.",
          "Filtrer par année, par type d'activité ou par statut pour retrouver une ligne précise."]}
        eviter={["Confondre budget prévu et dépense réelle : ce sont deux volets distincts du même plan, ne saisissez pas l'un à la place de l'autre.",
          "Interpréter un plan vide comme « rien à faire » sans vérifier le bandeau d'erreur : une lecture ratée laisse aussi l'écran vide."]} />
      {/* Le prévu et le réalisé du budget sont deux vues du même plan : même
          bascule que partout ailleurs dans l'application. */}
      <div className="flex items-center gap-1 p-1 rounded bg-slate-100 border border-slate-200 w-max">
        {[["plan","Plan et budget",CalendarRange],["reel","Exécution budgétaire",Check]].map(([id,label,Icon])=>(
          <button key={id} onClick={()=>setVolet(id)}
            className={clsx("flex items-center gap-1.5 px-3 py-1.5 rounded f125 font-semibold transition-colors",
              volet===id ? "bg-white text-slate-800 shadow-sm border border-slate-200"
                         : "text-slate-500 hover:text-slate-700")}>
            <Icon size={13} />{label}</button>))}
      </div>

      {/* Un échec de lecture RESTE à l'écran. Le toast qui le portait s'évanouit en
          quatre secondes, après quoi le plan vide se lisait comme un plan
          légitimement vide : deux situations opposées sous la même apparence. */}
      {erreur && (
        <Note tone="bad"><b>Le plan n'a pas pu être lu.</b> {erreur}{" "}
          Ce qui s'affiche ci-dessous n'est donc pas le plan de {year} : c'est un écran vide
          faute de réponse. Réessayez, ou signalez ce message à l'équipe technique.</Note>)}

      {!t.currency && t.devises?.length > 1 && (
        <Note tone="warn"><b>Plusieurs devises dans le même plan ({t.devises.join(", ")}).</b>{" "}
          Les totaux par devise restent justes, mais le total général n'est pas affiché :
          additionner des montants non convertis produirait un chiffre faux.</Note>)}

      <StatRow>
        <Stat label="Activités planifiées" value={t.activites ?? 0} icon={CalendarRange}
          sub={`${t.enCours || 0} en cours · ${t.realisees || 0} réalisée(s)`} />
        <Stat label="Budget total" value={cur ? money(t.budget, cur) : fmt(Math.round(t.budget||0))}
          icon={Wallet} sub={`${t.chiffrees || 0} activité(s) chiffrée(s)`} />
        {volet === "plan"
          ? <Stat label="Sans budget" value={t.sansBudget ?? 0} icon={Target}
              tone={t.sansBudget ? "warn" : "ok"}
              sub={t.sansBudget ? "à chiffrer avant arbitrage" : "toutes les activités sont chiffrées"} />
          : <Stat label="Dépense constatée" value={cur ? money(t.spent, cur) : fmt(Math.round(t.spent||0))}
              icon={Banknote} sub="sur les activités engagées seulement" />}
        <Stat label="Exécution budgétaire"
          value={t.execution == null ? "—" : t.execution + " %"}
          tone={t.execution == null ? undefined : t.execution > 110 ? "bad" : t.execution > 95 ? "warn" : "ok"}
          sub="dépense / budget des activités engagées" />
      </StatRow>

      {volet === "plan"
        ? <Plan data={data} rows={rows} cur={cur} filtres={filtres} can={can}
                onEdit={setEdit} onDelete={supprimer} />
        : <Execution data={data} rows={rows} cur={cur} filtres={filtres} onEdit={setEdit} can={can} />}

      <MreModal open={!!edit} activity={edit} db={db} data={data} busy={busy}
        onClose={()=>setEdit(null)} onSave={enregistrer} />
    </div>);
}

/* ── Volet « plan » : ce qu'on entreprend, quand, et pour quel montant ── */
function Plan({ data, rows, cur, filtres, can, onEdit, onDelete }){
  const parKind = data.parKind || [];
  return (
    <>
      <Card flush title={`Plan MRE ${data.year}`}
        subtitle={`${rows.length} activité(s) · suivi, revue, évaluation, enquête et étude`}
        right={filtres}>
        {!rows.length
          ? <Empty icon={CalendarRange} title="Aucune activité pour cette année"
              text="Le plan MRE recense ce que l'unité de suivi-évaluation entreprend : suivi de processus, enquêtes post-distribution, revues, évaluations. Chaque activité porte son budget, ligne par ligne." />
          /* Neuf colonnes débordaient de la carte et le budget — la colonne pour
             laquelle on ouvre cet écran — se retrouvait hors champ. La nature, la
             portée, le responsable et l'échantillon tiennent dans la cellule de
             l'activité : ce sont des qualificatifs, pas des grandeurs à comparer
             verticalement. Restent cinq colonnes, dont le budget, visibles. */
          : (<TableWrap max="mh480">
              <thead><tr><Th>Réf.</Th><Th>Activité</Th><Th>Calendrier</Th>
                <Th num>Budget</Th><Th>Statut</Th><Th /></tr></thead>
              <tbody>{rows.map(a=>(
                <tr key={a.id} className="hover:bg-sky-50 align-top">
                  <Td className="f115 text-slate-500 pt-2.5">{a.ref || "—"}</Td>
                  <Td className="whitespace-normal py-2">
                    <div className="font-medium text-slate-800">{a.title}</div>
                    {a.purpose && <div className="f11 text-slate-500 mt-0.5 mw420">{a.purpose}</div>}
                    <div className="flex items-center gap-2 flex-wrap mt-1 f105 text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full" style={{background:KIND_TONE[a.kind]||C.brand}} />
                        {a.kindLabel}</span>
                      <span className="text-slate-300">·</span>
                      <span>{a.office || "Plan national"}</span>
                      {a.geo_pcode && <><span className="text-slate-300">·</span><span>{a.portee}</span></>}
                      {a.responsible && <><span className="text-slate-300">·</span><span>{a.responsible}</span></>}
                      {!!a.sample && <><span className="text-slate-300">·</span>
                        <span>échantillon {fmt(a.sample)}</span></>}
                    </div></Td>
                  <Td className="pt-3"><Calendrier months={a.months} start={a.start_month} end={a.end_month} tone={KIND_TONE[a.kind]} /></Td>
                  {/* `data-budget` porte la valeur brute : le texte affiché est
                      groupé à la française et suivi du nombre de lignes, donc
                      illisible pour un test — même raison que `data-site` sur la carte. */}
                  <Td num data-budget={a.budget}
                    className={clsx("pt-2.5", a.budget ? "font-semibold" : "text-slate-400")}>
                    {a.budget ? money(a.budget, cur ? "" : a.currency) : "à chiffrer"}
                    {!!a.costs.length && <div className="f105 text-slate-400 font-normal">
                      {a.costs.length} ligne(s)</div>}</Td>
                  <Td className="pt-2.5"><Badge tone={(STATUT[a.status]||["","n"])[1]}>{(STATUT[a.status]||[a.status])[0]}</Badge></Td>
                  <Td className="text-right whitespace-nowrap pt-2">{can("edit") && (<>
                    <button onClick={()=>onEdit({ ...a, _lignes:a.costs.map(l=>({ ...l })) })}
                      className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>
                    {can("del") && <button onClick={()=>onDelete(a)}
                      className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>}</>)}</Td>
                </tr>))}</tbody>
              <tfoot><tr className="bg-slate-50 font-semibold">
                <Td colSpan={3} className="text-slate-600">Total du plan</Td>
                <Td num data-budget-total={data.totals.budget}>
                  {cur ? money(data.totals.budget, cur) : fmt(Math.round(data.totals.budget))}</Td>
                <Td colSpan={2} /></tr></tfoot>
            </TableWrap>)}
      </Card>

      <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))"}}>
        <Card title="Budget par nature d'activité"
          subtitle="Ce que le plan consacre au suivi, à la revue, à l'évaluation">
          {!parKind.length ? <Empty title="Rien à répartir" /> : (
            <div className="space-y-2.5">
              {parKind.sort((a,b)=>b.budget-a.budget).map(k=>{
                const part = data.totals.budget ? (k.budget / data.totals.budget) * 100 : 0;
                return (
                  <div key={k.kind}>
                    <div className="flex items-baseline gap-2 f125">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{background:KIND_TONE[k.kind]}} />
                      <span className="text-slate-700 truncate">{k.label}</span>
                      <span className="ml-auto tabular-nums font-semibold text-slate-800">
                        {/* Les deux branches du ternaire précédent rendaient la même
                            chaîne vide : le code laissait croire à une règle
                            d'affichage de la devise qui n'existait pas. Elle existe
                            maintenant — le code devise sort quand le plan n'en porte
                            qu'une, et se tait quand il en mélange plusieurs, un
                            montant sans devise valant mieux qu'une devise fausse. */}
                        {money(k.budget, cur || "")}</span>
                      <span className="tabular-nums f11 text-slate-400 w-10 text-right">
                        {Math.round(part)} %</span>
                    </div>
                    <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width:part+"%", background:KIND_TONE[k.kind] }} /></div>
                    <div className="f105 text-slate-400 mt-0.5">{k.n} activité(s)</div>
                  </div>);
              })}
            </div>)}
        </Card>

        <Card title="Budget par catégorie de coût"
          subtitle="La question posée en arbitrage : où part l'argent">
          {!(data.parCategorie||[]).length ? <Empty title="Aucune ligne de budget" /> : (
            <div style={{height:Math.max(200, (data.parCategorie.length*30)+40)}}>
              <ResponsiveContainer>
                <BarChart data={[...data.parCategorie].sort((a,b)=>b.budget-a.budget)}
                  layout="vertical" margin={{left:8,right:16,top:4,bottom:4}}>
                  <CartesianGrid horizontal={false} stroke="#E2E8F0" />
                  <XAxis type="number" tick={{fontSize:10}} tickFormatter={v=>fmt(v)} />
                  <YAxis type="category" dataKey="label" width={130} tick={{fontSize:10}} />
                  <Tooltip formatter={(v)=>money(v, cur||"")} />
                  <Bar dataKey="budget" name="Budget" fill={C.brand} radius={[0,3,3,0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>)}
        </Card>
      </div>

      <Card title="Charge mensuelle du plan"
        subtitle="Une ligne datée est imputée à son mois ; une ligne sans date est répartie sur la durée de son activité — convention explicite, pas une mesure">
        <div style={{height:200}}>
          <ResponsiveContainer>
            <BarChart data={(data.parMois||[]).map(m=>({ ...m, mois:MOIS[m.month] }))}>
              <CartesianGrid vertical={false} stroke="#E2E8F0" />
              <XAxis dataKey="mois" tick={{fontSize:10}} />
              <YAxis tick={{fontSize:10}} tickFormatter={v=>fmt(v)} />
              <Tooltip formatter={(v)=>money(v, cur||"")} />
              <Bar dataKey="budget" name="Budget" fill={C.brand} radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </>);
}

/* ── Volet « réel » : ce qui a été dépensé, et l'écart ──────────────── */
function Execution({ data, rows, cur, filtres, onEdit, can }){
  /* Seules les activités engagées entrent dans l'écart : mélanger celles qui
     n'ont pas commencé donnerait une sous-exécution mécanique de l'année. */
  const engagees = rows.filter(a => a.spent != null);
  const tone = (e) => e == null ? undefined : e > 110 ? "bad" : e > 95 ? "warn" : "ok";
  return (
    <>
      <Note>La dépense est saisie <b>ligne de budget par ligne de budget</b>, dans la fiche
        de l'activité. Une ligne sans dépense n'est pas une dépense nulle : elle est
        <b> non engagée</b>, et reste hors du calcul d'exécution — sinon toute l'année à
        venir afficherait une sous-consommation.</Note>

      <Card flush title={`Exécution budgétaire ${data.year}`}
        subtitle={`${engagees.length} activité(s) engagée(s) sur ${rows.length}`} right={filtres}>
        {!engagees.length
          ? <Empty icon={Banknote} title="Aucune dépense constatée"
              text="Renseignez la dépense sur les lignes de budget des activités engagées ; l'écart apparaît ici." />
          : (<TableWrap max="mh480">
              <thead><tr><Th>Réf.</Th><Th>Activité</Th><Th>Bureau</Th><Th num>Budget</Th>
                <Th num>Dépensé</Th><Th num>Écart</Th><Th>Exécution</Th><Th>Statut</Th><Th /></tr></thead>
              <tbody>{engagees.map(a=>{
                const ecart = a.budget - (a.spent || 0);
                return (
                  <tr key={a.id} className="hover:bg-sky-50">
                    <Td className="f115 text-slate-500">{a.ref || "—"}</Td>
                    <Td className="font-medium text-slate-800 mw420 whitespace-normal">{a.title}</Td>
                    <Td className="f115 text-slate-600">{a.office || "Plan national"}</Td>
                    <Td num>{money(a.budget, cur ? "" : a.currency)}</Td>
                    <Td num className="font-semibold">{money(a.spent, cur ? "" : a.currency)}</Td>
                    <Td num className={ecart < 0 ? "text-rose-700 font-semibold" : "text-slate-600"}>
                      {money(ecart, cur ? "" : a.currency)}</Td>
                    <Td><div className="flex items-center gap-2">
                      <Bar2 value={a.execution || 0} tone={tone(a.execution)} />
                      <span className="tabular-nums f115 w-12 text-right">{a.execution} %</span></div></Td>
                    <Td><Badge tone={(STATUT[a.status]||["","n"])[1]}>{(STATUT[a.status]||[a.status])[0]}</Badge></Td>
                    <Td className="text-right">{can("edit") &&
                      <button onClick={()=>onEdit({ ...a, _lignes:a.costs.map(l=>({ ...l })) })}
                        className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>}</Td>
                  </tr>);
              })}</tbody>
              <tfoot><tr className="bg-slate-50 font-semibold">
                <Td colSpan={3} className="text-slate-600">Total engagé</Td>
                <Td num>{fmt(Math.round(engagees.reduce((t,a)=>t+a.budget,0)))}</Td>
                <Td num>{fmt(Math.round(engagees.reduce((t,a)=>t+(a.spent||0),0)))}</Td>
                <Td num>{fmt(Math.round(engagees.reduce((t,a)=>t+a.budget-(a.spent||0),0)))}</Td>
                <Td colSpan={3} /></tr></tfoot>
            </TableWrap>)}
      </Card>

      <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))"}}>
        <Card title="Budget et dépense par mois"
          subtitle="La trésorerie du plan, prévue et constatée">
          <div style={{height:230}}>
            <ResponsiveContainer>
              <BarChart data={(data.parMois||[]).map(m=>({ ...m, mois:MOIS[m.month] }))}>
                <CartesianGrid vertical={false} stroke="#E2E8F0" />
                <XAxis dataKey="mois" tick={{fontSize:10}} />
                <YAxis tick={{fontSize:10}} tickFormatter={v=>fmt(v)} />
                <Tooltip formatter={(v)=>money(v, cur||"")} />
                <Legend wrapperStyle={{fontSize:11}} />
                <Bar dataKey="budget" name="Budget" fill={C.brand} radius={[3,3,0,0]} />
                <Bar dataKey="spent"  name="Dépensé" fill={C.warn} radius={[3,3,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card flush title="Écart par catégorie de coût"
          subtitle="Où le plan dérape, et de combien">
          <TableWrap max="mh300">
            <thead><tr><Th>Catégorie</Th><Th num>Budget</Th><Th num>Dépensé</Th>
              <Th num>Écart</Th><Th>Exécution</Th></tr></thead>
            <tbody>{(data.parCategorie||[]).map(c=>{
              const ex = c.budget ? Math.round((c.spent / c.budget) * 1000) / 10 : null;
              return (
                <tr key={c.category} className="hover:bg-sky-50">
                  <Td className="text-slate-700">{c.label}</Td>
                  <Td num>{fmt(Math.round(c.budget))}</Td>
                  <Td num>{c.spent ? fmt(Math.round(c.spent)) : "—"}</Td>
                  <Td num className={c.budget - c.spent < 0 ? "text-rose-700 font-semibold" : ""}>
                    {fmt(Math.round(c.budget - c.spent))}</Td>
                  <Td><div className="flex items-center gap-2">
                    <Bar2 value={ex || 0} tone={tone(ex)} />
                    <span className="tabular-nums f115 w-12 text-right">{ex == null ? "—" : ex + " %"}</span></div></Td>
                </tr>);
            })}</tbody>
          </TableWrap>
        </Card>
      </div>
    </>);
}

/* ── Fiche d'activité et son budget ─────────────────────────────────── */
function MreModal({ open, activity, db, data, busy, onClose, onSave }){
  const [f, setF] = useState({});
  const [lignes, setLignes] = useState([]);
  useEffect(()=>{
    setF(activity || {});
    setLignes(activity?._lignes?.length ? activity._lignes.map(l=>({ ...l })) : []);
  }, [activity]);
  if(!open) return null;

  const u = (k,v) => setF(p=>({ ...p, [k]:v }));
  const majLigne = (i,k,v) => setLignes(p => p.map((l,j)=> j===i ? { ...l, [k]:v } : l));
  const total = lignes.reduce((t,l)=> t + n(l.qty) * n(l.unit_cost), 0);
  const depense = lignes.reduce((t,l)=> t + (l.spent === "" || l.spent == null ? 0 : n(l.spent)), 0);
  const engagees = lignes.filter(l => l.spent !== "" && l.spent != null).length;
  const cats = Object.entries(data?.referentiel?.categories || {});
  const kinds = Object.entries(data?.referentiel?.kinds || {});

  return (
    <Modal open wide onClose={onClose}
      title={activity?.id ? "Modifier l'activité MRE" : "Nouvelle activité MRE"}
      subtitle="Ce qu'on entreprend, quand, avec quelle méthode — puis son budget ligne par ligne"
      footer={<>
        <div className="mr-auto f125 text-slate-600">
          Budget <b className="tabular-nums text-slate-800">{fmt(Math.round(total))} {(f.currency||"USD")}</b>
          {" "}· {lignes.length} ligne(s)
          {!!engagees && <> · dépensé <b className="tabular-nums">{fmt(Math.round(depense))}</b></>}
        </div>
        <Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || (f.title||"").trim().length < 3}
          onClick={()=>onSave(f, lignes)}>{busy ? "Enregistrement…" : "Enregistrer"}</Btn></>}>

      <div className="grid grid-cols-3 gap-x-4">
        <Field label="Intitulé de l'activité" className="col-span-2">
          <Input value={f.title||""} onChange={e=>u("title",e.target.value)}
            placeholder="Enquête post-distribution — premier semestre" /></Field>
        <Field label="Référence" hint="Unique dans l'année">
          <Input value={f.ref||""} onChange={e=>u("ref",e.target.value)} placeholder="MRE-08" /></Field>
        <Field label="Nature">
          <Select value={f.kind||"suivi"} onChange={e=>u("kind",e.target.value)} options={kinds} /></Field>
        <Field label="Année"><Input type="number" value={f.year ?? ""} onChange={e=>u("year",e.target.value)} /></Field>
        <Field label="Statut">
          <Select value={f.status||"planifie"} onChange={e=>u("status",e.target.value)}
            options={Object.entries(STATUT).map(([k,[l]])=>[k,l])} /></Field>
      </div>

      {/* Deux champs par ligne plutôt qu'un : la fiche fait défiler jusqu'au
          tableau du budget, qui est la raison de l'ouvrir. */}
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Question à laquelle l'activité répond"
          hint="Une activité de suivi qui ne sert aucune décision n'a pas à être budgétée">
          <Input value={f.purpose||""} onChange={e=>u("purpose",e.target.value)} /></Field>
        <Field label="Méthode">
          <Input value={f.method||""} onChange={e=>u("method",e.target.value)}
            placeholder="Échantillon aléatoire stratifié, entretiens ménages" /></Field>
      </div>

      <div className="grid grid-cols-3 gap-x-4">
        <Field label="Bureau porteur" hint="Sans bureau : activité du plan national">
          <Select value={f.office_id||""} onChange={e=>u("office_id",e.target.value)}
            empty="Plan national" options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
        <Field label="Activité programme">
          <Select value={f.activity_tag||""} onChange={e=>u("activity_tag",e.target.value)}
            empty="Transversale" options={(db.lists?.tags||[]).map(t=>[t.code,`${t.code} — ${t.label}`])} /></Field>
        <Field label="Indicateur suivi">
          <Select value={f.indicator_id||""} onChange={e=>u("indicator_id",e.target.value)}
            empty="Aucun en particulier"
            options={(db.indicators||[]).map(i=>[i.id,`${i.code} — ${i.name}`])} /></Field>
        {/* Mois de mise en œuvre — cliquez les mois concernés ; la période peut être
            DISCONTINUE (par exemple janvier + août, sans les mois intermédiaires). */}
        <Field label="Mois de mise en œuvre" className="col-span-2"
          hint="Cliquez les mois concernés — la période peut être discontinue (ex. janvier + août).">
          <div className="flex flex-wrap gap-1.5">
            {MOIS.map((m,i)=>{ const sel = (f.months||[]).includes(i);
              return (
              <button key={i} type="button"
                onClick={()=>u("months", (() => { const s = new Set(f.months||[]);
                  s.has(i) ? s.delete(i) : s.add(i); return [...s].sort((a,b)=>a-b); })())}
                className={clsx("px-2.5 py-1 f115 rounded-lg border font-semibold transition-colors",
                  sel ? "bg-brand text-white border-transparent shadow-sm"
                      : "bg-white text-slate-600 border-slate-200 hover:border-slate-300")}>
                {m.slice(0,4)}</button>); })}
          </div>
        </Field>
        <Field label="Taille d'échantillon" hint="Le cas échéant : enquête, revue de dossiers">
          <Input type="number" value={f.sample ?? ""} onChange={e=>u("sample",e.target.value)} /></Field>
        <Field label="Responsable"><Input value={f.responsible||""} onChange={e=>u("responsible",e.target.value)} /></Field>
        <Field label="Source de financement"><Input value={f.funding||""} onChange={e=>u("funding",e.target.value)} /></Field>
        <Field label="Devise" hint="Code à trois lettres">
          <Input value={f.currency||"USD"} maxLength={3}
            onChange={e=>u("currency",e.target.value.toUpperCase())} /></Field>
      </div>

      {/* ── Budget ──────────────────────────────────────────────────────
          Aucun champ « budget total » : il se calcule. Un total saisi à côté de
          ses lignes finit par ne plus leur correspondre, et c'est le total qu'on
          présente au bailleur. */}
      <div className="mt-2 pt-3 border-t border-slate-200">
        <div className="flex items-baseline gap-3 mb-2">
          <div className="f13 font-semibold text-slate-800">Budget de l'activité</div>
          <div className="f115 text-slate-500">quantité × coût unitaire ; le total est calculé</div>
          <div className="ml-auto f125 tabular-nums font-semibold text-slate-800">
            {fmt(Math.round(total))} {(f.currency||"USD")}</div>
        </div>
        <TableWrap max="mh300">
          <thead><tr><Th>Catégorie</Th><Th>Ligne</Th><Th>Unité</Th><Th num>Qté</Th>
            <Th num>Coût unitaire</Th><Th num>Total</Th><Th num>Dépensé</Th><Th>Mois</Th><Th /></tr></thead>
          <tbody>{lignes.map((l,i)=>(
            <tr key={i}>
              <Td><Select value={l.category||"autre"} onChange={e=>majLigne(i,"category",e.target.value)}
                options={cats} className="mi-py1 mi-xs mi-wauto" /></Td>
              <Td><input value={l.label||""} onChange={e=>majLigne(i,"label",e.target.value)}
                className={clsx(inputCls,"mi-py1 mnw180")} placeholder="Enquêteurs et superviseurs" /></Td>
              <Td><input value={l.unit||""} onChange={e=>majLigne(i,"unit",e.target.value)}
                className={clsx(inputCls,"mi-py1 w-24")} placeholder="personne-jour" /></Td>
              <Td num><input type="number" value={l.qty ?? ""} onChange={e=>majLigne(i,"qty",e.target.value)}
                className={clsx(inputCls,"mi-py1 w-20 text-right")} /></Td>
              <Td num><input type="number" value={l.unit_cost ?? ""} onChange={e=>majLigne(i,"unit_cost",e.target.value)}
                className={clsx(inputCls,"mi-py1 w-24 text-right")} /></Td>
              <Td num className="font-semibold">{fmt(Math.round(n(l.qty) * n(l.unit_cost)))}</Td>
              <Td num><input type="number" value={l.spent ?? ""} onChange={e=>majLigne(i,"spent",e.target.value)}
                placeholder="—" className={clsx(inputCls,"mi-py1 w-24 text-right")} /></Td>
              <Td><Select value={l.month ?? ""} onChange={e=>majLigne(i,"month",e.target.value)}
                empty="—" options={MOIS.map((m,j)=>[j,m])} className="mi-py1 mi-xs mi-wauto" /></Td>
              <Td className="text-right">
                <button onClick={()=>setLignes(p=>p.filter((_,j)=>j!==i))}
                  className="px-1 text-slate-400 hover:text-rose-600"><X size={14}/></button></Td>
            </tr>))}
            {!lignes.length && (
              <tr><Td colSpan={9} className="text-center text-slate-400 py-4">
                Aucune ligne de budget. Une activité non chiffrée reste dans le plan, mais
                n'entre pas dans l'arbitrage.</Td></tr>)}
          </tbody>
        </TableWrap>
        <Btn size="sm" kind="sec" icon={Plus} className="mt-2"
          onClick={()=>setLignes(p=>[...p,{ category:"autre", qty:1, unit_cost:0 }])}>
          Ajouter une ligne</Btn>
      </div>

      <Field label="Note" className="mt-3">
        <Input value={f.note||""} onChange={e=>u("note",e.target.value)} /></Field>
    </Modal>);
}
