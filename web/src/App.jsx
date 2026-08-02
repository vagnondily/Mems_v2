import React, { useState, useEffect, useCallback, useRef } from "react";
import { Boundary } from "./components/Boundary.jsx";
import { Toast, Btn } from "./components/ui.jsx";
import { uid } from "./lib/calc.js";
import { ACT_CATEGORIES, C, D_MMR, D_SCORING, D_ROLES, D_FORMULAS, D_WEIGHTS,
         destinationsAutorisees } from "./lib/constants.js";
import { api, setToken, setUnauthorizedHandler, createSyncQueue,
         setSandboxNotifier, subscribeSandbox, isSandbox } from "./lib/api.js";
import { Admin } from "./views/Admin.jsx";
import { Analytics } from "./views/Analytics.jsx";
import { Home } from "./views/Home.jsx";
import { Login } from "./views/Login.jsx";
import { Programme, Suivi } from "./views/Merged.jsx";
import MapView from "./views/MapView.jsx";
import { Reports } from "./views/Reports.jsx";
import { SettingsView } from "./views/Settings.jsx";
import { Shell } from "./views/Shell.jsx";

/* Collections poussées vers le serveur lorsqu'elles changent.
   Les sites et leur grille mensuelle passent par des routes dédiées : elles portent
   des règles métier — création de visite, cloisonnement par bureau — que le serveur applique. */
const SYNCED = ["params","outputs","indicators","outcomes","population","pdd",
                "reportTemplates","rationCatalog","dashboards","datasets","scripts","odkForms","settings"];

/* Réglages de configuration sans table ni route propres. Ils étaient édités à
   l'écran puis réécrits par leurs valeurs codées en dur au rechargement : la
   saisie était perdue. On les fait voyager dans la collection `settings`, la
   seule que `PUT /api/settings` persiste sous une clé quelconque. `hydrate` les
   relit de là (repli sur le défaut D_*), et `set` les y recopie quand ils
   changent — barème de priorité, matrice des rôles, formules de calcul,
   catégories d'activité et listes éditables.

   `mmr` (exigences MRE) et `outcomePlan` (calendrier de collecte) n'y sont PLUS :
   ce sont des objets de PLANIFICATION, éditables par un éditeur (S6), et ils
   voyagent par leur propre route `PUT /api/planning-config` (droit éditeur) — pas
   par le blob settings réservé à l'admin. Voir PLANNING_KEYS ci-dessous. */
const PERSISTED_SETTINGS = ["scoring","roles","formulas","actCategories","lists"];
/* Objets de planification, transportés hors settings, en droit éditeur (S6). */
const PLANNING_KEYS = ["mmr","outcomePlan"];

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

/* Les identifiants d'une collection, tels que le serveur les connaît. La projection
   `indicators` renomme la clé : on la traverse pour comparer sur le même terrain. */
const idsOf = (name, rows, db) => {
  const shaped = SHAPERS[name] ? SHAPERS[name](rows || [], db) : (rows || []);
  return new Set(shaped.map(r => r.id).filter(Boolean));
};

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
   Elle vit dans lib/constants.js, aux côtés de D_ROLES : la destination
   « Administration » suit le rôle et non la liste enregistrée, et cette nuance
   se lit mieux à côté de la matrice qu'ici. */
const resolveTabs = destinationsAutorisees;

export default function App(){
  const [db, setDb] = useState(null);
  const [me, setMe] = useState(null);
  const [tab, setTabState] = useState("home");
  const [subs, setSubs] = useState({ suivi:"summary", programme:"distribution",
    analytics:"datasets", reports:"extract", settings:"general", admin:"sessions" });
  const [toasts, setToasts] = useState([]);
  const [phase, setPhase] = useState("boot");
  const [fatal, setFatal] = useState("");
  const [sync, setSync] = useState({ state:"saved" });
  const queue = useRef(null);
  const prevDb = useRef(null);

  const notify = useCallback((text, kind="info") => {
    const id = uid("t");
    setToasts(t => [...t, { id, text, kind }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4600);
  }, []);

  useEffect(() => { setUnauthorizedHandler(() => {
    setMe(null); setDb(null); setPhase("login");
    notify("Session expirée, reconnectez-vous", "warn");
  }); }, [notify]);

  /* Mode démonstration : la couche d'accès signale chaque écriture absorbée. On
     n'en fait qu'un rappel throttlé — le sync-queue peut pousser plusieurs
     collections d'affilée, une seule bulle suffit. */
  useEffect(() => {
    let dernier = 0;
    setSandboxNotifier(() => {
      const t = performance.now();
      if(t - dernier < 3500) return;
      dernier = t;
      notify("Mode démonstration — action non enregistrée", "warn");
    });
    return () => setSandboxNotifier(null);
  }, [notify]);

  const hydrate = useCallback((state) => {
    /* Les réglages persistés priment sur les valeurs par défaut ; un compte neuf,
       qui n'a rien enregistré, retombe sur ces défauts et voit une config sensée. */
    const cfg = state.settings || {};
    const listes = cfg.lists || {};
    return {
    ...state,
    lists: {
      /* Les bureaux restent VIVANTS : ils ont leur propre écran et leurs routes
         dédiées (SetOffices), et une copie figée dans les réglages masquerait un
         bureau ajouté. Le reste des listes se persiste, faute de table à éditer. */
      offices: state.offices.map(o => o.name),
      partners: listes.partners ?? state.partners.map(p => p.name),
      modalities: listes.modalities ?? ["Espèces","Coupons","Vivres","Renforcement de capacités","Mixte"],
      poiSub: listes.poiSub ?? (state.poiSubtypes || []),
      tags: listes.tags ?? [...new Set(state.categories.map(c => c.tag))].map(t => ({
        code:t, label:(state.categories.find(c=>c.tag===t)||{}).name || t })),
    },
    actCategories: cfg.actCategories ?? (state.categories.length ? state.categories.map(c => c.name) : [...ACT_CATEGORIES]),
    /* Le référentiel canonique des activités (activity_categories), tel quel :
       nom, tag (code), domaine programme, actif, rev. C'est la source unique de
       l'écran Paramètres → Activités et du rattachement d'un indicateur de
       processus. Les reflets `lists.tags`/`actCategories` ci-dessus en dérivent. */
    activities: (state.categories || []).map(c => ({ id:c.id, name:c.name, tag:c.tag,
      programArea:c.program_area || "", active: c.active !== 0, rev:c.rev || 1 })),
    /* `weights` reste codé en dur : D_WEIGHTS n'alimente que le score hérité, que
       plus aucun écran vivant n'atteint (siteScore reçoit toujours `db`). */
    /* Fusion et non substitution : un rôle par défaut ajouté après coup (l'écran
       de supervision) doit apparaître même sur une instance qui a déjà enregistré
       sa matrice de rôles ; les personnalisations enregistrées priment. */
    roles: { ...D_ROLES, ...(cfg.roles || {}) }, weights: D_WEIGHTS, scoring: cfg.scoring || D_SCORING,
    formulas: cfg.formulas || D_FORMULAS,
    /* MRE : réglage sans table, écrit désormais par PUT /api/planning-config (droit
       éditeur) sous la clé `mmr` du même dictionnaire settings, d'où on le relit. */
    mmr: cfg.mmr || D_MMR,
    /* Le calendrier de collecte vit dans sa TABLE `outcome_plan` (lue par /state) :
       la route de planification l'y écrit, et le reflet dans settings est purgé. On
       lit donc la table, sans plus la laisser ombrer par le blob. */
    outcomePlan: state.outcomePlan || {},
    /* Le catalogue de rations (migration 031) : une collection synchronisée à part
       entière. Repli sur [] pour un serveur qui ne le sert pas encore. */
    rationCatalog: state.rationCatalog || [],
    settings: { org:"Bureau pays", unit:"Unité suivi et évaluation", logo:"", currency:"MGA",
      dateFmt:"DD/MM/YYYY", pageSize:25, syncInterval:30, notifications:true,
      odkBase:"https://odk-central.example.org", apiEnabled:false, opSize:"Large",
      /* La ration ne vit plus dans settings.rationTable (matrice) : elle est un
         CATALOGUE synchronisé à part (db.rationCatalog, chantier R). */
      ...cfg },
  }; }, []);

  const loadState = useCallback(async () => {
    const d = hydrate(await api.state());
    prevDb.current = d; setDb(d); return d;
  }, [hydrate]);

  useEffect(() => {
    queue.current = createSyncQueue({
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
  }, [notify, loadState]);

  useEffect(() => { (async () => {
    try{ await api.health(); }
    catch(e){
      setFatal("Le serveur ne répond pas. Vérifiez qu'il est démarré et que l'adresse de l'API est correcte.");
      setPhase("fatal"); return;
    }
    try{ const { user } = await api.me(); setMe(normalizeMe(user)); await loadState(); setPhase("ready"); }
    catch(e){ setPhase("login"); }
  })(); }, [loadState, notify]);

  /* Basculer le bac à sable resynchronise l'état local sur la vérité du serveur :
     en sortie, cela efface les saisies de démonstration jamais enregistrées ; en
     entrée, on repart d'un jeu réel propre. Sans compte connecté, on ne fait rien. */
  useEffect(() => subscribeSandbox(() => {
    if(!isSandbox()) notify("Mode démonstration quitté — données réelles rétablies", "ok");
    loadState().catch(()=>{});
  }), [loadState, notify]);

  /* L'écran de supervision ouvre directement sur le tableau de bord — c'est sa
     seule raison d'être (affichage mural permanent). */
  useEffect(() => { if(me?.role === "dashboard"){
    setTabState("suivi"); setSubs(s => ({ ...s, suivi:"dashboard" }));
  } }, [me?.role]);

  const onLogin = async (user, token) => {
    setToken(token); setMe(normalizeMe(user)); await loadState(); setPhase("ready");
    notify(`Bienvenue ${user.first_name}`, "ok");
  };
  const onLogout = async () => {
    try{ await queue.current?.flushAll(); await api.logout(); }catch(e){}
    setToken(null); setMe(null); setDb(null); setTabState("home"); setPhase("login");
  };

  /* Modification locale immédiate, puis envoi des seules collections réellement changées. */
  const set = useCallback((fn) => {
    setDb(prev => {
      if(!prev) return prev;
      const copy = JSON.parse(JSON.stringify(prev));
      const next = fn(copy) || copy;
      const before = prevDb.current || prev;
      /* Recopie des réglages de configuration modifiés vers `settings`, pour que la
         collection les emporte au serveur. L'écran qui édite le barème ou les
         formules n'a ainsi pas à connaître ce détail de transport. Conditionnée au
         changement réel : sans quoi une frappe sur un réglage voisin réécrirait
         `settings` entier — et rien d'inchangé ne doit voyager. */
      for(const key of PERSISTED_SETTINGS){
        if(before[key] === next[key]) continue;
        if(JSON.stringify(before[key]) === JSON.stringify(next[key])) continue;
        next.settings = { ...(next.settings || {}), [key]: next[key] };
      }
      /* La planification (MRE + calendrier) part par sa route éditeur, pas par
         settings : dès que l'un des deux change, on pousse l'ensemble courant. */
      const planChange = PLANNING_KEYS.some(k =>
        JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      if(planChange)
        queue.current?.push("planningConfig",
          { mmr: next.mmr, outcomePlan: next.outcomePlan || {} }, []);
      for(const name of SYNCED){
        if(before[name] === next[name]) continue;
        if(JSON.stringify(before[name]) === JSON.stringify(next[name])) continue;
        const shaper = SHAPERS[name];
        /* Ce que CE client a retiré, et rien d'autre. Le serveur ne déduit plus les
           suppressions : sans cela, enregistrer effaçait les lignes ajoutées entre-temps
           par un collègue, que ce client n'avait jamais reçues. */
        let deletes = [];
        if(name !== "settings" && Array.isArray(before[name]) && Array.isArray(next[name])){
          const apres = idsOf(name, next[name], next);
          deletes = [...idsOf(name, before[name], before)].filter(id => !apres.has(id));
        }
        queue.current?.push(name, shaper ? shaper(next[name], next) : next[name], deletes);
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
  const view = allowed.includes(tab) ? tab : (allowed[0] || "home");

  return (<>
    <Shell db={db} me={me} tab={view} sub={subs[view]} setTab={setTab} allowed={allowed}
           onLogout={onLogout} sync={sync} notify={notify} onMe={u=>setMe(normalizeMe(u))}>
      <Boundary reset={view + "|" + (subs[view] || "")}>
        {view==="home" && <Home db={db} me={me} go={setTab} />}
        {view==="suivi" && <Suivi db={db} set={set} me={me} sub={subs.suivi}
          setSub={setSub("suivi")} notify={notify} can={can} go={setTab} />}
        {view==="programme" && <Programme db={db} set={set} me={me} sub={subs.programme}
          setSub={setSub("programme")} notify={notify} can={can} go={setTab} />}
        {view==="map" && <MapView db={db} me={me} notify={notify} go={setTab} />}
        {/* `me` sert à l'exécution des scripts sur le serveur : elle est
            réservée au rôle `super` et non à la capacité « admin ». */}
        {view==="analytics" && <Analytics db={db} set={set} me={me} sub={subs.analytics}
          setSub={setSub("analytics")} notify={notify} can={can} />}
        {view==="reports" && <Reports db={db} set={set} sub={subs.reports}
          setSub={setSub("reports")} notify={notify} can={can} />}
        {view==="settings" && <SettingsView db={db} set={set} me={me} sub={subs.settings}
          setSub={setSub("settings")} notify={notify} can={can} reload={loadState} />}
        {view==="admin" && <Admin me={me} sub={subs.admin}
          setSub={setSub("admin")} notify={notify} />}
      </Boundary>
    </Shell>
    <Toast list={toasts} />
  </>);
}
