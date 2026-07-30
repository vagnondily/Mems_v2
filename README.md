# MEMS — Monitoring & Evaluation Management System

Application de suivi-évaluation pour un bureau pays humanitaire : planification des visites
fondée sur le risque, suivi de processus, produits, résultats, plan de distribution,
analyse des données ODK Central, cartographie et restitution.

- **Frontend** : React 18 + Vite, sans framework de composants imposé
- **Backend** : Node 20 + Express + SQLite (WAL), schéma relationnel avec clés étrangères
- **Tests** : 25 tests d'API + 10 tests de bout en bout pilotant l'interface réelle
- **Démo hors ligne** : `web/demo.html` présente une version statique de l'interface pour les présentations

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

 codespace help
  press o + enter to open in browser
  press c + enter to clear console
  press q + enter to quit


### Avec Docker

```bash
cp .env.example .env      # renseignez JWT_SECRET, DATA_KEY et CORS_ORIGINS
docker compose build
docker compose run --rm mems node src/seed.js    # affiche le mot de passe initial
docker compose up -d
```

Le conteneur écoute sur `127.0.0.1:4000`. Publiez-le derrière un reverse proxy TLS
(voir §7) : l'application ne termine pas elle-même le chiffrement.

### Démo hors ligne

Ouvrez directement `web/demo.html` dans un navigateur pour une version de présentation qui illustre l'interface sans exiger de serveur en local.

- Navigation multi-onglets simulée
- Données factices pour les écrans principaux
- Lecture simple via le fichier HTML

---

## 2. Arborescence

```
mems/
├─ server/                     API et base de données
│  ├─ migrations/001_init.sql  schéma relationnel complet
│  ├─ src/
│  │  ├─ index.js              montage Express, sécurité, service du frontend compilé
│  │  ├─ config.js             lecture et contrôle des variables d'environnement
│  │  ├─ db.js                 connexion SQLite, migrations, contrôle d'intégrité
│  │  ├─ migrate.js / seed.js  scripts d'exploitation
│  │  ├─ lib/auth.js           bcrypt, JWT, sessions, contrôle des droits
│  │  ├─ lib/validate.js       schémas Zod de toutes les entrées
│  │  ├─ lib/crypto.js         chiffrement au repos, génération d'identifiants
│  │  ├─ lib/logger.js         journal avec masquage des secrets
│  │  └─ routes/               auth, state, sites, geo, users, analytics, collections
│  └─ test/api.test.js         25 tests d'intégration
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

Vingt-quatre tables. Les clés étrangères sont **déclarées et contrôlées**
(`PRAGMA foreign_keys = ON`), avec `ON DELETE CASCADE` là où la dépendance est
existentielle et `ON DELETE SET NULL` là où elle est seulement descriptive.

### Relations principales

```
offices ──┬─< sites ──┬─< site_months        (PK composite site_id, year, month)
          │           ├─< visits             (cascade : supprimer un site supprime ses visites)
          │           └── geo                (référence facultative vers le découpage)
          ├─< coverage_params                (unique : office_id + activity_tag)
          ├─< users                          (rattachement d'un compte à un bureau)
          └─< pdd

activity_categories ──< sites
                     └─< coverage_params

partners ──< sites
         └─< pdd

indicators ──┬─< outcomes                    (cascade)
             └─< outcome_plan                (PK composite indicator_id, year, month)

population ──< population_values             (PK composite population_id, year)

odk_forms ──< datasets ──< scripts

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
| GET | `/geo`, `/geo/levels` | connecté | répertoire administratif, listes en cascade |
| POST | `/geo/bulk` | `admin` | import transactionnel du découpage |
| GET/POST/PUT/DELETE | `/users` | `admin` | gestion des comptes |
| GET | `/analytics/map` | connecté | points cartographiques filtrés |
| GET | `/analytics/coverage` | connecté | couverture mensuelle agrégée en SQL |
| GET | `/analytics/summary` | connecté | indicateurs de tête |
| PUT | `/collections/:name` | variable | synchronisation d'une collection entière |
| PUT | `/settings` | `admin` | réglages |
| PUT | `/visits/:id/status` | `validate` | validation d'une soumission |
| GET | `/audit` | `admin` | journal |

### Le point le plus discutable, expliqué

`PUT /collections/:name` reçoit la collection **entière** : le serveur insère, met à jour
et supprime dans une seule transaction. C'est un compromis assumé. L'interface travaille
sur un objet en mémoire et pousse ce qui change ; le serveur reste l'arbitre — validation
Zod, contraintes de la base, droits, journal.

Ce que cela implique : **le dernier écrivain gagne**. À deux personnes modifiant la même
collection en même temps, la seconde écrase la première. Les sites, la grille mensuelle
et les comptes échappent à ce mécanisme et passent par des routes ligne à ligne. Si le
travail simultané sur les mêmes tables devient courant, la suite consiste à généraliser
ces routes ligne à ligne et à ajouter un jeton de version optimiste (`updated_at`).

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
| Import de localités refusé | coordonnées hors WGS 84, ou droit `admin` manquant |

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
npm test              # 25 tests d'API puis 10 tests de bout en bout
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
