# Déployer MEMS sur Windows Server 2022

Ce guide installe MEMS en production sur **Windows Server 2022**, sans Docker.
Le serveur MEMS sert **à la fois l'API et l'interface web compilée** : un seul
processus Node écoute sur un port, il n'y a pas de second serveur web à gérer.

> **Bonne nouvelle : aucune dépendance native.** Depuis le passage à PostgreSQL,
> le serveur est 100 % JavaScript (`pg`). Il n'y a **rien à compiler** : pas de
> Visual Studio Build Tools, pas de `node-gyp`, pas de Python. `npm install`
> suffit.

---

## 1. Prérequis à installer

| Composant | Version | Notes |
|---|---|---|
| **Node.js** | 20 LTS ou 22 LTS (x64) | Installeur MSI depuis nodejs.org. Cochez « Add to PATH ». |
| **PostgreSQL** | 16 (x64) | Installeur EDB. Fournit `pg_dump.exe`/`pg_restore.exe`, nécessaires aux sauvegardes. |
| **Git** *(facultatif)* | récent | Pour cloner le dépôt ; sinon copiez les fichiers à la main. |

Pendant l'installation de PostgreSQL, notez le **mot de passe du super-utilisateur
`postgres`** : il sert une seule fois, pour créer le rôle et la base de MEMS.

### Mettre les outils PostgreSQL sur le PATH

Les sauvegardes appellent `pg_dump` / `pg_restore` par leur nom. Ajoutez le
dossier `bin` de PostgreSQL au **PATH système** (Panneau de configuration →
Système → Paramètres système avancés → Variables d'environnement → `Path`) :

```
C:\Program Files\PostgreSQL\16\bin
```

Vérifiez, dans une **nouvelle** fenêtre PowerShell :

```powershell
node -v          # v20.x ou v22.x
pg_dump --version   # pg_dump (PostgreSQL) 16.x
```

---

## 2. Créer le rôle et les bases PostgreSQL

Dans PowerShell (adaptez le mot de passe) :

```powershell
$env:PGPASSWORD = "<mot de passe du compte postgres>"
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"

# Rôle applicatif dédié (ne pas utiliser « postgres » pour l'application)
& $psql -U postgres -c "CREATE ROLE mems LOGIN PASSWORD 'UN_MOT_DE_PASSE_FORT';"

# Base de production, possédée par ce rôle
& $psql -U postgres -c "CREATE DATABASE mems OWNER mems;"
```

> Pour un poste de **démonstration/formation** avec le jeu de données factice,
> vous pourrez plus tard créer une base à part de la même manière — la production
> et la démonstration ne partagent jamais la même base.

---

## 3. Récupérer le code et installer les dépendances

```powershell
# À l'emplacement voulu, p. ex. C:\apps
cd C:\apps
git clone <url-du-dépôt> mems
cd mems

# Installe les dépendances du serveur ET de l'interface
npm run install:all
```

---

## 4. Configurer l'environnement (`server\.env`)

Générez les deux secrets (32 octets chacun) — **pas besoin d'OpenSSL**, Node
suffit :

```powershell
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('DATA_KEY='   + require('crypto').randomBytes(32).toString('hex'))"
```

Copiez `.env.example` en `server\.env` puis renseignez au minimum :

```ini
NODE_ENV=production
PORT=4000
HOST=0.0.0.0

# La base créée à l'étape 2 (mot de passe encodé si caractères spéciaux)
DATABASE_URL=postgres://mems:UN_MOT_DE_PASSE_FORT@127.0.0.1:5432/mems

# Les deux secrets générés ci-dessus
JWT_SECRET=...
DATA_KEY=...

# L'adresse réelle par laquelle les navigateurs joignent MEMS (jamais « * »)
CORS_ORIGINS=https://mems.votre-domaine.org

# Dossier ABSOLU pour les sauvegardes (créez-le, donnez les droits d'écriture)
BACKUP_DIR=C:\apps\mems\data\sauvegardes

# Compte administrateur initial. Laissez le mot de passe VIDE pour qu'un mot de
# passe aléatoire soit affiché une seule fois à l'amorçage (recommandé).
BOOTSTRAP_EMAIL=admin@votre-domaine.org
BOOTSTRAP_PASSWORD=

# Mettez 1 si MEMS est derrière un reverse proxy (IIS, Caddy…) — voir §8
TRUST_PROXY=1
```

> **Ne laissez JAMAIS `SEED_DEMO` en production.** En son absence, l'amorçage
> crée une base **nue** (compte administrateur seul). Voir §6.

Créez le dossier de sauvegardes :

```powershell
New-Item -ItemType Directory -Force C:\apps\mems\data\sauvegardes | Out-Null
```

---

## 5. Compiler l'interface web

```powershell
npm run build
```

Cela produit `web\dist`. Le serveur le détecte au démarrage et sert l'interface
sur le même port que l'API — **rien d'autre à configurer**.

---

## 6. Créer le schéma et le compte administrateur

```powershell
cd C:\apps\mems\server
npm run migrate    # applique toutes les migrations à la base
npm run seed       # crée le compte administrateur (base NUE, prête pour la prod)
```

La console affiche **une seule fois** l'adresse et le mot de passe de
l'administrateur initial. **Notez-le** : il n'est stocké nulle part en clair. À
la première connexion, l'application impose son remplacement.

> *(Poste de démonstration uniquement)* pour ajouter le jeu factice :
> `$env:SEED_DEMO = "1"; npm run seed; Remove-Item Env:\SEED_DEMO`

---

## 7. Démarrer et vérifier

```powershell
cd C:\apps\mems\server
npm start
```

Dans un navigateur du serveur : `http://localhost:4000` → l'écran de connexion
doit apparaître. La sonde de santé répond sur `http://localhost:4000/api/health`.

Arrêtez avec `Ctrl+C` : l'étape suivante l'installe en service permanent.

---

## 8. Exécuter MEMS comme service Windows

Pour que MEMS démarre au boot et redémarre en cas d'incident, installez-le en
service. Deux options ; **NSSM** est la plus simple.

### Option A — NSSM (recommandé)

Téléchargez [NSSM](https://nssm.cc/), placez `nssm.exe` sur le PATH, puis :

```powershell
$node = (Get-Command node).Source
nssm install MEMS $node "src\index.js"
nssm set MEMS AppDirectory "C:\apps\mems\server"
nssm set MEMS AppStdout "C:\apps\mems\data\mems.log"
nssm set MEMS AppStderr "C:\apps\mems\data\mems.log"
nssm set MEMS Start SERVICE_AUTO_START
nssm start MEMS
```

Le service lit `server\.env`, donc toute la configuration reste là. Pour appliquer
un changement de `.env` ou une mise à jour de code : `nssm restart MEMS`.

### Option B — node-windows

```powershell
cd C:\apps\mems\server
npm install --no-save node-windows
```

puis un petit script `install-service.js` qui déclare le service (voir la
documentation de node-windows). NSSM reste plus direct pour un seul service.

---

## 9. HTTPS et accès réseau

Le serveur Node écoute en HTTP. **N'exposez pas le port 4000 directement** :
placez un reverse proxy qui termine le TLS et relaie vers `127.0.0.1:4000`.

- **IIS** (déjà présent sur Windows Server) avec les modules **URL Rewrite** +
  **Application Request Routing (ARR)** : un site IIS en HTTPS (certificat lié
  dans IIS) qui *reverse-proxie* vers `http://127.0.0.1:4000`. Activez le
  transfert des en-têtes `X-Forwarded-*`.
- **Caddy pour Windows** : le plus court chemin vers un HTTPS automatique. Un
  `Caddyfile` de trois lignes suffit :
  ```
  mems.votre-domaine.org {
      reverse_proxy 127.0.0.1:4000
  }
  ```

Dans les deux cas, mettez **`TRUST_PROXY=1`** dans `.env` et renseignez
`CORS_ORIGINS` avec l'adresse HTTPS publique.

Ouvrez le **pare-feu Windows** pour 80/443 (le reverse proxy), pas pour 4000 :

```powershell
New-NetFirewallRule -DisplayName "HTTP"  -Direction Inbound -Protocol TCP -LocalPort 80  -Action Allow
New-NetFirewallRule -DisplayName "HTTPS" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
```

---

## 10. Sauvegardes

MEMS sauvegarde et restaure la base depuis **Administration → Sauvegarde**
(super-utilisateur), en s'appuyant sur `pg_dump`/`pg_restore` — d'où le PATH de
l'étape 1. Les archives vont dans `BACKUP_DIR`. Prévoyez une sauvegarde
planifiée du dossier `BACKUP_DIR` vers un stockage distinct du serveur.

Une sauvegarde manuelle en ligne de commande reste possible :

```powershell
$env:PGPASSWORD = "UN_MOT_DE_PASSE_FORT"
pg_dump -U mems -h 127.0.0.1 -Fc -f C:\apps\mems\data\sauvegardes\mems_manuel.dump mems
```

---

## 11. Mettre à jour MEMS

```powershell
cd C:\apps\mems
git pull
npm run install:all      # si des dépendances ont changé
npm run build            # recompile l'interface
cd server
npm run migrate          # applique les nouvelles migrations
nssm restart MEMS        # redémarre le service
```

Les migrations sont idempotentes : chacune n'est appliquée qu'une fois.

---

## 12. Dépannage

| Symptôme | Cause probable | Remède |
|---|---|---|
| `DATABASE_URL est requis en production` | `.env` absent ou non lu | Vérifiez `server\.env` et `NODE_ENV=production`. |
| `JWT_SECRET est absent ou trop court` | secret < 32 caractères | Régénérez avec la commande du §4. |
| `pg_dump a échoué` / sauvegarde impossible | `bin` PostgreSQL hors PATH | Ajoutez-le au PATH système (§1), redémarrez le service. |
| La page charge mais l'API renvoie « origine non autorisée » | `CORS_ORIGINS` ≠ URL réelle | Mettez l'adresse HTTPS exacte, redémarrez. |
| Connexion en boucle / cookie non posé derrière un proxy | `TRUST_PROXY` manquant | `TRUST_PROXY=1`, et transférez `X-Forwarded-Proto`. |
| L'interface ne s'affiche pas (404) | `web\dist` absent | Lancez `npm run build` à la racine. |

### À propos des scripts d'analyse (R / SPSS)

La fonction d'exécution de scripts est **désactivée par défaut** et n'a pas
besoin d'être activée pour faire tourner MEMS. Si vous l'activez sur Windows,
renseignez le chemin de l'interpréteur (`ANALYSIS_R` / `ANALYSIS_SPSS`) **et**
`ANALYSIS_PATH` avec des chemins Windows — sa valeur par défaut est de type
Unix. Sauf besoin explicite, laissez cette fonction fermée.
