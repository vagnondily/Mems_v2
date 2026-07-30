# MEMS — Monitoring & Evaluation Management System

Application de suivi-évaluation pour un bureau pays humanitaire : planification des visites
fondée sur le risque, suivi de processus, produits, résultats, plan de distribution,
analyse des données ODK Central, cartographie et restitution.

- **Frontend** : React 18 + Vite, sans framework de composants imposé
- **Backend** : Node 20 + Express + SQLite (WAL), schéma relationnel avec clés étrangères
- **Tests** : 44 tests d'API + 10 tests de bout en bout pilotant l'interface réelle

---

## 1. Démarrage rapide

### En local, sans conteneur

```bash
git clone <votre-dépôt> mems && cd mems
cp .env.example .env

# Générer les deux secrets obligatoires
echo "JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATA_KEY=$(openssl rand -hex 32)"  >> .env

npm run install:all
npm run seed          # crée le schéma, les données d'exemple et le compte administrateur
npm run dev:server    # http://localhost:4000
npm run dev:web       # http://localhost:5173  (dans un second terminal)
```

À la fin de `npm run seed`, la console affiche **une seule fois** l'adresse et le mot de passe
de l'administrateur initial. Notez-le : il n'est stocké nulle part en clair et n'apparaît
jamais dans l'application. À la première connexion, l'application impose son remplacement.

### Avec Docker

```bash
cp .env.example .env      # renseignez JWT_SECRET, DATA_KEY et CORS_ORIGINS
docker compose build
docker compose run --rm mems node src/seed.js    # affiche le mot de passe initial
docker compose up -d
```

Le conteneur écoute sur `127.0.0.1:4000`. Publiez-le derrière un reverse proxy TLS
(voir §7) : l'application ne termine pas elle-même le chiffrement.

---

## 2. Arborescence

```
mems/
├─ server/                     API et base de données
│  ├─ migrations/001_init.sql  schéma relationnel complet
│  ├─ migrations/002_geo_unit.sql  référentiel administratif versionné
│  ├─ migrations/003_sites_geo.sql rattachement des sites et du PDD au référentiel
│  ├─ migrations/004_caseload.sql  population, ménages et personnes ciblées
│  ├─ migrations/005_import.sql    lots d'import : analyse, diff, confirmation
│  ├─ migrations/006_revisions.sql révisions de ligne pour l'écriture concurrente
│  ├─ src/
│  │  ├─ index.js              montage Express, sécurité, service du frontend compilé
│  │  ├─ config.js             lecture et contrôle des variables d'environnement
│  │  ├─ db.js                 connexion SQLite, migrations, contrôle d'intégrité
│  │  ├─ migrate.js / seed.js  scripts d'exploitation
│  │  ├─ lib/auth.js           bcrypt, JWT, sessions, contrôle des droits
│  │  ├─ lib/validate.js       schémas Zod de toutes les entrées
│  │  ├─ lib/crypto.js         chiffrement au repos, génération d'identifiants
│  │  ├─ lib/geo.js            construction de l'arbre administratif, millésimes
│  │  ├─ lib/import.js         modèles Excel, réconciliation par clé, diff
│  │  ├─ import-geo.js         chargement du référentiel complet en ligne de commande
│  │  ├─ link-geo.js           rapprochement des données existantes vers le référentiel
│  │  ├─ lib/logger.js         journal avec masquage des secrets
│  │  └─ routes/               auth, state, sites, geo, users, analytics, collections
│  └─ test/api.test.js         44 tests d'intégration
└─ web/                        interface
   ├─ src/
   │  ├─ App.jsx               racine : session, file d'écriture, routage des onglets
   │  ├─ lib/api.js            client HTTP et file de synchronisation
   │  ├─ lib/constants.js      référentiels et jeu de couleurs
   │  ├─ lib/calc.js           calculs métier (score, couverture, apurement)
   │  ├─ lib/shapefile.js      lecture de shapefile dans le navigateur
   │  ├─ components/           bibliothèque d'interface, frontière d'erreur
   │  └─ views/                Login, Shell, Home, Planning, ActualData,
   │                           MapView, Analytics, Reports, Settings
   └─ test/e2e.test.js         10 tests pilotant l'interface contre un vrai serveur
```

---

## 3. Modèle de données

Trente tables. Les clés étrangères sont **déclarées et contrôlées**
(`PRAGMA foreign_keys = ON`), avec `ON DELETE CASCADE` là où la dépendance est
existentielle et `ON DELETE SET NULL` là où elle est seulement descriptive.

### Relations principales

```
offices ──┬─< sites ──┬─< site_months        (PK composite site_id, year, month)
          │           ├─< visits             (cascade : supprimer un site supprime ses visites)
          │           └── geo                (référence héritée, remplacée par geo_unit)
          ├─< coverage_params                (unique : office_id + activity_tag)
          ├─< users                          (rattachement d'un compte à un bureau)
          └─< pdd

activity_categories ──< sites
                     └─< coverage_params

partners ──< sites
         └─< pdd

indicators ──┬─< outcomes                    (cascade)
             └─< outcome_plan                (PK composite indicator_id, year, month)

population ──< population_values             (table héritée, remplacée par caseload)

caseload                                     (geo_pcode + année + mois + activité)

odk_forms ──< datasets ──< scripts

geo_version ──< geo_unit                     (arbre : parent_pcode, un seul millésime courant)

users ──< sessions                           (cascade : supprimer un compte ferme ses sessions)
      └─< audit                              (SET NULL : la trace survit au compte)
```

### Points de conception à connaître

| Choix | Raison |
|---|---|
| `site_months` en table à part, PK `(site_id, year, month)` | la grille de planification devient requêtable et agrégeable en SQL, au lieu d'être un tableau JSON opaque |
| `coverage_params` unique sur `(office_id, activity_tag)` | empêche deux paramètres contradictoires pour le même couple, cause classique de calculs incohérents |
| `visits` en cascade depuis `sites` | supprimer un site ne laisse pas de visites orphelines |
| `audit.user_id` en `SET NULL` | la trace d'une action survit à la suppression du compte qui l'a faite |
| `odk_forms.token_enc` | le jeton d'accès à la source externe est chiffré en AES-256-GCM, jamais renvoyé par l'API |
| `CHECK` sur `security IN (0,1,3,99)`, `risk_level BETWEEN 1 AND 3`, etc. | la codification métier est garantie par la base, pas seulement par l'interface |
| `geo_unit` en arbre versionné plutôt que table plate | une commune est une ligne : on peut enfin y attacher population, ciblage et distributions |

### Le référentiel géographique

Le découpage administratif est un **arbre versionné**, pas une liste plate :

```
geo_version ──< geo_unit ──┐
                    ↑      │  parent_pcode : chaque unité pointe vers son parent
                    └──────┘  adm0 → adm1 → adm2 → adm3 → adm4
```

Pour Madagascar : 23 régions, 119 districts, ~1 695 communes, ~18 000 fokontany —
soit environ **19 800 unités**, chargées en une seconde et demie.

| Colonne | À quoi elle sert |
|---|---|
| `pcode` | code officiel du jeu source ; dérivé du chemin de façon **déterministe** s'il est absent, pour qu'il reste stable d'un import à l'autre |
| `name_norm` | nom sans accents ni ponctuation : c'est la clé qui rapproche un fichier saisi à la main du référentiel |
| `path` | chemin matérialisé des p-codes — « tout ce qui est sous la région Androy » tient en un seul `LIKE` |
| `geo_version.is_current` | index unique partiel : **un seul millésime courant**, garanti par la base |

Deux partenaires n'ont pas la même liste de fokontany, et le découpage évolue. Le
versionnement permet de changer de millésime sans rien perdre : les précédents restent
consultables, et l'on peut revenir en arrière.

#### Charger le référentiel officiel

La source de référence est le **COD-AB** (Common Operational Datasets — Administrative
Boundaries) publié par OCHA sur HDX, qui descend jusqu'au niveau 4 (fokontany) avec les
p-codes officiels. L'INSTAT (RGPH-3, 2018) fait foi pour la population.

```bash
cd server
node src/import-geo.js mdg_adm4.csv --label "COD-AB v2023.1" --source "HDX / OCHA"

# Vérifier avant d'écrire
node src/import-geo.js mdg_adm4.csv --dry
```

Les en-têtes usuels (`ADM1_FR`, `ADM2_PCODE`, `Y`, `X`…) sont reconnus automatiquement.
Sinon, désignez-les explicitement :

```bash
node src/import-geo.js liste.csv --label "INSTAT 2018" \
  --map "REGION=adm1,DISTRICT=adm2,COMMUNE=adm3,FOKONTANY=adm4"
```

Le fichier est lu ligne à ligne, jamais chargé d'un bloc. Les niveaux supérieurs sont
**déduits et dédoublonnés** : une commune répétée sur quarante lignes de fokontany ne
produit qu'une seule unité. Les lignes à trou (« région, puis rien, puis commune ») sont
écartées et listées plutôt que rattachées au mauvais parent.

L'interface propose aussi l'import d'un shapefile (Paramètres → Localités), lu dans le
navigateur. Pour 18 000 fokontany, préférez la ligne de commande.

#### Rattacher les données existantes

Sites et plan de distribution portent leurs niveaux administratifs en texte. Une commande
les rapproche du référentiel en descendant l'arbre : chaque niveau est cherché parmi les
seuls enfants du niveau retenu au-dessus, ce qui lève l'ambiguïté des homonymes.

```bash
node src/link-geo.js            # analyse et rapport, sans écrire
node src/link-geo.js --write    # applique
node src/link-geo.js --write --min adm3   # n'accepte que les rapprochements jusqu'à la commune
```

Les lignes non rapprochées et les cas ambigus sont listés plutôt que rattachés au hasard.
Rien n'est écrasé : ce qui est déjà rattaché n'est pas touché, sauf avec `--relink`.

Un site est un **point d'intérêt** — école, formation sanitaire, marché, point de
distribution — situé dans un fokontany, pas un fokontany lui-même : plusieurs dizaines de
sites partagent la même commune. Quand un site porte un `geo_pcode`, ses libellés `adm1`
à `adm4` en sont **dérivés côté serveur** et ne peuvent plus diverger du référentiel. Ses
coordonnées propres priment : une école n'est pas au centroïde de son fokontany.

### Population, ciblage et distribution

`population` était annuelle, clée sur un texte libre sans lien avec le découpage, et
n'avait aucun champ « ciblés » : ni le taux de ciblage ni le croisement avec le plan de
distribution n'étaient calculables. `caseload` porte les deux dimensions qui manquaient —
l'unité administrative (par p-code) et la période.

**Le ciblage diffère selon l'activité, et les additionner donne un total faux** : une
personne ciblée par les cantines scolaires et par la nutrition serait comptée deux fois.
D'où deux natures de lignes :

| `activity_tag` | Ce que porte la ligne |
|---|---|
| `URT`, `NTA`, `SMP`… | ciblage propre à une activité |
| `''` (chaîne vide) | total de l'unité, **dédoublonné** |

La chaîne vide plutôt que `NULL` : en SQLite deux `NULL` sont distincts, une contrainte
d'unicité portant sur `NULL` ne contraindrait donc rien. Deux index partiels distinguent
la valeur annuelle (`month IS NULL`) de la valeur mensuelle.

Trois taux en découlent, tous visibles dans *Actual Data → Outputs et population* :

| Taux | Formule |
|---|---|
| **Ciblage** | personnes ciblées ÷ population |
| **Couverture du ciblage** | bénéficiaires planifiés ÷ personnes ciblées |
| **Réalisation** | bénéficiaires servis ÷ bénéficiaires planifiés |

La saisie se fait à la commune ; une vue par district ou par région **agrège vers le
haut**. Si le caseload est renseigné à plusieurs niveaux sous la même unité, seul le plus
fin est retenu — sinon on compterait deux fois.

`PUT /api/caseload` écrit **ligne à ligne**, jamais par remplacement de collection : deux
bureaux qui saisissent le même mois touchent des unités disjointes et ne s'effacent pas
mutuellement. Les lignes absentes du corps ne sont pas supprimées. Les incohérences —
p-code inconnu, plus de ciblés que d'habitants — sont rejetées **avec leur motif**, sans
annuler le reste.

#### Voir les trous de couverture

Planning → Couverture et MMR → *Couverture géographique* croise le référentiel et le
registre des sites, à n'importe quel niveau. Une unité à zéro est une zone où le programme
n'a aucune présence enregistrée — la question que le modèle plat ne savait pas poser.

> **Le référentiel ne transite plus par `/state`.** Il pesait plus que tout le reste réuni
> et se retrouvait tronqué à 4 000 lignes. L'interface interroge `/api/geo/levels` niveau
> par niveau, au fur et à mesure de ce qu'elle affiche.

### Saisir par fichier Excel

Le besoin est simple à énoncer — « remplir dans Excel, puis téléverser » — et
catastrophique s'il est traité naïvement. Un import qui remplace une collection
entière fait perdre le travail du bureau qui a téléversé avant. Le dispositif
tient donc en un principe et trois temps.

**Le principe : réconcilier par clé métier**, jamais par position dans le fichier,
jamais par remplacement. Une ligne absente du fichier n'est pas supprimée.

| Type | Clé de réconciliation |
|---|---|
| Population et ciblage | p-code + année + mois + activité |
| Plan de distribution | p-code + année + mois + type + modalité |

Conséquence directe : deux bureaux qui téléversent le même mois touchent des clés
disjointes et **ne s'effacent pas mutuellement**.

**① Le modèle** — `GET /api/import/:kind/template`

Il arrive **déjà rempli des lignes du périmètre de l'utilisateur**, avec les valeurs
actuelles. La colonne de p-code est verrouillée et grisée, les énumérations ont des
listes déroulantes Excel, et une feuille masquée (`_mems`) porte le type et le
millésime du référentiel. L'utilisateur complète des cases ; il ne saisit jamais de clé.

**② Le téléversement** — `POST /api/import/:kind`

Le serveur analyse et renvoie un diff. **Rien n'est écrit.** Les lignes fautives sont
rejetées une par une, avec leur numéro et leur motif :

```
ligne  47 · P-code            · absent du référentiel courant
ligne  88 · Personnes ciblées · 12 400 ciblés pour 9 800 habitants
ligne  91 · P-code            · hors du périmètre de votre bureau
ligne 104 · P-code            · ligne en doublon dans le fichier
```

Un rejet partiel n'annule pas le reste. Les lignes pré-remplies que l'utilisateur n'a
pas renseignées sont comptées à part et **ignorées** : elles ne créent pas
d'enregistrements à zéro.

Deux refus en bloc, en revanche, parce qu'ils rattacheraient des chiffres aux mauvaises
unités : un modèle d'un **autre type**, et un modèle produit avec un **autre millésime**
du référentiel.

**③ La confirmation** — `POST /api/import/batches/:id/commit`

Une transaction. Rejouer le même lot est refusé ; réimporter le même fichier ne change
rien — l'opération est idempotente. Un verrou consultatif sérialise deux confirmations
du même type et du même périmètre.

Le lot survit à un rechargement de page et reste consultable : qui a téléversé quoi,
quand, avec quel résultat. Le fichier lui-même n'est jamais écrit sur le disque du
serveur — seul le résultat de l'analyse est conservé.

> L'analyse se fait **côté serveur**, avec `exceljs` en lecture de flux. Le navigateur
> ne parse rien : la validation n'est pas contournable, et 18 000 lignes ne bloquent pas
> l'onglet de l'utilisateur.

### Vérifier l'intégrité à tout moment

```bash
curl -s http://localhost:4000/api/health | jq
# → { "status":"ok", "database": { "foreignKeyViolations":0, "integrity":"ok" } }
```

---

## 4. API

Toutes les routes sont sous `/api`. Sauf `/api/health` et `/api/auth/login`,
elles exigent un jeton — en-tête `Authorization: Bearer …` ou cookie `httpOnly`.

| Méthode | Route | Droit | Rôle |
|---|---|---|---|
| GET | `/health` | — | état du service et intégrité de la base |
| POST | `/auth/login` | — | connexion, 10 tentatives par quart d'heure |
| POST | `/auth/logout` | connecté | révoque la session en cours |
| GET | `/auth/me` | connecté | reprise de session |
| POST | `/auth/password` | connecté | change le mot de passe et ferme les autres sessions |
| GET | `/state` | connecté | vue agrégée consommée au démarrage de l'interface |
| GET/POST/PUT/DELETE | `/sites`, `/sites/:id` | lecture / `edit` / `del` | registre des sites |
| PUT | `/sites/:id/months` | `edit` | fiche mensuelle ; crée la visite et met à jour la dernière visite |
| POST | `/sites/bulk` | `edit` | modification groupée, champs sur liste blanche |
| GET | `/geo` | connecté | répertoire paginé, filtré par unité parente ou par recherche |
| GET | `/geo/levels` | connecté | enfants d'une unité — la cascade se fait un niveau à la fois |
| GET | `/geo/coverage` | connecté | unités couvertes et non couvertes, à tout niveau |
| GET | `/caseload` | connecté | population, ciblage et distribution par unité et par période |
| GET | `/caseload/tags` | connecté | activités pour lesquelles un ciblage est renseigné |
| PUT | `/caseload` | `edit` | écriture ligne à ligne, sans suppression implicite |
| GET | `/import/kinds` | connecté | types importables et colonnes attendues |
| GET | `/import/:kind/template` | `edit` | modèle Excel pré-rempli du périmètre |
| POST | `/import/:kind` | `edit` | analyse et diff — **n'écrit rien** |
| GET | `/import/batches`, `/import/batches/:id` | connecté | lots, propres à leur auteur |
| POST | `/import/batches/:id/commit` | `edit` | applique le lot en une transaction |
| POST | `/import/batches/:id/cancel` | `edit` | abandonne le lot |
| GET | `/geo/versions` | connecté | millésimes du référentiel |
| PUT | `/geo/versions/:id/current` | `admin` | change le millésime courant |
| POST | `/geo/bulk` | `admin` | import : le serveur reconstruit l'arbre en une transaction |
| GET/POST/PUT/DELETE | `/users` | `admin` | gestion des comptes |
| GET | `/analytics/map` | connecté | points cartographiques filtrés |
| GET | `/analytics/coverage` | connecté | couverture mensuelle agrégée en SQL |
| GET | `/analytics/summary` | connecté | indicateurs de tête |
| PUT | `/collections/:name` | variable | écriture d'une collection : suppressions explicites, révisions vérifiées |
| PUT | `/settings` | `admin` | réglages |
| PUT | `/visits/:id/status` | `validate` | validation d'une soumission |
| GET | `/audit` | `admin` | journal |

### Écriture concurrente

`PUT /collections/:name` recevait la collection entière et **supprimait tout ce qui
n'était pas dans le corps**. Deux pertes de données silencieuses en découlaient.

**① La ligne effacée sans que personne ne la supprime.** Le bureau A charge dix
indicateurs. Le bureau B en ajoute un onzième. A enregistre — et le onzième disparaît.
A n'avait jamais reçu cette ligne : il n'avait aucune raison de la supprimer.

→ **Les suppressions sont désormais explicites.** Le client envoie `deletes: [ids]` :
ce qu'il a retiré, et rien d'autre. Une ligne absente du corps est laissée intacte.
Corollaire utile : un corps **partiel** devient légitime — on peut n'envoyer qu'une ligne.

**② La modification écrasée en silence.** A et B modifient la même ligne. Le second
écrivait par-dessus le premier, sans aucun signal.

→ **Chaque ligne porte une révision.** `/state` la renvoie, le client la rend, et le
serveur refuse d'écrire par-dessus une révision plus récente :

```json
409  {
  "error": "cette collection a été modifiée par Tiana pendant votre saisie.
            Rechargez pour repartir de la version à jour.",
  "conflits": [{ "id": "ind_01J…", "revEnvoyee": 3, "revCourante": 4 }],
  "courant":  [{ "id": "ind_01J…", "name": "Intitulé posé par Tiana", … }]
}
```

La valeur courante accompagne le refus : l'interface peut montrer ce qui a changé sans
recharger tout l'état. Les conflits sont détectés **avant d'écrire** — soit l'ensemble
passe, soit rien.

Côté client, la file d'envoi ne réessaie **pas** sur un 409 : insister écraserait le
travail de l'autre. Elle prévient et recharge.

La révision est **facultative** : un client qui ne l'envoie pas reste accepté, avec le
comportement « dernier écrivain gagne » — mais sans suppression implicite, qui était le
plus dangereux des deux défauts.

`sites` et `caseload` portent la même révision. Population, ciblage et distributions
passent en outre par des écritures ligne à ligne (§ import et § population), où la
question ne se pose plus.

### Rôles

| Rôle | Onglets | Modifier | Supprimer | Valider | Administrer |
|---|---|---|---|---|---|
| `super` | tous | ✅ | ✅ | ✅ | ✅ |
| `admin` | tous | ✅ | ✅ | ✅ | ✅ |
| `validator` | hors paramètres | ✅ | ❌ | ✅ | ❌ |
| `editor` | hors paramètres | ✅ | ❌ | ❌ | ❌ |
| `viewer` | consultation | ❌ | ❌ | ❌ | ❌ |

Un compte rattaché à un bureau (`office_id`) ne voit et ne modifie **que** les sites de ce
bureau, sauf s'il est administrateur. Le filtrage est appliqué en SQL, pas dans l'interface.

---

## 5. Sécurité

Ce qui est en place :

- **Mots de passe** : bcrypt à 12 tours, jamais renvoyés par l'API, jamais journalisés.
  Politique minimale : 12 caractères, majuscule, minuscule, chiffre.
- **Sessions** : JWT signé, associé à une ligne `sessions` révocable. Déconnexion,
  changement de mot de passe et modification d'un compte ferment les sessions concernées.
- **Cookie** : `httpOnly`, `SameSite=Lax`, `Secure` en production.
- **Force brute** : 10 tentatives par quart d'heure et par adresse ; verrouillage du compte
  après 8 échecs. Le message d'erreur est identique que le compte existe ou non.
- **Injection SQL** : requêtes préparées partout, aucune concaténation de chaîne.
- **Validation** : chaque corps de requête passe par un schéma Zod avant d'atteindre la base.
- **En-têtes** : Helmet avec politique de sécurité du contenu restrictive.
- **CORS** : liste blanche explicite, jamais `*`.
- **Secrets au repos** : les jetons des sources externes sont chiffrés en AES-256-GCM
  avec `DATA_KEY`. L'API ne renvoie qu'un booléen `hasToken`.
- **Journal** : les champs `password`, `token`, `secret`, `pw_hash` sont masqués.
- **Audit** : connexions, échecs, créations, suppressions et modifications groupées sont tracés.
- **Erreurs** : aucune trace d'exécution ne remonte au client en production.

### Ce qui reste à votre charge

1. **TLS** — l'application ne chiffre pas le transport. Mettez-la derrière nginx, Caddy ou Traefik.
2. **Sauvegardes** — voir §8. Une base SQLite non sauvegardée est une base perdue.
3. **Rotation des secrets** — changer `JWT_SECRET` invalide toutes les sessions, ce qui est
   l'effet recherché en cas de compromission. Changer `DATA_KEY` rend illisibles les jetons
   déjà chiffrés : ressaisissez-les.
4. **Mises à jour** — `npm audit` est lancé par l'intégration continue, sans bloquer.

### Aucune ressource externe au chargement

Les feuilles de style sont **compilées dans le bundle**. C'était un vrai défaut :
`index.html` chargeait Tailwind depuis `cdn.tailwindcss.com`, alors que la politique
de sécurité du serveur interdit les scripts externes (`script-src 'self'`). Servie par
le serveur Node — c'est-à-dire en production, comme le décrit le §7 — l'application
s'affichait **sans aucune mise en forme**. Un bureau de terrain à la connexion
intermittente n'aurait rien vu non plus.

Pour vérifier qu'aucune ressource externe n'est requise :

```bash
grep -o 'https://[^"]*' web/dist/index.html    # ne doit renvoyer que des polices, facultatives
```

### Vérification rapide avant mise en ligne

```bash
grep -rn "password\|secret\|token" web/dist/assets/*.js | grep -vi "type=.password" | head
# ne doit rien renvoyer de compromettant

curl -sI http://localhost:4000/api/health | grep -i "content-security-policy\|x-frame"
```

---

## 6. Où se trouve quoi — guide de débogage

| Symptôme | Où regarder |
|---|---|
| « Le serveur ne répond pas » à l'écran | le serveur est arrêté, ou `CORS_ORIGINS` ne contient pas l'adresse du site |
| Connexion refusée alors que le mot de passe est bon | compte verrouillé (`locked_until`) ou désactivé — `SELECT email, active, locked_until FROM users;` |
| « Échec d'enregistrement » dans l'en-tête | ouvrez la console : la file de synchronisation affiche la collection et le message du serveur |
| Une section affiche « Cette section n'a pas pu s'afficher » | la frontière d'erreur a intercepté une exception ; le message exact est dans la console |
| Un calcul semble faux | tous les calculs métier sont dans `web/src/lib/calc.js`, avec les formules en commentaire |
| Les libellés ODK n'apparaissent pas | le XLSForm n'est pas joint — Paramètres → ODK Central |
| Les points n'apparaissent pas sur la carte | les sites n'ont pas de latitude ni de longitude ; l'API renvoie `count: 0` |
| Import de localités refusé | coordonnées hors WGS 84, droit `admin` manquant, ou collision de p-code — le message indique les deux chemins en conflit |
| Les listes de régions ou communes sont vides | aucun millésime courant : `SELECT label, units FROM geo_version WHERE is_current=1;` |

Journaux du serveur : `LOG_LEVEL=debug` fait apparaître méthode, chemin, code et durée de
chaque requête. Les corps ne sont jamais journalisés.

---

## 7. Mise en production

### Reverse proxy nginx

```nginx
server {
  listen 443 ssl http2;
  server_name mems.votre-domaine.org;

  ssl_certificate     /etc/letsencrypt/live/mems.votre-domaine.org/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mems.votre-domaine.org/privkey.pem;

  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

  client_max_body_size 30m;      # cohérent avec MAX_BODY_MB

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;       # les imports volumineux prennent du temps
  }
}
```

Avec un proxy, mettez `TRUST_PROXY=1` : sans cela, la limitation de débit voit toutes les
requêtes venir de la même adresse et pénalise tout le monde.

### Sans Docker (systemd)

```ini
[Unit]
Description=MEMS
After=network.target

[Service]
Type=simple
User=mems
WorkingDirectory=/opt/mems/server
EnvironmentFile=/opt/mems/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/mems/server/data

[Install]
WantedBy=multi-user.target
```

Le serveur sert le frontend compilé s'il trouve `web/dist` : `npm run build` puis un seul
processus suffit.

---

## 8. Exploitation

### Sauvegarde

SQLite en mode WAL ne se sauvegarde pas en copiant le fichier pendant l'écriture.

```bash
# Sauvegarde cohérente, à chaud
sqlite3 server/data/mems.db ".backup '/sauvegardes/mems-$(date +%F).db'"

# En conteneur
docker compose exec mems sh -c "sqlite3 /app/server/data/mems.db \
  \".backup '/app/server/data/backup-\$(date +%F).db'\""
```

Restauration : arrêtez le service, remplacez `mems.db`, supprimez `mems.db-wal` et
`mems.db-shm`, redémarrez.

### Mise à jour

```bash
git pull
npm run install:all
cd server && npm run migrate     # les migrations déjà appliquées sont ignorées
cd ../web && npm run build
docker compose up -d --build     # ou : systemctl restart mems
```

Les migrations sont enregistrées dans `_migrations` et rejouées une seule fois, chacune
dans sa propre transaction. Pour ajouter une évolution, créez `002_…​.sql` : ne modifiez
jamais un fichier déjà appliqué en production.

### Tests

```bash
npm test              # 44 tests d'API puis 10 tests de bout en bout
cd server && npm test # API seule
cd web && npm test    # interface seule, contre un serveur réellement démarré
```

Le test de bout en bout démarre un vrai serveur, amorce une vraie base, empaquette le code
de l'application tel qu'il est livré, le rend dans un DOM simulé et le pilote : connexion,
changement de mot de passe imposé, navigation, cartographie avec filtres et clic, écriture
avec contrôle d'intégrité, déconnexion.

---

## 9. Ce que l'application ne fait pas

Autant le dire clairement, cela évite de mauvaises surprises.

- **Les scripts R et SPSS ne s'exécutent pas.** Ils sont rédigés, versionnés et exportés
  avec leur jeu de données ; l'exécution se fait dans R ou SPSS, et les résultats se
  réimportent. En revanche, les règles d'apurement s'exécutent réellement dans le navigateur.
- **Les appels vers ODK Central partent du navigateur.** Si le serveur ODK n'autorise pas
  l'origine de la page, l'appel échoue. Le passage par un relais côté serveur est la suite
  logique, et le jeton est déjà stocké chiffré pour cela.
- **La cartographie n'utilise pas de fond de carte.** Projection équirectangulaire corrigée
  de la latitude, tracée à partir de vos seules coordonnées : aucune donnée ne sort, mais
  il n'y a ni relief ni routes.
- **SQLite convient à un bureau pays**, pas à des centaines d'écritures concurrentes par
  seconde. Le passage à PostgreSQL ne touche que `server/src/db.js` et les quelques
  particularités de syntaxe (`datetime('now')`, `PRAGMA`).
- **Pas de suppression logique.** Une suppression est définitive, tracée dans l'audit mais
  non réversible sans sauvegarde.

---

## 10. Comptes et secrets — où trouver quoi

| Élément | Où il vit | Comment le changer |
|---|---|---|
| Mot de passe administrateur initial | affiché une fois par `npm run seed` | changé de force à la première connexion |
| Mots de passe des comptes | `users.pw_hash`, bcrypt | Paramètres → Utilisateurs, ou `POST /api/auth/password` |
| `JWT_SECRET` | fichier `.env` | `openssl rand -hex 32` ; invalide toutes les sessions |
| `DATA_KEY` | fichier `.env` | `openssl rand -hex 32` ; ressaisissez ensuite les jetons ODK |
| Jetons ODK Central | `odk_forms.token_enc`, chiffrés | Paramètres → ODK Central |

Aucun de ces éléments n'apparaît dans l'interface, dans le code compilé ou dans les
journaux. Ce fichier est le seul endroit qui explique où ils se trouvent.

### Remettre à zéro un mot de passe oublié

```bash
cd server
node -e "
import('./src/lib/auth.js').then(async ({hashPassword}) => {
  const { db } = await import('./src/db.js');
  const pw = process.argv[1];
  db.prepare('UPDATE users SET pw_hash=?, must_change_pw=1, failed_logins=0, locked_until=NULL WHERE email=?')
    .run(await hashPassword(pw), process.argv[2]);
  db.prepare('UPDATE sessions SET revoked=1 WHERE user_id=(SELECT id FROM users WHERE email=?)')
    .run(process.argv[2]);
  console.log('mot de passe réinitialisé');
});" 'UnMotDePasseProvisoire1' 'admin@votre-domaine.org'
```

---

## 11. Licence et contributions

Dépôt interne. Avant toute fusion : `npm test` doit passer intégralement, et toute
évolution du schéma doit venir avec son fichier de migration numéroté.
