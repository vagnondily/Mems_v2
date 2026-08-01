import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { Check, Download, Link2, Search } from "lucide-react";
import { Aide, Badge, Btn, Card, Empty, Field, Input, Note, Select, Stat, StatRow,
         TableWrap, Td, Th } from "../components/ui.jsx";
import { fmt } from "../lib/calc.js";

/* ══════════════════ Référentiels de codes d'identification ══════════════════

   Répond mot pour mot à la demande : « Les smp utilise des code ecoles validee
   par tous pour etre identifier donc elles peuvent etre inserer dans les
   parametres comme base specifiques de la smp (que l on pourrait mettre a jour
   a partir d un fichier excel comme referentiel). »

   Trois raisons expliquent la forme de cet écran :

     — il est dans PARAMÈTRES et non dans l'import de Suivi-évaluation. Cet
       écran-là impose un exercice et refuse de s'afficher sans millésime
       géographique : deux conditions qui n'ont aucun sens pour une liste de
       codes école ;
     — il ne passe par aucune collection synchronisée. Un référentiel de 1 251
       lignes chargé au démarrage puis renvoyé au serveur à chaque enregistrement
       de l'état serait un aller-retour permanent. Il lit ses propres points
       d'API, comme le fait l'écran des connecteurs ;
     — il montre les ÉCHECS du rapprochement au même rang que ses succès. Un
       bilan muet sur ce qu'il n'a pas su faire se lit comme une réussite, et
       c'est exactement ainsi qu'on découvre six mois plus tard que trois cents
       écoles n'ont jamais été rattachées.
   ═══════════════════════════════════════════════════════════════════════ */

const PAGE = 50;

function SetCodeReferentiels({ notify, can }){
  const [refs,setRefs]     = useState([]);        /* les référentiels chargés, avec compteurs */
  const [sel,setSel]       = useState("");        /* celui qu'on consulte */
  const [nom,setNom]       = useState("");        /* celui qu'on s'apprête à charger */
  const [q,setQ]           = useState("");
  const [offset,setOffset] = useState(0);
  const [liste,setListe]   = useState({ total:0, rows:[] });
  const [etat,setEtat]     = useState(null);
  const [prev,setPrev]     = useState(null);      /* prévisualisation du lot d'import */
  const [bilan,setBilan]   = useState(null);      /* compte rendu du rapprochement */
  const [busy,setBusy]     = useState("");
  const [err,setErr]       = useState(null);
  /* Un rapprochement change le site rattaché de lignes déjà affichées, sans
     toucher ni la sélection ni la recherche : sans ce compteur, le tableau
     resterait sur l'état d'avant et contredirait le bilan juste au-dessus. */
  const [tick,setTick]     = useState(0);
  const fileRef = useRef(null);

  const admin = can("admin");

  const charger = () => api.codeReferentiels().then(r => {
    const rows = r.rows || [];
    setRefs(rows);
    setSel(p => p || rows[0]?.referentiel || "");
  }).catch(e => notify(e.message, "err"));

  useEffect(() => { charger(); }, []);

  /* La liste et l'état suivent la sélection, la recherche et la page. L'état est
     relu à chaque fois plutôt que déduit des compteurs de la liste : ils ne
     comptent pas la même chose, et un écran qui recalcule finit par diverger. */
  useEffect(() => {
    if(!sel){ setListe({ total:0, rows:[] }); setEtat(null); return; }
    let vivant = true;
    const qs = new URLSearchParams({ limit:String(PAGE), offset:String(offset) });
    if(q.trim()) qs.set("q", q.trim());
    api.codeReferentiel(sel, "?" + qs)
      .then(r => { if(vivant) setListe({ total:r.total || 0, rows:r.rows || [] }); })
      .catch(e => { if(vivant){ setListe({ total:0, rows:[] }); notify(e.message, "err"); } });
    api.etatCodes(sel).then(r => { if(vivant) setEtat(r); }).catch(() => {});
    return () => { vivant = false; };
  }, [sel, q, offset, tick]);

  useEffect(() => { setOffset(0); setBilan(null); setPrev(null); }, [sel]);

  /* Le référentiel du modèle : celui qu'on saisit s'il est renseigné, sinon celui
     qu'on consulte. C'est ce qui permet d'en créer un premier alors qu'aucun
     n'existe encore — le cas de la toute première utilisation. */
  const cible = nom.trim() || sel;

  const modele = async () => {
    if(!cible){ notify("Nommez le référentiel à charger", "warn"); return; }
    setBusy("modele"); setErr(null);
    try{
      const blob = await api.importTemplate("codes", null, { referentiel: cible });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `mems_codes_${cible.replace(/[^\w.-]+/g,"_")}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      notify("Modèle téléchargé", "ok");
    }catch(e){ setErr(e.message); notify("Modèle indisponible : " + e.message, "err"); }
    setBusy("");
  };

  const televerser = async (file) => {
    if(!file) return;
    setBusy("upload"); setErr(null); setPrev(null);
    try{
      const r = await api.importUpload("codes", file);
      setPrev(r);
      if(r.resume.rejetes) notify(`${r.resume.rejetes} ligne(s) rejetée(s) — voir le détail`, "warn");
    }catch(e){ setErr(e.message + (e.details ? " · " + e.details.map(d=>d.message).join(" ") : "")); }
    setBusy("");
    if(fileRef.current) fileRef.current.value = "";
  };

  const confirmer = async () => {
    setBusy("commit");
    try{
      const r = await api.importCommit(prev.batch);
      notify(`Référentiel chargé : ${r.crees} créé(s), ${r.modifies} modifié(s)`, "ok");
      setPrev(null);
      if(nom.trim()){ setSel(nom.trim()); setNom(""); }
      await charger();
      setOffset(0); setTick(n => n + 1);
    }catch(e){ setErr(e.message); notify("Confirmation refusée : " + e.message, "err"); }
    setBusy("");
  };

  const annuler = async () => {
    try{ await api.importCancel(prev.batch); }catch(e){}
    setPrev(null);
  };

  const rapprocher = async () => {
    setBusy("rapprocher"); setErr(null);
    try{
      const r = await api.rapprocherCodes(sel);
      setBilan(r);
      notify(`${r.rattachees} entrée(s) rattachée(s), ${r.alias} code(s) de reconnaissance posé(s)`
        + (r.detacheesTotal ? `, ${r.detacheesTotal} détachée(s)` : ""),
        r.detacheesTotal || r.sansSiteTotal || r.aConfirmerTotal ? "warn" : "ok");
      await charger();
      setTick(n => n + 1);
    }catch(e){ setErr(e.message); notify("Rapprochement refusé : " + e.message, "err"); }
    setBusy("");
  };

  const r = prev?.resume;
  const total = etat?.entrees || 0;

  return (
    <>
      <Aide>Ces listes sont les codes par lesquels une source désigne un site quand elle
        n'emploie pas le découpage administratif — les <b>codes école de SMP</b> en sont le
        premier exemple : des entiers qui ne sont le p-code de rien. Chargez la liste depuis un
        fichier Excel, puis lancez le rapprochement : chaque entrée reconnue pose un
        <b> code de reconnaissance</b> sur son site, et les soumissions de cette source se
        rattachent enfin toutes seules. Un référentiel est <b>national</b> : il n'appartient à
        aucun bureau, et son chargement est réservé à l'administration.</Aide>

      <StatRow>
        <Stat label="Codes chargés" value={fmt(total)}
          sub={sel ? `référentiel ${sel}` : "aucun référentiel chargé"} />
        <Stat label="Rattachés à un site" value={fmt(etat?.rattachees || 0)}
          tone={etat?.rattachees ? "ok" : ""}
          sub={total ? `${Math.round((etat.rattachees/total)*100)} % de la liste` : "—"} />
        <Stat label="À confirmer" value={fmt(etat?.aConfirmer || 0)}
          tone={etat?.aConfirmer ? "warn" : ""} sub="preuve trop faible, rien n'est posé" />
        <Stat label="Sans site" value={fmt(etat?.sansSite || 0)}
          tone={etat?.sansSite ? "bad" : ""} sub="aucun site ne correspond" />
        <Stat label="Jamais rapprochés" value={fmt(etat?.jamaisRapprochees || 0)}
          sub={etat?.dernierRapprochement
            ? `dernier essai ${String(etat.dernierRapprochement).slice(0,16)}`
            : "le rapprochement n'a jamais été lancé"} />
      </StatRow>

      <div className="grid gap-4" style={{gridTemplateColumns:"360px 1fr"}}>
        <div className="space-y-4">
          <Card title="Charger un référentiel"
            subtitle="Modèle Excel, aperçu du diff, puis confirmation">
            {!admin ? (
              <Note tone="warn">Le chargement d'un référentiel est réservé aux administrateurs :
                une liste chargée de travers fausse le rattachement de tous les bureaux.</Note>
            ) : (<>
              <Field label="Référentiel"
                hint="Laissez vide pour compléter celui que vous consultez, ou nommez-en un nouveau">
                <Input value={nom} onChange={e=>setNom(e.target.value)}
                  placeholder={sel || "SMP_2025"} /></Field>
              <Btn icon={Download} onClick={modele} disabled={busy==="modele" || !cible}>
                {busy==="modele" ? "Préparation…" : `Modèle Excel${cible ? ` — ${cible}` : ""}`}</Btn>
              <p className="f115 text-slate-500 mt-2 leading-relaxed">
                Le modèle arrive rempli des entrées déjà chargées ; au premier chargement il est
                vide, et vous y collez vos lignes. Le nom du référentiel est porté par le fichier :
                inutile de le recopier sur chaque ligne.</p>

              <div className="mt-4 pt-4 border-t border-slate-100">
                <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                  Téléverser le fichier rempli</div>
                <input ref={fileRef} type="file" accept=".xlsx" disabled={busy==="upload"}
                  onChange={e=>televerser(e.target.files[0])}
                  className="w-full f125 border border-dashed border-slate-300 rounded p-2 bg-slate-50 cursor-pointer" />
                {busy==="upload" && <div className="f12 text-slate-500 mt-2">Analyse du fichier…</div>}
                <p className="f115 text-slate-500 mt-2 leading-relaxed">
                  Rien n'est enregistré avant votre confirmation. Recharger deux fois le même
                  fichier ne crée aucun doublon : la clé est le couple référentiel + code.</p>
              </div>
              {err && <Note tone="err">{err}</Note>}
            </>)}
          </Card>

          <Card title="Rapprocher les codes des sites">
            <Note>Le rapprochement confronte chaque entrée au registre des sites, avec le même
              résolveur que l'ingestion ODK : code identique, puis p-code, puis nom. Quand la
              preuve suffit, il pose le code sur le site — la source rattache alors d'elle-même.
              <b> Sous le seuil de preuve, il ne pose rien</b> et compte l'entrée « à confirmer » :
              un code posé sur une simple ressemblance deviendrait une certitude au passage
              suivant, sans que personne l'ait validé. Relancez-le après avoir créé les sites
              manquants : il est plus efficace à chaque fois, puisqu'il dispose des codes déjà
              posés. Il n'est pas pour autant sans effet — quand le registre a bougé entre-temps,
              une entrée peut <b>perdre</b> son site. Le bilan les compte et les nomme.</Note>
            {!admin
              ? <Note tone="warn">Réservé aux administrateurs : ce geste écrit dans le registre
                  des sites.</Note>
              : <Btn icon={Link2} onClick={rapprocher} disabled={busy==="rapprocher" || !sel}>
                  {busy==="rapprocher" ? "Rapprochement…" : "Rapprocher les codes des sites"}</Btn>}
          </Card>
        </div>

        <div>
          {prev && (
            <Card flush title={`Prévisualisation — ${prev.fichier}`}
              subtitle={`${fmt(prev.lignes)} ligne(s) lue(s) · lot ${prev.batch}`}>
              <div style={{display:"grid",gap:1,background:"#e2e8ec",
                gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",borderBottom:"1px solid #e2e8ec"}}>
                <Stat label="À créer"    value={fmt(r.crees)}    tone={r.crees?"ok":""} />
                <Stat label="À modifier" value={fmt(r.modifies)} tone={r.modifies?"warn":""} />
                <Stat label="Inchangées" value={fmt(r.inchanges)} sub="déjà à jour" />
                <Stat label="Rejetées"   value={fmt(r.rejetes)}  tone={r.rejetes?"bad":""} />
              </div>
              <div className="p-4 flex items-center gap-3 flex-wrap">
                <Note tone={r.crees+r.modifies ? "info" : "warn"}>{prev.message}</Note>
                <Btn icon={Check} onClick={confirmer}
                  disabled={busy==="commit" || !(r.crees+r.modifies)}>
                  {busy==="commit" ? "Application…" : `Confirmer ${fmt(r.crees+r.modifies)} ligne(s)`}</Btn>
                <Btn kind="sec" onClick={annuler} disabled={busy==="commit"}>Abandonner</Btn>
              </div>
              {!!prev.rejets?.length && (
                <TableWrap max="mh300">
                  <thead><tr><Th className="w-20">Ligne</Th><Th>Entrée</Th><Th>Champ</Th><Th>Motif</Th></tr></thead>
                  <tbody>{prev.rejets.map(x=>(
                    <tr key={x.ligne} className="hover:bg-rose-50">
                      <Td className="f115">{x.ligne}</Td>
                      <Td>{x.unite || "—"}</Td>
                      <Td className="text-slate-600">{x.champ||"—"}</Td>
                      <Td className="text-rose-700">{x.message}</Td></tr>))}</tbody>
                </TableWrap>)}
            </Card>)}

          {bilan && <BilanRapprochement bilan={bilan} />}

          <Card flush title={sel ? `Entrées — ${sel}` : "Entrées"}
            subtitle={sel ? `${fmt(liste.total)} entrée(s) sur ce référentiel`
                          : "Aucun référentiel chargé pour l'instant"}
            right={<>
              <Select value={sel} onChange={e=>setSel(e.target.value)} empty="Choisir un référentiel"
                options={refs.map(x=>[x.referentiel, `${x.referentiel} — ${fmt(x.entrees)} codes`])}
                className="mi-py1 mi-xs mi-wauto" />
              <div className="relative">
                <Search size={13} className="absolute left-2 top-2 text-slate-400" />
                <Input value={q} onChange={e=>{ setQ(e.target.value); setOffset(0); }}
                  placeholder="Code ou libellé" className="mi-py1 mi-xs pl-7" style={{width:200}} />
              </div></>}>
            {!liste.rows.length ? (
              <Empty title={sel ? "Aucune entrée ne correspond" : "Aucun référentiel chargé"}
                text={sel
                  ? "Aucune entrée de ce référentiel ne porte ce code ni ce libellé."
                  : "Nommez un référentiel, téléchargez son modèle Excel, remplissez-le et "
                    + "téléversez-le. La liste des codes école du bureau se charge en une fois."} />
            ) : (<>
              <TableWrap max="mh520">
                <thead><tr><Th>Code</Th><Th>Libellé</Th><Th>Unité</Th><Th>Site rattaché</Th>
                  <Th>Passe</Th><Th>Motif</Th></tr></thead>
                <tbody>{liste.rows.map(x=>(
                  <tr key={x.id} className="hover:bg-sky-50">
                    <Td className="font-medium f115">{x.code}</Td>
                    <Td>{x.libelle || "—"}</Td>
                    <Td className="text-slate-500 f115">
                      {x.adm3 || x.adm4 || x.geo_pcode || "—"}</Td>
                    <Td>{x.siteNom
                      ? <><div className="font-medium">{x.siteNom}</div>
                          <div className="f11 text-slate-400">{x.siteCode}</div></>
                      : x.rattacheHorsBureau
                        ? <Badge tone="n">rattaché — autre bureau</Badge>
                        : <span className="text-slate-400">—</span>}</Td>
                    <Td>{x.rapproche_passe
                      ? <Badge tone={x.site_id ? "g" : "y"}>{x.rapproche_passe}
                          {x.rapproche_confiance != null ? ` · ${x.rapproche_confiance}` : ""}</Badge>
                      : x.rapproche_at ? <Badge tone="r">sans site</Badge>
                                       : <span className="f11 text-slate-400">jamais rapproché</span>}</Td>
                    {/* Le motif est la seule chose qui permette de corriger : il est
                        affiché, pas caché derrière un survol. */}
                    <Td className="text-slate-600 f11" style={{whiteSpace:"normal",maxWidth:420}}>
                      {x.site_id ? "" : (x.rapproche_motif || "")}</Td>
                  </tr>))}</tbody>
              </TableWrap>
              {liste.total > PAGE && (
                <div className="px-4 py-3 flex items-center gap-3 f125 text-slate-600">
                  <Btn size="sm" kind="sec" disabled={offset<=0}
                    onClick={()=>setOffset(Math.max(0, offset-PAGE))}>Précédentes</Btn>
                  <span>{offset+1} – {Math.min(offset+PAGE, liste.total)} sur {fmt(liste.total)}</span>
                  <Btn size="sm" kind="sec" disabled={offset+PAGE >= liste.total}
                    onClick={()=>setOffset(offset+PAGE)}>Suivantes</Btn>
                </div>)}
            </>)}
          </Card>
        </div>
      </div>
    </>);
}

/* Le compte rendu du rapprochement. Il énonce d'abord ce qu'il a fait, puis —
   au même rang, sans repli ni survol — ce qu'il n'a PAS su faire, dans les deux
   sens : les entrées restées sans site, et les sites restés sans entrée. */
function BilanRapprochement({ bilan }){
  const sansEntree = (bilan.sitesSansEntree || []).reduce((a,x)=>a+x.sites, 0);
  return (
    <Card flush title="Bilan du rapprochement"
      subtitle={`${fmt(bilan.lues)} entrée(s) confrontées au registre des sites`}>
      <div style={{display:"grid",gap:1,background:"#e2e8ec",
        gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",borderBottom:"1px solid #e2e8ec"}}>
        <Stat label="Rattachées" value={fmt(bilan.rattachees)} tone={bilan.rattachees?"ok":""} />
        <Stat label="Codes posés" value={fmt(bilan.alias)}
          sub={`${fmt(bilan.dejaPresents)} déjà présent(s)`
            + (bilan.aliasRetires ? ` · ${fmt(bilan.aliasRetires)} périmé(s) retiré(s)` : "")} />
        <Stat label="À confirmer" value={fmt(bilan.aConfirmerTotal)}
          tone={bilan.aConfirmerTotal?"warn":""} sub={`sous le seuil de ${bilan.seuil}`} />
        <Stat label="Sans site" value={fmt(bilan.sansSiteTotal)} tone={bilan.sansSiteTotal?"bad":""} />
        {/* Une entrée qui perd son site est le seul effet destructeur d'un geste
            présenté comme rejouable : il se montre au même rang que les gains. */}
        <Stat label="Détachées" value={fmt(bilan.detacheesTotal || 0)}
          tone={bilan.detacheesTotal?"bad":""} sub="rattachement perdu depuis le dernier passage" />
        <Stat label="Sites sans entrée" value={fmt(sansEntree)} sub="ventilés par activité" />
      </div>
      <div className="p-4 space-y-3">
        {bilan.detachement && <Note tone="err">{bilan.detachement}</Note>}
        {bilan.avertissement && <Note tone="warn">{bilan.avertissement}</Note>}
        {bilan.remarque && <Note tone="warn">{bilan.remarque}</Note>}

        {!!bilan.detachees?.length && (
          <div>
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
              Entrées qui ont perdu leur site</div>
            <TableWrap max="mh300">
              <thead><tr><Th>Code</Th><Th>Libellé</Th><Th>Pourquoi</Th></tr></thead>
              <tbody>{bilan.detachees.map(x=>(
                <tr key={x.code}><Td className="f115">{x.code}</Td><Td>{x.libelle||"—"}</Td>
                  <Td className="text-slate-600 f11" style={{whiteSpace:"normal"}}>{x.motif}</Td></tr>))}</tbody>
            </TableWrap>
          </div>)}

        {!!bilan.sansSite?.length && (
          <div>
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
              Entrées sans site {bilan.sansSiteTotal > bilan.sansSite.length
                && `— ${fmt(bilan.sansSite.length)} des ${fmt(bilan.sansSiteTotal)}`}</div>
            <TableWrap max="mh300">
              <thead><tr><Th>Code</Th><Th>Libellé</Th><Th>Pourquoi</Th></tr></thead>
              <tbody>{bilan.sansSite.map(x=>(
                <tr key={x.code}><Td className="f115">{x.code}</Td><Td>{x.libelle||"—"}</Td>
                  <Td className="text-slate-600 f11" style={{whiteSpace:"normal"}}>{x.motif}</Td></tr>))}</tbody>
            </TableWrap>
          </div>)}

        {!!bilan.aConfirmer?.length && (
          <div>
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
              À confirmer — aucun code n'a été posé</div>
            <TableWrap max="mh300">
              <thead><tr><Th>Code</Th><Th>Libellé</Th><Th>Passe</Th><Th>Ce qui a été trouvé</Th></tr></thead>
              <tbody>{bilan.aConfirmer.map(x=>(
                <tr key={x.code}><Td className="f115">{x.code}</Td><Td>{x.libelle||"—"}</Td>
                  <Td><Badge tone="y">{x.passe} · {x.confiance}</Badge></Td>
                  <Td className="text-slate-600 f11" style={{whiteSpace:"normal"}}>{x.motif}</Td></tr>))}</tbody>
            </TableWrap>
          </div>)}

        {!!bilan.sitesSansEntree?.length && (
          <div>
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
              Sites du registre sans entrée dans ce référentiel</div>
            {/* Ventilé, jamais en nombre brut : pour une liste d'écoles, les points de
                distribution URT sans entrée sont normaux, et les compter avec les
                écoles réellement manquantes noierait la seule information utile. */}
            <div className="flex flex-wrap gap-2">
              {bilan.sitesSansEntree.map(x=>(
                <Badge key={x.tag} tone="n">{x.tag} — {fmt(x.sites)}</Badge>))}
            </div>
          </div>)}

        {!!bilan.codesAmbigus?.length && (
          <div>
            <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-1">
              Codes désignant plusieurs sites</div>
            <TableWrap max="mh300">
              <thead><tr><Th>Code</Th><Th>Sites concernés</Th></tr></thead>
              <tbody>{bilan.codesAmbigus.map(x=>(
                <tr key={x.code}><Td className="f115">{x.code}</Td>
                  <Td className="text-slate-600">{x.sites.map(s=>`${s.name} (${s.code})`).join(" · ")}</Td>
                </tr>))}</tbody>
            </TableWrap>
          </div>)}
      </div>
    </Card>);
}

export { SetCodeReferentiels };
