import { useEffect, useMemo, useState } from "react";
import { CalendarRange, Download, FileText, Filter, Sparkles, Table2 } from "lucide-react";
import { Badge, Btn, Card, Empty, Field, Input, Note, Select, TableWrap, Tabs, Td, Th, download, inputCls, toCSV } from "../components/ui.jsx";
import { LEVELS, fmt, n, pct, siteRequirement, siteScore } from "../lib/calc.js";
import { D_ADJUST } from "../lib/constants.js";
import { GRANULARITES, anneesDisponibles, bornesPeriode, dateDansPeriode, libelleCourtPeriode,
  libellePeriode, moisDansPeriode, moisEcoules, normalisePeriode, optionsValeur, periodeAnnee,
  suffixePeriode, valeurDefaut } from "../lib/periode.js";
import { urgentTasks } from "./Home.jsx";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Rapports ══════════════════

   L'année du rapport n'est pas `db.year`, et ce n'est pas un oubli.
   `db.year` est l'exercice que le serveur a chargé : il le recalcule à chaque
   /state (`new Date().getFullYear()`), il ne figure pas dans les collections
   synchronisées d'App.jsx, et c'est lui qui décide de ce que le serveur envoie
   — `site_months WHERE year=?`, `outputs WHERE year=?`. Y écrire le choix d'un
   utilisateur ne survivrait à aucun rechargement, et surtout renommerait
   l'exercice partout ailleurs (pied de page de la coquille, planification,
   données réelles) alors que les chiffres affichés resteraient ceux de
   l'exercice chargé. On le lit donc — c'est la valeur par défaut du sélecteur
   et la référence de ce qui est réellement disponible — sans jamais l'écrire. */
function Reports({ db, set, sub, setSub, notify, can }){
  const items = [["extract","Extraction ODK"],["build","Générateur de rapport"]];
  const [periode,setPeriode] = useState(() => periodeAnnee(db.year));
  return (
    <div className="space-y-4">
      <PageHead title="Rapports" text="Extraction filtrée des données ODK Central, puis composition d'un rapport infographique à partir des données brutes ou apurées." />
      <Tabs items={items} value={sub} onChange={setSub} />
      <BarrePeriode db={db} periode={periode} onChange={setPeriode} />
      {sub==="extract" && <Extract db={db} periode={periode} notify={notify} />}
      {sub==="build" && <ReportBuilder db={db} set={set} periode={periode} notify={notify} can={can} />}
    </div>);
}

/* Barre de période — même emplacement et même facture que celle de la
   cartographie : un bandeau clair en tête d'écran, des sélecteurs compacts
   alignés. Rapports et Analyses la partagent ; deux copies auraient fini par
   diverger, et l'écart se serait vu sur les exports avant de se voir à l'écran. */
function BarrePeriode({ db, periode, onChange, note }){
  const annees = useMemo(() => anneesDisponibles(db), [db]);
  const maj = (patch) => onChange(normalisePeriode({ ...periode, ...patch }, db.year));
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-slate-50">
        <span className="f11 font-bold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
          <CalendarRange size={13} /> Période</span>
        <Select value={periode.annee} onChange={e=>maj({ annee:Number(e.target.value),
          valeur: valeurDefaut(periode.gran, Number(e.target.value)) })}
          options={annees.map(a=>[a, `Année ${a}`])} className="mi-py1 mi-xs mi-wauto" />
        <Select value={periode.gran} onChange={e=>maj({ gran:e.target.value,
          valeur: valeurDefaut(e.target.value, periode.annee) })}
          options={GRANULARITES} className="mi-py1 mi-xs mi-wauto" />
        {periode.gran!=="annee" && (
          <Select value={periode.valeur} onChange={e=>maj({ valeur:Number(e.target.value) })}
            options={optionsValeur(periode.gran)} className="mi-py1 mi-xs mi-wauto" />)}
        <span className="w-px h-6 bg-slate-300 mx-1" />
        <Badge tone="b">{libellePeriode(periode)}</Badge>
        {/* Le magasin ne contient la grille mensuelle et les bénéficiaires
            planifiés que pour l'exercice chargé. Le taire ferait passer des
            blocs vides pour une perte de données. */}
        {periode.annee!==db.year && (
          <span className="f115 text-amber-800">
            Exercice chargé&nbsp;: {db.year}. Hors de cet exercice, seules les visites et les
            mesures de résultat sont disponibles.</span>)}
        {note && <span className="ml-auto f115 text-slate-500">{note}</span>}
      </div>
    </Card>);
}

function Extract({ db, periode, notify }){
  const [formId,setFormId] = useState(db.odkForms[0]?.id || "");
  const bornes = bornesPeriode(periode);
  const [from,setFrom] = useState(bornes.du); const [to,setTo] = useState(bornes.au);
  const [site,setSite] = useState(""); const [cols,setCols] = useState(null);
  /* La période règle les bornes de dates plutôt que de s'y ajouter : deux
     filtres temporels superposés, l'un nommé et l'autre chiffré, ne peuvent que
     se contredire sous les yeux de l'utilisateur. Les dates restent modifiables
     à la main pour les cas que le calendrier ne découpe pas. */
  useEffect(() => { const b = bornesPeriode(periode); setFrom(b.du); setTo(b.au); },
    [periode.annee, periode.gran, periode.valeur]);
  /* Ce que l'export doit annoncer : la période choisie tant qu'on ne l'a pas
     débordée à la main, sinon les dates réelles — un fichier ne doit pas porter
     le nom d'une période dont il ne contient plus le contour. */
  const surMesure = from!==bornes.du || to!==bornes.au;
  const porte = surMesure ? `du ${from||"…"} au ${to||"…"}` : libellePeriode(periode);
  const suffixe = surMesure ? `${from}_${to}` : suffixePeriode(periode);
  const form = db.odkForms.find(f=>f.id===formId);
  const all = form?.rows || [];
  const fields = Object.keys(all[0]||{});
  const selected = cols || fields;
  const rows = all.filter(r => {
    const d = r[form?.dateField] || r.visit_date || r.today;
    if(d && from && String(d) < from) return false;
    if(d && to && String(d) > to) return false;
    if(site && String(r[form?.siteField]||r.site_id||"") !== site) return false;
    return true; });
  const label = (c) => (form?.labels||{})[c] || c;
  return (
    <>
      <Note>L'extraction porte sur les données déjà récupérées du formulaire. Les libellés affichés proviennent
        du XLSForm joint dans <b>Paramètres → ODK Central</b> ; à défaut, les noms techniques des champs sont utilisés.</Note>
      <div className="grid gap-4" style={{gridTemplateColumns:"320px 1fr"}}>
        <Card title="Filtres">
          <Field label="Formulaire"><Select value={formId} onChange={e=>{setFormId(e.target.value);setCols(null);}}
            options={db.odkForms.map(f=>[f.id, f.name])} /></Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="Du"><Input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></Field>
            <Field label="Au"><Input type="date" value={to} onChange={e=>setTo(e.target.value)} /></Field>
          </div>
          <Field label="Site"><Select value={site} onChange={e=>setSite(e.target.value)} empty="Tous les sites"
            options={db.sites.map(s=>[s.id, `${s.id} — ${s.poi}`])} /></Field>
          <Field label="Colonnes à extraire">
            <div className="mh240 overflow-auto border border-slate-200 rounded p-2 space-y-1">
              {fields.map(c=>(
                <label key={c} className="flex items-center gap-2 f115">
                  <input type="checkbox" checked={selected.includes(c)}
                    onChange={e=>setCols(e.target.checked ? [...selected,c] : selected.filter(x=>x!==c))} />
                  <span className="truncate" title={label(c)}>{label(c)}</span></label>))}
            </div></Field>
          <div className="flex gap-2">
            {/* Le CSV reste un jeu de données : y glisser un en-tête de rapport
                casserait tout ce qui le relit. La portée part donc dans le nom
                du fichier, et le JSON — lui destiné à être lu tel quel — la
                porte dans son enveloppe. */}
            <Btn size="sm" icon={Download} disabled={!rows.length}
              onClick={()=>{ download(`extraction_${form?.formId}_${suffixe}.csv`, toCSV(rows, selected), "text/csv");
                notify(`Extraction CSV téléchargée — ${porte}`,"ok"); }}>CSV</Btn>
            <Btn size="sm" kind="sec" icon={Download} disabled={!rows.length}
              onClick={()=>{ download(`extraction_${form?.formId}_${suffixe}.json`, JSON.stringify({
                  formulaire: form?.name || "", formId: form?.formId || "", periode: porte,
                  site: site || "tous les sites", du: from, au: to,
                  extraitLe: new Date().toISOString(), colonnes: selected,
                  lignes: rows.map(r => Object.fromEntries(selected.map(c=>[c, r[c] ?? null]))),
                }, null, 2), "application/json");
                notify(`Extraction JSON téléchargée — ${porte}`,"ok"); }}>JSON</Btn>
          </div>
        </Card>
        <Card flush title="Aperçu de l'extraction"
          subtitle={`${fmt(rows.length)} lignes sur ${fmt(all.length)} · ${selected.length} colonnes · ${porte}`}>
          {rows.length ? (
            <TableWrap max="mh62">
              <thead><tr>{selected.map(c=><Th key={c}>{label(c)}</Th>)}</tr></thead>
              <tbody>{rows.slice(0,100).map((r,i)=>(
                <tr key={i} className="hover:bg-sky-50">{selected.map(c=>
                  <Td key={c} className={String(r[c]??"")===""?"text-slate-300":""}>{String(r[c]??"∅")}</Td>)}</tr>))}</tbody>
            </TableWrap>
          ) : <Empty icon={Filter} title="Aucune ligne" text="Élargissez la période ou choisissez un autre formulaire." />}
        </Card>
      </div>
    </>);
}

/* ── Générateur de rapport infographique ── */
const BLOCKS = [
  ["kpi","Chiffres clés","Exigence de suivi, sites actifs, bénéficiaires, taux de réalisation"],
  ["coverage","Couverture par bureau","Sites actifs, planifiés et suivis, avec le taux de réalisation"],
  ["activity","Plan et réalisé par activité","Comparaison mensuelle des visites planifiées et réalisées"],
  ["outputs","Bénéficiaires planifiés et atteints","Cumul par catégorie d'activité avec les ajustements"],
  ["outcomes","Indicateurs de résultat","Référence, dernière mesure et valeur planifiée"],
  ["sites","Liste des sites","Tableau détaillé des sites avec priorité et couverture"],
  ["tasks","Points d'attention","Échéances manquées et actions à mener"],
];
/* computeMMR raisonne à l'exercice : il proratise l'exigence annuelle sur les
   mois écoulés de l'année et compte les visites de cette année. La règle est la
   même ici, restreinte aux mois de la période — sur une année entière, les deux
   donnent le même chiffre, ce qui est la condition pour que le rapport ne
   contredise pas l'accueil. Elle ne pouvait pas être ajoutée à calc.js sans
   changer la signature qu'utilisent déjà quatre écrans. */
function mmrPeriode(db, p){
  const ecoules = moisEcoules(p);
  let required = 0, done = 0, actifs = 0, visites = 0;
  db.sites.filter(s=>s.status!=="Inactive").forEach(s => {
    actifs++;
    required += siteRequirement(db, s).required * (ecoules/12);
    const v = db.visits.filter(x => x.siteId===s.id && dateDansPeriode(x.date, p)).length;
    done += v; if(v>0) visites++;
  });
  return { pct: pct(done, Math.round(required)), required: Math.round(required), done,
           activeSites: actifs, visitedSites: visites, coverage: pct(visites, actifs), elapsed: ecoules };
}

function reportData(db, periode){
  const p = normalisePeriode(periode, db.year);
  /* Le magasin indexe les mois de 0 à 11, le modèle de période de 1 à 12. */
  const dansP = (mi) => moisDansPeriode(mi+1, p);
  /* La grille mensuelle et les outputs ne descendent du serveur que pour
     l'exercice chargé. Sur une autre année, ils ne sont pas faux : ils sont
     absents. Recycler les chiffres de l'exercice sous une autre étiquette
     serait la seule erreur vraiment grave que ce filtre puisse commettre. */
  const grille = p.annee === db.year;
  const cumul = (liste, champ) => grille
    ? liste.reduce((t,s)=>t+s.plan.filter((x,i)=>x[champ] && dansP(i)).length, 0) : 0;

  const mmr = mmrPeriode(db, p);
  const sites = db.sites;
  const active = sites.filter(s=>s.status!=="Inactive");
  const planned = cumul(sites, "planned");
  const done = cumul(sites, "done");
  const libelle = libellePeriode(p);
  return {
    periode: p, libelle, grille,
    /* Le troisième champ dit sur quoi porte le chiffre : sans lui, « Sites
       actifs » et « Visites réalisées » se lisent comme deux mesures de la même
       période, alors que l'une est un état de registre et l'autre un flux. */
    mmr, kpis: [
      ["Exigence minimale de suivi", mmr.pct+" %", libelle],
      ["Sites actifs", fmt(active.length), "registre à ce jour"],
      ["Bénéficiaires ciblés", fmt(active.reduce((t,s)=>t+n(s.beneficiaries),0)), "registre à ce jour"],
      ["Visites planifiées", grille?fmt(planned):"—", libelle],
      ["Visites réalisées", grille?fmt(done):"—", libelle],
      ["Taux de réalisation", grille?pct(done,planned)+" %":"—", libelle],
    ],
    coverage: db.lists.offices.map(o => { const g=sites.filter(s=>s.subOffice===o);
      const p2=cumul(g,"planned"); const d=cumul(g,"done");
      return { office:o, actifs:g.filter(s=>s.status!=="Inactive").length, planifie:p2, realise:d, taux:pct(d,p2) };
    }).filter(x=>x.actifs),
    activity: db.lists.tags.map(t => { const g=sites.filter(s=>s.activityTag===t.code);
      const plan=cumul(g,"planned"); const real=cumul(g,"done");
      return { tag:t.code, label:t.label, plan, real, taux:pct(real,plan) }; }).filter(x=>x.plan||x.real),
    outputs: db.lists.tags.map(t => {
      const g = grille ? db.outputs.filter(o=>o.tag===t.code && dansP(o.month)) : [];
      return { tag:t.code, planned:g.reduce((a,o)=>a+n(o.planned),0), actual:g.reduce((a,o)=>a+n(o.actual),0),
        adjust:[...new Set(g.map(o=>o.adjust).filter(a=>a&&a!=="none"))]
          .map(a=>(D_ADJUST.find(x=>x[0]===a)||[])[1]).join(", ") }; }).filter(x=>x.planned||x.actual),
    outcomes: db.indicators.map(ind => {
      const toutes = db.outcomes.filter(o=>o.indicator===ind.id);
      const vals = toutes.filter(o=>dateDansPeriode(o.date, p));
      const last = vals.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
      /* La référence est par nature antérieure à la période mesurée : la
         restreindre effacerait le point de comparaison qu'on vient chercher. */
      const base = toutes.find(v=>/référence|baseline/i.test(v.round));
      return { id:ind.id, name:ind.name, unit:ind.unit, dir:ind.dir, base:base?base.value:null,
        last:last?last.value:null, planned:last?n(last.planned)||ind.target:ind.target }; }).filter(x=>x.last!==null),
    sites: sites.map(s => ({ id:s.id, poi:s.poi, office:s.subOffice, adm:[s.adm1,s.adm2,s.adm3].filter(Boolean).join(", "),
      tag:s.activityTag, status:s.status, benef:s.beneficiaries, prio:LEVELS[siteScore(s, db.weights, db).level].label,
      planned:cumul([s],"planned"), done:cumul([s],"done") })),
    /* Les points d'attention se mesurent par rapport à aujourd'hui — échéances
       dépassées, intervalles franchis, validations en attente. Les rejouer sur
       un trimestre passé n'a pas de sens : la liste est datée du tirage, et le
       rapport le dit plutôt que de faire semblant de la filtrer. */
    tasks: urgentTasks(db).slice(0,15),
  };
}
function reportHTML(db, tpl, periode){
  const D = reportData(db, periode);
  const esc = (v) => String(v??"").replace(/[&<>"]/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const bar = (v,tone) => `<div class="bar"><i class="${tone}" style="width:${Math.min(100,v)}%"></i></div>`;
  const tone = v => v>=80?"ok":v>=50?"warn":"bad";
  /* Chaque bloc annonce sa propre portée. Un lecteur qui tombe sur la page 3
     d'un rapport imprimé n'a plus l'en-tête sous les yeux, et rien ne
     distinguerait alors un tableau restreint au trimestre d'un tableau qui
     couvre tout l'exercice. */
  const h2 = (titre, portee) => `<h2>${esc(titre)}${portee?`<span class="per">${esc(portee)}</span>`:""}</h2>`;
  /* Un tableau vide sans explication se lit comme une panne. */
  const absent = `<p class="muted">Aucune donnée mensuelle pour cette période : le serveur ne
    transmet la grille de suivi et les bénéficiaires planifiés que pour l'exercice ${esc(db.year)}.</p>`;
  const corps = (lignes, table) => lignes.length ? table : (D.grille ? `<p class="muted">Aucune ligne sur la période.</p>` : absent);
  const intro = (tpl.intro||"").replace(/\{(\w+)\}/g, (_,k)=>({ org:db.settings.org, periode:D.libelle,
    annee:D.periode.annee, unite:db.settings.unit })[k] ?? `{${k}}`);
  const B = {
    kpi: () => `<section>${h2("Chiffres clés", D.libelle)}<div class="kpis">${
      D.kpis.map(([l,v,s])=>`<div class="kpi"><span>${esc(l)}</span><b>${esc(v)}</b>${
        s?`<em>${esc(s)}</em>`:""}</div>`).join("")}</div></section>`,
    coverage: () => `<section>${h2("Couverture par bureau", D.libelle)}${corps(D.coverage,
      `<table><thead><tr><th>Bureau</th><th class="n">Sites actifs</th>
      <th class="n">Planifiées</th><th class="n">Réalisées</th><th>Taux</th></tr></thead><tbody>${
      D.coverage.map(r=>`<tr><td>${esc(r.office)}</td><td class="n">${r.actifs}</td><td class="n">${r.planifie}</td>
        <td class="n">${r.realise}</td><td>${bar(r.taux,tone(r.taux))}<span class="pc">${r.taux} %</span></td></tr>`).join("")}
      </tbody></table>`)}</section>`,
    activity: () => `<section>${h2("Plan et réalisé par activité", D.libelle)}${corps(D.activity,
      `<table><thead><tr><th>Activité</th>
      <th class="n">Planifiées</th><th class="n">Réalisées</th><th>Taux</th></tr></thead><tbody>${
      D.activity.map(r=>`<tr><td><b>${esc(r.tag)}</b> ${esc(r.label)}</td><td class="n">${r.plan}</td>
        <td class="n">${r.real}</td><td>${bar(r.taux,tone(r.taux))}<span class="pc">${r.taux} %</span></td></tr>`).join("")}
      </tbody></table>`)}</section>`,
    outputs: () => `<section>${h2("Bénéficiaires planifiés et atteints", D.libelle)}${corps(D.outputs,
      `<table><thead><tr><th>Activité</th>
      <th class="n">Planifiés</th><th class="n">Atteints</th><th>Réalisation</th><th>Ajustements</th></tr></thead><tbody>${
      D.outputs.map(r=>{ const p=pct(r.actual,r.planned);
        return `<tr><td><b>${esc(r.tag)}</b></td><td class="n">${fmt(r.planned)}</td><td class="n">${fmt(r.actual)}</td>
        <td>${bar(p,tone(p))}<span class="pc">${p} %</span></td><td class="muted">${esc(r.adjust||"—")}</td></tr>`; }).join("")}
      </tbody></table>`)}</section>`,
    outcomes: () => `<section>${h2("Indicateurs de résultat", `dernière mesure sur ${D.libelle}`)}${
      D.outcomes.length ? `<table><thead><tr><th>Indicateur</th><th class="n">Référence</th>
      <th class="n">Dernière mesure</th><th class="n">Planifié</th><th>Sens</th></tr></thead><tbody>${
      D.outcomes.map(r=>{ const ok = r.dir==="up" ? r.last>=r.planned : r.last<=r.planned;
        return `<tr><td>${esc(r.name)}</td><td class="n">${r.base??"—"}</td>
        <td class="n"><b class="${ok?"good":"bad"}">${r.last}</b></td><td class="n">${r.planned}</td>
        <td class="muted">${r.dir==="up"?"à maximiser":"à minimiser"}</td></tr>`; }).join("")}
      </tbody></table>` : `<p class="muted">Aucune mesure de résultat collectée sur cette période.</p>`}</section>`,
    sites: () => `<section>${h2("Sites", `colonnes Plan. et Réal. sur ${D.libelle}`)}<table><thead><tr><th>ID</th><th>Point d'intérêt</th><th>Bureau</th>
      <th>Emplacement</th><th>Activité</th><th class="n">Bénéf.</th><th>Priorité</th><th class="n">Plan.</th><th class="n">Réal.</th></tr></thead><tbody>${
      D.sites.map(s=>`<tr><td class="mono">${esc(s.id)}</td><td>${esc(s.poi)}</td><td>${esc(s.office)}</td>
        <td class="muted">${esc(s.adm)}</td><td>${esc(s.tag)}</td><td class="n">${fmt(s.benef)}</td>
        <td>${esc(s.prio)}</td><td class="n">${s.planned}</td><td class="n">${s.done}</td></tr>`).join("")}
      </tbody></table></section>`,
    /* Pas de portée annoncée ici, et c'est délibéré : ces alertes se mesurent
       par rapport à aujourd'hui, pas à la période choisie. */
    tasks: () => `<section>${h2("Points d'attention", "état au jour du tirage")}<ul class="tasks">${
      D.tasks.map(t=>`<li><span class="pill ${t.prio}">${esc(t.prio)}</span> <b>${esc(t.kind)}</b> — ${esc(t.text)}</li>`).join("")}
      </ul></section>`,
  };
  const body = (tpl.blocks||[]).map(b => B[b] ? B[b]() : "").join("");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${esc(tpl.name)} — ${esc(db.settings.org)}</title>
<style>
:root{--b:#007DBC;--bd:#085387;--ok:#689e18;--warn:#F7B825;--bad:#c5192d;--l:#e2e8ec;--t2:#5a6872}
*{box-sizing:border-box}body{margin:0;font-family:'Open Sans',system-ui,-apple-system,Segoe UI,sans-serif;
color:#031c2d;background:#f2f5f7;font-size:13px;line-height:1.55}
.page{max-width:920px;margin:0 auto;background:#fff}
header.hd{background:linear-gradient(140deg,var(--bd),#19486a);color:#fff;padding:34px 40px}
header.hd h1{margin:0;font-size:27px;font-weight:300;letter-spacing:-.02em}
header.hd .meta{opacity:.82;font-size:12.5px;margin-top:8px}
.intro{padding:22px 40px;border-bottom:1px solid var(--l);white-space:pre-wrap;color:var(--t2)}
section{padding:24px 40px;border-bottom:1px solid var(--l)}
h2{font-size:15px;margin:0 0 14px;color:var(--bd);text-transform:uppercase;letter-spacing:.06em}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--l);border:1px solid var(--l)}
.kpi{background:#fff;padding:16px 18px}
.kpi span{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--t2);font-weight:700}
.kpi b{display:block;font-size:27px;font-weight:300;margin-top:6px}
.kpi em{display:block;font-style:normal;font-size:10.5px;color:var(--t2);margin-top:4px}
h2 .per{float:right;text-transform:none;letter-spacing:0;font-weight:400;font-size:11px;color:var(--t2)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--t2);
padding:7px 9px;border-bottom:2px solid var(--l);background:#f8fafc}
td{padding:7px 9px;border-bottom:1px solid #eef2f5}
.n{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:var(--t2)}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--t2)}
.good{color:var(--ok)}.bad{color:var(--bad)}
.bar{display:inline-block;width:74px;height:6px;background:var(--l);border-radius:3px;overflow:hidden;vertical-align:middle}
.bar i{display:block;height:100%;background:var(--b)}.bar i.ok{background:var(--ok)}
.bar i.warn{background:var(--warn)}.bar i.bad{background:var(--bad)}
.pc{margin-left:8px;font-variant-numeric:tabular-nums;font-size:11.5px}
.tasks{margin:0;padding:0;list-style:none}.tasks li{padding:7px 0;border-bottom:1px solid #eef2f5}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10.5px;font-weight:700;margin-right:6px}
.pill.haute{background:#fbe9eb;color:#8b1220}.pill.moyenne{background:#fdf4e0;color:#7a5504}
.pill.basse{background:#eef2f5;color:var(--t2)}
footer.ft{padding:18px 40px;font-size:11px;color:var(--t2)}
@media print{body{background:#fff}.page{max-width:none}section{page-break-inside:avoid}}
</style></head><body><div class="page">
<header class="hd"><h1>${esc(tpl.name)}</h1>
<div class="meta">${esc(db.settings.org)} — ${esc(db.settings.unit)} · ${esc(D.libelle)} · établi le ${new Date().toLocaleDateString("fr-FR")}</div></header>
${intro ? `<div class="intro">${esc(intro)}</div>` : ""}
${body}
<footer class="ft">Document produit par MEMS · ${esc(D.libelle)}${
  D.grille ? "" : ` · exercice chargé ${esc(db.year)}`}</footer>
</div></body></html>`;
}

/* Le rapport en tableur. Un rapport exporté doit dire sur quoi il porte : ici
   l'en-tête le dit avant la première ligne de données. Ce n'est pas un jeu de
   données — les tableaux s'y succèdent, séparés, comme dans le document
   imprimé — donc un préambule ne casse rien qu'on veuille préserver. */
function reportCSV(db, tpl, periode){
  const D = reportData(db, periode);
  /* toCSV ouvre par la marque d'ordre des octets, qui n'a de sens qu'en tête de
     fichier : elle saute pour toutes les sections suivantes. */
  const table = (rows, cols) => toCSV(rows, cols).replace(/^﻿/, "");
  const parts = [table([
    { champ:"Rapport", valeur:tpl.name },
    { champ:"Organisation", valeur:db.settings.org },
    { champ:"Unité", valeur:db.settings.unit },
    { champ:"Période", valeur:D.libelle },
    { champ:"Exercice chargé", valeur:db.year },
    { champ:"Établi le", valeur:new Date().toLocaleDateString("fr-FR") },
  ], ["champ","valeur"])];
  const bloc = (titre, rows, cols) => { if(!rows.length) return;
    parts.push(`\n${titre}\n${table(rows, cols)}`); };
  const B = {
    kpi: () => bloc(`Chiffres clés — ${D.libelle}`,
      D.kpis.map(([indicateur,valeur,portee])=>({ indicateur, valeur, portee })),
      ["indicateur","valeur","portee"]),
    coverage: () => bloc(`Couverture par bureau — ${D.libelle}`, D.coverage,
      ["office","actifs","planifie","realise","taux"]),
    activity: () => bloc(`Plan et réalisé par activité — ${D.libelle}`, D.activity,
      ["tag","label","plan","real","taux"]),
    outputs: () => bloc(`Bénéficiaires planifiés et atteints — ${D.libelle}`, D.outputs,
      ["tag","planned","actual","adjust"]),
    outcomes: () => bloc(`Indicateurs de résultat — dernière mesure sur ${D.libelle}`, D.outcomes,
      ["id","name","unit","base","last","planned","dir"]),
    sites: () => bloc(`Sites — colonnes planned/done sur ${D.libelle}`, D.sites,
      ["id","poi","office","adm","tag","status","benef","prio","planned","done"]),
    tasks: () => bloc("Points d'attention — état au jour du tirage", D.tasks, ["prio","kind","text","ctx"]),
  };
  (tpl.blocks||[]).forEach(b => B[b] && B[b]());
  return "﻿" + parts.join("\n");
}
function ReportBuilder({ db, set, periode, notify, can }){
  const [tplId,setTplId] = useState(db.reportTemplates[0]?.id || "");
  const [html,setHtml] = useState("");
  const tpl = db.reportTemplates.find(t=>t.id===tplId) || db.reportTemplates[0];
  const toggle = (b) => set(d => { const t=d.reportTemplates.find(x=>x.id===tplId); if(!t) return d;
    t.blocks = t.blocks.includes(b) ? t.blocks.filter(x=>x!==b) : [...t.blocks, b]; return d; });
  const build = () => { if(!tpl) return; setHtml(reportHTML(db, tpl, periode)); notify(`Rapport généré — ${libellePeriode(periode)}`,"ok"); };
  /* L'aperçu se vide dès que la période change : garder à l'écran un document
     tiré sur une autre période, sous une barre qui en annonce une nouvelle,
     c'est exactement la confusion que ce chantier vient corriger. */
  useEffect(() => { setHtml(""); }, [periode.annee, periode.gran, periode.valeur, tplId]);
  const fichier = `${(tpl?.name||"rapport").replace(/\W+/g,"_")}_${suffixePeriode(periode)}`;
  return (
    <div className="grid gap-4" style={{gridTemplateColumns:"340px 1fr"}}>
      <div className="space-y-4">
        <Card title="Modèle et période">
          <Field label="Modèle de rapport"><Select value={tplId} onChange={e=>setTplId(e.target.value)}
            options={db.reportTemplates.map(t=>[t.id,t.name])} /></Field>
          <Field label="Période du rapport" hint="Se règle dans la barre en haut de l'écran. Le libellé part dans le document et dans les exports.">
            <div className={inputCls + " bg-slate-50 text-slate-700"}>{libellePeriode(periode)}</div></Field>
          <p className="f115 text-slate-500 leading-relaxed mb-3">
            Les modèles, leur texte d'introduction et leurs champs dynamiques se gèrent dans
            Paramètres → Modèles de rapport. Le champ <b>{"{periode}"}</b> de l'introduction reprend le libellé ci-dessus.</p>
          <div className="flex flex-wrap gap-2">
            <Btn icon={Sparkles} onClick={build}>Générer</Btn>
            <Btn kind="sec" icon={Download} disabled={!html}
              onClick={()=>{ download(`${fichier}.html`, html, "text/html"); notify("Rapport téléchargé","ok"); }}>HTML</Btn>
            <Btn kind="sec" icon={Table2} disabled={!tpl}
              onClick={()=>{ download(`${fichier}.csv`, reportCSV(db, tpl, periode), "text/csv");
                notify(`Données du rapport exportées — ${libellePeriode(periode)}`,"ok"); }}>CSV</Btn>
          </div>
        </Card>
        <Card title="Sections du rapport" subtitle="Cochez les blocs à inclure">
          {BLOCKS.map(([b,l,d])=>(
            <label key={b} className="flex items-start gap-2.5 py-2 border-b border-slate-100 last:border-0 cursor-pointer">
              <input type="checkbox" className="mt-0.5" checked={!!tpl?.blocks?.includes(b)} disabled={!can("edit")} onChange={()=>toggle(b)} />
              <span><span className="f13 font-medium text-slate-800 block">{l}</span>
                <span className="f115 text-slate-500">{d}</span></span></label>))}
        </Card>
      </div>
      <Card flush title="Aperçu du rapport"
        subtitle={html ? `Rendu final sur ${libelleCourtPeriode(periode)}, prêt à imprimer ou à partager`
                       : `Choisissez les sections puis générez — ${libellePeriode(periode)}`}>
        {html
          ? <iframe title="apercu" srcDoc={html} className="w-full mh68 border-0" style={{height:"70vh"}} />
          : <Empty icon={FileText} title="Aucun rapport généré"
              text="Sélectionnez un modèle et les sections souhaitées, puis lancez la génération pour obtenir un document mis en page." />}
      </Card>
    </div>);
}

export { BLOCKS, BarrePeriode, Extract, ReportBuilder, Reports, mmrPeriode, reportCSV, reportData, reportHTML };
