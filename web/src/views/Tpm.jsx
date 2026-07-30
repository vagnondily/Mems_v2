import { useCallback, useEffect, useState } from "react";
import { Banknote, Building2, CalendarRange, Check, ChevronRight, ClipboardList, Download,
         FileText, Pencil, Plus, RefreshCw, Save, Send, Target, Trash2, Wallet, X } from "lucide-react";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow,
         TableWrap, Td, Th, download, inputCls, toCSV } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { clsx, fmt, n } from "../lib/calc.js";
import { C, MONTHS, MONTHS_L } from "../lib/constants.js";

/* ═══════════════════════════════════════════════════════════════════════
   Suivi tiers — TPM.

   Un principe, le même que pour le plan MRE : le budget n'est pas saisi, il est
   la conséquence de l'affectation. On assigne des zones pour le mois, on dit
   combien de superviseurs, d'agents, de jours et de véhicules ; le barème du
   contrat fait le reste. Le classeur d'un prestataire réel ne fait rien d'autre —
   Coût unitaire × Qté2 × Qté1, sous-total par équipe — et aucune de ses cellules
   de total n'est tapée à la main.

   Le second principe est le circuit. Trois niveaux, dans l'ordre, chacun ouvert à
   un acteur précis. L'écran ne décide de rien : il affiche ce que le serveur
   déclare permis (`plan.actions`). Redéduire le circuit côté navigateur aurait
   produit une seconde règle, qui aurait fini par diverger de la première.
   ═══════════════════════════════════════════════════════════════════════ */

const money = (v, cur) => (v == null ? "—" : `${fmt(Math.round(v))} ${cur || ""}`.trim());

const ETAT = {
  brouillon:     ["Brouillon", "n"],
  soumis:        ["Soumis", "y"],
  valide_tpm:    ["Validé prestataire", "b"],
  valide_bureau: ["Validé bureau", "b"],
  valide_pays:   ["Validé bureau pays", "g"],
  renvoye:       ["Renvoyé", "r"],
  cloture:       ["Clôturé", "n"],
};
/* L'avancement dans le circuit, pour le montrer d'un coup d'œil. */
const ETAPES = ["soumis", "valide_tpm", "valide_bureau", "valide_pays"];
const DRIVERS = [
  ["superviseur", "Superviseurs × jours"], ["agent", "Agents × jours"],
  ["vehicule", "Véhicules × jours"], ["carburant", "Litres"],
  ["forfait", "Forfait — quantité saisie"],
];

function Circuit({ status }){
  /* Un plan clôturé a franchi les trois niveaux : sans ce cas, `indexOf` renvoyait
     -1 et l'affichage laissait croire qu'aucune validation n'avait eu lieu. */
  const i = status === "cloture" ? ETAPES.length : ETAPES.indexOf(status);
  const renvoye = status === "renvoye";
  return (
    <div className="flex items-center gap-1">
      {["Prestataire", "Bureau", "Bureau pays"].map((l, k) => (
        <span key={l} className="flex items-center gap-1">
          {k > 0 && <ChevronRight size={11} className="text-slate-300" />}
          <span className={clsx("px-1.5 py-0.5 rounded f105 font-semibold",
            renvoye ? "bg-rose-50 text-rose-700"
            : i > k ? "bg-lime-50 text-lime-800"
            : i === k ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-400")}>{l}</span>
        </span>))}
    </div>);
}

export default function TpmView({ db, me, notify, can }){
  const [onglet, setOnglet] = useState("plans");
  const [year, setYear]     = useState(new Date().getFullYear());
  const [month, setMonth]   = useState("");
  const [tpmId, setTpmId]   = useState("");
  const [data, setData]     = useState(null);   /* plans */
  const [tpms, setTpms]     = useState(null);   /* prestataires et contrats */
  const [ouvert, setOuvert] = useState(null);   /* plan en cours d'examen */
  const [busy, setBusy]     = useState(false);

  const charger = useCallback(async () => {
    const q = new URLSearchParams({ year:String(year) });
    if(month !== "") q.set("month", String(month));
    if(tpmId) q.set("tpm_id", tpmId);
    try{
      const [p, t] = await Promise.all([api.tpmPlans("?" + q), api.tpm()]);
      setData(p); setTpms(t.rows || []);
    }catch(e){ notify(e.message, "err"); setData({ rows:[], totals:{} }); setTpms([]); }
  }, [year, month, tpmId, notify]);
  useEffect(()=>{ charger(); }, [charger]);

  const rafraichirPlan = async (id) => {
    try{ const r = await api.tpmPlan(id); setOuvert(r.plan); await charger(); }
    catch(e){ notify(e.message, "err"); }
  };

  if(!data || !tpms) return <Empty icon={ClipboardList} title="Chargement du suivi tiers…" />;
  const t = data.totals || {};
  const cur = t.currency;
  const annees = [...new Set([year, new Date().getFullYear(), new Date().getFullYear()-1,
    new Date().getFullYear()+1])].sort();

  const items = [["plans","Plans mensuels"],["contracts","Contrats et barèmes"],
    ["budget","Suivi budgétaire"]];

  return (
    <div className="space-y-4">
      {/* Pas de titre de page ici : la destination Suivi-évaluation porte déjà le sien,
          et deux titres empilés repousseraient les données sous la ligne de flottaison. */}
      <Tabs2 items={items} value={onglet} onChange={setOnglet} />

      {me?.tpm_id && (
        <Note><b>Vous êtes rattaché au prestataire « {me.tpm} ».</b> Vous ne voyez que
          vos propres plans, et la validation s'arrête pour vous au premier niveau —
          les deux suivants relèvent du bureau et du bureau pays.</Note>)}

      {onglet === "plans" && (<>
        <StatRow>
          <Stat label="Plans de l'exercice" value={t.plans ?? 0} icon={CalendarRange}
            sub={`${t.enAttente || 0} en attente de validation`} />
          <Stat label="Budget soumis" value={cur ? money(t.budget, cur) : fmt(Math.round(t.budget||0))}
            icon={Wallet} sub="tous états confondus" />
          <Stat label="Engagé" value={cur ? money(t.engage, cur) : fmt(Math.round(t.engage||0))}
            icon={Check} sub="plans validés au niveau pays" />
          <Stat label="Dépensé" value={cur ? money(t.depense, cur) : fmt(Math.round(t.depense||0))}
            icon={Banknote} sub="dépenses constatées" />
        </StatRow>

        {!!data.aValider?.length && (
          <Note tone="warn"><b>{data.aValider.length} plan(s) attendent votre validation.</b>{" "}
            Ils portent le bouton « Examiner » ci-dessous.</Note>)}

        <Card flush title={`Plans mensuels ${year}`}
          subtitle={`${data.rows.length} plan(s) · le budget est dérivé du barème contractuel, jamais saisi`}
          right={<>
            <Select value={year} onChange={e=>setYear(n(e.target.value))}
              options={annees.map(y=>[y,String(y)])} className="mi-py1 mi-xs mi-wauto" />
            <Select value={month} onChange={e=>setMonth(e.target.value === "" ? "" : n(e.target.value))}
              empty="Tous les mois" options={MONTHS_L.map((m,i)=>[i,m])} className="mi-py1 mi-xs mi-wauto" />
            {!me?.tpm_id && <Select value={tpmId} onChange={e=>setTpmId(e.target.value)}
              empty="Tous les prestataires" options={tpms.map(x=>[x.id,x.name])}
              className="mi-py1 mi-xs mi-wauto" />}
            <Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger}>Actualiser</Btn>
            {can("edit") && <Btn size="sm" icon={Plus}
              onClick={()=>setOuvert({ _nouveau:true, year, month: month === "" ? new Date().getMonth() : month })}>
              Nouveau plan</Btn>}
          </>}>
          {!data.rows.length
            ? <Empty icon={ClipboardList} title="Aucun plan sur cette période"
                text="Un plan couvre un prestataire et un mois : on y affecte les zones à suivre, et le budget en découle." />
            : (<TableWrap max="mh480">
                <thead><tr><Th>Mois</Th><Th>Prestataire</Th><Th>Réf.</Th><Th num>Zones</Th>
                  <Th num>Budget</Th><Th num>Dépensé</Th><Th>Circuit</Th><Th>État</Th><Th /></tr></thead>
                <tbody>{data.rows.map(p=>(
                  <tr key={p.id} className="hover:bg-sky-50">
                    <Td className="font-medium text-slate-800">{MONTHS[p.month]} {p.year}</Td>
                    <Td>{p.tpm}
                      {p.office && <div className="f105 text-slate-400">{p.office}</div>}</Td>
                    <Td className="f115 text-slate-500">{p.ref || "—"}</Td>
                    <Td num>{p.zones.length}</Td>
                    <Td num data-budget={p.budget} className="font-semibold">
                      {money(p.budget, cur ? "" : p.currency)}</Td>
                    <Td num className={p.execution > 100 ? "text-rose-700 font-semibold" : ""}>
                      {p.spent == null ? "—" : money(p.spent, cur ? "" : p.currency)}
                      {p.execution != null && <div className="f105 text-slate-400 font-normal">
                        {p.execution} %</div>}</Td>
                    <Td><Circuit status={p.status} /></Td>
                    <Td><Badge tone={(ETAT[p.status]||["","n"])[1]}>{(ETAT[p.status]||[p.status])[0]}</Badge></Td>
                    <Td className="text-right whitespace-nowrap">
                      <Btn size="sm" kind={p.actions?.valider ? "primary" : "sec"}
                        onClick={()=>rafraichirPlan(p.id)}>
                        {p.actions?.valider ? "Examiner" : "Ouvrir"}</Btn></Td>
                  </tr>))}</tbody>
                <tfoot><tr className="bg-slate-50 font-semibold">
                  <Td colSpan={4} className="text-slate-600">Total</Td>
                  <Td num>{fmt(Math.round(t.budget||0))}</Td>
                  <Td num>{fmt(Math.round(t.depense||0))}</Td>
                  <Td colSpan={3} /></tr></tfoot>
              </TableWrap>)}
        </Card>
      </>)}

      {onglet === "contracts" && <Contracts tpms={tpms} db={db} can={can} notify={notify}
        onChange={charger} />}
      {onglet === "budget"    && <Budget tpms={tpms} plans={data.rows} />}

      <PlanModal open={!!ouvert} plan={ouvert} tpms={tpms} db={db} me={me} can={can}
        busy={busy} setBusy={setBusy} notify={notify}
        onClose={()=>setOuvert(null)} onSaved={rafraichirPlan} onCreated={charger} />
    </div>);
}

/* Onglets internes. `Tabs` de la bibliothèque sert au second niveau de navigation ;
   ici c'est un troisième niveau, et réutiliser le même style les confondrait. */
function Tabs2({ items, value, onChange }){
  return (
    <div className="flex items-center gap-1 p-1 rounded bg-slate-100 border border-slate-200 w-max">
      {items.map(([id, label]) => (
        <button key={id} onClick={()=>onChange(id)}
          className={clsx("px-3 py-1.5 rounded f125 font-semibold transition-colors",
            value===id ? "bg-white text-slate-800 shadow-sm border border-slate-200"
                       : "text-slate-500 hover:text-slate-700")}>{label}</button>))}
    </div>);
}

/* ── Contrats, barèmes, avenants ─────────────────────────────────────*/
function Contracts({ tpms, db, can, notify, onChange }){
  const [editTpm, setEditTpm] = useState(null);
  const [editCtr, setEditCtr] = useState(null);
  const [rates, setRates]     = useState(null);   /* { contrat, lignes } */
  const [aven, setAven]       = useState(null);
  const [busy, setBusy]       = useState(false);

  const faire = async (fn, message) => {
    setBusy(true);
    try{ await fn(); await onChange(); notify(message, "ok");
      setEditTpm(null); setEditCtr(null); setRates(null); setAven(null); }
    catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  return (
    <>
      <Note>Le <b>plafond</b> d'un contrat ne se modifie pas en place : il évolue par
        <b> avenants</b>, chacun daté et motivé. Sans cela on saurait quel est le plafond
        du jour, mais plus pourquoi il a changé — ni ce qui avait été engagé avant.
        <br /><br />
        Le <b>barème</b> est ce qui transforme une affectation en budget. Chaque ligne porte
        son rôle dans le calcul : une ligne « superviseurs × jours » se remplit toute seule
        depuis les quantités de la zone ; une ligne « forfait » reste saisie.</Note>

      {can("admin") && <div className="flex gap-2 mb-4">
        <Btn size="sm" icon={Plus} onClick={()=>setEditTpm({ active:true })}>Nouveau prestataire</Btn>
      </div>}

      {!tpms.length && <Empty icon={Building2} title="Aucun prestataire"
        text="Un prestataire de suivi porte un ou plusieurs contrats, chacun avec son plafond, sa devise et son barème." />}

      {tpms.map(t => (
        <Card key={t.id} title={t.name}
          subtitle={[t.code, t.office || "tous bureaux", t.contact,
            `${t.users} compte(s)`].filter(Boolean).join(" · ")}
          right={can("admin") && <>
            <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEditTpm(t)}>Modifier</Btn>
            <Btn size="sm" kind="sec" icon={Plus}
              onClick={()=>setEditCtr({ tpm_id:t.id, currency:"MGA", status:"actif" })}>Contrat</Btn>
          </>}>
          {!t.contrats.length
            ? <div className="f125 text-slate-500 py-2">Aucun contrat. Sans contrat, aucun plan
                mensuel ne peut être monté — le barème et le plafond viennent de là.</div>
            : t.contrats.map(c => (
              <div key={c.id} className="border border-slate-200 rounded-xl p-4 mb-3 last:mb-0">
                <div className="flex items-baseline gap-3 flex-wrap mb-3">
                  <b className="f13 text-slate-800">{c.ref}</b>
                  <Badge tone={c.status==="actif"?"g":c.status==="clos"?"n":"y"}>{c.status}</Badge>
                  <span className="f115 text-slate-500">
                    {c.start_date || "—"} → {c.end_date || "—"}</span>
                  {can("admin") && <span className="ml-auto flex gap-2">
                    <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEditCtr({ ...c, tpm_id:t.id })}>Contrat</Btn>
                    <Btn size="sm" kind="sec" icon={Wallet}
                      onClick={()=>setRates({ contrat:c, lignes:c.rates.map(x=>({ ...x })) })}>Barème</Btn>
                    <Btn size="sm" kind="sec" icon={FileText} onClick={()=>setAven({ contrat:c })}>Avenant</Btn>
                  </span>}
                </div>

                {/* Le solde, décomposé. « Combien reste-t-il » n'a de sens que si l'on
                    distingue ce qui est engagé de ce qui circule encore. */}
                <div className="grid gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden mb-3"
                  style={{gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))"}}>
                  {[["Plafond", c.solde.plafond, ""],
                    ["Engagé", c.solde.engage, "plans validés au niveau pays"],
                    ["En cours", c.solde.enCours, "dans le circuit"],
                    ["Dépensé", c.solde.depense, "constaté"],
                    ["Disponible", c.solde.disponible, "plafond − engagé"]].map(([l,v,s])=>(
                    <div key={l} className="bg-white px-3 py-2.5">
                      <div className="f105 font-bold uppercase tracking-wider text-slate-500">{l}</div>
                      <div className={clsx("f15 font-semibold tabular-nums mt-0.5",
                        l==="Disponible" && v <= 0 ? "text-rose-700" : "text-slate-800")}>
                        {fmt(Math.round(v))}</div>
                      {s && <div className="f105 text-slate-400">{s}</div>}
                    </div>))}
                </div>
                <div className="flex items-center gap-3 f115 text-slate-600 mb-3">
                  <span>Consommation du plafond</span>
                  <div className="flex-1 max-w-xs"><Bar2 value={c.solde.consommation || 0}
                    tone={c.solde.consommation > 95 ? "bad" : c.solde.consommation > 80 ? "warn" : "ok"} /></div>
                  <b className="tabular-nums">{c.solde.consommation ?? 0} %</b>
                  <span className="text-slate-400">{c.currency}</span>
                </div>

                <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))"}}>
                  <div>
                    <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                      Barème — {c.rates.length} ligne(s)</div>
                    {!c.rates.length
                      ? <div className="f115 text-amber-700">Aucun barème : les plans de ce contrat
                          auront un budget nul.</div>
                      : <table className="w-full f115">
                          <tbody>{c.rates.map(x=>(
                            <tr key={x.id} className="border-b border-slate-100 last:border-0">
                              <td className="py-1 text-slate-700">{x.label}</td>
                              <td className="py-1 text-slate-400">{x.unit}</td>
                              <td className="py-1 text-right tabular-nums font-semibold">{fmt(x.unit_cost)}</td>
                              <td className="py-1 pl-2 text-slate-400 f105">
                                {(DRIVERS.find(d=>d[0]===x.driver)||[])[1]}</td>
                            </tr>))}</tbody>
                        </table>}
                  </div>
                  <div>
                    <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                      Avenants — {c.amendments.length}</div>
                    {!c.amendments.length
                      ? <div className="f115 text-slate-400">Plafond inchangé depuis la signature.</div>
                      : <table className="w-full f115">
                          <tbody>{c.amendments.map(a=>(
                            <tr key={a.id} className="border-b border-slate-100 last:border-0">
                              <td className="py-1 text-slate-500">{a.signed_at || "—"}</td>
                              <td className="py-1 text-slate-700">{a.ref || "avenant"}</td>
                              <td className={clsx("py-1 text-right tabular-nums font-semibold",
                                a.delta < 0 ? "text-rose-700" : "text-lime-700")}>
                                {a.delta > 0 ? "+" : ""}{fmt(a.delta)}</td>
                            </tr>))}
                            <tr><td colSpan={2} className="py-1 text-slate-500">Cumul</td>
                              <td className="py-1 text-right tabular-nums font-semibold">
                                {c.solde.avenants > 0 ? "+" : ""}{fmt(c.solde.avenants)}</td></tr>
                          </tbody>
                        </table>}
                    {c.amendments.map(a => a.reason && (
                      <div key={a.id+"r"} className="f105 text-slate-500 mt-1">
                        <b>{a.ref || "avenant"}</b> — {a.reason}</div>))}
                  </div>
                </div>
              </div>))}
        </Card>))}

      {/* Prestataire */}
      <Modal open={!!editTpm} onClose={()=>setEditTpm(null)}
        title={editTpm?.id ? "Modifier le prestataire" : "Nouveau prestataire de suivi"}
        subtitle="Identité et bureau de rattachement — c'est ce bureau qui valide au deuxième niveau"
        footer={<><Btn kind="sec" onClick={()=>setEditTpm(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !(editTpm?.name||"").trim()}
            onClick={()=>faire(() => {
              const b = { name:editTpm.name, code:editTpm.code||null, office_id:editTpm.office_id||null,
                contact:editTpm.contact||null, email:editTpm.email||null, phone:editTpm.phone||null,
                note:editTpm.note||null, active:editTpm.active!==false };
              if(editTpm.id) b.rev = editTpm.rev;
              return editTpm.id ? api.updateTpm(editTpm.id, b) : api.createTpm(b);
            }, "Prestataire enregistré")}>Enregistrer</Btn></>}>
        {editTpm && (<div className="grid grid-cols-2 gap-x-4">
          <Field label="Nom"><Input value={editTpm.name||""}
            onChange={e=>setEditTpm(p=>({...p,name:e.target.value}))} /></Field>
          <Field label="Code"><Input value={editTpm.code||""}
            onChange={e=>setEditTpm(p=>({...p,code:e.target.value}))} /></Field>
          <Field label="Bureau de rattachement" hint="Sans bureau : prestataire national, validé par n'importe quel bureau">
            <Select value={editTpm.office_id||""} onChange={e=>setEditTpm(p=>({...p,office_id:e.target.value}))}
              empty="Aucun — prestataire national"
              options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
          <Field label="Contact"><Input value={editTpm.contact||""}
            onChange={e=>setEditTpm(p=>({...p,contact:e.target.value}))} /></Field>
          <Field label="Adresse électronique"><Input value={editTpm.email||""}
            onChange={e=>setEditTpm(p=>({...p,email:e.target.value}))} /></Field>
          <Field label="Téléphone"><Input value={editTpm.phone||""}
            onChange={e=>setEditTpm(p=>({...p,phone:e.target.value}))} /></Field>
        </div>)}
      </Modal>

      {/* Contrat */}
      <Modal open={!!editCtr} onClose={()=>setEditCtr(null)}
        title={editCtr?.id ? "Modifier le contrat" : "Nouveau contrat"}
        subtitle="Référence, plafond, devise et période"
        footer={<><Btn kind="sec" onClick={()=>setEditCtr(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !(editCtr?.ref||"").trim()}
            onClick={()=>faire(() => {
              const b = { tpm_id:editCtr.tpm_id, ref:editCtr.ref,
                ceiling:n(editCtr.ceiling), currency:(editCtr.currency||"MGA").toUpperCase(),
                start_date:editCtr.start_date||null, end_date:editCtr.end_date||null,
                status:editCtr.status||"actif", note:editCtr.note||null };
              if(editCtr.id) b.rev = editCtr.rev;
              return editCtr.id ? api.updateContract(editCtr.id, b) : api.createContract(b);
            }, "Contrat enregistré")}>Enregistrer</Btn></>}>
        {editCtr && (<>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Référence"><Input value={editCtr.ref||""}
              onChange={e=>setEditCtr(p=>({...p,ref:e.target.value}))} placeholder="TPM-2026-01" /></Field>
            <Field label="Devise" hint="Code à trois lettres"><Input maxLength={3}
              value={editCtr.currency||"MGA"}
              onChange={e=>setEditCtr(p=>({...p,currency:e.target.value.toUpperCase()}))} /></Field>
            <Field label="Plafond contractuel"
              hint={editCtr.id ? "Non modifiable ici : passez par un avenant" : "Montant total du contrat"}>
              <Input type="number" value={editCtr.ceiling ?? ""} readOnly={!!editCtr.id}
                onChange={e=>setEditCtr(p=>({...p,ceiling:e.target.value}))} /></Field>
            <Field label="Statut">
              <Select value={editCtr.status||"actif"} onChange={e=>setEditCtr(p=>({...p,status:e.target.value}))}
                options={[["projet","Projet"],["actif","Actif"],["suspendu","Suspendu"],["clos","Clos"]]} /></Field>
            <Field label="Début"><Input type="date" value={editCtr.start_date||""}
              onChange={e=>setEditCtr(p=>({...p,start_date:e.target.value}))} /></Field>
            <Field label="Fin"><Input type="date" value={editCtr.end_date||""}
              onChange={e=>setEditCtr(p=>({...p,end_date:e.target.value}))} /></Field>
          </div>
          <Field label="Objet du contrat"><Input value={editCtr.note||""}
            onChange={e=>setEditCtr(p=>({...p,note:e.target.value}))} /></Field>
        </>)}
      </Modal>

      {/* Barème */}
      <Modal open={!!rates} wide onClose={()=>setRates(null)}
        title={rates ? `Barème du contrat ${rates.contrat.ref}` : ""}
        subtitle="Ce qui transforme une affectation en budget. Les brouillons en cours seront recalculés."
        footer={<><Btn kind="sec" onClick={()=>setRates(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy}
            onClick={()=>faire(() => api.saveRates(rates.contrat.id,
              rates.lignes.filter(l=>(l.label||"").trim()).map(l=>({ driver:l.driver||"forfait",
                label:l.label, unit:l.unit||null, unit_cost:n(l.unit_cost),
                active:l.active!==false, sort:n(l.sort) }))),
              "Barème enregistré")}>Enregistrer le barème</Btn></>}>
        {rates && (<>
          <TableWrap max="mh300">
            <thead><tr><Th>Rôle dans le calcul</Th><Th>Libellé</Th><Th>Unité</Th>
              <Th num>Coût unitaire</Th><Th /></tr></thead>
            <tbody>{rates.lignes.map((l,i)=>(
              <tr key={i}>
                <Td><Select value={l.driver||"forfait"} options={DRIVERS}
                  onChange={e=>setRates(p=>({...p,lignes:p.lignes.map((x,j)=>j===i?{...x,driver:e.target.value}:x)}))}
                  className="mi-py1 mi-xs mi-wauto" /></Td>
                <Td><input value={l.label||""} className={clsx(inputCls,"mi-py1 mnw180")}
                  onChange={e=>setRates(p=>({...p,lignes:p.lignes.map((x,j)=>j===i?{...x,label:e.target.value}:x)}))} /></Td>
                <Td><input value={l.unit||""} className={clsx(inputCls,"mi-py1 w-28")}
                  onChange={e=>setRates(p=>({...p,lignes:p.lignes.map((x,j)=>j===i?{...x,unit:e.target.value}:x)}))} /></Td>
                <Td num><input type="number" value={l.unit_cost ?? ""} className={clsx(inputCls,"mi-py1 w-28 text-right")}
                  onChange={e=>setRates(p=>({...p,lignes:p.lignes.map((x,j)=>j===i?{...x,unit_cost:e.target.value}:x)}))} /></Td>
                <Td className="text-right"><button className="px-1 text-slate-400 hover:text-rose-600"
                  onClick={()=>setRates(p=>({...p,lignes:p.lignes.filter((_,j)=>j!==i)}))}><X size={14}/></button></Td>
              </tr>))}</tbody>
          </TableWrap>
          <Btn size="sm" kind="sec" icon={Plus} className="mt-2"
            onClick={()=>setRates(p=>({...p,lignes:[...p.lignes,{ driver:"forfait", unit_cost:0 }]}))}>
            Ajouter une ligne</Btn>
          <Note tone="warn">Les plans déjà validés ne sont pas recalculés : leurs lignes portent le
            coût unitaire du jour où ils ont été montés. C'est ce qui a été approuvé.</Note>
        </>)}
      </Modal>

      {/* Avenant */}
      <Modal open={!!aven} onClose={()=>setAven(null)}
        title={aven ? `Avenant au contrat ${aven.contrat.ref}` : ""}
        subtitle="Un avenant modifie le plafond ; il est daté, motivé, et ne remplace pas l'historique"
        footer={<><Btn kind="sec" onClick={()=>setAven(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !n(aven?.delta) || !(aven?.reason||"").trim()}
            onClick={()=>faire(() => api.addAmendment(aven.contrat.id, { ref:aven.ref||null,
              delta:n(aven.delta), reason:aven.reason, signed_at:aven.signed_at||null }),
              "Avenant enregistré")}>Enregistrer l'avenant</Btn></>}>
        {aven && (<>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Référence"><Input value={aven.ref||""}
              onChange={e=>setAven(p=>({...p,ref:e.target.value}))} placeholder="AV-01" /></Field>
            <Field label="Date de signature"><Input type="date" value={aven.signed_at||""}
              onChange={e=>setAven(p=>({...p,signed_at:e.target.value}))} /></Field>
            <Field label={`Montant (${aven.contrat.currency})`}
              hint="Négatif pour réduire le plafond — jamais sous ce qui est déjà engagé">
              <Input type="number" value={aven.delta ?? ""}
                onChange={e=>setAven(p=>({...p,delta:e.target.value}))} /></Field>
            <Field label="Nouveau plafond" hint="Calculé">
              <Input readOnly value={fmt(Math.round(aven.contrat.solde.plafond + n(aven.delta)))} /></Field>
          </div>
          <Field label="Motif" hint="Ce que l'avenant couvre — c'est ce qu'on relira dans un an">
            <Input value={aven.reason||""} onChange={e=>setAven(p=>({...p,reason:e.target.value}))} /></Field>
        </>)}
      </Modal>
    </>);
}

/* ── Suivi budgétaire consolidé ──────────────────────────────────────*/
function Budget({ tpms, plans }){
  const contrats = tpms.flatMap(t => t.contrats.map(c => ({ ...c, tpm:t.name })));
  const exporter = () => {
    const rows = plans.flatMap(p => p.zones.flatMap(z => z.lines.map(l => ({
      prestataire:p.tpm, mois:MONTHS_L[p.month], annee:p.year, reference:p.ref, etat:p.status,
      zone:z.zone, activite:z.activity_tag, equipe:z.team_label,
      superviseurs:z.supervisors, agents:z.agents, jours:z.days, vehicules:z.vehicles,
      ligne:l.label, unite:l.unit, qte1:l.qty1, qte2:l.qty2, cout_unitaire:l.unit_cost,
      budget:l.total, depense:l.spent ?? "", devise:p.currency,
    }))));
    download(`suivi-tiers-${new Date().getFullYear()}.csv`, toCSV(rows,
      ["prestataire","annee","mois","reference","etat","zone","activite","equipe","superviseurs",
       "agents","jours","vehicules","ligne","unite","qte1","qte2","cout_unitaire","budget","depense","devise"]),
      "text/csv");
  };
  return (
    <>
      <Note>Le tableau rapproche trois choses par contrat : ce que le contrat autorise,
        ce qui est <b>engagé</b> par les plans validés, et ce qui est <b>dépensé</b>.
        Un plan qui circule encore n'engage rien — il apparaît en « en cours ».</Note>
      <Card flush title="Situation par contrat" subtitle={`${contrats.length} contrat(s)`}
        right={<Btn size="sm" kind="sec" icon={Download} onClick={exporter}>Exporter le détail</Btn>}>
        {!contrats.length ? <Empty title="Aucun contrat" /> : (
          <TableWrap>
            <thead><tr><Th>Prestataire</Th><Th>Contrat</Th><Th num>Plafond</Th><Th num>Avenants</Th>
              <Th num>Engagé</Th><Th num>En cours</Th><Th num>Dépensé</Th><Th num>Disponible</Th>
              <Th>Consommation</Th><Th>Devise</Th></tr></thead>
            <tbody>{contrats.map(c=>(
              <tr key={c.id} className="hover:bg-sky-50">
                <Td className="font-medium text-slate-800">{c.tpm}</Td>
                <Td className="f115">{c.ref} <Badge tone={c.status==="actif"?"g":"n"}>{c.status}</Badge></Td>
                <Td num>{fmt(Math.round(c.solde.ceiling))}</Td>
                <Td num className={c.solde.avenants ? "font-semibold" : "text-slate-400"}>
                  {c.solde.avenants ? (c.solde.avenants>0?"+":"")+fmt(Math.round(c.solde.avenants)) : "—"}</Td>
                <Td num className="font-semibold">{fmt(Math.round(c.solde.engage))}</Td>
                <Td num className="text-amber-700">{c.solde.enCours ? fmt(Math.round(c.solde.enCours)) : "—"}</Td>
                <Td num>{c.solde.depense ? fmt(Math.round(c.solde.depense)) : "—"}</Td>
                <Td num className={c.solde.disponible <= 0 ? "text-rose-700 font-semibold" : ""}>
                  {fmt(Math.round(c.solde.disponible))}</Td>
                <Td><div className="flex items-center gap-2">
                  <Bar2 value={c.solde.consommation || 0}
                    tone={c.solde.consommation > 95 ? "bad" : c.solde.consommation > 80 ? "warn" : "ok"} />
                  <span className="tabular-nums f115 w-12 text-right">{c.solde.consommation ?? 0} %</span>
                </div></Td>
                <Td className="text-slate-500 f115">{c.currency}</Td>
              </tr>))}</tbody>
          </TableWrap>)}
      </Card>
    </>);
}

/* ── Le plan : affectation, budget, circuit, dépenses ────────────────*/
function PlanModal({ open, plan, tpms, db, me, can, busy, setBusy, notify, onClose, onSaved, onCreated }){
  const [zones, setZones] = useState([]);
  const [sugg, setSugg]   = useState(null);
  const [neuf, setNeuf]   = useState({});
  const [avis, setAvis]   = useState("");
  const [dep, setDep]     = useState(null);

  useEffect(()=>{
    if(!plan) return;
    setZones((plan.zones || []).map(z => ({ ...z })));
    setAvis(""); setSugg(null); setDep(null);
    if(plan._nouveau) setNeuf({ year:plan.year, month:plan.month,
      tpm_id: me?.tpm_id || tpms[0]?.id || "", contract_id:"" });
  }, [plan]);
  if(!open || !plan) return null;

  const a = plan.actions || {};
  const cur = plan.currency;
  const modifiable = a.modifier;

  /* ── Création ── */
  if(plan._nouveau){
    const tpm = tpms.find(x => x.id === neuf.tpm_id);
    const contrats = (tpm?.contrats || []).filter(c => c.status === "actif");
    return (
      <Modal open onClose={onClose} title="Nouveau plan mensuel"
        subtitle="Un plan couvre un prestataire et un mois. Le contrat fixe le barème et le plafond."
        footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !neuf.tpm_id || !neuf.contract_id}
            onClick={async ()=>{ setBusy(true);
              try{ const r = await api.createTpmPlan({ tpm_id:neuf.tpm_id,
                    contract_id:neuf.contract_id, year:n(neuf.year), month:n(neuf.month),
                    ref:neuf.ref || null, note:neuf.note || null });
                notify("Plan créé — affectez les zones", "ok");
                await onCreated(); onSaved(r.id);
              }catch(e){ notify(e.message, "err"); }
              setBusy(false); }}>Créer le plan</Btn></>}>
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Prestataire">
            <Select value={neuf.tpm_id||""} disabled={!!me?.tpm_id}
              onChange={e=>setNeuf(p=>({...p,tpm_id:e.target.value,contract_id:""}))}
              empty="Choisir" options={tpms.map(x=>[x.id,x.name])} /></Field>
          <Field label="Contrat" hint={!contrats.length ? "Aucun contrat actif pour ce prestataire" : "Barème et plafond"}>
            <Select value={neuf.contract_id||""} onChange={e=>setNeuf(p=>({...p,contract_id:e.target.value}))}
              empty="Choisir" options={contrats.map(c=>[c.id,
                `${c.ref} — disponible ${fmt(Math.round(c.solde.disponible))} ${c.currency}`])} /></Field>
          <Field label="Année"><Input type="number" value={neuf.year ?? ""}
            onChange={e=>setNeuf(p=>({...p,year:e.target.value}))} /></Field>
          <Field label="Mois">
            <Select value={neuf.month ?? ""} onChange={e=>setNeuf(p=>({...p,month:e.target.value}))}
              options={MONTHS_L.map((m,i)=>[i,m])} /></Field>
          <Field label="Référence"><Input value={neuf.ref||""}
            onChange={e=>setNeuf(p=>({...p,ref:e.target.value}))} /></Field>
        </div>
        <Field label="Objet du plan"><Input value={neuf.note||""}
          onChange={e=>setNeuf(p=>({...p,note:e.target.value}))} /></Field>
      </Modal>);
  }

  /* Le budget d'une zone, recalculé à l'écran pendant la saisie. La règle est la
     même que celle du serveur ; c'est le serveur qui fait foi à l'enregistrement,
     l'écran n'affiche qu'une prévision immédiate — sans elle, l'utilisateur
     modifierait des jours à l'aveugle. */
  const tarif = (driver) => {
    const c = tpms.find(x=>x.id===plan.tpm_id)?.contrats.find(x=>x.id===plan.contract_id);
    return (c?.rates || []).filter(r => r.driver === driver && r.active)
      .reduce((t, r) => t + r.unit_cost, 0);
  };
  const apercu = (z) => {
    const j = n(z.days) + n(z.travel_days);
    return n(z.supervisors)*j*tarif("superviseur") + n(z.agents)*j*tarif("agent")
      + n(z.vehicles)*j*tarif("vehicule") + n(z.fuel_litres)*tarif("carburant");
  };
  const apercuTotal = zones.reduce((t,z)=>t+apercu(z), 0)
    + plan.communes.reduce((t,l)=>t+l.total, 0);

  const enregistrer = async () => {
    setBusy(true);
    try{
      const r = await api.saveTpmZones(plan.id, plan.rev, zones.map(z => ({
        geo_pcode:z.geo_pcode, activity_tag:z.activity_tag||null, team_label:z.team_label||null,
        supervisors:n(z.supervisors), agents:n(z.agents), days:n(z.days),
        travel_days:n(z.travel_days), vehicles:n(z.vehicles), fuel_litres:n(z.fuel_litres),
        sites:n(z.sites), note:z.note||null })));
      notify(`Affectation enregistrée — ${fmt(Math.round(r.plan.budget))} ${cur}`, "ok");
      await onSaved(plan.id);
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const soumettre = async () => {
    setBusy(true);
    try{ const r = await api.submitTpmPlan(plan.id);
      notify(r.avertissement || "Plan soumis à validation", r.avertissement ? "warn" : "ok");
      await onSaved(plan.id);
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const decider = async (decision) => {
    if(decision === "renvoye" && !avis.trim()){
      notify("Un renvoi doit être motivé", "warn"); return; }
    setBusy(true);
    try{ const r = await api.reviewTpmPlan(plan.id, decision, avis.trim() || undefined);
      notify(decision === "valide"
        ? `Validé — ${(ETAT[r.plan.status]||[])[0]}` : "Plan renvoyé au prestataire", "ok");
      setAvis(""); await onSaved(plan.id);
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const chargerSugg = async () => {
    try{
      const q = new URLSearchParams({ year:String(plan.year), month:String(plan.month) });
      const r = await api.tpmSuggest("?" + q);
      setSugg(r.rows || []);
    }catch(e){ notify(e.message, "err"); }
  };

  const majZone = (i,k,v) => setZones(p => p.map((z,j)=> j===i ? { ...z, [k]:v } : z));

  return (
    <Modal open wide onClose={onClose}
      title={`${plan.tpm} — ${MONTHS_L[plan.month]} ${plan.year}`}
      subtitle={`${plan.contract} · ${(ETAT[plan.status]||[plan.status])[0]}${plan.ref ? ` · ${plan.ref}` : ""}`}
      footer={<>
        <div className="mr-auto f125 text-slate-600">
          Budget <b className="tabular-nums text-slate-800">
            {fmt(Math.round(modifiable ? apercuTotal : plan.budget))} {cur}</b>
          {modifiable && Math.round(apercuTotal) !== Math.round(plan.budget) &&
            <span className="text-amber-700"> · non enregistré</span>}
          {plan.spent != null && <> · dépensé <b className="tabular-nums">{fmt(Math.round(plan.spent))}</b></>}
        </div>
        <Btn kind="sec" onClick={onClose}>Fermer</Btn>
        {modifiable && <Btn icon={Save} disabled={busy} onClick={enregistrer}>Enregistrer</Btn>}
        {a.soumettre && <Btn icon={Send} disabled={busy} onClick={soumettre}>Soumettre</Btn>}
      </>}>

      {/* Le circuit, et ce qu'il attend */}
      <div className="flex items-center gap-3 flex-wrap p-3 rounded-xl bg-slate-50 border border-slate-200 mb-4">
        <Circuit status={plan.status} />
        <span className="f115 text-slate-600">
          {a.niveau ? <>En attente : <b>{a.niveauLabel}</b></>
            : plan.status === "valide_pays" ? "Validé — le budget est engagé sur le contrat"
            : plan.status === "cloture" ? "Clôturé"
            : plan.status === "renvoye" ? "Renvoyé au prestataire pour correction"
            : "Brouillon"}</span>
        {plan.solde && <span className="ml-auto f115 text-slate-500">
          Disponible sur le contrat <b className="tabular-nums text-slate-700">
            {fmt(Math.round(plan.solde.disponible))} {cur}</b></span>}
      </div>

      {plan.status === "renvoye" && (() => {
        const dernier = [...(plan.reviews||[])].reverse().find(r => r.decision === "renvoye");
        return dernier && <Note tone="err"><b>Renvoyé par {dernier.by}</b> — {dernier.comment}</Note>;
      })()}

      {/* ── Affectation ── */}
      <div className="flex items-baseline gap-3 mb-2">
        <div className="f13 font-semibold text-slate-800">Zones affectées</div>
        <div className="f115 text-slate-500">
          le budget découle de ces quantités et du barème contractuel</div>
        {modifiable && <span className="ml-auto flex gap-2">
          <Btn size="sm" kind="sec" icon={Target} onClick={chargerSugg}>Zones à couvrir</Btn>
          <Btn size="sm" kind="sec" icon={Plus}
            onClick={()=>setZones(p=>[...p,{ geo_pcode:"", supervisors:1, agents:1, days:2,
              travel_days:0, vehicles:1, fuel_litres:0, sites:0 }])}>Ajouter une zone</Btn>
        </span>}
      </div>

      {sugg && (
        <div className="mb-3 p-3 rounded-xl border border-sky-200 bg-sky-50">
          <div className="f115 text-sky-900 mb-2">
            <b>Proposé par la planification fondée sur le risque.</b> L'écart est ce qui était
            prévu ce mois-ci et n'est pas fait ; le risque agrège les drapeaux des sites.
            Cliquez pour affecter.</div>
          <TableWrap max="mh240">
            <thead><tr><Th>Commune</Th><Th>District</Th><Th num>Sites actifs</Th>
              <Th num>Prévus</Th><Th num>Visités</Th><Th num>Écart</Th><Th num>Risque</Th><Th /></tr></thead>
            <tbody>{sugg.map(s=>{
              const deja = zones.some(z => z.geo_pcode === s.geo_pcode);
              return (
                <tr key={s.geo_pcode} className={clsx("hover:bg-white", deja && "opacity-50")}>
                  <Td className="font-medium text-slate-800">{s.zone}</Td>
                  <Td className="text-slate-600 f115">{s.district}</Td>
                  <Td num>{s.actifs}</Td><Td num>{s.planifies}</Td><Td num>{s.visites}</Td>
                  <Td num className={s.ecart ? "text-amber-700 font-semibold" : ""}>{s.ecart}</Td>
                  <Td num>{s.risque}</Td>
                  <Td className="text-right">
                    <Btn size="sm" kind="sec" disabled={deja}
                      onClick={()=>setZones(p=>[...p,{ geo_pcode:s.geo_pcode, zone:`${s.zone} (${s.district})`,
                        activity_tag:s.tags[0]||"", team_label:`TEAM${p.length+1}`,
                        supervisors:1, agents:1, days:Math.min(10, Math.max(2, s.ecart || 2)),
                        travel_days:1, vehicles:1, fuel_litres:15*Math.min(10, Math.max(2, s.ecart||2)),
                        sites:s.actifs }])}>
                      {deja ? "Affectée" : "Affecter"}</Btn></Td>
                </tr>); })}</tbody>
          </TableWrap>
        </div>)}

      <TableWrap max="mh340">
        <thead><tr><Th>Zone</Th><Th>Activité</Th><Th>Équipe</Th><Th num>Sup.</Th><Th num>Agents</Th>
          <Th num>Jours</Th><Th num>Trajet</Th><Th num>Véhic.</Th><Th num>Litres</Th>
          <Th num>Sites</Th><Th num>Sous-total</Th><Th /></tr></thead>
        <tbody>{zones.map((z,i)=>{
          const enregistree = plan.zones.find(x => x.id === z.id);
          return (
            <tr key={z.id || i}>
              <Td className="mnw180">{z.zone || z.geo_pcode || <span className="text-rose-600">à choisir</span>}</Td>
              <Td>{modifiable
                ? <input value={z.activity_tag||""} className={clsx(inputCls,"mi-py1 w-20")}
                    onChange={e=>majZone(i,"activity_tag",e.target.value)} />
                : z.activity_tag || "—"}</Td>
              <Td>{modifiable
                ? <input value={z.team_label||""} className={clsx(inputCls,"mi-py1 w-24")}
                    onChange={e=>majZone(i,"team_label",e.target.value)} />
                : z.team_label || "—"}</Td>
              {[["supervisors","w-16"],["agents","w-16"],["days","w-16"],["travel_days","w-16"],
                ["vehicles","w-16"],["fuel_litres","w-20"],["sites","w-16"]].map(([k,w])=>(
                <Td key={k} num>{modifiable
                  ? <input type="number" value={z[k] ?? ""} className={clsx(inputCls,"mi-py1 text-right",w)}
                      onChange={e=>majZone(i,k,e.target.value)} />
                  : fmt(z[k])}</Td>))}
              <Td num className="font-semibold">
                {fmt(Math.round(modifiable ? apercu(z) : (enregistree?.subtotal ?? 0)))}</Td>
              <Td className="text-right">{modifiable &&
                <button className="px-1 text-slate-400 hover:text-rose-600"
                  onClick={()=>setZones(p=>p.filter((_,j)=>j!==i))}><X size={14}/></button>}</Td>
            </tr>); })}
          {!zones.length && <tr><Td colSpan={12} className="text-center text-slate-400 py-4">
            Aucune zone affectée. Le bouton « Zones à couvrir » propose celles où le suivi
            prévu du mois n'est pas fait.</Td></tr>}
        </tbody>
      </TableWrap>

      {/* ── Le détail des lignes, quand le plan est figé ── */}
      {!modifiable && !!plan.zones.length && (
        <div className="mt-4">
          <div className="f13 font-semibold text-slate-800 mb-2">Détail du budget</div>
          <TableWrap max="mh300">
            {/* Les intitulés du classeur de référence, à dessein : « Qtté 1 (jr) »,
                « Qtté 2 (nb) », coût unitaire, total. */}
            <thead><tr><Th>Équipe / zone</Th><Th>Ligne</Th><Th>Unité</Th><Th num>Qté 1 (jr)</Th>
              <Th num>Qté 2 (nb)</Th><Th num>Coût unitaire</Th><Th num>Total</Th><Th num>Dépensé</Th></tr></thead>
            <tbody>
              {plan.zones.flatMap(z => [
                ...z.lines.map(l => (
                  <tr key={l.id} className="hover:bg-sky-50">
                    <Td className="text-slate-500 f115">{z.team_label || z.zone}</Td>
                    <Td>{l.label}{!l.derived && <Badge tone="y">ajustée</Badge>}</Td>
                    <Td className="text-slate-500 f115">{l.unit}</Td>
                    <Td num>{fmt(l.qty1)}</Td><Td num>{fmt(l.qty2)}</Td>
                    <Td num>{fmt(l.unit_cost)}</Td>
                    <Td num className="font-semibold">{fmt(Math.round(l.total))}</Td>
                    <Td num className={l.spent != null && l.spent > l.total ? "text-rose-700" : ""}>
                      {l.spent == null ? "—" : fmt(Math.round(l.spent))}</Td>
                  </tr>)),
                <tr key={z.id+"st"} className="bg-slate-50">
                  <Td colSpan={6} className="text-right f115 text-slate-600">
                    Sous-total {z.team_label || z.zone}</Td>
                  <Td num className="font-bold">{fmt(Math.round(z.subtotal))}</Td><Td /></tr>,
              ])}
              {plan.communes.map(l => (
                <tr key={l.id} className="hover:bg-sky-50">
                  <Td className="text-slate-400 f115">frais commun</Td>
                  <Td>{l.label}</Td><Td className="text-slate-500 f115">{l.unit}</Td>
                  <Td num>{fmt(l.qty1)}</Td><Td num>{fmt(l.qty2)}</Td><Td num>{fmt(l.unit_cost)}</Td>
                  <Td num className="font-semibold">{fmt(Math.round(l.total))}</Td>
                  <Td num>{l.spent == null ? "—" : fmt(Math.round(l.spent))}</Td>
                </tr>))}
              <tr className="bg-slate-100 font-bold">
                <Td colSpan={6} className="text-right">Total général</Td>
                <Td num>{fmt(Math.round(plan.budget))}</Td>
                <Td num>{plan.spent == null ? "—" : fmt(Math.round(plan.spent))}</Td></tr>
            </tbody>
          </TableWrap>
        </div>)}

      {/* ── Validation ── */}
      {a.valider && (
        <div className="mt-4 p-4 rounded-xl border-2 bd-brand bg-sky-50">
          <div className="f13 font-semibold text-slate-800 mb-1">
            Votre validation — {a.niveauLabel}</div>
          <p className="f115 text-slate-600 mb-2">
            Vous validez <b>{fmt(Math.round(plan.budget))} {cur}</b> pour {plan.zones.length} zone(s).
            Le montant est consigné avec votre décision : un plan modifié ensuite ne pourra pas
            laisser croire que ce montant-là avait été approuvé.
            {a.niveau === "pays" && plan.solde &&
              ` Disponible sur le contrat : ${fmt(Math.round(plan.solde.disponible))} ${cur}.`}
          </p>
          <Field label="Commentaire" hint="Obligatoire pour un renvoi — c'est ce qui permettra de corriger">
            <Input value={avis} onChange={e=>setAvis(e.target.value)}
              placeholder="Motif du renvoi, ou observation" /></Field>
          <div className="flex gap-2">
            <Btn icon={Check} disabled={busy} onClick={()=>decider("valide")}>Valider</Btn>
            <Btn kind="danger" icon={X} disabled={busy} onClick={()=>decider("renvoye")}>
              Renvoyer au prestataire</Btn>
          </div>
        </div>)}

      {/* ── Journal des décisions ── */}
      {!!plan.reviews.length && (
        <div className="mt-4">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
            Journal de validation</div>
          <table className="w-full f115">
            <tbody>{plan.reviews.map((rv,i)=>(
              <tr key={i} className="border-b border-slate-100 last:border-0">
                <td className="py-1.5 text-slate-500 whitespace-nowrap">{rv.at}</td>
                <td className="py-1.5">{{ tpm:"Prestataire", bureau:"Bureau",
                  pays:"Bureau pays" }[rv.level]}</td>
                <td className="py-1.5">{rv.decision === "valide"
                  ? <Badge tone="g">validé</Badge> : <Badge tone="r">renvoyé</Badge>}</td>
                <td className="py-1.5 tabular-nums text-right">{fmt(Math.round(rv.amount||0))}</td>
                <td className="py-1.5 pl-3 text-slate-600">{rv.by}</td>
                <td className="py-1.5 pl-3 text-slate-500 whitespace-normal">{rv.comment}</td>
              </tr>))}</tbody>
          </table>
        </div>)}

      {/* ── Dépenses ── */}
      {a.depenser && (
        <div className="mt-4 pt-3 border-t border-slate-200">
          <div className="flex items-baseline gap-3 mb-2">
            <div className="f13 font-semibold text-slate-800">Dépenses constatées</div>
            <div className="f115 text-slate-500">rattachées à leur ligne de budget</div>
            <Btn size="sm" kind="sec" icon={Plus} className="ml-auto"
              onClick={()=>setDep({ spent_on:new Date().toISOString().slice(0,10) })}>
              Constater une dépense</Btn>
          </div>
          {!plan.expenses.length
            ? <div className="f115 text-slate-400">Aucune dépense constatée.</div>
            : <table className="w-full f115">
                <tbody>{plan.expenses.map(e=>{
                  const l = [...plan.zones.flatMap(z=>z.lines), ...plan.communes]
                    .find(x=>x.id===e.line_id);
                  return (
                    <tr key={e.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 text-slate-500">{e.spent_on || "—"}</td>
                      <td className="py-1.5">{l?.label || <span className="text-slate-400">non rattachée</span>}</td>
                      <td className="py-1.5 text-slate-500">{e.ref}</td>
                      <td className="py-1.5 text-right tabular-nums font-semibold">{fmt(Math.round(e.amount))}</td>
                      <td className="py-1.5 text-right">{can("del") &&
                        <button className="text-slate-400 hover:text-rose-600"
                          onClick={async ()=>{ try{ await api.deleteTpmExpense(e.id);
                            await onSaved(plan.id); notify("Dépense annulée","ok");
                          }catch(err){ notify(err.message,"err"); } }}><Trash2 size={13}/></button>}</td>
                    </tr>); })}
                  <tr className="font-bold"><td colSpan={3} className="py-1.5">Total dépensé</td>
                    <td className="py-1.5 text-right tabular-nums">{fmt(Math.round(plan.spent||0))}</td>
                    <td /></tr>
                </tbody>
              </table>}
          {plan.execution != null && (
            <div className="flex items-center gap-3 mt-2 f115">
              <span className="text-slate-600">Exécution du plan</span>
              <div className="flex-1 max-w-xs"><Bar2 value={plan.execution}
                tone={plan.execution > 110 ? "bad" : plan.execution > 95 ? "warn" : "ok"} /></div>
              <b className="tabular-nums">{plan.execution} %</b>
            </div>)}
          {plan.status === "valide_pays" && can("validate") && (
            <Btn size="sm" kind="sec" className="mt-3" disabled={busy}
              onClick={async ()=>{ setBusy(true);
                try{ await api.closeTpmPlan(plan.id); await onSaved(plan.id);
                  notify("Plan clôturé","ok"); }catch(e){ notify(e.message,"err"); }
                setBusy(false); }}>Clôturer le plan</Btn>)}
        </div>)}

      {/* Saisie d'une dépense */}
      <Modal open={!!dep} onClose={()=>setDep(null)} title="Constater une dépense"
        subtitle="Rattachez-la à sa ligne : sans cela on saurait combien, pas sur quoi"
        footer={<><Btn kind="sec" onClick={()=>setDep(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !n(dep?.amount)}
            onClick={async ()=>{ setBusy(true);
              try{ const r = await api.addTpmExpense(plan.id, { line_id:dep.line_id||null,
                    spent_on:dep.spent_on||null, amount:n(dep.amount), ref:dep.ref||null,
                    note:dep.note||null });
                notify(r.avertissement || "Dépense enregistrée", r.avertissement ? "warn" : "ok");
                setDep(null); await onSaved(plan.id);
              }catch(e){ notify(e.message,"err"); }
              setBusy(false); }}>Enregistrer</Btn></>}>
        {dep && (<>
          <Field label="Ligne de budget" hint="Facultatif, mais c'est ce qui rend l'écart lisible">
            <Select value={dep.line_id||""} onChange={e=>setDep(p=>({...p,line_id:e.target.value}))}
              empty="Non rattachée"
              options={[...plan.zones.flatMap(z=>z.lines.map(l=>[l.id,
                `${z.team_label||z.zone} — ${l.label} (${fmt(Math.round(l.total))})`])),
                ...plan.communes.map(l=>[l.id, `${l.label} (${fmt(Math.round(l.total))})`])]} /></Field>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label={`Montant (${cur})`}><Input type="number" value={dep.amount ?? ""}
              onChange={e=>setDep(p=>({...p,amount:e.target.value}))} /></Field>
            <Field label="Date"><Input type="date" value={dep.spent_on||""}
              onChange={e=>setDep(p=>({...p,spent_on:e.target.value}))} /></Field>
            <Field label="Référence de la pièce"><Input value={dep.ref||""}
              onChange={e=>setDep(p=>({...p,ref:e.target.value}))} placeholder="FAC-2026-07-12" /></Field>
            <Field label="Note"><Input value={dep.note||""}
              onChange={e=>setDep(p=>({...p,note:e.target.value}))} /></Field>
          </div>
        </>)}
      </Modal>
    </Modal>);
}
