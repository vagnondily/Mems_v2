import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ChevronLeft, ChevronRight, Download, HeartPulse, Monitor, RefreshCw,
         RotateCcw, Save, ScrollText, Search, Trash2, Wrench } from "lucide-react";
import { Badge, Btn, Card, Empty, Field, Input, Modal, Note, Select, Stat, StatRow,
         TableWrap, Tabs, Td, Th, download, toCSV } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { fmt } from "../lib/calc.js";
import { PageHead } from "./Shell.jsx";

/* ══════════════════ Console d'administration ══════════════════

   Ce que cet écran administre n'est pas la donnée métier — comptes, bureaux et
   référentiels vivent dans Paramètres, où un administrateur les gère déjà — mais
   L'INSTANCE : les sessions ouvertes, le journal de sécurité, le fichier de base
   et ses sauvegardes. C'est la seule différence réelle entre `super` et `admin`,
   et c'est pourquoi la destination suit le rôle et non la liste d'onglets
   enregistrée sur le compte (lib/constants.js, destinationsAutorisees).

   Le serveur reste l'arbitre : chacune des routes appelées ici pose son propre
   garde `requireSuper`. Masquer la destination n'ouvre ni ne ferme rien, cela
   évite seulement de proposer une porte qui se referme au premier clic.

   Deux règles tenues partout dans ce fichier :
     — une action qui détruit ou qui bloque annonce d'abord, NOMMÉMENT, ce
       qu'elle va faire, avant de le faire ;
     — toute action rend un compte rendu affiché, y compris quand elle échoue.
       Une opération d'administration silencieuse est une opération dont on ne
       sait pas si elle a eu lieu. ══════════════════════════════════════════ */

/* SQLite rend ses dates en UTC sans le dire (« 2026-08-01 05:29:16 ») : sans le
   « Z », le navigateur les lirait comme des heures locales et afficherait un
   décalage constant. Les dates déjà normalisées passent telles quelles. */
const horodate = (v) => {
  if(!v) return "—";
  const s = String(v);
  const iso = /[Zz]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString("fr-FR");
};
const poids = (o) => o == null ? "—"
  : o < 1024 ? `${o} o` : o < 1048576 ? `${(o/1024).toFixed(1)} Ko`
  : `${(o/1048576).toFixed(2)} Mo`;

/* Charger, recharger, dire ce qui a échoué : le même trio dans les quatre
   sous-écrans. Écrit une fois — sinon la gestion d'erreur diverge d'un panneau
   à l'autre, et l'un d'eux finit par avaler en silence un refus du serveur. */
function useDonnees(charger){
  const [etat,setEtat] = useState({ donnees:null, erreur:"", chargement:true });
  /* La fonction de chargement est reprise par référence : `recharger` reste
     stable — donc l'effet ne se redéclenche pas à chaque rendu — tout en
     appelant toujours la dernière version de la closure. */
  const ref = useRef(charger);
  ref.current = charger;
  const recharger = useCallback(async () => {
    setEtat(e => ({ ...e, chargement:true }));
    try{ const d = await ref.current(); setEtat({ donnees:d, erreur:"", chargement:false }); }
    catch(e){ setEtat(x => ({ ...x, erreur:e.message, chargement:false })); }
  }, []);
  useEffect(() => { recharger(); }, [recharger]);
  return { ...etat, recharger };
}

/* Compte rendu de la dernière action. Il reste à l'écran jusqu'à la suivante :
   une notification passagère ne suffit pas quand on vient de révoquer trente
   sessions ou de réécrire le fichier de base. */
const Rendu = ({ r }) => !r ? null : (
  <Note tone={r.tone || "ok"} data-rendu>
    <b>{r.titre}</b>
    {(r.lignes || []).length > 0 && (
      <ul className="mt-1 pl18 list-disc">{r.lignes.filter(Boolean).map((l,i) => <li key={i}>{l}</li>)}</ul>)}
  </Note>);

/* Confirmation NOMMÉE. Elle ne demande pas « êtes-vous sûr » — question à
   laquelle on répond oui par réflexe — mais énonce l'effet exact, sur quoi, et
   ce qui est irréversible. Les gestes sans retour exigent en plus un mot
   recopié : une case se coche par inadvertance, un mot ne s'écrit pas tout
   seul. C'est la règle que le serveur applique déjà à la restauration. */
function Confirmation({ demande, onClose }){
  const [mot,setMot] = useState("");
  const [occupe,setOccupe] = useState(false);
  useEffect(() => { setMot(""); setOccupe(false); }, [demande]);
  if(!demande) return null;
  const pret = !demande.motAttendu || mot === demande.motAttendu;
  const lancer = async () => { setOccupe(true); try{ await demande.onOui(); } finally{ onClose(); } };
  return (
    <Modal open title={demande.titre} subtitle={demande.sous} onClose={onClose}
      footer={<>
        <Btn kind="sec" onClick={onClose}>Annuler</Btn>
        <Btn kind="danger" data-confirmer disabled={!pret || occupe} onClick={lancer}>
          {occupe ? "En cours…" : demande.libelle}</Btn></>}>
      <div className="f13 text-slate-700 leading-relaxed space-y-2">{demande.corps}</div>
      {demande.motAttendu && (
        <Field className="mt-3" label={`Recopiez « ${demande.motAttendu} » pour confirmer`}
          hint="Ce geste est sans retour : la confirmation est volontairement manuelle.">
          <Input value={mot} onChange={e=>setMot(e.target.value)} data-mot-confirmation
            placeholder={demande.motAttendu} /></Field>)}
    </Modal>);
}

/* ══════════════════ 1. Sessions ══════════════════ */
function Sessions({ notify }){
  const { donnees, erreur, chargement, recharger } = useDonnees(
    () => api.sessions("?tous=1&limite=200"));
  const [rendu,setRendu] = useState(null);
  const [demande,setDemande] = useState(null);
  const [jours,setJours] = useState("0");

  /* Un seul point de passage pour toutes les actions du panneau : le compte
     rendu, le rechargement et le traitement de l'échec y sont écrits une fois.
     Un échec est un compte rendu comme un autre — il s'affiche, il ne disparaît
     pas dans la console du navigateur. */
  const agir = async (titre, travail, lignesDe) => {
    try{
      const r = await travail();
      setRendu({ tone:"ok", titre, lignes: lignesDe(r) });
      notify(titre, "ok");
    }catch(e){
      setRendu({ tone:"err", titre:`${titre} — échec`, lignes:[e.message] });
      notify(e.message, "err");
    }
    await recharger();
  };

  const sessions = donnees?.sessions || [];
  const actives = sessions.filter(s => s.active).length;

  const revoquer = (s) => setDemande({
    titre: s.courante ? "Fermer votre propre session ?" : "Révoquer cette session ?",
    sous: `${s.email || s.user_id} — ouverte le ${horodate(s.issued_at)}`,
    libelle: "Révoquer",
    corps: (<>
      <p>La session <b>{s.id}</b> du compte <b>{s.email || s.user_id}</b> sera fermée immédiatement.
        Le poste concerné sera renvoyé à l'écran de connexion à sa prochaine action, en perdant
        la saisie en cours.</p>
      {s.courante && <p className="text-rose-700"><b>C'est la session avec laquelle vous êtes
        connecté.</b> Vous serez déconnecté dès cette requête et devrez vous reconnecter.</p>}
    </>),
    onOui: () => agir("Session révoquée",
      () => api.revoquerSession(s.id, s.courante),
      (r) => [`Session ${r.revoquee}`,
              r.deja_revoquee ? "elle était déjà révoquée, rien n'a changé" : null,
              r.courante ? "c'était votre session : reconnectez-vous" : null]),
  });

  const revoquerCompte = (s) => setDemande({
    titre: "Révoquer toutes les sessions de ce compte ?",
    sous: s.email || s.user_id,
    libelle: "Tout révoquer",
    corps: (<>
      <p>Toutes les sessions ouvertes du compte <b>{s.email || s.user_id}</b> seront fermées, sur tous
        ses appareils. C'est le geste à faire quand un poste est perdu ou compromis.</p>
      <p><b>Votre propre session sera préservée</b> si elle appartient à ce compte : se couper au milieu
        empêcherait de terminer le ménage — désactiver le compte, changer le mot de passe.</p>
    </>),
    onOui: () => agir("Sessions du compte révoquées",
      () => api.revoquerSessionsDe(s.user_id),
      (r) => [`${r.revoquees} session(s) fermée(s) pour ${r.email}`,
              r.courante_preservee ? "votre session courante a été préservée" : null]),
  });

  const purger = () => setDemande({
    titre: "Purger les sessions closes ?",
    sous: "Suppression définitive de lignes du journal des sessions",
    libelle: "Purger",
    corps: (<>
      <p>Les sessions <b>déjà révoquées ou expirées</b> seront supprimées de la base
        {Number(jours) > 0 ? <>, à l'exception de celles ouvertes il y a moins
          de <b>{jours} jour(s)</b></> : null}. Aucune session vivante n'est concernée.</p>
      <p>Ces lignes servent aux enquêtes après incident : une fois supprimées, elles ne se
        reconstituent pas.</p>
    </>),
    onOui: () => agir("Sessions closes purgées",
      () => api.purgerSessions(Number(jours) || 0),
      (r) => [`${r.supprimees} supprimée(s), ${r.restantes} conservée(s) sur ${r.avant}`,
              r.jours ? `fenêtre de conservation : ${r.jours} jour(s)` : null]),
  });

  return (
    <div className="space-y-4">
      <Note>Une session est un jeton de connexion vivant. La révoquer déconnecte l'appareil concerné
        à sa prochaine requête — c'est la parade immédiate à un poste perdu, sans avoir à désactiver
        le compte entier.</Note>
      <Rendu r={rendu} />
      {erreur && <Note tone="err"><b>Lecture impossible.</b> {erreur}</Note>}
      <StatRow>
        <Stat label="Sessions enregistrées" value={fmt(donnees?.total ?? 0)} icon={Monitor} />
        <Stat label="Sessions vivantes" value={fmt(actives)} tone={actives ? "ok" : undefined}
          sub="non révoquées et non expirées" />
        <Stat label="Comptes concernés" value={fmt(new Set(sessions.map(s=>s.user_id)).size)} />
      </StatRow>
      <Card flush title="Sessions ouvertes et closes"
        subtitle={`${sessions.length} dernière(s) session(s), la plus récente d'abord`}
        right={<>
          <Input className="mi-wauto mi-f115" type="number" min="0" value={jours} data-purge-jours
            onChange={e=>setJours(e.target.value)} title="Conserver les sessions closes de moins de N jours" />
          <Btn size="sm" kind="danger" icon={Trash2} onClick={purger}>Purger les closes</Btn>
          <Btn size="sm" kind="sec" icon={RefreshCw} onClick={recharger}>Actualiser</Btn></>}>
        {chargement && !donnees ? <p className="p-5 f13 text-slate-500">Chargement…</p>
          : sessions.length ? (
          <TableWrap max="mh440">
            <thead><tr><Th>Compte</Th><Th>État</Th><Th>Ouverte le</Th><Th>Expire le</Th>
              <Th>Adresse</Th><Th>Poste</Th><Th /></tr></thead>
            <tbody>{sessions.map(s => (
              <tr key={s.id} className="hover:bg-sky-50" data-session={s.id}>
                <Td className="font-medium">{s.email || s.user_id}
                  {s.courante && <Badge tone="b"> la vôtre</Badge>}</Td>
                <Td>{s.revoked ? <Badge tone="n">Révoquée</Badge>
                  : s.active ? <Badge tone="g">Vivante</Badge> : <Badge tone="y">Expirée</Badge>}</Td>
                <Td className="f115 text-slate-600">{horodate(s.issued_at)}</Td>
                <Td className="f115 text-slate-600">{horodate(s.expires_at)}</Td>
                <Td className="f115 text-slate-500">{s.ip || "—"}</Td>
                <Td className="f105 text-slate-400 mw240 truncate" title={s.user_agent || ""}>
                  {s.user_agent || "—"}</Td>
                <Td className="text-right">
                  {s.active && <Btn size="sm" kind="ghost" onClick={()=>revoquer(s)}>Révoquer</Btn>}
                  <Btn size="sm" kind="ghost" onClick={()=>revoquerCompte(s)}>Tout le compte</Btn></Td>
              </tr>))}</tbody>
          </TableWrap>
        ) : <Empty icon={Monitor} title="Aucune session" text="Aucune connexion n'est enregistrée." />}
      </Card>
      <Confirmation demande={demande} onClose={()=>setDemande(null)} />
    </div>);
}

/* ══════════════════ 2. Journal d'audit ══════════════════ */
const FILTRES_VIDES = { depuis:"", jusqu_a:"", user_id:"", kind:"", entity:"", action:"", q:"" };
const TAILLE = 50;

function Journal({ notify }){
  const [filtres,setFiltres] = useState(FILTRES_VIDES);
  /* Les filtres SAISIS et les filtres APPLIQUÉS sont deux états distincts : sans
     cela chaque frappe dans la recherche libre déclencherait une requête, et la
     pagination repartirait de la page 1 au milieu d'une lecture. */
  const [appliques,setAppliques] = useState(FILTRES_VIDES);
  const [page,setPage] = useState(1);
  const [donnees,setDonnees] = useState(null);
  const [facettes,setFacettes] = useState(null);
  const [erreur,setErreur] = useState("");

  useEffect(() => { api.journalFacettes().then(setFacettes).catch(()=>setFacettes(null)); }, []);

  useEffect(() => {
    let vivant = true;
    /* Seuls les filtres RENSEIGNÉS partent : le serveur valide la requête en
       mode strict, un paramètre vide n'y est pas « aucun filtre », c'est une
       valeur vide qui ne correspondrait à rien. */
    const p = new URLSearchParams();
    for(const [k,v] of Object.entries(appliques)) if(v) p.set(k, v);
    p.set("page", String(page)); p.set("taille", String(TAILLE));
    api.journal(`?${p.toString()}`)
      .then(d => { if(vivant){ setDonnees(d); setErreur(""); } })
      .catch(e => { if(vivant){ setErreur(e.message); } });
    return () => { vivant = false; };
  }, [appliques, page]);

  const u = (k,v) => setFiltres(f => ({ ...f, [k]:v }));
  const appliquer = () => { setPage(1); setAppliques(filtres); };
  const reinitialiser = () => { setFiltres(FILTRES_VIDES); setAppliques(FILTRES_VIDES); setPage(1); };
  const opts = (liste) => (liste || []).map(x => [x.v, `${x.v} (${x.n})`]);
  const lignes = donnees?.lignes || [];

  const exporter = () => {
    /* La PAGE affichée, et rien d'autre : un export qui ramènerait tout le
       journal laisserait croire que l'écran montre tout, alors qu'il en montre
       cinquante lignes. Le nom du fichier porte donc le numéro de page. */
    const cols = ["at","user_label","office","kind","entity","entity_id","action","text"];
    download(`journal-page-${page}.csv`, toCSV(lignes, cols), "text/csv");
    notify(`${lignes.length} ligne(s) exportée(s)`, "ok");
  };

  return (
    <div className="space-y-4">
      <Note>Le journal de sécurité conserve ce qu'aucun autre écran ne montre : connexions, échecs de
        connexion, changements de mot de passe, révocations, entretien de la base. Il est en écriture
        seule pour l'application — aucune route ne le modifie ni ne l'efface.</Note>
      {erreur && <Note tone="err"><b>Lecture impossible.</b> {erreur}</Note>}
      <Card title="Filtres" subtitle={facettes?.bornes?.premier
        ? `Le journal couvre du ${horodate(facettes.bornes.premier)} au ${horodate(facettes.bornes.dernier)}`
        : "Toutes les entrées du journal"}>
        <div className="grid gap-x-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))"}}>
          <Field label="Depuis" hint="AAAA-MM-JJ">
            <Input value={filtres.depuis} data-filtre-depuis placeholder="2026-01-01"
              onChange={e=>u("depuis", e.target.value)} /></Field>
          <Field label="Jusqu'au" hint="La journée entière est incluse">
            <Input value={filtres.jusqu_a} placeholder="2026-12-31"
              onChange={e=>u("jusqu_a", e.target.value)} /></Field>
          <Field label="Genre">
            <Select value={filtres.kind} empty="Tous" options={opts(facettes?.kinds)}
              onChange={e=>u("kind", e.target.value)} /></Field>
          <Field label="Objet">
            <Select value={filtres.entity} empty="Tous" options={opts(facettes?.entities)}
              onChange={e=>u("entity", e.target.value)} /></Field>
          <Field label="Action">
            <Select value={filtres.action} empty="Toutes" options={opts(facettes?.actions)}
              onChange={e=>u("action", e.target.value)} /></Field>
          <Field label="Compte">
            <Select value={filtres.user_id} empty="Tous"
              options={(facettes?.comptes || []).map(c => [c.user_id, `${c.user_label || c.user_id} (${c.n})`])}
              onChange={e=>u("user_id", e.target.value)} /></Field>
          <Field label="Recherche libre" hint="Dans le libellé de l'entrée">
            <Input value={filtres.q} data-filtre-q onChange={e=>u("q", e.target.value)} /></Field>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Btn icon={Search} onClick={appliquer}>Filtrer</Btn>
          <Btn kind="sec" onClick={reinitialiser}>Réinitialiser</Btn>
          <Btn kind="sec" icon={Download} onClick={exporter} disabled={!lignes.length}>
            Exporter la page</Btn>
        </div>
      </Card>
      <Card flush title="Entrées du journal"
        subtitle={donnees ? `${fmt(donnees.total)} entrée(s), page ${donnees.page} sur ${donnees.pages}`
          : "Chargement…"}
        right={<>
          <Btn size="sm" kind="sec" icon={ChevronLeft} disabled={!donnees || donnees.page <= 1}
            onClick={()=>setPage(p => Math.max(1, p-1))}>Précédente</Btn>
          <Btn size="sm" kind="sec" icon={ChevronRight} disabled={!donnees || donnees.page >= donnees.pages}
            onClick={()=>setPage(p => p+1)}>Suivante</Btn></>}>
        {lignes.length ? (
          <TableWrap max="mh440">
            <thead><tr><Th>Date</Th><Th>Compte</Th><Th>Genre</Th><Th>Objet</Th><Th>Action</Th><Th>Libellé</Th></tr></thead>
            <tbody>{lignes.map(l => (
              <tr key={l.id} className="hover:bg-sky-50">
                <Td className="f115 text-slate-600">{horodate(l.at)}</Td>
                <Td className="f115">{l.user_label || <span className="text-slate-400">—</span>}</Td>
                <Td><Badge tone={l.kind === "securite" ? "y" : "n"}>{l.kind}</Badge></Td>
                <Td className="f115 text-slate-600">{l.entity || "—"}</Td>
                <Td className="f115 text-slate-600">{l.action || "—"}</Td>
                <Td className="whitespace-normal">{l.text}</Td>
              </tr>))}</tbody>
          </TableWrap>
        ) : <Empty icon={ScrollText} title="Aucune entrée"
              text="Aucune entrée du journal ne correspond à ces filtres." />}
      </Card>
    </div>);
}

/* ══════════════════ 3. Santé et entretien ══════════════════ */
function Sante({ notify }){
  const { donnees, erreur, chargement, recharger } = useDonnees(() => api.baseEtat());
  const [rendu,setRendu] = useState(null);
  const [demande,setDemande] = useState(null);
  const [occupe,setOccupe] = useState("");

  const agir = async (nom, titre, travail, lignesDe) => {
    setOccupe(nom);
    try{
      const r = await travail();
      setRendu({ tone:"ok", titre, lignes: lignesDe(r) });
      notify(titre, "ok");
    }catch(e){
      setRendu({ tone:"err", titre:`${titre} — échec`, lignes:[e.message] });
      notify(e.message, "err");
    }finally{ setOccupe(""); }
    await recharger();
  };

  const checkpoint = () => agir("checkpoint", "Point de contrôle effectué",
    () => api.baseCheckpoint(),
    (r) => [`Taille de la base : ${poids(r.avant.octets)} → ${poids(r.apres.octets)} en ${r.ms} ms`,
            r.complet ? "le point de contrôle a été exécuté"
              : "le rôle de l'application n'a pas le privilège CHECKPOINT : opération ignorée"]);

  const vacuum = () => setDemande({
    titre: "Lancer un VACUUM sur la base ?",
    sous: "VACUUM (ANALYZE) sur toute la base",
    libelle: "Lancer le VACUUM",
    corps: (<>
      <p>PostgreSQL va <b>récupérer l'espace</b> laissé par les lignes mortes et <b>rafraîchir les
        statistiques</b> du planificateur. Contrairement à un VACUUM FULL, cette opération ne
        verrouille pas les tables en écriture.</p>
      <p>Elle peut néanmoins peser sur les entrées/sorties d'une base volumineuse : préférez une
        heure creuse. Aucune donnée n'est perdue.</p>
    </>),
    onOui: () => agir("vacuum", "VACUUM terminé",
      () => api.baseVacuum(),
      (r) => [`Taille de la base : ${poids(r.avant.octets)} → ${poids(r.apres.octets)} en ${r.ms} ms`,
              `Espace récupéré : ${poids(Math.max(0, r.gain))}`]),
  });

  const d = donnees;
  const conforme = d?.integrite?.conforme;

  return (
    <div className="space-y-4">
      <Rendu r={rendu} />
      {erreur && <Note tone="err"><b>Lecture impossible.</b> {erreur}</Note>}
      {chargement && !d && <p className="f13 text-slate-500">Lecture de l'état de la base…</p>}
      {d && (<>
        {d.entretien_en_cours && (
          <Note tone="warn"><b>Une opération d'entretien est en cours</b> ({d.entretien_en_cours.operation},
            depuis {Math.round((d.entretien_en_cours.ms || 0)/1000)} s). Les autres opérations seront
            refusées jusqu'à sa fin.</Note>)}
        <StatRow>
          <Stat label="Intégrité" value={conforme ? "Conforme" : "À examiner"}
            tone={conforme ? "ok" : "bad"} icon={HeartPulse}
            sub={`${d.integrite.contraintes_non_validees} contrainte(s) non validée(s)`} />
          <Stat label="Taille de la base" value={poids(d.base.octets)}
            sub={`PostgreSQL ${d.base.version || ""}`} />
          <Stat label="Connexions" value={fmt(d.base.connexions)}
            sub="sessions ouvertes sur cette base" />
          <Stat label="Sauvegardes" value={fmt(d.sauvegardes)} icon={Archive} />
        </StatRow>

        <Card title="Entretien" subtitle="Deux opérations bloquantes, à lancer en connaissance de cause"
          right={<Btn size="sm" kind="sec" icon={RefreshCw} onClick={recharger}>Actualiser</Btn>}>
          <div className="flex gap-2 flex-wrap">
            <Btn icon={Wrench} disabled={!!occupe} onClick={checkpoint}>
              {occupe === "checkpoint" ? "Point de contrôle…" : "Point de contrôle WAL"}</Btn>
            <Btn kind="danger" icon={Wrench} disabled={!!occupe} onClick={vacuum}>
              {occupe === "vacuum" ? "VACUUM en cours…" : "VACUUM"}</Btn>
          </div>
          <p className="f115 text-slate-500 mt-2 leading-relaxed">
            Le <b>point de contrôle</b> force PostgreSQL à écrire les pages modifiées sur le disque
            (utile avant une sauvegarde) ; il exige un rôle privilégié. Le <b>VACUUM (ANALYZE)</b>
            récupère l'espace des lignes mortes et rafraîchit les statistiques du planificateur, sans
            verrouiller les tables en écriture.</p>
        </Card>

        {!conforme && d.integrite.detail?.length > 0 && (
          <Card flush title="Contraintes non validées"
            subtitle={`${d.integrite.contraintes_non_validees} au total, ${d.integrite.detail.length} détaillée(s) — posées NOT VALID, non encore vérifiées sur les lignes existantes`}>
            <TableWrap max="mh240">
              <thead><tr><Th>Contrainte</Th><Th>Table</Th></tr></thead>
              <tbody>{d.integrite.detail.map((v,i) => (
                <tr key={i}><Td>{v.conname}</Td><Td>{v.table}</Td></tr>))}</tbody>
            </TableWrap>
          </Card>)}

        <div className="grid gap-4" style={{gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))"}}>
          <Card flush title="Migrations appliquées" subtitle={`${d.migrations.length} au schéma actuel`}>
            <TableWrap max="mh300">
              <thead><tr><Th>Migration</Th><Th>Appliquée le</Th></tr></thead>
              <tbody>{d.migrations.map(m => (
                <tr key={m.name}><Td className="f115">{m.name}</Td>
                  <Td className="f115 text-slate-500">{horodate(m.applied_at)}</Td></tr>))}</tbody>
            </TableWrap>
          </Card>
          <Card flush title="Tables" subtitle={`${d.tables.length} tables — nombre de lignes seulement`}>
            <TableWrap max="mh300">
              <thead><tr><Th>Table</Th><Th num>Lignes</Th></tr></thead>
              <tbody>{d.tables.map(t => (
                <tr key={t.nom}><Td className="f115">{t.nom}</Td><Td num>{fmt(t.lignes)}</Td></tr>))}</tbody>
            </TableWrap>
          </Card>
        </div>

        <Card title="Serveur PostgreSQL" subtitle="État de l'instance qui sert cette base">
          <div className="grid gap-x-4 gap-y-1"
            style={{gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))"}}>
            {Object.entries({
              version: d.base.version || "—",
              taille: poids(d.base.octets),
              connexions: d.base.connexions,
              tables: d.tables.length,
              migrations: d.migrations.length,
            }).map(([k,v]) => (
              <div key={k} className="flex gap-2 f115 border-b border-slate-100 py-1">
                <span className="text-slate-500">{k}</span>
                <b className="ml-auto text-slate-800 tabular-nums">{String(v)}</b></div>))}
          </div>
        </Card>
      </>)}
      <Confirmation demande={demande} onClose={()=>setDemande(null)} />
    </div>);
}

/* ══════════════════ 4. Sauvegarde et restauration ══════════════════ */
const MOT_RESTAURATION = "RESTAURER";

function Sauvegarde({ notify }){
  const { donnees, erreur, chargement, recharger } = useDonnees(() => api.sauvegardes());
  const [rendu,setRendu] = useState(null);
  const [demande,setDemande] = useState(null);
  const [occupe,setOccupe] = useState("");
  const [controles,setControles] = useState({});

  const agir = async (nom, titre, travail, lignesDe) => {
    setOccupe(nom);
    try{
      const r = await travail();
      setRendu({ tone:"ok", titre, lignes: lignesDe(r) });
      notify(titre, "ok");
    }catch(e){
      setRendu({ tone:"err", titre:`${titre} — échec`, lignes:[e.message] });
      notify(e.message, "err");
    }finally{ setOccupe(""); }
    await recharger();
  };

  const creer = () => agir("creer", "Sauvegarde produite",
    () => api.creerSauvegarde(),
    (r) => [`${r.sauvegarde.nom} — ${poids(r.sauvegarde.octets)} en ${r.sauvegarde.ms} ms`,
            `Relue après écriture : intégrité « ${r.sauvegarde.integrite} », ${r.sauvegarde.tables} tables`]);

  const telecharger = async (s) => {
    setOccupe(`dl:${s.nom}`);
    try{
      const b = await api.telechargerSauvegarde(s.nom);
      download(s.nom, b, b.type || "application/octet-stream");
      setRendu({ tone:"ok", titre:"Sauvegarde téléchargée",
        lignes:[`${s.nom} — ${poids(s.octets)}`,
          "Ce fichier contient la base entière : conservez-le comme tel."] });
    }catch(e){
      setRendu({ tone:"err", titre:"Téléchargement — échec", lignes:[e.message] });
      notify(e.message, "err");
    }finally{ setOccupe(""); }
  };

  const controler = async (s) => {
    setOccupe(`ct:${s.nom}`);
    try{
      const r = await api.controlerSauvegarde(s.nom);
      setControles(c => ({ ...c, [s.nom]: r.controle }));
      setRendu({ tone: r.controle.lisible ? "ok" : "err",
        titre: r.controle.lisible ? "Sauvegarde contrôlée et lisible" : "Sauvegarde inexploitable",
        lignes:[`${s.nom} — intégrité « ${r.controle.integrite ?? "inconnue"} », `
          + `${r.controle.violations ?? "?"} violation(s), ${r.controle.tables} tables, `
          + `${r.controle.migrations} migrations`,
          r.controle.motif] });
    }catch(e){
      setRendu({ tone:"err", titre:"Contrôle — échec", lignes:[e.message] });
      notify(e.message, "err");
    }finally{ setOccupe(""); }
  };

  const supprimer = (s) => setDemande({
    titre: "Supprimer cette sauvegarde ?",
    sous: `${s.nom} — ${poids(s.octets)}`,
    libelle: "Supprimer",
    corps: (<p>Le fichier <b>{s.nom}</b>, produit le {horodate(s.cree_le)}, sera effacé du serveur.
      Si vous ne l'avez pas téléchargé, cet état de la base ne sera plus récupérable.</p>),
    onOui: () => agir(`rm:${s.nom}`, "Sauvegarde supprimée",
      () => api.supprimerSauvegarde(s.nom), (r) => [`${r.supprime} effacée du serveur`]),
  });

  const restaurer = (s) => setDemande({
    titre: "Restaurer la base depuis cette sauvegarde ?",
    sous: `${s.nom} — produite le ${horodate(s.cree_le)}`,
    libelle: "Restaurer la base",
    motAttendu: MOT_RESTAURATION,
    corps: (<>
      <p>Le contenu <b>de toutes les tables</b> sera remplacé par celui de <b>{s.nom}</b>. Tout ce qui
        a été saisi depuis le {horodate(s.cree_le)} — sites, visites, plans, comptes créés — disparaîtra
        de la base.</p>
      <p>Le serveur produit <b>automatiquement une sauvegarde de l'état actuel</b> avant de commencer :
        une restauration du mauvais fichier reste rattrapable. L'opération est atomique — en cas
        d'échec, rien n'est modifié.</p>
      <p>Les sessions font partie des tables remplacées : <b>votre propre connexion peut ne plus être
        valide</b> après l'opération, et il faudra vous reconnecter.</p>
    </>),
    onOui: () => agir(`rs:${s.nom}`, "Base restaurée",
      () => api.restaurerBase(s.nom, MOT_RESTAURATION),
      (r) => [`${r.restaure} restaurée en ${r.ms} ms — ${r.tables} tables`,
              `Sauvegarde de l'état précédent : ${r.sauvegarde_prealable}`,
              r.compte_toujours_present ? null
                : "votre compte ne figure pas dans la sauvegarde restaurée",
              r.avertissement]),
  });

  const liste = donnees?.sauvegardes || [];

  return (
    <div className="space-y-4">
      <Note tone="warn"><b>Une sauvegarde est la base entière.</b> Elle contient toutes les données de
        l'opération, les empreintes de mots de passe et les jetons chiffrés. La télécharger, c'est sortir
        ce fichier de la machine : chaque téléchargement est inscrit au journal de sécurité, et le fichier
        obtenu doit être traité comme la base elle-même.</Note>
      <Rendu r={rendu} />
      {erreur && <Note tone="err"><b>Lecture impossible.</b> {erreur}</Note>}
      <Card flush title="Sauvegardes disponibles sur le serveur"
        subtitle={donnees?.dossier ? `Dossier : ${donnees.dossier}` : "Chargement…"}
        right={<>
          <Btn size="sm" icon={Save} disabled={!!occupe} onClick={creer}>
            {occupe === "creer" ? "Sauvegarde en cours…" : "Sauvegarder maintenant"}</Btn>
          <Btn size="sm" kind="sec" icon={RefreshCw} onClick={recharger}>Actualiser</Btn></>}>
        {chargement && !donnees ? <p className="p-5 f13 text-slate-500">Chargement…</p>
          : liste.length ? (
          <TableWrap max="mh440">
            <thead><tr><Th>Fichier</Th><Th>Produite le</Th><Th num>Taille</Th><Th>Contrôle</Th><Th /></tr></thead>
            <tbody>{liste.map(s => { const c = controles[s.nom];
              return (
              <tr key={s.nom} className="hover:bg-sky-50" data-sauvegarde={s.nom}>
                <Td className="f115 font-medium">{s.nom}</Td>
                <Td className="f115 text-slate-600">{horodate(s.cree_le)}</Td>
                <Td num>{poids(s.octets)}</Td>
                <Td>{c ? (c.lisible ? <Badge tone="g">Lisible</Badge> : <Badge tone="r">Inexploitable</Badge>)
                  : <span className="f105 text-slate-400">non contrôlée</span>}</Td>
                <Td className="text-right">
                  <Btn size="sm" kind="ghost" disabled={!!occupe} onClick={()=>controler(s)}>
                    {occupe === `ct:${s.nom}` ? "Contrôle…" : "Contrôler"}</Btn>
                  <Btn size="sm" kind="ghost" icon={Download} disabled={!!occupe}
                    onClick={()=>telecharger(s)}>
                    {occupe === `dl:${s.nom}` ? "…" : "Télécharger"}</Btn>
                  <Btn size="sm" kind="ghost" icon={RotateCcw} disabled={!!occupe}
                    onClick={()=>restaurer(s)}>Restaurer</Btn>
                  <Btn size="sm" kind="ghost" icon={Trash2} disabled={!!occupe}
                    onClick={()=>supprimer(s)}>Supprimer</Btn></Td>
              </tr>); })}</tbody>
          </TableWrap>
        ) : <Empty icon={Archive} title="Aucune sauvegarde"
              text="Produisez-en une avant toute opération d'entretien : c'est le seul filet."
              action={<Btn icon={Save} onClick={creer}>Sauvegarder maintenant</Btn>} />}
      </Card>
      {/* La restauration n'a de sens qu'avec un fichier à restaurer : elle est
          donc proposée sur chaque ligne plutôt qu'en bouton isolé qui n'aurait
          rien à faire quand la liste est vide. */}
      <Note>La <b>restauration</b> se lance depuis la ligne de la sauvegarde voulue. Contrôlez-la
        d'abord — c'est la seule façon honnête de savoir qu'une sauvegarde vaut quelque chose — puis
        confirmez en recopiant « {MOT_RESTAURATION} ». Le serveur sauvegarde l'état courant avant de
        l'écraser, et refuse l'opération si une autre est déjà en cours.</Note>
      <Confirmation demande={demande} onClose={()=>setDemande(null)} />
    </div>);
}

/* ══════════════════ Destination ══════════════════ */
function Admin({ me, sub, setSub, notify }){
  const items = [["sessions","Sessions"],["journal","Journal d'audit"],
    ["sante","Santé"],["sauvegarde","Sauvegarde"]];

  /* Ceinture, en plus des bretelles d'App et du garde du serveur : si cet écran
     est un jour atteint autrement — lien direct, état restauré —, il dit non de
     lui-même plutôt que d'enchaîner quatre appels voués au 403. */
  if(me?.role !== "super") return (
    <div className="space-y-4">
      <PageHead title="Administration" />
      <Note tone="err"><b>Destination réservée au super-utilisateur.</b> L'administration de l'instance —
        sessions, journal de sécurité, base et sauvegardes — n'est pas ouverte au rôle
        « administrateur », qui gère les comptes, les bureaux et les référentiels dans Paramètres.</Note>
    </div>);

  return (
    <div className="space-y-4">
      <PageHead title="Administration"
        text="Exploitation de l'instance : sessions ouvertes, journal de sécurité, état du fichier de base et sauvegardes. Ces écrans ne touchent pas à la donnée métier." />
      <Tabs items={items} value={sub} onChange={setSub} />
      {sub==="sessions"   && <Sessions notify={notify} />}
      {sub==="journal"    && <Journal notify={notify} />}
      {sub==="sante"      && <Sante notify={notify} />}
      {sub==="sauvegarde" && <Sauvegarde notify={notify} />}
    </div>);
}

export { Admin, Confirmation, Journal, Rendu, Sante, Sauvegarde, Sessions, horodate, poids };
