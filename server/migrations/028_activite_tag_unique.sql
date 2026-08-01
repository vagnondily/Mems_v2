-- =====================================================================
--  L'ACTIVITÉ, C'EST SON TAG — et le tag est unique
--
--  Demande du propriétaire : « Liste des activités = activity tag (valeur
--  unique stp). »
--
--  ── Ce que le schéma disait, et ce qu'il ne disait pas ───────────────
--  `activity_categories` (001_init.sql:18) impose l'unicité du NOM et pose
--  un index ORDINAIRE sur le tag. Le nom n'est pourtant qu'un libellé — il
--  se traduit, se reformule, se corrige. Le TAG, lui, est la clé de
--  jointure : dix colonnes le portent en texte (sites, couverture, plan de
--  distribution, produits, visites, formulaires ODK, caseload, zones TPM,
--  soumissions, indicateurs de processus), sans aucune contrainte pour les
--  retenir. Deux activités partageant un tag rendaient donc ces dix
--  colonnes ambiguës : « URT » désignait deux lignes, et aucune requête ne
--  pouvait dire laquelle.
--
--  La contrainte d'unicité manquait exactement là où elle comptait.
--
--  ── Trois gestes, dans cet ordre ─────────────────────────────────────
--  1. NORMALISER. Le classeur du PAM porte des acronymes espacés
--     (« FBA _CCS », « AES _CCS »…) : c'est une coquille de saisie, pas un
--     code différent, et deux écritures du même tag valent deux activités.
--     Les espaces intérieurs tombent, la casse est fixée en majuscules.
--  2. FUSIONNER les doublons qui subsistent. La ligne la plus ANCIENNE
--     survit — c'est elle que les données existantes désignent le plus
--     probablement —, et les clés étrangères des autres sont reportées sur
--     elle avant qu'elles ne disparaissent. Rien n'est détaché : c'est le
--     même principe que le renommage en cascade du chantier S8, appliqué
--     une fois, en SQL, à un état hérité.
--  3. CONTRAINDRE. L'index unique, insensible à la casse, pour que le
--     problème ne puisse pas revenir par une saisie.
--
--  Le nom des lignes fusionnées est perdu, et c'est assumé : deux lignes
--  qui portaient le même tag étaient déjà la même activité pour toutes les
--  données qui s'y rattachent.
-- =====================================================================

-- ── 1. Normalisation ────────────────────────────────────────────────
-- Espaces intérieurs, tabulations et sauts de ligne retirés ; majuscules.
UPDATE activity_categories
   SET tag = UPPER(REPLACE(REPLACE(REPLACE(TRIM(tag), ' ', ''), CHAR(9), ''), CHAR(10), ''));

-- Un tag vide n'est pas un tag : il rendrait l'unicité illusoire (toutes
-- les lignes vides seraient « la même »). On lui en donne un, dérivé de la
-- ligne, visible et corrigeable.
UPDATE activity_categories
   SET tag = 'ACT' || rowid
 WHERE tag IS NULL OR tag = '';

-- ── 2. Fusion des doublons ──────────────────────────────────────────
-- Les enfants des lignes condamnées sont reportés sur la survivante — la
-- plus ancienne du groupe — AVANT toute suppression.
UPDATE sites
   SET category_id = (
     SELECT a2.id FROM activity_categories a2
      WHERE a2.tag = (SELECT a1.tag FROM activity_categories a1 WHERE a1.id = sites.category_id)
      ORDER BY a2.rowid LIMIT 1)
 WHERE category_id IS NOT NULL;

UPDATE coverage_params
   SET category_id = (
     SELECT a2.id FROM activity_categories a2
      WHERE a2.tag = (SELECT a1.tag FROM activity_categories a1
                      WHERE a1.id = coverage_params.category_id)
      ORDER BY a2.rowid LIMIT 1)
 WHERE category_id IS NOT NULL;

-- Les lignes en trop peuvent maintenant partir : plus rien ne les désigne.
DELETE FROM activity_categories
 WHERE rowid NOT IN (SELECT MIN(rowid) FROM activity_categories GROUP BY tag);

-- ── 3. La contrainte ────────────────────────────────────────────────
-- L'index ordinaire n'a plus lieu d'être : l'unique le remplace et sert les
-- mêmes recherches.
DROP INDEX IF EXISTS idx_actcat_tag;
CREATE UNIQUE INDEX idx_actcat_tag ON activity_categories(tag COLLATE NOCASE);
