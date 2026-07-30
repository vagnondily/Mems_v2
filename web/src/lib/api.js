/* Couche d'accès au serveur.
   Le jeton vit en mémoire ; le cookie httpOnly posé par le serveur assure la reprise
   de session après un rechargement, sans jamais exposer le jeton au code de la page. */

const BASE = import.meta.env?.VITE_API_URL || "/api";
let token = null;
let onUnauthorized = () => {};

/* Le pays dans lequel un compte NON borné travaille.

   Il part sur chaque appel dans `X-MEMS-Country`. Il est ignoré par le serveur pour
   un compte borné à un pays — la garde est là-bas, pas ici : un contrôle qui ne vit
   que dans le navigateur n'en est pas un.

   Conservé dans `localStorage` pour survivre à un rechargement : sans cela, un
   administrateur régional se retrouverait dans le pays par défaut de l'instance à
   chaque F5, et croirait ses données perdues. */
const CLE_PAYS = "mems.pays";
let pays = null;
try{ pays = localStorage.getItem(CLE_PAYS) || null; }catch(e){ pays = null; }

export const setToken = (t) => { token = t; };
export const getWorkingCountry = () => pays;
export const setWorkingCountry = (code) => {
  pays = code || null;
  try{ code ? localStorage.setItem(CLE_PAYS, code) : localStorage.removeItem(CLE_PAYS); }catch(e){}
};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(status, message, details){ super(message); this.status = status; this.details = details; }
}

async function call(method, path, body, opts = {}){
  const headers = { "Accept": "application/json" };
  if(body !== undefined) headers["Content-Type"] = "application/json";
  if(token) headers["Authorization"] = `Bearer ${token}`;
  if(pays) headers["X-MEMS-Country"] = pays;
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
  if(pays) headers["X-MEMS-Country"] = pays;
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
  if(pays) headers["X-MEMS-Country"] = pays;
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
  /* `pays` place l'appel dans un autre pays que celui où l'on travaille : c'est ce
     qui permet de configurer le découpage du pays B depuis l'écran de configuration
     sans quitter le pays A. Le serveur l'ignore pour un compte borné à un pays —
     la garde est là-bas, pas ici. */
  geoVersions:  (pays)            => call("GET", `/geo/versions${pays?`?country=${encodeURIComponent(pays)}`:""}`),
  geoCoverage:  (q="")            => call("GET", `/geo/coverage${q}`),
  geoScope:     ()                => call("GET", "/geo/scope"),
  /* Rattachement par les coordonnées : on demande les propositions, on applique
     ensuite ce qui a été retenu. */
  geoLocate:    (lat, lon)        => call("POST", "/geo/locate", { lat, lon }),
  geoOrphans:   (q="")            => call("GET", `/geo/orphans${q}`),
  geoAttach:    (body)            => call("POST", "/geo/attach", body),
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
  setGeoVersion:(id, pays)        => call("PUT", `/geo/versions/${encodeURIComponent(id)}/current${pays?`?country=${encodeURIComponent(pays)}`:""}`),
  /* Un import crée un millésime complet : le serveur reconstruit l'arbre. */
  importGeo:    (rows, label, source, pays) =>
    call("POST", `/geo/bulk${pays?`?country=${encodeURIComponent(pays)}`:""}`, { rows, label, source }),

  /* Contours administratifs. L'import est envoyé par lots — les contours d'un pays
     entier ne passent pas dans un corps de requête — et le premier lot porte
     `reset` : sans lui, deux imports successifs mêleraient leurs géométries. */
  geoGeometry:      (q="")                => call("GET", `/geo/geometry${q}`),
  importGeometry:   (features, opts = {}) => call("POST", `/geo/geometry${opts.pays?`?country=${encodeURIComponent(opts.pays)}`:""}`,
                        { features, reset:!!opts.reset, source:opts.source, versionId:opts.versionId }),
  clearGeometry:    ()                    => call("DELETE", "/geo/geometry"),

  mre:          (q="")       => call("GET", `/mre${q}`),
  createMre:    (a)          => call("POST", "/mre", a),
  updateMre:    (id, a)      => call("PUT", `/mre/${encodeURIComponent(id)}`, a),
  deleteMre:    (id)         => call("DELETE", `/mre/${encodeURIComponent(id)}`),
  /* Le budget est enregistré en bloc pour une activité, avec sa révision :
     l'unité d'édition est l'activité, pas la ligne de coût. */
  /* Le calendrier trimestriel et la dépense constatée : deux écritures distinctes,
     parce qu'elles sont faites à des moments différents et souvent par deux
     personnes — lier les deux ferait qu'un saisisseur de dépense bloquerait un
     planificateur, et réciproquement. */
  mreFrequencies: (id, body) => call("PUT", `/mre/${encodeURIComponent(id)}/frequencies`, body),
  mreSpend:       (id, body) => call("PUT", `/mre/${encodeURIComponent(id)}/spend`, body),
  updateIndicatorPlan: (id, body) =>
    call("PUT", `/indicators/${encodeURIComponent(id)}/plan`, body),

  /* Suivi tiers. Les mutations renvoient le plan recalculé : le client n'a pas à
     redéduire le budget ni l'état du circuit, il le redéduirait autrement. */
  tpm:            ()             => call("GET", "/tpm"),
  createTpm:      (t)            => call("POST", "/tpm", t),
  updateTpm:      (id, t)        => call("PUT", `/tpm/${encodeURIComponent(id)}`, t),
  deleteTpm:      (id)           => call("DELETE", `/tpm/${encodeURIComponent(id)}`),
  createContract: (c)            => call("POST", "/tpm/contracts", c),
  updateContract: (id, c)        => call("PUT", `/tpm/contracts/${encodeURIComponent(id)}`, c),
  addAmendment:   (id, a)        => call("POST", `/tpm/contracts/${encodeURIComponent(id)}/amendments`, a),
  saveRates:      (id, rates)    => call("PUT", `/tpm/contracts/${encodeURIComponent(id)}/rates`, { rates }),
  tpmOverview:  (q="")            => call("GET", `/tpm/overview${q}`),
  tpmPlans:       (q="")         => call("GET", `/tpm/plans${q}`),
  tpmPlan:        (id)           => call("GET", `/tpm/plans/${encodeURIComponent(id)}`),
  createTpmPlan:  (p)            => call("POST", "/tpm/plans", p),
  saveTpmZones:   (id, rev, zones) => call("PUT", `/tpm/plans/${encodeURIComponent(id)}/zones`, { rev, zones }),
  saveTpmLines:   (id, rev, lines) => call("PUT", `/tpm/plans/${encodeURIComponent(id)}/lines`, { rev, lines }),
  submitTpmPlan:  (id)           => call("POST", `/tpm/plans/${encodeURIComponent(id)}/submit`, {}),
  reviewTpmPlan:  (id, decision, comment) =>
                                    call("POST", `/tpm/plans/${encodeURIComponent(id)}/review`, { decision, comment }),
  closeTpmPlan:   (id)           => call("POST", `/tpm/plans/${encodeURIComponent(id)}/close`, {}),
  deleteTpmPlan:  (id)           => call("DELETE", `/tpm/plans/${encodeURIComponent(id)}`),
  addTpmExpense:  (id, e)        => call("POST", `/tpm/plans/${encodeURIComponent(id)}/expenses`, e),
  deleteTpmExpense:(id)          => call("DELETE", `/tpm/expenses/${encodeURIComponent(id)}`),
  tpmSuggest:     (q="")         => call("GET", `/tpm/suggest${q}`),

  /* Pays et vocabulaire du découpage. Cette première version sert Madagascar ;
     ces routes existent pour que le pays suivant soit un acte de configuration. */
  countries:      ()             => call("GET", "/country"),
  createCountry:  (c)            => call("POST", "/country", c),
  updateCountry:  (code, c)      => call("PUT", `/country/${encodeURIComponent(code)}`, c),
  /* Le pays PAR DÉFAUT de l'instance — celui d'un compte qui n'en déclare aucun. À
     ne pas confondre avec `setWorkingCountry`, qui place l'appelant dans un pays le
     temps de sa session sans rien changer pour les autres. */
  setDefaultCountry: (code)      => call("PUT", `/country/${encodeURIComponent(code)}/current`),
  deleteCountry:  (code)         => call("DELETE", `/country/${encodeURIComponent(code)}`),

  partners:      ()        => call("GET", "/partners"),
  createPartner: (b)       => call("POST", "/partners", b),
  updatePartner: (id, b)   => call("PUT", `/partners/${encodeURIComponent(id)}`, b),
  deletePartner: (id)      => call("DELETE", `/partners/${encodeURIComponent(id)}`),
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
