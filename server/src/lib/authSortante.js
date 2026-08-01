/* ═══════════════════════════════════════════════════════════════════════
   L'AUTHENTIFICATION SORTANTE — le seul endroit qui sache fabriquer un
   en-tête `Authorization` pour une source extérieure.

   ── Pourquoi ce module existe ─────────────────────────────────────────

   Tout l'accès sortant de MEMS supposait un schéma unique, `Bearer <jeton>`,
   écrit en dur à deux endroits : lib/odkClient.js pour le tirage ODK,
   lib/foundry.js pour les connecteurs. C'était une hypothèse déguisée en règle
   du monde, et elle est fausse deux fois :

     — KoboToolbox emploie le mot-clé `Token`, pas `Bearer`. Un jeton Kobo
       parfaitement valide présenté en `Bearer` revient en 401, et le message
       rendu accusait alors le jeton.
     — ODK Central ne délivre pas de jeton permanent à un compte web. Il délivre
       une SESSION qui expire. Le seul justificatif que MEMS savait stocker était
       ce jeton de session, collé à la main : il fallait donc le recoller à chaque
       expiration, ce qui rendait le tirage automatique illusoire.

   D'où la règle posée ici : le schéma d'authentification est une DONNÉE de la
   source (`auth_schema`, migration 021), pas une constante du code. En ajouter
   un est une entrée dans SCHEMAS_AUTH ci-dessous — exactement comme ajouter un
   interpréteur est une entrée dans INTERPRETEURS (lib/moteur.js) ou une
   transformation une entrée dans TRANSFORMATIONS (lib/mapping.js). Rien
   d'autre dans le serveur ne connaît le mot « Bearer ».

   ── Deux secrets, et non un ───────────────────────────────────────────

   Le JUSTIFICATIF DURABLE se saisit et reste où il était : `odk_forms.token_enc`
   et `connector.secret_enc`, chiffrés par lib/crypto.js. C'est un jeton collé, un
   jeton d'API permanent, ou un mot de passe.

   Le SECOND SECRET ne se saisit jamais : il se fabrique à partir du premier, se
   met en cache dans `source_session`, et se renouvelle tout seul avant son
   échéance — et aussi sur un 401, parce qu'une date d'expiration annoncée peut
   mentir. Deux schémas en dérivent un : `odk_session` (le jeton expire) et
   `kobo_jeton` (il n'expire pas). La table sait exprimer les deux.

   ── CE QUI N'A PAS PU ÊTRE VÉRIFIÉ ────────────────────────────────────

   Aucune instance réelle, ni ODK Central ni KoboToolbox, n'était joignable
   depuis cet environnement : la documentation publique de ces deux produits est
   refusée par le mandataire (403 sur CONNECT). Ce qui suit a été établi en
   lisant le CODE SOURCE des deux produits (getodk/central-backend, branche
   master ; kobotoolbox/kpi, branche main ; encode/django-rest-framework), pas
   leur documentation, et pas de mémoire. Les fichiers exacts sont cités au-dessus
   de chaque valeur. Une instance ancienne ou auto-hébergée peut différer : tous
   les CHEMINS sont donc surchargeables par source, sur le même principe et pour
   la même raison que `CHEMIN_FOUNDRY_DEFAUT` (lib/foundry.js). Une supposition
   avouée est utilisable ; une supposition déguisée en fait ne l'est pas.
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";
import { encrypt, decrypt } from "./crypto.js";
import { log } from "./logger.js";

/* ── Chemins par défaut, tous surchargeables ──────────────────────────
   Établi par getodk/central-backend, lib/resources/sessions.js :
   `service.post('/sessions', ...)`, et lib/http/middleware.js impose le préfixe
   `/v1` (404.2 sans lui). */
export const CHEMIN_SESSION_ODK_DEFAUT = "/v1/sessions";
/* Établi par getodk/central-backend, lib/resources/users.js :
   `service.get('/users/current', ...)` — « Returns the currently authed actor. »
   Le point d'entrée le moins cher pour éprouver un justificatif : il ne touche
   ni formulaire ni donnée. */
export const CHEMIN_EPREUVE_ODK_DEFAUT = "/v1/users/current";
/* Établi par kobotoolbox/kpi, kpi/urls/__init__.py : `path('token/', TokenView…)`.
   Ce n'est PAS sous /api/v2/. Le `?format=json` est la forme que la documentation
   publique donne en exemple ; il est inoffensif si l'instance l'ignore. */
export const CHEMIN_JETON_KOBO_DEFAUT = "/token/?format=json";
/* Établi par kobotoolbox/kpi, kpi/urls/__init__.py : `path('me/', CurrentUserViewSet…)`.
   Le pendant Kobo de `/v1/users/current`. */
export const CHEMIN_EPREUVE_KOBO_DEFAUT = "/me/";

const refus = (code, cause, message, motif) => {
  const e = new Error(message);
  e.code = code; e.causeAuth = cause; if(motif) e.motifAuth = motif;
  return e;
};

/* Un refus PRONONCÉ par la source — elle a répondu, et elle a dit non — par
   opposition à un silence : délai dépassé, connexion refusée, coupure. La
   distinction n'est pas cosmétique, c'est elle qui décide si l'on a le droit de
   détruire une session encore valable et de bloquer la source cinq minutes.
   Une panne d'une seconde chez la source ne prouve rien sur le justificatif. */
const refusSource = (cause, message, motif) => {
  const e = refus("AUTH", cause, message, motif);
  e.refusDeLaSource = true;
  return e;
};

/* ═══════════════════════════════════════════════════════════════════════
   LA TABLE DES SCHÉMAS

   Chaque entrée dit quatre choses, et rien d'autre dans le module ne connaît de
   cas particulier :
     `champs`     — ce que l'écran de déclaration doit demander ;
     `ou_trouver` — où l'administrateur récupère ce justificatif CHEZ LA SOURCE ;
     `enTete`     — l'en-tête à émettre ;
     `session`    — comment dériver un second secret, quand il y en a un.
   `libelle` et `note` sont en français et destinés à l'écran, comme le `label`
   et la `note` des transformations de lib/mapping.js.
   ═══════════════════════════════════════════════════════════════════════ */

/* `masque` dit que le champ ne doit pas s'afficher en clair à la saisie ; il ne
   nomme PAS un type d'élément HTML. La nuance a une raison très concrète : la
   table est servie au navigateur, et une valeur « password » y ferait apparaître
   la chaîne `"password"` dans une réponse d'API — soit exactement ce que le
   balayage anti-fuite recherche. Une alarme qui sonne à tort finit désactivée. */
const CHAMP_JETON = { cle:"justificatif", label:"Jeton d'accès", masque:true, requis:true };
const CHAMP_IDENTIFIANT = { cle:"identifiant", label:"Identifiant", masque:false, requis:true };
const CHAMP_MOT_DE_PASSE = { cle:"justificatif", label:"Mot de passe", masque:true, requis:true };

export const SCHEMAS_AUTH = {
  /* Ce schéma existe parce que le code d'avant faisait déjà cela — sans le dire.
     `lib/foundry.js` n'ajoutait aucun en-tête quand le jeton manquait : une source
     publique fonctionnait, mais une source privée mal configurée partait elle
     aussi sans rien et revenait en 401, et MEMS ne savait même pas qu'il n'avait
     rien eu à présenter. Le rendre explicite sépare les deux cas : « pas de
     justificatif parce qu'il n'en faut pas » est une déclaration, « pas de
     justificatif alors qu'il en faut un » est refusé avant de sortir. */
  aucun: {
    libelle: "Aucune (source publique)",
    motCle: "",
    note: "Aucun en-tête d'autorisation n'est émis. À réserver aux sources réellement ouvertes : "
      + "si la source en attend un, le refus arrivera côté source, pas côté MEMS.",
    ou_trouver: "Rien à saisir.",
    champs: [],
    refus401: "cette source est déclarée sans justificatif, et la source en réclame un.",
    enTete: () => ({}),
  },

  porteur: {
    libelle: "Porteur (Bearer)",
    motCle: "Bearer",
    note: "Le jeton part tel quel dans « Authorization: Bearer <jeton> ». C'est le schéma "
      + "d'ODK Central et de la plupart des API d'entreprise. Attention : chez ODK Central un "
      + "jeton collé à la main est un jeton de SESSION, qui expire — préférez le schéma "
      + "« Session ODK Central » pour que MEMS le renouvelle lui-même.",
    ou_trouver: "Chez ODK Central, un jeton de session s'obtient en se connectant à l'interface "
      + "web ; ailleurs, dans les réglages du compte de service de la source.",
    champs: [CHAMP_JETON],
    /* La cause la plus probable d'un 401 sous ce schéma, quand rien dans la
       réponse ne permet de trancher. Elle vit dans la table parce que c'est une
       propriété du schéma, pas du chemin d'appel qui s'en sert. */
    refus401: "un jeton collé à la main est, chez ODK Central, un jeton de SESSION : il expire "
      + "(24 h par défaut, réglable par l'exploitant du serveur). Enregistrez plutôt le courriel "
      + "et le mot de passe d'un compte avec le schéma « Session ODK Central » — MEMS renouvellera "
      + "alors la session tout seul.",
    enTete: (j) => ({ Authorization: `Bearer ${j.justificatif}` }),
  },

  jeton: {
    libelle: "Jeton (Token)",
    motCle: "Token",
    note: "Le jeton part dans « Authorization: Token <jeton> ». C'est le schéma de KoboToolbox "
      + "et, plus largement, de toute API bâtie sur Django REST Framework. Présenté en « Bearer », "
      + "un jeton pourtant valide est refusé : le serveur ne reconnaît pas le mot-clé.",
    ou_trouver: "KoboToolbox : votre clé d'API se récupère sur « <adresse de votre serveur>/token/ » "
      + "une fois connecté. Elle n'expire pas ; elle se révoque.",
    champs: [CHAMP_JETON],
    refus401: "la source a reconnu le schéma mais refuse ce justificatif. Un jeton d'API Kobo "
      + "n'expire pas : s'il est refusé, c'est qu'il a été révoqué, mal recopié, ou qu'il "
      + "appartient à un autre déploiement que celui indiqué en adresse de base.",
    enTete: (j) => ({ Authorization: `Token ${j.justificatif}` }),
  },

  basique: {
    libelle: "Basique (Basic)",
    motCle: "Basic",
    note: "Identifiant et mot de passe, encodés en base64 dans l'en-tête. À réserver aux sources "
      + "qui n'offrent rien d'autre : le mot de passe est revérifié à chaque requête, ce qui coûte "
      + "des centaines de millisecondes par appel, et il voyage à chaque fois. ODK Central "
      + "l'accepte mais le déconseille, et le refuse purement et simplement hors https "
      + "ou quand l'instance est passée sous OIDC.",
    ou_trouver: "Les identifiants de connexion du compte de service, tels que la source vous les a "
      + "communiqués. Ce compte doit avoir le droit de LIRE les données, pas seulement d'en déposer.",
    champs: [CHAMP_IDENTIFIANT, CHAMP_MOT_DE_PASSE],
    refus401: "l'identifiant ou le mot de passe est refusé par la source. Vérifiez aussi que "
      + "l'authentification basique n'est pas désactivée sur cette instance : ODK Central la ferme "
      + "hors https et lorsqu'elle est configurée en OIDC, et KoboToolbox la ferme dès que le compte "
      + "a l'authentification à deux facteurs.",
    enTete: (j) => ({
      Authorization: "Basic " + Buffer.from(`${j.identifiant}:${j.justificatif}`, "utf8").toString("base64"),
    }),
  },

  /* ── Les deux schémas qui dérivent un second secret ───────────────── */

  odk_session: {
    libelle: "Session ODK Central (courriel et mot de passe)",
    motCle: "Bearer",
    note: "MEMS échange le courriel et le mot de passe d'un compte ODK Central contre une SESSION, "
      + "qu'il met en cache et renouvelle tout seul avant son échéance — et aussi quand le serveur "
      + "répond 401, parce qu'une date annoncée peut mentir. C'est la seule façon d'automatiser le "
      + "tirage : le jeton d'un « App User » ne sait que déposer des soumissions, il ne peut pas "
      + "les lire. Ce schéma n'existe pas sur une instance passée sous OIDC : collez-y un jeton de "
      + "session avec le schéma « Porteur ».",
    ou_trouver: "Les identifiants d'un compte web ODK Central ayant le droit de lire ce projet. "
      + "MEMS ne stocke que le mot de passe, chiffré ; il ne le renvoie jamais, même partiellement.",
    champs: [
      { ...CHAMP_IDENTIFIANT, label: "Courriel du compte ODK Central" },
      CHAMP_MOT_DE_PASSE,
    ],
    refus401: "la session vient d'être ouverte et pourtant la source refuse l'appel.",
    enTete: (j) => SCHEMAS_AUTH.porteur.enTete(j),
    session: {
      perissable: true,
      schemaDerive: "porteur",
      cheminDefaut: CHEMIN_SESSION_ODK_DEFAUT,
      libelleChemin: "Chemin d'ouverture de session",
      /* getodk/central-backend, lib/model/frames.js : la trame Session déclare
         `token`, `csrf`, `expiresAt` et `createdAt` comme lisibles (`actorId` ne
         l'est pas). La lecture reste tolérante — une instance ancienne pourrait
         nommer autrement — mais l'absence de jeton est une erreur franche, jamais
         un silence. */
      async obtenir({ base, chemin, identifiant, secret }){
        const res = await fetchBorne(base + normaliserChemin(chemin), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email: identifiant, password: secret }),
        });
        if(res.status === 401 || res.status === 403) throw refusSource("AUTH_SESSION",
          "ODK Central refuse ce couple courriel / mot de passe",
          "courriel ou mot de passe refusé par ODK Central");
        if(res.status === 404) throw refusSource("AUTH_SESSION",
          `ODK Central ne connaît pas le chemin « ${chemin} »`,
          `chemin d'ouverture de session introuvable (${chemin}) : une instance sous OIDC ne `
          + "propose pas cette route, et un serveur ancien peut la placer ailleurs");
        if(!res.ok) throw refusSource("AUTH_SESSION",
          `ODK Central a répondu ${res.status} à l'ouverture de session`,
          `ouverture de session refusée (HTTP ${res.status})`);
        const corps = await corpsJson(res);
        const jeton = corps?.token || corps?.jeton || corps?.access_token;
        if(!jeton) throw refusSource("AUTH_SESSION",
          "la réponse d'ODK Central ne porte aucun jeton de session",
          "réponse d'ouverture de session sans jeton : forme inattendue");
        return { jeton, expireLe: corps?.expiresAt || corps?.expires_at || null };
      },
    },
  },

  kobo_jeton: {
    libelle: "Jeton KoboToolbox obtenu par identifiants",
    motCle: "Token",
    note: "MEMS échange l'identifiant et le mot de passe contre la clé d'API du compte, puis la "
      + "présente en « Token ». Contrairement à la session ODK, cette clé N'EXPIRE PAS : elle est "
      + "obtenue une fois et gardée jusqu'à révocation. À n'employer que si vous préférez ne pas "
      + "manipuler la clé vous-même — l'échange est refusé dès que le compte a l'authentification "
      + "à deux facteurs, auquel cas collez la clé avec le schéma « Jeton ».",
    ou_trouver: "Les identifiants de connexion à votre serveur KoboToolbox.",
    champs: [CHAMP_IDENTIFIANT, CHAMP_MOT_DE_PASSE],
    refus401: "la clé d'API vient d'être obtenue et pourtant la source refuse l'appel.",
    enTete: (j) => SCHEMAS_AUTH.jeton.enTete(j),
    session: {
      /* Le second secret ne périme pas : c'est précisément ce que la table doit
         savoir dire, et ce qui distingue Kobo d'ODK Central. */
      perissable: false,
      schemaDerive: "jeton",
      cheminDefaut: CHEMIN_JETON_KOBO_DEFAUT,
      libelleChemin: "Chemin d'obtention de la clé d'API",
      /* kobotoolbox/kpi, kpi/views/token.py : `TokenView.get` rend `{'token': key}`.
         L'appel se fait en authentification BASIC — kobo/settings/base.py inscrit
         `kpi.authentication.BasicAuthentication` dans DEFAULT_AUTHENTICATION_CLASSES. */
      async obtenir({ base, chemin, identifiant, secret }){
        const res = await fetchBorne(base + normaliserChemin(chemin), {
          method: "GET",
          headers: { ...SCHEMAS_AUTH.basique.enTete({ identifiant, justificatif: secret }),
                     Accept: "application/json" },
        });
        if(res.status === 401 || res.status === 403) throw refusSource("AUTH_SESSION",
          "KoboToolbox refuse ce couple identifiant / mot de passe",
          "identifiants refusés par KoboToolbox — l'authentification basique y est fermée dès "
          + "que le compte a l'authentification à deux facteurs");
        if(!res.ok) throw refusSource("AUTH_SESSION",
          `KoboToolbox a répondu ${res.status} à la demande de clé d'API`,
          `demande de clé d'API refusée (HTTP ${res.status}) : vérifiez le chemin « ${chemin} »`);
        const corps = await corpsJson(res);
        const jeton = corps?.token || corps?.key;
        if(!jeton) throw refusSource("AUTH_SESSION",
          "la réponse de KoboToolbox ne porte aucune clé d'API",
          "réponse sans clé d'API : forme inattendue");
        return { jeton, expireLe: null };
      },
    },
  },
};

export const NOMS_SCHEMAS_AUTH = Object.keys(SCHEMAS_AUTH);

/* La forme servie à l'écran de déclaration d'une source. L'écran n'en tient
   aucune copie, pour la même raison que pour le registre des champs et le jeu
   des transformations : deux listes finissent par diverger, et c'est toujours
   l'écran qui propose ce que le serveur refuse. */
export const schemasAuthPublics = () => NOMS_SCHEMAS_AUTH.map(cle => {
  const d = SCHEMAS_AUTH[cle];
  return {
    cle, libelle: d.libelle, note: d.note, ou_trouver: d.ou_trouver, motCle: d.motCle,
    champs: d.champs.map(c => ({ ...c })),
    derive: !!d.session,
    perissable: !!d.session?.perissable,
    chemin: d.session ? { defaut: d.session.cheminDefaut, label: d.session.libelleChemin } : null,
  };
});

/* ═══════════════════════════════════════════════════════════════════════
   LES CAUSES D'ÉCHEC

   Le message d'avant en confondait cinq : « jeton absent, expiré, ou sans droit
   sur ce jeu de données » énumérait trois causes qu'il ne savait pas départager,
   et en ignorait deux. Chacune a désormais son code et son message.

   AUTH_REFUS mérite son existence : c'est le refus dont la cause n'est PAS
   déterminable. Rien ne garantit qu'un serveur réponde 401 plutôt que 403 quand
   le mot-clé est mauvais mais le jeton bon, ni qu'il rende un `WWW-Authenticate`
   exploitable. Sans ce code, il faudrait choisir une des cinq causes au hasard
   et l'affirmer — c'est-à-dire refaire exactement le défaut qu'on corrige.
   ═══════════════════════════════════════════════════════════════════════ */
export const CAUSES_AUTH = {
  AUTH_ABSENT:  "aucun justificatif enregistré pour cette source",
  AUTH_ILLISIBLE: "le justificatif enregistré ne peut pas être déchiffré",
  AUTH_SCHEMA:  "le schéma d'authentification ne convient pas à cette source",
  AUTH_SESSION: "la session a expiré ou n'a pas pu être ouverte",
  AUTH_DROITS:  "justificatif accepté, mais droits insuffisants",
  AUTH_HOTE:    "l'hôte est refusé par la politique de sortie du serveur",
  AUTH_REFUS:   "la source refuse sans préciser la cause",
};

/* Ce qu'on accepte de dire d'un secret, et rien de plus. La maison ne rendait
   jusqu'ici que sa présence (`hasToken`, `hasSecret`) ; la longueur est ajoutée
   ici parce qu'elle diagnostique réellement — une clé Kobo tronquée au copier-
   coller se voit à sa longueur. Les quatre derniers caractères, eux, ne
   diagnostiquent rien qu'une longueur ne dise déjà : ils ne sortent pas.

   `lisible` sépare deux états que « présent » confondait, et qui appellent des
   gestes opposés : un justificatif enregistré qu'on n'arrive pas à déchiffrer
   demande de restaurer la clé de chiffrement, pas de ressaisir le secret. Sans
   lui, l'écran affichait « présent, 0 caractère », c'est-à-dire deux choses qui
   ne peuvent pas être vraies ensemble. */
export const indicesSecret = (secret, present = !!secret) => ({
  present: !!present,
  longueur: secret ? String(secret).length : 0,
  lisible: !present || !!secret,
});

/* ═══════════════════════════════════════════════════════════════════════
   Lectures bornées

   Un corps de réponse vient de l'extérieur : le lire sans plafond, c'est offrir
   sa mémoire. Le plafond est bien plus bas que celui de lib/foundry.js (8 Mo)
   parce que ce qu'on lit ici n'est pas de la donnée mais un diagnostic : une
   réponse d'erreur ou un jeton tiennent dans quelques centaines d'octets.
   ═══════════════════════════════════════════════════════════════════════ */
const MAX_DIAGNOSTIC = 8 * 1024;

/* Lève si la lecture est interrompue — délai dépassé, connexion coupée. Elle
   rendait auparavant le fragment déjà lu, ce qui faisait passer une réponse
   tronquée par le délai pour une réponse complète et mal formée : deux pannes
   très différentes sous un seul message. */
async function corpsBorne(res, max = MAX_DIAGNOSTIC){
  if(!res.body) return "";
  const lecteur = res.body.getReader();
  const decodeur = new TextDecoder("utf-8");
  let texte = "", octets = 0;
  for(;;){
    const { done, value } = await lecteur.read();
    if(done) break;
    octets += value.byteLength;
    texte += decodeur.decode(value, { stream:true });
    if(octets > max){ await lecteur.cancel(); break; }
  }
  return texte + decodeur.decode();
}

/* Le corps d'une réponse en JSON, ou null. Deux formes arrivent ici : la réponse
   bornée que `fetchBorne` rend — corps déjà lu sous son délai — et la `Response`
   nue des deux autres chemins sortants (lib/odkClient.js, lib/foundry.js), qui
   mènent leur propre appel et confient seulement le diagnostic à ce module. */
async function corpsJson(res){
  try{
    if(typeof res?.texte === "string") return JSON.parse(res.texte);
    return JSON.parse(await corpsBorne(res));
  }catch(e){ return null; }
}

const normaliserChemin = (c) => {
  const s = String(c || "");
  return s.startsWith("/") ? s : "/" + s;
};

/* Le `fetch` de ce module : celui qui va chercher un second secret, et celui de
   l'épreuve de connexion. Il pose les mêmes gardes que les deux autres chemins
   sortants — délai borné, et `redirect: "manual"` parce qu'une redirection
   sortirait de l'hôte vérifié, emportant avec elle le mot de passe qu'on est en
   train de présenter.

   Il rend une réponse dont le CORPS EST DÉJÀ LU, et c'est le point important :
   le délai désarmé à l'arrivée des en-têtes ne borne que la moitié de l'échange.
   Une source qui répond « 200 » puis n'achève jamais son corps figeait alors la
   promesse pour toujours ; comme l'ouverture de session est partagée entre les
   appelants (`enVol` plus bas), elle figeait avec elle toutes les demandes
   suivantes sur cette source, jusqu'au redémarrage du serveur. Un délai qui ne
   couvre pas la lecture du corps n'est pas un délai. */
async function fetchBorne(url, options){
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.authSortante.delaiMs);
  try{
    const res = await fetch(url, { ...options, signal: ac.signal, redirect: "manual" });
    if(res.status >= 300 && res.status < 400) throw refus("AUTH", "AUTH_HOTE",
      "la source répond par une redirection", "la source redirige la demande de justificatif : "
      + "le serveur ne suit pas, car la redirection mènerait vers un hôte non vérifié");
    return { status: res.status, ok: res.ok, headers: res.headers,
             texte: await corpsBorne(res) };
  }catch(e){
    if(e.causeAuth) throw e;
    throw refus("AUTH", "AUTH_SESSION",
      e.name === "AbortError" ? "délai dépassé" : e.message,
      e.name === "AbortError" ? "délai dépassé en joignant la source" : `source injoignable : ${e.message}`);
  }finally{ clearTimeout(timer); }
}

/* ═══════════════════════════════════════════════════════════════════════
   LE CACHE DES SECONDS SECRETS

   `empreinte` est un HMAC-SHA256 du justificatif durable, clé par la clé de
   chiffrement des données. Il répond à une question et une seule : « ce cache
   a-t-il été rempli avec CE justificatif-là ? » Dès qu'un administrateur change
   le mot de passe ou le schéma, l'empreinte ne correspond plus, la session en
   cache cesse d'être servie ET le blocage après échec tombe. Autrement dit,
   corriger son mot de passe débloque sur-le-champ, sans qu'aucune route n'ait à
   penser à vider ce cache — ce à quoi on finit toujours par oublier de penser
   quelque part.
   ═══════════════════════════════════════════════════════════════════════ */
const empreinteDe = (schema, identifiant, secret) =>
  crypto.createHmac("sha256", config.dataKey)
    .update(JSON.stringify([schema, identifiant || "", secret || ""]), "utf8")
    .digest("hex");

const ligneSession = (p) => db.prepare(
  "SELECT * FROM source_session WHERE source_kind=? AND source_id=?").get(p.nature, p.id);

function ecrireSession(p, { jeton, expireLe }){
  db.prepare(`INSERT INTO source_session
      (source_kind,source_id,jeton_enc,expire_le,obtenu_le,echec_le,echec_motif,empreinte)
      VALUES (?,?,?,?,?,NULL,NULL,?)
      ON CONFLICT(source_kind,source_id) DO UPDATE SET
        jeton_enc=excluded.jeton_enc, expire_le=excluded.expire_le,
        obtenu_le=excluded.obtenu_le, echec_le=NULL, echec_motif=NULL,
        empreinte=excluded.empreinte`)
    .run(p.nature, p.id, encrypt(jeton), expireLe || null, new Date().toISOString(), p.empreinte);
}

function ecrireEchec(p, motif){
  db.prepare(`INSERT INTO source_session
      (source_kind,source_id,jeton_enc,expire_le,obtenu_le,echec_le,echec_motif,empreinte)
      VALUES (?,?,NULL,NULL,NULL,?,?,?)
      ON CONFLICT(source_kind,source_id) DO UPDATE SET
        jeton_enc=NULL, expire_le=NULL, echec_le=excluded.echec_le,
        echec_motif=excluded.echec_motif, empreinte=excluded.empreinte`)
    .run(p.nature, p.id, new Date().toISOString(), String(motif).slice(0, 400), p.empreinte);
}

/* L'état du cache pour ce justificatif-ci : un jeton utilisable, un blocage
   motivé, ou rien. Trois réponses distinctes, parce que « rien en cache » et
   « on vient d'échouer » n'appellent pas la même suite.

   La marge de renouvellement n'est pas appliquée telle quelle, et il y a une
   raison précise : quand la source annonce une durée de vie PLUS COURTE que la
   marge — `sessionLifetime` réglé court chez l'exploitant ODK, ou une session
   d'une minute — un jeton naît déjà « dans la marge », donc périmé aux yeux du
   cache, et MEMS rouvre une session à CHAQUE appel sortant. Un tirage de
   cinquante pages ouvrait alors cinquante sessions, chacune coûtant une
   vérification de mot de passe chez la source : le martèlement même que le
   blocage après échec existe pour empêcher. La marge est donc plafonnée à la
   moitié de la durée de vie annoncée, et une ouverture toute fraîche est servie
   quoi qu'il arrive. Le filet reste le 401 : il déclenche un renouvellement
   unique, qui ne passe pas par ici. */
function etatCache(p){
  const row = ligneSession(p);
  if(!row || row.empreinte !== p.empreinte) return { etat: "vide" };
  if(row.echec_le){
    const depuis = Date.now() - Date.parse(row.echec_le);
    if(Number.isFinite(depuis) && depuis < config.authSortante.delaiApresEchecMs)
      return { etat: "bloque", motif: row.echec_motif || "cause non consignée", echecLe: row.echec_le };
    return { etat: "vide" };
  }
  const jeton = row.jeton_enc ? decrypt(row.jeton_enc) : null;
  if(!jeton) return { etat: "vide" };
  const valide = { etat: "valide", jeton, expireLe: row.expire_le, obtenuLe: row.obtenu_le };
  if(!row.expire_le) return valide;

  const echeance = Date.parse(row.expire_le);
  /* Une échéance illisible n'est pas une échéance passée. `obtenir` n'écrit
     désormais que des dates analysables, mais une ligne écrite par une version
     antérieure peut encore en porter une : la traiter comme « périmée » ferait
     exactement la rafale décrite au-dessus, sans que rien ne la signale. */
  if(!Number.isFinite(echeance)) return valide;
  const reste = echeance - Date.now();
  if(reste <= 0) return { etat: "vide" };

  const obtenu = Date.parse(row.obtenu_le || "");
  const depuisOuverture = Number.isFinite(obtenu) ? Date.now() - obtenu : Infinity;
  if(depuisOuverture < config.authSortante.plancherOuvertureMs) return valide;
  const vie = Number.isFinite(obtenu) ? echeance - obtenu : Infinity;
  const marge = Math.min(config.authSortante.margeMs, Math.floor(vie / 2));
  return reste <= marge ? { etat: "vide" } : valide;
}

/* Une seule ouverture de session à la fois par source. On mémorise la PROMESSE
   en cours, pas son résultat : deux tirages simultanés attendent alors la même,
   et la source ne voit ouvrir qu'une session au lieu de deux.

   L'empreinte fait partie de la clé, et ce n'est pas une précaution de plus :
   sans elle, un administrateur qui corrige le mot de passe pendant qu'une
   ouverture est en vol reçoit la session ouverte avec l'ANCIEN justificatif — et
   l'épreuve de connexion prononce alors « justificatif accepté » sur un couple
   que la source n'a jamais vu, ou « refusé » sur un couple correct. L'empreinte
   existe précisément pour que le changement de justificatif fasse tomber le
   cache ; la laisser hors de cette clé-ci la court-circuitait. */
const enVol = new Map();

function obtenirSecondSecret(p){
  const cle = `${p.nature}:${p.id}:${p.empreinte}`;
  const dejaEnVol = enVol.get(cle);
  if(dejaEnVol) return dejaEnVol;

  const travail = (async () => {
    const def = SCHEMAS_AUTH[p.schema];
    try{
      /* La garde anti-SSRF est celle de la famille de sources concernée — celle
         d'ODK ou celle des connecteurs, deux listes blanches distinctes. Elle est
         PASSÉE au porteur, jamais recopiée ici : une règle de sécurité en double
         est une règle qui finit par diverger (lib/foundry.js le dit déjà pour
         `motifPrive`, et pour la même raison). */
      const u = await p.verifierBase(p.baseUrl);
      const base = String(u).replace(/\/+$/, "");
      const obtenu = await def.session.obtenir({
        base, chemin: p.cheminSession || def.session.cheminDefaut,
        identifiant: p.identifiant, secret: p.secret });
      /* Une échéance annoncée par la source fait foi — à condition d'être une
         DATE. Elle vient de l'extérieur, et le module se veut tolérant sur la
         forme de la réponse : recopier telle quelle une valeur qu'aucun calcul ne
         saura relire produisait un cache que chaque appel déclarait périmé.
         À défaut, et seulement si le second secret est périssable, on s'en donne
         une COURTE et configurable : mieux vaut renouveler une session encore
         valable que découvrir son expiration par un tirage en échec. Jamais de
         durée codée en dur ici — `sessionLifetime` est un réglage de l'instance
         distante, pas une constante. */
      const annoncee = Date.parse(obtenu.expireLe || "");
      if(obtenu.expireLe && !Number.isFinite(annoncee))
        log.warn("échéance de session illisible, échéance par défaut appliquée",
          { source: p.id, nature: p.nature, annonce: String(obtenu.expireLe).slice(0, 60) });
      const expireLe = Number.isFinite(annoncee)
        ? new Date(annoncee).toISOString()
        : (def.session.perissable
              ? new Date(Date.now() + config.authSortante.dureeParDefautMs).toISOString()
              : null);
      ecrireSession(p, { jeton: obtenu.jeton, expireLe });
      log.info("session de source ouverte", { source: p.id, nature: p.nature,
        schema: p.schema, expire_le: expireLe || "sans expiration",
        annoncee: Number.isFinite(annoncee) });
      return { ok: true, jeton: obtenu.jeton, expireLe };
    }catch(e){
      const motif = e.motifAuth || e.message || "cause inconnue";
      /* Un échec se SIGNALE — il est consigné et il sera rendu tel quel à
         l'administrateur — et il ne se rejoue pas : la ligne d'échec bloque les
         tentatives suivantes le temps du délai, pour que MEMS ne martèle pas une
         source qui vient de dire non.

         Encore faut-il qu'elle ait dit non. Un silence — délai dépassé, hoquet
         d'une seconde chez la source, bascule de mandataire — n'est pas un refus :
         effacer sur cette base une session valable six heures, puis bloquer la
         source cinq minutes en conseillant de corriger un justificatif qui n'a
         jamais été en cause, c'est punir l'administrateur pour la panne d'un
         tiers. On ne touche donc au cache que lorsque la source a RÉPONDU. */
      if(e.refusDeLaSource) ecrireEchec(p, motif);
      log.warn("ouverture de session de source en échec",
        { source: p.id, nature: p.nature, schema: p.schema, motif,
          refusee: !!e.refusDeLaSource });
      return { ok: false, motif };
    }
  })();

  const partagee = travail.finally(() => { enVol.delete(cle); });
  enVol.set(cle, partagee);
  return partagee;
}

/* ═══════════════════════════════════════════════════════════════════════
   LE PORTEUR — ce que les chemins sortants reçoivent à la place d'un jeton nu
   ═══════════════════════════════════════════════════════════════════════ */

/* Construit le porteur d'une source, ou lève une erreur qui dit précisément ce
   qui manque. `codeErreur` est celui de la famille appelante (ODK_AUTH,
   SOURCE_AUTH) : les routes existantes continuent ainsi de reconnaître leurs
   propres codes, et le message, lui, devient exact. */
export function porteurAuth({
  nature, id, schema, identifiant, secret, secretPresent, baseUrl, cheminSession,
  verifierBase, codeErreur = "AUTH", quoi = "cette source",
}){
  const cle = String(schema || "porteur");
  const def = SCHEMAS_AUTH[cle];
  if(!def) throw refus(codeErreur, "AUTH_SCHEMA",
    `schéma d'authentification inconnu pour ${quoi} : « ${cle} ». `
    + `Schémas déclarés : ${NOMS_SCHEMAS_AUTH.join(", ")}.`);

  /* Un justificatif ENREGISTRÉ mais indéchiffrable n'est pas un justificatif
     absent, et les deux appellent des gestes opposés : restaurer la clé de
     chiffrement de l'instance dans un cas, ressaisir le secret dans l'autre.
     `decrypt` rend null quand l'authentification GCM échoue — clé DATA_KEY
     changée, base recopiée d'une autre instance, ligne abîmée — et cette valeur
     nulle ressortait sous « n'a pas de justificatif complet : renseignez-le »,
     avec des indices qui se contredisaient (présent, longueur nulle). L'écart
     était visible dans le dépôt : la route de tirage ODK, elle, savait le dire.
     Elle le dit maintenant depuis ici, donc pour tous les chemins à la fois. */
  if(secretPresent && !secret) throw refus(codeErreur, "AUTH_ILLISIBLE",
    `le justificatif de ${quoi} est enregistré, mais il ne peut pas être déchiffré : il a été `
    + "chiffré avec une autre clé que celle de cette instance (DATA_KEY), ou la ligne est abîmée. "
    + "Restaurez la clé de chiffrement de l'instance, ou ressaisissez le justificatif pour cette "
    + "source — ne le ressaisissez pas avant d'avoir écarté la première cause, sinon les autres "
    + "sources resteront illisibles elles aussi.");

  /* Les clés sont celles que la table déclare dans `champs` — « justificatif » et
     non « secret ». Ce n'est pas de la coquetterie : le nom de champ voyage
     jusqu'au navigateur dans la table servie, et une clé nommée « secret » y
     ferait apparaître la chaîne `"secret"` dans une réponse d'API, c'est-à-dire
     exactement le motif que le balayage anti-fuite recherche. Un nom qui déclenche
     une alarme sans qu'il y ait de fuite finit par faire désactiver l'alarme. */
  const valeurs = { justificatif: secret || "", identifiant: identifiant || "" };
  /* Un schéma qui dérive un second secret a besoin de savoir OÙ le ranger. Sans
     identité de source, deux sources différentes partageraient la même ligne de
     cache — donc la session de l'une ouvrirait la porte de l'autre. C'est une
     faute d'appel, pas une saisie fautive : elle se signale au développeur. */
  if(def.session && (!nature || !id))
    throw new Error(`porteurAuth : le schéma « ${cle} » dérive un justificatif et exige `
      + "donc une source identifiée (nature et id).");

  const manquants = def.champs.filter(c => c.requis && !valeurs[c.cle]).map(c => c.label);
  if(manquants.length) throw refus(codeErreur, "AUTH_ABSENT",
    `${quoi} n'a pas de justificatif complet : le schéma « ${def.libelle} » exige `
    + `${manquants.join(" et ")}. Renseignez-le dans la fiche de la source : chaque source porte `
    + "le sien, aucune n'en emprunte à une autre.");

  const p = {
    nature, id, schema: cle, identifiant: valeurs.identifiant, secret: valeurs.justificatif,
    baseUrl, cheminSession, verifierBase, codeErreur,
    libelle: def.libelle,
    motCle: def.motCle,
    derive: !!def.session,
    perissable: !!def.session?.perissable,
    indices: indicesSecret(valeurs.justificatif, secretPresent ?? !!valeurs.justificatif),
    empreinte: empreinteDe(cle, valeurs.identifiant, valeurs.justificatif),
  };

  /* Les en-têtes à émettre. Pour un schéma sans dérivation, c'est un calcul pur.
     Pour les autres, c'est le cache — ou une ouverture de session. */
  p.enTetes = async ({ forcer = false } = {}) => {
    if(!def.session) return def.enTete(valeurs);
    if(!forcer){
      const etat = etatCache(p);
      if(etat.etat === "valide") return def.enTete({ ...valeurs, justificatif: etat.jeton });
      if(etat.etat === "bloque")
        throw refus(codeErreur, "AUTH_SESSION",
          `${quoi} : le renouvellement du justificatif a échoué et n'est pas rejoué — ${etat.motif}. `
          + "Corrigez ce que ce motif désigne dans la fiche de la source — justificatif ou chemin : "
          + "l'enregistrer lève ce blocage immédiatement.");
    }
    const r = await obtenirSecondSecret(p);
    if(!r.ok)
      throw refus(codeErreur, "AUTH_SESSION",
        `${quoi} : impossible d'obtenir un justificatif auprès de la source — ${r.motif}.`);
    return def.enTete({ ...valeurs, justificatif: r.jeton });
  };

  /* Ce que l'écran a le droit de savoir de la session en cours. Jamais le jeton. */
  p.etatSession = () => {
    if(!def.session) return null;
    const row = ligneSession(p);
    if(!row || row.empreinte !== p.empreinte)
      return { ouverte:false, expire_le:null, obtenue_le:null, echec_le:null, echec_motif:null };
    return { ouverte: !!row.jeton_enc, expire_le: row.expire_le, obtenue_le: row.obtenu_le,
             echec_le: row.echec_le, echec_motif: row.echec_motif };
  };

  return p;
}

/* ═══════════════════════════════════════════════════════════════════════
   L'APPEL AUTHENTIFIÉ — un rejeu, jamais deux

   `faireAppel` reçoit les en-têtes et rend la réponse. Sur un 401, et seulement
   si le schéma sait dériver un justificatif, on renouvelle UNE fois et on rejoue
   UNE fois : le drapeau est porté par cet appel-ci, il ne se réarme pas. Sur un
   403, on ne renouvelle jamais — 403 signifie « authentifié, mais sans droit »,
   et refabriquer une session n'y changerait rien tout en bouclant.
   ═══════════════════════════════════════════════════════════════════════ */
export async function appelAuthentifie(porteur, faireAppel){
  const res = await faireAppel(await porteur.enTetes());
  if(res.status !== 401 || !porteur.derive) return { res, renouvele: false, motifRenouvellement: "" };

  let enTetes;
  try{ enTetes = await porteur.enTetes({ forcer: true }); }
  catch(e){
    /* Le renouvellement a échoué : on rend la PREMIÈRE réponse, celle de la
       source, pour que le diagnostic parle du refus réel et non de notre échec —
       en gardant tout de même le motif, qui est la moitié utile du message. */
    return { res, renouvele: false, motifRenouvellement: e.motifAuth || e.message };
  }
  const res2 = await faireAppel(enTetes);
  return { res: res2, renouvele: true, motifRenouvellement: "" };
}

/* ═══════════════════════════════════════════════════════════════════════
   LE DIAGNOSTIC

   Ce que la source nous laisse déduire, et rien de plus.
     — ODK Central sérialise ses refus en `{ message, code }` où `code` vaut
       401.2 (authentification échouée), 401.3 (https obligatoire), 401.5 (basic
       fermé quand OIDC est actif) ou 403.1 (droits insuffisants).
       Établi par getodk/central-backend, lib/util/problem.js.
     — KoboToolbox renvoie un `WWW-Authenticate` qui nomme le schéma qu'il
       attendait : « Session » quand AUCUN authentifieur n'a reconnu l'en-tête
       — c'est le cas d'un mot-clé inadapté — et « Token » quand le mot-clé était
       bon mais le jeton mauvais. Établi par kpi/authentication.py et
       rest_framework/views.py. C'est le seul signal qui sépare vraiment
       « mauvais schéma » de « mauvais jeton », et aucun code HTTP ne le donne.
   Quand rien ne tranche, on le DIT. On n'accuse pas le jeton.
   ═══════════════════════════════════════════════════════════════════════ */
/* Le schéma DÉCLARABLE dont le mot-clé est celui que la source réclame, s'il
   existe. Nommer le mot-clé ne suffit pas : l'administrateur choisit dans une
   liste de libellés, pas de mots-clés, et rien ne garantit que le mot-clé annoncé
   corresponde à une entrée de la liste. */
const schemaParMotCle = (motCle) => {
  const m = String(motCle || "").toLowerCase();
  if(!m) return null;
  const cle = NOMS_SCHEMAS_AUTH.find(k => SCHEMAS_AUTH[k].motCle
    && SCHEMAS_AUTH[k].motCle.toLowerCase() === m && !SCHEMAS_AUTH[k].session);
  return cle ? SCHEMAS_AUTH[cle] : null;
};

/* Les mots-clés qu'une source annonce et qui ne désignent AUCUN schéma
   présentable. Ils vivent dans une table parce qu'ils sont une propriété du
   produit distant, pas du code : c'est exactement la même règle que pour les
   chemins par défaut, et pour la même raison — une instance peut différer.

   « Session » est le cas connu, et il est piégeux : c'est ce que Django REST
   Framework — donc KoboToolbox — rend quand AUCUN de ses authentifieurs n'a
   reconnu l'en-tête reçu, et non l'annonce d'un schéma à adopter. Le message qui
   ordonnait « adoptez celui qu'elle réclame » envoyait donc l'administrateur
   choisir « Session ODK Central » sur un serveur Kobo, c'est-à-dire poster le
   couple courriel / mot de passe sur une route qui n'existe pas. */
const MOTS_CLES_SANS_SCHEMA = {
  session: "« Session » ne désigne pas un en-tête que MEMS puisse présenter : c'est la connexion par "
    + "formulaire web de la source. Une API bâtie sur Django REST Framework — KoboToolbox en fait "
    + "partie — répond cela quand AUCUN de ses authentifieurs n'a reconnu l'en-tête reçu. Sur un "
    + "serveur KoboToolbox, le schéma à employer est « Jeton (Token) ».",
};

export async function causeRefus({ porteur, res, renouvele = false, motifRenouvellement = "" }){
  const wwwAuth = res.headers?.get?.("www-authenticate") || "";
  const corps = await corpsJson(res);
  const codeProbleme = typeof corps?.code === "number" ? corps.code : null;
  const detail = String(corps?.detail || corps?.message || "").slice(0, 300);
  const motCleSource = (wwwAuth.match(/^\s*([A-Za-z]+)/) || [])[1] || "";
  const dit = detail ? ` La source dit : « ${detail} »` : "";

  if(codeProbleme === 401.3) return { cause: "AUTH_SCHEMA",
    message: "accès refusé : la source exige https pour ce schéma d'authentification et l'adresse "
      + `de base ne l'emploie pas.${dit}` };

  if(codeProbleme === 401.5) return { cause: "AUTH_SCHEMA",
    message: "accès refusé : cette instance est configurée en OIDC, elle ferme l'authentification "
      + "basique et l'ouverture de session par mot de passe. Collez-y un jeton de session avec le "
      + `schéma « Porteur ».${dit}` };

  /* Une source déclarée « aucune authentification » qui reçoit un refus n'a pas
     un mauvais schéma : elle n'a rien présenté du tout. C'est la cause la plus
     simple à nommer, et la seule que l'ancien code ne pouvait pas voir.

     Elle passe AVANT le 403, et l'ordre est le correctif : un 403 était affirmé
     « justificatif accepté, droits insuffisants » y compris quand MEMS n'avait
     émis aucun en-tête — ce que répond une API Django REST Framework dont le
     premier authentifieur n'expose pas de `WWW-Authenticate`. On envoyait alors
     l'administrateur réclamer des droits chez la source pour un justificatif
     qu'il n'avait pas encore saisi. */
  if(!porteur.motCle) return { cause: "AUTH_ABSENT",
    message: "accès refusé : cette source est déclarée sans justificatif (« Aucune — source "
      + `publique »), et elle en réclame un${motCleSource ? ` — elle attend « ${motCleSource} »` : ""}. `
      + `Choisissez un schéma d'authentification et renseignez le justificatif.${dit}` };

  /* De même : la source a NOMMÉ le mot-clé qu'elle attendait, et ce n'est pas
     celui qu'on a émis. Ce signal est plus précis que le code HTTP, quel qu'il
     soit — le même corps rendu en 401 donnait le bon diagnostic et en 403 le
     mauvais, alors que seul le code changeait. */
  if(motCleSource && motCleSource.toLowerCase() !== String(porteur.motCle).toLowerCase()){
    const attendu = schemaParMotCle(motCleSource);
    const sansSchema = MOTS_CLES_SANS_SCHEMA[motCleSource.toLowerCase()];
    const remede = attendu
      ? `Choisissez le schéma « ${attendu.libelle} » pour cette source.`
      : sansSchema
        ? `${sansSchema} Les schémas déclarés sont : `
          + `${NOMS_SCHEMAS_AUTH.map(k => SCHEMAS_AUTH[k].libelle).join(", ")}.`
        : "Aucun schéma déclaré dans MEMS ne porte ce mot-clé : "
          + `${NOMS_SCHEMAS_AUTH.map(k => SCHEMAS_AUTH[k].libelle).join(", ")}. `
          + "Signalez-le à l'équipe technique — un schéma s'ajoute par une entrée dans une table.";
    return { cause: "AUTH_SCHEMA",
      message: `accès refusé : MEMS présente son justificatif en « ${porteur.motCle} », et la source `
        + `répond « ${motCleSource} ». ${remede}${dit}` };
  }

  if(res.status === 403 || codeProbleme === 403.1) return { cause: "AUTH_DROITS",
    message: `accès refusé : le justificatif est accepté par la source, mais il n'a pas les droits `
      + `nécessaires sur cette ressource. C'est un réglage à faire CHEZ LA SOURCE, pas dans MEMS.${dit}` };

  if(porteur.derive && renouvele) return { cause: "AUTH_SCHEMA",
    message: `accès refusé alors que le justificatif vient d'être renouvelé à l'instant : il est donc `
      + `frais, et pourtant refusé. L'hypothèse la plus probable est que le schéma « ${porteur.libelle} » `
      + `ne convient pas à cette source — vérifiez lequel elle attend. Ce n'est pas un verdict : la `
      + `source n'a pas dit sa raison.${dit}` };

  /* Le renouvellement doit avoir été TENTÉ pour qu'on puisse dire qu'il a échoué.
     Cette branche parlait d'un renouvellement impossible dans un cas où rien
     n'avait été tenté — la seconde étape de l'épreuve de connexion, qui réemploie
     exprès la session que la première vient d'ouvrir et de faire accepter. Le
     diagnostic disait alors le contraire de ce que les deux étapes établissaient. */
  if(porteur.derive && motifRenouvellement) return { cause: "AUTH_SESSION",
    message: `accès refusé et le justificatif n'a pas pu être renouvelé — ${motifRenouvellement}.${dit}` };

  const def = SCHEMAS_AUTH[porteur.schema];
  return { cause: "AUTH_REFUS",
    message: `accès refusé par la source, sans qu'elle en précise la cause. Cette source est déclarée `
      + `avec le schéma « ${def.libelle} » : ${def.refus401}${dit}` };
}

/* ═══════════════════════════════════════════════════════════════════════
   L'ÉPREUVE DE CONNEXION

   Une sonde authentifiée sur un point d'entrée qui ne lit aucune donnée, et un
   diagnostic qu'un administrateur peut utiliser : ce qui a été joint, sous quel
   schéma, ce que la source a répondu, et laquelle des causes nommées s'applique.
   Le secret ne sort jamais — au plus sa présence et sa longueur.
   ═══════════════════════════════════════════════════════════════════════ */
export async function sonder({ porteur, chemin, etape = "justificatif", forcer = true,
                               exigeAuth = false }){
  const base = { etape, schema_employe: porteur.schema, schema_libelle: porteur.libelle,
    mot_cle: porteur.motCle, hote_verifie: false, joignable: false, code_http: null,
    cause: null, message: "", verdict: "indetermine", indices: porteur.indices,
    session: porteur.etatSession ? porteur.etatSession() : null };

  let base_url;
  try{ base_url = String(await porteur.verifierBase(porteur.baseUrl)).replace(/\/+$/, ""); }
  catch(e){ return { ...base, ok: false, cause: "AUTH_HOTE", message: e.message }; }
  base.hote_verifie = true;

  let enTetes;
  /* Une épreuve déclenchée par un humain force l'ouverture d'une session neuve :
     c'est ce qu'on attend d'un bouton « tester », et c'est aussi ce qui permet de
     réessayer après un échec sans attendre la fin du délai de blocage. Les étapes
     suivantes, elles, réemploient la session ainsi obtenue — les forcer ouvrirait
     une session par étape, ce que la source verrait comme un martèlement. */
  try{ enTetes = await porteur.enTetes({ forcer: forcer && !!porteur.derive }); }
  catch(e){
    return { ...base, ok: false, cause: e.causeAuth || "AUTH_ABSENT", message: e.message,
      session: porteur.etatSession ? porteur.etatSession() : null };
  }

  const appeler = (entetes) => fetchBorne(base_url + normaliserChemin(chemin),
    { method: "GET", headers: { ...entetes, Accept: "application/json" } });

  let res;
  try{ res = await appeler(enTetes); }
  catch(e){
    return { ...base, ok: false, cause: e.causeAuth === "AUTH_HOTE" ? "AUTH_HOTE" : null,
      message: `la source n'a pas répondu correctement : ${e.motifAuth || e.message}`,
      session: porteur.etatSession ? porteur.etatSession() : null };
  }

  base.joignable = true;
  base.code_http = res.status;
  base.session = porteur.etatSession ? porteur.etatSession() : null;

  if(res.status === 401 || res.status === 403){
    const { cause, message } = await causeRefus({ porteur, res, renouvele: forcer && !!porteur.derive });
    return { ...base, ok: false, cause, message };
  }
  /* Un 404 n'établit rien du justificatif, ni dans un sens ni dans l'autre. Il
     laissait `ok` absent, que la route traduisait en « faux » : la modale
     affichait alors « la source n'a pas accepté l'appel » au-dessus d'un texte
     qui affirme le contraire. Deux verdicts opposés dans le même encadré ne se
     départagent pas — d'où `verdict`, qui dit qu'il n'y a pas de verdict. */
  if(res.status === 404) return { ...base, ok: false, verdict: "indetermine", cause: null,
    message: `la source répond, mais il n'y a rien à « ${chemin} » (404). Le justificatif n'est pas `
      + "en cause : c'est le chemin qui ne correspond pas à cette instance. Il est réglable dans la "
      + "fiche de la source." };
  if(!res.ok) return { ...base, ok: false, verdict: "indetermine", cause: null,
    message: `la source répond ${res.status}, ce qui n'est ni un succès ni un refus d'authentification.` };

  /* ── Ce qu'un 2xx prouve, et ce qu'il ne prouve pas ─────────────────
     Sur un point d'entrée dont on SAIT qu'il exige une authentification —
     `/v1/users/current` chez ODK Central, `/me/` chez KoboToolbox — un 2xx prouve
     que le justificatif a été accepté. Ailleurs, il ne prouve rien : les natures
     « http » et « foundry » sondent le chemin réglé, souvent « / », et une page
     publique répond 200 à tout le monde. L'épreuve déclarait alors « justificatif
     accepté » sur un secret entièrement faux, et l'écran affichait un feu vert
     que tout aperçu démentait aussitôt.

     On ne devine pas : on REFAIT l'appel sans en-tête d'autorisation. Si la
     source répond pareil sans justificatif, ce point d'entrée n'en exige pas et
     l'épreuve le dit. Si elle refuse, l'en-tête a bien été pris en compte, et
     c'est cette fois une preuve. Un appel de plus, sur le seul chemin qui a
     réussi, contre un verdict qui ne veut rien dire. */
  const accepte = (extra = "") => ({ ...base, ok: true, verdict: "accepte",
    message: `justificatif accepté : la source a répondu ${res.status} au schéma `
      + `« ${porteur.libelle} »${extra}.` });
  const indetermine = (message) => ({ ...base, ok: true, verdict: "indetermine", message });

  if(exigeAuth) return accepte();
  if(!porteur.motCle) return indetermine(
    `la source répond ${res.status} à « ${chemin} ». Cette source est déclarée sans justificatif : `
    + "l'épreuve dit qu'elle est joignable, elle ne dit rien d'un justificatif qu'il n'y a pas.");

  let temoin;
  try{ temoin = await appeler({}); }
  catch(e){ return indetermine(
    `la source répond ${res.status} à « ${chemin} », mais le second appel — le même, sans `
    + `justificatif, qui seul dirait si ce point d'entrée en exige un — n'a pas abouti : `
    + `${e.motifAuth || e.message}.`); }

  if(temoin.status === 401 || temoin.status === 403)
    return accepte(`, et refusé (${temoin.status}) le même appel présenté sans justificatif`);
  if(temoin.ok) return indetermine(
    `la source répond ${res.status} à « ${chemin} » — mais elle y répond AUSSI sans aucun `
    + "justificatif. Ce point d'entrée n'en exige pas : l'épreuve établit que la source est "
    + "joignable, pas que le justificatif enregistré soit bon. Indiquez un chemin d'épreuve qui "
    + "exige une authentification pour obtenir un verdict.");
  return accepte(`, là où le même appel sans justificatif répond ${temoin.status}`);
}
