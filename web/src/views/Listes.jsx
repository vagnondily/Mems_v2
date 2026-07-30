import { useEffect, useState } from "react";
import { ArrowRight, Building2, Link2, Pencil, Plus, Save, Trash2, Users } from "lucide-react";
import { api } from "../lib/api.js";
import { Badge, Btn, Card, Empty, Field, Input, Note, Select, Sw, TableWrap, Td, Th }
  from "../components/ui.jsx";
import { clsx, fmt } from "../lib/calc.js";

/* ═══════════════════════════════════════════════════════════════════════
   Listes de référence.

   Deux défauts se corrigent ici, et ils ont la même racine.

   Le premier : la liste des partenaires d'exécution était présentée comme
   modifiable alors qu'elle ne l'était pas. Elle était dérivée de la table à chaque
   chargement, éditée en mémoire, et jamais renvoyée au serveur — toute saisie
   disparaissait au rechargement, sans un message. C'est le défaut qui avait été
   corrigé pour les bureaux et qui subsistait ici.

   Le second : rien ne disait à quoi une liste SERT. Un partenaire est assigné par
   commune dans le plan de distribution et porté par des sites ; un prestataire de
   suivi porte des contrats et des plans mensuels. Sans ce lien affiché, une liste de
   configuration ressemble à un formulaire sans conséquence, et l'on ne comprend ni
   pourquoi une suppression est refusée, ni où va ce qu'on saisit.

   Chaque liste affiche donc son poids réel et mène à l'écran qui l'utilise.
   ═══════════════════════════════════════════════════════════════════════ */

const vide = { name:"", code:"", kind:null, active:true };

function PartenaireForm({ p, db, ref2, busy, onChange, onSave, onCancel }){
  const u = (k,v) => onChange({ ...p, [k]:v });
  return (
    <Card title={p.id ? `Partenaire — ${p.name}` : "Nouveau partenaire d'exécution"}
      subtitle="Identité, convention et bureau de rattachement"
      right={<><Btn kind="sec" onClick={onCancel}>Annuler</Btn>
        <Btn icon={Save} disabled={busy || !(p.name||"").trim()} onClick={onSave}>
          {busy ? "Enregistrement…" : "Enregistrer"}</Btn></>}>
      <div className="grid grid-cols-4 gap-x-4">
        <Field label="Nom" className="col-span-2">
          <Input value={p.name||""} onChange={e=>u("name",e.target.value)} /></Field>
        <Field label="Sigle" hint="Court, utilisé dans les tableaux">
          <Input value={p.code||""} onChange={e=>u("code",e.target.value)} /></Field>
        <Field label="Nature">
          <Select value={p.kind||""} onChange={e=>u("kind",e.target.value)}
            empty="— à préciser —" options={Object.entries(ref2.kinds||{})} /></Field>
        <Field label="Bureau de rattachement" hint="Vide = partenaire national">
          <Select value={p.office_id||""} onChange={e=>u("office_id",e.target.value)}
            empty="Tous les bureaux" options={(db.offices||[]).map(o=>[o.id,o.name])} /></Field>
        <Field label="Référence de la convention">
          <Input value={p.agreement||""} onChange={e=>u("agreement",e.target.value)} /></Field>
        <Field label="Début de convention">
          <Input type="date" value={p.start_date||""} onChange={e=>u("start_date",e.target.value)} /></Field>
        <Field label="Fin de convention">
          <Input type="date" value={p.end_date||""} onChange={e=>u("end_date",e.target.value)} /></Field>
        <Field label="Contact"><Input value={p.contact||""} onChange={e=>u("contact",e.target.value)} /></Field>
        <Field label="Adresse électronique">
          <Input type="email" value={p.email||""} onChange={e=>u("email",e.target.value)} /></Field>
        <Field label="Téléphone"><Input value={p.phone||""} onChange={e=>u("phone",e.target.value)} /></Field>
        <Field label="Note"><Input value={p.note||""} onChange={e=>u("note",e.target.value)} /></Field>
      </div>
      <Sw label="Partenaire actif"
        hint="Un partenaire inactif reste dans l'historique et cesse d'être proposé à la saisie"
        on={p.active !== false} onChange={v=>u("active",v)} />
      {p.id && !!(p.usage?.sites || p.usage?.pdd) && (
        <Note>Ce partenaire est référencé par <b>{p.usage.sites} site(s)</b> et
          {" "}<b>{p.usage.pdd} ligne(s)</b> du plan de distribution. Le renommer met l'ensemble à
          jour ; il ne peut pas être supprimé tant qu'il est utilisé.</Note>)}
    </Card>);
}

export default function Listes({ db, notify, can, reload, go }){
  const [rows, setRows] = useState(null);
  const [ref2, setRef2] = useState({});
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tpms, setTpms] = useState([]);

  const charger = () => {
    api.partners().then(r => { setRows(r.rows || []); setRef2(r.referentiel || {}); })
      .catch(e => { notify(e.message, "err"); setRows([]); });
    api.tpm().then(r => setTpms(r.rows || [])).catch(()=>{});
  };
  useEffect(()=>{ charger(); }, []);
  if(!rows) return <Empty icon={Users} title="Chargement des listes de référence…" />;

  const enregistrer = async () => {
    setBusy(true);
    const b = { name:(edit.name||"").trim(), code:edit.code || null, kind:edit.kind || null,
      contact:edit.contact || null, email:edit.email || null, phone:edit.phone || null,
      agreement:edit.agreement || null, start_date:edit.start_date || null,
      end_date:edit.end_date || null, note:edit.note || null,
      office_id:edit.office_id || null, active: edit.active !== false };
    if(edit.id) b.rev = edit.rev;
    try{
      edit.id ? await api.updatePartner(edit.id, b) : await api.createPartner(b);
      setEdit(null); charger();
      /* Le nom d'un partenaire apparaît sur les sites et le plan de distribution :
         sans rechargement de l'état, l'écran montrerait le nouveau nom et le reste
         de l'application l'ancien. */
      if(reload) await reload();
      notify("Partenaire enregistré", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const supprimer = async (p) => {
    if(!confirm(`Supprimer « ${p.name} » ?`)) return;
    try{ await api.deletePartner(p.id); charger(); if(reload) await reload();
      notify("Partenaire supprimé", "ok"); }
    catch(e){ notify(e.message, "err"); }
  };

  if(edit) return (
    <PartenaireForm p={edit} db={db} ref2={ref2} busy={busy} onChange={setEdit}
      onSave={enregistrer} onCancel={()=>setEdit(null)} />);

  const actifs = rows.filter(p => p.active).length;
  const utilises = rows.filter(p => p.usage.sites || p.usage.pdd).length;

  return (
    <div className="space-y-4">
      <Note>Ces listes alimentent les menus déroulants du reste de l'application. Chacune indique
        <b> ce qui l'utilise</b> : c'est la seule façon de comprendre pourquoi une suppression est
        refusée, et où va ce qu'on saisit ici.</Note>

      <Card flush title="Partenaires d'exécution"
        subtitle={`${rows.length} partenaire(s) · ${actifs} actif(s) · ${utilises} référencé(s) par des données`}
        right={can("admin") && <Btn size="sm" icon={Plus}
          onClick={()=>setEdit({ ...vide })}>Ajouter un partenaire</Btn>}>
        {!rows.length ? (
          <Empty icon={Users} title="Aucun partenaire d'exécution"
            text="Ce sont les organisations qui distribuent sur le terrain : on les assigne par commune dans le plan de distribution." />
        ) : (
          <TableWrap max="mh480">
            <thead><tr><Th>Partenaire</Th><Th>Sigle</Th><Th>Nature</Th><Th>Bureau</Th>
              <Th>Convention</Th><Th num>Sites</Th><Th num>Lignes de distribution</Th>
              <Th>État</Th><Th /></tr></thead>
            <tbody>{rows.map(p=>(
              <tr key={p.id} className="hover:bg-sky-50 cursor-pointer"
                  onClick={()=>can("admin") && setEdit({ ...p })}>
                <Td className="font-medium text-slate-800">{p.name}
                  {p.contact && <div className="f105 text-slate-400">{p.contact}</div>}</Td>
                <Td className="f115 text-slate-500">{p.code || "—"}</Td>
                <Td className="f115 text-slate-600">{p.kindLabel || "—"}</Td>
                <Td className="f115 text-slate-600">{p.office || "tous"}</Td>
                <Td className="f115 text-slate-500">
                  {p.agreement || "—"}
                  {p.end_date && <div className="f105 text-slate-400">jusqu'au {p.end_date}</div>}</Td>
                {/* Le poids réel du partenaire : c'est ce qui rend la liste vivante
                    plutôt que décorative. */}
                <Td num className={p.usage.sites ? "" : "text-slate-300"}>{p.usage.sites || "—"}</Td>
                <Td num className={p.usage.pdd ? "" : "text-slate-300"}>{p.usage.pdd || "—"}</Td>
                <Td>{p.active ? <Badge tone="g">actif</Badge> : <Badge>inactif</Badge>}</Td>
                <Td className="text-right whitespace-nowrap" onClick={e=>e.stopPropagation()}>
                  {can("admin") && (<>
                    <button onClick={()=>setEdit({ ...p })} className="text-slate-400 m-ico p-1">
                      <Pencil size={14}/></button>
                    <button onClick={()=>supprimer(p)}
                      title={p.usage.sites || p.usage.pdd ? "Partenaire référencé : désactivez-le" : "Supprimer"}
                      className="text-slate-400 hover:text-rose-600 p-1"><Trash2 size={14}/></button>
                  </>)}</Td>
              </tr>))}</tbody>
          </TableWrap>)}
      </Card>

      {/* ── Liaisons ──────────────────────────────────────────────────
          Ce que cette liste alimente, avec le chemin pour y aller. Sans cela,
          l'écran de configuration reste un formulaire hors sol. */}
      <div className="grid gap-4" style={{gridTemplateColumns:"1fr 1fr"}}>
        <Card title="Où servent les partenaires d'exécution" subtitle="Les écrans qui lisent cette liste">
          <div className="space-y-1.5">
            {[["Plan de distribution", "Assigné par commune et par mois", ["programme","distribution"]],
              ["Registre des sites", "Le partenaire qui exécute sur le site", ["suivi","sites"]],
             ].map(([titre, texte, dest])=>(
              <button key={titre} onClick={()=>go(...dest)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded border border-slate-200 hover:bg-sky-50 text-left">
                <Link2 size={14} className="text-slate-400 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="f125 text-slate-800 block">{titre}</span>
                  <span className="f105 text-slate-500">{texte}</span></span>
                <ArrowRight size={13} className="text-slate-400 shrink-0" />
              </button>))}
          </div>
        </Card>

        <Card title="Prestataires de suivi" subtitle={`${tpms.length} prestataire(s) contracté(s)`}
          right={<Btn size="sm" kind="sec" onClick={()=>go("suivi","tpm")}>Ouvrir le suivi tiers</Btn>}>
          {/* Les prestataires ne se gèrent pas ici : ils portent des contrats, des
              barèmes et un circuit de validation, donc ils ont leur propre écran. On
              les montre quand même, parce qu'ils sont une liste de référence comme
              les autres et qu'on les cherche ici. */}
          {!tpms.length ? <Empty icon={Building2} title="Aucun prestataire de suivi" /> : (
            <div className="space-y-1.5">
              {tpms.map(t=>(
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded border border-slate-200">
                  <span className="min-w-0 flex-1">
                    <span className="f125 text-slate-800 block">{t.name}</span>
                    <span className="f105 text-slate-500">
                      {t.office || "tous bureaux"} · {t.contrats?.length || 0} contrat(s)</span></span>
                  {!t.active && <Badge>inactif</Badge>}
                </div>))}
            </div>)}
          <Note>Un prestataire de suivi se crée et se contracte dans <b>Suivi-évaluation → Suivi
            tiers</b> : il porte un plafond, un barème et un circuit de validation, qu'une simple
            liste ne saurait pas tenir.</Note>
        </Card>
      </div>
    </div>);
}
