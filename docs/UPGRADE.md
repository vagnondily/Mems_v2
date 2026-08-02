# Mettre MEMS à niveau — guide de maintenance

Ce document explique comment faire évoluer une instance MEMS **sans perte de
données** et où intervenir pour les évolutions courantes. L'application est
conçue pour la mise à niveau : le schéma se migre tout seul, la donnée de
référence se recharge d'un bouton, et la configuration vit en base (pas dans le
code).

## 1. Déployer une nouvelle version

```bash
git pull
npm --prefix server ci        # dépendances serveur (verrouillées)
npm --prefix web ci           # dépendances front
npm --prefix web run build    # bundle de production → web/dist (servi par le serveur)
# redémarrer le serveur (systemd, pm2, docker… selon l'hébergement)
```

Le serveur **applique les migrations au démarrage** (`server/src/index.js` →
`migrate(migrations/)`). Aucune commande de migration manuelle n'est requise :
au boot, chaque fichier `server/migrations/NNN_*.sql` non encore appliqué est
exécuté dans l'ordre, une seule fois, et tracé dans la table `schema_migrations`.

> Sauvegarde d'abord. `Paramètres › Administration › Sauvegardes` (ou copie du
> fichier `server/data/*.db` à l'arrêt) avant toute montée de version majeure.

## 2. Faire évoluer le schéma

- Ajouter **un fichier** `server/migrations/NNN_intitule.sql` (NNN = numéro
  suivant, sur 3 chiffres). Écrire des migrations **idempotentes** (`CREATE TABLE
  IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN` gardé par un test d'existence dans le
  code si besoin). Ne jamais éditer une migration déjà publiée : en ajouter une
  nouvelle qui corrige.
- Le schéma est du SQLite (better-sqlite3). Pas d'ORM : les routes lisent/écrivent
  en SQL paramétré.

## 3. Recharger la donnée de référence (renflouement)

Tout le référentiel réel se (re)charge depuis `Paramètres › Localités › Gestion
du référentiel`, ou en ligne de commande :

| Donnée | Bouton / commande | Source |
|---|---|---|
| Découpage adm0→adm3 + contours | « Découpage » / `npm --prefix server run seed:reel` | shapefile `data/` ou `docs/` |
| Activités + indicateurs CRF **+ indicateurs de suivi de processus (XLSForm)** | « Activités + indicateurs » | masterlist + `*Process_Monitoring*.xlsx` |
| Sites par tag | « Sites par tag » / `seed:sites` | `List Sites per Tag.xlsx` |

Les fichiers sources sont cherchés dans l'ordre : `MEMS_DATA_DIR` (ou `--docs`),
puis `data/` s'il porte le shapefile, puis `docs/`. Voir `data/README.md`.

### Ajouter / mettre à jour un formulaire de suivi de processus

Déposer le XLSForm (nommé `*Process_Monitoring*` ou `*SMP_20xx*`) dans `data/`
(ou `docs/`), relancer « Activités + indicateurs ». L'extracteur
(`server/src/lib/process-xlsform.js`) relit les variables (name, libellé, type,
module, **choix**) et remplace la table `process_indicator` pour ce fichier. Le
rattachement à une activité se règle dans `FORMULAIRES_PROCESSUS`
(`server/src/seed-reel.js`).

## 4. Dépendances & vulnérabilités

`npm audit` peut signaler des avis **transitifs, non exploitables en production**
sur cette instance :

- **web — `esbuild`/`vite`** : l'avis ne concerne que le **serveur de dev** de
  vite (`npm run dev`), pas le bundle de production (`web/dist`). Il ne peut pas
  se corriger par un simple override sur vite 5.x (esbuild 0.25 casse le build).
  Correctif de fond : monter à **vite 6** (esbuild patché) — à planifier et tester
  (`npm run build` + `npm test`), ce n'est pas un correctif à chaud.
- **server — `uuid` via `exceljs`** : l'avis vise `uuid` v3/v5/v6 quand on passe un
  buffer ; `exceljs` utilise `uuid.v4()` **sans buffer** → non atteint. Ne pas
  forcer `uuid@11` (exceljs attend l'API v8, cela le casse).

Règle : mettre à niveau les dépendances **directes** régulièrement (`npm outdated`),
et vérifier `npm --prefix web run build` + `npm test` avant de committer un bump.

## 5. Où vit la configuration (rien de codé en dur)

- **Réglages d'instance, barème, formules, rôles, listes** → table `settings`
  (JSON), éditée dans Paramètres, relue à chaque démarrage.
- **Pays & découpage** → tables `geo_*`, versionnées par millésime.
- **Activités, indicateurs, rations, connecteurs, utilisateurs** → tables dédiées.
- **Secrets** (jetons ODK/MoDa, `DATA_KEY`, `JWT_SECRET`) → variables
  d'environnement / chiffrés en base ; **jamais** dans le dépôt.

Variables d'environnement principales : `DB_FILE`, `DATA_KEY` (chiffrement au
repos), `JWT_SECRET`, `PORT`, `CORS_ORIGINS`, `MEMS_DATA_DIR`.

## 6. Vers un miroir `mems-dev`

L'instance sert **toujours la donnée réelle** ; il n'y a plus de « version démo »
séparée (le mode démonstration est un bac à sable côté navigateur, cf.
`data/README.md`). Pour un environnement de développement, cloner le dépôt,
pointer un `DB_FILE` distinct, et recharger le référentiel : la même base de code
sert les deux, la seule différence est la configuration (env + `DB_FILE`).
