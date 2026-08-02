import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Activity, AlertTriangle, BarChart3, ChevronRight, ClipboardCheck, Crosshair,
         FileSpreadsheet, Gauge, Layers, MapPin, PanelLeftClose, PanelLeftOpen, Search,
         ShieldAlert, ShieldCheck } from "lucide-react";
import { Empty, Select } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { clsx, computeMMR, fmt, pct, siteScore } from "../lib/calc.js";
import { C } from "../lib/constants.js";
import { AnalyseProcessus } from "./AnalyseProcessus.jsx";

/* ══════════════════ Tableau de bord — cockpit de suivi de processus ══════════════════
   « Un bailleur, le management vont le regarder ; on l'affiche en permanence sur un
   écran. » — d'où une disposition en COCKPIT, sans toucher à l'en-tête de l'appli :

     · une navigation LATÉRALE gauche, rétractable, qui libère le centre ;
     · une CARTE de Madagascar au centre, colorée par état (rouge = alerte, vert =
       normal), lue d'un coup d'œil à distance ;
     · un panneau d'ALERTES à droite — retards, validations, GPS, intégrité — avec un
       bouton d'action qui mène droit à l'écran qui résout ;
     · des jauges circulaires et des sparklines, compactes, pour ne pas surcharger ;
     · la PERFORMANCE des indicateurs de suivi de processus EXTRAITS DES XLSForms,
       calculée sur la donnée réelle (couverture, conformité).

   Tout est lu des DONNÉES RÉELLES, cloisonné comme le reste. Palette bleu/gris +
   accents sémantiques. */

const VERT = C.ok, AMBRE = C.warn, ROUGE = C.bad, NEUTRE = "#cbd5e1";

/* La grammaire de couleur de l'état : une part « à jour » élevée est verte, faible
   est rouge ; sans site, gris. */
const bandePart = (part, sites) => sites === 0 ? { c:NEUTRE, nom:"Sans site", t:"n" }
  : part >= 70 ? { c:VERT,  nom:"Normal",    t:"g" }
  : part >= 40 ? { c:AMBRE, nom:"Attention", t:"y" }
  : { c:ROUGE, nom:"Alerte", t:"r" };

const bandePct = (p) => p >= 75 ? { c:VERT, l:"Bon" } : p >= 50 ? { c:AMBRE, l:"À surveiller" } : { c:ROUGE, l:"Critique" };

const norm = (s) => String(s || "").toLowerCase().normalize("NFD")
  .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const jours = (d) => { if(!d) return Infinity; const t = new Date(d).getTime();
  return Number.isFinite(t) ? (Date.now() - t) / 86400000 : Infinity; };
const estAJour = (s) => jours(s.lastVisit || s.lastVisitEffective) <= 90;
const aProbleme = (s) => (s.fraud > 0) || (s.issueCFM > 0) || (s.issueReport > 0) || (s.issueIPM > 0);

/* ── Jauge circulaire (SVG maison, plus légère qu'un graphe) ── */
function Jauge({ value = 0, size = 96, stroke = 9, color = C.brand, label, sub }){
  const v = Math.min(100, Math.max(0, Math.round(value)));
  const r = (size - stroke) / 2, circ = 2 * Math.PI * r, off = circ * (1 - v / 100);
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width:size, height:size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#eef2f6" strokeWidth={stroke} />
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
            strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round"
            style={{ transition:"stroke-dashoffset .6s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="f22 font-extrabold leading-none tabular-nums" style={{ color }}>{v}<span className="f11">%</span></span>
        </div>
      </div>
      {label && <div className="f105 font-bold uppercase tracking-wide text-slate-500 mt-1.5 text-center leading-tight">{label}</div>}
      {sub && <div className="f105 text-slate-400 text-center leading-tight">{sub}</div>}
    </div>);
}

/* ── Sparkline (SVG maison) ── */
function Sparkline({ data = [], color = C.brand, w = 132, h = 34 }){
  if(!data.length) return null;
  const max = Math.max(...data, 1);
  const pas = data.length > 1 ? w / (data.length - 1) : w;
  const pts = data.map((v, i) => [i * pas, h - (v / max) * (h - 4) - 2]);
  const ligne = pts.map(p => p.join(",")).join(" ");
  const aire = `0,${h} ` + ligne + ` ${w},${h}`;
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polygon points={aire} fill={color} opacity="0.10" />
      <polyline points={ligne} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.6" fill={color} />
    </svg>);
}

/* ── Carte de Madagascar, colorée par état (Leaflet sans tuiles) ── */
function CarteEtat({ parRegion, onRegion, selection }){
  const boxRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null);
  const [etat, setEtat] = useState({ chargement:true, erreur:"", regions:0 });

  useEffect(() => {
    if(!boxRef.current || mapRef.current || !L.Browser.svg) return;
    const map = L.map(boxRef.current, { zoomControl:true, attributionControl:false,
      scrollWheelZoom:true, doubleClickZoom:true }).setView([-18.9, 46.9], 5);
    mapRef.current = map; layerRef.current = L.layerGroup().addTo(map);
    return () => { try{ map.remove(); }catch(e){} mapRef.current = null; };
  }, []);

  /* Les contours des régions (adm1) : ~23 unités, légères. Le fond de carte
     (tuiles) est bloqué par le proxy — Leaflet dessine les polygones sur fond vide. */
  useEffect(() => {
    let vivant = true;
    (async () => {
      try{
        const geo = await api.geoGeometry("?level=adm1&limit=120");
        if(!vivant) return;
        const feats = geo?.features || [];
        setEtat({ chargement:false, erreur: feats.length ? "" : "Aucun contour de région chargé.", regions:feats.length });
        dessiner(feats);
        if(geo.extent){ const e = geo.extent;
          try{ mapRef.current.fitBounds([[e.south, e.west], [e.north, e.east]], { padding:[12,12] }); }catch(_){}
        }
      }catch(e){ if(vivant) setEtat({ chargement:false, erreur:e.message, regions:0 }); }
    })();
    return () => { vivant = false; };
  }, []);

  /* Recolorer quand la mesure par région ou la sélection changent, sans re-tirer
     les contours. On garde les features en mémoire. */
  const featsRef = useRef([]);
  const dessiner = (feats) => { if(feats) featsRef.current = feats;
    const g = layerRef.current; if(!g) return; g.clearLayers();
    for(const f of featsRef.current){
      const nom = f.properties?.name || "";
      const m = parRegion.get(norm(nom)) || { total:0, aJour:0 };
      const part = m.total ? Math.round(m.aJour / m.total * 100) : 0;
      const b = bandePart(part, m.total);
      const sel = selection && norm(selection) === norm(nom);
      const couche = L.geoJSON(f, { style:{ color: sel ? C.brandD : "#ffffff",
        weight: sel ? 2.6 : 1, opacity:1, fillColor:b.c, fillOpacity: m.total ? 0.72 : 0.25 } });
      couche.on("click", () => onRegion?.(sel ? "" : nom));
      couche.bindTooltip(
        `<b>${nom}</b><br>${m.total ? `${m.total} site(s) · ${part}% à jour · ${b.nom}` : "aucun site"}`,
        { sticky:true });
      g.addLayer(couche);
    }
  };
  useEffect(() => { dessiner(); }, [parRegion, selection]);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden border border-slate-200 bg-[#eaf1f6]">
      <div ref={boxRef} className="absolute inset-0" />
      {/* Légende */}
      <div className="absolute left-3 bottom-3 z-[500] bg-white/95 rounded-xl shadow-sm border border-slate-200 px-3 py-2">
        <div className="f10 font-bold uppercase tracking-wide text-slate-500 mb-1">État du suivi par région</div>
        <div className="flex items-center gap-3 flex-wrap f105">
          {[[VERT,"Normal"],[AMBRE,"Attention"],[ROUGE,"Alerte"],[NEUTRE,"Sans site"]].map(([c,l])=>(
            <span key={l} className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{background:c}} />{l}</span>))}
        </div>
      </div>
      {(etat.chargement || etat.erreur) && (
        <div className="absolute inset-0 grid place-items-center z-[500] pointer-events-none">
          <div className="bg-white/90 rounded-xl px-4 py-2 f115 text-slate-500 shadow-sm">
            {etat.chargement ? "Chargement de la carte…" : etat.erreur}</div>
        </div>)}
    </div>);
}

/* ── Panneau d'alertes (droite) ── */
function CarteAlerte({ a }){
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 flex items-start gap-3"
      style={{ borderLeft:`4px solid ${a.c}` }}>
      <span className="w-8 h-8 rounded-lg grid place-items-center shrink-0 mt-0.5" style={{ background:a.c+"1a", color:a.c }}>
        <a.ic size={16} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="f26 font-extrabold leading-none tabular-nums" style={{ color:a.c }}>{fmt(a.n)}</span>
          <span className="f125 font-semibold text-slate-800 leading-tight">{a.titre}</span>
        </div>
        <div className="f11 text-slate-500 leading-snug mt-0.5">{a.detail}</div>
        {a.action && (
          <button onClick={a.action}
            className="mt-1.5 inline-flex items-center gap-1 f11 font-semibold hover:underline" style={{ color:a.c }}>
            {a.cta || "Traiter"} <ChevronRight size={12} /></button>)}
      </div>
    </div>);
}

function ProcessDashboard({ db, go, notify }){
  const [annee, setAnnee] = useState(db.year);
  const [vue, setVue] = useState("synthese");     /* synthese | carte | processus | activites | controle */
  const [replie, setReplie] = useState(false);
  const [region, setRegion] = useState("");        /* région sélectionnée sur la carte */

  const tags = db.lists?.tags || [];
  const activiteLabel = (tag) => (db.activities || []).find(a => a.tag === tag)?.name || tag;
  const mmr = useMemo(() => computeMMR(db, annee), [db, annee]);
  const actifs = useMemo(() => db.sites.filter(s => s.status !== "Inactive"), [db.sites]);

  /* Mesure par région pour la carte et le filtre d'alertes. */
  const parRegion = useMemo(() => {
    const m = new Map();
    for(const s of actifs){ const k = norm(s.adm1 || ""); if(!k) continue;
      const g = m.get(k) || { total:0, aJour:0, nom:s.adm1 };
      g.total++; if(estAJour(s)) g.aJour++; m.set(k, g); }
    return m;
  }, [actifs]);

  const champ = region ? actifs.filter(s => norm(s.adm1) === norm(region)) : actifs;
  const visitesChamp = region
    ? db.visits.filter(v => { const s = db.sites.find(x => x.id === v.siteId); return s && norm(s.adm1) === norm(region); })
    : db.visits;

  /* KPI. */
  const aJour = champ.filter(estAJour).length;
  const sansProbleme = champ.filter(s => !aProbleme(s)).length;
  const valides = visitesChamp.filter(v => v.status === "Validé").length;
  const aValider = visitesChamp.filter(v => v.status === "À valider").length;
  const couv = region
    ? pct(champ.reduce((a,s)=>a+(s.plan||[]).filter(p=>p.done).length,0),
          Math.max(1, champ.reduce((a,s)=>a+(s.plan||[]).filter(p=>p.planned).length,0)))
    : (mmr.required ? pct(mmr.done, mmr.required) : 0);
  const kCouv = bandePct(couv), kJour = bandePct(pct(aJour, champ.length)),
        kVal = bandePct(pct(valides, valides + aValider)), kConf = bandePct(pct(sansProbleme, champ.length));

  /* Sparkline : visites réalisées par mois (année courante, périmètre courant). */
  const visitesParMois = useMemo(() => {
    const t = Array(12).fill(0);
    for(const v of visitesChamp){ const d = new Date(v.date);
      if(d.getFullYear() === annee) t[d.getMonth()]++; }
    return t;
  }, [visitesChamp, annee]);

  /* Alertes prioritaires — toutes dérivées de la donnée réelle. */
  const alertes = useMemo(() => {
    const elapsed = mmr.elapsed || 12;
    const retard = champ.filter(s => (s.plan || []).slice(0, elapsed).some(p => p.planned && !p.done)).length;
    const sansGps = champ.filter(s => s.lat == null || s.lon == null || (s.lat === 0 && s.lon === 0)).length;
    const integrite = champ.filter(aProbleme).length;
    const list = [];
    if(retard) list.push({ c:ROUGE, ic:AlertTriangle, n:retard, titre:"Retards de visite",
      detail:"Sites dont une visite planifiée est échue sans réalisation.",
      cta:"Voir le suivi", action:() => go?.("suivi", "monitoring") });
    if(aValider) list.push({ c:AMBRE, ic:ClipboardCheck, n:aValider, titre:"Validations en attente",
      detail:"Visites réalisées en attente de validation.",
      cta:"Valider", action:() => go?.("suivi", "monitoring") });
    if(sansGps) list.push({ c:AMBRE, ic:Crosshair, n:sansGps, titre:"Coordonnées GPS manquantes",
      detail:"Sites sans point GPS — vérification impossible.",
      cta:"Vérifier", action:() => go?.("settings", "gps") });
    if(integrite) list.push({ c:ROUGE, ic:ShieldAlert, n:integrite, titre:"Signaux d'intégrité",
      detail:"Sites portant une alerte fraude, CFM ou rapport.",
      cta:"Examiner", action:() => go?.("suivi", "monitoring") });
    return list;
  }, [champ, visitesChamp, aValider, mmr.elapsed, go]);

  /* Par activité (barres + poste de contrôle). */
  const parActivite = useMemo(() => tags.map((t) => {
    const sites = champ.filter(s => s.activityTag === t.code);
    const visits = visitesChamp.filter(v => v.tag === t.code);
    const planned = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.planned).length, 0);
    const done = sites.reduce((a, s) => a + (s.plan || []).filter(p => p.done).length, 0);
    const pending = visits.filter(v => v.status === "À valider").length;
    const rate = pct(done, planned);
    const conf = sites.length ? pct(sites.filter(s => !aProbleme(s)).length, sites.length) : 0;
    const scoreMoyen = sites.length
      ? Math.round(sites.reduce((a, s) => a + (siteScore(s, db.weights, db).pct || 0), 0) / sites.length) : 0;
    return { tag:t.code, nom:activiteLabel(t.code), sites:sites.length, visits:visits.length,
      planned, done, pending, rate, conf, scoreMoyen };
  }).filter(a => a.sites || a.visits).sort((a, b) => b.sites - a.sites), [tags, champ, visitesChamp]);

  const proc = db.processIndicators || { total:0, activites:[] };

  const totSites = actifs.length;
  const totVisits = db.visits.length;
  if(!totSites && !totVisits) return (
    <Empty icon={Gauge} title="Aucune donnée de suivi"
      text="Le tableau de bord s'alimente du registre des sites, du plan de suivi et des visites. Chargez la donnée de référence et planifiez le suivi." />);

  const RAIL = [["synthese","Synthèse",Gauge],["carte","Carte",MapPin],
    ["analyse","Analyse process",BarChart3],
    ["processus","Indicateurs processus",ClipboardCheck],["activites","Par activité",Activity],
    ["controle","Poste de contrôle",ShieldCheck]];
  /* L'analyse de reproduction porte sa propre navigation ; le panneau d'alertes
     latéral serait redondant à côté d'elle. */
  const alertesVisibles = vue !== "analyse";

  return (
    <div className="flex flex-col" style={{ height:"calc(100vh - 232px)", minHeight:560 }}>
      {/* ── Barre du cockpit ── */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <button onClick={()=>setReplie(r=>!r)} title={replie?"Déplier le menu":"Replier le menu"}
          className="p-1.5 rounded-lg border border-slate-200 bg-white text-slate-500 hover:text-slate-800">
          {replie ? <PanelLeftOpen size={16}/> : <PanelLeftClose size={16}/>}</button>
        <div>
          <div className="f16 font-bold text-slate-900 leading-tight">Cockpit du suivi de processus</div>
          <div className="f105 text-slate-500">{region ? <>Région : <b className="text-slate-700">{region}</b> · <button className="c-bd hover:underline" onClick={()=>setRegion("")}>tout le pays</button></> : "Vue nationale · données réelles"}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select value={String(annee)} onChange={e=>setAnnee(+e.target.value)} className="mi-py1 mi-xs mi-wauto"
            options={[db.year-1, db.year, db.year+1].map(y=>[String(y), String(y)])} />
        </div>
      </div>

      {/* ── Corps en colonnes fluides ── */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* Rail gauche rétractable */}
        <nav className={clsx("shrink-0 bg-white border border-slate-200 rounded-2xl p-2 flex flex-col gap-1 transition-all",
          replie ? "w-14" : "w-52")}>
          {RAIL.map(([cle,label,Ic])=>(
            <button key={cle} onClick={()=>setVue(cle)} title={label}
              className={clsx("flex items-center gap-2.5 rounded-xl px-2.5 py-2 f125 font-semibold transition-colors",
                replie && "justify-center",
                vue===cle ? "bg-brand text-white shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800")}>
              <Ic size={17} className="shrink-0"/>{!replie && <span className="truncate">{label}</span>}</button>))}
          {!replie && <div className="mt-auto px-2 py-2 f10 text-slate-400 leading-snug">
            {fmt(proc.total)} indicateur(s) de processus extrait(s) des XLSForms</div>}
        </nav>

        {/* Centre */}
        <section className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">
          {vue==="synthese" && (
            <>
              <div className="grid gap-3 shrink-0" style={{ gridTemplateColumns:"repeat(4, minmax(0,1fr))" }}>
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 flex items-center justify-center">
                  <Jauge value={couv} color={kCouv.c} label="Couverture" sub={region?"plan réalisé":`${fmt(mmr.done)}/${fmt(mmr.required)} visites`} /></div>
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 flex items-center justify-center">
                  <Jauge value={pct(aJour, champ.length)} color={kJour.c} label="Sites à jour" sub={`${fmt(aJour)}/${fmt(champ.length)} · ≤90 j`} /></div>
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 flex items-center justify-center">
                  <Jauge value={pct(valides, valides+aValider)} color={kVal.c} label="Validation" sub={`${fmt(aValider)} en attente`} /></div>
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-3 flex flex-col items-center justify-center">
                  <div className="f105 font-bold uppercase tracking-wide text-slate-500">Visites / mois</div>
                  <Sparkline data={visitesParMois} color={C.brand} />
                  <div className="f105 text-slate-400">{fmt(visitesChamp.filter(v=>new Date(v.date).getFullYear()===annee).length)} en {annee}</div>
                </div>
              </div>
              {/* Carte (largeur maîtrisée, Madagascar est étroit) + contenu à droite,
                  pour ne plus laisser d'espace vide autour de l'île. */}
              <div className="flex-1 min-h-0 grid gap-3" style={{ gridTemplateColumns:"minmax(300px, 40%) 1fr" }}>
                <CarteEtat parRegion={parRegion} onRegion={setRegion} selection={region} />
                <div className="min-h-0 overflow-y-auto pr-1 space-y-3">
                  <ContenuSynthese parActivite={parActivite} parRegion={parRegion} onRegion={setRegion}
                    region={region} setVue={setVue} proc={proc} />
                </div>
              </div>
            </>)}

          {vue==="carte" && (
            <div className="flex-1 min-h-0">
              <CarteEtat parRegion={parRegion} onRegion={setRegion} selection={region} /></div>)}

          {vue==="analyse" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <AnalyseProcessus /></div>)}

          {vue==="processus" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-3">
              <PerfProcessus proc={proc} parActivite={parActivite} notify={notify} />
            </div>)}

          {vue==="activites" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
                <div className="f14 font-bold text-slate-800 mb-1">Couverture du suivi par activité</div>
                <div className="f115 text-slate-500 mb-4">Visites réalisées sur planifiées{region?` — ${region}`:""}</div>
                {parActivite.length ? <BarresActivite items={parActivite} />
                  : <Empty icon={Activity} title="Aucune activité suivie" text="Rattachez des sites à une activité et planifiez leur suivi." />}
              </div>
            </div>)}

          {vue==="controle" && (
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
              <div className="grid gap-3" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(230px, 1fr))" }}>
                {parActivite.map(a => { const b = bandePct(a.rate);
                  return (
                  <div key={a.tag} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background:b.c }} />
                      <span className="f105 font-extrabold text-white px-1.5 py-0.5 rounded bg-brand">{a.tag}</span>
                      <span className="f22 font-extrabold ml-auto leading-none tabular-nums" style={{ color:b.c }}>{a.rate}<span className="f11">%</span></span>
                    </div>
                    <div className="f115 text-slate-500 leading-snug mb-3 truncate" title={a.nom}>{a.nom}</div>
                    <div className="grid grid-cols-3 gap-2 text-center border-t border-slate-100 pt-3">
                      <div><div className="f16 font-bold text-slate-800 leading-none tabular-nums">{fmt(a.sites)}</div><div className="f10 text-slate-400 mt-1">sites</div></div>
                      <div><div className="f16 font-bold text-slate-800 leading-none tabular-nums">{a.conf}%</div><div className="f10 text-slate-400 mt-1">conformité</div></div>
                      <div><div className={clsx("f16 font-bold leading-none tabular-nums", a.pending?"text-amber-600":"text-slate-800")}>{fmt(a.pending)}</div><div className="f10 text-slate-400 mt-1">à valider</div></div>
                    </div>
                  </div>); })}
              </div>
            </div>)}
        </section>

        {/* Panneau d'alertes (droite) — masqué sur l'analyse, qui a sa navigation. */}
        {alertesVisibles && (
        <aside className="hidden xl:flex w-80 shrink-0 flex-col bg-slate-50 border border-slate-200 rounded-2xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-white flex items-center gap-2">
            <AlertTriangle size={15} className="text-amber-500" />
            <span className="f13 font-bold text-slate-800">Alertes prioritaires</span>
            <span className="ml-auto f105 font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 tabular-nums">{alertes.reduce((a,x)=>a+x.n,0)}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
            {alertes.length ? alertes.map((a,i)=><CarteAlerte key={i} a={a} />)
              : <div className="h-full grid place-items-center text-center px-4">
                  <div><ShieldCheck size={26} className="mx-auto text-emerald-500 mb-2" />
                    <div className="f125 font-semibold text-slate-700">Aucune alerte</div>
                    <div className="f11 text-slate-500">Tout est à jour sur ce périmètre.</div></div>
                </div>}
          </div>
        </aside>)}
      </div>
    </div>);
}

/* Contenu qui accompagne la carte en synthèse : ce qui compte au-delà du MMR —
   couverture par activité, régions à surveiller, et l'entrée vers l'analyse. */
function ContenuSynthese({ parActivite, parRegion, onRegion, region, setVue, proc }){
  /* Régions triées de la moins à jour à la plus à jour (celles qui ont des sites). */
  const regions = [...parRegion.values()].filter(r => r.total > 0)
    .map(r => ({ ...r, part: Math.round(r.aJour / r.total * 100) }))
    .sort((a, b) => a.part - b.part).slice(0, 7);
  return (<>
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="f13 font-bold text-slate-800">Couverture par activité</div>
        <button onClick={()=>setVue("activites")} className="f105 c-bd font-semibold hover:underline">Tout voir</button>
      </div>
      {parActivite.length
        ? <BarresActivite items={parActivite.slice(0, 6)} />
        : <div className="f115 text-slate-400 py-3">Aucune activité suivie sur ce périmètre.</div>}
    </div>

    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="f13 font-bold text-slate-800 mb-1">Régions à surveiller</div>
      <div className="f105 text-slate-400 mb-3">Part des sites visités il y a ≤ 90 jours</div>
      <div className="space-y-2">
        {regions.map(r => { const b = bandePart(r.part, r.total);
          return (
          <button key={r.nom} onClick={()=>onRegion(region===r.nom ? "" : r.nom)}
            className={clsx("w-full flex items-center gap-2.5 text-left rounded-lg px-1.5 py-1 hover:bg-slate-50",
              region===r.nom && "bg-sky-50")}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background:b.c }} />
            <span className="f115 text-slate-700 flex-1 truncate">{r.nom}</span>
            <div className="w-20 h-2 rounded-full bg-slate-100 overflow-hidden shrink-0">
              <div className="h-full rounded-full" style={{ width:`${r.part}%`, background:b.c }} /></div>
            <span className="f11 font-bold tabular-nums w-9 text-right" style={{ color:b.c }}>{r.part}%</span>
            <span className="f10 text-slate-400 w-14 text-right">{fmt(r.total)} site(s)</span>
          </button>); })}
        {!regions.length && <div className="f115 text-slate-400 py-2">Aucun site rattaché à une région.</div>}
      </div>
    </div>

    {proc.total > 0 && (
      <button onClick={()=>setVue("analyse")}
        className="w-full bg-white border border-slate-200 rounded-2xl shadow-sm p-4 flex items-center gap-3 hover:shadow-md transition-shadow text-left">
        <span className="w-10 h-10 rounded-xl grid place-items-center bg-brand/10 shrink-0" style={{ color:C.brand }}><BarChart3 size={20} /></span>
        <div className="min-w-0 flex-1">
          <div className="f125 font-bold text-slate-800">Analyse du suivi de processus</div>
          <div className="f105 text-slate-500">{fmt(proc.total)} indicateurs · modules, salle de contrôle, performance</div>
        </div>
        <ChevronRight size={18} className="text-slate-300 shrink-0" />
      </button>)}
  </>);
}

/* Type XLSForm → libellé court + teinte, pour lire une variable d'un coup d'œil. */
const TYPE_INFO = (t) => {
  const base = String(t||"").split(/\s+/)[0];
  const m = {
    select_one:["choix unique","#0d9488"], select_multiple:["choix multiple","#7c3aed"],
    integer:["entier","#0ea5e9"], decimal:["décimal","#0ea5e9"], text:["texte","#64748b"],
    date:["date","#f59e0b"], time:["heure","#f59e0b"], geopoint:["GPS","#dd1367"],
    range:["échelle","#0ea5e9"], barcode:["code-barres","#64748b"],
  };
  return m[base] || [base || "—", "#94a3b8"];
};

/* Les VARIABLES d'une activité, groupées par module, avec leurs CHOIX mappés à
   chaque question — « je ne vois pas les variables de mes XLSForm », « mappe les
   choix aux questions pour la visualisation ». Tirées à la demande. */
function VariablesActivite({ tag, notify }){
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [mod, setMod] = useState("");        /* module ouvert */
  useEffect(() => {
    let vivant = true; setRows(null); setErr("");
    api.processIndicateurs(`?activity=${encodeURIComponent(tag)}&limit=5000`)
      .then(r => { if(vivant) setRows(r.rows || []); })
      .catch(e => { if(vivant){ setErr(e.message); notify?.("Chargement des variables impossible : " + e.message, "err"); } });
    return () => { vivant = false; };
  }, [tag]);

  if(err) return <div className="f115 text-rose-600 px-1 py-2">{err}</div>;
  if(rows === null) return <div className="f115 text-slate-400 px-1 py-3">Chargement des variables…</div>;

  const filtre = q.trim().toLowerCase();
  const visibles = filtre
    ? rows.filter(r => (r.label||"").toLowerCase().includes(filtre) || (r.var_name||"").toLowerCase().includes(filtre))
    : rows;
  /* Regroupement par module, dans l'ordre d'apparition. */
  const modules = [];
  const parMod = new Map();
  for(const r of visibles){ const key = r.module || "(sans module)";
    if(!parMod.has(key)){ parMod.set(key, []); modules.push(key); }
    parMod.get(key).push(r); }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Rechercher une variable, un libellé…"
            className="pl-7 pr-2 py-1 f115 rounded-lg border border-slate-200 bg-white w-64 outline-none focus:border-sky-400" /></div>
        <span className="f105 text-slate-400">{fmt(visibles.length)} variable(s) · {modules.length} module(s)</span>
      </div>
      {modules.map(nomMod => { const liste = parMod.get(nomMod); const ouvert = mod === nomMod || !!filtre;
        return (
        <div key={nomMod} className="rounded-xl border border-slate-200 overflow-hidden">
          <button onClick={()=>setMod(ouvert && !filtre ? "" : nomMod)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-left">
            <Layers size={14} className="text-slate-400 shrink-0" />
            <span className="f125 font-semibold text-slate-700 flex-1 truncate">{nomMod}</span>
            <span className="f11 font-bold text-slate-500 tabular-nums">{liste.length}</span>
            <ChevronRight size={14} className={clsx("text-slate-300 transition-transform", ouvert && "rotate-90")} />
          </button>
          {ouvert && (
            <div className="divide-y divide-slate-100">
              {liste.map(r => { const [tl, tc] = TYPE_INFO(r.var_type);
                return (
                <div key={r.id} className="px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span className="f9 font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5" style={{ background:tc+"1a", color:tc }}>{tl}</span>
                    <div className="min-w-0 flex-1">
                      <div className="f125 text-slate-800 leading-snug">{r.label || <span className="text-slate-400 italic">(sans libellé)</span>}</div>
                      <code className="f10 text-slate-400">{r.var_name}</code>
                      {/* Les CHOIX mappés à la question. */}
                      {r.choices?.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.choices.slice(0, 14).map((c,i)=>(
                            <span key={i} className="f10 rounded-md bg-slate-100 text-slate-600 px-1.5 py-0.5" title={c.value}>{c.label}</span>))}
                          {r.choices.length > 14 && <span className="f10 text-slate-400 px-1 py-0.5">+{r.choices.length-14}</span>}
                        </div>)}
                    </div>
                  </div>
                </div>); })}
            </div>)}
        </div>); })}
    </div>);
}

/* ── Performance + variables des indicateurs de suivi de processus (XLSForm) ── */
function PerfProcessus({ proc, parActivite, notify }){
  const [ouvert, setOuvert] = useState("");
  const [vue, setVue] = useState("perf");          /* perf | variables */
  const perfDe = (tag) => parActivite.find(a => a.tag === tag)
    || parActivite.find(a => norm(a.nom).includes(norm(tag)));

  const dl = async () => {
    try{
      const blob = await api.processIndicateursExport();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = "indicateurs_suivi_processus.xlsx";
      a.click(); URL.revokeObjectURL(url);
    }catch(e){ notify?.("Export impossible : " + e.message, "err"); }
  };

  if(!proc.total) return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8 text-center">
      <ClipboardCheck size={30} className="mx-auto text-slate-300 mb-2" />
      <div className="f14 font-bold text-slate-700">Aucun indicateur de suivi de processus</div>
      <p className="f125 text-slate-500 mt-1 max-w-lg mx-auto">Les indicateurs se remplissent depuis les XLSForms
        au renflouement « données réelles » (Paramètres → Localités → Gestion du référentiel → Activités + indicateurs).</p>
    </div>);

  return (<>
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 flex items-center gap-3 flex-wrap">
      <span className="w-10 h-10 rounded-xl grid place-items-center bg-brand/10" style={{ color:C.brand }}><ClipboardCheck size={20} /></span>
      <div className="min-w-0">
        <div className="f14 font-bold text-slate-800">Indicateurs de suivi de processus</div>
        <div className="f115 text-slate-500"><b>{fmt(proc.total)}</b> variables extraites de <b>{proc.activites.length}</b> formulaires XLSForm — libellés, types et choix.</div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          {[["perf","Performance"],["variables","Variables"]].map(([k,l])=>(
            <button key={k} onClick={()=>setVue(k)}
              className={clsx("px-3 py-1 f11 rounded-md font-semibold transition-colors",
                vue===k ? "bg-brand text-white shadow-sm" : "text-slate-500 hover:text-slate-800")}>{l}</button>))}
        </div>
        <button onClick={dl} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg f115 font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200">
          <FileSpreadsheet size={15} /> Exporter</button>
      </div>
    </div>

    {proc.activites.map(act => {
      const p = perfDe(act.tag);
      const rate = p?.rate ?? null, conf = p?.conf ?? null;
      const b = rate != null ? bandePct(rate) : { c:NEUTRE, l:"—" };
      const open = ouvert === act.tag;
      return (
        <div key={act.tag || act.form} className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <button onClick={()=>setOuvert(open ? "" : act.tag)}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 text-left">
            <span className="f105 font-extrabold text-white px-2 py-0.5 rounded bg-brand shrink-0">{act.tag || "—"}</span>
            <div className="min-w-0 flex-1">
              <div className="f13 font-semibold text-slate-800 truncate">{act.label}</div>
              <div className="f105 text-slate-400 truncate">{act.total} indicateurs · {act.modules.length} modules · {act.formTitle || act.form}</div>
            </div>
            {vue==="perf" && (
              <div className="flex items-center gap-4 shrink-0">
                <div className="text-right"><div className="f10 text-slate-400 uppercase tracking-wide">Couverture</div>
                  <div className="f16 font-extrabold tabular-nums leading-none" style={{ color:b.c }}>{rate != null ? rate+"%" : "—"}</div></div>
                <div className="text-right"><div className="f10 text-slate-400 uppercase tracking-wide">Conformité</div>
                  <div className="f16 font-extrabold tabular-nums leading-none text-slate-700">{conf != null ? conf+"%" : "—"}</div></div>
                <ChevronRight size={16} className={clsx("text-slate-300 transition-transform", open && "rotate-90")} />
              </div>)}
            {vue==="variables" && <ChevronRight size={16} className={clsx("text-slate-300 transition-transform shrink-0", open && "rotate-90")} />}
          </button>
          {vue==="perf" && rate != null && (
            <div className="px-4 pb-1"><div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full" style={{ width:`${Math.min(100,rate)}%`, background:b.c }} /></div></div>)}
          {open && vue==="perf" && (
            <div className="px-4 pb-4 pt-2 border-t border-slate-100">
              <div className="f105 font-bold uppercase tracking-wide text-slate-400 mb-2">Modules thématiques</div>
              <div className="grid gap-2" style={{ gridTemplateColumns:"repeat(auto-fill, minmax(200px,1fr))" }}>
                {act.modules.map((m,i)=>(
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-slate-150 bg-slate-50 px-2.5 py-1.5">
                    <Layers size={13} className="text-slate-400 shrink-0" />
                    <span className="f115 text-slate-700 truncate flex-1" title={m.nom}>{m.nom}</span>
                    <span className="f11 font-bold text-slate-500 tabular-nums">{m.n}</span>
                  </div>))}
              </div>
              {rate == null && <p className="f105 text-slate-400 mt-3">Aucun site rattaché à cette activité sur le périmètre courant — la performance s'affichera dès qu'un site portera ce tag.</p>}
            </div>)}
          {open && vue==="variables" && (
            <div className="px-4 pb-4 pt-3 border-t border-slate-100">
              <VariablesActivite tag={act.tag} notify={notify} />
            </div>)}
        </div>);
    })}
  </>);
}

/* Les barres de couverture par activité — alignées, calmes, la valeur en tête de
   bande sémantique. */
function BarresActivite({ items }){
  return (
    <div className="space-y-3">
      {items.map(a => { const b = bandePct(a.rate);
        return (
        <div key={a.tag} className="grid items-center gap-4" style={{ gridTemplateColumns:"210px 1fr 56px" }}>
          <div className="min-w-0 flex items-center gap-2">
            <span className="f105 font-extrabold text-white px-1.5 py-0.5 rounded bg-brand shrink-0">{a.tag}</span>
            <span className="f11 text-slate-400 truncate" title={a.nom}>{a.nom}</span>
          </div>
          <div className="h-4 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width:`${Math.min(100, a.rate)}%`, background:b.c }} />
          </div>
          <div className="text-right f13 font-bold tabular-nums" style={{ color:b.c }}>{a.rate}%</div>
        </div>); })}
    </div>);
}

export { ProcessDashboard };
