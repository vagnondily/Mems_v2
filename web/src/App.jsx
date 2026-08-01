import React, { useState, useEffect, useCallback, useRef } from "react";
import { Boundary } from "./components/Boundary.jsx";
import { Toast, Btn } from "./components/ui.jsx";
import { uid } from "./lib/calc.js";
import { ACT_CATEGORIES, C, D_MMR, D_SCORING, D_ROLES, D_FORMULAS, D_WEIGHTS,
         destinationsAutorisees } from "./lib/constants.js";
import { api, setToken, setUnauthorizedHandler, createSyncQueue } from "./lib/api.js";
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
                "reportTemplates","dashboards","datasets","scripts","odkForms","settings"];

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

  const hydrate = useCallback((state) => ({
    ...state,
    lists: {
      offices: state.offices.map(o => o.name),
      partners: state.partners.map(p => p.name),
      modalities: ["Espèces","Coupons","Vivres","Renforcement de capacités","Mixte"],
      poiSub: state.poiSubtypes || [],
      tags: [...new Set(state.categories.map(c => c.tag))].map(t => ({
        code:t, label:(state.categories.find(c=>c.tag===t)||{}).name || t })),
    },
    actCategories: state.categories.length ? state.categories.map(c => c.name) : [...ACT_CATEGORIES],
    roles: D_ROLES, weights: D_WEIGHTS, scoring: D_SCORING, formulas: D_FORMULAS, mmr: D_MMR,
    settings: { org:"Bureau pays", unit:"Unité suivi et évaluation", logo:"", currency:"MGA",
      dateFmt:"DD/MM/YYYY", pageSize:25, syncInterval:30, notifications:true,
      odkBase:"https://odk-central.example.org", apiEnabled:false, opSize:"Large",
      /* Vide par défaut, à dessein : la ration réelle par denrée est une donnée de
         programme, propre à chaque opération — personne ne la devine à sa place. */
      rationTable:{},
      ...(state.settings || {}) },
  }), []);

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
           onLogout={onLogout} sync={sync} notify={notify}>
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
