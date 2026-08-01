/* ═══════════════════════════════════════════════════════════════════════
   Lecture d'une source REST distante — Palantir Foundry, et HTTP générique.

   ⚠ CE QUI N'A PAS PU ÊTRE VÉRIFIÉ, ET QU'IL FAUT SAVOIR AVANT DE S'EN SERVIR

   Ce client est écrit d'après la forme documentée de l'API Foundry. Il n'a
   jamais parlé à une instance Foundry : aucune n'était disponible, et cet
   environnement n'a pas d'accès réseau sortant libre. Ce qui est prouvé par les
   tests, c'est la construction de l'URL, l'en-tête d'autorisation, la lecture
   CSV et JSON, la gestion des codes d'erreur et le refus des adresses interdites
   — contre un serveur simulé. Ce qui ne l'est PAS : que le chemin
   `/api/v2/datasets/{rid}/readTable` et les noms de paramètres soient exactement
   ceux de l'instance du client, ni la forme précise de ses réponses.

   D'où le choix de rendre le chemin et les noms de paramètres configurables par
   connecteur (`config.chemin`) plutôt que de les figer : la première mise en
   service se réglera par la configuration, sans nouvelle livraison de code. La
   valeur par défaut est la forme documentée, pas une invention.

   ── Où le serveur accepte-t-il d'aller ────────────────────────────────
   Exactement la même règle que pour ODK Central (lib/odkClient.js), pour la même
   raison : `base_url` est saisie par un administrateur, donc venue de
   l'extérieur, et un `fetch` sans contrôle sur une valeur venue de l'extérieur
   est une SSRF. La fonction qui nomme les plages interdites est IMPORTÉE de
   lib/odkClient.js, non recopiée — une règle de sécurité en double est une règle
   qui finit par diverger.

     1. CONNECTOR_ALLOWED_HOSTS, si renseignée, fait seule autorité (variable
        d'environnement : posée par qui exploite, pas par qui utilise).
     2. Sinon, https obligatoire — le jeton voyage dans l'en-tête Authorization.
     3. Sinon, l'adresse résolue doit être publique.

   Même limite assumée qu'ODK : entre notre résolution DNS et celle de `fetch`,
   un DNS hostile peut changer sa réponse. La liste blanche reste la parade
   complète pour qui en a besoin.
   ═══════════════════════════════════════════════════════════════════════ */

import dns from "node:dns/promises";
import net from "node:net";
import { config } from "../config.js";
import { motifPrive } from "./odkClient.js";
import { appelAuthentifie, causeRefus } from "./authSortante.js";

const TIMEOUT_MS = 20_000;
/* Un aperçu lit quelques lignes, pas un dataset entier : le plafond protège la
   mémoire du serveur contre une source qui répondrait un fichier de plusieurs
   gigaoctets, et il est vérifié pendant la lecture, pas après. */
const MAX_OCTETS = 8 * 1024 * 1024;
const MAX_LIGNES = 5_000;

/* Le chemin documenté de la lecture d'un dataset Foundry. Surchargeable par
   connecteur : voir l'avertissement en tête de fichier. */
export const CHEMIN_FOUNDRY_DEFAUT = "/api/v2/datasets/{rid}/readTable";

/* Un refus d'hôte porte aussi sa cause nommée (lib/authSortante.js) : l'écran
   distingue ainsi « l'adresse est interdite » de « le justificatif est refusé »
   sans avoir à interpréter le texte du message. */
const refus = (message, code = "SOURCE_URL") => {
  const e = new Error(message); e.code = code;
  if(code === "SOURCE_URL") e.causeAuth = "AUTH_HOTE";
  return e;
};

export async function verifierBaseSortante(baseUrl, quoi = "la source"){
  let u;
  try{ u = new URL(String(baseUrl)); }
  catch(e){ throw refus(
    `adresse de ${quoi} illisible : indiquez une URL complète, par exemple https://exemple.palantirfoundry.com`); }

  const hote = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();

  if(config.connectorAllowedHosts.length){
    if(!config.connectorAllowedHosts.includes(hote)) throw refus(
      `l'hôte « ${hote} » ne figure pas dans la liste des sources autorisées `
      + `(CONNECTOR_ALLOWED_HOSTS). Contactez l'équipe technique pour l'y ajouter.`);
    return u;
  }

  if(u.protocol !== "https:") throw refus(
    `${quoi} doit être jointe en https : le jeton d'accès circule dans les en-têtes, `
    + "il ne peut pas voyager en clair.");

  let adresses;
  if(net.isIP(hote)) adresses = [hote];
  else{
    try{ adresses = (await dns.lookup(hote, { all:true })).map(a => a.address); }
    catch(e){ throw refus(`le nom « ${hote} » ne se résout pas : vérifiez l'adresse de ${quoi}.`); }
  }
  for(const a of adresses){
    const motif = motifPrive(a);
    if(motif) throw refus(
      `l'adresse « ${hote} » désigne ${a}, ${motif} : le serveur ne va pas chercher de données `
      + `sur son propre réseau. Déclarez l'hôte dans CONNECTOR_ALLOWED_HOSTS s'il s'agit bien `
      + `d'un serveur interne légitime.`);
  }
  return u;
}

/* Lecture bornée du corps de la réponse : on s'arrête au plafond au lieu de le
   constater une fois la mémoire consommée. */
async function texteBorne(res){
  if(!res.body) return await res.text();
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder("utf-8");
  let texte = "", octets = 0;
  for(;;){
    const { done, value } = await lecteur.read();
    if(done) break;
    octets += value.byteLength;
    if(octets > MAX_OCTETS){
      await lecteur.cancel();
      throw refus(`réponse trop volumineuse (plafond ${Math.round(MAX_OCTETS / 1048576)} Mo) : `
        + "restreignez les colonnes ou le nombre de lignes demandées.", "SOURCE_HTTP");
    }
    texte += decodeur.decode(value, { stream:true });
  }
  return texte + decodeur.decode();
}

/* Comme lib/odkClient.js, ce client ne fabrique plus d'en-tête d'autorisation :
   il reçoit un porteur (lib/authSortante.js). Le `Bearer` qui était écrit ici
   partait pour TOUTES les natures de connecteur, y compris celles qui attendent
   `Token` — et il n'avait, pour Foundry lui-même, jamais été vérifié contre une
   instance réelle. Une hypothèse non vérifiée reconduite tacitement en reste une :
   elle est désormais réglable par source. */
async function appeler(url, porteur, accept){
  const faireAppel = async (enTetes) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try{
      return await fetch(url, {
        headers: { ...enTetes, Accept: accept },
        signal: ac.signal,
        redirect: "manual",     /* une redirection sortirait de l'hôte vérifié */
      });
    }catch(e){
      throw refus(e.name === "AbortError" ? "délai dépassé" : e.message, "SOURCE_NETWORK");
    }finally{ clearTimeout(timer); }
  };

  const { res, renouvele, motifRenouvellement } = await appelAuthentifie(porteur, faireAppel);

  if(res.status >= 300 && res.status < 400) throw refus(
    "la source répond par une redirection : le serveur ne la suit pas, car elle mènerait "
    + "vers un hôte qui n'a pas été vérifié. Indiquez l'adresse finale.", "SOURCE_HTTP");
  if(res.status === 401 || res.status === 403){
    const { cause, message } = await causeRefus({ porteur, res, renouvele, motifRenouvellement });
    const e = refus(message, "SOURCE_AUTH"); e.causeAuth = cause; throw e;
  }
  if(res.status === 404) throw refus(
    "jeu de données introuvable à cette adresse : vérifiez l'identifiant et le chemin.",
    "SOURCE_NOT_FOUND");
  if(!res.ok) throw refus(`réponse inattendue de la source (${res.status})`, "SOURCE_HTTP");
  return res;
}

/* ── CSV ──────────────────────────────────────────────────────────────
   Foundry rend le contenu d'une table en CSV lorsqu'on le lui demande. Un
   analyseur complet (guillemets, guillemets doublés, séparateurs et sauts de
   ligne entre guillemets) tient en vingt lignes ; s'en remettre à un `split(",")`
   casserait sur la première cellule contenant une virgule — c'est-à-dire sur le
   premier nom de lieu composé. */
export function lireCsv(texte, maxLignes = MAX_LIGNES){
  const lignes = [];
  let ligne = [], cellule = "", entreGuillemets = false;
  const t = String(texte).replace(/\r\n?/g, "\n");
  for(let i = 0; i < t.length; i++){
    const ch = t[i];
    if(entreGuillemets){
      if(ch === '"'){ if(t[i+1] === '"'){ cellule += '"'; i++; } else entreGuillemets = false; }
      else cellule += ch;
    } else if(ch === '"') entreGuillemets = true;
    else if(ch === "," || ch === ";"){ ligne.push(cellule); cellule = ""; }
    else if(ch === "\n"){ ligne.push(cellule); lignes.push(ligne); ligne = []; cellule = "";
      if(lignes.length > maxLignes + 1) break; }
    else cellule += ch;
  }
  if(cellule !== "" || ligne.length){ ligne.push(cellule); lignes.push(ligne); }
  if(!lignes.length) return [];
  const entetes = lignes.shift().map(h => h.replace(/^﻿/, "").trim());
  return lignes
    .filter(l => l.some(v => v !== ""))
    .slice(0, maxLignes)
    .map(l => Object.fromEntries(entetes.map((h, i) => [h || `col${i + 1}`, l[i] ?? ""])));
}

/* Extrait le tableau de lignes d'une réponse JSON, quelle que soit la façon dont
   la source l'emballe. `pointeur` permet de nommer explicitement le chemin quand
   aucune des formes courantes ne convient — plutôt que de deviner. */
export function extraireLignes(payload, pointeur){
  let noeud = payload;
  if(pointeur){
    for(const s of String(pointeur).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)){
      if(noeud === null || noeud === undefined || typeof noeud !== "object") return [];
      noeud = Array.isArray(noeud) ? noeud[Number(s)] : noeud[s];
    }
  }
  if(Array.isArray(noeud)) return noeud;
  if(!noeud || typeof noeud !== "object") return [];
  for(const cle of ["data", "rows", "value", "results", "items", "records"])
    if(Array.isArray(noeud[cle])) return noeud[cle];
  return [];
}

/* ── Foundry ──────────────────────────────────────────────────────────
   Lit les premières lignes d'un dataset. Le format CSV est demandé par défaut :
   c'est celui que l'API documente pour `readTable`, et il ne suppose aucune
   hypothèse sur l'emballage JSON de l'instance. */
/* Le chemin d'un dataset, gabarit résolu. Exporté parce que l'épreuve de
   connexion (routes/connectors.js) doit viser LA MÊME adresse que la lecture :
   elle reprenait `config.chemin` tel quel, appelait donc « /api/v2/datasets/
   %7Brid%7D/readTable », et imputait le 404 qui s'ensuit au chemin réglé — un
   chemin pourtant correct, et que l'écran propose lui-même en indication. Deux
   substitutions n'auraient pas mieux valu qu'une : c'est en ayant deux façons de
   composer l'URL qu'on obtient deux URL différentes. */
export const cheminFoundry = (chemin, datasetRid) =>
  String(chemin || CHEMIN_FOUNDRY_DEFAUT).replace("{rid}", encodeURIComponent(datasetRid || ""));

export async function lireDatasetFoundry({ baseUrl, datasetRid, porteur, branche = "master",
  limite = 100, format = "CSV", chemin = CHEMIN_FOUNDRY_DEFAUT, colonnes = [], pointeur = "" } = {}){

  if(!datasetRid) throw refus(
    "identifiant du jeu de données (RID) absent : renseignez-le dans la configuration du connecteur.",
    "SOURCE_CONFIG");
  const u = await verifierBaseSortante(baseUrl, "l'instance Foundry");

  const base = u.toString().replace(/\/+$/, "");
  const suffixe = cheminFoundry(chemin, datasetRid);
  const url = new URL(base + (suffixe.startsWith("/") ? suffixe : "/" + suffixe));
  url.searchParams.set("format", format);
  if(branche) url.searchParams.set("branchName", branche);
  url.searchParams.set("rowLimit", String(Math.min(Math.max(1, Number(limite) || 100), MAX_LIGNES)));
  if(colonnes.length) url.searchParams.set("columns", colonnes.join(","));

  const res = await appeler(url.toString(), porteur,
    format === "CSV" ? "text/csv, application/json" : "application/json");
  const texte = await texteBorne(res);
  const typeReponse = (res.headers.get("content-type") || "").toLowerCase();

  /* On se fie au type rendu, pas au format demandé : une instance peut très bien
     répondre du JSON là où le CSV a été demandé, et le deviner à l'envers
     produirait des lignes composées d'une seule colonne illisible. */
  if(typeReponse.includes("json")){
    let payload;
    try{ payload = JSON.parse(texte); }
    catch(e){ throw refus("réponse de Foundry illisible : ce n'est pas du JSON valide.", "SOURCE_HTTP"); }
    return { rows: extraireLignes(payload, pointeur).slice(0, MAX_LIGNES), format: "JSON" };
  }
  return { rows: lireCsv(texte, Number(limite) || 100), format: "CSV" };
}

/* ── HTTP générique ───────────────────────────────────────────────────
   Toute API qui rend du JSON ou du CSV : l'export d'un partenaire, un service
   interne. Aucune connaissance du produit distant, aucune pagination — un aperçu,
   pas un import.

   Ce commentaire nommait aussi KoboToolbox, et c'est par là que le défaut
   d'en-tête se manifestait : l'administrateur suivait l'invitation, déclarait son
   Kobo en nature « http », et cette voie partait en `Bearer` alors que Kobo
   attend `Token`. Kobo a désormais son lecteur, juste en dessous. */
export async function lireJsonHttp({ baseUrl, chemin = "", porteur, pointeur = "", limite = 100 } = {}){
  const u = await verifierBaseSortante(baseUrl, "la source HTTP");
  const base = u.toString().replace(/\/+$/, "");
  const suffixe = String(chemin || "");
  const url = new URL(base + (suffixe && !suffixe.startsWith("/") ? "/" + suffixe : suffixe));

  const res = await appeler(url.toString(), porteur, "application/json, text/csv");
  const texte = await texteBorne(res);
  const typeReponse = (res.headers.get("content-type") || "").toLowerCase();
  if(typeReponse.includes("csv")) return { rows: lireCsv(texte, Number(limite) || 100), format: "CSV" };
  let payload;
  try{ payload = JSON.parse(texte); }
  catch(e){ throw refus("réponse de la source illisible : ni JSON valide, ni CSV annoncé.", "SOURCE_HTTP"); }
  return { rows: extraireLignes(payload, pointeur).slice(0, Number(limite) || 100), format: "JSON" };
}

/* ── KoboToolbox ──────────────────────────────────────────────────────
   La nature « kobo » était déclarable depuis la migration 016 mais n'allait
   chercher nulle part : elle exigeait une adresse de base dont aucun code ne se
   servait, et l'aperçu la refusait en disant qu'elle « n'est pas lue par le
   serveur ». C'était le pire des deux mondes — un administrateur configurait une
   source qui ne serait jamais lue. Il ne lui manquait que le bon en-tête et le
   bon chemin ; les voici.

   ⚠ CE QUI EST SUPPOSÉ. Le chemin est celui du dépôt kobotoolbox/kpi
   d'aujourd'hui : kpi/urls/router_api_v2.py enregistre `assets`, puis `data` en
   route imbriquée, sous le préfixe `api/v2/` de kpi/urls/__init__.py. Une
   instance auto-hébergée figée sur une version ancienne peut différer — d'où
   `config.chemin`, réglable par connecteur, exactement comme
   `CHEMIN_FOUNDRY_DEFAUT`. L'API v1 (kobocat), elle, n'est pas une solution de
   repli : kobo/urls.py la route vers `v1_api_gone_view`, qui répond 410.

   La pagination de Kobo n'est pas celle d'ODK : `{count, next, previous, results}`
   avec `limit` et `start` (kpi/paginators.py, DefaultPagination sur
   LimitOffsetPagination ; plafond MAX_API_PAGE_SIZE = 1000). Un aperçu ne suit
   PAS `next` : d'une part il ne lit que quelques lignes, d'autre part ce lien est
   une URL absolue fabriquée par la source, donc à revérifier — la même trappe que
   celle refermée sur `@odata.nextLink` (lib/odkClient.js). Un import complet, le
   jour où il existera, devra la suivre et la revérifier. */
export const CHEMIN_DONNEES_KOBO_DEFAUT = "/api/v2/assets/{uid}/data/";
/* L'API historique, celle des déploiements ONA/kobocat comme la MoDa du PAM
   (moda.wfp.org). Elle NE répond PAS 410 sur ces instances — c'est la seule que
   MoDa expose : `GET /api/v1/data/{id}` où l'identifiant est le NUMÉRO du
   formulaire (ex. 340943), pas l'uid d'un asset. La réponse est un tableau JSON
   direct, sans l'emballage {count, results} du paginateur v2. Le justificatif y
   est le même jeton `Token …`. On ne devine pas la version : l'administrateur la
   choisit (config.apiVersion), parce qu'une même adresse peut servir les deux et
   que seul lui sait laquelle son instance honore. */
export const CHEMIN_DONNEES_KOBO_V1_DEFAUT = "/api/v1/data/{formId}";
const PLAFOND_KOBO = 1000;

export async function lireKobo({ baseUrl, uid, formId, apiVersion = "v2", porteur,
  chemin, pointeur = "", limite = 100 } = {}){

  const v1 = apiVersion === "v1";
  const identifiant = v1 ? formId : uid;
  if(!identifiant) throw refus(v1
    ? "numéro du formulaire MoDa/Kobo v1 absent : renseignez-le dans la configuration du connecteur. "
      + "L'API v1 désigne un formulaire par son NUMÉRO (celui de l'adresse …/api/v1/data/340943)."
    : "identifiant du formulaire Kobo (uid de l'asset) absent : renseignez-le dans la configuration "
      + "du connecteur. KoboToolbox n'a pas de « projet » au sens d'ODK Central — un formulaire y est "
      + "désigné par son seul uid.", "SOURCE_CONFIG");
  const u = await verifierBaseSortante(baseUrl, v1 ? "le serveur MoDa/Kobo (API v1)" : "le serveur KoboToolbox");

  const base = u.toString().replace(/\/+$/, "");
  const gabarit = String(chemin || (v1 ? CHEMIN_DONNEES_KOBO_V1_DEFAUT : CHEMIN_DONNEES_KOBO_DEFAUT));
  const suffixe = gabarit.replace("{uid}", encodeURIComponent(uid || ""))
                         .replace("{formId}", encodeURIComponent(formId || ""));
  const url = new URL(base + (suffixe.startsWith("/") ? suffixe : "/" + suffixe));
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(Math.min(Math.max(1, Number(limite) || 100), PLAFOND_KOBO)));

  const res = await appeler(url.toString(), porteur, "application/json");
  const texte = await texteBorne(res);
  let payload;
  try{ payload = JSON.parse(texte); }
  catch(e){ throw refus("réponse de KoboToolbox illisible : ce n'est pas du JSON valide.", "SOURCE_HTTP"); }
  /* v2 : `results` est la clé du paginateur ; `extraireLignes` la connaît déjà.
     v1 : la réponse est un tableau JSON direct, que `extraireLignes` rend tel quel.
     Le pointeur reste disponible pour une instance qui emballerait autrement. */
  return { rows: extraireLignes(payload, pointeur).slice(0, Number(limite) || 100), format: "JSON",
           total: Number.isFinite(payload?.count) ? payload.count : null };
}
