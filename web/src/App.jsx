import React, { useState, useEffect, useCallback, useRef } from "react";
import { Boundary } from "./components/Boundary.jsx";
import { Toast, Btn } from "./components/ui.jsx";
import { uid } from "./lib/calc.js";
import { ACT_CATEGORIES, C, D_MMR, D_SCORING, D_ROLES, D_FORMULAS, D_WEIGHTS } from "./lib/constants.js";
import { api, setToken, setUnauthorizedHandler, createSyncQueue } from "./lib/api.js";
import { ActualData } from "./views/ActualData.jsx";
import { Analytics } from "./views/Analytics.jsx";
import { Home } from "./views/Home.jsx";
import { Login } from "./views/Login.jsx";
import MapView from "./views/MapView.jsx";
import { Planning } from "./views/Planning.jsx";
import { Reports } from "./views/Reports.jsx";
import { SettingsView } from "./views/Settings.jsx";
import { Shell } from "./views/Shell.jsx";

/* Collections poussées vers le serveur lorsqu'elles changent.
   Les sites et leur grille mensuelle passent par des routes dédiées : elles portent
   des règles métier — création de visite, cloisonnement par bureau — que le serveur applique. */
const SYNCED = ["params","outputs","indicators","outcomes","population","pdd",
                "reportTemplates","dashboards","datasets","scripts","odkForms","settings"];

const SHAPERS = {
  outputs: (rows, db) => rows.map(o => ({ ...o, year: db.year })),
  outcomes: (rows, db) => rows.map(o => ({
    id:o.id, indicator_id: o.indicator_id || (db.indicators.find(i=>i.id===o.indicator)||{}).key,
    adm1:o.adm1, round_label:o.round, planned:o.planned, value:o.value,
    collected_at:o.date, sample:o.sample })).filter(o => o.indicator_id),
  indicators: (rows) => rows.map(i => ({ id:i.key, code:i.id, name:i.name, basket:i.basket,
    unit:i.unit, target:i.target, direction:i.dir, method:i.method, frequency:i.freq })),
  params: (rows) => rows.map(p => ({ id:p.id, csp:p.csp, office_id:p.office_id,
    category_id:p.category_id, tag:p.tag, duration:p.duration,
    riskLevel:p.riskLevel, feasiblePerMonth:p.feasiblePerMonth })).filter(p => p.office_id),
  pdd: (rows, db) => rows.map(p => ({ ...p, year: p.year || db.year })),
};

export default function App(){
  const [db, setDb] = useState(null);
  const [me, setMe] = useState(null);
  const [tab, setTabState] = useState("home");
  const [subs, setSubs] = useState({ planning:"overreaching", actual:"summary",
    analytics:"datasets", reports:"extract", settings:"general" });
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

  useEffect(() => {
    queue.current = createSyncQueue({ onStatus: (s) => {
      setSync(s);
      if(s.state === "error" && s.failures >= 3)
        notify(`Enregistrement impossible (${s.collection}) : ${s.message}`, "err");
    }});
  }, [notify]);

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
      ...(state.settings || {}) },
  }), []);

  const loadState = useCallback(async () => {
    const d = hydrate(await api.state());
    prevDb.current = d; setDb(d); return d;
  }, [hydrate]);

  useEffect(() => { (async () => {
    try{ await api.health(); }
    catch(e){
      setFatal("Le serveur ne répond pas. Vérifiez qu'il est démarré et que l'adresse de l'API est correcte.");
      setPhase("fatal"); return;
    }
    try{ const { user } = await api.me(); setMe(user); await loadState(); setPhase("ready"); }
    catch(e){ setPhase("login"); }
  })(); }, [loadState]);

  const onLogin = async (user, token) => {
    setToken(token); setMe(user); await loadState(); setPhase("ready");
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
        queue.current?.push(name, shaper ? shaper(next[name], next) : next[name]);
      }
      prevDb.current = next;
      return next;
    });
  }, []);

  const setTab = (t, s) => { setTabState(t); if(s) setSubs(x => ({ ...x, [t]:s })); };
  const setSub = (t) => (s) => setSubs(x => ({ ...x, [t]:s }));
  const can = useCallback((f) => {
    if(!me) return false;
    const caps = { super:{edit:1,del:1,validate:1,admin:1}, admin:{edit:1,del:1,validate:1,admin:1},
      validator:{edit:1,validate:1}, editor:{edit:1}, viewer:{} }[me.role] || {};
    return !!caps[f];
  }, [me]);

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

  const allowed = (me.tabs && me.tabs.length) ? me.tabs
    : ["home","planning","actual","analytics","reports"];
  const view = allowed.includes(tab) ? tab : (allowed[0] || "home");

  return (<>
    <Shell db={db} me={me} tab={view} sub={subs[view]} setTab={setTab}
           onLogout={onLogout} sync={sync} notify={notify}>
      <Boundary reset={view + "|" + (subs[view] || "")}>
        {view==="home" && <Home db={db} me={me} go={setTab} />}
        {view==="planning" && <Planning db={db} set={set} me={me} sub={subs.planning}
          setSub={setSub("planning")} notify={notify} can={can} />}
        {view==="actual" && (subs.actual === "map"
          ? <MapView db={db} me={me} notify={notify} go={setTab} />
          : <ActualData db={db} set={set} me={me} sub={subs.actual}
              setSub={setSub("actual")} notify={notify} can={can} go={setTab} />)}
        {view==="analytics" && <Analytics db={db} set={set} sub={subs.analytics}
          setSub={setSub("analytics")} notify={notify} can={can} />}
        {view==="reports" && <Reports db={db} set={set} sub={subs.reports}
          setSub={setSub("reports")} notify={notify} can={can} />}
        {view==="settings" && <SettingsView db={db} set={set} me={me} sub={subs.settings}
          setSub={setSub("settings")} notify={notify} can={can} />}
      </Boundary>
    </Shell>
    <Toast list={toasts} />
  </>);
}
