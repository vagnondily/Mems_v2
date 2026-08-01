# À faire

Ce fichier n'existait pas dans le dépôt — il est créé ici pour donner suite à la
demande « lis docs/A_FAIRE.md et fais le chantier 1 », en reprenant ce qui a été
discuté et laissé en attente dans la conversation. À corriger/réordonner librement.

## Chantier 1 — PDD : calcul automatique des rations — FAIT

**Constat** : une ligne de PDD porte une seule denrée ; une distribution qui en
mélange plusieurs (riz + légumineuses + huile, par exemple) demandait donc une
ligne par denrée, saisie et calculée à la main (tonnage = bénéficiaires × jours ×
ration, refait pour chacune).

**Décision prise avec l'utilisateur** : pas de barème de ration réel fourni ni
inventé (ce sont des données de programme, propres à chaque opération) — à la
place, un écran de paramétrage où l'administrateur saisit lui-même la ration
(grammes/personne/jour) par denrée et par type d'activité (GD/PREVMA/PECMAM/FFA).

**Livré** :
1. `Paramètres → Rations` (`web/src/views/Settings.jsx`, `SetRations`) : table
   éditable, par activité, de la ration de chaque denrée (grammes/personne/jour).
   Persistée dans `settings.rationTable` (synchronisée comme le reste des
   réglages — contrairement à `formulas`, qui ne l'est pas, voir remarque
   plus bas). Aperçu du tonnage en direct sur un échantillon-témoin.
2. `Programme → Distributions` (PDD, `web/src/views/Planning.jsx`,
   `PddGenModal`) : un bouton « Générer par commune » ouvre un formulaire —
   bureau, région/district/commune (référentiel géographique, cascade),
   activité, partenaire, modalité, bénéficiaires planifiés, jours de ration.
   Pour la modalité Food, il affiche la liste des denrées configurées pour
   l'activité choisie avec le tonnage calculé en direct (décochables une à
   une), et crée **une ligne de PDD par denrée cochée** à la validation. Pour
   Cash/Voucher, une seule ligne (montant saisi à la main, comme avant —
   aucune ration ne s'y applique).

Vérifié de bout en bout avec un navigateur réel (Playwright) : paramétrage
d'une ration, génération d'un plan pour une commune, ligne(s) bien créée(s)
et persistée(s) côté serveur avec le tonnage attendu (bénéficiaires × jours ×
ration ÷ 1 000 000).

**Remarque relevée en marge — CORRIGÉE** : `db.formulas` (Paramètres → Calculs)
n'était dans aucune collection serveur — un administrateur qui modifiait un
calcul le perdait au rechargement, y compris juste après « Enregistrer ».
Confirmé non volontaire. Corrigé en le faisant vivre en miroir dans
`settings.formulas` (`App.jsx`, `hydrate` ; `Settings.jsx`, `SetCalc` — chaque
mutation de `d.formulas` recopie aussi `d.settings.formulas`, qui lui est
réellement synchronisé) : même mécanisme que `rationTable`/`siteIndicators`,
sans nouvelle route serveur. Vérifié : un calcul personnalisé créé survit à un
rechargement complet (relu directement en base, `settings.formulas`).

**Autre remarque relevée en testant — CORRIGÉE** : une ligne de PDD nouvellement
créée (que ce soit via « Ajouter une ligne » ou « Générer par commune ») ne
renseignait que `partner` (le nom du partenaire) et pas `partner_id` — le
serveur acceptait la ligne (le champ est optionnel) mais la clé étrangère
restait vide tant que la ligne n'avait pas été rechargée depuis le serveur.
Corrigé au même point que la résolution `indicator_id` des outcomes
(`App.jsx`, `SHAPERS.pdd`) : `partner_id` est maintenant résolu depuis le nom
au moment de l'envoi, pour toute ligne créée par n'importe quel écran.
Vérifié : une ligne créée porte son `partner_id` dès sa première écriture en
base, sans attendre un rechargement.

## Chantier 2 — Revue des écrans « budget » comme utilisateur final — FAIT

Demande explicite : « regarde chaque écran, teste comme un end user » plutôt que
deviner lequel est visé.

**MRE** (`Mre.jsx`) : testé de bout en bout au navigateur — création d'une
activité, ajout de deux lignes de budget, total calculé (jamais saisi),
répartitions par nature d'activité / catégorie de coût / mois, bascule vers
« Exécution budgétaire ». Aucun défaut trouvé ; l'écran se comporte comme conçu.

**PDD — section Planification** : couverte par le chantier 1 (génération par
commune) et par un ajout manuel classique ; testée aux deux endroits, rien
à signaler au-delà de la remarque sur `partner_id` déjà notée plus haut.

**TPM** (`Tpm.jsx`) : un défaut réel et significatif trouvé en essayant de
construire le scénario complet — un compte de prestataire qui se connecte
lui-même pour soumettre son plan, plutôt qu'un administrateur qui agit en son
nom :

1. **`Paramètres → Utilisateurs` ne permettait pas de créer ce compte.** Le
   serveur (`server/src/routes/users.js`, `server/src/lib/validate.js`) et
   `TpmView` (le bandeau « Vous êtes rattaché au prestataire… », le masquage du
   sélecteur « Tous les prestataires ») savent tous les deux ce qu'est un
   compte `tpm_id`, mais l'écran de création/édition d'utilisateur
   (`UserModal` dans `Settings.jsx`) n'exposait que le rattachement à un
   bureau — aucun champ pour choisir un prestataire. Corrigé : `UserModal`
   propose maintenant les deux rattachements, mutuellement exclusifs (choisir
   l'un vide l'autre), désactivés pour les rôles administrateur/super, comme
   le serveur l'exige déjà ; le tableau des comptes affiche le prestataire
   rattaché au lieu de « Tous ».
2. **`GET /api/state` omettait `tpm_id` de la liste des comptes**
   (`server/src/routes/state.js`). Cette liste est rechargée à chaque
   connexion et après chaque conflit de synchronisation — sans ce champ, le
   client oubliait le rattachement d'un compte dès le premier rechargement,
   et le **prochain enregistrement de ce compte** (même pour changer un champ
   sans rapport, comme la fonction) renvoyait `tpm_id: null` au serveur,
   détachant silencieusement le compte de son prestataire. C'est probablement
   la cause des rattachements manquants observés. Corrigé, avec un test de
   régression (`server/test/api.test.js`, « état : la liste des comptes porte
   tpm_id… »).

Vérifié de bout en bout : création d'un compte prestataire, connexion sous ce
compte, bandeau de cloisonnement affiché, liste des plans limitée au bon
prestataire (l'autre prestataire n'apparaît pas), modification d'un champ
sans toucher au rattachement puis relecture en base — `tpm_id` survit
désormais. Le circuit de validation à trois niveaux et l'éditeur de zones/
lignes d'un plan ont aussi été ouverts en tant qu'administrateur : aucune
erreur, budget cohérent avec le barème contractuel.

## Chantier 3 — xlsx (SheetJS) : dépendance vulnérable — FAIT

**Décision** : pas de tarball CDN. `xlsx` (SheetJS) n'a plus de correctif publié
sur le registre npm depuis ses CVE (pollution de prototype, ReDoS) — seul un
tarball signé sur `cdn.sheetjs.com` les corrige, ce qui aurait fait dépendre
chaque `npm ci` (y compris en CI) d'un hôte hors du registre npm. Remplacé
l'unique usage réel — la lecture, dans le navigateur, de la feuille `survey`
d'un XLSForm joint à une source ODK Central, pour en tirer les libellés de
question (`Paramètres → ODK Central`, `web/src/views/Settings.jsx`,
`attachXls`) — par [`read-excel-file`](https://www.npmjs.com/package/read-excel-file)
(export `/universal`, sans worker à empaqueter), publié sur le registre npm,
sans dépendance transitive vulnérable (`npm audit` : plus aucune entrée sur
`xlsx` après le remplacement). `exceljs` — déjà utilisé côté serveur — a été
essayé en premier mais écarté : sa dépendance à `archiver` pour l'écriture
(inutile ici, on ne lit qu'en lecture) introduisait 13 vulnérabilités
transitives (`glob`, `minimatch`, `brace-expansion`…), un échange perdant.

Vérifié avec les cinq vrais XLSForms MDG de ce dépôt (jusqu'à 2000+ caractères
de libellé, texte de consentement compris) : extraction identique à l'ancienne
bibliothèque, `npm run build` compile, et un défaut réel découvert au passage
a été corrigé — voir remarque ci-dessous.

**Remarque relevée en testant** : la limite de longueur d'un libellé de
question (`server/src/routes/collections.js`, schéma `odkForms`) était de 500
caractères. Un XLSForm réel dépasse cette limite dès qu'une question porte un
texte de consentement ou une note d'instruction — la source entière était
alors refusée (422) au premier enregistrement, avec un message d'échec facile
à manquer (le bandeau « Source enregistrée » s'affiche de façon optimiste,
avant que la synchronisation vers le serveur n'ait confirmé quoi que ce soit —
même défaut de fond que le rattachement `tpm_id` du chantier 2). Portée à
4000 caractères, avec un test de régression.

## Chantier 4 — Indicateurs de site et cohérence GPS (soumissions ODK Central) — FAIT

**Demande** : pouvoir repérer facilement, à partir des soumissions ODK Central,
les sites à risque, les signes de détournement ou de fraude, et la performance
par catégorie — analyse fondée sur chacun des cinq XLSForms réels, affichée sur
la fiche de chaque site (« à droite »), et modulable par l'administrateur.
Vérifier aussi que le point GPS d'une soumission correspond, à 1 km près, aux
coordonnées enregistrées pour le site dans MEMS.

**Ce qui a d'abord fallu corriger** : une question `geopoint` XLSForm arrive
dans l'OData d'ODK Central comme un point GeoJSON —
`{ type:"Point", coordinates:[lon,lat,alt] }` — pas comme un champ de premier
niveau. L'aplatissement (`server/src/lib/odkClient.js`) descendait dedans,
gardait `type` et perdait `coordinates` (un tableau, explicitement ignoré) :
la question GPS disparaissait entièrement. Elle est maintenant reconnue avant
la récursion et posée sous le nom même de la question, en `{ lat, lon, alt }`.

**Analyse des cinq XLSForms** : en comparant les feuilles `survey` de
GD_PREVMA, MIARO_PROD, SMP, NutritionAIM et RESILIENCE_SAMS (déjà appariées au
chantier d'ingestion ODK), un tronc commun de questions ressort — même nom de
champ, même liste de choix `Yesno` (1=Oui, 0=Non) — qui couvre exactement les
angles demandés :
- **Chaîne d'approvisionnement** : conformité au bordereau, déchargement
  observé, registre de stock tenu, livraison reçue et dans les délais,
  personnel formé.
- **Redevabilité envers les populations affectées (AAP)** : mécanisme de
  plainte connu/utilisé, trajet vers le site jugé sûr.
- **Fraude et détournement** : vol/détournement signalé ou constaté, doute sur
  la sélection des bénéficiaires, rumeur de paiement pour bénéficier de l'aide,
  bénéficiaires porteurs de la carte d'autrui.
- **Sécurité** : acteurs armés présents, problème de sécurité rapporté.
- **Suivi** : nombre de visites, date de la dernière.
- MIARO (tag `MPA`) porte en plus un taux de présence (réel ÷ planifié) et le
  bon fonctionnement du matériel SCOPE.

**Livré** :
1. `Paramètres → Indicateurs de site` (`SetSiteIndicators`, Settings.jsx) :
   éditeur modulable par activité — intitulé, type d'agrégat (% de Oui, % dans
   une liste de codes, moyenne, ratio de deux champs, nombre, date la plus
   récente), champ(s) ODK, catégorie, et un drapeau « alerte » quand un taux
   élevé est un signal (fraude, sécurité) plutôt qu'une performance. Persisté
   dans `settings.siteIndicators`, pré-rempli avec le tronc commun ci-dessus,
   librement modifiable — « Rétablir les indicateurs par défaut » par activité.
2. Chaque source ODK Central (`Paramètres → ODK Central`) déclare désormais
   aussi un **champ GPS**, à côté du champ site et du champ date déjà
   existants.
3. Au tirage (`POST /odk-forms/:id/pull`), chaque soumission dont le champ GPS
   situe le site à plus d'1 km de ses coordonnées enregistrées marque ce site
   « à vérifier » (`sites.needs_review`, `review_note`, `review_distance_km`) —
   à la hausse seulement : un tirage sans nouvel écart ne referme jamais
   l'alerte tout seul, il faut un administrateur.
4. Registre des sites : un badge rouge « GPS » sur la ligne concernée, un
   filtre « GPS : à vérifier seulement », et un compteur dans les statistiques
   de tête d'écran.
5. Fiche d'un site (`SiteModal`) : un panneau à droite, toujours visible quel
   que soit l'onglet actif à gauche — l'alerte GPS (écart, date, source, bouton
   « Marquer comme vérifié ») et les indicateurs de performance, calculés à la
   volée à partir des soumissions ODK dont le champ site correspond au code du
   site, groupés par catégorie et colorés selon qu'un taux élevé est une
   performance ou une alerte.

Vérifié de bout en bout avec un serveur ODK Central simulé et des données
proches du réel : geopoint conservé après tirage, site à plus d'1 km marqué et
badge visible dans le registre, indicateurs calculés conformes aux soumissions
(vérifiés un par un), correction de l'alerte qui persiste côté serveur et fait
disparaître le badge. Server : 104/104 tests (dont un nouveau sur la
préservation du geopoint et le marquage/levée de l'alerte GPS).

## Fait (pour mémoire, PR #4 et #5 fusionnées dans main)

- Ingestion ODK Central (script + tirage réel + appariement des variables des
  5 XLSForms MDG).
- Éditeur de formules de performance sur les jeux de données (Analyses).
- `.devcontainer` pour GitHub Codespaces (amorçage automatique).
- Correctifs : blocage CI e2e (recharts/rAF), CORS Codespaces, encadré de
  connexion trompeur, favicon manquant, rafraîchissement après import d'un
  référentiel géographique.
