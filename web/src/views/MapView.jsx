import React, { useState, useEffect, useMemo, useRef } from "react";
import { MapPin, Search, RefreshCw, Download, Users, Target, Activity, AlertTriangle, Layers } from "lucide-react";
import { C, MONTHS_L, D_SECURITY } from "../lib/constants.js";
import { fmt, pct, n, r2, clsx } from "../lib/calc.js";
import { download, toCSV } from "../components/ui.jsx";
import { Card, Btn, Select, Stat, StatRow, Empty, Note, Bar2, TableWrap, Th, Td, inputCls } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { useGeoCascade, names } from "../lib/geo.js";
import { niveau, niveaux } from "../lib/levels.js";

/* Projection équirectangulaire simple, suffisante pour un pays et sans dépendance externe.
   Aucune tuile n'est appelée : la carte fonctionne hors ligne et ne fuite aucune donnée. */
function makeProjection(bounds, width, height, pad = 26){
  if(!bounds) return null;
  const latSpan = Math.max(0.02, bounds.maxLat - bounds.minLat);
  const lonSpan = Math.max(0.02, bounds.maxLon - bounds.minLon);
  /* Correction de la convergence des méridiens à la latitude moyenne. */
  const midLat = (bounds.maxLat + bounds.minLat) / 2;
  const kx = Math.cos(midLat * Math.PI / 180) || 1;
  const scale = Math.min((width - 2*pad) / (lonSpan * kx), (height - 2*pad) / latSpan);
  const cx = (bounds.maxLon + bounds.minLon) / 2;
  const cy = midLat;
  return {
    x: (lon) => width/2 + (lon - cx) * kx * scale,
    y: (lat) => height/2 - (lat - cy) * scale,
    scale,
  };
}

const COLOR_MODES = [
  ["coverage", "Couverture des visites"],
  ["security", "Situation sécuritaire"],
  ["activity", "Catégorie d'activité"],
  ["status", "Statut du site"],
];

/* Aplats du fond de carte. « Aucun » laisse les contours en simple trait : c'est
   ce qu'il faut quand on regarde les points. Les trois autres répondent à des
   questions que le module de ciblage posait déjà en tableau, et qu'un tableau ne
   sait pas montrer — où sont les vides. */
const FILL_MODES = [
  ["none",     "Contours seuls"],
  ["presence", "Présence de sites"],
  ["coverage", "Couverture du suivi"],
  ["benef",    "Bénéficiaires"],
];
/* Les niveaux proposés viennent de la configuration du pays : « Régions,
   Districts, Communes, Fokontany » est le vocabulaire de Madagascar, pas celui du
   logiciel. Le pays n'est pas proposé — on ne colore pas un aplat sur une seule
   forme. */

/* Une géométrie GeoJSON vers un chemin SVG, projeté.

   L'arrondi à 0,1 pixel n'est pas une coquetterie : un contour de commune compte
   des centaines de sommets, et écrire « 412.7382910384 » plutôt que « 412.7 »
   multiplie par trois la taille du DOM pour une différence invisible. Sur un
   millier de contours, cela se voit à l'affichage. */
function pathOf(geometry, proj){
  if(!geometry || !proj) return "";
  const r1 = (v) => Math.round(v * 10) / 10;
  const anneau = (r) => {
    let d = "";
    for(let i = 0; i < r.length; i++){
      const x = r1(proj.x(r[i][0])), y = r1(proj.y(r[i][1]));
      d += (i ? "L" : "M") + x + " " + y;
    }
    return d + "Z";
  };
  if(geometry.type === "Polygon") return geometry.coordinates.map(anneau).join("");
  if(geometry.type === "MultiPolygon")
    return geometry.coordinates.map(p => p.map(anneau).join("")).join("");
  return "";
}

/* Échelle d'aplat séquentielle, du plus clair au plus foncé de la teinte de
   marque. Cinq classes : au-delà, l'œil ne distingue plus, et en dessous on perd
   l'information. Le blanc est réservé au zéro — un vide doit se voir comme un vide,
   pas comme la première classe. */
const RAMP = ["#e8f2f8", "#bcdcec", "#8ac2dd", "#4e9ec7", "#0b6d9e"];
function classify(v, max){
  if(v == null || max <= 0) return null;
  if(v <= 0) return null;
  const k = Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length));
  return RAMP[k];
}

export default function MapView({ db, me, notify, go }){
  const [rows, setRows] = useState([]);
  const [bounds, setBounds] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [colorMode, setColorMode] = useState("coverage");
  const [sizeByBenef, setSizeByBenef] = useState(true);
  const [f, setF] = useState({ office_id:"", adm1:"", adm2:"", activity_tag:"", status:"Active" });
  const [view, setView] = useState({ k:1, dx:0, dy:0 });
  /* Fond de carte : contours administratifs et mode d'aplat. */
  const [fillMode, setFillMode] = useState("presence");
  const [geoLevel, setGeoLevel] = useState("adm2");
  const [shapes, setShapes] = useState({ features:[], extent:null, tronque:false, loading:false });
  const [selShape, setSelShape] = useState(null);
  const GEO_LEVELS = niveaux(db, { from:"adm1", to:"adm4" });
  const W = 900, H = 560;

  const load = async () => {
    setBusy(true); setError("");
    try{
      const params = new URLSearchParams();
      Object.entries(f).forEach(([k,v]) => { if(v) params.set(k, v); });
      const r = await api.mapPoints("?" + params.toString());
      setRows(r.sites); setBounds(r.bounds);
    }catch(e){ setError(e.message); setRows([]); setBounds(null); }
    setBusy(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [f.office_id, f.adm1, f.adm2, f.activity_tag, f.status]);

  const filtered = useMemo(() => !q ? rows : rows.filter(s =>
    [s.code, s.name, s.adm3, s.adm4, s.office].join(" ").toLowerCase().includes(q.toLowerCase())), [rows, q]);

  /* Le cadrage tient compte des contours : sans cela une région dont les sites
     sont regroupés dans un coin verrait son contour dépasser de l'écran. */
  const cadre = useMemo(() => {
    const e = shapes.extent;
    if(!e) return bounds;
    const g = { minLat:e.south, maxLat:e.north, minLon:e.west, maxLon:e.east };
    if(!bounds) return g;
    return { minLat:Math.min(bounds.minLat, g.minLat), maxLat:Math.max(bounds.maxLat, g.maxLat),
             minLon:Math.min(bounds.minLon, g.minLon), maxLon:Math.max(bounds.maxLon, g.maxLon) };
  }, [bounds, shapes.extent]);
  const proj = useMemo(() => makeProjection(cadre, W, H), [cadre]);
  const tags = useMemo(() => [...new Set(rows.map(s => s.activity_tag).filter(Boolean))].sort(), [rows]);
  /* Le référentiel vient du serveur, niveau par niveau : le navigateur ne
     charge jamais les 18 000 fokontany pour alimenter deux listes déroulantes. */
  const geo = useGeoCascade({ adm1: f.adm1 });
  /* Repères de fond : centroïdes des communes du périmètre affiché. Bornés à 1 000,
     qui est la limite du serveur — on demandait 1 200, la requête repartait en 422,
     et le `catch` du client vidait la liste sans rien dire : ces repères ne se sont
     jamais affichés. Au-delà de ce nombre ils forment de toute façon une tache
     grise sans rien apprendre. */
  const [geoMarks, setGeoMarks] = useState([]);
  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ level:"adm3", limit:"1000" });
    if(geo.codes.adm2) qs.set("parent", geo.codes.adm2);
    else if(geo.codes.adm1) qs.set("parent", geo.codes.adm1);
    api.geo("?"+qs)
      .then(r => { if(alive) setGeoMarks((r.rows||[]).filter(g => g.lat != null && g.lon != null)); })
      .catch(() => { if(alive) setGeoMarks([]); });
    return () => { alive = false; };
  }, [geo.codes.adm1, geo.codes.adm2]);

  /* ── Contours administratifs ───────────────────────────────────────
     Chargés par niveau et bornés au parent affiché. La version servie est la
     version simplifiée : c'est celle dont un écran de 900 pixels a besoin, et
     demander la pleine résolution d'un pays entier n'afficherait rien de plus
     tout en pesant cent fois plus lourd. */
  useEffect(() => {
    let alive = true;
    if(!db.geoVersion?.geom?.units){ setShapes({ features:[], extent:null, tronque:false, loading:false }); return; }
    setShapes(s => ({ ...s, loading:true }));
    const qs = new URLSearchParams({ level:geoLevel, limit:"1500" });
    const parent = geo.codes.adm2 || geo.codes.adm1;
    if(parent) qs.set("parent", parent);
    api.geoGeometry("?"+qs)
      .then(r => { if(alive) setShapes({ features:r.features||[], extent:r.extent,
        tronque:!!r.tronque, loading:false }); })
      .catch(() => { if(alive) setShapes({ features:[], extent:null, tronque:false, loading:false }); });
    return () => { alive = false; };
  }, [geoLevel, geo.codes.adm1, geo.codes.adm2, db.geoVersion?.geom?.units]);

  const adm1s = useMemo(() => names(geo.adm1), [geo.adm1]);
  const adm2s = useMemo(() => names(geo.adm2), [geo.adm2]);

  const palette = useMemo(() => {
    const t = {}; tags.forEach((x,i) => { t[x] = [C.brand, C.ok, C.warn, C.orange, C.aqua, C.magenta, C.navy][i % 7]; });
    return t;
  }, [tags]);

  const colorOf = (s) => {
    if(colorMode === "security")
      return s.security === 0 ? C.ok : s.security === 1 ? C.warn : s.security === 3 ? C.bad : "#7c8792";
    if(colorMode === "activity") return palette[s.activity_tag] || "#94a3b8";
    if(colorMode === "status") return s.status === "Active" ? C.ok : "#94a3b8";
    const c = s.planned ? pct(s.done, s.planned) : (s.done ? 100 : 0);
    return s.planned === 0 && s.done === 0 ? "#c3cdd6" : c >= 80 ? C.ok : c >= 40 ? C.warn : C.bad;
  };
  const radiusOf = (s) => {
    if(!sizeByBenef) return 4.2;
    const b = n(s.beneficiaries);
    return 3 + Math.min(9, Math.sqrt(b) / 22);
  };

  const stats = useMemo(() => {
    const active = filtered.filter(s => s.status === "Active");
    const visited = filtered.filter(s => s.done > 0);
    const never = filtered.filter(s => !s.last_visit);
    return { total: filtered.length, active: active.length, visited: visited.length,
      never: never.length, benef: filtered.reduce((t,s) => t + n(s.beneficiaries), 0),
      coverage: pct(visited.length, active.length) };
  }, [filtered]);

  /* ── Valeurs thématiques par unité ─────────────────────────────────
     Agrégées depuis les sites déjà chargés, par p-code. Le rattachement se fait
     par code et non par nom : deux communes homonymes dans deux districts
     différents existent, et les confondre colorerait la mauvaise. Un site dont le
     p-code manque ne compte pour aucune unité — il est visible en point, ce qui
     est la bonne façon de signaler qu'il n'est pas rattaché.

     Les valeurs remontent d'un niveau à l'autre par la propriété `parent` que le
     serveur joint à chaque contour : les sites sont à la commune, la carte peut
     être au district. */
  const themeValues = useMemo(() => {
    if(fillMode === "none" || !shapes.features.length) return { par:{}, max:0, absent:0 };
    /* Chaîne de parenté des contours affichés, pour remonter un site plus fin. */
    const parentDe = {};
    shapes.features.forEach(f => { parentDe[f.properties.pcode] = f.properties.parent; });
    const cible = new Set(shapes.features.map(f => f.properties.pcode));

    const par = {}; let absent = 0;
    for(const st of filtered){
      let p = st.geo_pcode;
      /* On remonte jusqu'à une unité du niveau affiché — dix sauts au plus, le
         référentiel n'en compte que cinq. */
      let sauts = 0;
      while(p && !cible.has(p) && sauts++ < 10) p = parentDe[p];
      if(!p || !cible.has(p)){ absent++; continue; }
      const a = par[p] = par[p] || { sites:0, actifs:0, planifies:0, visites:0, benef:0 };
      a.sites++;
      if(st.status === "Active") a.actifs++;
      a.planifies += n(st.planned); a.visites += n(st.done); a.benef += n(st.beneficiaries);
    }
    const val = (a) => fillMode === "presence" ? a.sites
      : fillMode === "benef" ? a.benef
      : (a.planifies ? Math.round((a.visites / a.planifies) * 100) : (a.visites ? 100 : 0));
    const max = fillMode === "coverage" ? 100
      : Math.max(0, ...Object.values(par).map(val));
    return { par, val, max, absent };
  }, [fillMode, shapes.features, filtered]);

  const byRegion = useMemo(() => {
    const m = {};
    filtered.forEach(s => { const k = s.adm1 || "—";
      m[k] = m[k] || { region:k, sites:0, visites:0, benef:0 };
      m[k].sites++; m[k].visites += s.done; m[k].benef += n(s.beneficiaries); });
    return Object.values(m).sort((a,b) => b.sites - a.sites);
  }, [filtered]);

  const legend = colorMode === "security"
    ? D_SECURITY.map(([v,l]) => [v === 0 ? C.ok : v === 1 ? C.warn : v === 3 ? C.bad : "#7c8792", l])
    : colorMode === "activity" ? tags.map(t => [palette[t], t])
    : colorMode === "status" ? [[C.ok,"Actif"], ["#94a3b8","Inactif"]]
    : [[C.ok,"80 % et plus des visites prévues"], [C.warn,"40 à 79 %"], [C.bad,"moins de 40 %"], ["#c3cdd6","aucune visite prévue"]];

  const exportPoints = () => {
    download("cartographie_sites.csv", toCSV(filtered,
      ["code","name","office","category","activity_tag","adm1","adm2","adm3","adm4",
       "lat","lon","beneficiaries","security","status","planned","done","last_visit"]), "text/csv");
    notify("Points exportés","ok");
  };

  const zoom = (factor) => setView(v => ({ ...v, k: Math.max(1, Math.min(12, v.k * factor)) }));
  const drag = useRef(null);
  const onDown = (e) => { drag.current = { x:e.clientX, y:e.clientY, dx:view.dx, dy:view.dy }; };
  const onMove = (e) => { if(!drag.current) return;
    setView(v => ({ ...v, dx: drag.current.dx + (e.clientX - drag.current.x),
                          dy: drag.current.dy + (e.clientY - drag.current.y) })); };
  const onUp = () => { drag.current = null; };

  return (
    <div className="space-y-4">
      <StatRow>
        <Stat label="Sites cartographiés" value={fmt(stats.total)} sub={`${fmt(rows.length)} ramenés du serveur`} icon={MapPin} />
        <Stat label="Sites actifs" value={fmt(stats.active)} icon={Activity} />
        <Stat label="Sites visités" value={fmt(stats.visited)} tone={stats.coverage >= 60 ? "ok" : "warn"}
          sub={`${stats.coverage} % des actifs`} icon={Target} />
        <Stat label="Jamais visités" value={fmt(stats.never)} tone={stats.never ? "bad" : "ok"} icon={AlertTriangle} />
        <Stat label="Bénéficiaires couverts" value={fmt(stats.benef)} icon={Users} />
      </StatRow>

      <Card flush title="Cartographie des sites"
        subtitle={busy ? "Chargement des points…" : `${fmt(filtered.length)} points affichés · projection WGS 84`}
        right={<>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Site, commune, fokontany…"
              className={clsx(inputCls, "pl-7 mi-py1 w-52")} />
          </div>
          <Btn size="sm" kind="sec" icon={RefreshCw} onClick={load}>Actualiser</Btn>
          <Btn size="sm" kind="sec" icon={Download} disabled={!filtered.length} onClick={exportPoints}>Exporter</Btn>
        </>}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          <Select value={f.office_id} onChange={e=>setF(x=>({...x, office_id:e.target.value}))}
            empty="Tous les bureaux" options={(db.offices||[]).map(o=>[o.id,o.name])} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.adm1} onChange={e=>setF(x=>({...x, adm1:e.target.value, adm2:""}))}
            empty="Toutes les régions" options={adm1s} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.adm2} onChange={e=>setF(x=>({...x, adm2:e.target.value}))}
            empty="Tous les districts" options={adm2s} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.activity_tag} onChange={e=>setF(x=>({...x, activity_tag:e.target.value}))}
            empty="Toutes les activités" options={tags} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.status} onChange={e=>setF(x=>({...x, status:e.target.value}))}
            empty="Tous les statuts" options={[["Active","Actifs"],["Inactive","Inactifs"]]} className="mi-py1 mi-xs mi-wauto" />
          <span className="w-px h-6 bg-slate-300 mx-1" />
          {db.geoVersion?.geom?.units > 0 && (<>
            <Select value={geoLevel} onChange={e=>setGeoLevel(e.target.value)}
              options={GEO_LEVELS} className="mi-py1 mi-xs mi-wauto" />
            <Select value={fillMode} onChange={e=>setFillMode(e.target.value)}
              options={FILL_MODES} className="mi-py1 mi-xs mi-wauto" />
            <span className="w-px h-6 bg-slate-300 mx-1" />
          </>)}
          <Select value={colorMode} onChange={e=>setColorMode(e.target.value)}
            options={COLOR_MODES} className="mi-py1 mi-xs mi-wauto" />
          <label className="flex items-center gap-1.5 f115 text-slate-600">
            <input type="checkbox" checked={sizeByBenef} onChange={e=>setSizeByBenef(e.target.checked)} />
            taille selon les bénéficiaires</label>
          <div className="ml-auto flex items-center gap-1">
            <Btn size="sm" kind="sec" onClick={()=>zoom(1/1.4)}>−</Btn>
            <span className="f115 text-slate-500 tabular-nums px-1">×{r2(view.k)}</span>
            <Btn size="sm" kind="sec" onClick={()=>zoom(1.4)}>+</Btn>
            <Btn size="sm" kind="ghost" onClick={()=>setView({ k:1, dx:0, dy:0 })}>Recentrer</Btn>
          </div>
        </div>

        {error ? <Note tone="err">{error}</Note> : null}

        {/* Un fond de carte sans point reste utile : il montre les unités où le
            programme n'a aucune présence, ce qui est précisément l'information
            qu'une carte de points ne peut pas donner. */}
        {!proj || (!filtered.length && !shapes.features.length) ? (
          <Empty icon={MapPin} title={busy ? "Chargement…" : "Aucun site à afficher"}
            text={busy ? "" : "Aucun site ne porte de coordonnées pour ces filtres. Renseignez la latitude et la longitude dans le registre des sites."} />
        ) : (
          <div className="flex">
            <div className="flex-1 min-w-0 relative" style={{ background:"#f7fafc" }}
                 onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ cursor: drag.current ? "grabbing" : "grab" }}
                   onMouseDown={onDown}>
                <defs>
                  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e6edf2" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width={W} height={H} fill="url(#grid)" />
                <g transform={`translate(${view.dx},${view.dy}) scale(${view.k})`}>
                  {/* ── Fond de carte administratif ──────────────────────
                      Les contours passent en premier : tout le reste se dessine
                      par-dessus. Le trait s'affine avec le zoom pour rester d'une
                      épaisseur constante à l'écran — sans quoi un zoom ×8
                      transformerait les frontières en gros traits opaques. */}
                  {shapes.features.map(f => {
                    const a = themeValues.par?.[f.properties.pcode];
                    const fill = fillMode === "none" || !a ? "#ffffff"
                      : classify(themeValues.val(a), themeValues.max) || "#ffffff";
                    const actif = selShape === f.properties.pcode;
                    return (
                      <path key={f.properties.pcode} d={pathOf(f.geometry, proj)}
                        data-unit={f.properties.pcode} fill={fill}
                        fillOpacity={fillMode === "none" ? 0.55 : 0.9}
                        stroke={actif ? C.brandD : "#9fb2c0"}
                        strokeWidth={(actif ? 2 : 0.7) / view.k}
                        onClick={()=>setSelShape(actif ? null : f.properties.pcode)}
                        style={{ cursor:"pointer" }}>
                        <title>{`${f.properties.name}${a ? `\n${a.sites} site(s), ${a.actifs} actif(s)\n${a.visites}/${a.planifies} visites\n${fmt(a.benef)} bénéficiaires` : "\naucun site"}`}</title>
                      </path>);
                  })}
                  {/* Repères de communes : centroïdes du référentiel, chargés à la demande.
                      Inutiles dès que les contours sont là — ils disaient « il y a une
                      commune ici », ce que le contour dit mieux. */}
                  {!shapes.features.length && geoMarks.map((g,i) => (
                    <circle key={"g"+i} data-geo="1" cx={proj.x(+g.lon)} cy={proj.y(+g.lat)} r={1.2/view.k}
                            fill="#b9c6d1" opacity={0.7} />
                  ))}
                  {filtered.map(s => (
                    <circle key={s.id} data-site={s.code} data-name={s.name}
                      cx={proj.x(s.lon)} cy={proj.y(s.lat)} r={radiusOf(s)/Math.sqrt(view.k)}
                      fill={colorOf(s)} fillOpacity={0.82} stroke="#fff" strokeWidth={0.8/view.k}
                      onClick={()=>setSel(s)} style={{ cursor:"pointer" }}>
                      <title>{`${s.name}\n${s.adm3 || ""} · ${s.office || ""}\n${fmt(s.beneficiaries)} bénéficiaires\n${s.done}/${s.planned} visites`}</title>
                    </circle>
                  ))}
                  {sel && (
                    <circle cx={proj.x(sel.lon)} cy={proj.y(sel.lat)} r={(radiusOf(sel)+5)/Math.sqrt(view.k)}
                            fill="none" stroke={C.brandD} strokeWidth={2/view.k} />
                  )}
                </g>
                <g>
                  <rect x={12} y={H-46} width={188} height={34} fill="#fff" fillOpacity={0.92}
                        stroke="#e2e8ec" rx={3} />
                  <text x={22} y={H-30} fontSize="10" fill={C.t2}>Échelle approximative</text>
                  <line x1={22} y1={H-22} x2={22 + 100} y2={H-22} stroke={C.t1} strokeWidth="2" />
                  <text x={128} y={H-19} fontSize="10" fill={C.t2}>
                    {Math.round(100 / (proj.scale * view.k) * 111)} km</text>
                </g>
              </svg>
            </div>

            <aside className="w-72 shrink-0 border-l border-slate-200 p-4 mh68 overflow-auto">
              {/* L'échelle d'aplat en premier : c'est ce qui couvre la surface de la
                  carte, donc ce que l'œil interroge en premier. */}
              {fillMode !== "none" && !!shapes.features.length && (
                <div className="mb-4">
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                    {(FILL_MODES.find(m=>m[0]===fillMode)||[])[1]}
                    <span className="font-normal normal-case tracking-normal text-slate-400">
                      {" "}· {(GEO_LEVELS.find(g=>g[0]===geoLevel)||[])[1].toLowerCase()}</span></div>
                  <div className="flex h-3 rounded overflow-hidden border border-slate-200">
                    <i className="flex-1" style={{ background:"#ffffff" }} title="aucun" />
                    {RAMP.map(c => <i key={c} className="flex-1" style={{ background:c }} />)}
                  </div>
                  <div className="flex justify-between f105 text-slate-400 mt-1">
                    <span>aucun</span>
                    <span>{fillMode === "coverage" ? "100 %" : fmt(themeValues.max)}</span></div>
                  {!!themeValues.absent && (
                    <div className="f105 text-amber-700 mt-1">
                      {fmt(themeValues.absent)} site(s) sans rattachement au découpage :
                      visibles en points, comptés dans aucune unité.</div>)}
                  {shapes.tronque && (
                    <div className="f105 text-amber-700 mt-1">
                      Affichage tronqué : filtrez par région ou district pour voir ce niveau en entier.</div>)}
                </div>)}

              {!db.geoVersion?.geom?.units && (
                <Note tone="warn">Aucun contour chargé : la carte n'a pas de fond, et une
                  unité sans site reste invisible. Paramètres → Localités → Contours
                  administratifs.</Note>)}

              {selShape && (() => {
                const f = shapes.features.find(x => x.properties.pcode === selShape);
                const a = themeValues.par?.[selShape];
                return f && (
                  <div className="mb-4">
                    <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                      Unité sélectionnée</div>
                    <div className="border border-slate-200 rounded p-3">
                      <div className="f13 font-semibold text-slate-800">{f.properties.name}</div>
                      <div className="f11 text-slate-500 mb-2">{f.properties.level} · {selShape}</div>
                      <dl className="space-y-1 f115">
                        {[["Sites", a ? fmt(a.sites) : "0"],
                          ["dont actifs", a ? fmt(a.actifs) : "0"],
                          ["Visites", a ? `${fmt(a.visites)} / ${fmt(a.planifies)}` : "—"],
                          ["Bénéficiaires", a ? fmt(a.benef) : "—"]].map(([k,v])=>(
                          <div key={k} className="flex justify-between gap-2">
                            <dt className="text-slate-500">{k}</dt>
                            <dd className="font-medium tabular-nums">{v}</dd></div>))}
                      </dl>
                      {!a && <div className="f105 text-amber-700 mt-2">
                        Aucune présence enregistrée dans cette unité.</div>}
                    </div>
                  </div>);
              })()}

              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Légende des points</div>
              <ul className="space-y-1.5 mb-4">
                {legend.map(([col,label]) => (
                  <li key={label} className="flex items-center gap-2 f115 text-slate-600">
                    <i className="w-3 h-3 rounded-full inline-block shrink-0" style={{ background:col }} />
                    <span className="truncate" title={label}>{label}</span></li>))}
              </ul>
              {sel ? (
                <>
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Site sélectionné</div>
                  <div className="border border-slate-200 rounded p-3">
                    <div className="f13 font-semibold text-slate-800">{sel.name}</div>
                    <div className="f11 text-slate-500 mb-2">{sel.code} · {sel.office}</div>
                    <dl className="space-y-1 f115">
                      {[["Emplacement", [sel.adm1, sel.adm2, sel.adm3].filter(Boolean).join(", ")],
                        [niveau(db, "adm4"), sel.adm4 || "—"],
                        ["Catégorie", sel.category || "—"],
                        ["Activité", sel.activity_tag || "—"],
                        ["Bénéficiaires", fmt(sel.beneficiaries)],
                        ["Sécurité", (D_SECURITY.find(x=>x[0]===sel.security)||[])[1] || sel.security],
                        ["Coordonnées", `${r2(sel.lat)}, ${r2(sel.lon)}`],
                        ["Dernière visite", sel.last_visit || "jamais"]].map(([k,v]) => (
                        <div key={k} className="flex gap-2">
                          <dt className="text-slate-500 w-28 shrink-0">{k}</dt>
                          <dd className="text-slate-800 min-w-0 break-words">{v}</dd></div>))}
                    </dl>
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <div className="flex justify-between f115 text-slate-600 mb-1">
                        <span>Visites réalisées</span><b>{sel.done} / {sel.planned || "—"}</b></div>
                      <Bar2 value={sel.planned ? pct(sel.done, sel.planned) : 0}
                        tone={pct(sel.done, sel.planned) >= 80 ? "ok" : "warn"} />
                    </div>
                    <Btn size="sm" kind="sec" className="mt-3 w-full justify-center"
                      onClick={()=>go("settings","sites")}>Ouvrir dans le registre</Btn>
                  </div>
                </>
              ) : (
                <p className="f115 text-slate-500 leading-relaxed">
                  Cliquez sur un point pour afficher la fiche du site. Faites glisser la carte pour la déplacer
                  et utilisez les commandes de zoom.</p>
              )}
            </aside>
          </div>
        )}
      </Card>

      <Card flush title="Répartition géographique" subtitle="Sites, visites réalisées et bénéficiaires par région">
        <TableWrap max="mh340">
          <thead><tr><Th>Région</Th><Th num>Sites</Th><Th num>Visites réalisées</Th>
            <Th num>Bénéficiaires</Th><Th>Part des sites</Th></tr></thead>
          <tbody>{byRegion.map(r => (
            <tr key={r.region} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{r.region}</Td>
              <Td num>{fmt(r.sites)}</Td><Td num>{fmt(r.visites)}</Td><Td num>{fmt(r.benef)}</Td>
              <Td><div className="flex items-center gap-2">
                <Bar2 value={pct(r.sites, stats.total)} />
                <span className="tabular-nums f115">{pct(r.sites, stats.total)} %</span></div></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
    </div>
  );
}
