# À faire — ce qui reste, écrit pour qu'une session suivante exécute

Ce document existe pour qu'une session suivante **exécute** plutôt qu'elle reconçoive.

État de départ de cette passe : branche `claude/analyse-mems-v2-lmr9o5`, 122 tests API
et 18 tests web au vert. À la fin de cette passe (chantier 1 construit) : **126 tests
API**, 18 tests web, toujours au vert, vérifié en navigateur réel (voir le journal en
fin de section 1).

---

## 1. Lire réellement les soumissions ODK — FAIT, avec une réserve importante

**Statut** : construit et vérifié — migration, route serveur, écran, tests API (5
nouveaux tests), et un passage complet en navigateur réel contre un serveur mock local.
Ce qui suit documente ce qui a été bâti ET pourquoi la forme a changé en cours de route,
pour que la session suivante ne revienne pas en arrière par erreur.

### La correction d'API — la partie qui compte le plus

Le brouillon initial de ce chantier (écrit par la session précédente) supposait l'API
OData d'ODK Central : `/v1/projects/{p}/forms/{f}.svc/Submissions`, pagination
`$top`/`$skip`/`$filter`, champs `__id`/`__system`.

En cours de session, l'utilisateur a fourni un lien de test réel :
`https://moda.wfp.org/api/v1/data/340943` avec un jeton hexadécimal à 40 caractères.
Cette forme ne correspond PAS à ODK Central. Elle correspond à l'API REST classique
KoBoCAT/Ona (dont MODA — la plateforme ODK de WFP — hérite) : `/api/v1/data/{id}`,
authentification `Authorization: Token <jeton>` (DRF TokenAuthentication, pas un Bearer
JWT — le format à 40 caractères hexadécimaux est la signature de ce type de jeton),
soumissions plates avec des champs `_id`/`_uuid`/`_submission_time` (un seul tiret bas,
pas deux).

**La route a été réécrite pour cette forme.** `server/src/routes/odk.js` appelle
maintenant `/api/v1/data/{form_id}` avec `Authorization: Token`, pagine par
`limit`/`start`, filtre par `?query={"_submission_time":{"$gt":"..."}}` (syntaxe
MongoDB-like, convention KoBoCAT), et lit `_uuid`/`_id`/`_submission_time`.

**Ce qui n'a PAS pu être vérifié** : la politique réseau de l'environnement de
développement refuse la sortie vers `moda.wfp.org` (403 côté proxy — voir
`recentRelayFailures` de `$HTTPS_PROXY/__agentproxy/status`). La correction ci-dessus
repose sur la forme de l'URL et du jeton, **pas sur une réponse réelle observée**. La
vérification en navigateur a donc été faite contre un serveur KoBoCAT/Ona **simulé**
localement (voir le journal plus bas), qui respecte la convention mais ne garantit pas
que MODA n'a pas ses propres particularités (pagination enveloppée dans `{results:[...]}`
au lieu d'un tableau brut — déjà anticipé et accepté par `callOdk()` — champs de méta
supplémentaires, limites de débit, etc.).

**À faire en tout premier, avant tout autre travail sur ce chantier ou sur le 2** :
retester `POST /odk/forms/:id/test` contre le vrai `moda.wfp.org`, depuis un poste qui y
a accès (pas cet environnement), avec un jeton valide pour le formulaire 340943. **Un
jeton d'essai a été communiqué en clair dans la conversation qui a produit cette passe ;
il doit être considéré comme grillé et révoqué/régénéré côté WFP avant tout usage — ne
pas le reprendre, y compris depuis l'historique de conversation.** Si la vraie réponse
diverge de l'hypothèse KoBoCAT/Ona, corriger `buildUrl()` et `callOdk()` dans
`server/src/routes/odk.js` en conséquence — c'est le seul endroit qui la connaît, exprès.

### Migration — `server/migrations/022_odk_submissions.sql` (construite)

Le brouillon d'origine réajoutait `last_pull` par un second `ALTER TABLE`, alors que
cette colonne existe déjà depuis `001_init.sql`. Une migration qui l'avait fait telle
quelle aurait échoué au premier démarrage. Corrigé : seuls `last_cursor` et `last_error`
sont ajoutés.

### Route — `server/src/routes/odk.js`, montée sur `/api/odk` (construite)

- `POST /odk/forms/:id/pull` — `requireCap("edit")`. Pagine par pages de 500, plafonnées
  à 10 par appel (l'écran relance). `INSERT OR IGNORE` sur l'identifiant de soumission —
  c'est ce qui rend le rejeu inoffensif, vérifié par un test qui rejoue l'appel et
  confirme zéro doublon. Rend `{ lues, nouvelles, ignorees, sansSite, cursor }`.
- `GET /odk/forms/:id/champs` — les clés rencontrées dans les 200 dernières soumissions
  **déjà ingérées localement** (pas un nouvel appel au serveur ODK), avec type deviné et
  jusqu'à trois exemples. Exclut les champs préfixés `_` (métadonnées KoBoCAT/Ona) et
  `meta/`. C'est ce que l'écran d'appariement du chantier 2 affichera à gauche.
- `POST /odk/forms/:id/test` — un appel `limit=1`. **C'est le vrai « Tester la
  connexion »**, celui qui manquait — vérifié en navigateur : contre un mauvais jeton, il
  échoue vraiment et le dit, il ne prétend pas réussir.

**Deux défauts trouvés et corrigés pendant la vérification en navigateur, pas seulement
en test API :**

1. **Un jeton ODK externe refusé aurait déconnecté l'administrateur de toute
   l'application.** `web/src/lib/api.js` traite tout `401` comme « session MEMS
   expirée » et efface le jeton de session globalement. La route ODK renvoyait 401 quand
   le serveur externe refusait le jeton — un jeton ODK mauvais aurait donc éjecté
   l'utilisateur de MEMS entier, pour une cause sans rapport. Corrigé : `callOdk()` fait
   remonter `409` pour un 401/403 externe, jamais `401`. Reproduit par un vrai test en
   navigateur (jeton faux → toast d'erreur, session intacte) avant et après le correctif.
2. **Les boutons Tester/Extraire restaient invisibles juste après avoir configuré un
   jeton**, jusqu'au prochain rechargement complet. L'écriture est optimiste côté client
   (`web/src/App.jsx`, file de synchronisation à 900 ms) : après un enregistrement local,
   `db.odkForms[i].hasToken` — qui vient du serveur — n'est pas mis à jour, seul
   `db.odkForms[i].token` (la valeur tout juste tapée) l'est. La condition d'affichage ne
   testait que `hasToken`. Corrigé dans `Settings.jsx` (`SetOdk`) et `ActualData.jsx`
   (`Sources`) : `(f.hasToken || f.token)`.

### Écran — construit

`Paramètres → ODK Central` (`SetOdk` dans `Settings.jsx`) porte deux actions réelles par
source (icônes ⚡ et ↓, visibles seulement si un jeton existe) : tester, extraire — avec
état occupé, notification du résultat, et rechargement de l'état après extraction. La
colonne « Dernière extraction » affiche aussi `last_error` en rouge si le dernier appel a
échoué. `Programme → Sources de données` (`Sources` dans `ActualData.jsx`) porte la même
action d'extraction, pour qui travaille depuis cet écran plutôt que la configuration. Le
texte d'aide (« adresse d'appel ») et le champ de collage d'URL de la fiche source ont été
mis à jour pour la forme `/api/v1/data/{id}` ; le collage reconnaît aussi encore l'ancienne
forme ODK Central au cas où une source de ce type existerait un jour.

### Journal de vérification en navigateur réel (pas seulement les tests)

Playwright piloté manuellement (`chromium-cli` indisponible dans cet environnement,
`playwright-core` installé dans le scratchpad + binaire pré-installé
`/opt/pw-browsers/chromium`), contre le vrai serveur MEMS (`node src/index.js`) et un
serveur mock KoBoCAT/Ona local (`http://localhost:8899`, un fichier `http.createServer`
d'une soixantaine de lignes vérifiant l'en-tête `Authorization: Token`, la pagination
`limit`/`start` et le filtre `query`) :

1. Connexion, `Paramètres → ODK Central`, adresse de serveur posée sur le mock, jeton
   saisi sur la source déjà semée (`form_id=340943` — le même identifiant que le lien
   réel fourni en session).
2. « Tester la connexion » → toast « Connexion vérifiée », appel HTTP réel confirmé.
3. « Extraire » → toast « 3 nouvelle(s), 0 déjà lue(s), 1 sans site résolu » ; en base,
   les trois soumissions sont bien présentes, deux résolues au site `L0001` (une par
   `code`, une par simulation de résolution par `name`), une laissée sans site
   (`SITE-INCONNU`, aucun rattachement inventé) ; `odk_forms.records=3`,
   `last_cursor` = la date de la dernière soumission.
4. Rejeu de « Extraire » → « 0 nouvelle(s), 0 déjà lue(s) » : le second appel a bien
   utilisé `query={"_submission_time":{"$gt":cursor}}` et le mock a filtré côté serveur —
   ce test-là couvre le chemin du filtre incrémental, que les tests API (mock plus
   simple) ne couvraient pas.
5. `Programme → Sources de données` : même source, même compteur, bouton « Extraire »
   fonctionnel depuis cet écran aussi.
6. Jeton faux → toast rouge « Invalid token. », session MEMS intacte (vérifié avant ET
   après le correctif du point 1 ci-dessus, pour confirmer la régression puis sa
   correction).

### Pièges déjà rencontrés, pour ne pas les retrouver

- Le jeton ne ressort jamais de l'API, même déchiffré — vérifié par un test API
  (`token_enc` ne contient jamais le clair).
- `site_key` est résolu en `site_id` par `code`, puis par `name`, puis rien ; l'écran dit
  combien n'ont pas été résolus (`sansSite`).
- Le compte de démonstration codé en dur dans `web/src/App.jsx`/`Login.jsx`
  (`admin@mems.local` / `MemsAdmin2026`, actif seulement en `import.meta.env.DEV`) ne
  correspond à aucun compte tant que le semis n'est pas lancé avec
  `BOOTSTRAP_EMAIL`/`BOOTSTRAP_PASSWORD` réglés sur ces mêmes valeurs. Sans cela, l'appli
  tente deux connexions automatiques vouées à l'échec (StrictMode double l'effet) puis
  affiche l'écran de connexion normalement — dégradation correcte, mais déroutante à
  l'observation si l'on ne sait pas pourquoi.

### Ce qu'il reste pour ce chantier

Le chantier 2 (appariement des variables) peut commencer : `GET /odk/forms/:id/champs`
existe et rend une forme compatible avec ce que sa description prévoyait. Mais faire
d'abord la vérification contre le vrai `moda.wfp.org` décrite plus haut — apparier des
variables sur la base d'une API mal devinée serait pire que de ne rien apparier.

---

## 2. Apparier les variables du formulaire aux indicateurs

**Migration** — `server/migrations/023_appariement.sql`

```sql
CREATE TABLE odk_mapping (
  id          TEXT PRIMARY KEY,
  form_id     TEXT NOT NULL REFERENCES odk_forms(id) ON DELETE CASCADE,
  champ       TEXT NOT NULL,         -- le nom de la variable dans le formulaire
  cible_type  TEXT NOT NULL CHECK (cible_type IN ('indicator','output','site_field')),
  cible_id    TEXT NOT NULL,         -- indicators.id, activity_tag, ou nom de colonne
  agregation  TEXT NOT NULL DEFAULT 'sum'
              CHECK (agregation IN ('sum','avg','count','last','max','min')),
  filtre      TEXT,                  -- expression optionnelle, évaluée par l'interpréteur
                                     -- de web/src/lib/calc.js — PAS par new Function
  actif       INTEGER NOT NULL DEFAULT 1,
  rev         INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_map_unique ON odk_mapping(form_id, champ, cible_type, cible_id);
```

**Écran** — deux colonnes, dans Paramètres → ODK Central, à la suite de la fiche de
la source. À gauche les champs découverts (`GET /odk/forms/:id/champs`) avec leur type
et un exemple ; à droite les indicateurs et outputs de MEMS. Propositions automatiques
par similarité de nom **et compatibilité de type** — un `select_one` ne s'apparie pas à
une cible numérique, et le proposer ferait perdre plus de temps que de ne rien proposer.

**Route de rapprochement** — `POST /odk/forms/:id/apply`

Parcourt les soumissions non encore rapprochées, applique les appariements, écrit dans
`outputs` / `outcomes` pour la période et le site déduits. Rend le compte de ce qui a
été rempli, de ce qui a été ignoré faute d'appariement, et de ce qui n'a pas trouvé son
site. **Aperçu obligatoire avant écriture**, comme la génération du plan de distribution
et la restauration de sauvegarde : ces deux-là ont établi la règle dans ce projet.

**Ce que les XLSForms de l'utilisateur doivent apprendre avant de coder**

- la granularité d'une soumission — un site ? un bénéficiaire ? une distribution ? —
  c'est elle qui décide de l'agrégation par défaut ;
- les groupes répétés (`begin repeat`), qui produisent des sous-tables OData
  (`.svc/Submissions.groupe`) et demandent un second appel ;
- le champ qui porte le site et celui qui porte la date.

---

## 3. API de lecture pour Tableau Desktop et Power BI

**Migration** — `server/migrations/024_api_tokens.sql`

```sql
CREATE TABLE api_token (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,         -- SHA-256 ; le jeton n'est montré qu'à la création
  prefix      TEXT NOT NULL,         -- 8 premiers caractères, pour le reconnaître dans la liste
  country_code TEXT REFERENCES country(code) ON DELETE CASCADE,
  office_id   TEXT REFERENCES offices(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used   TEXT,
  revoked     INTEGER NOT NULL DEFAULT 0
);
```

Un jeton est **en lecture seule par construction** : il n'ouvre que `/api/v1/*`, et ces
routes ne contiennent aucune écriture. Il porte son propre cloisonnement pays/bureau,
qui ne peut être que plus étroit que celui de qui l'a créé.

**Routes** — `server/src/routes/v1.js`, montée sur `/api/v1`, authentifiée par
`Authorization: Bearer <jeton>` **ou** `?token=` (Tableau ne sait pas toujours poser un
en-tête).

| Route | Contenu |
|---|---|
| `/v1/sites` | registre, avec priorité calculée et couverture |
| `/v1/visits` | visites, avec statut de validation |
| `/v1/plan` | grille mensuelle planifié/réalisé |
| `/v1/outputs` | bénéficiaires planifiés et atteints par activité et mois |
| `/v1/outcomes` | valeurs mesurées des indicateurs |
| `/v1/pdd` | plan de distribution |
| `/v1/caseload` | population, ciblage, couverture par unité |
| `/v1/mmr` | exigence minimale de suivi consolidée |

Chacune accepte `?year=`, `?format=csv|json` et `?since=` (date ISO, pour l'actualisation
incrémentale). **Le CSV est ce que Tableau consomme le plus simplement** : en-tête sur la
première ligne, séparateur virgule, dates ISO, pas de séparateur de milliers.

Ajouter un `/v1/$metadata` minimal si l'on veut un connecteur OData natif ; sinon
Tableau lit très bien un CSV distant par « Fichier texte → URL ».

**Écran** — Paramètres → API, qui annonce aujourd'hui honnêtement que rien n'est servi.
Remplacer par : la liste des jetons (libellé, préfixe, dernière utilisation, révocation),
un bouton de création qui montre le jeton **une seule fois**, et pour chaque route une
URL complète copiable, prête à coller dans Tableau.

**Ce qu'il ne faut pas faire** : réutiliser le JWT de session comme jeton d'API. Il
expire en huit heures, il porte des droits d'écriture, et il finirait enregistré en clair
dans un classeur Tableau partagé.

---

## Ordre imposé

1 avant 2 (l'appariement suppose des soumissions), 3 indépendant. Chaque chantier se
termine par ses tests API et un passage dans un navigateur réel avant d'être poussé.

---

# Le reste du carnet

Ce qui a été relevé au fil du travail et laissé ouvert. Classé par ce que coûte de ne
pas le faire, et non par difficulté.

## 4. Aligner le calcul de priorité sur la note RBM — **le plus important**

C'est le seul point de cette liste où MEMS produit aujourd'hui des **chiffres qui ne
sont pas ceux que la méthode institutionnelle donnerait**. Le reste est du confort ou de
la dette ; celui-ci touche la justesse.

Repéré en lisant `Guidance_note_on_RBM.pdf` et `RBM.pptx`, jamais corrigé :

- **Outil 3.a — priorité d'un site.** La note prescrit la MOYENNE de six sous-scores,
  avec des dérogations dures : certains critères, seuls, imposent la priorité haute quel
  que soit le reste. `sitePriority()` dans `web/src/lib/constants.js` ADDITIONNE des
  points et compare à des seuils. Deux sites que la méthode classerait différemment
  peuvent donc recevoir la même priorité, et inversement. Or ce score décide de la
  fréquence des visites : l'écart se propage jusqu'au plan et jusqu'au budget.
- **Outil 3.b — ajustement annuel.** L'ajustement porte sur le nombre de sites UNIQUES
  visités dans l'année, pas sur le nombre de visites. La distinction change le
  dénominateur de la couverture.
- **Outil 2 — allocation des moyens par le risque.** Absent. C'est ce qui relie le
  niveau de risque d'une zone au budget de suivi qu'on lui consacre.
- **Règle trimestrielle de l'exigence minimale.** `computeMMR()` calcule au prorata des
  mois écoulés ; la note raisonne par trimestre.

**Comment s'y prendre** : écrire d'abord les tests à partir des exemples chiffrés de la
note — elle en donne — puis corriger jusqu'à ce qu'ils passent. Ne pas corriger la
formule au jugé : c'est ainsi qu'on remplace un écart connu par un écart inconnu.

## 5. Un compte rattaché à plusieurs pays

`users.country_code` ne porte qu'un pays. Un administrateur régional qui suit Madagascar
et les Comores est aujourd'hui soit borné à un seul, soit pas borné du tout — c'est-à-dire
qu'il voit tout, y compris ce qui ne le regarde pas.

Il faut une table de liaison `user_country(user_id, country_code)` et faire lire
`countryBound()` (`server/src/lib/scope.js`) sur un ENSEMBLE plutôt que sur une valeur.
Les appels sont nombreux mais la fonction est unique — c'est précisément pour cela
qu'elle avait été isolée.

## 6. La carte

- **Regroupement des points.** Au-delà de quelques centaines de sites au même endroit,
  les cercles se recouvrent en une tache. La liste latérale rend le problème supportable,
  elle ne le supprime pas. Regrouper par proximité en deçà d'un seuil de zoom, avec le
  compte dans la pastille.
- **Délimiter une zone et la conserver.** Le rectangle de zoom existe, mais dessiner un
  périmètre et l'enregistrer — pour dire « cette zone est suivie par ce prestataire » —
  n'existe pas. C'était demandé.
- **Défaut d'affichage.** Dans le champ de recherche de la carte, la loupe recouvre la
  première lettre du texte indicatif : on lit « ◎ite, commune, fokontany ». Il manque un
  retrait à gauche sur l'`input` (`web/src/views/MapView.jsx`).

## 7. Suites de la revue de sécurité

Trois points relevés, aucun corrigé :

- **CORS en développement.** `origin` renvoie vrai pour toute origine dès que
  `NODE_ENV !== "production"`, avec `credentials: true`. Sans danger en local, dangereux
  si une instance déployée démarre un jour sans `NODE_ENV`. Exiger une liste explicite,
  ou refuser de démarrer hors production sur une interface non locale.
- **`sameSite=lax`.** Correct aujourd'hui parce qu'aucune requête GET ne modifie l'état.
  Cette propriété n'est écrite nulle part et rien ne la vérifie : un GET mutant ajouté
  plus tard rouvrirait la faille sans que personne ne le voie. Écrire un test qui
  parcourt les routes et refuse tout GET qui écrit.
- **`GET /api/backup`.** Rend la base entière à toute session administrateur. Le
  cloisonnement est correct, mais c'est devenu la requête la plus lourde de conséquences
  de l'application : elle mérite sa propre alerte au journal, distincte du reste.

## 8. Petites dettes

- **Partenaire par commune dans le plan de distribution.** Le générateur affecte un seul
  partenaire à toutes les lignes produites. En réalité il change d'une commune à l'autre.
  Ajouter une colonne « partenaire » modifiable dans le tableau des communes de l'écran
  de conception.
- **Bureaux sans périmètre dans le jeu d'essai.** Bekily et Tsihombe n'en ont pas : le
  contrôle de cohérence géographique les signale à chaque exécution, ce qui apprend à
  ignorer un signal qui devrait rester rare. Corriger le semis.
- **Jeton ODK d'organisation.** Retiré parce que le serveur l'écartait en silence. Un
  jeton chiffré au niveau de l'instance, repris par les sources qui n'en déclarent pas,
  reste à faire si le besoin se confirme — le chantier 1 rend le jeton par source.

---

# 9. Retours d'usage — écran par écran

Relevés par l'utilisateur après une prise en main complète. Ce sont des demandes
métier : elles décrivent le travail réel, et là où l'application ne le suit pas.

## Configuration — la structure des bureaux

**Un bureau n'est pas une liste de chaînes.** Aujourd'hui la fiche d'un bureau porte des
« antennes » saisies comme du texte libre. Or la réalité est un ARBRE : un *area office*
porte plusieurs sous-bureaux et antennes ; un sous-bureau porte lui-même une ou
plusieurs antennes.

Il faut `offices.parent_id` et une fiche qui, en modification, propose la LISTE des
bureaux existants comme rattachement — avec la possibilité d'en retirer un devenu sans
objet. Conséquences à traiter : le cloisonnement (`officeClause`, `officeReach`) doit
descendre l'arbre — voir un area office, c'est voir ses sous-bureaux — et un bureau ne
peut pas devenir son propre ancêtre.

**Fusionner « Bureaux » et « Périmètre des bureaux » en un seul écran.** Ce sont deux
faces d'une même question : ce bureau existe, et il couvre ceci. Les séparer oblige à
faire deux fois le chemin pour un seul geste.

**Retirer « Sites » des paramètres.** Le registre a sa place sous Suivi-évaluation ; il
n'a rien à faire dans la configuration, où il fait croire qu'un site est un réglage.

**Le shapefile appartient à la configuration du pays.** C'est là qu'on téléverse le
fichier ET qu'on définit adm1 à adm4 avec leurs libellés — la correspondance entre les
attributs du fichier et les niveaux se fait dans le même écran, pas ailleurs.

## Répertoire des localités

- **L'export ne sort pas correctement.** À reproduire et corriger.
- **Le répertoire doit être ENGENDRÉ par le shapefile** : la liste des unités vient du
  découpage chargé, et non d'une saisie parallèle. Depuis cette liste, on doit pouvoir
  sortir les sites de chaque unité **avec leur type de site**.

## Indicateurs

- **Modèle à télécharger, fichier à téléverser.** Comme l'import Excel des réalisations :
  on récupère un classeur pré-rempli, on le complète hors ligne, on le renvoie, et l'on
  voit les écarts avant de confirmer. Réutiliser `server/src/routes/import.js`.
- **La méthode de collecte devient une liste à choisir**, plus un champ libre — c'est ce
  qui permettra de la croiser avec les sources ODK.

## Rations

Le calcul doit être explicite et vérifiable :

    ration (grammes / personne / jour) × nombre de jours × multiplicateur = résultat en kg

Saisir la ration en grammes journaliers, puis un nombre de jours et un multiplicateur
pour éprouver le calcul, et afficher le résultat converti en kilogrammes. Aujourd'hui le
générateur de plan de distribution prend une ration en kg/personne/jour sans montrer
l'opération : on ne peut pas la vérifier d'un coup d'œil.

## Modèles de rapport

Ajouter les **indicateurs calculés** aux blocs disponibles, et pour chacun choisir sa
forme — graphique, tableau, ou autre — selon ce que l'indicateur supporte. Un taux se
lit en courbe, une répartition en secteurs, une liste en tableau : le modèle doit
laisser ce choix plutôt que l'imposer.

## Plan de suivi des sites — *Suivi-évaluation → Suivi des sites*

C'est la demande la plus dense de cette liste.

- **Afficher adm1 à adm3 dans le tableau**, sous les libellés du pays, à côté des sites
  configurés (rattachés par adm4 ou adm3). La planification se fait en voyant où l'on est.
- **Planifier par filtre** : choisir une commune ou un district et planifier l'ensemble
  de ses sites d'un geste, plutôt que ligne à ligne.
- **Infobulles sur les symboles** de la grille mensuelle. Aujourd'hui rien n'explique ce
  que veut dire chaque marque, et personne ne devine.
- **Marquer ce qui a DÉJÀ été suivi** d'après les soumissions ODK Central rattachées à la
  base — dépend du chantier 1.

## Suivi tiers — *plans mensuels*

Le circuit doit être automatique là où il est aujourd'hui manuel :

1. **Affectation automatique des sites** au prestataire dès que le plan de suivi est
   validé. Aujourd'hui elle est saisie à la main, ce qui la rend fausse dès le premier
   changement de plan.
2. Le prestataire reçoit alors un **brouillon de budget mensuel** qu'il examine et valide.
3. **Refaire la fenêtre du bas.** Au lieu de « zones / activité / équipe », elle doit
   porter : **adm1 à adm3**, le **nom du prestataire**, puis le **nombre de sites qu'il
   peut consulter**. Sous le budget, il renseigne le nombre d'agents et/ou de
   superviseurs, le nombre de jours, de trajets, de véhicules et le carburant —
   **sans saisir le total**, qui se calcule.
4. Il en sort un **budget modifiable, de la forme du classeur Excel partagé**, qu'il
   complète et soumet.

**Contrats et barèmes deviennent un sous-module du suivi budgétaire.** Ou bien : cliquer
un prestataire ouvre à droite un **panneau rétractable** portant toutes ses informations.
La seconde forme est préférable — on consulte un barème en regardant un budget, pas en
changeant d'écran.

## Cartographie — à reprendre

- **Fond de carte par l'API Google Maps**, cadré sur le pays choisi.
- Puis la **géolocalisation des sites** par-dessus.
- Les **informations pertinentes à droite**, comme dans le localisateur d'agences qui a
  servi de référence.
- **Sans perdre l'intégration du shapefile** : les contours administratifs restent
  affichés au-dessus du fond, et cliquer une unité filtre la liste.

*Note technique* : Google Maps est une bibliothèque distante et une clef d'API. La
politique de sécurité du contenu (`server/src/index.js`) devra autoriser explicitement
ses origines, et la clef sera un réglage d'installation, jamais une constante du code.
Peser le coût : l'implémentation actuelle en tuiles OSM ne dépend d'aucun contrat ni
d'aucune facturation.

## Déjà fait — ne pas reconstruire (section 9)

Deux demandes de cette liste existent déjà ; si elles n'ont pas été trouvées, c'est un
défaut de visibilité, pas de fonction :

- **Sauvegarde sélective et restauration** — *Paramètres → API*. Export JSON poste par
  poste, restauration avec examen préalable et refus des suppressions destructrices.
- **Cloche de notifications et page dédiée** — l'accueil ne porte plus la longue liste ;
  la cloche de l'en-tête ouvre la destination « À traiter ».

---

# 10. Les angles morts

Relecture de l'ensemble des échanges depuis le début. Ce qui suit n'a jamais été
demandé explicitement, ou l'a été si tôt qu'on l'a perdu de vue. Rien de tout cela n'est
un défaut visible aujourd'hui — c'est précisément pourquoi il faut l'écrire.

## 10.1 Ce qui a divergé sans qu'on le voie

**La démonstration hors ligne ne suit plus.** Il avait été demandé qu'elle reprenne
« toutes les options du site ». Depuis, l'application a gagné le filtre d'exercice, le
générateur de plan de distribution, la sauvegarde, les demandes d'accès, la mise à jour,
la liste liée de la carte, le contrôle de cohérence. La page de démonstration ignore tout
cela. Une démonstration périmée est pire qu'aucune : elle montre un produit qui n'existe
plus.

**Des documents n'ont jamais été lus.** Plusieurs liens Drive et iCloud ont été bloqués
par la politique réseau de cet environnement. Les fichiers Excel et les documents RBM
joints directement ont bien été exploités, mais **ce qui n'a pas pu être ouvert peut
contenir des exigences dont personne ne sait qu'elles manquent.** À vérifier en
rouvrant ces documents et en les confrontant à l'application.

**La validation du budget de suivi tiers était demandée À TROIS NIVEAUX.** Le circuit
actuel en compte deux : soumission puis examen. Le troisième — vraisemblablement une
validation hiérarchique après l'accord technique — n'existe pas. À reprendre avec la
section 9, qui refait déjà cet écran.

## 10.2 Ce qui n'a jamais été mesuré

**La montée en charge.** Tout a été éprouvé sur un jeu de démonstration de 309 sites et
52 unités administratives. Le référentiel réel de Madagascar en compte près de 18 000 au
niveau fokontany. Or la carte dessine un cercle SVG par site sans regroupement, `/state`
rend l'état complet en une fois, et le contrôle de cohérence parcourt tous les sites
contre tous les contours. Aucun de ces trois points n'a été chronométré à l'échelle
réelle. **Importer le référentiel complet et mesurer avant de promettre quoi que ce soit.**

**L'accessibilité.** Jamais contrôlée : navigation au clavier, contraste, rôles ARIA,
lecteurs d'écran. Une application de bureau pays finit par tomber sous une exigence
d'accessibilité, et la reprendre après coup coûte dix fois plus cher.

**Les tablettes.** Seul l'écran de connexion a été vérifié en étroit. Les grilles
mensuelles, la carte et le plan de distribution sont conçus pour un grand écran. Si les
agents de terrain saisissent sur tablette, c'est un chantier à part entière.

## 10.3 Ce qui manque pour une exploitation réelle

**Le fonctionnement en connectivité faible.** Ce n'est pas un détail à Madagascar :
l'application exige une liaison permanente avec le serveur. Un bureau de terrain qui
perd le réseau ne peut plus rien saisir. L'import Excel offre un contournement — remplir
hors ligne, téléverser ensuite — mais il n'a jamais été présenté comme la réponse à ce
problème, et il ne couvre pas la saisie des visites. **Décider si c'est acceptable, ou
en faire un chantier.**

**La sauvegarde périodique.** L'export JSON existe et la mise à jour en prend un avant
d'agir, mais rien ne sauvegarde tout seul, tous les jours. Une sauvegarde qui dépend de
quelqu'un qui y pense n'est pas une sauvegarde. Une tâche planifiée écrivant dans
`UPDATE_BACKUP_DIR`, avec rotation.

**La réinitialisation d'un mot de passe.** Il n'existe aucun chemin autonome : un
administrateur doit intervenir. C'est un choix défendable — il n'y a pas de service de
courriel — mais il faut au moins que l'administrateur puisse le faire depuis la fiche du
compte, ce qui n'a jamais été vérifié.

**La purge du journal d'audit.** La table `audit` grossit sans limite. Sur plusieurs
années, elle finira par peser plus que les données. Prévoir une rétention.

**Un guide pour l'utilisateur.** Le README s'adresse à qui installe. Personne n'a écrit
comment on conçoit un plan de suivi ou on interprète l'exigence minimale — et ces deux
gestes ne sont pas évidents.
