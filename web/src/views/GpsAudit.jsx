import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Download, MapPin, RefreshCw, Save } from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow, TableWrap, Td, Th, download, toCSV } from "../components/ui.jsx";
import { clsx, fmt } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Vérification GPS des points (portage de docs/app.R) ══════════════════
   L'outil R rattache chaque point à sa commune d'accueil, mesure l'écart au
   CENTROÏDE (distance routière estimée = vol d'oiseau × 1,3, le repli d'app.R
   hors OSRM), et signale les points suspects. Ici on ajoute ce qui manquait :
   on AFFICHE les points sur une carte, et on donne la main pour les CORRIGER —
   coordonnées inversées, virgule déplacée, mauvaise unité. */

const VERDICTS = {
  ok:        { l:"Conforme",     tone:"g", couleur:C.ok  },
  far:       { l:"Éloigné",      tone:"y", couleur:C.warn },
  outside:   { l:"Hors emprise", tone:"r", couleur:C.bad  },
  unmatched: { l:"Non rattaché", tone:"n", couleur:"#94a3b8" },
};

function GpsAudit({ notify, can }){
  const [seuil,setSeuil] = useState(15);
  const [d,setD] = useState({ rows:[], bilan:null, loading:true });
  const [filtre,setFiltre] = useState("");
  const [corr,setCorr] = useState(null);   /* site en correction */

  const charger = () => {
    setD(x => ({ ...x, loading:true }));
    api.gpsAudit(`?seuil=${seuil}`)
      .then(r => setD({ rows:r.rows||[], bilan:r.bilan||null, version:r.version, methode:r.methode, loading:false }))
      .catch(e => { setD({ rows:[], bilan:null, loading:false, error:e.message }); notify?.(e.message,"err"); });
  };
  useEffect(()=>{ charger(); }, [seuil]);

  const b = d.bilan;
  const rows = filtre ? d.rows.filter(r => r.verdict === filtre) : d.rows;
  const avecGps = d.rows.filter(r => r.lat != null && r.lon != null);

  const exporter = () => {
    download(`verification_gps_seuil${seuil}.csv`,
      toCSV(d.rows.map(r => ({ Site:r.name, Code:r.code, Activité:r.tag||"", Bureau:r.office||"", District:r.adm2||"",
        "Commune saisie":r.adm3||"", "Commune d'accueil":r.commune||"", Latitude:r.lat, Longitude:r.lon,
        "Distance routière (km)":r.dist ?? "", "Dans l'emprise":r.inBbox===null?"":(r.inBbox?"oui":"non"),
        Verdict:VERDICTS[r.verdict]?.l || r.verdict })),
        ["Site","Code","Activité","Bureau","District","Commune saisie","Commune d'accueil","Latitude","Longitude",
         "Distance routière (km)","Dans l'emprise","Verdict"]),
      "text/csv");
    notify?.("Vérification GPS exportée","ok");
  };

  if(d.error) return <Note tone="warn"><b>Vérification indisponible.</b> {d.error} — un référentiel géographique
    courant est nécessaire (Paramètres › Localités).</Note>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(seuil)} onChange={e=>setSeuil(+e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[5,10,15,20,30,50].map(s=>[String(s), `Seuil d'alerte : ${s} km`])} />
        <Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger} disabled={d.loading}>Recalculer</Btn>
        <Btn size="sm" kind="sec" icon={Download} onClick={exporter} disabled={!d.rows.length}>Exporter</Btn>
        <span className="f11 text-slate-400 ml-1">Distance routière estimée = vol d'oiseau × 1,3 (méthode app.R, hors OSRM)</span>
      </div>

      {b && (
        <StatRow>
          <Stat label="Points GPS" value={fmt(b.total)} sub="dans votre périmètre" />
          <Stat label="Conformes" value={fmt(b.ok)} sub={`${b.total?Math.round(b.ok/b.total*100):0} %`} tone="ok" />
          <Stat label="Éloignés" value={fmt(b.far)} sub={`> ${seuil} km du centroïde`} tone={b.far?"warn":""} />
          <Stat label="Hors emprise" value={fmt(b.outside)} sub="hors boîte englobante" tone={b.outside?"bad":""} />
          <Stat label="Non rattachés" value={fmt(b.unmatched)} sub="commune introuvable" tone={b.unmatched?"warn":""} />
        </StatRow>)}

      {/* ── Carte des points ── */}
      <Card flush title="Carte des points GPS"
        subtitle={`${fmt(avecGps.length)} point(s) géolocalisé(s) · couleur selon le verdict`}>
        <CarteAudit points={filtre ? avecGps.filter(r=>r.verdict===filtre) : avecGps} onPick={r=>can?.("edit") && setCorr(r)} />
      </Card>

      {/* ── Tableau des points à contrôler, avec correction ── */}
      <Card flush title="Points à contrôler" subtitle={d.loading ? "Calcul en cours…"
          : `${fmt(rows.length)} point(s)${filtre?` — ${VERDICTS[filtre]?.l}`:""} · du plus suspect au plus conforme`}
        right={<div className="flex items-center gap-2 flex-wrap">
          {Object.entries(VERDICTS).map(([k,vd])=>(
            <button key={k} onClick={()=>setFiltre(f=>f===k?"":k)}
              className={clsx("f11 px-2 py-1 rounded-full border transition-colors inline-flex items-center gap-1.5",
                filtre===k?"bg-slate-800 text-white border-transparent":"bg-white border-slate-200 text-slate-600 hover:bg-slate-50")}>
              <span className="w-2 h-2 rounded-full" style={{ background:vd.couleur }} />
              {vd.l} {b ? `(${fmt(b[k]||0)})` : ""}</button>))}
        </div>}>
        {!rows.length
          ? <Empty icon={MapPin} title={d.loading?"Calcul…":"Aucun point"} text="Aucun point GPS à ce filtre." />
          : <TableWrap max="mh480">
            <thead><tr><Th>Site</Th><Th>Activité</Th><Th>Bureau</Th><Th>Commune saisie</Th>
              <Th>Commune d'accueil</Th><Th num>Distance</Th><Th>Emprise</Th><Th>Verdict</Th><Th /></tr></thead>
            <tbody>{rows.slice(0,1200).map(r=>{
              const vd = VERDICTS[r.verdict] || {};
              return (
              <tr key={r.id} className="hover:bg-sky-50">
                <Td><div className="font-medium text-slate-800">{r.name}</div>
                  <div className="f10 text-slate-400">{r.code} · {r.lat?.toFixed(5)}, {r.lon?.toFixed(5)}</div></Td>
                <Td>{r.tag ? <Badge tone="b">{r.tag}</Badge> : "—"}</Td>
                <Td className="f115 text-slate-500">{r.office || "—"}</Td>
                <Td className="f115 text-slate-600">{r.adm3||"—"}</Td>
                <Td className="f115 text-slate-600">{r.commune || <span className="text-slate-400">introuvable</span>}</Td>
                <Td num className="tabular-nums font-semibold">{r.dist!=null ? `${fmt(r.dist)} km` : "—"}</Td>
                <Td>{r.inBbox===null ? <span className="f11 text-slate-300">—</span>
                  : r.inBbox ? <Badge tone="g">dans</Badge> : <Badge tone="r">hors</Badge>}</Td>
                <Td><Badge tone={vd.tone}>{vd.l || r.verdict}</Badge></Td>
                <Td className="text-right">{can?.("edit") && r.lat!=null &&
                  <Btn size="sm" kind="sec" onClick={()=>setCorr(r)}>Corriger</Btn>}</Td>
              </tr>); })}</tbody>
          </TableWrap>}
      </Card>

      <CorrectionModal site={corr} onClose={()=>setCorr(null)} notify={notify}
        onSaved={()=>{ setCorr(null); charger(); }} />
    </div>);
}

/* La carte d'ensemble : un point coloré par verdict, cliquable pour corriger. */
/* Leaflet rend les info-bulles en HTML : le nom d'un site (saisi par l'utilisateur)
   ou d'une commune doit être échappé avant d'y être posé. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

function CarteAudit({ points, onPick }){
  const boxRef = useRef(null); const mapRef = useRef(null); const layerRef = useRef(null);
  useEffect(()=>{
    if(!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { zoomControl:true, attributionControl:false, preferCanvas:true })
      .setView([-18.9, 46.9], 5);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom:18, subdomains:"abcd" })
      .addTo(map).on("tileerror", ()=>{});
    mapRef.current = map; layerRef.current = L.layerGroup().addTo(map);
    return ()=>{ map.remove(); mapRef.current = null; };
  }, []);
  useEffect(()=>{
    const map = mapRef.current, g = layerRef.current; if(!map || !g) return;
    g.clearLayers();
    const pts = [];
    for(const p of points.slice(0, 2000)){
      const c = (VERDICTS[p.verdict]||{}).couleur || "#64748b";
      const m = L.circleMarker([p.lat, p.lon], { radius:4, color:"#fff", weight:1, fillColor:c, fillOpacity:0.9 })
        .bindTooltip(`${esc(p.name)} — ${p.dist!=null?p.dist+" km":"non rattaché"}`, { direction:"top" });
      if(onPick) m.on("click", ()=>onPick(p));
      m.addTo(g); pts.push([p.lat, p.lon]);
    }
    if(pts.length){ try{ map.fitBounds(pts, { padding:[24,24], maxZoom:9 }); }catch{} }
    setTimeout(()=>map.invalidateSize(), 60);
  }, [points, onPick]);
  return <div ref={boxRef} style={{ height:360 }} className="w-full rounded-b-2xl" />;
}

/* La correction d'un point : coordonnées éditables, correctif « inverser lat/lon »
   (l'erreur GPS la plus fréquente), et une mini-carte qui montre le point (glissable)
   face au centroïde de sa commune. Enregistre sur le site, puis rejoue l'audit. */
function CorrectionModal({ site, onClose, notify, onSaved }){
  const [lat,setLat] = useState(""); const [lon,setLon] = useState(""); const [busy,setBusy] = useState(false);
  const boxRef = useRef(null); const mapRef = useRef(null); const markRef = useRef(null); const lineRef = useRef(null);
  useEffect(()=>{ if(site){ setLat(String(site.lat)); setLon(String(site.lon)); } }, [site]);

  useEffect(()=>{
    if(!site || !boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { zoomControl:true, attributionControl:false })
      .setView([site.lat, site.lon], 9);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", { maxZoom:18, subdomains:"abcd" })
      .addTo(map).on("tileerror", ()=>{});
    /* Le centroïde de la commune d'accueil, en repère fixe. */
    if(site.cLat!=null && site.cLon!=null)
      L.circleMarker([site.cLat, site.cLon], { radius:7, color:"#fff", weight:2, fillColor:C.brand, fillOpacity:0.9 })
        .bindTooltip("Centroïde — "+(site.commune||"commune"), { permanent:false }).addTo(map);
    /* Le point du site, GLISSABLE. */
    const mk = L.marker([site.lat, site.lon], { draggable:true }).addTo(map);
    mk.on("dragend", ()=>{ const p = mk.getLatLng(); setLat(p.lat.toFixed(6)); setLon(p.lng.toFixed(6)); });
    map.on("click", (e)=>{ mk.setLatLng(e.latlng); setLat(e.latlng.lat.toFixed(6)); setLon(e.latlng.lng.toFixed(6)); });
    mapRef.current = map; markRef.current = mk;
    setTimeout(()=>map.invalidateSize(), 80);
    return ()=>{ map.remove(); mapRef.current = null; markRef.current = null; };
  }, [site]);

  /* Refléter les saisies numériques sur la carte, et tracer le lien au centroïde. */
  useEffect(()=>{
    const map = mapRef.current, mk = markRef.current; if(!map || !mk) return;
    const la = parseFloat(lat), lo = parseFloat(lon);
    if(Number.isFinite(la) && Number.isFinite(lo)){
      mk.setLatLng([la, lo]);
      if(lineRef.current){ map.removeLayer(lineRef.current); lineRef.current = null; }
      if(site?.cLat!=null) lineRef.current = L.polyline([[la,lo],[site.cLat,site.cLon]],
        { color:"#94a3b8", weight:1, dashArray:"4 4" }).addTo(map);
    }
  }, [lat, lon, site]);

  if(!site) return null;
  const la = parseFloat(lat), lo = parseFloat(lon);
  const valide = Number.isFinite(la) && la>=-90 && la<=90 && Number.isFinite(lo) && lo>=-180 && lo<=180;
  const inverser = ()=>{ setLat(lon); setLon(lat); };

  const enregistrer = async () => {
    if(!valide) return; setBusy(true);
    try{ await api.updateSite(site.id, { lat:la, lon:lo });
      notify?.("Coordonnées corrigées","ok"); onSaved?.();
    }catch(e){ notify?.(e.message,"err"); } setBusy(false);
  };

  return (
    <Modal open wide onClose={onClose} title={`Corriger — ${site.name}`}
      subtitle={`${site.code}${site.commune?` · commune d'accueil : ${site.commune}`:""}`}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy||!valide} onClick={enregistrer}>Enregistrer les coordonnées</Btn></>}>
      <div className="grid gap-4" style={{ gridTemplateColumns:"1fr 300px" }}>
        <div ref={boxRef} style={{ height:340 }} className="rounded-lg border border-slate-200 overflow-hidden" />
        <div>
          <Note tone="tool">Glissez le point sur la carte, ou cliquez pour le repositionner, ou corrigez les
            coordonnées à la main. Le repère bleu est le <b>centroïde</b> de la commune d'accueil.</Note>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <Field label="Latitude" className="mb-0"><Input value={lat} onChange={e=>setLat(e.target.value)} /></Field>
            <Field label="Longitude" className="mb-0"><Input value={lon} onChange={e=>setLon(e.target.value)} /></Field>
          </div>
          <Btn size="sm" kind="sec" onClick={inverser} className="mt-2">Inverser latitude / longitude</Btn>
          <div className="f11 text-slate-500 mt-3 leading-relaxed">
            Cas fréquents : <b>lat/lon inversées</b> (bouton ci-dessus), une <b>virgule déplacée</b>
            {" "}(vérifiez l'ordre de grandeur), ou une saisie <b>hors du pays</b>.
            {site.dist!=null && <> Distance actuelle au centroïde : <b>{fmt(site.dist)} km</b>.</>}
          </div>
        </div>
      </div>
    </Modal>);
}

export { GpsAudit };
