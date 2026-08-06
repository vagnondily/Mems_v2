import { useEffect, useMemo, useState } from "react";
import { BarChart3, Bell, CalendarRange, Check, ChevronDown, Cog, Database, FileText, Gauge, KeyRound, LayoutDashboard, LogOut, MapPin, Save, ShieldCheck, UserCog } from "lucide-react";
import { Badge, Btn, BrandMark, Empty, Field, Input, Modal, Note, NotesMenuItem, SandboxMenuItem, TestEnvMenuItem, useSandbox, useTestEnv } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { clsx } from "../lib/calc.js";
import { C } from "../lib/constants.js";
import { SEVERITES, ecrireLues, elaguerLues, lireLues, tachesUtilisateur } from "../lib/taches.js";

/* ══════════════════ Mon compte ══════════════════
   Self-service du compte, ouvert depuis le menu du compte de l'en-tête (demande du
   01/08) : accessible à TOUT rôle, y compris ceux qui n'ont pas l'onglet Paramètres.
   On y consulte ses infos, on change son mot de passe à tout moment, et on définit
   son identifiant de connexion. Aucune donnée d'un autre compte n'y transite. */
function AccountModal({ open, me, db, notify, onMe, onClose }){
  const [ident,setIdent] = useState("");
  const [pw,setPw] = useState({ current:"", next:"", confirm:"" });
  const [busy,setBusy] = useState(false);
  useEffect(()=>{ if(open){ setIdent(me.username||""); setPw({ current:"", next:"", confirm:"" }); } },[open, me]);
  if(!open) return null;

  const enregistrerIdent = async () => {
    setBusy(true);
    try{ const r = await api.setUsername(ident.trim());
      onMe?.(r.user);
      notify(ident.trim() ? "Identifiant enregistré" : "Identifiant retiré", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };
  const changerMdp = async () => {
    if(pw.next !== pw.confirm){ notify("La confirmation ne correspond pas", "err"); return; }
    setBusy(true);
    try{ await api.changePassword(pw.current, pw.next);
      setPw({ current:"", next:"", confirm:"" });
      notify("Mot de passe modifié — les autres sessions sont fermées", "ok");
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  const info = [["Nom", `${me.firstName} ${me.lastName}`.trim() || "—"],
    ["Fonction", me.title || "—"], ["Adresse électronique", me.email],
    ["Rôle", db.roles[me.role]?.label || me.role],
    ["Rattachement", me.office || (me.tpm ? `Prestataire — ${me.tpm}` : "Tous les bureaux")]];

  return (
    <Modal open onClose={onClose} title="Mon compte" subtitle="Vos informations, votre identifiant et votre mot de passe">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
        {info.map(([k,v])=>(
          <div key={k} className="flex flex-col">
            <span className="f10 uppercase tracking-wide font-bold text-slate-400">{k}</span>
            <span className="f13 text-slate-800">{v}</span></div>))}
      </div>

      <div className="border-t border-slate-100 pt-3">
        <div className="font-semibold text-slate-800 f13 mb-1.5 flex items-center gap-2"><UserCog size={15}/> Identifiant de connexion</div>
        <Note>Facultatif. Défini, il permet de se connecter avec cet identifiant à la place de l'adresse
          électronique. 3 à 40 caractères : lettres minuscules, chiffres, point, tiret, tiret bas.</Note>
        <div className="flex items-end gap-2">
          <Field label="Identifiant" className="flex-1"><Input value={ident}
            onChange={e=>setIdent(e.target.value)} placeholder="prenom.nom" /></Field>
          <Btn kind="sec" icon={Save} disabled={busy || (ident.trim()===(me.username||""))} onClick={enregistrerIdent}>
            {me.username ? "Mettre à jour" : "Définir"}</Btn>
        </div>
      </div>

      <div className="border-t border-slate-100 pt-3 mt-1">
        <div className="font-semibold text-slate-800 f13 mb-1.5 flex items-center gap-2"><KeyRound size={15}/> Mot de passe</div>
        <div className="grid grid-cols-3 gap-x-3">
          <Field label="Mot de passe actuel"><Input type="password" value={pw.current}
            onChange={e=>setPw(p=>({...p,current:e.target.value}))} /></Field>
          <Field label="Nouveau mot de passe" hint="12 caractères minimum"><Input type="password" value={pw.next}
            onChange={e=>setPw(p=>({...p,next:e.target.value}))} /></Field>
          <Field label="Confirmer"><Input type="password" value={pw.confirm}
            onChange={e=>setPw(p=>({...p,confirm:e.target.value}))} /></Field>
        </div>
        <Btn icon={KeyRound} className="mt-1"
          disabled={busy || !pw.current || pw.next.length<12 || !pw.confirm} onClick={changerMdp}>
          Changer le mot de passe</Btn>
      </div>
    </Modal>);
}

/* ══════════════════ Coquille ══════════════════ */
/* Les destinations, et rien d'autre. Chaque écran déclare lui-même ses
   sous-onglets (composant Tabs) : les redire ici en ferait une seconde liste à
   tenir à jour, qui finirait par mentir le jour où un écran change les siens. */
const NAV = [
  { id:"home", label:"Accueil", icon:LayoutDashboard },
  /* Le tableau de bord des visualisations, modifiable par l'utilisateur, est une
     destination de premier niveau (demande explicite), non un sous-onglet des
     Analyses. */
  { id:"viz", label:"Tableau de bord", icon:Gauge },
  /* Un sujet par destination : le prévu et le réalisé s'y basculent, ils ne se
     dupliquent plus. Le premier niveau suit les deux métiers, non la nature des données. */
  { id:"suivi", label:"Suivi-évaluation", icon:CalendarRange },
  { id:"programme", label:"Programme", icon:Database },
  { id:"map", label:"Cartographie", icon:MapPin },
  { id:"analytics", label:"Analyses", icon:BarChart3 },
  { id:"reports", label:"Rapports", icon:FileText },
  /* Dernière de la barre, et volontairement : ce n'est pas une destination de
     travail. On y va pour exploiter l'instance — sessions, journal de sécurité,
     base, sauvegardes — pas pour saisir de la donnée. Elle n'apparaît que pour
     le rôle `super` (lib/constants.js, destinationsAutorisees) ; `allowed` fait
     seul le filtrage, cette liste ne décide de rien. */
  { id:"admin", label:"Administration", icon:ShieldCheck },
];

/* État d'enregistrement : l'utilisateur doit savoir si son travail est parti au serveur. */
function SyncBadge({ sync }){
  if(!sync) return null;
  const map = {
    saved: ["Enregistré", "bg-white/10 text-white/80"],
    dirty: ["Modifications en attente", "bg-amber-400/20 text-amber-100"],
    saving:["Enregistrement…", "bg-white/20 text-white"],
    error: ["Échec d'enregistrement", "bg-rose-500/30 text-rose-50"],
  };
  const [label, cls] = map[sync.state] || map.saved;
  return (
    <span title={sync.message || label}
      className={clsx("hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full f11 font-semibold", cls)}>
      <i className={clsx("w-1.5 h-1.5 rounded-full",
        sync.state==="error" ? "bg-rose-300" : sync.state==="saved" ? "bg-lime-300" : "bg-amber-300")} />
      {label}
    </span>);
}

/* Nombre de tâches montrées d'emblée : au-delà, le panneau cesse d'être une
   notification et redevient le tableau qu'on vient justement de retirer de
   l'accueil. Le reste s'ouvre à la demande. */
const APERCU = 6;

/* Cloche de notifications.
   Les tâches ne viennent pas du serveur : elles sont déduites de l'état par
   lib/taches.js, filtrées selon le bureau et les droits du compte. La cloche ne
   décide rien, elle compte et elle mène. */
function Cloche({ db, me, allowed, setTab, ouvert, setOuvert }){
  const [lues,setLues] = useState(() => lireLues(me.id));
  const [tout,setTout] = useState(false);
  const toutes = useMemo(() => tachesUtilisateur(db, me, allowed), [db, me, allowed]);

  /* Une tâche réglée sort de la dérivation ; son identifiant n'a plus à rester
     masqué. C'est cet élagage qui la fait réapparaître si elle redevient vraie. */
  useEffect(() => { setLues(prev => {
    const next = elaguerLues(prev, toutes);
    if(next.size === prev.size) return prev;
    ecrireLues(me.id, next); return next;
  }); }, [toutes, me.id]);

  /* Refermer le panneau le remet à son aperçu : rouvrir ne doit pas restituer un
     déroulé de quarante lignes dont on était sorti. */
  useEffect(() => { if(!ouvert) setTout(false); }, [ouvert]);

  const taches = toutes.filter(t => !lues.has(t.id));
  const urgentes = taches.filter(t => t.severite === "urgent").length;
  const visibles = tout ? taches : taches.slice(0, APERCU);
  const toutMarquerLu = () => { const next = new Set(toutes.map(t => t.id));
    setLues(next); ecrireLues(me.id, next); };

  return (
    <div className="relative" onClick={e=>e.stopPropagation()}>
      <button onClick={()=>setOuvert(o=>!o)} data-cloche
        title={taches.length ? `${taches.length} tâche(s) en attente` : "Aucune tâche en attente"}
        aria-label={`Notifications — ${urgentes} urgente(s) sur ${taches.length}`}
        className="relative p-1.5 rounded-full text-white/85 hover:bg-white/10 hover:text-white">
        <Bell size={17} />
        {/* Le nombre porté par la pastille est celui des urgences : c'est la seule
            question qu'on pose à une cloche d'un coup d'œil. Le reste se compte
            dans le panneau — mais un point signale qu'il y a tout de même à lire. */}
        {urgentes > 0
          ? <span data-cloche-compte={urgentes}
              className="absolute -top-0.5 -right-0.5 min-w-[17px] h-[17px] px-1 rounded-full grid place-items-center
                         bg-rose-500 text-white f9 font-bold tabular-nums ring-2 ring-[#085387]">
              {urgentes > 99 ? "99+" : urgentes}</span>
          : taches.length > 0
            ? <span data-cloche-compte="0"
                className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-amber-300 ring-2 ring-[#085387]" />
            : null}
      </button>
      {ouvert && (
        <div className="absolute right-0 top-10 bg-white rounded shadow-xl border border-slate-200 w-96 max-w-[92vw] z-50 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
            <div className="min-w-0">
              <div className="f13 font-semibold text-slate-800">Notifications</div>
              <div className="f115 text-slate-500">{taches.length
                ? `${urgentes} urgente(s) sur ${taches.length} tâche(s)`
                : "Tout est à jour"}</div>
            </div>
            {taches.length > 0 && (
              <button onClick={toutMarquerLu}
                className="ml-auto shrink-0 f11 font-semibold c-bd hover:underline">Tout marquer comme lu</button>)}
          </div>
          {taches.length ? (<>
            <div className="mh340 overflow-auto">
              {SEVERITES.map(([code,label,tone]) => {
                const groupe = visibles.filter(t => t.severite === code);
                if(!groupe.length) return null;
                /* Le compte du bandeau est celui de la SÉVÉRITÉ, pas celui des
                   lignes affichées : n'annoncer que la tranche visible ferait
                   lire « Urgent 6 » là où il y en a cent soixante-dix-sept. */
                const total = taches.filter(t => t.severite === code).length;
                return (
                  <div key={code}>
                    <div className="flex items-center gap-2 px-4 py-1.5 bg-slate-50 border-y border-slate-100">
                      <Badge tone={tone}>{label}</Badge>
                      <span className="f11 text-slate-500 tabular-nums">
                        {total > groupe.length ? `${groupe.length} sur ${total}` : total}</span>
                    </div>
                    {/* Chaque tâche mène à l'écran qui la résout : une notification
                        qu'on ne peut pas suivre ne vaut pas la peine d'être posée. */}
                    {groupe.map(t => (
                      <button key={t.id} data-tache={t.id}
                        onClick={()=>{ setTab(...t.vers); setOuvert(false); }}
                        className="block w-full text-left px-4 py-2.5 border-b border-slate-50 hover:bg-sky-50">
                        <div className="f125 font-semibold text-slate-800">{t.titre}</div>
                        <div className="f115 text-slate-600 leading-snug">{t.detail}</div>
                        {t.contexte && <div className="f105 text-slate-400 mt-0.5">{t.contexte} →</div>}
                      </button>))}
                  </div>);
              })}
            </div>
            {!tout && taches.length > APERCU && (
              <button onClick={()=>setTout(true)}
                className="w-full px-4 py-2.5 f115 font-semibold c-bd border-t border-slate-100 hover:bg-slate-50">
                Tout voir ({taches.length})</button>)}
          </>) : (
            <Empty icon={Check} title="Rien d'urgent"
              text="Aucune échéance en attente pour votre périmètre." />)}
        </div>)}
    </div>);
}

/* `allowed` est calculé une seule fois par App (resolveTabs) et transmis ici :
   deux règles divergentes laissaient un compte sans aucune navigation. */
function Shell({ db, me, tab, sub, setTab, children, onLogout, sync, notify, onMe, allowed = [] }){
  const [menu,setMenu] = useState(false);
  const [cloche,setCloche] = useState(false);
  const [compte,setCompte] = useState(false);
  const sandbox = useSandbox();
  const testEnv = useTestEnv();
  useEffect(()=>{ const h=()=>{setMenu(false);setCloche(false);};
    window.addEventListener("click",h); return ()=>window.removeEventListener("click",h); },[]);
  const initials = (me.firstName?.[0]||"") + (me.lastName?.[0]||"");
  return (
    /* « Fermer la page sur la mesure totale de l'écran, scroll pour le reste. »
       La coque occupe EXACTEMENT la hauteur de la fenêtre (h-screen) et ne défile
       pas elle-même (overflow-hidden) : l'en-tête reste en haut, le pied en bas, et
       seul le contenu défile, dans son propre cadre (main : overflow-y-auto). Les
       en-têtes de tableau collants (TableWrap) se collent alors au haut de ce
       cadre, comme demandé. */
    <div className="h-screen overflow-hidden flex flex-col" style={{background:C.bg}}>
      {/* ── En-tête ────────────────────────────────────────────────────
          Le bloc de marque était un cadre translucide de 44 px contenant un signe
          de 36 px, surmonté de deux lignes de texte dont la seconde à 8 px. Trois
          conséquences : le cadre transformait le signe en pastille grise
          illisible, la ligne de 8 px se lisait comme une salissure plutôt que
          comme une phrase, et le bloc occupait 260 px sur deux lignes dans une
          barre de 56 px où tout le reste tient sur une seule.

          Le signe est donc posé à même la barre, à sa taille lisible, suivi du
          seul mot « MEMS » et d'un filet qui sépare la marque de la navigation.
          L'intitulé complet a rejoint le pied de page, où il y a la place de le
          lire. Une marque n'a pas besoin de se répéter à chaque écran ; elle a
          besoin d'être reconnaissable. */}
      <header className="flex items-center gap-1 px-4 h-14 text-white sticky top-0 z-40" style={{background:C.brandD}}>
        <div className="flex items-center gap-2.5 shrink-0 pr-4 mr-2 h-8 border-r border-white/20">
          <BrandMark size={30} tone="light" />
          <span className="f15 font-bold tr14">MEMS</span>
        </div>
        {/* La barre du haut ne porte plus que les DESTINATIONS. Les menus
            déroulants qui s'y ouvraient ont été retirés, pour trois raisons
            constatées ensemble :

            1. Ils étaient découpés. Cette barre a besoin de `overflow-x-auto`
               pour défiler sur un écran étroit ; or en CSS, dès que `overflow-x`
               vaut `auto`, `overflow-y` cesse d'être `visible`. Un panneau posé
               en `absolute top-14`, donc SOUS la barre, était donc rogné par son
               propre parent — le défaut d'affichage signalé à l'usage.
            2. Le bouton faisait deux choses d'un seul clic : il changeait de
               destination ET ouvrait le menu. On arrivait sur l'écran demandé
               avec un panneau posé par-dessus, et recliquer renavigait au lieu
               de simplement refermer.
            3. Ils étaient redondants. Chaque destination affiche déjà sa propre
               barre de sous-onglets dans la page (composant Tabs), entièrement
               visible et non contrainte par un parent qui défile.

            Un menu qui duplique une navigation existante en la cassant n'est pas
            à réparer, il est à retirer. */}
        <nav className="flex items-center gap-0.5 overflow-x-auto">
          {NAV.filter(x=>allowed.includes(x.id)).map(x => (
            /* Un seul signal pour la destination courante : le filet. Le fond
               teinté et le texte blanc en plus faisaient trois marques pour une
               idée. */
            <button key={x.id} onClick={()=>setTab(x.id)}
              className={clsx("flex items-center gap-1.5 px-3 h-14 f125 font-semibold whitespace-nowrap border-b-2 transition-colors",
                tab===x.id ? "border-white text-white" : "border-transparent text-white/65 hover:text-white")}>
              <x.icon size={15} className={tab===x.id ? "" : "opacity-80"} />{x.label}
            </button>))}
        </nav>
        <div className="ml-auto flex items-center gap-3 shrink-0">
          <SyncBadge sync={sync} />
          {/* Les tâches urgentes occupaient un tableau au milieu de l'accueil : on ne
              les voyait qu'en s'y rendant, et jamais depuis les autres écrans. Elles
              sont désormais où l'on va les chercher — dans la barre, à toute heure. */}
          <Cloche db={db} me={me} allowed={allowed} setTab={setTab} ouvert={cloche}
            setOuvert={v=>{ setMenu(false); setCloche(v); }} />
          <div className="relative" onClick={e=>e.stopPropagation()}>
            {/* La pastille suffit à identifier le compte ; l'anneau et le fond
                translucide autour ajoutaient deux bordures sans rien dire. */}
            <button onClick={()=>{ setMenu(m=>!m); setCloche(false); }}
              className="flex items-center gap-2 pl-0.5 pr-2 py-0.5 rounded-full hover:bg-white/10 f125">
              <span className="w-7 h-7 rounded-full grid place-items-center f105 font-bold c-deep" style={{background:C.aqua}}>{initials||"?"}</span>
              <span className="hidden sm:inline text-white/90">{me.firstName}</span>
              <ChevronDown size={12} className="opacity-60" /></button>
            {menu && (
              <div className="absolute right-0 top-10 bg-white rounded shadow-xl border border-slate-200 w-72 z-50 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100">
                  <div className="font-semibold text-slate-800 f13">{me.firstName} {me.lastName}</div>
                  <div className="f115 text-slate-500">{me.title}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone="b">{db.roles[me.role]?.label}</Badge>
                    <Badge>{me.office || "Tous les bureaux"}</Badge></div>
                </div>
                <button onClick={()=>{setCompte(true);setMenu(false);}}
                  className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50">
                  <UserCog size={14} /> Mon compte</button>
                {/* L'interrupteur des notes explicatives — rangé ici, hors de la
                    vue des pages, pour ne pas les enlaidir. */}
                <NotesMenuItem onDone={()=>setMenu(false)} />
                {/* Le bac à sable : réservé au super, il fait vivre l'application
                    sans jamais toucher la donnée réelle. */}
                {me.role==="super" && <SandboxMenuItem onDone={()=>setMenu(false)} />}
                {/* Le mode test (miroir serveur) : y basculer envoie chaque
                    requête vers l'instantané isolé de la production. Ouvert à
                    tout compte quand un miroir existe — c'est un bac à sable
                    partagé, pas un droit d'administration. */}
                <TestEnvMenuItem onDone={()=>setMenu(false)} />
                {allowed.includes("settings") && (
                  <button onClick={()=>{setTab("settings");setMenu(false);}}
                    className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50 border-t border-slate-100">
                    <Cog size={14} /> Paramètres de l'application</button>)}
                <button onClick={onLogout} className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50 border-t border-slate-100">
                  <LogOut size={14} /> Se déconnecter</button>
              </div>)}
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto w-full">
        <div className="mw1520 w-full mx-auto px-5 py-5">
          {/* Bandeau MODE DÉMONSTRATION (bac à sable) — on peut tout remplir, rien
              n'est enregistré. Le super lève le mode depuis son menu (en haut à
              droite). Un rechargement rétablit la donnée réelle intacte. */}
          {sandbox && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 flex items-center gap-2.5 f125 text-amber-900">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0 animate-pulse" />
              <span><b>Mode démonstration</b> — vous pouvez remplir les formulaires, mais rien n'est enregistré sur les données réelles. Quittez ce mode depuis le menu du compte.</span>
            </div>)}
          {/* Bandeau MODE TEST (miroir) — ici les écritures PERSISTENT, mais dans
              le jumeau isolé de la production. Un violet franc pour ne jamais le
              confondre avec la production ni avec la démonstration. */}
          {testEnv && (
            <div className="mb-4 rounded-xl border border-violet-300 bg-violet-50 px-4 py-2.5 flex items-center gap-2.5 f125 text-violet-900">
              <span className="w-2.5 h-2.5 rounded-full bg-violet-500 shrink-0 animate-pulse" />
              <span><b>Mode test</b> — vous travaillez sur un instantané isolé de la production. Vos écritures sont enregistrées ici, dans le bac à sable, jamais sur les données réelles. Quittez ce mode depuis le menu du compte.</span>
            </div>)}
          {children}
        </div>
      </main>
      {/* L'intitulé complet vit ici : le pied de page est l'endroit où l'on a la
          place de le lire, et il n'a pas à occuper la barre à chaque écran. */}
      <footer className="border-t border-slate-200 bg-white px-5 py-3 flex items-center gap-3 f11 text-slate-500">
        {db.settings.logo && <img src={db.settings.logo} alt="" className="h-6 w-auto shrink-0"
          onError={e=>{ e.currentTarget.style.display="none"; }} />}
        <div>{db.settings.org} — {db.settings.unit}</div>
        <span className="ml-auto text-right">
          <b className="font-semibold text-slate-600">MEMS</b> · Monitoring and Evaluation
          Management System · exercice {db.year}</span>
      </footer>
      <AccountModal open={compte} me={me} db={db} notify={notify} onMe={onMe} onClose={()=>setCompte(false)} />
    </div>);
}
/* Titre de page. Il était à 23 px en gras, suivi d'un paragraphe à 13 px, au-dessus
   de cartes dont les titres sont à 13 px : l'écart de hiérarchie était tel que le
   titre écrasait le contenu, et l'empilement titre + phrase + onglets + bascule
   repoussait les données sous la ligne de flottaison. Ramené à 19 px, avec la
   phrase en 12,5 px et une marge resserrée. La phrase reste : elle dit à quoi
   sert l'écran, ce qu'aucun titre de deux mots ne fait. */
const PageHead = ({ title, text, children }) => (
  <div className="flex items-start gap-4 flex-wrap mb-4">
    <div className="min-w-0">
      <h2 className="f19 font-semibold text-slate-900 leading-tight">{title}</h2>
      {text && <p className="f125 text-slate-500 mt-1 max-w-3xl leading-relaxed">{text}</p>}</div>
    <div className="ml-auto flex gap-2 flex-wrap">{children}</div>
  </div>);

export { SyncBadge, NAV, PageHead, Shell };
