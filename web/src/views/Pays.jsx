import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, Download, Layers, MapPin, Plus, RefreshCw, Save, Search,
         Trash2, Upload } from "lucide-react";
import { api } from "../lib/api.js";
import { resetGeoCache } from "../lib/geo.js";
import { Badge, Btn, Card, Empty, Field, Input, Note, Select, Stat, StatRow, Sw,
         TableWrap, Td, Th, download, inputCls, toCSV } from "../components/ui.jsx";
import { clsx, fmt, r5 } from "../lib/calc.js";
import { GUESS, guessField, readGeoFile } from "../lib/shapefile.js";

/* ═══════════════════════════════════════════════════════════════════════
   Pays et découpage — une seule configuration, en deux écrans.

   C'étaient deux destinations séparées : « Pays » (nom, devise, vocabulaire) et
   « Localités » (import du découpage, contours, répertoire). Rien ne disait qu'elles
   parlaient de la même chose, et l'ordre correct — configurer le pays, PUIS importer
   son découpage — n'était écrit nulle part. Un administrateur qui ajoutait la RDC se
   retrouvait avec un pays sans géographie, et devait deviner que la suite se passait
   dans un autre onglet.

   Le découpage appartient donc à la fiche du pays. Ajouter un pays et charger son
   shapefile est un seul parcours, et l'écran dit à chaque étape ce qui manque.

   Deuxième changement : la fiche n'est plus une fenêtre modale mais une SOUS-PAGE.
   Une modale impose sa taille au contenu — d'où les champs serrés, les tableaux qui
   défilent dans un cadre de 300 px et le formulaire de vocabulaire à cinq lignes
   comprimé. Une sous-page a toute la largeur, et l'on y revient par un lien.

   Enfin, chaque appel au serveur porte le pays configuré (`?country=`). Sans cela,
   configurer la RDC depuis un compte qui travaille à Madagascar aurait importé le
   découpage congolais... dans Madagascar.
   ═══════════════════════════════════════════════════════════════════════ */

const ADM = ["adm0","adm1","adm2","adm3","adm4"];

/* Les libellés du pays CONFIGURÉ, qui n'est pas forcément celui où l'on travaille.
   `lib/levels.js` lit le pays courant : ici ce serait le mauvais vocabulaire. */
const libelles = (pays, plural = false) =>
  ADM.map(k => [k, (plural ? pays?.levels?.[k]?.many : pays?.levels?.[k]?.one) || k]);

/* ── Liste des pays ─────────────────────────────────────────────────── */
function ListePays({ data, can, busy, onOuvrir, onNouveau, onDefaut }){
  return (
    <>
      <Note>Le découpage administratif du schéma est neutre : <code className="bg-white px-1 rounded">adm0</code>
        {" "}à <code className="bg-white px-1 rounded">adm4</code>. Ce sont les <b>libellés</b> qui sont propres à
        un pays — région, district, commune, fokontany à Madagascar ; province, territoire, secteur,
        groupement en RDC. Ils sont configurés ici et utilisés partout, plutôt que réécrits écran par écran.
        <br /><br />
        <b>Une instance sert plusieurs pays.</b> Le pays marqué « par défaut » n'est pas « le pays de tout
        le monde » : c'est celui d'un compte qui n'en déclare aucun, et celui qu'un nouveau compte reçoit.
        Le pays dans lequel un utilisateur travaille est une propriété de <b>son compte</b>
        {" "}(Paramètres → Utilisateurs) ; un compte non borné le change par le sélecteur de l'en-tête.</Note>

      <Card flush title="Pays configurés"
        subtitle={`${data.rows.length} pays · par défaut : ${data.current?.name || "aucun"}`}
        right={can("admin") && <Btn size="sm" icon={Plus} onClick={onNouveau}>Ajouter un pays</Btn>}>
        <TableWrap>
          <thead><tr><Th>Pays</Th><Th>Code</Th><Th>Devise locale</Th><Th>Vocabulaire du découpage</Th>
            <Th num>Millésimes</Th><Th>État</Th><Th /></tr></thead>
          <tbody>{data.rows.map(c=>(
            /* La ligne entière ouvre la fiche : c'est le geste attendu d'un tableau
               dont chaque ligne est un objet configurable. */
            <tr key={c.code} className="hover:bg-sky-50 cursor-pointer" onClick={()=>onOuvrir(c)}>
              <Td className="font-medium text-slate-800">{c.name}
                {c.note && <div className="f105 text-slate-400 whitespace-normal mw420">{c.note}</div>}</Td>
              <Td className="f115 text-slate-500">{c.code}</Td>
              <Td className="f115">{c.currency}</Td>
              <Td className="f115 text-slate-600 whitespace-normal mw420">
                {["adm1","adm2","adm3","adm4"].map(l => c.levels[l]?.many).filter(Boolean).join(" · ")}</Td>
              {/* Un pays sans millésime n'est pas exploitable : le dire ici évite de
                  le découvrir devant une carte vide. */}
              <Td num className={c.versions ? "" : "text-amber-700"}>{c.versions || "aucun"}</Td>
              <Td>{c.current ? <Badge tone="g">par défaut</Badge>
                : c.active ? <Badge>actif</Badge> : <Badge tone="r">désactivé</Badge>}</Td>
              <Td className="text-right whitespace-nowrap" onClick={e=>e.stopPropagation()}>
                <Btn size="sm" kind="sec" onClick={()=>onOuvrir(c)}>Configurer</Btn>
                {can("admin") && !c.current && c.active && (
                  <Btn size="sm" kind="sec" className="ml-2" disabled={busy}
                    onClick={()=>onDefaut(c)}>Rendre par défaut</Btn>)}</Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
    </>);
}

/* ── Identité et vocabulaire ────────────────────────────────────────── */
function Identite({ edit, setEdit, niveauxSchema, busy, onSave, can }){
  const u = (k,v) => setEdit(p => ({ ...p, [k]:v }));
  return (
    <Card title={edit._existe ? "Identité et vocabulaire" : "Nouveau pays"}
      subtitle="Nom, devise locale et libellés des cinq niveaux administratifs"
      right={can("admin") && <Btn icon={Save} disabled={busy || !edit.name?.trim() || (edit.code||"").length !== 3}
        onClick={onSave}>{busy ? "Enregistrement…" : "Enregistrer"}</Btn>}>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="Nom du pays" className="col-span-2">
          <Input value={edit.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        <Field label="Code ISO" hint="Trois lettres — MDG, COD, ETH">
          <Input maxLength={3} value={edit.code||""} readOnly={edit._existe}
            onChange={e=>u("code",e.target.value.toUpperCase())} /></Field>
        <Field label="Devise locale" hint="Utilisée pour les contrats de prestataires">
          <Input maxLength={3} value={edit.currency||""}
            onChange={e=>u("currency",e.target.value.toUpperCase())} /></Field>
        <Field label="Latitude du centre" hint="Cadre la carte avant tout import de contours">
          <Input type="number" value={edit.lat ?? ""} onChange={e=>u("lat",e.target.value)} /></Field>
        <Field label="Longitude du centre">
          <Input type="number" value={edit.lon ?? ""} onChange={e=>u("lon",e.target.value)} /></Field>
        <Field label="Note" className="col-span-2">
          <Input value={edit.note||""} onChange={e=>u("note",e.target.value)} /></Field>
      </div>

      <Field label="Libellés des niveaux administratifs"
        hint="Singulier et pluriel. Les cinq sont exigés : un niveau non nommé s'afficherait « adm4 » quelque part.">
        {/* Cinq lignes de deux champs, sur toute la largeur : dans la fenêtre modale
            d'avant, le même tableau défilait dans 300 px de haut. */}
        <div className="grid gap-1.5">
          {niveauxSchema.map(l=>(
            <div key={l} className="grid items-center gap-2" style={{gridTemplateColumns:"5rem 1fr 1fr"}}>
              <span className="f115 c-bd font-semibold">{l}</span>
              <input value={edit.levels?.[l]?.one || ""} placeholder="singulier"
                className={clsx(inputCls,"mi-py1")}
                onChange={e=>setEdit(p=>({...p, levels:{...p.levels,
                  [l]:{ ...(p.levels?.[l]||{}), one:e.target.value }}}))} />
              <input value={edit.levels?.[l]?.many || ""} placeholder="pluriel"
                className={clsx(inputCls,"mi-py1")}
                onChange={e=>setEdit(p=>({...p, levels:{...p.levels,
                  [l]:{ ...(p.levels?.[l]||{}), many:e.target.value }}}))} />
            </div>))}
        </div>
      </Field>
      <Sw label="Pays actif" hint="Un pays désactivé ne peut être ni choisi ni rendu par défaut"
        on={edit.active !== false} onChange={v=>u("active",v)} />
    </Card>);
}

/* ── Découpage administratif d'un pays ──────────────────────────────── */
function Decoupage({ pays, db, can, notify }){
  const code = pays.code;
  const [versions,setVersions] = useState([]);
  const [draft,setDraft] = useState(null); const [status,setStatus] = useState(null);
  const [map,setMap] = useState({}); const [label,setLabel] = useState("");
  const [depth,setDepth] = useState("adm4"); const [busy,setBusy] = useState(false);
  const [geomDraft,setGeomDraft] = useState(null);
  const [geomMap,setGeomMap] = useState({});
  const [geomStat,setGeomStat] = useState(null);
  const [geomBusy,setGeomBusy] = useState(false);

  const loadVersions = () => api.geoVersions(code).then(r=>setVersions(r.rows||[])).catch(()=>{});
  useEffect(()=>{ loadVersions(); }, [code]);
  const courant = versions.find(v => v.current) || null;
  const noms = libelles(pays);

  /* ── Lecture du fichier de découpage ─────────────────────────────── */
  const onFile = async (file) => {
    setStatus({ kind:"info", text:"Lecture du fichier…" });
    try{
      const d = await readGeoFile(file);
      if(!d.rows.length) throw new Error("Aucun objet trouvé");
      const bad = d.cent.filter(Boolean).some(c => Math.abs(c[0])>180 || Math.abs(c[1])>90);
      if(bad) throw new Error("Les coordonnées sortent de la plage géographique : reprojetez le fichier en WGS 84 (EPSG:4326)");
      setDraft(d);
      /* La correspondance est PROPOSÉE à partir des noms de colonnes du fichier
         (ADM1_FR, ADM2_PCODE, NAME_2…), et reste modifiable : aucun jeu de données
         officiel ne nomme ses champs comme le voisin. Le niveau 0 retombe sur le nom
         du pays configuré quand le fichier ne le porte pas — c'est le cas le plus
         fréquent, un shapefile national ne répétant pas le pays sur chaque ligne. */
      setMap({ adm0:guessField(d.fields,GUESS.adm0), adm1:guessField(d.fields,GUESS.adm1),
        adm2:guessField(d.fields,GUESS.adm2), adm3:guessField(d.fields,GUESS.adm3),
        adm4:guessField(d.fields,GUESS.adm4), code:guessField(d.fields,GUESS.code) });
      setDepth(guessField(d.fields,GUESS.adm4) ? "adm4"
             : guessField(d.fields,GUESS.adm3) ? "adm3" : "adm2");
      setLabel(file.name.replace(/\.[^.]+$/,"") + " — " + new Date().toISOString().slice(0,10));
      setStatus({ kind:"ok", text:`${d.rows.length.toLocaleString("fr-FR")} objets lus depuis ${d.src} · ${d.fields.length} champs attributaires`
        + (d.geomSkipped ? " · centroïdes repris des attributs, la géométrie n'a pas eu besoin d'être ouverte" : "") });
    }catch(e){ setDraft(null); setStatus({ kind:"err", text:e.message }); }
  };

  /* Ce que l'on retiendra du fichier : au-delà du niveau choisi, les doublons sont
     regroupés. Le niveau 0 non désigné prend le nom du pays : le chemin normalisé
     commence par lui, et deux pays voisins ne peuvent donc pas collisionner. */
  const preview = useMemo(() => {
    if(!draft) return [];
    const keep = ADM.slice(0, ADM.indexOf(depth) + 1);
    const seen = new Set(); const out = [];
    draft.rows.forEach((r, i) => {
      const c = draft.cent[i];
      const g = {};
      ADM.forEach(k => { g[k] = (keep.includes(k) && map[k]) ? String(r[map[k]] ?? "") : ""; });
      if(!g.adm0) g.adm0 = pays.name;
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
  }, [draft, map, depth, pays.name]);

  const commit = async () => {
    if(!draft || !preview.length){
      notify("Aucune localité exploitable : vérifiez la correspondance des champs", "err"); return; }
    setBusy(true);
    try{
      const rows = preview.map(g => ({ adm0:g.adm0 || null, adm1:g.adm1 || null, adm2:g.adm2 || null,
        adm3:g.adm3 || null, adm4:g.adm4 || null, pcode:g.code || null,
        lat: g.lat === "" ? null : Number(g.lat), lon: g.lon === "" ? null : Number(g.lon) }));
      const r = await api.importGeo(rows, label.trim() || `Import du ${new Date().toISOString().slice(0,10)}`,
        draft.src || null, code);
      resetGeoCache(); setDraft(null);
      await loadVersions();
      const c = r.counts || {};
      setStatus({ kind:"ok", text:`${r.imported.toLocaleString("fr-FR")} unités enregistrées — `
        + noms.slice(1).filter(([k])=>c[k]).map(([k,l])=>`${c[k].toLocaleString("fr-FR")} ${l.toLowerCase()}`).join(", ")
        + (r.rejected ? ` · ${r.rejected} ligne(s) écartée(s)` : "") });
      notify(`Découpage importé pour ${pays.name} : ${r.imported.toLocaleString("fr-FR")} unités`, "ok");
    }catch(e){
      setStatus({ kind:"err", text:e.message + (e.details ? " — " + JSON.stringify(e.details).slice(0,180) : "") });
      notify("Import refusé : " + e.message, "err");
    }
    setBusy(false);
  };

  const activate = async (id, lb) => {
    try{ await api.setGeoVersion(id, code); resetGeoCache(); await loadVersions();
      notify(`Millésime courant de ${pays.name} : « ${lb} »`, "ok");
    }catch(e){ notify("Changement refusé : " + e.message, "err"); }
  };

  /* ── Contours ────────────────────────────────────────────────────── */
  const onGeomFile = async (file) => {
    setGeomStat({ kind:"info", text:"Lecture des géométries…" });
    try{
      const d = await readGeoFile(file, { withGeometry:true });
      const avec = d.geom?.filter(Boolean).length || 0;
      if(!avec) throw new Error("Aucun polygone : ce fichier ne porte pas de géométrie exploitable");
      setGeomDraft(d);
      setGeomMap({ adm1:guessField(d.fields,GUESS.adm1), adm2:guessField(d.fields,GUESS.adm2),
        adm3:guessField(d.fields,GUESS.adm3), adm4:guessField(d.fields,GUESS.adm4),
        code:guessField(d.fields,GUESS.code) });
      setGeomStat({ kind:"ok", text:`${avec.toLocaleString("fr-FR")} contour(s) lus depuis ${d.src}` });
    }catch(e){ setGeomDraft(null); setGeomStat({ kind:"err", text:e.message }); }
  };

  const commitGeom = async () => {
    if(!geomDraft) return;
    setGeomBusy(true);
    try{
      const feats = geomDraft.rows.map((r,i)=>{
        const g = geomDraft.geom[i]; if(!g) return null;
        const noms2 = {};
        for(const k of ["adm1","adm2","adm3","adm4"])
          if(geomMap[k]) noms2[k] = String(r[geomMap[k]] ?? "");
        return { ...noms2, pcode: geomMap.code ? String(r[geomMap.code] ?? "") : null, geometry:g };
      }).filter(Boolean);
      if(!feats.length) throw new Error("Aucun contour à envoyer : désignez au moins un champ de nom");

      /* Par lots : les contours d'un pays entier ne passent pas dans un corps de
         requête. Le premier lot porte `reset`, sinon deux imports successifs
         mêleraient leurs géométries. */
      const LOT = 120; let total = 0;
      for(let i = 0; i < feats.length; i += LOT){
        const r = await api.importGeometry(feats.slice(i, i+LOT),
          { reset: i === 0, source: geomDraft.src, pays: code });
        total += r.enregistres || 0;
        setGeomStat({ kind:"info", text:`Envoi… ${Math.min(i+LOT, feats.length)} / ${feats.length}` });
      }
      await loadVersions();
      setGeomDraft(null);
      setGeomStat({ kind:"ok", text:`${total.toLocaleString("fr-FR")} contour(s) enregistrés` });
      notify(`Contours enregistrés pour ${pays.name}`, "ok");
    }catch(e){ setGeomStat({ kind:"err", text:e.message }); notify(e.message, "err"); }
    setGeomBusy(false);
  };

  return (
    <>
      <Card title="Découpage administratif"
        subtitle={courant
          ? `Millésime courant : « ${courant.label} » — ${fmt(courant.units)} unités`
          : "aucun millésime : ce pays n'a pas encore de géographie"}>
        {courant ? (
          <StatRow>
            {noms.slice(1).map(([k,l])=>(
              <Stat key={k} label={l} value={fmt(courant.counts?.[k] || 0)} />))}
            <Stat label="Total des unités" value={fmt(courant.units)} />
          </StatRow>
        ) : (
          <Note tone="warn"><b>Aucun découpage chargé pour {pays.name}.</b> Les listes administratives,
            la carte et le rattachement des sites resteront vides tant qu'un fichier n'aura pas été importé
            ci-dessous.</Note>)}

        <Note>Chargez une archive <b>.zip</b> contenant un shapefile, ou un fichier <b>.shp</b>,
          <b> .dbf</b> ou <b>.geojson</b>. La lecture se fait entièrement <b>dans le navigateur</b> :
          aucun fichier n'est transmis, seules les lignes retenues partent au serveur. Les coordonnées
          doivent être en WGS 84.
          <br /><br />
          Pour un référentiel complet — de l'ordre de 18 000 unités au dernier niveau — préférez la ligne
          de commande, qui lit le fichier sans le charger en mémoire :
          <code className="bg-white px-1 rounded mx-1">node src/import-geo.js fichier.csv --label "COD-AB v2023.1"</code>
        </Note>

        <div className="grid grid-cols-2 gap-x-4">
          <Field label="Fichier du découpage">
            <input type="file" accept=".zip,.shp,.dbf,.geojson,.json" disabled={!can("admin")}
              onChange={e=>e.target.files[0]&&onFile(e.target.files[0])}
              className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
          <div className="self-center">{status && <Note tone={status.kind}>{status.text}</Note>}</div>
        </div>
        {!can("admin") && <Note tone="warn">L'import du découpage est réservé aux administrateurs.</Note>}

        {draft && (<>
          {/* La correspondance, dans le vocabulaire DU PAYS configuré : « Niveau 1 —
              Province » pour la RDC, « Niveau 1 — Région » pour Madagascar. C'est la
              question que se pose l'utilisateur devant son fichier. */}
          <Field label="Correspondance des champs"
            hint="À gauche le niveau du schéma et son libellé dans ce pays, à droite la colonne du fichier qui le porte.">
            <div className="grid gap-1.5">
              {noms.map(([k,l],i)=>(
                <div key={k} className="grid items-center gap-2" style={{gridTemplateColumns:"16rem 1fr"}}>
                  <span className="f125 text-slate-700">
                    <b className="c-bd">{k}</b> — {l}
                    {i===0 && <span className="text-slate-400"> (à défaut : {pays.name})</span>}</span>
                  <Select value={map[k]||""} onChange={e=>setMap(m=>({...m,[k]:e.target.value}))}
                    empty={i===0 ? `— ${pays.name} —` : "— aucun —"} options={draft.fields} className="mi-py1" />
                </div>))}
              <div className="grid items-center gap-2" style={{gridTemplateColumns:"16rem 1fr"}}>
                <span className="f125 text-slate-700"><b className="c-bd">pcode</b> — code administratif</span>
                <Select value={map.code||""} onChange={e=>setMap(m=>({...m,code:e.target.value}))}
                  empty="— dérivé du chemin de noms —" options={draft.fields} className="mi-py1" />
              </div>
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Niveau de détail à conserver"
              hint="Le niveau le plus fin peut représenter des dizaines de milliers d'entrées">
              <Select value={depth} onChange={e=>setDepth(e.target.value)}
                options={noms.slice(1).map(([k,l])=>[k, `Jusqu'au niveau ${k.slice(-1)} — ${l.toLowerCase()}`])} /></Field>
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
            <thead><tr>{noms.map(([k,l])=><Th key={k}>{l}</Th>)}
              <Th>P-code</Th><Th num>Latitude</Th><Th num>Longitude</Th></tr></thead>
            <tbody>{preview.slice(0,8).map((g,i)=>(
              <tr key={i}>{ADM.map(k=><Td key={k}>{g[k]}</Td>)}
                <Td className="f115">{g.code}</Td>
                <Td num className="f11">{g.lat}</Td><Td num className="f11">{g.lon}</Td></tr>))}</tbody>
          </TableWrap>
          <Btn className="mt-3" icon={Upload} disabled={busy || !preview.length || !can("admin")} onClick={commit}>
            {busy ? "Import en cours…" : `Importer ${preview.length.toLocaleString("fr-FR")} lignes`}</Btn>
        </>)}
      </Card>

      {/* ── Contours ─────────────────────────────────────────────────── */}
      <Card title="Contours administratifs — fond de carte"
        subtitle={courant?.geom?.units
          ? `${fmt(courant.geom.units)} unité(s) avec contour${courant.geom.source ? ` · ${courant.geom.source}` : ""}`
          : "aucun contour : la cartographie n'aura pas de fond dessiné"}
        right={can("admin") && courant?.geom?.units > 0 &&
          <Btn size="sm" kind="sec" icon={Trash2} disabled={geomBusy}
            onClick={async ()=>{ if(!confirm("Retirer tous les contours de ce millésime ?")) return;
              try{ const r = await api.clearGeometry(); await loadVersions();
                notify(`${fmt(r.supprimes)} contour(s) retiré(s)`, "ok");
              }catch(e){ notify(e.message, "err"); } }}>Retirer les contours</Btn>}>

        {!courant ? (
          <Note tone="warn">Chargez d'abord le découpage : les contours se rattachent à l'arbre
            administratif, ils ne le créent pas.</Note>
        ) : (<>
          {!!courant.geom?.parNiveau?.length && (
            <StatRow>
              {courant.geom.parNiveau.map(x=>(
                <Stat key={x.level} label={(pays.levels?.[x.level]?.many) || x.level}
                  value={fmt(x.units)}
                  sub={`${fmt(x.points_simple)} sommets affichés sur ${fmt(x.points)}`} />))}
            </StatRow>)}

          <Note>Le rattachement se fait par <b>chemin de noms</b>, comme pour les sites : les p-codes du
            référentiel sont dérivés du chemin, et un fichier de contours porte rarement les mêmes que
            celui du découpage. Importez <b>un niveau à la fois</b>. Le serveur simplifie les géométries
            et en conserve deux résolutions — l'allégée pour la vue d'ensemble, la fine pour le zoom.</Note>

          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Fichier de contours">
              <input type="file" accept=".zip,.shp,.geojson,.json" disabled={!can("admin") || geomBusy}
                onChange={e=>e.target.files[0]&&onGeomFile(e.target.files[0])}
                className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" /></Field>
            <div className="self-center">{geomStat && <Note tone={geomStat.kind}>{geomStat.text}</Note>}</div>
          </div>

          {geomDraft && (<>
            <div className="grid grid-cols-5 gap-x-3">
              {[...noms.slice(1), ["code","P-code (optionnel)"]].map(([k,l])=>(
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

      {versions.length > 1 && (
        <Card flush title="Millésimes" subtitle="Changer de millésime ne perd rien : les précédents restent disponibles">
          <TableWrap>
            <thead><tr><Th>Millésime</Th><Th>Provenance</Th><Th num>Unités</Th><Th>Importé le</Th><Th>Par</Th><Th /></tr></thead>
            <tbody>{versions.map(v=>(
              <tr key={v.id} className={clsx("hover:bg-sky-50", v.current && "bg-sky-50")}>
                <Td><b>{v.label}</b>{v.current && <Badge tone="g">courant</Badge>}</Td>
                <Td className="text-slate-500">{v.source || "—"}</Td>
                <Td num>{fmt(v.units)}</Td>
                <Td className="f115">{String(v.importedAt||"").slice(0,16)}</Td>
                <Td className="text-slate-500">{v.importedBy || "—"}</Td>
                <Td className="text-right">{!v.current && can("admin") &&
                  <Btn size="sm" kind="sec" icon={RefreshCw} onClick={()=>activate(v.id, v.label)}>Activer</Btn>}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </Card>)}
    </>);
}

/* ── Répertoire des unités du pays ──────────────────────────────────── */
function Repertoire({ pays, db }){
  const code = pays.code;
  const [q,setQ] = useState(""); const [page,setPage] = useState(0);
  const [niveau,setNiveau] = useState("adm3");
  const [dir,setDir] = useState({ rows:[], total:0, loading:true });
  const PER = 200;
  const noms = libelles(pays);

  useEffect(()=>{
    let alive = true;
    setDir(d=>({ ...d, loading:true }));
    const qs = new URLSearchParams({ level:niveau, limit:String(PER), offset:String(page*PER), country:code });
    if(q.trim()) qs.set("search", q.trim());
    const id = setTimeout(() => {
      api.geo("?"+qs).then(r => { if(alive) setDir({ ...r, loading:false }); })
        .catch(e => { if(alive) setDir({ rows:[], total:0, loading:false, error:e.message }); });
    }, q ? 280 : 0);
    return () => { alive = false; clearTimeout(id); };
  }, [code, niveau, q, page]);
  useEffect(()=>{ setPage(0); }, [code, niveau, q]);

  const pages = Math.ceil(dir.total / PER);
  const exp = () => download(`decoupage-${code}.csv`,
    toCSV(dir.rows, ["adm1","adm2","adm3","adm4","pcode","lat","lon"]), "text/csv");

  return (
    <Card flush title="Répertoire du découpage"
      subtitle={dir.loading ? "Chargement…"
        : `${fmt(dir.total)} unité(s) au niveau choisi · page ${page+1} sur ${Math.max(1,pages)}`}
      right={<>
        <Select value={niveau} onChange={e=>setNiveau(e.target.value)}
          options={noms.slice(1).map(([k,l])=>[k,l])} className="mi-py1 mi-xs mi-wauto" />
        <div className="relative"><Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Rechercher…"
            className={clsx(inputCls,"pl-7 mi-py1 w-44")} /></div>
        <Btn size="sm" kind="sec" icon={Download} onClick={exp} disabled={!dir.rows.length}>Exporter la page</Btn>
      </>}>
      <TableWrap>
        <thead><tr>{noms.slice(1).map(([k,l])=><Th key={k}>{l}</Th>)}
          <Th>P-code</Th><Th num>Latitude</Th><Th num>Longitude</Th></tr></thead>
        <tbody>{dir.rows.map(g=>(
          <tr key={g.pcode} className="hover:bg-sky-50">
            <Td className="text-slate-500">{g.adm1||"—"}</Td>
            <Td className="text-slate-500">{g.adm2||"—"}</Td>
            <Td>{g.adm3||"—"}</Td>
            <Td className="font-medium text-slate-800">{g.adm4 || g.name}</Td>
            <Td className="f115 c-bd">{g.pcode}</Td>
            <Td num className="f115">{g.lat ?? "—"}</Td><Td num className="f115">{g.lon ?? "—"}</Td>
          </tr>))}</tbody>
      </TableWrap>
      {!dir.loading && !dir.rows.length && (
        <div className="px-4 py-8 text-center f125 text-slate-500">
          {dir.error ? dir.error : "Aucune unité : importez un découpage pour ce pays."}</div>)}
      {pages > 1 && (
        <div className="px-4 py-2 flex items-center gap-2 f115 text-slate-500 border-t border-slate-100">
          <Btn size="sm" kind="sec" disabled={page===0} onClick={()=>setPage(p=>p-1)}>Précédent</Btn>
          <span>{fmt(page*PER+1)} – {fmt(Math.min((page+1)*PER, dir.total))} sur {fmt(dir.total)}</span>
          <Btn size="sm" kind="sec" disabled={page>=pages-1} onClick={()=>setPage(p=>p+1)}>Suivant</Btn>
        </div>)}
    </Card>);
}

/* ── Écran ──────────────────────────────────────────────────────────── */
export default function PaysEtDecoupage({ db, notify, can, reload }){
  const [data,setData] = useState(null);
  const [edit,setEdit] = useState(null);       /* la fiche ouverte, ou null pour la liste */
  const [busy,setBusy] = useState(false);

  const charger = () => api.countries().then(setData)
    .catch(e => { notify(e.message,"err"); setData({ rows:[], levels:[] }); });
  useEffect(()=>{ charger(); },[]);
  if(!data) return <Empty icon={MapPin} title="Chargement de la configuration des pays…" />;

  const vide = { code:"", name:"", currency:"USD", active:true,
    levels: Object.fromEntries((data.levels||[]).map(l => [l, { one:"", many:"" }])) };

  const enregistrer = async () => {
    setBusy(true);
    const b = { code:edit.code, name:edit.name, currency:edit.currency,
      levels:edit.levels, lat:edit.lat ?? null, lon:edit.lon ?? null,
      note:edit.note || null, active:edit.active !== false };
    if(edit._existe) b.rev = edit.rev;
    try{
      const r = edit._existe ? await api.updateCountry(edit.code, b) : await api.createCountry(b);
      await charger();
      /* On reste sur la fiche : après avoir créé un pays, la suite du travail est
         d'importer son découpage, et c'est ici. Revenir à la liste obligerait à
         rouvrir ce qu'on vient de créer. */
      setEdit({ ...(r.country || b), _existe:true });
      /* Les libellés voyagent avec l'état initial : sans rechargement, les écrans
         continueraient d'afficher l'ancien vocabulaire jusqu'au prochain F5. */
      if(reload) await reload();
      notify("Pays enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const rendreDefaut = async (c) => {
    if(!confirm(`Faire de « ${c.name} » le pays par défaut de l'instance ? Les comptes sans pays déclaré y basculeront.`)) return;
    setBusy(true);
    try{ const r = await api.setDefaultCountry(c.code); await charger();
      if(reload) await reload();
      notify(r.avertissement || `Pays par défaut : ${c.name}`, r.avertissement ? "warn" : "ok");
    }catch(e){ notify(e.message,"err"); }
    setBusy(false);
  };

  if(!edit) return (
    <ListePays data={data} can={can} busy={busy}
      onOuvrir={c=>setEdit({ ...c, _existe:true })}
      onNouveau={()=>setEdit({ ...vide, _existe:false })}
      onDefaut={rendreDefaut} />);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Btn kind="sec" size="sm" icon={ArrowLeft} onClick={()=>setEdit(null)}>Tous les pays</Btn>
        <div className="f13 font-semibold text-slate-800">
          {edit._existe ? edit.name : "Nouveau pays"}
          {edit._existe && <span className="f115 font-normal text-slate-500 ml-2">{edit.code} · {edit.currency}</span>}
        </div>
        {edit.current && <Badge tone="g">pays par défaut de l'instance</Badge>}
      </div>

      <Identite edit={edit} setEdit={setEdit} niveauxSchema={data.levels||[]}
        busy={busy} onSave={enregistrer} can={can} />

      {/* Le découpage n'a de sens qu'une fois le pays enregistré : il s'y rattache
          par son code. Le dire plutôt que d'afficher un formulaire qui échouerait. */}
      {edit._existe ? (<>
        <Decoupage pays={edit} db={db} can={can} notify={notify} />
        <Repertoire pays={edit} db={db} />
      </>) : (
        <Note tone="info">Enregistrez d'abord le pays : le découpage administratif se rattache à son
          code, et l'import n'aurait nulle part où aller.</Note>)}
    </div>);
}
