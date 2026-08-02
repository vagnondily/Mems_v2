# `data/` — données de référence réelles de MEMS

Ce dossier est l'emplacement **canonique** des jeux de données réels que MEMS
charge : le découpage administratif (shapefile Madagascar), la masterlist des
activités et indicateurs, la liste des sites par tag, et tout classeur source
utilisé par le renflouement « données réelles ».

## Comment MEMS le lit

Les chargeurs (`server/src/seed-reel.js`, `server/src/import-sites.js`, et la
route `POST /api/admin/reference`) cherchent les fichiers dans cet ordre :

1. le dossier passé en option `--docs <chemin>` (ou la variable d'environnement
   **`MEMS_DATA_DIR`**) ;
2. **ce dossier `data/`** s'il contient le shapefile de référence ;
3. à défaut, `docs/` (où les fichiers d'origine sont versionnés).

Pour utiliser `data/` comme source, déposez-y les fichiers réels (mêmes noms que
dans `docs/`), par exemple :

```
data/
  mdg_bnd_adm3_com_pam_2025.shp   (+ .dbf .prj .shx)
  List Sites per Tag.xlsx
  CM-L005_CSP_Detailed_Logframe... .xlsx   (masterlist)
  ...
```

puis lancez le renflouement depuis **Paramètres › Localités › Gestion du
référentiel › Données de référence**, ou en ligne de commande :

```
MEMS_DATA_DIR=$(pwd)/data npm --prefix server run seed:reel
MEMS_DATA_DIR=$(pwd)/data npm --prefix server run seed:sites
```

## Mode démonstration (bac à sable)

Il n'y a plus de « version démo » ni de jeu de données de démonstration séparé :
l'instance sert **toujours la donnée réelle**. Pour présenter l'application sans
risque, le **super-utilisateur** active le **mode démonstration** depuis le menu
du compte (en haut à droite) : on peut remplir tous les formulaires, mais aucune
écriture n'atteint le serveur (`web/src/lib/api.js` absorbe les mutations). Un
rechargement rétablit la production intacte. Le drapeau vit en `localStorage`,
propre au poste, jamais dans la base.

> Les bases SQLite (`server/data/*.db`) et les gros binaires ne sont pas versionnés
> ici : ce dossier accueille les **fichiers sources** de référence, pas la base
> compilée.
