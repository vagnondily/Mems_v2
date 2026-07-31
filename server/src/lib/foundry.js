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

const TIMEOUT_MS = 20_000;
/* Un aperçu lit quelques lignes, pas un dataset entier : le plafond protège la
   mémoire du serveur contre une source qui répondrait un fichier de plusieurs
   gigaoctets, et il est vérifié pendant la lecture, pas après. */
const MAX_OCTETS = 8 * 1024 * 1024;
const MAX_LIGNES = 5_000;

/* Le chemin documenté de la lecture d'un dataset Foundry. Surchargeable par
   connecteur : voir l'avertissement en tête de fichier. */
export const CHEMIN_FOUNDRY_DEFAUT = "/api/v2/datasets/{rid}/readTable";

const refus = (message, code = "SOURCE_URL") => { const e = new Error(message); e.code = code; return e; };

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

async function appeler(url, token, accept){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try{
    res = await fetch(url, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: accept,
      },
      signal: ac.signal,
      redirect: "manual",     /* une redirection sortirait de l'hôte vérifié */
    });
  }catch(e){
    throw refus(e.name === "AbortError" ? "délai dépassé" : e.message, "SOURCE_NETWORK");
  }finally{ clearTimeout(timer); }

  if(res.status >= 300 && res.status < 400) throw refus(
    "la source répond par une redirection : le serveur ne la suit pas, car elle mènerait "
    + "vers un hôte qui n'a pas été vérifié. Indiquez l'adresse finale.", "SOURCE_HTTP");
  if(res.status === 401 || res.status === 403) throw refus(
    "accès refusé par la source : jeton absent, expiré, ou sans droit sur ce jeu de données.",
    "SOURCE_AUTH");
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
export async function lireDatasetFoundry({ baseUrl, datasetRid, token, branche = "master",
  limite = 100, format = "CSV", chemin = CHEMIN_FOUNDRY_DEFAUT, colonnes = [], pointeur = "" } = {}){

  if(!datasetRid) throw refus(
    "identifiant du jeu de données (RID) absent : renseignez-le dans la configuration du connecteur.",
    "SOURCE_CONFIG");
  const u = await verifierBaseSortante(baseUrl, "l'instance Foundry");

  const base = u.toString().replace(/\/+$/, "");
  const suffixe = String(chemin || CHEMIN_FOUNDRY_DEFAUT)
    .replace("{rid}", encodeURIComponent(datasetRid));
  const url = new URL(base + (suffixe.startsWith("/") ? suffixe : "/" + suffixe));
  url.searchParams.set("format", format);
  if(branche) url.searchParams.set("branchName", branche);
  url.searchParams.set("rowLimit", String(Math.min(Math.max(1, Number(limite) || 100), MAX_LIGNES)));
  if(colonnes.length) url.searchParams.set("columns", colonnes.join(","));

  const res = await appeler(url.toString(), token,
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
   Toute API qui rend du JSON ou du CSV : l'export d'un partenaire, un
   KoboToolbox derrière son API, un service interne. Aucune connaissance du
   produit distant, aucune pagination — un aperçu, pas un import. */
export async function lireJsonHttp({ baseUrl, chemin = "", token, pointeur = "", limite = 100 } = {}){
  const u = await verifierBaseSortante(baseUrl, "la source HTTP");
  const base = u.toString().replace(/\/+$/, "");
  const suffixe = String(chemin || "");
  const url = new URL(base + (suffixe && !suffixe.startsWith("/") ? "/" + suffixe : suffixe));

  const res = await appeler(url.toString(), token, "application/json, text/csv");
  const texte = await texteBorne(res);
  const typeReponse = (res.headers.get("content-type") || "").toLowerCase();
  if(typeReponse.includes("csv")) return { rows: lireCsv(texte, Number(limite) || 100), format: "CSV" };
  let payload;
  try{ payload = JSON.parse(texte); }
  catch(e){ throw refus("réponse de la source illisible : ni JSON valide, ni CSV annoncé.", "SOURCE_HTTP"); }
  return { rows: extraireLignes(payload, pointeur).slice(0, Number(limite) || 100), format: "JSON" };
}
