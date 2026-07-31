# À faire — trois chantiers, conçus et non commencés

Ce document existe pour qu'une session suivante **exécute** plutôt qu'elle reconçoive.
Il dit ce qu'il faut construire, dans quel ordre, avec les formes exactes des tables et
des routes. Rien de ce qui suit n'est écrit dans le code aujourd'hui.

État de départ : branche `claude/analyse-mems-v2-lmr9o5`, 122 tests API et 18 tests web
au vert.

---

## 1. Lire réellement les soumissions ODK Central

**Pourquoi d'abord** : les deux autres chantiers en dépendent. Aujourd'hui aucune
soumission n'entre — le bouton qui prétendait le faire inventait des nombres, il a été
retiré (voir `web/src/views/ActualData.jsx`, commentaire de `Sources`).

**Migration** — `server/migrations/022_odk_submissions.sql`

```sql
CREATE TABLE odk_submission (
  id          TEXT PRIMARY KEY,      -- __id de la soumission ODK, pas un id à nous :
                                     -- c'est lui qui rend l'extraction idempotente
  form_id     TEXT NOT NULL REFERENCES odk_forms(id) ON DELETE CASCADE,
  submitted_at TEXT,                 -- __system/submissionDate
  site_id     TEXT REFERENCES sites(id) ON DELETE SET NULL,
  site_key    TEXT,                  -- la valeur brute du champ site, avant résolution
  periode     TEXT,                  -- AAAA-MM déduit de la date
  payload     TEXT NOT NULL,         -- la soumission entière, en JSON
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sub_form   ON odk_submission(form_id, submitted_at);
CREATE INDEX idx_sub_site   ON odk_submission(site_id);

-- Où en est chaque source : sans cela chaque extraction relirait tout.
ALTER TABLE odk_forms ADD COLUMN last_cursor TEXT;   -- date de la dernière soumission lue
ALTER TABLE odk_forms ADD COLUMN last_pull   TEXT;
ALTER TABLE odk_forms ADD COLUMN last_error  TEXT;
```

**Route** — `server/src/routes/odk.js`, montée sur `/api/odk`

- `POST /odk/forms/:id/pull` — `requireCap("edit")`. Déchiffre le jeton
  (`decrypt(token_enc)`), appelle
  `${odkBase}/v1/projects/{project}/forms/{formId}.svc/Submissions`
  avec `?$top=500&$skip=N` et, si `last_cursor` existe,
  `&$filter=__system/submissionDate gt {cursor}`.
  `INSERT OR IGNORE` sur `__id` — c'est ce qui rend le rejeu inoffensif.
  Rend `{ lues, nouvelles, ignorees, cursor }`.
- `GET /odk/forms/:id/champs` — les clés rencontrées dans les 200 dernières
  soumissions, avec leur type deviné et trois valeurs d'exemple. C'est ce que
  l'écran d'appariement affiche à gauche.
- `POST /odk/forms/:id/test` — un appel `$top=1` qui dit seulement si le serveur
  répond et si le jeton est accepté. **C'est le vrai « Tester la connexion »**, celui
  qui manquait.

**Pièges à ne pas manquer**

- Le jeton ne doit jamais ressortir de l'API, même déchiffré.
- Une extraction est longue : la mener en tâche de fond et rendre l'avancement, ou
  plafonner à N pages par appel et laisser l'écran relancer.
- `site_key` est résolu en `site_id` par `code`, puis par `name`, puis rien —
  et l'écran doit dire combien n'ont pas été résolus.

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
