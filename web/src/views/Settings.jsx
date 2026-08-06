import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api } from "../lib/api.js";
import { useGeoCascade, resetGeoCache } from "../lib/geo.js";
import { Activity, ArrowRightLeft, Building2, CalendarRange, Check, ChevronDown, ChevronRight, ClipboardList, Copy, Download, FileText, KeyRound, Layers, Link2, MapPin, Pencil, Plus, RefreshCw, Save, Search, Target, Trash2, Upload, X } from "lucide-react";
import { Area, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Aide, Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, SideRail, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { LEVELS, clsx, codeVariable, computeMMR, computeParam, evalFormula, fmt, motifLisible, n, pct, r2, r5, siteRequirement, siteScore, uid, variablesProcessus, visiteOdk } from "../lib/calc.js";
import { ACT_CATEGORIES, C, CALC_VARS, CAT_TO_AREA, DURATIONS, D_FORMULAS, D_SECURITY, D_STATUS, D_URBAN, MONITORING_TYPES, PROG_AREAS, SITE_TYPES, TABS_ALL, siteDerived, sitePriority } from "../lib/constants.js";
import { collecterLocalites, csvLocalites } from "../lib/exportGeo.js";
import { niveau, niveaux } from "../lib/levels.js";
import { Sources } from "./ActualData.jsx";
import { MonthCellModal, MonthGrid, MonthLegend, PDD_ACTS, PDD_COMMODITIES } from "./Planning.jsx";
import { SetListes, RenommageModal } from "./Listes.jsx";
import { SetCodeReferentiels } from "./Referentiels.jsx";
import { GpsAudit } from "./GpsAudit.jsx";
import { BLOCKS } from "./Reports.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Paramètres ══════════════════
   Les dix-huit écrans de configuration ne tiennent pas — et ne DOIVENT pas
   tenir — sur une seule rangée d'onglets : à l'écran, le dernier débordait
   déjà (« ODK Cer… »). Ils sont regroupés par SUJET dans un rail à gauche,
   avec un intitulé de catégorie par groupe et ses écrans dessous. C'est la
   même forme maître-détail que l'écran des listes typées : on choisit le
   sujet à gauche, on le configure à droite.

   Le regroupement suit ce qu'on FAIT, pas la table sous-jacente :
     · Configuration       — les briques fondatrices (pays, découpage, général)
     · Référentiels         — les listes canoniques réutilisées partout
     · Organisation & lieux — bureaux, périmètres, répertoire des localités
     · Collecte & sources   — d'où viennent les données
     · Calculs & rations    — comment MEMS les transforme
     · Restitution & accès  — ce qui sort, et qui entre */
const SETTINGS_GROUPS = (superUser) => [
  { cle:"config", label:"Configuration", items:[
    ...(superUser ? [["guided","Configuration guidée"]] : []),
    ["general","Général"], ["country","Pays & découpage"] ] },
  { cle:"ref", label:"Référentiels", items:[
    ["activities","Activités"], ["listes","Listes paramétrables"],
    ["indicators","Indicateurs"], ["codes","Référentiels de codes"] ] },
  { cle:"org", label:"Organisation & lieux", items:[
    ["offices","Bureaux"], ["scope","Périmètre des bureaux"], ["locations","Localités"],
    ["gps","Vérification GPS"] ] },
  { cle:"src", label:"Collecte & sources", items:[
    ["sources","Sources de données"] ] },
  { cle:"calc", label:"Calculs & rations", items:[
    ["calc","Calculs"], ["rations","Rations"] ] },
  { cle:"acces", label:"Restitution & accès", items:[
    ["templates","Modèles de rapport"], ["api","API"],
    ["users","Utilisateurs"], ["about","À propos"] ] },
];

function SettingsView({ db, set, me, sub, setSub, notify, can, reload }){
  const superUser = me?.role === "super";
  const groups = SETTINGS_GROUPS(superUser);
  const allItems = groups.flatMap(g => g.items);
  /* Un sujet toujours affiché : si `sub` n'existe pas (défaut, ou onglet retiré
     pour ce rôle), on retombe sur le premier — jamais un panneau vide. */
  const active = allItems.some(i => i[0] === sub) ? sub : (allItems[0]?.[0] || "general");
  const activeLabel = allItems.find(i => i[0] === active)?.[1] || "";
  const activeGroup = groups.find(g => g.items.some(i => i[0] === active))?.label || "";
  return (
    <div className="space-y-4">
      <PageHead title="Paramètres"
        text="Configuration de l'application, référentiels, calculs, sources et accès — regroupés par sujet." />
      <div className="grid gap-4 items-start" style={{ gridTemplateColumns:"244px minmax(0,1fr)" }}>
        {/* ── Rail des catégories et sous-catégories ── */}
        <nav className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-auto sticky"
          style={{ top:"0.75rem", maxHeight:"calc(100vh - 90px)" }}>
          <div className="py-1.5">
            {groups.map(g => (
              <div key={g.cle} className="mb-0.5">
                <div className="px-4 pt-3 pb-1 f10 font-bold uppercase tracking-wider text-slate-400">{g.label}</div>
                {g.items.map(([v,l]) => (
                  <button key={v} onClick={()=>setSub(v)}
                    className={clsx("w-full text-left px-4 py-2 f125 border-l-2 transition-colors",
                      active===v
                        ? "bg-sky-50 bd-brand c-bd font-semibold"
                        : "border-l-transparent text-slate-600 hover:bg-slate-50 hover:text-slate-900")}>
                    {l}</button>))}
              </div>))}
          </div>
        </nav>

        {/* ── Panneau du sujet choisi ── */}
        <div className="min-w-0">
          {/* Fil d'Ariane : catégorie › sous-catégorie, pour savoir où l'on est. */}
          <div className="flex items-center gap-2 f11 text-slate-400 mb-3">
            <span className="uppercase tracking-wide font-semibold">{activeGroup}</span>
            <span>›</span>
            <span className="text-slate-700 font-semibold">{activeLabel}</span>
          </div>
      {active==="guided" && superUser && <SetGuided db={db} setSub={setSub} />}
      {active==="general" && <SetGeneral db={db} set={set} />}
      {active==="country" && <SetCountry db={db} notify={notify} can={can} reload={reload} />}
      {active==="offices" && <SetOffices db={db} notify={notify} can={can} reload={reload} />}
      {active==="about" && <SetAbout db={db} />}
      {active==="locations" && <SetLocations db={db} set={set} notify={notify} can={can} reload={reload} me={me} />}
      {/* La vérification GPS des sites — déplacée du suivi vers les paramètres,
          au plus près du référentiel des localités qu'elle contrôle. */}
      {active==="gps" && <GpsAudit db={db} notify={notify} can={can} />}
      {active==="scope" && <SetScope db={db} notify={notify} can={can} />}
      {active==="activities" && <SetActivities db={db} notify={notify} can={can} reload={reload} me={me} />}
      {active==="listes" && <SetListes notify={notify} can={can} me={me} />}
      {active==="indicators" && <SetIndicators db={db} set={set} notify={notify} can={can} />}
      {active==="calc" && <SetCalc db={db} set={set} notify={notify} can={can} />}
      {active==="rations" && <SetRations db={db} set={set} notify={notify} can={can} />}
      {(active==="sources" || active==="odk" || active==="connectors") &&
        <SetSources db={db} set={set} notify={notify} can={can} reload={reload}
          depart={active==="odk" ? "odk" : "connectors"} />}
      {active==="codes" && <SetCodeReferentiels notify={notify} can={can} />}
      {active==="templates" && <SetTemplates db={db} set={set} notify={notify} can={can} />}
      {active==="api" && <SetApi db={db} notify={notify} />}
      {active==="users" && <SetUsers db={db} set={set} me={me} notify={notify} />}
        </div>
      </div>
    </div>);
}

/* ══════════════════ Configuration guidée (parcours fondateur S7) ══════════════════
   « La config est à faire en une fois et stockée dans la base de données (à faire
   par le super user), avec possibilité de mise à jour. » Un parcours qui rassemble
   en une page les cinq briques fondatrices — pays, découpage, activités,
   indicateurs, sources —, dit ce qui est prêt et ce qui reste, et mène à chaque
   étape. L'état est LU de la base (données réelles), donc toujours à jour ; chaque
   brique se rouvre et se révise à tout moment (mise à jour possible). Réservé au
   super-utilisateur. */
function SetGuided({ db, setSub }){
  const crf = (db.indicators || []).filter(i => (i.kind || "crf") === "crf").length;
  const xls = (db.indicators || []).filter(i => i.kind === "xlsform").length;
  const geoUnits = db.geoVersion?.units || 0;
  const etapes = [
    { cle:"country", icon:MapPin, titre:"Pays",
      desc:"Le pays courant et le vocabulaire de son découpage (régions, districts, communes…).",
      pret: !!db.country?.code, tab:"country",
      etat: db.country?.code ? `${db.country.name} (${db.country.code})` : "Aucun pays courant" },
    { cle:"decoupage", icon:Layers, titre:"Découpage administratif",
      desc:"Le shapefile du pays : l'arbre adm0→adm4 et ses contours, importés depuis la fiche du pays.",
      pret: geoUnits > 0, tab:"country",
      etat: geoUnits > 0 ? `${fmt(geoUnits)} unités · ${db.geoVersion?.geom?.units ? fmt(db.geoVersion.geom.units)+" contours" : "sans contours"}` : "Aucun découpage chargé" },
    { cle:"activities", icon:Activity, titre:"Activités",
      desc:"Le référentiel des activités du programme — la source unique réutilisée partout.",
      pret: (db.activities || []).length > 0, tab:"activities",
      etat: (db.activities || []).length ? `${fmt(db.activities.length)} activité(s)` : "Aucune activité" },
    { cle:"indicators", icon:Target, titre:"Indicateurs",
      desc:"La bibliothèque CRF (résultats) et XLSForm (processus) qui alimente tableaux de bord et rapports.",
      pret: (db.indicators || []).length > 0, tab:"indicators",
      etat: (db.indicators || []).length ? `${fmt(crf)} CRF · ${fmt(xls)} processus` : "Aucun indicateur" },
    { cle:"sources", icon:Link2, titre:"Sources de données",
      desc:"Les formulaires ODK Central et les connecteurs qui alimentent la collecte.",
      pret: (db.odkForms || []).length > 0, tab:"sources",
      etat: (db.odkForms || []).length ? `${fmt(db.odkForms.length)} formulaire(s) ODK` : "Aucune source configurée" },
  ];
  const prets = etapes.filter(e => e.pret).length;
  return (
    <div className="space-y-4">
      <Card title="Configuration guidée"
        subtitle="Le parcours fondateur — pays, découpage, activités, indicateurs, sources. Réservé au super-utilisateur.">
        <Note>Chaque brique se configure ici, puis reste consultable et modifiable à tout moment ;
          l'état ci-dessous est <b>lu de la base</b>, il reflète la configuration réelle. Menez les
          étapes dans l'ordre : chacune prépare la suivante.</Note>
        <div className="flex items-center gap-3 mt-3">
          <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width:`${(prets/etapes.length)*100}%`, background:C.aqua }} /></div>
          <span className="f13 font-semibold text-slate-700 tabular-nums">{prets} / {etapes.length} prêtes</span>
        </div>
      </Card>
      <div className="space-y-3">
        {etapes.map((e,i)=>(
          <Card key={e.cle}>
            <div className="flex items-start gap-4">
              <div className={clsx("w-10 h-10 rounded-full grid place-items-center shrink-0 font-bold",
                e.pret ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-400")}>
                {e.pret ? <Check size={20}/> : (i+1)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <e.icon size={15} className="text-slate-400" />
                  <span className="f15 font-semibold text-slate-800">{e.titre}</span>
                  {e.pret ? <Badge tone="g">Prêt</Badge> : <Badge tone="n">À configurer</Badge>}
                </div>
                <p className="f125 text-slate-500 mt-0.5 leading-relaxed">{e.desc}</p>
                <p className="f12 text-slate-600 mt-1"><b className="text-slate-400 uppercase tracking-wide f10">État&nbsp;:</b> {e.etat}</p>
              </div>
              <Btn size="sm" kind={e.pret?"sec":"primary"} onClick={()=>setSub(e.tab)}>
                {e.pret ? "Revoir" : "Configurer"}</Btn>
            </div>
          </Card>))}
      </div>
      {prets === etapes.length && <Note tone="ok">Toutes les briques fondatrices sont en place.
        La configuration reste modifiable étape par étape à tout moment.</Note>}
    </div>);
}

/* `Aide` (aide repliable) et `SideRail` (sous-navigation EN HAUT) vivent
   désormais dans components/ui.jsx : tous les écrans de paramètres — y compris
   Listes et Référentiels, dans leurs propres fichiers — s'en servent, et un
   composant partagé ne peut pas rester enfermé dans un seul écran. */

/* Général — désormais en maître-détail, et débarrassé de ses éditeurs de
   listes : partenaires, modalités, sous-types de PI et activity tags étaient
   dupliqués avec « Listes paramétrables » (et l'onglet « Activités »). On les
   retire d'ici — une liste, un seul endroit — et Général ne garde que ce qui
   lui est propre : l'identité de l'instance et le barème de priorité. */
function SetGeneral({ db, set }){
  const s = db.settings; const u = (k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const [sec,setSec] = useState("identity");
  const groups = [{ label:"Réglages généraux", items:[
    { value:"identity", label:"Identité et affichage" },
    { value:"scoring", label:"Barème de priorité de suivi" },
  ] }];
  const identity = (
    <Card title="Identité et affichage" subtitle="Nom de l'instance et présentation">
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
        {/* Productivité de collecte par DÉFAUT, pour le calcul des jours d'un plan
            de suivi tiers (TPM) d'après le MMR. Une valeur propre à un couple
            (bureau, activité) la surcharge dans « Calculs automatiques ». */}
        <Field label="Sites à suivre par jour et par agent"
          hint="Valeur par défaut du calcul des jours d'un plan TPM (MMR). 0 = non renseigné ; une productivité par bureau × activité la surcharge dans « Calculs automatiques ».">
          <Input type="number" min="0" value={s.sitesJourAgent ?? 0}
            onChange={e=>u("sitesJourAgent",n(e.target.value))} /></Field>
      </div>
    </Card>);
  const scoring = (
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
      </Card>);
  return (
    <SideRail groups={groups} active={sec} onPick={setSec}
      right={<>
        <Aide>Les listes — partenaires, modalités, sous-types de point d'intérêt, activity tags,
          catégories… — se configurent désormais dans <b>Référentiels → Listes paramétrables</b> et
          l'onglet <b>Activités</b> : une liste, un seul endroit. Général ne garde que ce qui lui est
          propre — l'identité de l'instance et le barème de priorité.</Aide>
        {sec==="identity" && identity}
        {sec==="scoring" && scoring}
      </>} />
  );
}

function SetAbout({ db }){
  return (
    <div className="space-y-4">
      <Card title="À propos de MEMS" subtitle="Monitoring and Evaluation Management System">
        <p className="text-slate-600 leading-relaxed">MEMS est l'interface de suivi et de pilotage du bureau — planification du suivi
          fondée sur le risque, réalisation des visites, couverture géographique, indicateurs de résultat et
          rapports. Elle s'appuie sur un serveur unique : la donnée saisie est la donnée réelle de production.</p>
        <p className="text-slate-600 leading-relaxed mt-2"><b>Mode démonstration.</b> Pour présenter l'application
          sans risque, le super-utilisateur active le <b>mode démonstration</b> depuis le menu du compte (en haut à
          droite) : on peut remplir tous les formulaires, mais rien n'est enregistré sur les données réelles. Un
          rechargement rétablit la production intacte.</p>
      </Card>
      <Card title="Instance" subtitle="Contexte courant">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {[["Organisation", db.settings?.org || "—"], ["Unité", db.settings?.unit || "—"],
            ["Exercice", String(db.year)], ["Devise", db.settings?.currency || "—"]].map(([k,v])=>(
            <div key={k} className="flex flex-col">
              <span className="f10 uppercase tracking-wide font-bold text-slate-400">{k}</span>
              <span className="f13 text-slate-800">{v}</span></div>))}
        </div>
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
    planned: scoped.filter(s=>s.plan.some(p=>p.planned)).length,
    /* Un site sans aucune soumission rattachée n'est pas forcément un site sans
       activité : c'est le plus souvent son code externe qui manque. Le compte est
       ici pour que l'écart se voie sans ouvrir une fiche. */
    alimentes: scoped.filter(s=>(s.submissions||0)>0).length };
  const avg = pct(scoped.reduce((t,s)=>t+s.plan.filter(p=>p.done).length,0),
                  scoped.reduce((t,s)=>t+s.plan.filter(p=>p.planned).length,0));

  const saveSite = async (site) => {
    /* Le serveur applique l'unicité du code, le cloisonnement par bureau et la trace. */
    const payload = {
      code: site.code || site.id || ("L" + Date.now().toString(36).toUpperCase()),
      name: site.poi || "", status: site.status || "Active",
      /* Le serveur écrit TOUTES les colonnes de la fiche à chaque enregistrement :
         omettre le code externe ici ne le préserverait pas, cela l'effacerait. Il
         est donc relu à l'ouverture de la fiche (voir SiteModal) et renvoyé tel quel. */
      external_code: (site.externalCode || "").trim() || null,
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
        /* Le code externe retenu vient de la réponse du serveur, pas du formulaire :
           c'est la seule version que le résolveur de soumissions comparera. */
        const merged = { ...site, id:saved.id, code:saved.code, poi:saved.name,
          externalCode: saved.external_code || "" };
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
      visitesPlanifiees: s.plan.filter(p=>p.planned).length, visitesRealisees: s.plan.filter(p=>p.done).length,
      /* Les deux dates partent côte à côte : un export qui n'emporterait que la
         date retenue ferait disparaître la saisie du jour où l'ODK la dépasse. */
      derniereVisiteOdk: s.lastVisitOdk || "", derniereVisiteRetenue: s.lastVisitEffective || s.lastVisit || "",
      soumissions: s.submissions || 0 })),
    ["id","status","poi","poiSubtype","poiSubtypeCode","activityTag","subOffice","adm1","adm2","adm3","urbanArea",
     "lat","lon","security","modality","beneficiaries","partner","responsible","lastVisit",
     "derniereVisiteOdk","derniereVisiteRetenue","soumissions","score","priorite",
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
      {/* Le code externe est le seul point du registre par lequel la chaîne de
          collecte entre : tant qu'il n'est pas renseigné, les soumissions restent
          non rattachées et les colonnes ci-dessous restent vides. L'explication est
          ici plutôt que dans la fiche seule, parce qu'elle se lit avant d'ouvrir
          une fiche — et parce qu'elle vaut aussi pour la lecture du tableau. */}
      <Note>
        <b>Code externe et soumissions.</b> Chaque site peut porter le code que le formulaire de
        collecte emploie pour le désigner — il se saisit dans la fiche, onglet « Identification ».
        C'est sur lui que les soumissions se rattachent automatiquement à un site ; sans lui, le
        rapprochement retombe sur le nom, qui ne départage pas deux sites homonymes. La colonne
        « Soumissions » compte celles qui sont rattachées, et « Dernière visite » affiche la date
        observée sur le terrain quand il en existe une, la date saisie sinon. Les soumissions qui
        n'ont trouvé aucun site se relisent sous <b>Programme → Soumissions</b>.
      </Note>
      <StatRow>
        <Stat label="Total des sites" value={stats.total} sub="Sites gérés" icon={MapPin} />
        <Stat label="Sites actifs" value={stats.active} sub={`${stats.total-stats.active} inactifs`} icon={Activity} />
        <Stat label="Sites planifiés" value={stats.planned} sub="Au moins une échéance" icon={CalendarRange} />
        <Stat label="Sites à visiter" value={stats.toVisit} sub="Échéance non honorée" tone={stats.toVisit?"warn":"ok"} icon={Target} />
        <Stat label="Sites suivis" value={stats.done} sub="Au moins une visite" tone="ok" icon={Check} />
        <Stat label="Sites alimentés" value={stats.alimentes} tone={stats.alimentes?"ok":"warn"}
          sub={`${stats.total-stats.alimentes} sans aucune soumission`} icon={Link2} />
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
              <Th>Priorité de suivi</Th><Th>Dernière visite</Th><Th num>Soumissions</Th>
              <Th num>Visites</Th><Th num>À programmer</Th>
              <Th>Suivi</Th><Th>Responsable</Th><Th />
            </tr></thead>
            <tbody>{shown.map(s=>{
              const sc = siteScore(s, db.weights, db); const req = siteRequirement(db, s);
              const done = s.plan.filter(p=>p.done).length, planned = s.plan.filter(p=>p.planned).length;
              const prog = pct(done, Math.max(planned, req.required||1));
              const code = (db.lists.poiSub.find(p=>p.label===s.poiSubtype)||{}).code || "";
              const sec = (D_SECURITY.find(x=>x[0]===s.security)||[])[1] || String(s.security);
              /* La date retenue est celle du serveur ; l'origine se déduit de la seule
                 présence d'une date ODK, puisque c'est elle qui prime quand elle existe.
                 La valeur saisie n'est pas remplacée, elle passe dans l'info-bulle. */
              const visite = s.lastVisitEffective || s.lastVisit || "";
              const visiteOdk = !!s.lastVisitOdk;
              const soumissions = s.submissions || 0;
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
                  <Td title={visiteOdk
                        ? `Observée sur le terrain (ODK) : ${s.lastVisitOdk}. Valeur saisie conservée : ${s.lastVisit || "aucune"}.`
                        : visite ? "Valeur saisie dans la fiche. Aucune soumission ODK rattachée à ce site."
                                 : "Aucune visite, ni saisie ni observée."}>
                    {visite
                      ? <span className="inline-flex items-center gap-1.5"><span className="tabular-nums">{visite}</span>
                          <Badge tone={visiteOdk?"b":"n"}>{visiteOdk?"observée":"saisie"}</Badge></span>
                      : <span className="text-slate-400">Jamais</span>}</Td>
                  <Td num title={soumissions
                        ? `${soumissions} soumission(s) rattachée(s) à ce site`
                        : "Aucune soumission rattachée — vérifiez le code externe de la fiche"}>
                    {soumissions ? <span className="text-lime-700 font-semibold">{fmt(soumissions)}</span>
                                 : <span className="text-slate-400">0</span>}</Td>
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
  /* Le code externe ne figure pas dans l'état chargé au démarrage : il est lu sur
     la fiche du serveur à l'ouverture. Cette lecture n'est pas un confort — sans
     elle, l'enregistrement renverrait un code vide et effacerait le rattachement
     automatique des soumissions du site qu'on vient simplement de renommer. */
  const [lecture,setLecture] = useState("ok");
  useEffect(()=>{
    setF(site||{}); setTab("id");
    if(!site?.id){ setLecture("ok"); return; }
    let vivant = true; setLecture("encours");
    api.get(`/sites/${encodeURIComponent(site.id)}`)
      .then(r => { if(!vivant) return;
        setF(p => ({ ...p, externalCode: r.site?.external_code || "" })); setLecture("ok"); })
      .catch(() => { if(vivant) setLecture("echec"); });
    return () => { vivant = false; };
  },[site]);
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
        {/* Enregistrer pendant la lecture du code externe reviendrait à l'écraser
            avec une case vide : le bouton attend que la fiche soit complète. */}
        <Btn icon={Save} disabled={lecture==="encours" || !(f.adm4||"").trim()}
          title={(f.adm4||"").trim() ? "" : "Renseignez le fokontany (adm4) : c'est le parent obligatoire du site"}
          onClick={()=>onSave({ ...f, geo_pcode: geo.pcode })}>{site?.id?"Mettre à jour":"Créer le site"}</Btn></>}>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["id","Identification"],["risk","Critères de risque"],["plan","Suivi"]]} />
      {lecture==="echec" && <Note tone="warn">Le code externe de ce site n'a pas pu être lu.
        Fermez la fiche et rouvrez-la : enregistrer maintenant effacerait ce code, et les prochaines
        soumissions de ce site ne se rattacheraient plus automatiquement.</Note>}
      {tab==="id" && (<>
        {!(f.adm4||"").trim() && (
          <div className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2 flex items-center gap-2 f115 text-amber-900">
            <MapPin size={14} className="shrink-0" /><span>Un site doit être rattaché à un <b>fokontany (adm4)</b> — renseignez-le plus bas pour pouvoir enregistrer.</span></div>)}
        <div className="grid grid-cols-3 gap-x-4">
          <Field label="ID"><Input value={f.id||""} onChange={e=>u("id",e.target.value)} placeholder="Généré si vide" /></Field>
          <Field label="Code externe (ODK)" className="col-span-2"
            hint="Code que le formulaire de collecte porte pour désigner ce site (par exemple MG23210070009001). C'est sur lui que les soumissions se rattachent automatiquement à ce site ; laissé vide, le rapprochement ne peut plus s'appuyer que sur le nom.">
            <Input value={f.externalCode||""} onChange={e=>u("externalCode",e.target.value)}
              disabled={lecture==="encours"} maxLength={80}
              placeholder={lecture==="encours" ? "Lecture du code enregistré…" : "Aucun — rattachement par le nom seulement"} /></Field>
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
          {/* adm4 (fokontany) est le PARENT OBLIGATOIRE d'un site — « un site ne peut
              être inséré sans adm4 comme parent ». Le shapefile fokontany (~80 Mo)
              n'étant pas chargé, la cascade est vide : on saisit alors le fokontany
              à la main (liste de suggestions si le niveau est chargé). */}
          <Field label="Admin level 4 — fokontany" hint="Parent obligatoire du site">
            {adm4s.length
              ? <Select value={f.adm4||""} onChange={e=>u("adm4",e.target.value)} empty="— (obligatoire)" options={adm4s} />
              : <Input value={f.adm4||""} onChange={e=>u("adm4",e.target.value)} placeholder="Fokontany (obligatoire)"
                  className={(f.adm4||"").trim() ? "" : "border-amber-300 bg-amber-50/40"} />}
          </Field>
          <Field label="Urban Area"><Select value={f.urbanArea||"Non"} onChange={e=>u("urbanArea",e.target.value)} options={D_URBAN} /></Field>
          <Field label="Modality type"><Select value={f.modality||""} onChange={e=>u("modality",e.target.value)} empty="—" options={db.lists.modalities} /></Field>
          <Field label="GPS Latitude"><Input type="number" step="0.000001" value={f.lat??""} onChange={e=>u("lat",e.target.value)} /></Field>
          <Field label="GPS Longitude"><Input type="number" step="0.000001" value={f.lon??""} onChange={e=>u("lon",e.target.value)} /></Field>
          <Field label="Beneficiary number"><Input type="number" value={f.beneficiaries??0} onChange={e=>u("beneficiaries",n(e.target.value))} /></Field>
          <Field label="Security situation" className="col-span-2"><Select value={f.security??0} onChange={e=>u("security",n(e.target.value))} options={D_SECURITY} /></Field>
          <Field label="Partenaire coopérant"><Select value={f.partner||""} onChange={e=>u("partner",e.target.value)} empty="—" options={db.lists.partners} /></Field>
        </div></>)}
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
            {/* Les trois dates côte à côte : la saisie reste modifiable et n'est
                jamais remplacée, l'observée vient des soumissions rattachées, et la
                troisième dit seulement laquelle des deux l'emporte à l'affichage. */}
            <Field label="Dernière visite (saisie)" hint="La grille mensuelle la pose au 15 du mois">
              <Input type="date" value={f.lastVisit||""} onChange={e=>u("lastVisit",e.target.value)} /></Field>
            <Field label="Dernière visite observée" hint="Date déclarée sur le terrain dans la soumission">
              <Input value={f.lastVisitOdk||"—"} readOnly /></Field>
            <Field label="Dernière visite retenue"
              hint={f.lastVisitOdk ? "L'observée prime sur la saisie" : "Aucune soumission rattachée à ce site"}>
              <Input value={f.lastVisitEffective||f.lastVisit||"—"} readOnly /></Field>
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
            {/* Les visites de l'année, avec d'où elles viennent et pourquoi quand
                aucun formulaire ne les porte. La fiche est l'endroit où l'on juge
                un site : y lire « quatre visites » sans savoir que trois sont des
                rattrapages non expliqués reviendrait à juger sur un chiffre creux.
                `db.visits` est déjà chargé, aucun appel supplémentaire. */}
            <div className="col-span-4 mt-2">
              <div className="f11 font-semibold text-slate-600 mb-1">Visites de l'année {db.year}</div>
              {(()=>{ const vs = (db.visits||[]).filter(v => v.siteId===f.id
                  && String(v.date||"").startsWith(String(db.year)))
                  .slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)));
                if(!vs.length) return <div className="f115 text-slate-500 py-2">Aucune visite enregistrée cette année.</div>;
                return (<TableWrap max="mh300">
                  <thead><tr><Th>Date</Th><Th>Origine</Th><Th>Motif</Th><Th>Précision</Th><Th>Statut</Th></tr></thead>
                  <tbody>{vs.map(v=>{ const odk = visiteOdk(v); return (
                    <tr key={v.id}>
                      <Td className="f115">{v.date}</Td>
                      <Td><Badge tone={odk?"b":"y"}>{odk?"ODK":"Manuelle"}</Badge></Td>
                      <Td className="f115 text-slate-600">{odk ? "—" : motifLisible(db, v.motif)}</Td>
                      <Td className="f115 text-slate-500">{v.motifNote || "—"}</Td>
                      <Td><Badge tone={v.status==="Validé"?"g":v.status==="Erreur"?"r":"y"}>{v.status}</Badge></Td>
                    </tr>); })}</tbody>
                </TableWrap>); })()}
            </div>
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
      <Aide>Le découpage administratif du schéma est neutre : <code className="bg-white px-1 rounded">adm0</code>
        {" "}à <code className="bg-white px-1 rounded">adm4</code>. Ce sont les <b>libellés</b> qui sont propres à
        un pays — région, district, commune, fokontany à Madagascar ; province, territoire, secteur,
        groupement en RDC. Ils sont configurés ici et utilisés partout, plutôt que réécrits écran par écran.
        <br /><br />
        <b>Un seul pays est courant à la fois.</b> C'est ce qui correspond à un déploiement par bureau
        pays. Servir plusieurs pays depuis une même instance supposerait de rattacher les sites, les
        bureaux et les comptes à un pays — une autre décision, celle de savoir si un utilisateur
        traverse les frontières.</Aide>

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

      {/* Le découpage — shapefile, dbf et contours — se configure DANS la fiche
          du pays (« sur l'interface d'insertion des données du pays »), plus dans
          des cartes séparées sous le tableau : on ouvre le pays, on injecte, on
          lit le récap par niveau. Le millésime se rattache au pays ouvert. */}

      <Modal open={!!edit} wide onClose={()=>setEdit(null)}
        title={edit?._existe ? `Configuration de ${edit.name}` : "Nouveau pays"}
        subtitle="Identité, découpage administratif et contours — tout ce qui décrit ce pays"
        footer={<><Btn kind="sec" onClick={()=>setEdit(null)}>Fermer</Btn>
          <Btn icon={Save} disabled={busy || !edit?.name?.trim() || (edit?.code||"").length !== 3}
            onClick={enregistrer}>{busy ? "Enregistrement…" : "Enregistrer l'identité"}</Btn></>}>
        {edit && (<>
          <SectionTitle n="1" title="Identité et vocabulaire"
            hint="Nom, devise, centre de la carte et libellés des cinq niveaux administratifs." />
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

          {/* ── Découpage administratif, DANS la fiche du pays ──────────────
              « Sur l'interface d'insertion des données du pays, on injecte le
              shapefile et les dbf, et en bas un récap des nombres par niveau. »
              Le shapefile se rattache à un pays qui EXISTE et qui est COURANT
              (un seul l'est à la fois) : les deux gardes ci-dessous le disent
              plutôt que de laisser un import partir dans le vide. */}
          <div className="mt-6 -mx-5 px-5 pt-5 border-t border-slate-200 bg-slate-50/70">
            <SectionTitle n="2" title="Découpage administratif — shapefile et dbf"
              hint="Le fichier des limites du pays. Il construit l'arbre région → district → commune → fokontany et le fond de carte." />
            {!edit._existe ? (
              <Note tone="warn">Enregistrez d'abord l'identité de ce pays (bouton ci-dessous), puis
                rouvrez sa fiche : le découpage se rattache à un pays qui existe.</Note>
            ) : !edit.current ? (
              <Note tone="warn">Ce pays n'est pas le pays courant. Le découpage se configure sur le
                pays courant — un seul l'est à la fois. Fermez cette fiche, cliquez
                <b> « Rendre courant »</b> sur la ligne de {edit.name}, puis rouvrez-la.
                {edit.versions ? ` (${edit.versions} millésime(s) déjà chargé(s) pour ce pays.)` : ""}</Note>
            ) : (<>
              <SetShapefileServer db={db} notify={notify} can={can} country={edit} inline
                onCommitted={async ()=>{
                  /* Le millésime importé devient le référentiel courant du pays :
                     on rafraîchit la fiche (compteur de millésimes), on vide le
                     cache géo et on remonte les libellés, sinon les écrans
                     garderaient l'ancien découpage jusqu'au prochain F5. */
                  resetGeoCache(); await charger(); if(reload) await reload();
                }} />
              <SetContoursNiveaux db={db} notify={notify} can={can} inline
                onCommitted={async ()=>{ resetGeoCache(); if(reload) await reload(); }} />
              {/* ── En bas : le récap des nombres par niveau ── */}
              <RecapNiveaux db={db} />
            </>)}
          </div>
        </>)}
      </Modal>
    </>);
}

/* Un intitulé de section numéroté, pour découper la fiche du pays en étapes
   lisibles — identité, découpage, récap — plutôt qu'un long formulaire. */
function SectionTitle({ n, title, hint }){
  return (
    <div className="flex items-start gap-3 mb-3">
      <span className="w-6 h-6 rounded-full grid place-items-center f11 font-bold shrink-0 bg-sky-100 c-bd">{n}</span>
      <div className="min-w-0">
        <div className="f13 font-semibold text-slate-800">{title}</div>
        {hint && <div className="f115 text-slate-500 leading-snug">{hint}</div>}
      </div>
    </div>);
}

/* Le récap demandé : ce que le millésime courant porte, NIVEAU PAR NIVEAU —
   combien d'unités de découpage, combien de contours cartographiques, et si le
   fond de carte est complet à ce niveau. Lu de l'état (db.geoVersion), il
   reflète toujours ce qui vient d'être injecté ou dérivé, sans recalcul. */
function RecapNiveaux({ db }){
  const gv = db.geoVersion;
  const NIV = niveaux(db, { from:"adm0", to:"adm4" });
  const contours = Object.fromEntries((gv?.geom?.parNiveau || []).map(x => [x.level, x.units]));
  const totUnites = Object.values(gv?.counts || {}).reduce((a,b)=>a+b, 0);
  const totContours = gv?.geom?.units || 0;
  return (
    <div className="pb-5">
      <div className="f11 font-bold uppercase tracking-wider text-slate-500 mb-2 mt-1">
        Récapitulatif par niveau</div>
      {!gv ? (
        <Note tone="warn">Aucun découpage chargé pour ce pays : injectez un shapefile ci-dessus.</Note>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <TableWrap max="mh300">
            <thead><tr><Th>Niveau</Th><Th num>Unités du découpage</Th>
              <Th num>Contours cartographiques</Th><Th>Fond de carte</Th></tr></thead>
            <tbody>{NIV.map(([code,label])=>{
              const u = gv.counts?.[code] || 0;
              const c = contours[code] || 0;
              return (
                <tr key={code} className={clsx(!u && "opacity-50")}>
                  <Td className="font-medium text-slate-800">{label}
                    <span className="text-slate-400 f11"> {code}</span></Td>
                  <Td num className={u ? "font-semibold text-slate-700" : "text-slate-400"}>{u ? fmt(u) : "—"}</Td>
                  <Td num className={c ? "font-semibold text-slate-700" : "text-slate-400"}>{c ? fmt(c) : "—"}</Td>
                  <Td>{!u ? <span className="text-slate-400 f11">—</span>
                    : c >= u ? <Badge tone="g">complet</Badge>
                    : c ? <Badge tone="y">partiel · {Math.round((c/u)*100)} %</Badge>
                    : <Badge>aucun contour</Badge>}</Td>
                </tr>);
            })}</tbody>
            <tfoot><tr className="bg-slate-50 border-t-2 border-slate-200">
              <Td className="font-bold text-slate-800">Total</Td>
              <Td num className="font-bold text-slate-800">{fmt(totUnites)}</Td>
              <Td num className="font-bold text-slate-800">{fmt(totContours)}</Td>
              <Td /></tr></tfoot>
          </TableWrap>
        </div>)}
    </div>);
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
      <Aide>Un bureau est une entité de la base : il porte les sites, les comptes, les
        paramètres de couverture et le plan de distribution. Son <b>mode de périmètre</b>{" "}
        décide de ce que ses comptes non administrateurs peuvent voir —
        soit les unités qui lui sont attribuées (Paramètres → Périmètre des bureaux),
        soit <b>tout le pays</b> pour le bureau central.</Aide>

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
      <Aide>Un bureau couvre les unités qui lui sont <b>attribuées</b>, à n'importe quel
        niveau — le plus souvent un district. Le périmètre effectif est tout ce qui en
        descend. Tant qu'aucune unité n'est attribuée, il est <b>déduit</b> des sites et
        du plan de distribution du bureau : c'est un repli, pas une intention.
        <br /><br />
        Ce périmètre borne ce qu'un compte rattaché à ce bureau peut lire et écrire —
        population, ciblage, couverture géographique, et les lignes que ses modèles
        d'import contiennent.</Aide>

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

/* ── Téléversement d'un shapefile, lu par le SERVEUR ──────────────────
   Le navigateur n'embarque plus de parseur : il dépose les fichiers (un .zip, ou
   .shp + .dbf + .prj), le serveur les lit et renvoie les colonnes trouvées avec
   une correspondance proposée. L'utilisateur met chaque colonne en face d'une
   variable MEMS — même geste que la correspondance des connecteurs — relit
   l'aperçu, puis valide, ce qui bascule le millésime en une transaction. Le coût
   du basculement (les sites que le nouveau découpage rend orphelins) est chiffré
   AVANT toute écriture, jamais masqué. */
function SetShapefileServer({ db, notify, can, onCommitted, country, inline }){
  const [files,setFiles] = useState([]);
  const [apercu,setApercu] = useState(null);
  const [mapping,setMapping] = useState({});
  const [label,setLabel] = useState("");
  const [allowDup,setAllowDup] = useState(false);
  const [busy,setBusy] = useState(false);
  const [stat,setStat] = useState(null);

  const analyser = async (fs, map, dup) => {
    if(!fs.length) return;
    setBusy(true); setStat({ kind:"info", text:"Lecture du shapefile par le serveur…" });
    try{
      const r = await api.shapefilePreview(fs, map, dup, country?.code);
      setApercu(r); setMapping(r.mapping || {});
      setStat({ kind: r.resume.typeShp === 5 ? "ok" : "warn",
        text:`${fmt(r.resume.records)} enregistrement(s) · ${fmt(r.resume.avecGeometrie)} avec contour`
          + (r.resume.sansDbf ? " · polygones seuls (aucun .dbf)" : "") });
    }catch(e){ setApercu(null); setStat({ kind:"err", text:e.message }); }
    setBusy(false);
  };

  /* Le poids total du dépôt, et l'avertissement qui va avec. Un .shp de fokontany
     pèse des dizaines de mégaoctets ; MEMS les accepte (MAX_SHAPEFILE_MB, 150 Mo
     par défaut), mais un proxy en amont refuse souvent bien plus tôt — nginx
     plafonne le corps à 1 Mo TANT QU'ON NE LUI DIT PAS AUTRE CHOSE. L'échec arrive
     alors en 413, avant même d'atteindre l'application, et rien à l'écran ne
     laissait deviner que le remède était ailleurs. On le dit AVANT l'envoi. */
  const poidsMo = files.reduce((t,f)=>t+(f?.size||0),0) / (1024*1024);
  const zipDepose = files.some(f => /\.zip$/i.test(f?.name || ""));

  const onFiles = (list) => {
    const fs = Array.from(list || []);
    setFiles(fs); setAllowDup(false);
    setLabel(fs[0] ? fs[0].name.replace(/\.[^.]+$/,"") + " — " + new Date().toISOString().slice(0,10) : "");
    /* Premier passage sans correspondance : le serveur en propose une, l'écran
       l'affiche pré-remplie. */
    analyser(fs, {}, false);
  };

  /* La case « p-codes en double » change ce qui sera écrit (le premier, ou les
     deux) : on relit l'aperçu pour que les compteurs suivent. */
  const basculerDup = (v) => { setAllowDup(v); analyser(files, mapping, v); };

  const valider = async () => {
    if(!apercu) return;
    const o = apercu.orphelins?.orphelins || 0;
    if(!confirm("Basculer le référentiel courant sur ce découpage ?"
      + (o ? `\n\n${o} site(s) deviendront orphelins : leur ancien p-code n'existe pas dans ce `
           + "découpage. Le rattachement ne sera PAS refait automatiquement." : "")))
      return;
    setBusy(true);
    try{
      const r = await api.shapefileCommit(files, mapping, label, "shapefile", allowDup, country?.code);
      setStat({ kind: r.orphelins.orphelins ? "warn" : "ok", text: r.message });
      notify(`Découpage importé : ${fmt(r.imported)} unités, ${fmt(r.geom.écrites)} contours`,
        r.orphelins.orphelins ? "warn" : "ok");
      setApercu(null); setFiles([]);
      if(onCommitted) await onCommitted();
    }catch(e){
      /* La garde de consentement sur les doublons revient en 422 avec la liste :
         on la montre plutôt que de la masquer, l'utilisateur coche puis revalide. */
      setStat({ kind:"err", text: e.message });
    }
    setBusy(false);
  };

  const R = apercu?.resume;
  const nbCol = apercu?.collisionsTotal || 0;
  const sansDbf = !!R?.sansDbf;
  /* Dans la fiche du pays (`inline`), la section est déjà titrée par le pas « 2 » :
     on rend le corps sans la chrome d'une carte, pour ne pas empiler deux titres.
     Ailleurs, la carte autonome est conservée à l'identique. */
  const Wrap = inline
    ? ({ children }) => <div className="mb-4">
        <p className="f115 text-slate-500 mb-3">Lu par le serveur, rattaché à <b>{country?.name || "ce pays"}</b>.
          Déposez le .zip, ou le .shp avec son .dbf (et son .prj).</p>{children}</div>
    : ({ children }) => <Card title="Découpage administratif — téléverser le shapefile"
        subtitle={`Lu par le serveur, rattaché à ${country?.name || "ce pays"}. Déposez le .zip, ou le .shp avec son .dbf (et son .prj).`}>{children}</Card>;
  return (
    <Wrap>
      {!can("admin") && <Note tone="warn">Le téléversement du découpage est réservé aux administrateurs.</Note>}

      <Note>Ce découpage devient la <b>référence adm0→adm4 de MEMS</b> pour {country?.name || "le pays courant"} :
        sites, population et distributions s'y rattachent. L'archive <b>.zip</b> doit contenir le
        <b> .shp</b> (les contours), le <b>.dbf</b> (les noms et p-codes) et le <b>.prj</b> (la projection,
        qui doit être WGS 84 / EPSG:4326).
        <br /><br />
        <b>Déposez juste le .shp pour voir les polygones</b> tout de suite sur la carte, sous des noms
        provisoires « Polygone 1, 2, … » ; <b>ajoutez le .dbf pour les nommer et les rattacher</b> à
        l'arbre région → district → commune → fokontany. Le fichier peut aller jusqu'à 150 Mo ; au-delà,
        ou si un proxy plafonne l'envoi, préférez l'archive .zip (elle compresse fortement le .shp).</Note>

      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Shapefile (.zip, ou .shp + .dbf + .prj)">
          <input type="file" multiple accept=".zip,.shp,.dbf,.prj" disabled={!can("admin") || busy}
            onChange={e=>e.target.files.length && onFiles(e.target.files)}
            className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
        <div className="self-center">{stat && <Note tone={stat.kind}>{stat.text}</Note>}</div>
      </div>

      {/* Le poids du dépôt, dit AVANT l'envoi. Un échec en 413 se produit hors de
          MEMS — chez le proxy d'entrée — et ne laisse aucune trace exploitable
          dans l'application : autant prévenir pendant qu'on peut encore agir. */}
      {poidsMo >= 1 && (
        <Note tone={poidsMo > 40 && !zipDepose ? "warn" : "info"}>
          <b>Dépôt de {poidsMo.toFixed(1)} Mo.</b>{" "}
          {zipDepose
            ? <>L'archive .zip est le format le plus sûr : elle compresse fortement le .shp.</>
            : <>MEMS accepte jusqu'à 150 Mo, mais un <b>proxy en amont</b> refuse souvent bien plus
                tôt — sous nginx, la limite par défaut est de <b>1 Mo</b>, et l'envoi échoue alors en
                erreur 413 sans jamais atteindre l'application. Si c'est le cas :
                déposez plutôt une <b>archive .zip</b> des mêmes fichiers, ou faites porter
                « client_max_body_size 200m; » à la configuration du proxy.</>}
        </Note>)}

      {apercu && (<>
        <StatRow>
          <Stat label="Enregistrements" value={fmt(R.records)}
            sub={`type ${R.typeShp} · ${fmt(R.avecGeometrie)} avec contour`} />
          <Stat label={sansDbf ? "Polygones" : "Communes"} value={fmt(apercu.arbre.counts.adm3 || 0)}
            sub={`${fmt(apercu.arbre.total)} unités au total`} />
          <Stat label="P-codes en double" value={fmt(nbCol)} tone={nbCol ? "warn" : undefined}
            sub="mêmes codes, chemins différents" />
          <Stat label="Sites orphelins" value={fmt(apercu.orphelins.orphelins)}
            tone={apercu.orphelins.orphelins ? "bad" : "ok"}
            sub={`sur ${fmt(apercu.orphelins.sitesRattaches)} rattachés aujourd'hui`} />
        </StatRow>

        {/* Sans .dbf : aucune colonne à mettre en face. On importe les polygones
            seuls, nommés « Polygone N », pour les voir tout de suite. */}
        {sansDbf ? (
          <Note tone="warn">Aucune table attributaire (<b>.dbf</b>) : import des <b>polygones seuls</b>,
            nommés « Polygone 1, 2, … » au niveau commune. Ils s'afficheront sur la carte, mais sans nom
            ni rattachement. <b>Ajoutez le .dbf</b> (dans la même archive, ou à côté du .shp) pour les
            nommer et les rattacher à l'arbre adm0→adm4.</Note>
        ) : (<>
          <Note>Chaque colonne du fichier se met en face d'une variable MEMS. La proposition ci-dessous
            vient des intitulés reconnus ; ajustez-la, puis relisez l'aperçu.</Note>
          <div className="grid grid-cols-3 gap-x-3">
            {apercu.cibles.map(c=>(
              <Field key={c.cle} label={c.label}>
                <Select value={mapping[c.cle]||""} onChange={e=>setMapping(m=>({...m,[c.cle]:e.target.value}))}
                  empty="— aucune —" options={apercu.colonnes.map(x=>x.nom)} className="mi-py1" /></Field>))}
          </div>
          <div className="flex items-center gap-3 mb-4">
            <Btn kind="sec" icon={RefreshCw} disabled={busy} onClick={()=>analyser(files, mapping, allowDup)}>
              Relire l'aperçu</Btn>
            <span className="f115 text-slate-500">La correspondance choisie alimente l'arbre et le rattachement des contours.</span>
          </div>
        </>)}

        {!!apercu.echantillon?.length && (
          <TableWrap max="mh200">
            <thead><tr><Th>{sansDbf ? "Polygone (échantillon)" : "Commune (échantillon)"}</Th><Th>P-code</Th></tr></thead>
            <tbody>{apercu.echantillon.map(u=>(
              <tr key={u.pcode}><Td>{u.name}</Td><Td className="f115 text-slate-500">{u.pcode}</Td></tr>))}</tbody>
          </TableWrap>)}

        {!!apercu.orphelins.orphelins && (
          <Note tone="warn"><b>{fmt(apercu.orphelins.orphelins)} site(s) deviendront orphelins.</b>{" "}
            Leur p-code actuel est absent de ce découpage — par exemple{" "}
            {apercu.orphelins.echantillon.slice(0,4).map(s=>s.geo_pcode).join(", ")}. Le rattachement est
            une décision : il ne sera pas refait automatiquement.</Note>)}

        {/* ── P-codes en double : présentés, jamais bloquants ──────────────
            L'identité d'une unité est son chemin. Un même code sur deux chemins
            peut être une vraie donnée ; on le montre, l'utilisateur corrige la
            source ou accepte l'ambiguïté. */}
        {nbCol > 0 && (<>
          <Note tone="warn"><b>{fmt(nbCol)} p-code(s) en double</b> — un même code porté par
            plusieurs chemins de noms. Corrigez la source, ou autorisez-les ci-dessous : le rattachement
            <b> par nom reste sûr</b> ; <b>par p-code, le premier trouvé l'emporte.</b></Note>
          <TableWrap max="mh200">
            <thead><tr><Th>P-code</Th><Th>Chemins en conflit</Th></tr></thead>
            <tbody>{apercu.collisions.map(c=>(
              <tr key={c.pcode}><Td className="f115">{c.pcode}</Td>
                <Td className="whitespace-normal f115 text-slate-600">{c.chemins.join("  ≠  ")}</Td></tr>))}</tbody>
          </TableWrap>
          <div className="max-w-xl">
            <Sw label="Autoriser les p-codes en double"
              hint="Les deux chemins entrent, le chemin faisant foi. Sinon, le premier l'emporte et le commit demande cette confirmation."
              on={allowDup} disabled={busy} onChange={basculerDup} />
          </div>
        </>)}

        {!!apercu.rejets?.length && (
          <Note tone="warn">{fmt(apercu.rejets.length)} ligne(s) écartée(s) à la construction de l'arbre
            {apercu.rejets[0]?.reason ? ` (par exemple : ${apercu.rejets[0].reason})` : ""}.</Note>)}

        <div className="grid grid-cols-2 gap-x-4 mt-3">
          <Field label="Nom du millésime" hint="Il identifie ce chargement dans l'historique">
            <Input value={label} onChange={e=>setLabel(e.target.value)} placeholder="COD-AB communes 2025" /></Field>
        </div>
        <Btn icon={Upload} disabled={busy || !can("admin") || !apercu.arbre.total} onClick={valider}>
          {busy ? "Validation…" : "Valider et basculer le millésime"}</Btn>
      </>)}
    </Wrap>
  );
}

/* ── Contours par niveau de découpage (chantier S8, point 6) ──────────
   « Durant la configuration pays, insérer plusieurs shapefiles : adm1 à adm4
   pour pouvoir avoir un affichage par type de breakdown sur la carte après. »

   Le téléversement du dessus construit le millésime — l'arbre et les contours du
   fichier déposé, à la maille qu'il porte. Ici on AJOUTE une maille : un fichier
   par niveau, rattaché au même millésime, sans reconstruire l'arbre. Chaque
   niveau dit ce qu'il porte, se remplace, et se retire seul. */
function SetContoursNiveaux({ db, notify, can, onCommitted, inline }){
  const [busy,setBusy]   = useState("");
  const [bilan,setBilan] = useState(null);
  const gv = db.geoVersion;
  const parNiveau = Object.fromEntries((gv?.geom?.parNiveau || []).map(x => [x.level, x.units]));
  const NIVEAUX = niveaux(db, { from:"adm1", to:"adm4" });

  const deposer = async (niveau, list) => {
    const fichiers = Array.from(list || []);
    if(!fichiers.length) return;
    setBusy(niveau); setBilan(null);
    try{
      const r = await api.shapefileContours(fichiers, niveau, {}, fichiers[0].name, true);
      setBilan({ ...r, niveau });
      notify(r.message, r.écrites ? (r.rejetes ? "warn" : "ok") : "err");
      if(onCommitted) await onCommitted();
    }catch(e){ notify(e.message, "err"); setBilan({ niveau, erreur:e.message }); }
    setBusy("");
  };

  /* Dériver : les niveaux supérieurs sont les mêmes polygones réunis par
     parent. Un seul fichier — les communes — suffit donc à donner districts,
     régions et pays, et c'est la réponse au fait que seul adm3 est fourni. */
  const deriver = async (remplacer) => {
    setBusy("deriver"); setBilan(null);
    try{
      const r = await api.deriverContours(null, remplacer);
      setBilan({ derivation:r });
      notify(r.message, r.total ? "ok" : "warn");
      if(onCommitted) await onCommitted();
    }catch(e){ notify(e.message, "err"); setBilan({ erreur:e.message }); }
    setBusy("");
  };

  const retirer = async (niveau, libelle) => {
    if(!confirm(`Retirer les contours « ${libelle} » du millésime courant ?`)) return;
    setBusy(niveau);
    try{
      const r = await api.clearGeometry(niveau);
      notify(`${fmt(r.supprimes)} contour(s) retirés`, "ok");
      setBilan(null);
      if(onCommitted) await onCommitted();
    }catch(e){ notify(e.message, "err"); }
    setBusy("");
  };

  if(!gv) return null;
  const Wrap = inline
    ? ({ children }) => <div className="mt-5 pt-4 border-t border-slate-200">
        <div className="f13 font-semibold text-slate-800 mb-1">Contours par niveau (breakdown de la carte)</div>
        <p className="f115 text-slate-500 mb-3">Millésime : <b>{gv.label}</b> · {fmt(gv.geom?.units || 0)} contour(s) au total.</p>
        {children}</div>
    : ({ children }) => <Card title="Contours par niveau — le breakdown de la carte"
        subtitle={`Millésime courant : ${gv.label} · ${fmt(gv.geom?.units || 0)} contour(s) au total`}>{children}</Card>;
  return (
    <Wrap>
      <Note>La carte dessine les limites <b>au niveau de breakdown choisi</b> : elle ne peut le faire
        que pour les niveaux dont elle a les contours. Déposez <b>un shapefile par maille</b> —
        {" "}{NIVEAUX.map(([,l])=>l).join(", ")} — rattaché à ce même millésime ; l'arbre
        administratif n'est pas reconstruit. Le <b>.dbf est indispensable ici</b> : sans lui, aucun
        polygone ne peut être reconnu dans le découpage déjà chargé. Un dépôt <b>remplace</b> le
        niveau qu'il annonce, et ne touche pas aux autres.</Note>

      <TableWrap max="mh300">
        <thead><tr><Th>Niveau</Th><Th num>Unités du découpage</Th><Th num>Contours</Th>
          <Th>État</Th><Th /></tr></thead>
        <tbody>{NIVEAUX.map(([code,libelle])=>{
          const unites = gv.counts?.[code] || 0;
          const contours = parNiveau[code] || 0;
          return (
            <tr key={code} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{libelle} <span className="text-slate-400 f11">{code}</span></Td>
              <Td num className="text-slate-500">{unites ? fmt(unites) : "—"}</Td>
              <Td num className={contours ? "font-semibold text-slate-700" : "text-slate-400"}>
                {contours ? fmt(contours) : "—"}</Td>
              <Td>{contours
                ? (unites && contours < unites
                    ? <Badge tone="y">partiel — {Math.round((contours/unites)*100)} %</Badge>
                    : <Badge tone="g">complet</Badge>)
                : <Badge>aucun contour</Badge>}</Td>
              <Td className="text-right">
                {can("admin") && <label className="inline-block">
                  <input type="file" multiple accept=".zip,.shp,.dbf,.prj" className="hidden"
                    disabled={!!busy} onChange={e=>{ deposer(code, e.target.files); e.target.value=""; }} />
                  <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer">
                    <Upload size={13}/> {busy===code ? "Lecture…" : contours ? "Remplacer" : "Déposer"}</span>
                </label>}
                {can("admin") && !!contours && <button onClick={()=>retirer(code, libelle)}
                  disabled={!!busy} className="text-slate-400 hover:text-rose-600 p-1 ml-1"
                  title="Retirer les contours de ce niveau"><Trash2 size={14}/></button>}
              </Td>
            </tr>);
        })}</tbody>
      </TableWrap>

      {/* La dérivation, sous le tableau : elle ne remplace pas un dépôt, elle
          évite d'en attendre un. */}
      {can("admin") && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <Note>Un seul fichier suffit : les contours d'un district sont ceux de ses communes
            <b> réunies</b>, ceux d'une région ceux de ses districts. MEMS peut donc
            <b> dériver les niveaux supérieurs</b> à partir du niveau le plus fin déjà chargé —
            les frontières intérieures sont dissoutes, pas empilées. Un niveau qui porte déjà ses
            propres contours n'est pas touché : un fichier officiel vaut mieux qu'un calcul.</Note>
          <div className="flex items-center gap-2 flex-wrap">
            <Btn kind="sec" icon={Layers} disabled={!!busy || !gv.geom?.units}
              onClick={()=>deriver(false)}>
              {busy==="deriver" ? "Dissolution…" : "Dériver les niveaux supérieurs"}</Btn>
            <Btn kind="ghost" disabled={!!busy || !gv.geom?.units}
              onClick={()=>{ if(confirm("Recalculer AUSSI les niveaux qui portent déjà des contours ?"
                + "\n\nLes contours déposés à ces niveaux seront remplacés par des contours dérivés."))
                deriver(true); }}>Recalculer tout</Btn>
          </div>
        </div>)}

      {bilan?.niveau && !bilan.erreur && (
        <div className="mt-3">
          <Note tone={bilan.écrites ? (bilan.rejetes ? "warn" : "ok") : "err"}>{bilan.message}</Note>
          {!!bilan.rejets?.length && (
            <TableWrap max="mh200">
              <thead><tr><Th>Unité</Th><Th>Motif du rejet</Th></tr></thead>
              <tbody>{bilan.rejets.map((r,i)=>(
                <tr key={i}><Td className="f115">{r.pcode || "—"}</Td>
                  <Td className="text-slate-600 f11" style={{whiteSpace:"normal"}}>{r.message}</Td></tr>))}</tbody>
            </TableWrap>)}
        </div>)}

      {bilan?.derivation && (
        <div className="mt-3">
          {/* Après un dépôt, ce tableau est le DÉTAIL de la dérivation automatique
              annoncée dans la note ci-dessus ; après un clic « Dériver », il en
              est le seul compte-rendu. Même structure dans les deux cas. */}
          {!bilan.niveau && <Note tone={bilan.derivation.total ? "ok" : "warn"}>{bilan.derivation.message}</Note>}
          <TableWrap max="mh240">
            <thead><tr><Th>Niveau</Th><Th>Dérivé de</Th><Th num>Unités</Th><Th num>Contours</Th>
              <Th>Remarque</Th></tr></thead>
            <tbody>{bilan.derivation.etapes.map(e=>(
              <tr key={e.niveau}>
                <Td className="font-medium text-slate-800">{niveau(db, e.niveau, true)}
                  <span className="text-slate-400 f11"> {e.niveau}</span></Td>
                <Td className="text-slate-500">{e.depuis || "—"}</Td>
                <Td num className="text-slate-500">{e.unites ? fmt(e.unites) : "—"}</Td>
                <Td num className={e.ecrites ? "font-semibold" : "text-slate-400"}>
                  {e.ecrites ? fmt(e.ecrites) : "—"}</Td>
                <Td className="text-slate-600 f11" style={{whiteSpace:"normal"}}>
                  {e.saute || (e.approximatifs
                    ? `${e.approximatifs} unité(s) non dissoutes — rendues comme assemblage`
                    : e.ecrites ? "frontières intérieures dissoutes" : "")}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </div>)}
      {bilan?.erreur && <Note tone="err">{bilan.erreur}</Note>}
    </Wrap>
  );
}

/* ── Carte du découpage : les unités administratives RÉELLES, par niveau ──
   « Pourquoi il n'y a pas la carte de Madagascar avec les propositions de adm1 à
   adm4 avec les réellement inscrits ? » — on trace donc les contours du millésime
   courant, niveau par niveau, tels qu'ils sont enregistrés. Leaflet sans tuiles
   (le proxy les bloque) : les polygones se dessinent sur fond vide. adm4
   (fokontany) reste vide tant que son shapefile (~80 Mo) n'est pas chargé. */
function CarteDecoupage({ db }){
  const parN = db.geoVersion?.geom?.parNiveau || [];
  const dispo = new Set(parN.filter(p => p.units > 0).map(p => p.level));
  const countOf = (lv) => (parN.find(p => p.level === lv)?.units) || 0;
  const [niv, setNiv] = useState(["adm3","adm2","adm1"].find(l => dispo.has(l)) || "adm1");
  const boxRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null);
  const [etat, setEtat] = useState({ loading:true, erreur:"", unites:0 });

  useEffect(() => {
    if(!boxRef.current || mapRef.current || !L.Browser.svg) return;
    const map = L.map(boxRef.current, { zoomControl:true, attributionControl:false, scrollWheelZoom:true })
      .setView([-18.9, 46.9], 5);
    mapRef.current = map; layerRef.current = L.layerGroup().addTo(map);
    return () => { try{ map.remove(); }catch(e){} mapRef.current = null; };
  }, []);

  useEffect(() => {
    let vivant = true; setEtat(e => ({ ...e, loading:true, erreur:"" }));
    (async () => {
      try{
        const geo = await api.geoGeometry(`?level=${niv}&limit=2500`);
        if(!vivant) return;
        const feats = geo?.features || []; const g = layerRef.current;
        if(g){ g.clearLayers();
          for(const f of feats){
            const c = L.geoJSON(f, { style:{ color:C.brandD, weight: niv==="adm1"?1.6:0.7,
              opacity:0.9, fillColor:C.brand, fillOpacity:0.12 } });
            /* Leaflet rend l'info-bulle en HTML : on échappe le nom de l'unité. */
            const nomEsc = String(f.properties?.name || "").replace(/[&<>"']/g,
              ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
            c.bindTooltip(nomEsc, { sticky:true });
            c.on("mouseover", () => c.setStyle({ fillOpacity:0.32 }));
            c.on("mouseout", () => c.setStyle({ fillOpacity:0.12 }));
            g.addLayer(c);
          }
        }
        if(geo?.extent){ const e = geo.extent;
          try{ mapRef.current.fitBounds([[e.south, e.west], [e.north, e.east]], { padding:[10,10] }); }catch(_){}
        }
        setEtat({ loading:false, erreur: feats.length ? "" : "Aucun contour tracé à ce niveau.", unites:feats.length });
      }catch(e){ if(vivant) setEtat({ loading:false, erreur:e.message, unites:0 }); }
    })();
    return () => { vivant = false; };
  }, [niv]);

  return (
    <Card flush title="Carte du découpage administratif"
      subtitle="Les unités réellement enregistrées dans le millésime courant, par niveau">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap border-b border-slate-100">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {["adm1","adm2","adm3","adm4"].map(lv => { const ok = dispo.has(lv); const c = countOf(lv);
            return (
            <button key={lv} disabled={!ok} onClick={()=>setNiv(lv)}
              title={ok ? `${fmt(c)} ${niveau(db, lv, true).toLowerCase()}`
                : "Aucun contour à ce niveau — pour adm4 (fokontany), le shapefile (~80 Mo) n'est pas chargé"}
              className={clsx("px-3 py-1 f11 rounded-md font-semibold transition-colors",
                !ok ? "text-slate-300 cursor-not-allowed" : niv===lv ? "bg-brand text-white shadow-sm" : "text-slate-500 hover:text-slate-800")}>
              {niveau(db, lv, false)}{ok && <span className="ml-1 f10 opacity-70 tabular-nums">{fmt(c)}</span>}</button>); })}
        </div>
        <span className="f115 text-slate-500 ml-1">{etat.loading ? "Chargement…"
          : `${fmt(etat.unites)} ${niveau(db, niv, true).toLowerCase()} tracé(s)`}</span>
      </div>
      <div className="relative" style={{ height:340 }}>
        <div ref={boxRef} className="absolute inset-0 bg-[#eaf1f6]" />
        {etat.erreur && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none z-[500]">
            <div className="bg-white/90 rounded-xl px-4 py-2 f115 text-slate-500 shadow-sm">{etat.erreur}</div></div>)}
      </div>
    </Card>);
}

/* ── Gestion des codes POI : insertion manuelle ou import Excel/CSV ──
   « Dans localité on gère les POI codes : insertion, mapping via GPS. Soit une
   insertion manuelle, soit télécharger et insérer via Excel (adm1 à 4 en base de
   référence). » Un POI EST un site : on réutilise /sites par une porte étroite,
   centrée sur le code, l'adresse administrative (adm4 obligatoire) et le GPS. */
const normCol = (s) => String(s||"").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"");
const champCSV = (row, ...noms) => { const keys = Object.keys(row);
  for(const nom of noms){ const k = keys.find(k => normCol(k) === normCol(nom));
    if(k && row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim(); }
  return ""; };

function PoiModal({ open, db, notify, onClose, onCreated }){
  const [f,setF] = useState({});
  useEffect(()=>{ if(open) setF({}); },[open]);
  const geo = useGeoCascade({ adm1:f.adm1, adm2:f.adm2, adm3:f.adm3 });
  const [busy,setBusy] = useState(false);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const [adm1s,adm2s,adm3s]=[geo.adm1,geo.adm2,geo.adm3].map(r=>r.map(x=>x.name));
  const pret = (f.poi||"").trim() && (f.adm4||"").trim();
  const creer = async () => { setBusy(true);
    try{ await api.createSite({ code:(f.code||"").trim()||undefined, external_code:(f.code||"").trim()||null,
        name:f.poi.trim(), status:"Active", poi_subtype:f.poiSubtype||null, activity_tag:f.activityTag||null,
        adm1:f.adm1||null, adm2:f.adm2||null, adm3:f.adm3||null, adm4:f.adm4.trim(),
        lat:f.lat===""||f.lat==null?null:Number(f.lat), lon:f.lon===""||f.lon==null?null:Number(f.lon),
        geo_pcode:geo.pcode||null });
      notify("POI enregistré","ok"); onCreated?.(); onClose();
    }catch(e){ notify(e.message,"err"); } setBusy(false); };
  return (
    <Modal open onClose={onClose} title="Insérer un POI"
      subtitle="Code, adresse administrative (fokontany obligatoire) et point GPS"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Plus} disabled={busy||!pret} title={pret?"":"Nom et fokontany (adm4) obligatoires"}
          onClick={creer}>{busy?"Enregistrement…":"Créer le POI"}</Btn></>}>
      {!(f.adm4||"").trim() && <Note tone="warn">Un POI (site) exige un <b>fokontany (adm4)</b> comme parent.
        Le shapefile fokontany (~80 Mo) n'étant pas chargé, saisissez-le à la main.</Note>}
      <div className="grid grid-cols-2 gap-x-4 mt-1">
        <Field label="Code POI" hint="Code d'identification / externe (généré si vide)">
          <Input value={f.code||""} onChange={e=>u("code",e.target.value)} placeholder="ex. MG23210070009001" /></Field>
        <Field label="Nom du POI"><Input value={f.poi||""} onChange={e=>u("poi",e.target.value)} /></Field>
        <Field label="Sous-type"><Select value={f.poiSubtype||""} onChange={e=>u("poiSubtype",e.target.value)}
          empty="—" options={db.lists.poiSub.map(p=>p.label)} /></Field>
        <Field label="Activité"><Select value={f.activityTag||""} onChange={e=>u("activityTag",e.target.value)}
          empty="—" options={db.lists.tags.map(t=>[t.code,`${t.code} — ${t.label}`])} /></Field>
        <Field label="Région (adm1)"><Select value={f.adm1||""} onChange={e=>{u("adm1",e.target.value);u("adm2","");u("adm3","");}} empty="—" options={adm1s} /></Field>
        <Field label="District (adm2)"><Select value={f.adm2||""} onChange={e=>{u("adm2",e.target.value);u("adm3","");}} empty="—" options={adm2s} /></Field>
        <Field label="Commune (adm3)"><Select value={f.adm3||""} onChange={e=>u("adm3",e.target.value)} empty="—" options={adm3s} /></Field>
        <Field label="Fokontany (adm4)" hint="Parent obligatoire">
          {geo.adm4?.length
            ? <Select value={f.adm4||""} onChange={e=>u("adm4",e.target.value)} empty="— (obligatoire)" options={geo.adm4.map(x=>x.name)} />
            : <Input value={f.adm4||""} onChange={e=>u("adm4",e.target.value)} placeholder="Fokontany (obligatoire)"
                className={(f.adm4||"").trim()?"":"border-amber-300 bg-amber-50/40"} />}</Field>
        <Field label="Latitude (GPS)"><Input type="number" step="0.000001" value={f.lat??""} onChange={e=>u("lat",e.target.value)} /></Field>
        <Field label="Longitude (GPS)"><Input type="number" step="0.000001" value={f.lon??""} onChange={e=>u("lon",e.target.value)} /></Field>
      </div>
    </Modal>);
}

function PoiManager({ db, notify, can, reload }){
  const [modal,setModal] = useState(false);
  const [imp,setImp] = useState(null);
  const fileRef = useRef(null);
  const editable = can?.("edit");
  const sites = db.sites || [];
  const avecCode = sites.filter(s => s.externalCode || s.code).length;
  const sansGps = sites.filter(s => s.lat == null || s.lon == null).length;
  const sansAdm4 = sites.filter(s => !(s.adm4||"").trim()).length;

  const modele = () => {
    const head = "code,nom,sous_type,activite,adm1,adm2,adm3,adm4,latitude,longitude";
    const ex = "MG2321007,École Ambatolampy,École,SMP,Analamanga,Antananarivo,Ambatolampy,Ambatolampy Centre,-18.912,47.531";
    download("modele_poi.csv", head + "\n" + ex + "\n", "text/csv;charset=utf-8");
  };
  const exporter = () => {
    const rows = sites.map(s => ({ code:s.externalCode || s.code || s.id, nom:s.poi || "",
      sous_type:s.poiSubtype || "", activite:s.activityTag || "", adm1:s.adm1 || "", adm2:s.adm2 || "",
      adm3:s.adm3 || "", adm4:s.adm4 || "", latitude:s.lat ?? "", longitude:s.lon ?? "" }));
    if(!rows.length){ notify("Aucun POI à exporter", "warn"); return; }
    download("codes_poi.csv", toCSV(rows), "text/csv;charset=utf-8");
  };
  const importer = async (file) => {
    if(!file) return;
    let lignes = []; try{ lignes = parseCSV(await file.text()); }catch(e){ notify("CSV illisible : " + e.message, "err"); return; }
    if(!lignes.length){ notify("Fichier vide", "warn"); return; }
    if(lignes.length > 2000){ notify("Import limité à 2000 lignes par fichier", "warn"); return; }
    let ok=0, echecs=0, manque=0;
    setImp({ total:lignes.length, ok, echecs, manque, encours:true });
    for(const row of lignes){
      const adm4 = champCSV(row, "adm4", "fokontany");
      const nom = champCSV(row, "nom", "name", "poi");
      if(!adm4 || !nom){ echecs++; if(!adm4) manque++; setImp(x=>({ ...x, echecs, manque })); continue; }
      try{
        const lat = champCSV(row, "latitude", "lat"), lon = champCSV(row, "longitude", "lon", "lng");
        await api.createSite({ code:champCSV(row,"code","code_poi")||undefined,
          external_code:champCSV(row,"code","code_poi")||null, name:nom, status:"Active",
          poi_subtype:champCSV(row,"sous_type","subtype","poi_subtype")||null,
          activity_tag:champCSV(row,"activite","activity_tag","tag")||null,
          adm1:champCSV(row,"adm1","region")||null, adm2:champCSV(row,"adm2","district")||null,
          adm3:champCSV(row,"adm3","commune")||null, adm4,
          lat: lat ? Number(lat) : null, lon: lon ? Number(lon) : null });
        ok++; setImp(x=>({ ...x, ok }));
      }catch(e){ echecs++; setImp(x=>({ ...x, echecs })); }
    }
    setImp(x=>({ ...x, encours:false }));
    notify(`Import terminé : ${ok} POI créé(s), ${echecs} en échec${manque?` (${manque} sans adm4)`:""}`, echecs?"warn":"ok");
    await reload?.();
  };

  return (
    <Card title="Codes POI (sites)"
      subtitle="Insertion manuelle ou import Excel/CSV — chaque POI exige un fokontany (adm4)"
      right={editable && <Btn size="sm" icon={Plus} onClick={()=>setModal(true)}>Insérer un POI</Btn>}>
      <div className="flex items-center gap-5 flex-wrap">
        <div className="flex items-center gap-5">
          {[["POI", fmt(sites.length), false], ["avec code", fmt(avecCode), false],
            ["sans GPS", fmt(sansGps), sansGps>0], ["sans adm4", fmt(sansAdm4), sansAdm4>0]].map(([l,v,alerte])=>(
            <div key={l} className="text-center">
              <div className={clsx("f16 font-bold tabular-nums leading-none", alerte?"text-amber-600":"text-slate-800")}>{v}</div>
              <div className="f10 text-slate-400 mt-0.5">{l}</div></div>))}
        </div>
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <Btn size="sm" kind="sec" icon={Download} onClick={modele}>Modèle CSV</Btn>
          {editable && <Btn size="sm" kind="sec" icon={Upload} onClick={()=>fileRef.current?.click()}>Importer CSV</Btn>}
          <Btn size="sm" kind="sec" icon={Download} onClick={exporter} disabled={!sites.length}>Exporter</Btn>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={e=>{ const fl = e.target.files?.[0]; e.target.value=""; importer(fl); }} />
        </div>
      </div>
      {imp && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 f115 text-slate-600">
          {imp.encours ? `Import en cours… ${imp.ok+imp.echecs}/${imp.total}`
            : `Import terminé : ${fmt(imp.ok)} créé(s), ${fmt(imp.echecs)} en échec${imp.manque?` (${imp.manque} sans adm4)`:""}`}</div>)}
      <PoiModal open={modal} db={db} notify={notify} onClose={()=>setModal(false)} onCreated={()=>reload?.()} />
    </Card>);
}

/* ── Localités : référentiel administratif versionné ──
   Le découpage n'est plus une liste plate éditable ligne à ligne : c'est un arbre
   (région → district → commune → fokontany) chargé par millésime. Sites, population
   et distributions s'y raccrochent, donc il ne se modifie pas à la main — on importe
   un nouveau millésime, et l'ancien reste disponible. */
function SetLocations({ db, set, notify, can, reload, me }){
  const [versions,setVersions] = useState([]);
  const [refBusy,setRefBusy]   = useState("");   /* chargement des données de référence */
  /* La suppression des contours reste une action de maintenance (le millésime
     garde son arbre, on n'en retire que le fond de carte) : un seul verrou suffit. */
  const [geomBusy,setGeomBusy] = useState(false);
  /* La gestion du référentiel (millésimes, contours, chargement, sites par tag)
     est SECONDAIRE : le tableau des localités passe en premier, la gestion se
     déplie à la demande — « le tableau en priorité, cherche un moyen pour les
     référentiels ». */
  const [gestion,setGestion] = useState(false);

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
  /* Le niveau le plus PROFOND réellement chargé. Le répertoire visait « adm4 »
     en dur — or le shapefile officiel de Madagascar s'arrête aux COMMUNES
     (adm3), sans fokontany : la requête ne rendait alors rien, et l'écran
     paraissait vide (« dans l'onglet localité je ne vois rien »). On affiche
     donc la maille la plus fine qui existe dans le millésime courant. */
  const niveauProfond = ["adm4","adm3","adm2","adm1"]
    .find(l => (db.geoVersion?.counts?.[l] || 0) > 0) || "adm3";

  /* Le nombre de sites par localité, compté UNE fois. Chaque ligne du répertoire
     faisait auparavant son propre `db.sites.filter(...)` à l'intérieur du rendu :
     deux cents lignes × plusieurs milliers de sites, refait à chaque frappe dans la
     recherche. Deux comptages suffisent, parce que la règle d'origine dépend du
     SITE et non de la ligne — un site qui porte la maille fine se compte sur son
     nom, un site qui ne la porte pas se rabat sur sa commune. */
  const comptesSites = useMemo(() => {
    const parNiveau = new Map(), parAdm3 = new Map();
    for(const s of (db.sites || [])){
      const v = s[niveauProfond];
      if(v) parNiveau.set(v, (parNiveau.get(v) || 0) + 1);
      else if(s.adm3) parAdm3.set(s.adm3, (parAdm3.get(s.adm3) || 0) + 1);
    }
    return { parNiveau, parAdm3 };
  }, [db.sites, niveauProfond]);
  useEffect(()=>{
    let alive = true;
    setDir(d=>({ ...d, loading:true }));
    const qs = new URLSearchParams({ level:niveauProfond, limit:String(PER), offset:String(page*PER) });
    if(parent) qs.set("parent", parent);
    if(q.trim()) qs.set("search", q.trim());
    const id = setTimeout(() => {
      api.geo("?"+qs).then(r => { if(alive) setDir({ ...r, loading:false }); })
        .catch(e => { if(alive) setDir({ rows:[], total:0, version:null, loading:false, error:e.message }); });
    }, q ? 280 : 0);                       /* la recherche attend la fin de la frappe */
    return () => { alive = false; clearTimeout(id); };
  }, [parent, q, page, refresh, niveauProfond]);
  useEffect(()=>{ setPage(0); }, [parent, q]);

  const activate = async (id, lb) => {
    try{ await api.setGeoVersion(id); resetGeoCache();
      setSel({ adm1:"", adm2:"", adm3:"" }); setPage(0); setRefresh(x=>x+1); await loadVersions();
      if(reload) await reload();
      notify(`Référentiel courant : « ${lb} »`, "ok");
    }catch(e){ notify("Changement refusé : " + e.message, "err"); }
  };

  /* L'export sortait `dir.rows` — la seule page affichée, plafonnée à PER. Sur un
     millésime malgache (~18 000 fokontany) l'utilisateur repartait avec 200 lignes
     sans le savoir. On récupère désormais la TOTALITÉ du jeu filtré courant, en
     paginant le point d'API au-delà de son plafond par appel. */
  const [exportEnCours,setExportEnCours] = useState(false);
  const exp = async () => {
    setExportEnCours(true);
    const lecteur = (offset, limit) => {
      const qs = new URLSearchParams({ level:niveauProfond, limit:String(limit), offset:String(offset) });
      if(parent) qs.set("parent", parent);
      if(q.trim()) qs.set("search", q.trim());
      return api.geo("?"+qs);
    };
    try{
      const { rows, total, tronque } = await collecterLocalites(lecteur);
      if(!rows.length){ notify("Aucune localité à exporter", "warn"); setExportEnCours(false); return; }
      const nom = (dir.version?.label || "referentiel").replace(/[^\w.-]+/g, "_");
      download(`localites_${nom}.csv`, csvLocalites(rows), "text/csv;charset=utf-8");
      notify(tronque
        ? `Export plafonné à ${rows.length.toLocaleString("fr-FR")} localités sur ${total.toLocaleString("fr-FR")} — affinez le filtre pour tout obtenir`
        : `${rows.length.toLocaleString("fr-FR")} localité(s) exportée(s)`, tronque ? "warn" : "ok");
    }catch(e){ notify("Export impossible : " + e.message, "err"); }
    setExportEnCours(false);
  };

  const cur = db.geoVersion;
  const pages = Math.ceil(dir.total / PER);
  const geoCount = cur?.counts ? Object.values(cur.counts).reduce((a,b)=>a+(b||0),0) : (cur?.units||0);
  const loadRef = async (quoi) => { setRefBusy(quoi);
    try{ const r = await api.chargerReference(quoi); const b = r.bilan||{};
      notify(quoi==="decoupage" ? `Découpage chargé : ${fmt(b.geo?.unites||0)} unités, ${fmt(b.geo?.contours||0)} contours`
        : quoi==="indicateurs" ? `Référentiels chargés : ${fmt(b.activites?.lues||0)} activités, ${fmt(b.indicateurs?.lues||0)} indicateurs`
            + (b.processus?.indicateurs ? `, ${fmt(b.processus.indicateurs)} indicateurs de suivi de processus (XLSForm)` : "")
        : `Sites chargés : ${fmt(b.crees||0)} créés, ${fmt(b.majs||0)} mis à jour`, "ok");
      await reload?.(); await loadVersions();
    }catch(e){ notify(e.message,"err"); } setRefBusy(""); };
  const cols = niveaux(db, { from:"adm1", to:niveauProfond, plural:false });
  const aFiltre = sel.adm1 || sel.adm2 || sel.adm3 || q;

  return (
    <div className="space-y-4">
      {/* ── Bandeau : référentiel courant, compact ── */}
      {cur ? (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-5 py-3.5 flex items-center gap-5 flex-wrap">
          <div className="flex items-center gap-2.5 shrink-0">
            <span className="w-9 h-9 rounded-xl grid place-items-center" style={{ background:C.brand+"14", color:C.brand }}><MapPin size={18}/></span>
            <div className="leading-tight">
              <div className="f10 font-bold uppercase tracking-wider text-slate-400">Référentiel courant</div>
              <div className="f14 font-semibold text-slate-800">{cur.label}</div>
            </div>
          </div>
          <div className="flex items-center gap-5 flex-wrap ml-2">
            {niveaux(db, { from:"adm1", to:niveauProfond, plural:true }).map(([k,l])=>(
              <div key={k} className="text-center">
                <div className="f16 font-bold text-slate-800 tabular-nums leading-none">{fmt(cur.counts?.[k] || 0)}</div>
                <div className="f10 text-slate-400 mt-0.5">{l}</div></div>))}
            <div className="text-center">
              <div className="f16 font-bold tabular-nums leading-none" style={{ color:C.brand }}>{fmt(cur.units)}</div>
              <div className="f10 text-slate-400 mt-0.5">total</div></div>
            <div className="text-center">
              <div className={clsx("f16 font-bold tabular-nums leading-none", cur.geom?.units?"text-emerald-600":"text-slate-300")}>{fmt(cur.geom?.units||0)}</div>
              <div className="f10 text-slate-400 mt-0.5">contours</div></div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {me?.role==="super" && !geoCount &&
              <Btn size="sm" icon={MapPin} disabled={!!refBusy} onClick={()=>loadRef("decoupage")}>
                {refBusy==="decoupage"?"Chargement…":"Charger le découpage"}</Btn>}
            <Btn size="sm" kind="sec" icon={gestion?ChevronDown:ChevronRight} onClick={()=>setGestion(g=>!g)}>
              Gestion du référentiel</Btn>
          </div>
        </div>
      ) : (
        <Note tone="warn"><b>Aucun référentiel chargé.</b> {me?.role==="super"
          ? <>Chargez le découpage depuis le serveur (bouton ci-dessous) ou importez un shapefile depuis l'onglet <b>Pays &amp; découpage</b>.</>
          : <>Un découpage doit être importé depuis l'onglet <b>Pays &amp; découpage</b> pour peupler ce répertoire.</>}
          {me?.role==="super" && <div className="mt-2"><Btn size="sm" icon={MapPin} disabled={!!refBusy}
            onClick={()=>loadRef("decoupage")}>{refBusy==="decoupage"?"Chargement…":"Charger le découpage Madagascar (serveur)"}</Btn></div>}
        </Note>
      )}

      {/* ── La carte du découpage réel : adm1 → adm4 tels qu'ils sont inscrits ── */}
      {cur && <CarteDecoupage db={db} />}

      {/* ── Gestion des codes POI : insertion manuelle ou import Excel/CSV ── */}
      {cur && <PoiManager db={db} notify={notify} can={can} reload={reload} />}

      {/* ── LE RÉPERTOIRE : priorité à l'écran ── */}
      <Card flush title="Répertoire des localités"
        subtitle={dir.loading ? "Chargement…"
          : `${fmt(dir.total)} ${niveau(db, niveauProfond, false).toLowerCase()}(s)${aFiltre?" dans la sélection":""} · page ${page+1} sur ${Math.max(1,pages)}`}>
        {/* Barre de filtres propre, AU-DESSUS du tableau (plus dans l'en-tête cramé) */}
        <div className="px-4 pt-3 pb-2 flex items-center gap-2 flex-wrap border-b border-slate-100">
          <Select value={sel.adm1} onChange={e=>setSel({ adm1:e.target.value, adm2:"", adm3:"" })}
            empty="Toutes les régions" options={geo.adm1.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" />
          <Select value={sel.adm2} onChange={e=>setSel(s=>({ ...s, adm2:e.target.value, adm3:"" }))}
            empty="Tous les districts" options={geo.adm2.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" disabled={!sel.adm1} />
          <Select value={sel.adm3} onChange={e=>setSel(s=>({ ...s, adm3:e.target.value }))}
            empty="Toutes les communes" options={geo.adm3.map(x=>x.name)} className="mi-py1 mi-xs mi-wauto" disabled={!sel.adm2} />
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Rechercher une localité…"
              className={clsx(inputCls,"pl-7 mi-py1 w-56")} /></div>
          {aFiltre && <Btn size="sm" kind="ghost" onClick={()=>{ setSel({adm1:"",adm2:"",adm3:""}); setQ(""); }}>Effacer</Btn>}
          <Btn size="sm" kind="sec" icon={Download} onClick={exp} disabled={exportEnCours || !dir.total} className="ml-auto">
            {exportEnCours ? "Export…" : "Exporter"}</Btn>
        </div>
        <TableWrap max="mh520">
          <thead><tr>{cols.map(([c,l])=><Th key={c}>{l}</Th>)}<Th>P-code</Th>
            <Th num>Latitude</Th><Th num>Longitude</Th><Th num>Sites</Th></tr></thead>
          <tbody>{dir.rows.map(g=>{
            const cnt = (comptesSites.parNiveau.get(g.name) || 0)
              + (g.adm3 ? (comptesSites.parAdm3.get(g.adm3) || 0) : 0);
            return (<tr key={g.pcode} className="hover:bg-sky-50">
              {cols.map(([c])=><Td key={c} className={c===niveauProfond?"font-medium text-slate-800":"text-slate-500"}>
                {c===niveauProfond ? g.name : (g[c]||"—")}</Td>)}
              <Td className="f115 c-bd">{g.pcode}</Td>
              <Td num className="f115 text-slate-500">{g.lat != null ? Number(g.lat).toFixed(5) : "—"}</Td>
              <Td num className="f115 text-slate-500">{g.lon != null ? Number(g.lon).toFixed(5) : "—"}</Td>
              <Td num className="text-slate-500">{cnt||""}</Td>
            </tr>); })}</tbody>
        </TableWrap>
        {!dir.loading && !dir.rows.length && (
          <div className="px-4 py-10 text-center f125 text-slate-500">
            {dir.error ? dir.error : cur ? "Aucune localité dans cette sélection." : "Chargez un découpage pour peupler le répertoire."}</div>)}
        {pages > 1 && (
          <div className="px-4 py-2.5 flex items-center gap-2 f115 text-slate-500 border-t border-slate-100">
            <Btn size="sm" kind="sec" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
            <span>{fmt(page*PER+1)} – {fmt(Math.min((page+1)*PER, dir.total))} sur {fmt(dir.total)}</span>
            <Btn size="sm" kind="sec" disabled={page>=pages-1} onClick={()=>setPage(p=>p+1)}>Suivant</Btn>
          </div>)}
      </Card>

      {/* ── Gestion du référentiel : repliée, secondaire ── */}
      {gestion && (
        <div className="space-y-4">
          {me?.role==="super" && (
            <Card title="Données de référence (chargement serveur)"
              subtitle="Lues depuis les fichiers du serveur — aucun téléversement, aucune limite de taille (résout le 413)">
              <div className="flex flex-wrap gap-2">
                <Btn kind="sec" icon={MapPin} disabled={!!refBusy}
                  onClick={()=>loadRef("decoupage")}>{refBusy==="decoupage"?"Chargement…":`Découpage${geoCount?" (recharger)":""}`}</Btn>
                <Btn kind="sec" icon={Target} disabled={!!refBusy}
                  onClick={()=>loadRef("indicateurs")}>{refBusy==="indicateurs"?"Chargement…":`Activités + indicateurs${(db.indicators||[]).length?" (recharger)":""}`}</Btn>
                <Btn kind="sec" icon={MapPin} disabled={!!refBusy||!geoCount}
                  onClick={()=>loadRef("sites")} title={geoCount?"":"Chargez d'abord le découpage"}>{refBusy==="sites"?"Chargement…":`Sites par tag${(db.sites||[]).length?" (recharger)":""}`}</Btn>
              </div>
              <div className="f11 text-slate-500 mt-2">Chargez le découpage AVANT les sites (ils s'y rattachent).</div>
            </Card>)}

          <Card title="Contours administratifs — fond de carte"
            subtitle={cur?.geom?.units
              ? `${fmt(cur.geom.units)} unité(s) avec contour${cur.geom.source ? ` · ${cur.geom.source}` : ""}`
              : "aucun contour : la cartographie n'a pas de fond"}
            right={can("admin") && cur?.geom?.units > 0 &&
              <Btn size="sm" kind="sec" icon={Trash2} disabled={geomBusy}
                onClick={async ()=>{ if(!confirm("Retirer tous les contours de ce millésime ? L'arbre administratif est conservé.")) return;
                  setGeomBusy(true);
                  try{ const r = await api.clearGeometry(); await loadVersions(); if(reload) await reload();
                    notify(`${fmt(r.supprimes)} contour(s) retiré(s)`, "ok");
                  }catch(e){ notify(e.message, "err"); } setGeomBusy(false); }}>Retirer les contours</Btn>}>
            {cur?.geom?.units && !!cur.geom?.parNiveau?.length
              ? <StatRow>{cur.geom.parNiveau.map(x=>(
                  <Stat key={x.level} label={niveau(db, x.level, true)} value={fmt(x.units)}
                    sub={`${fmt(x.points_simple)} sommets sur ${fmt(x.points)}`} />))}</StatRow>
              : <Note>Les contours arrivent avec le shapefile importé depuis l'onglet <b>Pays &amp; découpage</b>,
                  ou avec le chargement serveur du découpage ci-dessus.</Note>}
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

          {!!(db.sites||[]).length && (() => {
            const sites = db.sites || [];
            const geoloc = sites.filter(s => s.lat != null && s.lon != null).length;
            const parTag = {}; for(const s of sites){ const t = s.activityTag || "—"; parTag[t] = (parTag[t]||0)+1; }
            const rangs = Object.entries(parTag).sort((a,b)=>b[1]-a[1]);
            return (
              <Card flush title="Sites (POI) par activité"
                subtitle={`${fmt(sites.length)} site(s) · ${fmt(geoloc)} géolocalisé(s) · rattachés au découpage`}>
                <div className="p-4 flex flex-wrap gap-2">
                  {rangs.map(([tag,n])=>(
                    <span key={tag} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white pl-3 pr-1.5 py-1 f11">
                      <span className="font-semibold text-slate-700" title={(db.activities||[]).find(a=>a.tag===tag)?.name || tag}>{tag}</span>
                      <span className="f10 tabular-nums bg-slate-100 text-slate-600 px-1.5 rounded-full">{fmt(n)}</span>
                    </span>))}
                </div>
              </Card>);
          })()}
        </div>)}
    </div>);
}

/* ── Référentiel des activités (activity_categories) ──────────────────
   La liste canonique des activités du programme, désormais éditable (S4/S7) :
   nom, tag (code), domaine programme, actif. C'est la source unique que
   réutilisent le rattachement d'un site, les indicateurs de processus, les
   plans. Les mutations passent par la route dédiée puis rechargent l'état. */
function SetActivities({ db, notify, can, reload, me }){
  const [edit,setEdit] = useState(null);
  const [busy,setBusy] = useState(false);
  /* Le renommage de tag en cascade vit désormais ICI (l'activité a quitté le
     gestionnaire de listes typées pour son onglet propre). Réservé au super. */
  const [renomme,setRenomme] = useState(null);
  const superUser = me?.role === "super";
  const liste = db.activities || [];
  const save = async (a) => {
    setBusy(true);
    const payload = { name:(a.name||"").trim(), tag:(a.tag||"").trim().toUpperCase(),
      program_area:a.programArea || null, active:a.active !== false, rev:a.rev };
    try{
      if(a.id) await api.updateActivity(a.id, payload); else await api.createActivity(payload);
      await reload(); setEdit(null); notify("Activité enregistrée", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };
  const remove = async (a) => {
    if(!confirm(`Supprimer l'activité « ${a.name} » ?`)) return;
    try{ await api.deleteActivity(a.id); await reload(); notify("Activité supprimée", "ok"); }
    catch(e){ notify(e.message, "err"); }
  };
  return (
    <>
      <Aide>
        <p>Le référentiel des <b>activités</b> du programme — une activité, une ligne : son code (tag),
        son intitulé et son domaine. C'est la source unique réutilisée pour rattacher un site, suivre un
        indicateur de processus et planifier. Désactiver une activité la retire des choix sans effacer
        l'historique.</p>
        <p className="mt-2">La liste des activités <b>est</b> la liste des <b>tags</b> : un tag désigne une activité et
        une seule. Le référentiel chargé depuis le classeur du PAM en compte 58 (onglet
        « Annex 5 Activity tags ») ; les espaces intérieurs sont retirés à la saisie, et un tag déjà
        pris est refusé en nommant l'activité qui le porte.</p>
        <p className="mt-2">Le <b>tag</b> est le code d'identification : dix tables le portent en texte
        (sites, couverture, plan de distribution, produits, visites, formulaires ODK, caseload,
        zones TPM, soumissions, indicateurs). Il ne se modifie donc pas à l'édition — un
        super-utilisateur le renomme <b>en cascade</b> (bouton dédié, ci-dessous), ce qui
        réécrit du même coup toutes les lignes qui le portent.</p>
      </Aide>
      <Card flush title="Activités du programme" subtitle={`${liste.length} activité${liste.length>1?"s":""}`}
        right={can("admin") && <Btn size="sm" icon={Plus}
          onClick={()=>setEdit({ id:"", name:"", tag:"", programArea:"", active:true })}>Ajouter</Btn>}>
        {!liste.length
          ? <Empty>Aucune activité. Ajoutez-en une, ou importez le découpage du pays qui les amorce.</Empty>
          : <TableWrap>
          <thead><tr><Th>Code</Th><Th>Intitulé</Th><Th>Domaine programme</Th><Th>Statut</Th>
            <Th num>Sites</Th><Th num>Paramètres</Th><Th num>Total référencé</Th><Th /></tr></thead>
          <tbody>{liste.map(a=>(
            <tr key={a.id} className="hover:bg-sky-50">
              <Td><Badge tone="b">{a.tag}</Badge></Td>
              <Td className="font-medium text-slate-800">{a.name}</Td>
              <Td className="text-slate-600">{a.programArea || "—"}</Td>
              <Td>{a.active ? <Badge tone="g">Active</Badge> : <Badge>Inactive</Badge>}</Td>
              <Td num className="text-slate-500">{a.usage?.sites ?? "—"}</Td>
              <Td num className="text-slate-500">{a.usage?.params ?? "—"}</Td>
              {/* Le total sur les DOUZE colonnes qui désignent l'activité, pas
                  seulement les deux clés étrangères : c'est lui qui décide de la
                  suppression, il doit donc être celui qu'on lit. */}
              <Td num className={a.usageTotal ? "font-semibold text-slate-700" : "text-slate-400"}
                title={(a.usageDetail||[]).map(u=>`${u.label} (${u.table}.${u.colonne}) : ${u.lignes}`).join("\n")}>
                {a.usageTotal ? fmt(a.usageTotal) : "—"}</Td>
              <Td className="text-right">
                {superUser && <button onClick={()=>setRenomme({ id:a.id, code:a.tag, label:a.name })}
                  className="text-slate-400 m-ico p-1"
                  title="Renommer le tag, en entraînant les dix tables qui le portent"><ArrowRightLeft size={14}/></button>}
                {can("admin") && <button onClick={()=>setEdit(a)} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>}
                {can("admin") && <button onClick={()=>remove(a)}
                  className={clsx("p-1", a.usageTotal ? "text-slate-300 cursor-help" : "text-slate-400 hover:text-rose-600")}
                  title={a.usageTotal ? `${a.usageTotal} ligne(s) référencent cette activité` : "Supprimer"}>
                  <Trash2 size={14}/></button>}</Td>
            </tr>))}</tbody>
        </TableWrap>}
      </Card>
      <ActivityModal open={!!edit} act={edit} busy={busy} onClose={()=>setEdit(null)} onSave={save} />
      <RenommageModal open={!!renomme} item={renomme} cle="activites"
        type={{ label:"Activités" }} notify={notify}
        onClose={()=>setRenomme(null)} onDone={async ()=>{ setRenomme(null); await reload(); }} />
    </>);
}
function ActivityModal({ open, act, busy, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(act||{}); },[act]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  return (
    <Modal open onClose={onClose} title={act?.id?"Modifier l'activité":"Nouvelle activité"}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || !f.name || !f.tag} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        {/* Le tag est en lecture seule dès que l'activité existe : le serveur
            refuserait de le changer, et proposer un champ qu'on ne peut pas
            enregistrer apprend à l'utilisateur que l'écran ment. */}
        <Field label="Code (tag)" hint={act?.id
          ? "Non modifiable ici — clé de jointure ; un super le renomme en cascade (bouton dédié)"
          : "Court, en majuscules — porté par les sources"}><Input value={f.tag||""}
          readOnly={!!act?.id} disabled={!!act?.id}
          onChange={e=>u("tag",e.target.value.replace(/\s+/g,"").toUpperCase())} placeholder="URT" /></Field>
        <Field label="Domaine programme"><Select value={f.programArea||""} onChange={e=>u("programArea",e.target.value)}
          empty="— aucun —" options={PROG_AREAS.map(p=>p[0])} /></Field>
        <Field label="Intitulé" className="col-span-2"><Input value={f.name||""}
          onChange={e=>u("name",e.target.value)} placeholder="Unconditional Resource Transfer" /></Field>
      </div>
      <Sw label="Activité active" hint="Une activité inactive n'est plus proposée dans les choix" on={f.active!==false} onChange={v=>u("active",v)} />
    </Modal>);
}

/* Les deux natures d'indicateur (migration 022). Le CRF est le cadre de résultats
   institutionnel — outcome, output, other output ; l'XLSForm porte les indicateurs
   de PROCESSUS d'une activité. Une seule bibliothèque, deux sous-onglets. */
const IND_NATURES = [["crf","CRF — résultats"],["xlsform","XLSForm — processus"]];
/* Les quatre niveaux du cadre de résultats, tels que la masterlist du PAM les
   range par onglet (migration 027) : Annex 2 Outcome, Annex 3 Output, Detailed
   Output, Annex 4 Crosscutting. */
const IND_LEVELS = [["outcome","Outcome"],["output","Output"],
  ["other_output","Other output (détaillé)"],["crosscutting","Transversal (CC)"],["sdg","ODD (SDG)"]];
const indLevelLabel = (v) => IND_LEVELS.find(([k])=>k===v)?.[1] || "";
const IND_PAGE = 100;
/* Les colonnes que chaque sous-groupe de la masterlist met en avant — ce que le
   propriétaire a listé, colonne par colonne (« tu peux adapter les noms »). Le
   tableau les rend dans cet ordre, après Code et Intitulé ; un tableau plus large
   que l'écran défile dans son cadre (en-tête collant). */
const IND_COLS = {
  outcome:      ["tags","cibles","applic","report","cat"],
  output:       ["tags","cibles","type","follow","cat"],
  other_output: ["interm","unite","unitinterp","flex","type","cat"],
  crosscutting: ["tags","cibles","applic","cat"],
  sdg:          ["cat","unite"],
};
const IND_COL_LABEL = { tags:"Activités concernées", cibles:"Cibles / groupes", applic:"Applicabilité",
  report:"Exigence de report", follow:"Valeur de suivi reportée", type:"Output / Other output",
  interm:"Indicateur intermédiaire", unite:"Unité", unitinterp:"Interprétation de l'unité",
  flex:"Flexibilité", cat:"Catégorie" };

function SetIndicators({ db, set, notify, can }){
  const [edit,setEdit] = useState(null);
  /* 842 indicateurs de masterlist, rangés par onglet (niveau) puis par thème.
     « Mettre à gauche comme avec listes paramétrables au lieu d'un filtre à
     trois niveaux » : le NIVEAU du cadre de résultats — et la nature de
     processus — se choisissent dans un RAIL à gauche ; la catégorie et la
     recherche restent au-dessus du tableau, à droite. */
  const [active,setActive] = useState("crf:outcome");
  const [cat,setCat] = useState("");
  const [act,setAct] = useState("");
  const [q,setQ]     = useState("");
  const [page,setPage] = useState(1);
  /* Les intermédiaires dépliés. « Les indicateurs intermédiaires, si tu regardes
     bien, sont des branches expand de l'indicateur, d'où la duplication de code. »
     Exact : sur l'onglet détaillé, un même indicateur INTERMÉDIAIRE (A.5.g.2…) se
     répète sur chacun de ses indicateurs détaillés (A.5.1, A.5.2…). On ne le répète
     plus : il devient un PARENT dépliable, et ses détaillés en sont les branches. */
  const [deplies,setDeplies] = useState(() => new Set());
  const basculerDeplie = (k) => setDeplies(s => { const n2 = new Set(s);
    n2.has(k) ? n2.delete(k) : n2.add(k); return n2; });
  const nature = active === "xls" ? "xlsform" : "crf";
  const niv = nature === "crf" ? active.split(":")[1] : "";
  const crf = nature === "crf";
  const kindOf = (ind) => ind.kind || "crf";
  const countLevel = (lvl) => db.indicators.filter(i => kindOf(i)==="crf" && i.level===lvl).length;
  const groups = [
    { label:"CRF — cadre de résultats",
      items: IND_LEVELS.map(([v,l]) => ({ value:`crf:${v}`, label:l, count:countLevel(v) })) },
    { label:"XLSForm — processus",
      items:[{ value:"xls", label:"Indicateurs de processus",
               count: db.indicators.filter(i => i.kind==="xlsform").length }] },
  ];
  const listeNature = db.indicators.filter(ind => kindOf(ind) === nature && (!crf || ind.level === niv));
  const categories = [...new Set(listeNature.map(i => i.category).filter(Boolean))].sort();
  const tagsPresents = [...new Set(listeNature.flatMap(i => i.activityTags || []))].sort();
  const liste = listeNature.filter(i =>
    (!cat || i.category === cat)
    && (!act || (i.activityTags || []).includes(act))
    && (!q.trim() || `${i.id} ${i.name} ${i.category || ""} ${(i.activityTags||[]).join(" ")} ${i.targets||""}`
         .toLowerCase().includes(q.trim().toLowerCase())));
  /* L'onglet détaillé (« other_output ») s'affiche en ARBRE : les indicateurs
     détaillés se rangent sous leur indicateur intermédiaire. On regroupe donc par
     `intermediate` (le parent), et la pagination porte sur les PARENTS, pas sur les
     lignes — sinon une branche se retrouverait coupée d'une page à l'autre. */
  const estArbre = crf && niv === "other_output";
  const groupesInterm = useMemo(() => {
    if(!estArbre) return [];
    const m = new Map();
    for(const i of liste){ const k = String(i.intermediate || "").replace(/\s+/g, " ").trim();
      if(!m.has(k)) m.set(k, []); m.get(k).push(i); }
    /* Le groupe sans parent en dernier ; les autres par ordre de code. */
    return [...m.entries()].sort((a,b)=>(a[0]?1:0)-(b[0]?1:0) || a[0].localeCompare(b[0]));
  }, [estArbre, liste]);

  const ARBRE_PAGE = 40;
  const nbUnites = estArbre ? groupesInterm.length : liste.length;
  const tailePage = estArbre ? ARBRE_PAGE : IND_PAGE;
  const pages = Math.max(1, Math.ceil(nbUnites / tailePage));
  const pageSure = Math.min(page, pages);
  const visibles = estArbre ? [] : liste.slice((pageSure-1)*IND_PAGE, pageSure*IND_PAGE);
  const groupesVisibles = estArbre ? groupesInterm.slice((pageSure-1)*ARBRE_PAGE, pageSure*ARBRE_PAGE) : [];
  const activeLabel = crf ? indLevelLabel(niv) : "Indicateurs de processus";
  const activites = (db.activities || []).filter(a=>a.active).map(a => [a.tag, `${a.tag} — ${a.name}`]);
  const activiteLabel = (tag) => (db.activities || []).find(a=>a.tag===tag)?.name || tag || "";

  /* Les colonnes du sous-groupe courant, et le rendu d'une cellule par clé. Un
     indicateur retiré du cadre porte une méthode « Retiré… » ; sinon il est actif. */
  const colClés = IND_COLS[niv] || ["tags","cibles","cat"];
  /* En arbre, la colonne « interm » n'est plus une colonne : c'est le parent. */
  const colClésAff = estArbre ? colClés.filter(k => k !== "interm") : colClés;
  const indActif = (ind) => !/retir|inactiv|deac/i.test(ind.status || ind.method || "");
  const badgesTags = (tags) => (tags||[]).length
    ? <div className="flex flex-wrap gap-1">
        {tags.slice(0,8).map(t=>(<span key={t} title={activiteLabel(t)}
          className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200 f10 font-semibold">{t}</span>))}
        {tags.length>8 && <span className="f10 text-slate-400">+{tags.length-8}</span>}</div>
    : <span className="text-slate-400 f11">toutes / non précisé</span>;
  const indCell = (k, ind) => {
    switch(k){
      case "tags": return badgesTags(ind.activityTags);
      case "cibles": return ind.targets || "—";
      case "applic": return ind.applicability || "—";
      case "report": return ind.reportingReq || "—";
      case "follow": return ind.followValue || "—";
      case "type": return ind.outputType || "—";
      case "interm": return ind.intermediate || "—";
      case "unite": return ind.unit || "—";
      case "unitinterp": return ind.unitInterp || "—";
      case "flex": return ind.flexibility || "—";
      case "cat": return ind.category || "—";
      default: return "—";
    }
  };

  const save = (ind) => { set(d => { const i=d.indicators.findIndex(x=>x.id===ind.id);
      if(i>=0) d.indicators[i]=ind; else d.indicators.push(ind); return d; });
    setEdit(null); notify("Indicateur enregistré","ok"); };
  const exp = () => download(`indicateurs_${nature}${crf?"_"+niv:""}.csv`,
    toCSV(liste, ["id","name","kind","level","category","activity","basket","unit","target","dir","method","freq"]), "text/csv");
  const imp = (file) => { const rd=new FileReader();
    rd.onload=()=>{ const rows=parseCSV(rd.result);
      if(!rows.length){ notify("Fichier vide","err"); return; }
      set(d=>{ rows.forEach(r=>{ if(!r.id) return;
        const kind = r.kind==="xlsform" ? "xlsform" : "crf";
        const rec = { id:r.id, name:r.name||r.id, kind,
          level: kind==="crf" ? (IND_LEVELS.some(([k])=>k===r.level) ? r.level : "") : "",
          activity: kind==="xlsform" ? (r.activity||"") : "",
          category: kind==="crf" ? (r.category||"") : "",
          basket:r.basket||"", unit:r.unit||"%",
          target:n(r.target), dir:(r.dir==="down"?"down":"up"), method:r.method||"", freq:r.freq||"" };
        const i=d.indicators.findIndex(x=>x.id===rec.id);
        if(i>=0) d.indicators[i]=rec; else d.indicators.push(rec); }); return d; });
      notify(`${rows.length} indicateur(s) importé(s)`,"ok"); };
    rd.readAsText(file,"utf-8"); };

  return (
    <SideRail groups={groups} active={active} onPick={v=>{ setActive(v); setCat(""); setAct(""); setPage(1); }}
      right={<>
        <Aide>{crf
          ? <>Le <b>CRF</b> est le cadre de résultats. Choisissez le niveau en haut, puis affinez par
            catégorie thématique ou recherche. Chaque indicateur montre <b>à quelles activités</b> il
            s'applique et <b>quelles cibles</b> il vise. Il alimente le plan de collecte et
            Programme → Résultats.</>
          : <>Les indicateurs de <b>processus</b> issus des <b>XLSForms</b> suivent l'exécution d'une
            activité. Ils sont stockés comme référentiel et alimentent le tableau de bord de suivi.</>}
          {" "}La liste s'exporte en CSV et se réimporte pour une mise à jour groupée.</Aide>
        <Card flush title={crf ? `CRF · ${activeLabel}` : "Indicateurs de processus (XLSForm)"}
          subtitle={`${fmt(liste.length)} indicateur${liste.length>1?"s":""}`
            + (liste.length !== listeNature.length ? ` sur ${fmt(listeNature.length)}` : "")}
          right={<>
            <label><input type="file" accept=".csv" className="hidden" onChange={e=>e.target.files[0]&&imp(e.target.files[0])} />
              <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer"><Upload size={13}/> Importer</span></label>
            <Btn size="sm" kind="sec" icon={Download} onClick={exp} disabled={!liste.length}>Exporter</Btn>
            {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ id:"", name:"",
              kind:nature, level:crf?niv:"", activity:"", category:"", basket:"", unit:"%",
              target:0, dir:"up", method:"", freq:"Annuel" })}>Ajouter</Btn>}</>}>
          <div className="px-4 pt-3 flex items-center gap-2 flex-wrap">
            {crf && !!categories.length && <Select value={cat} onChange={e=>{ setCat(e.target.value); setPage(1); }}
              empty={`Toutes les catégories (${categories.length})`} options={categories}
              className="mi-py1 mi-xs mi-wauto" />}
            {crf && !!tagsPresents.length && <Select value={act} onChange={e=>{ setAct(e.target.value); setPage(1); }}
              empty={`Toutes les activités (${tagsPresents.length})`}
              options={tagsPresents.map(t=>[t, `${t} — ${activiteLabel(t)}`])}
              className="mi-py1 mi-xs mi-wauto" />}
            <div className="relative">
              <Search size={13} className="absolute left-2 top-2 text-slate-400" />
              <Input value={q} onChange={e=>{ setQ(e.target.value); setPage(1); }}
                placeholder="Code, intitulé ou catégorie" className="mi-py1 mi-xs pl-7" style={{width:240}} />
            </div>
            {(cat || act || q) && <Btn size="sm" kind="ghost"
              onClick={()=>{ setCat(""); setAct(""); setQ(""); setPage(1); }}>Effacer les filtres</Btn>}
          </div>
          {!liste.length
            ? <Empty title={listeNature.length ? "Aucun indicateur ne correspond" : "Aucun indicateur à ce niveau"}
                text={listeNature.length
                  ? "Aucun indicateur ne correspond à la catégorie ou à la recherche."
                  : crf ? "Ajoutez-en un, ou chargez la masterlist réelle (npm run seed:reel)."
                        : "Ajoutez-en un rattaché à une activité, ou importez-le."} />
            : <><TableWrap max="mh72">
            {/* Le tableau ne PLANIFIE pas : il LISTE. Il montre, par sous-groupe,
                les colonnes réelles de la masterlist (IND_COLS) : la pertinence
                (activités, cibles) mais aussi le statut, l'applicabilité, le type
                output/other, l'unité et sa flexibilité pour le détaillé, etc. */}
            <thead><tr><Th>Code</Th><Th>Intitulé</Th>
              {crf ? <><Th>Statut</Th>{colClésAff.map(k => <Th key={k}>{IND_COL_LABEL[k]}</Th>)}</>
                   : <><Th>Activité</Th><Th>Unité</Th><Th>Fréquence</Th></>}<Th /></tr></thead>
            {estArbre
              ? <tbody>{groupesVisibles.map(([interm,enfants])=>{
                  const sansParent = interm === "";
                  const ouvert = sansParent || deplies.has(interm);
                  return (
                  <Fragment key={interm || "__sans__"}>
                    {/* Le parent : l'indicateur INTERMÉDIAIRE, une seule fois. Cliquer déplie ses branches. */}
                    <tr className="bg-slate-50/70 hover:bg-sky-50 cursor-pointer align-top border-t border-slate-200"
                      onClick={()=>!sansParent && basculerDeplie(interm)}>
                      <Td>{sansParent ? <span className="text-slate-300">—</span>
                        : ouvert ? <ChevronDown size={15} className="text-slate-500"/> : <ChevronRight size={15} className="text-slate-500"/>}</Td>
                      <Td className="mw520 font-semibold text-slate-800" style={{whiteSpace:"normal"}} colSpan={colClésAff.length + 3}>
                        <span className="inline-flex items-center gap-2">
                          <Layers size={13} className="text-slate-400 shrink-0" />
                          <span className={sansParent?"text-slate-400 italic font-normal":""}>{interm || "Sans indicateur intermédiaire"}</span>
                          <Badge tone="n">{enfants.length} détaillé{enfants.length>1?"s":""}</Badge>
                        </span>
                      </Td>
                    </tr>
                    {/* Les branches : les indicateurs détaillés de cet intermédiaire. */}
                    {ouvert && enfants.map(ind=>(
                      <tr key={ind.id} className="hover:bg-sky-50 align-top">
                        <Td className="pl-6"><Badge tone="b">{ind.id}</Badge></Td>
                        <Td className="mw420 text-slate-800" style={{whiteSpace:"normal"}} title={ind.name}>{ind.name}
                          {ind.formula && <span className="ml-1.5" title={ind.formula}><Badge tone="y">calculé</Badge></span>}</Td>
                        <Td>{indActif(ind) ? <Badge tone="g">{ind.status || "Actif"}</Badge> : <Badge tone="r">{ind.status || "Inactif"}</Badge>}</Td>
                        {colClésAff.map(k => <Td key={k} className="text-slate-600 f11"
                          style={{whiteSpace:"normal", maxWidth: k==="cat"?240:200}}
                          title={typeof indCell(k,ind)==="string" ? indCell(k,ind) : undefined}>{indCell(k,ind)}</Td>)}
                        <Td className="text-right">
                          {can("edit") && <button onClick={()=>setEdit(ind)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                          {can("del") && <button onClick={()=>set(d=>{ d.indicators=d.indicators.filter(x=>x.id!==ind.id); return d; })}
                            className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
                      </tr>))}
                  </Fragment>); })}</tbody>
              : <tbody>{visibles.map(ind=>(
              <tr key={ind.id} className="hover:bg-sky-50 align-top">
                <Td><Badge tone="b">{ind.id}</Badge></Td>
                <Td className="mw420 font-medium text-slate-800" style={{whiteSpace:"normal"}} title={ind.name}>{ind.name}
                  {ind.formula && <span className="ml-1.5" title={ind.formula}><Badge tone="y">calculé</Badge></span>}</Td>
                {crf ? <>
                  <Td>{indActif(ind)
                    ? <Badge tone="g">{ind.status || "Actif"}</Badge>
                    : <Badge tone="r" >{ind.status || "Inactif"}</Badge>}</Td>
                  {colClés.map(k => <Td key={k} className="text-slate-600 f11"
                    style={{whiteSpace:"normal", maxWidth: k==="cat"?240 : k==="tags"?280 : 200}}
                    title={typeof indCell(k,ind)==="string" ? indCell(k,ind) : undefined}>{indCell(k,ind)}</Td>)}
                </> : <>
                  <Td className="text-slate-600">{ind.activity ? <span title={activiteLabel(ind.activity)}>{ind.activity}</span> : "—"}</Td>
                  <Td>{ind.unit}</Td><Td>{ind.freq}</Td>
                </>}
                <Td className="text-right">
                  {can("edit") && <button onClick={()=>setEdit(ind)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                  {can("del") && <button onClick={()=>set(d=>{ d.indicators=d.indicators.filter(x=>x.id!==ind.id); return d; })}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
              </tr>))}</tbody>}
          </TableWrap>
          {estArbre && <div className="px-4 pt-2 flex items-center gap-3">
            <Btn size="sm" kind="ghost" onClick={()=>setDeplies(new Set(groupesInterm.map(g=>g[0])))}>Tout déplier</Btn>
            <Btn size="sm" kind="ghost" onClick={()=>setDeplies(new Set())}>Tout replier</Btn>
            <span className="f11 text-slate-400">{groupesInterm.length} intermédiaire(s) · {liste.length} détaillé(s)</span>
          </div>}
          {pages > 1 && (
            <div className="px-4 py-3 flex items-center gap-3 f125 text-slate-600">
              <Btn size="sm" kind="sec" disabled={pageSure<=1} onClick={()=>setPage(pageSure-1)}>Précédents</Btn>
              <span>{(pageSure-1)*tailePage+1} – {Math.min(pageSure*tailePage, nbUnites)} sur {fmt(nbUnites)}
                {estArbre ? " intermédiaires" : ""}</span>
              <Btn size="sm" kind="sec" disabled={pageSure>=pages} onClick={()=>setPage(pageSure+1)}>Suivants</Btn>
            </div>)}
          </>}
        </Card>
        <IndicatorModal open={!!edit} ind={edit} activites={activites} indicateurs={db.indicators}
          categories={categories} onClose={()=>setEdit(null)} onSave={save} />
      </>} />
  );
}

function IndicatorModal({ open, ind, activites, categories = [], indicateurs = [], onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(ind||{}); },[ind]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const crf = (f.kind||"crf") === "crf";
  /* Un indicateur COMPOSÉ se définit par une formule entre les codes des autres
     indicateurs de la masterlist. On propose ces codes (hors celui édité, pour
     interdire l'auto-référence) et l'on valide l'expression par l'évaluateur sûr,
     comme les jeux de données — mêmes garde-fous CSP. */
  const codesRef = (indicateurs || []).map(i=>i.id).filter(c => codeVariable(c) && c !== f.id);
  const nomRef = (c) => ((indicateurs||[]).find(i=>i.id===c)||{}).name || c;
  const erreurFormule = (f.formula||"").trim()
    ? (evalFormula(f.formula, Object.fromEntries(codesRef.map(c=>[c,1]))).err || "") : "";
  return (
    <Modal open onClose={onClose}
      title={`${ind?.id?"Modifier":"Nouvel"} indicateur ${crf?"CRF":"de processus"}`}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!f.id||!f.name} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Code"><Input value={f.id||""} onChange={e=>u("id",e.target.value.toUpperCase())} placeholder={crf?"FCS":"PROC-01"} /></Field>
        {crf
          ? <Field label="Niveau du cadre de résultats"><Select value={f.level||"outcome"} onChange={e=>u("level",e.target.value)}
              options={IND_LEVELS} /></Field>
          : <Field label="Activité suivie"><Select value={f.activity||""} onChange={e=>u("activity",e.target.value)}
              empty="— aucune —" options={activites} /></Field>}
        <Field label="Intitulé" className="col-span-2"><Input value={f.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        {/* La catégorie vient du classeur institutionnel ; le panier est le
            regroupement d'analyse propre au bureau. Deux axes, deux champs :
            les confondre perdrait le second au premier chargement de la
            masterlist. La liste propose l'existant sans l'imposer. */}
        {crf && <Field label="Catégorie (masterlist)" className="col-span-2"
          hint="Le thème tel que le classeur du PAM le nomme — c'est par lui que l'écran filtre">
          <Input list="mems-cat-indic" value={f.category||""} onChange={e=>u("category",e.target.value)} />
          <datalist id="mems-cat-indic">{categories.map(c => <option key={c} value={c} />)}</datalist>
        </Field>}
        {crf && <Field label="Panier thématique (analyse du bureau)" className="col-span-2"><Input value={f.basket||""} onChange={e=>u("basket",e.target.value)} /></Field>}
        <Field label="Unité"><Select value={f.unit||"%"} onChange={e=>u("unit",e.target.value)} options={["%","idx","nombre","ratio"]} /></Field>
        <Field label="Valeur cible"><Input type="number" step="0.1" value={f.target??0} onChange={e=>u("target",n(e.target.value))} /></Field>
        <Field label="Sens de progression"><Select value={f.dir||"up"} onChange={e=>u("dir",e.target.value)}
          options={[["up","À maximiser"],["down","À minimiser"]]} /></Field>
        <Field label="Fréquence de collecte"><Select value={f.freq||"Annuel"} onChange={e=>u("freq",e.target.value)}
          options={["Mensuel","Trimestriel","Semestriel","Annuel"]} /></Field>
        <Field label="Méthode de collecte" className="col-span-2"><Input value={f.method||""} onChange={e=>u("method",e.target.value)}
          placeholder={crf?"Enquête ménage, registres, suivi post-distribution":"Extraction XLSForm, agrégation des soumissions"} /></Field>
        {crf && (
          <Field label="Formule (indicateur composé)" className="col-span-2"
            hint="Facultatif. Laissez vide pour un indicateur MESURÉ. Une formule le rend CALCULÉ : combinez d'autres indicateurs par leur code (ex. « FCS / FES * 100 »), sans données propres — réalisé et planifié se déduisent de ses composants. Fonctions : min, max, round, abs, sqrt, floor, ceil.">
            <Input value={f.formula||""} onChange={e=>u("formula",e.target.value)}
              placeholder="ex. FCS / FES * 100" className={erreurFormule?"border-rose-300":undefined} />
            {erreurFormule && <p className="f115 text-rose-700 mt-1">{erreurFormule}</p>}
            {(f.formula||"").trim() && !erreurFormule && <p className="f115 text-lime-700 mt-1">Formule valide — indicateur calculé.</p>}
            {!!codesRef.length && (
              <div className="flex flex-wrap gap-1 mt-2">
                {codesRef.slice(0,60).map(c=>(
                  <button key={c} type="button" title={nomRef(c)}
                    onClick={()=>u("formula",(f.formula||"")+c)}
                    className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{c}</button>))}
              </div>)}
          </Field>)}
      </div>
    </Modal>);
}

/* ── Calculs automatiques ── */
function SetCalc({ db, set, notify, can }){
  const TEST = { duration:12, riskLevel:2, nbSites:24, feasiblePerMonth:8, minInterval:6, minFreq:2,
    targetPerMonth:4, feasibilityRatio:2, adjustedFreq:4, adjustedInterval:3, beneficiaries:1500,
    population:85000, visitsDone:3, visitsPlanned:4, score:52 };
  const [edit,setEdit] = useState(null);
  /* Les variables issues du suivi de processus — celles que les XLSForms MoDa
     déclarent, activité par activité, plus ce qui a réellement été visité. Elles
     rejoignent les variables de couverture dans le MÊME jeu : une expression peut
     donc croiser la structure du formulaire et la réalisation du terrain. */
  const proc = useMemo(() => variablesProcessus(db), [db]);
  /* Le jeu d'essai devient : les valeurs fictives de couverture (elles n'ont pas
     de source réelle hors d'un couple bureau × activité) PLUS les valeurs
     RÉELLES du processus. Un calcul de processus s'éprouve ainsi sur la donnée
     du pays, pas sur un nombre inventé. */
  const scopeEssai = useMemo(() => ({ ...TEST, ...proc.vars }), [proc]);
  /* « Variable → signification → origine → valeur », toutes origines confondues. */
  const toutesVars = useMemo(() => [
    ...CALC_VARS.map(([v, d2, o]) => ({ nom:v, sens:d2, origine:o, valeur: TEST[v], essai:true })),
    ...proc.meta.map(m => ({ ...m, essai:false })),
  ], [proc]);

  /* « Sous-groupe à gauche, informations à droite, pour ne pas surcharger
     l'écran. » Les calculs se choisissent dans le rail (de base / personnalisés),
     et les variables utilisables deviennent une entrée de rail à part plutôt
     qu'une grande table poussée sous tous les calculs. */
  const [active,setActive] = useState(db.formulas[0]?.id || "__vars__");
  const save = (fm) => { set(d => { const i=d.formulas.findIndex(x=>x.id===fm.id);
      if(i>=0) d.formulas[i]=fm; else d.formulas.push({ ...fm, id:fm.id||uid("f"), core:false }); return d; });
    setEdit(null); notify("Calcul enregistré","ok"); };
  const groups = [
    { label:"Calculs de base", items: db.formulas.filter(f=>f.core).map(f=>({ value:f.id, label:f.label })) },
    { label:"Calculs personnalisés", items: db.formulas.filter(f=>!f.core).map(f=>({ value:f.id, label:f.label })) },
    { label:"Références", items:[{ value:"__vars__", label:"Variables utilisables", count:toutesVars.length }] },
  ];
  const isVars = active === "__vars__";
  const cur = isVars ? null : (db.formulas.find(f=>f.id===active) || db.formulas[0]);
  const idx = cur ? db.formulas.findIndex(f=>f.id===cur.id) : -1;
  const t = cur ? evalFormula(cur.expr, scopeEssai) : null;
  return (
    <SideRail groups={groups} active={isVars ? "__vars__" : cur?.id} onPick={setActive}
      right={<>
        {can("edit") && <div className="flex gap-2 flex-wrap">
          <Btn size="sm" icon={Plus} onClick={()=>setEdit({ id:"", label:"", desc:"", expr:"", vars:[] })}>Créer un calcul</Btn>
          <Btn size="sm" kind="sec" icon={RefreshCw}
            onClick={()=>{ set(d=>{ d.formulas = JSON.parse(JSON.stringify(D_FORMULAS)); return d; }); notify("Calculs de base rétablis","ok"); }}>Rétablir les calculs de base</Btn>
        </div>}
        {isVars ? (
          <Card flush title="Variables utilisables"
            subtitle={`${fmt(toutesVars.length)} variables acceptées dans les expressions`}>
            <div className="p-4 pb-0"><Note>Deux familles, et elles ne se lisent pas de la même façon.
              Les variables de <b>couverture</b> (duration, nbSites…) décrivent UN couple bureau × activité :
              elles n'ont de valeur que dans ce contexte, d'où une valeur d'essai fictive ici.
              Les variables de <b>suivi de processus</b> (<code>proc_…</code>) sont issues des
              <b> XLSForms MoDa</b> et du terrain : leur valeur affichée est la valeur RÉELLE du pays.
              Une expression peut croiser les deux — par exemple la couverture d'une activité rapportée
              au nombre d'indicateurs que son formulaire déclare.</Note></div>
            <TableWrap max="mh440">
              <thead><tr><Th>Variable</Th><Th>Signification</Th><Th>Origine</Th><Th num>Valeur</Th></tr></thead>
              <tbody>{toutesVars.map(v=>(
                <tr key={v.nom} className="hover:bg-sky-50">
                  <Td><code className="bg-slate-100 px-1.5 py-0.5 rounded f115">{v.nom}</code></Td>
                  <Td className="text-slate-700">{v.sens}</Td><Td className="text-slate-500">{v.origine}</Td>
                  <Td num className="tabular-nums" title={v.essai ? "Valeur d'essai" : "Valeur réelle"}>
                    {v.valeur ?? "—"}{v.essai && <span className="f10 text-slate-400 ml-1">essai</span>}</Td></tr>))}</tbody>
            </TableWrap>
          </Card>
        ) : cur ? (
          <Card title={cur.label} subtitle={cur.desc}
            right={<>{cur.core ? <Badge tone="n">calcul de base</Badge> : <Badge tone="b">personnalisé</Badge>}
              {t.ok ? <Badge tone="g">valide</Badge> : <Badge tone="r">erreur</Badge>}</>}>
            <Field label="Expression">
              <Input value={cur.expr} disabled={!can("edit")}
                onChange={e=>set(d=>{ d.formulas[idx].expr=e.target.value; return d; })} className="f12" /></Field>
            {!!(cur.vars||[]).length && <div className="flex flex-wrap gap-1.5 mb-2">
              {(cur.vars||[]).map(v=>(
                <button key={v} onClick={()=>set(d=>{ d.formulas[idx].expr += (d.formulas[idx].expr?" ":"")+v; return d; })}
                  className="px-2 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{v}</button>))}
            </div>}
            <div className={clsx("f115 px-2.5 py-1.5 rounded", t.ok?"bg-lime-50 text-lime-800":"bg-rose-50 text-rose-800")}>
              {t.ok ? <>Jeu d'essai → <b className="tabular-nums">{r2(t.value)}</b></> : t.err}</div>
            {!cur.core && can("edit") && (
              <div className="flex gap-2 mt-3">
                <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEdit(cur)}>Modifier</Btn>
                <Btn size="sm" kind="ghost" icon={Trash2}
                  onClick={()=>{ const nid=db.formulas[0]?.id||"__vars__"; set(d=>{ d.formulas=d.formulas.filter(x=>x.id!==cur.id); return d; }); setActive(nid); }}>Supprimer</Btn></div>)}
          </Card>
        ) : <Card><Empty title="Aucun calcul" text="Créez un calcul, ou consultez les variables utilisables." /></Card>}
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
            {/* Les deux familles de variables sont proposées SÉPARÉMENT : mélangées,
                les cent pastilles « proc_… » d'un pays bien équipé noieraient les
                quinze variables de couverture, et l'on ne saurait plus laquelle
                appartient à quel monde. */}
            <div className="f11 font-bold uppercase tracking-wide text-slate-400 mb-1">Couverture</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {CALC_VARS.map(([v])=>(<button key={v} onClick={()=>setEdit(p=>({...p, expr:(p.expr||"")+v,
                vars:[...new Set([...(p.vars||[]), v])] }))}
                className="px-2 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{v}</button>))}
            </div>
            {!!proc.meta.length && (<>
              <div className="f11 font-bold uppercase tracking-wide text-slate-400 mb-1">
                Suivi de processus (XLSForm) · {fmt(proc.meta.length)} variables</div>
              <div className="flex flex-wrap gap-1.5 mb-3 mh190 overflow-auto">
                {proc.meta.map(m=>(<button key={m.nom} title={`${m.sens} — valeur actuelle : ${m.valeur}`}
                  onClick={()=>setEdit(p=>({...p, expr:(p.expr||"")+m.nom,
                    vars:[...new Set([...(p.vars||[]), m.nom])] }))}
                  className="px-2 py-0.5 rounded bg-sky-50 hover:bg-sky-100 f11 c-bd border border-sky-200">{m.nom}</button>))}
              </div></>)}
            {(()=>{ const tt=evalFormula(edit.expr, scopeEssai);
              return <Note tone={tt.ok?"ok":"err"}>{tt.ok ? <>Résultat sur le jeu d'essai : <b>{r2(tt.value)}</b></> : tt.err}</Note>; })()}
          </>)}
        </Modal>
      </>} />
  );
}

/* ══════════════════ Catalogue de rations + denrées (chantier R) ══════════════════

   « Une ration, une ligne » : l'onglet n'est plus une matrice activité × denrée
   mais un CATALOGUE de conventions. Chaque ligne porte un libellé (« GD standard »,
   « Stunting FEFA 2023 »…), UNE denrée, un grammage par personne et par jour, une
   activité par défaut facultative, une note. Une convention composée (riz + huile +
   légumineuses) est plusieurs lignes de même libellé.

   Et « combiner la config des rations et la création de denrée » : les denrées se
   gèrent DANS le même écran (panneau du haut), et le sélecteur de denrée d'une ligne
   de ration offre « + créer une denrée » sans quitter la page. Les denrées vivent
   dans la liste typée `denrees` (routes/listes.js), servie ici par l'API — le
   catalogue, lui, est une collection synchronisée comme les autres. */

/* Les modalités de transfert d'une convention (migration 034). Les codes sont
   ceux de la liste « modalites » semée à la migration 026 ; « Food » vaut vivres.
   La modalité décide de l'unité du grammage : grammes pour les vivres, montant
   (Ar) par personne et par jour pour espèces et coupons. */
const MODALITES_RATION = [
  ["Food", "Vivres (en nature)"],
  ["Cash", "Espèces (CBT)"],
  ["Voucher", "Coupons (voucher)"],
  ["Mix", "Modalité mixte"],
  ["Capacity Strengthening", "Renforcement de capacités"],
];
const LABEL_MODALITE = Object.fromEntries(MODALITES_RATION);
const estRationCBT = (m) => m === "Cash" || m === "Voucher";
const uniteRation = (m) => estRationCBT(m) ? "Ar/pers/j" : "g/pers/j";
/* La catégorie de denrée attendue par une modalité : espèces/coupons → « cbt »,
   le reste → « food ». « other » est accepté partout. Sert à ne proposer que des
   denrées cohérentes dans le formulaire. */
const categorieAttendue = (m) => estRationCBT(m) ? "cbt" : "food";

function SetRations({ db, set, notify, can }){
  const [edit,setEdit]       = useState(null);   /* ligne de catalogue en édition */
  const [denrees,setDenrees] = useState(null);   /* liste typée « denree », lue par l'API */
  const [jours,setJours]     = useState(30);
  const [effectif,setEff]    = useState(1000);
  const [menage,setMenage]   = useState(1);       /* diviseur ménage : ÷5 en GFD, 1 sinon */
  const cat = db.rationCatalog || [];
  const activites = (db.activities || []).filter(a=>a.active);
  const actLabel = (tag) => activites.find(a=>a.tag===tag)?.name || "";

  /* Les denrées, chargées à l'ouverture puis après chaque création/renommage :
     le sélecteur de denrée et la liste du haut partagent la même source. */
  const [groupes,setGroupes] = useState([]);   /* familles alimentaires (groupe_denree) */
  const chargerDenrees = () => api.liste("denrees")
    .then(r => setDenrees((r.items||[]).map(x=>({ id:x.id, code:x.code, label:x.label,
      active:x.active!==false, rev:x.rev, usage:x.usageTotal||0,
      group:x.champs?.food_group || "", category:x.champs?.category || "food" }))))
    .catch(e=>{ notify(e.message,"err"); setDenrees([]); });
  useEffect(()=>{ chargerDenrees();
    api.liste("groupes_denree").then(r=>setGroupes((r.items||[]).filter(g=>g.active!==false)
      .map(g=>({ code:g.code, label:g.label })))).catch(()=>{});
  },[]);
  const denreesActives = (denrees||[]).filter(d=>d.active);

  /* Le catalogue est une collection synchronisée : on l'édite par `set`, comme
     les indicateurs. Un identifiant client, une révision à 1, le serveur tranche. */
  const saveLigne = (ligne) => {
    set(d => { const i = d.rationCatalog.findIndex(x=>x.id===ligne.id);
      if(i>=0) d.rationCatalog[i] = ligne;
      else d.rationCatalog.push({ ...ligne, id: ligne.id || uid("rc"), rev:1 });
      return d; });
    setEdit(null); notify("Ligne de ration enregistrée","ok");
  };
  const delLigne = (id) => set(d => { d.rationCatalog = d.rationCatalog.filter(x=>x.id!==id); return d; });

  /* Création d'une denrée sans quitter l'écran : la liste typée l'accueille, et
     on recharge pour que le sélecteur la propose aussitôt. Le code EST la valeur
     que portera `pdd.commodity` et `ration_catalog.commodity` — d'où sa présence. */
  const creerDenree = async (label, group, category) => {
    const nom = (label||"").trim(); if(!nom) return null;
    try{
      const champs = {};
      if(group) champs.food_group = group;
      if(category) champs.category = category;
      const r = await api.createItem("denrees", { code:nom, label:nom, champs });
      await chargerDenrees();
      notify(`Denrée « ${nom} » créée`,"ok");
      return r.item?.code || nom;
    }catch(e){ notify(e.message,"err"); return null; }
  };

  /* Les conventions, regroupées par libellé pour l'affichage : une ration composée
     se lit d'un bloc. Trié par `sort` puis libellé, comme le sert le serveur. */
  const parConvention = useMemo(()=>{
    const m = new Map();
    for(const l of [...cat].sort((a,b)=>(a.sort??0)-(b.sort??0) || (a.label||"").localeCompare(b.label||""))){
      if(!m.has(l.label)) m.set(l.label, []);
      m.get(l.label).push(l);
    }
    return [...m.entries()];
  },[cat]);

  const eff = Math.max(0, menage>1 ? effectif/menage : effectif);
  const tonnage = (g) => g*jours*eff/1e6;         /* tonnes */

  return (
    <>
      <Aide>Le catalogue applique la règle <b>« une ration, une ligne »</b> : chaque ligne porte une
        <b>modalité</b> (vivres, espèces, coupons), une convention (un libellé), <b>une denrée</b> et sa
        <b>quantité par personne et par jour</b> — grammes pour les vivres, montant (Ar) pour espèces et
        coupons. Une ration composée (riz + huile + légumineuses) est <b>plusieurs lignes de même libellé</b>.
        Les denrées se créent et se gèrent ici même, dans le panneau ci-dessous, avec leur <b>catégorie</b>
        (food / cbt / autre). Le tonnage — ou le montant total — n'est pas stocké : il se calcule à l'usage,
        <b>quantité × jours × effectif</b>, les jours étant saisis au plan de distribution parce qu'ils
        changent à chaque livraison.</Aide>

      {/* ── Denrées : la création combinée à la config des rations ── */}
      <DenreesPanel denrees={denrees} groupes={groupes} can={can} notify={notify}
        onCreate={creerDenree} onReload={chargerDenrees} />

      {/* ── Le catalogue proprement dit ── */}
      <Card flush title="Catalogue de rations" subtitle={`${cat.length} ligne(s) · ${parConvention.length} convention(s)`}
        right={can("edit") && <Btn size="sm" icon={Plus}
          onClick={()=>setEdit({ id:"", label:"", modality:"Food", commodity:denreesActives.find(d=>d.category!=="cbt")?.code||denreesActives[0]?.code||"", grams:0,
            activityTag:"", note:"", sort:(cat.reduce((m,l)=>Math.max(m,l.sort||0),0))+10 })}>
          Ajouter une ligne</Btn>}>
        {!cat.length
          ? <Empty icon={ClipboardList} title="Catalogue vide"
              text="Ajoutez une convention, ou chargez la première charge officielle (npm run seed:reel / migration 031)." />
          : <TableWrap max="mh480">
            <thead><tr><Th>Modalité</Th><Th>Convention</Th><Th>Denrée</Th><Th num>Quantité/pers/j</Th>
              <Th>Activité par défaut</Th><Th>Note</Th><Th /></tr></thead>
            <tbody>{parConvention.map(([label,lignes])=>lignes.map((l,i)=>{
              const mod = l.modality || "Food";
              return (
              <tr key={l.id} className="hover:bg-sky-50 align-top">
                <Td>{i===0
                  ? <span className={clsx("px-1.5 py-0.5 rounded f10 font-semibold border",
                      estRationCBT(mod) ? "bg-violet-50 text-violet-800 border-violet-200" : "bg-emerald-50 text-emerald-800 border-emerald-200")}
                      title={LABEL_MODALITE[mod]||mod}>{LABEL_MODALITE[mod]||mod}</span>
                  : <span />}</Td>
                <Td className={clsx("font-medium text-slate-800", i>0 && "text-transparent")}
                  style={{whiteSpace:"normal",maxWidth:220}}>{i===0 ? label : label}</Td>
                <Td><span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 f11 font-semibold">{l.commodity}</span></Td>
                <Td num className="tabular-nums font-semibold">{fmt(l.grams)} <span className="f10 text-slate-400 font-normal">{uniteRation(mod)}</span></Td>
                <Td>{l.activityTag
                  ? <span title={actLabel(l.activityTag)} className="f11 text-slate-700">{l.activityTag}</span>
                  : <span className="f11 text-slate-400">toutes</span>}</Td>
                <Td className="f105 text-slate-500" style={{whiteSpace:"normal",maxWidth:280}}>{l.note||"—"}</Td>
                <Td className="text-right whitespace-nowrap">
                  {can("edit") && <button onClick={()=>setEdit(l)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                  {can("del") && <button onClick={()=>delLigne(l.id)} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}
                </Td>
              </tr>); }))}</tbody>
          </TableWrap>}
      </Card>

      {/* ── Jeu d'essai : jours + effectif → tonnage OU montant, par convention ── */}
      {!!cat.length && (
        <Card title="Jeu d'essai — tonnage ou montant par convention"
          subtitle="Rien n'est stocké : quantité × jours × effectif. Vivres → tonnes ; espèces/coupons → montant (Ar)">
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <Field label="Jours de ration" className="mb-0"><Input type="number" min="0" step="1" value={jours}
              onChange={e=>setJours(Math.max(0,n(e.target.value)))} className="w-28" /></Field>
            <Field label="Effectif (bénéficiaires)" className="mb-0"><Input type="number" min="0" step="1" value={effectif}
              onChange={e=>setEff(Math.max(0,n(e.target.value)))} className="w-36" /></Field>
            <Field label="Diviseur ménage" className="mb-0"
              hint="÷5 pour une ration par ménage (GFD/FFA) ; 1 en nutrition/école"><Input type="number" min="1" step="1" value={menage}
              onChange={e=>setMenage(Math.max(1,n(e.target.value)||1))} className="w-24" /></Field>
            <div className="f11 text-slate-500 pb-1.5">Effectif retenu : <b>{fmt(Math.round(eff))}</b></div>
          </div>
          <TableWrap max="mh320">
            <thead><tr><Th>Modalité</Th><Th>Convention</Th><Th>Denrées</Th>
              <Th num>Quantité totale/pers/j</Th><Th num>Résultat</Th></tr></thead>
            <tbody>{parConvention.map(([label,lignes])=>{
              /* Une convention peut mêler vivres et transfert ; on sépare les deux :
                 les lignes vivres donnent un tonnage, les lignes CBT un montant. */
              const cbt = lignes.some(l=>estRationCBT(l.modality));
              const qTot = lignes.reduce((s,l)=>s+n(l.grams),0);
              const t = tonnage(qTot);               /* tonnes (pertinent pour les vivres) */
              const montant = qTot*jours*eff;         /* Ar total (pertinent pour espèces/coupons) */
              const mod = lignes[0]?.modality || "Food";
              return (
                <tr key={label} className="hover:bg-sky-50">
                  <Td><span className={clsx("px-1.5 py-0.5 rounded f10 font-semibold border",
                    cbt ? "bg-violet-50 text-violet-800 border-violet-200" : "bg-emerald-50 text-emerald-800 border-emerald-200")}>
                    {LABEL_MODALITE[mod]||mod}</span></Td>
                  <Td className="font-medium text-slate-800" style={{whiteSpace:"normal",maxWidth:200}}>{label}</Td>
                  <Td className="f11 text-slate-500">{lignes.map(l=>`${l.commodity} ${fmt(l.grams)}`).join(" + ")}</Td>
                  <Td num className="tabular-nums font-semibold">{fmt(qTot)} <span className="f10 text-slate-400 font-normal">{uniteRation(mod)}</span></Td>
                  <Td num className="tabular-nums text-slate-700 font-semibold">{cbt
                    ? <>{fmt(Math.round(montant))} <span className="f10 text-slate-400 font-normal">Ar</span></>
                    : <>{r2(t)} <span className="f10 text-slate-400 font-normal">t</span></>}</Td>
                </tr>); })}</tbody>
          </TableWrap>
        </Card>)}

      <RationModal open={!!edit} ligne={edit} denrees={denreesActives} activites={activites}
        labels={[...new Set(cat.map(l=>l.label))]} onCreateDenree={creerDenree}
        onClose={()=>setEdit(null)} onSave={saveLigne} />
    </>);
}

/* Le panneau de denrées, dans l'écran des rations : créer, renommer, retirer une
   denrée sans quitter la config des rations. Les denrées sont une liste typée
   (routes/listes.js) — édition réservée à l'administration comme toute liste. */
function DenreesPanel({ denrees, groupes, can, notify, onCreate, onReload }){
  const [ajout,setAjout] = useState("");
  const [grp,setGrp]     = useState("");
  const [cat,setCat]     = useState("food");
  const [busy,setBusy]   = useState(false);
  if(denrees === null) return <Card title="Denrées & commodités"><Empty icon={ClipboardList} title="Chargement des denrées…" /></Card>;
  const ajouter = async () => { if(!ajout.trim()) return; setBusy(true);
    const code = await onCreate(ajout.trim(), grp||null, cat||null); if(code){ setAjout(""); } setBusy(false); };
  const basculer = async (d) => { setBusy(true);
    try{ await api.activerItem("denrees", d.id, !d.active, d.rev); await onReload(); }
    catch(e){ notify(e.message,"err"); } setBusy(false); };
  const retirer = async (d) => {
    if(d.usage>0){ notify(`« ${d.label} » est utilisée ${d.usage} fois (PDD/catalogue) — désactivez-la plutôt`,"warn"); return; }
    if(!confirm(`Supprimer la denrée « ${d.label} » ?`)) return; setBusy(true);
    try{ await api.deleteItem("denrees", d.id); await onReload(); notify("Denrée supprimée","ok"); }
    catch(e){ notify(e.message,"err"); } setBusy(false);
  };
  const labelGroupe = (code) => (groupes||[]).find(g=>g.code===code)?.label || code;
  /* Les denrées regroupées par FAMILLE, à la manière de COMET. L'ordre des
     familles suit la liste des groupes ; les denrées sans groupe finissent
     ensemble. Une chip par denrée, sous l'en-tête de sa famille. */
  const parFamille = (() => {
    const ordre = (groupes||[]).map(g=>g.code);
    const m = new Map();
    for(const d of denrees){ const k = d.group || ""; if(!m.has(k)) m.set(k, []); m.get(k).push(d); }
    return [...m.entries()].sort((a,b)=>{
      const ia = a[0]===""?999:ordre.indexOf(a[0]), ib = b[0]===""?999:ordre.indexOf(b[0]);
      return (ia<0?998:ia)-(ib<0?998:ib);
    });
  })();
  const chip = (d) => (
    <div key={d.id} className={clsx("inline-flex items-center gap-1.5 rounded-full border pl-3 pr-1.5 py-1 f11",
      d.active ? "bg-white border-slate-200 text-slate-700" : "bg-slate-50 border-slate-200 text-slate-400")}>
      <span className="font-semibold">{d.label}</span>
      {d.category==="cbt" && <span className="f10 px-1 rounded bg-violet-100 text-violet-700" title="Transfert monétaire">CBT</span>}
      {d.category==="other" && <span className="f10 px-1 rounded bg-slate-100 text-slate-500" title="Autre">autre</span>}
      {d.usage>0 && <span className="f10 text-slate-400" title="Utilisée dans le PDD ou le catalogue">·{d.usage}</span>}
      {!d.active && <span className="f10 uppercase tracking-wide">inactif</span>}
      {can("admin") && <>
        <button onClick={()=>basculer(d)} disabled={busy} title={d.active?"Désactiver":"Réactiver"}
          className="text-slate-300 hover:text-slate-600 px-1">{d.active?"⦸":"↺"}</button>
        {!d.usage && <button onClick={()=>retirer(d)} disabled={busy} title="Supprimer"
          className="text-slate-300 hover:text-rose-600"><Trash2 size={12}/></button>}
      </>}
    </div>);
  return (
    <Card flush title="Denrées & commodités"
      subtitle="Créées et gérées ici même, rangées par famille — le code est la valeur portée par le plan de distribution et le catalogue"
      right={can("admin") && <div className="flex items-center gap-2 flex-wrap">
        <Input value={ajout} onChange={e=>setAjout(e.target.value)} placeholder="Nouvelle denrée (ex. Farine)"
          onKeyDown={e=>e.key==="Enter"&&ajouter()} className="mi-py1 mi-xs" style={{width:170}} />
        <Select value={cat} onChange={e=>setCat(e.target.value)}
          options={[["food","Vivres"],["cbt","CBT (espèces/coupon)"],["other","Autre"]]} className="mi-py1 mi-xs mi-wauto" />
        {!!(groupes||[]).length && <Select value={grp} onChange={e=>setGrp(e.target.value)} empty="Famille…"
          options={groupes.map(g=>[g.code, g.label])} className="mi-py1 mi-xs mi-wauto" />}
        <Btn size="sm" icon={Plus} disabled={busy||!ajout.trim()} onClick={ajouter}>Créer</Btn>
      </div>}>
      {denrees.length ? (
        <div className="p-3 space-y-3">
          {parFamille.map(([code,list])=>(
            <div key={code||"__none__"}>
              <div className="f10 font-bold uppercase tracking-wider text-slate-400 mb-1.5">
                {code ? labelGroupe(code) : "Sans famille"}</div>
              <div className="flex flex-wrap gap-2">{list.map(chip)}</div>
            </div>))}
        </div>
      ) : <div className="p-3"><span className="f11 text-slate-400">Aucune denrée — créez-en une ci-dessus.</span></div>}
    </Card>);
}

/* La fiche d'une ligne de ration. Le sélecteur de denrée porte « + créer une
   denrée » : la création se fait sans quitter la fiche, et la nouvelle denrée est
   aussitôt choisie. Le libellé propose les conventions existantes (datalist) pour
   qu'une ration composée reçoive le MÊME libellé sur chacune de ses lignes. */
function RationModal({ open, ligne, denrees, activites, labels, onCreateDenree, onClose, onSave }){
  const [f,setF] = useState({});
  const [creation,setCreation] = useState("");
  /* Le « test de calcul » demandé dans l'userform : jours × effectif appliqués à
     la quantité saisie, en direct, sans quitter la fiche. Local au formulaire. */
  const [tJours,setTJours] = useState(30);
  const [tEff,setTEff]     = useState(1000);
  useEffect(()=>{ setF(ligne||{}); setCreation(""); },[ligne]);
  if(!open) return null;
  const u = (k,v)=>setF(p=>({...p,[k]:v}));
  const mod = f.modality || "Food";
  const cbt = estRationCBT(mod);
  const catAttendue = categorieAttendue(mod);
  /* On ne propose que les denrées cohérentes avec la modalité — les CBT (Espèces,
     Coupon) pour espèces/coupons, les vivres sinon — plus « other », accepté
     partout. La denrée déjà choisie reste proposée même si sa catégorie diffère,
     pour ne jamais la faire disparaître d'une fiche qu'on modifie. */
  const denreesFiltrees = denrees.filter(d => d.category===catAttendue || d.category==="other" || d.code===f.commodity);
  const choisirDenree = async (v) => {
    if(v==="__new__"){ setCreation(" "); return; }
    u("commodity", v);
  };
  const validerCreation = async () => {
    const code = await onCreateDenree(creation.trim(), null, catAttendue);
    if(code){ u("commodity", code); setCreation(""); }
  };
  const q = Math.max(0, n(f.grams));
  const resultat = cbt
    ? q * Math.max(0,tJours) * Math.max(0,tEff)            /* Ar total */
    : q * Math.max(0,tJours) * Math.max(0,tEff) / 1e6;      /* tonnes */
  return (
    <Modal open onClose={onClose} title={ligne?.id ? "Modifier la ligne de ration" : "Nouvelle ligne de ration"}
      subtitle="Modalité, convention, denrée, quantité par personne et par jour"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={!(f.label||"").trim() || !(f.commodity||"").trim()}
          onClick={()=>onSave({ ...f, modality:mod, grams:Math.max(0,n(f.grams)), sort:f.sort??0 })}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Modalité de transfert" hint="Vivres → grammes ; espèces/coupons → montant (Ar) par personne et par jour">
          <Select value={mod} onChange={e=>{
            const m2 = e.target.value;
            /* Changer de modalité recale la denrée sur une denrée cohérente si
               l'actuelle ne l'est plus — une ration espèces ne reste pas sur « Riz ». */
            setF(p=>{ const cur = denrees.find(d=>d.code===p.commodity);
              const catV = categorieAttendue(m2);
              const ok = cur && (cur.category===catV || cur.category==="other");
              const repl = ok ? p.commodity : (denrees.find(d=>d.category===catV)?.code || p.commodity || "");
              return { ...p, modality:m2, commodity:repl }; });
          }} options={MODALITES_RATION} /></Field>
        <Field label="Activité par défaut" hint="Facultatif — présélectionne cette ration pour l'activité au PDD">
          <Select value={f.activityTag||""} onChange={e=>u("activityTag",e.target.value)} empty="— toutes —"
            options={activites.map(a=>[a.tag, `${a.tag} — ${a.name}`])} /></Field>
      </div>
      <Field label="Convention (libellé)" hint="Réutilisez le même libellé pour toutes les denrées d'une ration composée">
        <Input list="mems-ration-labels" value={f.label||""} onChange={e=>u("label",e.target.value)}
          placeholder="GD standard, Espèces FFA 2024, Stunting FEFA 2023…" />
        <datalist id="mems-ration-labels">{(labels||[]).map(l=><option key={l} value={l} />)}</datalist>
      </Field>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label={cbt ? "Denrée / instrument (CBT)" : "Denrée"}>
          {creation.trim() || creation===" " ? (
            <div className="flex items-center gap-1.5">
              <Input autoFocus value={creation.trim()} onChange={e=>setCreation(e.target.value)}
                placeholder="Nom de la nouvelle denrée" onKeyDown={e=>e.key==="Enter"&&validerCreation()} />
              <Btn size="sm" onClick={validerCreation} disabled={!creation.trim()}>Créer</Btn>
              <Btn size="sm" kind="ghost" onClick={()=>setCreation("")}>×</Btn>
            </div>
          ) : (
            <Select value={f.commodity||""} onChange={e=>choisirDenree(e.target.value)} empty="— choisir —"
              options={[...denreesFiltrees.map(d=>[d.code, d.label]), ["__new__", cbt?"➕ Créer un instrument CBT…":"➕ Créer une denrée…"]]} />
          )}
        </Field>
        <Field label={cbt ? "Montant (Ar / personne / jour)" : "Grammage (g / personne / jour)"}>
          <Input type="number" min="0" step={cbt?"1":"1"} value={f.grams??0}
            onChange={e=>u("grams",n(e.target.value))} /></Field>
      </div>
      <Field label="Note" hint="Jours typiques, date de la convention — ce qui la rend relisible">
        <Input value={f.note||""} onChange={e=>u("note",e.target.value)}
          placeholder={cbt ? "30 j. 120 000 Ar/ménage (2024)." : "30 j (demi : 15). Convention 2024."} /></Field>
      <Field label="Ordre d'affichage"><Input type="number" min="0" step="1" value={f.sort??0}
        onChange={e=>u("sort",Math.max(0,n(e.target.value)))} className="w-28" /></Field>

      {/* ── Test de calcul (partie de l'userform demandée) ── */}
      <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
        <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Test de calcul</div>
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Jours" className="mb-0"><Input type="number" min="0" step="1" value={tJours}
            onChange={e=>setTJours(Math.max(0,n(e.target.value)))} className="w-20" /></Field>
          <Field label="Effectif" className="mb-0"><Input type="number" min="0" step="1" value={tEff}
            onChange={e=>setTEff(Math.max(0,n(e.target.value)))} className="w-28" /></Field>
          <div className="pb-1.5 f125 text-slate-700">
            {q>0 ? <>
              <span className="text-slate-500">{fmt(q)} {uniteRation(mod)} × {fmt(tJours)} j × {fmt(tEff)} pers = </span>
              <b className="text-slate-900">{cbt
                ? `${fmt(Math.round(resultat))} Ar`
                : `${r2(resultat)} t (${fmt(Math.round(resultat*1000))} kg)`}</b>
            </> : <span className="text-slate-400">Saisissez une quantité pour voir le résultat.</span>}
          </div>
        </div>
      </div>
    </Modal>);
}

/* ══════════════════ Sources de données (ODK Central + Connecteurs, réunis) ══════════════════
   « L'onglet ODK Central est le même que les sources. » Il l'était de fait : deux
   entrées de menu pour une seule idée — d'où viennent les données. On les réunit
   sous un seul sujet, avec un aiguillage en haut entre les deux mécanismes qui
   restent, eux, distincts côté serveur : les connecteurs (déclarer où lire, mettre
   les variables en face des champs MEMS) et le tirage ODK Central (son cache et son
   écran de correspondance propres). Une seule porte, deux ateliers derrière. */
function SetSources({ db, set, notify, can, reload, depart }){
  const [vue,setVue] = useState(depart === "odk" ? "odk" : "connectors");
  const onglets = [["connectors","Connecteurs"], ["odk","ODK Central"]];
  return (
    <div className="space-y-4">
      {/* Aiguillage segmenté : même geste que les pastilles de sous-navigation
          des autres écrans, mais à deux positions seulement — inutile d'un rail. */}
      <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {onglets.map(([cle,label])=>(
          <button key={cle} onClick={()=>setVue(cle)}
            className={clsx("px-4 py-1.5 f125 rounded-md font-semibold transition-colors",
              vue===cle ? "bg-white shadow-sm c-bd" : "text-slate-500 hover:text-slate-800")}>
            {label}</button>))}
      </div>
      {vue==="connectors"
        ? <SetConnectors notify={notify} can={can} />
        : <SetOdk db={db} set={set} notify={notify} can={can} reload={reload} />}
    </div>);
}

/* ── ODK Central ── */
function SetOdk({ db, set, notify, can, reload }){
  const [edit,setEdit] = useState(null);
  const [pulling,setPulling] = useState(null);
  const s = db.settings; const u=(k,v)=>set(d=>{ d.settings[k]=v; return d; });
  const save = (f) => { set(d => { const i=d.odkForms.findIndex(x=>x.id===f.id);
      if(i>=0) d.odkForms[i]=f; else d.odkForms.push({ ...f, id:uid("f"), records:0, last:"", rows:[] }); return d; });
    setEdit(null); notify("Source enregistrée","ok"); };
  const [epreuve,setEpreuve] = useState(null);
  const pull = async (f) => {
    setPulling(f.id);
    try{
      const r = await api.post(`/odk-forms/${f.id}/pull`);
      notify(r.avertissement || `${r.records} soumission(s) tirée(s) d'ODK Central`, r.avertissement ? "warn" : "ok");
      if(reload) await reload();
    }catch(e){ notify(e.message || "tirage impossible", "err"); }
    setPulling(null);
  };
  /* L'épreuve réelle, à la place du bouton décoratif d'avant : c'est le serveur
     qui sort, avec le justificatif de LA SOURCE — le navigateur n'a rien à
     présenter et n'aurait de toute façon pas le droit de joindre ODK Central
     depuis une autre origine. */
  const tester = async (f) => {
    setPulling(f.id);
    try{ setEpreuve(await api.odkFormTest(f.id)); }
    catch(e){ notify(e.message || "épreuve impossible", "err"); }
    setPulling(null);
  };
  return (
    <>
      <Aide tone="tool" titre="Comment sont lues les sources ODK ?"><b>Adresse d'appel.</b> Un formulaire ODK Central est lu à l'adresse
        <code className="bg-white px-1.5 py-0.5 rounded mx-1 f115">{s.odkBase}/v1/projects/&#123;projet&#125;/forms/&#123;formulaire&#125;.svc/Submissions</code>
        avec un justificatif dans l'en-tête d'autorisation. Chaque source déclare le type de données qu'elle
        apporte, le champ qui identifie le site, et peut recevoir son XLSForm pour restituer les libellés des
        questions à la place des noms techniques. Le bouton <RefreshCw size={11} className="inline align-text-top" /> tire
        les soumissions réelles depuis le serveur : il exige un <b>justificatif propre à cette source</b>,
        chiffré côté serveur, qu'aucune autre source n'emprunte.</Aide>
      {!can("admin") && <Note tone="warn">La configuration des sources ODK Central est réservée aux
        administrateurs : cet écran est ici en lecture seule.</Note>}
      <div className="grid gap-4" style={{gridTemplateColumns:"340px 1fr"}}>
        <Card title="Serveur">
          <Field label="Adresse du serveur"><Input value={s.odkBase} onChange={e=>u("odkBase",e.target.value)} placeholder="https://odk-central.example.org" /></Field>
          {/* Le « Jeton général » a été retiré, et son retrait est le correctif.
              Il ne servait à RIEN : le serveur refuse que `odkToken` l'atteigne
              (routes/collections.js, `PUT /settings`), aucune source ne s'en sert
              pour tirer, et rien ne le conserve d'une session à l'autre. Il
              n'était pas non plus, comme son indication l'a successivement promis,
              « repris par les sources qui n'en ont pas » ni « gardé dans ce
              navigateur » : la file de synchronisation POSTe l'objet `settings`
              entier, ce jeton compris, 900 ms après chaque frappe — il traversait
              donc bien le réseau, et tout journal de mandataire en amont, avant
              d'être jeté à l'arrivée. Un champ qui ne fait rien et dont l'écran
              explique de travers ce qu'il ne fait pas se supprime. */}
          <Field label="Identifiant de projet par défaut"><Input value={s.odkProject||""} onChange={e=>u("odkProject",e.target.value)} placeholder="1" /></Field>
          <Field label="Chemin d'ouverture de session"
            hint="Laisser vide pour /v1/sessions — à ajuster si votre instance diffère">
            <Input value={s.odkCheminSession||""} onChange={e=>u("odkCheminSession",e.target.value)} placeholder="/v1/sessions" /></Field>
          <Field label="Chemin d'épreuve du justificatif"
            hint="Laisser vide pour /v1/users/current : le point d'entrée qui valide un compte sans lire de données">
            <Input value={s.odkCheminEpreuve||""} onChange={e=>u("odkCheminEpreuve",e.target.value)} placeholder="/v1/users/current" /></Field>
        </Card>
        {/* Toutes les actions de cette carte sont gardées par `admin`, et non par
            `edit`, parce que c'est ce que le serveur exige : la collection
            `odkForms` est déclarée en `cap:"admin"` (routes/collections.js), le
            tirage et l'épreuve de connexion sont sous `requireCap("admin")`. Un
            éditeur voyait donc les boutons, et ne récoltait que des 403 — ce que
            le dépôt refuse explicitement ailleurs : proposer l'interrupteur pour
            le voir revenir en erreur apprend à l'utilisateur que l'écran ment. */}
        <Card flush title="Sources de données" subtitle={`${db.odkForms.length} formulaires déclarés`}
          right={can("admin") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ name:"", formId:"", project:s.odkProject||"",
            token:"", authSchema:"porteur", authIdentifiant:"", kind:"process", tag:"", siteField:"",
            dateField:"", labels:{}, xlsform:null })}>Nouvelle source</Btn>}>
          <TableWrap max="mh440">
            <thead><tr><Th>Formulaire</Th><Th>Projet / ID</Th><Th>Type de données</Th><Th>Activité</Th>
              <Th>Champ site</Th><Th>Justificatif</Th><Th>XLSForm</Th><Th num>Enreg.</Th><Th>Dernier tirage</Th><Th /></tr></thead>
            <tbody>{db.odkForms.map(f=>(
              <tr key={f.id} className="hover:bg-sky-50">
                <Td className="font-medium">{f.name}</Td>
                <Td className="f115 text-slate-500">{f.project||"—"} / {f.formId}</Td>
                <Td><Badge tone="b">{ {process:"Suivi de processus", output:"Output", outcome:"Outcome", sites:"Registre des sites"}[f.kind] }</Badge></Td>
                <Td>{f.tag ? <Badge>{f.tag}</Badge> : <span className="text-slate-400">—</span>}</Td>
                <Td className="f115">{f.siteField || <span className="text-amber-700">à définir</span>}</Td>
                {/* Ce badge se lisait sur `f.token || s.odkToken` : `s.odkToken`
                    n'est employé par personne, il affichait donc « présent » pour
                    une source qui n'avait rien, et le tirage échouait aussitôt
                    après. Il lit maintenant ce que le SERVEUR dit détenir —
                    complété de ce qui vient d'être saisi dans cette session, sans
                    quoi une source dont on vient d'enregistrer le justificatif
                    resterait affichée « manquant », en rouge, jusqu'au prochain
                    rechargement complet de l'état. */}
                <Td>{(f.hasToken || !!f.token)
                  ? <Badge tone="g">{nomSchemaAuth(db, f.authSchema)}</Badge>
                  : <Badge tone="r">manquant</Badge>}</Td>
                <Td>{f.xlsform ? <Badge tone="g">{Object.keys(f.labels||{}).length} libellés</Badge> : <Badge>non joint</Badge>}</Td>
                <Td num>{fmt(f.records)}</Td>
                <Td className="f115 text-slate-500">{f.last ? new Date(f.last).toLocaleString("fr-FR") : "jamais"}</Td>
                <Td className="text-right whitespace-nowrap">
                  {can("admin") && <button title="Éprouver la connexion à cette source" disabled={pulling===f.id}
                    onClick={()=>tester(f)} className="text-slate-400 hover:text-sky-600 p-1 disabled:opacity-40">
                    <Link2 size={13} /></button>}
                  {can("admin") && <button title="Tirer les soumissions depuis ODK Central" disabled={pulling===f.id}
                    onClick={()=>pull(f)} className="text-slate-400 hover:text-sky-600 p-1 disabled:opacity-40">
                    <RefreshCw size={13} className={pulling===f.id?"animate-spin":""} /></button>}
                  {can("admin") && <button onClick={()=>setEdit(f)} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
                  {can("admin") && <button onClick={()=>set(d=>{ d.odkForms=d.odkForms.filter(x=>x.id!==f.id); return d; })}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </Card>
      </div>
      <Epreuve resultat={epreuve} causes={db.causesAuth} onClose={()=>setEpreuve(null)} />
      <OdkModal open={!!edit} form={edit} db={db} onClose={()=>setEdit(null)} onSave={save} notify={notify} />
    </>);
}

/* Le libellé d'un schéma, tel que le serveur l'a déclaré. Aucune table de
   correspondance dans le navigateur : la clé inconnue est rendue telle quelle
   plutôt que traduite au jugé. */
const nomSchemaAuth = (db, cle) =>
  (db?.schemasAuth || []).find(x => x.cle === (cle || "porteur"))?.libelle || cle || "présent";

/* ── Le résultat d'une épreuve de connexion ───────────────────────────
   Ce que l'administrateur doit pouvoir lire sans nous appeler : ce qui a été
   joint, sous quel schéma, ce que la source a répondu, et laquelle des causes
   nommées s'applique. Le secret n'y figure pas — au plus sa présence et sa
   longueur, ce qui suffit à voir un copier-coller tronqué.

   `causes` est la taxonomie servie par le serveur (`causesAuth`), pas une table
   recopiée ici : une cause ajoutée côté serveur s'affiche alors avec son libellé,
   au lieu de sortir en code brut sous les yeux de l'administrateur. */
function Epreuve({ resultat, causes, onClose }){
  if(!resultat) return null;
  const etapes = resultat.etapes || [];
  /* Trois issues, et non deux. Une étape peut réussir sans rien prouver du
     justificatif — un 404, ou un point d'entrée qui n'exige aucune
     authentification —, et le serveur le dit par `verdict`. Le bandeau se lisait
     sur le seul `ok` : il affichait « la source n'a pas accepté l'appel » en rouge
     au-dessus d'un texte qui affirmait le contraire, et l'administrateur ne
     pouvait pas trancher entre les deux. */
  const echec = etapes.some(e => !e.ok);
  const sansVerdict = etapes.some(e => e.verdict === "indetermine");
  const tone = echec ? (etapes.some(e => e.cause) ? "err" : "warn") : (sansVerdict ? "warn" : "ok");
  const bandeau = echec
    ? (etapes.some(e => e.cause)
        ? "La source n'a pas accepté l'appel. Le détail ci-dessous dit à quelle étape et pourquoi."
        : "L'épreuve n'a pas abouti, mais le justificatif n'est pas en cause. Le détail dit ce qui l'a arrêtée.")
    : (sansVerdict
        ? "La source répond, mais l'épreuve ne prouve pas que le justificatif soit bon : lisez le détail."
        : "La source répond et accepte le justificatif enregistré.");
  return (
    <Modal open wide onClose={onClose} title="Épreuve de connexion"
      subtitle={resultat.source?.name || resultat.connecteur?.name || ""}
      footer={<Btn kind="sec" onClick={onClose}>Fermer</Btn>}>
      <Note tone={tone}>{bandeau}</Note>
      {etapes.map((e,i)=>(
        <div key={i} className="border border-slate-200 rounded p-3 mb-3">
          <div className="flex items-center gap-2 mb-2">
            <Badge tone={e.ok ? (e.verdict === "indetermine" ? "y" : "g") : (e.cause ? "r" : "y")}>
              {e.etape === "formulaire" ? "Accès au formulaire" : "Justificatif"}</Badge>
            {e.cause && <Badge tone="y">{(causes||{})[e.cause] || e.cause}</Badge>}
            {e.code_http && <Badge tone="b">HTTP {e.code_http}</Badge>}
          </div>
          <p className="f125 text-slate-700 leading-relaxed mb-2">{e.message}</p>
          <div className="f11 text-slate-500">
            Schéma employé : <b>{e.schema_libelle || e.schema_employe}</b> (mot-clé « {e.mot_cle} ») —
            hôte {e.hote_verifie ? "vérifié" : "refusé"}, source {e.joignable ? "jointe" : "non jointe"} —
            justificatif {!e.indices?.present ? "absent"
              : e.indices.lisible === false ? "enregistré, mais illisible"
              : `enregistré, ${e.indices.longueur} caractères`}.
            {e.session && (e.session.echec_motif
              ? <> Dernier renouvellement en échec : {e.session.echec_motif}.</>
              : e.session.ouverte
                ? <> Session ouverte{e.session.expire_le ? `, valable jusqu'au ${new Date(e.session.expire_le).toLocaleString("fr-FR")}` : " (sans expiration annoncée)"}.</>
                : null)}
          </div>
        </div>))}
    </Modal>);
}

/* Les champs qu'un schéma réclame, tels qu'il les déclare côté serveur. L'écran
   ne sait pas ce qu'est « basique » ni « session ODK » : il lit la table. C'est
   ce qui permet d'ajouter un schéma sans revenir ici. */
function ChampsAuth({ db, schema, valeurs, onChange, hasSecret }){
  const def = (db?.schemasAuth || []).find(x => x.cle === (schema || "porteur"));
  if(!def) return null;
  return (
    <>
      {def.champs.map(c => (
        <Field key={c.cle} label={c.label}
          hint={c.cle === "justificatif" && hasSecret
            ? "Un justificatif est déjà enregistré, chiffré. Laissez vide pour le conserver."
            : c.masque ? "Chiffré au repos, jamais renvoyé par l'API" : null}>
          <Input type={c.masque ? "password" : "text"}
            value={valeurs[c.cle] || ""} onChange={e=>onChange(c.cle, e.target.value)} />
        </Field>))}
      <Note tone="info"><b>Où trouver ce justificatif.</b> {def.ou_trouver} {def.note}</Note>
    </>);
}
function OdkModal({ open, form, db, onClose, onSave, notify }){
  const [f,setF] = useState({}); const [busy,setBusy] = useState(false);
  useEffect(()=>{ setF(form ? { ...form, labels:{ ...(form.labels||{}) } } : {}); },[form]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const url = `${db.settings.odkBase}/v1/projects/${f.project||"{projet}"}/forms/${f.formId||"{formulaire}"}.svc/Submissions`;
  /* Les colonnes du dernier tirage, servies par /api/state (`champs`). Elles se
     lisaient auparavant dans `rows[0]`, ce qui obligeait l'état initial à
     transporter les 20 000 lignes du formulaire pour n'en regarder que les clés
     de la première. */
  const fields = f.champs || [];
  const attachXls = async (file) => {
    setBusy(true);
    try{
      let labels = {};
      if(/\.(xlsx|xls)$/i.test(file.name)){
        /* Lecture côté serveur : le navigateur n'embarque plus de lecteur de
           classeurs. Le serveur renvoie aussi le type de chaque variable et un
           aperçu des listes de choix, ce que la lecture locale ne donnait pas. */
        const r = await api.xlsformParse(file);
        labels = r.labels || {};
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
        {/* Le schéma d'authentification pilote les champs demandés juste en
            dessous. La liste vient du serveur (GET /api/state), l'écran n'en tient
            aucune copie : ajouter un schéma ne se répercute pas ici. */}
        <Field label="Schéma d'authentification" className="col-span-2">
          <Select value={f.authSchema||"porteur"} onChange={e=>u("authSchema",e.target.value)}
            options={(db.schemasAuth||[]).map(x=>[x.cle, x.libelle])} /></Field>
        <div className="col-span-3">
          <ChampsAuth db={db} schema={f.authSchema||"porteur"} hasSecret={!!f.hasToken}
            valeurs={{ justificatif:f.token||"", identifiant:f.authIdentifiant||"" }}
            onChange={(cle,v)=>u(cle==="justificatif" ? "token" : "authIdentifiant", v)} />
        </div>
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

/* ══════════════════ Connecteurs et correspondance des variables ══════════════════

   Cet écran répond mot pour mot à la demande : « à chaque liaison, mets en place
   un système de mapping des variables pour correspondre à ceux utilisés par MEMS,
   et ainsi on ne se perd pas à recoder à chaque fois. » Brancher une source ne
   demande plus d'écrire du code : on déclare où lire, on met les variables en
   face des champs MEMS, on vérifie sur de vraies lignes, on enregistre.

   Un point de méthode, qui explique la forme de tout le fichier : la liste des
   entités, celle de leurs champs et celle des transformations viennent du serveur
   (GET /api/connectors/champs) et ne sont écrites NULLE PART ici. C'est le même
   registre que celui contre lequel l'enregistrement est validé. Une copie locale
   afficherait tôt ou tard des champs que le serveur refuse — le genre d'écart
   qu'on ne découvre qu'au moment d'enregistrer, après avoir tout saisi. */

const NATURES_CONNECTEUR = [
  ["odk","ODK Central"], ["kobo","KoboToolbox"], ["foundry","Palantir Foundry"],
  ["csv","Fichier ou données collées"], ["http","API HTTP (JSON ou CSV)"]];
const NOM_NATURE = Object.fromEntries(NATURES_CONNECTEUR);
/* Les natures qui vont chercher la donnée par le réseau, donc les seules qu'une
   épreuve de connexion puisse éprouver. Le serveur applique la même règle et
   refuse les autres : cette constante ne fait que masquer un bouton inutile. */
const RESEAU_CONNECTEUR = new Set(["odk","kobo","foundry","http"]);
/* Les natures que le SERVEUR sait aller lire tout seul — celles pour lesquelles,
   l'épreuve passée, on peut découvrir les colonnes et pré-remplir la table sans
   rien coller. Doit rester le miroir de NATURES_LUES côté serveur : « odk » en
   est dehors (son tirage a son propre écran et son cache). */
const LUES_CONNECTEUR = new Set(["foundry","kobo","http"]);

/* Ni `db` ni `set` : cet écran ne passe pas par l'état global. Les connecteurs
   ont leurs propres routes, et les faire transiter par la file de synchronisation
   des collections exposerait le jeton au navigateur de chaque utilisateur. */
function SetConnectors({ notify, can }){
  const [registre,setRegistre] = useState(null);   /* { entites, transformations } — servi par le serveur */
  const [rows,setRows]         = useState(null);
  const [offices,setOffices]   = useState([]);
  const [sel,setSel]           = useState("");
  const [edit,setEdit]         = useState(null);
  const [entity,setEntity]     = useState("");
  const [lignes,setLignes]     = useState({});     /* champ MEMS → correspondance en cours de saisie */
  const [vars,setVars]         = useState([]);     /* variables d'un XLSForm téléversé */
  const [ech,setEch]           = useState("");     /* échantillon collé, en JSON */
  const [apercu,setApercu]     = useState(null);
  const [epreuve,setEpreuve]   = useState(null);   /* diagnostic de « tester cette source » */
  const [busy,setBusy]         = useState(false);
  /* Correspondances pré-remplies par le peuplement automatique, en attente que le
     connecteur fraîchement enregistré soit sélectionné. Un ref et non un état :
     l'effet de chargement des correspondances les fusionne au vol, sans re-render
     supplémentaire ni course avec le setLignes qui suit setSel. */
  const autoFill = useRef(null);   /* { id, entity, lignes } */

  const tester = async (c) => {
    setBusy(true);
    try{ setEpreuve(await api.connectorTest(c.id)); }
    catch(e){ notify(e.message,"err"); }
    setBusy(false);
  };

  const charger = () => api.connectors().then(r=>setRows(r.rows||[]))
    .catch(e=>{ notify(e.message,"err"); setRows([]); });

  /* Pré-crée les 5 connecteurs MoDa (un par activité). L'admin n'a plus qu'à
     ouvrir chacun, saisir le numéro de formulaire et le jeton : le rattachement à
     l'activité (config.activityTag) est déjà fait. */
  const preparerModa = async () => {
    try{ const r = await api.preparerConnecteursModa();
      const rows2 = r.connectors || []; if(rows2.length) setRows(rows2); else await charger();
      notify(r.crees?.length
        ? `${r.crees.length} connecteur(s) MoDa créé(s) — ouvrez chacun pour saisir le numéro du formulaire et le jeton`
        : "Les 5 connecteurs MoDa existent déjà", "ok");
    }catch(e){ notify(e.message, "err"); }
  };

  useEffect(()=>{
    api.connectorChamps()
      .then(r=>{ setRegistre(r); setEntity(p=>p || r.entites?.[0]?.cle || ""); })
      .catch(e=>{ notify(e.message,"err"); setRegistre({ entites:[], transformations:[] }); });
    charger();
    api.offices().then(r=>setOffices(r.offices||[])).catch(()=>{});
  },[]);

  const conn = (rows||[]).find(x=>x.id===sel) || null;
  const ent  = (registre?.entites||[]).find(e=>e.cle===entity) || null;

  /* Charge les correspondances enregistrées pour (connecteur, entité), puis
     fusionne le peuplement automatique en attente. Extraite de l'effet pour être
     rejouable à la main : réenregistrer le connecteur DÉJÀ sélectionné ne change
     pas `sel`, donc l'effet ne se redéclenche pas — il faut alors l'appeler. */
  const chargerMappings = (id, ent) => {
    setApercu(null);
    if(!id || !ent){ setLignes({}); return Promise.resolve(); }
    return api.connectorMappings(id, ent).then(r=>{
      const m = {};
      for(const x of r.rows||[]) m[x.mems_field] = { source_path:x.source_path||"",
        transform:x.transform||"brut", required:!!x.required, default_value:x.default_value||"" };
      /* Peuplement automatique après enregistrement : les propositions ne
         garnissent que les champs ENCORE VIDES — jamais par-dessus une
         correspondance déjà déclarée, qu'un rapprochement de noms n'a pas à
         écraser. Elles portent leur score, pour que chaque ligne se relise. */
      if(autoFill.current && autoFill.current.id===id && autoFill.current.entity===ent){
        for(const [f,v] of Object.entries(autoFill.current.lignes))
          if(!m[f]?.source_path) m[f] = v;
        autoFill.current = null;
      }
      setLignes(m);
    }).catch(e=>notify(e.message,"err"));
  };
  useEffect(()=>{ chargerMappings(sel, entity); },[sel,entity]);

  /* L'échantillon collé sert deux fois : à proposer des correspondances, et à
     montrer l'aperçu. Une saisie encore incomplète ne doit pas crier à l'erreur :
     on signale seulement, sans bloquer. */
  const echantillon = useMemo(()=>{
    if(!ech.trim()) return [];
    try{ const p = JSON.parse(ech); const a = Array.isArray(p) ? p : [p];
      return a.filter(x => x && typeof x === "object" && !Array.isArray(x)); }
    catch(e){ return []; }
  },[ech]);
  const echIllisible = !!ech.trim() && !echantillon.length;
  const clesEch = useMemo(()=>[...new Set(echantillon.flatMap(x=>Object.keys(x)))],[echantillon]);

  /* Les variables proposées dans les listes déroulantes : celles du XLSForm quand
     il a été joint, sinon les clés de l'échantillon. Les lignes de structure du
     XLSForm (begin_group, note, calculate) sont écartées — ce ne sont pas des
     questions, et les laisser remonter fait proposer un groupe comme champ site. */
  const variablesSource = useMemo(()=>
    vars.length ? vars.filter(v=>!v.structure) : clesEch.map(k=>({ name:k, type:"", label:"" })),
    [vars, clesEch]);

  /* Toute modification périme l'aperçu : le laisser affiché ferait lire des
     valeurs produites par une correspondance qui n'est plus celle de l'écran. */
  const maj = (champ, patch) => { setApercu(null);
    setLignes(p=>({ ...p, [champ]: { source_path:"", transform:"brut",
      required:false, default_value:"", ...(p[champ]||{}), ...patch } })); };
  /* Changer la variable à la main efface le score de la proposition : il portait
     sur l'ancienne variable, l'afficher encore serait un mensonge poli. */
  const majSource = (champ, v) => maj(champ, { source_path:v, score:undefined, motif:undefined });

  /* Seules les lignes réellement renseignées partent : une ligne vide n'est pas une
     correspondance, et l'enregistrer encombrerait la table sans rien décrire. */
  const aEnvoyer = () => Object.entries(lignes)
    .filter(([,v]) => (v.source_path||"").trim() || (v.default_value||"").trim())
    .map(([champ,v],i) => ({ entity, mems_field:champ, source_path:(v.source_path||"").trim()||null,
      transform:v.transform||"brut", required:!!v.required,
      default_value:(v.default_value||"").trim()||null, position:i }));

  const joindreXlsform = async (file) => {
    setBusy(true);
    try{
      const r = await api.xlsformParse(file);
      setVars(r.vars||[]);
      notify(`${(r.vars||[]).filter(v=>!v.structure).length} variables lues dans ${file.name}`,"ok");
    }catch(e){ notify("Lecture du XLSForm impossible : "+e.message,"err"); }
    setBusy(false);
  };

  const proposer = async () => {
    if(!variablesSource.length){ notify("Joignez le XLSForm ou collez un échantillon avant de proposer","warn"); return; }
    setBusy(true);
    try{
      const r = await api.connectorSuggestions(sel, { entity,
        ...(vars.length ? { variables: vars.map(v=>({ name:v.name, type:v.type||"",
            label:v.label||"", structure:!!v.structure })) } : { cles: clesEch }) });
      setLignes(p=>{
        const m = { ...p };
        for(const s of r.suggestions||[]){
          if(!s.source_path) continue;
          m[s.mems_field] = { source_path:s.source_path, transform:s.transform,
            required:m[s.mems_field]?.required||false, default_value:m[s.mems_field]?.default_value||"",
            score:s.score, motif:s.motif };
        }
        return m;
      });
      /* Un avertissement, pas une confirmation : rien n'est enregistré, et un
         rapprochement de noms se vérifie. Une proposition acceptée sans regarder
         est exactement la façon dont « planned » finit par alimenter « atteints ». */
      notify("Propositions remplies — vérifiez chaque ligne, puis enregistrez","warn");
    }catch(e){ notify(e.message,"err"); }
    setBusy(false);
  };

  const voirApercu = async () => {
    setBusy(true);
    try{
      const corps = { entity, mappings: aEnvoyer(), limite:5 };
      if(echantillon.length) corps.echantillon = echantillon.slice(0,5);
      const r = await api.connectorApercu(sel, corps);
      setApercu(r);
      if(!r.ok) notify(`${r.manquants.length} champ(s) obligatoire(s) sans valeur : cette correspondance ne passera pas`,"warn");
    }catch(e){ notify(e.message,"err"); setApercu(null); }
    setBusy(false);
  };

  const enregistrer = async () => {
    setBusy(true);
    try{
      const r = await api.saveConnectorMappings(sel, entity, aEnvoyer());
      notify(`${r.enregistrees} correspondance(s) enregistrée(s)`,"ok");
      await charger();
    }catch(e){ notify(e.message + (e.details ? " — " + e.details.map(d=>d.message).join(" ; ") : ""),"err"); }
    setBusy(false);
  };

  const supprimer = async (c) => {
    if(!confirm(`Supprimer « ${c.name} » et ses ${c.mappings} correspondance(s) ?`)) return;
    try{ await api.deleteConnector(c.id); if(sel===c.id) setSel(""); await charger();
      notify("Connecteur supprimé","ok"); }
    catch(e){ notify(e.message,"err"); }
  };

  const enregistrerConnecteur = async (f) => {
    setBusy(true);
    const payload = { name:(f.name||"").trim(), kind:f.kind||"csv",
      base_url:(f.base_url||"").trim()||null, config:f.config||{},
      auth_schema:f.auth_schema||"porteur",
      auth_identifiant:(f.auth_identifiant||"").trim()||null,
      office_id:f.office_id||null, active:f.active!==false };
    /* Le secret n'est envoyé que s'il a été saisi : laissé vide, celui qui est
       déjà chiffré en base est conservé — le serveur ne le renvoie jamais, on ne
       pourrait donc pas le réémettre à chaque modification. L'identifiant, lui,
       n'est pas un secret : il part à chaque fois, sinon l'effacer serait impossible. */
    if((f.secret||"").trim()) payload.secret = f.secret.trim();
    if(f.id) payload.rev = f.rev;
    let c2;
    try{
      const r = f.id ? await api.updateConnector(f.id, payload) : await api.createConnector(payload);
      c2 = r.connector;
      setEdit(null); await charger();
    }catch(e){ notify(e.message,"err"); setBusy(false); return; }

    /* « Quand on l'enregistre, tester d'abord la connexion et, si ok, peupler
       automatiquement la table de correspondance. » L'enchaînement littéral :
       enregistrer → éprouver → lire les colonnes → proposer. Chaque étape peut
       échouer sans compromettre la précédente — le connecteur, lui, est écrit. */
    if(!RESEAU_CONNECTEUR.has(c2.kind)){
      setSel(c2.id); notify("Connecteur enregistré","ok"); setBusy(false); return;
    }
    let ep;
    try{ ep = await api.connectorTest(c2.id); setEpreuve(ep); }
    catch(e){ setSel(c2.id); notify("Connecteur enregistré. Épreuve de connexion impossible : "+e.message,"warn");
      setBusy(false); return; }
    if(!ep.ok){
      setSel(c2.id);
      notify("Connecteur enregistré — la connexion n'a pas abouti. Voir le détail de l'épreuve.","warn");
      setBusy(false); return;
    }
    /* Connexion prouvée. Pour les natures que le serveur sait lire, on découvre
       les colonnes et on pré-remplit la table via l'appariement de noms — sans
       coller quoi que ce soit. Les autres (ODK) : test seul, l'écran attend leur
       XLSForm. */
    if(!LUES_CONNECTEUR.has(c2.kind)){
      setSel(c2.id); notify("Connexion réussie. Joignez le XLSForm pour proposer les correspondances.","ok");
      setBusy(false); return;
    }
    try{
      const rv = await api.connectorVariables(c2.id);
      const cles = (rv.variables||[]).map(v=>v.name);
      if(!cles.length){
        setSel(c2.id); notify("Connexion réussie, mais la source n'a renvoyé aucune colonne à rapprocher.","warn");
        setBusy(false); return;
      }
      /* L'échantillon lu alimente les listes déroulantes et l'aperçu, et les
         suggestions garnissent la table. On passe par le ref pour survivre au
         rechargement des correspondances déclenché par setSel. */
      if(rv.lignes?.length) setEch(JSON.stringify(rv.lignes));
      setVars([]);
      const rs = await api.connectorSuggestions(c2.id, { entity, cles });
      const lignesProposees = {};
      for(const s of rs.suggestions||[]){
        if(!s.source_path) continue;
        lignesProposees[s.mems_field] = { source_path:s.source_path, transform:s.transform,
          required:false, default_value:"", score:s.score, motif:s.motif };
      }
      autoFill.current = { id:c2.id, entity, lignes:lignesProposees };
      /* Si le connecteur était DÉJÀ sélectionné, changer `sel` pour la même
         valeur ne redéclenche pas l'effet : on applique la fusion à la main. */
      if(sel===c2.id) await chargerMappings(c2.id, entity); else setSel(c2.id);
      const n = Object.keys(lignesProposees).length;
      notify(n
        ? `Connexion réussie — ${n} correspondance(s) pré-remplie(s) depuis ${rv.lignesLues} ligne(s). `
          + "Vérifiez chaque ligne, puis Enregistrer."
        : "Connexion réussie, mais aucun nom de colonne ne s'est rapproché d'un champ MEMS : à faire à la main.",
        n ? "ok" : "warn");
    }catch(e){
      setSel(c2.id);
      notify("Connexion réussie, mais la lecture des variables a échoué : "+e.message,"warn");
    }
    setBusy(false);
  };

  if(registre === null || rows === null) return <Empty icon={Link2} title="Chargement des connecteurs…" />;

  const transformations = registre.transformations || [];
  const apres0 = apercu?.lignes?.[0]?.apres || null;

  /* La liste des connecteurs devient la sous-navigation EN HAUT (pastilles),
     comme les autres écrans ; le connecteur choisi et sa table de correspondance
     s'affichent EN DESSOUS. Les actions propres à une source (éprouver, modifier,
     supprimer) suivent la sélection dans la barre d'actions du détail. */
  const railGroups = [{
    label: "Sources",
    items: rows.map(c => ({ value:c.id, label:c.name, count:c.mappings || 0 })),
  }];

  return (
    <>
      <Aide tone="tool" titre="Comment marchent les connecteurs ?">
        <b>Une correspondance, pas du code.</b> Un connecteur dit <b>où</b> lire ; les correspondances
        disent <b>quelle variable de la source alimente quel champ MEMS</b>, et par quelle transformation.
        À l'<b>enregistrement d'une source réseau</b>, MEMS <b>éprouve d'abord la connexion</b> ; si elle
        passe et que la source est lisible (Foundry, Kobo, HTTP), il <b>lit ses colonnes et pré-remplit
        la table</b> tout seul. Le rapprochement de noms donne un score — il ne décide rien, chaque ligne
        se relit avant d'enregistrer. La liste des champs et celle des transformations viennent du serveur :
        c'est exactement celle contre laquelle l'enregistrement est vérifié. Le jeton d'accès est chiffré
        côté serveur et n'est jamais renvoyé.
      </Aide>
      <SideRail groups={rows.length ? railGroups : []} active={sel} onPick={setSel} right={<>
        {/* Barre d'actions : créer une source, et — si l'une est choisie — l'éprouver,
            la modifier ou la supprimer. Elle remplace les icônes par ligne de l'ancien
            volet de gauche. */}
        <div className="flex items-center gap-2 flex-wrap">
          {conn ? <div className="min-w-0">
            <span className="f13 font-semibold text-slate-800">{conn.name}</span>
            <span className="f115 text-slate-500"> · {NOM_NATURE[conn.kind]||conn.kind}
              {conn.base_url ? ` — ${conn.base_url.replace(/^https?:\/\//,"")}` : ""}</span>
            <span className="ml-2 inline-flex gap-1 align-middle">
              <Badge tone={conn.hasSecret?"g":"n"}>{conn.hasSecret ? nomSchemaAuth(registre, conn.auth_schema) : "sans justificatif"}</Badge>
              {!conn.active && <Badge tone="r">inactif</Badge>}
            </span>
          </div> : <span className="f125 text-slate-500">Choisissez une source ci-dessus, ou créez-en une.</span>}
          {can("admin") && <div className="ml-auto flex items-center gap-2">
            {conn && RESEAU_CONNECTEUR.has(conn.kind) && <Btn size="sm" kind="sec" icon={Link2}
              disabled={busy} onClick={()=>tester(conn)}>Tester</Btn>}
            {conn && <Btn size="sm" kind="sec" icon={Pencil} onClick={()=>setEdit({ ...conn, secret:"" })}>Modifier</Btn>}
            {conn && <Btn size="sm" kind="ghost" icon={Trash2} onClick={()=>supprimer(conn)}>Supprimer</Btn>}
            <Btn size="sm" kind="sec" icon={Link2} disabled={busy}
              title="Créer les 5 connecteurs MoDa (un par activité de suivi de processus)"
              onClick={preparerModa}>Préparer MoDa</Btn>
            <Btn size="sm" icon={Plus}
              onClick={()=>setEdit({ name:"", kind:"csv", base_url:"", config:{}, office_id:"", active:true, secret:"" })}>
              Nouveau</Btn>
          </div>}
        </div>

        {!conn ? (
          <Card title="Correspondance des variables">
            <Empty icon={Link2} title={rows.length ? "Choisissez un connecteur" : "Aucun connecteur"}
              text={rows.length
                ? "La table de correspondance s'affiche ici : une ligne par champ MEMS, avec en face la variable de la source."
                : "Déclarez une source — ODK Central, KoboToolbox, un dataset Foundry, un export CSV — puis mettez ses variables en face des champs MEMS."} />
          </Card>
        ) : (
          <div className="space-y-4">
            <Card title="Variables de la source" subtitle="Ce dont les listes déroulantes ci-dessous seront remplies"
              right={<div className="flex items-center gap-2">
                {!!vars.length && <Badge tone="g">{variablesSource.length} variables du XLSForm</Badge>}
                {!vars.length && !!clesEch.length && <Badge tone="b">{clesEch.length} clés de l'échantillon</Badge>}
                <label>
                  <input type="file" accept=".xlsx,.xls" className="hidden" disabled={busy}
                    onChange={e=>e.target.files[0]&&joindreXlsform(e.target.files[0])} />
                  <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer">
                    <Upload size={13} /> {busy?"Lecture…":"Joindre le XLSForm"}</span></label>
              </div>}>
              <p className="f115 text-slate-500 leading-relaxed mb-2">
                Le XLSForm est lu <b>par le serveur</b> : il en tire le nom, le type et le libellé de chaque question.
                À défaut, collez quelques enregistrements de la source en JSON — un objet ou un tableau d'objets —
                pour renseigner les listes et voir l'aperçu sur de vraies lignes.
              </p>
              <textarea value={ech} onChange={e=>setEch(e.target.value)} rows={4}
                placeholder='[{"DPName":"MG23209050001","SvyDate":"2026-03-01","HHCoord":"-23.35 43.66 12 5.2"}]'
                className={clsx(inputCls,"font-mono f115")} />
              {echIllisible && <p className="f115 text-amber-700 mt-1">
                Cet échantillon n'est pas du JSON lisible : un objet, ou un tableau d'objets.</p>}
            </Card>

            <Card flush title="Correspondance des variables"
              subtitle={ent ? ent.note : ""}
              right={<div className="flex items-center gap-2 flex-wrap">
                <Select value={entity} onChange={e=>setEntity(e.target.value)}
                  options={(registre.entites||[]).map(e=>[e.cle, e.label])} className="w-44" />
                <Btn size="sm" kind="sec" icon={Target} disabled={busy||!variablesSource.length} onClick={proposer}>
                  Proposer automatiquement</Btn>
                <Btn size="sm" kind="sec" icon={Search} disabled={busy} onClick={voirApercu}>Aperçu</Btn>
                {can("admin") && <Btn size="sm" icon={Save} disabled={busy} onClick={enregistrer}>Enregistrer</Btn>}
              </div>}>
              <TableWrap max="mh440">
                <thead><tr>
                  <Th>Champ MEMS</Th><Th>Type</Th><Th>Variable source</Th><Th>Transformation</Th>
                  <Th>Valeur par défaut</Th><Th>Aperçu</Th>
                </tr></thead>
                <tbody>
                  {(ent?.champs||[]).map(ch=>{
                    const l = lignes[ch.nom] || {};
                    const manque = (apercu?.manquants||[]).find(m=>m.champ===ch.nom);
                    return (
                      <tr key={ch.nom} className="hover:bg-sky-50 align-top">
                        <Td>
                          <div className="font-medium text-slate-800">{ch.nom}
                            {ch.obligatoire && <span className="text-rose-600 ml-1" title="Champ obligatoire">*</span>}</div>
                          <div className="f105 text-slate-500 whitespace-normal mw320">{ch.note}</div>
                        </Td>
                        <Td className="f115 text-slate-500">{ch.type}</Td>
                        <Td>
                          {variablesSource.length ? (
                            <Select value={l.source_path||""} onChange={e=>majSource(ch.nom, e.target.value)}
                              empty="—" options={variablesSource.map(v=>[v.name, v.label ? `${v.name} — ${String(v.label).slice(0,40)}` : v.name])} />
                          ) : (
                            <Input value={l.source_path||""} onChange={e=>majSource(ch.nom, e.target.value)}
                              placeholder="nom de la variable" />
                          )}
                          {l.score !== undefined && l.source_path &&
                            <div className="mt-1"><Badge tone={l.score>=0.9?"g":l.score>=0.6?"y":"r"}>
                              proposé {Math.round(l.score*100)} %</Badge></div>}
                          {l.motif && <div className="f105 text-slate-400 whitespace-normal mw320">{l.motif}</div>}
                        </Td>
                        <Td>
                          <Select value={l.transform||"brut"} onChange={e=>maj(ch.nom,{ transform:e.target.value })}
                            options={transformations.map(t=>[t.cle, t.label])} />
                        </Td>
                        <Td><Input value={l.default_value||""} onChange={e=>maj(ch.nom,{ default_value:e.target.value })}
                          placeholder="—" className="w-28" /></Td>
                        <Td className="f115">
                          {manque ? <span className="text-rose-700" title={manque.motif}>manquant</span>
                            : apres0 && apres0[ch.nom] !== undefined
                              ? <span className="text-slate-800">{String(apres0[ch.nom])}</span>
                              : <span className="text-slate-300">—</span>}
                        </Td>
                      </tr>);
                  })}
                </tbody>
              </TableWrap>
            </Card>

            {apercu && (
              <Card title="Aperçu" subtitle={`${apercu.lignesLues} ligne(s) — ${apercu.provenance}`}>
                {apercu.ok
                  ? <Note tone="ok">Tous les champs obligatoires sont alimentés sur les lignes examinées.</Note>
                  : <Note tone="err"><b>Cette correspondance ne passera pas.</b>
                      <ul className="mt-1.5 ml-4 list-disc">
                        {apercu.manquants.map(m=>(<li key={m.champ}><b>{m.champ}</b> — {m.motif}</li>))}
                      </ul></Note>}
                <TableWrap max="mh300">
                  <thead><tr><Th>#</Th><Th>Avant (source)</Th><Th>Après (MEMS)</Th></tr></thead>
                  <tbody>{apercu.lignes.map((l,i)=>(
                    <tr key={i} className="align-top">
                      <Td className="text-slate-400">{i+1}</Td>
                      <Td className="f105 font-mono text-slate-500 whitespace-normal mw420">{JSON.stringify(l.avant)}</Td>
                      <Td className="f105 font-mono text-slate-800 whitespace-normal mw420">{JSON.stringify(l.apres)}</Td>
                    </tr>))}</tbody>
                </TableWrap>
              </Card>)}
          </div>)}
      </>} />
      <Epreuve resultat={epreuve} causes={registre?.causesAuth} onClose={()=>setEpreuve(null)} />
      <ConnectorModal open={!!edit} c={edit} offices={offices} busy={busy} registre={registre}
        onClose={()=>setEdit(null)} onSave={enregistrerConnecteur} />
    </>);
}

/* La fiche d'un connecteur. Les champs de configuration dépendent de la nature de
   la source : les afficher tous ferait un formulaire dont les trois quarts ne
   servent jamais, et laisserait croire qu'un RID de dataset a un sens pour ODK. */
function ConnectorModal({ open, c, offices, busy, registre, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(c ? { ...c, config:{ ...(c.config||{}) }, secret:"" } : {}); },[c]);
  if(!open) return null;
  const u = (k,v)=>setF(p=>({ ...p, [k]:v }));
  const uc = (k,v)=>setF(p=>({ ...p, config:{ ...(p.config||{}), [k]:v } }));
  const reseau = ["odk","kobo","foundry","http"].includes(f.kind);
  /* Le même composant que pour les sources ODK, alimenté par la même table —
     servie ici par GET /api/connectors/champs, parce que cet écran ne passe pas
     par l'état global. Une seule vérité, deux portes. */
  const dbSchemas = { schemasAuth: registre?.schemasAuth || [] };
  const defAuth = (registre?.schemasAuth || []).find(x => x.cle === (f.auth_schema || "porteur"));
  return (
    <Modal open wide onClose={onClose} title={c?.id ? "Modifier le connecteur" : "Nouveau connecteur"}
      subtitle="Nature de la source, adresse, jeton et rattachement"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || !(f.name||"").trim() || (reseau && !(f.base_url||"").trim())}
          onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Nom du connecteur"><Input value={f.name||""} onChange={e=>u("name",e.target.value)}
          placeholder="Foundry — chiffres de bénéficiaires" /></Field>
        <Field label="Nature de la source"><Select value={f.kind||"csv"} onChange={e=>u("kind",e.target.value)}
          options={NATURES_CONNECTEUR} /></Field>
        {reseau && <Field label="Adresse de base" className="col-span-2"
          hint="https obligatoire, sauf hôte explicitement autorisé par l'équipe technique (CONNECTOR_ALLOWED_HOSTS)">
          <Input value={f.base_url||""} onChange={e=>u("base_url",e.target.value)}
            placeholder="https://exemple.palantirfoundry.com" /></Field>}
        <Field label="Schéma d'authentification"
          hint="Ce que la source attend dans l'en-tête. Un jeton valide présenté sous le mauvais mot-clé est refusé.">
          <Select value={f.auth_schema||"porteur"} onChange={e=>u("auth_schema",e.target.value)}
            options={(registre?.schemasAuth||[]).map(x=>[x.cle, x.libelle])} /></Field>
        <Field label="Bureau" hint="Un connecteur rattaché à un bureau n'est visible que par ce bureau">
          <Select value={f.office_id||""} onChange={e=>u("office_id",e.target.value)} empty="Tous les bureaux"
            options={offices.map(o=>[o.id, o.name])} /></Field>
        <div className="col-span-2">
          <ChampsAuth db={dbSchemas} schema={f.auth_schema||"porteur"} hasSecret={!!c?.hasSecret}
            valeurs={{ justificatif:f.secret||"", identifiant:f.auth_identifiant||"" }}
            onChange={(cle,v)=>u(cle==="justificatif" ? "secret" : "auth_identifiant", v)} />
        </div>
        {defAuth?.derive && <Field label={defAuth.chemin?.label || "Chemin d'obtention du justificatif"}
          className="col-span-2"
          hint={`Laisser vide pour ${defAuth.chemin?.defaut} — à ajuster si votre instance diffère`}>
          <Input value={f.config?.cheminAuth||""} onChange={e=>uc("cheminAuth",e.target.value)}
            placeholder={defAuth.chemin?.defaut} /></Field>}
        {/* Le chemin sur lequel « éprouver la connexion » va frapper. Le serveur
            le lisait déjà (`config.cheminEpreuve`) mais aucun champ ne permettait
            de le saisir : l'épreuve d'une source « http » ou « foundry » retombait
            donc sur le chemin de lecture, voire sur « / », c'est-à-dire souvent
            sur une page publique qui ne prouve rien. */}
        {(f.kind==="http" || f.kind==="foundry") && <Field label="Chemin d'épreuve du justificatif"
          className="col-span-2"
          hint="Un point d'entrée qui EXIGE une authentification. Laissé vide, l'épreuve appelle le chemin
                de lecture : si la source y répond aussi sans justificatif, elle le dira au lieu de conclure.">
          <Input value={f.config?.cheminEpreuve||""} onChange={e=>uc("cheminEpreuve",e.target.value)}
            placeholder="/api/v2/me" /></Field>}

        {f.kind==="foundry" && <>
          <Field label="Identifiant du jeu de données (RID)" className="col-span-2">
            <Input value={f.config?.datasetRid||""} onChange={e=>uc("datasetRid",e.target.value)}
              placeholder="ri.foundry.main.dataset.…" /></Field>
          <Field label="Branche" hint="« master » par défaut">
            <Input value={f.config?.branche||""} onChange={e=>uc("branche",e.target.value)} placeholder="master" /></Field>
          <Field label="Chemin de lecture"
            hint="Laisser vide pour /api/v2/datasets/{rid}/readTable — à ajuster si l'instance diffère">
            <Input value={f.config?.chemin||""} onChange={e=>uc("chemin",e.target.value)} /></Field>
        </>}
        {f.kind==="http" && <>
          <Field label="Chemin" hint="Ajouté à l'adresse de base">
            <Input value={f.config?.chemin||""} onChange={e=>uc("chemin",e.target.value)} placeholder="/api/v1/donnees" /></Field>
          <Field label="Pointeur vers les lignes" hint="Chemin JSON du tableau de lignes, si la réponse l'emballe">
            <Input value={f.config?.pointeur||""} onChange={e=>uc("pointeur",e.target.value)} placeholder="data.results" /></Field>
        </>}
        {f.kind==="odk" && <>
          <Field label="Projet"><Input value={f.config?.project||""} onChange={e=>uc("project",e.target.value)} placeholder="1" /></Field>
          <Field label="Identifiant du formulaire">
            <Input value={f.config?.formId||""} onChange={e=>uc("formId",e.target.value)} placeholder="MDG_GD_PREVMA_v2" /></Field>
        </>}
        {/* Kobo n'a pas de « projet » : un formulaire y est désigné par le seul uid
            de son asset (API v2), ou par son NUMÉRO (API v1, celle de la MoDa du
            PAM). L'administrateur choisit la version : une même adresse peut servir
            les deux, seul lui sait laquelle son instance honore. */}
        {f.kind==="kobo" && <>
          <Field label="Version de l'API" className="col-span-2"
            hint="MoDa (moda.wfp.org) et les instances ONA/kobocat utilisent l'API v1 ; KoboToolbox récent, l'API v2.">
            <Select value={f.config?.apiVersion||"v2"} onChange={e=>uc("apiVersion",e.target.value)}
              options={[["v1","API v1 — MoDa / ONA (numéro de formulaire)"],["v2","API v2 — KoboToolbox (uid d'asset)"]]} /></Field>
          {(f.config?.apiVersion||"v2")==="v1" ? <>
            {/* Le geste demandé, mot pour mot : coller le lien du formulaire au
                format …/api/v1/data/340943, l'adresse de base et le numéro sont
                extraits tout seuls. Reste la clé d'API (champ « justificatif »
                ci-dessus), puis « Tester » — et si ça passe, « Enregistrer ». */}
            <Field label="Coller le lien complet des données du formulaire" className="col-span-2"
              hint="Format https://moda.wfp.org/api/v1/data/340943 — l'adresse et le numéro sont extraits automatiquement">
              <Input placeholder="https://moda.wfp.org/api/v1/data/340943" onChange={e=>{
                const m = /^(https?:\/\/[^/]+)\/api\/v1\/data\/(\d+)/i.exec((e.target.value||"").trim());
                if(m) setF(p=>({ ...p, base_url:m[1], config:{ ...(p.config||{}), apiVersion:"v1", formId:m[2] } })); }} /></Field>
            <Field label="Numéro du formulaire" hint="Celui de l'adresse …/api/v1/data/340943">
              <Input value={f.config?.formId||""} onChange={e=>uc("formId",e.target.value)} placeholder="340943" /></Field>
            <Field label="Chemin de lecture"
              hint="Laisser vide pour /api/v1/data/{formId} — à ajuster si l'instance diffère">
              <Input value={f.config?.chemin||""} onChange={e=>uc("chemin",e.target.value)} /></Field>
          </> : <>
            <Field label="Identifiant du formulaire (uid de l'asset)" className="col-span-2">
              <Input value={f.config?.uid||""} onChange={e=>uc("uid",e.target.value)}
                placeholder="aBcDeFgHiJkLmNoPqRsTuV" /></Field>
            <Field label="Chemin de lecture"
              hint="Laisser vide pour /api/v2/assets/{uid}/data/ — à ajuster si l'instance diffère">
              <Input value={f.config?.chemin||""} onChange={e=>uc("chemin",e.target.value)} /></Field>
            <Field label="Pointeur vers les lignes" hint="Vide convient : Kobo emballe ses lignes dans « results »">
              <Input value={f.config?.pointeur||""} onChange={e=>uc("pointeur",e.target.value)} placeholder="results" /></Field>
          </>}
        </>}
      </div>
      <Sw label="Connecteur actif" hint="Un connecteur inactif reste configuré mais n'est plus proposé"
        on={f.active!==false} onChange={v=>u("active",v)} />
      <Note>Aucun secret ne doit figurer dans les champs de configuration ci-dessus : ils sont renvoyés
        en clair par l'API. Le jeton a son propre champ, chiffré au repos — le serveur refuse d'ailleurs
        toute clé de configuration dont le nom évoque un secret.</Note>
    </Modal>);
}

/* ── Modèles de rapport ── */
function SetTemplates({ db, set, notify, can }){
  const [sel,setSel] = useState(db.reportTemplates[0]?.id || "");
  const t = db.reportTemplates.find(x=>x.id===sel);
  const upd = (fn) => set(d => { const x=d.reportTemplates.find(y=>y.id===sel); if(x) fn(x); return d; });
  /* Les modèles deviennent la sous-navigation EN HAUT (pastilles) ; la
     configuration du modèle choisi s'affiche EN DESSOUS, comme les autres écrans. */
  const groups = [{ label:"Modèles",
    items: db.reportTemplates.map(x => ({ value:x.id, label:x.name, count:x.blocks.length })) }];
  return (
    <SideRail groups={groups} active={sel} onPick={setSel} right={<>
      {can("edit") && <div className="flex items-center gap-2">
        <Btn size="sm" icon={Plus}
          onClick={()=>{ const nt={ id:uid("t"), name:"Nouveau modèle", blocks:["kpi"], intro:"" };
            set(d=>{ d.reportTemplates.push(nt); return d; }); setSel(nt.id); }}>Ajouter un modèle</Btn>
        {t && can("del") && db.reportTemplates.length>1 &&
          <Btn size="sm" kind="ghost" icon={Trash2} onClick={()=>{ set(d=>{ d.reportTemplates=d.reportTemplates.filter(x=>x.id!==sel); return d; });
            setSel(db.reportTemplates.find(x=>x.id!==sel)?.id||""); }}>Supprimer</Btn>}
      </div>}
      {t ? (
        <Card title="Configuration du modèle" subtitle={t.name}>
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
      ) : <Card><Empty icon={FileText} title="Aucun modèle" text="Ajoutez un modèle de rapport pour commencer." /></Card>}
    </>} />);
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
  /* Le mot de passe provisoire, affiché UNE seule fois après création ou
     réinitialisation, pour que l'administrateur le communique. Jamais restocké. */
  const [provisoire,setProvisoire] = useState(null);
  /* Les prestataires ne vivent pas dans l'état global (db) : ils sont propres à
     l'écran Suivi tiers, et cet écran n'a besoin que de leur nom pour le
     rattachement d'un compte. Un aller-retour dédié plutôt qu'alourdir /api/state
     d'une collection que presque personne n'affiche. */
  useEffect(()=>{ api.tpm().then(r=>setTpms(r.rows||[])).catch(()=>setTpms([])); },[]);
  /* Les comptes vivent côté serveur : le navigateur ne calcule aucun condensat
     et ne conserve aucun mot de passe au-delà de la saisie. */
  const save = async (u2) => {
    /* L'administrateur ne choisit plus de mot de passe : à la création, le serveur
       en GÉNÈRE un provisoire et le renvoie ici une seule fois. L'identifiant, lui,
       se pose à la création comme plus tard. */
    const payload = { email:(u2.email||"").trim(), username:(u2.username||"").trim() || null,
      first_name:u2.firstName || u2.first_name || "",
      last_name:u2.lastName || u2.last_name || null, title:u2.title || null,
      office_id:u2.office_id || null, tpm_id:u2.tpm_id || null, role:u2.role || "viewer",
      tabs:u2.tabs || [], active:u2.active !== false };
    try{
      const r = u2.id ? await api.updateUser(u2.id, payload) : await api.createUser(payload);
      set(d => { const i = d.users.findIndex(x => x.id === r.user.id);
        if(i >= 0) d.users[i] = r.user; else d.users.push(r.user); return d; });
      setEdit(null);
      if(r.provisionalPassword) setProvisoire({ email:r.user.email, pw:r.provisionalPassword, cree:true });
      else notify("Compte enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
  };
  const reinitialiser = async (u2) => {
    if(!confirm(`Réinitialiser le mot de passe de ${u2.email} ? Ses sessions ouvertes seront fermées.`)) return;
    try{ const r = await api.resetUserPassword(u2.id);
      setProvisoire({ email:u2.email, pw:r.provisionalPassword, cree:false });
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
            <Th>Identifiant</Th><Th>Rôle</Th><Th>Onglets</Th><Th>Statut</Th><Th /></tr></thead>
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
              <Td className="f115 text-slate-500">{u2.username || "—"}</Td>
              <Td><Badge tone={u2.role==="super"||u2.role==="admin"?"r":u2.role==="validator"?"b":u2.role==="editor"?"g":"n"}>
                {db.roles[u2.role]?.label}</Badge></Td>
              <Td className="text-slate-500">{(u2.tabs||db.roles[u2.role]?.tabs||[]).length} / {TABS_ALL.length}</Td>
              <Td>{u2.active!==false ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>}</Td>
              <Td className="text-right whitespace-nowrap">
                <button title="Réinitialiser le mot de passe" onClick={()=>reinitialiser(u2)}
                  className="text-slate-400 m-ico p-1"><KeyRound size={14}/></button>
                <button title="Modifier" onClick={()=>setEdit(u2)} className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>
                {u2.id!==me.id && <button title="Supprimer" onClick={()=>{ if(confirm("Supprimer ce compte ?")) removeUser(u2.id); }}
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
      <ProvisionalModal data={provisoire} notify={notify} onClose={()=>setProvisoire(null)} />
    </>);
}

/* Le mot de passe provisoire, montré UNE fois. L'administrateur le lit, le copie et
   le communique ; il n'est ni restocké ni renvoyé une seconde fois par le serveur. */
function ProvisionalModal({ data, notify, onClose }){
  if(!data) return null;
  const copier = async () => {
    try{ await navigator.clipboard.writeText(data.pw); notify("Mot de passe copié", "ok"); }
    catch{ notify("Copie impossible — sélectionnez le texte manuellement", "err"); }
  };
  return (
    <Modal open onClose={onClose} title={data.cree ? "Compte créé" : "Mot de passe réinitialisé"}
      subtitle={data.email}
      footer={<Btn onClick={onClose}>J'ai communiqué le mot de passe</Btn>}>
      <Note tone="warn">Communiquez ce mot de passe provisoire à l'utilisateur. Il ne sera
        <b> plus jamais affiché</b>. À sa première connexion, il devra le remplacer.</Note>
      <div className="flex items-center gap-2 mt-3">
        <code className="flex-1 f16 font-mono tracking-wide bg-slate-100 border border-slate-200 rounded px-3 py-2.5 text-slate-900 select-all">{data.pw}</code>
        <Btn kind="sec" icon={Copy} onClick={copier}>Copier</Btn>
      </div>
    </Modal>);
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
        <Btn icon={Save} disabled={!f.firstName||!f.email} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Prénom"><Input value={f.firstName||""} onChange={e=>u("firstName",e.target.value)} /></Field>
        <Field label="Nom"><Input value={f.lastName||""} onChange={e=>u("lastName",e.target.value)} /></Field>
        <Field label="Fonction"><Input value={f.title||""} onChange={e=>u("title",e.target.value)} /></Field>
        <Field label="Adresse électronique"><Input type="email" value={f.email||""} onChange={e=>u("email",e.target.value)} /></Field>
        <Field label="Identifiant de connexion" className="col-span-2"
          hint="Facultatif — permet de se connecter à la place du courriel. L'utilisateur peut le changer depuis « Mon compte »">
          <Input value={f.username||""} onChange={e=>u("username",e.target.value)} placeholder="prenom.nom" /></Field>
      </div>
      {!user?.id && <Note>À l'enregistrement, un <b>mot de passe provisoire</b> est généré et affiché
        une seule fois : communiquez-le à l'utilisateur, qui devra le remplacer à sa première connexion.
        L'administrateur ne choisit pas le mot de passe.</Note>}
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
