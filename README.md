# MEMS — le système de suivi & évaluation

MEMS est l'outil de travail d'un bureau pays humanitaire pour **suivre ses activités sur le terrain** :
où sont les sites, qui doit les visiter et à quelle fréquence, ce qui a été distribué, ce que mesurent
les indicateurs, et comment tout cela se restitue en cartes, tableaux de bord et rapports.

Il est pensé pour des gens qui **ne sont pas informaticiens** : on configure son pays, on charge ses
sites, on planifie, on saisit le terrain, on regarde les résultats. Le reste (base de données, sécurité,
calculs) se fait tout seul.

> **Vous débutez ?** Lisez la section [1. Prise en main](#1-prise-en-main) puis
> [2. Charger vos vraies données](#2-charger-vos-vraies-données). En dix minutes vous avez une instance
> qui tourne avec la carte réelle de votre pays et vos sites.

**Sous le capot** (pour information) : interface React 19 + Vite, serveur Node + Express, base
**PostgreSQL 16**. Tout est en français, hébergeable sur vos propres serveurs, **sans dépendance à un
service externe** (aucune donnée ne sort de chez vous).

---

## Sommaire

1. [Prise en main](#1-prise-en-main)
2. [Charger vos vraies données](#2-charger-vos-vraies-données)
3. [Les grands écrans, en clair](#3-les-grands-écrans-en-clair)
4. [Comptes et rôles](#4-comptes-et-rôles)
5. [Le fond de carte](#5-le-fond-de-carte)
6. [Sécurité, en bref](#6-sécurité-en-bref)
7. [Déploiement et exploitation](#7-déploiement-et-exploitation)
8. [Documentation détaillée](#8-documentation-détaillée)
9. [Ce que MEMS ne fait pas](#9-ce-que-mems-ne-fait-pas)

---

## 1. Prise en main

### Ce qu'il vous faut d'abord

- **Node.js 22** (ou plus récent) — le moteur qui fait tourner l'application.
- **PostgreSQL 16** (ou plus récent) — là où sont stockées vos données. En local, distant, ou dans un
  conteneur, peu importe, du moment que l'application peut s'y connecter.

### Les commandes, une fois pour toutes

```bash
# 1. Récupérer le code
git clone <votre-dépôt> mems && cd mems

# 2. Deux secrets obligatoires (le serveur refuse de démarrer sans eux)
cp .env.example server/.env
echo "JWT_SECRET=$(openssl rand -hex 32)" >> server/.env   # signe les sessions
echo "DATA_KEY=$(openssl rand -hex 32)"  >> server/.env    # chiffre les données sensibles

# 3. Créer la base (une seule fois) puis renseigner DATABASE_URL dans server/.env
createuser mems --pwprompt && createdb mems --owner mems
#   → DATABASE_URL=postgres://mems:VOTRE_MOT_DE_PASSE@127.0.0.1:5432/mems

# 4. Installer, préparer la base, construire l'interface
cd server && npm ci && npm run migrate && npm run seed
cd ../web   && npm ci && npm run build

# 5. Démarrer
cd ../server && npm start        # → http://localhost:4000
```

**À la première connexion**, l'application affiche **une seule fois** l'adresse et le mot de passe du
compte administrateur créé par `npm run seed`. Notez-les : ils n'apparaissent nulle part ailleurs. Ce
mot de passe devra être changé dès la première ouverture.

> 💡 Pour fixer vous-même le mot de passe admin plutôt que d'en tirer un au hasard :
> `BOOTSTRAP_PASSWORD='…' npm run seed`.

### Vérifier que tout va bien

Ouvrez `http://localhost:4000/api/health` : vous devez voir `"status":"ok"`.

### Pour développer (rechargement à chaud)

```bash
cd server && npm run dev     # API qui redémarre à chaque modification (port 4000)
cd web    && npm run dev     # interface Vite avec rechargement (port 5173)
```

---

## 2. Charger vos vraies données

Un `npm run seed` **ne crée que le compte administrateur** — **aucune donnée de démonstration**. Une
instance fraîche est donc vide, et c'est normal. Pour partir des vraies données de référence de
Madagascar (fournies dans `docs/`) :

```bash
cd server
npm run seed         # compte admin seulement
npm run seed:reel    # le vrai découpage du pays (communes + contours), la masterlist et les activités
npm run seed:sites   # les sites réels — ET les bureaux de terrain, avec le rattachement de chaque site
```

Après ces trois commandes, la **carte** affiche votre pays et vos sites, le **registre des sites** les
liste avec leur bureau et leur activité, et la **couverture** montre les sites actifs par activité.

> ⚠️ **Point important.** Tant que les sites ne sont **rattachés à aucun bureau**, ils n'apparaissent ni
> en planification ni au tableau de bord (tout y est organisé **par bureau**). `seed:sites` s'en occupe
> automatiquement. Si un jour vos sites sont visibles sur la carte mais absents de la planification,
> c'est ce rattachement qui manque : relancez `seed:sites` (il est idempotent, aucun doublon).

**Il reste ensuite la configuration opérationnelle**, que vous saisissez dans l'application (elle ne se
devine d'aucun fichier) :

1. vérifier vos **bureaux** et leur **périmètre** (Paramètres → Bureaux) ;
2. définir les **paramètres de couverture** — à quelle fréquence suivre chaque activité, dans chaque
   bureau. C'est ce qui remplit la colonne « Prévu » des plans ;
3. les **visites** et les **données de terrain** arrivent par saisie ou par import ODK Central.

**Vos propres données** (d'autres sites, vos soumissions) se chargent par l'écran d'import Excel ou par
la connexion à ODK Central — voir [8. Documentation détaillée](#8-documentation-détaillée).

---

## 3. Les grands écrans, en clair

La barre du haut donne accès aux grandes destinations. Voici à quoi sert chacune.

| Écran | Ce qu'on y fait |
|---|---|
| **Accueil** | Le coup d'œil du matin : couverture du suivi, tendance des trois derniers mois, réalisations par activité. |
| **Tableau de bord** | Deux vues : *Suivi de processus* (la synthèse tirée des questionnaires — jauges, alertes, couverture) et *Mes visualisations* (des graphiques que vous composez vous-même, y compris des indicateurs calculés et croisés). |
| **Suivi-évaluation** | Le cœur métier : résumé global, plan de suivi des sites, plan MRE et budget, **suivi des tiers (prestataires TPM)**, couverture et registre des sites. |
| **Programme** | Le plan de distribution (PDD), la population ciblée, les indicateurs de résultat, les sources ODK et les soumissions collectées. |
| **Cartographie** | Vos sites sur la carte du pays, colorés par couverture / sécurité / activité, avec une fiche personnalisable au clic. |
| **Analyses** | Constituer des jeux de données depuis ODK, les apurer, écrire des scripts R/SPSS. |
| **Rapports** | Extraire les données ODK filtrées, et composer un rapport (indicateurs planifiés/réalisés, par catégorie). |
| **Paramètres** | Toute la configuration : identité, découpage du pays, activités, listes, **indicateurs (masterlist)**, bureaux, sources, calculs, rations, modèles de rapport, utilisateurs. |
| **Administration** *(super-utilisateur)* | Sessions, journal de sécurité, sauvegardes, état de la base. |

**Le suivi des tiers (TPM)** mérite un mot : un prestataire porte un ou plusieurs **contrats** (plafond,
barème, périmètre de communes) ; on monte des **plans mensuels** dont le **budget découle du barème** ;
un plan peut se faire *par commune* ou *en une seule équipe pour toutes les communes*, le nombre d'agents
se déduisant alors du nombre total de sites.

> **Les petites notes d'aide.** Chaque écran porte des notes bleues « à quoi sert cet écran ». Vous
> pouvez toutes les **afficher ou masquer** d'un coup depuis le **menu de votre compte** (en haut à
> droite) → *Afficher / Masquer les notes explicatives*. Les messages d'**état** (avertissements, erreurs,
> confirmations) ne se masquent jamais : ce sont des faits, pas des explications.

---

## 4. Comptes et rôles

Le **rôle** dit ce qu'un compte peut faire ; il est tranché **par le serveur** (l'écran ne protège rien).

| Rôle | Peut… |
|---|---|
| **super** | tout, y compris la console d'administration |
| **admin** | tout sauf le routeur réservé au super |
| **validator** | consulter, modifier, **valider** |
| **editor** | consulter et **modifier** (saisie, planification) |
| **viewer** | **consulter** seulement |
| **dashboard** | un écran de supervision en lecture seule (affichage mural), sur une plage horaire |

Un compte peut être **rattaché à un bureau** : il ne voit alors que les sites de son bureau, en lecture
comme en écriture. Un administrateur n'a pas de périmètre : il voit tout.

---

## 5. Le fond de carte

La carte dessine **toujours** les limites réelles du pays (régions → districts → communes → fokontany) à
partir du découpage chargé par `seed:reel` — donc même **sans aucune tuile**, vous voyez le pays et vos
sites. Le « fond de carte » (le raster rues/relief) est une couche en plus, avec **trois options** :

1. **Vous avez Internet** → rien à faire, les fonds publics (Carto, OpenStreetMap) se chargent seuls.
2. **Hors-ligne ou derrière un pare-feu** → déposez une pyramide de tuiles `z/x/y.png` dans
   `server/tiles/`, puis réglez, dans *Paramètres → Localités → Serveur de tuiles interne*, l'URL
   `/tiles/{z}/{x}/{y}.png`. MEMS sert alors le fond lui-même, **sans aucune configuration réseau**.
3. **Serveur de tuiles interne séparé** → même champ, pointé vers votre serveur.

Sinon, choisissez **« Aucun fond »** : contours et points restent parfaitement lisibles.

Détails et façons d'obtenir les tuiles : `docs/MAINTENANCE.md` (§ « Le fond de carte »).

---

## 6. Sécurité, en bref

MEMS est conçu pour être **hébergé chez vous**, sans fuite vers l'extérieur : au chargement, l'interface
ne demande **aucune ressource distante** (polices, scripts, images tierces sont tous locaux ; seules les
tuiles de carte peuvent venir d'un fournisseur, et c'est votre choix).

En place par défaut : mots de passe **hachés** (bcrypt), **verrouillage** après trop d'échecs, session
en **cookie httpOnly** (invulnérable au vol par script), secret exigé en production, **CSP stricte**,
requêtes SQL **paramétrées**, autorisation et **cloisonnement par bureau** vérifiés côté serveur.

L'audit complet et les durcissements recommandés : **`docs/SECURITE.md`**.

---

## 7. Déploiement et exploitation

- **En production**, l'API sert aussi l'interface compilée (`web/dist`) : un seul service à exposer,
  derrière un reverse proxy en HTTPS.
- **Débuter sur un PC Windows, sans rien connaître au développement** : suivez
  **`docs/DEMARRAGE-WINDOWS-DEBUTANT.md`** — chaque clic et chaque commande y sont expliqués.
- **Windows Server 2022** (mise en production, sans Docker) : guide pour informaticien dans **`docs/WINDOWS.md`**.
- **Sauvegarde / restauration**, débogage à la main, matrice des rôles, procédure de mise à jour :
  **`docs/MAINTENANCE.md`**.

Sauvegarde minimale :

```bash
pg_dump "$DATABASE_URL" > mems_$(date +%F).sql       # à sauvegarder ailleurs
# ⚠️ Conservez DATA_KEY séparément : sans elle, les données chiffrées sont irrécupérables.
```

**Tests** (à lancer avant toute mise à jour) :

```bash
cd server && npm test     # tests de l'API (attendu : 0 échec)
cd web    && npm test     # tests de bout en bout de l'interface
```

---

## 8. Documentation détaillée

| Fichier | Contenu |
|---|---|
| **`docs/MAINTENANCE.md`** | Lancer, **déboguer à la main** (logs, base, symptômes → causes), fond de carte, rôles, mise à jour, sauvegarde. |
| **`docs/SECURITE.md`** | Revue de sécurité complète et durcissements recommandés. |
| **`docs/DEMARRAGE-WINDOWS-DEBUTANT.md`** | **Lancer MEMS sur un PC Windows, pas à pas, pour un non-développeur.** |
| **`docs/WINDOWS.md`** | Déploiement sur Windows Server 2022, sans Docker (pour informaticien). |
| **`docs/UPGRADE.md`** | Notes de montée de version. |
| **`docs/A_FAIRE.md`** | Analyse fonctionnelle et feuille de route (document de travail). |

---

## 9. Ce que MEMS ne fait pas

Pour éviter les malentendus :

- **Il ne collecte pas la donnée de terrain lui-même.** La collecte se fait dans **ODK Central / KoboToolbox**
  (formulaires XLSForm) ; MEMS **importe** les soumissions et les exploite.
- **Il n'exécute pas R ni SPSS dans le navigateur.** Les scripts se rédigent et se versionnent ici, puis
  se téléchargent avec les données pour tourner ailleurs — ou, si l'exploitant l'a explicitement activé,
  sur le serveur.
- **Il n'est pas multi-organisation** pour l'instant : une instance = un bureau pays. Chaque organisation
  déploie la sienne, sur ses propres serveurs.

---

*Interface, code et documentation en français. Hébergement autonome, sans service externe.*
