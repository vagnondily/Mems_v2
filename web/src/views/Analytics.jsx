import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, BarChart3, Code2, Database, Download, FileDown, Filter, Pencil, Play, Plus, Save, Sigma, Trash2, Upload } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart,
         PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, RadialBar, RadialBarChart,
         ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis } from "recharts";
import { Badge, Bar2, Btn, Card, Empty, Field, Input, Modal, Note, Select, TableWrap, Tabs, Td, Th, download, inputCls, parseCSV, toCSV } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { RULE_TYPES, applyFormulas, applyRules, fmt, n, pct, profileColumn, r1, siteScore, uid } from "../lib/calc.js";
import { C, MONTHS, SERIES } from "../lib/constants.js";
import { anneeMoisDe, dateDansPeriode, libelleCourtPeriode, moisDansPeriode,
  normalisePeriode, periodeAnnee } from "../lib/periode.js";
import { BarrePeriode } from "./Reports.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Analyses ══════════════════ */
function Analytics({ db, set, me, sub, setSub, notify, can }){
  const items = [["datasets","Jeux de données"],["scripts","Scripts d'analyse"],["viz","Visualisations"]];
  const [periode,setPeriode] = useState(() => periodeAnnee(db.year));
  return (
    <div className="space-y-4">
      <PageHead title="Analyses" text="Constitution des jeux de données à partir d'ODK Central, apurement, scripts R ou SPSS et visualisations." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {/* La barre ne sort que sur les visualisations. Les jeux de données et les
          scripts portent des colonnes ODK quelconques, sans date garantie ni
          nommée : y poser un filtre de période afficherait un réglage qui ne
          filtrerait rien. */}
      {sub==="viz" && <BarrePeriode db={db} periode={periode} onChange={setPeriode} />}
      {sub==="datasets" && <Datasets db={db} set={set} notify={notify} can={can} />}
      {sub==="scripts" && <Scripts db={db} set={set} me={me} notify={notify} can={can} />}
      {sub==="viz" && <Viz db={db} set={set} periode={periode} notify={notify} can={can} />}
    </div>);
}

function Datasets({ db, set, notify, can }){
  const [open,setOpen] = useState(null); const [creating,setCreating] = useState(false);
  const [tirage,setTirage] = useState("");
  /* Les lignes brutes ne voyagent plus dans l'état initial — jusqu'à 20 000
     soumissions par formulaire partaient vers chaque compte à chaque ouverture,
     pour ce seul geste. On va les chercher AU MOMENT où l'on en fait un jeu de
     données, ce qui est aussi le seul moment où elles servent. */
  const create = async (formId, name) => {
    const f = db.odkForms.find(x=>x.id===formId); if(!f) return;
    if(!f.records){ notify("Ce formulaire ne contient pas encore de données extraites","warn"); return; }
    setTirage(formId);
    try{
      const r = await api.odkFormRows(formId);
      const rows = r.rows || [];
      if(!rows.length){ notify("Ce formulaire ne contient pas encore de données extraites","warn"); return; }
      set(d => { d.datasets.push({ id:uid("ds"), name: name || f.name, formId:f.id, formName:f.name,
        createdAt:new Date().toISOString(), raw: rows, rules: [], formulas: [], version: 1, notes:"" }); return d; });
      setCreating(false);
      notify(r.reste
        ? `Jeu de données créé — ${fmt(rows.length)} lignes sur ${fmt(r.total)} (plafond de lecture atteint)`
        : `Jeu de données créé à partir de ${fmt(rows.length)} ligne(s) brutes`, r.reste ? "warn" : "ok");
    }catch(e){ notify(e.message, "err"); }
    finally{ setTirage(""); }
  };
  return (
    <>
      <Note>Un jeu de données fige les <b>données brutes</b> extraites d'un formulaire. Les règles d'apurement
        s'exécutent dans le navigateur et produisent les <b>données apurées</b>, sans jamais altérer la source.
        Les deux versions restent disponibles à l'export et pour les visualisations.</Note>
      <Card flush title="Jeux de données" subtitle={`${db.datasets.length} enregistrés`}
        right={can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setCreating(true)}>Créer depuis un formulaire</Btn>}>
        {db.datasets.length ? (
          <TableWrap max="mh420">
            <thead><tr><Th>Nom</Th><Th>Source</Th><Th num>Lignes brutes</Th><Th num>Lignes apurées</Th>
              <Th num>Règles</Th><Th num>Colonnes</Th><Th>Créé le</Th><Th /></tr></thead>
            <tbody>{db.datasets.map(ds=>{ const res = applyRules(ds.raw, ds.rules);
              return (<tr key={ds.id} className="hover:bg-sky-50">
                <Td className="font-medium">{ds.name}</Td><Td className="text-slate-600">{ds.formName}</Td>
                <Td num>{fmt(ds.raw.length)}</Td>
                <Td num><b className={res.rows.length<ds.raw.length?"text-amber-700":"text-lime-700"}>{fmt(res.rows.length)}</b></Td>
                <Td num>{(ds.rules||[]).length}</Td>
                <Td num>{Object.keys(ds.raw[0]||{}).length}</Td>
                <Td className="f115 text-slate-500">{new Date(ds.createdAt).toLocaleDateString("fr-FR")}</Td>
                <Td className="text-right">
                  <Btn size="sm" kind="ghost" icon={Filter} onClick={()=>setOpen(ds.id)}>Apurer</Btn>
                  {can("del") && <button onClick={()=>set(d=>{ d.datasets=d.datasets.filter(x=>x.id!==ds.id); return d; })}
                    className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</Td>
              </tr>); })}</tbody>
          </TableWrap>
        ) : <Empty icon={Database} title="Aucun jeu de données"
              text="Créez un jeu à partir d'un formulaire ODK Central pour commencer l'apurement et l'analyse."
              action={can("edit") && <Btn icon={Plus} onClick={()=>setCreating(true)}>Créer depuis un formulaire</Btn>} />}
      </Card>
      <Modal open={creating} onClose={()=>setCreating(false)} title="Créer un jeu de données"
        subtitle="Les données brutes du formulaire sont figées dans le jeu"
        footer={<Btn kind="sec" onClick={()=>setCreating(false)}>Fermer</Btn>}>
        <div className="space-y-2">
          {db.odkForms.map(f=>(
            <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 border border-slate-200 rounded hover:bg-slate-50">
              <Database size={16} className="text-slate-400" />
              <div className="flex-1 min-w-0"><div className="f13 font-semibold text-slate-800">{f.name}</div>
                <div className="f115 text-slate-500">{f.formId} · {fmt(f.records||0)} lignes disponibles</div></div>
              <Btn size="sm" disabled={!f.records || !!tirage} onClick={()=>create(f.id)}>
                {tirage===f.id ? "Lecture…" : "Créer"}</Btn>
            </div>))}
        </div>
      </Modal>
      <CleanModal open={!!open} ds={db.datasets.find(d=>d.id===open)} set={set} onClose={()=>setOpen(null)} notify={notify} can={can} />
    </>);
}

function CleanModal({ open, ds, set, onClose, notify, can }){
  const [tab,setTab] = useState("rules");
  if(!open || !ds) return null;
  const cols = Object.keys(ds.raw[0]||{});
  const res = applyRules(ds.raw, ds.rules);
  const withInd = applyFormulas(res.rows, ds.formulas);
  const indCols = (ds.formulas||[]).filter(f=>f.active!==false && f.field).map(f=>f.field);
  const upd = (fn) => set(d => { const x = d.datasets.find(y=>y.id===ds.id); if(x) fn(x); return d; });
  const addRule = () => upd(x => { x.rules = x.rules||[]; x.rules.push({ id:uid("r"), type:"dropEmpty", field:cols[0], value:"", value2:"", active:true }); });
  const addFormula = () => upd(x => { x.formulas = x.formulas||[]; x.formulas.push(
    { id:uid("fx"), name:"Nouvel indicateur", field:"indicateur_"+(x.formulas.length+1), expr:"", notes:"", active:true }); });
  const exp = (rows, suffix) => download(`${ds.name.replace(/\W+/g,"_")}_${suffix}.csv`,
    toCSV(rows, Object.keys(rows[0]||{})), "text/csv");
  return (
    <Modal open wide onClose={onClose} title={`Apurement — ${ds.name}`}
      subtitle={`${fmt(ds.raw.length)} lignes brutes · ${fmt(res.rows.length)} après application des règles`}
      footer={<><Btn kind="sec" icon={Download} onClick={()=>exp(ds.raw,"brut")}>Exporter les données brutes</Btn>
        <Btn kind="sec" icon={Download} onClick={()=>exp(res.rows,"apure")}>Exporter les données apurées</Btn>
        {indCols.length>0 && <Btn kind="sec" icon={Download} onClick={()=>exp(withInd.rows,"indicateurs")}>Exporter avec indicateurs</Btn>}
        <Btn onClick={onClose}>Fermer</Btn></>}>
      <Tabs className="mb-4" value={tab} onChange={setTab}
        items={[["rules","Règles d'apurement"],["formulas","Formules de performance"],
          ["profile","Profil des variables"],["preview","Aperçu"],["log","Journal"]]} />
      {tab==="formulas" && (
        <>
          <Note tool><b>Pourquoi recalculer ici.</b> Les scores « calculate » des XLSForms ODK sont figés sur le
            terrain et peuvent être faux (dénominateur qui ne correspond plus au nombre réel de critères, poids qui
            ne somment pas à 100…). Une formule ci-dessous se réécrit et se corrige à tout moment, sans reflasher le
            formulaire. Elle s'applique aux <b>données apurées</b> (après les règles), dans l'ordre de la liste : une
            formule peut réutiliser le résultat d'une formule précédente comme variable.</Note>
          {(ds.formulas||[]).length ? (ds.formulas||[]).map((f,i)=>{ const err = withInd.errors[f.id];
            return (
            <div key={f.id} className="px-3 py-3 border border-slate-200 rounded mb-2">
              <div className="flex flex-wrap items-end gap-2 mb-2">
                <label className="flex items-center gap-1.5 f115 self-center">
                  <input type="checkbox" checked={f.active!==false} onChange={e=>upd(x=>{x.formulas[i].active=e.target.checked;})} />actif</label>
                <div className="flex-1 mnw260"><div className="f10 font-semibold text-slate-500 mb-1">Nom</div>
                  <Input value={f.name||""} onChange={e=>upd(x=>{x.formulas[i].name=e.target.value;})} className="mi-py1 mi-xs" /></div>
                <div><div className="f10 font-semibold text-slate-500 mb-1">Colonne calculée</div>
                  <Input value={f.field||""} onChange={e=>upd(x=>{x.formulas[i].field=e.target.value.replace(/\s+/g,"_");})} className="mi-py1 mi-xs w-40" /></div>
                <div className="f115 self-center ml-auto">
                  {err ? <span className="text-rose-700 flex items-center gap-1"><AlertTriangle size={12}/>{err.count} erreur(s)</span>
                    : (f.active!==false && f.field && f.expr) ? <span className="text-lime-700">calculée sur {fmt(res.rows.length)} ligne(s)</span> : null}</div>
                {can("edit") && <button onClick={()=>upd(x=>{x.formulas.splice(i,1);})} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>}
              </div>
              <textarea value={f.expr||""} onChange={e=>upd(x=>{x.formulas[i].expr=e.target.value;})}
                rows={2} className="m-code" spellCheck={false}
                placeholder="ex. MOFoodReceivedMatch=='1' ? 100 : 0" />
              {err && <p className="f115 text-rose-700 mt-1">{err.sample}</p>}
              <div className="flex flex-wrap gap-1 mt-2">
                {cols.map(c=>(
                  <button key={c} onClick={()=>upd(x=>{x.formulas[i].expr=(x.formulas[i].expr||"")+c;})}
                    className="px-1.5 py-0.5 rounded bg-slate-100 hover:bg-sky-100 f11 text-slate-600 border border-slate-200">{c}</button>))}
              </div>
              <textarea value={f.notes||""} onChange={e=>upd(x=>{x.formulas[i].notes=e.target.value;})}
                rows={1} className={inputCls+" mt-2"} placeholder="Notes méthodologiques (pondération, source, hypothèse…)" />
            </div>); }) : <Empty icon={Sigma} title="Aucune formule"
              text="Ajoutez un indicateur pour recalculer un score de performance à partir des variables de ce jeu." />}
          {can("edit") && <Btn size="sm" kind="sec" icon={Plus} onClick={addFormula}>Ajouter une formule</Btn>}
        </>)}
      {tab==="rules" && (
        <>
          {(ds.rules||[]).length ? (ds.rules||[]).map((r,i)=>(
            <div key={r.id} className="flex flex-wrap items-end gap-2 px-3 py-2.5 border border-slate-200 rounded mb-2">
              <label className="flex items-center gap-1.5 f115 self-center">
                <input type="checkbox" checked={r.active!==false} onChange={e=>upd(x=>{x.rules[i].active=e.target.checked;})} />actif</label>
              <div><div className="f10 font-semibold text-slate-500 mb-1">Règle</div>
                <Select value={r.type} onChange={e=>upd(x=>{x.rules[i].type=e.target.value;})} options={RULE_TYPES} className="mi-py1 mi-xs mi-wauto" /></div>
              <div><div className="f10 font-semibold text-slate-500 mb-1">Champ</div>
                <Select value={r.field} onChange={e=>upd(x=>{x.rules[i].field=e.target.value;})} options={cols} className="mi-py1 mi-xs mi-wauto" /></div>
              {["keepIf","dropIf","recode","rename","range"].includes(r.type) && (
                <div><div className="f10 font-semibold text-slate-500 mb-1">{r.type==="range"?"Minimum":r.type==="rename"?"Nouveau nom":"Valeur"}</div>
                  <Input value={r.value||""} onChange={e=>upd(x=>{x.rules[i].value=e.target.value;})} className="mi-py1 mi-xs w-36" /></div>)}
              {["recode","range"].includes(r.type) && (
                <div><div className="f10 font-semibold text-slate-500 mb-1">{r.type==="range"?"Maximum":"Remplacer par"}</div>
                  <Input value={r.value2||""} onChange={e=>upd(x=>{x.rules[i].value2=e.target.value;})} className="mi-py1 mi-xs w-36" /></div>)}
              <div className="f115 text-slate-500 self-center ml-auto">
                {res.log[i] ? `${res.log[i].removed>0?"−"+res.log[i].removed+" lignes":"aucune suppression"}` : ""}</div>
              <button onClick={()=>upd(x=>{x.rules.splice(i,1);})} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>
            </div>)) : <Empty icon={Filter} title="Aucune règle" text="Ajoutez des règles pour nettoyer le jeu de données." />}
          {can("edit") && <Btn size="sm" kind="sec" icon={Plus} onClick={addRule}>Ajouter une règle</Btn>}
        </>)}
      {tab==="profile" && (
        <TableWrap max="mh55">
          <thead><tr><Th>Variable</Th><Th num>Valeurs</Th><Th num>Manquantes</Th><Th num>Modalités</Th>
            <Th num>Moyenne</Th><Th num>Médiane</Th><Th num>Min</Th><Th num>Max</Th></tr></thead>
          <tbody>{[...cols, ...indCols].map(c=>{ const p=profileColumn(withInd.rows,c);
            return (<tr key={c} className="hover:bg-sky-50">
              <Td className="font-medium">{c}{indCols.includes(c) && <span className="ml-1.5"><Badge tone="b">indicateur</Badge></span>}</Td><Td num>{p.total}</Td>
              <Td num className={p.missing?"text-amber-700":""}>{p.missing}</Td><Td num>{p.unique}</Td>
              <Td num>{p.numeric?p.mean:"—"}</Td><Td num>{p.numeric?p.median:"—"}</Td>
              <Td num>{p.numeric?p.min:"—"}</Td><Td num>{p.numeric?p.max:"—"}</Td></tr>); })}</tbody>
        </TableWrap>)}
      {tab==="preview" && (
        <TableWrap max="mh55">
          <thead><tr>{Object.keys(withInd.rows[0]||{}).map(c=><Th key={c}>{c}</Th>)}</tr></thead>
          <tbody>{withInd.rows.slice(0,60).map((r,i)=>(
            <tr key={i} className="hover:bg-sky-50">{Object.keys(withInd.rows[0]||{}).map(c=>
              <Td key={c} className={String(r[c]??"")===""?"text-slate-300":""}>{String(r[c]??"∅")}</Td>)}</tr>))}</tbody>
        </TableWrap>)}
      {tab==="log" && (
        <TableWrap max="mh55">
          <thead><tr><Th num>#</Th><Th>Règle</Th><Th>Champ</Th><Th num>Avant</Th><Th num>Après</Th><Th num>Retirées</Th></tr></thead>
          <tbody>{res.log.map((l,i)=>(<tr key={i}><Td num>{i+1}</Td>
            <Td>{(RULE_TYPES.find(t=>t[0]===l.rule)||[])[1] || l.rule}</Td><Td className="f115">{l.field}</Td>
            <Td num>{l.before}</Td><Td num>{l.after}</Td>
            <Td num className={l.removed?"text-amber-700 font-semibold":""}>{l.removed}</Td></tr>))}</tbody>
        </TableWrap>)}
    </Modal>);
}

const SCRIPT_TPL = {
  R: `# Analyse — MEMS
# Les données apurées sont exportées dans donnees.csv
library(dplyr)

donnees <- read.csv("donnees.csv", stringsAsFactors = FALSE)

resume <- donnees %>%
  group_by(site_id) %>%
  summarise(n = n(), score_moyen = mean(as.numeric(q_score), na.rm = TRUE))

print(resume)
write.csv(resume, "resultats.csv", row.names = FALSE)
`,
  SPSS: `* Analyse — MEMS.
GET DATA /TYPE=TXT /FILE='donnees.csv' /DELIMITERS=","
  /FIRSTCASE=2 /VARIABLES=ALL.

FREQUENCIES VARIABLES=site_id
  /ORDER=ANALYSIS.

MEANS TABLES=q_score BY site_id
  /CELLS MEAN COUNT STDDEV.
`,
};
/* Deux mesures qu'on ne lit pas en brut : 12345 ms et 1048576 octets ne disent
   rien, « 12,3 s » et « 1,0 Mo » se lisent d'un coup d'œil. */
const dureeLisible = (ms) => ms == null ? "—" : `${(ms/1000).toFixed(1)} s`;
const poidsLisible = (o) => o == null ? "—"
  : o < 1024 ? `${o} o` : o < 1048576 ? `${(o/1024).toFixed(1)} Ko` : `${(o/1048576).toFixed(1)} Mo`;

/* État des interpréteurs du serveur, dit à l'exploitant.

   Masquer « Exécuter » sans un mot laisserait croire à une panne ou à un droit
   manquant, alors que la fonction est simplement FERMÉE PAR DÉFAUT : l'ouvrir
   revient à autoriser l'exécution de code arbitraire sur le serveur, et c'est
   une décision d'exploitant. On dit donc ce qui manque, pourquoi, et quoi faire.
   Les noms de variables viennent de la réponse du serveur et ne sont pas
   recopiés ici : ajouter un interpréteur côté serveur n'a pas à toucher
   l'interface. */
function EtatMoteurs({ etat }){
  if(!etat) return <Note>Interrogation du serveur sur les interpréteurs disponibles…</Note>;
  if(etat.erreur) return (
    <Note tone="err"><b>Impossible de savoir si l'exécution sur le serveur est possible.</b> {etat.erreur}.
      Le téléchargement du script et des données reste disponible.</Note>);

  const liste = etat.moteurs || [];
  const dispo = liste.filter(m => m.disponible);
  const detail = (
    <ul className="mt-1.5 pl18 list-disc">
      {liste.map(m => (
        <li key={m.lang}><b>{m.libelle}</b> — {m.disponible ? "disponible" : m.raison}</li>))}
    </ul>);

  if(!dispo.length) return (
    <Note tone="warn">
      <b>L'exécution des scripts sur le serveur est désactivée sur cette instance.</b> Aucun interpréteur
      n'y est utilisable : les scripts se rédigent et se téléchargent ici, puis s'exécutent ailleurs — le
      fonctionnement décrit ci-dessous, inchangé.
      {detail}
      <div className="mt-1.5">Pour l'activer, déclarez le chemin absolu de l'interpréteur dans{" "}
        {liste.map(m => m.variable).filter(Boolean).join(" ou ") || "la variable prévue"} du fichier
        <b> .env</b> du serveur, puis redémarrez-le. Exécuter un script, c'est exécuter du code sur le
        serveur avec les droits du processus MEMS : ne l'ouvrez que sur une instance dont la perte est
        acceptable.</div>
    </Note>);

  return (
    <Note tone="ok">
      <b>L'exécution sur le serveur est disponible.</b> Le script reçoit le jeu de données apuré par ce
      navigateur, s'exécute sous un délai borné, et rend son code de sortie, ses sorties et les fichiers
      qu'il a produits. Chaque exécution est journalisée au registre de sécurité.
      {detail}
    </Note>);
}

function Scripts({ db, set, me, notify, can }){
  const [edit,setEdit] = useState(null);
  /* `null` tant que le serveur n'a pas répondu : « on ne sait pas encore » et
     « aucun interpréteur » n'ont pas à produire le même écran. */
  const [moteurs,setMoteurs] = useState(null);
  const [execution,setExecution] = useState(null);
  const [encours,setEncours] = useState("");
  /* Le rôle, et non la capacité « admin » : le serveur réserve tout ce routeur
     au super-utilisateur, un administrateur y recevrait 403. */
  const superUtilisateur = me?.role === "super";

  /* L'état des interpréteurs vient du serveur et de nulle part ailleurs : lui
     seul sait ce qui est installé sur SA machine. Le déduire du langage du
     script afficherait un bouton qui échoue une fois sur deux. */
  useEffect(() => {
    if(!superUtilisateur) return undefined;
    let vivant = true;
    api.scriptMoteurs()
      .then(m => { if(vivant) setMoteurs(m); })
      .catch(e => { if(vivant) setMoteurs({ actif:false, moteurs:[], erreur:e.message }); });
    return () => { vivant = false; };
  }, [superUtilisateur]);

  const moteurDe = (lang) => (moteurs?.moteurs || []).find(m => m.lang === lang);

  const add = () => setEdit({ id:null, name:"Nouvelle analyse", lang:"R", datasetId:db.datasets[0]?.id||"",
    stage:"analysis", code:SCRIPT_TPL.R, notes:"", runs:[] });
  const save = (s) => { set(d => { const i=d.scripts.findIndex(x=>x.id===s.id);
      if(i>=0) d.scripts[i]=s; else d.scripts.push({ ...s, id:uid("sc"), createdAt:new Date().toISOString() });
      return d; }); setEdit(null); notify("Script enregistré","ok"); };
  /* Les lignes que le script doit voir, apurement compris. C'est la même
     sélection pour le téléchargement et pour l'exécution serveur : les deux
     chemins doivent porter exactement le même jeu de données, sans quoi le
     script rendrait deux résultats différents selon l'endroit où il tourne. */
  const lignesDe = (s) => { const ds = db.datasets.find(d=>d.id===s.datasetId);
    return ds ? (s.stage==="cleaning" ? ds.raw : applyRules(ds.raw, ds.rules).rows) : null; };
  const bundle = (s) => {
    const rows = lignesDe(s);
    if(!rows){ notify("Ce script n'est relié à aucun jeu de données","warn"); return; }
    download(`${s.name.replace(/\W+/g,"_")}_donnees.csv`, toCSV(rows, Object.keys(rows[0]||{})), "text/csv");
    download(`${s.name.replace(/\W+/g,"_")}.${s.lang==="R"?"R":"sps"}`, s.code, "text/plain");
    notify("Script et données téléchargés","ok"); };

  const executer = async (s) => {
    setEncours(s.id);
    setExecution({ script:s, resultat:null, erreur:null });
    try{
      /* Les règles d'apurement s'appliquent dans le navigateur ; le serveur ne
         les rejoue pas. Transmettre les lignes déjà apurées est donc la seule
         façon d'exécuter le script sur les données qu'il attend. */
      const rep = await api.executerScript(s.id, lignesDe(s));
      setExecution({ script:s, resultat:rep.execution, erreur:null });
      const ok = rep.execution.statut === "ok";
      notify(ok ? `Script « ${s.name} » exécuté` : `Le script « ${s.name} » s'est terminé en échec`,
        ok ? "ok" : "warn");
    }catch(e){
      setExecution({ script:s, resultat:null, erreur:e.message });
      notify(e.message, "err");
    }finally{ setEncours(""); }
  };

  return (
    <>
      <Note tone="warn"><b>Ce que fait l'application, et ce qu'elle ne fait pas.</b> Les scripts R et SPSS sont
        rédigés, versionnés et conservés ici, puis téléchargés avec le jeu de données correspondant pour être
        exécutés dans R ou SPSS. Un navigateur ne peut pas faire tourner ces moteurs. En revanche, les
        <b> règles d'apurement</b> de l'onglet Jeux de données s'exécutent réellement ici, et les résultats
        d'analyse produits à l'extérieur peuvent être réimportés en pièce jointe du script.</Note>
      {/* L'exécution sur le serveur s'AJOUTE au travail hors ligne, elle ne le
          remplace pas : le téléchargement reste offert sur chaque ligne, y
          compris quand un interpréteur est disponible. Une analyse se refait
          souvent sur le poste de l'analyste, avec ses propres bibliothèques. */}
      {superUtilisateur && <EtatMoteurs etat={moteurs} />}
      <Card flush title="Scripts d'apurement et d'analyse" subtitle={`${db.scripts.length} scripts`}
        right={can("edit") && <Btn size="sm" icon={Plus} onClick={add}>Nouveau script</Btn>}>
        {db.scripts.length ? (
          <TableWrap max="mh420">
            <thead><tr><Th>Nom</Th><Th>Langage</Th><Th>Étape</Th><Th>Jeu de données</Th><Th num>Lignes</Th><Th num>Exécutions</Th><Th /></tr></thead>
            <tbody>{db.scripts.map(s=>{ const ds=db.datasets.find(d=>d.id===s.datasetId);
              const moteur = moteurDe(s.lang);
              return (<tr key={s.id} className="hover:bg-sky-50">
                <Td className="font-medium">{s.name}</Td>
                <Td><Badge tone={s.lang==="R"?"b":"n"}>{s.lang}</Badge></Td>
                <Td>{s.stage==="cleaning"?"Nettoyage":"Analyse"}</Td>
                <Td className="text-slate-600">{ds?ds.name:<span className="text-amber-700">non relié</span>}</Td>
                <Td num>{ds?fmt(s.stage==="cleaning"?ds.raw.length:applyRules(ds.raw,ds.rules).rows.length):"—"}</Td>
                <Td num>{(s.runs||[]).length}</Td>
                <Td className="text-right">
                  {superUtilisateur && (moteur?.disponible
                    ? <Btn size="sm" kind="ghost" icon={Play} data-executer={s.id}
                        disabled={!!encours} onClick={()=>executer(s)}>
                        {encours===s.id ? "Exécution…" : "Exécuter"}</Btn>
                    /* Pas de bouton désactivé : il inviterait à cliquer sur ce
                       qui ne peut pas aboutir. Le motif exact est au survol, et
                       la marche à suivre au-dessus du tableau. */
                    : moteurs && <span className="f105 text-slate-400 mr-2"
                        title={moteur?.raison || "interpréteur inconnu du serveur"}>
                        {s.lang} non exécutable ici</span>)}
                  <Btn size="sm" kind="ghost" icon={Download} onClick={()=>bundle(s)}>Exporter</Btn>
                  <Btn size="sm" kind="ghost" icon={Pencil} onClick={()=>setEdit(s)}>Ouvrir</Btn></Td>
              </tr>); })}</tbody>
          </TableWrap>
        ) : <Empty icon={Code2} title="Aucun script" text="Créez un script R ou SPSS relié à un jeu de données."
              action={can("edit") && <Btn icon={Plus} onClick={add}>Nouveau script</Btn>} />}
      </Card>
      <ScriptModal open={!!edit} s={edit} db={db} onClose={()=>setEdit(null)} onSave={save} notify={notify} />
      <ResultatExecution etat={execution} onClose={()=>setExecution(null)} notify={notify} />
    </>);
}

/* Compte rendu d'une exécution : code de sortie, durée, les deux sorties, et
   les fichiers produits. Un script faux est un résultat d'analyse et non une
   panne — l'échec s'affiche donc avec le même soin que la réussite. */
function ResultatExecution({ etat, onClose, notify }){
  const [charge,setCharge] = useState("");
  if(!etat) return null;
  const { script, resultat, erreur } = etat;

  const telecharger = async (f) => {
    setCharge(f.nom);
    try{
      const b = await api.fichierExecution(resultat.id, f.nom);
      download(f.nom, b, b.type || "application/octet-stream");
    }catch(e){ notify(`Téléchargement impossible : ${e.message}`, "err"); }
    finally{ setCharge(""); }
  };

  const STATUTS = { ok:["Réussite","g"], echec:["Échec","r"], delai:["Délai dépassé","r"] };
  const [libelle,tone] = STATUTS[resultat?.statut] || ["—","n"];

  return (
    <Modal open wide onClose={onClose} title={`Exécution — ${script.name}`}
      subtitle="Exécution sur le serveur, journalisée au registre de sécurité"
      footer={<Btn kind="sec" onClick={onClose}>Fermer</Btn>}>
      {!resultat && !erreur && (
        <div className="py-10 text-center f13 text-slate-500">
          <div className="w-9 h-9 rounded-full bd3 border-slate-200 bdt-brand animate-spin mx-auto mb-3" />
          Exécution en cours sur le serveur…</div>)}

      {erreur && <Note tone="err"><b>Le script n'a pas été exécuté.</b> {erreur}</Note>}

      {resultat && (<>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge tone={tone}>{libelle}</Badge>
          <Badge>{resultat.moteur}</Badge>
          <span className="f115 text-slate-500">
            code de sortie <b className="tabular-nums">{resultat.code === null ? "aucun" : resultat.code}</b>
            {resultat.signal ? ` (signal ${resultat.signal})` : ""}
            {" · "}durée <b className="tabular-nums">{dureeLisible(resultat.dureeMs)}</b>
            {" · "}<b className="tabular-nums">{fmt(resultat.lignes)}</b> lignes transmises</span>
        </div>

        {resultat.message && <Note tone="warn">{resultat.message}</Note>}
        {/* Une conclusion tirée d'un tableau coupé sans le savoir est une
            conclusion fausse : la troncature se dit, elle ne se devine pas. */}
        {resultat.tronque && <Note tone="warn"><b>Sortie tronquée.</b> Le serveur plafonne ce qu'il
          conserve de la sortie d'un script. Ce qui suit est incomplet — écrivez les résultats volumineux
          dans un fichier, il sera récupérable ci-dessous.</Note>}

        <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
          Sortie standard{resultat.sortieTronquee && <span className="text-amber-700"> — tronquée</span>}</div>
        <pre className="m-code overflow-auto mh240 mb-3">{resultat.sortie
          || "(aucune sortie standard)"}</pre>

        <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
          Sortie d'erreur{resultat.erreurTronquee && <span className="text-amber-700"> — tronquée</span>}</div>
        <pre className="m-code overflow-auto mh240 mb-3">{resultat.erreur
          || "(aucune sortie d'erreur)"}</pre>

        <div className="border-t border-slate-200 pt-3">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
            Fichiers produits par le script</div>
          {(resultat.fichiers||[]).length ? (
            <TableWrap max="mh240">
              <thead><tr><Th>Fichier</Th><Th num>Taille</Th><Th /></tr></thead>
              <tbody>{resultat.fichiers.map(f=>(
                <tr key={f.nom} className="hover:bg-sky-50">
                  <Td className="f115">{f.nom}</Td>
                  <Td num>{poidsLisible(f.octets)}</Td>
                  <Td className="text-right">
                    <Btn size="sm" kind="ghost" icon={FileDown} disabled={!!charge}
                      onClick={()=>telecharger(f)}>
                      {charge===f.nom ? "Téléchargement…" : "Télécharger"}</Btn></Td>
                </tr>))}</tbody>
            </TableWrap>
          ) : <p className="f115 text-slate-400">Le script n'a produit aucun fichier. Écrivez vos
                résultats dans le répertoire courant — un CSV, un graphique — pour les récupérer ici.</p>}
          {/* Ce que le serveur a refusé de rendre, et pourquoi : sans cette
              liste, un fichier attendu manquerait sans explication. */}
          {(resultat.fichiersEcartes||[]).length > 0 && (
            <div className="mt-2 f105 text-amber-700">
              Écartés : {resultat.fichiersEcartes.join(" · ")}</div>)}
          <p className="f105 text-slate-400 mt-2">Ces fichiers sont conservés un temps limité par le
            serveur, puis effacés : téléchargez ce que vous voulez garder.</p>
        </div>
      </>)}
    </Modal>);
}
function ScriptModal({ open, s, db, onClose, onSave, notify }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(s||{}); },[s]);
  if(!open) return null;
  const u=(k,v)=>setF(p=>({...p,[k]:v}));
  const ds = db.datasets.find(d=>d.id===f.datasetId);
  const attach = (file) => { const rd = new FileReader();
    rd.onload = () => { const rows = parseCSV(rd.result);
      setF(p=>({ ...p, runs:[...(p.runs||[]), { id:uid("run"), at:new Date().toISOString(),
        file:file.name, rows: rows.length, preview: rows.slice(0,20) }] }));
      notify(`${rows.length} lignes de résultats attachées`,"ok"); };
    rd.readAsText(file,"utf-8"); };
  return (
    <Modal open wide onClose={onClose} title={s?.id?"Modifier le script":"Nouveau script d'analyse"}
      subtitle="Rédigez, conservez, exportez avec les données, puis réimportez les résultats"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="Nom" className="col-span-2"><Input value={f.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        <Field label="Langage"><Select value={f.lang||"R"} onChange={e=>{ u("lang",e.target.value);
          if(!f.code || f.code===SCRIPT_TPL.R || f.code===SCRIPT_TPL.SPSS) u("code", SCRIPT_TPL[e.target.value]); }}
          options={[["R","R"],["SPSS","SPSS"]]} /></Field>
        <Field label="Étape"><Select value={f.stage||"analysis"} onChange={e=>u("stage",e.target.value)}
          options={[["cleaning","Nettoyage — sur données brutes"],["analysis","Analyse — sur données apurées"]]} /></Field>
        <Field label="Jeu de données" className="col-span-2">
          <Select value={f.datasetId||""} onChange={e=>u("datasetId",e.target.value)} empty="—"
            options={db.datasets.map(d=>[d.id, `${d.name} (${d.raw.length} lignes)`])} /></Field>
        <Field label="Variables disponibles" className="col-span-2">
          <div className="flex flex-wrap gap-1 mh190 overflow-auto p-1.5 border border-slate-200 rounded bg-slate-50">
            {Object.keys((ds?.raw||[])[0]||{}).map(c=>(
              <button key={c} onClick={()=>u("code",(f.code||"")+c)}
                className="px-1.5 py-0.5 rounded bg-white border border-slate-200 f11 text-slate-600 hover:bg-sky-50">{c}</button>))}
            {!ds && <span className="f115 text-slate-400">Reliez un jeu de données pour voir ses variables.</span>}
          </div></Field>
      </div>
      <Field label="Code"><textarea value={f.code||""} onChange={e=>u("code",e.target.value)} rows={14} className="m-code" spellCheck={false} /></Field>
      <Field label="Notes méthodologiques"><textarea value={f.notes||""} onChange={e=>u("notes",e.target.value)}
        rows={2} className={inputCls} placeholder="Hypothèses, pondérations, traitements particuliers" /></Field>
      <div className="border-t border-slate-200 pt-3">
        <div className="flex items-center gap-3 mb-2">
          <div className="f11 font-bold uppercase tracking-wide text-slate-500">Résultats réimportés</div>
          <label className="ml-auto">
            <input type="file" accept=".csv,.txt" className="hidden" onChange={e=>e.target.files[0]&&attach(e.target.files[0])} />
            <span className="inline-flex items-center gap-1.5 border rounded font-semibold px-2.5 py-1 f11 m-btn-sec cursor-pointer">
              <Upload size={13} /> Joindre un fichier de résultats</span></label>
        </div>
        {(f.runs||[]).length ? (
          <TableWrap max="mh190">
            <thead><tr><Th>Fichier</Th><Th>Date</Th><Th num>Lignes</Th><Th /></tr></thead>
            <tbody>{(f.runs||[]).map((r,i)=>(<tr key={r.id}><Td className="f115">{r.file}</Td>
              <Td className="f115 text-slate-500">{new Date(r.at).toLocaleString("fr-FR")}</Td><Td num>{fmt(r.rows)}</Td>
              <Td className="text-right"><button onClick={()=>u("runs",(f.runs||[]).filter(x=>x.id!==r.id))}
                className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button></Td></tr>))}</tbody>
          </TableWrap>
        ) : <p className="f115 text-slate-400">Aucun résultat attaché pour l'instant.</p>}
      </div>
    </Modal>);
}

/* ── Visualisations ── */
const SOURCES = {
  sites:   { label:"Sites", dims:[["subOffice","Bureau"],["adm1","Niveau 1"],["adm2","Niveau 2"],["adm3","Niveau 3"],
             ["activityTag","Activity tag"],["poiSubtype","Sous-type"],["modality","Modalité"],["partner","Partenaire"],
             ["urbanArea","Zone urbaine"],["status","Statut"]],
             measures:[["count","Nombre de sites"],["beneficiaries","Bénéficiaires"],["planned","Visites planifiées"],
             ["done","Visites réalisées"],["score","Score de risque moyen"]] },
  visits:  { label:"Visites", dims:[["office","Bureau"],["tag","Activity tag"],["monitor","Moniteur"],
             ["status","Statut"],["month","Mois"]], measures:[["count","Nombre de visites"]] },
  outputs: { label:"Outputs", dims:[["tag","Activity tag"],["month","Mois"],["adjust","Ajustement"]],
             measures:[["planned","Bénéficiaires planifiés"],["actual","Bénéficiaires atteints"]] },
  outcomes:{ label:"Outcomes", dims:[["indicator","Indicateur"],["adm1","Zone"],["round","Ronde"]],
             measures:[["value","Valeur moyenne"],["planned","Valeur planifiée moyenne"],["sample","Échantillon"]] },
};
/* Où la période mord réellement. Les sites sont un registre : leur nombre, leurs
   bénéficiaires et leur score de risque sont l'état du jour, pas une série
   mensuelle — seules les colonnes du plan de suivi en ont une. Annoncer « T2 »
   au-dessus d'un décompte de sites serait un décor, et un décor sur un chiffre
   se prend pour une mesure. */
const temporel = (source, measure) =>
  source==="sites" ? (measure==="planned" || measure==="done") : true;

function aggregate(db, source, dim, measure, periode){
  if(!SOURCES[source]) source = "sites";
  const p = normalisePeriode(periode, db.year);
  /* La grille mensuelle et les outputs ne descendent du serveur que pour
     l'exercice chargé : sur une autre année il n'y a rien à agréger, et
     réutiliser les chiffres de l'exercice sous une autre étiquette serait faux. */
  const grille = p.annee === db.year;
  const dansP = (mi) => moisDansPeriode(mi+1, p);   /* le magasin indexe les mois de 0 à 11 */
  const map = {};
  const push = (k,v) => { k = (k===undefined||k===null||k==="") ? "—" : k;
    map[k] = map[k] || { key:k, sum:0, n:0 }; map[k].sum += v; map[k].n++; };
  const surPeriode = (s,champ) => grille ? s.plan.filter((x,i)=>x[champ] && dansP(i)).length : 0;
  if(source==="sites") db.sites.forEach(s => {
    const v = measure==="count" ? 1 : measure==="beneficiaries" ? n(s.beneficiaries)
      : measure==="planned" ? surPeriode(s,"planned")
      : measure==="done" ? surPeriode(s,"done") : siteScore(s, db.weights, db).pct;
    push(s[dim], v); });
  else if(source==="visits") db.visits.forEach(v => {
    if(!dateDansPeriode(v.date, p)) return;
    push(dim==="month" ? MONTHS[anneeMoisDe(v.date).mois-1] : v[dim], 1); });
  else if(source==="outputs") db.outputs.forEach(o => {
    if(!grille || !dansP(o.month)) return;
    push(dim==="month" ? MONTHS[o.month] : o[dim], n(o[measure])); });
  else db.outcomes.forEach(o => {
    if(!dateDansPeriode(o.date, p)) return;
    push(o[dim], n(o[measure])); });
  return Object.values(map).map(x => ({ name:String(x.key),
    value: (measure==="score"||measure==="value"||measure==="planned"&&source==="outcomes") ? r1(x.sum/x.n) : x.sum }))
    .sort((a,b)=>b.value-a.value).slice(0,14);
}
function Viz({ db, set, periode, notify, can }){
  const [active,setActive] = useState(db.dashboards[0]?.id); const [edit,setEdit] = useState(null);
  const dash = db.dashboards.find(d=>d.id===active) || db.dashboards[0];
  const addDash = () => { const d = { id:uid("db"), name:"Nouvel onglet", widgets:[] };
    set(x=>{ x.dashboards.push(d); return x; }); setActive(d.id); };
  const saveW = (w) => { set(x=>{ const d=x.dashboards.find(y=>y.id===active);
      const i=d.widgets.findIndex(y=>y.id===w.id);
      if(i>=0) d.widgets[i]=w; else d.widgets.push({...w,id:uid("w")}); return x; });
    setEdit(null); notify("Visualisation enregistrée","ok"); };
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <Tabs className="flex-1" items={db.dashboards.map(d=>[d.id,d.name])} value={active} onChange={setActive} />
        {can("edit") && <Btn kind="sec" size="sm" icon={Plus} onClick={addDash}>Onglet</Btn>}
        {can("edit") && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ type:"bar", source:"sites", dim:"subOffice", measure:"count", title:"" })}>Visualisation</Btn>}
      </div>
      {dash?.widgets?.length ? (
        <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(400px,1fr))"}}>
          {dash.widgets.map(w=><Widget key={w.id} w={w} db={db} periode={periode}
            onEdit={can("edit")?()=>setEdit(w):null}
            onDelete={can("edit")?()=>set(x=>{ const d=x.dashboards.find(y=>y.id===active);
              d.widgets=d.widgets.filter(y=>y.id!==w.id); return x; }):null} />)}
        </div>
      ) : <Card><Empty icon={BarChart3} title="Onglet vide" text="Ajoutez une visualisation en choisissant une source, une dimension et une mesure."
            action={can("edit") && <Btn icon={Plus} onClick={()=>setEdit({ type:"bar", source:"sites", dim:"subOffice", measure:"count", title:"" })}>Ajouter</Btn>} /></Card>}
      <WidgetModal open={!!edit} w={edit} db={db} periode={periode} onClose={()=>setEdit(null)} onSave={saveW} />
    </>);
}
function Widget({ w, db, periode, onEdit, onDelete }){
  const src = SOURCES[w.source] ? w.source : "sites";
  const SRC = SOURCES[src];
  const dim = SRC.dims.some(d=>d[0]===w.dim) ? w.dim : SRC.dims[0][0];
  const measure = SRC.measures.some(m=>m[0]===w.measure) ? w.measure : SRC.measures[0][0];
  const p = normalisePeriode(periode, db.year);
  const data = useMemo(()=>aggregate(db, src, dim, measure, p),
    [db,src,dim,measure,p.annee,p.gran,p.valeur]);
  const dimLabel = (SRC.dims.find(d=>d[0]===dim)||[])[1] || dim;
  const mLabel = (SRC.measures.find(m=>m[0]===measure)||[])[1] || measure;
  /* Le sous-titre ne mentionne la période que là où elle a servi à restreindre :
     ailleurs, il dirait à l'utilisateur qu'il regarde un trimestre alors qu'il
     regarde tout. */
  const portee = temporel(src, measure) ? `${SRC.label} · ${libelleCourtPeriode(p)}` : SRC.label;
  return (
    <Card title={w.title || `${mLabel} par ${dimLabel.toLowerCase()}`} subtitle={portee}
      right={<>{onEdit && <button onClick={onEdit} className="text-slate-400 m-ico p-1"><Pencil size={13}/></button>}
        {onDelete && <button onClick={onDelete} className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={13}/></button>}</>}>
      {w.type==="table" ? (
        <TableWrap max="mh280">
          <thead><tr><Th>{dimLabel}</Th><Th num>{mLabel}</Th><Th num>Part</Th></tr></thead>
          <tbody>{data.map(d=>{ const tot=data.reduce((t,x)=>t+x.value,0);
            return <tr key={d.name} className="hover:bg-sky-50"><Td>{d.name}</Td><Td num>{fmt(d.value)}</Td>
              <Td num><div className="flex items-center gap-2 justify-end"><Bar2 value={pct(d.value,tot)} />{pct(d.value,tot)}%</div></Td></tr>; })}
          </tbody></TableWrap>
      ) : <ResponsiveContainer width="100%" height={250}>{chartEl(w.type, data)}</ResponsiveContainer>}
    </Card>);
}

/* La PALETTE de graphiques du tableau de bord modifiable. Chaque type produit
   son composant recharts à partir des mêmes données agrégées `[{name,value}]`.
   Ajouter un type ici l'ajoute partout : l'aperçu, le sélecteur et le rendu
   passent tous par cette seule fonction. */
const AXE_X = { dataKey:"name", tick:{fontSize:9.5,fill:C.t2}, axisLine:{stroke:"#e2e8ec"}, tickLine:false };
const AXE_Y = { tick:{fontSize:10,fill:C.t2}, axisLine:false, tickLine:false };
const TIP = { contentStyle:{fontSize:11,borderRadius:3}, formatter:v=>fmt(v) };
const GRID = <CartesianGrid strokeDasharray="3 3" stroke="#eef2f5" vertical={false} />;
const cellules = (data) => data.map((d,i)=><Cell key={i} fill={SERIES[i%SERIES.length]} />);

function TreemapCell({ x, y, width, height, index, name }){
  if(width<=0 || height<=0) return null;
  return (<g>
    <rect x={x} y={y} width={width} height={height} fill={SERIES[index%SERIES.length]} stroke="#fff" />
    {width>46 && height>18 && <text x={x+4} y={y+14} fontSize={10} fill="#fff">{String(name).slice(0,18)}</text>}
  </g>);
}

function chartEl(type, data){
  const m = { top:6, right:6, left:-14, bottom:0 };
  switch(type){
    case "barh":
      return (
        <BarChart data={data} layout="vertical" margin={{top:6,right:12,left:6,bottom:0}}>
          {GRID}
          <XAxis type="number" {...AXE_Y} />
          <YAxis type="category" dataKey="name" width={110} tick={{fontSize:9.5,fill:C.t2}} axisLine={false} tickLine={false} />
          <Tooltip {...TIP} />
          <Bar dataKey="value" radius={[0,2,2,0]}>{cellules(data)}</Bar>
        </BarChart>);
    case "line":
      return (
        <LineChart data={data} margin={m}>{GRID}<XAxis {...AXE_X} /><YAxis {...AXE_Y} /><Tooltip {...TIP} />
          <Line type="monotone" dataKey="value" stroke={C.brand} strokeWidth={2.4} dot={{r:3}} /></LineChart>);
    case "area":
      return (
        <AreaChart data={data} margin={m}>
          <defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.brand} stopOpacity={0.35} /><stop offset="100%" stopColor={C.brand} stopOpacity={0.02} />
          </linearGradient></defs>
          {GRID}<XAxis {...AXE_X} /><YAxis {...AXE_Y} /><Tooltip {...TIP} />
          <Area type="monotone" dataKey="value" stroke={C.brand} strokeWidth={2.2} fill="url(#gArea)" /></AreaChart>);
    case "pie":
    case "donut":
      return (
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" paddingAngle={1}
            innerRadius={type==="donut" ? "55%" : 0} outerRadius="80%">{cellules(data)}</Pie>
          <Tooltip {...TIP} /><Legend wrapperStyle={{fontSize:10.5}} /></PieChart>);
    case "radial":
      return (
        <RadialBarChart data={data} innerRadius="20%" outerRadius="95%" startAngle={90} endAngle={-270}>
          <RadialBar dataKey="value" background cornerRadius={2}>{cellules(data)}</RadialBar>
          <Tooltip {...TIP} /><Legend iconSize={8} wrapperStyle={{fontSize:10}} /></RadialBarChart>);
    case "radar":
      return (
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="#e2e8ec" /><PolarAngleAxis dataKey="name" tick={{fontSize:9.5,fill:C.t2}} />
          <PolarRadiusAxis tick={{fontSize:9,fill:C.t2}} /><Tooltip {...TIP} />
          <Radar dataKey="value" stroke={C.brand} fill={C.brand} fillOpacity={0.35} /></RadarChart>);
    case "treemap":
      return <Treemap data={data} dataKey="value" nameKey="name" stroke="#fff" content={<TreemapCell />} isAnimationActive={false} />;
    default: /* bar */
      return (
        <BarChart data={data} margin={m}>{GRID}
          <XAxis {...AXE_X} interval={0} angle={-18} textAnchor="end" height={52} />
          <YAxis {...AXE_Y} /><Tooltip {...TIP} />
          <Bar dataKey="value" radius={[2,2,0,0]}>{cellules(data)}</Bar></BarChart>);
  }
}

/* Les types offerts au constructeur, avec leur libellé. L'ordre est celui du
   menu déroulant. Une seule liste, réutilisée par le sélecteur. */
const TYPES_VIZ = [
  ["bar","Histogramme"], ["barh","Barres horizontales"], ["line","Courbe"],
  ["area","Aire"], ["pie","Circulaire"], ["donut","Anneau"],
  ["radial","Barres radiales"], ["radar","Radar"], ["treemap","Treemap"],
  ["table","Tableau croisé"],
];
function WidgetModal({ open, w, db, periode, onClose, onSave }){
  const [f,setF] = useState({});
  useEffect(()=>{ setF(w||{}); },[w]);
  if(!open) return null;
  const S = SOURCES[f.source] || SOURCES.sites;
  const u=(k,v)=>setF(p=>{ const x={...p,[k]:v};
    if(k==="source"){ x.dim = SOURCES[v].dims[0][0]; x.measure = SOURCES[v].measures[0][0]; } return x; });
  return (
    <Modal open onClose={onClose} wide title={w?.id?"Modifier la visualisation":"Nouvelle visualisation"}
      subtitle="Choisissez la source, la dimension d'analyse et la mesure"
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn><Btn icon={Save} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Titre" className="col-span-2"><Input value={f.title||""} onChange={e=>u("title",e.target.value)} /></Field>
        <Field label="Source"><Select value={f.source} onChange={e=>u("source",e.target.value)}
          options={Object.entries(SOURCES).map(([k,v])=>[k,v.label])} /></Field>
        <Field label="Type"><Select value={f.type} onChange={e=>u("type",e.target.value)}
          options={TYPES_VIZ} /></Field>
        <Field label="Dimension"><Select value={f.dim} onChange={e=>u("dim",e.target.value)} options={S.dims} /></Field>
        <Field label="Mesure"><Select value={f.measure} onChange={e=>u("measure",e.target.value)} options={S.measures} /></Field>
      </div>
      <div className="border border-slate-200 rounded p-3 bg-slate-50">
        <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Aperçu</div>
        <div className="bg-white rounded border border-slate-200"><Widget w={{...f,id:"prev"}} db={db} periode={periode} /></div>
      </div>
    </Modal>);
}

export { Analytics, CleanModal, Datasets, EtatMoteurs, ResultatExecution, SCRIPT_TPL, SOURCES, ScriptModal, Scripts, Viz, Widget, WidgetModal, aggregate, temporel };
