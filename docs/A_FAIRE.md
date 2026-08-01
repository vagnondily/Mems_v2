# À faire

Refonte du 31/07/2026. La version précédente listait 3 chantiers et 2 remarques ; l'audit
complet du dépôt (254 fonctionnalités recensées, 15 migrations, 45 tables, ~70 routes) en a
fait apparaître beaucoup d'autres, et a corrigé le statut des deux chantiers marqués « FAIT ».
S'y ajoutent 25 demandes produit formulées le 31/07/2026.

**Comment lire ce document.** Les chantiers A à G sont de la dette : ils corrigent ce qui est
cassé ou faux aujourd'hui. Les chantiers H à M sont les demandes produit. Chaque entrée porte
ses ancres `chemin:ligne`, et les questions bloquantes sont regroupées en fin de document —
plusieurs demandes ne peuvent pas être codées sans une décision métier.

Toute affirmation ci-dessous a été vérifiée dans le code. Là où une vérification n'a pas pu
être faite, c'est écrit.

---

## Feuille de route confirmée le 01/08/2026 (ordre des modules)

Le propriétaire a fixé l'ordre de construction, selon une structure professionnelle où chaque
module s'appuie sur le précédent :

1. **Paramétrage** *(en cours — chantier S3)*. Le socle. Y compris le **référentiel
   d'activités** : tout MEMS est *par activité*, donc les activités se paramètrent ici et tout
   le reste s'y accroche. Et la **configuration du pays** (découpage géographique importé par
   shapefile/dbf) devient **LA base de référence adm0→adm4 de tout le système** — sites,
   caseload, plan de suivi, carte, dashboards y puisent.
2. **Suivi-évaluation** : Planification → Suivi → **Dashboard des indicateurs de suivi de
   processus** sur données **Kobo v1 mappées** (chantier T). Jeu de test : `List Sites per
   Tag.xlsx` (le fichier « tag ») pour les sites par activité.
3. **Programme** (PDD, distributions — chantier R pour le catalogue de rations et la fiche PDD).
4. **Cartographie**.
5. **Accueil + Analyses + Rapports réunis en un seul module**.

Principe transversal : les **indicateurs de l'XLSForm sont stockés** et servent de base aux
calculs et à la sortie des dashboards, présentés **par activité** et selon l'audience —
inspirés du tableau de bord HTML, jamais clonés. Les **données MoDa sont une base par activité
reliée en temps réel** (chantier T).

Ordre de LIVRAISON professionnel : paramétrage → planification → suivi → dashboards. On ne
peut pas afficher un indicateur avant d'avoir paramétré l'activité, mappé la donnée et défini
le référentiel — d'où cet ordre, et d'où la priorité donnée aux Paramètres.

---

# Journal de livraison

Ce document décrit un état daté. Ce qui a été livré depuis est consigné ici, avec le commit
qui le porte — le corps du document reste écrit au moment de l'audit, et le lire sans ce
journal donnerait une image fausse de ce qui reste à faire.

**Tests au dernier commit : 217 côté serveur, 44 côté web, 0 échec. Audit de production :
aucun avis grave, ni serveur ni web.**

| Commit | Ce qui est livré | Effet sur ce document |
|---|---|---|
| `a189dce` | Carte réécrite sur Leaflet avec fond libre, **`xlsx` supprimé du frontend** (le XLSForm est lu par le serveur, `POST /api/xlsform/parse`), **huit correctifs du chantier A**, `.dockerignore`, audit de CI qui échoue vraiment, Vite sur `127.0.0.1` | **Chantier 3 clos autrement** : la dépendance vulnérable est retirée au lieu d'être mise à jour depuis un CDN tiers — le risque de chaîne d'approvisionnement est supprimé, pas déplacé. **Chantier A : 8 points sur 10 faits.** **Chantier C : 4 points sur 10 faits.** |
| `cf42bf8` | Couche générique de connecteurs et de correspondance des variables (migration 016, `lib/champs.js`, `lib/mapping.js`, `routes/connectors.js`, écran Paramètres → Connecteurs), client Foundry | Répond à la demande « un système de mapping des variables à chaque liaison ». **La migration `submissions` prend le n° 017.** |
| `49062d9` | Fonds de carte au choix et échec de tuiles **visible**, vue d'ensemble dans le panneau de droite, cartographie promue au premier niveau, nouveau logo | **M1 tranché autrement que prévu : le fond est libre et sans clé, pas Google.** Le propriétaire du produit a demandé un affichage gratuit ; Google Maps facture chaque ouverture. **Q20, Q24 et Q29 tombent donc d'elles-mêmes.** M2, M3 et M4 restent. |
| `68de783` | Cloche de notifications (**K3**), sélecteur d'année et filtre de période (**Q9 appliquée, K1 partiel**), chaîne ODK côté serveur (migration 017, résolveur, « déjà suivi », GPS), **menus déroulants de l'en-tête supprimés** | **K3 fait. L4/13d fait côté serveur.** Le défaut d'affichage des menus est corrigé à la racine : `overflow-x-auto` sur la barre empêchait le panneau d'être visible, et le bouton naviguait *et* ouvrait le menu. |
| `f0a6cdd` | Écran Programme → Soumissions ODK, code externe dans la fiche de site, double date de dernière visite, couche GPS sur la carte, **correction d'une perte de données sur `PUT /api/sites/:id`** | **Chantier O largement fait.** Le `PUT` n'était pas partiel : renommer un site effaçait antenne, catégorie, activité, type et code externe. Même défaut que sur les comptes, sur une table où il fait plus de dégâts. |

| `7239bbe` | **Codes externes multiples** (migration 018 : un site peut être désigné différemment par chaque formulaire), import d'une table de correspondance, **rattachement manuel tracé** avec création d'alias à la volée, et **score de risque aligné sur la date qui fait foi** | **SMP devient rattachable dès que le bureau fournit sa table.** Le rattachement manuel est protégé de tout rejeu et de tout re-versement. La divergence entre score, cloche et carte est résorbée : les trois lisent la même date. |
| `8ebe2f1` | **Exécution de scripts R et SPSS sur le serveur** (`lib/moteur.js`, `POST /api/scripts/:id/executer`) et **console d'administration de l'instance** (`/api/admin` : sessions, journal de sécurité, santé du fichier de base, sauvegarde et restauration) | Répond aux deux dernières demandes. **Le rôle `super` cesse d'être un doublon d'`admin`** : `requireSuper` (lib/auth.js) marque la frontière que la matrice `CAPS` ne savait pas exprimer — administrer *l'installation* et non son contenu. **La sauvegarde et la restauration demandées en Paramètres sont livrées ici**, où elles ont leur place. |
| `03eb422` | **La visite saisie à la main devient l'exception justifiée** (migration 019, `lib/visites.js`) et **référentiel de codes d'identification importable** (migration 020, `lib/codes.js`, type d'import `codes`, écran Paramètres → Référentiels de codes) | **SMP est rattachable, pour de bon** : le référentiel chargé pose les alias, et le résolveur rattache la soumission par son code école à confiance 1,0. La ligne « SMP reste non rattachable » du bas de ce document tombe. **Un défaut de destruction de données est fermé** : décocher un mois effaçait la visite du mois quelle qu'elle soit, y compris une visite ODK portant sa soumission. |
| *(ce commit)* | **Justificatif propre à chaque source de collecte** (migration 021, `lib/authSortante.js`) : schémas d'authentification déclarables (`porteur`/Bearer, `jeton`/Token pour Kobo, `basique`/Basic, session ODK Central renouvelée), **deux secrets** — un justificatif durable et un jeton de session court qui en dérive, mis en cache et renouvelé —, épreuve de connexion réelle qui distingue les cinq causes d'échec, **zoom souris et bascule des contours sur la carte**, et la **synthèse des 27 documents** reçus (indicateurs CRF, rations PDD, shapefile, règles QC) | Répond à « il faut un token à part l'API » : le schéma est une donnée de la source, plus une hypothèse du code — **Kobo, jusqu'ici déclarable mais muet, envoyait `Bearer` au lieu de `Token`**. Le « Jeton général » ODK, qui promettait un repli que le serveur refusait, est supprimé. Ouvre les **chantiers R** (catalogue de rations, fiche de saisie PDD) et **S** (réorganisation produit + UI), et la **synthèse documentaire** transforme les chantiers N et P d'« inventer » en « importer ». |

### La visite à la main : ce qui change, et pourquoi

Le formulaire ODK est la voie normale. La saisie à la main reste possible — le terrain
en a besoin, réseau coupé, appareil à plat, visite antérieure au déploiement — mais elle
n'est plus silencieuse : elle exige **un motif pris dans une liste fermée**, déclarée une
seule fois côté serveur (`lib/visites.js`) et servie au client, plus une précision libre
obligatoire pour « autre ». Trois conséquences :

- un mois déjà couvert par une soumission ODK ne se saisit pas une seconde fois ;
- une visite portant une soumission ne peut plus être supprimée depuis la planification —
  et le refus renvoie vers l'écran qui, lui, sait la retirer (Programme → Soumissions ODK) ;
- quand une soumission arrive **après** une saisie à la main du même mois, la visite est
  promue au lieu d'être doublée : elle devient la preuve de terrain, son motif de
  rattrapage n'a plus cours. L'historique de ce motif ne survit que dans le journal
  d'audit — c'est un arbitrage, pas une évidence.

Les 527 visites de la base de démonstration sont reprises en `inconnu_anterieur`, un motif
qui n'est **pas saisissable** : on ne prête pas aux anciennes lignes une raison que
personne ne connaît.

### Le référentiel de codes : générique, SMP en est le premier occupant

Une table nomme le référentiel, ce qui évite de recoder au formulaire suivant — même
raison que `lib/champs.js` et `lib/mapping.js`. Le chargement passe par le cadre d'import
Excel déjà en place : modèle pré-rempli, aperçu avec écart avant écriture, lot annulable,
écriture idempotente par le couple (référentiel, code). Le rapprochement pose les alias
`site_external_code` et **dit ce qu'il n'a pas su faire** — combien d'entrées sans site
avec le motif de chaque échec, combien de sites sans entrée par activité. Il dit aussi ce
qu'il **défait** : quand le fichier ne soutient plus un lien établi, le lien tombe, et cela
se compte au lieu de disparaître.

### Ce qu'il faut savoir avant d'activer l'exécution de scripts

La fonction est **absente tant qu'aucun interpréteur n'est nommément déclaré** (`ANALYSIS_R`,
`ANALYSIS_SPSS`) : une instance qui ne s'en sert pas ne peut pas exécuter de code par accident,
même si un compte est compromis. Ce que le moteur garantit — environnement purgé, répertoire de
travail neuf et détruit, mise à mort du **groupe** de processus au bout d'un délai borné, sorties
et fichiers produits plafonnés — et surtout **ce qu'il ne garantit pas**, sont écrits en toutes
lettres en tête de `server/src/lib/moteur.js`. Le point à retenir : l'enfant tourne sous
l'utilisateur du processus MEMS, il lit donc le `.env` et la base ; le réseau lui est ouvert ; ni
processeur ni mémoire ne sont bornés. **Ce n'est pas un bac à sable.** Une instance qui active la
fonction doit faire tourner MEMS dans un conteneur dont la perte est acceptable.

**L'image Docker n'embarque ni `Rscript` ni `pspp`** — les installer est une décision
d'exploitation, prise sciemment, pas un défaut hérité de l'image.

## Ce qui reste ouvert, et pourquoi

- **Chantier A, points 6 et 10** : un compte prestataire n'est toujours pas cloisonné hors du
  module TPM, et la fuite de périmètre à l'agrégation de `GET /caseload` n'est pas traitée.
- **Chantier B** : `exceljs` reste un cul-de-sac amont (dernière version publiée en 2023) et
  `better-sqlite3` embarque toujours une SQLite en deçà du seuil de CVE-2025-6965. Node 20 est
  en fin de vie et épinglé à quatre endroits.
- **Chantiers D, E, F, G** : intacts. La persistance des sept réglages perdus au rechargement
  reste le plus gênant à l'usage.
- **Chantiers N et P** : intacts. Les référentiels MRE et le modèle d'indicateurs ne
  correspondent toujours à aucun référentiel du PAM.
- **SMP : le canal est livré, le fichier manque encore.** Ses codes sont des entiers hors du
  référentiel p-code. Le mécanisme d'alias l'était déjà (migration 018) ; le **chargement de la
  table** l'est désormais (migration 020, type d'import `codes`, Paramètres → Référentiels de
  codes). Ce qui reste à obtenir est le fichier lui-même — les 1 251 codes école doivent venir
  du bureau, ils ne s'inventent pas. Deux limites consignées plutôt que découvertes :
  le référentiel est **générique** — les 247 codes ZAP en sont le second occupant attendu, sans
  nouvelle ligne de code ; et le rapprochement **ne pose un code de reconnaissance qu'au-dessus
  d'un seuil de preuve** (0,7, celui d'un p-code adm4) ou sur désignation humaine explicite.
  Une entrée rapprochée par son seul nom est comptée « à confirmer » et ne rattache rien :
  poser l'alias en ferait une certitude au passage suivant, sans que personne l'ait validé.
- **Q15c** (sur quelle période un site compte comme « déjà suivi »), **Q25** et **Q26**
  (position déclarée contre position observée) restent des décisions métier. Le code les
  prépare — la fenêtre est un paramètre, l'écart en mètres est mesuré et affiché — mais ne les
  prend pas.

---

## Statut corrigé des chantiers précédents

### Chantier 1 — PDD, calcul automatique des rations — était « FAIT », en réalité **partiel**

Le cœur est bien livré et exact : `SetRations` existe, `PddGenModal` existe, la cascade
géographique fonctionne, une ligne de PDD par denrée cochée est bien créée, la formule
`bénéficiaires × jours × ration ÷ 1 000 000` est bien celle du code, et Cash/Voucher ne crée
bien qu'une ligne. Restent cinq défauts :

1. **Le bureau est un champ texte libre** (`web/src/views/Planning.jsx:891`) alors que le
   serveur l'exige non vide (`server/src/routes/collections.js:56`). Une génération sans
   bureau fait échouer en 422 la synchronisation de **toute** la collection `pdd`. L'échec est
   quasi muet : `web/src/lib/api.js:209` ne réessaie pas les 4xx et `web/src/App.jsx:118`
   n'alerte qu'au troisième échec.
2. **`geo_pcode` n'est pas transmis** par le générateur, alors que la saisie manuelle le
   transmet (`Planning.jsx:788`) : les lignes « par commune » ne sont rattachées à aucune
   commune.
3. **`office_id` n'est pas transmis** : un compte cloisonné ne revoit pas ses propres lignes
   au rechargement (`server/src/routes/state.js:92-94`).
4. **Droit incohérent sur l'écran Rations** : l'écran autorise sur `can("edit")`
   (`Settings.jsx:1605,1617`), le serveur exige `admin` (`collections.js:196`). Un éditeur
   saisit, l'aperçu se met à jour, la requête part en 403, la saisie est perdue sans message.
5. **Incompatible avec l'import Excel du PDD** : la clé de réconciliation
   (`server/src/lib/import.js:128`) n'inclut pas la denrée — les lignes multi-denrées créées
   par le chantier 1 sont rejetées en doublon. Et l'énumération « Type »
   (`import.js:137,210`) ne connaît que GD/PREVMA, pas PECMAM ni FFA que l'écran Rations
   propose.

**Aucun test versionné.** Le document précédent disait « vérifié avec Playwright » : le dépôt
n'utilise pas Playwright (jsdom + esbuild, `web/test/harness.mjs`), et le commit du chantier
ne touche aucun fichier de test.

### Chantier 2 — TPM, rattachement prestataire — était « FAIT », **le correctif serveur tient, le reste non**

`state.js:166` renvoie bien `tpm_id` et le test existe (`server/test/api.test.js:1701`).
Mais :

1. **Le test ne teste pas le scénario décrit.** Il vérifie que le champ est exposé, pas le
   réenregistrement d'un compte. Si `routes/users.js:73` cessait d'écrire `tpm_id`, la suite
   resterait verte.
2. **Le mécanisme du bug est toujours armé, et son pire cas est ailleurs.**
   `PUT /api/users/:id` est un remplacement complet couplé à des défauts zod
   (`server/src/lib/validate.js:122-124`) : un PUT partiel remet `role="viewer"`, `tabs=[]`
   et surtout **`active=true`** — il réactive un compte désactivé sans un mot d'erreur.
   `tpm_id` n'était qu'un symptôme.
3. **« Les deux rattachements désactivés pour admin/super » est faux** : seul le sélecteur
   prestataire l'est (`Settings.jsx:1983`) ; le sélecteur bureau reste actif, alors que
   l'infobulle juste au-dessus (`Settings.jsx:1978`) affirme le contraire. Et « comme le
   serveur l'exige déjà » est faux aussi : `routes/users.js:17-23` ne contrôle rien sur
   `office_id`.
4. **L'exclusivité mutuelle rejoue le bug qu'elle corrige** : choisir l'option *vide* d'un
   sélecteur vide aussi l'autre (`Settings.jsx:1981,1984`). Un aller-retour sur le sélecteur
   bureau détache silencieusement le compte de son prestataire.

### Chantier 3 — xlsx (SheetJS) — **exact, toujours entièrement à faire, et infaisable ici**

`web/package.json:17` et le lock : `xlsx@0.18.5`. Vérifié le 31/07/2026 : `0.18.5` **est** la
dernière version publiée sur npm — SheetJS a quitté le registre, d'où le `fixAvailable: false`
de `npm audit`. La seule voie reste le tarball CDN.

Deux précisions que le document précédent omettait :

- **`xlsx` n'est pas une dépendance dormante** : elle parse un fichier fourni par
  l'utilisateur (`Settings.jsx:1707`, « Joindre le XLSForm »). La retirer suppose de réécrire
  ce parcours — ou de basculer ce parsing côté serveur sur `exceljs`, déjà présent.
- **`cdn.sheetjs.com` est injoignable depuis l'environnement de développement** : vérifié le
  31/07/2026, `curl` renvoie `403` au tunnel du proxy. Le chantier exige donc un poste à accès
  réseau complet, comme déjà noté.

Conséquence à assumer, non signalée jusqu'ici : une fois installé par tarball, `resolved`
pointera vers `cdn.sheetjs.com` dans `web/package-lock.json`, et chaque `npm ci` de la CI
(`.github/workflows/ci.yml:28`) et du build Docker dépendra d'un hôte hors registre. Cela
**déplace** un risque de chaîne d'approvisionnement plutôt que de le supprimer. À trancher
explicitement (voir Q1).

### Remarque A (`db.formulas`) — exacte, mais c'est un défaut de classe

Deux corrections. D'abord, la corriger demande **deux gestes, pas un** : ajouter `formulas` à
`SYNCED` ne suffirait pas, car `App.jsx:99` réécrit `formulas: D_FORMULAS` à chaque
hydratation, et le serveur n'a ni collection (`collections.js:18-106` → 404) ni table pour les
accueillir.

Ensuite, **ce n'est pas un cas isolé** : sept réglages sont éditables à l'écran et perdus au
rechargement — `scoring`, `roles`, `mmr`, `lists` (partenaires, modalités, sous-types de POI,
tags), `actCategories`, `outcomePlan`, `formulas`. La matrice des rôles de
`Paramètres → Utilisateurs` (`Settings.jsx:1933-1950`) est dans ce cas : on coche, rien ne se
passe. Voir chantier D.

Le doute exprimé (« peut-être volontaire, un bac à sable ») n'est étayé par rien dans le code :
le bouton « Rétablir les calculs de base » (`Settings.jsx:1548`) et le badge « personnalisé »
(`:1527`) indiquent au contraire une persistance attendue.

### Remarque B (`partner_id`) — la conséquence décrite est inversée

Le document disait que la clé étrangère « reste vide tant que la ligne n'a pas été rechargée »,
ce qui suggère un problème transitoire. C'est l'inverse : **rien ne remplit jamais
`partner_id`, et c'est le rechargement qui fait disparaître le partenaire.** Le schéma de
synchro (`collections.js:53-66`) n'a pas de champ `partner`, zod le supprime silencieusement,
la table `pdd` n'a pas cette colonne (`001_init.sql:247`), et `state.js:103` renvoie une chaîne
vide.

Il y a donc **perte de donnée saisie** : colonne « Partenaire » vidée (`Planning.jsx:734`),
export CSV vidé (`:644-646`), filtre de recherche inopérant (`:616`). Le document omettait aussi
la troisième voie de création touchée (import CSV, `Planning.jsx:655`).

### Section « Fait pour mémoire » — exacte sauf un point

Tirage ODK réel ✅ (vrai `fetch` HTTP paginé, `lib/odkClient.js:40,65-79`, couvert par 5 tests),
éditeur de formules ✅, `.devcontainer` ✅, les cinq correctifs ✅.

En revanche « appariement des variables des **5 XLSForms MDG** » promet un livrable que le
dépôt ne porte pas : **aucun XLSForm n'est versionné**, aucune table de correspondance par
formulaire n'est stockée. Ce qui existe est un appariement générique nom→libellé
(`import-odk-forms.js:112-125`) et une détection heuristique du champ site/date par expressions
régulières calibrées sur ces formulaires (`:73-78`). Le « 5 » ne vit que dans un message de
commit et `README.md:770`. À reformuler ou à rendre vérifiable.

---

## Chantier A — Cloisonnement et droits côté serveur (sécurité, bloquant)

À traiter avant tout le reste : ces points contredisent des garanties que l'application affiche.

1. **`PUT /api/collections/:name` n'applique aucun cloisonnement.** `collections.js` n'importe
   même pas `lib/scope.js` : `SELECT id, rev FROM <table>` sans filtre (`:138`),
   `UPDATE … WHERE id=?` (`:164`), `DELETE … WHERE id=?` (`:176`). Un `editor` du bureau A peut
   **écrire et supprimer les lignes du bureau B**, alors que `GET /api/state` les lui cache.
   → Restreindre `existing`, l'UPDATE et surtout `deletes` au bureau de l'appelant.
2. **Les suppressions n'exigent pas le droit `del`.** La route est protégée par `edit`, et le
   tableau `deletes` passe avec — contrairement à la matrice des rôles
   (`lib/auth.js:53-59`, `README.md:919-925`).
3. **`must_change_pw` n'est appliqué nulle part côté serveur.** `authenticate`
   (`lib/auth.js:36-51`) ne le lit pas ; seul `web/src/views/Login.jsx:32` bloque. Un appel API
   direct avec le mot de passe provisoire donne un accès complet, indéfiniment.
   → Refuser tout appel d'un compte `must_change_pw=1` hors `/auth/password` et `/auth/me`.
4. **`PUT /api/caseload` n'applique aucun contrôle de périmètre** (`routes/caseload.js:179`),
   alors que le même flux par import en applique un (`lib/import.js:411-415`). `scopeOf` est
   importé mais n'est utilisé qu'en lecture.
5. **SSRF sur `odkBase`** : l'URL n'est ni validée ni restreinte avant l'appel serveur
   (`routes/odk.js:31`, `lib/odkClient.js:65`). → Imposer https, liste blanche d'hôtes, refus
   des adresses privées.
6. **Un compte prestataire n'est pas cloisonné hors du module TPM** : `routes/users.js:20-21`
   impose `tpm_id` *sans* `office_id`, donc `scopeOf` le déclare non borné et `/api/state` lui
   livre tous les sites, visites, plans et le journal d'audit.
7. **Verrouillage définitif après oubli de mot de passe** : `failed_logins` n'est remis à zéro
   que par une connexion réussie (`routes/auth.js:58`). Après expiration d'un verrou le
   compteur vaut toujours 8 : la première tentative erronée reverrouille pour 15 minutes.
   L'utilisateur est bloqué en permanence sans intervention d'un administrateur.
8. **Sessions non révoquées** à la désactivation d'un compte ou au changement de rôle — ou
   alors `README.md:946-947` est à corriger.
9. **`PUT /tpm/plans/:id` ne vérifie pas `modifiable(plan.status)`** (`routes/tpm.js:521`) : un
   plan validé reste modifiable.
10. **Fuite de périmètre à l'agrégation** dans `GET /caseload` : `covers` retient volontairement
    les ancêtres (`lib/scope.js:113-115`), mais `agrege` (`routes/caseload.js:72-86,98-108`)
    somme ensuite tout ce qui en descend.

---

## Chantier B — Dépendances (audit du 31/07/2026)

`npm audit` a réellement été exécuté. **13 alertes brutes : 10 côté serveur (9 hautes,
1 modérée), 3 côté web (2 hautes, 1 modérée).** Après analyse d'atteignabilité, le classement
réel est très différent du classement npm — et la vraie faille du serveur n'est dans aucune des
13 alertes.

### B1. Bombe de décompression sur l'import Excel — **atteignable, non signalée par npm**

Aucun avis publié. `wb.xlsx.load()` décompresse intégralement chaque entrée de l'archive, sans
plafond de taille inflatée et sans vérifier que l'entrée appartient au paquet OOXML.

Chemin complet, entièrement dans le flux nominal :
`server/src/index.js:115` → `routes/import.js:76` → `upload.single("file")` (multer
`memoryStorage`, limite `MAX_BODY_MB` = **25 Mo**, `config.js:45`) → `routes/import.js:89`
`readUpload(...)` → `lib/import.js:325` `await wb.xlsx.load(buffer)`.

Le `fileFilter` (`routes/import.js:19`) accepte tout fichier dont le **nom** finit par `.xlsx` —
aucun contrôle de signature.

Mesure réelle rapportée par l'analyse : un `.xlsx` de 299,9 Ko contenant une entrée de 300 Mo de
zéros fait passer le RSS du process de 79 Mo à 775 Mo en 3,5 s. À la limite de 25 Mo,
l'expansion atteint ~25 Go : mort du process Node. `restart: unless-stopped`
(`docker-compose.yml:6`) le relance, l'attaquant recommence. Une seule requête suffit — le
limiteur de débit (600 req/min) n'y change rien.

Prérequis attaquant : un compte authentifié avec le droit `edit` (`lib/import.js:30,127`), donc
`super`, `admin`, `validator` **et `editor`** — le rôle le plus distribué sur le terrain.

**Correctif applicatif, ~15 lignes, sans changer de dépendance** : avant le
`wb.xlsx.load(buffer)` de `lib/import.js:325`, ouvrir l'archive avec JSZip (déjà présent
transitivement), refuser toute entrée dont le nom ne correspond pas à
`/^(\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/)/`, et refuser si la somme des tailles
décompressées annoncées dépasse un plafond (par ex. 10× la taille compressée, ou 200 Mo
absolus). Ajouter un test de non-régression.

*Note : cette mesure vient d'une analyse automatisée avec exécution ; je n'ai pas rejoué
moi-même la mesure mémoire. Le chemin de code, lui, est vérifié ligne à ligne.*

### B2. `xlsx@0.18.5` (web) — **atteignable, seule vulnérabilité de production**

`GHSA-4r6h-8v6p-xvw6` (prototype pollution, CVE-2023-30533) et `GHSA-5pgg-2g8v-p4x9` (ReDoS,
CVE-2024-22363). C'est la **seule** alerte qui survit à `npm audit --omit=dev`.

Risque recalibré à **moyen**, pas haut : le parsing est 100 % côté navigateur (import dynamique
`Settings.jsx:1707`), le serveur ne voit jamais l'octet du XLSForm, et l'accès est restreint aux
rôles `super`/`admin` (`constants.js:117-121`). Conséquence maximale : compromission de la
session d'un onglet administrateur — rôle qui détient pourtant la gestion des comptes et les
jetons ODK déchiffrés. Probabilité faible (fichier fourni par un tiers + action manuelle),
conséquence élevée.

Voir chantier 3 pour la remédiation et sa contrepartie de chaîne d'approvisionnement.
Mitigations de coût nul en attendant : garde de taille avant `Settings.jsx:1708`
(`if (file.size > 5*1024*1024) …`).

### B3. `vite@5.4.21` + `esbuild` (web, développement) — amplifié par une ligne de configuration

Trois avis Vite (`GHSA-fx2h-pf6j-xcff` bypass `server.fs.deny` sous Windows CVSS 7.5,
`GHSA-4w7w-66w2-5vf9` traversée de chemin, `GHSA-v6wh-96g9-6wx3` fuite de hash NTLM sous
Windows) et un avis esbuild (`GHSA-67mh-4wv8-2f99`).

**Aucun impact en production** — ce sont des dépendances de développement. Mais
`web/vite.config.js:21` déclare **`host: "0.0.0.0"`** (vérifié) : le serveur de développement
écoute sur toutes les interfaces, ce qui est la précondition des trois avis Vite. Que ce ne soit
pas théorique est attesté par `server/src/config.js:32`, qui liste `http://10.0.10.147:5173`
parmi les origines CORS.

**Correctif immédiat, coût nul, sans changer une version : remplacer `host: "0.0.0.0"` par
`host: "127.0.0.1"` dans `web/vite.config.js:21`.** Codespaces continue de fonctionner (le
transfert de port se fait vers `127.0.0.1` dans le conteneur).

Ensuite, à planifier : `vite@^7` + `@vitejs/plugin-react` correspondant (deux majeures), et
**supprimer `"esbuild": "^0.28.1"` de `web/package.json:19`** — Vite charge sa propre copie
imbriquée (0.21.5), donc cette ligne est un faux correctif qui trompe le prochain lecteur.

### B4. Les 9 alertes « high » du serveur sont du bruit — **ne pas lancer `npm audit fix --force`**

`brace-expansion` (`GHSA-mh99-v99m-4gvg`) compte **9 fois** dans l'audit, mais c'est **un seul
avis** répercuté sur 8 paquets intermédiaires (`archiver`, `archiver-utils`, `glob`,
`minimatch`, `readdir-glob`, `rimraf`, `zip-stream`, `exceljs`).

**Inatteignable** : MEMS n'utilise que l'API non-streaming d'ExcelJS (`lib/import.js:251,325`,
`routes/import.js:70`, `import-odk-forms.js:89`), qui passe par JSZip et non par `archiver`.
`archiver` est bien chargé au `require`, mais charger n'est pas appeler : `brace-expansion` n'est
atteint que si un motif glob est évalué, et l'entrée du bug est une chaîne de motif, pas un
contenu de fichier.

`uuid@8.3.2` (`GHSA-w5hq-g745-h8pq`) : **inatteignable doublement** — l'avis ne vise que v3/v5/v6
avec l'argument `buf`, or exceljs n'appelle que `v4()` sans argument, et `uuid@8.3.2` n'exporte
même pas `v6`.

**`npm audit fix --force` installerait `exceljs@3.4.0` : c'est un rétrogradage de deux majeures
qui casse l'API utilisée.** `exceljs@4.4.0` est bien la dernière version publiée — il n'existe
aucun correctif amont. → Déclarer l'exception dans un fichier de suppression versionné avec la
justification et une date de réexamen, et documenter dans le README.

### B5. CVE SQLite invisible de npm

`better-sqlite3@11.10.0` embarque SQLite 3.49.2, en deçà du seuil de **CVE-2025-6965**
(troncature d'entier, corruption mémoire, CVSS 7.2). `npm audit` ne voit pas les bibliothèques C
compilées dans un binaire prébuilt. Inatteignable aujourd'hui (pas d'injection SQL connue), mais
c'est un amplificateur : le jour où une injection apparaît, on passe de « fuite » à « exécution
de code ». → `npm i better-sqlite3@13.0.2` (embarque SQLite 3.53.4), puis `npm test`.

### B6. Dettes de version sans CVE, à traiter en lot

- **Node 20 est en fin de vie** et épinglé à quatre endroits : `Dockerfile:2,10,18` et
  `.github/workflows/ci.yml:13`. C'est la dette la plus structurelle.
- `exceljs@4.4.0` : dernière version publiée, mais stable depuis octobre 2023 — cul-de-sac amont.
- `recharts@2.15.4` : **formellement déprécié** par son mainteneur (« 1.x and 2.x branches are no
  longer active »). → v3.
- `lucide-react@0.446.0` → 1.28.0 ; `react@18.3.1` → 19 (bloque `@vitejs/plugin-react` 6 et
  recharts 3) ; `tailwindcss@3.4` → 4 ; `jsdom@25` → 30 (tests seulement) ;
  `better-sqlite3` (voir B5) ; `express@4.22.2` (branche 4 **toujours maintenue**, publiée en
  mai 2026 — pas urgent) ; `zod@3.25.76` (faux écart, embarque déjà Zod 4 sous `zod/v4`) ;
  `bcryptjs@2.4.3` (vérifié : utilise `crypto.randomBytes`, aucun enjeu de sécurité).
- Déjà à jour, à ne pas toucher : `multer@2.2.0`, `helmet@8.3.0`, `jsonwebtoken@9`,
  `postcss`, `autoprefixer`.

### B7. Alerte PostCSS `PreviousMap` (signalée le 01/08/2026) — non atteignable ici

**Le mécanisme rapporté est réel.** `postcss` lit l'annotation `/*# sourceMappingURL=… */`
de toute CSS passée à `process()` et déréférence ce chemin sur le disque, sans schéma ni
garde de traversée (`lib/previous-map.js`, `loadFile`). Une CSS **contrôlée par un
attaquant** peut ainsi faire lire un fichier arbitraire du processus Node et en fuiter les
~10 premiers octets via le message d'un `SyntaxError` de `JSON.parse` (plus un oracle
d'existence de fichier et un vecteur de déni de service).

**Vérifié : le vecteur n'existe pas dans MEMS.** L'attaque exige que de la CSS non fiable
atteigne `postcss().process()` — les cas cités (thèmes CMS, feuilles de style téléversées,
rendu de commentaires) sont tous des pipelines de CSS utilisateur au moment de l'exécution.
Dans MEMS :
- `postcss` est une **devDependency** de `web/` (8.5.25), jamais une dépendance de
  production, et **absente du serveur** — rien de ce qui est déployé ne l'embarque ;
- il ne tourne **qu'au build**, via Vite/Tailwind (`web/postcss.config.js`), sur la CSS
  **du projet** — jamais sur une entrée venue de l'extérieur ;
- **aucun code applicatif** n'appelle `postcss().process()` (vérifié par recherche).

Autrement dit, l'entrée de PostCSS n'est jamais sous le contrôle d'un tiers : elle est le
code source de première main, compilé sur une machine de build. La faille ne peut pas se
déclencher. C'est aussi pourquoi l'audit de production reste propre — postcss n'est pas dans
la surface auditée.

**Condition de réveil, à surveiller** : cette alerte redeviendrait pertinente le jour où
MEMS traiterait de la CSS fournie par un utilisateur (thème personnalisable, feuille de
style téléversée, éditeur de rapport rendant de la CSS libre). À ce moment-là — et
seulement là — il faudrait soit passer `{ map: false }` à `process()`, soit assainir
l'annotation avant, soit relire l'état amont de PostCSS (le rapport est disputé côté
mainteneur, qui tient la lecture des source maps pour un comportement voulu d'un outil de
build). Tant que la surface reste « build-time, CSS de première main », il n'y a rien à
corriger.

### B8. Minuteur relâché avant la lecture du corps (`odkClient.js`, `foundry.js`)

Relevé en marge du lot d'authentification, hors de son périmètre : `fetchJson` (odkClient)
et `texteBorne`/`res.json()` (foundry) désarment leur délai **dès l'arrivée des en-têtes**,
puis lisent le corps sans échéance. Une source qui répond `200` puis se tait fige la requête
Express en cours. Le lot a corrigé la variante **grave** de ce défaut dans `lib/authSortante.js`
(là où la promesse figée restait dans `enVol` et rendait la source injoignable pour tout le
serveur — cf. le test 151) ; ces deux-ci n'ont pas cette amplification, mais restent à
aligner sur `fetchBorne`, qui lit désormais le corps sous le même délai. Petit, isolé, sans
CVE — à traiter au prochain passage sur ces fichiers.

---

## Chantier C — Chaîne de construction et de livraison

1. **L'audit de la CI est décoratif.** `.github/workflows/ci.yml:38-41` :
   `npm audit --audit-level=high || true`. Le `|| true` avale le code de sortie — l'étape est
   verte quelle que soit la vulnérabilité. **C'est ce qui a laissé passer `xlsx` depuis le
   début.** → Retirer `|| true`, séparer serveur et web, utiliser `--omit=dev` côté web, et
   tenir une liste d'exceptions justifiées et datées (voir B4).
2. **Aucun `.dockerignore`** (vérifié : le fichier n'existe pas). `Dockerfile:26`
   `COPY server/ ./server/` s'exécute après la copie des `node_modules` et embarque donc tout
   `server/data/` — dont la base SQLite locale — et tout `.env` présent dans l'arborescence de
   build. `.gitignore` les couvre pour git, mais **Docker ne lit pas `.gitignore`**.
   → Créer un `.dockerignore` (`node_modules`, `data`, `*.db*`, `.env*`, `*.log`, `dist`).
3. **Images de base non épinglées** : `node:20-bookworm-slim` sans digest, trois fois.
4. **Actions CI épinglées par étiquette mobile** (`actions/checkout@v4`, `actions/setup-node@v4`)
   et **aucun bloc `permissions:`** dans le workflow.
5. **Cartes source livrées en production** : `web/vite.config.js:8` impose `sourcemap: true`, et
   le build émet les `.map` complets (plusieurs Mo). Le code source complet est donc servi aux
   utilisateurs. → Décider : conserver pour le débogage, ou passer à `hidden`.
6. **Le devcontainer ne respecte pas le lockfile** : `npm run install:all` fait `npm install` et
   non `npm ci` — la CI et Docker font bien les choses, le chemin développeur non.
7. **`npx esbuild` dans les tests** (`web/test/calc.test.js:21`, `e2e.test.js:68`) : si la devDep
   disparaissait, `npx` irait la chercher au registre pendant la CI.
8. **Aucun Dependabot ni Renovate** (vérifié : aucun fichier de configuration).
9. **Mot de passe administrateur écrit en clair sur disque** : `.devcontainer/setup.sh:36` fait
   `npm run seed | tee server/.admin-credentials.log`. `*.log` est bien dans `.gitignore` — il
   n'y a donc pas de fuite vers le dépôt — mais le fichier reste lisible sur le disque et serait
   embarqué dans une image Docker construite depuis ce répertoire tant que le point 2 n'est pas
   corrigé.
10. **Aucune limite de ressources** sur le conteneur (`docker-compose.yml` : ni `mem_limit` ni
    `deploy.resources.limits`) — ce qui aggrave B1.

---

## Chantier D — Persistance des réglages (généralisation de la remarque A)

Décider et traiter **en bloc** : `scoring`, `roles`, `mmr`, `lists`, `actCategories`,
`outcomePlan`, `formulas`. Aujourd'hui tous éditables et tous perdus au rechargement
(`App.jsx:18-19,90-99` ; `Settings.jsx:81-152,1942-1947` ; `Planning.jsx:387-397,1118-1120`).
Soit on les persiste, soit les écrans passent en lecture seule — l'état actuel, qui laisse
saisir dans le vide, n'est pas tenable.

S'y ajoutent :
- **« Générer le plan »** (`Planning.jsx:435-456`) n'écrit rien côté serveur.
- ~~**Le « Jeton général » ODK**~~ **— réglé.** Le champ promettait un repli que le serveur
  refusait (`odkToken` est dans `FORBIDDEN`, le jeton général ne quittait jamais le
  navigateur) : le lot d'authentification des sources l'a **supprimé** plutôt que raccommodé.
  Chaque source ODK porte désormais son propre justificatif, et le badge suit ce que le
  serveur détient réellement.

---

## Chantier E — Finir le chantier 1

1. Transmettre `geo_pcode`, `office_id` et `partner_id` à la création d'une ligne de PDD, aux
   **trois** endroits : `PddGenModal` (`Planning.jsx:863-875`), « Ajouter une ligne »
   (`:700-703`), import CSV (`:651-658`). Le plus sûr est de le faire une fois dans `save`
   (`:627-631`) et `saveMany` (`:634-638`). Modèle existant : `Settings.jsx:227` résout déjà
   `partner_id` pour les sites.
2. Remplacer le champ bureau libre par un `Select` sur `db.lists.offices` et l'ajouter à la
   garde `canSubmit` (`Planning.jsx:849,861,891`).
3. Aligner le droit de l'écran Rations sur celui du serveur (ou l'inverse), et afficher un
   avertissement quand le compte n'a pas le droit d'écrire.
4. Notifier dès le premier échec pour les statuts 4xx (`App.jsx:117-119`), qui ne sont jamais
   réessayés (`api.js:207-214`).
5. Ajouter la denrée à la clé de réconciliation de l'import PDD (`import.js:128,219-231`) et
   étendre l'énumération « Type » à PECMAM et FFA (`import.js:137,210`).
6. Écrire les tests annoncés mais absents : côté serveur (PUT `/api/collections/pdd` créant N
   lignes Food, tonnage vérifié, rejet d'un bureau vide) et côté web (parcours
   « Rations → Générer par commune »).

---

## Chantier F — Retirer ce qui est simulé, mort ou faux

1. **Bouton « Extraire » de Programme → Sources** : n'appelle rien, invente un nombre de
   soumissions (`Math.random()*40`) et le persiste (`ActualData.jsx:617-622`). La vraie route
   existe (`POST /api/odk-forms/:id/pull`) et est utilisée par l'écran jumeau de Paramètres.
   → Brancher ou supprimer.
2. **Onglet « API »** (`Settings.jsx:1820-1866`) : documente sept points d'entrée `/api/v1/*`
   qui n'existent pas. Idem « Tester la connexion » (`:1661`).
3. **Encadré trompeur** de Paramètres → Utilisateurs (`Settings.jsx:1902-1904`), qui nie le
   cloisonnement serveur.
4. **Code mort** : `web/src/lib/seed.js` (entier), `legacyScore`/`D_WEIGHTS`
   (`calc.js:31-45`), `seedPDD` (`Planning.jsx:566-601`), anciens conteneurs `Planning`/
   `ActualData` (`Planning.jsx:57-70`, `ActualData.jsx:14-30`), `api.saveTpmLines` et les
   suppressions TPM (`api.js:132,141,146`) sans aucun appelant, colonne `rev` du caseload
   jamais lue (`006_revisions.sql:36`).
5. **Deux modèles de population coexistent** : `population`/`population_values` sont toujours
   synchronisées et affichées alors que `caseload` est censé les remplacer
   (`App.jsx:18`, `collections.js:48-51`, `calc.js:101-108`).
6. **Deux vocabulaires pour `activity_tag`** : `caseload` porte `URT/NTA/SMP`, `pdd` porte
   `URT_GD/URT_PREV`.
7. **`users.tabs` est une coquille côté serveur** : aucune route ne le consulte
   (`001_init.sql:62`) — retirer un onglet masque un menu mais ne ferme aucun accès.

---

## Chantier G — Remettre le README d'aplomb

Le README se contredit et se trompe sur au moins sept points, tous vérifiés :

1. `README.md:9` annonce « 25 tests d'API + 10 tests de bout en bout », `README.md:1120` annonce
   « 96 tests d'API puis 12 » — le comptage réel est **102 tests d'API + 12 e2e + 4 unitaires**.
2. L'arborescence (`:84-91`) s'arrête aux migrations 001-008 ; il y en a **15**.
3. « Trente-et-une tables » (`:128`) → **45** (46 avec `_migrations`).
4. Section `### Rôles` vide à `:873`, la vraie étant à `:917`.
5. Routes non documentées : `GET /auth/sessions`, `PUT /tpm/plans/:id`,
   `POST /tpm/plans/:id/close`, `DELETE /tpm/expenses/:id`.
6. « Plus rien de spécifique à Madagascar n'est écrit dans le code » (`:179-183`) : faux —
   `MGA` en dur à neuf endroits **et dans le schéma** (`011_tpm.sql:69`), libellés
   « fokontany »/« commune » en dur dans six fichiers alors que `web/src/lib/levels.js` existe
   pour cela.
7. La démo hors ligne promise (`:10,69`) n'est pas dans le build : `vite.config.js` ne déclare
   aucune entrée pour `demo.html`, et le serveur renvoie `index.html` pour tout chemin hors
   `/api` (`index.js:125`). En production, « Ouvrir la démo » réaffiche l'application.

---

# Demandes produit du 31/07/2026

25 entrées. Difficulté : **S** < 1 j · **M** 1-3 j · **L** 3-8 j · **XL** > 8 j ou décision
produit préalable.

## Chantier H — Structure des bureaux et configuration du pays

### H1 — Hiérarchie des bureaux : area office → sous-bureau → antenne  · **XL**

*« Ajouter antennes si on modifie le bureau devrait être liste des bureaux et on peut supprimer
si non pertinent, parce qu'un area office peut avoir plusieurs sous-bureaux et antennes, ou un
sous-bureau peut avoir une ou plusieurs antennes. »*

**Aujourd'hui la table `offices` est plate.** `001_init.sql:8-16` déclare `id`, `name`, `code`,
`kind` (`'field'|'hq'`), `active` — **aucune colonne parent, aucun niveau**.
`009_office_config.sql:39` ajoute une colonne `antennes` qui est un **tableau JSON de chaînes** :
une antenne n'est donc pas une entité, elle ne peut porter ni parent, ni périmètre, ni compte
utilisateur. `sites.antenne` (`001_init.sql:92`) est également du texte libre.

**Travail** : migration ajoutant `parent_id` et un niveau (`area|sub|antenne`) à `offices` ;
reprise des valeurs texte déjà saisies dans `offices.antennes` et `sites.antenne` ; refonte de
`SetOffices` pour choisir le parent dans la liste des bureaux et détacher ; **et surtout revue de
`lib/scope.js`** — `officeBound`/`scopeOf` supposent aujourd'hui un bureau plat, il faut décider
si le périmètre d'un area office englobe celui de ses antennes (héritage) ou non.

→ Voir **Q2** (trois décisions bloquantes).

### H2 — Retirer le sous-onglet « Sites » des Paramètres  · **S**

**C'est un doublon exact.** `SitesModule` (`Settings.jsx:176-455`) est déjà monté à l'identique
par Suivi-évaluation → Registre des sites (`Merged.jsx:88`). Seule la note d'introduction
(`Settings.jsx:303`) est propre au montage dans les Paramètres. Rien à déplacer.

→ Voir **Q3** (effet sur les droits d'accès).

### H3 — Fusionner « Bureaux » et « Périmètre des bureaux » en un seul paramètre  · **M**

Deux sous-onglets frères (`Settings.jsx:26-27`, rendus `:36` et `:40`) pour un seul objet : le
périmètre n'est pas une entité autonome, c'est un attribut du bureau — `office_scope` a pour clé
primaire `(office_id, geo_pcode)` (`007_office_scope.sql:25-32`). Les deux écrans affichent déjà
les mêmes colonnes à partir de deux routes qui calculent la même chose.

**Travail** : fusionner `SetScope` dans `SetOffices` sous forme de panneau par bureau. Aucune
migration. À faire **après H1**, dont la hiérarchie change la maquette.

→ Voir **Q4**.

### H4 — Téléverser le shapefile et définir adm1-adm4 depuis la fiche pays  · **L**

Aujourd'hui le téléversement du shapefile est dans l'onglet **Localités**
(`Settings.jsx:1272-1376`), qui travaille implicitement sur le pays courant, et la fiche pays ne
montre que le *nombre* de millésimes (`Settings.jsx:678`). Les libellés de niveaux existent déjà
et sont éditables (`Settings.jsx:718-733`, `web/src/lib/levels.js`).

**Travail** : déplacer l'import du découpage et des contours dans `SetCountry`, y afficher les
millésimes du pays, et rendre les libellés de niveaux solidaires du pays.

→ Voir **Q5** : « définir les adm1 à adm4 » signifie-t-il seulement les *nommer* (déjà fait) ou
*déclarer combien de niveaux ce pays possède* ? La seconde lecture impose une colonne `depth` et
la revue de tous les écrans qui supposent quatre niveaux.

## Chantier I — Répertoire des localités

### I1 — L'export des Localités est défectueux  · **M**

**Défaut principal trouvé** : `Settings.jsx:1177` fait `toCSV(dir.rows, …)`, or `dir.rows` est la
**page affichée**, plafonnée à `PER = 200` lignes (`Settings.jsx:1068,1085`). Sur un millésime
malgache d'environ 18 000 fokontany, l'utilisateur obtient **200 lignes sur 18 000, sans aucun
avertissement**. Neuf défauts secondaires ont été relevés (BOM UTF-8 absent, séparateur,
échappement des guillemets, p-codes à zéro non significatif écrasés par Excel).

**Travail** : exporter la totalité du jeu filtré, pas la page. → Voir **Q6** (CSV ou XLSX ?).

### I2 — Le répertoire doit sortir la liste issue du shapefile, puis les sites avec leur type  · **L**

**La première moitié est déjà faite** : `geo_unit` est peuplée exclusivement par l'import de
shapefile (`Settings.jsx:1096-1167` → `routes/geo.js:198-218` → `lib/geo.js:33-130`), et le
répertoire n'affiche que `geo_unit`. Le travail réel est la jointure localité → sites → type et
son export.

→ Voir **Q7**, **bloquante** : le dépôt porte **deux typologies qui se recouvrent** —
`site_type` (liste figée, `constants.js:194` : FDP, Health Center, School, Warehouse, Market,
Community site, Other) et `poi_subtype` (référentiel en base). Laquelle fait foi ?

## Chantier J — Indicateurs et rations

### J1 — Modèle d'indicateurs à télécharger, et import  · **L**

Un export CSV rudimentaire existe (`Settings.jsx:1439`, colonnes `id,name,basket,unit,target,
dir,method,freq`) mais **aucun modèle** : sur une masterlist vide il produit une seule ligne
d'en-têtes.

**Travail recommandé** : ajouter un troisième type de lot au pipeline d'import qui existe déjà
pour `caseload` et `pdd` (`lib/import.js`, `routes/import.js` : modèle → téléversement →
analyse → diff → confirmation), plutôt que d'écrire un import ad hoc.

→ Voir **Q8** (où placer le téléchargement et le téléversement).

### J2 — Méthode de collecte en liste déroulante  · **S**

Le champ existe (`method TEXT`, `001_init.sql:213`) mais **sans contrainte** — saisie libre
(`Settings.jsx:1502`), là où `direction` juste au-dessus porte un `CHECK`. D'où « Enquête
ménage » / « enquete menages » / « HH survey » indistinguables.

✅ **Q9 est fermée** par le gabarit RAM : 25 méthodes officielles + 6 fréquences (voir chantier N).
Les cinq valeurs actuelles viennent du jeu de démonstration — `web/src/lib/constants.js:99-109`
(`D_INDICATORS`) — et n'en recouvrent qu'une partie. Reste à trancher la **multivaluation**
(voir chantier P).

### J3 — Aperçu de ration paramétrable, résultat en kg  · **S**

*« Mettre la ration par gramme journalière et pour tester mettre nombre de jours et
multiplicateur à saisir, ensuite ration × nb de jours × multiplicateur, résultat en kg. »*

La ration **est déjà** saisie en grammes/personne/jour (`Settings.jsx:1610`). Ce qui manque :
les deux champs (aujourd'hui `sample = 1000` et `days = 15` sont **en dur**,
`Settings.jsx:1595`), et le résultat en kg (aujourd'hui en tonnes, `÷ 1e6`). L'arrondi `r2`
(`:1613`) écrase les petites rations : 1 g/pers/j affiche 0,02 t au lieu de 0,015.

→ Voir **Q10**, **bloquante** : que désigne « multiplicateur » — le nombre de bénéficiaires
(qui remplacerait `sample`), ou un facteur *supplémentaire* appliqué en plus des bénéficiaires ?
Et la demande change-t-elle aussi le calcul du PDD (`Planning.jsx:854-855`, en tonnes) ou
seulement l'aperçu de test ?

## Chantier K — Rapports, sauvegarde, accueil

### K1 — Indicateurs calculés dans les modèles de rapport, et rendu au choix  · **L**

Le générateur n'offre que **sept blocs figés en dur** (`Reports.jsx:80-88`), et un modèle ne
stocke qu'un tableau de chaînes (`Reports.jsx:219-220`). Les formules de performance par jeu de
données (`Analytics.jsx:100-136`) et les calculs de couverture (`Settings.jsx:1509`) n'y
figurent pas et ne peuvent pas y être ajoutés.

**Travail** : passer d'un tableau de chaînes à un tableau d'objets `{source, ref, rendu}` dans
`reportTemplates` ; alimenter la liste des choix depuis les formules existantes ; ajouter le
sélecteur de rendu (recharts est déjà là).

**Précisé le 01/08/2026 — un vrai constructeur de rapport infographique, fondé sur les
indicateurs.** Un modèle se configure *par type de rapport*. On y dépose les indicateurs
voulus, tirés du **référentiel d'indicateurs** (Master List du PAM et/ou XLSForms mappés — les
mêmes qui alimentent les dashboards, chantier T). Pour CHAQUE indicateur retenu, on choisit sa
**représentation** : graphique (type — barres, ligne, secteurs… —, **couleurs**, forme), tableau,
ou autre. Cible visuelle : un rapport **infographique**, inspiré de `docs/dashboard_suivi_
processus_WFP.html` (couleurs, cartes de synthèse, bandes de classes), sans le cloner —
présentation adaptée à l'audience. C'est le pendant « sortie figée » des dashboards « sortie
vivante » : les deux lisent le même référentiel d'indicateurs, l'un pour l'écran, l'autre pour
le document exporté (PDF/Word/HTML). Dépend donc du référentiel d'indicateurs (chantier T) et
du référentiel d'activités (S3). Vient dans le module **Accueil+Analyses+Rapports** de la
feuille de route.

→ Voir **Q11** (quelles formules exactement).

### K2 — Sauvegarde sélective et restauration  · **XL**

**Rien n'existe** (recherche `backup|sauvegarde|restaur|restore` : aucune occurrence). Le seul
approchant est l'« instantané JSON » (`Settings.jsx:1829-1837`), calculé dans le navigateur,
déjà cloisonné par bureau, et couvrant 8 collections sur 45 tables — inutilisable comme base.

**Fonction à fort risque.** Garde-fous nécessaires : droit `super`, confirmation explicite,
sauvegarde préalable automatique avant toute restauration, journalisation d'audit, gestion de
l'ordre des clés étrangères, et décision sur le chiffrement au repos (`lib/crypto.js`) et les
mots de passe.

→ Voir **Q12**, **bloquante** : archivage/reprise après sinistre, transfert entre instances, ou
export pour analyse externe ? Les trois n'ont ni le même format ni les mêmes garde-fous.

### K3 — Retirer les tâches urgentes de l'accueil, cloche de notifications en haut  · **M**

Les « tâches urgentes » sont un calcul **100 % client** sans contrepartie serveur
(`Home.jsx:11-45`, sept familles dérivées du store). Retirer la carte (`Home.jsx:142-163`) est
trivial ; poser une cloche dans `Shell.jsx` l'est aussi.

Le vrai écart est de nature : ce qui est affiché n'est pas une notification mais une dérivation
de l'état courant — sans historique, sans destinataire, sans lu/non-lu.

→ Voir **Q13** : simple déplacement dans un popover (**M**), ou vraie notion de notification
côté serveur avec table et état lu/non-lu (**L/XL**) ?

## Chantier L — Suivi des sites et suivi tiers

### L1 (13a) — Colonnes adm1/adm2/adm3 avec les libellés du pays dans le plan de suivi  · **M**

L'écran est `ProcessPlan` (`Planning.jsx:427-478`), la grille est `MonthGrid`
(`Planning.jsx:15-48`). Elle n'a **qu'une seule colonne d'identification**, dont l'en-tête est la
chaîne en dur « Élément » (`:18`) ; seul `adm3` survit, noyé dans une sous-ligne de texte
(`:472`). adm1 et adm2 ne figurent nulle part.

→ Voir **Q14** : faut-il une quatrième colonne adm4 ? Les sites sont le plus souvent rattachés
**au niveau adm4** (`web/src/lib/geo.js:48`) — sans cette colonne, deux sites de fokontany
différents d'une même commune sont indistinguables.

### L2 (13b) — Planifier en filtrant par commune ou district  · **L**

`ProcessPlan` n'a que deux filtres, ni l'un ni l'autre géographique : bureau et activité
(`Planning.jsx:428,468-469`).

**Écart bloquant découvert au passage** : la génération automatique ne respecte de toute façon
aucun filtre, puisqu'elle balaie `d.sites` en entier (`Planning.jsx:437`) — et son résultat
n'est pas persisté (voir chantier D).

### L3 (13c) — Infobulles sur les symboles de la grille  · **S**

Les symboles réels sont produits en `Planning.jsx:30-39` : cinq états de fond (hachures
« inactif », vert plein, ambre, gris) et quatre glyphes (`✓`, `!`, `●`). L'infobulle actuelle ne
dit que le mois (`:37`) ; la légende (`:49-54`) explique les couleurs mais pas les glyphes, et
son échantillon « Inactif ce mois » (gris plein) **ne correspond pas au rendu réel** (hachures).

### L4 (13d) — Marquer « déjà suivi » depuis les données ODK Central  · **XL**

**Constat central, vérifié : il n'existe aucune table `submissions` dans le dépôt.** Les 15
migrations créent 45 tables, aucune ne porte ce nom. Ce que la base contient d'ODK est un blob
JSON par formulaire (`odk_forms.raw`, migration 015), **sans aucune clé vers `sites`**. Le champ
`odk_forms.site_field` prévu pour ce rattachement **n'est jamais consommé côté serveur**.

La demande suppose donc une donnée qui n'existe pas. Il faut d'abord construire le rattachement
soumission → site, ce qui est un chantier à part entière.

→ **Débloqué en grande partie par les XLSForms du 31/07/2026** : voir **chantier O**, qui
spécifie la table `submissions`, le code site réellement présent dans chaque formulaire et le
résolveur en trois passes. Une fois O1–O3 faits, L4 retombe à **M**. Reste ouvert : la période
qui définit « déjà suivi » (**Q15c**).

### L5 (14a) — Affectation automatique des sites au prestataire après validation du plan  · **XL**

**Trois briques manquent, pas une.** (a) *Le déclencheur* : le plan de suivi MEMS n'a pas
d'état — `site_months` (`001_init.sql:129-141`) ne porte aucun statut, et « Générer le plan »
n'est même pas persisté. (b) *L'objet affecté* : le module TPM raisonne en **zones/communes**
(`tpm_zone.geo_pcode`, `011_tpm.sql:142-162`), jamais en sites. (c) *La règle d'affectation*
elle-même.

→ Voir **Q16**, bloquante : sur quel critère un site va-t-il à tel prestataire plutôt qu'à tel
autre ?

### L6 (14b) — Brouillon de budget mensuel pré-rempli  · **L**

**L'état brouillon existe, le pré-remplissage non.** `tpm_plan.status` a bien `brouillon` par
défaut (`011_tpm.sql:126-128`) et `modifiable()` ne rend éditables que `brouillon` et `renvoye`
(`lib/tpm.js:256`). Mais `POST /api/tpm/plans` (`routes/tpm.js:375-404`) crée un plan **vide de
zones et de lignes**, donc de budget nul — et `POST /plans/:id/submit` refuse justement de le
soumettre (`:550-553`).

→ Voir **Q17** (qui prépare le brouillon, et d'où viennent les quantités par défaut).

### L7 (14c) — Colonnes du tableau du bas : adm1-3, nom du prestataire, nb de sites  · **M**

En-têtes actuels (`Tpm.jsx:718-720`) : Zone | Activité | Équipe | Sup. | Agents | Jours | …
Le serveur ne renvoie qu'un libellé fusionné « commune (district) » (`lib/tpm.js:106-109,126`) —
il faut trois champs distincts.

→ Voir **Q18** : le nom du prestataire est constant sur tout le plan (un plan = un prestataire,
index unique `011_tpm.sql:137`) — une colonne qui répète la même valeur, ou un en-tête ?

### L8 (14d) — Saisie agents/superviseurs/jours/trajets/véhicules/carburant, sans total  · **L**

**Bonne nouvelle : les unités de coût existent déjà presque toutes.** `tpm_rate`
(`011_tpm.sql:99-112`) porte un `driver CHECK IN ('superviseur','agent','vehicule','carburant',
'forfait')`, et `tpm_zone` porte déjà `supervisors, agents, days, travel_days, vehicles,
fuel_litres` (`:142-162`). « Sans le total » est **déjà acquis** : aucun total n'est stocké ni
saisi (`lib/tpm.js:13-19`).

L'essentiel de la demande est donc un **réagencement d'IHM** : déplacer ces saisies de la ligne
de zone (`Tpm.jsx:734-739`) vers un bloc sous le budget.

→ **Q1 bis / bloquant** : le fichier Excel de référence (« l'excel que je t'ai partagé »)
**n'est pas dans le dépôt** — vérifié, aucun `.xlsx`, `.xls`, `.xlsm`, `.ods` ni `.csv` hors
`node_modules`. Le classeur `MAHAVOTSE_BUDGET_TPM` n'apparaît que dans des commentaires de code.
La structure exacte du budget attendu en dépend.

### L9 (15) — Contrats et barèmes en sous-module du suivi budgétaire, panneau latéral rétractable  · **M**

Aujourd'hui deux onglets **frères** de même niveau (`Tpm.jsx:95-96`). L'écart est purement
structurel et d'interface : aucune donnée ne manque (`GET /api/tpm` renvoie déjà tout), le
tableau budgétaire n'est simplement pas cliquable et il n'existe pas de composant de panneau
latéral dans `web/src/components/ui.jsx`.

→ Voir **Q19** (contenu et ordre du panneau).

## Chantier M — Cartographie

### M1 (16a) — Passer le rendu à l'API Google Maps  · **XL**

**Aujourd'hui la carte est un SVG écrit à la main**, sans aucune bibliothèque cartographique :
projection équirectangulaire calculée à la main (`MapView.jsx:13-28`), zoom borné à ×12
(`:262`), **zéro appel réseau externe**.

Conséquences à assumer, exposées sans militer :
- **clé d'API Google obligatoire et facturable à l'usage** — à fournir et à payer ;
- **chaque poste appellera des serveurs Google** à chaque ouverture de la carte, ce qui renverse
  une propriété que le code et le README revendiquent (déploiement souverain derrière un proxy
  TLS) ;
- **la carte cessera d'afficher un fond dans un bureau sans accès internet** ;
- la **CSP** posée par helmet (`server/src/index.js`) devra être ouverte aux scripts Google ;
- « se focaliser sur le pays pour sortir le fond de carte » ne peut pas signifier que Google ne
  servirait que les tuiles de ce pays : Google sert le monde. On ne peut que **borner la vue**
  et/ou **griser l'extérieur** par un masque polygonal.

*L'alternative usuelle est un fond de tuiles OSM/MapLibre, auto-hébergeable et sans clé ; le
chiffrage ci-dessous reste néanmoins celui de Google Maps, puisque c'est ce qui est demandé.*

→ Voir **Q20**.

### M2 (16b) — Cadrer automatiquement sur le pays choisi  · **M**

Le pays courant porte **déjà un centre** en base (`013_country.sql:47-49`, Madagascar à
-18,9 / 47,5), éditable, transmis au navigateur — **et jamais utilisé**. La carte se cadre
uniquement sur ce qu'elle a reçu, donc sur un pays sans contours elle zoome sur la seule région
peuplée de sites, et sur un pays sans données elle n'affiche rien.

Il manque une **emprise** (le centre seul ne permet pas de choisir un zoom). Trois options, dont
deux **sans migration** : exposer l'emprise du millésime courant (`lib/geom.js:242-255` calcule
déjà la bbox), ou calculer une bbox sur les `lat/lon` de `geo_unit`.

→ Voir **Q21**.

### M3 (16c) — Géolocalisation des sites et panneau d'informations à droite  · **M**

**Les deux briques existent déjà.** Les sites portent `lat/lon` (`Settings.jsx:540-541`), servis
par `GET /api/analytics/map` avec 17 colonnes et un plafond de 6000 lignes
(`routes/analytics.js:20-43`). **Le panneau de droite existe** (`MapView.jsx:397-493`) et
contient déjà l'échelle thématique, la fiche de l'unité administrative, la légende et une fiche
de site à huit champs.

Le panneau est donc à **enrichir et élargir** (`w-72` figé), pas à créer. Recommandation : ne
pas élargir `/api/analytics/map` mais ajouter une route de détail à la demande
`GET /api/analytics/site/:id` appelée au clic.

→ Voir **Q22**, **bloquante** : quelles sont exactement les « informations pertinentes » ?

### M4 (16d) — Superposer le shapefile sur le fond de carte  · **L**

**Il n'y a rien à intégrer : le shapefile est déjà lu, simplifié, stocké, servi et dessiné.**
Lecture entièrement dans le navigateur sans dépendance (`web/src/lib/shapefile.js` : index ZIP,
`DecompressionStream`, DBF avec repli windows-1252, SHP binaire, conversion des anneaux ESRI en
GeoJSON) ; envoi par lots de 120 (`Settings.jsx:1199-1236`) ; simplification Douglas-Peucker et
stockage en deux résolutions avec bbox (`lib/geom.js:133-207`, `012_geo_geom.sql:33-53`) ;
service en FeatureCollection GeoJSON (`routes/geo.js:273-296`) ; écran d'administration complet
(`Settings.jsx:1272-1330`).

L'écart est **entièrement dans le portage du dessin vers Google Maps**, avec trois difficultés
que le SVG masque aujourd'hui : le **volume** (`google.maps.Data` n'est pas conçu pour 1500
polygones), la **résolution** (le serveur sert par défaut la version simplifiée à ~550 m de
tolérance, invisible à ×12 mais visiblement décalée sur un fond satellite à fort zoom), et le
**style** (toute la logique d'aplat thématique doit passer d'attributs JSX à une fonction de
style impérative).

→ Voir **Q23**.

---

# Documents de référence reçus le 01/08/2026

Vingt-cinq fichiers déposés sur `main`, analysés en totalité le jour même (sept lectures
parallèles, chaque fichier ouvert pour de vrai — feuilles comptées, variables citées).
L'ensemble change la nature du backlog : **les référentiels qui manquaient existent
désormais dans le dépôt**, et trois chantiers passent de « inventer » à « importer ».

## Ce que chaque famille apporte

**Les quatre applications QC (R/Shiny) et la syntaxe SPSS** sont le contrôle qualité réel
de l'équipe, et elles partagent une même architecture, directement transposable : trois
familles de règles (A erreurs dures, B cohérences à confirmer, C signaux d'intégrité
escaladés HORS score), un score agent identique partout (40 % erreurs + 20 % cohérence +
30 % complétude + 10 % bonnes pratiques, seuils 85/70), la lecture sans recalcul des scores
calculés sur l'appareil, et le cadrage par activité (une règle ne s'évalue que si l'activité
est présente dans la visite). Environ **80 règles** avec leurs seuils métier (écart registre
10 %, sachets LQ=15/MQ=30, VSLA 10–25 membres, PB 125 mm ×2…) sont prêtes à devenir un
référentiel de règles QC évalué à l'ingestion ODK — les seuils en paramètres, jamais en dur.
Deux découvertes au passage : `app.R` est un outil de **validation GPS point-dans-polygone**
contre l'adm4 (à porter dans le rattachement MEMS), et le script MIARO calcule son taux
d'erreur autrement que les trois autres — le même agent n'aurait pas le même score selon
l'application. MEMS, en unifiant, corrigera cette incohérence.

**Les cinq classeurs d'indicateurs** forment une chaîne complète : Master List corporate
v2.8 (CRF 2022-2025, 90 outcome + 137 output + 21 transversaux, métadonnées riches) →
**table de passage ancien/nouveau CRF** → **logframe pays MG03 approuvé HQ** (extraction
COMET du 21/07/2026, CRF 2026-2029) → logframe bailleur FSRP → kits programme (C4PX/CVA).
La tension à gérer : la Master List décrit l'ANCIEN cadre, le logframe pays le NOUVEAU —
la table de passage est donc une **table de base de données**, pas un document. Ordre
d'import : le logframe CM-L005 d'abord (la liste fermée et approuvée du bureau, avec ses
codes WBS `MG03.01.011.URT1…`), la Master List pour les métadonnées, le crosswalk pour la
migration. **Le chantier P cesse d'être une invention : c'est un import.**

**CM-A003 + le tableau de bord HTML** sont les deux moitiés à réunir : les effectifs COMET
(grain commune × mois × activité × groupe, 2026-01→06) et la qualité du processus (grain
site × visite). Le CM-A003 n'a **aucun p-code** — rattachement par noms Admin1-3, et le
`.dbf` du shapefile fournit justement la correspondance officielle nom↔p-code (avec 166
communes homonymes qui interdisent le nom seul). Règle métier confirmée : bénéficiaires
uniques = MAX mensuel par commune × activité × groupe. Le tableau de bord HTML est la
**maquette cible** des écrans de suivi de processus : indice de conformité par visite,
modules configurables, page agent avec seuils.

**Les deux classeurs Résilience de 12 Mo sont un doublon strict** (diff = 0 sur 23 796
cellules) : une seule source, le cadre corporate 2020-2022, dont le schéma de métadonnées
à 16 colonnes étend la table d'indicateurs, et ~450 indicateurs additionnels documentés.

**Les trois PDF** sont les spécifications métier des programmes que les scripts QC
contrôlent. Le guide UNICEF d'estimation de l'émaciation est **la spécification complète
du module caseload manquant** — arbre de décision, formules, et les K-values de 7 districts
en annexe, importables comme référentiel. Le manuel des cantines donne la ration SMP
officielle (céréale 140 g + légumineuse 30 g + huile 10 g + MNP 0,4 g /élève/jour), le
dictionnaire des fiches 01a→04, et la norme « chaque école visitée ≥ 2 fois par année
scolaire » — un seuil concret pour « déjà suivi ».

**Les quatre présentations** : CARI (formules et seuils officiels de l'indice de sécurité
alimentaire, couleurs imposées comprises — à implanter comme chaîne de formules type et à
faire tourner via le moteur R/SPSS avec les scripts officiels du PAM) ; Orientation MIARO
(**les listes de référence du MRE nutrition — le chantier N tient là ses réponses** :
catégories U2/FE/FA/FEFA, seuils couverture > 70 %, participation > 80 %, abandon < 15 %) ;
stratégie SMP 2025 (ration confirmée, cycle de vie d'une école, hiérarchie scolaire
DREN > CISCO > ZAP distincte d'adm1-4) ; Résilience (typologie de sites à étendre : OPB,
chantier FFA, site RRT, unité de transformation).

**Le shapefile est complet et cohérent** : 1 701 polygones = 1 701 lignes attributaires,
`ADM3_PCODE` unique, WGS 84 ; le `.shx` manquant se régénère mécaniquement. Le référentiel
actuel de la base est un **jeu de démonstration** (10 adm3 synthétiques, rectangles) que ce
fichier remplace. Bonus : les drapeaux de ciblage par commune (`PECMAM` ×225, `PLW` ×33,
`PLW_child` ×32, `Activités`) sont une couche de ciblage prête pour la carte et le caseload.
Attention au basculement de millésime : les sites rattachés aux p-codes de démonstration
deviendront orphelins — la reprise doit être outillée, pas subie.

## Ce que cela ferme, ouvre ou déplace

- **Chantier P (modèle d'indicateurs)** : fermé comme problème de conception, rouvert comme
  chantier d'import — logframe CM-L005, Master List, crosswalk, schéma résilience.
- **Chantier N (listes MRE)** : les réponses sont dans l'orientation MIARO et le cadre
  résilience ; reste à les charger.
- **Caseload (méthode non outillée)** : spécification complète reçue (guide UNICEF),
  K-values importables.
- **Nouveau chantier : moteur de règles QC** sur les soumissions — ~80 règles réelles,
  architecture commune aux quatre applications, familles A/B/C, cadrage par activité,
  scores appareil lus sans recalcul. Les signaux d'intégrité (fraude, EAS/SEA) exigent un
  circuit d'escalade distinct du score, qui n'existe pas encore dans MEMS.
- **Nouveau référentiel : bureaux de terrain** (codes 1→10 et noms, dans `app.R`), et
  deuxième puis troisième cas du référentiel de codes : `Adm4Code_MAM` (CRENAM) après les
  codes école SMP.

## Les deux PDD reçus le même jour : la liste des rations, lue dans les formules

`1.PDD_janvier_mars_2023_NPA Mitigation.xlsx` (474 lignes, feuille « Ration » explicite)
et `PDD_Global_Novembre.xlsx` (3 911 lignes, 486 communes, 2 247 sites — les grammages y
sont des constantes et des formules, pas une feuille). Les deux confirment **exactement la
formule du module Rations de MEMS** : `tonnage = ration (g/pers/j) × jours × effectif ÷
1 000 000`, multiplicateur ménage = 5 (en GFD, « ménage » = bénéficiaires ÷ 5 ; en
nutrition et cantines, la personne compte pour elle-même).

**Rations officielles à charger dans Paramètres → Rations** (g/personne/jour) :

| Activité | Vivres | Jours | Espèces |
|---|---|---|---|
| GD/GFD (par ménage ×5) | riz 400 + LS 60 + huile 35 | 30 (demi : 15) | 120 000 Ar/ménage (150 000 cyclone 2023) |
| HH protection | riz 400 + LS 60 | 30 | — |
| DRR | riz 400 + LS 60 | 20 | — |
| FFA / Résilience (×5) | riz 400 + LS 60 + huile 35 | 20 | 60 000 Ar (2023) · 120 000 Ar/30 j (CAR 2024) |
| MAM traitement | P Sup 100 | 30 (2024 : 30/60/90) | — |
| MAM traitement 2 | CSB++ 200 | 30 | — |
| PREVMA/MIARO enfants | P Doz 50 | 30 (90 trimestriel, 120 urgence) | — |
| PREVMA FEFA | huile 20 + CSB+ 200 | 30 | — |
| PEC FEFA | huile 25 + CSB+ 250 | 30 | — |
| HIV/TB | huile 20 + CSB+ 200 | 30 | 100 000 Ar |
| Stunting enfant (NPA) | P Doz 50 (variante LNS 20 en 2023) | 30 | 21 000 Ar/enfant/mois |
| Stunting FEFA | huile 20 + CSB+ 200 | 30 | 60 000 Ar/mois |
| SMP cantines | riz 140 + LS 30 + huile 10 | 60/trimestre · LS 13 j si hybride | 315 Ar/élève/j (2023) · 22 088 Ar/période (2024) |

**Les contradictions relevées entre les fichiers** — SMP sans MNP et 60 j au lieu de 175 ;
deux rations FEFA (200+20 en PrevMa, 250+25 en PEC) ; CSB+ 200 *et* CSB++ 200 sur une même
ligne 2023 ; cash GD ×2 ou ×1 selon les lignes de novembre 2024 — **ont reçu leur réponse
du propriétaire le 01/08** : il se peut qu'il y ait eu des conventions arbitraires de
changement de rations. Elles ne sont donc PAS des erreurs à arbitrer : ce sont des
conventions datées, et la conséquence architecturale est nette — **les rations ne se codent
pas, elles se cataloguent**. Voir le chantier ci-dessous.

## Chantier R — Catalogue de rations et fiche de saisie du PDD (demande du 01/08/2026)

La demande, reformulée : *« une ration, une ligne »* dans un module de création de rations ;
dans le PDD, on **sélectionne** dans ce catalogue ; le **nombre de jours reste saisi par
l'utilisateur** à chaque ligne parce qu'il change tout le temps (les PDD réels le prouvent :
30, 60, 90, 120 jours selon les livraisons) ; et une ligne de PDD (une commune × une
activité) porte **plusieurs denrées et rations**, saisies dans une fiche (userform) avec
sélection multiple des denrées et, en dessous, un groupe où chaque denrée reçoit sa ration,
extensible.

Ce que cela donne, concrètement :

1. **Catalogue de rations** (Paramètres → Rations, refondu) : une ligne = un libellé de
   convention (« GD standard », « Stunting FEFA AMB jan-2023 »…), une denrée, un grammage
   par personne et par jour, une activité par défaut facultative, une note. CRUD complet,
   révisions comme partout. Les ~30 conventions extraites des deux PDD sont la première
   charge du catalogue — **toutes**, y compris les variantes contradictoires, puisqu'elles
   ont réellement servi, chacune datée par sa source.
2. **La ligne de PDD compose** : activité, commune (p-code), effectifs, **jours saisis à la
   main**, et une liste de couples (denrée, ration) — le grammage se présélectionne depuis
   le catalogue et reste modifiable. Le tonnage se calcule par denrée puis en total :
   `Σ ration × jours de la denrée × effectif ÷ 1 000 000`. Structure : table fille du PDD
   (une ligne par denrée), pas une colonne unique.
3. **La fiche de saisie (userform)** — précisée par le propriétaire le 01/08 : le **nombre
   de jours se saisit EN HAUT** de la fiche et vaut pour toutes les denrées ; mais chaque
   ligne de denrée peut **déroger** à ce chiffre, parce que les jours changent selon la
   disponibilité des denrées — et une dérogation s'accompagne d'une **note explicative**
   (obligatoire dès qu'on déroge : un chiffre qui s'écarte sans raison écrite redevient
   une cellule Excel qu'on ne sait plus relire six mois après). Les PDD réels prouvent le
   besoin : riz 60 j / légumineuses 13 j en cantine hybride. Le reste de la fiche :
   sélection multiple des denrées en haut ; en bas, un groupe avec une ligne par denrée —
   sélecteur de ration filtré par denrée + grammage modifiable + jours (hérités, barrés
   d'une dérogation éventuelle) + aperçu du tonnage calculé ; bouton pour ajouter une
   denrée. Le multiplicateur ménage (÷5 en GFD, personne = elle-même en nutrition/école)
   est porté par l'activité, affiché, jamais silencieux.
4. Au passage, les leçons de l'import : accepter les tags COMET (`URT_GD`, `URT_MAM`,
   `NPA_STUN`…) dans `act_type`, ajouter la modalité hybride, arrondir les effectifs
   décimaux en le disant.

Dépendances : aucune — peut partir dès que le lot d'authentification a atterri. Les quatre
« arbitrages » ci-dessus deviennent quatre lignes de catalogue parmi d'autres.

## Chantier S — Réorganisation produit et interface (demande du 01/08/2026)

La demande, dans les mots du propriétaire : faire de MEMS un outil « exploitable, facile à
utiliser pour chaque type d'utilisateur », comparable aux plateformes du domaine (COMET,
DHIS2, DevResults, ActivityInfo), en réorganisant ce qui existe — pas en ajoutant. Il dit
ne pas réussir à formuler précisément ce qu'il a en tête ; la reformulation ci-dessous fait
foi jusqu'à correction de sa part.

### S1 — L'architecture d'information : chaque chose chez son métier

Règle directrice donnée : **tout ce qui relève de l'analyse et des données va au
Suivi-évaluation, sauf le PDD et les distributions qui restent au Programme.**

- **Suivi-évaluation** devient l'espace de travail M&E complet : plans de suivi et visites,
  soumissions ODK, **outcomes et indicateurs** (aujourd'hui éparpillés), **population et
  ciblage** (aujourd'hui dans Programme), couverture, qualité des données (futur moteur QC),
  analyses et scripts.
- **Programme** garde l'opérationnel : PDD (avec le chantier R), distributions, réceptions.
- Le ciblage est **mis en cohérence avec le PDD quand il existe** : sur une même commune ×
  activité, l'écran confronte personnes ciblées et bénéficiaires planifiés, et montre
  l'écart au lieu de laisser deux chiffres vivre chacun de leur côté.

### S2 — La population : mise à jour et taux de glissement

Système demandé explicitement : pouvoir **mettre à jour les effectifs de population** et,
tant qu'aucun rapport validé sur l'évolution des populations bénéficiaires n'existe,
**appliquer un taux de glissement entre les années** — c'est-à-dire projeter N+1 = N ×
(1 + taux), par unité géographique ou globalement. Conséquences de conception :

- chaque valeur de population porte un **statut de source** : recensement / projection par
  taux / rapport validé — et la projection se distingue visuellement du constaté ;
- appliquer un taux est un geste explicite, tracé (qui, quand, quel taux, depuis quelle
  année), et réversible tant qu'un rapport validé ne l'a pas remplacé ;
- quand un rapport validé arrive, il **remplace** la projection et le dit.

### S3 — Paramètres : finaliser la configuration D'ABORD (demande du 01/08/2026, priorité relevée)

Le propriétaire relève cette partie en tête : « travaille sur les paramètres en premier lieu
pour finaliser cette partie configuration, c'est la base de tout, règle chaque souci, fais que
tout fonctionne, réorganise les options pour un rendu professionnel ». Passe donc AVANT le
chantier R. Contrainte : `Settings.jsx` est tenu par le lot shapefile en cours — s'exécute une
fois ce lot atterri.

**Audit des 16 onglets (état stable, commité), soucis réels à régler :**

1. **Sept réglages se perdent au rechargement** — le plus grave, c'est du « saisir dans le
   vide ». `scoring`, `roles`, `mmr`, `lists` (partenaires, modalités), `actCategories`,
   `outcomePlan`, `formulas` sont éditables (Calculs, Indicateurs, listes…) et jamais
   persistés côté serveur (chantier D). À traiter en bloc : soit les persister (les verser
   dans une collection synchronisée ou dans `settings`), soit passer l'écran en lecture seule.
   La bonne réponse ici est de PERSISTER — la configuration est le socle, elle doit tenir.
2. **Export des Localités tronqué en silence** (chantier I1) : `toCSV(dir.rows,…)` n'exporte
   que la page affichée (`PER=200`) au lieu du jeu filtré complet — 200 lignes sur 18 000
   fokontany, sans avertissement. Exporter la totalité, avec BOM UTF-8 et p-codes préservés.
3. **Sites hors de Paramètres** : demande ancienne du propriétaire, jamais faite — l'onglet
   « Sites » est de la gestion de données, pas de la configuration. Le retirer d'ici (il vit
   déjà ailleurs via SitesModule).
4. **Rations** : l'onglet actuel est l'ancienne matrice `settings.rationTable` ; il sera
   remplacé par le catalogue du chantier R. Pour cette passe, au minimum garantir qu'il
   persiste ; la refonte complète est R.
5. **Référentiel d'activités (nouveau, fondateur)** : le propriétaire l'a confirmé le 01/08 —
   « les activités se paramètrent dans Paramètres, ne l'oublie pas ». C'est la colonne
   vertébrale : indicateurs, dashboards, données MoDa, PDD, plan de suivi sont tous *par
   activité*. Aujourd'hui les activités vivent en liste éparpillée (`db.lists.tags`,
   `actCategories`, `activity_tag`) sans référentiel propre. Poser un vrai onglet Activités
   (code, libellé, catégorie CSP, tags COMET associés) sous Référentiels M&E, persistant, sur
   lequel tout le reste s'accroche. La taxonomie réelle est déjà extraite (analyse du 01/08 :
   Unconditional resource transfer, FFA, SMP, Malnutrition treatment/prevention, Smallholder
   agriculture…).
6. **Sites (shapefile/dbf) — présentation** : garder les DEUX entrées de dépôt pour la
   facilité, avec des descriptions explicites (« déposez le `.shp` ET le `.dbf` ; le `.prj`
   précise la projection »), ET l'option `.zip` en disant ce qu'il doit contenir (les trois
   fichiers). Rappeler à l'écran que ce découpage devient la référence adm0→adm4 de tout MEMS.
7. **UNIFIER l'import géo — urgent (retour terrain du 01/08).** Le propriétaire n'arrive
   toujours pas à importer, même en `.zip`. Diagnostic établi : **trois flux géo coexistent**
   dans Localités et il utilise un ancien (lecteur navigateur, « Fichier de contours ») qui
   lit les géométries mais JAMAIS le `.dbf` — d'où le « 0 champs attributaires » de sa
   capture. Le flux serveur `SetShapefileServer` (« Lu par le serveur ») fonctionne : vérifié
   en isolation sur le vrai zip adm3 (extraction shp+dbf+prj correcte, 1701 records, 21
   colonnes). **Retirer les deux anciens flux**, ne laisser que le serveur — une seule carte
   évidente. C'est la vraie cause de l'échec, pas un bug du parseur.
8. **Lire un `.shp` SANS `.dbf` (demande du 01/08 : « comme QGIS »).** `construire()` exige
   aujourd'hui un `.dbf` (`if(!dbf) 422`). Le rendre OPTIONNEL : sans `.dbf`, importer les
   géométries seules avec des identités provisoires (« Polygone N ») à un niveau unique, pour
   qu'elles s'affichent sur la carte immédiatement ; `.dbf` + correspondance restent la voie
   complète (rattachement adm0→4). Voir d'abord les polygones, mapper ensuite. Touche
   `lib/shapefile.js` + `routes/geo.js` (serveur, non conflictuel) et `SetShapefileServer`
   dans `Settings.jsx` (UI). À faire juste après le lot de persistance en cours.
9. **Échelle adm4 — limite d'envoi à 150 Mo (demande du 01/08).** Le propriétaire demande que
   MEMS accepte un fichier de configuration jusqu'à **150 Mo** (il a d'abord écrit « 150 »,
   puis « 15 » — mais son zip adm3 fait déjà 16 Mo, donc 15 est trop petit ; on retient 150,
   à confirmer). Relever `config.maxShapefileMb` à 150 pour cette route (multer), et signaler
   à l'écran un éventuel plafond du proxy Codespace si l'envoi échoue quand même.
10. **INTÉGRER le découpage DANS la création du pays (demande du 01/08, importante pour le
    multi-pays).** Le shapefile ne doit PAS être une carte flottante : un découpage appartient
    à SON pays. `geo_version` porte déjà une colonne `country` et `is_current` est cloisonné
    par pays (`lib/geo.js:125,143`), mais l'UI doit lier l'upload à la configuration du pays
    (composant `SetCountry`), pas à un onglet séparé. Sinon, en multi-pays, on bascule un
    découpage sans savoir de quel pays il relève — bug garanti. Donc : l'import shapefile
    devient une étape de la fiche pays, le millésime créé est rattaché au pays courant, et la
    bascule ne touche que le découpage de CE pays. C'est l'aboutissement de l'unification
    (points 7-8) : une seule entrée, dans le pays.
    **Précisé le 01/08 :** la fiche pays reçoit DEUX injections — (a) le **shapefile** (sa
    géométrie ET sa table d'attributs) qui donne le découpage adm0→4 et les contours ; (b) un
    **`.dbf` pour la liste des sites**, qui peut porter **beaucoup de lignes** (échelle adm4 /
    milliers de sites). Le premier alimente le référentiel géographique, le second le registre
    des sites. Les deux doivent tenir le volume (lecture serveur en flux, écriture par lots,
    limite d'envoi à 150 Mo). Le `.dbf` des sites est distinct du `.dbf` du découpage :
    prévoir deux dépôts clairement libellés dans la fiche pays.

**Réorganisation maître-détail (le « rendu professionnel ») — volet gauche de groupes,
contenu à droite :**

| Groupe | Sous-onglets |
|---|---|
| Organisation | Général · Pays · Bureaux · Périmètre des bureaux |
| Référentiels géographiques | Localités (+ import shapefile/contours) |
| Référentiels M&E | **Activités** · Indicateurs · Calculs · Rations · Codes d'identification |
| Sources de données | ODK Central · Connecteurs |
| Rapports | Modèles de rapport |
| Système | **Mon compte** · API · Utilisateurs · À propos |

Même principe pour la gestion des listes : des sous-catégories plutôt qu'un écran surchargé.
Chaque onglet est parcouru, testé et corrigé un par un — l'objectif est que TOUT fonctionne,
pas seulement que ce soit mieux rangé.

**« Mon compte » (demande du 01/08) — self-service du compte, distinct de l'administration
des utilisateurs.** Aujourd'hui l'écran Utilisateurs est réservé aux administrateurs, et un
compte ne peut changer son mot de passe qu'à la première connexion (parcours imposé). Il faut
un écran où N'IMPORTE QUEL utilisateur voit et gère SON compte : consulter ses infos (nom,
courriel, rôle, bureau), **changer son mot de passe à tout moment** (route
`POST /api/auth/password` — elle existe, il manque l'entrée hors premier accès), et **définir
un identifiant (username)**. Le username est nouveau : décider s'il devient un second
identifiant de connexion (en plus du courriel) ou seulement un nom affiché — à trancher, mais
au minimum le champ et son unicité. Accessible depuis le menu du compte (l'en-tête), pas
seulement depuis Paramètres.

**Réinitialisation par l'admin — le mot de passe provisoire est GÉNÉRÉ, pas choisi (demande
du 01/08).** Règle du propriétaire : « l'administrateur ne connaît pas le mot de passe des
utilisateurs, mais peut faire une réinitialisation, et le mot de passe provisoire s'affiche
que lui pour qu'il le communique ; une fois ce reset fait et l'utilisateur connecté avec le
provisoire, on lui demande d'en changer à la première connexion. » État actuel : le forçage
de changement (`must_change_pw`, écran « Nouveau mot de passe ») EXISTE déjà (lib/auth.js,
Login.jsx), MAIS à la création et à la réinitialisation (`routes/users.js:48,96`) **c'est
l'admin qui TAPE le mot de passe** — donc il le connaît. À changer : un bouton
« Réinitialiser » qui **génère** un mot de passe provisoire côté serveur, le **renvoie une
seule fois** dans la réponse pour que l'admin le lise et le communique (jamais stocké en
clair, jamais renvoyé une seconde fois), et pose `must_change_pw=1`. Idem à la création : le
provisoire est généré, l'admin ne le choisit pas. C'est un changement d'API (la route ne
prend plus de mot de passe en entrée pour ces deux cas) — le brief du prochain lot Utilisateurs.

### S5 — Deux directives de cadrage (01/08/2026)

- **Priorité PROD, pas la démo.** « Oublie pour le moment la partie démo, concentre-toi sur la
  prod. » Ne pas investir dans le jeu de démonstration / le seed ; construire pour l'usage
  réel. (La base de démo reste utile à MES vérifications, mais les fonctionnalités visent la
  prod.)
- **« CL » différé** jusqu'à ce que les Paramètres soient bien configurés et réorganisés
  professionnellement. *(Interprétation à confirmer : « CL » = Cadre Logique / cadre de
  résultats ? ou Caseload ? — je le note comme différé quoi qu'il en soit ; à préciser.)*

### S6 — DÉCISION : un éditeur peut planifier les suivis (01/08/2026)

Tranche la restriction 4 du lot de persistance (PR #13). Le propriétaire : « un éditeur peut
être attribué à planifier les suivis. » État :
- **Plan de suivi des sites** (grille sites × mois, « Générer le plan », « Générer par
  commune ») : DÉJÀ éditeur — `PUT /api/sites/:id/months` = `requireCap("edit")`. Rien à
  changer.
- **Paramètres MRE** (`Planning.jsx:392-401` : durée, type de site, fréquence, coefficient par
  activité) : le lot de persistance les a passés en `can("admin")` parce qu'ils s'enregistrent
  via `PUT /api/settings` (admin). À CORRIGER : les repasser en `edit`, ET leur donner une
  **persistance éditeur** — une route/collection dédiée `requireCap("edit")` (pas la route
  settings admin), pour qu'un éditeur planifie ET que ça tienne. Même traitement pour le
  calendrier de collecte (`outcomePlan`) : sortir de `settings`, route propre en `edit`.

C'est le pendant « fait proprement » de la restriction 2 (outcomePlan qui ombrait sa table) et
de la restriction 4 (droit admin). À faire dans un lot « persistance de la planification en
droit éditeur », distinct de la route settings admin qui, elle, reste réservée à la vraie
configuration.

### S4 — La passe de cohérence transversale

Le reste de la discussion « professionnelle vs bricolage » : hiérarchie visuelle, densité,
états vides qui disent quoi faire, chargements, vocabulaire uniforme entre écrans, parcours
par type d'utilisateur (chargé M&E, point focal bureau, prestataire TPM, direction), clair/
sombre, accessibilité de base. Un tour complet en tant qu'utilisateur final, écran par
écran, avec grille de lecture : est-ce que je comprends où je suis, ce que je peux faire,
ce qui s'est passé après mon clic.

Position dans la séquence : **après** les chantiers fonctionnels en cours (authentification,
shapefile, cadre de résultats, QC, chantier R) — c'est la passe finale voulue par le
propriétaire (« une fois tout terminé on va s'attaquer au UI »).

## Chantier T — Intégration MoDa/Kobo réelle et onglet de résultats par activité (demande du 01/08/2026)

Le propriétaire a fourni l'API réelle : `https://moda.wfp.org/api/v1/data/340943`, format Kobo,
avec un jeton d'API. **Le secret ne figure nulle part dans ce dépôt** — il vit dans le coffre
chiffré (`connector.secret_enc`), saisi à l'exécution dans l'instance. Recommandation faite au
propriétaire : régénérer ce jeton après mise en place, puisqu'il a transité par une conversation.

**Détail d'intégration établi par l'URL** : `moda.wfp.org` est une instance **kobocat v1**
(`/api/v1/data/{id numérique}`), et non KPI v2 (`/api/v2/assets/{uid}/data`). Le chemin de
lecture d'un connecteur Kobo doit donc être **configurable** pour couvrir les deux saveurs —
c'est précisément la limite notée au lot d'authentification (« mot-clé Token établi d'après le
code source, pas d'une instance réelle »). Le schéma `Token` livré est le bon ; reste à ne pas
figer le chemin.

**Contrainte d'environnement** : le bac à sable de développement bloque tout HTTPS sortant
(même `example.com` répond 403 au tunnel). Le tirage réel se fait donc dans l'environnement du
propriétaire (Codespace), pas ici. Le code est bâti et testé hors-ligne — grounded sur les
XLSForms (noms de variables), les scripts QC (analyse) et le tableau de bord HTML (écran cible),
tous déjà dans `docs/`. Seul le premier tirage vivant revient au propriétaire.

Le flux, précisé par le propriétaire le 01/08 (une base par activité, en temps réel) :
1. **Un lien = une activité = une base de données.** Chaque connexion MoDa/Kobo porte les
   données d'UNE activité et les garde **reliées en temps réel** : quand MoDa change, la base
   de l'activité se met à jour (tirage périodique ou à la demande, cache versionné, jamais un
   copier-coller figé). Le chemin de lecture reste configurable (kobocat v1 vs KPI v2).
2. **Mapping par activité vers ses indicateurs.** Les champs de soumission mis en cache sont
   mis en face des **indicateurs de l'XLSForm de cette activité**, via la couche de
   correspondance des variables (`lib/champs.js`, `lib/mapping.js`, `connector_mapping`) — pas
   un mécanisme parallèle. Les indicateurs à afficher se lisent dans le HTML et l'XLSForm
   partagés (voir la famille « scripts QC » et « bénéficiaires » de l'analyse du 01/08).
3. **Les indicateurs de l'XLSForm sont STOCKÉS** comme référentiel, et MEMS les utilise comme
   **base des calculs et de la sortie des dashboards**. Présentation **par activité**, adaptée
   à l'audience — s'INSPIRER de `docs/dashboard_suivi_processus_WFP.html`, NE PAS le cloner :
   trouver la bonne façon de présenter couverture, indice de conformité, scorecard selon qui
   regarde (direction, chargé M&E, terrain).
4. Les **activités elles-mêmes se paramètrent dans Paramètres** (référentiel d'activités) :
   c'est la colonne vertébrale, tout le reste (indicateurs, dashboards, données MoDa) s'y
   accroche. À poser dès la passe Paramètres (chantier S3).

### Natures de source à proposer (demande du 01/08/2026)

La liste `NATURES` des connecteurs (aujourd'hui `odk, kobo, foundry, csv, http`) devient, au
format demandé par le propriétaire :

| Nature | Ce que c'est | Chemin / auth |
|---|---|---|
| `kobo_v1` | **kobocat v1** — c'est MoDa | `GET {base}/api/v1/data/{id numérique}`, en-tête `Token` |
| `kobo_v2` | **KPI v2** | `GET {base}/api/v2/assets/{uid}/data`, en-tête `Token` |
| `ona` | Ona (plateforme ODK, API proche de kobocat) | `GET {base}/api/v1/data/{id}`, `Token` |
| `foundry` | Palantir Foundry | voir ci-dessous |
| `excel` | Téléversement seul, **puis** mapping (pas de lien réseau) | fichier + correspondance |
| `http` | API HTTP générique rendant du JSON/CSV | chemin libre, schéma d'auth au choix |
| `jdbc` | Base de données (JDBC) | à cadrer — driver, chaîne de connexion, requête |

Le **schéma d'authentification** (livré au lot d'authentification) reste indépendant de la
nature : `Token` pour kobo/ona, `Bearer` pour Foundry, `Basic`/`Bearer`/session pour http.

**Foundry — établi d'après la doc officielle (lue le 01/08 via recherche ; le sandbox bloque
le fetch direct).** API v2, OAuth 2.0, en-tête `Authorization: Bearer <jeton>` — **c'est déjà
le schéma de `lib/foundry.js`, rien à corriger côté auth.** Ce qu'il faut rendre configurable,
c'est le CHEMIN de lecture :
- dataset : `GET /api/v2/datasets/{datasetRid}/readTable` — params `format` (CSV/ARROW),
  `columns`, `rowLimit`, `branchName` ; scope `api:datasets-read` ;
- objets d'ontologie : `GET /api/v2/ontologies/{ontology}/objects/{objectType}` — paginé
  (max 10 000 objets en Object Storage V1) ; scope `api:ontologies-read`.
Un utilisateur Foundry génère un jeton d'API temporaire portant ses propres droits. Pour les
chiffres de bénéficiaires/réceptions, l'un ou l'autre chemin convient selon la modélisation du
bureau — d'où le chemin configurable.

Séquence : après Paramètres et le module Suivi-évaluation (voir la feuille de route en tête).

**Le format PDD comme gabarit d'import** : la logique de « Details » (1 ligne = lieu × mois
× activité × modalité) est le bon modèle, mais le fichier réel est inutilisable tel quel —
aucun p-code (noms seuls, casse variable), grain site plus fin que la clé MEMS, mois en
toutes lettres, modalité « hybride » absente de l'énumération, bénéficiaires décimaux,
en-têtes en ligne 3 ou 5. Le gabarit MEMS garde la logique et impose p-code + énumérations.
Les fichiers réels portent aussi une leçon : l'énumération `act_type` du type d'import
`pdd` (GD/PREVMA) est trop étroite — le PDD national 2024 porte déjà les tags COMET
(`URT_GD`, `URT_PREV`, `URT_MAM`, `NPA_STUN`), il faut les accepter tels quels.

Et une leçon d'outillage : les deux classeurs contiennent des **formules cassées ou
décoratives** (taux de change pointant une cellule vide, blocs Février/Mars jamais lus par
le XLOOKUP, jours recopiés en 31, 32, 33… au lieu de 30, tonnages saisis à la main qui ne
recollent pas avec ration × jours). C'est l'argument le plus concret en faveur du calcul
par MEMS : la formule vit à UN endroit, testée, au lieu de 3 911 cellules.

## Trois gabarits du plan de suivi (reçus le 01/08/2026) — ancrent le chantier L et le suivi fondé sur le risque

Le propriétaire a déposé les fichiers réels du plan de suivi. Ils donnent le modèle exact de
ce qu'il avait décrit (tableau adm1-adm3 avec les sites configurés, planification par
commune/district, « déjà suivi »), et surtout la MÉTHODE de couverture fondée sur le risque.

- **`List Sites per Tag.xlsx`** — le répertoire des sites croisés aux activités. Feuille
  « Sites » : 2 874 sites × 26 colonnes (`ID, Field_office(+code, +code ancien), Adm1..Adm4
  Name/Code (+ codes anciens)`) ; feuille reliant `POIName / POI_code / Activity_tag`. C'est
  la source du tableau du plan, et elle confirme deux besoins déjà notés : les **codes
  administratifs anciens** (une colonne `_ancien` par niveau — la bascule de millésime que le
  chantier shapefile doit outiller) et le rattachement site→activité par tag.

- **`Plan de suivi 2026 - Copy.xlsx`** — un plan réellement rempli : feuille « Mapping plan de
  suivi » (3 008 lignes × 55 colonnes), « Update_location » (3 373 × 47), et le shapefile adm3
  embarqué (`mdg_bnd_adm3_com_pam2`, mêmes colonnes que le .dbf déjà analysé). Preuve que le
  plan, le découpage et les sites vivent aujourd'hui dans un seul classeur — ce que MEMS doit
  réunir proprement.

- **`Plan de suivi revue.xlsm`** — le plus important : l'outil « Monitoring Plan » du PAM, la
  MÉTHODE. Il porte, prêts à modéliser :
  - **Les paramètres du suivi fondé sur le risque** (feuille « Overarching parameters ») :
    `Minimum required interval`, `Minimum required frequency`, `Targeted number of sites`,
    `Feasible number of sites`, `CO adjusted required frequency/interval`, `Operation duration`,
    `Number of sites`, par CSP Activity et par bureau. C'est le cœur du moteur de priorisation
    et de couverture — les colonnes existent, il n'y a pas à les inventer.
  - **Le plan de couverture mensuel** (feuille « Monitoring Coverage Plan ») :
    `CSP Activity | Activity category | Site visits | Janvier…Décembre | Cumulative`.
  - **Les plans par bureau** (Manakara, Toliara, Ambovombe, Ampanihy, Antananarivo, 134
    colonnes) : `# | Sous-bureau | Antenne | Site | Région | District | Commune | Fokontany |
    ID | GPS lat/long | Activity Category | Programme Area | Activity Tags | Security situation
    | Programme synergies`, avec les colonnes mensuelles de couverture.
  - La **taxonomie d'activités** (feuilles « dropdown », « Sheet6 ») : Unconditional resource
    transfer, Asset creation and livelihoods (FFA), Action to protect against…, School based
    programme (SMP), Malnutrition treatment, Malnutrition prevention, Smallholder agriculture…
    — le référentiel d'activités CSP réel, à croiser avec les tags MEMS.

Conséquence pour le chantier L : le tableau du plan de suivi (adm1-adm3 × sites × mois), les
symboles à expliquer par infobulle, et le « déjà suivi » depuis ODK ont désormais leur
gabarit exact. Et le suivi fondé sur le risque cesse d'être une intention : ses paramètres
(intervalle/fréquence requis, sites ciblés vs faisables, ajustement CO) sont donnés.

# Documents de référence reçus le 31/07/2026

Dix documents ont été fournis. Ils **ferment ou réduisent 8 des 23 questions bloquantes** et
font apparaître trois chantiers qui n'existaient pas au backlog (N, O, P).

| Document | Ce qu'il apporte |
|---|---|
| `MAHAVOTSE_BUDGET_TPM_JUILLET_2026_REVU.xlsx` | **Ferme Q1 bis.** Structure exacte du budget TPM. |
| `RAM_Budget_MDG_CO_2G_CSP_2024‑2028.xlsx` | Gabarit institutionnel du plan MRE. **Ferme Q9.** → chantier N |
| 4 XLSForms MDG (GD_PREVMA v2, SMP 2025‑2026, NutritionAIM, MIARO PROD) | **Ferme Q15 en grande partie.** → chantier O |
| `20230828_Cadre_ME_activités_Résilience.xlsx` | Référentiel d'indicateurs réel. → chantier P |
| `Guidance_note_on_RBM.pdf` (APP, juillet 2024) | Cadre corporate du **suivi fondé sur le risque**. |
| `RBM.pptx` | Outils 1 à 4 du cadre, dont la grille de couverture. |
| 2 sources de shapefile Madagascar | Non atteignables depuis cet environnement (403 au proxy). |
| Capture de l'écran de connexion | Voir la note en fin de section. |

Les deux PDF du PAM (*Monitoring Handbook*, *Indicator Compendium*) ont été tentés deux fois :
**`cdn.document360.io` renvoie 403 depuis cet environnement**. Aucun contenu n'en a été lu et
rien n'en a été déduit.

> **Note sur la capture d'écran.** Le bandeau « DÉVELOPPEMENT — COMPTE DE DÉMONSTRATION /
> admin@mems.local / MemsAdmin2026 » **n'existe plus dans le code** : il a été retiré par le
> commit `e25b937`, qui supprime `email: "admin@mems.local"` et `password: "MemsAdmin2026"` de
> `web/src/views/Login.jsx`. La capture provient donc d'un build antérieur. Avant le test sur
> Codespaces, repartir de `main` à jour. Accessoirement, l'adresse saisie sur la capture
> (`admin@dev.local`) ne correspond pas à celle du bandeau.

---

## Chantier N — Aligner le plan MRE sur le gabarit RAM du PAM

Le classeur `RAM_Budget_MDG_CO` est le gabarit institutionnel (VAM / *Monitoring and Evaluation
Planning and Budgeting*) rempli par le bureau pays : 13 feuilles, dont 6 masquées et 1
`veryHidden`. La confrontation est sévère — **les énumérations de MEMS ne viennent d'aucun
référentiel officiel.**

1. **Les six « natures d'activité » de MEMS sont inventées.** `kind IN ('suivi','revue',
   'evaluation','enquete','etude','capacite')` (`010_mre.sql:37-38`). Le référentiel réel en a
   **huit**, plus un second niveau de **76 sous-catégories** (`Monitoring Activity List`!B :
   EFSA, CFSVA, mVAM, ICA, CFSAM, FSOM, FSMS, JAM, IPC, SMART/SENS, Distribution Monitoring,
   Retailer monitoring, Warehouse monitoring, PDM URT, PDM Nutrition, SABER…). MEMS ignore
   totalement ce second niveau. · **L**
2. **Les dix catégories de coût de MEMS ne recoupent aucune liste du classeur**
   (`010_mre.sql:81-84`). Le classeur en a trois, emboîtées, pilotées par une « High level cost
   category » (`transfer_cs` / `implementation` / `dsc`) qui décide quelle sous-liste s'ouvre —
   une validation `INDIRECT(IF(...))` dans la feuille 3. · **L**
3. **Aucun plan pluriannuel.** `mre_activity.year INTEGER NOT NULL` (`010_mre.sql:31`) et le
   filtre `a.year = ?` (`routes/mre.js:152`) enferment tout dans une année ; le classeur couvre
   2024‑2028. · **L**
4. **Aucune fréquence.** Le classeur ne saisit ni budget ni durée : il saisit un **nombre
   d'occurrences par trimestre**, et le budget en découle (`AE7=SUM(G7:AD7)`,
   `AN7=$AE7*$AG7`). MEMS saisit quantité × coût unitaire hors calendrier. · **L**
5. **Aucune distinction Interne / Externe**, pourtant structurante : elle sépare le budget en
   deux totaux dans `Table for Summary Page`. · **M**
6. **Les coûts de personnel n'existent pas comme objet.** La feuille 3 modélise 46 postes avec
   titre, grade (43 valeurs), quatre pourcentages de temps (Monitoring / Evaluation / VAM /
   Other), coût unitaire annuel indexé à 2 %/an et coût réparti par fonction. MEMS n'a qu'une
   catégorie `personnel`. · **L**
7. **Les achats n'existent pas comme objet** (article, unités par année, coût unitaire,
   rattachement CSP et poste comptable). MEMS n'a que `category='equipement'`. · **L**
8. **Aucun rattachement à la structure CPB** ni aux activités CSP (code `MG03.01.011.URT1`). · **M**
9. **Suivi du financement et de l'exécution** : remplacer `funding TEXT` (`010_mre.sql:57`) par
   des lignes portant budget requis / financement confirmé / dépense réalisée par année. · **M**
10. **Import et export du gabarit** : ajouter un type de lot au pipeline existant pour la
    feuille 2, et un export au même format, afin qu'un bureau pays puisse continuer à échanger
    avec le siège. · **L**

> **Q9 est fermée par ce document.** Le référentiel officiel des méthodes de collecte est
> `MRE dropdown list`!T2:T26 — **25 valeurs** : Desk based study, PDM (general), Baseline
> (general), PDM URT, Baseline URT, PDM School Meals (Take Home Ration), Baseline School Meals,
> School Feeding Survey, SABER, PDM Nutrition, Baseline Nutrition, PDM Malnutrition prevention,
> Baseline Malnutrition prevention, PDM Nutrition treatment, Baseline Nutrition treatment,
> Nutrition survey, PDM Asset Creation/Resilience, Baseline Asset creation/Resilience, EB…
> **Et la fréquence a elle aussi son référentiel** (`V2:V7`, 6 valeurs) : Monthly, Quarterly,
> Twice a year, Once a year, Once every two years, Once every five years.
> `indicators.method` **et** `indicators.frequency` (`001_init.sql:213-214`) doivent être
> contraints sur ces deux listes.

---

## Chantier O — Soumissions ODK, rattachement aux sites et GPS

Les 4 XLSForms permettent enfin de répondre à Q15 — et montrent que le chemin est plus long que
prévu.

### Ce que contient réellement le champ site (réponse à Q15)

Le champ site n'est **jamais** du texte libre ni un identifiant interne MEMS : c'est toujours la
valeur `name` d'un choix de la feuille `choices`, donc un **code**. Mais **pas le même code
selon le formulaire** :

| Formulaire | Champ | Forme du code | Exemple |
|---|---|---|---|
| GD_PREVMA v2 | `DPName` | p‑code fokontany, 13 car. | `MG23209050001` |
| NutritionAIM | `DPName` | p‑code adm4 + n° d'ordre, 16‑17 car. | `MG23209032002001` |
| MIARO PROD | `POIName` | p‑code adm4 + `001`, 16 car. | `MG23210070009001` |
| **SMP 2025‑2026** | `Adm4Code_SMP` | **entier, hors référentiel p‑code** | `603140007` |

**Trois obstacles à traiter, tous réels :**
- **SMP est hors du référentiel** : ses `ADM3CODE`/`ADM4CODE` sont des entiers (91 = TSIVORY)
  alors que ses `ADM1CODE`/`ADM2CODE` sont des p‑codes. `geo_unit.pcode` ne peut pas les
  accueillir → une table de correspondance (1 251 codes école, 247 codes ZAP) est indispensable,
  sans quoi **aucune soumission SMP n'est rattachable**. *Traité côté outil (lot B)* : la table
  `code_referentiel` accueille l'une comme l'autre — le nom du référentiel fait partie de la clé
  métier —, elle se charge par le cadre d'import Excel et se rapproche des sites par un geste
  séparé qui dit ce qu'il n'a pas su rattacher. Reste à obtenir les deux fichiers.
- **GD_PREVMA a des codes ambigus** : 7 codes `DPName` désignent deux points de distribution
  différents (`MG51507010014` = « Androka Betohoke » *et* « Betsibarike »), ce que
  `settings.allow_choice_duplicates='yes'` autorise explicitement.
- **MIARO décrit deux sites par soumission** (`POIName` L14 et `FRSiteName` L274), chacun avec
  son fokontany et son geopoint obligatoire.

### Le GPS existe déjà dans les quatre formulaires

`HHCoord` (geopoint) est présent dans les 4 : GD_PREVMA L20, SMP L20, NutritionAIM L18, MIARO
L17 — plus des geopoints secondaires (`HHCoord_FARNE` L276, `HHCoord_wh` L411, `HHCoordWh`
L229). C'est la matière de « les coordonnées GPS qui ressortiront des data sets ».

### Trois défauts du script d'ingestion, trouvés en le confrontant aux vrais formulaires

1. **`guessField` ne filtre pas le type de ligne** (`import-odk-forms.js:122`) : il empile
   toute ligne dont `name` est non vide, y compris `begin_group`, `note` et `calculate`. Sur
   GD_PREVMA, le premier candidat du second motif est un `begin_group`.
2. **La détection du site sur SMP ne tient qu'à un libellé exact** : le motif `^[ée]cole$`
   (`:75`) matche le *label* « Ecole ». Aucun *nom de variable* SMP ne matche le motif
   principal. Le repli `^Adm4Code` sauve le cas — par chance.
3. **MIARO : le second site est silencieusement jeté** (`:82` prend le premier candidat).

### Travail

> **Fait depuis :** la couche générique de correspondance des variables est livrée
> (migration **016**, `lib/champs.js`, `lib/mapping.js`, `routes/connectors.js`,
> Paramètres → Connecteurs). L'entité `submission` du registre décrit déjà exactement les
> colonnes prévues par O1 : la migration à venir n'a rien à réapprendre, mais elle prend
> le **numéro 017** et non 016. Ce qui reste : créer la table, brancher l'import (la chaîne
> s'arrête aujourd'hui à l'aperçu) et écrire le résolveur O3.

- **O1** — Créer la table `submissions`, qui n'existe pas (migration **017**) : `id`, `form_id`,
  `instance_id` UNIQUE, `submitted_at`, `svy_date`, `site_code_raw`, `site_id` (nullable),
  `geo_pcode`, `lat`, `lon`, `gps_accuracy`, `office_code`, `cp_code`. · **L**
- **O2** — Ajouter à `sites` un code externe ODK indexé : `sites.code` porte des valeurs
  internes générées (`L0001`, `seed.js:212`) et ne peut pas accueillir `MG23210070009001`. · **M**
- **O3** — Écrire le résolveur soumission → site en trois passes traçables : code exact ;
  préfixe p‑code adm4 (utilisable pour MIARO 160/163 et GD_PREVMA 179/208) ; table de
  correspondance pour SMP. · **L**
- **O4** — Découper la chaîne geopoint (`lat lon altitude precision`) en quatre colonnes. · **S**
- **O5** — Corriger les trois défauts de `guessField` ci-dessus. · **M**
- **O6** — Verser les 4 XLSForms dans `server/fixtures/xlsforms/` et écrire le test qui manque :
  la détection doit retourner `DPName` / `Adm4Code_SMP` / `DPName` / `POIName`, et `SvyDate`
  partout. **C'est ce qui rendrait enfin vérifiable l'affirmation « appariement des variables des
  XLSForms MDG »** de la section « Fait pour mémoire ». · **M**
- **O7** — Table de correspondance des codes de contexte : `Field_office` (1=Bekily,
  2=Fort Dauphin, 3=Antananarivo, 4=Manakara, 6=Ambovombe, 7=Tsihombe, 9=Ampanihy, 10=Tulear)
  vers `offices`, et `CPList` (3=MAHAVOTSE…) vers les partenaires. · **S**
- **O8** — Implémenter **L4 (13d)** une fois `submissions` en place : marquer « déjà suivi » sur
  une fenêtre paramétrable et alimenter `site_months.done` ou créer une ligne `visits`. · **M**
  *(était XL : la table manquait ; il reste O1 à O3 en préalable)*

---

## Chantier P — Aligner les indicateurs sur le cadre RBM

Le classeur *Cadre M&E Résilience* et le PPTX RBM montrent ce qu'un indicateur doit porter.
`indicators` (`001_init.sql:205-215`) porte `id, code, name, basket, unit, target, direction,
method, frequency`. Manquent :

1. **Le niveau de résultat** (effet / produit / transversal) et le rattachement
   Strategic Outcome → Activity → Output. · **L**
2. **Un indicateur d'output n'a nulle part où aller** : `outputs` (`001_init.sql:176-187`) est
   une table de volumétrie par `activity_tag` × année × mois, **sans colonne `indicator_id`** ;
   seule `outcomes` référence `indicators`. Les 20 indicateurs d'output du classeur sont
   orphelins. · **L**
3. **Les huit indicateurs transversaux** (C.1.1 à C.4.1 — redevabilité, sécurité/dignité, genre,
   environnement) n'ont aucun moyen d'être marqués comme tels. · **M**
4. **`Data source` ≠ `Collection method`** : le classeur les distingue nettement (col C vs
   col D). MEMS n'a que `method`. · **S**
5. **Aucun responsable de collecte** (col G, 10 valeurs dont « WFP/Gov », « CPs »,
   « JOINTLY WFP/DEFIS ») — c'est pourtant qui relancer quand une collecte manque. · **S**
6. **Aucune valeur de référence (baseline)** ni sa date, alors que `target` est obligatoire. · **M**
7. **Double fréquence** : le classeur exprime systématiquement deux rythmes dans une cellule
   (« Monthly collection — Quarterly consolidation »). Le `<Select>` de MEMS n'en a qu'un. · **M**

> **Deux corrections à ce document.** (a) L'ancre donnée plus haut pour les cinq méthodes de
> démonstration est fausse : elles sont dans `web/src/lib/constants.js:99-109` (`D_INDICATORS`),
> **pas** dans `web/src/lib/seed.js:44-55`. (b) Les 17 valeurs réelles du classeur Résilience
> sont **composites** (« PDM/CHS », « CHS/ FGD/ Visits/ Workshop/PDM ») : une liste déroulante à
> choix unique perdrait de l'information sur 43 % des lignes. Il faut donc trancher la
> **multivaluation** de la méthode, pas seulement fermer la liste.

> **Point favorable, vérifié.** Les six calculs de couverture de MEMS
> (`web/src/lib/constants.js:137-144`) **sont exactement l'Outil 3 du cadre RBM**, confrontés
> cellule par cellule à la diapositive 25 du PPTX : durée d'opération en mois, nombre de sites,
> niveau de risque 1/2/3, intervalle minimal requis, nombre de sites ciblés par mois, nombre
> faisable, intervalle ajusté, ratio faisable/ciblé. Ils sont donc **légitimes dans un rapport
> RBM** — cela règle une partie de K1 : ce n'est pas un arbitrage produit, c'est une exigence du
> cadre. L'Outil 4 exige en plus les cumuls mensuels, que `coverageRows`
> (`constants.js:266-270`) calcule déjà mais que le générateur de rapport n'expose pas.

---

## Mise à jour des chantiers L et M

### L8 (14d) — le budget TPM, désormais spécifié

Le classeur donne la formule exacte : **`Budget = Coût unitaire × Qtté 2 × Qtté 1`**, avec un
sous-total par équipe et un total général (9 635 000 Ar en juillet 2026).

Sémantique des deux quantités, reconstituée ligne à ligne :
- **Qtté 1 (jr)** = jours = `Jour de travail` + `Déplacement (aller-retour)` — **sauf** le
  carburant (litres) et le forfait (jours de travail **seuls**, `C25=7` quand `C21=8`).
- **Qtté 2 (nb)** = nombre d'unités : superviseurs, agents, véhicules, `1` pour le carburant,
  et **superviseurs + agents** pour le forfait.

**Le classeur ne contient aucune formule inter-feuilles** : les quantités de la feuille BUDGET
sont recopiées à la main depuis les blocs d'équipe. C'est exactement ce que la demande 14d veut
supprimer.

**Excellente nouvelle, vérifiée par reconstitution** : avec le barème de `seed.js:597-603`,
`derivedLines` (`lib/tpm.js:39-61`) reproduit **exactement** les postes 1 à 4 des quatre blocs
(TEAM 3 : 560 000 + 480 000 + 2 400 000 + 600 000). Le total MEMS serait 9 315 000 Ar contre
9 635 000 — **écart de 320 000 Ar, soit précisément les quatre lignes « Forfait 1st premium »**.

Il ne manque donc que deux choses :
- **L8a** — Dériver le forfait. `lib/tpm.js:45-52` exclut explicitement `driver='forfait'`
  (« ne dérive de rien »), et `:40` ne calcule qu'un seul `jours = days + travel_days` — or le
  forfait se calcule sur les jours de travail **seuls** et sur superviseurs + agents. · **M**
- **L8b** — Ajouter un driver d'équipement. `011_tpm.sql:104-105` n'a aucune valeur pour un
  équipement ; « Groupe électrogène avec carburant » (80 000) est déclaré dans les quatre blocs
  mais **non budgété** en juillet 2026 (colonne C vide → F = 0). · **S**
- **L8c** — Sortir la norme de carburant du code. 15 L/véhicule-jour est en dur à deux endroits
  (`Tpm.jsx:711`, `seed.js:643`) — et les blocs 1 et 2 du classeur **ne la suivent pas** (45 et
  60 L au lieu de 30). Elle doit être un paramètre de barème, pas une constante. · **S**

**Réponses partielles apportées aux autres questions TPM :**
- **Q16** — la maille est tranchée : l'affectation se fait par **zone entière et pour toutes les
  activités à la fois** (`BUDGET!A4` : « GD/PECMAM/FARNE_AMBANISARIKA_AMBOVOMBE »), jamais site
  par site. Preuve : les feuilles PEC n'ont qu'une liste de sites, sans bloc d'équipe — leur
  budget est celui de l'équipe GD/GFD de la même zone. Le critère de choix **entre** deux
  prestataires reste inconnu (le classeur n'en contient qu'un).
  ⚠️ Conséquence pour MEMS : `tpm_zone.activity_tag` est mono-valué et borné à 20 caractères
  (`routes/tpm.js:421`), et l'unicité `(geo_pcode, activity_tag)` (`:447-450`) **interdit** de
  représenter une équipe multi-activités autrement que par un tag opaque. · **M**
- **Q17** — les jours viennent du **calendrier de distribution** (`GFD ABV`!A12:C17 : deux dates
  = deux jours), pas d'une norme de productivité — 10 sites en 2 jours pour TEAM 1, 29 sites en
  2 jours pour TEAM 2. La composition est constante : 1 superviseur + 1 agent + 1 véhicule 4×4.
  Le déplacement vaut 0 pour les zones du bureau et 1 pour les zones éloignées.
- **Q18** — le nom du prestataire **n'apparaît dans aucune cellule** (seulement dans le nom du
  fichier) : cela plaide pour un **en-tête**, pas une colonne répétée. « Nb de sites » = sites
  affectés à l'équipe : 10 / 29 / 27 / 16, soit 82. Aucun plafond contractuel n'apparaît.
- **Q14** — tranchée, et **il faut cinq colonnes, pas trois** : les six feuilles portent
  `ADM1 | ADM2 | ADM3 | ADM4 | POIName`, et le POI est distinct de l'adm4 dans de nombreuses
  lignes (« Ambanisarika » vs « Ambanisarika Centre »). Les 4 XLSForms confirment : tous
  collectent l'adm4 explicitement.

### M — Cartographie : Google Maps confirmé

**Q20 est tranchée sur le principe** : Google Maps remplace le rendu actuel. L'alternative
OSM/MapLibre mentionnée plus haut n'est plus qu'une note de repli hors ligne. **La question de
la clé d'API reste entière et bloque la première ligne de code.**

- **M1a — CSP.** L'en-tête réellement émis a été mesuré. Il faut ouvrir : `script-src` →
  `https://maps.googleapis.com` ; `connect-src` → `maps.googleapis.com`, `maps.gstatic.com` ;
  `img-src` → les hôtes de tuiles (`maps.gstatic.com`, `khms{,0,1}.googleapis.com`,
  `mts.googleapis.com`…). **Et surtout `worker-src`, qui n'est pas déclarée aujourd'hui** et
  retombe donc sur `default-src 'self'` : un worker `blob:` serait refusé, panne muette, carte
  blanche sans erreur lisible. Mettre ces hôtes dans une constante **dédiée**, surtout pas dans
  `config.corsOrigins` (`index.js:53`), qui mélange deux notions. · **S**
- **M2 — le cadrage devient trivial.** `GET /api/geo/geometry` renvoie **déjà** `extent`
  (`routes/geo.js:293`) : `map.fitBounds(...)` suffit, sans migration ni nouvelle route. · **S**
- **M4b — filtre par emprise, nouveau et nécessaire.** `readGeometries` (`lib/geom.js:213-226`)
  ne filtre que par `level` et `parent` : il n'accepte aucune bbox. Les colonnes existent
  pourtant (`012_geo_geom.sql:44`) mais **aucune requête ne les lit et aucun index ne les
  couvre**. Sans ce filtre, « le détail seulement pour ce qui est à l'écran » est impossible et
  `detail=true` rapatrie tout le niveau. · **M**
- **M4d — opacité.** « Rattache le shapefile **dessus** » impose que le fond reste visible : cela
  exclut l'aplat actuel (`fillOpacity 0.9`, `MapView.jsx:358`) et le remplissage blanc des
  unités sans données (`:352`), qui masqueraient précisément le fond demandé. · **S**
- **M3 — volume de points.** `/api/analytics/map` sert jusqu'à 6 000 sites, aujourd'hui dessinés
  en 6 000 `<circle>` SVG. Ni `google.maps.Marker` (déprécié) ni `AdvancedMarkerElement` ne
  tiennent ce volume sans regroupement. · **L**
- **GEO — le niveau 4 n'est pas acquis.** Les deux sources de shapefile sont inaccessibles
  depuis cet environnement (403), mais le point dur est mesurable : un niveau village
  (~18 000 fokontany) demande 382 Mo à 1,2 Go de tas dans le navigateur avant tout envoi, et le
  service plafonne à 1 500‑4 000 features (`routes/geo.js:281`). **M4 se scinde donc en deux** :
  le portage du dessin (acquis en principe) et la tenue du niveau 4 dans le pipeline (non
  acquis, · **XL**). Il faut probablement un import de contours en ligne de commande et en flux,
  sur le modèle de `import-geo.js`. · **L**
- **DOC** — Corriger `MapView.jsx:12` (« Aucune tuile n'est appelée : la carte fonctionne hors
  ligne et ne fuite aucune donnée »), qui devient faux, ainsi que la revendication de
  déploiement souverain du README. Et documenter l'ouverture de la CSP : le commentaire
  `index.js:46-49` dit que ces autorisations Google avaient été **retirées** délibérément —
  sans note, le prochain lecteur les retirera à nouveau et cassera la carte. · **S**

---

# Questions bloquantes

Ces points ne peuvent pas être décidés depuis le code — ils engagent une règle métier ou un
arbitrage produit. **Huit ont été fermées ou réduites par les documents du 31/07/2026.**

| # | Sujet | Question |
|---|---|---|
| **Q1** | xlsx (chantier 3) | Accepte-t-on que `web/package-lock.json` dépende de `cdn.sheetjs.com` (hors registre npm) pour chaque `npm ci` de la CI et du build Docker ? Sinon, bascule-t-on le parsing du XLSForm côté serveur sur `exceljs`, déjà présent ? |
| ~~**Q1 bis**~~ | TPM (L8) | ✅ **FERMÉE** — classeur fourni et dépouillé le 31/07/2026. Voir « Mise à jour du chantier L8 ». |
| **Q2** | Bureaux (H1) | Une antenne devient-elle un **vrai bureau** (identifiant propre, comptes possibles, périmètre propre) ou reste-t-elle un libellé de rattachement ? Que fait-on des valeurs texte déjà saisies dans `offices.antennes` et `sites.antenne` ? Le périmètre d'un area office englobe-t-il celui de ses antennes ? |
| **Q3** | Sites (H2) | Le registre ne restera atteignable que par l'onglet Suivi-évaluation. Les onglets étant réglables compte par compte (`users.tabs`), faut-il vérifier qu'aucun compte existant ne perd l'accès ? |
| **Q4** | Périmètres (H3) | Le sélecteur d'unités doit-il permettre d'attribuer des communes (adm3), voire des fokontany (adm4) ? Le schéma l'autorise déjà. |
| **Q5** | Pays (H4) | « Définir les adm1 à adm4 » = seulement les **nommer** (déjà possible), ou **déclarer combien de niveaux** ce pays possède ? La seconde lecture impose une colonne `depth` et la revue de tous les écrans qui supposent quatre niveaux. |
| **Q6** | Export localités (I1) | CSV ou XLSX ? `exceljs` est déjà côté serveur et produit déjà les modèles d'import — un `.xlsx` supprimerait d'un coup les problèmes de séparateur, de BOM et de p-codes à zéro non significatif. |
| **Q7** | Types de site (I2) | Deux typologies se recouvrent : `site_type` (liste figée `constants.js:194`) et `poi_subtype` (référentiel en base). Laquelle fait foi ? |
| **Q8** | Indicateurs (J1) | Où placer le téléchargement du modèle et le téléversement : Paramètres → Indicateurs, ou Actual Data → Import Excel (où tout le dispositif existe déjà) ? |
| ~~**Q9**~~ | Méthode de collecte (J2) | ✅ **FERMÉE** — 25 méthodes (`MRE dropdown list`!T2:T26) + 6 fréquences (`V2:V7`). **Reste un sous-point** : le classeur Résilience emploie des méthodes *composites* (« PDM/CHS ») sur 43 % des lignes — faut-il autoriser plusieurs méthodes par indicateur ? |
| **Q10** | Rations (J3) | Que désigne « **multiplicateur** » : le nombre de bénéficiaires (remplaçant `sample = 1000`), ou un facteur supplémentaire en plus des bénéficiaires ? Et cela change-t-il aussi le calcul du PDD, ou seulement l'aperçu de test ? |
| **Q11** | Rapports (K1) | « Indicateurs calculés » = les formules de performance par jeu de données (`Analytics.jsx:100-136`), les six calculs de couverture (`Settings.jsx:1509`), ou les deux ? |
| **Q12** | Sauvegarde (K2) | But réel : archivage / reprise après sinistre, transfert entre instances, ou export sélectif pour analyse externe ? Les trois n'ont ni le même format ni les mêmes garde-fous. |
| **Q13** | Notifications (K3) | La cloche montre-t-elle seulement l'état dérivé actuel (retards, validations en attente), ou aussi des **événements** (« un collègue a validé », « un import a été confirmé ») ? La seconde lecture impose une table de notifications côté serveur. |
| ~~**Q14**~~ | Plan de suivi (L1) | ✅ **FERMÉE — et la réponse va plus loin que la question** : il faut **cinq** colonnes (adm1→adm4 + nom du site), pas trois. Les 6 feuilles du budget TPM et les 4 XLSForms portent tous l'adm4, et le POI y est distinct de l'adm4. |
| **Q15** | ODK / déjà suivi (L4) | 🟡 **RÉDUITE** — le champ site porte toujours un **code** issu de `choices`, mais de forme différente par formulaire (voir chantier O). **Restent trois points** : (a) comment rattacher SMP, dont les codes sont des entiers hors référentiel p‑code ? (b) que faire des 7 codes GD_PREVMA ambigus ? (c) **sur quelle période un site compte-t-il comme « déjà suivi » ?** — reste entière, c'est une règle métier. |
| **Q16** | Affectation TPM (L5) | 🟡 **RÉDUITE** — la maille est tranchée : affectation **par zone entière et pour toutes les activités**, jamais site par site. **Reste** : sur quel critère choisir entre deux prestataires ? Le classeur n'en contient qu'un. |
| ~~**Q17**~~ | Brouillon TPM (L6) | ✅ **FERMÉE** — les jours viennent du **calendrier de distribution** (2 dates = 2 jours), pas d'une norme ; composition constante 1 superviseur + 1 agent + 1 véhicule 4×4 ; déplacement 0 en zone de bureau, 1 en zone éloignée. |
| ~~**Q18**~~ | Colonnes TPM (L7) | ✅ **FERMÉE** — le nom du prestataire n'est dans aucune cellule → **en-tête**, pas colonne. « Nb de sites » = sites affectés à l'équipe (10 / 29 / 27 / 16). Aucun plafond contractuel n'existe. |
| **Q19** | Panneau prestataire (L9) | Quelles informations exactement, et dans quel ordre : identité et contacts, contrats et plafonds, barème, avenants, plans du mois et leur état, dernières dépenses, alertes de dépassement ? |
| **Q20** | Google Maps (M1) | 🟡 **RÉDUITE** — Google Maps est confirmé, l'appel aux serveurs Google est accepté. **Reste, et c'est bloquant dès la première ligne de code : qui fournit et paie la clé d'API ?** Prévoir aussi sa restriction par référent HTTP, sans quoi elle est utilisable depuis n'importe quel site. |
| **Q21** | Cadrage (M2) | 🟡 **COÛT EFFONDRÉ** (`extent` est déjà renvoyé). **Reste** : cadrage simple à l'ouverture, ou contrainte dure interdisant de sortir du pays (gênant pour un site frontalier) ? Faut-il griser l'extérieur ? |
| **Q22** | Panneau carte (M3) | Inchangée. Quelle est la **liste ordonnée** des informations voulues pour un site, et pour une unité administrative ? |
| **Q23** | Contours (M4) | 🟡 **RÉDUITE** — « rattache le shapefile **dessus** » impose que le fond reste visible, donc l'aplat opaque actuel est exclu. **Reste** : à partir de quel niveau de zoom veut-on la pleine résolution (coût réseau direct) ? |
| **Q24** | Coût Google (M1) | Quel plafond mensuel accepte-t-on, et que se passe-t-il quand il est atteint : la carte s'arrête, ou bascule sur le rendu SVG actuel ? Un chargement est facturé à chaque ouverture de l'écran. |
| **Q25** | GPS observé (chantier O) | Le geopoint ODK doit-il **écraser** `sites.lat/lon`, ou coexister ? Écraser est le moins cher mais détruit la valeur saisie **sans trace** (la table n'a ni provenance ni date de relevé), et un seul relevé fautif déplace le site définitivement. Recommandation à valider : garder `sites.lat/lon` comme référence, ajouter une table de positions observées, et n'écrire dans le site que par une action explicite « adopter cette position », journalisée. |
| **Q26** | Nature du geopoint (chantier O) | Un geopoint enregistre où se tenait **l'agent**, pas la position officielle du site — sur un point de distribution l'écart peut atteindre plusieurs centaines de mètres, et plusieurs soumissions produisent un **nuage**. Que veut-on : le dernier point, un point moyen, ou tous les points comme trace de passage ? La précision renvoyée par ODK doit-elle servir de seuil de rejet ? |
| **Q27** | Niveau du fond de carte | Veut-on vraiment un fond de **niveau 4** (~18 000 fokontany) ? Le pipeline n'en sert que 1 500 à 4 000 à la fois et le navigateur ne tient pas l'import. Un fond adm2/adm3 avec descente en adm4 sous un parent choisi est ce que le code fait déjà et reste tenable. |
| **Q28** | Licence des contours | Les deux sources sont inaccessibles depuis cet environnement. À relever depuis un poste connecté : niveaux réellement fournis, **noms exacts des colonnes du `.dbf`** (ils décident si l'appariement automatique fonctionne), présence des p‑codes officiels, projection, et **licence de rediffusion** — un téléchargement gratuit derrière un compte n'emporte pas le droit de redistribuer les contours dans un produit interne. |
| **Q29** | Confidentialité (M1) | Chaque affichage transmet à Google la zone regardée, donc indirectement où le programme travaille. Sur des zones sensibles (`sites.security` a quatre niveaux), est-ce acceptable ? C'est exactement la propriété que `MapView.jsx:12` revendique aujourd'hui. |
| **Q30** | Référentiels MRE (chantier N) | Adopte-t-on les référentiels du gabarit RAM **en l'état** (8 natures + 76 sous-catégories, 3 niveaux de coût, interne/externe, pluriannuel) — ce qui refond `010_mre.sql` — ou garde-t-on les listes actuelles de MEMS en acceptant qu'elles ne correspondent à aucun référentiel du PAM ? |

---

## Méthode

**Complément du 31/07/2026 (documents métier).** Dix documents fournis par le propriétaire du
produit ont été dépouillés : les deux classeurs de budget (TPM et MRE) cellule par cellule et
formule par formule, les 4 XLSForms ODK feuille `survey`/`choices`/`settings` en entier, le
classeur d'indicateurs, la note RBM et le PPTX. Les affirmations qui en découlent sont ancrées
sur des références de cellules vérifiables. Ce qui n'a **pas** pu être lu est signalé comme tel :
les deux PDF du PAM (`cdn.document360.io`, 403) et les deux sources de shapefile — aucun contenu
n'en a été déduit.

Analyse du 31/07/2026 : lecture intégrale du dépôt (~22 000 lignes) par agents parallèles,
254 fonctionnalités recensées (134 complètes, 105 partielles, 5 coquilles, 10 mortes), puis
vérification contradictoire de chaque affirmation de la version précédente de ce document.

`npm audit` a réellement été exécuté sur `server/` et `web/` ; les versions ont été confrontées
au registre ; l'atteignabilité de chaque avis a été analysée dans le code plutôt que reprise
telle quelle. Les constats les plus lourds (absence de cloisonnement sur `PUT /collections`,
`must_change_pw` non appliqué, `host: "0.0.0.0"`, absence de `.dockerignore`, `|| true` de la CI,
`cdn.sheetjs.com` injoignable) ont été revérifiés à la main.
