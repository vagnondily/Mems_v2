import React, { useState, useEffect, useMemo, useRef } from "react";
import { MapPin, Search, RefreshCw, Download, Users, Target, Activity, AlertTriangle, Layers } from "lucide-react";
import { C, MONTHS_L, D_SECURITY } from "../lib/constants.js";
import { fmt, pct, n, r2, clsx } from "../lib/calc.js";
import { download, toCSV } from "../components/ui.jsx";
import { Card, Btn, Select, Stat, StatRow, Empty, Note, Bar2, TableWrap, Th, Td, inputCls } from "../components/ui.jsx";
import { api } from "../lib/api.js";

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

  const proj = useMemo(() => makeProjection(bounds, W, H), [bounds]);
  const tags = useMemo(() => [...new Set(rows.map(s => s.activity_tag).filter(Boolean))].sort(), [rows]);
  const adm1s = useMemo(() => [...new Set(db.geo.map(g => g.adm1).filter(Boolean))].sort(), [db.geo]);
  const adm2s = useMemo(() => [...new Set(db.geo.filter(g => !f.adm1 || g.adm1 === f.adm1)
    .map(g => g.adm2).filter(Boolean))].sort(), [db.geo, f.adm1]);

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

        {!proj || !filtered.length ? (
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
                  {/* Repères de communes : centroïdes du découpage administratif importé */}
                  {(db.geo || []).filter(g => g.lat && g.lon).slice(0, 1200).map((g,i) => (
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
              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Légende</div>
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
                        ["Fokontany", sel.adm4 || "—"],
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
