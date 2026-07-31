import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { useGeoCascade, resetGeoCache } from "../lib/geo.js";
import { Activity, Building2, CalendarRange, Check, ClipboardList, Download, FileText, Layers, Link2, MapPin, Pencil, Plus, RefreshCw, Save, Search, Target, Trash2, Upload, X } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { LEVELS, clsx, computeMMR, computeParam, evalFormula, fmt, n, pct, r2, r5, siteRequirement, siteScore, uid } from "../lib/calc.js";
import { ACT_CATEGORIES, C, CALC_VARS, D_ENTITIES, CAT_TO_AREA, DURATIONS, D_FORMULAS, D_SECURITY, D_STATUS, D_URBAN, MONITORING_TYPES, PROG_AREAS, SITE_TYPES, TABS_ALL, siteDerived, sitePriority } from "../lib/constants.js";
/* `readGeoFile` était APPELÉ sans être importé : l'import de découpage depuis
   l'interface levait « readGeoFile is not defined » dès le choix du fichier. Le
   référentiel de production avait été chargé par le script src/import-geo.js, si
   bien que ce chemin-là n'avait jamais été emprunté. */
import { GUESS, guessField, readGeoFile } from "../lib/shapefile.js";
import { niveau, niveaux } from "../lib/levels.js";
import Listes from "./Listes.jsx";
import PaysEtDecoupage from "./Pays.jsx";
import { Sources } from "./ActualData.jsx";
import { MonthCellModal, MonthGrid, MonthLegend } from "./Planning.jsx";
import { BLOCKS } from "./Reports.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Paramètres ══════════════════ */
function SettingsView({ db, set, me, sub, setSub, notify, can, reload, go }){
  /* La fusion de `main` avait repris sa propre liste d'onglets, sans « Bureaux » ni
     « Périmètre des bureaux » : les deux écrans existaient toujours dans le fichier
     mais n'étaient plus atteignables, et `reload` ne remontait plus. Les voici
     rétablis, avec « À propos » qui venait de main. */
  return (
    <div className="space-y-4">
      {sub==="general" && <SetGeneral db={db} set={set} can={can} />}
      {sub==="country" && <PaysEtDecoupage db={db} notify={notify} can={can} reload={reload} />}
      {sub==="offices" && <SetOffices db={db} notify={notify} can={can} reload={reload} />}
      {sub==="lists" && <Listes db={db} notify={notify} can={can} reload={reload} go={go} />}
      {sub==="about" && <SetAbout db={db} />}
      {sub==="sites" && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="settings" />}
      {sub==="scope" && <><SetScope db={db} notify={notify} can={can} /><CoherenceGeo notify={notify} /></>}
      {sub==="indicators" && <SetIndicators db={db} set={set} notify={notify} can={can} />}
      {sub==="calc" && <SetCalc db={db} set={set} notify={notify} can={can} />}
      {sub==="odk" && <SetOdk db={db} set={set} notify={notify} can={can} />}
      {sub==="templates" && <SetTemplates db={db} set={set} notify={notify} can={can} />}
      {sub==="api" && <><MiseAJour me={me} notify={notify} /><Sauvegarde db={db} notify={notify} /><SetApi db={db} notify={notify} /></>}
      {sub==="users" && <>
        <OptionDemande db={db} set={set} />
        <DemandesAcces db={db} set={set} notify={notify} reload={reload} />
        <SetUsers db={db} set={set} me={me} notify={notify} />
      </>}
    </div>);
}

function SetGeneral({ db, set, can }){
  const s = db.settings; const u = (k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const modifiable = can ? can("admin") : true;
  /* Les bureaux ne figurent plus ici. Ils étaient présentés comme une liste de noms
     modifiable, mais cette liste est dérivée de la table `offices` à chaque
     chargement et n'était jamais renvoyée au serveur : toute saisie était perdue.
     Un bureau porte de surcroît une nature, un périmètre et des antennes, et il est
     référencé par les sites et les comptes — il a désormais son propre écran. */
  /* Les partenaires ne figurent plus ici. Ils y étaient présentés comme une liste de
     noms modifiable, mais cette liste est dérivée de la table `partners` à chaque
     chargement et n'était jamais renvoyée au serveur : la saisie était perdue au
     rechargement. Même défaut que les bureaux avant leur écran propre, et même
     correction — voir Paramètres → Listes de référence. */
  /* « Types de modalité » ne figure plus ici. Cette liste n'était lue par aucun écran :
     le plan de distribution travaille sur les trois modalités que le serveur accepte
     (vivres, espèces, coupons). On la présentait comme configurable, elle ne pilotait
     rien, et sa saisie n'était de toute façon jamais enregistrée. */
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
      <CategoriesActivite db={db} set={set} modifiable={modifiable} />
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
      <SousTypesPoi db={db} set={set} modifiable={modifiable} />
    </div>);
}

/* ── Catégories d'activité ───────────────────────────────────
   Elles étaient présentées en DEUX cartes — « Activity tags » et « Catégories
   d'activité » — qui modifiaient chacune une projection différente de la même table,
   sans jamais rien enregistrer. On y ajoutait une catégorie, elle apparaissait dans
   les listes déroulantes, et elle disparaissait au rechargement suivant.

   Une seule carte, une seule source : le nom, le code d'activité qui le désigne
   partout ailleurs, et le domaine programmatique. Ce que la catégorie classe
   réellement est affiché en regard — c'est ce qui fait sentir la liaison entre cette
   liste et le reste, et c'est aussi ce qui interdit de la supprimer à la légère. */
function CategoriesActivite({ db, set, modifiable }){
  const cats = db.activityCategories || [];
  const maj = (i, champ, v) => set(d => { d.activityCategories[i][champ] = v; return d; });
  const compte = (id) => ({
    sites:  db.sites.filter(s => s.category_id === id).length,
    params: (db.params || []).filter(p => p.category_id === id).length,
  });
  return (
    <Card title="Catégories d'activité"
      subtitle="Le code d'activité de chaque catégorie sert de filtre dans tout le suivi"
      right={modifiable && <Btn size="sm" kind="sec" icon={Plus} onClick={()=>set(d=>{
        d.activityCategories = [...(d.activityCategories||[]),
          { id:uid("cat"), name:"", tag:"", program_area:"", active:1 }]; return d; })}>Ajouter</Btn>}>
      {!cats.length && <Empty title="Aucune catégorie"
        text="Les catégories d'activité nomment ce que l'on suit : distribution générale, nutrition, cantines scolaires…" />}
      {!!cats.length && <TableWrap max="mh340">
          <thead><tr><Th>Intitulé</Th><Th>Code</Th><Th>Domaine</Th><Th>Utilisée par</Th>
            <Th>Active</Th><Th/></tr></thead>
          <tbody>
            {cats.map((c, i) => { const usage = compte(c.id); const lie = usage.sites + usage.params;
              return (<tr key={c.id || i} className="border-t border-slate-100">
                <Td><input value={c.name || ""} disabled={!modifiable} placeholder="Distribution générale"
                  onChange={e=>maj(i,"name",e.target.value)} className={clsx(inputCls,"mi-py1")} /></Td>
                <Td><input value={c.tag || ""} disabled={!modifiable} placeholder="GD"
                  onChange={e=>maj(i,"tag",e.target.value.toUpperCase())} className={clsx(inputCls,"mi-py1 w-20")} /></Td>
                <Td><Select value={c.program_area || ""} disabled={!modifiable} empty="—"
                  options={PROG_AREAS} onChange={e=>maj(i,"program_area",e.target.value)}
                  className="mi-py1 mi-wauto" /></Td>
                <Td className="text-slate-500 f115">
                  {lie ? `${usage.sites} site(s) · ${usage.params} paramètre(s)` : "—"}</Td>
                <Td><button disabled={!modifiable} onClick={()=>maj(i,"active", c.active ? 0 : 1)}
                  className={clsx("px-2 py-0.5 rounded f10 uppercase tracking-wide font-bold border",
                    c.active !== 0 && c.active !== false
                      ? "bg-lime-50 text-lime-800 border-lime-200"
                      : "bg-slate-50 text-slate-500 border-slate-200")}>
                  {c.active !== 0 && c.active !== false ? "active" : "retirée"}</button></Td>
                <Td>{modifiable && (lie
                  ? <span className="f10 text-slate-400" title="Retirez-la des choix en la désactivant : l'historique reste lisible">référencée</span>
                  : <button onClick={()=>set(d=>{ d.activityCategories.splice(i,1); return d; })}
                      className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>)}</Td>
              </tr>); })}
          </tbody>
      </TableWrap>}
      <Note>Une catégorie déjà portée par des sites ou des paramètres de couverture ne se
        supprime pas : la désactiver la retire des listes déroulantes sans détacher ce qui
        s'y rattache.</Note>
    </Card>);
}

/* ── Sous-types de point d'intérêt ────────────────────────
   La table existait, le semis la remplissait, et l'état ne la rendait pas : l'écran
   montrait une liste vide alors que les sites en portaient déjà les valeurs. */
function SousTypesPoi({ db, set, modifiable }){
  const rows = db.poiSubtypes || [];
  const maj = (i, champ, v) => set(d => { d.poiSubtypes[i][champ] = v; return d; });
  return (
    <Card title="Sous-types de point d'intérêt"
      subtitle="Ce qu'est le lieu suivi : école, centre de santé, marché…"
      right={modifiable && <Btn size="sm" kind="sec" icon={Plus} onClick={()=>set(d=>{
        d.poiSubtypes = [...(d.poiSubtypes||[]), { id:uid("poi"), label:"", code:"", note:"" }];
        return d; })}>Ajouter</Btn>}>
      {!rows.length && <Empty title="Aucun sous-type"
        text="Le sous-type sert à comparer ce qui est comparable : une école ne se visite pas comme un marché." />}
      <div className="space-y-1.5 mh300 overflow-auto pr-1">
        {rows.map((v, i) => (<div key={v.id || i} className="flex gap-1.5">
          <input value={v.label || ""} disabled={!modifiable} placeholder="École"
            onChange={e=>maj(i,"label",e.target.value)} className={clsx(inputCls,"mi-py1")} />
          <input value={v.code || ""} disabled={!modifiable} placeholder="SCH"
            onChange={e=>maj(i,"code",e.target.value.toUpperCase())} className={clsx(inputCls,"mi-py1 w-24")} />
          {modifiable && <button onClick={()=>set(d=>{ d.poiSubtypes.splice(i,1); return d; })}
            className="px-2 text-slate-400 hover:text-rose-600"><X size={14}/></button>}
        </div>))}
      </div>
    </Card>);
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
function SetOffices({ db, notify, can, reload }){
  const [rows,setRows] = useState(null);
  const [edit,setEdit] = useState(null);
  const [busy,setBusy] = useState(false);

  const charger = () => api.offices().then(r=>setRows(r.offices||[])).catch(e=>{ notify(e.message,"err"); setRows([]); });
  useEffect(()=>{ charger(); },[]);

  const enregistrer = async (f) => {
    setBusy(true);
    const payload = { name:(f.name||"").trim(), code:f.code||null, kind:f.kind||"field",
      scope_mode:f.scope_mode||"geo", country_code:f.country_code || null,
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
  const multi = (db?.countries || []).length > 1;

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
          {/* La colonne « Pays » n'apparaît que si l'instance en sert plusieurs :
              une colonne qui répète la même valeur sur chaque ligne prend de la place
              sans rien apprendre. */}
          <thead><tr><Th>Bureau</Th><Th>Code</Th>{multi && <Th>Pays</Th>}<Th>Nature</Th>
            <Th>Périmètre</Th><Th>Antennes</Th><Th>Responsable</Th><Th num>Sites</Th>
            <Th num>Comptes</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{rows.map(o=>(
            <tr key={o.id} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{o.name}</Td>
              <Td className="f115 text-slate-500">{o.code || "—"}</Td>
              {multi && <Td className="f115 text-slate-600">{o.country || o.country_code || "—"}</Td>}
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
        onClose={()=>setEdit(null)} onSave={enregistrer} db={db} />
    </>);
}

function OfficeModal({ open, office, busy, onClose, onSave, db }){
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
        {/* Le pays n'apparaît que si l'instance en sert plusieurs, et que l'appelant
            n'est borné à aucun — sinon il n'y a rien à choisir, et un champ à une
            seule valeur est du bruit. Un bureau qui porte déjà des données ne change
            plus de pays : son périmètre géographique appartient au découpage de
            celui-ci. */}
        {(db?.countries || []).length > 1 && (
          <Field label="Pays" hint={office?.id ? "Un bureau qui porte des données ne change plus de pays" : ""}>
            <Select value={f.country_code || db?.country?.code || ""}
              disabled={!!office?.id && !!Object.values(office.usage||{}).reduce((a,b)=>a+b,0)}
              onChange={e=>u("country_code",e.target.value)}
              options={db.countries.map(c => [c.code, c.name])} /></Field>)}
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

/* ── La chaîne géographique tient-elle ? ──────────────────────
   Le découpage, les coordonnées et les listes ne se parlent que par un fil très fin :
   le p-code. Qu'il casse quelque part et rien ne se voit — les écrans continuent
   d'afficher des nombres, simplement ils n'additionnent plus les mêmes choses. Un
   réimport de découpage suffit à détacher trois cents sites en silence.

   Ce panneau constate et chiffre. Il ne répare pas : une correction automatique sur
   des données de terrain serait une décision, pas un diagnostic. Il indique en
   revanche ce qui SERAIT réparable — les sites dont le point GPS tombe dans un
   contour — et renvoie vers l'écran qui le fait, où l'on valide chaque proposition. */
function CoherenceGeo({ notify }){
  const [d,setD] = useState({ loading:true });
  const charger = () => { setD({ loading:true });
    api.geoCoherence().then(r => setD({ ...r, loading:false }))
      .catch(e => setD({ loading:false, err:e.message })); };
  useEffect(charger, []);

  if(d.loading) return <Card title="Cohérence géographique"><Note>Contrôle en cours…</Note></Card>;
  if(d.err) return <Card title="Cohérence géographique"><Note tone="warn">{d.err}</Note></Card>;
  if(!d.version) return <Card title="Cohérence géographique">
    <Empty title="Aucun découpage chargé" text={d.message} /></Card>;

  const ecarts = d.constats.filter(c => c.n > 0);
  return (
    <Card flush title="Cohérence géographique"
      subtitle={`Millésime « ${d.version.label} » · ${fmt(d.volumes.sites)} sites, ${fmt(d.volumes.pdd)} lignes de plan, ${fmt(d.volumes.caseload)} lignes de ciblage`}
      right={<Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger}>Recontrôler</Btn>}>
      <div className="p-5 pb-0">
        {!ecarts.length
          ? <Note tone="ok"><b>Rien à signaler.</b> Chaque site, chaque ligne de plan et chaque
              ligne de ciblage pointe vers une unité qui existe, les libellés recopiés s'accordent
              avec le découpage, et les points GPS tombent bien dans leur unité.</Note>
          : <Note tone="warn"><b>{fmt(d.ecarts)} écart(s)</b> sur {ecarts.length} contrôle(s).
              {d.reparable.contour > 0 && <> {fmt(d.reparable.contour)} site(s) peuvent être rattachés
              automatiquement : leur point GPS tombe dans un contour connu — voir Paramètres →
              Pays et découpage.</>}</Note>}
      </div>
      <TableWrap max="mh420">
        <thead><tr><Th /><Th>Contrôle</Th><Th num>Écarts</Th><Th>Exemples</Th></tr></thead>
        <tbody>{d.constats.map(c => (
          <tr key={c.cle} className={clsx("border-t border-slate-100", c.n && "bg-amber-50/40")}>
            <Td>{c.n
              ? <AlertTriangle size={14} className="text-amber-600" />
              : <Check size={14} className="text-lime-600" />}</Td>
            <Td><div className="font-medium text-slate-800">{c.titre}</div>
              <div className="f105 text-slate-500 whitespace-normal mw420">{c.quoi}</div></Td>
            <Td num className="tabular-nums font-semibold">{c.n || "—"}</Td>
            <Td className="f105 text-slate-500 whitespace-normal mw420">
              {c.exemples.length ? c.exemples.join(" · ") : "—"}</Td>
          </tr>))}</tbody>
      </TableWrap>
    </Card>);
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
        {/* Deux commandes ont disparu d'ici, et c'est un gain.

            « Tester la connexion » ne testait rien : elle affichait un message et
            s'arrêtait là. Un bouton qui prétend éprouver quelque chose et ne l'éprouve
            pas est pire que son absence — on le presse, il ne se plaint pas, et l'on
            en conclut que le serveur répond.

            « Jeton général » était refusé côté serveur, en silence : le dictionnaire
            des réglages n'accepte aucun secret en clair, et la clé était simplement
            ignorée à l'enregistrement. On saisissait un jeton, le champ semblait le
            retenir, et il n'existait nulle part au rechargement. Le jeton se porte par
            SOURCE, où il est chiffré — c'est le seul chemin qui fonctionne. */}
        <Card title="Serveur">
          <Field label="Adresse du serveur"><Input value={s.odkBase} onChange={e=>u("odkBase",e.target.value)} placeholder="https://odk-central.example.org" /></Field>
          <Field label="Identifiant de projet par défaut"><Input value={s.odkProject||""} onChange={e=>u("odkProject",e.target.value)} placeholder="1" /></Field>
          <Note>Le jeton d'accès se déclare source par source, dans la fiche du formulaire :
            il y est chiffré avant d'être conservé et n'est jamais renvoyé à l'écran. Le
            dictionnaire des réglages, lui, n'accepte aucun secret.</Note>
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
                <Td>{f.token ? <Badge tone="g">présent</Badge> : <Badge tone="r">manquant</Badge>}</Td>
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
/* ── Sauvegarde et retour en arrière ─────────────────────────
   Une base SQLite se copie, mais un fichier .db ne se lit pas, ne se vérifie pas avant
   de le remettre, et ne se restaure pas par morceaux. C'est bon pour un incident
   matériel et inadapté à ce qui arrive vraiment : un import qui a mal tourné, un plan
   qu'on voudrait retrouver tel qu'il était en mars, une configuration à recopier d'une
   instance vers une autre.

   L'écran suit l'ordre du geste : on choisit ce qu'on emporte, on l'emporte ; ou bien
   on dépose un fichier, on REGARDE ce qu'il ferait, et on écrit ensuite. Jamais
   l'inverse. */
function Sauvegarde({ db, notify }){
  const [postes,setPostes] = useState(null);
  const [choix,setChoix]   = useState(() => new Set());
  const [busy,setBusy]     = useState("");
  const [fichier,setFichier] = useState(null);
  const [examen,setExamen] = useState(null);
  const [mode,setMode]     = useState("completer");

  useEffect(() => { api.backupParts()
    .then(r => { setPostes(r.postes);
      setChoix(new Set(r.postes.filter(p => !p.lourd && p.lignes).map(p => p.cle))); })
    .catch(e => notify(e.message, "err")); }, []);

  const basculer = (cle) => setChoix(s => { const c = new Set(s);
    c.has(cle) ? c.delete(cle) : c.add(cle); return c; });

  const emporter = async () => {
    setBusy("export");
    try{
      const j = await api.backup([...choix]);
      download(`mems_sauvegarde_${new Date().toISOString().slice(0,10)}.json`,
        JSON.stringify(j, null, 2), "application/json");
      notify(`Sauvegarde de ${j.manifeste.postes.length} poste(s) téléchargée`, "ok");
    }catch(e){ notify(e.message, "err"); }
    finally{ setBusy(""); }
  };

  const deposer = (f) => { const rd = new FileReader();
    rd.onload = () => { try{
        const j = JSON.parse(rd.result);
        if(!j?.donnees) throw new Error("ce fichier n'est pas une sauvegarde MEMS");
        setFichier(j); setExamen(null);
      }catch(e){ notify(e.message, "err"); } };
    rd.readAsText(f, "utf-8"); };

  const regarder = async () => {
    setBusy("examen");
    try{ setExamen(await api.backupRestore({ donnees:fichier.donnees, mode, examiner:true })); }
    catch(e){ notify(e.message, "err"); }
    finally{ setBusy(""); }
  };
  const ecrire = async () => {
    setBusy("restore");
    try{
      const r = await api.backupRestore({ donnees:fichier.donnees, mode, examiner:false });
      notify(`${r.creees} ligne(s) restaurées` + (r.supprimees ? `, ${r.supprimees} remplacées` : ""), "ok");
      if(r.note) notify(r.note, "warn");
      setTimeout(() => window.location.reload(), 1200);
    }catch(e){ notify(e.message, "err"); }
    finally{ setBusy(""); }
  };

  const groupes = { configuration:"Configuration", decoupage:"Découpage géographique",
    operations:"Données opérationnelles", suivi:"Suivi et évaluation", analyses:"Analyses et rapports" };

  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"minmax(380px,1fr) minmax(420px,1fr)"}}>
      <Card title="Emporter une sauvegarde"
        subtitle="Un fichier JSON lisible, complet ou partiel"
        right={<Btn size="sm" icon={Download} disabled={!choix.size || busy==="export"} onClick={emporter}>
          {busy==="export" ? "Préparation…" : `Télécharger ${choix.size} poste(s)`}</Btn>}>
        <Note>Les empreintes de mots de passe et les jetons ne figurent jamais dans la sauvegarde :
          un tel fichier circule par courriel et finit sur une clé USB, il ne doit pas suffire à se
          faire passer pour quelqu'un. Les comptes restaurés devront recevoir un nouveau mot de passe.</Note>
        {!postes && <div className="f115 text-slate-500 mt-3">Lecture des postes…</div>}
        {postes && Object.entries(groupes).map(([g, titre]) => {
          const liste = postes.filter(p => p.groupe === g && !p.absent);
          if(!liste.length) return null;
          return (<div key={g} className="mt-4">
            <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-1.5">{titre}</div>
            <div className="space-y-1">
              {liste.map(p => (
                <label key={p.cle} className="flex items-center gap-2 f115 cursor-pointer py-0.5">
                  <input type="checkbox" checked={choix.has(p.cle)} onChange={()=>basculer(p.cle)} />
                  <span className="flex-1 text-slate-700">{p.label}
                    {p.lourd && <span className="f10 text-amber-700 ml-1.5">volumineux</span>}</span>
                  <span className="tabular-nums text-slate-500">{fmt(p.lignes)}</span>
                </label>))}
            </div></div>); })}
      </Card>

      <Card title="Revenir à une sauvegarde" subtitle="On regarde d'abord, on écrit ensuite">
        <label className="block">
          <input type="file" accept=".json" className="hidden"
            onChange={e=>e.target.files[0] && deposer(e.target.files[0])} />
          <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-3 py-1.5 f13 m-btn-sec cursor-pointer">
            <Upload size={14}/> Choisir un fichier de sauvegarde</span>
        </label>
        {fichier && <div className="mt-3">
          <Note>Sauvegarde du {new Date(fichier.manifeste?.cree || Date.now()).toLocaleString("fr-FR")}
            {fichier.manifeste?.par ? ` par ${fichier.manifeste.par}` : ""} —
            {" "}{Object.keys(fichier.donnees).length} poste(s),
            {" "}{fmt(Object.values(fichier.donnees).reduce((t,x)=>t+x.length,0))} ligne(s).</Note>
          <Field label="Mode" className="mt-3">
            <Select value={mode} onChange={e=>{setMode(e.target.value); setExamen(null);}}
              options={[["completer","Compléter — n'écrire que ce qui manque"],
                        ["remplacer","Remplacer — vider puis réécrire (destructif)"]]} /></Field>
          <div className="flex gap-2">
            <Btn kind="sec" disabled={busy==="examen"} onClick={regarder}>
              {busy==="examen" ? "Examen…" : "Regarder ce que cela ferait"}</Btn>
            <Btn kind={mode==="remplacer" ? "danger" : "primary"} icon={Check}
              disabled={!examen || busy==="restore"} onClick={ecrire}>
              {busy==="restore" ? "Écriture…" : "Restaurer"}</Btn>
          </div>
        </div>}
        {examen && <div className="mt-4">
          {!!examen.detacherait && <Note tone="warn">
            <b>Refusé en l'état.</b> Vider ces postes détacherait {fmt(examen.detacherait)} ligne(s)
            ailleurs — le schéma les met à vide, et la réécriture ne les recolle pas. Ajoutez les
            postes dépendants, ou choisissez « compléter ».</Note>}
          <TableWrap max="mh300">
            <thead><tr><Th>Poste</Th><Th num>Dans le fichier</Th><Th num>En base</Th>
              <Th num>Créées</Th><Th num>Supprimées</Th></tr></thead>
            <tbody>{examen.plan.map(p => (
              <tr key={p.cle} className={clsx("border-t border-slate-100", p.detacherait && "bg-amber-50/50")}>
                <Td>{p.label}{p.detacherait && <div className="f10 text-amber-700">
                  détacherait {p.detacherait.map(d=>`${fmt(d.lignes)} ${d.table}`).join(", ")}</div>}</Td>
                <Td num className="tabular-nums">{fmt(p.entrantes)}</Td>
                <Td num className="tabular-nums text-slate-500">{fmt(p.enBase)}</Td>
                <Td num className="tabular-nums font-semibold">{fmt(p.creees)}</Td>
                <Td num className="tabular-nums text-rose-700">{p.supprimees ? fmt(p.supprimees) : "—"}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </div>}
      </Card>
    </div>);
}

/* ── Mise à jour du serveur ──────────────────────────────────
   L'écran n'existe que si l'installation l'a voulu. C'est le point important : le
   dépôt, la branche et la commande sont fixés dans l'environnement du serveur, et
   aucune requête ne peut les changer. On ne peut demander qu'une chose — « applique
   ce qui a été configuré » — et il faut encore taper la confirmation.

   L'ordre du geste est celui du risque : voir où l'on en est, voir ce qui a changé
   en amont, puis seulement appliquer. */
function MiseAJour({ me, notify }){
  const [etat,setEtat] = useState({ loading:true });
  const [ecart,setEcart] = useState(null);
  const [resultat,setResultat] = useState(null);
  const [mot,setMot] = useState("");
  const [busy,setBusy] = useState("");

  useEffect(() => { api.updateStatus()
    .then(r => setEtat({ ...r, loading:false }))
    .catch(e => setEtat({ loading:false, indisponible:true, err:e.message })); }, []);

  if(etat.loading) return null;
  /* Ni écran, ni mention, quand la fonction n'a pas été installée : annoncer une porte
     qu'on ne peut pas ouvrir n'aide personne. Le compte non super non plus. */
  if(etat.indisponible || me?.role !== "super") return null;

  const verifier = async () => { setBusy("check"); setEcart(null);
    try{ setEcart(await api.updateCheck()); }
    catch(e){ notify(e.message, "err"); } finally{ setBusy(""); } };
  const appliquer = async () => { setBusy("apply"); setResultat(null);
    try{
      const r = await api.updateApply();
      setResultat(r); setMot("");
      notify(r.redemarrage ? "Mise à jour appliquée — le service redémarre" : "Mise à jour appliquée", "ok");
    }catch(e){ notify(e.message, "err"); setResultat({ ok:false, erreur:e.message, etapes:e.details }); }
    finally{ setBusy(""); } };

  const v = etat.version || {};
  const r = etat.reglages || {};
  return (
    <Card flush title="Mise à jour du serveur"
      subtitle={etat.mode === "git"
        ? `Avance rapide sur ${r.remote}/${r.branche}`
        : "Commande fournie à l'installation"}>
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-1">Version en service</div>
            {v.erreur ? <div className="f115 text-amber-700">{v.erreur}</div> : <>
              <div className="font-mono f13 text-slate-800">{v.commit} <span className="text-slate-400">·</span> {v.branche}</div>
              <div className="f115 text-slate-500">{v.sujet}</div>
              <div className="f105 text-slate-400">{v.date ? new Date(v.date).toLocaleString("fr-FR") : ""}</div>
              {v.modifieLocalement > 0 && <div className="f105 text-amber-700 mt-1">
                {v.modifieLocalement} fichier(s) modifiés localement — la mise à jour sera refusée.</div>}
            </>}
          </div>
          <div>
            <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-1">Ce qui sera fait</div>
            <ul className="f115 text-slate-600 space-y-0.5">
              {[[r.sauvegarder,"Sauvegarde de la base avant"],
                [true, etat.mode === "git" ? `Avance rapide sur ${r.remote}/${r.branche}` : `Commande : ${r.commande}`],
                [r.migrer,"Migrations de base"],
                [r.construire,"Reconstruction de l'interface"],
                [r.redemarrer,"Arrêt du service pour redémarrage"]].map(([on,t],i)=>(
                <li key={i} className={on ? "text-slate-700" : "text-slate-300 line-through"}>
                  {on ? "• " : "◦ "}{t}</li>))}
            </ul>
            <div className="f105 text-slate-400 mt-2">
              Réglé à l'installation ; non modifiable depuis l'application.</div>
          </div>
        </div>

        {etat.derniere && <Note>Dernière opération : {etat.derniere.text}
          {" "}({new Date(etat.derniere.at).toLocaleString("fr-FR")}, {etat.derniere.user_label}).</Note>}

        <div className="flex gap-2">
          <Btn kind="sec" icon={RefreshCw} disabled={busy==="check"} onClick={verifier}>
            {busy==="check" ? "Lecture du dépôt…" : "Vérifier les mises à jour"}</Btn>
        </div>

        {ecart && ecart.mode === "commande" && <Note tone="warn">{ecart.message}</Note>}
        {ecart && ecart.mode === "git" && <>
          {ecart.enAttente === 0
            ? <Note tone="ok">Ce serveur est à jour sur {ecart.cible}.</Note>
            : <Note><b>{ecart.enAttente} mise(s) à jour</b> en attente sur {ecart.cible}.</Note>}
          {ecart.avertissement && <Note tone="warn">{ecart.avertissement}</Note>}
          {!!ecart.commits.length && <TableWrap max="mh240">
            <thead><tr><Th>Commit</Th><Th>Date</Th><Th>Auteur</Th><Th>Objet</Th></tr></thead>
            <tbody>{ecart.commits.map(c => (
              <tr key={c.sha} className="border-t border-slate-100">
                <Td className="font-mono f105">{c.sha}</Td>
                <Td className="f105 text-slate-500">{new Date(c.date).toLocaleDateString("fr-FR")}</Td>
                <Td className="f105 text-slate-500">{c.auteur}</Td>
                <Td className="f115 whitespace-normal mw420">{c.sujet}</Td>
              </tr>))}</tbody>
          </TableWrap>}
          {ecart.enAttente > 0 && !ecart.avertissement && <div className="flex items-end gap-2 mt-3">
            <Field label="Confirmation" className="mb-0"
              hint="Tapez METTRE A JOUR — le geste remplace le programme en cours d'exécution">
              <Input value={mot} onChange={e=>setMot(e.target.value)} placeholder="METTRE A JOUR" /></Field>
            <Btn kind="danger" icon={Check} disabled={mot !== "METTRE A JOUR" || busy==="apply"}
              onClick={appliquer}>{busy==="apply" ? "Mise à jour…" : "Appliquer"}</Btn>
          </div>}
        </>}

        {resultat && <div className="mt-2">
          <Note tone={resultat.ok ? "ok" : "warn"}>
            {resultat.ok ? resultat.note : resultat.erreur}</Note>
          {!!resultat.etapes?.length && <ul className="f115 mt-2 space-y-0.5">
            {resultat.etapes.map((e,i)=>(
              <li key={i} className={e.ok ? "text-slate-700" : "text-rose-700"}>
                {e.ok ? "✓" : "✗"} <b>{e.nom}</b> — <span className="text-slate-500">{e.detail}</span></li>))}
          </ul>}
        </div>}
      </div>
    </Card>);
}

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
/* ── Les demandes d'accès ─────────────────────────────────────
   Une demande n'est pas un compte : c'est une déclaration en attente de décision. Ce
   qui se joue ici est exactement ce que le demandeur ne pouvait pas décider — le rôle,
   le bureau, les destinations. L'écran met donc la déclaration à gauche et la décision
   à droite, pour qu'on lise l'une en remplissant l'autre.

   L'acceptation rend un mot de passe initial UNE SEULE FOIS. L'application n'envoie
   pas de courriel : c'est à l'administrateur de le transmettre, il doit donc le voir,
   et il ne le reverra jamais. On le montre en grand, avec de quoi le copier, et on
   dit qu'il ne reviendra pas. */
/* L'option elle-même. Elle est fermée par défaut, et l'écran dit ce qu'elle ouvre :
   une porte publique, sur laquelle n'importe qui peut frapper. C'est sans danger tant
   que frapper ne fait qu'annoncer — mais on préfère l'écrire que le sous-entendre. */
function OptionDemande({ db, set }){
  const s = db.settings || {};
  const u = (k, v) => set(d => { d.settings[k] = v; return d; });
  const ouvert = s.selfRegistration === true;
  return (
    <Card title="Demande d'accès"
      subtitle="Permettre à quelqu'un de demander un compte depuis l'écran de connexion">
      <Sw label="Ouvrir la demande d'accès"
        hint="Un lien « Demander un accès » apparaît sur l'écran de connexion. Une demande ne crée aucun compte : elle attend votre décision."
        on={ouvert} onChange={v=>u("selfRegistration", v)} />
      {ouvert && <Field label="Domaines acceptés"
        hint="Séparés par des virgules — par exemple wfp.org. Laisser vide accepte toute adresse.">
        <Input value={s.selfRegistrationDomains || ""} placeholder="wfp.org"
          onChange={e=>u("selfRegistrationDomains", e.target.value)} /></Field>}
      {ouvert && <Note>Le rôle ne peut pas être demandé : il n'existe ni dans le formulaire
        ni dans la table des demandes. Il se décide ici, à l'acceptation, et nulle part ailleurs.</Note>}
    </Card>);
}

function DemandesAcces({ db, set, notify, reload }){
  const [d, setD] = useState({ rows:[], loading:true });
  const [sel, setSel] = useState(null);
  const [decision, setDecision] = useState({ role:"viewer", office_id:"", tabs:[], note:"" });
  const [busy, setBusy] = useState(false);
  const [motDePasse, setMotDePasse] = useState(null);
  const [voir, setVoir] = useState("pending");

  const charger = () => { setD(x => ({ ...x, loading:true }));
    api.demandes(voir === "toutes" ? "" : `?status=${voir}`)
      .then(r => setD({ ...r, loading:false }))
      .catch(e => setD({ rows:[], loading:false, err:e.message })); };
  useEffect(charger, [voir]);

  const ouvrir = (r) => {
    setSel(r); setMotDePasse(null);
    /* L'entité déclarée propose les destinations de son métier : c'est à cela qu'elle
       sert, et cela évite de cocher douze cases à l'aveugle. Tout reste modifiable. */
    const e = D_ENTITIES[r.entity];
    setDecision({ role:"viewer", office_id:r.office_id || "",
      tabs: e ? [...e.tabs] : ["home"], note:"" });
  };

  const accepter = async () => {
    setBusy(true);
    try{
      const r = await api.accepterDemande(sel.id, decision);
      setMotDePasse(r);
      notify(`Compte créé pour ${r.email}`, "ok");
      charger(); if(reload) await reload();
    }catch(e){ notify(e.message, "err"); }
    finally{ setBusy(false); }
  };
  const refuser = async () => {
    setBusy(true);
    try{ await api.refuserDemande(sel.id, decision.note);
      notify("Demande refusée", "ok"); setSel(null); charger(); }
    catch(e){ notify(e.message, "err"); }
    finally{ setBusy(false); }
  };

  const enAttente = d.rows.filter(r => r.status === "pending").length;
  const TONE = { pending:"b", approved:"g", rejected:"r" };
  const MOT  = { pending:"en attente", approved:"acceptée", rejected:"refusée" };

  return (<>
    <Card flush title="Demandes d'accès"
      subtitle={d.loading ? "Lecture…"
        : enAttente ? `${enAttente} demande(s) à examiner` : "Aucune demande en attente"}
      right={<>
        <Select value={voir} onChange={e=>setVoir(e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[["pending","En attente"],["approved","Acceptées"],
                    ["rejected","Refusées"],["toutes","Toutes"]]} />
        <Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger}>Rafraîchir</Btn></>}>
      {d.err && <div className="p-5"><Note tone="warn">{d.err}</Note></div>}
      {!d.loading && !d.rows.length && <Empty title="Rien à examiner"
        text="Les demandes déposées depuis l'écran de connexion apparaissent ici, dans votre pays." />}
      {!!d.rows.length && <TableWrap max="mh340">
        <thead><tr><Th>Personne</Th><Th>Service</Th><Th>Bureau souhaité</Th>
          <Th>Déposée le</Th><Th>État</Th><Th /></tr></thead>
        <tbody>{d.rows.map(r => (
          <tr key={r.id} className="border-t border-slate-100 hover:bg-sky-50">
            <Td><div className="font-medium text-slate-800">{r.first_name} {r.last_name}</div>
              <div className="f105 text-slate-500">{r.email}{r.title ? ` · ${r.title}` : ""}</div></Td>
            <Td className="f115">{D_ENTITIES[r.entity]?.label || <span className="text-slate-400">—</span>}</Td>
            <Td className="f115 text-slate-600">{r.office || <span className="text-slate-400">à décider</span>}</Td>
            <Td className="f105 text-slate-500">{new Date(r.created_at).toLocaleDateString("fr-FR")}</Td>
            <Td><Badge tone={TONE[r.status]}>{MOT[r.status]}</Badge></Td>
            <Td className="text-right">{r.status === "pending"
              ? <Btn size="sm" onClick={()=>ouvrir(r)}>Examiner</Btn>
              : <span className="f105 text-slate-400">{r.decidedBy}</span>}</Td>
          </tr>))}</tbody>
      </TableWrap>}
    </Card>

    <Modal open={!!sel} onClose={()=>{ setSel(null); setMotDePasse(null); }} wide
      title={motDePasse ? "Compte créé" : "Examiner la demande"}
      subtitle={motDePasse ? undefined : "Le demandeur a déclaré qui il est ; vous décidez de ce qu'il pourra faire"}
      footer={motDePasse
        ? <Btn onClick={()=>{ setSel(null); setMotDePasse(null); }}>J'ai noté le mot de passe</Btn>
        : <><Btn kind="sec" onClick={()=>setSel(null)}>Annuler</Btn>
            <Btn kind="danger" disabled={busy} onClick={refuser}>Refuser</Btn>
            <Btn icon={Check} disabled={busy} onClick={accepter}>
              {busy ? "Création…" : "Accepter et créer le compte"}</Btn></>}>
      {motDePasse ? (
        <div>
          <Note tone="warn"><b>Ce mot de passe n'est affiché qu'une fois.</b> Il n'est
            conservé nulle part en clair et aucun écran ne le redonnera. Transmettez-le
            par un canal sûr ; il devra être changé à la première connexion.</Note>
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-5 text-center">
            <div className="f11 uppercase tracking-wide font-bold text-slate-500">{motDePasse.email}</div>
            <div className="font-mono text-2xl text-slate-900 mt-2 select-all">{motDePasse.motDePasse}</div>
          </div>
        </div>
      ) : sel && (
        <div className="grid gap-5" style={{gridTemplateColumns:"1fr 1fr"}}>
          <div>
            <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-2">Ce qui a été déclaré</div>
            <div className="space-y-2 f13">
              <div><span className="text-slate-500">Nom </span>
                <b>{sel.first_name} {sel.last_name}</b></div>
              <div><span className="text-slate-500">Adresse </span>{sel.email}</div>
              <div><span className="text-slate-500">Poste </span>{sel.title || "—"}</div>
              <div><span className="text-slate-500">Service </span>
                {D_ENTITIES[sel.entity]?.label || "—"}</div>
              <div><span className="text-slate-500">Bureau souhaité </span>{sel.office || "—"}</div>
              <div><span className="text-slate-500">Pays </span>{sel.country_code || "—"}</div>
            </div>
            {sel.motif && <div className="mt-4">
              <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-1">Motif</div>
              <p className="f115 text-slate-600 whitespace-pre-wrap leading-relaxed">{sel.motif}</p></div>}
            <Note>Une déclaration n'engage que celui qui la fait. Vérifiez auprès du bureau
              concerné avant d'accorder un accès à des données de bénéficiaires.</Note>
          </div>

          <div>
            <div className="f10 uppercase tracking-wide font-bold text-slate-500 mb-2">Ce que vous décidez</div>
            <Field label="Rôle" hint="Le rôle, et lui seul, accorde des droits. Il n'a pas pu être demandé.">
              <Select value={decision.role}
                onChange={e=>setDecision(x=>({ ...x, role:e.target.value }))}
                options={[["viewer","Lecture seule"],["editor","Éditeur"],
                          ["validator","Validateur"],["admin","Administrateur"]]} /></Field>
            <Field label="Bureau">
              <Select value={decision.office_id} empty="Aucun — voit tout le pays"
                onChange={e=>setDecision(x=>({ ...x, office_id:e.target.value }))}
                options={(db.offices||[]).map(o=>[o.id, o.name])} /></Field>
            <Field label="Destinations ouvertes">
              <div className="grid grid-cols-2 gap-1">
                {TABS_ALL.map(([t,l])=>(
                  <label key={t} className="flex items-center gap-1.5 f115 cursor-pointer">
                    <input type="checkbox" checked={decision.tabs.includes(t)}
                      onChange={e=>setDecision(x=>({ ...x,
                        tabs: e.target.checked ? [...new Set([...x.tabs, t])] : x.tabs.filter(y=>y!==t) }))} />
                    {l}</label>))}
              </div></Field>
            <Field label="Note de décision" hint="Conservée au journal, et visible ici ensuite.">
              <Input value={decision.note}
                onChange={e=>setDecision(x=>({ ...x, note:e.target.value }))} /></Field>
          </div>
        </div>
      )}
    </Modal>
  </>);
}

function SetUsers({ db, set, me, notify }){
  const [edit,setEdit] = useState(null);
  /* Les comptes vivent côté serveur : le navigateur ne calcule aucun condensat
     et ne conserve aucun mot de passe au-delà de la saisie. */
  const save = async (u2) => {
    const payload = { email:(u2.email||"").trim(), first_name:u2.firstName || u2.first_name || "",
      last_name:u2.lastName || u2.last_name || null, title:u2.title || null,
      office_id:u2.office_id || null, role:u2.role || "viewer",
      /* `country_code` et `tpm_id` sont renvoyés tels quels. Les omettre les
         effacerait : la validation les traite comme facultatifs et un champ absent
         devient NULL — un compte de prestataire modifié depuis cet écran perdait
         ainsi son rattachement, et un compte de pays y gagnerait la vue de tous. */
      country_code:u2.country_code || null, tpm_id:u2.tpm_id || null, entity:u2.entity || null,
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
      {/* Cette note disait le contraire de ce qui est vrai : « ces rôles gouvernent
          l'interface et non l'accès aux données ». C'était exact quand tout vivait
          dans le navigateur ; ce ne l'est plus depuis que le serveur applique le
          cloisonnement en SQL. Laisser un avertissement périmé est pire que ne rien
          dire — il invite à ajouter une protection ailleurs, ou à se méfier de celle
          qui existe. */}
      <Note><b>Trois questions, trois réponses.</b> L'<b>entité</b> dit qui est ce compte,
        le <b>rôle</b> ce qu'il peut faire, le <b>pays</b> et le <b>bureau</b> où il peut le faire.
        Seul le rôle accorde des droits.
        <br /><br />
        Ces règles sont appliquées <b>par le serveur</b>, en SQL, et pas seulement par l'interface :
        un compte de terrain qui appellerait l'API directement obtiendrait les mêmes données que
        celles qu'il voit à l'écran, ni plus. Les mots de passe sont hachés avec un sel propre à
        chaque compte et ne sont jamais conservés en clair.</Note>
      <Card flush title="Comptes" subtitle={`${db.users.length} comptes · ${db.users.filter(u=>u.active!==false).length} actifs`}
        right={<Btn size="sm" icon={Plus} onClick={()=>setEdit({ role:"viewer", active:true, tabs:db.roles.viewer.tabs })}>Ajouter un utilisateur</Btn>}>
        <TableWrap max="mh440">
          {/* Comme pour les bureaux : la colonne « Pays » ne s'affiche que si
              l'instance en sert plusieurs. */}
          <thead><tr><Th>Utilisateur</Th><Th>Entité</Th><Th>Fonction</Th><Th>Bureau</Th>
            {(db.countries||[]).length > 1 && <Th>Pays</Th>}<Th>Adresse électronique</Th>
            <Th>Rôle</Th><Th>Onglets</Th><Th>Statut</Th><Th /></tr></thead>
          <tbody>{db.users.map((u2,i)=>(
            <tr key={u2.id} className="hover:bg-sky-50">
              <Td><div className="flex items-center gap-2.5">
                <span className="w-7 h-7 rounded-full grid place-items-center f10 font-bold c-deep" style={{background:C.aqua}}>
                  {(u2.first_name?.[0]||"")+(u2.last_name?.[0]||"")}</span>
                <b>{u2.first_name} {u2.last_name}</b></div></Td>
              <Td>{u2.entity
                ? <Badge tone="n">{(D_ENTITIES[u2.entity]||{}).label || u2.entity}</Badge>
                : <span className="text-slate-300 f115">—</span>}</Td>
              <Td className="text-slate-600">{u2.title}</Td><Td>{(db.offices.find(o=>o.id===u2.office_id)||{}).name || "Tous"}</Td>
              {(db.countries||[]).length > 1 && (
                <Td className="f115 text-slate-600">
                  {u2.country_code
                    ? ((db.countries.find(c=>c.code===u2.country_code)||{}).name || u2.country_code)
                    /* Un compte sans pays voit tous les pays : c'est un périmètre, pas un
                       champ oublié, et il se dit explicitement. */
                    : <Badge tone="b">tous les pays</Badge>}</Td>)}
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
      {/* Cette matrice était présentée comme modifiable : on décochait « Modifier »
          pour le rôle éditeur, la case restait décochée à l'écran, et rien ne
          changeait — ni sur le serveur, qui tient la sienne et reste seul arbitre, ni
          au rechargement suivant, où la case revenait cochée. Une case à cocher qui
          ne coche rien vaut moins qu'un tableau qui dit la vérité : la voici en
          lecture, telle que le serveur l'applique. Ce qui se règle par compte —
          les destinations ouvertes — se règle dans sa fiche, et cela fonctionne. */}
      <Card flush title="Rôles et niveaux d'accès"
        subtitle="Ce que chaque rôle permet, tel que le serveur l'applique">
        <TableWrap max="mh300">
          <thead><tr><Th>Rôle</Th><Th>Destinations ouvertes par défaut</Th>
            {["Modifier","Supprimer","Valider","Administrer"].map(h=><Th key={h} className="mi-tc">{h}</Th>)}</tr></thead>
          <tbody>{Object.entries(db.roles).map(([k,r])=>(
            <tr key={k}><Td><b>{r.label}</b></Td>
              <Td className="whitespace-normal mw420 f115 text-slate-600">
                {TABS_ALL.filter(([t]) => r.tabs.includes(t)).map(([,l])=>l).join(" · ") || "aucune"}</Td>
              {["edit","del","validate","admin"].map(fl=>(
                <Td key={fl} className="mi-tc">{r[fl]
                  ? <Check size={14} className="inline text-lime-600" />
                  : <span className="text-slate-300">—</span>}</Td>))}
            </tr>))}</tbody>
        </TableWrap>
        <Note>Les droits d'un rôle ne se modifient pas depuis l'application : le serveur
          les applique à chaque appel et refuserait ce que cet écran laisserait passer.
          Pour ouvrir ou fermer des destinations à quelqu'un en particulier, ouvrez sa
          fiche — ce réglage-là est bien enregistré.</Note>
      </Card>
      <UserModal open={!!edit} user={edit} db={db} me={me} onClose={()=>setEdit(null)} onSave={save} />
    </>);
}
/* ── Fiche d'un compte ────────────────────────────────────────────────
   Trois questions, et elles étaient mélangées : QUI est ce compte (son entité), ce
   qu'il peut FAIRE (son rôle), et OÙ (pays, bureau, prestataire). La fenêtre les
   présentait à plat, avec douze cases à cocher pour les destinations, et rien ne
   disait ce que le compte verrait en se connectant.

   Elles sont séparées, et l'écran RÉPOND : un panneau récapitule, avant
   d'enregistrer, ce que ce compte pourra faire et où. C'était la seule façon de
   vérifier une décision d'accès autrement qu'en se connectant à la place de
   quelqu'un.

   L'entité ne donne aucun droit — deux façons de décider d'un accès, c'est une de
   trop. Elle propose les destinations utiles à ce métier, et reste modifiable. */
function UserModal({ open, user, db, me, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(user ? { ...user, firstName:user.first_name, lastName:user.last_name,
    tabs:[...(user.tabs || db.roles[user.role]?.tabs || [])] } : { tabs:[], role:"viewer", active:true }); },[user]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));

  const role = db.roles[f.role] || {};
  const bureau = (db.offices||[]).find(o=>o.id===f.office_id);
  const pays = (db.countries||[]).find(c=>c.code===f.country_code);
  const ent = D_ENTITIES[f.entity];

  /* Ce que ce compte verra — calculé des mêmes règles que le serveur applique, et
     énoncé en phrases plutôt qu'en cases. */
  const portee = [];
  portee.push(pays ? `Les données de ${pays.name} uniquement`
    : (db.countries||[]).length > 1 ? "Les données de TOUS les pays de l'instance"
    : "Les données du pays servi");
  if(f.tpm_id) portee.push("Uniquement les plans de son prestataire de suivi, quel que soit son rôle");
  else if(bureau) portee.push(bureau.scope_mode === "national" || bureau.kind === "hq"
    ? `Rattaché à ${bureau.name}, qui a un périmètre national : il voit tous les sites`
    : `Uniquement les sites, visites et plans de ${bureau.name}`);
  else portee.push("Tous les bureaux : aucun cloisonnement géographique");

  const actions = [
    ["Consulter les écrans autorisés", true],
    ["Saisir et modifier les données de son périmètre", !!role.edit],
    ["Valider ce que d'autres ont soumis", !!role.validate],
    ["Supprimer des enregistrements", !!role.del],
    ["Administrer la configuration et les comptes", !!role.admin],
  ];

  return (
    <Modal open onClose={onClose} wide title={user?.id?"Modifier le compte":"Nouveau compte"}
      subtitle="Qui est ce compte, ce qu'il peut faire, et où"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.firstName||!f.email||(!user?.id&&!f._pw)} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid gap-4" style={{gridTemplateColumns:"1.6fr 1fr"}}>
        <div>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Prénom"><Input value={f.firstName||""} onChange={e=>u("firstName",e.target.value)} /></Field>
            <Field label="Nom"><Input value={f.lastName||""} onChange={e=>u("lastName",e.target.value)} /></Field>
            <Field label="Intitulé de poste"><Input value={f.title||""} onChange={e=>u("title",e.target.value)} /></Field>
            <Field label="Adresse électronique"><Input type="email" value={f.email||""} onChange={e=>u("email",e.target.value)} /></Field>
          </div>

          <Field label="Entité d'appartenance"
            hint="Qui est ce compte. N'accorde aucun droit : elle propose les destinations utiles à ce métier.">
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(D_ENTITIES).map(([k,e])=>(
                <label key={k} className={clsx("flex items-start gap-2 px-2.5 py-1.5 rounded border cursor-pointer",
                  f.entity===k ? "bd-brand bg-sky-50" : "border-slate-200 hover:bg-slate-50")}>
                  <input type="radio" name="entity" className="mt-1" checked={f.entity===k}
                    onChange={()=>{ u("entity",k);
                      /* Les destinations suivent l'entité tant que le compte est neuf.
                         Sur un compte existant, on ne réécrit pas un réglage que
                         quelqu'un a peut-être affiné à la main. */
                      if(!user?.id) u("tabs",[...e.tabs]); }} />
                  <span className="min-w-0">
                    <span className="f125 font-semibold text-slate-800 block">{e.label}</span>
                    <span className="f105 text-slate-500">{e.text}</span></span>
                </label>))}
            </div></Field>

          <Field label="Rôle" hint="Ce que le compte peut faire. C'est le rôle, et lui seul, qui accorde les droits.">
            <div className="grid gap-1.5">
              {Object.entries(db.roles).map(([k,r])=>(
                <label key={k} className={clsx("flex items-center gap-3 px-3 py-2 rounded border cursor-pointer",
                  f.role===k?"bd-brand bg-sky-50":"border-slate-200 hover:bg-slate-50")}>
                  <input type="radio" name="role" checked={f.role===k} onChange={()=>{u("role",k);u("tabs",[...r.tabs]);}} />
                  <div className="flex-1"><div className="f13 font-semibold text-slate-800">{r.label}</div></div>
                  <Badge tone={r.admin ? "r" : r.validate ? "b" : r.edit ? "g" : "n"}>
                    {r.admin ? "administration" : r.validate ? "validation" : r.edit ? "saisie" : "lecture"}</Badge>
                </label>))}
            </div></Field>

          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Bureau d'appartenance" hint="Restreint la vue aux données de ce bureau, hors administrateurs">
              <Select value={f.office_id||""} onChange={e=>u("office_id",e.target.value)} empty="Tous les bureaux"
                options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
            {/* Le pays borne le compte au-dessus du bureau. « Tous les pays » n'est
                proposé que par un compte lui-même non borné : c'est le périmètre d'un
                bureau régional, pas un champ qu'on laisse vide par distraction. */}
            {(db?.countries || []).length > 1 && (
              <Field label="Pays d'appartenance"
                hint="Au-dessus du bureau : le compte ne voit que les données de ce pays">
                <Select value={f.country_code||""} onChange={e=>u("country_code",e.target.value)}
                  empty={me?.country_code ? undefined : "Tous les pays (bureau régional)"}
                  options={db.countries.map(c=>[c.code,c.name])} /></Field>)}
            <Field label={user?.id?"Nouveau mot de passe":"Mot de passe"}
              hint={user?.id?"Laisser vide pour conserver l'actuel":"Douze caractères au minimum"}>
              <Input type="password" value={f._pw||""} onChange={e=>u("_pw",e.target.value)} /></Field>
          </div>

          <Field label="Destinations accessibles" hint="Affine ce que le rôle et l'entité proposent">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {TABS_ALL.map(([t,l])=>(
                <label key={t} className="inline-flex items-center gap-1.5 f125">
                  <input type="checkbox" checked={(f.tabs||[]).includes(t)}
                    onChange={e=>u("tabs", e.target.checked ? [...new Set([...(f.tabs||[]),t])] : (f.tabs||[]).filter(x=>x!==t))} />
                  {l}</label>))}
            </div></Field>

          <Sw label="Compte actif" hint="Un compte inactif ne peut pas se connecter"
            on={f.active!==false} onChange={v=>u("active",v)} />
        </div>

        {/* ── Ce que ce compte verra ──────────────────────────────────
            Le récapitulatif se met à jour à chaque choix. Sans lui, la seule façon de
            vérifier une décision d'accès était de se connecter à la place de
            quelqu'un — ce que personne ne fait, et c'est ainsi qu'un compte se
            retrouve avec plus de droits qu'on ne croyait. */}
        <div className="bg-slate-50 border border-slate-200 rounded p-3.5 self-start sticky top-2">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
            Ce que ce compte verra</div>
          <div className="f13 font-semibold text-slate-800">
            {(f.firstName||"—")} {(f.lastName||"")}</div>
          <div className="f115 text-slate-500 mb-2">
            {f.title || "sans intitulé"}{ent ? ` · ${ent.label}` : ""}</div>

          <ul className="space-y-1 mb-3">
            {portee.map((x,i)=>(
              <li key={i} className="f115 text-slate-700 flex gap-1.5">
                <span className="c-bd">•</span><span>{x}</span></li>))}
          </ul>

          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
            Ce qu'il pourra faire</div>
          <ul className="space-y-1 mb-3">
            {actions.map(([label, ok])=>(
              <li key={label} className={clsx("f115 flex gap-1.5",
                ok ? "text-slate-700" : "text-slate-400 line-through")}>
                <span>{ok ? "✓" : "✕"}</span><span>{label}</span></li>))}
          </ul>

          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
            Destinations ouvertes</div>
          <div className="flex flex-wrap gap-1">
            {TABS_ALL.filter(([t])=>(f.tabs||[]).includes(t)).map(([t,l])=>(
              <Badge key={t} tone="b">{l}</Badge>))}
            {!(f.tabs||[]).length && <span className="f115 text-amber-700">
              aucune : ce compte ne verrait rien en se connectant</span>}
          </div>

          {f.role === "super" && (
            <Note tone="warn">Un super-utilisateur contrôle toute l'instance, y compris les autres
              pays et la gestion des comptes. Réservez-le à l'administration technique.</Note>)}
          {f.tpm_id && (f.role === "admin" || f.role === "super") && (
            <Note tone="err">Un compte rattaché à un prestataire ne peut pas être administrateur :
              l'enregistrement sera refusé.</Note>)}
        </div>
      </div>
    </Modal>);
}

export { BulkBar, IndicatorModal, OdkModal, SetApi, SetCalc, SetGeneral, SetIndicators, SetOdk, SetTemplates, SetUsers, SettingsView, SiteModal, SitesModule, UserModal };
