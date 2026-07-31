import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { useGeoCascade, resetGeoCache } from "../lib/geo.js";
import { Activity, Building2, CalendarRange, Check, ClipboardList, Download, FileText, Layers, Link2, MapPin, Pencil, Plus, RefreshCw, Save, Search, Target, Trash2, Upload, X } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { LEVELS, clsx, computeMMR, computeParam, evalFormula, fmt, n, pct, r2, r5, siteRequirement, siteScore, uid } from "../lib/calc.js";
import { ACT_CATEGORIES, C, CALC_VARS, CAT_TO_AREA, DURATIONS, D_FORMULAS, D_SECURITY, D_STATUS, D_URBAN, MONITORING_TYPES, PROG_AREAS, SITE_TYPES, TABS_ALL, siteDerived, sitePriority } from "../lib/constants.js";
/* `readGeoFile` était APPELÉ sans être importé : l'import de découpage depuis
   l'interface levait « readGeoFile is not defined » dès le choix du fichier. Le
   référentiel de production avait été chargé par le script src/import-geo.js, si
   bien que ce chemin-là n'avait jamais été emprunté. */
import { GUESS, guessField, readGeoFile } from "../lib/shapefile.js";
import { niveau, niveaux } from "../lib/levels.js";
import { Sources } from "./ActualData.jsx";
import { MonthCellModal, MonthGrid, MonthLegend, PDD_ACTS, PDD_COMMODITIES } from "./Planning.jsx";
import { BLOCKS } from "./Reports.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Paramètres ══════════════════ */
function SettingsView({ db, set, me, sub, setSub, notify, can, reload }){
  /* La fusion de `main` avait repris sa propre liste d'onglets, sans « Bureaux » ni
     « Périmètre des bureaux » : les deux écrans existaient toujours dans le fichier
     mais n'étaient plus atteignables, et `reload` ne remontait plus. Les voici
     rétablis, avec « À propos » qui venait de main. */
  const items = [["general","Général"],["country","Pays"],["offices","Bureaux"],["sites","Sites"],
    ["locations","Localités"],["scope","Périmètre des bureaux"],["indicators","Indicateurs"],
    ["calc","Calculs"],["rations","Rations"],["odk","ODK Central"],["templates","Modèles de rapport"],
    ["api","API"],["users","Utilisateurs"],["about","À propos"]];
  return (
    <div className="space-y-4">
      <PageHead title="Paramètres" text="Configuration de l'application, référentiels, registre des sites, calculs, sources et accès." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="general" && <SetGeneral db={db} set={set} />}
      {sub==="country" && <SetCountry db={db} notify={notify} can={can} reload={reload} />}
      {sub==="offices" && <SetOffices db={db} notify={notify} can={can} reload={reload} />}
      {sub==="about" && <SetAbout db={db} />}
      {sub==="sites" && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="settings" />}
      {sub==="locations" && <SetLocations db={db} notify={notify} can={can} reload={reload} />}
      {sub==="scope" && <SetScope db={db} notify={notify} can={can} />}
      {sub==="indicators" && <SetIndicators db={db} set={set} notify={notify} can={can} />}
      {sub==="calc" && <SetCalc db={db} set={set} notify={notify} can={can} />}
      {sub==="rations" && <SetRations db={db} set={set} notify={notify} can={can} />}
      {sub==="odk" && <SetOdk db={db} set={set} notify={notify} can={can} reload={reload} />}
      {sub==="templates" && <SetTemplates db={db} set={set} notify={notify} can={can} />}
      {sub==="api" && <SetApi db={db} notify={notify} />}
      {sub==="users" && <SetUsers db={db} set={set} me={me} notify={notify} />}
    </div>);
}

function SetGeneral({ db, set }){
  const s = db.settings; const u = (k,v)=>set(d=>{ d.settings[k]=v; return d; });
  /* Les bureaux ne figurent plus ici. Ils étaient présentés comme une liste de noms
     modifiable, mais cette liste est dérivée de la table `offices` à chaque
     chargement et n'était jamais renvoyée au serveur : toute saisie était perdue.
     Un bureau porte de surcroît une nature, un périmètre et des antennes, et il est
     référencé par les sites et les comptes — il a désormais son propre écran. */
  const LISTS = [["partners","Partenaires coopérants"],["modalities","Types de modalité"]];
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

function SetAbout({ db }){
  return (
    <div className="space-y-4">
      <Card title="À propos de MEMS">
        <p className="text-slate-600 leading-relaxed">Cette application est une interface de suivi et de pilotage. La démo hors ligne est disponible sans installation du serveur.</p>
        <p className="text-slate-600 leading-relaxed">Cliquez sur le lien ci-dessous pour ouvrir la version de présentation indépendante.</p>
        <a href="/demo.html" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-4 py-3 rounded-xl font-semibold text-slate-900 bg-slate-100 hover:bg-slate-200 transition">Ouvrir la démo offline</a>
      </Card>
      <Card title="Informations importantes" subtitle="Démo hors ligne">
        <ul className="list-disc pl-5 space-y-2 text-slate-600">
          <li>La démo n'utilise aucun backend serveur.</li>
          <li>Les écrans et contenus sont simulés pour la présentation.</li>
          <li>Le fichier <code className="rounded bg-slate-100 px-1 py-0.5">web/demo.html</code> est accessible directement.</li>
        </ul>
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

  /* Les quatre niveaux administratifs portaient trois intitulés neutres
     (« Admin level 1 » à « 3 ») et un quatrième propre à Madagascar
     (« Fokontany ») : la même colonne nommée de deux façons selon sa profondeur.
     Les quatre viennent maintenant du pays configuré. Ce ne sont que des en-têtes
     d'affichage — aucun import ne s'y raccroche, la correspondance des champs se
     fait ailleurs et explicitement. */
  const COLS = ["ID","Status","Point of Interest","POI Subtypes","POI Subtypes Code","Activity Tag","Sub Office",
    "Antenne","Activity Category","Programme Area",
    ...niveaux(db, { from:"adm1", to:"adm4", plural:false }).map(x => x[1]),
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
  /* Cascade servie par le serveur, avant tout retour anticipé : un hook ne peut
     pas être conditionnel. Chaque niveau ne demande que les enfants du précédent. */
  const geo = useGeoCascade({ adm1:f.adm1, adm2:f.adm2, adm3:f.adm3, adm4:f.adm4 });
  const [adm1s, adm2s, adm3s, adm4s] =
    [geo.adm1, geo.adm2, geo.adm3, geo.adm4].map(rows => rows.map(x => x.name));
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const code = (db.lists.poiSub.find(p=>p.label===f.poiSubtype)||{}).code || "";
  const sc = siteScore(f, db.weights, db); const req = siteRequirement(db, { ...f, id:f.id||"__" });
  return (
    <Modal open wide onClose={onClose} title={site?.id?`Site ${site.id}`:"Nouveau site"}
      subtitle="Identification, codification et critères de risque"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} onClick={()=>onSave({ ...f, geo_pcode: geo.pcode })}>{site?.id?"Mettre à jour":"Créer le site"}</Btn></>}>
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
/* ── Périmètre des bureaux ──
   Le rôle dit ce qu'un compte peut faire ; le périmètre dit où. Un bureau couvre
   les unités qu'on lui attribue — le plus souvent des districts — et le périmètre
   effectif est tout ce qui en descend. */
/* ── Pays et vocabulaire du découpage ─────────────────────────────────
   Cette première version sert Madagascar, et d'autres pays suivront. Ce qui
   change ici n'est pas la capacité à servir plusieurs pays en même temps — cela
   demanderait de rattacher sites, bureaux et comptes à un pays — mais le fait que
   plus rien de spécifique à Madagascar ne soit écrit dans le code.

   « Régions / Districts / Communes / Fokontany » figurait en dur dans huit
   endroits de l'interface. La RDC a des Provinces, Territoires, Secteurs et
   Groupements ; l'Éthiopie des Regions, Zones, Woredas et Kebeles. Le schéma, lui,
   n'a jamais connu que adm0 à adm4. */
function SetCountry({ db, notify, can, reload }){
  const [data,setData] = useState(null);
  const [edit,setEdit] = useState(null);
  const [busy,setBusy] = useState(false);

  const charger = () => api.countries().then(setData)
    .catch(e => { notify(e.message,"err"); setData({ rows:[], levels:[] }); });
  useEffect(()=>{ charger(); },[]);
  if(!data) return <Empty icon={MapPin} title="Chargement de la configuration du pays…" />;

  const vide = { code:"", name:"", currency:"USD", active:true,
    levels: Object.fromEntries((data.levels||[]).map(l => [l, { one:"", many:"" }])) };

  const enregistrer = async () => {
    setBusy(true);
    const b = { code:edit.code, name:edit.name, currency:edit.currency,
      levels:edit.levels, lat:edit.lat ?? null, lon:edit.lon ?? null,
      note:edit.note || null, active:edit.active !== false };
    if(edit._existe) b.rev = edit.rev;
    try{
      edit._existe ? await api.updateCountry(edit.code, b) : await api.createCountry(b);
      setEdit(null); await charger();
      /* Les libellés voyagent avec l'état initial : sans rechargement, les écrans
         continueraient d'afficher l'ancien vocabulaire jusqu'au prochain F5. */
      if(reload) await reload();
      notify("Pays enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  return (
    <>
      <Note>Le découpage administratif du schéma est neutre : <code className="bg-white px-1 rounded">adm0</code>
        {" "}à <code className="bg-white px-1 rounded">adm4</code>. Ce sont les <b>libellés</b> qui sont propres à
        un pays — région, district, commune, fokontany à Madagascar ; province, territoire, secteur,
        groupement en RDC. Ils sont configurés ici et utilisés partout, plutôt que réécrits écran par écran.
        <br /><br />
        <b>Un seul pays est courant à la fois.</b> C'est ce qui correspond à un déploiement par bureau
        pays. Servir plusieurs pays depuis une même instance supposerait de rattacher les sites, les
        bureaux et les comptes à un pays — une autre décision, celle de savoir si un utilisateur
        traverse les frontières.</Note>

      <Card flush title="Pays configurés"
        subtitle={`${data.rows.length} pays · courant : ${data.current?.name || "aucun"}`}
        right={can("admin") && <Btn size="sm" icon={Plus}
          onClick={()=>setEdit({ ...vide, _existe:false })}>Ajouter un pays</Btn>}>
        <TableWrap>
          <thead><tr><Th>Pays</Th><Th>Code</Th><Th>Devise locale</Th><Th>Vocabulaire du découpage</Th>
            <Th num>Millésimes</Th><Th>État</Th><Th /></tr></thead>
          <tbody>{data.rows.map(c=>(
            <tr key={c.code} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{c.name}
                {c.note && <div className="f105 text-slate-400 whitespace-normal mw420">{c.note}</div>}</Td>
              <Td className="f115 text-slate-500">{c.code}</Td>
              <Td className="f115">{c.currency}</Td>
              <Td className="f115 text-slate-600 whitespace-normal mw420">
                {["adm1","adm2","adm3","adm4"].map(l => c.levels[l]?.many).filter(Boolean).join(" · ")}</Td>
              <Td num className={c.versions ? "" : "text-amber-700"}>{c.versions || "aucun"}</Td>
              <Td>{c.current ? <Badge tone="g">courant</Badge>
                : c.active ? <Badge>actif</Badge> : <Badge tone="r">désactivé</Badge>}</Td>
              <Td className="text-right whitespace-nowrap">{can("admin") && (<>
                <Btn size="sm" kind="sec" icon={Pencil}
                  onClick={()=>setEdit({ ...c, _existe:true })}>Modifier</Btn>
                {!c.current && c.active && <Btn size="sm" kind="sec" className="ml-2" disabled={busy}
                  onClick={async ()=>{ if(!confirm(`Rendre « ${c.name} » courant ? Le référentiel géographique suivra.`)) return;
                    setBusy(true);
                    try{ const r = await api.setCountry(c.code); await charger();
                      if(reload) await reload();
                      notify(r.avertissement || `Pays courant : ${c.name}`, r.avertissement ? "warn" : "ok");
                    }catch(e){ notify(e.message,"err"); }
                    setBusy(false); }}>Rendre courant</Btn>}</>)}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>

      <Modal open={!!edit} wide onClose={()=>setEdit(null)}
        title={edit?._existe ? `Configuration de ${edit.name}` : "Nouveau pays"}
        subtitle="Identité, devise locale et libellés des cinq niveaux administratifs"
        footer={<><Btn kind="sec" onClick={()=>setEdit(null)}>Annuler</Btn>
          <Btn icon={Save} disabled={busy || !edit?.name?.trim() || (edit?.code||"").length !== 3}
            onClick={enregistrer}>{busy ? "Enregistrement…" : "Enregistrer"}</Btn></>}>
        {edit && (<>
          <div className="grid grid-cols-4 gap-x-4">
            <Field label="Nom du pays" className="col-span-2">
              <Input value={edit.name||""} onChange={e=>setEdit(p=>({...p,name:e.target.value}))} /></Field>
            <Field label="Code ISO" hint="Trois lettres — MDG, COD, ETH">
              <Input maxLength={3} value={edit.code||""} readOnly={edit._existe}
                onChange={e=>setEdit(p=>({...p,code:e.target.value.toUpperCase()}))} /></Field>
            <Field label="Devise locale" hint="Utilisée pour les contrats de prestataires">
              <Input maxLength={3} value={edit.currency||""}
                onChange={e=>setEdit(p=>({...p,currency:e.target.value.toUpperCase()}))} /></Field>
            <Field label="Latitude du centre" hint="Cadre la carte avant tout import de contours">
              <Input type="number" value={edit.lat ?? ""}
                onChange={e=>setEdit(p=>({...p,lat:e.target.value}))} /></Field>
            <Field label="Longitude du centre">
              <Input type="number" value={edit.lon ?? ""}
                onChange={e=>setEdit(p=>({...p,lon:e.target.value}))} /></Field>
            <Field label="Note" className="col-span-2"><Input value={edit.note||""}
              onChange={e=>setEdit(p=>({...p,note:e.target.value}))} /></Field>
          </div>

          <Field label="Libellés des niveaux administratifs"
            hint="Singulier et pluriel. Les cinq sont exigés : un niveau non nommé s'afficherait « adm4 » quelque part.">
            <TableWrap max="mh300">
              <thead><tr><Th>Code du schéma</Th><Th>Singulier</Th><Th>Pluriel</Th></tr></thead>
              <tbody>{(data.levels||[]).map(l=>(
                <tr key={l}>
                  <Td className="f115 c-bd">{l}</Td>
                  <Td><input value={edit.levels?.[l]?.one || ""} className={clsx(inputCls,"mi-py1")}
                    onChange={e=>setEdit(p=>({...p, levels:{...p.levels,
                      [l]:{ ...(p.levels?.[l]||{}), one:e.target.value }}}))} /></Td>
                  <Td><input value={edit.levels?.[l]?.many || ""} className={clsx(inputCls,"mi-py1")}
                    onChange={e=>setEdit(p=>({...p, levels:{...p.levels,
                      [l]:{ ...(p.levels?.[l]||{}), many:e.target.value }}}))} /></Td>
                </tr>))}</tbody>
            </TableWrap>
          </Field>
          <Sw label="Pays actif" hint="Un pays désactivé ne peut pas être rendu courant"
            on={edit.active !== false} onChange={v=>setEdit(p=>({...p,active:v}))} />
        </>)}
      </Modal>
    </>);
}

/* ── Bureaux ──────────────────────────────────────────────────────────
   Configuration réelle des bureaux, en base. Deux choses s'y règlent qui
   n'existaient nulle part : la création d'un bureau, et son mode de périmètre.

   Le mode de périmètre est le point délicat. Un compte de terrain est borné aux
   unités de son bureau ; c'est la bonne règle pour une antenne, mais le bureau
   pays a des staffs qui doivent voir tous les sites. Les passer administrateurs
   aurait réglé la visibilité en leur donnant la gestion des comptes. Le périmètre
   est donc porté par le bureau, indépendamment du rôle. */
function SetOffices({ db, notify, can, reload }){
  const [rows,setRows] = useState(null);
  const [edit,setEdit] = useState(null);
  const [busy,setBusy] = useState(false);

  const charger = () => api.offices().then(r=>setRows(r.offices||[])).catch(e=>{ notify(e.message,"err"); setRows([]); });
  useEffect(()=>{ charger(); },[]);

  const enregistrer = async (f) => {
    setBusy(true);
    const payload = { name:(f.name||"").trim(), code:f.code||null, kind:f.kind||"field",
      scope_mode:f.scope_mode||"geo",
      antennes:(f.antennes||[]).map(a=>a.trim()).filter(Boolean),
      manager:f.manager||null, email:f.email||null, phone:f.phone||null,
      lat:f.lat===""||f.lat==null?null:r5(n(f.lat)), lon:f.lon===""||f.lon==null?null:r5(n(f.lon)),
      note:f.note||null, active:f.active!==false };
    if(f.id) payload.rev = f.rev;
    try{
      f.id ? await api.updateOffice(f.id, payload) : await api.createOffice(payload);
      setEdit(null); await charger();
      /* Le nom d'un bureau apparaît sur chaque site et dans tous les filtres :
         l'état global doit être rechargé, sinon l'écran affiche le nouveau nom et
         le reste de l'application l'ancien. */
      if(reload) await reload();
      notify("Bureau enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const supprimer = async (o) => {
    const tot = Object.values(o.usage).reduce((a,b)=>a+b,0);
    if(tot){ notify("Ce bureau est référencé : désactivez-le plutôt que de le supprimer", "warn"); return; }
    if(!confirm(`Supprimer « ${o.name} » ?`)) return;
    try{ await api.deleteOffice(o.id); await charger(); if(reload) await reload();
      notify("Bureau supprimé", "ok"); }
    catch(e){ notify(e.message, "err"); }
  };

  if(rows === null) return <Empty icon={Building2} title="Chargement des bureaux…" />;
  const nat = rows.filter(o=>o.scope_mode==="national").length;

  return (
    <>
      <Note>Un bureau est une entité de la base : il porte les sites, les comptes, les
        paramètres de couverture et le plan de distribution. Son <b>mode de périmètre</b>{" "}
        décide de ce que ses comptes non administrateurs peuvent voir —
        soit les unités qui lui sont attribuées (Paramètres → Périmètre des bureaux),
        soit <b>tout le pays</b> pour le bureau central.</Note>

      <Card flush title="Bureaux et antennes"
        subtitle={`${rows.length} bureau(x) · ${rows.filter(o=>o.active).length} actifs · ${nat} à périmètre national`}
        right={can("admin") && <Btn size="sm" icon={Plus}
          onClick={()=>setEdit({ kind:"field", scope_mode:"geo", active:true, antennes:[] })}>
          Ajouter un bureau</Btn>}>
        <TableWrap max="mh480">
          <thead><tr><Th>Bureau</Th><Th>Code</Th><Th>Nature</Th><Th>Périmètre</Th>
            <Th>Antennes</Th><Th>Responsable</Th><Th num>Sites</Th><Th num>Comptes</Th>
            <Th>Statut</Th><Th /></tr></thead>
          <tbody>{rows.map(o=>(
            <tr key={o.id} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{o.name}</Td>
              <Td className="f115 text-slate-500">{o.code || "—"}</Td>
              <Td>{o.kind==="hq" ? <Badge tone="b">bureau pays</Badge> : <Badge>terrain</Badge>}</Td>
              <Td>{o.scope_mode==="national"
                ? <Badge tone="b">national — tous les sites</Badge>
                : o.scope.source==="déclaré" ? <Badge tone="g">{o.scope.communes} commune(s)</Badge>
                : o.scope.source==="déduit"  ? <Badge tone="y">déduit · {o.scope.communes}</Badge>
                : <Badge tone="r">aucun</Badge>}</Td>
              <Td className="text-slate-600 f115">{(o.antennes||[]).join(", ") || "—"}</Td>
              <Td className="text-slate-600">{o.manager || "—"}</Td>
              <Td num>{o.usage.sites || "—"}</Td>
              <Td num>{o.usage.users || "—"}</Td>
              <Td>{o.active ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>}</Td>
              <Td className="text-right whitespace-nowrap">{can("admin") && (<>
                <button onClick={()=>setEdit({ ...o })} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>
                <button onClick={()=>supprimer(o)}
                  title={Object.values(o.usage).reduce((a,b)=>a+b,0) ? "Bureau référencé : désactivez-le" : "Supprimer"}
                  className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button></>)}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>

      {!nat && (
        <Note tone="warn"><b>Aucun bureau à périmètre national.</b> Les staffs du bureau
          pays qui ne sont pas administrateurs ne voient que les sites rattachés à leur
          bureau. Passez le bureau central en périmètre national pour leur ouvrir
          l'ensemble, sans leur donner la gestion des comptes.</Note>)}

      <OfficeModal open={!!edit} office={edit} busy={busy}
        onClose={()=>setEdit(null)} onSave={enregistrer} />
    </>);
}

function OfficeModal({ open, office, busy, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(office ? { ...office, antennes:[...(office.antennes||[])] }
                              : { kind:"field", scope_mode:"geo", active:true, antennes:[] }); },[office]);
  if(!open) return null;
  const u = (k,v)=>setF(p=>({ ...p, [k]:v }));
  const antenne = (i,v)=>setF(p=>{ const a=[...p.antennes]; a[i]=v; return { ...p, antennes:a }; });
  const MODES = [
    ["geo","Périmètre déclaré","Les comptes de ce bureau ne voient que les unités qui lui sont attribuées."],
    ["national","Périmètre national","Les comptes de ce bureau voient tous les sites du pays, sans droit d'administration."],
  ];
  return (
    <Modal open onClose={onClose} title={office?.id ? "Modifier le bureau" : "Nouveau bureau"}
      subtitle="Identité, nature, périmètre et antennes de rattachement"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || !(f.name||"").trim()} onClick={()=>onSave(f)}>
          {busy ? "Enregistrement…" : "Enregistrer"}</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Nom du bureau"><Input value={f.name||""} onChange={e=>u("name",e.target.value)}
          placeholder="Bureau de terrain de …" /></Field>
        <Field label="Code" hint="Court, utilisé dans les exports et les modèles">
          <Input value={f.code||""} onChange={e=>u("code",e.target.value)} /></Field>
        <Field label="Nature">
          <Select value={f.kind||"field"} onChange={e=>u("kind",e.target.value)}
            options={[["field","Bureau de terrain"],["hq","Bureau pays"]]} /></Field>
        <Field label="Responsable"><Input value={f.manager||""} onChange={e=>u("manager",e.target.value)} /></Field>
        <Field label="Adresse électronique"><Input type="email" value={f.email||""} onChange={e=>u("email",e.target.value)} /></Field>
        <Field label="Téléphone"><Input value={f.phone||""} onChange={e=>u("phone",e.target.value)} /></Field>
        <Field label="Latitude" hint="Position du bureau, pour la cartographie">
          <Input type="number" value={f.lat ?? ""} onChange={e=>u("lat",e.target.value)} /></Field>
        <Field label="Longitude">
          <Input type="number" value={f.lon ?? ""} onChange={e=>u("lon",e.target.value)} /></Field>
      </div>

      <Field label="Mode de périmètre" hint="Le rôle dit ce qu'un compte peut faire ; le périmètre dit où">
        <div className="grid gap-1.5">
          {MODES.map(([k,label,desc])=>(
            <label key={k} className={clsx("flex items-start gap-3 px-3 py-2 rounded border cursor-pointer",
              (f.scope_mode||"geo")===k ? "bd-brand bg-sky-50" : "border-slate-200 hover:bg-slate-50")}>
              <input type="radio" name="scope_mode" className="mt-1"
                checked={(f.scope_mode||"geo")===k} onChange={()=>u("scope_mode",k)} />
              <div><div className="f13 font-semibold text-slate-800">{label}</div>
                <div className="f115 text-slate-500">{desc}</div></div></label>))}
        </div></Field>

      <Field label="Antennes" hint="Lieux de rattachement des visites — ce ne sont pas des bureaux : pas de comptes ni de périmètre propre">
        <div className="space-y-1.5">
          {(f.antennes||[]).map((a,i)=>(<div key={i} className="flex gap-1.5">
            <input value={a} onChange={e=>antenne(i,e.target.value)} className={clsx(inputCls,"mi-py1")} />
            <button onClick={()=>u("antennes",(f.antennes||[]).filter((_,j)=>j!==i))}
              className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button></div>))}
          <Btn size="sm" kind="sec" icon={Plus}
            onClick={()=>u("antennes",[...(f.antennes||[]),""])}>Ajouter une antenne</Btn>
        </div></Field>

      <Field label="Note"><Input value={f.note||""} onChange={e=>u("note",e.target.value)} /></Field>
      <Sw label="Bureau actif" hint="Un bureau inactif reste dans l'historique ; il ne peut être désactivé s'il porte encore des comptes actifs"
        on={f.active!==false} onChange={v=>u("active",v)} />
      {office?.id && !!Object.values(office.usage||{}).reduce((a,b)=>a+b,0) && (
        <Note>Ce bureau est référencé par {office.usage.sites} site(s), {office.usage.users} compte(s),
          {" "}{office.usage.params} paramètre(s) de couverture, {office.usage.visits} visite(s)
          et {office.usage.pdd} ligne(s) de plan de distribution. Le renommer met à jour
          l'ensemble ; il ne peut pas être supprimé.</Note>)}
    </Modal>);
}

function SetScope({ db, notify, can }){
  const [rows,setRows]   = useState([]);
  const [edit,setEdit]   = useState(null);   /* bureau en cours d'édition */
  const [sel,setSel]     = useState(new Set());
  const [region,setRegion] = useState("");
  const [busy,setBusy]   = useState(false);
  const geo = useGeoCascade({ adm1: region });

  const charger = () => api.geoScope().then(r=>setRows(r.rows||[])).catch(()=>{});
  useEffect(()=>{ charger(); },[]);

  const ouvrir = (o) => { setEdit(o); setSel(new Set(o.units.map(u=>u.pcode))); setRegion(""); };
  const bascule = (pcode) => setSel(s => {
    const n = new Set(s); n.has(pcode) ? n.delete(pcode) : n.add(pcode); return n; });

  const enregistrer = async () => {
    setBusy(true);
    try{
      const r = await api.setGeoScope(edit.office_id, [...sel]);
      notify(`Périmètre enregistré : ${r.communes} commune(s) couverte(s)`, "ok");
      setEdit(null); charger();
    }catch(e){ notify("Refusé : " + e.message, "err"); }
    setBusy(false);
  };

  if(!db.geoVersion) return (
    <Note tone="warn"><b>Aucun référentiel chargé.</b> Le périmètre d'un bureau s'exprime
      en unités administratives. Chargez un millésime depuis Paramètres → Localités.</Note>);

  return (
    <>
      <Note>Un bureau couvre les unités qui lui sont <b>attribuées</b>, à n'importe quel
        niveau — le plus souvent un district. Le périmètre effectif est tout ce qui en
        descend. Tant qu'aucune unité n'est attribuée, il est <b>déduit</b> des sites et
        du plan de distribution du bureau : c'est un repli, pas une intention.
        <br /><br />
        Ce périmètre borne ce qu'un compte rattaché à ce bureau peut lire et écrire —
        population, ciblage, couverture géographique, et les lignes que ses modèles
        d'import contiennent.</Note>

      <Card flush title="Périmètre par bureau"
        subtitle={`${rows.length} bureau(x) · ${rows.filter(r=>r.source==="déclaré").length} avec un périmètre déclaré`}>
        <TableWrap max="mh480">
          <thead><tr><Th>Bureau</Th><Th>Code</Th><Th>Origine</Th><Th>Unités attribuées</Th>
            <Th num>Communes couvertes</Th><Th>Cohérence</Th><Th /></tr></thead>
          <tbody>{rows.map(o=>(
            <tr key={o.office_id} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{o.name}</Td>
              <Td className="f115 text-slate-500">{o.code}</Td>
              {/* Le critère est le mode de périmètre du bureau, pas sa nature :
                  un bureau de terrain peut être déclaré national, et l'inverse. */}
              <Td>{o.source==="national"
                ? <Badge tone="b">national — tous les sites</Badge>
                : o.source==="déclaré" ? <Badge tone="g">déclaré</Badge>
                : o.source==="déduit" ? <Badge tone="y">déduit</Badge>
                : <Badge tone="r">aucun</Badge>}</Td>
              <Td>{o.units.length
                ? <div className="flex gap-1 flex-wrap">{o.units.slice(0,6).map(u=>(
                    <Badge key={u.pcode}>{u.name}</Badge>))}
                    {o.units.length>6 && <Badge>+{o.units.length-6}</Badge>}</div>
                : <span className="text-slate-400">—</span>}</Td>
              <Td num>{o.communes || "—"}</Td>
              <Td>{o.horsPerimetre && (o.horsPerimetre.sites || o.horsPerimetre.pdd)
                ? <Badge tone="y">
                    {o.horsPerimetre.sites ? `${o.horsPerimetre.sites} site(s)` : ""}
                    {o.horsPerimetre.sites && o.horsPerimetre.pdd ? " · " : ""}
                    {o.horsPerimetre.pdd ? `${o.horsPerimetre.pdd} ligne(s) PDD` : ""} hors périmètre
                  </Badge>
                : <span className="text-slate-400">—</span>}</Td>
              <Td className="text-right">{can("admin") && o.source!=="national" &&
                <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>ouvrir(o)}>Modifier</Btn>}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>

      {rows.some(o => o.horsPerimetre && (o.horsPerimetre.sites || o.horsPerimetre.pdd)) && (
        <Note tone="warn"><b>Données hors périmètre.</b> Certains sites ou lignes de plan sont
          rattachés à des unités qui ne figurent pas dans le périmètre déclaré de leur bureau.
          Ce n'est pas une erreur — les données peuvent précéder la déclaration — mais l'un des
          deux mérite d'être corrigé : élargir le périmètre, ou réaffecter les données.</Note>)}

      <Modal open={!!edit} wide onClose={()=>setEdit(null)}
        title={edit ? `Périmètre de ${edit.name}` : ""}
        subtitle="Attribuez des districts, ou des communes pour un découpage plus fin"
        footer={<><Btn kind="sec" onClick={()=>setEdit(null)}>Annuler</Btn>
          <Btn icon={Save} onClick={enregistrer} disabled={busy}>
            {busy ? "Enregistrement…" : `Enregistrer ${sel.size} unité(s)`}</Btn></>}>
        {edit && (<>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Région" hint="Pour parcourir les districts">
              <Select value={region} onChange={e=>setRegion(e.target.value)} empty="Choisir une région"
                options={geo.adm1.map(x=>x.name)} /></Field>
            <div className="self-end pb-3 f125 text-slate-600">
              {sel.size} unité(s) attribuée(s)
              {!!sel.size && <button onClick={()=>setSel(new Set())}
                className="ml-2 c-bd hover:underline">tout retirer</button>}
            </div>
          </div>

          {!region ? (
            <div className="py-8 text-center f125 text-slate-500">
              Choisissez une région pour voir ses districts.</div>
          ) : (
            <TableWrap max="mh300">
              <thead><tr><Th className="w-14" /><Th>District</Th><Th>P-code</Th><Th /></tr></thead>
              <tbody>{geo.adm2.map(d=>(
                <tr key={d.pcode} className={clsx("hover:bg-sky-50", sel.has(d.pcode) && "bg-sky-50")}>
                  <Td><input type="checkbox" checked={sel.has(d.pcode)}
                    onChange={()=>bascule(d.pcode)} /></Td>
                  <Td className="font-medium text-slate-800">{d.name}</Td>
                  <Td className="f115 c-bd">{d.pcode}</Td>
                  <Td /></tr>))}</tbody>
            </TableWrap>)}

          {!!sel.size && (
            <div className="mt-4 pt-3 border-t border-slate-100">
              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                Unités retenues</div>
              <div className="flex gap-1.5 flex-wrap">
                {[...sel].map(pc => {
                  const connu = [...geo.adm2, ...geo.adm3].find(x=>x.pcode===pc)
                    || edit.units.find(u=>u.pcode===pc);
                  return (<button key={pc} onClick={()=>bascule(pc)}
                    className="px-2 py-0.5 rounded f11 font-semibold bg-sky-50 border border-sky-200 c-bd hover:bg-rose-50 hover:border-rose-200">
                    {connu?.name || pc} ✕</button>);
                })}
              </div>
              <p className="f115 text-slate-500 mt-2">Cliquez pour retirer. Les unités
                d'autres régions restent attribuées même si elles ne sont pas listées ci-dessus.</p>
            </div>)}
        </>)}
      </Modal>
    </>);
}

/* ── Localités : référentiel administratif versionné ──
   Le découpage n'est plus une liste plate éditable ligne à ligne : c'est un arbre
   (région → district → commune → fokontany) chargé par millésime. Sites, population
   et distributions s'y raccrochent, donc il ne se modifie pas à la main — on importe
   un nouveau millésime, et l'ancien reste disponible. */
function SetLocations({ db, notify, can, reload }){
  const [draft,setDraft] = useState(null); const [status,setStatus] = useState(null);
  const [map,setMap] = useState({}); const [label,setLabel] = useState("");
  const [depth,setDepth] = useState("adm4"); const [busy,setBusy] = useState(false);
  const [versions,setVersions] = useState([]);
  /* Import des contours — indépendant de l'import du découpage : on charge d'abord
     l'arbre (qui donne les p-codes), les géométries s'y rattachent ensuite. */
  const [geomDraft,setGeomDraft] = useState(null);
  const [geomMap,setGeomMap] = useState({});
  const [geomStat,setGeomStat] = useState(null);
  const [geomBusy,setGeomBusy] = useState(false);

  /* Répertoire : filtres en cascade et pagination, tout vient du serveur. */
  const [sel,setSel] = useState({ adm1:"", adm2:"", adm3:"" });
  const [q,setQ] = useState(""); const [page,setPage] = useState(0);
  const [dir,setDir] = useState({ rows:[], total:0, version:null, loading:true });
  const geo = useGeoCascade(sel);
  const PER = 200;

  const loadVersions = () => api.geoVersions().then(r=>setVersions(r.rows||[])).catch(()=>{});
  useEffect(()=>{ loadVersions(); },[]);

  /* Un import ou un changement de millésime courant remplacent les données que sert
     le serveur sans forcément changer le filtre affiché (sel/q/page restent à leurs
     valeurs déjà courantes) : rien ne redéclenchait alors la requête, et le répertoire
     continuait d'afficher l'ancien millésime jusqu'au prochain filtre touché à la
     main — ou un rechargement complet de la page. `refresh` force le nouvel appel
     même quand aucune de ces valeurs n'a changé. */
  const [refresh,setRefresh] = useState(0);
  /* Le parent le plus profond réellement choisi borne la requête. */
  const parent = geo.codes.adm3 || geo.codes.adm2 || geo.codes.adm1 || "";
  useEffect(()=>{
    let alive = true;
    setDir(d=>({ ...d, loading:true }));
    const qs = new URLSearchParams({ level:"adm4", limit:String(PER), offset:String(page*PER) });
    if(parent) qs.set("parent", parent);
    if(q.trim()) qs.set("search", q.trim());
    const id = setTimeout(() => {
      api.geo("?"+qs).then(r => { if(alive) setDir({ ...r, loading:false }); })
        .catch(e => { if(alive) setDir({ rows:[], total:0, version:null, loading:false, error:e.message }); });
    }, q ? 280 : 0);                       /* la recherche attend la fin de la frappe */
    return () => { alive = false; clearTimeout(id); };
  }, [parent, q, page, refresh]);
  useEffect(()=>{ setPage(0); }, [parent, q]);

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
      setLabel(file.name.replace(/\.[^.]+$/,"") + " — " + new Date().toISOString().slice(0,10));
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

  /* L'écriture passe par le serveur : il reconstruit l'arbre, en une transaction. */
  const commit = async () => {
    if(!draft || !preview.length){
      notify("Aucune localité exploitable : vérifiez la correspondance des champs", "err"); return;
    }
    setBusy(true);
    try{
      const rows = preview.map(g => ({ adm0:g.adm0 || null, adm1:g.adm1 || null, adm2:g.adm2 || null,
        adm3:g.adm3 || null, adm4:g.adm4 || null, pcode:g.code || null,
        lat: g.lat === "" ? null : Number(g.lat), lon: g.lon === "" ? null : Number(g.lon) }));
      const r = await api.importGeo(rows, label.trim() || `Import du ${new Date().toISOString().slice(0,10)}`,
        draft.src || null);
      resetGeoCache(); setDraft(null); setSel({ adm1:"", adm2:"", adm3:"" }); setPage(0);
      setRefresh(x=>x+1);
      await loadVersions();
      /* db.geoVersion (carte « Référentiel courant ») vient de l'état global, chargé
         une fois au démarrage : sans ce rechargement, elle continue d'afficher
         l'ancien millésime bien après que le nouveau soit devenu courant. */
      if(reload) await reload();
      const c = r.counts || {};
      setStatus({ kind:"ok", text:`${r.imported.toLocaleString("fr-FR")} unités enregistrées — `
        + [["adm1","régions"],["adm2","districts"],["adm3","communes"],["adm4","fokontany"]]
            .filter(([k])=>c[k]).map(([k,l])=>`${c[k].toLocaleString("fr-FR")} ${l}`).join(", ")
        + (r.rejected ? ` · ${r.rejected} ligne(s) écartée(s)` : "") });
      notify(`Référentiel importé : ${r.imported.toLocaleString("fr-FR")} unités`, "ok");
    }catch(e){
      setStatus({ kind:"err", text:e.message + (e.details ? " — " + JSON.stringify(e.details).slice(0,180) : "") });
      notify("Import refusé : " + e.message, "err");
    }
    setBusy(false);
  };

  const activate = async (id, lb) => {
    try{ await api.setGeoVersion(id); resetGeoCache();
      setSel({ adm1:"", adm2:"", adm3:"" }); setPage(0); setRefresh(x=>x+1); await loadVersions();
      if(reload) await reload();
      notify(`Référentiel courant : « ${lb} »`, "ok");
    }catch(e){ notify("Changement refusé : " + e.message, "err"); }
  };

  const exp = () => download("localites.csv",
    toCSV(dir.rows, ["adm1","adm2","adm3","adm4","pcode","lat","lon"]), "text/csv");

  /* ── Contours ───────────────────────────────────────────────────────
     La lecture se fait dans le navigateur, comme pour le découpage ; ce qui part
     au serveur est la géométrie déjà extraite, par lots. Le serveur la simplifie
     et en garde deux résolutions : la version fine ne s'affiche qu'au zoom, et
     servir 18 000 contours en pleine résolution arrêterait le navigateur. */
  const onGeomFile = async (file) => {
    setGeomStat({ kind:"info", text:"Lecture des contours… cela peut prendre un moment sur un fichier de fokontany." });
    try{
      const d = await readGeoFile(file, { withGeometry:true });
      const avec = (d.geom || []).filter(Boolean).length;
      if(!avec) throw new Error("Aucun contour trouvé : ce fichier ne contient que des points ou une table attributaire. Il faut le .shp, ou un .geojson de polygones.");
      setGeomDraft(d);
      setGeomMap({ adm1:guessField(d.fields,GUESS.adm1), adm2:guessField(d.fields,GUESS.adm2),
        adm3:guessField(d.fields,GUESS.adm3), adm4:guessField(d.fields,GUESS.adm4),
        code:guessField(d.fields,GUESS.code) });
      setGeomStat({ kind:"ok", text:`${fmt(avec)} contour(s) lus sur ${fmt(d.rows.length)} objets · ${d.fields.length} champs attributaires` });
    }catch(e){ setGeomDraft(null); setGeomStat({ kind:"err", text:e.message }); }
  };

  const commitGeom = async () => {
    if(!geomDraft) return;
    setGeomBusy(true);
    const LOT = 120;   /* un lot de contours de commune pèse déjà quelques mégaoctets */
    let envoyes = 0, ecrites = 0, rejetes = 0; const motifs = [];
    try{
      const items = geomDraft.rows.map((r, i) => {
        const g = geomDraft.geom[i];
        if(!g) return null;
        const names = {};
        for(const k of ["adm1","adm2","adm3","adm4"])
          if(geomMap[k] && r[geomMap[k]]) names[k] = String(r[geomMap[k]]);
        if(!Object.keys(names).length && !geomMap.code) return null;
        return { pcode: geomMap.code ? String(r[geomMap.code] ?? "") || undefined : undefined,
                 names, geometry:g };
      }).filter(Boolean);
      if(!items.length) throw new Error("Aucun contour rattachable : indiquez au moins un champ de nom administratif");

      for(let i = 0; i < items.length; i += LOT){
        const lot = items.slice(i, i + LOT);
        const r = await api.importGeometry(lot, { reset: i === 0, source: geomDraft.src });
        envoyes += lot.length; ecrites += r.écrites; rejetes += r.rejetes;
        if(r.rejets?.length && motifs.length < 8) motifs.push(...r.rejets.slice(0, 3));
        setGeomStat({ kind:"info",
          text:`Envoi… ${fmt(envoyes)} / ${fmt(items.length)} — ${fmt(ecrites)} rattaché(s)` });
        /* On libère au fur et à mesure : garder tous les contours en mémoire pendant
           l'envoi ferait doubler l'empreinte pour rien. */
        for(let k = i; k < i + LOT && k < geomDraft.geom.length; k++) geomDraft.geom[k] = null;
      }
      await loadVersions();
      setGeomDraft(null);
      setGeomStat({ kind: rejetes ? "warn" : "ok",
        text: `${fmt(ecrites)} contour(s) enregistré(s)` +
          (rejetes ? ` · ${fmt(rejetes)} non rattaché(s) : ${motifs.map(m=>m.pcode).filter(Boolean).slice(0,3).join(", ")}…` : "") });
      notify(`Contours administratifs enregistrés — ${fmt(ecrites)} unité(s)`, rejetes ? "warn" : "ok");
    }catch(e){ setGeomStat({ kind:"err", text:e.message }); notify(e.message, "err"); }
    setGeomBusy(false);
  };

  const cur = db.geoVersion;
  const pages = Math.ceil(dir.total / PER);
  return (
    <>
      <Note>Importez le découpage administratif du niveau 0 au niveau 4 depuis une archive <b>.zip</b> contenant
        un shapefile, ou un fichier <b>.shp</b>, <b>.dbf</b> ou <b>.geojson</b>. La lecture se fait entièrement dans
        le navigateur, aucun fichier n'est transmis à un serveur. Lorsque la table attributaire porte déjà des
        colonnes de centroïdes — <code className="bg-white px-1 rounded">X</code> et
        <code className="bg-white px-1 rounded mx-1">Y</code>, ou latitude et longitude — la géométrie n'est pas
        ouverte du tout. Les coordonnées doivent être en WGS 84.
        <br /><br />
        Pour le référentiel complet de Madagascar — environ 18 000 fokontany — préférez la ligne de commande,
        qui lit le fichier sans le charger en mémoire :
        <code className="bg-white px-1 rounded mx-1">node src/import-geo.js fichier.csv --label "COD-AB v2023.1"</code>
      </Note>

      {cur ? (
        <Card title="Référentiel courant" subtitle={`« ${cur.label} » — importé le ${String(cur.importedAt||"").slice(0,10)}`}>
          <StatRow>
            {/* Les libellés viennent du pays configuré, pas du code. */}
            {niveaux(db, { from:"adm1", to:"adm4" }).map(([k,l])=>(
              <Stat key={k} label={l} value={fmt(cur.counts?.[k] || 0)} />))}
            <Stat label="Total des unités" value={fmt(cur.units)} />
          </StatRow>
        </Card>
      ) : (
        <Note tone="warn"><b>Aucun référentiel chargé.</b> Les listes administratives resteront vides
          tant qu'un découpage n'aura pas été importé.</Note>
      )}

      {/* ── Contours administratifs ──────────────────────────────────────
          Le référentiel ne portait que des points, et la carte projetait des cercles
          sur un fond vide : une commune non couverte n'apparaissait nulle part. Les
          contours sont ce qui permet de la dessiner — et donc de la voir. */}
      <Card title="Contours administratifs — fond de carte"
        subtitle={cur?.geom?.units
          ? `${fmt(cur.geom.units)} unité(s) avec contour${cur.geom.source ? ` · ${cur.geom.source}` : ""}`
          : "aucun contour : la cartographie n'a pas de fond"}
        right={can("admin") && cur?.geom?.units > 0 &&
          <Btn size="sm" kind="sec" icon={Trash2} disabled={geomBusy}
            onClick={async ()=>{ if(!confirm("Retirer tous les contours de ce millésime ?")) return;
              try{ const r = await api.clearGeometry(); await loadVersions();
                notify(`${fmt(r.supprimes)} contour(s) retiré(s)`, "ok");
              }catch(e){ notify(e.message, "err"); } }}>Retirer les contours</Btn>}>

        {!cur ? (
          <Note tone="warn">Chargez d'abord un découpage : les contours se rattachent à
            l'arbre administratif, ils ne le créent pas.</Note>
        ) : (<>
          {!!cur.geom?.parNiveau?.length && (
            <StatRow>
              {cur.geom.parNiveau.map(x=>(
                <Stat key={x.level} label={niveau(db, x.level, true)}
                  value={fmt(x.units)}
                  sub={`${fmt(x.points_simple)} sommets affichés sur ${fmt(x.points)}`} />))}
            </StatRow>)}

          <Note>Chargez le <b>.shp</b> (ou son archive <b>.zip</b>, ou un <b>.geojson</b> de polygones)
            du niveau voulu. Le fichier est lu <b>dans le navigateur</b> ; seules les géométries
            extraites partent au serveur, par lots. Le serveur les <b>simplifie</b> et en conserve
            deux résolutions : la version allégée pour la vue d'ensemble, la version fine pour le zoom —
            sans quoi un pays de 18 000 fokontany ne s'afficherait pas.
            <br /><br />
            Le rattachement se fait par <b>chemin de noms</b> (région, district, commune, fokontany),
            comme pour les sites : les p-codes du référentiel sont dérivés du chemin, et un fichier de
            contours porte rarement les mêmes que celui du découpage. Importez un niveau à la fois.</Note>

          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Fichier de contours">
              <input type="file" accept=".zip,.shp,.geojson,.json" disabled={!can("admin") || geomBusy}
                onChange={e=>e.target.files[0]&&onGeomFile(e.target.files[0])}
                className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
            <div className="self-center">{geomStat && <Note tone={geomStat.kind}>{geomStat.text}</Note>}</div>
          </div>

          {geomDraft && (<>
            <div className="grid grid-cols-5 gap-x-3">
              {[...niveaux(db, { from:"adm1", to:"adm4", plural:false }),
                ["code","P-code (optionnel)"]].map(([k,l])=>(
                <Field key={k} label={l}>
                  <Select value={geomMap[k]||""} onChange={e=>setGeomMap(m=>({...m,[k]:e.target.value}))}
                    empty="—" options={geomDraft.fields} className="mi-py1" /></Field>))}
            </div>
            <div className="flex items-center gap-3">
              <Btn icon={Upload} disabled={geomBusy || !can("admin")} onClick={commitGeom}>
                {geomBusy ? "Envoi en cours…" : "Enregistrer les contours"}</Btn>
              <Btn kind="sec" disabled={geomBusy} onClick={()=>{ setGeomDraft(null); setGeomStat(null); }}>
                Annuler</Btn>
              <span className="f115 text-slate-500">
                Le niveau est déduit du champ de nom le plus profond que vous désignez.</span>
            </div>
          </>)}
        </>)}
      </Card>

      <Card title="Importer un découpage administratif"
        right={<Btn size="sm" kind="sec" icon={Download} onClick={exp} disabled={!dir.rows.length}>Exporter la page</Btn>}>
        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Fichier du découpage">
            <input type="file" accept=".zip,.shp,.dbf,.geojson,.json" disabled={!can("admin")}
              onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}
              className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
          <div className="self-center">{status && <Note tone={status.kind}>{status.text}</Note>}</div>
        </div>
        {!can("admin") && <Note tone="warn">L'import du découpage est réservé aux administrateurs.</Note>}
        {draft && (
          <>
            <div className="grid grid-cols-4 gap-x-3">
              {[["adm0","Niveau 0 — pays"],["adm1","Niveau 1 — région"],["adm2","Niveau 2 — district"],
                ["adm3","Niveau 3 — commune"],["adm4","Niveau 4 — fokontany"],["code","Code administratif"]].map(([k,l])=>(
                <Field key={k} label={l}><Select value={map[k]||""} onChange={e=>setMap(m=>({...m,[k]:e.target.value}))}
                  empty="— aucun —" options={draft.fields} /></Field>))}
              <Field label="Niveau de détail à conserver"
                hint="Le niveau le plus fin peut représenter des dizaines de milliers d'entrées">
                <Select value={depth} onChange={e=>setDepth(e.target.value)}
                  options={[["adm1","Jusqu'au niveau 1"],["adm2","Jusqu'au niveau 2"],
                            ["adm3","Jusqu'au niveau 3"],["adm4","Niveau 4 complet"]]} /></Field>
              <Field label="Nom du millésime" hint="Il identifie ce chargement dans l'historique">
                <Input value={label} onChange={e=>setLabel(e.target.value)} placeholder="COD-AB v2023.1" /></Field>
            </div>
            <Note tone="info">
              <b>{preview.length.toLocaleString("fr-FR")} lignes</b> seront envoyées
              {depth !== "adm4" && " après regroupement des doublons"}, dont{" "}
              {preview.filter(g => g.lat !== "").length.toLocaleString("fr-FR")} avec coordonnées.
              Le serveur en déduit l'arbre complet : les niveaux supérieurs sont créés une seule fois,
              quel que soit le nombre de lignes qui les répètent.
            </Note>
            <TableWrap max="mh240">
              <thead><tr>{["Niveau 0","Niveau 1","Niveau 2","Niveau 3","Niveau 4","Code","Latitude","Longitude"].map(h=><Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>{preview.slice(0,8).map((g,i)=>(
                <tr key={i}>{["adm0","adm1","adm2","adm3","adm4","code"].map(k=><Td key={k}>{g[k]}</Td>)}
                  <Td num className="f11">{g.lat}</Td><Td num className="f11">{g.lon}</Td></tr>))}</tbody>
            </TableWrap>
            <Btn className="mt-3" icon={Upload} disabled={busy || !preview.length || !can("admin")} onClick={commit}>
              {busy ? "Import en cours…" : `Importer ${preview.length.toLocaleString("fr-FR")} lignes`}</Btn>
          </>)}
      </Card>

      {versions.length > 1 && (
        <Card flush title="Millésimes" subtitle="Changer de millésime ne perd rien : les précédents restent disponibles">
          <TableWrap>
            <thead><tr><Th>Millésime</Th><Th>Provenance</Th><Th num>Unités</Th><Th>Importé le</Th><Th>Par</Th><Th /></tr></thead>
            <tbody>{versions.map(v=>(
              <tr key={v.id} className={clsx("hover:bg-sky-50", v.current && "bg-sky-50")}>
                <Td><b>{v.label}</b>{v.current && <Badge tone="g" className="ml-2">courant</Badge>}</Td>
                <Td className="text-slate-500">{v.source || "—"}</Td>
                <Td num>{fmt(v.units)}</Td>
                <Td className="f115">{String(v.importedAt||"").slice(0,16)}</Td>
                <Td className="text-slate-500">{v.importedBy || "—"}</Td>
                <Td className="text-right">{!v.current && can("admin") &&
                  <Btn size="sm" kind="sec" icon={RefreshCw} onClick={()=>activate(v.id, v.label)}>Activer</Btn>}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </Card>)}

      <Card flush title="Répertoire des localités"
        subtitle={dir.loading ? "Chargement…"
          : `${fmt(dir.total)} fokontany dans la sélection · page ${page+1} sur ${Math.max(1,pages)}`}
        right={<>
          <Select value={sel.adm1} onChange={e=>setSel({ adm1:e.target.value, adm2:"", adm3:"" })}
            empty="Toutes les régions" options={geo.adm1.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" />
          <Select value={sel.adm2} onChange={e=>setSel(s=>({ ...s, adm2:e.target.value, adm3:"" }))}
            empty="Tous les districts" options={geo.adm2.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto"
            disabled={!sel.adm1} />
          <Select value={sel.adm3} onChange={e=>setSel(s=>({ ...s, adm3:e.target.value }))}
            empty="Toutes les communes" options={geo.adm3.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto"
            disabled={!sel.adm2} />
          <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Rechercher…" className={clsx(inputCls,"pl-7 mi-py1 w-44")} /></div></>}>
        <TableWrap>
          <thead><tr>{[...niveaux(db, { from:"adm1", to:"adm4", plural:false }).map(x=>x[1]),
            "P-code"].map(h=><Th key={h}>{h}</Th>)}
            <Th num>Latitude</Th><Th num>Longitude</Th><Th num>Sites</Th></tr></thead>
          <tbody>{dir.rows.map(g=>{
            const cnt = db.sites.filter(s=>g.adm3 && s.adm3===g.adm3).length;
            return (<tr key={g.pcode} className="hover:bg-sky-50">
              <Td className="text-slate-500">{g.adm1||"—"}</Td><Td className="text-slate-500">{g.adm2||"—"}</Td>
              <Td>{g.adm3||"—"}</Td><Td className="font-medium text-slate-800">{g.name}</Td>
              <Td className="f115 c-bd">{g.pcode}</Td>
              <Td num className="f115">{g.lat ?? "—"}</Td><Td num className="f115">{g.lon ?? "—"}</Td>
              <Td num className="text-slate-500">{cnt||""}</Td>
            </tr>); })}</tbody>
        </TableWrap>
        {!dir.loading && !dir.rows.length && (
          <div className="px-4 py-8 text-center f125 text-slate-500">
            {dir.error ? dir.error : "Aucune localité dans cette sélection."}</div>)}
        {pages > 1 && (
          <div className="px-4 py-2 flex items-center gap-2 f115 text-slate-500 border-t border-slate-100">
            <Btn size="sm" kind="sec" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
            <span>{fmt(page*PER+1)} – {fmt(Math.min((page+1)*PER, dir.total))} sur {fmt(dir.total)}</span>
            <Btn size="sm" kind="sec" disabled={page>=pages-1} onClick={()=>setPage(p=>p+1)}>Suivant</Btn>
          </div>)}
      </Card>
    </>);
}

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

/* ── Rations (PDD) ── */
function SetRations({ db, set, notify, can }){
  const [actType,setActType] = useState(PDD_ACTS[0][0]);
  const table = db.settings.rationTable || {};
  const row = table[actType] || {};
  const u = (commodity, v) => set(d => {
    d.settings.rationTable = d.settings.rationTable || {};
    d.settings.rationTable[actType] = { ...(d.settings.rationTable[actType]||{}), [commodity]: v };
    return d; });
  const clearAct = () => { set(d => { d.settings.rationTable = d.settings.rationTable || {};
    d.settings.rationTable[actType] = {}; return d; }); notify("Rations réinitialisées pour cette activité","ok"); };
  const configured = PDD_COMMODITIES.filter(c => n(row[c])>0);
  const sample = 1000, days = 15;
  return (
    <>
      <Note>Ration journalière par bénéficiaire (grammes/personne/jour), par denrée et par type d'activité —
        une donnée de programme propre à chaque opération, à saisir ici plutôt qu'à deviner. Elle alimente le
        bouton « Générer par commune » du plan de distribution (PDD) : une ligne y est créée automatiquement
        pour chaque denrée dont la ration est renseignée, avec un tonnage calculé (bénéficiaires × jours de
        ration × ration ÷ 1 000 000).</Note>
      <div className="flex items-center gap-2 mb-4">
        <Select value={actType} onChange={e=>setActType(e.target.value)} options={PDD_ACTS} className="mi-wauto" />
        {can("edit") && <Btn kind="ghost" size="sm" icon={Trash2} onClick={clearAct}>Réinitialiser cette activité</Btn>}
      </div>
      <Card flush title={`Rations — ${(PDD_ACTS.find(a=>a[0]===actType)||[])[1]}`}
        subtitle={`Aperçu sur ${fmt(sample)} bénéficiaires, ${days} jours de ration`}>
        <TableWrap>
          <thead><tr><Th>Denrée</Th><Th num>Ration (g/personne/jour)</Th><Th num>Tonnage d'essai (t)</Th></tr></thead>
          <tbody>{PDD_COMMODITIES.map(c=>{
            const g = n(row[c]);
            const t = r2(sample*days*g/1e6);
            return (
              <tr key={c} className="hover:bg-sky-50">
                <Td className="font-medium">{c}</Td>
                <Td num><Input type="number" min="0" step="1" disabled={!can("edit")} value={row[c] ?? ""}
                  onChange={e=>u(c, e.target.value===""?"":Math.max(0,n(e.target.value)))}
                  className="mi-py1 w-24 text-right ml-auto" /></Td>
                <Td num className="tabular-nums text-slate-500">{g>0?t:"—"}</Td>
              </tr>); })}</tbody>
        </TableWrap>
      </Card>
      {!configured.length && <Note tone="warn">Aucune ration n'est encore paramétrée pour cette activité — le
        bouton « Générer par commune » du PDD n'y proposera aucune denrée tant que ceci n'est pas rempli.</Note>}
    </>);
}

/* ── ODK Central ── */
function SetOdk({ db, set, notify, can, reload }){
  const [edit,setEdit] = useState(null);
  const [pulling,setPulling] = useState(null);
  const s = db.settings; const u=(k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const save = (f) => { set(d => { const i=d.odkForms.findIndex(x=>x.id===f.id);
      if(i>=0) d.odkForms[i]=f; else d.odkForms.push({ ...f, id:uid("f"), records:0, last:"", rows:[] }); return d; });
    setEdit(null); notify("Source enregistrée","ok"); };
  const pull = async (f) => {
    setPulling(f.id);
    try{
      const r = await api.post(`/odk-forms/${f.id}/pull`);
      notify(r.avertissement || `${r.records} soumission(s) tirée(s) d'ODK Central`, r.avertissement ? "warn" : "ok");
      if(reload) await reload();
    }catch(e){ notify(e.message || "tirage impossible", "err"); }
    setPulling(null);
  };
  return (
    <>
      <Note tool><b>Adresse d'appel.</b> Un formulaire ODK Central est lu à l'adresse
        <code className="bg-white px-1.5 py-0.5 rounded mx-1 f115">{s.odkBase}/v1/projects/&#123;projet&#125;/forms/&#123;formulaire&#125;.svc/Submissions</code>
        avec un jeton dans l'en-tête d'autorisation. Chaque source déclare le type de données qu'elle apporte,
        le champ qui identifie le site, et peut recevoir son XLSForm pour restituer les libellés des questions
        à la place des noms techniques. Le bouton <RefreshCw size={11} className="inline align-text-top" /> tire
        les soumissions réelles depuis le serveur — il exige un <b>jeton propre à cette source</b> : le jeton
        général ci-contre reste dans votre navigateur et n'est jamais envoyé au serveur.</Note>
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
              <Th>Champ site</Th><Th>Jeton</Th><Th>XLSForm</Th><Th num>Enreg.</Th><Th>Dernier tirage</Th><Th /></tr></thead>
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
                <Td className="f115 text-slate-500">{f.last ? new Date(f.last).toLocaleString("fr-FR") : "jamais"}</Td>
                <Td className="text-right whitespace-nowrap">
                  {can("edit") && <button title="Tirer les soumissions depuis ODK Central" disabled={pulling===f.id}
                    onClick={()=>pull(f)} className="text-slate-400 hover:text-sky-600 p-1 disabled:opacity-40">
                    <RefreshCw size={13} className={pulling===f.id?"animate-spin":""} /></button>}
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
  const [tpms,setTpms] = useState([]);
  /* Les prestataires ne vivent pas dans l'état global (db) : ils sont propres à
     l'écran Suivi tiers, et cet écran n'a besoin que de leur nom pour le
     rattachement d'un compte. Un aller-retour dédié plutôt qu'alourdir /api/state
     d'une collection que presque personne n'affiche. */
  useEffect(()=>{ api.tpm().then(r=>setTpms(r.rows||[])).catch(()=>setTpms([])); },[]);
  /* Les comptes vivent côté serveur : le navigateur ne calcule aucun condensat
     et ne conserve aucun mot de passe au-delà de la saisie. */
  const save = async (u2) => {
    const payload = { email:(u2.email||"").trim(), first_name:u2.firstName || u2.first_name || "",
      last_name:u2.lastName || u2.last_name || null, title:u2.title || null,
      office_id:u2.office_id || null, tpm_id:u2.tpm_id || null, role:u2.role || "viewer",
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
          <thead><tr><Th>Utilisateur</Th><Th>Fonction</Th><Th>Rattachement</Th><Th>Adresse électronique</Th>
            <Th>Rôle</Th><Th>Onglets</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{db.users.map((u2,i)=>(
            <tr key={u2.id} className="hover:bg-sky-50">
              <Td><div className="flex items-center gap-2.5">
                <span className="w-7 h-7 rounded-full grid place-items-center f10 font-bold c-deep" style={{background:C.aqua}}>
                  {(u2.first_name?.[0]||"")+(u2.last_name?.[0]||"")}</span>
                <b>{u2.first_name} {u2.last_name}</b></div></Td>
              <Td className="text-slate-600">{u2.title}</Td>
              <Td>{u2.tpm_id
                ? <span className="inline-flex items-center gap-1"><Badge tone="b">Prestataire</Badge>
                    {(tpms.find(t=>t.id===u2.tpm_id)||{}).name || "—"}</span>
                : (db.offices.find(o=>o.id===u2.office_id)||{}).name || "Tous"}</Td>
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
      <UserModal open={!!edit} user={edit} db={db} tpms={tpms} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
function UserModal({ open, user, db, tpms, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(user ? { ...user, firstName:user.first_name, lastName:user.last_name,
    tabs:[...(user.tabs || db.roles[user.role]?.tabs || [])] } : { tabs:[], role:"viewer", active:true }); },[user]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  /* Un compte de prestataire n'a pas de bureau — il est cloisonné à son
     prestataire, quel que soit son rôle (voir tpmBound côté serveur) — et
     l'inverse tout autant : les deux champs s'excluent, comme le serveur le
     refuse déjà silencieusement s'ils arrivent ensemble. */
  const tpmInterdit = f.role === "admin" || f.role === "super";
  return (
    <Modal open onClose={onClose} title={user?.id?"Modifier l'utilisateur":"Nouvel utilisateur"}
      subtitle="Identité, rattachement, rôle et onglets accessibles"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.firstName||!f.email||(!user?.id&&!f._pw)} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Prénom"><Input value={f.firstName||""} onChange={e=>u("firstName",e.target.value)} /></Field>
        <Field label="Nom"><Input value={f.lastName||""} onChange={e=>u("lastName",e.target.value)} /></Field>
        <Field label="Fonction"><Input value={f.title||""} onChange={e=>u("title",e.target.value)} /></Field>
        <Field label="Adresse électronique"><Input type="email" value={f.email||""} onChange={e=>u("email",e.target.value)} /></Field>
        <Field label={user?.id?"Nouveau mot de passe":"Mot de passe"} hint={user?.id?"Laisser vide pour conserver l'actuel":"Huit caractères au minimum"}>
          <Input type="password" value={f._pw||""} onChange={e=>u("_pw",e.target.value)} /></Field>
      </div>
      <Field label="Rattachement" hint={tpmInterdit ? "Un administrateur n'est rattaché ni à un bureau ni à un prestataire" : undefined}>
        <div className="grid grid-cols-2 gap-x-4">
          <Select value={f.office_id||""}
            onChange={e=>setF(p=>({...p, office_id:e.target.value||null, tpm_id:null}))}
            empty="Bureau de terrain — tous les bureaux" options={(db.offices||[]).map(o=>[o.id,o.name])} />
          <Select value={f.tpm_id||""} disabled={tpmInterdit}
            onChange={e=>setF(p=>({...p, tpm_id:e.target.value||null, office_id:null}))}
            empty="Prestataire (TPM) — aucun" options={(tpms||[]).map(t=>[t.id,t.name])} />
        </div>
        <div className="f11 text-slate-500 mt-1">Bureau : restreint la vue aux sites de ce bureau. Prestataire :
          le compte ne voit que ses propres plans TPM et ne valide qu'au premier niveau du circuit. Un seul des
          deux à la fois.</div>
      </Field>
      <Field label="Rôle">
        <div className="grid grid-cols-1 gap-1.5">
          {Object.entries(db.roles).map(([k,r])=>(
            <label key={k} className={clsx("flex items-center gap-3 px-3 py-2 rounded border cursor-pointer",
              f.role===k?"bd-brand bg-sky-50":"border-slate-200 hover:bg-slate-50")}>
              <input type="radio" name="role" checked={f.role===k}
                onChange={()=>{u("role",k); u("tabs",[...r.tabs]);
                  if((k==="admin"||k==="super") && f.tpm_id) u("tpm_id",null); }} />
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
