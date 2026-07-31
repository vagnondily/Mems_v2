/* ═══════════════════════════════════════════════════════════════════════
   Client minimal pour l'API OData d'ODK Central.

   Portée volontairement limitée à cette première version : seuls les champs
   de premier niveau et les champs de groupe (aplatis sur leur seul nom de
   feuille, comme le fait déjà le rattachement d'un XLSForm depuis
   Paramètres → ODK Central) sont récupérés. Les groupes répétés exigent une
   requête `$expand` distincte par répétition dans l'API OData ; ils ne sont
   pas suivis ici. Les indicateurs de performance audités sur les XLSForms
   MDG s'appuient tous sur des champs de premier niveau ou de groupe, jamais
   sur une répétition — cette limite n'empêche donc pas de les recalculer.

   Aplatir sur le seul nom de feuille reproduit aussi un défaut réel des
   formulaires source : deux champs de groupes différents portant le même
   nom (ex. « HHCoord » utilisé à la fois pour les coordonnées du site et
   celles de l'entrepôt dans MDG_Process_Monitoring_GD_PREVMA_v2) s'écrasent
   l'un l'autre. C'est un défaut du XLSForm, pas de ce client : mieux vaut
   le voir dans les résultats que le masquer par un chemin composé illisible
   dans l'éditeur de formules.

   Une question `geopoint` XLSForm revient dans l'OData d'ODK Central comme
   un point GeoJSON — `{ type:"Point", coordinates:[lon,lat,alt] }` — pas comme
   un champ de premier niveau. Sans traitement particulier, la branche
   « objet, pas tableau » de l'aplatissement y descendait, gardait `type`
   (une chaîne) et perdait `coordinates` (un tableau, explicitement ignoré) :
   la question GPS disparaissait entièrement, remplacée par un `type:"Point"`
   égaré. Elle est désormais reconnue avant la récursion et posée sous le nom
   même de la question, en `{ lat, lon, alt }` — exploitable pour la
   vérification de cohérence GPS avec le référentiel des sites. */

const MAX_PAGES = 50;
const PAGE_SIZE = 1000;
const TIMEOUT_MS = 20_000;
const MAX_ROWS = 20_000;

function isGeoPoint(v){
  return !!v && typeof v === "object" && v.type === "Point" && Array.isArray(v.coordinates)
    && v.coordinates.length >= 2 && v.coordinates.every(x => typeof x === "number");
}

function flatten(obj, out = {}){
  for(const [k, v] of Object.entries(obj || {})){
    if(k.startsWith("__") || k.startsWith("@odata")) continue;
    if(isGeoPoint(v)){
      const [lon, lat, alt] = v.coordinates;
      out[k] = { lat, lon, alt: alt ?? null };
    }
    else if(v && typeof v === "object" && !Array.isArray(v)) flatten(v, out);
    else if(!Array.isArray(v)) out[k] = v;
  }
  return out;
}

async function fetchJson(url, token){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try{
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: ac.signal,
    });
  }catch(e){
    const err = new Error(e.name === "AbortError" ? "délai dépassé" : e.message);
    err.code = "ODK_NETWORK";
    throw err;
  }finally{ clearTimeout(timer); }

  if(res.status === 401 || res.status === 403){
    const e = new Error("accès refusé par ODK Central"); e.code = "ODK_AUTH"; throw e;
  }
  if(res.status === 404){
    const e = new Error("formulaire introuvable sur ODK Central"); e.code = "ODK_NOT_FOUND"; throw e;
  }
  if(!res.ok){
    const e = new Error(`réponse inattendue d'ODK Central (${res.status})`); e.code = "ODK_HTTP"; throw e;
  }
  try{ return await res.json(); }
  catch(e){ const err = new Error("réponse d'ODK Central illisible"); err.code = "ODK_HTTP"; throw err; }
}

/* Tire les soumissions d'un formulaire, page par page, jusqu'à épuisement,
   au plafond de pages, ou au plafond de lignes — le premier atteint. */
export async function pullSubmissions({ baseUrl, project, formId, token }){
  const base = String(baseUrl).replace(/\/+$/, "");
  let url = `${base}/v1/projects/${encodeURIComponent(project)}/forms/${encodeURIComponent(formId)}`
    + `.svc/Submissions?$top=${PAGE_SIZE}`;
  const rows = [];
  let pages = 0, truncated = false;
  while(url){
    if(pages >= MAX_PAGES || rows.length >= MAX_ROWS){ truncated = true; break; }
    const body = await fetchJson(url, token);
    for(const item of body.value || []) rows.push(flatten(item));
    pages++;
    url = body["@odata.nextLink"] || null;
  }
  return { rows: rows.slice(0, MAX_ROWS), pages, truncated };
}
