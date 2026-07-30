import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { Activity, Check, ClipboardList, Download, Globe, Link2, ListChecks, Pencil, Plus, Save, Target, Trash2, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Field, Input, Modal, Note, Select, Stat, StatRow, TableWrap, Tabs, Td, Th } from "../components/ui.jsx";
import { POP_BASE_YEAR, clsx, computeMMR, fmt, n, pct, populationFor, uid } from "../lib/calc.js";
import { C, D_ADJUST, MONTHS, MONTHS_L, SERIES } from "../lib/constants.js";
import { DistributionActual, rate } from "./Planning.jsx";
import { SitesModule } from "./Settings.jsx";
import { PageHead } from "./Shell.jsx";
import { useGeoCascade, names } from "../lib/geo.js";

/* ══════════════════ Actual Data ══════════════════ */
function ActualData({ db, set, sub, setSub, me, notify, can, go }){
  const items = [["summary","Résumé global"],["process","Suivi de processus"],["sites","Sites"],["map","Cartographie"],["distrib","Distributions"],["output","Outputs et population"],["outcome","Outcomes"],
    ["import","Import Excel"],["sources","Sources de données"]];
  return (
    <div className="space-y-4">
      <PageHead title="Actual Data" text="Données réellement collectées : soumissions ODK Central, couverture des sites, produits livrés et indicateurs de résultat." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="summary" && <ActualSummary db={db} />}
      {sub==="process" && <ProcessData db={db} set={set} notify={notify} can={can} go={go} />}
      {sub==="sites" && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="actual" />}
      {sub==="distrib" && <DistributionActual db={db} set={set} notify={notify} can={can} />}
      {sub==="output" && <OutputData db={db} set={set} notify={notify} can={can} />}
      {sub==="outcome" && <OutcomeData db={db} set={set} notify={notify} can={can} go={go} />}
      {sub==="import" && <ImportView db={db} notify={notify} can={can} />}
      {sub==="sources" && <Sources db={db} set={set} notify={notify} can={can} />}
    </div>);
}

function ActualSummary({ db }){
  const benef = db.sites.filter(s=>s.status!=="Inactive").reduce((t,s)=>t+n(s.beneficiaries),0);
  const mmr = computeMMR(db, db.year);
  const outPlan = db.outputs.reduce((t,o)=>t+n(o.planned),0);
  const outReal = db.outputs.reduce((t,o)=>t+n(o.actual),0);
  const byMonth = MONTHS.map((m,i)=>({ mois:m,
    Planifié: db.outputs.filter(o=>o.month===i).reduce((t,o)=>t+o.planned,0),
    Atteint:  db.outputs.filter(o=>o.month===i).reduce((t,o)=>t+o.actual,0) }));
  const pop = db.population.reduce((t,p)=>{ const v=populationFor(db,p.key,db.year); return t+(v?v.value:0); },0);
  return (
    <>
      <StatRow>
        <Stat label="Bénéficiaires ciblés" value={fmt(benef)} sub="Sites actifs du registre" icon={Users} />
        <Stat label="Bénéficiaires atteints" value={fmt(outReal)} sub={`${pct(outReal,outPlan)}% du planifié`}
          tone={pct(outReal,outPlan)>=80?"ok":"warn"} icon={Target} />
        <Stat label="Population des zones" value={fmt(pop)} sub={`Estimation ${db.year}`} icon={Globe} />
        <Stat label="Soumissions de suivi" value={fmt(db.visits.length)}
          sub={`${db.visits.filter(v=>v.status==="À valider").length} à valider`} icon={ClipboardList} />
        <Stat label="Exigence minimale" value={mmr.pct+"%"} tone={mmr.pct>=80?"ok":mmr.pct>=50?"warn":"bad"}
          sub={`${mmr.done} / ${mmr.required} visites`} icon={Activity} />
      </StatRow>
      <div className="grid gap-4" style={{gridTemplateColumns:"1.4fr 1fr"}}>
        <Card title="Bénéficiaires planifiés et atteints" subtitle="Toutes activités confondues">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={byMonth} margin={{top:6,right:6,left:-8,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
              <XAxis dataKey="mois" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
              <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{fontSize:12,borderRadius:3,border:"1px solid "+C.line}} formatter={v=>fmt(v)} />
              <Legend wrapperStyle={{fontSize:11}} />
              <Bar dataKey="Planifié" fill={C.brandL} radius={[2,2,0,0]} barSize={16} />
              <Bar dataKey="Atteint" fill={C.ok} radius={[2,2,0,0]} barSize={16} />
            </ComposedChart></ResponsiveContainer>
        </Card>
        <Card title="Sources ODK Central" flush subtitle="Dernière extraction par formulaire">
          <TableWrap max="mh300">
            <thead><tr><Th>Formulaire</Th><Th>Type</Th><Th>Extraction</Th><Th num>Enreg.</Th></tr></thead>
            <tbody>{db.odkForms.map(f=>(
              <tr key={f.id}><Td><div className="font-medium">{f.name}</div>
                  <div className="f11 text-slate-400">/v1/projects/…/{f.formId}</div></Td>
                <Td><Badge tone="b">{ {process:"Processus", output:"Output", outcome:"Outcome", sites:"Sites"}[f.kind] }</Badge></Td>
                <Td className="text-slate-500">{f.last || "—"}</Td><Td num>{fmt(f.records)}</Td></tr>))}
            </tbody></TableWrap>
        </Card>
      </div>
    </>);
}

/* ── Suivi de processus : activités reliées à leurs données ODK ── */
function ProcessData({ db, set, notify, can, go }){
  const [fStatus,setFStatus] = useState(""); const [fTag,setFTag] = useState("");
  const rows = db.visits.filter(v=>(!fStatus||v.status===fStatus)&&(!fTag||v.tag===fTag))
    .slice().sort((a,b)=>b.date.localeCompare(a.date)).slice(0,300);
  const validate = async (id) => {
    try{
      await api.setVisitStatus(id, "Validé");
      set(d => { const v = d.visits.find(x=>x.id===id); if(v) v.status = "Validé"; return d; });
      notify("Visite validée","ok");
    }catch(e){ notify(e.message, "err"); }
  };
  const activities = db.lists.tags.map(t => {
    const sites = db.sites.filter(s=>s.activityTag===t.code);
    const form = db.odkForms.find(f=>f.tag===t.code && f.kind==="process");
    const v = db.visits.filter(x=>x.tag===t.code);
    const planned = sites.reduce((a,s)=>a+s.plan.filter(p=>p.planned).length,0);
    return { ...t, nbSites:sites.length, form, visits:v.length, planned,
      pending:v.filter(x=>x.status==="À valider").length, rate:pct(v.length,planned) };
  }).filter(a=>a.nbSites);
  return (
    <>
      <Card flush title="Activités et sources ODK Central associées"
        subtitle="Chaque catégorie d'activité est reliée au formulaire qui alimente son suivi de processus">
        <TableWrap max="mh340">
          <thead><tr><Th>Activité</Th><Th>Formulaire ODK Central</Th><Th num>Sites</Th><Th num>Planifiées</Th>
            <Th num>Soumissions</Th><Th num>À valider</Th><Th>Couverture</Th><Th /></tr></thead>
          <tbody>{activities.map(a=>(
            <tr key={a.code} className="hover:bg-sky-50">
              <Td><Badge tone="b">{a.code}</Badge> <span className="ml-2 text-slate-700">{a.label}</span></Td>
              <Td>{a.form ? <><span className="font-medium">{a.form.name}</span>
                  <span className="f11 text-slate-400 ml-2">{a.form.formId}</span></>
                : <span className="text-amber-700 f12">Aucun formulaire associé</span>}</Td>
              <Td num>{a.nbSites}</Td><Td num>{a.planned}</Td><Td num>{a.visits}</Td>
              <Td num>{a.pending ? <Badge tone="y">{a.pending}</Badge> : "—"}</Td>
              <Td><div className="flex items-center gap-2"><Bar2 value={a.rate} tone={a.rate>=80?"ok":a.rate>=50?"warn":"bad"} />
                <span className="tabular-nums f115">{a.rate}%</span></div></Td>
              <Td className="text-right"><Btn size="sm" kind="ghost" icon={Link2} onClick={()=>go("settings","odk")}>Configurer</Btn></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <Card flush title="Soumissions de suivi de processus"
        subtitle={`${db.visits.length} enregistrements · ${db.visits.filter(v=>v.status==="À valider").length} en attente`}
        right={<><Select value={fTag} onChange={e=>setFTag(e.target.value)} empty="Toutes les activités"
            options={db.lists.tags.map(t=>t.code)} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fStatus} onChange={e=>setFStatus(e.target.value)} empty="Tous les statuts"
            options={["Validé","À valider","Erreur"]} className="mi-py1 mi-xs mi-wauto" /></>}>
        <TableWrap>
          <thead><tr><Th>Date</Th><Th>Site</Th><Th>Bureau</Th><Th>Activité</Th><Th>Moniteur</Th><Th>Formulaire</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{rows.map(v=>{ const s = db.sites.find(x=>x.id===v.siteId);
            return (<tr key={v.id} className="hover:bg-sky-50">
              <Td className="f115">{v.date}</Td>
              <Td><div className="font-medium">{s?.poi || v.siteId}</div><div className="f11 text-slate-400">{v.siteId} · {s?.adm3}</div></Td>
              <Td>{v.office}</Td><Td><Badge tone="b">{v.tag}</Badge></Td><Td>{v.monitor}</Td>
              <Td className="f11 text-slate-500">{v.form}</Td>
              <Td><Badge tone={v.status==="Validé"?"g":v.status==="Erreur"?"r":"y"}>{v.status}</Badge></Td>
              <Td className="text-right">{can("validate") && v.status!=="Validé" &&
                <Btn size="sm" kind="ghost" icon={Check} onClick={()=>validate(v.id)}>Valider</Btn>}</Td>
            </tr>); })}</tbody>
        </TableWrap>
      </Card>
    </>);
}

/* ── Outputs et population ── */
/* Import par fichier, en trois temps : on télécharge un modèle déjà rempli de ses
   lignes, on le complète, on le téléverse — et rien n'est enregistré avant d'avoir
   vu ce qui va changer. */
function ImportView({ db, notify, can }){
  const [kind,setKind]   = useState("caseload");
  const [year,setYear]   = useState(db.year);
  const [busy,setBusy]   = useState("");
  const [prev,setPrev]   = useState(null);      /* prévisualisation du lot */
  const [hist,setHist]   = useState([]);
  const [err,setErr]     = useState(null);
  const fileRef = useRef(null);

  const KINDS = [["caseload","Population et ciblage"],["pdd","Plan de distribution"]];
  const charger = () => api.importBatches().then(r=>setHist(r.rows||[])).catch(()=>{});
  useEffect(()=>{ charger(); },[]);

  const modele = async () => {
    setBusy("modele"); setErr(null);
    try{
      const blob = await api.importTemplate(kind, year);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `mems_${kind}_${year}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify("Modèle téléchargé","ok");
    }catch(e){ setErr(e.message); notify("Modèle indisponible : " + e.message, "err"); }
    setBusy("");
  };

  const televerser = async (file) => {
    if(!file) return;
    setBusy("upload"); setErr(null); setPrev(null);
    try{
      const r = await api.importUpload(kind, file);
      setPrev(r);
      if(r.resume.rejetes) notify(`${r.resume.rejetes} ligne(s) rejetée(s) — voir le détail`, "warn");
    }catch(e){ setErr(e.message + (e.details ? " · " + e.details.map(d=>d.message).join(" ") : "")); }
    setBusy("");
    if(fileRef.current) fileRef.current.value = "";
  };

  const confirmer = async () => {
    setBusy("commit");
    try{
      const r = await api.importCommit(prev.batch);
      notify(`Import appliqué : ${r.crees} créé(s), ${r.modifies} modifié(s)`, "ok");
      setPrev(null); charger();
    }catch(e){ setErr(e.message); notify("Confirmation refusée : " + e.message, "err"); }
    setBusy("");
  };

  const annuler = async () => {
    try{ await api.importCancel(prev.batch); }catch(e){}
    setPrev(null); charger();
  };

  if(!can("edit")) return (
    <Note tone="warn">L'import de données est réservé aux comptes qui peuvent modifier.</Note>);
  if(!db.geoVersion) return (
    <Note tone="warn"><b>Aucun référentiel chargé.</b> Les modèles d'import s'appuient sur le
      découpage administratif. Chargez un millésime depuis Paramètres → Localités.</Note>);

  const r = prev?.resume;
  return (
    <>
      <Note>Téléchargez le modèle : il arrive <b>déjà rempli des lignes de votre périmètre</b>,
        avec les codes en colonne verrouillée — vous complétez des cases, vous ne saisissez pas
        de clés. Au téléversement, l'application vous montre ce qui va changer ; <b>rien n'est
        enregistré avant votre confirmation</b>. Les lignes absentes du fichier ne sont pas
        supprimées : deux bureaux peuvent téléverser le même mois sans s'effacer.</Note>

      <div className="grid gap-4" style={{gridTemplateColumns:"360px 1fr"}}>
        <Card title="① Télécharger le modèle">
          <Field label="Données à importer">
            <Select value={kind} onChange={e=>{setKind(e.target.value); setPrev(null);}} options={KINDS} /></Field>
          <Field label="Exercice">
            <Select value={String(year)} onChange={e=>setYear(+e.target.value)}
              options={[db.year-1, db.year, db.year+1].map(y=>[String(y),String(y)])} /></Field>
          <Btn icon={Download} onClick={modele} disabled={busy==="modele"}>
            {busy==="modele" ? "Préparation…" : "Télécharger le modèle Excel"}</Btn>

          <div className="mt-4 pt-4 border-t border-slate-100">
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">② Téléverser</div>
            <input ref={fileRef} type="file" accept=".xlsx" disabled={busy==="upload"}
              onChange={e=>televerser(e.target.files[0])}
              className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" />
            {busy==="upload" && <div className="f12 text-slate-500 mt-2">Analyse du fichier…</div>}
            <p className="f115 text-slate-500 mt-2 leading-relaxed">
              Format .xlsx. Le fichier n'est pas conservé sur le serveur : seul le résultat
              de l'analyse est enregistré.</p>
          </div>
          {err && <Note tone="err">{err}</Note>}
        </Card>

        <div>
          {!prev ? (
            <Card title="③ Prévisualisation">
              <div className="py-10 text-center f125 text-slate-500">
                Téléversez un fichier pour voir ce qui sera créé, modifié ou rejeté.
              </div>
            </Card>
          ) : (
            <>
              <Card flush title={`Prévisualisation — ${prev.fichier}`}
                subtitle={`${fmt(prev.lignes)} ligne(s) lue(s) · lot ${prev.batch}`}>
                <div className="stats-row" style={{display:"grid",gap:1,background:"#e2e8ec",
                  gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",borderBottom:"1px solid #e2e8ec"}}>
                  <Stat label="À créer"    value={fmt(r.crees)}    tone={r.crees?"ok":""} />
                  <Stat label="À modifier" value={fmt(r.modifies)} tone={r.modifies?"warn":""} />
                  <Stat label="Inchangées" value={fmt(r.inchanges)} sub="déjà à jour" />
                  <Stat label="Non renseignées" value={fmt(r.vides||0)} sub="ignorées, pas créées à zéro" />
                  <Stat label="Rejetées"   value={fmt(r.rejetes)}  tone={r.rejetes?"bad":""} />
                </div>
                <div className="p-4 flex items-center gap-3 flex-wrap">
                  <Note tone={r.crees+r.modifies ? "info" : "warn"} className="flex-1">{prev.message}</Note>
                  <Btn icon={Check} onClick={confirmer}
                    disabled={busy==="commit" || !(r.crees+r.modifies)}>
                    {busy==="commit" ? "Application…" : `Confirmer ${fmt(r.crees+r.modifies)} ligne(s)`}</Btn>
                  <Btn kind="sec" onClick={annuler} disabled={busy==="commit"}>Abandonner</Btn>
                </div>
              </Card>

              {!!prev.rejets?.length && (
                <Card flush title="Lignes rejetées"
                  subtitle="Elles ne bloquent pas les autres : le reste du fichier reste applicable">
                  <TableWrap max="mh300">
                    <thead><tr><Th className="w-20">Ligne</Th><Th>Unité</Th><Th>Champ</Th><Th>Motif</Th></tr></thead>
                    <tbody>{prev.rejets.map(x=>(
                      <tr key={x.ligne} className="hover:bg-rose-50">
                        <Td className="f115">{x.ligne}</Td>
                        <Td>{x.unite}</Td>
                        <Td className="text-slate-600">{x.champ||"—"}</Td>
                        <Td className="text-rose-700">{x.message}</Td></tr>))}</tbody>
                  </TableWrap>
                </Card>)}

              {!!prev.apercu?.modifies?.length && (
                <Card flush title="Aperçu des modifications">
                  <TableWrap max="mh300">
                    <thead><tr><Th className="w-20">Ligne</Th><Th>Unité</Th><Th>Ce qui change</Th></tr></thead>
                    <tbody>{prev.apercu.modifies.map(x=>(
                      <tr key={x.ligne} className="hover:bg-sky-50">
                        <Td className="f115">{x.ligne}</Td><Td>{x.unite}</Td>
                        <Td className="text-slate-700">{x.message}</Td></tr>))}</tbody>
                  </TableWrap>
                </Card>)}
            </>)}
        </div>
      </div>

      {!!hist.length && (
        <Card flush title="Imports précédents" subtitle="Qui a téléversé quoi, et ce que cela a produit">
          <TableWrap max="mh300">
            <thead><tr><Th>Date</Th><Th>Données</Th><Th>Fichier</Th><Th>Par</Th>
              <Th num>Créées</Th><Th num>Modifiées</Th><Th num>Rejetées</Th><Th>État</Th></tr></thead>
            <tbody>{hist.map(b=>(
              <tr key={b.id} className="hover:bg-sky-50">
                <Td className="f115">{String(b.created_at||"").slice(0,16)}</Td>
                <Td>{(KINDS.find(k=>k[0]===b.kind)||[])[1] || b.kind}</Td>
                <Td className="text-slate-600">{b.filename||"—"}</Td>
                <Td className="text-slate-500">{b.user_label||"—"}</Td>
                <Td num>{b.summary?.crees ?? "—"}</Td>
                <Td num>{b.summary?.modifies ?? "—"}</Td>
                <Td num className={b.summary?.rejetes ? "text-rose-600" : ""}>{b.summary?.rejetes ?? "—"}</Td>
                <Td><Badge tone={b.status==="committed"?"g":b.status==="cancelled"?"":"y"}>
                  {b.status==="committed"?"appliqué":b.status==="cancelled"?"abandonné":"en attente"}</Badge></Td>
              </tr>))}</tbody>
          </TableWrap>
        </Card>)}
    </>);
}

/* Population, ciblage et distribution par unité et par période — les nombres.
   Trois taux en découlent :
     ciblage     = personnes ciblées / population
     couverture  = bénéficiaires planifiés / personnes ciblées
     réalisation = bénéficiaires servis / bénéficiaires planifiés */
function CaseloadView({ db, notify, can }){
  const [level,setLevel] = useState("adm3");
  const [year,setYear]   = useState(db.year);
  const [month,setMonth] = useState("");          /* "" = toute l'année */
  const [tag,setTag]     = useState("");          /* "" = total dédoublonné */
  const [sel,setSel]     = useState({ adm1:"", adm2:"" });
  const geo = useGeoCascade(sel);
  const [d,setD] = useState({ rows:[], totals:null, loading:true });
  const [tags,setTags] = useState([]);

  const parent = geo.codes.adm2 || geo.codes.adm1 || "";
  useEffect(() => {
    let alive = true;
    setD(x => ({ ...x, loading:true }));
    const qs = new URLSearchParams({ year:String(year), level });
    if(month !== "") qs.set("month", month);
    if(tag) qs.set("tag", tag);
    if(parent) qs.set("parent", parent);
    api.caseload("?"+qs)
      .then(r => { if(alive) setD({ ...r, loading:false }); })
      .catch(e => { if(alive) setD({ rows:[], totals:null, loading:false, error:e.message }); });
    return () => { alive = false; };
  }, [year, month, tag, level, parent]);
  useEffect(() => { api.caseloadTags(year).then(r=>setTags(r.rows||[])).catch(()=>{}); }, [year]);

  const t = d.totals;
  const LBL = { adm1:"région", adm2:"district", adm3:"commune", adm4:"fokontany" };
  const tone = (v, bon, moyen) => v == null ? "" : v >= bon ? "ok" : v >= moyen ? "warn" : "bad";

  const exporter = () => {
    download(`population_ciblage_${year}${month!==""?"_"+MONTHS[+month]:""}${tag?"_"+tag:""}.csv`,
      toCSV(d.rows.map(r => ({ Région:r.adm1||"", District:r.adm2||"", Commune:r.adm3||"",
        Unité:r.name, "P-code":r.pcode, Population:r.population, Ménages:r.households,
        Ciblés:r.targeted, "Taux de ciblage %":r.tauxCiblage ?? "",
        "Bénéficiaires planifiés":r.planned, "Couverture du ciblage %":r.tauxCouverture ?? "",
        "Bénéficiaires servis":r.actual, "Réalisation %":r.tauxRealisation ?? "",
        "Tonnage (t)":r.tonnage, "Montant":r.amount, Source:r.source })),
        ["Région","District","Commune","Unité","P-code","Population","Ménages","Ciblés",
         "Taux de ciblage %","Bénéficiaires planifiés","Couverture du ciblage %",
         "Bénéficiaires servis","Réalisation %","Tonnage (t)","Montant","Source"]),
      "text/csv");
    notify("Population et ciblage exportés","ok");
  };

  if(!db.geoVersion) return (
    <Note tone="warn"><b>Aucun référentiel chargé.</b> Population et ciblage se rattachent aux
      unités administratives. Chargez un millésime depuis Paramètres → Localités.</Note>);

  return (
    <>
      <Note>Population, ménages et personnes ciblées par {LBL[level]}, mis en regard du plan de
        distribution de la période. {tag
          ? <>Le ciblage affiché est celui de l'activité <b>{tag}</b>.</>
          : <><b>Le total « toutes activités » n'est pas la somme des activités</b> : une même
            personne peut être ciblée par plusieurs programmes. Il provient de lignes propres,
            dédoublonnées.</>}</Note>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Select value={level} onChange={e=>setLevel(e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[["adm1","Par région"],["adm2","Par district"],["adm3","Par commune"],["adm4","Par fokontany"]]} />
        <Select value={String(year)} onChange={e=>setYear(+e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[db.year-1, db.year, db.year+1].map(y=>[String(y), String(y)])} />
        <Select value={month} onChange={e=>setMonth(e.target.value)} empty="Toute l'année"
          options={MONTHS_L.map((m,i)=>[String(i), m])} className="mi-py1 mi-xs mi-wauto" />
        <Select value={tag} onChange={e=>setTag(e.target.value)} empty="Toutes activités (dédoublonné)"
          options={tags.map(x=>[x.tag, `${x.tag} — ${fmt(x.targeted)} ciblés`])}
          className="mi-py1 mi-xs mi-wauto" />
        <Select value={sel.adm1} onChange={e=>setSel({ adm1:e.target.value, adm2:"" })}
          empty="Toutes les régions" options={geo.adm1.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" />
        <Select value={sel.adm2} onChange={e=>setSel(s=>({ ...s, adm2:e.target.value }))}
          empty="Tous les districts" options={geo.adm2.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto"
          disabled={!sel.adm1} />
        <Btn size="sm" kind="sec" icon={Download} onClick={exporter} disabled={!d.rows.length}>Exporter</Btn>
      </div>

      {t && (
        <StatRow>
          <Stat label="Population" value={fmt(t.population)} sub={`${fmt(t.households)} ménages`} />
          <Stat label="Personnes ciblées" value={fmt(t.targeted)}
            sub={tag ? `activité ${tag}` : "toutes activités, dédoublonné"} />
          <Stat label="Taux de ciblage" value={t.tauxCiblage != null ? t.tauxCiblage+" %" : "—"}
            sub="ciblés / population" />
          <Stat label="Bénéficiaires planifiés" value={fmt(t.planned)} sub="plan de distribution" />
          <Stat label="Couverture du ciblage" value={t.tauxCouverture != null ? t.tauxCouverture+" %" : "—"}
            sub="planifiés / ciblés" tone={tone(t.tauxCouverture, 90, 60)} />
          <Stat label="Réalisation" value={t.tauxRealisation != null ? t.tauxRealisation+" %" : "—"}
            sub={`${fmt(t.actual)} servis`} tone={tone(t.tauxRealisation, 90, 60)} />
        </StatRow>)}

      {t && t.renseignees < t.unites && (
        <Note tone="warn">{fmt(t.unites - t.renseignees)} {LBL[level]}(s) sur {fmt(t.unites)} n'ont
          ni population ni ciblage renseignés : elles comptent pour zéro dans les totaux.</Note>)}

      <Card flush title={`Population, ciblage et distribution par ${LBL[level]}`}
        subtitle={d.loading ? "Chargement…"
          : `${fmt(d.rows.length)} ${LBL[level]}(s) · ${year}${month!==""?" — "+MONTHS_L[+month]:""}${tag?" — "+tag:""}`}>
        <TableWrap max="mh520">
          <thead><tr>
            {level!=="adm1" && <Th>Région</Th>}
            {(level==="adm3"||level==="adm4") && <Th>District</Th>}
            <Th>{LBL[level].replace(/^./,c=>c.toUpperCase())}</Th>
            <Th num>Population</Th><Th num>Ménages</Th><Th num>Ciblés</Th><Th num>Ciblage</Th>
            <Th num>Planifiés</Th><Th num>Couverture</Th><Th num>Servis</Th><Th num>Réalisation</Th>
            <Th num>Tonnage</Th></tr></thead>
          <tbody>{d.rows.map(r=>(
            <tr key={r.pcode} className={clsx("hover:bg-sky-50", !r.population && "bg-amber-50/40")}>
              {level!=="adm1" && <Td className="text-slate-500">{r.adm1||"—"}</Td>}
              {(level==="adm3"||level==="adm4") && <Td className="text-slate-500">{r.adm2||"—"}</Td>}
              <Td className="font-medium text-slate-800">{r.name}</Td>
              <Td num>{r.population ? fmt(r.population) : "—"}</Td>
              <Td num className="text-slate-500">{r.households ? fmt(r.households) : "—"}</Td>
              <Td num><b>{r.targeted ? fmt(r.targeted) : "—"}</b></Td>
              <Td num>{r.tauxCiblage != null
                ? <Badge tone={r.tauxCiblage>=30?"y":""}>{r.tauxCiblage} %</Badge> : "—"}</Td>
              <Td num>{r.planned ? fmt(r.planned) : "—"}</Td>
              <Td num>{r.tauxCouverture != null
                ? <Badge tone={r.tauxCouverture>=90?"g":r.tauxCouverture>=60?"y":"r"}>{r.tauxCouverture} %</Badge> : "—"}</Td>
              <Td num className="text-slate-600">{r.actual ? fmt(r.actual) : "—"}</Td>
              <Td num>{r.tauxRealisation != null
                ? <Badge tone={r.tauxRealisation>=90?"g":r.tauxRealisation>=60?"y":"r"}>{r.tauxRealisation} %</Badge> : "—"}</Td>
              <Td num className="text-slate-500">{r.tonnage || "—"}</Td>
            </tr>))}</tbody>
        </TableWrap>
        {!d.loading && !d.rows.length && (
          <div className="px-4 py-8 text-center f125 text-slate-500">
            {d.error ? d.error : "Aucune unité dans cette sélection."}</div>)}
      </Card>

      {!can("edit") ? null : (
        <Note>La saisie se fait par import : le modèle attendu porte une ligne par unité et par
          activité, avec le p-code en clé. Les lignes absentes du fichier ne sont pas supprimées,
          deux bureaux peuvent donc téléverser le même mois sans s'effacer mutuellement.</Note>)}
    </>);
}

function OutputData({ db, set, notify, can }){
  const [tab,setTab] = useState("outputs"); const [year,setYear] = useState(db.year);
  const cell = (tag,mi) => db.outputs.find(o=>o.tag===tag && o.month===mi);
  const upsert = (tag,mi,patch) => set(d => { let o = d.outputs.find(x=>x.tag===tag && x.month===mi);
    if(!o){ o = { id:uid("o"), tag, month:mi, planned:0, actual:0, adjust:"none", note:"" }; d.outputs.push(o); }
    Object.assign(o, patch); return d; });
  const totals = db.lists.tags.map(t => { const g = db.outputs.filter(o=>o.tag===t.code);
    return { ...t, planned:g.reduce((a,o)=>a+n(o.planned),0), actual:g.reduce((a,o)=>a+n(o.actual),0) };
  }).filter(t=>t.planned||t.actual);
  return (
    <>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["outputs","Bénéficiaires par activité"],["population","Population, ciblage et distribution"]]} />
      {tab==="outputs" ? (
        <>
          <Note>Pour chaque mois, saisissez les bénéficiaires planifiés et atteints, et qualifiez l'ajustement :
            extension de la couverture, réduction, ou nouveau ciblage. Ces mentions expliquent les écarts au moment du rapportage.</Note>
          <Card flush title="Bénéficiaires planifiés et atteints par activité"
            subtitle="Saisie mensuelle, avec le motif d'ajustement de la couverture">
            <TableWrap>
              <thead><tr><Th>Activité</Th><Th>Mois</Th><Th num>Planifiés</Th><Th num>Atteints</Th>
                <Th num>Écart</Th><Th>Ajustement</Th><Th>Commentaire</Th></tr></thead>
              <tbody>{db.lists.tags.flatMap(t => MONTHS.map((m,mi) => {
                const o = cell(t.code, mi); if(!o && mi > new Date().getMonth()) return null;
                const p = n(o?.planned), a = n(o?.actual);
                return (
                  <tr key={t.code+mi} className="hover:bg-sky-50">
                    <Td><Badge tone="b">{t.code}</Badge></Td><Td className="text-slate-600">{MONTHS_L[mi]}</Td>
                    <Td num><input type="number" value={p||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{planned:n(e.target.value)})}
                      className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                    <Td num><input type="number" value={a||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{actual:n(e.target.value)})}
                      className="w-24 px-1.5 py-0.5 f12 text-right border border-slate-200 rounded" /></Td>
                    <Td num className={a>=p?"text-lime-700":"text-rose-700"}>{p?fmt(a-p):"—"}</Td>
                    <Td><select value={o?.adjust||"none"} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{adjust:e.target.value})}
                      className="px-1.5 py-0.5 f115 border border-slate-200 rounded">
                      {D_ADJUST.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></Td>
                    <Td><input value={o?.note||""} disabled={!can("edit")}
                      onChange={e=>upsert(t.code,mi,{note:e.target.value})} placeholder="Motif ou précision"
                      className="w-56 px-1.5 py-0.5 f12 border border-slate-200 rounded" /></Td>
                  </tr>); }).filter(Boolean))}</tbody>
            </TableWrap>
          </Card>
          <Card title="Cumul par activité">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={totals} margin={{top:6,right:6,left:-8,bottom:0}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
                <XAxis dataKey="code" tick={{fontSize:11,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
                <YAxis tick={{fontSize:11,fill:C.t2}} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{fontSize:12,borderRadius:3}} formatter={v=>fmt(v)} />
                <Legend wrapperStyle={{fontSize:11}} />
                <Bar dataKey="planned" name="Planifiés" fill={C.brandL} radius={[2,2,0,0]} />
                <Bar dataKey="actual" name="Atteints" fill={C.ok} radius={[2,2,0,0]} />
              </BarChart></ResponsiveContainer>
          </Card>
        </>
      ) : <CaseloadView db={db} notify={notify} can={can} />}
    </>);
}

function OutcomeData({ db, set, notify, can, go }){
  const [edit,setEdit] = useState(null); const [fInd,setFInd] = useState("");
  const rows = db.outcomes.filter(o=>!fInd||o.indicator===fInd)
    .slice().sort((a,b)=>b.date.localeCompare(a.date));
  const summary = db.indicators.map(ind => {
    const vals = db.outcomes.filter(o=>o.indicator===ind.id);
    const last = vals.slice().sort((a,b)=>b.date.localeCompare(a.date))[0];
    const base = vals.find(v=>/référence|baseline/i.test(v.round));
    const planned = last ? n(last.planned) || ind.target : ind.target;
    const ok = last ? (ind.dir==="up" ? last.value >= planned : last.value <= planned) : null;
    const prog = last ? (ind.dir==="up" ? pct(last.value, planned) : pct(planned, last.value)) : 0;
    return { ...ind, base: base?base.value:null, last: last?last.value:null, planned, ok, prog:Math.min(150,prog) };
  });
  const save = (row) => { set(d => { const i=d.outcomes.findIndex(x=>x.id===row.id);
      if(i>=0) d.outcomes[i]=row; else d.outcomes.push({ ...row, id:uid("c") }); return d; });
    setEdit(null); notify("Valeur enregistrée","ok"); };
  return (
    <>
      <Note>Les indicateurs proviennent de la masterlist définie dans <b>Paramètres → Indicateurs</b>, où elle peut être
        exportée. On saisit ici la valeur planifiée et la valeur observée pour chaque ronde de collecte.
        Le sens de progression dépend de l'indicateur : certains doivent augmenter, d'autres diminuer.</Note>
      <Card flush title="Situation par indicateur" subtitle="Référence, dernière mesure, valeur planifiée"
        right={<Btn size="sm" kind="sec" icon={ListChecks} onClick={()=>go("settings","indicators")}>Gérer la masterlist</Btn>}>
        <TableWrap max="mh420">
          <thead><tr><Th>Indicateur</Th><Th>Panier</Th><Th num>Référence</Th><Th num>Dernière mesure</Th>
            <Th num>Planifié</Th><Th>Sens</Th><Th>Progression</Th></tr></thead>
          <tbody>{summary.map(r=>(
            <tr key={r.id} className="hover:bg-sky-50">
              <Td><div className="font-medium text-slate-800 mw320 truncate" title={r.name}>{r.name}</div>
                <div className="f11 text-slate-400">{r.id} · {r.method} · {r.freq}</div></Td>
              <Td className="text-slate-600">{r.basket}</Td>
              <Td num>{r.base ?? "—"}</Td>
              <Td num><b className={r.ok===null?"":r.ok?"text-lime-700":"text-rose-700"}>{r.last ?? "—"}</b></Td>
              <Td num>{r.planned}{r.unit==="%"?" %":""}</Td>
              <Td><Badge tone="n">{r.dir==="up"?"↑ à maximiser":"↓ à minimiser"}</Badge></Td>
              <Td><div className="flex items-center gap-2"><Bar2 value={r.prog} tone={r.ok?"ok":r.prog>=80?"warn":"bad"} />
                <span className="tabular-nums f115">{r.prog}%</span></div></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <Card flush title="Valeurs collectées" subtitle="Planification et mesures par ronde et par zone"
        right={<><Select value={fInd} onChange={e=>setFInd(e.target.value)} empty="Tous les indicateurs"
            options={db.indicators.map(i=>[i.id,i.id])} className="mi-py1 mi-xs mi-wauto" />
          {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ indicator:db.indicators[0]?.id, adm1:"",
            round:"Suivi", planned:db.indicators[0]?.target, value:0, date:new Date().toISOString().slice(0,10), sample:0 })}>Ajouter une valeur</Btn>}</>}>
        <TableWrap max="mh420">
          <thead><tr><Th>Indicateur</Th><Th>Zone</Th><Th>Ronde</Th><Th>Date</Th>
            <Th num>Planifié</Th><Th num>Observé</Th><Th num>Échantillon</Th><Th /></tr></thead>
          <tbody>{rows.map(o=>{ const ind=db.indicators.find(i=>i.id===o.indicator);
            const ok = ind ? (ind.dir==="up" ? o.value>=n(o.planned) : o.value<=n(o.planned)) : null;
            return (<tr key={o.id} className="hover:bg-sky-50">
              <Td><Badge tone="b">{o.indicator}</Badge></Td><Td>{o.adm1||"—"}</Td><Td>{o.round}</Td>
              <Td className="f115">{o.date}</Td><Td num>{o.planned}</Td>
              <Td num><b className={ok?"text-lime-700":"text-rose-700"}>{o.value}</b></Td>
              <Td num className="text-slate-500">{fmt(o.sample)}</Td>
              <Td className="text-right">{can("edit") &&
                <button onClick={()=>setEdit(o)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                {can("del") && <button onClick={()=>set(d=>{ d.outcomes=d.outcomes.filter(x=>x.id!==o.id); return d; })}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
            </tr>); })}</tbody>
        </TableWrap>
      </Card>
      <OutcomeModal open={!!edit} row={edit} db={db} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function OutcomeModal({ open, row, db, onClose, onSave }){
  const [f,setF] = useState({});
  /* Appelé avant tout retour anticipé : un hook ne peut pas être conditionnel. */
  const outcomeGeo = useGeoCascade({});
  useEffect(()=>{ setF(row||{}); },[row]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const ind = db.indicators.find(i=>i.id===f.indicator);
  return (
    <Modal open onClose={onClose} title={row?.id?"Modifier la valeur":"Nouvelle valeur d'indicateur"}
      subtitle={ind?ind.name:""}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Indicateur"><Select value={f.indicator||""} onChange={e=>{ const i=db.indicators.find(x=>x.id===e.target.value);
          setF(p=>({...p, indicator:e.target.value, planned:i?i.target:p.planned})); }}
          options={db.indicators.map(i=>[i.id, `${i.id} — ${i.name.slice(0,44)}`])} /></Field>
        <Field label="Zone"><Select value={f.adm1||""} onChange={e=>u("adm1",e.target.value)} empty="Toutes zones"
          options={names(outcomeGeo.adm1)} /></Field>
        <Field label="Ronde de collecte"><Input value={f.round||""} onChange={e=>u("round",e.target.value)} placeholder="Référence, Suivi S1, Finale" /></Field>
        <Field label="Date de collecte"><Input type="date" value={f.date||""} onChange={e=>u("date",e.target.value)} /></Field>
        <Field label={`Valeur planifiée${ind?" ("+ind.unit+")":""}`}><Input type="number" step="0.1" value={f.planned??0} onChange={e=>u("planned",n(e.target.value))} /></Field>
        <Field label={`Valeur observée${ind?" ("+ind.unit+")":""}`}><Input type="number" step="0.1" value={f.value??0} onChange={e=>u("value",n(e.target.value))} /></Field>
        <Field label="Taille de l'échantillon"><Input type="number" value={f.sample??0} onChange={e=>u("sample",n(e.target.value))} /></Field>
      </div>
      {ind && <Note tone={(ind.dir==="up" ? n(f.value)>=n(f.planned) : n(f.value)<=n(f.planned)) ? "ok":"warn"}>
        Cet indicateur doit {ind.dir==="up"?"augmenter":"diminuer"}. Avec une valeur observée de {f.value} pour un
        objectif de {f.planned}, la cible est {(ind.dir==="up" ? n(f.value)>=n(f.planned) : n(f.value)<=n(f.planned))?"atteinte":"non atteinte"}.
      </Note>}
    </Modal>);
}

/* ── Sources de données ── */
function Sources({ db, set, notify, can }){
  const pull = (f) => { set(d => { const x = d.odkForms.find(y=>y.id===f.id);
      if(x){ x.last = new Date().toLocaleString("fr-FR"); x.records += Math.floor(Math.random()*40); }
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:"Bureau central",
        kind:"odk", text:`Extraction ODK Central — ${f.name}` }); return d; });
    notify(`Extraction lancée sur ${f.name}`,"ok"); };
  return (
    <>
      <Note tone="warn"><b>Lecture des données.</b> Les jeux sont appelés sur ODK Central via
        <code className="bg-white px-1.5 py-0.5 rounded mx-1 f115">{db.settings.odkBase}/v1/projects/&#123;projet&#125;/forms/&#123;formulaire&#125;.svc/Submissions</code>
        avec un jeton porté par l'en-tête d'autorisation. Depuis un navigateur, l'appel n'aboutit que si le serveur
        autorise l'origine de cette page. La configuration complète se fait dans Paramètres → ODK Central.</Note>
      <Card flush title="Formulaires connectés" subtitle="Chaque formulaire alimente une partie de l'application">
        <TableWrap max="mh420">
          <thead><tr><Th>Formulaire</Th><Th>Identifiant</Th><Th>Type de données</Th><Th>Champ site</Th>
            <Th>XLSForm</Th><Th num>Enreg.</Th><Th>Dernière extraction</Th><Th /></tr></thead>
          <tbody>{db.odkForms.map(f=>(
            <tr key={f.id} className="hover:bg-sky-50">
              <Td className="font-medium">{f.name}</Td><Td className="f115">{f.formId}</Td>
              <Td><Badge tone="b">{ {process:"Suivi de processus", output:"Output", outcome:"Outcome", sites:"Registre des sites"}[f.kind] }</Badge></Td>
              <Td className="f115 text-slate-500">{f.siteField || "auto"}</Td>
              <Td>{f.xlsform ? <Badge tone="g">{f.xlsform.name} · {Object.keys(f.labels||{}).length} libellés</Badge> : <Badge>Non joint</Badge>}</Td>
              <Td num>{fmt(f.records)}</Td><Td className="text-slate-500">{f.last || "—"}</Td>
              <Td className="text-right">{can("sync") && <Btn size="sm" kind="ghost" icon={Download} onClick={()=>pull(f)}>Extraire</Btn>}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
    </>);
}

export { ActualData, ActualSummary, CaseloadView, ImportView, OutcomeData, OutcomeModal, OutputData, ProcessData, Sources };
