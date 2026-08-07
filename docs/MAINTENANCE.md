# MEMS — Guide de maintenance, débogage et mise à jour

Ce document réunit ce qu'il faut pour **faire tourner**, **déboguer à la main** et
**mettre à jour** MEMS sans avoir à relire le code. Il complète le `README.md`
(installation) et `docs/WINDOWS.md` (déploiement Windows Server).

---

## 1. Architecture en une page

| Couche | Techno | Où | Notes |
|---|---|---|---|
| Base | PostgreSQL 16 | `server/migrations/*.sql` | Seul moteur supporté. Une migration = un fichier numéroté, appliqué une fois. |
| API | Node + Express 4 | `server/src/` | `routes/` (HTTP), `lib/` (métier), `db.js` (pool `pg` + couche async). |
| Client | React 19 + Vite 8 | `web/src/` | `views/` (écrans), `lib/` (calcul, seed, constantes). Build servi par l'API en prod. |
| Auth | JWT (cookie httpOnly) + bcrypt | `server/src/lib/auth.js` | Verrouillage de compte, révocation par `jti`. |

**Flux de données** : le client tient l'état en mémoire (`GET /api/state`), édite,
puis **resynchronise par collection** (`PUT /api/collections/:nom`). Les sites, la
grille mensuelle et le TPM ont des routes dédiées qui portent des règles métier.

---

## 2. Lancer en local

```bash
# 1. PostgreSQL (créer les bases une fois)
sudo service postgresql start
createdb mems_dev ; createdb mems_test      # ou via psql CREATE DATABASE

# 2. Variables (server/.env — voir .env.example)
export DATABASE_URL=postgres://mems:mems_dev_pw@127.0.0.1:5432/mems_dev
export JWT_SECRET=<au moins 32 caractères>
export DATA_KEY=<48 caractères hexadécimaux>

# 3. Migrer + amorcer
cd server && npm ci && npm run migrate && npm run seed
#   → affiche l'e-mail et le mot de passe admin UNE fois. Notez-le.
#   BOOTSTRAP_PASSWORD=... npm run seed  pour fixer le mot de passe.
#   SEED_DEMO=1  npm run seed  pour un jeu de démonstration complet.

# 4. Client
cd ../web && npm ci && npm run build       # prod : servi par l'API sur :4000
#   ou  npm run dev  pour le serveur de dev Vite (:5173, proxy API)

# 5. API
cd ../server && npm start                  # http://localhost:4000
```

### 2.1 Charger les données RÉELLES (pas la démo)

`npm run seed` en production ne crée **que le compte admin** — aucune donnée de
démonstration (celle-ci est réservée à `SEED_DEMO=1`). Pour partir des vraies
données de référence :

```bash
cd server
npm run seed         # compte admin seulement — AUCUNE démo
npm run seed:reel    # découpage réel (communes + contours), masterlist et activités
npm run seed:sites   # les sites réels (docs/List Sites per Tag.xlsx)
```

`seed:sites` crée aussi **les bureaux de terrain** nommés dans la colonne
« Field office » du fichier et **rattache chaque site à son bureau** (`office_id`).
C'est indispensable : la planification, la couverture et le tableau de bord
s'organisent **par bureau**, donc sans ce rattachement ils n'auraient aucun site à
montrer.

Après cette étape, il reste la **configuration opérationnelle**, saisie dans
l'application (elle ne se déduit d'aucun fichier) :
1. vérifier/compléter les **bureaux** et leur **périmètre** (Paramètres → Bureaux,
   Périmètre des bureaux) ;
2. définir les **paramètres de couverture** (fréquence et durée de suivi par
   bureau × activité) — c'est ce qui alimente les colonnes « Prévu » du plan ;
3. les **visites** et la donnée de terrain arrivent ensuite par saisie ou ODK.

> Symptôme typique : « je ne vois pas mes sites en planification / au tableau de
> bord » alors que le registre et la carte les affichent → les sites existent mais
> ne sont **rattachés à aucun bureau** (`office_id` NULL). Relancer `seed:sites`
> (idempotent) crée les bureaux et fait le rattachement.

**Vérifier que tout répond** : `curl -s localhost:4000/api/health | jq` →
`status: ok`, taille de base, nombre de connexions.

---

## 3. Déboguer à la main

### 3.1 Les logs
Le serveur journalise en JSON une ligne par requête (méthode, chemin, statut,
durée) — sans corps ni secret. Pour tout voir, montez le niveau :

```bash
LOG_LEVEL=debug npm start        # debug | info (défaut) | warn | error
```

`GET /api/health` est volontairement exclu des logs pour ne pas les noyer.

### 3.2 Inspecter la base directement
```bash
psql "$DATABASE_URL"
\dt                          # tables
\d indicators               # colonnes d'une table
SELECT level, count(*) FROM indicators GROUP BY level;   # ex. sanity check
SELECT * FROM audit ORDER BY at DESC LIMIT 20;           # journal d'actions
```
Le **journal d'audit** (`audit`) trace connexions, synchronisations et
validations avec un libellé lisible : c'est le premier endroit où regarder
« qui a fait quoi, quand ».

### 3.3 Reproduire un appel d'API
```bash
# se connecter (récupère le cookie httpOnly + le token)
curl -s -c /tmp/j -X POST localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@mems.local","password":"..."}' | jq
# appeler une route protégée avec le cookie
curl -s -b /tmp/j localhost:4000/api/state | jq '.indicators | length'
```

### 3.4 Symptômes fréquents → cause
| Symptôme | Cause probable | Où regarder |
|---|---|---|
| `500 erreur interne` sur un `PUT /api/collections/*` | une colonne `NOT NULL` reçoit `null` (champ absent transformé en `null` par le schéma) | `routes/collections.js` — n'écrire un champ que s'il est `!= null` |
| Un indicateur n'apparaît pas dans la masterlist | son `level` de cadre de résultats est vide (l'écran filtre par niveau) | `SELECT code, level FROM indicators` |
| `401 jeton invalide` juste après connexion | horloge/`JWT_SECRET` différent entre process, ou token expiré | `config.jwtSecret`, `tokenTtl` |
| `423 compte verrouillé` | trop d'échecs de connexion | `SELECT email, failed_logins, locked_until FROM users` — remettre à 0 pour débloquer |
| Carte sans fond | hôtes de tuiles bloqués par la CSP/réseau | `TILE_HOSTS`, `imgSrc` de la CSP dans `index.js` |
| `409` à la synchronisation | verrouillage optimiste : la ligne a changé entre lecture et écriture | recharger l'état ; c'est le comportement voulu |

### 3.4bis Le fond de carte (base map)

La carte dessine **toujours** les contours administratifs réels (régions →
districts → communes) à partir du shapefile importé par `seed:reel` : même sans
aucune tuile, on voit le pays, ses limites et les points des sites. Le **fond de
carte** (le raster rues/relief) est une couche en plus, et il y a **trois façons**
de l'obtenir, selon le réseau :

1. **Internet disponible** — rien à faire : les fonds publics (Carto par défaut,
   OpenStreetMap, OSM France) se chargent automatiquement. Leurs hôtes sont déjà
   autorisés par la CSP (`config.tileHosts`).

2. **Instance hors-ligne / derrière un pare-feu — fond servi par MEMS lui-même**
   *(recommandé sur le terrain)*. Déposez une pyramide de tuiles raster dans
   `server/tiles/` (arborescence `z/x/y.png`), redémarrez l'API, puis dans
   **Paramètres → Localités → « Serveur de tuiles interne »** mettez
   `‎/tiles/{z}/{x}/{y}.png`. Ces tuiles sont servies en **même origine** que
   l'application : elles passent la CSP sans aucun réglage réseau. Le dossier peut
   être ailleurs via la variable `TILES_DIR`. *(Comment obtenir les tuiles : un
   export d'une région OSM, ou l'extraction d'un fichier `.mbtiles` avec
   `mb-util`. `server/tiles/` n'est jamais versionné.)*

3. **Serveur de tuiles interne séparé** — même champ « Serveur de tuiles interne »,
   pointé vers l'URL de votre serveur (`https://tuiles.interne/{z}/{x}/{y}.png`) ;
   pensez alors à ajouter son hôte à `TILE_HOSTS` pour la CSP.

Si aucun fond ne convient, choisissez **« Aucun fond »** dans la carte : contours
et points restent parfaitement lisibles.

### 3.5 Débloquer un compte à la main
```sql
UPDATE users SET failed_logins=0, locked_until=NULL WHERE email='...';
-- forcer un changement de mot de passe au prochain login
UPDATE users SET must_change_pw=1 WHERE email='...';
```

---

## 4. Le modèle des rôles (test « chaque type d'utilisateur »)

Les capacités sont définies **au même endroit** côté serveur (`lib/auth.js`,
matrice `ROLE_CAPS`) et côté client (`constants.js`, `D_ROLES`). Un écran ne
protège rien : le serveur tranche.

| Rôle | edit | del | validate | admin | Destinations |
|---|:--:|:--:|:--:|:--:|---|
| `super` | ✔ | ✔ | ✔ | ✔ | tout + Administration |
| `admin` | ✔ | ✔ | ✔ | ✔ | tout sauf routeur super |
| `validator` | ✔ | — | ✔ | — | suivi, programme, rapports… |
| `editor` | ✔ | — | — | — | saisie et planification |
| `viewer` | — | — | — | — | lecture seule |
| `dashboard` | — | — | — | — | écran de supervision, **plage horaire** |

Pour **tester un rôle** sans cliquer partout : créez un compte du rôle voulu
(Paramètres → Utilisateurs, ou `INSERT` direct), puis vérifiez au niveau API
qu'une action interdite renvoie bien `403`/`423` — c'est ce que couvrent les
tests `server/test/api.test.js` (chercher « concurrence », « cloisonnement »,
« droit »).

---

## 5. Mettre à jour

### 5.1 Ajouter une migration de schéma
1. Créer `server/migrations/0NN_ma_migration.sql` (numéro **strictement croissant**).
2. Écrire du SQL Postgres **idempotent quand c'est possible** (`ADD COLUMN … DEFAULT`).
3. `npm run migrate` — la migration s'applique une seule fois (suivi interne).
4. Si la colonne alimente le client : l'ajouter à `routes/state.js` (lecture),
   `routes/collections.js` (schéma + `map`), et à la projection `SHAPERS` de
   `web/src/App.jsx` si elle doit repartir vers le serveur.

> ⚠️ Un champ optionnel décrit par le schéma serveur `S(n)` devient **`null`**
> quand il est absent (pas `undefined`). Pour une colonne `NOT NULL`, ne
> l'écrire que `!= null`, sinon `PUT` renvoie 500.

### 5.2 Mettre à jour les dépendances
```bash
cd server && npm outdated && npm update      # puis npm test
cd ../web  && npm outdated && npm update && npm run build && npm test
```
Points de vigilance connus : `recharts` (v3 = API graphiques), `vite`/`react`
(majeures), et l'`override` `uuid` du client. Toujours relancer les deux suites.

### 5.3 Vérification avant livraison
```bash
cd server && npm test     # attendu : 0 fail (quelques skip)
cd ../web  && npm test     # attendu : 47/47
cd ../web  && npm run build
```
Un échec est un **signal réel** : pas de `--force`, pas de `skip`. Voir §3.4.

---

## 6. Sauvegarde & restauration

```bash
pg_dump "$DATABASE_URL" > mems_$(date +%F).sql     # sauvegarde
psql "$DATABASE_URL" < mems_2026-08-06.sql          # restauration
```
`DATA_KEY` chiffre certaines données sensibles : **sauvegardez-la séparément**,
sans elle une restauration ne peut pas les déchiffrer.
