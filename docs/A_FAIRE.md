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

**Remarque relevée en marge** : `db.formulas` (Paramètres → Calculs) n'est pas
dans la liste `SYNCED` de `App.jsx` — un administrateur qui modifie un calcul
le perd au rechargement. Peut-être volontaire (un bac à sable d'essai plutôt
qu'un réglage), à confirmer ; le `rationTable` ne reproduit pas ce
comportement et persiste réellement.

**Autre remarque relevée en testant** : une ligne de PDD nouvellement créée
(que ce soit via « Ajouter une ligne » ou « Générer par commune ») ne renseigne
que `partner` (le nom du partenaire) et pas `partner_id` — le serveur accepte
la ligne (le champ est optionnel) mais la clé étrangère reste vide tant que la
ligne n'a pas été rechargée depuis le serveur. Pré-existant, pas propre au
chantier 1 ; à corriger séparément si l'on a besoin de `partner_id` fiable
immédiatement après création (jointures, rapports).

## Chantier 2 — Revue des écrans « budget » comme utilisateur final

Demande explicite : « regarde chaque écran, teste comme un end user » plutôt que
deviner lequel est visé. Périmètre encore à couvrir en détail :
- MRE — éditeur de budget par ligne (`Mre.jsx`, déjà relu au niveau code, pas
  encore testé en conditions réelles avec un compte non-admin).
- TPM — contrats, avenants, barèmes (`Tpm.jsx`), pas encore testé.
- PDD — section « Planification » (tonnage/montant/bénéficiaires), concernée
  aussi par le chantier 1.

## Chantier 3 — xlsx (SheetJS) : finaliser côté environnement avec accès réseau

`web/package.json` pointe encore `xlsx` sur l'ancienne version vulnérable (le
changement vers le tarball CDN a été reverti de la PR #5 — le bac à sable de
développement ne peut pas atteindre `cdn.sheetjs.com`). À faire depuis un poste
ou un Codespace avec accès réseau complet :

```bash
cd web
npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
npm test
git add package.json package-lock.json && git commit -m "xlsx: paquet corrigé SheetJS"
```

## Fait (pour mémoire, PR #4 et #5 fusionnées dans main)

- Ingestion ODK Central (script + tirage réel + appariement des variables des
  5 XLSForms MDG).
- Éditeur de formules de performance sur les jeux de données (Analyses).
- `.devcontainer` pour GitHub Codespaces (amorçage automatique).
- Correctifs : blocage CI e2e (recharts/rAF), CORS Codespaces, encadré de
  connexion trompeur, favicon manquant, rafraîchissement après import d'un
  référentiel géographique.
