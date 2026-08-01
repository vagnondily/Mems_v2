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

/* Point de montage des routes d'administration de l'instance. Une seule
   constante : les onze appels ci-dessous ne connaissent pas le préfixe. */
const ADMIN = "/admin";

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
  /* `extra` porte les paramètres propres à un type d'import — le référentiel, pour
     un type de portée nationale, qui n'a ni exercice ni périmètre. L'appel à deux
     arguments reste exactement ce qu'il était. */
  importTemplate: (kind, year, extra = {}) => {
    const qs = new URLSearchParams();
    if(year != null && year !== "") qs.set("year", String(year));
    for(const [k, v] of Object.entries(extra)) if(v != null && v !== "") qs.set(k, String(v));
    return fetchBlob(`/import/${encodeURIComponent(kind)}/template?${qs}`);
  },
  importUpload:   (kind, file)    => postFile(`/import/${encodeURIComponent(kind)}`, file),
  /* Le XLSForm est lu par le serveur, qui a déjà exceljs. Le navigateur
     embarquait SheetJS pour le faire lui-même : deux failles connues, aucun
     correctif au registre npm, et un lecteur de classeurs livré à chaque
     utilisateur pour une fenêtre de configuration ouverte par les seuls
     administrateurs. */
  xlsformParse:   (file)          => postFile("/xlsform/parse", file),
  importBatches:  ()              => call("GET", "/import/batches"),
  importBatch:    (id)            => call("GET", `/import/batches/${encodeURIComponent(id)}`),
  importCommit:   (id)            => call("POST", `/import/batches/${encodeURIComponent(id)}/commit`, {}),
  importCancel:   (id)            => call("POST", `/import/batches/${encodeURIComponent(id)}/cancel`, {}),
  setGeoVersion:(id)              => call("PUT", `/geo/versions/${encodeURIComponent(id)}/current`),
  /* Un import crée un millésime complet : le serveur reconstruit l'arbre. */
  importGeo:    (rows, label, source) => call("POST", "/geo/bulk", { rows, label, source }),

  /* Contours administratifs. L'import est envoyé par lots — les contours d'un pays
     entier ne passent pas dans un corps de requête — et le premier lot porte
     `reset` : sans lui, deux imports successifs mêleraient leurs géométries. */
  geoGeometry:      (q="")                => call("GET", `/geo/geometry${q}`),
  importGeometry:   (features, opts = {}) => call("POST", "/geo/geometry",
                        { features, reset:!!opts.reset, source:opts.source, versionId:opts.versionId }),
  clearGeometry:    ()                    => call("DELETE", "/geo/geometry"),

  mre:          (q="")       => call("GET", `/mre${q}`),
  createMre:    (a)          => call("POST", "/mre", a),
  updateMre:    (id, a)      => call("PUT", `/mre/${encodeURIComponent(id)}`, a),
  deleteMre:    (id)         => call("DELETE", `/mre/${encodeURIComponent(id)}`),
  /* Le budget est enregistré en bloc pour une activité, avec sa révision :
     l'unité d'édition est l'activité, pas la ligne de coût. */
  saveMreCosts: (id, rev, lines) => call("PUT", `/mre/${encodeURIComponent(id)}/costs`, { rev, lines }),

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
  setCountry:     (code)         => call("PUT", `/country/${encodeURIComponent(code)}/current`),
  deleteCountry:  (code)         => call("DELETE", `/country/${encodeURIComponent(code)}`),

  /* Connecteurs et correspondance des variables.

     `connectorChamps` rend le registre des champs MEMS et le jeu fermé des
     transformations. L'écran n'en tient AUCUNE copie : une seconde liste dans le
     navigateur divergerait de celle que le serveur valide, et l'utilisateur
     verrait des champs que l'enregistrement refuse. */
  connectors:         ()             => call("GET", "/connectors"),
  connectorChamps:    ()             => call("GET", "/connectors/champs"),
  createConnector:    (c)            => call("POST", "/connectors", c),
  updateConnector:    (id, c)        => call("PUT", `/connectors/${encodeURIComponent(id)}`, c),
  deleteConnector:    (id)           => call("DELETE", `/connectors/${encodeURIComponent(id)}`),
  connectorMappings:  (id, entity)   => call("GET", `/connectors/${encodeURIComponent(id)}/mappings`
                                          + (entity ? `?entity=${encodeURIComponent(entity)}` : "")),
  saveConnectorMappings: (id, entity, mappings) =>
                                        call("PUT", `/connectors/${encodeURIComponent(id)}/mappings`,
                                          { entity, mappings }),
  /* L'aperçu accepte des correspondances non encore enregistrées : on vérifie
     avant d'écrire, jamais l'inverse. */
  connectorApercu:    (id, corps)    => call("POST", `/connectors/${encodeURIComponent(id)}/apercu`, corps),
  connectorSuggestions:(id, corps)   => call("POST", `/connectors/${encodeURIComponent(id)}/suggestions`, corps),

  /* Chaîne ODK : verser, puis rattacher. Les deux sont réservés à
     l'administration côté serveur — ils écrivent dans le référentiel
     opérationnel — et sont volontairement séparés : on doit pouvoir rejouer un
     rattachement après avoir corrigé un code externe, sans rien re-tirer. */
  submissions:          (q="")    => call("GET", `/submissions${q}`),
  ingestSubmissions:    (corps)   => call("POST", "/submissions/ingest", corps),
  rattacherSubmissions: (corps)   => call("POST", "/submissions/rattacher", corps),

  /* Le rattachement décidé par un humain, soumission par soumission — ce que le
     résolveur refuse de deviner et qu'aucun code externe ne tranchera.

     `creer_alias` demande en plus que le code brut de la soumission soit retenu
     comme code de reconnaissance du site : sans lui, la décision ne vaut que
     pour cette ligne et le geste est à refaire à chaque collecte du même site.

     Le détachement a sa propre route plutôt qu'un `site_id` nul sur celle-ci :
     les deux gestes ne conservent pas la même chose. Rattacher pose une passe
     « manuel » qui résiste au rejeu ; détacher la retire et rend la question au
     résolveur. Un seul point d'entrée pour deux effets contraires obligerait à
     lire le corps de la requête pour savoir laquelle des deux on a demandée. */
  rattacherSubmissionA: (id, { site_id, creer_alias = false } = {}) =>
    call("POST", `/submissions/${encodeURIComponent(id)}/rattacher-a`,
         { site_id, creer_alias: !!creer_alias }),
  detacherSubmission:   (id) =>
    call("POST", `/submissions/${encodeURIComponent(id)}/detacher`, {}),

  /* Référentiels de codes d'identification. Aucun de ces points n'entre dans la
     file de synchronisation des collections : 1 251 lignes n'ont rien à faire
     dans l'état poussé au démarrage, et moins encore renvoyées au serveur à
     chaque enregistrement. L'écran lit son propre point d'API. */
  codeReferentiels: ()          => call("GET", "/code-referentiels"),
  codeReferentiel:  (nom, q="") => call("GET", `/code-referentiels/${encodeURIComponent(nom)}${q}`),
  rapprocherCodes:  (nom)       => call("POST", `/code-referentiels/${encodeURIComponent(nom)}/rapprocher`, {}),
  etatCodes:        (nom)       => call("GET", `/code-referentiels/${encodeURIComponent(nom)}/etat`),

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

  /* ── Exécution des scripts d'analyse sur le serveur ────────────────────
     Tout ce routeur est réservé au super-utilisateur : l'appeler avec un autre
     compte rend 403. L'interface ne doit donc l'interroger que pour ce rôle,
     sinon elle fabrique une erreur pour apprendre ce qu'elle savait déjà. */
  scriptMoteurs:   ()           => call("GET", "/scripts/moteurs"),
  /* `lignes` porte le jeu de données APURÉ par le navigateur. Sans lui le
     serveur relit les lignes brutes enregistrées avec le jeu de données : il ne
     rejoue pas les règles d'apurement et ne prétend pas le faire. */
  executerScript:  (id, lignes) => call("POST", `/scripts/${encodeURIComponent(id)}/executer`,
                                        lignes ? { lignes } : {}),
  /* Le manifeste d'exécution porte déjà une `url` toute faite, mais elle
     contient le préfixe « /api » en dur alors que VITE_API_URL peut le
     déplacer. On rebâtit donc le chemin depuis l'identifiant et le nom, qui
     figurent tous deux au manifeste. */
  fichierExecution: (execId, nom) => fetchBlob(
    `/scripts/executions/${encodeURIComponent(execId)}/fichiers/${encodeURIComponent(nom)}`),

  /* ── Sessions ──────────────────────────────────────────────────────────
     Lire les SIENNES est ouvert à tous ; tout le reste — celles d'autrui,
     révocation, purge — est réservé au super-utilisateur côté serveur. */
  sessions:           (q="")    => call("GET", `/auth/sessions${q}`),
  /* Le serveur refuse (409) de couper la session de l'appelant sans une
     confirmation explicite : ce n'est pas un effet de bord acceptable pour un
     geste de ménage. `confirmer` la porte. */
  revoquerSession:    (id, confirmer=false) => call("DELETE",
                          `/auth/sessions/${encodeURIComponent(id)}${confirmer ? "?confirmer=1" : ""}`),
  revoquerSessionsDe: (userId, inclureCourante=false) => call("DELETE",
                          `/auth/users/${encodeURIComponent(userId)}/sessions`
                          + (inclureCourante ? "?inclure_courante=1" : "")),
  purgerSessions:     (jours=0) => call("POST", `/auth/sessions/purge?jours=${jours}`, {}),

  journal:            (q="")    => call("GET", `${ADMIN}/journal${q}`),
  journalFacettes:    ()        => call("GET", `${ADMIN}/journal/facettes`),

  baseEtat:           ()        => call("GET", `${ADMIN}/base`),
  baseCheckpoint:     ()        => call("POST", `${ADMIN}/base/checkpoint`, {}),
  baseVacuum:         ()        => call("POST", `${ADMIN}/base/vacuum`, {}),

  sauvegardes:          ()      => call("GET", `${ADMIN}/sauvegardes`),
  creerSauvegarde:      ()      => call("POST", `${ADMIN}/sauvegarde`, {}),
  controlerSauvegarde:  (nom)   => call("GET", `${ADMIN}/sauvegardes/${encodeURIComponent(nom)}/controle`),
  supprimerSauvegarde:  (nom)   => call("DELETE", `${ADMIN}/sauvegardes/${encodeURIComponent(nom)}`),
  telechargerSauvegarde:(nom)   => fetchBlob(`${ADMIN}/sauvegardes/${encodeURIComponent(nom)}`),
  /* `confirmation` est un mot à recopier, exigé par le serveur : une case à
     cocher se coche par réflexe, un mot ne s'écrit pas par accident. */
  restaurerBase:        (fichier, confirmation) =>
                                   call("POST", `${ADMIN}/restauration`, { fichier, confirmation }),
};

/* Un navigateur ne rend jamais ce minuteur — seul Node (tests, rendu serveur) expose
   .unref() sur la valeur de retour de setTimeout. Sans ce détachement, un réessai en
   attente retient le processus vivant indéfiniment : un test qui tue le serveur pendant
   qu'un réessai est programmé contre un serveur mort ne se termine alors jamais, chaque
   échec reprogrammant le suivant. */
const unref = (t) => { if(t && typeof t.unref === "function") t.unref(); return t; };

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
        unref(setTimeout(() => flushOne(name), Math.min(30000, 1500 * 2 ** Math.min(failures, 4))));
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
      timers.set(name, unref(setTimeout(() => flushOne(name), delay)));
      onStatus({ state:"dirty", inflight, failures });
    },
    async flushAll(){
      for(const name of [...pending.keys()]){ clearTimeout(timers.get(name)); await flushOne(name); }
    },
    get busy(){ return inflight > 0 || pending.size > 0; },
  };
}
