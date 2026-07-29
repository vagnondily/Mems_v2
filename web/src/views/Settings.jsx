import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { Activity, Building2, CalendarRange, Check, ClipboardList, Download, FileText, Layers, Link2, MapPin, Pencil, Plus, RefreshCw, Save, Search, Target, Trash2, Upload, X } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { LEVELS, clsx, computeMMR, computeParam, evalFormula, fmt, n, pct, r2, r5, siteRequirement, siteScore, uid } from "../lib/calc.js";
import { ACT_CATEGORIES, C, CALC_VARS, CAT_TO_AREA, DURATIONS, D_FORMULAS, D_SECURITY, D_STATUS, D_URBAN, MONITORING_TYPES, PROG_AREAS, SITE_TYPES, TABS_ALL, siteDerived, sitePriority } from "../lib/constants.js";
import { GUESS, guessField } from "../lib/shapefile.js";
import { Sources } from "./ActualData.jsx";
import { MonthCellModal, MonthGrid, MonthLegend } from "./Planning.jsx";
import { BLOCKS } from "./Reports.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Paramètres ══════════════════ */
function SettingsView({ db, set, me, sub, setSub, notify, can }){
  const items = [["general","Général"],["sites","Sites"],["locations","Localités"],["indicators","Indicateurs"],
    ["calc","Calculs"],["odk","ODK Central"],["templates","Modèles de rapport"],["api","API"],["users","Utilisateurs"]];
  return (
    <div className="space-y-4">
      <PageHead title="Paramètres" text="Configuration de l'application, référentiels, registre des sites, calculs, sources et accès." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="general" && <SetGeneral db={db} set={set} />}
      {sub==="sites" && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="settings" />}
      {sub==="locations" && <SetLocations db={db} set={set} notify={notify} can={can} />}
      {sub==="indicators" && <SetIndicators db={db} set={set} notify={notify} can={can} />}
      {sub==="calc" && <SetCalc db={db} set={set} notify={notify} can={can} />}
      {sub==="odk" && <SetOdk db={db} set={set} notify={notify} can={can} />}
      {sub==="templates" && <SetTemplates db={db} set={set} notify={notify} can={can} />}
      {sub==="api" && <SetApi db={db} notify={notify} />}
      {sub==="users" && <SetUsers db={db} set={set} me={me} notify={notify} />}
    </div>);
}

function SetGeneral({ db, set }){
  const s = db.settings; const u = (k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const LISTS = [["offices","Bureaux et antennes"],["partners","Partenaires coopérants"],["modalities","Types de modalité"]];
  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(330px,1fr))"}}>
      <Card title="Identité et affichage">
        <Field label="Nom de l'organisation"><Input value={s.org} onChange={e=>u("org",e.target.value)} /></Field>
        <Field label="Unité responsable"><Input value={s.unit} onChange={e=>u("unit",e.target.value)} /></Field>
        {/* La politique de sécurité du contenu n'autorise que les images de même origine
            ou en data: — un lien externe serait bloqué par le navigateur, sans message. */}
        <Field label="Logo du pied de page"
          hint="Chemin servi par l'application (/logo.png) ou image en data: — les adresses externes sont bloquées par la politique de sécurité">
          <Input value={s.logo} onChange={e=>u("logo",e.target.value)} placeholder="/logo.png" /></Field>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="Éléments par page" hint="Pagination des tableaux de planification">
            <Input type="number" value={s.pageSize} onChange={e=>u("pageSize",n(e.target.value))} /></Field>
        </div>
        {/* Devise, format de date, intervalle de synchronisation et notifications ont été
            retirés : aucun code ne les lisait. Les rétablir suppose de les brancher
            réellement (formatage des montants et des dates, cadence de la file d'envoi). */}
      </Card>
      {LISTS.map(([k,label])=>(
        <Card key={k} title={label} subtitle={`${db.lists[k].length} entrées`}>
          <div className="space-y-1.5 mh240 overflow-auto pr-1">
            {db.lists[k].map((v,i)=>(<div key={i} className="flex gap-1.5">
              <input value={v} onChange={e=>set(d=>{ d.lists[k][i]=e.target.value; return d; })} className={clsx(inputCls,"mi-py1")} />
              <button onClick={()=>set(d=>{ d.lists[k].splice(i,1); return d; })} className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>
            </div>))}
          </div>
          <Btn size="sm" kind="sec" icon={Plus} className="mt-3" onClick={()=>set(d=>{ d.lists[k].push(""); return d; })}>Ajouter</Btn>
        </Card>))}
      <Card title="Sous-types de point d'intérêt" subtitle="Libellé et code de codification">
        <div className="space-y-1.5 mh240 overflow-auto pr-1">
          {db.lists.poiSub.map((v,i)=>(<div key={i} className="flex gap-1.5">
            <input value={v.label} onChange={e=>set(d=>{ d.lists.poiSub[i].label=e.target.value; return d; })} className={clsx(inputCls,"mi-py1")} />
            <input value={v.code} onChange={e=>set(d=>{ d.lists.poiSub[i].code=e.target.value; return d; })} className={clsx(inputCls,"mi-py1 w-24")} />
            <button onClick={()=>set(d=>{ d.lists.poiSub.splice(i,1); return d; })} className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>
          </div>))}
        </div>
        <Btn size="sm" kind="sec" icon={Plus} className="mt-3" onClick={()=>set(d=>{ d.lists.poiSub.push({label:"",code:""}); return d; })}>Ajouter</Btn>
      </Card>
      <Card title="Activity tags" subtitle="Code et intitulé de l'activité">
        <div className="space-y-1.5 mh240 overflow-auto pr-1">
          {db.lists.tags.map((v,i)=>(<div key={i} className="flex gap-1.5">
            <input value={v.code} onChange={e=>set(d=>{ d.lists.tags[i].code=e.target.value; return d; })} className={clsx(inputCls,"mi-py1 w-20")} />
            <input value={v.label} onChange={e=>set(d=>{ d.lists.tags[i].label=e.target.value; return d; })} className={clsx(inputCls,"mi-py1")} />
            <button onClick={()=>set(d=>{ d.lists.tags.splice(i,1); return d; })} className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>
          </div>))}
        </div>
        <Btn size="sm" kind="sec" icon={Plus} className="mt-3" onClick={()=>set(d=>{ d.lists.tags.push({code:"",label:""}); return d; })}>Ajouter</Btn>
      </Card>
      <Card title="Barème de priorité de suivi" subtitle="Reprend la logique du plan de suivi : quatre sous-scores, puis leur somme arrondie">
        <Note>Priorité = drapeaux urgents + critère nouveau partenaire et ancienneté + moyenne des critères.
          La moyenne porte sur les problèmes du suivi interne, des rapports partenaire et du mécanisme de plainte,
          la fraude, l'expérience du partenaire, les synergies de programme et la taille de la charge.</Note>
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Seuil de charge — palier bas" hint="En deçà, la taille compte pour 0">
            <Input type="number" value={db.scoring.caseload.thresholds[0]}
              onChange={e=>set(d=>{ d.scoring.caseload.thresholds[0]=n(e.target.value); return d; })} /></Field>
          <Field label="Seuil de charge — palier haut" hint="Au-delà, la taille compte pour 2">
            <Input type="number" value={db.scoring.caseload.thresholds[1]}
              onChange={e=>set(d=>{ d.scoring.caseload.thresholds[1]=n(e.target.value); return d; })} /></Field>
          <Field label="Seuil de déclenchement des drapeaux urgents" hint="Niveau à partir duquel un problème est jugé urgent">
            <Input type="number" value={db.scoring.flagLevel.value}
              onChange={e=>set(d=>{ d.scoring.flagLevel.value=n(e.target.value); return d; })} /></Field>
          <Field label="Points attribués aux drapeaux urgents">
            <Input type="number" value={db.scoring.flagLevel.pts}
              onChange={e=>set(d=>{ d.scoring.flagLevel.pts=n(e.target.value); return d; })} /></Field>
          <Field label="Points quand l'intervalle requis est dépassé">
            <Input type="number" value={db.scoring.overdue.pts}
              onChange={e=>set(d=>{ d.scoring.overdue.pts=n(e.target.value); return d; })} /></Field>
          <Field label="Points nouveau partenaire ou visite en retard">
            <Input type="number" value={db.scoring.newPartner.pts}
              onChange={e=>set(d=>{ d.scoring.newPartner.pts=n(e.target.value); return d; })} /></Field>
          <Field label="Seuil de priorité moyenne">
            <Input type="number" value={db.scoring.medium.value}
              onChange={e=>set(d=>{ d.scoring.medium.value=n(e.target.value); return d; })} /></Field>
          <Field label="Seuil de priorité haute">
            <Input type="number" value={db.scoring.high.value}
              onChange={e=>set(d=>{ d.scoring.high.value=n(e.target.value); return d; })} /></Field>
        </div>
        <div className="grid grid-cols-3 gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden">
          {[3,2,1].map(lv=>(
            <div key={lv} className="bg-white px-3 py-2.5">
              <div className="f10 uppercase tracking-wide font-bold text-slate-500">Priorité {LEVELS[lv].label.toLowerCase()}</div>
              <div className="text-lg font-light tabular-nums text-slate-800 mt-0.5">
                {db.sites.filter(x=>sitePriority(x,db).level===lv).length}</div></div>))}
        </div>
      </Card>
      <Card title="Catégories d'activité" subtitle="Liste de référence du plan de suivi">
        <div className="space-y-1.5 mh300 overflow-auto pr-1">
          {(db.actCategories||[]).map((v,i)=>(<div key={i} className="flex gap-1.5">
            <input value={v} onChange={e=>set(d=>{ d.actCategories[i]=e.target.value; return d; })} className={clsx(inputCls,"mi-py1 f115")} />
            <button onClick={()=>set(d=>{ d.actCategories.splice(i,1); return d; })} className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>
          </div>))}
        </div>
        <Btn size="sm" kind="sec" icon={Plus} className="mt-3" onClick={()=>set(d=>{ d.actCategories.push(""); return d; })}>Ajouter</Btn>
      </Card>
    </div>);
}

/* ══════════════════ Module Sites (registre complet, réutilisé en sous-onglet) ══════════════════ */
function SitesModule({ db, set, me, notify, can, context }){
  const [q,setQ] = useState(""); const [fOffice,setFOffice] = useState(""); const [fCommune,setFCommune] = useState("");
  const [fStatus,setFStatus] = useState(""); const [fPrio,setFPrio] = useState(""); const [fTag,setFTag] = useState("");
  const [view,setView] = useState("standard"); const [page,setPage] = useState(1);
  const [edit,setEdit] = useState(null); const [cell,setCell] = useState(null);
  const [sel,setSel] = useState(new Set()); const [bulk,setBulk] = useState(false);

  const admin = db.roles[me.role]?.admin;
  const scoped = db.sites.filter(s => !me.office || admin || s.subOffice===me.office);
  const base = scoped.filter(s => {
    if(fOffice && s.subOffice!==fOffice) return false;
    if(fCommune && s.adm3!==fCommune) return false;
    if(fTag && s.activityTag!==fTag) return false;
    if(fStatus==="active" && s.status==="Inactive") return false;
    if(fStatus==="inactive" && s.status!=="Inactive") return false;
    if(fPrio && String(siteScore(s, db.weights, db).level)!==fPrio) return false;
    if(q && ![s.id,s.poi,s.poiSubtype,s.adm1,s.adm2,s.adm3,s.subOffice,s.activityTag,s.partner,s.modality]
      .join(" ").toLowerCase().includes(q.toLowerCase())) return false;
    return true; });
  const rows = base.filter(s => view==="visit" ? s.plan.some(p=>p.planned&&!p.done)
    : view==="done" ? s.plan.some(p=>p.done) : true);
  const per = n(db.settings.pageSize) || 25;
  const pages = Math.max(1, Math.ceil(rows.length/per));
  const shown = view==="plan" ? rows : rows.slice((Math.min(page,pages)-1)*per, Math.min(page,pages)*per);
  const communes = [...new Set(scoped.map(s=>s.adm3).filter(Boolean))].sort();

  const stats = { total: scoped.length, active: scoped.filter(s=>s.status!=="Inactive").length,
    toVisit: scoped.filter(s=>s.status!=="Inactive" && s.plan.some(p=>p.planned&&!p.done)).length,
    done: scoped.filter(s=>s.plan.some(p=>p.done)).length,
    planned: scoped.filter(s=>s.plan.some(p=>p.planned)).length };
  const avg = pct(scoped.reduce((t,s)=>t+s.plan.filter(p=>p.done).length,0),
                  scoped.reduce((t,s)=>t+s.plan.filter(p=>p.planned).length,0));

  const saveSite = async (site) => {
    /* Le serveur applique l'unicité du code, le cloisonnement par bureau et la trace. */
    const payload = {
      code: site.code || site.id || ("L" + Date.now().toString(36).toUpperCase()),
      name: site.poi || "", status: site.status || "Active",
      office_id: (db.offices.find(o=>o.name===site.subOffice)||{}).id || site.office_id || null,
      antenne: site.antenne || null,
      category_id: (db.categories.find(c=>c.name===site.activityCategory)||{}).id || site.category_id || null,
      activity_tag: site.activityTag || null, program_area: site.programArea || null,
      program_tag: site.programTag || null, poi_subtype: site.poiSubtype || null,
      poi_subtype_code: site.poiSubtypeCode || null, site_type: site.siteType || null,
      monitoring_type: site.monitoringType || null, duration: site.duration || null,
      adm1: site.adm1 || null, adm2: site.adm2 || null, adm3: site.adm3 || null, adm4: site.adm4 || null,
      urban_area: site.urbanArea === "Oui" ? "Oui" : "Non",
      lat: site.lat === "" || site.lat == null ? null : Number(site.lat),
      lon: site.lon === "" || site.lon == null ? null : Number(site.lon),
      security: Number(site.security ?? 0), modality: site.modality || null,
      beneficiaries: Number(site.beneficiaries ?? 0),
      partner_id: (db.partners.find(p=>p.name===site.partner)||{}).id || site.partner_id || null,
      responsible: site.responsible || null, last_visit: site.lastVisit || null,
      synergies: Number(site.synergies ?? 0), new_partner: Number(site.newPartner ?? 0),
      exp_partner: Number(site.expPartner ?? 0), issue_ipm: Number(site.issueIPM ?? 0),
      issue_report: Number(site.issueReport ?? 0), issue_cfm: Number(site.issueCFM ?? 0),
      fraud: Number(site.fraud ?? 0),
    };
    try{
      const r = site.id ? await api.updateSite(site.id, payload) : await api.createSite(payload);
      const saved = r.site;
      set(d => { const i = d.sites.findIndex(x=>x.id===saved.id);
        const merged = { ...site, id:saved.id, code:saved.code, poi:saved.name };
        if(i>=0) d.sites[i] = { ...d.sites[i], ...merged };
        else d.sites.push({ ...merged, plan: Array.from({length:12},()=>(
          { planned:false, done:false, activeMonth:true, cp:"", monitor:"", report:"", moda:"" })) });
        return d; });
      setEdit(null); notify("Site enregistré","ok");
    }catch(e){ notify(e.message, "err"); }
    return;
  };
  const legacySaveSite = (site) => {
    set(d => { const i = d.sites.findIndex(x=>x.id===site.id);
      if(i>=0) d.sites[i] = { ...d.sites[i], ...site };
      else d.sites.push({ ...site, id: site.id || ("L"+String(d.sites.length+1).padStart(3,"0")),
        plan: site.plan || Array.from({length:12},()=>({planned:false,done:false,activeMonth:true,cp:"",monitor:"",report:"",moda:""})) });
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:site.subOffice,
        kind:"plan", text:`Site ${i>=0?"modifié":"créé"} — ${site.poi}` });
      return d; });
    setEdit(null); notify("Site enregistré","ok"); };
  const BULK_TO_API = { subOffice:"office_id", activityTag:"activity_tag", poiSubtype:"poi_subtype",
    modality:"modality", partner:"partner_id", urbanArea:"urban_area", status:"status",
    security:"security", responsible:"responsible" };
  const applyBulk = async (patch) => {
    const [field, raw] = Object.entries(patch)[0] || [];
    const apiField = BULK_TO_API[field];
    if(apiField){
      const value = apiField === "office_id" ? (db.offices.find(o=>o.name===raw)||{}).id
        : apiField === "partner_id" ? (db.partners.find(p=>p.name===raw)||{}).id
        : raw;
      try{
        const r = await api.bulkSites([...sel], apiField, value ?? null);
        set(d => { d.sites.forEach(s => { if(sel.has(s.id)) Object.assign(s, patch); }); return d; });
        notify(`${r.updated} site(s) mis à jour`,"ok"); setSel(new Set());
        return;
      }catch(e){ notify(e.message, "err"); return; }
    }
    set(d => { d.sites.forEach(s => { if(sel.has(s.id)) Object.assign(s, patch); });
      d.audit.unshift({ id:uid("a"), at:new Date().toISOString(), user:"session", office:me.office||"—",
        kind:"plan", text:`Modification groupée appliquée à ${sel.size} site(s)` });
      return d; });
    notify(`${sel.size} site(s) mis à jour`,"ok"); setSel(new Set()); };
  const exportSites = () => download(`sites_${db.year}.csv`,
    toCSV(rows.map(s=>({ ...s, poiSubtypeCode:(db.lists.poiSub.find(p=>p.label===s.poiSubtype)||{}).code||"",
      score: siteScore(s, db.weights, db).pct, priorite: LEVELS[siteScore(s, db.weights, db).level].label,
      visitesPlanifiees: s.plan.filter(p=>p.planned).length, visitesRealisees: s.plan.filter(p=>p.done).length })),
    ["id","status","poi","poiSubtype","poiSubtypeCode","activityTag","subOffice","adm1","adm2","adm3","urbanArea",
     "lat","lon","security","modality","beneficiaries","partner","responsible","lastVisit","score","priorite",
     "visitesPlanifiees","visitesRealisees"]), "text/csv");
  const newSite = () => setEdit({ status:"Active", subOffice:db.lists.offices[0],
    activityTag:db.lists.tags[0]?.code, poiSubtype:db.lists.poiSub[0]?.label, urbanArea:"Non", security:0,
    modality:db.lists.modalities[0], beneficiaries:0, synergies:0, newPartner:0, expPartner:0,
    issueIPM:0, issueReport:0, issueCFM:0, fraud:0 });

  const COLS = ["ID","Status","Point of Interest","POI Subtypes","POI Subtypes Code","Activity Tag","Sub Office",
    "Antenne","Activity Category","Programme Area","Admin level 1","Admin level 2","Admin level 3","Fokontany",
    "Urban Area","GPS-Latitude","GPS-Longitude","Security situation","Modality type","Beneficiary number"];

  return (
    <div className="space-y-4">
      {context==="settings" && <Note>Registre de référence des sites. Toute création ou modification ici alimente
        directement le plan de suivi, les paramètres de couverture et les rapports.</Note>}
      <StatRow>
        <Stat label="Total des sites" value={stats.total} sub="Sites gérés" icon={MapPin} />
        <Stat label="Sites actifs" value={stats.active} sub={`${stats.total-stats.active} inactifs`} icon={Activity} />
        <Stat label="Sites planifiés" value={stats.planned} sub="Au moins une échéance" icon={CalendarRange} />
        <Stat label="Sites à visiter" value={stats.toVisit} sub="Échéance non honorée" tone={stats.toVisit?"warn":"ok"} icon={Target} />
        <Stat label="Sites suivis" value={stats.done} sub="Au moins une visite" tone="ok" icon={Check} />
        <Stat label="Progression moyenne" value={avg+"%"} tone={avg>=80?"ok":avg>=50?"warn":"bad"} sub="Réalisé ÷ planifié" icon={ClipboardList} />
      </StatRow>

      <Card flush>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="Rechercher un site…"
              className={clsx(inputCls,"pl-8 w-56 mi-py1")} /></div>
          <Select value={fOffice} onChange={e=>{setFOffice(e.target.value);setPage(1);}} empty="Tous les bureaux"
            options={db.lists.offices} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fCommune} onChange={e=>{setFCommune(e.target.value);setPage(1);}} empty="Toutes les communes"
            options={communes} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fTag} onChange={e=>{setFTag(e.target.value);setPage(1);}} empty="Toutes les activités"
            options={db.lists.tags.map(t=>t.code)} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fStatus} onChange={e=>{setFStatus(e.target.value);setPage(1);}} empty="Tous les statuts"
            options={[["active","Actifs"],["inactive","Inactifs"]]} className="mi-py1 mi-xs mi-wauto" />
          <Select value={fPrio} onChange={e=>{setFPrio(e.target.value);setPage(1);}} empty="Toutes priorités"
            options={[["3","Élevée"],["2","Moyenne"],["1","Faible"]]} className="mi-py1 mi-xs mi-wauto" />
          <div className="ml-auto flex items-center gap-1 bg-white border border-slate-300 rounded p-0.5">
            {[["standard","Vue standard"],["visit","À visiter"],["done","Déjà visités"],["plan","Planification"]].map(([v,l])=>(
              <button key={v} onClick={()=>{setView(v);setPage(1);}}
                className={clsx("px-2.5 py-1 f12 font-semibold rounded", view===v?"bg-brand text-white":"text-slate-600 hover:bg-slate-100")}>{l}</button>))}
          </div>
          <Btn size="sm" kind="sec" icon={Download} onClick={exportSites}>Exporter</Btn>
          {can("edit") && <Btn size="sm" kind={bulk?"primary":"sec"} icon={Layers}
            onClick={()=>{setBulk(b=>!b); setSel(new Set());}}>{bulk?"Quitter la sélection":"Modification groupée"}</Btn>}
          {can("edit") && <Btn size="sm" icon={Plus} onClick={newSite}>Ajouter un site</Btn>}
        </div>

        {bulk && <BulkBar db={db} sel={sel} rows={rows} communes={communes}
          onSelectCommune={(c)=>setSel(new Set(rows.filter(s=>!c||s.adm3===c).map(s=>s.id)))}
          onApply={applyBulk} onClear={()=>setSel(new Set())} />}

        {view==="plan" ? (
          <>
            <MonthLegend />
            <MonthGrid rows={rows} labelOf={s=>s.poi} subOf={s=>`${s.id} · ${s.subOffice} · ${s.adm3} · ${s.activityTag}`}
              cellOf={(s,mi)=>{ const p=s.plan[mi]||{};
                return { planned:!!p.planned, done:!!p.done, activeMonth:p.activeMonth!==false && s.status!=="Inactive",
                  missed: p.planned && !p.done && mi<new Date().getMonth() }; }}
              onCell={(s,mi)=>can("edit")&&setCell({site:s,mi})}
              footerOf={mi=>rows.filter(s=>s.plan[mi]?.planned).length||""} />
          </>
        ) : (
          <TableWrap>
            <thead><tr>
              {bulk && <Th className="w-9"><input type="checkbox" checked={sel.size===shown.length&&shown.length>0}
                onChange={e=>setSel(e.target.checked ? new Set(shown.map(s=>s.id)) : new Set())} /></Th>}
              {COLS.map(h=><Th key={h} num={["GPS-Latitude","GPS-Longitude","Beneficiary number"].includes(h)}>{h}</Th>)}
              <Th>Priorité de suivi</Th><Th>Dernière visite</Th><Th num>Visites</Th><Th num>À programmer</Th>
              <Th>Suivi</Th><Th>Responsable</Th><Th />
            </tr></thead>
            <tbody>{shown.map(s=>{
              const sc = siteScore(s, db.weights, db); const req = siteRequirement(db, s);
              const done = s.plan.filter(p=>p.done).length, planned = s.plan.filter(p=>p.planned).length;
              const prog = pct(done, Math.max(planned, req.required||1));
              const code = (db.lists.poiSub.find(p=>p.label===s.poiSubtype)||{}).code || "";
              const sec = (D_SECURITY.find(x=>x[0]===s.security)||[])[1] || String(s.security);
              return (
                <tr key={s.id} className={clsx("hover:bg-sky-50", sel.has(s.id)&&"bg-sky-50", !bulk&&can("edit")&&"cursor-pointer")}
                    onClick={()=>!bulk && can("edit") && setEdit(s)}>
                  {bulk && <Td onClick={e=>e.stopPropagation()}><input type="checkbox" checked={sel.has(s.id)}
                    onChange={e=>{ const x=new Set(sel); e.target.checked?x.add(s.id):x.delete(s.id); setSel(x); }} /></Td>}
                  <Td className="f11 text-slate-500">{s.id}</Td>
                  <Td>{s.status!=="Inactive" ? <Badge tone="g">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  <Td className="font-medium text-slate-800">{s.poi}</Td>
                  <Td className="text-slate-700">{s.poiSubtype}</Td>
                  <Td className="f11 text-slate-500">{code}</Td>
                  <Td><Badge tone="b">{s.activityTag}</Badge></Td>
                  <Td><div className="flex items-center gap-1.5 text-slate-700"><Building2 size={12} className="text-slate-400" />{s.subOffice}</div></Td>
                  <Td className="text-slate-600">{s.antenne||"—"}</Td>
                  <Td className="text-slate-600 mw240 truncate" title={s.activityCategory}>{s.activityCategory||"—"}</Td>
                  <Td className="text-slate-600 mw220 truncate" title={s.programArea}>{s.programArea||"—"}</Td>
                  <Td>{s.adm1}</Td><Td>{s.adm2}</Td><Td>{s.adm3}</Td><Td className="text-slate-600">{s.adm4||"—"}</Td>
                  <Td>{s.urbanArea==="Oui" ? <Badge tone="b">Urbain</Badge> : <span className="text-slate-500">Rural</span>}</Td>
                  <Td num className="f11">{s.lat}</Td><Td num className="f11">{s.lon}</Td>
                  <Td><span title={sec} className={clsx("inline-block px-2 py-0.5 rounded-full f11 font-semibold border",
                    s.security===0?"bg-lime-50 text-lime-800 border-lime-200":s.security===1?"bg-amber-50 text-amber-800 border-amber-200":
                    s.security===3?"bg-rose-50 text-rose-800 border-rose-200":"bg-slate-100 text-slate-600 border-slate-200")}>{s.security}</span></Td>
                  <Td className="text-slate-700">{s.modality}</Td>
                  <Td num>{fmt(s.beneficiaries)}</Td>
                  <Td><span className={clsx("inline-block px-2 py-0.5 rounded-full f11 font-semibold border", LEVELS[sc.level].cls)}>
                    {LEVELS[sc.level].label} · {sc.pct}</span></Td>
                  <Td>{s.lastVisit || <span className="text-slate-400">Jamais</span>}</Td>
                  <Td num><span className={done>=req.required?"text-lime-700 font-semibold":"text-slate-700"}>{done}</span>
                    <span className="text-slate-400"> / {req.required||"—"}</span></Td>
                  <Td num className={siteDerived(s,db).visitsToBePlanned?"text-amber-700 font-semibold":"text-slate-400"}>
                    {siteDerived(s,db).visitsToBePlanned||"—"}</Td>
                  <Td><div className="flex items-center gap-2"><Bar2 value={prog} tone={prog>=80?"ok":prog>=40?"warn":"bad"} />
                    <span className="tabular-nums f11 text-slate-600">{prog}%</span></div></Td>
                  <Td className="text-slate-600">{s.responsible}</Td>
                  <Td className="text-right" onClick={e=>e.stopPropagation()}>
                    {can("edit") && <button onClick={()=>setEdit(s)} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>}
                    {can("del") && <button onClick={async ()=>{ if(!confirm("Supprimer ce site ?")) return;
                      try{ await api.deleteSite(s.id); set(d=>{ d.sites=d.sites.filter(x=>x.id!==s.id); return d; });
                        notify("Site supprimé","ok"); }catch(e){ notify(e.message,"err"); } }}
                      className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>}</Td>
                </tr>); })}
            </tbody>
          </TableWrap>)}
        {!rows.length && <Empty icon={MapPin} title="Aucun site ne correspond"
          text="Modifiez les filtres ou ajoutez un nouveau site au registre."
          action={can("edit") && <Btn icon={Plus} onClick={newSite}>Ajouter un site</Btn>} />}
        {view!=="plan" && rows.length>per && (
          <div className="flex items-center gap-3 px-4 py-2.5 border-t border-slate-100 f125 text-slate-600">
            <span>{(Math.min(page,pages)-1)*per+1} à {Math.min(page*per, rows.length)} sur {fmt(rows.length)}</span>
            <div className="ml-auto flex items-center gap-1">
              <Btn size="sm" kind="sec" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
              <span className="px-2 tabular-nums">{Math.min(page,pages)} / {pages}</span>
              <Btn size="sm" kind="sec" disabled={page>=pages} onClick={()=>setPage(p=>p+1)}>Suivant</Btn></div>
          </div>)}
      </Card>

      <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr"}}>
        <Card title="Répartition par priorité de suivi" subtitle="Score de risque calculé sur le barème en vigueur">
          <ResponsiveContainer width="100%" height={220}>
            <PieChart><Pie dataKey="value" nameKey="name" innerRadius="45%" outerRadius="78%" paddingAngle={1}
              data={[3,2,1].map(l=>({ name:LEVELS[l].label, value:base.filter(s=>siteScore(s, db.weights, db).level===l).length }))}>
              {[C.bad,C.warn,C.ok].map((c,i)=><Cell key={i} fill={c} />)}</Pie>
              <Tooltip contentStyle={{fontSize:11,borderRadius:3}} /><Legend wrapperStyle={{fontSize:11}} /></PieChart>
          </ResponsiveContainer>
        </Card>
        <Card title="Sites actifs, planifiés et suivis par bureau">
          <ResponsiveContainer width="100%" height={220}>
            <BarChart margin={{top:6,right:6,left:-14,bottom:0}}
              data={db.lists.offices.map(o=>{ const g=scoped.filter(s=>s.subOffice===o);
                return { bureau:o.slice(0,15), Actifs:g.filter(s=>s.status!=="Inactive").length,
                  Planifiés:g.filter(s=>s.plan.some(p=>p.planned)).length, Suivis:g.filter(s=>s.plan.some(p=>p.done)).length };
              }).filter(x=>x.Actifs||x.Planifiés)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />
              <XAxis dataKey="bureau" tick={{fontSize:10,fill:C.t2}} axisLine={{stroke:"#e2e8ec"}} tickLine={false} />
              <YAxis tick={{fontSize:10,fill:C.t2}} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{fontSize:11,borderRadius:3}} /><Legend wrapperStyle={{fontSize:11}} />
              <Bar dataKey="Actifs" fill="#cfe0ea" radius={[2,2,0,0]} />
              <Bar dataKey="Planifiés" fill={C.brandL} radius={[2,2,0,0]} />
              <Bar dataKey="Suivis" fill={C.ok} radius={[2,2,0,0]} />
            </BarChart></ResponsiveContainer>
        </Card>
      </div>

      <SiteModal open={!!edit} site={edit} db={db} onClose={()=>setEdit(null)} onSave={saveSite} />
      <MonthCellModal cell={cell} db={db} set={set} onClose={()=>setCell(null)} notify={notify} />
    </div>);
}

function BulkBar({ db, sel, rows, communes, onSelectCommune, onApply, onClear }){
  const [field,setField] = useState("subOffice"); const [val,setVal] = useState(""); const [commune,setCommune] = useState("");
  const FIELDS = [["subOffice","Sub Office",db.lists.offices],
    ["activityTag","Activity Tag",db.lists.tags.map(t=>[t.code,`${t.code} — ${t.label}`])],
    ["poiSubtype","POI Subtypes",db.lists.poiSub.map(p=>p.label)],
    ["modality","Modality type",db.lists.modalities],
    ["partner","Partenaire coopérant",db.lists.partners],
    ["urbanArea","Urban Area",D_URBAN],
    ["status","Status",D_STATUS],
    ["security","Security situation",D_SECURITY.map(x=>[String(x[0]),x[1]])],
    ["responsible","Responsable du suivi",[]]];
  const cur = FIELDS.find(f=>f[0]===field) || FIELDS[0];
  const apply = () => onApply({ [field]: field==="security" ? n(val) : val });
  return (
    <div className="flex flex-wrap items-end gap-3 px-4 py-3 bg-sky-50 border-b border-sky-200">
      <div className="f13 font-semibold text-sky-900 self-center">{sel.size} site(s) sélectionné(s)</div>
      <div><div className="f11 font-semibold text-slate-600 mb-1">Sélectionner par commune</div>
        <div className="flex gap-2">
          <Select value={commune} onChange={e=>setCommune(e.target.value)} empty="Toutes les communes affichées"
            options={communes} className="mi-py1 mi-xs mi-wauto" />
          <Btn size="sm" kind="sec" onClick={()=>onSelectCommune(commune)}>Sélectionner</Btn></div></div>
      <div><div className="f11 font-semibold text-slate-600 mb-1">Champ à modifier</div>
        <Select value={field} onChange={e=>{setField(e.target.value);setVal("");}}
          options={FIELDS.map(f=>[f[0],f[1]])} className="mi-py1 mi-xs mi-wauto" /></div>
      <div><div className="f11 font-semibold text-slate-600 mb-1">Nouvelle valeur</div>
        {cur[2].length
          ? <Select value={val} onChange={e=>setVal(e.target.value)} empty="—" options={cur[2]} className="mi-py1 mi-xs mi-wauto" />
          : <Input value={val} onChange={e=>setVal(e.target.value)} className="mi-py1 mi-xs w-40" />}</div>
      <Btn size="sm" icon={Check} disabled={!sel.size||val===""} onClick={apply}>Appliquer</Btn>
      <Btn size="sm" kind="ghost" onClick={onClear}>Désélectionner</Btn>
    </div>);
}

function SiteModal({ open, site, db, onClose, onSave }){
  const [tab,setTab] = useState("id"); const [f,setF] = useState({});
  useEffect(()=>{ setF(site||{}); setTab("id"); },[site]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const code = (db.lists.poiSub.find(p=>p.label===f.poiSubtype)||{}).code || "";
  const sc = siteScore(f, db.weights, db); const req = siteRequirement(db, { ...f, id:f.id||"__" });
  const adm1s = [...new Set(db.geo.map(g=>g.adm1).filter(Boolean))];
  const adm2s = [...new Set(db.geo.filter(g=>!f.adm1||g.adm1===f.adm1).map(g=>g.adm2).filter(Boolean))];
  const adm3s = [...new Set(db.geo.filter(g=>(!f.adm1||g.adm1===f.adm1)&&(!f.adm2||g.adm2===f.adm2)).map(g=>g.adm3).filter(Boolean))];
  const adm4s = [...new Set(db.geo.filter(g=>(!f.adm1||g.adm1===f.adm1)&&(!f.adm2||g.adm2===f.adm2)&&(!f.adm3||g.adm3===f.adm3)).map(g=>g.adm4).filter(Boolean))].slice(0,400);
  return (
    <Modal open wide onClose={onClose} title={site?.id?`Site ${site.id}`:"Nouveau site"}
      subtitle="Identification, codification et critères de risque"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} onClick={()=>onSave(f)}>{site?.id?"Mettre à jour":"Créer le site"}</Btn></>}>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["id","Identification"],["risk","Critères de risque"],["plan","Suivi"]]} />
      {tab==="id" && (
        <div className="grid grid-cols-3 gap-x-4">
          <Field label="ID"><Input value={f.id||""} onChange={e=>u("id",e.target.value)} placeholder="Généré si vide" /></Field>
          <Field label="Status"><Select value={f.status||"Active"} onChange={e=>u("status",e.target.value)} options={D_STATUS} /></Field>
          <Field label="Point of Interest"><Input value={f.poi||""} onChange={e=>u("poi",e.target.value)} /></Field>
          <Field label="POI Subtype"><Select value={f.poiSubtype||""} onChange={e=>u("poiSubtype",e.target.value)}
            empty="—" options={db.lists.poiSub.map(p=>p.label)} /></Field>
          <Field label="POI Subtype Code" hint="Déduit du sous-type"><Input value={code} readOnly /></Field>
          <Field label="Activity Tag"><Select value={f.activityTag||""} onChange={e=>u("activityTag",e.target.value)}
            empty="—" options={db.lists.tags.map(t=>[t.code, `${t.code} — ${t.label}`])} /></Field>
          <Field label="Sub Office"><Select value={f.subOffice||""} onChange={e=>u("subOffice",e.target.value)} empty="—" options={db.lists.offices} /></Field>
          <Field label="Antenne"><Input value={f.antenne||""} onChange={e=>u("antenne",e.target.value)} /></Field>
          <Field label="Activity Category" className="col-span-2">
            <Select value={f.activityCategory||""} onChange={e=>{ u("activityCategory",e.target.value);
              u("programArea", CAT_TO_AREA[e.target.value]||""); u("programTag",""); }}
              empty="—" options={db.actCategories||ACT_CATEGORIES} /></Field>
          <Field label="Programme Area"><Select value={f.programArea||""} onChange={e=>{u("programArea",e.target.value);u("programTag","");}}
            empty="—" options={PROG_AREAS.map(a=>a[0])} /></Field>
          <Field label="Activity Tag (aire de programme)" className="col-span-2">
            <Select value={f.programTag||""} onChange={e=>u("programTag",e.target.value)} empty="—"
              options={(PROG_AREAS.find(a=>a[0]===f.programArea)||[null,[]])[1]} /></Field>
          <Field label="Type de site"><Select value={f.siteType||""} onChange={e=>u("siteType",e.target.value)} empty="—" options={SITE_TYPES} /></Field>
          <Field label="Type de suivi" className="col-span-2"><Select value={f.monitoringType||""} onChange={e=>u("monitoringType",e.target.value)}
            empty="—" options={MONITORING_TYPES} /></Field>
          <Field label="Durée de mise en œuvre"><Select value={f.duration||""} onChange={e=>u("duration",e.target.value)} empty="—" options={DURATIONS} /></Field>
          <Field label="Admin level 1"><Select value={f.adm1||""} onChange={e=>{u("adm1",e.target.value);u("adm2","");u("adm3","");}} empty="—" options={adm1s} /></Field>
          <Field label="Admin level 2"><Select value={f.adm2||""} onChange={e=>{u("adm2",e.target.value);u("adm3","");}} empty="—" options={adm2s} /></Field>
          <Field label="Admin level 3 — commune"><Select value={f.adm3||""} onChange={e=>u("adm3",e.target.value)} empty="—" options={adm3s} /></Field>
          <Field label="Admin level 4 — fokontany"><Select value={f.adm4||""} onChange={e=>u("adm4",e.target.value)} empty="—" options={adm4s} /></Field>
          <Field label="Urban Area"><Select value={f.urbanArea||"Non"} onChange={e=>u("urbanArea",e.target.value)} options={D_URBAN} /></Field>
          <Field label="Modality type"><Select value={f.modality||""} onChange={e=>u("modality",e.target.value)} empty="—" options={db.lists.modalities} /></Field>
          <Field label="GPS Latitude"><Input type="number" step="0.000001" value={f.lat??""} onChange={e=>u("lat",e.target.value)} /></Field>
          <Field label="GPS Longitude"><Input type="number" step="0.000001" value={f.lon??""} onChange={e=>u("lon",e.target.value)} /></Field>
          <Field label="Beneficiary number"><Input type="number" value={f.beneficiaries??0} onChange={e=>u("beneficiaries",n(e.target.value))} /></Field>
          <Field label="Security situation" className="col-span-2"><Select value={f.security??0} onChange={e=>u("security",n(e.target.value))} options={D_SECURITY} /></Field>
          <Field label="Partenaire coopérant"><Select value={f.partner||""} onChange={e=>u("partner",e.target.value)} empty="—" options={db.lists.partners} /></Field>
        </div>)}
      {tab==="risk" && (
        <>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Synergies de programme"><Select value={f.synergies??0} onChange={e=>u("synergies",n(e.target.value))}
              options={[[0,"0 — Une seule activité"],[1,"1 — Plusieurs activités"]]} /></Field>
            <Field label="Nouveau partenaire"><Select value={f.newPartner??0} onChange={e=>u("newPartner",n(e.target.value))}
              options={[[0,"0 — Partenaire avec expérience"],[1,"1 — Nouveau partenaire"]]} /></Field>
            <Field label="Expérience du partenaire"><Select value={f.expPartner??0} onChange={e=>u("expPartner",n(e.target.value))}
              options={[[0,"0 — Bonne expérience"],[1,"1 — Expérience moyenne"],[2,"2 — Problèmes constatés"]]} /></Field>
            <Field label="Problèmes du suivi interne"><Select value={f.issueIPM??0} onChange={e=>u("issueIPM",n(e.target.value))}
              options={[[0,"0 — Aucun"],[1,"1 — Important"],[2,"2 — Urgent"]]} /></Field>
            <Field label="Problèmes des rapports partenaire"><Select value={f.issueReport??0} onChange={e=>u("issueReport",n(e.target.value))}
              options={[[0,"0 — Aucun"],[1,"1 — Important"],[2,"2 — Urgent"]]} /></Field>
            <Field label="Problèmes du mécanisme de plainte"><Select value={f.issueCFM??0} onChange={e=>u("issueCFM",n(e.target.value))}
              options={[[0,"0 — Aucun"],[1,"1 — Important"],[2,"2 — Urgent"]]} /></Field>
            <Field label="Fraude et corruption"><Select value={f.fraud??0} onChange={e=>u("fraud",n(e.target.value))}
              options={[[0,"0 — Non suspecté"],[1,"1 — Suspicion"],[2,"2 — Fraude avérée"]]} /></Field>
            <Field label="Responsable du suivi"><Input value={f.responsible||""} onChange={e=>u("responsible",e.target.value)} /></Field>
          </div>
          {(()=>{ const p = sitePriority(f, db); return (
            <>
              <div className="grid grid-cols-5 gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden mb-3">
                {[["Taille de la charge", p.caseload],["Score dernière visite", p.scoreLastVisit],
                  ["Drapeaux urgents", p.urgentFlags],["Nouveau partenaire et ancienneté", p.newPartnerTime],
                  ["Moyenne des critères", p.average]].map(([l,v])=>(
                  <div key={l} className="bg-white px-3 py-2.5">
                    <div className="f10 uppercase tracking-wide font-bold text-slate-500 leading-tight">{l}</div>
                    <div className="text-lg font-light tabular-nums text-slate-800 mt-0.5">{v}</div></div>))}
              </div>
              <Note tone={p.level===3?"warn":"info"}>
                <b>Priorité de suivi : {p.priority} — {LEVELS[p.level].label.toLowerCase()}.</b>{" "}
                Somme des drapeaux urgents, du critère nouveau partenaire et de la moyenne des critères, arrondie.
                {p.monthsSinceVisit!==null
                  ? ` Dernière visite il y a ${p.monthsSinceVisit} mois pour un intervalle requis de ${p.requiredInterval||"—"} mois.`
                  : " Ce site n'a jamais été visité."}
                <span className="block mt-1 opacity-80">Les seuils se règlent dans Paramètres → Barème de priorité.</span>
              </Note>
            </>); })()}
        </>)}
      {tab==="plan" && (()=>{ const d2 = siteDerived({ ...f, plan: f.plan || [] }, db); return (
          <div className="grid grid-cols-4 gap-x-4">
            <Field label="Dernière visite"><Input type="date" value={f.lastVisit||""} onChange={e=>u("lastVisit",e.target.value)} /></Field>
            <Field label="Site actif"><Input value={d2.activeSite ? "Oui" : "Non"} readOnly /></Field>
            <Field label="Plan Count" hint="Mois où une visite est prévue"><Input value={d2.planCount} readOnly /></Field>
            <Field label="Visit Count" hint="Visites effectivement réalisées"><Input value={d2.visitCount} readOnly /></Field>
            <Field label="Monitoring priority"><Input value={d2.priority} readOnly /></Field>
            <Field label="Fréquence minimale requise"><Input value={req.required||"—"} readOnly /></Field>
            <Field label="Intervalle ajusté requis (mois)"><Input value={req.interval||"—"} readOnly /></Field>
            <Field label="Mois restants"><Input value={d2.monthsRemaining} readOnly /></Field>
            <Field label="Sites restant à planifier"><Input value={d2.sitesToBePlanned} readOnly /></Field>
            <Field label="Visites à programmer"><Input value={d2.visitsToBePlanned} readOnly /></Field>
            <Field label="Nombre de fois visité"><Input value={
              d2.visitedFourPlus ? "4 fois ou plus" : d2.visitedThrice ? "3 fois" : d2.visitedTwice ? "2 fois"
              : d2.visitedOnce ? "1 fois" : "Jamais"} readOnly /></Field>
          </div>); })()}
    </Modal>);
}

/* ── Localités : niveaux administratifs issus du shapefile ── */
function SetLocations({ db, set, notify, can }){
  const [draft,setDraft] = useState(null); const [status,setStatus] = useState(null);
  const [map,setMap] = useState({}); const [mode,setMode] = useState("replace");
  const [depth,setDepth] = useState("adm4"); const [busy,setBusy] = useState(false);
  const [q,setQ] = useState(""); const [f1,setF1] = useState(""); const [f2,setF2] = useState("");
  const rows = db.geo.filter(g => (!f1||g.adm1===f1) && (!f2||g.adm2===f2)
    && (!q || [g.adm0,g.adm1,g.adm2,g.adm3,g.adm4,g.code].join(" ").toLowerCase().includes(q.toLowerCase())));
  const onFile = async (file) => {
    setStatus({ kind:"info", text:"Lecture du fichier…" });
    try{
      const d = await readGeoFile(file);
      if(!d.rows.length) throw new Error("Aucun objet trouvé");
      const bad = d.cent.filter(Boolean).some(c => Math.abs(c[0])>180 || Math.abs(c[1])>90);
      if(bad) throw new Error("Les coordonnées sortent de la plage géographique : reprojetez le fichier en WGS 84 (EPSG:4326)");
      setDraft(d);
      setMap({ adm0:guessField(d.fields,GUESS.adm0), adm1:guessField(d.fields,GUESS.adm1),
        adm2:guessField(d.fields,GUESS.adm2), adm3:guessField(d.fields,GUESS.adm3),
        adm4:guessField(d.fields,GUESS.adm4), code:guessField(d.fields,GUESS.code) });
      setDepth(guessField(d.fields,GUESS.adm4) ? "adm4" : "adm3");
      setStatus({ kind:"ok", text:`${d.rows.length.toLocaleString("fr-FR")} objets lus depuis ${d.src} · ${d.fields.length} champs attributaires`
        + (d.geomSkipped ? " · centroïdes repris des attributs, la géométrie n'a pas eu besoin d'être ouverte" : "") });
    }catch(e){ setDraft(null); setStatus({ kind:"err", text:e.message }); }
  };
  /* Ce que l'on retiendra du fichier : au-delà du niveau choisi, les doublons sont regroupés. */
  const preview = useMemo(() => {
    if(!draft) return [];
    const order = ["adm0","adm1","adm2","adm3","adm4"];
    const keep = order.slice(0, order.indexOf(depth) + 1);
    const seen = new Set(); const out = [];
    draft.rows.forEach((r, i) => {
      const c = draft.cent[i];
      const g = {};
      order.forEach(k => { g[k] = (keep.includes(k) && map[k]) ? String(r[map[k]] ?? "") : ""; });
      g.code = map.code ? String(r[map.code] ?? "") : "";
      g.lat = c ? r5(c[1]) : ""; g.lon = c ? r5(c[0]) : "";
      if(!(g.adm1 || g.adm2 || g.adm3 || g.adm4)) return;
      if(depth !== "adm4"){
        const k = keep.map(x => g[x]).join("|");
        if(seen.has(k)) return;
        seen.add(k); g.code = "";
      }
      out.push(g);
    });
    return out;
  }, [draft, map, depth]);

  /* L'écriture passe par le serveur : une transaction, des contraintes, une trace. */
  const commit = async () => {
    if(!draft || !preview.length){
      notify("Aucune localité exploitable : vérifiez la correspondance des champs", "err"); return;
    }
    setBusy(true);
    try{
      const rows = preview.map(g => ({ adm0:g.adm0 || null, adm1:g.adm1 || null, adm2:g.adm2 || null,
        adm3:g.adm3 || null, adm4:g.adm4 || null, pcode:g.code || null,
        lat: g.lat === "" ? null : Number(g.lat), lon: g.lon === "" ? null : Number(g.lon) }));
      const r = await api.importGeo(mode, rows);
      const fresh = await api.geo("?limit=4000");
      set(d => { d.geo = fresh.rows.map(x => ({ ...x, code:x.pcode })); d.geoCount = r.total; return d; });
      setDraft(null);
      setStatus({ kind:"ok", text:`${r.imported.toLocaleString("fr-FR")} localités importées · ${r.total.toLocaleString("fr-FR")} au total dans le répertoire` });
      notify(`${r.imported.toLocaleString("fr-FR")} localité(s) importée(s)`, "ok");
    }catch(e){
      setStatus({ kind:"err", text:e.message });
      notify("Import refusé : " + e.message, "err");
    }
    setBusy(false);
  };
  const exp = () => download("localites.csv", toCSV(db.geo, ["adm0","adm1","adm2","adm3","adm4","code","lat","lon"]), "text/csv");
  return (
    <>
      <Note>Importez le découpage administratif du niveau 0 au niveau 4 depuis une archive <b>.zip</b> contenant
        un shapefile, ou un fichier <b>.shp</b>, <b>.dbf</b> ou <b>.geojson</b>. La lecture se fait entièrement dans
        le navigateur, aucun fichier n'est transmis à un serveur. Lorsque la table attributaire porte déjà des
        colonnes de centroïdes — <code className="bg-white px-1 rounded">X</code> et
        <code className="bg-white px-1 rounded mx-1">Y</code>, ou latitude et longitude — la géométrie n'est pas
        ouverte du tout : une archive de plusieurs dizaines de mégaoctets se lit alors en une seconde.
        Les coordonnées doivent être en WGS 84.</Note>
      <Card title="Importer un découpage administratif"
        right={<><Btn size="sm" kind="sec" icon={Download} onClick={exp}>Exporter CSV</Btn>
          {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>set(d=>{ d.geo.unshift({ id:uid("g"),
            adm0:"",adm1:"",adm2:"",adm3:"",adm4:"",code:"",lat:"",lon:"" }); return d; })}>Ajouter</Btn>}</>}>
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Fichier du découpage">
            <input type="file" accept=".zip,.shp,.dbf,.geojson,.json" disabled={!can("edit")}
              onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}
              className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
          <div className="self-center">{status && <Note tone={status.kind}>{status.text}</Note>}</div>
        </div>
        {draft && (
          <>
            <div className="grid grid-cols-4 gap-x-3">
              {[["adm0","Niveau 0 — pays"],["adm1","Niveau 1"],["adm2","Niveau 2"],["adm3","Niveau 3"],
                ["adm4","Niveau 4"],["code","Code administratif"]].map(([k,l])=>(
                <Field key={k} label={l}><Select value={map[k]||""} onChange={e=>setMap(m=>({...m,[k]:e.target.value}))}
                  empty="— aucun —" options={draft.fields} /></Field>))}
              <Field label="Niveau de détail à conserver"
                hint="Le niveau le plus fin peut représenter des dizaines de milliers d'entrées">
                <Select value={depth} onChange={e=>setDepth(e.target.value)}
                  options={[["adm1","Jusqu'au niveau 1"],["adm2","Jusqu'au niveau 2"],
                            ["adm3","Jusqu'au niveau 3"],["adm4","Niveau 4 complet"]]} /></Field>
              <Field label="Mode d'import"><Select value={mode} onChange={e=>setMode(e.target.value)}
                options={[["replace","Remplacer les localités"],["merge","Compléter la liste"]]} /></Field>
            </div>
            <Note tone={preview.length > 12000 ? "warn" : "info"}>
              <b>{preview.length.toLocaleString("fr-FR")} localités</b> seront enregistrées
              {depth !== "adm4" && " après regroupement des doublons"}, dont{" "}
              {preview.filter(g => g.lat !== "").length.toLocaleString("fr-FR")} avec coordonnées.
              {preview.length > 12000 && " À ce volume, l'import se fait en une transaction et le répertoire reste paginé à l'affichage."}
            </Note>
            <TableWrap max="mh240">
              <thead><tr>{["Niveau 0","Niveau 1","Niveau 2","Niveau 3","Niveau 4","Code","Latitude","Longitude"].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>{preview.slice(0,8).map((g,i)=>(
                <tr key={i}>{["adm0","adm1","adm2","adm3","adm4","code"].map(k=><Td key={k}>{g[k]}</Td>)}
                  <Td num className="f11">{g.lat}</Td><Td num className="f11">{g.lon}</Td></tr>))}</tbody>
            </TableWrap>
            <Btn className="mt-3" icon={Upload} disabled={busy || !preview.length} onClick={commit}>
              {busy ? "Import en cours…" : `Importer ${preview.length.toLocaleString("fr-FR")} localités`}</Btn>
          </>)}
      </Card>
      <Card flush title="Répertoire des localités" subtitle={`${(db.geoCount ?? db.geo.length).toLocaleString("fr-FR")} entrées au total · ${db.geo.length.toLocaleString("fr-FR")} chargées ici`}
        right={<>
          <Select value={f1} onChange={e=>{setF1(e.target.value);setF2("");}} empty="Tous les niveaux 1"
            options={[...new Set(db.geo.map(g=>g.adm1).filter(Boolean))]} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f2} onChange={e=>setF2(e.target.value)} empty="Tous les niveaux 2"
            options={[...new Set(db.geo.filter(g=>!f1||g.adm1===f1).map(g=>g.adm2).filter(Boolean))]} className="mi-py1 mi-xs mi-wauto" />
          <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Rechercher…" className={clsx(inputCls,"pl-7 mi-py1 w-44")} /></div></>}>
        <TableWrap>
          <thead><tr>{["Niveau 0","Niveau 1","Niveau 2","Niveau 3","Niveau 4","Code"].map(h=><Th key={h}>{h}</Th>)}
            <Th num>Latitude</Th><Th num>Longitude</Th><Th num>Sites</Th><Th /></tr></thead>
          <tbody>{rows.slice(0,300).map(g=>{ const i=db.geo.indexOf(g);
            const cnt = db.sites.filter(s=>s.adm3===g.adm3 && g.adm3).length;
            return (<tr key={g.id} className="hover:bg-sky-50">
              {["adm0","adm1","adm2","adm3","adm4","code"].map(k=>(
                <Td key={k}><input value={g[k]||""} disabled={!can("edit")} onChange={e=>set(d=>{ d.geo[i][k]=e.target.value; return d; })}
                  className="w-28 px-1.5 py-0.5 f12 border border-transparent hover:border-slate-300 rounded" /></Td>))}
              {["lat","lon"].map(k=>(
                <Td key={k} num><input type="number" step="0.000001" value={g[k]??""} disabled={!can("edit")}
                  onChange={e=>set(d=>{ d.geo[i][k]=e.target.value; return d; })}
                  className="w-24 px-1.5 py-0.5 f12 text-right border border-transparent hover:border-slate-300 rounded" /></Td>))}
              <Td num className="text-slate-500">{cnt||""}</Td>
              <Td className="text-right">{can("del") && <button onClick={()=>set(d=>{ d.geo.splice(i,1); return d; })}
                className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
            </tr>); })}</tbody>
        </TableWrap>
        {rows.length>300 && <div className="px-4 py-2 f115 text-slate-500">300 premières lignes affichées sur {fmt(rows.length)}.</div>}
      </Card>
    </>);
}

/* ── Masterlist des indicateurs ── */
function SetIndicators({ db, set, notify, can }){
  const [edit,setEdit] = useState(null);
  const save = (ind) => { set(d => { const i=d.indicators.findIndex(x=>x.id===ind.id);
      if(i>=0) d.indicators[i]=ind; else d.indicators.push(ind); return d; });
    setEdit(null); notify("Indicateur enregistré","ok"); };
  const exp = () => download("masterlist_indicateurs.csv",
    toCSV(db.indicators, ["id","name","basket","unit","target","dir","method","freq"]), "text/csv");
  const imp = (file) => { const rd=new FileReader();
    rd.onload=()=>{ const rows=parseCSV(rd.result);
      if(!rows.length){ notify("Fichier vide","err"); return; }
      set(d=>{ rows.forEach(r=>{ if(!r.id) return;
        const rec = { id:r.id, name:r.name||r.id, basket:r.basket||"", unit:r.unit||"%",
          target:n(r.target), dir:(r.dir==="down"?"down":"up"), method:r.method||"", freq:r.freq||"" };
        const i=d.indicators.findIndex(x=>x.id===rec.id);
        if(i>=0) d.indicators[i]=rec; else d.indicators.push(rec); }); return d; });
      notify(`${rows.length} indicateur(s) importé(s)`,"ok"); };
    rd.readAsText(file,"utf-8"); };
  return (
    <>
      <Note>Cette masterlist alimente le plan de collecte et la saisie des valeurs dans Actual Data.
        Elle s'exporte en CSV pour être partagée, et se réimporte pour une mise à jour groupée.</Note>
      <Card flush title="Masterlist des indicateurs" subtitle={`${db.indicators.length} indicateurs`}
        right={<>
          <label><input type="file" accept=".csv" className="hidden" onChange={e=>e.target.files[0]&&imp(e.target.files[0])} />
            <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer"><Upload size={13}/> Importer</span></label>
          <Btn size="sm" kind="sec" icon={Download} onClick={exp}>Exporter</Btn>
          {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ id:"", name:"", basket:"", unit:"%",
            target:0, dir:"up", method:"", freq:"Annuel" })}>Ajouter</Btn>}</>}>
        <TableWrap>
          <thead><tr><Th>Code</Th><Th>Intitulé</Th><Th>Panier</Th><Th>Unité</Th><Th num>Cible</Th>
            <Th>Sens</Th><Th>Méthode</Th><Th>Fréquence</Th><Th num>Valeurs</Th><Th /></tr></thead>
          <tbody>{db.indicators.map(ind=>(
            <tr key={ind.id} className="hover:bg-sky-50">
              <Td><Badge tone="b">{ind.id}</Badge></Td>
              <Td className="mw420 truncate font-medium text-slate-800" title={ind.name}>{ind.name}</Td>
              <Td className="text-slate-600">{ind.basket}</Td><Td>{ind.unit}</Td><Td num>{ind.target}</Td>
              <Td><Badge tone="n">{ind.dir==="up"?"↑ maximiser":"↓ minimiser"}</Badge></Td>
              <Td className="text-slate-600">{ind.method}</Td><Td>{ind.freq}</Td>
              <Td num className="text-slate-500">{db.outcomes.filter(o=>o.indicator===ind.id).length}</Td>
              <Td className="text-right">
                {can("edit") && <button onClick={()=>setEdit(ind)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                {can("del") && <button onClick={()=>set(d=>{ d.indicators=d.indicators.filter(x=>x.id!==ind.id); return d; })}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <IndicatorModal open={!!edit} ind={edit} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function IndicatorModal({ open, ind, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(ind||{}); },[ind]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  return (
    <Modal open onClose={onClose} title={ind?.id?"Modifier l'indicateur":"Nouvel indicateur"}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.id||!f.name} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Code"><Input value={f.id||""} onChange={e=>u("id",e.target.value.toUpperCase())} placeholder="FCS" /></Field>
        <Field label="Panier thématique"><Input value={f.basket||""} onChange={e=>u("basket",e.target.value)} /></Field>
        <Field label="Intitulé" className="col-span-2"><Input value={f.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        <Field label="Unité"><Select value={f.unit||"%"} onChange={e=>u("unit",e.target.value)} options={["%","idx","nombre","ratio"]} /></Field>
        <Field label="Valeur cible"><Input type="number" step="0.1" value={f.target??0} onChange={e=>u("target",n(e.target.value))} /></Field>
        <Field label="Sens de progression"><Select value={f.dir||"up"} onChange={e=>u("dir",e.target.value)}
          options={[["up","À maximiser"],["down","À minimiser"]]} /></Field>
        <Field label="Fréquence de collecte"><Select value={f.freq||"Annuel"} onChange={e=>u("freq",e.target.value)}
          options={["Mensuel","Trimestriel","Semestriel","Annuel"]} /></Field>
        <Field label="Méthode de collecte" className="col-span-2"><Input value={f.method||""} onChange={e=>u("method",e.target.value)}
          placeholder="Enquête ménage, registres, suivi post-distribution" /></Field>
      </div>
    </Modal>);
}

/* ── Calculs automatiques ── */
function SetCalc({ db, set, notify, can }){
  const [edit,setEdit] = useState(null);
  const TEST = { duration:12, riskLevel:2, nbSites:24, feasiblePerMonth:8, minInterval:6, minFreq:2,
    targetPerMonth:4, feasibilityRatio:2, adjustedFreq:4, adjustedInterval:3, beneficiaries:1500,
    population:85000, visitsDone:3, visitsPlanned:4, score:52 };
  const save = (fm) => { set(d => { const i=d.formulas.findIndex(x=>x.id===fm.id);
      if(i>=0) d.formulas[i]=fm; else d.formulas.push({ ...fm, id:fm.id||uid("f"), core:false }); return d; });
    setEdit(null); notify("Calcul enregistré","ok"); };
  return (
    <>
      <Note>Chaque calcul est défini par une expression. Les fonctions
        <code className="bg-white px-1 rounded mx-1">max min round abs sqrt floor ceil</code> sont acceptées, ainsi que
        les variables listées en bas de page. Les six calculs de base alimentent les paramètres de couverture ;
        les calculs ajoutés sont disponibles pour les vôtres.</Note>
      <div className="grid gap-4 mb-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(380px,1fr))"}}>
        {db.formulas.map((fm,i)=>{ const t = evalFormula(fm.expr, TEST);
          return (
            <Card key={fm.id} title={fm.label} subtitle={fm.desc}
              right={<>{fm.core ? <Badge tone="n">calcul de base</Badge> : <Badge tone="b">personnalisé</Badge>}
                {t.ok ? <Badge tone="g">valide</Badge> : <Badge tone="r">erreur</Badge>}</>}>
              <Field label="Expression">
                <Input value={fm.expr} disabled={!can("edit")}
                  onChange={e=>set(d=>{ d.formulas[i].expr=e.target.value; return d; })} className="f12" /></Field>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {(fm.vars||[]).map(v=>(
                  <button key={v} onClick={()=>set(d=>{ d.formulas[i].expr += (d.formulas[i].expr?" ":"")+v; return d; })}
                    className="px-2 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{v}</button>))}
              </div>
              <div className={clsx("f115 px-2.5 py-1.5 rounded", t.ok?"bg-lime-50 text-lime-800":"bg-rose-50 text-rose-800")}>
                {t.ok ? <>Jeu d'essai → <b className="tabular-nums">{r2(t.value)}</b></> : t.err}</div>
              {!fm.core && can("edit") && (
                <div className="flex gap-2 mt-3">
                  <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEdit(fm)}>Modifier</Btn>
                  <Btn size="sm" kind="ghost" icon={Trash2} onClick={()=>set(d=>{ d.formulas=d.formulas.filter(x=>x.id!==fm.id); return d; })}>Supprimer</Btn></div>)}
            </Card>); })}
      </div>
      <div className="flex gap-2 mb-4">
        {can("edit") && <Btn icon={Plus} onClick={()=>setEdit({ id:"", label:"", desc:"", expr:"", vars:[] })}>Créer un calcul</Btn>}
        {can("edit") && <Btn kind="sec" icon={RefreshCw}
          onClick={()=>{ set(d=>{ d.formulas = JSON.parse(JSON.stringify(D_FORMULAS)); return d; }); notify("Calculs de base rétablis","ok"); }}>Rétablir les calculs de base</Btn>}
      </div>
      <Card flush title="Variables utilisables" subtitle="Liste complète des variables acceptées dans les expressions">
        <TableWrap max="mh340">
          <thead><tr><Th>Variable</Th><Th>Signification</Th><Th>Origine</Th><Th num>Valeur d'essai</Th></tr></thead>
          <tbody>{CALC_VARS.map(([v,d2,o])=>(
            <tr key={v} className="hover:bg-sky-50">
              <Td><code className="bg-slate-100 px-1.5 py-0.5 rounded f115">{v}</code></Td>
              <Td className="text-slate-700">{d2}</Td><Td className="text-slate-500">{o}</Td>
              <Td num className="tabular-nums">{TEST[v] ?? "—"}</Td></tr>))}</tbody>
        </TableWrap>
      </Card>
      <Modal open={!!edit} onClose={()=>setEdit(null)} title={edit?.core===false&&edit?.id?"Modifier le calcul":"Nouveau calcul"}
        subtitle="Définissez un calcul réutilisable"
        footer={<><Btn kind="sec" onClick={()=>setEdit(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={!edit?.label||!edit?.expr} onClick={()=>save(edit)}>Enregistrer</Btn></>}>
        {edit && (<>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Intitulé"><Input value={edit.label||""} onChange={e=>setEdit(p=>({...p,label:e.target.value}))} /></Field>
            <Field label="Identifiant technique"><Input value={edit.id||""} onChange={e=>setEdit(p=>({...p,id:e.target.value.replace(/\W/g,"")}))} placeholder="Généré si vide" /></Field>
            <Field label="Description" className="col-span-2"><Input value={edit.desc||""} onChange={e=>setEdit(p=>({...p,desc:e.target.value}))} /></Field>
          </div>
          <Field label="Expression"><Input value={edit.expr||""} onChange={e=>setEdit(p=>({...p,expr:e.target.value}))} className="f12" /></Field>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {CALC_VARS.map(([v])=>(<button key={v} onClick={()=>setEdit(p=>({...p, expr:(p.expr||"")+v,
              vars:[...new Set([...(p.vars||[]), v])] }))}
              className="px-2 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{v}</button>))}
          </div>
          {(()=>{ const t=evalFormula(edit.expr, TEST);
            return <Note tone={t.ok?"ok":"err"}>{t.ok ? <>Résultat sur le jeu d'essai : <b>{r2(t.value)}</b></> : t.err}</Note>; })()}
        </>)}
      </Modal>
    </>);
}

/* ── ODK Central ── */
function SetOdk({ db, set, notify, can }){
  const [edit,setEdit] = useState(null);
  const s = db.settings; const u=(k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const save = (f) => { set(d => { const i=d.odkForms.findIndex(x=>x.id===f.id);
      if(i>=0) d.odkForms[i]=f; else d.odkForms.push({ ...f, id:uid("f"), records:0, last:"", rows:[] }); return d; });
    setEdit(null); notify("Source enregistrée","ok"); };
  return (
    <>
      <Note tool><b>Adresse d'appel.</b> Un formulaire ODK Central est lu à l'adresse
        <code className="bg-white px-1.5 py-0.5 rounded mx-1 f115">{s.odkBase}/v1/projects/&#123;projet&#125;/forms/&#123;formulaire&#125;.svc/Submissions</code>
        avec un jeton dans l'en-tête d'autorisation. Chaque source déclare le type de données qu'elle apporte,
        le champ qui identifie le site, et peut recevoir son XLSForm pour restituer les libellés des questions
        à la place des noms techniques.</Note>
      <div className="grid gap-4" style={{gridTemplateColumns:"340px 1fr"}}>
        <Card title="Serveur">
          <Field label="Adresse du serveur"><Input value={s.odkBase} onChange={e=>u("odkBase",e.target.value)} placeholder="https://odk-central.example.org" /></Field>
          <Field label="Jeton général" hint="Repris par les sources qui n'ont pas de jeton propre">
            <Input type="password" value={s.odkToken||""} onChange={e=>u("odkToken",e.target.value)} /></Field>
          <Field label="Identifiant de projet par défaut"><Input value={s.odkProject||""} onChange={e=>u("odkProject",e.target.value)} placeholder="1" /></Field>
          <Btn size="sm" kind="sec" icon={Link2}
            onClick={()=>notify("Configuration enregistrée. L'appel réel exige un serveur autorisant cette origine.","warn")}>Tester la connexion</Btn>
        </Card>
        <Card flush title="Sources de données" subtitle={`${db.odkForms.length} formulaires déclarés`}
          right={can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ name:"", formId:"", project:s.odkProject||"",
            token:"", kind:"process", tag:"", siteField:"", dateField:"", labels:{}, xlsform:null })}>Nouvelle source</Btn>}>
          <TableWrap max="mh440">
            <thead><tr><Th>Formulaire</Th><Th>Projet / ID</Th><Th>Type de données</Th><Th>Activité</Th>
              <Th>Champ site</Th><Th>Jeton</Th><Th>XLSForm</Th><Th num>Enreg.</Th><Th /></tr></thead>
            <tbody>{db.odkForms.map(f=>(
              <tr key={f.id} className="hover:bg-sky-50">
                <Td className="font-medium">{f.name}</Td>
                <Td className="f115 text-slate-500">{f.project||"—"} / {f.formId}</Td>
                <Td><Badge tone="b">{ {process:"Suivi de processus", output:"Output", outcome:"Outcome", sites:"Registre des sites"}[f.kind] }</Badge></Td>
                <Td>{f.tag ? <Badge>{f.tag}</Badge> : <span className="text-slate-400">—</span>}</Td>
                <Td className="f115">{f.siteField || <span className="text-amber-700">à définir</span>}</Td>
                <Td>{(f.token||s.odkToken) ? <Badge tone="g">présent</Badge> : <Badge tone="r">manquant</Badge>}</Td>
                <Td>{f.xlsform ? <Badge tone="g">{Object.keys(f.labels||{}).length} libellés</Badge> : <Badge>non joint</Badge>}</Td>
                <Td num>{fmt(f.records)}</Td>
                <Td className="text-right">
                  {can("edit") && <button onClick={()=>setEdit(f)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                  {can("del") && <button onClick={()=>set(d=>{ d.odkForms=d.odkForms.filter(x=>x.id!==f.id); return d; })}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </Card>
      </div>
      <OdkModal open={!!edit} form={edit} db={db} onClose={()=>setEdit(null)} onSave={save} notify={notify} />
    </>);
}
function OdkModal({ open, form, db, onClose, onSave, notify }){
  const [f,setF] = useState({}); const [busy,setBusy] = useState(false);
  useEffect(()=>{ setF(form ? { ...form, labels:{ ...(form.labels||{}) } } : {}); },[form]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const url = `${db.settings.odkBase}/v1/projects/${f.project||"{projet}"}/forms/${f.formId||"{formulaire}"}.svc/Submissions`;
  const fields = Object.keys((f.rows||[])[0] || {});
  const attachXls = async (file) => {
    setBusy(true);
    try{
      let labels = {};
      if(/\.(xlsx|xls)$/i.test(file.name)){
        const XLSX = await import("xlsx");
        const wb = XLSX.read(await file.arrayBuffer(), { type:"array" });
        const sheet = wb.Sheets[wb.SheetNames.find(x=>/survey/i.test(x)) || wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { defval:"" });
        rows.forEach(r => { const name = r.name || r.Name;
          const lab = r.label || r["label::Français (fr)"] || r["label::French (fr)"] || r["label::English (en)"] || r.Label;
          if(name && lab) labels[String(name)] = String(lab); });
      } else {
        parseCSV(await file.text()).forEach(r => { const k = Object.keys(r);
          const name = r[k.find(x=>/^name$/i.test(x))], lab = r[k.find(x=>/^label/i.test(x))];
          if(name && lab) labels[name] = lab; });
      }
      if(!Object.keys(labels).length) throw new Error("Aucune paire nom/libellé trouvée dans la feuille survey");
      setF(p=>({ ...p, xlsform:{ name:file.name, at:new Date().toISOString() }, labels }));
      notify(`${Object.keys(labels).length} libellés extraits du XLSForm`,"ok");
    }catch(e){
      notify("Lecture du XLSForm impossible : "+e.message+". Vous pouvez joindre un CSV à deux colonnes name et label.","err");
    }
    setBusy(false);
  };
  return (
    <Modal open wide onClose={onClose} title={form?.id?"Modifier la source":"Configurer une source ODK Central"}
      subtitle="Connexion, type de données, correspondance des champs et libellés"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.name||!f.formId} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <Field label="Coller l'adresse complète du formulaire" hint="Le projet et l'identifiant sont extraits automatiquement">
        <Input placeholder={`${db.settings.odkBase}/v1/projects/1/forms/suivi_site`} onChange={e=>{
          const m = /\/v1\/projects\/([^/]+)\/forms\/([^/.?#]+)/.exec(e.target.value);
          if(m){ u("project",m[1]); setF(p=>({...p, project:m[1], formId:m[2]})); } }} /></Field>
      <div className="grid grid-cols-3 gap-x-4">
        <Field label="Nom du formulaire" className="col-span-2"><Input value={f.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        <Field label="Identifiant du projet"><Input value={f.project||""} onChange={e=>u("project",e.target.value)} /></Field>
        <Field label="Identifiant du formulaire"><Input value={f.formId||""} onChange={e=>u("formId",e.target.value)} /></Field>
        <Field label="Jeton d'accès" hint="Laisser vide pour reprendre le jeton général">
          <Input type="password" value={f.token||""} onChange={e=>u("token",e.target.value)} /></Field>
        <Field label="Type de données apportées"><Select value={f.kind||"process"} onChange={e=>u("kind",e.target.value)}
          options={[["process","Suivi de processus"],["output","Output — bénéficiaires"],["outcome","Outcome — indicateurs"],["sites","Registre des sites"]]} /></Field>
        <Field label="Activité rattachée"><Select value={f.tag||""} onChange={e=>u("tag",e.target.value)} empty="Toutes"
          options={db.lists.tags.map(t=>[t.code, `${t.code} — ${t.label}`])} /></Field>
        <Field label="Champ identifiant du site">
          {fields.length ? <Select value={f.siteField||""} onChange={e=>u("siteField",e.target.value)} empty="—"
              options={fields.map(c=>[c, (f.labels||{})[c] ? `${c} — ${f.labels[c]}` : c])} />
            : <Input value={f.siteField||""} onChange={e=>u("siteField",e.target.value)} placeholder="site_id" />}</Field>
        <Field label="Champ de date">
          {fields.length ? <Select value={f.dateField||""} onChange={e=>u("dateField",e.target.value)} empty="—"
              options={fields.map(c=>[c, (f.labels||{})[c] ? `${c} — ${f.labels[c]}` : c])} />
            : <Input value={f.dateField||""} onChange={e=>u("dateField",e.target.value)} placeholder="visit_date" />}</Field>
      </div>
      <div className="border-t border-slate-200 pt-3 mb-3">
        <div className="flex items-center gap-3 mb-2">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500">XLSForm associé</div>
          {f.xlsform && <Badge tone="g">{f.xlsform.name}</Badge>}
          <label className="ml-auto">
            <input type="file" accept=".xlsx,.xls,.csv" className="hidden" disabled={busy}
              onChange={e=>e.target.files[0]&&attachXls(e.target.files[0])} />
            <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer">
              <Upload size={13} /> {busy ? "Lecture…" : "Joindre le XLSForm"}</span></label>
        </div>
        <p className="f115 text-slate-500 leading-relaxed mb-2">
          La feuille <b>survey</b> est lue pour associer chaque nom de question à son libellé. Les libellés apparaissent
          ensuite dans les extractions et les analyses à la place des noms techniques. Un fichier CSV à deux colonnes
          <code className="bg-slate-100 px-1 rounded mx-1">name</code> et <code className="bg-slate-100 px-1 rounded">label</code> est également accepté.</p>
        {Object.keys(f.labels||{}).length ? (
          <TableWrap max="mh190">
            <thead><tr><Th>Nom technique</Th><Th>Libellé</Th></tr></thead>
            <tbody>{Object.entries(f.labels).slice(0,40).map(([k,v])=>(
              <tr key={k}><Td className="f115">{k}</Td><Td className="text-slate-700">{v}</Td></tr>))}</tbody>
          </TableWrap>
        ) : <p className="f115 text-slate-400">Aucun libellé chargé.</p>}
      </div>
      <div className="px-3 py-2 rounded bg-slate-50 border border-slate-200 f115 text-slate-600 break-all">{url}</div>
    </Modal>);
}

/* ── Modèles de rapport ── */
function SetTemplates({ db, set, notify, can }){
  const [sel,setSel] = useState(db.reportTemplates[0]?.id || "");
  const t = db.reportTemplates.find(x=>x.id===sel);
  const upd = (fn) => set(d => { const x=d.reportTemplates.find(y=>y.id===sel); if(x) fn(x); return d; });
  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"300px 1fr"}}>
      <Card flush title="Modèles" right={can("edit") && <Btn size="sm" icon={Plus}
        onClick={()=>{ const nt={ id:uid("t"), name:"Nouveau modèle", blocks:["kpi"], intro:"" };
          set(d=>{ d.reportTemplates.push(nt); return d; }); setSel(nt.id); }}>Ajouter</Btn>}>
        <div className="divide-y divide-slate-100">
          {db.reportTemplates.map(x=>(
            <button key={x.id} onClick={()=>setSel(x.id)}
              className={clsx("block w-full text-left px-4 py-3 hover:bg-slate-50", sel===x.id&&"bg-sky-50")}>
              <div className="f13 font-semibold text-slate-800">{x.name}</div>
              <div className="f115 text-slate-500">{x.blocks.length} section(s)</div></button>))}
        </div>
      </Card>
      {t ? (
        <Card title="Configuration du modèle" right={can("del") && db.reportTemplates.length>1 &&
          <Btn size="sm" kind="ghost" icon={Trash2} onClick={()=>{ set(d=>{ d.reportTemplates=d.reportTemplates.filter(x=>x.id!==sel); return d; });
            setSel(db.reportTemplates.find(x=>x.id!==sel)?.id||""); }}>Supprimer</Btn>}>
          <Field label="Nom du modèle"><Input value={t.name} disabled={!can("edit")} onChange={e=>upd(x=>{x.name=e.target.value;})} /></Field>
          <Field label="Texte d'introduction" hint="Champs disponibles : {org} {unite} {periode} {annee}">
            <textarea value={t.intro||""} disabled={!can("edit")} rows={5} className={inputCls}
              onChange={e=>upd(x=>{x.intro=e.target.value;})} /></Field>
          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Sections incluses</div>
          {BLOCKS.map(([b,l,d2])=>(
            <label key={b} className="flex items-start gap-2.5 py-2 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-0.5" disabled={!can("edit")} checked={t.blocks.includes(b)}
                onChange={()=>upd(x=>{ x.blocks = x.blocks.includes(b) ? x.blocks.filter(y=>y!==b) : [...x.blocks,b]; })} />
              <span><span className="f13 font-medium text-slate-800 block">{l}</span>
                <span className="f115 text-slate-500">{d2}</span></span></label>))}
        </Card>
      ) : <Card><Empty icon={FileText} title="Aucun modèle" /></Card>}
    </div>);
}

/* ── API ── */
function SetApi({ db, notify }){
  const s = db.settings;
  const endpoints = [["/api/v1/sites","Registre des sites avec score et couverture"],
    ["/api/v1/plan","Plan de suivi mensuel, planifié et réalisé"],
    ["/api/v1/params","Paramètres de couverture et colonnes calculées"],
    ["/api/v1/visits","Soumissions de suivi de processus"],
    ["/api/v1/outputs","Bénéficiaires planifiés et atteints"],
    ["/api/v1/outcomes","Valeurs des indicateurs de résultat"],
    ["/api/v1/mmr","Exigence minimale de suivi consolidée"]];
  const snapshot = () => { const data = { generated:new Date().toISOString(), org:s.org, year:db.year,
      mmr: computeMMR(db, db.year),
      sites: db.sites.map(x=>({ id:x.id, status:x.status, poi:x.poi, subOffice:x.subOffice, adm1:x.adm1, adm2:x.adm2,
        adm3:x.adm3, activityTag:x.activityTag, beneficiaries:x.beneficiaries, score:siteScore(x, db.weights, db).pct,
        planned:x.plan.filter(p=>p.planned).length, done:x.plan.filter(p=>p.done).length })),
      params: db.params.map(p=>({ ...p, ...computeParam(p, db.sites, db.formulas) })),
      outputs: db.outputs, outcomes: db.outcomes, indicators: db.indicators };
    download("mems_api_snapshot.json", JSON.stringify(data,null,2), "application/json");
    notify("Instantané JSON téléchargé","ok"); };
  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"360px 1fr"}}>
      <Card title="Accès applicatif">
        <div className="rounded bg-amber-50 border border-amber-200 px-3 py-2.5 f115 text-amber-900 leading-relaxed">
          <b>Non disponible.</b> L'accès en lecture par jeton n'est pas encore servi par
          l'application : les points d'entrée ci-contre décrivent la structure prévue, aucun
          n'est actif. En attendant, utilisez l'instantané JSON.
        </div>
        <div className="mt-4 pt-4 border-t border-slate-100">
          <Btn size="sm" icon={Download} onClick={snapshot}>Télécharger un instantané JSON</Btn>
          <p className="f115 text-slate-500 mt-2 leading-relaxed">
            Cet instantané se charge directement dans un outil décisionnel par
            « Obtenir les données → JSON ». Il reflète votre périmètre au moment du téléchargement.</p></div>
      </Card>
      <Card flush title="Points d'entrée" subtitle="Structure prévue — aucun de ces points d'entrée n'est actif à ce jour">
        <TableWrap max="mh420">
          <thead><tr><Th>Point d'entrée</Th><Th>Contenu</Th><Th>Méthode</Th></tr></thead>
          <tbody>{endpoints.map(([e,d2])=>(
            <tr key={e} className="hover:bg-sky-50"><Td className="f115 c-bd">{e}</Td>
              <Td className="text-slate-600">{d2}</Td><Td><Badge tone="b">GET</Badge></Td></tr>))}</tbody>
        </TableWrap>
        <div className="p-4 border-t border-slate-100">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Forme prévue de l'appel</div>
          <pre className="px-3 py-2.5 rounded bg-slate-900 text-slate-100 f115 overflow-auto">
{`GET https://mems.example.org/api/v1/sites?year=${db.year}
Authorization: Token <jeton à émettre>
Accept: application/json`}</pre></div>
      </Card>
    </div>);
}

/* ── Utilisateurs ── */
function SetUsers({ db, set, me, notify }){
  const [edit,setEdit] = useState(null);
  /* Les comptes vivent côté serveur : le navigateur ne calcule aucun condensat
     et ne conserve aucun mot de passe au-delà de la saisie. */
  const save = async (u2) => {
    const payload = { email:(u2.email||"").trim(), first_name:u2.firstName || u2.first_name || "",
      last_name:u2.lastName || u2.last_name || null, title:u2.title || null,
      office_id:u2.office_id || null, role:u2.role || "viewer",
      tabs:u2.tabs || [], active:u2.active !== false };
    if(u2._pw) payload.password = u2._pw;
    try{
      const r = u2.id ? await api.updateUser(u2.id, payload) : await api.createUser(payload);
      set(d => { const i = d.users.findIndex(x => x.id === r.user.id);
        if(i >= 0) d.users[i] = r.user; else d.users.push(r.user); return d; });
      setEdit(null); notify("Compte enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
  };
  const removeUser = async (id) => {
    try{
      await api.deleteUser(id);
      set(d => { d.users = d.users.filter(x => x.id !== id); return d; });
      notify("Compte supprimé", "ok");
    }catch(e){ notify(e.message, "err"); }
  };
  return (
    <>
      <Note tone="warn"><b>Portée de la sécurité.</b> Les mots de passe sont hachés avec un sel propre à chaque compte
        et ne sont jamais conservés en clair. L'application s'exécutant dans le navigateur, ces rôles gouvernent
        l'interface et non l'accès aux données : une protection réelle suppose un serveur avec base authentifiée.</Note>
      <Card flush title="Comptes" subtitle={`${db.users.length} comptes · ${db.users.filter(u=>u.active!==false).length} actifs`}
        right={<Btn size="sm" icon={Plus} onClick={()=>setEdit({ role:"viewer", active:true, tabs:db.roles.viewer.tabs })}>Ajouter un utilisateur</Btn>}>
        <TableWrap max="mh440">
          <thead><tr><Th>Utilisateur</Th><Th>Fonction</Th><Th>Bureau</Th><Th>Adresse électronique</Th>
            <Th>Rôle</Th><Th>Onglets</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{db.users.map((u2,i)=>(
            <tr key={u2.id} className="hover:bg-sky-50">
              <Td><div className="flex items-center gap-2.5">
                <span className="w-7 h-7 rounded-full grid place-items-center f10 font-bold c-deep" style={{background:C.aqua}}>
                  {(u2.first_name?.[0]||"")+(u2.last_name?.[0]||"")}</span>
                <b>{u2.first_name} {u2.last_name}</b></div></Td>
              <Td className="text-slate-600">{u2.title}</Td><Td>{(db.offices.find(o=>o.id===u2.office_id)||{}).name || "Tous"}</Td>
              <Td className="f115">{u2.email}</Td>
              <Td><Badge tone={u2.role==="super"||u2.role==="admin"?"r":u2.role==="validator"?"b":u2.role==="editor"?"g":"n"}>
                {db.roles[u2.role]?.label}</Badge></Td>
              <Td className="text-slate-500">{(u2.tabs||db.roles[u2.role]?.tabs||[]).length} / {TABS_ALL.length}</Td>
              <Td>{u2.active!==false ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>}</Td>
              <Td className="text-right">
                <button onClick={()=>setEdit(u2)} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>
                {u2.id!==me.id && <button onClick={()=>{ if(confirm("Supprimer ce compte ?")) removeUser(u2.id); }}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <Card flush title="Rôles et niveaux d'accès" subtitle="Onglets ouverts par défaut et actions permises">
        <TableWrap max="mh300">
          <thead><tr><Th>Rôle</Th><Th>Onglets accessibles</Th>
            {["Modifier","Supprimer","Valider","Administrer"].map(h=><Th key={h} className="mi-tc">{h}</Th>)}</tr></thead>
          <tbody>{Object.entries(db.roles).map(([k,r])=>(
            <tr key={k}><Td><b>{r.label}</b></Td>
              <Td className="whitespace-normal mw420">{TABS_ALL.map(([t,l])=>(
                <label key={t} className="inline-flex items-center gap-1 mr-3 f115">
                  <input type="checkbox" checked={r.tabs.includes(t)} disabled={k==="super"}
                    onChange={e=>set(d=>{ const rr=d.roles[k];
                      rr.tabs = e.target.checked ? [...new Set([...rr.tabs,t])] : rr.tabs.filter(x=>x!==t); return d; })} />
                  {l}</label>))}</Td>
              {["edit","del","validate","admin"].map(fl=>(
                <Td key={fl} className="mi-tc"><input type="checkbox" checked={!!r[fl]} disabled={k==="super"}
                  onChange={e=>set(d=>{ d.roles[k][fl]=e.target.checked; return d; })} /></Td>))}
            </tr>))}</tbody>
        </TableWrap>
      </Card>
      <UserModal open={!!edit} user={edit} db={db} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function UserModal({ open, user, db, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(user ? { ...user, firstName:user.first_name, lastName:user.last_name,
    tabs:[...(user.tabs || db.roles[user.role]?.tabs || [])] } : { tabs:[], role:"viewer", active:true }); },[user]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  return (
    <Modal open onClose={onClose} title={user?.id?"Modifier l'utilisateur":"Nouvel utilisateur"}
      subtitle="Identité, rattachement, rôle et onglets accessibles"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.firstName||!f.email||(!user?.id&&!f._pw)} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Prénom"><Input value={f.firstName||""} onChange={e=>u("firstName",e.target.value)} /></Field>
        <Field label="Nom"><Input value={f.lastName||""} onChange={e=>u("lastName",e.target.value)} /></Field>
        <Field label="Fonction"><Input value={f.title||""} onChange={e=>u("title",e.target.value)} /></Field>
        <Field label="Bureau de terrain d'appartenance" hint="Restreint la vue aux sites de ce bureau, hors administrateurs">
          <Select value={f.office_id||""} onChange={e=>u("office_id",e.target.value)} empty="Tous les bureaux"
            options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
        <Field label="Adresse électronique"><Input type="email" value={f.email||""} onChange={e=>u("email",e.target.value)} /></Field>
        <Field label={user?.id?"Nouveau mot de passe":"Mot de passe"} hint={user?.id?"Laisser vide pour conserver l'actuel":"Huit caractères au minimum"}>
          <Input type="password" value={f._pw||""} onChange={e=>u("_pw",e.target.value)} /></Field>
      </div>
      <Field label="Rôle">
        <div className="grid grid-cols-1 gap-1.5">
          {Object.entries(db.roles).map(([k,r])=>(
            <label key={k} className={clsx("flex items-center gap-3 px-3 py-2 rounded border cursor-pointer",
              f.role===k?"bd-brand bg-sky-50":"border-slate-200 hover:bg-slate-50")}>
              <input type="radio" name="role" checked={f.role===k} onChange={()=>{u("role",k);u("tabs",[...r.tabs]);}} />
              <div className="flex-1"><div className="f13 font-semibold text-slate-800">{r.label}</div></div>
              <Badge tone="n">{r.tabs.length} onglets</Badge></label>))}
        </div></Field>
      <Field label="Onglets accessibles à ce compte" hint="Affine les droits du rôle">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {TABS_ALL.map(([t,l])=>(
            <label key={t} className="inline-flex items-center gap-1.5 f125">
              <input type="checkbox" checked={(f.tabs||[]).includes(t)}
                onChange={e=>u("tabs", e.target.checked ? [...new Set([...(f.tabs||[]),t])] : (f.tabs||[]).filter(x=>x!==t))} />
              {l}</label>))}
        </div></Field>
      <Sw label="Compte actif" hint="Un compte inactif ne peut pas se connecter" on={f.active!==false} onChange={v=>u("active",v)} />
    </Modal>);
}

export { BulkBar, IndicatorModal, OdkModal, SetApi, SetCalc, SetGeneral, SetIndicators, SetLocations, SetOdk, SetTemplates, SetUsers, SettingsView, SiteModal, SitesModule, UserModal };
