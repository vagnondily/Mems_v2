import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { ArrowRightLeft, Check, ListChecks, Pencil, Plus, Save, Search, ShieldCheck,
         Trash2 } from "lucide-react";
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
  const [renomme,setRenomme] = useState(null);    /* l'item dont on renomme le code */

  const admin = can("admin");
  /* Le renommage de code touche en un geste des milliers de lignes de tables
     que l'opérateur n'a pas sous les yeux : le serveur le réserve au super, et
     l'écran ne montre pas un bouton qui reviendrait en 403. */
  const superUser = me?.role === "super";

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

  const basculer = async (it, active) => {
    setBusy(true);
    try{
      await api.activerItem(cle, it.id, active, it.rev);
      await recharger(); setRefus(null);
      notify(`« ${it.label} » ${active ? "réactivé" : "désactivé"}`, "ok");
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
        sans effacer l'historique.
        {superUser && <> Un super-utilisateur peut <b>renommer un code</b> (icône <ArrowRightLeft
          size={12} className="inline" />) : la correspondance ancien → nouveau est calculée et
          montrée, puis appliquée <b>en une transaction</b> qui réécrit toutes les tables filles.</>}
      </Note>

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
                onClose={()=>setRefus(null)} onDesactiver={()=>basculer(refus.item, false)} admin={admin} /></div>}

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
                        {/* Le statut se bascule d'un clic : c'est l'issue proposée
                            quand la suppression est refusée, elle doit être à
                            portée de main et non au fond d'une fiche. */}
                        <Td>{admin
                          ? <button onClick={()=>basculer(it, !it.active)} disabled={busy}
                              title={it.active ? "Désactiver" : "Réactiver"}>
                              {it.active ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>}</button>
                          : (it.active ? <Badge tone="g">Actif</Badge> : <Badge>Inactif</Badge>)}</Td>
                        {/* Le nombre de lignes qui référencent l'item, avec le détail
                            au survol : c'est ce qui explique d'avance pourquoi la
                            corbeille refusera. */}
                        <Td num className={it.usageTotal ? "font-semibold text-slate-700" : "text-slate-400"}
                          title={it.usage?.map(u => `${u.label} (${u.table}.${u.colonne}) : ${u.lignes}`).join("\n") || ""}>
                          {it.usageTotal ? fmt(it.usageTotal) : "—"}</Td>
                        <Td className="text-right">
                          {superUser && <button onClick={()=>setRenomme(it)}
                            className="text-slate-400 m-ico p-1"
                            title="Renommer le code, en entraînant tout ce qui le porte">
                            <ArrowRightLeft size={14}/></button>}
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
      <RenommageModal open={!!renomme} item={renomme} cle={cle} type={t} notify={notify}
        onClose={()=>setRenomme(null)} onDone={async ()=>{ setRenomme(null); await recharger(); }} />
    </>);
}

/* ══════════════════ Mappage puis validation ══════════════════
   « Si je fais une mise à jour d'un paramètre interconnecté, toujours
   procéder à un mappage puis validation pour ne pas perdre des données. »

   Deux temps, et le second n'est pas atteignable sans le premier : on
   demande la CORRESPONDANCE (ancien → nouveau, table par table, avec le
   nombre de lignes touchées), on la lit, puis on valide. Le jeton du plan
   part avec la validation ; si la base a bougé entre les deux, le serveur
   refuse et rend le plan à jour plutôt que d'écrire ce qui n'a pas été vu.

   Même esprit que l'écran de correspondance des connecteurs : rien ne
   s'écrase en silence. */
function RenommageModal({ open, item, cle, type, notify, onClose, onDone }){
  const [nouveau,setNouveau] = useState("");
  const [plan,setPlan]       = useState(null);
  const [bilan,setBilan]     = useState(null);
  const [busy,setBusy]       = useState("");

  useEffect(() => { setNouveau(""); setPlan(null); setBilan(null); setBusy(""); }, [item]);
  if(!open || !item) return null;

  const calculer = async () => {
    setBusy("plan"); setPlan(null);
    try{ const r = await api.planRenommage(cle, item.id, nouveau.trim()); setPlan(r.plan); }
    catch(e){ notify(e.message, "err"); }
    setBusy("");
  };

  const appliquer = async () => {
    setBusy("apply");
    try{
      const r = await api.renommerCode(cle, item.id, plan.nouveau, plan.mode, plan.jeton);
      setBilan(r);
      notify(`Code ${r.mode === "fusionner" ? "fusionné" : "renommé"} — `
        + `${r.total} ligne(s) réécrite(s)`, "ok");
    }catch(e){
      /* Le plan a bougé : on le remplace par celui que le serveur renvoie,
         et l'utilisateur revalide sur ce qu'il voit réellement. */
      if(e.payload?.plan) setPlan(e.payload.plan);
      notify(e.message, "err");
    }
    setBusy("");
  };

  const fusion = plan?.mode === "fusionner";
  return (
    <Modal open wide onClose={onClose}
      title={`Renommer le code — ${item.code}`}
      subtitle={`${type?.label} · réservé au super-utilisateur`}
      footer={<>
        <Btn kind="sec" onClick={onClose}>{bilan ? "Fermer" : "Annuler"}</Btn>
        {!bilan && <Btn kind={fusion ? "danger" : "primary"} icon={ArrowRightLeft}
          disabled={!plan || busy === "apply"} onClick={appliquer}>
          {busy === "apply" ? "Application…"
            : plan ? `Valider et ${fusion ? "fusionner" : "appliquer"} — ${fmt(plan.total)} ligne(s)`
                   : "Calculez d'abord la correspondance"}</Btn>}
      </>}>
      {bilan ? (
        <div className="space-y-3">
          <Note tone="ok">Code <b>{bilan.ancien}</b> → <b>{bilan.nouveau}</b> :
            {" "}{fmt(bilan.total)} ligne(s) réécrite(s) dans {bilan.tables.length} table(s),
            en une transaction.</Note>
          {/* Le reliquat est la preuve : plus aucune ligne ne porte l'ancien code. */}
          <Note tone={bilan.reliquat ? "err" : "ok"}>
            {bilan.reliquat
              ? `${fmt(bilan.reliquat)} ligne(s) portent encore l'ancien code — signalez-le.`
              : "Contrôle d'après-coup : plus aucune ligne ne désigne l'ancien code."}</Note>
          <TableWrap max="mh300">
            <thead><tr><Th>Table</Th><Th>Colonne</Th><Th num>Lignes réécrites</Th></tr></thead>
            <tbody>{bilan.tables.map(t2 => (
              <tr key={t2.table + t2.colonne}><Td>{t2.label}</Td>
                <Td className="text-slate-500 f115">{t2.table}.{t2.colonne}</Td>
                <Td num>{fmt(t2.lignes)}</Td></tr>))}</tbody>
          </TableWrap>
          <Btn kind="sec" onClick={onDone}>Recharger la liste</Btn>
        </div>
      ) : (<>
        <Note>Le code est la <b>clé de jointure</b> : le changer sans entraîner ce qui le porte
          laisserait des lignes désigner un code disparu. Ici, la correspondance est calculée
          d'abord, montrée ensuite, et appliquée <b>en une transaction</b> — la table maîtresse et
          toutes ses filles, ou rien.</Note>
        <div className="grid grid-cols-2 gap-x-4 items-end">
          <Field label="Code actuel"><Input value={item.code} readOnly disabled /></Field>
          <Field label="Nouveau code"
            hint="S'il est déjà pris dans cette liste, l'opération devient une FUSION">
            <Input value={nouveau} onChange={e=>{ setNouveau(e.target.value); setPlan(null); }}
              placeholder="Nouveau code" /></Field>
        </div>
        <Btn kind="sec" icon={Search} disabled={!nouveau.trim() || busy === "plan"} onClick={calculer}>
          {busy === "plan" ? "Calcul…" : "Calculer la correspondance"}</Btn>

        {plan && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2">
              <Badge tone={fusion ? "r" : "b"}>{fusion ? "Fusion" : "Renommage"}</Badge>
              <span className="f13 text-slate-700">
                <b>{plan.ancien}</b> → <b>{plan.nouveau}</b>
                {fusion && plan.cible ? <> (item existant « {plan.cible.label} »)</> : null}</span>
            </div>
            {plan.avertissements.map((a,i) => (
              <Note key={i} tone={fusion ? "err" : "warn"}>{a}</Note>))}
            {!plan.correspondances.length
              ? <Empty icon={ArrowRightLeft} title="Aucune ligne à réécrire"
                  text="Seul l'item lui-même changera de code." />
              : <TableWrap max="mh300">
                  <thead><tr><Th>Table concernée</Th><Th>Colonne</Th>
                    <Th>Valeur actuelle</Th><Th>Deviendra</Th><Th num>Lignes</Th></tr></thead>
                  <tbody>{plan.correspondances.map(c => (
                    <tr key={c.table + c.colonne}>
                      <Td className="font-medium text-slate-800">{c.label}</Td>
                      <Td className="text-slate-500 f115">{c.table}.{c.colonne}</Td>
                      <Td><Badge tone="n">{c.de}</Badge></Td>
                      <Td><Badge tone="b">{c.vers}</Badge></Td>
                      <Td num className="font-semibold">{fmt(c.lignes)}</Td></tr>))}</tbody>
                </TableWrap>}
            <p className="f115 text-slate-500">Rien n'est écrit tant que vous n'avez pas validé.
              Si la base change d'ici là, la validation est refusée et la correspondance recalculée.</p>
          </div>)}
      </>)}
    </Modal>);
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

export { SetListes, RenommageModal };
