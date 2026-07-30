-- =====================================================================
--  Le plan MRE devient un vrai plan MRE
--
--  Ce que la migration 010 avait construit tenait debout, mais ne ressemblait pas à
--  un plan de suivi, revue et évaluation : c'était une liste d'activités annuelles
--  avec des lignes de coût. Les classeurs de référence du bureau pays — le cadre de
--  suivi-évaluation d'une part, le classeur de planification et budgétisation
--  d'autre part — en décrivent un autre, en DEUX parties liées :
--
--    1. le plan de suivi par INDICATEUR
--       Pour chaque indicateur du cadre logique : d'où vient la donnée, par quelle
--       méthode elle est collectée, comment la référence est établie, qui collecte,
--       à quelle fréquence, et dans quel rapport l'information est utilisée.
--       C'est la partie que l'outil ne savait pas exprimer du tout : il connaissait
--       la cible et le sens d'un indicateur, jamais la mécanique qui le produit.
--
--    2. la budgétisation par ACTIVITÉ MRE
--       Pour chaque activité : l'entité responsable (interne ou externe), sa
--       catégorie de coût, sa fréquence TRIMESTRIELLE sur PLUSIEURS ANNÉES, son
--       coût unitaire, et la dépense constatée. Le budget d'une année est
--       Σ(fréquences des quatre trimestres) × coût unitaire — c'est exactement la
--       formule du classeur, et elle a l'avantage de dire QUAND l'argent est
--       consommé, ce qu'une somme de lignes ne dit pas.
--
--  Pourquoi remplacer `mre_cost` plutôt que le garder à côté : deux façons de
--  calculer un budget, c'est une de trop. Elles auraient fini par donner deux
--  montants différents pour la même activité, et personne n'aurait su lequel
--  défendre en réunion. Les lignes existantes sont donc CONVERTIES — leur total
--  devient le coût unitaire d'une occurrence, placée au trimestre du mois de début —
--  puis la table est retirée. Aucun montant n'est perdu.
-- =====================================================================

-- ── 1. Le plan de suivi par indicateur ──────────────────────────────
-- La hiérarchie du cadre logique. Elle vient du classeur corporate et n'existait
-- nulle part : un indicateur y flottait sans rattachement à l'effet stratégique ni
-- à l'activité qui le produit, si bien qu'on ne pouvait pas répondre à « quels
-- indicateurs pour l'activité 1.2 ? », qui est la question posée en revue.
ALTER TABLE indicators ADD COLUMN sdg_target        TEXT;
ALTER TABLE indicators ADD COLUMN outcome           TEXT;
ALTER TABLE indicators ADD COLUMN outcome_category  TEXT;
ALTER TABLE indicators ADD COLUMN activity_ref      TEXT;
ALTER TABLE indicators ADD COLUMN activity_category TEXT;

-- Les moyens de vérification. `method` et `frequency` existaient déjà et portent la
-- méthode de collecte et la fréquence de suivi : on ne les duplique pas.
ALTER TABLE indicators ADD COLUMN data_source  TEXT;   -- d'où vient la donnée
ALTER TABLE indicators ADD COLUMN baseline     TEXT;   -- comment la référence est établie
ALTER TABLE indicators ADD COLUMN responsible  TEXT;   -- qui collecte
ALTER TABLE indicators ADD COLUMN reports      TEXT;   -- où l'information est utilisée
ALTER TABLE indicators ADD COLUMN use_note     TEXT;   -- quand, comment, par qui

-- ── 2. La budgétisation par activité ────────────────────────────────
ALTER TABLE mre_activity ADD COLUMN entity        TEXT;   -- interne / externe
ALTER TABLE mre_activity ADD COLUMN cost_category TEXT;   -- catégorie de coût
ALTER TABLE mre_activity ADD COLUMN high_category TEXT;   -- catégorie de coût de haut niveau
ALTER TABLE mre_activity ADD COLUMN unit_cost     REAL NOT NULL DEFAULT 0;

-- La fréquence, par année et par trimestre. C'est le cœur du modèle : une activité
-- n'a pas un budget annuel, elle a un nombre d'occurrences par trimestre et un coût
-- unitaire. Un plan pluriannuel se lit alors sans changer d'écran.
CREATE TABLE mre_frequency (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES mre_activity(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  quarter     INTEGER NOT NULL CHECK (quarter BETWEEN 0 AND 3),
  n           REAL NOT NULL DEFAULT 0 CHECK (n >= 0)
);
CREATE UNIQUE INDEX idx_mre_freq ON mre_frequency(activity_id, year, quarter);
CREATE INDEX idx_mre_freq_annee ON mre_frequency(year);

-- La dépense constatée, par année. Elle reste distincte du budget : nul n'est zéro
-- — « rien de dépensé pour l'instant » et « dépense constatée nulle » sont deux
-- états différents, et l'exécution budgétaire d'une année sans dépense saisie ne
-- vaut pas 0 %, elle ne vaut rien du tout.
CREATE TABLE mre_spend (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES mre_activity(id) ON DELETE CASCADE,
  year        INTEGER NOT NULL,
  amount      REAL CHECK (amount IS NULL OR amount >= 0),
  note        TEXT
);
CREATE UNIQUE INDEX idx_mre_spend ON mre_spend(activity_id, year);

-- ── Conversion de l'existant ────────────────────────────────────────
-- Le coût unitaire reprend le total des lignes : une occurrence de l'activité coûte
-- ce que ses lignes coûtaient. Le budget affiché est donc identique avant et après.
UPDATE mre_activity SET unit_cost = COALESCE(
  (SELECT ROUND(SUM(qty * unit_cost), 2) FROM mre_cost c WHERE c.activity_id = mre_activity.id), 0);

-- Une occurrence, au trimestre du mois de début (janvier → T1, avril → T2…). Les
-- activités sans mois de début sont placées au premier trimestre : c'est arbitraire
-- et cela se corrige à l'écran, alors que ne rien poser aurait effacé leur budget.
INSERT INTO mre_frequency (id, activity_id, year, quarter, n)
SELECT 'freq_' || a.id, a.id, a.year, COALESCE(a.start_month, 0) / 3, 1
FROM mre_activity a WHERE a.unit_cost > 0;

-- La dépense : somme des lignes qui en portaient une. Les autres restent sans
-- dépense, ce qui est différent de zéro.
INSERT INTO mre_spend (id, activity_id, year, amount)
SELECT 'spend_' || a.id, a.id, a.year,
       (SELECT ROUND(SUM(c.spent), 2) FROM mre_cost c
        WHERE c.activity_id = a.id AND c.spent IS NOT NULL)
FROM mre_activity a
WHERE EXISTS (SELECT 1 FROM mre_cost c WHERE c.activity_id = a.id AND c.spent IS NOT NULL);

DROP TABLE mre_cost;

-- Le mois de début et de fin ne veulent plus rien dire : le calendrier est porté par
-- les fréquences trimestrielles, et laisser deux calendriers concurrents dans le
-- schéma revient à laisser quelqu'un lire le mauvais.
ALTER TABLE mre_activity DROP COLUMN start_month;
ALTER TABLE mre_activity DROP COLUMN end_month;
