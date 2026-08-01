import { useEffect, useState } from "react";
import { Download, MapPin, RefreshCw } from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, Btn, Card, Empty, Note, Select, Stat, StatRow, TableWrap, Td, Th, download, toCSV } from "../components/ui.jsx";
import { fmt } from "../lib/calc.js";

/* ── Vérification GPS des points, façon PAM GPS AUDIT TOOL (docs/app.R) ─
   L'outil R rattache chaque point à sa commune d'accueil, puis mesure l'écart
   entre le GPS relevé et le centroïde de cette commune pour repérer les points
   suspects. On reprend la démarche : le serveur résout la commune (par p-code ou
   par nom, comme le rattachement du registre), calcule la distance à vol
   d'oiseau au centroïde, et vérifie que le point tombe dans la boîte englobante
   de la commune. Quatre verdicts : conforme, éloigné, hors emprise, non rattaché. */

const VERDICTS = {
  ok:        { l:"Conforme",     tone:"g", desc:"proche du centroïde, dans l'emprise" },
  far:       { l:"Éloigné",      tone:"y", desc:"au-delà du seuil de distance" },
  outside:   { l:"Hors emprise", tone:"r", desc:"hors de la boîte englobante de sa commune" },
  unmatched: { l:"Non rattaché", tone:"n", desc:"commune d'accueil introuvable" },
};

function GpsAudit({ notify }){
  const [seuil,setSeuil] = useState(15);
  const [d,setD] = useState({ rows:[], bilan:null, loading:true });
  const [filtre,setFiltre] = useState("");   /* "" = tous ; sinon verdict */

  const charger = () => {
    setD(x => ({ ...x, loading:true }));
    api.gpsAudit(`?seuil=${seuil}`)
      .then(r => setD({ rows:r.rows||[], bilan:r.bilan||null, version:r.version, loading:false }))
      .catch(e => { setD({ rows:[], bilan:null, loading:false, error:e.message }); notify?.(e.message,"err"); });
  };
  useEffect(()=>{ charger(); }, [seuil]);

  const b = d.bilan;
  const rows = filtre ? d.rows.filter(r => r.verdict === filtre) : d.rows;

  const exporter = () => {
    download(`verification_gps_seuil${seuil}.csv`,
      toCSV(d.rows.map(r => ({ Site:r.name, Code:r.code, Activité:r.tag||"", District:r.adm2||"",
        "Commune saisie":r.adm3||"", "Commune d'accueil":r.commune||"", Latitude:r.lat, Longitude:r.lon,
        "Distance au centroïde (km)":r.dist ?? "", "Dans l'emprise":r.inBbox===null?"":(r.inBbox?"oui":"non"),
        Verdict:VERDICTS[r.verdict]?.l || r.verdict })),
        ["Site","Code","Activité","District","Commune saisie","Commune d'accueil","Latitude","Longitude",
         "Distance au centroïde (km)","Dans l'emprise","Verdict"]),
      "text/csv");
    notify?.("Vérification GPS exportée","ok");
  };

  if(d.error) return <Note tone="warn"><b>Vérification indisponible.</b> {d.error} — un référentiel géographique
    courant est nécessaire (Paramètres → Localités).</Note>;

  return (
    <div className="space-y-4">
      <Note>Chaque point est rattaché à sa <b>commune d'accueil</b> (par p-code, sinon par nom), puis on mesure
        l'écart entre le <b>GPS relevé</b> et le <b>centroïde</b> de cette commune, et l'on vérifie que le point
        tombe dans son emprise. Reprend la démarche de l'outil d'audit GPS du PAM ; la distance est à vol
        d'oiseau (borne basse), non routière — un point <b>éloigné</b> ou <b>hors emprise</b> mérite un
        contrôle : coordonnées inversées, virgule déplacée, ou saisie dans la mauvaise unité.</Note>

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={String(seuil)} onChange={e=>setSeuil(+e.target.value)} className="mi-py1 mi-xs mi-wauto"
          options={[5,10,15,20,30,50].map(s=>[String(s), `Seuil : ${s} km`])} />
        <Btn size="sm" kind="sec" icon={RefreshCw} onClick={charger} disabled={d.loading}>Recalculer</Btn>
        <Btn size="sm" kind="sec" icon={Download} onClick={exporter} disabled={!d.rows.length}>Exporter</Btn>
        {d.version && <span className="f11 text-slate-400">Millésime : {d.version.label}</span>}
      </div>

      {b && (
        <StatRow>
          <Stat label="Points GPS" value={fmt(b.total)} sub="dans votre périmètre" />
          <Stat label="Conformes" value={fmt(b.ok)} sub={`${b.total?Math.round(b.ok/b.total*100):0} %`} tone="ok" />
          <Stat label="Éloignés" value={fmt(b.far)} sub={`> ${seuil} km du centroïde`} tone={b.far?"warn":""} />
          <Stat label="Hors emprise" value={fmt(b.outside)} sub="hors boîte englobante" tone={b.outside?"bad":""} />
          <Stat label="Non rattachés" value={fmt(b.unmatched)} sub="commune introuvable" tone={b.unmatched?"warn":""} />
        </StatRow>)}

      <Card flush title="Points à contrôler" subtitle={d.loading ? "Calcul en cours…"
          : `${fmt(rows.length)} point(s)${filtre?` — ${VERDICTS[filtre]?.l}`:""} · triés du plus suspect au plus conforme`}
        right={<div className="flex items-center gap-2 flex-wrap">
          {Object.entries(VERDICTS).map(([k,vd])=>(
            <button key={k} onClick={()=>setFiltre(f=>f===k?"":k)}
              className={`f11 px-2 py-1 rounded-full border transition-colors ${filtre===k?"bg-slate-800 text-white border-transparent":"bg-white border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
              {vd.l} {b ? `(${fmt(b[k]||0)})` : ""}</button>))}
        </div>}>
        {!rows.length
          ? <Empty icon={MapPin} title={d.loading?"Calcul…":"Aucun point"} text="Aucun point GPS à ce filtre." />
          : <TableWrap max="mh520">
            <thead><tr><Th>Site</Th><Th>Activité</Th><Th>District</Th><Th>Commune saisie</Th>
              <Th>Commune d'accueil</Th><Th num>Distance</Th><Th>Emprise</Th><Th>Verdict</Th></tr></thead>
            <tbody>{rows.slice(0,1500).map(r=>{
              const vd = VERDICTS[r.verdict] || {};
              return (
              <tr key={r.id} className="hover:bg-sky-50">
                <Td><div className="font-medium text-slate-800">{r.name}</div>
                  <div className="f10 text-slate-400">{r.code} · {r.lat?.toFixed(4)}, {r.lon?.toFixed(4)}</div></Td>
                <Td>{r.tag ? <Badge tone="b">{r.tag}</Badge> : "—"}</Td>
                <Td className="f115 text-slate-500">{r.adm2||"—"}</Td>
                <Td className="f115 text-slate-600">{r.adm3||"—"}</Td>
                <Td className="f115 text-slate-600">{r.commune || <span className="text-slate-400">introuvable</span>}</Td>
                <Td num className="tabular-nums font-semibold">{r.dist!=null ? `${fmt(r.dist)} km` : "—"}</Td>
                <Td>{r.inBbox===null ? <span className="f11 text-slate-300">—</span>
                  : r.inBbox ? <Badge tone="g">dans</Badge> : <Badge tone="r">hors</Badge>}</Td>
                <Td><Badge tone={vd.tone}>{vd.l || r.verdict}</Badge></Td>
              </tr>); })}</tbody>
          </TableWrap>}
      </Card>
    </div>);
}

export { GpsAudit };
