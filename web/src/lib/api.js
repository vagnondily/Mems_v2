/* Couche d'accès au serveur.
   Le jeton vit en mémoire ; le cookie httpOnly posé par le serveur assure la reprise
   de session après un rechargement, sans jamais exposer le jeton au code de la page. */

const BASE = import.meta.env?.VITE_API_URL || "/api";
let token = null;
let onUnauthorized = () => {};

export const setToken = (t) => { token = t; };
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, message, details){ super(message); this.status = status; this.details = details; }
}

async function call(method, path, body, opts = {}){
  const headers = { "Accept": "application/json" };
  if(body !== undefined) headers["Content-Type"] = "application/json";
  if(token) headers["Authorization"] = `Bearer ${token}`;
  let res;
  try{
    res = await fetch(BASE + path, {
      method, headers, credentials:"include",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
  }catch(e){
    throw new ApiError(0, "serveur injoignable — vérifiez votre connexion");
  }
  if(res.status === 204) return null;
  let payload = null;
  const type = res.headers.get("content-type") || "";
  if(type.includes("application/json")) { try{ payload = await res.json(); }catch(e){ payload = null; } }
  if(!res.ok){
    if(res.status === 401 && path !== "/auth/login"){ token = null; onUnauthorized(); }
    throw new ApiError(res.status, payload?.error || `erreur ${res.status}`, payload?.details);
  }
  return payload;
}

export const api = {
  get:  (p, o)    => call("GET", p, undefined, o),
  post: (p, b, o) => call("POST", p, b ?? {}, o),
  put:  (p, b, o) => call("PUT", p, b ?? {}, o),
  del:  (p, o)    => call("DELETE", p, undefined, o),

  health:      ()            => call("GET", "/health"),
  login:       (email, password) => call("POST", "/auth/login", { email, password }),
  logout:      ()            => call("POST", "/auth/logout", {}),
  me:          ()            => call("GET", "/auth/me"),
  changePassword: (current, next) => call("POST", "/auth/password", { current, next }),
  state:       ()            => call("GET", "/state"),

  createSite:  (s)           => call("POST", "/sites", s),
  updateSite:  (id, s)       => call("PUT", `/sites/${encodeURIComponent(id)}`, s),
  deleteSite:  (id)          => call("DELETE", `/sites/${encodeURIComponent(id)}`),
  saveMonth:   (id, m)       => call("PUT", `/sites/${encodeURIComponent(id)}/months`, m),
  bulkSites:   (ids, field, value) => call("POST", "/sites/bulk", { ids, field, value }),

  syncCollection: (name, rows) => call("PUT", `/collections/${encodeURIComponent(name)}`, { rows }),
  saveSettings:   (obj)        => call("PUT", "/settings", obj),
  setVisitStatus: (id, status) => call("PUT", `/visits/${encodeURIComponent(id)}/status`, { status }),

  geo:          (q="")            => call("GET", `/geo${q}`),
  geoLevels:    (q="")            => call("GET", `/geo/levels${q}`),
  geoVersions:  ()                => call("GET", "/geo/versions"),
  setGeoVersion:(id)              => call("PUT", `/geo/versions/${encodeURIComponent(id)}/current`),
  /* Un import crée un millésime complet : le serveur reconstruit l'arbre. */
  importGeo:    (rows, label, source) => call("POST", "/geo/bulk", { rows, label, source }),

  users:      ()             => call("GET", "/users"),
  createUser: (u)            => call("POST", "/users", u),
  updateUser: (id, u)        => call("PUT", `/users/${encodeURIComponent(id)}`, u),
  deleteUser: (id)           => call("DELETE", `/users/${encodeURIComponent(id)}`),

  mapPoints:  (q="")         => call("GET", `/analytics/map${q}`),
  coverage:   (q="")         => call("GET", `/analytics/coverage${q}`),
  summary:    (q="")         => call("GET", `/analytics/summary${q}`),
  audit:      (limit=100)    => call("GET", `/audit?limit=${limit}`),
};

/* File d'écriture : les collections modifiées sont poussées par lot, avec réessai.
   Une seule requête par collection est en vol à la fois : le serveur reste l'arbitre. */
export function createSyncQueue({ onStatus = () => {}, delay = 900 } = {}){
  const pending = new Map();          /* collection -> dernières lignes connues */
  const timers = new Map();
  let inflight = 0, failures = 0;

  async function flushOne(name){
    const rows = pending.get(name);
    if(rows === undefined) return;
    pending.delete(name);
    inflight++; onStatus({ state:"saving", inflight, failures });
    try{
      if(name === "settings") await api.saveSettings(rows);
      else await api.syncCollection(name, rows);
      failures = 0;
    }catch(e){
      failures++;
      onStatus({ state:"error", inflight, failures, message:e.message, collection:name });
      if(e.status >= 500 || e.status === 0){
        /* Erreur transitoire : on remet en file avec un délai croissant, plafonné. */
        if(!pending.has(name)) pending.set(name, rows);
        setTimeout(() => flushOne(name), Math.min(30000, 1500 * 2 ** Math.min(failures, 4)));
      }
      inflight--; return;
    }
    inflight--;
    onStatus({ state: inflight ? "saving" : "saved", inflight, failures });
  }

  return {
    push(name, rows){
      pending.set(name, rows);
      clearTimeout(timers.get(name));
      timers.set(name, setTimeout(() => flushOne(name), delay));
      onStatus({ state:"dirty", inflight, failures });
    },
    async flushAll(){
      for(const name of [...pending.keys()]){ clearTimeout(timers.get(name)); await flushOne(name); }
    },
    get busy(){ return inflight > 0 || pending.size > 0; },
  };
}
