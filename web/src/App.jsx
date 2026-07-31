import React, { useState, useEffect, useCallback, useRef } from "react";
import { Boundary } from "./components/Boundary.jsx";
import { Toast, Btn } from "./components/ui.jsx";
import { uid } from "./lib/calc.js";
import { ACT_CATEGORIES, C, D_MMR, D_SCORING, D_ROLES, D_FORMULAS, D_WEIGHTS } from "./lib/constants.js";
import { api, setToken, setUnauthorizedHandler, setWorkingCountry, createSyncQueue } from "./lib/api.js";
import Alerts from "./views/Alerts.jsx";
import { Analytics } from "./views/Analytics.jsx";
import { Home } from "./views/Home.jsx";
import { Login } from "./views/Login.jsx";
import { Programme, Suivi } from "./views/Merged.jsx";
import { Reports } from "./views/Reports.jsx";
import { SettingsView } from "./views/Settings.jsx";
import { Shell } from "./views/Shell.jsx";

/* Collections poussées vers le serveur lorsqu'elles changent.
   Les sites et leur grille mensuelle passent par des routes dédiées : elles portent
   des règles métier — création de visite, cloisonnement par bureau — que le serveur applique. */
const SYNCED = ["params","outputs","indicators","outcomes","population","pdd",
                "reportTemplates","dashboards","datasets","scripts","odkForms",
                "activityCategories","poiSubtypes","settings"];

/* Les projections vers le serveur conservent `rev` : c'est la révision lue, que le
   serveur compare à la sienne pour détecter qu'un collègue a modifié la même ligne. */
const SHAPERS = {
  outputs: (rows, db) => rows.map(o => ({ ...o, year: db.year })),
  outcomes: (rows, db) => rows.map(o => ({
    id:o.id, rev:o.rev,
    indicator_id: o.indicator_id || (db.indicators.find(i=>i.id===o.indicator)||{}).key,
    adm1:o.adm1, round_label:o.round, planned:o.planned, value:o.value,
    collected_at:o.date, sample:o.sample })).filter(o => o.indicator_id),
  indicators: (rows) => rows.map(i => ({ id:i.key, rev:i.rev, code:i.id, name:i.name,
    basket:i.basket, unit:i.unit, target:i.target, direction:i.dir,
    method:i.method, frequency:i.freq })),
  params: (rows) => rows.map(p => ({ id:p.id, rev:p.rev, csp:p.csp, office_id:p.office_id,
    category_id:p.category_id, tag:p.tag, duration:p.duration,
    riskLevel:p.riskLevel, feasiblePerMonth:p.feasiblePerMonth })).filter(p => p.office_id),
  pdd: (rows, db) => rows.map(p => ({ ...p, year: p.year || db.year })),
};

/* Ce que l'interface lit partout, dérivé de ce que le serveur détient.

   `lists.tags` et `actCategories` sont deux vues des CATÉGORIES D'ACTIVITÉ, et
   `lists.offices`/`lists.partners` des vues des bureaux et des partenaires. Elles
   étaient calculées une seule fois, au chargement, puis modifiées sur place par
   l'écran de configuration — qui croyait ainsi tenir la liste alors qu'il n'écrivait
   que dans la projection. Rien ne repartait vers le serveur : la catégorie ajoutée
   disparaissait au rechargement suivant, sans message.

   On les recalcule donc à chaque modification, à partir de la source. Ce sont des
   vues : on ne les édite pas, on édite ce dont elles découlent. */
function projeter(d){
  const cats = (d.activityCategories || []).filter(c => c && c.name);
  const actifs = cats.filter(c => c.active !== 0 && c.active !== false);
  const tags = [];
  for(const c of (actifs.length ? actifs : cats)){
    if(!c.tag || tags.some(t => t.code === c.tag)) continue;
    tags.push({ code:c.tag, label:c.name });
  }
  return { ...d,
    lists: {
      offices: (d.offices || []).map(o => o.name),
      partners: (d.partners || []).map(p => p.name),
      poiSub: d.poiSubtypes || [],
      tags,
    },
    actCategories: cats.length ? cats.map(c => c.name) : [...ACT_CATEGORIES],
    /* `categories` est le nom sous lequel le serveur les rend et sous lequel plusieurs
       écrans les lisent encore. Un seul contenu, deux noms : sans cette ligne, ajouter
       une catégorie ne la rendait pas trouvable là où le rattachement d'un site la
       cherche. */
    categories: d.activityCategories || [],
  };
}

/* Une ligne qu'on vient d'ajouter est vide le temps qu'on la remplisse. L'envoyer
   ferait refuser TOUT le lot par le serveur — nom trop court, code manquant — et la
   liste entière cesserait de s'enregistrer sans qu'on comprenne pourquoi. On garde
   donc la ligne à l'écran et on ne l'envoie qu'une fois renseignée. */
const COMPLET = {
  activityCategories: (c) => (c.name || "").trim().length >= 2 && !!(c.tag || "").trim(),
  poiSubtypes: (p) => (p.label || "").trim().length >= 1,
};

/* Ce qui part réellement dans les réglages. Le barème de priorité, les formules de
   couverture et les coefficients trimestriels n'ont pas de table à eux : ils vivent
   dans le dictionnaire clé-valeur. L'interface les lit à la racine parce que tout le
   code de calcul les y attend ; la conversion se fait ici, dans les deux sens (voir
   `hydrate` pour l'autre). */
const chargeReglages = (d) => ({ ...(d.settings || {}),
  scoring:d.scoring, formulas:d.formulas, mmr:d.mmr });

/* Le champ qui porte l'identifiant CÔTÉ SERVEUR dans les lignes locales. Il coïncide
   partout avec `id`, sauf pour les indicateurs : l'écran les désigne par leur code
   (« OUT-1 »), et la clé technique vit dans `key`. */
const REV_KEY = { indicators: "key" };

/* Les identifiants d'une collection, tels que le serveur les connaît. La projection
   `indicators` renomme la clé : on la traverse pour comparer sur le même terrain. */
const idsOf = (name, rows, db) => {
  const shaped = SHAPERS[name] ? SHAPERS[name](rows || [], db) : (rows || []);
  return new Set(shaped.map(r => r.id).filter(Boolean));
};

const DEV_ADMIN_CREDENTIALS = import.meta.env?.DEV ? {
  email: "admin@mems.local",
  password: "MemsAdmin2026",
} : null;

/* Le serveur parle snake_case, l'interface camelCase. Un seul point de conversion :
   sans lui, me.firstName et me.office sont undefined partout (« Bonjour undefined »,
   avatar « ? », cloisonnement d'interface inopérant). */
const normalizeMe = (u) => u && ({
  ...u,
  firstName: u.first_name || "",
  lastName:  u.last_name  || "",
  title:     u.title      || "",
  office:    u.office     || "",
  tabs: Array.isArray(u.tabs) ? u.tabs : [],
});

/* Onglets autorisés : une seule règle, partagée par App et par la coquille.
   `tabs` vaut [] par défaut côté serveur ; il faut donc retomber sur le rôle,
   sinon un compte se retrouve avec une navigation vide. */
const resolveTabs = (u) =>
  (u?.tabs?.length ? u.tabs : D_ROLES[u?.role]?.tabs) || ["home"];

/* Destinations atteignables sans figurer dans la barre de sections : la liste « à
   traiter », ouverte par la cloche. Elle ne montre que ce que le compte voit déjà
   ailleurs — la retirer à quelqu'un ne protégerait rien et lui cacherait ses propres
   échéances. Les paramètres, eux, restent gouvernés par le rôle. */
const HORS_NAV = ["alerts"];

export default function App(){
  const [db, setDb] = useState(null);
  const [me, setMe] = useState(null);
  const [tab, setTabState] = useState("home");
  const [subs, setSubs] = useState({ suivi:"summary", programme:"distribution",
    analytics:"datasets", reports:"extract", settings:"general" });
  const [toasts, setToasts] = useState([]);
  const [phase, setPhase] = useState("boot");
  const [fatal, setFatal] = useState("");
  const [sync, setSync] = useState({ state:"saved" });
  /* L'exercice affiché. Il s'ouvre sur l'année en cours et n'est pas conservé d'une
     session à l'autre : au 1er janvier, on doit retrouver la nouvelle année sans
     avoir à y penser — c'est précisément ce que « par défaut » veut dire ici. */
  const [annee, setAnneeState] = useState(() => new Date().getFullYear());
  const queue = useRef(null);
  const prevDb = useRef(null);

  const notify = useCallback((text, kind="info") => {
    const id = uid("t");
    setToasts(t => [...t, { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4600);
  }, []);

  /* Un 401 ne veut pas toujours dire « session expirée ».

     Au tout premier chargement, l'application demande /auth/me pour savoir si un
     cookie de session traîne. Sans session — le cas de quiconque ouvre l'adresse
     pour la première fois — le serveur répond 401, ce qui est la réponse NORMALE, et
     l'écran de connexion s'affichait accompagné de « Session expirée,
     reconnectez-vous ». C'est faux et inquiétant : rien n'a expiré, et l'on croit
     avoir perdu quelque chose avant même d'avoir commencé.

     Le message n'est donc dit que si une session avait bel et bien été ouverte. */
  const connecte = useRef(false);
  useEffect(() => { setUnauthorizedHandler(() => {
    const avaitUneSession = connecte.current;
    connecte.current = false;
    setMe(null); setDb(null); setPhase("login");
    if(avaitUneSession) notify("Session expirée, reconnectez-vous", "warn");
  }); }, [notify]);

  const hydrate = useCallback((state) => {
    const reglages = { org:"Bureau pays", unit:"Unité suivi et évaluation", logo:"", currency:"MGA",
      dateFmt:"DD/MM/YYYY", pageSize:25, syncInterval:30, notifications:true,
      odkBase:"https://odk-central.example.org", apiEnabled:false, opSize:"Large",
      ...(state.settings || {}) };
    /* Les trois réglages de calcul sont conservés dans le dictionnaire des réglages —
       ils n'ont pas de table à eux — mais l'interface les lit à la racine, où tout le
       code les attend. On les en détache ici pour n'avoir qu'un seul exemplaire. */
    const detache = (cle, defaut) => {
      const v = reglages[cle]; delete reglages[cle];
      const rempli = Array.isArray(v) ? v.length : (v && typeof v === "object" && Object.keys(v).length);
      return rempli ? v : JSON.parse(JSON.stringify(defaut));
    };
    return projeter({
      ...state,
      /* Les catégories d'activité et les sous-types de point d'intérêt portent leur
         propre nom, comme les collections qu'ils sont désormais. `lists` n'en garde que
         la projection d'affichage, recalculée à chaque modification. */
      activityCategories: state.categories || [],
      poiSubtypes: state.poiSubtypes || [],
      /* La matrice des rôles n'est pas conservée : le serveur en tient une, seule
         faisant foi. Celle-ci ne sert qu'à masquer ce qu'il refuserait. */
      roles: D_ROLES, weights: D_WEIGHTS,
      scoring: detache("scoring", D_SCORING),
      formulas: detache("formulas", D_FORMULAS),
      mmr: detache("mmr", D_MMR),
      settings: reglages,
    });
  }, []);

  const loadState = useCallback(async (an) => {
    const d = hydrate(await api.state(an ?? annee));
    prevDb.current = d; setDb(d); return d;
  }, [hydrate, annee]);

  /* Changer d'exercice relit l'état : les collections datées — grille mensuelle,
     outputs, plan de distribution, plan de collecte — sont celles de cette année-là.
     La file d'écriture est vidée AVANT, sinon une saisie encore en vol partirait
     étiquetée de l'année qu'on vient de quitter. */
  const setAnnee = useCallback(async (an) => {
    if(an === annee) return;
    try{ await queue.current?.flushAll(); }catch(e){}
    setAnneeState(an);
    try{ await loadState(an); }
    catch(e){ notify("Impossible de charger l'exercice " + an, "err"); }
  }, [annee, loadState, notify]);

  /* Après un enregistrement réussi, le serveur rend les révisions telles qu'elles sont
     désormais. On les recopie dans l'état local, et dans la référence de comparaison
     du même mouvement : sans le second, la prochaine modification renverrait la
     collection entière au seul motif que ces jetons ont changé — et sans le premier,
     le prochain enregistrement de la même ligne serait rejeté comme un conflit avec
     soi-même, ce qui rendait toute deuxième correction impossible sans recharger. */
  const appliquerRevisions = useCallback((name, revisions) => {
    if(!revisions || !Object.keys(revisions).length) return;
    const cle = REV_KEY[name] || "id";
    setDb(prev => {
      if(!prev || !Array.isArray(prev[name])) return prev;
      let change = false;
      const lignes = prev[name].map(r => {
        const v = revisions[r[cle]];
        if(v === undefined || r.rev === v) return r;
        change = true; return { ...r, rev:v };
      });
      if(!change) return prev;
      if(prevDb.current) prevDb.current = { ...prevDb.current, [name]:lignes };
      return { ...prev, [name]:lignes };
    });
  }, []);

  useEffect(() => {
    queue.current = createSyncQueue({
      onSaved: appliquerRevisions,
      onStatus: (s) => {
        setSync(s);
        if(s.state === "error" && s.failures >= 3)
          notify(`Enregistrement impossible (${s.collection}) : ${s.message}`, "err");
      },
      /* Écriture concurrente : insister écraserait le travail de l'autre. On prévient
         et on repart de la version à jour. */
      onConflict: async (name, message) => {
        notify(message || "Cette donnée a été modifiée par ailleurs — rechargement", "warn");
        try{ await loadState(); }catch(e){}
      },
    });
  }, [notify, loadState, appliquerRevisions]);

  useEffect(() => { (async () => {
    try{ await api.health(); }
    catch(e){
      setFatal("Le serveur ne répond pas. Vérifiez qu'il est démarré et que l'adresse de l'API est correcte.");
      setPhase("fatal"); return;
    }
    try{ const { user } = await api.me(); setMe(normalizeMe(user)); connecte.current = true;
         await loadState(); setPhase("ready"); }
    catch(e){
      if(DEV_ADMIN_CREDENTIALS){
        try{
          const r = await api.login(DEV_ADMIN_CREDENTIALS.email, DEV_ADMIN_CREDENTIALS.password);
          setToken(r.token); setMe(normalizeMe(r.user)); connecte.current = true;
          await loadState(); setPhase("ready");
          notify(`Bienvenue ${r.user.first_name}`, "ok");
          return;
        }catch(loginError){}
      }
      setPhase("login");
    }
  })(); }, [loadState, notify]);

  const onLogin = async (user, token) => {
    setToken(token); setMe(normalizeMe(user)); connecte.current = true;
    await loadState(); setPhase("ready");
    notify(`Bienvenue ${user.first_name}`, "ok");
  };
  const onLogout = async () => {
    try{ await queue.current?.flushAll(); await api.logout(); }catch(e){}
    /* Le pays de travail est oublié à la déconnexion : le poste peut être partagé, et
       le compte suivant n'a pas à hériter du pays choisi par le précédent — le serveur
       l'ignorerait s'il est borné, mais un autre compte non borné le reprendrait. */
    setWorkingCountry(null);
    connecte.current = false;
    setToken(null); setMe(null); setDb(null); setTabState("home"); setPhase("login");
  };

  /* Modification locale immédiate, puis envoi des seules collections réellement changées. */
  const set = useCallback((fn) => {
    setDb(prev => {
      if(!prev) return prev;
      const copy = JSON.parse(JSON.stringify(prev));
      /* Les vues sont recalculées ici, et nulle part ailleurs : ajouter une catégorie
         doit rafraîchir les listes déroulantes qui en découlent dans le même geste. */
      const next = projeter(fn(copy) || copy);
      const before = prevDb.current || prev;
      for(const name of SYNCED){
        /* Les réglages partent avec les trois blocs de calcul qui y sont conservés :
           barème de priorité, formules de couverture et coefficients trimestriels.
           Ils s'éditaient déjà et ne repartaient nulle part — modifier une formule,
           recharger, et retrouver la formule d'origine, sans un message. */
        const avant = name === "settings" ? chargeReglages(before) : before[name];
        const apresVal = name === "settings" ? chargeReglages(next) : next[name];
        if(avant === apresVal) continue;
        if(JSON.stringify(avant) === JSON.stringify(apresVal)) continue;
        if(name === "settings"){ queue.current?.push(name, apresVal, []); continue; }
        const shaper = SHAPERS[name];
        /* Ce que CE client a retiré, et rien d'autre. Le serveur ne déduit plus les
           suppressions : sans cela, enregistrer effaçait les lignes ajoutées entre-temps
           par un collègue, que ce client n'avait jamais reçues. */
        let deletes = [];
        if(name !== "settings" && Array.isArray(before[name]) && Array.isArray(next[name])){
          const apres = idsOf(name, next[name], next);
          deletes = [...idsOf(name, before[name], before)].filter(id => !apres.has(id));
        }
        /* Les suppressions, elles, se calculent sur la liste ENTIÈRE : une ligne
           incomplète n'est pas une ligne retirée, et l'exclure des deux côtés évite
           de supprimer sur le serveur ce que quelqu'un est en train d'écrire. */
        const charge = shaper ? shaper(next[name], next) : next[name];
        queue.current?.push(name,
          COMPLET[name] ? charge.filter(COMPLET[name]) : charge, deletes);
      }
      prevDb.current = next;
      return next;
    });
  }, []);

  const setTab = (t, s) => { setTabState(t); if(s) setSubs(x => ({ ...x, [t]:s })); };
  const setSub = (t) => (s) => setSubs(x => ({ ...x, [t]:s }));
  /* Une seule matrice de droits côté client (D_ROLES), alignée sur celle du serveur.
     Le serveur reste l'arbitre : ceci ne fait que masquer ce qu'il refuserait. */
  const can = useCallback((f) => !!D_ROLES[me?.role]?.[f], [me]);

  useEffect(() => {
    const h = (e) => { if(queue.current?.busy){ e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  if(phase === "fatal") return (
    <div className="min-h-screen grid place-items-center p-6" style={{ background:C.bg }}>
      <div className="max-w-md w-full bg-white border border-rose-200 rounded p-6">
        <h1 className="f17 font-semibold text-rose-800 mb-2">MEMS ne peut pas démarrer</h1>
        <p className="f13 text-slate-600 leading-relaxed mb-4">{fatal}</p>
        <Btn onClick={() => window.location.reload()}>Réessayer</Btn>
      </div>
    </div>);

  if(phase === "boot") return (
    <div className="min-h-screen grid place-items-center" style={{ background:C.bg }}>
      <div className="text-center">
        <div className="w-12 h-12 rounded-full bd3 border-slate-200 bdt-brand animate-spin mx-auto mb-4" />
        <div className="f13 text-slate-500">Chargement de MEMS…</div></div>
    </div>);

  if(phase === "login" || !me || !db) return (<>
    <Login onLogin={onLogin} notify={notify} />
    <Toast list={toasts} />
  </>);

  const allowed = resolveTabs(me);
  const view = (allowed.includes(tab) || HORS_NAV.includes(tab)) ? tab : (allowed[0] || "home");

  return (<>
    <Shell db={db} me={me} tab={view} sub={subs[view]} setTab={setTab} allowed={allowed}
           onLogout={onLogout} sync={sync} notify={notify}
           annee={annee} setAnnee={setAnnee}>
      <Boundary reset={view + "|" + (subs[view] || "")}>
        {view==="home" && <Home db={db} me={me} go={setTab} />}
        {view==="alerts" && <Alerts db={db} go={setTab} />}
        {view==="suivi" && <Suivi db={db} set={set} me={me} sub={subs.suivi}
          setSub={setSub("suivi")} notify={notify} can={can} go={setTab} />}
        {view==="programme" && <Programme db={db} set={set} me={me} sub={subs.programme} reload={loadState}
          setSub={setSub("programme")} notify={notify} can={can} go={setTab} />}
        {view==="analytics" && <Analytics db={db} set={set} sub={subs.analytics}
          setSub={setSub("analytics")} notify={notify} can={can} />}
        {view==="reports" && <Reports db={db} set={set} sub={subs.reports}
          setSub={setSub("reports")} notify={notify} can={can} />}
        {view==="settings" && <SettingsView db={db} set={set} me={me} sub={subs.settings}
          setSub={setSub("settings")} notify={notify} can={can} reload={loadState} go={setTab} />}
      </Boundary>
    </Shell>
    <Toast list={toasts} />
  </>);
}
