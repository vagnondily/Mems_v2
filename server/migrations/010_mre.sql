-- =====================================================================
--  Plan MRE et budgétisation
--
--  MRE : Monitoring, Review and Evaluation — le plan annuel d'activités de
--  suivi, de revue et d'évaluation du bureau pays, avec son coût. L'application
--  savait déjà planifier des VISITES de site et des ROUNDS d'indicateur ; elle
--  ne savait pas dire ce que l'unité suivi-évaluation entreprend dans l'année,
--  ni ce que cela coûte. Ce sont pourtant les deux questions posées à chaque
--  exercice budgétaire, et la seule réponse disponible était un classeur tenu
--  à part — donc jamais rapproché de ce que l'outil mesure.
--
--  Deux tables, parce que ce sont deux choses de nature différente :
--
--    mre_activity  ce qu'on entreprend  (une enquête PDM, une évaluation à
--                  mi-parcours, une revue trimestrielle…), quand, où, par qui,
--                  avec quel lien vers le programme et quel indicateur
--    mre_cost      ce que cela coûte, ligne par ligne (enquêteurs, transport,
--                  atelier, consultant…), en quantité × coût unitaire
--
--  Le budget n'est donc pas un montant saisi à la main : c'est la somme de ses
--  lignes. Un total qu'on ne peut pas décomposer ne se défend pas en réunion,
--  et ne se compare pas à la dépense.
--
--  Chaque ligne de coût porte aussi le RÉALISÉ (`spent`). C'est le même principe
--  que le reste de l'application depuis la fusion du prévu et du réalisé : un
--  sujet, deux vues. L'écart budgétaire se lit alors sans second classeur.
-- =====================================================================

CREATE TABLE mre_activity (
  id            text PRIMARY KEY,
  year          integer NOT NULL,
  ref           text,                       -- référence lisible, ex. « MRE-2026-04 »
  title         text NOT NULL,

  -- La nature de l'activité gouverne la lecture du plan : on ne budgète pas une
  -- évaluation externe comme une visite de suivi de processus.
  kind          text NOT NULL DEFAULT 'suivi'
      CHECK (kind IN ('suivi','revue','evaluation','enquete','etude','capacite')),
  purpose       text,                       -- à quelle question l'activité répond
  method        text,                       -- méthode de collecte ou d'analyse

  -- Rattachements. Tous facultatifs : une activité transversale n'a ni activité
  -- programme ni indicateur unique, et la forcer à en déclarer un serait faux.
  office_id     text REFERENCES offices(id) ON DELETE SET NULL,
  activity_tag  text,                       -- URT, ACL… lien vers le programme
  indicator_id  text REFERENCES indicators(id) ON DELETE SET NULL,
  geo_pcode     text,                       -- portée ; NULL = national

  responsible   text,
  -- Calendrier en mois de l'année (0–11), comme partout ailleurs dans le schéma.
  start_month   integer CHECK (start_month IS NULL OR start_month BETWEEN 0 AND 11),
  end_month     integer CHECK (end_month   IS NULL OR end_month   BETWEEN 0 AND 11),
  sample        integer CHECK (sample IS NULL OR sample >= 0),

  status        text NOT NULL DEFAULT 'planifie'
      CHECK (status IN ('planifie','en_cours','realise','reporte','annule')),
  funding       text,                       -- source de financement
  currency      text NOT NULL DEFAULT 'USD',
  note          text,

  rev           integer NOT NULL DEFAULT 1,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text REFERENCES users(id) ON DELETE SET NULL
);

-- La référence est unique dans l'année, pas au-delà : les plans se succèdent et
-- « MRE-04 » de 2026 n'a rien à voir avec celui de 2027. Index partiel, car une
-- activité sans référence est permise et deux NULL sont distincts pour l'unicité.
CREATE UNIQUE INDEX idx_mre_ref ON mre_activity(year, ref) WHERE ref IS NOT NULL;
CREATE INDEX idx_mre_year   ON mre_activity(year, kind);
CREATE INDEX idx_mre_office ON mre_activity(office_id);
CREATE INDEX idx_mre_geo    ON mre_activity(geo_pcode);

CREATE TABLE mre_cost (
  id           text PRIMARY KEY,
  activity_id  text NOT NULL REFERENCES mre_activity(id) ON DELETE CASCADE,

  -- Catégories fermées : un budget dont les lignes sont libellées librement ne
  -- s'agrège pas. « Combien coûtent les enquêteurs sur l'année » doit avoir une
  -- réponse, et elle n'existe que si la catégorie est un code.
  category     text NOT NULL DEFAULT 'autre'
      CHECK (category IN ('personnel','enqueteurs','deplacement','transport',
                          'atelier','consultant','equipement','impression',
                          'communication','autre')),
  label        text,
  unit         text,                        -- jour, personne-jour, véhicule-jour…
  qty          double precision NOT NULL DEFAULT 1 CHECK (qty >= 0),
  unit_cost    double precision NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- Réalisé. Nul tant qu'aucune dépense n'est constatée : zéro et « pas encore
  -- dépensé » ne se confondent pas dans un suivi budgétaire.
  spent        double precision CHECK (spent IS NULL OR spent >= 0),
  month        integer CHECK (month IS NULL OR month BETWEEN 0 AND 11),
  note         text,

  rev          integer NOT NULL DEFAULT 1,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mre_cost_act ON mre_cost(activity_id);
CREATE INDEX idx_mre_cost_cat ON mre_cost(category);
