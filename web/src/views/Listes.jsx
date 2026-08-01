import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { Check, ListChecks, Pencil, Plus, Save, Search, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Btn, Card, Empty, Field, Input, Modal, Note, Select, Sw,
         TableWrap, Td, Th } from "../components/ui.jsx";
import { clsx, fmt } from "../lib/calc.js";

/* ══════════════════ Listes paramétrables typées ══════════════════
   « J'aurai besoin des listes à paramétrer par types (activité, denrées,
   tiers, partenaire, type de partenariat, etc.) en sous-groupe sélectionnable
   à gauche et à droite la configuration des listes (ajout, modification,
   suppression, validation). »

   D'où la forme MAÎTRE-DÉTAIL : le rail de gauche porte les TYPES, le volet de
   droite la liste choisie et ses quatre gestes. Trois partis pris :

     — l'écran ne connaît AUCUNE liste. Les types, leurs champs propres et les
       tables qui les référencent sont lus du serveur (`GET /api/listes`, puis
       `/api/listes/:cle`). Ajouter un type de liste au registre le fait
       apparaître ici sans toucher à ce fichier ;
     — l'USAGE est montré, pas caché. Chaque item affiche combien de lignes le
       référencent, et la suppression refusée dit lesquelles. C'est ce qui rend
       la règle compréhensible au lieu de la faire subir ;
     — la VALIDATION porte sur la liste, pas sur le formulaire. Elle dit « cette
       liste a été relue », et toute modification ultérieure l'efface.
   ═════════════════════════════════════════════════════════════════ */

function SetListes({ notify, can, me }){
  const [types,setTypes]   = useState([]);
  const [cle,setCle]       = useState("");
  const [detail,setDetail] = useState(null);      /* { type, items, validation } */
  const [q,setQ]           = useState("");
  const [edit,setEdit]     = useState(null);
  const [busy,setBusy]     = useState(false);
  const [refus,setRefus]   = useState(null);      /* le 409 d'une suppression refusée */

  const admin = can("admin");

  const chargerTypes = () => api.listes()
    .then(r => { const t = r.types || []; setTypes(t); setCle(p => p || t[0]?.cle || ""); })
    .catch(e => notify(e.message, "err"));

  const chargerDetail = (k) => { if(!k) return Promise.resolve();
    return api.liste(k).then(setDetail).catch(e => { setDetail(null); notify(e.message, "err"); }); };

  useEffect(() => { chargerTypes(); }, []);
  useEffect(() => { setQ(""); setRefus(null); chargerDetail(cle); }, [cle]);

  /* Après une écriture, le rail ET le volet sont relus : les compteurs du rail
     (nombre d'items, badge de validation) sont exactement ce que l'écriture
     vient de changer. Les recalculer côté client les ferait diverger au premier
     cas non prévu — une suppression refusée, par exemple. */
  const recharger = async () => { await Promise.all([chargerTypes(), chargerDetail(cle)]); };

  const enregistrer = async (f) => {
    setBusy(true);
    const payload = { code:(f.code||"").trim(), label:(f.label||"").trim(), note:f.note||null,
      ordre:Number(f.ordre)||0, active:f.active !== false, champs:f.champs || {}, rev:f.rev };
    try{
      if(f.id) await api.updateItem(cle, f.id, payload); else await api.createItem(cle, payload);
      await recharger(); setEdit(null); notify("Item enregistré", "ok");
    }catch(e){ notify(e.message + (e.details ? " · " + e.details.map(d=>d.message).join(" ") : ""), "err"); }
    setBusy(false);
  };

  const supprimer = async (it) => {
    if(!confirm(`Supprimer « ${it.label} » de la liste ${detail.type.label} ?`)) return;
    setRefus(null);
    try{ await api.deleteItem(cle, it.id); await recharger(); notify("Item supprimé", "ok"); }
    catch(e){
      /* Un refus d'intégrité n'est pas une erreur de saisie : il s'affiche en
         clair, avec le détail de ce qui retient l'item, et la désactivation à
         portée de clic. */
      if(e.status === 409) setRefus({ item:it, message:e.message, usage:e.payload?.usage || [] });
      notify(e.message, "err");
    }
  };

  const desactiver = async (it) => {
    setBusy(true);
    try{
      await api.updateItem(cle, it.id, { code:it.code, label:it.label, note:it.note || null,
        ordre:it.ordre, active:false, champs:it.champs || {}, rev:it.rev });
      await recharger(); setRefus(null); notify(`« ${it.label} » désactivé`, "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const valider = async () => {
    setBusy(true);
    try{ await api.validerListe(cle, null); await recharger();
      notify(`Liste « ${detail.type.label} » validée`, "ok"); }
    catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const items = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = detail?.items || [];
    return s ? l.filter(x => (x.code + " " + x.label).toLowerCase().includes(s)) : l;
  }, [detail, q]);

  const t = detail?.type;
  const val = detail?.validation;

  return (
    <>
      <Note>Toutes les listes paramétrables de MEMS, <b>par type</b> : choisissez la liste à gauche,
        configurez-la à droite. Un item porte un <b>code d'identification</b> — c'est lui que les
        autres tables enregistrent — et un libellé. Le code ne change pas à la modification :
        il est la clé de jointure, et le casser perdrait le lien avec les données déjà saisies.
        Un item <b>déjà utilisé ne se supprime pas</b> ; il se désactive, ce qui le retire des choix
        sans effacer l'historique.</Note>

      <div className="grid gap-4" style={{gridTemplateColumns:"300px 1fr"}}>
        {/* ── Rail de gauche : les TYPES ── */}
        <Card flush title="Types de liste" subtitle={`${types.length} référentiel(s)`}>
          <div className="mh65 overflow-auto">
            {types.map(x => (
              <button key={x.cle} onClick={()=>setCle(x.cle)}
                className={clsx("w-full text-left px-4 py-2.5 border-b border-slate-100 transition-colors",
                  x.cle === cle ? "bg-sky-50 bl3 bd-brand" : "hover:bg-slate-50 bl3 border-l-transparent")}>
                <div className="flex items-center gap-2">
                  <span className={clsx("f13 font-semibold truncate",
                    x.cle === cle ? "c-bd" : "text-slate-800")}>{x.label}</span>
                  {x.validation && <ShieldCheck size={13} className="text-lime-600 shrink-0" />}
                </div>
                <div className="f11 text-slate-500 mt-0.5">
                  {fmt(x.items)} item{x.items>1?"s":""}
                  {x.items !== x.actifs && ` · ${fmt(x.items - x.actifs)} inactif(s)`}
                  {x.native && " · table propre"}
                </div>
              </button>))}
          </div>
        </Card>

        {/* ── Volet de droite : la liste choisie ── */}
        <div>
          {!t ? <Card><Empty icon={ListChecks} title="Choisissez une liste"
                  text="Le rail de gauche porte les types de liste paramétrables." /></Card>
          : (<>
            <Card flush title={t.label}
              subtitle={`${fmt(detail.items.length)} item(s)` + (t.native ? " · table dédiée" : "")}
              right={<>
                <div className="relative">
                  <Search size={13} className="absolute left-2 top-2 text-slate-400" />
                  <Input value={q} onChange={e=>setQ(e.target.value)} placeholder="Code ou libellé"
                    className="mi-py1 mi-xs pl-7" style={{width:180}} /></div>
                {admin && <Btn size="sm" kind="sec" icon={Check} onClick={valider}
                  disabled={busy || !detail.items.length}>Valider la liste</Btn>}
                {admin && <Btn size="sm" icon={Plus} onClick={()=>setEdit({ id:"", code:"", label:"",
                  note:"", ordre:(detail.items.length+1)*1, active:true, champs:{} })}>Ajouter</Btn>}
              </>}>
              <div className="px-4 pt-3 space-y-2">
                <p className="f125 text-slate-600 leading-relaxed">{t.description}</p>
                {val
                  ? <Note tone="ok">Liste <b>validée</b> le {String(val.at).slice(0,16)}
                      {val.par ? <> par <b>{val.par}</b></> : null} — {fmt(val.items)} item(s) relus.
                      Toute modification ultérieure retire cette marque.</Note>
                  : <Note tone="warn">Cette liste n'a pas été validée depuis sa dernière
                      modification. Relisez-la, puis cliquez « Valider la liste ».</Note>}
                {!!t.liens.length && (
                  <div className="flex flex-wrap items-center gap-1.5 pb-1">
                    <span className="f11 font-bold uppercase tracking-wide text-slate-500">
                      Référencée par&nbsp;:</span>
                    {t.liens.map(l => (
                      <Badge key={l.table+l.colonne} tone="n">{l.label} · {l.table}.{l.colonne}</Badge>))}
                  </div>)}
              </div>

              {refus && <div className="px-4"><RefusSuppression refus={refus} busy={busy}
                onClose={()=>setRefus(null)} onDesactiver={()=>desactiver(refus.item)} admin={admin} /></div>}

              {!items.length
                ? <Empty icon={ListChecks} title={q ? "Aucun item ne correspond" : "Liste vide"}
                    text={q ? "Aucun code ni libellé ne contient ce texte."
                            : "Ajoutez un premier item : son code est la valeur que les autres "
                              + "tables enregistreront."} />
                : <TableWrap max="mh520">
                    <thead><tr>
                      <Th>Code</Th><Th>Libellé</Th>
                      {t.champs.map(c => <Th key={c.cle}>{c.label}</Th>)}
                      <Th>Statut</Th><Th num>Utilisé</Th><Th /></tr></thead>
                    <tbody>{items.map(it => (
                      <tr key={it.id} className={clsx("hover:bg-sky-50", !it.active && "opacity-60")}>
                        <Td><Badge tone="b">{it.code}</Badge></Td>
                        <Td className="font-medium text-slate-800">{it.label}</Td>
                        {t.champs.map(c => <Td key={c.cle} className="text-slate-600">
                          {it.champs?.[c.cle] || "—"}</Td>)}
                        <Td>{it.active ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>}</Td>
                        {/* Le nombre de lignes qui référencent l'item, avec le détail
                            au survol : c'est ce qui explique d'avance pourquoi la
                            corbeille refusera. */}
                        <Td num className={it.usageTotal ? "font-semibold text-slate-700" : "text-slate-400"}
                          title={it.usage?.map(u => `${u.label} (${u.table}.${u.colonne}) : ${u.lignes}`).join("\n") || ""}>
                          {it.usageTotal ? fmt(it.usageTotal) : "—"}</Td>
                        <Td className="text-right">
                          {admin && <button onClick={()=>setEdit(it)}
                            className="text-slate-400 m-ico p-1"><Pencil size={14}/></button>}
                          {admin && <button onClick={()=>supprimer(it)}
                            className={clsx("p-1", it.usageTotal
                              ? "text-slate-300 cursor-help" : "text-slate-400 hover:text-rose-600")}
                            title={it.usageTotal
                              ? `${it.usageTotal} ligne(s) référencent cet item : il ne peut pas être supprimé`
                              : "Supprimer"}><Trash2 size={14}/></button>}
                        </Td>
                      </tr>))}</tbody>
                  </TableWrap>}
            </Card>
          </>)}
        </div>
      </div>

      <ItemModal open={!!edit} item={edit} type={t} busy={busy}
        onClose={()=>setEdit(null)} onSave={enregistrer} />
    </>);
}

/* Le refus de suppression, montré en clair. Il énumère ce qui retient l'item —
   table, colonne, nombre de lignes — et propose la seule issue non destructrice.
   Un simple « impossible » aurait laissé l'utilisateur chercher. */
function RefusSuppression({ refus, busy, admin, onClose, onDesactiver }){
  return (
    <div className="mb-3">
      <Note tone="err">
        <div className="font-semibold mb-1">{refus.message}</div>
        {!!refus.usage?.length && (
          <ul className="list-disc pl-5 space-y-0.5">
            {refus.usage.map(u => (
              <li key={u.table+u.colonne}>{u.label} — <b>{fmt(u.lignes)}</b> ligne(s)
                <span className="text-rose-800/70"> ({u.table}.{u.colonne})</span></li>))}
          </ul>)}
        <div className="flex gap-2 mt-2">
          {admin && <Btn size="sm" onClick={onDesactiver} disabled={busy}>Désactiver plutôt</Btn>}
          <Btn size="sm" kind="sec" onClick={onClose}>Fermer</Btn>
        </div>
      </Note>
    </div>);
}

function ItemModal({ open, item, type, busy, onClose, onSave }){
  const [f,setF] = useState({});
  /* Les listes qui alimentent les champs propres (le domaine programme d'une
     activité, le type de partenariat d'un partenaire) sont chargées à
     l'ouverture : ce sont des CODES d'autres listes, et les proposer évite d'en
     saisir un qui n'existe pas — que le serveur refuserait de toute façon. */
  const [options,setOptions] = useState({});

  useEffect(() => { setF(item || {}); }, [item]);
  useEffect(() => {
    if(!open || !type) return;
    const aCharger = (type.champs || []).filter(c => c.liste);
    if(!aCharger.length){ setOptions({}); return; }
    let vivant = true;
    Promise.all(aCharger.map(c => api.liste(c.liste)
      .then(r => [c.cle, (r.items || []).filter(x => x.active).map(x => [x.code, `${x.code} — ${x.label}`])])
      .catch(() => [c.cle, []])))
      .then(paires => { if(vivant) setOptions(Object.fromEntries(paires)); });
    return () => { vivant = false; };
  }, [open, type]);

  if(!open || !type) return null;
  const u = (k,v) => setF(p => ({ ...p, [k]:v }));
  const uc = (k,v) => setF(p => ({ ...p, champs:{ ...(p.champs||{}), [k]:v } }));
  const existant = !!f.id;

  return (
    <Modal open onClose={onClose}
      title={existant ? `Modifier — ${type.label}` : `Nouvel item — ${type.label}`}
      subtitle={existant
        ? "Le code d'identification est préservé : il est la clé de jointure des données déjà saisies."
        : "Le code est la valeur que les autres tables enregistreront."}
      footer={<><Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || !f.code || !f.label} onClick={()=>onSave(f)}>Enregistrer</Btn></>}>
      <div className="grid grid-cols-2 gap-x-4">
        <Field label="Code d'identification"
          hint={existant
            ? "Non modifiable ici — un super-utilisateur peut le renommer en cascade."
            : "Court et stable : les sites, le plan et les sources le porteront."}>
          <Input value={f.code||""} readOnly={existant} disabled={existant}
            onChange={e=>u("code", e.target.value)} placeholder="URT" /></Field>
        <Field label="Ordre d'affichage" hint="Les petits nombres remontent">
          <Input type="number" min="0" value={f.ordre ?? 0}
            onChange={e=>u("ordre", e.target.value)} /></Field>
        <Field label="Libellé" className="col-span-2">
          <Input value={f.label||""} onChange={e=>u("label", e.target.value)}
            placeholder="Transferts de ressources non conditionnels" /></Field>
        {(type.champs || []).map(c => (
          <Field key={c.cle} label={c.label} className="col-span-2">
            {c.liste
              ? <Select value={f.champs?.[c.cle] || ""} onChange={e=>uc(c.cle, e.target.value)}
                  empty="— aucun —" options={options[c.cle] || []} />
              : <Input value={f.champs?.[c.cle] || ""} onChange={e=>uc(c.cle, e.target.value)} />}
          </Field>))}
        <Field label="Note" className="col-span-2">
          <Input value={f.note||""} onChange={e=>u("note", e.target.value)}
            placeholder="Précision utile à qui relira la liste" /></Field>
      </div>
      <Sw label="Item actif" hint="Un item inactif n'est plus proposé dans les choix, mais reste lié à l'historique"
        on={f.active !== false} onChange={v=>u("active", v)} />
      {existant && !!f.usageTotal && (
        <Note tone="warn">Cet item est référencé par <b>{fmt(f.usageTotal)}</b> ligne(s).
          Le modifier est sans danger — son code, lui, ne bouge pas.</Note>)}
    </Modal>);
}

export { SetListes };
