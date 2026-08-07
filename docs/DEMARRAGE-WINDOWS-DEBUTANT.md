# Lancer MEMS sur Windows — guide pas à pas pour débutant

Ce guide s'adresse à une personne **qui ne programme pas**. Il explique, clic par
clic et commande par commande, comment faire tourner MEMS sur un ordinateur
Windows (Windows 10 ou 11) pour le découvrir, le tester ou l'utiliser en local.

> **À qui s'adresse ce guide ?** À vous, si vous voulez juste « ouvrir MEMS dans
> votre navigateur sur votre PC ». Pour une installation sur un **vrai serveur**
> accessible par toute une équipe (avec HTTPS, service qui redémarre tout seul,
> pare-feu), voir plutôt `docs/WINDOWS.md`, destiné à un informaticien.

---

## Ce que vous allez faire, en une phrase

Installer **deux logiciels** (Node.js et PostgreSQL), **télécharger MEMS**, taper
**quelques commandes** une seule fois, puis ouvrir MEMS dans votre navigateur à
l'adresse `http://localhost:4000`.

Comptez **30 à 45 minutes** la première fois. Ensuite, relancer MEMS ne prend que
quelques secondes.

> **Bon à savoir :** il n'y a **rien à compiler**, aucun outil de développeur
> compliqué à installer. Les commandes de ce guide se copient-collent telles
> quelles.

---

## Vocabulaire minimal (à lire une fois)

| Mot | Ce que ça veut dire ici |
|---|---|
| **Node.js** | Le « moteur » qui fait tourner MEMS. |
| **PostgreSQL** | La base de données : c'est là que MEMS range vos données. |
| **PowerShell** | La fenêtre noire où l'on tape des commandes. Fournie avec Windows. |
| **Commande** | Une ligne de texte qu'on tape (ou qu'on colle) puis qu'on valide avec **Entrée**. |
| **`.env`** | Un petit fichier de réglages que vous allez créer une fois. |

**Comment coller dans PowerShell :** copiez le texte (Ctrl+C), cliquez dans la
fenêtre PowerShell, puis faites **clic droit** (ou Ctrl+V). La ligne se colle.
Appuyez sur **Entrée** pour l'exécuter.

---

## Étape 1 — Installer Node.js

1. Allez sur **https://nodejs.org**.
2. Cliquez sur le gros bouton **« LTS »** (version stable recommandée).
   Un fichier `.msi` se télécharge.
3. Ouvrez le fichier téléchargé. Cliquez **Next / Suivant** à chaque écran,
   acceptez la licence, et **laissez toutes les cases cochées** (surtout
   « Add to PATH »). Terminez par **Install** puis **Finish**.

**Vérifier que ça a marché :** ouvrez le menu Démarrer, tapez `PowerShell`,
ouvrez **Windows PowerShell**. Dans la fenêtre, tapez :

```powershell
node -v
```

Vous devez voir quelque chose comme `v20.x.x` ou `v22.x.x`. Si oui, c'est bon.

---

## Étape 2 — Installer PostgreSQL (la base de données)

1. Allez sur **https://www.postgresql.org/download/windows/** puis cliquez sur
   **« Download the installer »** (installeur fourni par EDB).
2. Choisissez la **version 16**, architecture **Windows x86-64**, et lancez le
   fichier téléchargé.
3. Cliquez **Next** partout. À un moment, l'installeur demande un **mot de passe
   pour l'utilisateur `postgres`** (le compte maître de la base).
   **➜ Choisissez un mot de passe, et NOTEZ-LE** : vous en aurez besoin dans une
   minute. (Vous ne l'utiliserez qu'une seule fois.)
4. Laissez le **port** sur `5432`. Continuez jusqu'à **Finish**. Si l'installeur
   propose « Stack Builder » à la fin, vous pouvez **décocher / annuler** : ce
   n'est pas nécessaire.

**Retenez ce chemin**, on s'en sert ci-dessous :
`C:\Program Files\PostgreSQL\16\bin`

---

## Étape 2 bis — « PostgreSQL est déjà installé chez moi depuis longtemps »

**Bonne nouvelle : inutile de réinstaller.** MEMS fonctionne avec **PostgreSQL 12
ou plus récent** (16 est la version recommandée, mais 12, 13, 14, 15 conviennent).
Vous allez seulement réutiliser l'installation existante. Trois choses à
retrouver — la **version**, le **dossier**, le **mot de passe `postgres`** — puis
vous reprendrez à l'étape 3.

### a) Retrouver la version et le dossier

Dans PowerShell, listez les versions présentes :

```powershell
dir "C:\Program Files\PostgreSQL"
```

Vous verrez un ou plusieurs dossiers nommés par leur version (`13`, `15`, `16`…).
**Notez le plus grand numéro** : c'est celui à utiliser.

- Si ce numéro est **12 ou plus** ➜ parfait, gardez cette installation.
- S'il est **inférieur à 12** (très ancien) ➜ mieux vaut installer PostgreSQL 16
  en plus (suivez l'étape 2). Les deux cohabitent ; la nouvelle prendra
  automatiquement le port `5433` — retenez ce numéro pour l'étape 7.

> Dans **toutes** les commandes de ce guide, remplacez le `16` du chemin
> `C:\Program Files\PostgreSQL\16\bin` par **votre** numéro de version.

### b) Vérifier que le service tourne, et sur quel port

```powershell
Get-Service | Where-Object { $_.Name -like "postgresql*" }
```

Le `Status` doit être **Running**. S'il est **Stopped**, démarrez-le :
`Start-Service <nom-affiché>` (ou via l'appli « Services » de Windows).

Le port est **presque toujours `5432`**. S'il y a plusieurs installations, la
seconde peut être sur `5433` — vous en tiendrez compte dans le `DATABASE_URL`
de l'étape 7 (voir l'encadré « autre port » là-bas).

### c) Le mot de passe `postgres`, vous l'avez… ou pas

- **Vous connaissez le mot de passe `postgres` :** parfait, rien à faire. Passez à
  l'étape 3, et à l'étape 5 utilisez ce mot de passe.

- **Vous l'avez oublié :** deux solutions.

  **Solution simple — passer par pgAdmin (l'outil graphique).** EDB installe
  **pgAdmin** avec PostgreSQL. Ouvrez-le depuis le menu Démarrer. S'il se
  connecte tout seul à votre serveur (il a souvent le mot de passe enregistré),
  vous pouvez créer le compte et la base **sans ligne de commande** :
  1. Dépliez à gauche : *Servers → (votre serveur)*.
  2. Clic droit sur **Login/Group Roles → Create → Login/Group Role**.
     Onglet *General* : nom `mems`. Onglet *Definition* : mettez un mot de passe
     (notez-le, ce sera votre `MOT_DE_PASSE_MEMS`). Onglet *Privileges* : activez
     **Can login?**. Enregistrez.
  3. Clic droit sur **Databases → Create → Database**. Nom `mems`, *Owner* =
     `mems`. Enregistrez.
  4. **L'étape 5 est alors déjà faite** : passez directement à l'étape 6.

  **Solution de repli — réinitialiser le mot de passe `postgres`** (si pgAdmin
  demande lui aussi un mot de passe que vous n'avez pas). Cela demande d'éditer un
  fichier de configuration en tant qu'administrateur ; faites-le seulement si
  nécessaire :
  1. Ouvrez le Bloc-notes **en tant qu'administrateur** (clic droit → *Exécuter
     en tant qu'administrateur*), puis ouvrez le fichier
     `C:\Program Files\PostgreSQL\16\data\pg_hba.conf`.
  2. Tout en bas, sur les lignes qui commencent par `host ... 127.0.0.1/32`,
     remplacez le dernier mot (`scram-sha-256` ou `md5`) par **`trust`**.
     Enregistrez.
  3. Redémarrez le service : `Restart-Service <nom-du-service-postgresql>`.
  4. Fixez un nouveau mot de passe (aucun mot de passe n'est demandé grâce à
     `trust`) :
     ```powershell
     & "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -c "ALTER USER postgres PASSWORD 'NOUVEAU_MDP_POSTGRES';"
     ```
  5. **Remettez** le fichier `pg_hba.conf` comme avant (`trust` → `scram-sha-256`)
     et redémarrez à nouveau le service. C'est important pour la sécurité.
  6. Vous connaissez de nouveau le mot de passe `postgres` : passez à l'étape 3.

Une fois version, dossier et mot de passe en main, **reprenez à l'étape 3**.

---

## Étape 3 — Télécharger MEMS sur votre PC

Le plus simple, sans rien installer de plus :

1. Ouvrez la page GitHub du projet MEMS dans votre navigateur.
2. Cliquez sur le bouton vert **« Code »**, puis **« Download ZIP »**.
3. Une fois le ZIP téléchargé, faites **clic droit dessus → « Extraire tout… »**.
   Extrayez-le dans un dossier simple, par exemple **`C:\mems`**.

À la fin, vous devez avoir un dossier `C:\mems` qui contient, entre autres, les
sous-dossiers **`server`** et **`web`**.

> *(Alternative pour les habitués de Git : `git clone <url-du-dépôt> C:\mems`.)*

---

## Étape 4 — Ouvrir PowerShell DANS le dossier de MEMS

1. Ouvrez l'**Explorateur de fichiers** et allez dans **`C:\mems`**.
2. Cliquez dans la **barre d'adresse** en haut (là où c'est écrit le chemin),
   effacez tout, tapez `powershell` et appuyez sur **Entrée**.

Une fenêtre PowerShell s'ouvre, déjà positionnée dans `C:\mems`. **Gardez-la
ouverte** : toutes les commandes suivantes se tapent ici.

Pour vérifier que vous êtes au bon endroit, tapez :

```powershell
dir
```

Vous devez voir apparaître `server`, `web`, `README.md`, etc.

---

## Étape 5 — Créer la base de données de MEMS

MEMS a besoin d'une base vide qui lui appartient. On la crée en deux commandes.

Dans PowerShell, tapez d'abord ceci (remplacez `LE_MOT_DE_PASSE_POSTGRES` par le
mot de passe noté à l'étape 2) :

```powershell
$env:PGPASSWORD = "LE_MOT_DE_PASSE_POSTGRES"
$psql = "C:\Program Files\PostgreSQL\16\bin\psql.exe"
```

Puis créez le compte applicatif et la base (choisissez ici **un nouveau mot de
passe** pour MEMS et notez-le aussi — appelons-le `MOT_DE_PASSE_MEMS`) :

```powershell
& $psql -U postgres -c "CREATE ROLE mems LOGIN PASSWORD 'MOT_DE_PASSE_MEMS';"
& $psql -U postgres -c "CREATE DATABASE mems OWNER mems;"
```

Si les deux commandes répondent `CREATE ROLE` puis `CREATE DATABASE`, c'est bon.

> **Ça coince ?** Si `psql.exe` n'est pas trouvé, c'est que PostgreSQL n'est pas
> en version 16, ou installé ailleurs. Ouvrez `C:\Program Files\PostgreSQL\`,
> regardez le numéro du dossier (15, 16, 17…) et remplacez `16` dans le chemin
> ci-dessus par ce que vous voyez.

---

## Étape 6 — Installer les composants de MEMS

Toujours dans PowerShell, dans `C:\mems` :

```powershell
npm run install:all
```

Cette commande télécharge tout ce dont MEMS a besoin. **Elle peut durer
plusieurs minutes** et affiche beaucoup de texte : c'est normal. Attendez qu'elle
rende la main (que le curseur revienne).

---

## Étape 7 — Créer le fichier de réglages `.env`

MEMS a besoin de deux « clés secrètes » (pour sécuriser les connexions) et de
savoir comment joindre la base. On génère les clés, puis on écrit le fichier.

**7a — Générer les deux clés.** Tapez ces deux lignes ; chacune affiche une ligne
à recopier :

```powershell
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('DATA_KEY='   + require('crypto').randomBytes(32).toString('hex'))"
```

Gardez ces deux lignes sous la main (elles ressemblent à
`JWT_SECRET=1a2b3c…`).

**7b — Créer le fichier.** On l'ouvre dans le Bloc-notes :

```powershell
notepad server\.env
```

Le Bloc-notes demande de créer le fichier : cliquez **Oui**. Collez dedans le
texte ci-dessous, **en remplaçant** :
- `MOT_DE_PASSE_MEMS` par le mot de passe MEMS choisi à l'étape 5 ;
- les deux lignes `JWT_SECRET=` et `DATA_KEY=` par celles générées en 7a.

```ini
NODE_ENV=production
PORT=4000
HOST=127.0.0.1

# La base créée à l'étape 5
DATABASE_URL=postgres://mems:MOT_DE_PASSE_MEMS@127.0.0.1:5432/mems

# Les deux clés générées à l'étape 7a (collez vos vraies valeurs)
JWT_SECRET=collez_ici_la_valeur_generee
DATA_KEY=collez_ici_la_valeur_generee

# Votre adresse d'administrateur (le mot de passe sera donné automatiquement)
BOOTSTRAP_EMAIL=admin@exemple.org
BOOTSTRAP_PASSWORD=
```

**Enregistrez** (Fichier → Enregistrer) et fermez le Bloc-notes.

> **Votre PostgreSQL est sur un autre port ?** (cas d'une seconde installation,
> souvent `5433` — voir l'étape 2 bis.) Remplacez `5432` par votre port dans la
> ligne `DATABASE_URL`, par exemple :
> `DATABASE_URL=postgres://mems:MOT_DE_PASSE_MEMS@127.0.0.1:5433/mems`

> **Important :** ne mettez **jamais** `SEED_DEMO` dans ce fichier pour un usage
> réel. Sans lui, MEMS démarre **vide et propre**, prêt à recevoir vos vraies
> données (voir étape 11).

---

## Étape 8 — Construire l'interface

```powershell
npm run build
```

Cela prépare les pages web de MEMS. Quand la commande se termine (« built in… »),
passez à la suite.

---

## Étape 9 — Créer les tables et le compte administrateur

```powershell
cd server
npm run migrate
npm run seed
```

- `npm run migrate` crée toutes les tables dans la base (à ne faire qu'une fois).
- `npm run seed` crée **votre compte administrateur**.

**➜ Regardez bien la fenêtre :** `seed` affiche **une seule fois** l'adresse et un
**mot de passe administrateur** généré au hasard. **Copiez-le et gardez-le en
lieu sûr.** Il n'est écrit nulle part ailleurs. (À la première connexion, MEMS
vous demandera d'en choisir un nouveau.)

---

## Étape 10 — Démarrer MEMS et se connecter

```powershell
npm start
```

Laissez cette fenêtre PowerShell **ouverte** : c'est elle qui fait tourner MEMS.
Tant qu'elle est ouverte, MEMS fonctionne.

Ouvrez maintenant votre navigateur (Chrome, Edge…) et allez à :

```
http://localhost:4000
```

L'écran de connexion de MEMS apparaît. Connectez-vous avec l'adresse
(`admin@exemple.org`) et le **mot de passe affiché à l'étape 9**. MEMS vous
demande d'en choisir un nouveau : c'est parti. 🎉

**Pour arrêter MEMS :** revenez dans la fenêtre PowerShell et appuyez sur
**Ctrl + C**.

---

## Étape 11 — (Optionnel) Charger les vraies données de Madagascar

MEMS démarre vide. Pour y injecter le découpage administratif, la liste des
indicateurs et les sites réels fournis avec le projet :

1. **Arrêtez MEMS** s'il tourne (Ctrl + C dans la fenêtre PowerShell).
2. Toujours dans le dossier `server`, lancez dans l'ordre :

```powershell
npm run seed:reel     # régions/communes/fokontany + liste des indicateurs
npm run seed:sites    # importe les sites réels et crée leurs bureaux
```

3. Relancez `npm start`, rechargez `http://localhost:4000` : vos sites, la carte
   et la planification sont maintenant remplis.

> `seed:sites` rattache automatiquement chaque site à un **bureau** (d'après sa
> colonne « antenne »). C'est ce rattachement qui fait apparaître les sites dans
> la planification, sur la carte et dans le tableau de bord.

---

## Relancer MEMS plus tard (les jours suivants)

Tout est déjà installé. Il suffit de :

1. Ouvrir l'Explorateur dans `C:\mems\server`, taper `powershell` dans la barre
   d'adresse, **Entrée**.
2. Taper :

```powershell
npm start
```

3. Ouvrir `http://localhost:4000` dans le navigateur.

C'est tout — plus besoin de refaire les étapes 1 à 9.

---

## En cas de problème

| Ce que vous voyez | Pourquoi | Quoi faire |
|---|---|---|
| `node` n'est pas reconnu | Node.js pas installé, ou PowerShell ouvert avant l'installation | Refaites l'étape 1, **fermez et rouvrez** PowerShell. |
| `DATABASE_URL est requis en production` | Le fichier `server\.env` manque ou est mal placé | Vérifiez qu'il s'appelle bien `.env` (pas `.env.txt`) et qu'il est dans le dossier `server`. |
| `JWT_SECRET est absent ou trop court` | Clé manquante ou trop courte | Regénérez-la (étape 7a) et recollez-la dans `.env`. |
| `psql.exe` introuvable (étape 5) | PostgreSQL pas en version 16, ou ailleurs | Ouvrez `C:\Program Files\PostgreSQL\` et corrigez le numéro de version dans le chemin. |
| `password authentication failed` en migrant | Le mot de passe dans `DATABASE_URL` ne correspond pas à celui du rôle `mems` | Corrigez la ligne `DATABASE_URL=` dans `.env` (étape 5, ou 2 bis si base déjà installée). |
| `could not connect` / `ECONNREFUSED 127.0.0.1:5432` | Le service PostgreSQL est arrêté, ou écoute sur un autre port | Démarrez le service (étape 2 bis-b) ; si le port est `5433`, corrigez `DATABASE_URL`. |
| `role "mems" already exists` (étape 5) | Vous aviez déjà lancé cette commande | Sans gravité : le rôle existe, continuez. Pour changer son mot de passe : `ALTER USER mems PASSWORD '…';`. |
| Mot de passe `postgres` oublié | Installation ancienne | Créez le rôle/base via **pgAdmin**, ou réinitialisez le mot de passe (étape 2 bis-c). |
| La page reste blanche / erreur 404 | L'interface n'a pas été construite | Revenez dans `C:\mems` et refaites `npm run build`. |
| « Ce site est inaccessible » dans le navigateur | MEMS n'est pas démarré | Vérifiez que la fenêtre `npm start` est bien ouverte et sans erreur. |

> **Le fichier `.env` s'est appelé `.env.txt` ?** Le Bloc-notes ajoute parfois
> `.txt`. Dans l'Explorateur, activez **Affichage → Extensions de noms de
> fichiers**, puis renommez `.env.txt` en `.env`.

---

## Pour aller plus loin

- **Utiliser MEMS au quotidien** (rôles, écrans, carte, rapports) :
  les info-bulles « Aide » dans chaque écran, et le `README.md` du projet.
- **Installer sur un vrai serveur partagé** (HTTPS, service automatique,
  sauvegardes planifiées) : `docs/WINDOWS.md`.
- **Dépanner, sauvegarder, mettre à jour** : `docs/MAINTENANCE.md`.
