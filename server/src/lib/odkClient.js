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
   dans l'éditeur de formules. */

import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { appelAuthentifie, causeRefus } from "./authSortante.js";

const MAX_PAGES = 50;
const PAGE_SIZE = 1000;
const TIMEOUT_MS = 20_000;
const MAX_ROWS = 20_000;

/* ═══════════════════════════════════════════════════════════════════════
   Où le serveur accepte-t-il d'aller chercher des soumissions ?

   `odkBase` est une valeur de réglage : elle vient de `PUT /api/settings`, donc
   d'un administrateur, donc de l'extérieur. Elle partait telle quelle dans un
   `fetch` côté serveur, sans le moindre contrôle — c'est la définition d'une
   SSRF. Le serveur MEMS tourne dans le réseau du bureau pays : « http://10.0.0.5 »
   ou « http://169.254.169.254/latest/meta-data/ » lui faisait interroger un
   voisin interne, ou le service de métadonnées de l'hébergeur, et recopier la
   réponse dans `odk_forms.raw` — d'où elle ressort par `GET /api/state`.

   Trois règles, dans cet ordre :

   1. ODK_ALLOWED_HOSTS, quand elle est renseignée, fait seule autorité. C'est une
      variable d'environnement : elle est posée par qui exploite le serveur, pas
      par qui l'utilise. Un hôte qu'un exploitant a nommé lui-même est réputé
      légitime, y compris en http et sur une adresse privée — c'est exactement le
      cas d'une installation ODK Central sur site, derrière un proxy inverse, que
      les deux règles suivantes interdiraient à tort.
   2. Sans liste, https est obligatoire : un jeton d'API voyage dans l'en-tête
      Authorization, en clair sur http.
   3. Sans liste, l'adresse résolue doit être publique. Bouclage, réseaux privés,
      lien-local et adresses locales uniques sont refusés.

   Limite assumée : entre notre résolution et celle de `fetch`, un DNS hostile peut
   changer sa réponse (« DNS rebinding »). S'en prémunir vraiment suppose d'ouvrir
   la connexion nous-mêmes sur l'adresse vérifiée ; c'est hors de portée de ce
   client minimal. La liste blanche reste la parade complète pour qui en a besoin.
   ═══════════════════════════════════════════════════════════════════════ */

/* `causeAuth` accompagne le code : « l'hôte est refusé » est l'une des causes
   nommées de lib/authSortante.js, et l'écran doit pouvoir la distinguer d'un
   justificatif fautif sans lire le texte du message. */
const refus = (message) => {
  const e = new Error(message); e.code = "ODK_URL"; e.causeAuth = "AUTH_HOTE"; return e;
};

/* Le motif pour lequel une adresse est refusée, ou null si elle est publique.
   On nomme le motif : « refusé » sans dire pourquoi envoie chercher pendant une heure.

   Exportée depuis l'ajout des connecteurs (lib/foundry.js) : la règle « quelles
   adresses le serveur refuse de joindre » ne doit exister qu'à un seul endroit.
   La recopier pour une seconde source sortante, c'est se garantir qu'un jour
   l'une des deux copies oubliera une plage — et une plage oubliée est une SSRF. */
export function motifPrive(ip){
  if(net.isIPv4(ip)){
    const [a, b] = ip.split(".").map(Number);
    if(a === 127) return "bouclage (127.0.0.0/8)";
    if(a === 10)  return "réseau privé (10.0.0.0/8)";
    if(a === 172 && b >= 16 && b <= 31) return "réseau privé (172.16.0.0/12)";
    if(a === 192 && b === 168) return "réseau privé (192.168.0.0/16)";
    if(a === 169 && b === 254) return "lien-local (169.254.0.0/16)";
    if(a === 0) return "adresse non routable (0.0.0.0/8)";
    return null;
  }
  const v6 = String(ip).toLowerCase();
  if(v6 === "::1" || v6 === "::") return "bouclage (::1)";
  /* IPv4 encapsulé : ::ffff:127.0.0.1 désigne exactement la même machine. */
  const encapsule = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if(encapsule) return motifPrive(encapsule[1]);
  if(/^f[cd]/.test(v6)) return "adresse locale unique (fc00::/7)";
  if(/^fe[89ab]/.test(v6)) return "lien-local (fe80::/10)";
  return null;
}

/* Vérifie l'adresse de base avant tout appel sortant. Lève une erreur `ODK_URL`
   — que la route traduit en 422 — plutôt que de renvoyer un booléen : le message
   fait partie du correctif, l'administrateur doit savoir quoi corriger. */
export async function verifierBaseOdk(baseUrl){
  let u;
  try{ u = new URL(String(baseUrl)); }
  catch(e){ throw refus(
    "adresse du serveur ODK Central illisible : indiquez une URL complète, par exemple https://odk.exemple.org"); }

  const hote = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if(config.odkAllowedHosts.length){
    if(!config.odkAllowedHosts.includes(hote)) throw refus(
      `l'hôte « ${hote} » ne figure pas dans la liste des serveurs ODK autorisés `
      + `(ODK_ALLOWED_HOSTS). Contactez l'équipe technique pour l'y ajouter.`);
    return u;
  }

  if(u.protocol !== "https:") throw refus(
    "le serveur ODK Central doit être joint en https : le jeton d'accès circule "
    + "dans les en-têtes, il ne peut pas voyager en clair.");

  let adresses;
  if(net.isIP(hote)) adresses = [hote];
  else{
    try{ adresses = (await dns.lookup(hote, { all:true })).map(a => a.address); }
    catch(e){ throw refus(
      `le nom « ${hote} » ne se résout pas : vérifiez l'adresse du serveur ODK Central.`); }
  }
  for(const a of adresses){
    const motif = motifPrive(a);
    if(motif) throw refus(
      `l'adresse « ${hote} » désigne ${a}, ${motif} : le serveur ne va pas chercher `
      + `de données sur son propre réseau. Déclarez l'hôte dans ODK_ALLOWED_HOSTS `
      + `s'il s'agit bien de votre ODK Central interne.`);
  }
  return u;
}

/* Deux valeurs sont extraites des champs « système » d'OData avant que le reste
   ne soit écarté, et il faut dire pourquoi cette exception existe.

   `__id` est l'identifiant d'instance de la soumission — sa clé primaire chez
   ODK Central, pas un détail de protocole. Sans lui, deux tirages successifs du
   même formulaire ne se recouvrent pas : ils créent des doublons. Il ressort donc
   sous `instance_id`, qui est le nom du champ dans le registre (lib/champs.js) et
   la colonne d'unicité de `submissions`. `__system/submissionDate` sort de même
   sous `submitted_at` : la date de dépôt n'est pas la date de collecte, et un
   formulaire rempli hors ligne peut être déposé plusieurs jours plus tard.

   Tout le reste de `__system` (état de relecture, appareil, pièces jointes) et
   toutes les annotations `@odata` continuent d'être écartées : ce sont bien des
   détails de protocole, et les faire apparaître comme des variables du
   formulaire polluerait l'éditeur de formules. */
function flatten(obj, out = {}){
  for(const [k, v] of Object.entries(obj || {})){
    if(k.startsWith("__") || k.startsWith("@odata")) continue;
    if(v && typeof v === "object" && !Array.isArray(v)) flatten(v, out);
    else if(!Array.isArray(v)) out[k] = v;
  }
  return out;
}

function aplatirSoumission(item){
  const out = flatten(item);
  if(item?.__id !== undefined && out.instance_id === undefined) out.instance_id = item.__id;
  const depot = item?.__system?.submissionDate;
  if(depot !== undefined && out.submitted_at === undefined) out.submitted_at = depot;
  return out;
}

/* Ce client ne sait plus fabriquer un en-tête d'autorisation : il en reçoit un
   porteur (lib/authSortante.js), qui est le seul du serveur à savoir le faire.
   Le mot « Bearer » n'apparaît donc plus ici — il était écrit en dur, et il ne
   valait que pour ODK Central alors qu'il était pris pour une règle universelle.
   Le renouvellement d'une session expirée et le rejeu de l'appel sont pris en
   charge par `appelAuthentifie`, une fois et une seule. */
async function fetchJson(url, porteur){
  const appel = async (enTetes) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try{
      return await fetch(url, {
        headers: { ...enTetes, Accept: "application/json" },
        signal: ac.signal,
        /* Posé au même titre que chez lib/foundry.js, et pour la même raison :
           une redirection sortirait de l'hôte vérifié en emportant l'en-tête
           d'autorisation. Cette garde manquait de ce côté-ci — une règle écrite
           d'un côté et pas de l'autre finit toujours par se payer du côté nu. */
        redirect: "manual",
      });
    }catch(e){
      const err = new Error(e.name === "AbortError" ? "délai dépassé" : e.message);
      err.code = "ODK_NETWORK";
      throw err;
    }finally{ clearTimeout(timer); }
  };

  const { res, renouvele, motifRenouvellement } = await appelAuthentifie(porteur, appel);

  if(res.status >= 300 && res.status < 400){
    /* La destination est dite, et c'est tout l'intérêt du message : « indiquez
       l'adresse finale » sans nommer laquelle envoie chercher. Elle vient de la
       source, donc on la borne et on en retire les caractères de contrôle avant
       de la recopier — un en-tête d'origine extérieure n'écrit pas dans nos
       journaux ce qu'il veut. Le cas courant est un ODK Central sur site derrière
       un nginx qui redirige http vers https : l'adresse à corriger est dans
       Paramètres → ODK Central → Serveur. */
    const vers = String(res.headers.get("location") || "")
      .replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    const e = new Error("ODK Central répond par une redirection : le serveur ne la suit pas, car "
      + "elle emporterait le justificatif vers un hôte qui n'a pas été vérifié. "
      + (vers ? `Elle mène vers « ${vers} » : indiquez cette adresse` : "Indiquez l'adresse finale")
      + " dans Paramètres → ODK Central → Serveur.");
    e.code = "ODK_URL"; throw e;
  }
  if(res.status === 401 || res.status === 403){
    const { cause, message } = await causeRefus({ porteur, res, renouvele, motifRenouvellement });
    const e = new Error(`ODK Central — ${message}`);
    e.code = "ODK_AUTH"; e.causeAuth = cause; throw e;
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
export async function pullSubmissions({ baseUrl, project, formId, porteur }){
  /* Le contrôle est ici, au seul point de sortie, et non chez l'appelant : un
     futur second appelant hériterait sinon de la faille sans que rien ne le dise. */
  await verifierBaseOdk(baseUrl);
  const base = String(baseUrl).replace(/\/+$/, "");
  const premiere = `${base}/v1/projects/${encodeURIComponent(project)}/forms/${encodeURIComponent(formId)}`
    + `.svc/Submissions?$top=${PAGE_SIZE}`;
  const origine = new URL(premiere).origin;
  let url = premiere;
  const rows = [];
  let pages = 0, truncated = false;
  while(url){
    if(pages >= MAX_PAGES || rows.length >= MAX_ROWS){ truncated = true; break; }
    const body = await fetchJson(url, porteur);
    for(const item of body.value || []) rows.push(aplatirSoumission(item));
    pages++;
    url = pageSuivante(body["@odata.nextLink"], origine);
  }
  return { rows: rows.slice(0, MAX_ROWS), pages, truncated };
}

/* Le lien de page suivante d'OData est une URL ABSOLUE, et c'est le SERVEUR
   DISTANT qui la fabrique : chez ODK Central elle est composée du réglage
   `default.domain` de l'instance suivi du chemin (lib/util/odata.js, gabarit
   `"@odata.nextLink":"{{{domain}}}{{{nextUrl}}}"`). La suivre telle quelle, comme
   on le faisait, rendait la garde anti-SSRF contournable par la source elle-même :
   il suffisait d'un ODK Central compromis — ou seulement mal configuré — pour
   faire partir la page 2, et l'en-tête d'autorisation avec elle, vers n'importe
   quel hôte.

   On ne retient donc du lien que ce que la source a le droit de décider : le
   CHEMIN et sa requête. L'origine, elle, reste celle du premier appel, sans quoi
   la source choisirait où l'on va. Refuser tout lien dont l'origine diffère aurait
   fermé la même faille, mais cassé au passage un déploiement parfaitement
   légitime : `default.domain` est le nom public de l'instance, et rien n'oblige
   qu'il soit l'adresse par laquelle MEMS la joint — un ODK Central sur site
   déclaré « http://odk.interne.org » compose ses liens avec « https://odk.exemple.org ».
   Le tirage s'y arrêtait à la première page de plus de mille soumissions.

   Un lien illisible, lui, reste une erreur franche : on ne devine pas une
   pagination. */
function pageSuivante(lien, origine){
  if(!lien) return null;
  let u;
  try{ u = new URL(String(lien), origine); }
  catch(e){
    const err = new Error("ODK Central renvoie un lien de page suivante illisible : tirage interrompu.");
    err.code = "ODK_HTTP"; throw err;
  }
  return origine + u.pathname + u.search;
}
