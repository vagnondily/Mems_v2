-- ══════════════════════════════════════════════════════════════════════════
-- Référentiel des INDICATEURS DE SUIVI DE PROCESSUS, extraits des XLSForms.
--
-- « Extrais les variables name et label et mets-les dans un référentiel ; une
--  fois qu'on clique sur le renflouement avec données réelles, ça entre aussi
--  dedans. » — les formulaires de suivi de processus (GD/PREVMA, SMP, MIARO,
--  Nutrition/AIM, Résilience/SAMS) portent chacun des centaines de questions
--  regroupées en modules thématiques. Ce référentiel en garde le squelette :
--  une ligne par variable, son libellé, son type, son module, et l'activité
--  dont il suit le processus. C'est la couche de DÉFINITION qu'exploite le
--  tableau de bord — la performance, elle, se calcule sur la donnée réelle.
--
--  Séparé de `indicators` (masterlist CRF) à dessein : ce sont des milliers de
--  variables opérationnelles, pas des indicateurs de cadre logique ; les mêler
--  brouillerait l'écran Indicateurs. Le lien se fait par `activity_tag`.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS process_indicator (
  id           TEXT PRIMARY KEY,
  activity_tag TEXT,                 -- tag d'activité déduit du formulaire (GD, SMP, MIARO…)
  activity_label TEXT,               -- libellé lisible de l'activité
  form_file    TEXT NOT NULL,        -- nom du XLSForm source
  form_title   TEXT,                 -- titre déclaré dans l'onglet settings
  module       TEXT,                 -- libellé du groupe (module thématique)
  module_code  TEXT,                 -- name du groupe
  var_name     TEXT NOT NULL,        -- name de la variable
  var_type     TEXT,                 -- type XLSForm (select_one, integer, text…)
  label        TEXT,                 -- libellé (français, à défaut anglais)
  choices_json jsonb,                -- choix éventuels : [{value,label}]
  ord          INTEGER DEFAULT 0,    -- ordre d'apparition dans le formulaire
  active       INTEGER DEFAULT 1,
  rev          INTEGER DEFAULT 1,
  UNIQUE(form_file, var_name)
);

CREATE INDEX IF NOT EXISTS idx_procind_act  ON process_indicator(activity_tag);
CREATE INDEX IF NOT EXISTS idx_procind_form ON process_indicator(form_file);
