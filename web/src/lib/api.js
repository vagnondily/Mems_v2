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

/* Le modèle Excel est un binaire : il ne passe pas par `call`, qui attend du JSON. */
async function fetchBlob(path){
  const headers = {};
  if(token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { headers, credentials:"include" });
  if(!res.ok){
    let msg = `erreur ${res.status}`;
    try{ const j = await res.json(); msg = j.error || msg; }catch(e){}
    throw new ApiError(res.status, msg);
  }
  return res.blob();
}
/* Téléversement multipart : le Content-Type est posé par le navigateur, avec sa frontière. */
async function postFile(path, file, field = "file"){
  const headers = {};
  if(token) headers["Authorization"] = `Bearer ${token}`;
  const body = new FormData(); body.append(field, file, file.name);
  const res = await fetch(BASE + path, { method:"POST", headers, credentials:"include", body });
  let payload = null;
  try{ payload = await res.json(); }catch(e){}
  if(!res.ok) throw new ApiError(res.status, payload?.error || `erreur ${res.status}`, payload?.details);
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

  /* Les suppressions sont explicites : le serveur ne déduit plus ce qui manque. */
  syncCollection: (name, rows, deletes = []) =>
    call("PUT", `/collections/${encodeURIComponent(name)}`, { rows, deletes }),
  saveSettings:   (obj)        => call("PUT", "/settings", obj),
  setVisitStatus: (id, status) => call("PUT", `/visits/${encodeURIComponent(id)}/status`, { status }),

  geo:          (q="")            => call("GET", `/geo${q}`),
  geoLevels:    (q="")            => call("GET", `/geo/levels${q}`),
  geoVersions:  ()                => call("GET", "/geo/versions"),
  geoCoverage:  (q="")            => call("GET", `/geo/coverage${q}`),
  geoScope:     ()                => call("GET", "/geo/scope"),
  setGeoScope:  (officeId, pcodes)=> call("PUT", `/geo/scope/${encodeURIComponent(officeId)}`, { pcodes }),
  caseload:     (q="")            => call("GET", `/caseload${q}`),
  caseloadTags: (year)            => call("GET", `/caseload/tags?year=${year}`),
  saveCaseload: (rows)            => call("PUT", "/caseload", { rows }),

  importKinds:    ()              => call("GET", "/import/kinds"),
  importTemplate: (kind, year)    => fetchBlob(`/import/${encodeURIComponent(kind)}/template?year=${year}`),
  importUpload:   (kind, file)    => postFile(`/import/${encodeURIComponent(kind)}`, file),
  importBatches:  ()              => call("GET", "/import/batches"),
  importBatch:    (id)            => call("GET", `/import/batches/${encodeURIComponent(id)}`),
  importCommit:   (id)            => call("POST", `/import/batches/${encodeURIComponent(id)}/commit`, {}),
  importCancel:   (id)            => call("POST", `/import/batches/${encodeURIComponent(id)}/cancel`, {}),
  setGeoVersion:(id)              => call("PUT", `/geo/versions/${encodeURIComponent(id)}/current`),
  /* Un import crée un millésime complet : le serveur reconstruit l'arbre. */
  importGeo:    (rows, label, source) => call("POST", "/geo/bulk", { rows, label, source }),

  mre:          (q="")       => call("GET", `/mre${q}`),
  createMre:    (a)          => call("POST", "/mre", a),
  updateMre:    (id, a)      => call("PUT", `/mre/${encodeURIComponent(id)}`, a),
  deleteMre:    (id)         => call("DELETE", `/mre/${encodeURIComponent(id)}`),
  /* Le budget est enregistré en bloc pour une activité, avec sa révision :
     l'unité d'édition est l'activité, pas la ligne de coût. */
  saveMreCosts: (id, rev, lines) => call("PUT", `/mre/${encodeURIComponent(id)}/costs`, { rev, lines }),

  offices:      ()           => call("GET", "/offices"),
  createOffice: (o)          => call("POST", "/offices", o),
  updateOffice: (id, o)      => call("PUT", `/offices/${encodeURIComponent(id)}`, o),
  deleteOffice: (id)         => call("DELETE", `/offices/${encodeURIComponent(id)}`),

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
export function createSyncQueue({ onStatus = () => {}, onConflict = null, delay = 900 } = {}){
  const pending = new Map();          /* collection -> { rows, deletes } */
  const timers = new Map();
  let inflight = 0, failures = 0;

  async function flushOne(name){
    const job = pending.get(name);
    if(job === undefined) return;
    pending.delete(name);
    inflight++; onStatus({ state:"saving", inflight, failures });
    try{
      if(name === "settings") await api.saveSettings(job.rows);
      else await api.syncCollection(name, job.rows, job.deletes);
      failures = 0;
    }catch(e){
      /* 409 : quelqu'un d'autre a modifié la même ligne. Réessayer écraserait son
         travail — on remonte le conflit pour que l'appelant recharge, et on n'insiste pas. */
      if(e.status === 409){
        inflight--;
        onStatus({ state: inflight ? "saving" : "saved", inflight, failures:0 });
        if(onConflict) onConflict(name, e.message, e.details);
        return;
      }
      failures++;
      onStatus({ state:"error", inflight, failures, message:e.message, collection:name });
      if(e.status >= 500 || e.status === 0){
        /* Erreur transitoire : on remet en file avec un délai croissant, plafonné. */
        if(!pending.has(name)) pending.set(name, job);
        setTimeout(() => flushOne(name), Math.min(30000, 1500 * 2 ** Math.min(failures, 4)));
      }
      inflight--; return;
    }
    inflight--;
    onStatus({ state: inflight ? "saving" : "saved", inflight, failures });
  }

  return {
    push(name, rows, deletes = []){
      /* Une écriture chassée par une autre avant son envoi ne doit pas perdre les
         suppressions déjà demandées : on les cumule. */
      const prev = pending.get(name);
      const cumul = prev ? [...new Set([...prev.deletes, ...deletes])] : deletes;
      pending.set(name, { rows, deletes: cumul });
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
