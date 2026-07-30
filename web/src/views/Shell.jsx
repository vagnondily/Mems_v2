import { useEffect, useState } from "react";
import { BarChart3, Bell, CalendarRange, ChevronDown, Cog, Database, FileText, Globe,
         LayoutDashboard, LogOut } from "lucide-react";
import { Badge, BrandMark } from "../components/ui.jsx";
import { clsx } from "../lib/calc.js";
import { C } from "../lib/constants.js";
import { getWorkingCountry, setWorkingCountry } from "../lib/api.js";
import { alertes } from "../lib/alerts.js";

/* ═══════════════════════════════════════════════════════════════════════
   Coquille — navigation, identité du compte, alertes.

   La navigation était sur DEUX niveaux qui se contredisaient : un menu déroulant
   dans l'en-tête, et une barre d'onglets sous le titre de page. Les deux listaient
   les mêmes destinations. Conséquences observées en parcourant l'application comme
   un utilisateur :

     — le bouton de section faisait deux choses à la fois (naviguer ET ouvrir ou
       fermer le menu) : un deuxième clic pour atteindre une sous-page la refermait ;
     — le menu déroulant recouvrait la barre d'onglets, donc l'endroit même où l'on
       allait cliquer ;
     — une fois sur une destination, le menu était refermé : pour passer à sa
       voisine il fallait rouvrir la section, ce qui changeait déjà l'écran.

   Le menu déroulant est supprimé. Il reste UNE barre de sous-destinations, sous
   l'en-tête, toujours visible et collante : on voit où l'on est et où l'on peut
   aller, sans rien ouvrir. La coquille porte aussi le titre de la destination —
   les quatre vues affichaient le nom de leur SECTION, identique sur huit écrans, ce
   qui ne disait jamais où l'on se trouvait.

   `NAV` est désormais la seule définition de la navigation : identifiant, libellé
   et phrase de chaque destination. Les vues ne redéclarent plus leur propre liste —
   elles en avaient une, forcément vouée à diverger de celle-ci.
   ═══════════════════════════════════════════════════════════════════════ */
const NAV = [
  { id:"home", label:"Accueil", icon:LayoutDashboard,
    text:"Situation consolidée : exigence minimale de suivi, tendance des trois derniers mois et ce qui attend une action." },
  /* Un sujet par destination : le prévu et le réalisé s'y basculent, ils ne se
     dupliquent plus. Le premier niveau suit les deux métiers, non la nature des données. */
  { id:"suivi", label:"Suivi-évaluation", icon:CalendarRange, sub:[
    ["summary","Résumé global","Ce que le suivi a produit sur l'exercice : couverture, visites, écarts."],
    ["monitoring","Suivi des sites","Le plan de visites fondé sur le risque, et les visites réellement faites."],
    ["mre","Plan MRE et budget","Le plan de suivi, revue et évaluation du bureau pays, et son budget."],
    ["tpm","Suivi tiers","Prestataires de suivi : contrats, zones affectées, budgets validés et dépenses."],
    ["coverage","Couverture et MMR","Ce que l'exigence minimale de suivi impose, et ce qui est atteint."],
    ["map","Cartographie","Où sont les sites, ce qu'ils couvrent, et ce qui reste à visiter."],
    ["sites","Registre des sites","Le registre complet : rattachement, activité, partenaire, dernière visite."],
    ["params","Paramètres de couverture","Ce sur quoi la couverture est calculée : risque, durée, capacité mensuelle."]] },
  { id:"programme", label:"Programme", icon:Database, sub:[
    ["distribution","Distributions","Le plan de distribution par commune et période, et ce qui a été distribué."],
    ["population","Population et outputs","Population, personnes ciblées et produits livrés par activité."],
    ["results","Résultats","Calendrier de collecte des indicateurs de résultat, et valeurs mesurées."],
    ["import","Import Excel","Remplir hors ligne puis téléverser : analyse, écarts, confirmation."],
    ["sources","Sources de données","Formulaires ODK Central rattachés aux activités."]] },
  { id:"analytics", label:"Analyses", icon:BarChart3, sub:[
    ["datasets","Jeux de données","Constitution et apurement des jeux issus des sources."],
    ["scripts","Scripts d'analyse","Traitements R ou SPSS appliqués aux jeux de données."],
    ["viz","Visualisations","Tableaux de bord composés à partir des jeux apurés."]] },
  { id:"reports", label:"Rapports", icon:FileText, sub:[
    ["extract","Extraction ODK","Extraction filtrée des soumissions, prête à exporter."],
    ["build","Générateur de rapport","Composition d'un rapport à partir des données brutes ou apurées."]] },

  /* `hidden` : la section n'apparaît pas dans la barre du haut — on y entre par le
     menu du compte — mais elle déclare ses destinations comme les autres, et reçoit
     donc la même barre collante et les mêmes titres. Sans cela, l'écran de
     configuration aurait gardé sa propre liste, c'est-à-dire une deuxième vérité. */
  { id:"settings", label:"Paramètres", icon:Cog, hidden:true, sub:[
    ["general","Général","Identité de l'organisation, affichage, listes de codification."],
    ["country","Pays et découpage","Pays servis, vocabulaire des niveaux, découpage administratif et contours."],
    ["offices","Bureaux","Bureaux et antennes : nature, périmètre, responsable."],
    ["scope","Périmètre des bureaux","Quelles unités administratives chaque bureau couvre."],
    ["sites","Sites","Le registre des sites, modifiable en masse."],
    ["indicators","Indicateurs","Indicateurs de résultat : cible, sens, méthode, fréquence."],
    ["calc","Calculs","Exigence minimale de suivi, pondérations, formules de priorité."],
    ["odk","ODK Central","Connexion aux formulaires et rattachement aux activités."],
    ["templates","Modèles de rapport","Trames réutilisables du générateur de rapport."],
    ["api","API","Accès applicatif et jetons."],
    ["users","Utilisateurs","Comptes, rôles, rattachements et portée."],
    ["about","À propos","Version, intégrité de la base, licences."]] },

  /* Destination de la cloche. Sans sous-destinations : c'est une seule liste. */
  { id:"alerts", label:"À traiter", icon:Bell, hidden:true,
    text:"Tout ce qui attend une action, groupé par nature, avec le lien vers l'écran qui la résout." },
];

/* Les destinations d'une section, et le libellé d'une destination : les vues les
   lisent ici au lieu de recopier la liste. */
const SUBS = (tabId) => (NAV.find(x => x.id === tabId)?.sub || []).map(([id, label]) => [id, label]);
const DEST = (tabId, subId) => {
  const t = NAV.find(x => x.id === tabId);
  if(!t) return null;
  if(!t.sub) return { label:t.label, text:t.text };
  const s = t.sub.find(x => x[0] === subId) || t.sub[0];
  return s ? { label:s[1], text:s[2], section:t.label } : { label:t.label, text:t.text };
};

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

/* Sélecteur de pays — visible seulement pour un compte qui n'est borné à aucun :
   bureau régional, administrateur de l'instance. Le serveur ne renvoie la liste qu'à
   ceux-là (voir `countries` dans /api/state), donc l'absence de sélecteur n'est pas
   une décision de l'interface : c'est le reflet de ce que le compte a le droit de
   voir. Un compte rattaché à un pays n'a rien à choisir.

   Le changement recharge la page. C'est volontaire, et ce n'est pas de la paresse :
   l'application garde en mémoire tout un jeu de collections — sites, plans, découpage
   administratif, libellés des niveaux — et un rafraîchissement partiel laisserait
   momentanément des données d'un pays sous le vocabulaire de l'autre. C'est
   exactement l'erreur la plus difficile à voir, et un rechargement de deux secondes
   la rend impossible. */
function PaysCourant({ db }){
  const liste = db?.countries || [];
  if(liste.length < 2) return null;
  /* Le pays retenu localement ne fait pas foi : s'il a été désactivé ou supprimé
     depuis, le serveur a servi autre chose, et c'est ce qu'il faut montrer. */
  const garde = getWorkingCountry();
  const actuel = liste.some(c => c.code === garde) ? garde : (db?.country?.code || "");
  return (
    <label className="hidden md:flex items-center gap-1.5 f115 text-white/80"
      title="Pays dans lequel vous travaillez">
      <Globe size={14} className="opacity-80" />
      <select value={actuel} aria-label="Pays"
        onChange={e => { setWorkingCountry(e.target.value); window.location.reload(); }}
        className="bg-transparent text-white f115 font-semibold border-none outline-none cursor-pointer">
        {liste.map(c => (
          <option key={c.code} value={c.code} className="text-slate-800">{c.name}</option>))}
      </select>
    </label>);
}

/* La cloche. Le décompte est celui des alertes de priorité haute : mettre le total
   ferait un nombre à trois chiffres en permanence, qu'on cesse de lire au bout d'un
   jour. Zéro alerte haute n'affiche pas de pastille — un badge « 0 » est du bruit. */
function Cloche({ db, actif, onClick }){
  const liste = alertes(db);
  const hautes = liste.filter(a => a.prio === "haute").length;
  const titre = liste.length
    ? `${liste.length} élément(s) à traiter, dont ${hautes} en priorité haute`
    : "Rien à traiter";
  return (
    <button onClick={onClick} title={titre} aria-label={titre}
      className={clsx("relative p-1.5 rounded-full transition-colors",
        actif ? "bg-white/20 text-white" : "text-white/75 hover:text-white hover:bg-white/10")}>
      <Bell size={17} />
      {hautes > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-rose-500
                         text-white f10 font-bold grid place-items-center tabular-nums">
          {hautes > 99 ? "99+" : hautes}</span>)}
    </button>);
}

/* `allowed` est calculé une seule fois par App (resolveTabs) et transmis ici :
   deux règles divergentes laissaient un compte sans aucune navigation. */
function Shell({ db, me, tab, sub, setTab, children, onLogout, sync, allowed = [] }){
  const [menu,setMenu] = useState(false);
  useEffect(()=>{ const h=()=>setMenu(false);
    window.addEventListener("click",h); return ()=>window.removeEventListener("click",h); },[]);
  const initials = (me.firstName?.[0]||"") + (me.lastName?.[0]||"");
  const sections = NAV.filter(x => !x.hidden && allowed.includes(x.id));
  const courant = NAV.find(x => x.id === tab);
  const sousDest = courant?.sub || [];
  const brut = DEST(tab, sub) || { label:"", text:"" };
  /* L'accueil s'adresse à quelqu'un : la phrase générique de NAV y est remplacée par
     le salut et la date. C'est le seul écran dont le titre dépend du lecteur. */
  const dest = tab === "home"
    ? { ...brut, text:`Bonjour ${me.firstName}. Situation consolidée du suivi au ${new Date().toLocaleDateString("fr-FR")}.` }
    : brut;

  return (
    <div className="min-h-screen flex flex-col" style={{background:C.bg}}>
      {/* ── En-tête ────────────────────────────────────────────────────
          Le signe est posé à même la barre, à sa taille lisible, suivi du seul mot
          « MEMS » et d'un filet qui sépare la marque de la navigation. L'intitulé
          complet vit dans le pied de page, où il y a la place de le lire : une marque
          n'a pas besoin de se répéter à chaque écran, elle a besoin d'être
          reconnaissable. */}
      <header className="flex items-center gap-1 px-4 h-14 text-white sticky top-0 z-40" style={{background:C.brandD}}>
        <div className="flex items-center gap-2.5 shrink-0 pr-4 mr-2 h-8 border-r border-white/20">
          <BrandMark size={30} tone="light" />
          <span className="f15 font-bold tr14">MEMS</span>
        </div>
        <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Sections">
          {sections.map(x => (
            /* Un seul geste, un seul effet : le bouton mène à la section. La barre
               du dessous s'occupe des destinations. */
            <button key={x.id} onClick={()=>setTab(x.id)}
              aria-current={tab===x.id ? "page" : undefined}
              className={clsx("flex items-center gap-1.5 px-3 h-14 f125 font-semibold whitespace-nowrap border-b-2 transition-colors",
                tab===x.id ? "border-white text-white" : "border-transparent text-white/65 hover:text-white")}>
              <x.icon size={15} className={tab===x.id ? "" : "opacity-80"} />{x.label}</button>))}
        </nav>
        <div className="ml-auto flex items-center gap-2.5 shrink-0">
          <PaysCourant db={db} />
          <SyncBadge sync={sync} />
          <Cloche db={db} actif={tab==="alerts"} onClick={()=>setTab("alerts")} />
          <div className="relative" onClick={e=>e.stopPropagation()}>
            {/* La pastille suffit à identifier le compte ; l'anneau et le fond
                translucide autour ajoutaient deux bordures sans rien dire. */}
            <button onClick={()=>setMenu(m=>!m)}
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
                {allowed.includes("settings") && (
                  <button onClick={()=>{setTab("settings");setMenu(false);}}
                    className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50">
                    <Cog size={14} /> Paramètres de l'application</button>)}
                <button onClick={onLogout} className="flex items-center gap-2 w-full px-4 py-2.5 f13 text-slate-700 hover:bg-slate-50 border-t border-slate-100">
                  <LogOut size={14} /> Se déconnecter</button>
              </div>)}
          </div>
        </div>
      </header>

      {/* ── Destinations de la section ──────────────────────────────────
          Collante sous l'en-tête : sur un tableau de six cents lignes, la
          navigation reste à portée sans remonter. Elle ne s'affiche que si la
          section a plusieurs destinations — une barre à un seul onglet n'informe de
          rien et prend une ligne. */}
      {sousDest.length > 1 && (
        <div className="sticky top-14 z-30 bg-white border-b border-slate-200 px-5 overflow-x-auto"
             aria-label={`Destinations de ${courant.label}`}>
          <div className="mw1520 mx-auto flex gap-0.5">
            {sousDest.map(([id, label]) => (
              <button key={id} onClick={()=>setTab(tab, id)}
                aria-current={sub===id ? "page" : undefined}
                className={clsx("px-3 py-2.5 f125 whitespace-nowrap border-b-2 -mb-px transition-colors",
                  sub===id ? "bd-brand c-bd font-semibold"
                           : "border-transparent text-slate-500 hover:text-slate-800")}>{label}</button>))}
          </div>
        </div>)}

      <main className="flex-1 mw1520 w-full mx-auto px-5 py-5">
        <PageHead section={dest.section} title={dest.label} text={dest.text} />
        {children}
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
    </div>);
}

/* Titre de destination. Il était à 23 px en gras, suivi d'un paragraphe à 13 px,
   au-dessus de cartes dont les titres sont à 13 px : l'écart de hiérarchie était tel
   que le titre écrasait le contenu. Ramené à 19 px, avec la phrase en 12,5 px.

   La phrase reste : elle dit à quoi sert l'écran, ce qu'aucun titre de deux mots ne
   fait. La section passe au-dessus, en petit — sans elle, huit destinations
   affichaient toutes « Suivi-évaluation » et aucune ne disait laquelle. */
const PageHead = ({ section, title, text, children }) => (
  <div className="flex items-start gap-4 flex-wrap mb-4">
    <div className="min-w-0">
      {section && <div className="f11 font-semibold uppercase tracking-wide text-slate-400 mb-0.5">{section}</div>}
      <h2 className="f19 font-semibold text-slate-900 leading-tight">{title}</h2>
      {text && <p className="f125 text-slate-500 mt-1 max-w-3xl leading-relaxed">{text}</p>}</div>
    <div className="ml-auto flex gap-2 flex-wrap">{children}</div>
  </div>);

export { SyncBadge, NAV, SUBS, DEST, PageHead, Shell };
