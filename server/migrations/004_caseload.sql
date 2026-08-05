-- =====================================================================
--  MEMS — population, ménages et personnes ciblées, par unité et par période
--
--  `population` était annuelle, clée sur un texte libre sans lien avec le
--  découpage, et n'avait aucun champ « ciblés ». Impossible d'en tirer le taux
--  de ciblage, ni de le croiser avec le plan de distribution.
--
--  `caseload` porte les deux dimensions qui manquaient : l'unité administrative
--  (par p-code, donc jointe au plan de distribution) et la période.
--
--  Le ciblage diffère selon l'activité. Additionner les activités donnerait un
--  total faux : une même personne ciblée par les cantines scolaires et par la
--  nutrition serait comptée deux fois. D'où deux natures de lignes :
--    activity_tag = 'URT', 'NTA'…  ciblage propre à une activité
--    activity_tag = ''             total de l'unité, dédoublonné
--  La chaîne vide plutôt que NULL : deux NULL sont distincts pour une contrainte
--  d'unicité (SQLite comme PostgreSQL), une contrainte portant sur NULL ne
--  contraindrait donc rien.
-- =====================================================================

CREATE TABLE caseload (
  id           text PRIMARY KEY,
  geo_pcode    text NOT NULL,              -- p-code seul : stable entre millésimes
  level        text NOT NULL DEFAULT 'adm3'
      CHECK (level IN ('adm1','adm2','adm3','adm4')),
  year         integer NOT NULL,
  month        integer CHECK (month IS NULL OR month BETWEEN 0 AND 11),  -- NULL = valeur annuelle
  activity_tag text NOT NULL DEFAULT '',   -- '' = toutes activités, total dédoublonné

  population   integer NOT NULL DEFAULT 0 CHECK (population  >= 0),
  households   integer NOT NULL DEFAULT 0 CHECK (households  >= 0),
  targeted     integer NOT NULL DEFAULT 0 CHECK (targeted    >= 0),
  targeted_hh  integer NOT NULL DEFAULT 0 CHECK (targeted_hh >= 0),

  source       text,                       -- « INSTAT RGPH-3 2018 », « projection 2,7 % », « enquête »
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Deux index partiels plutôt qu'un seul : une valeur annuelle et une valeur
-- mensuelle du même mois ne doivent pas pouvoir coexister en double.
CREATE UNIQUE INDEX idx_caseload_mois
  ON caseload(geo_pcode, year, month, activity_tag) WHERE month IS NOT NULL;
CREATE UNIQUE INDEX idx_caseload_annuel
  ON caseload(geo_pcode, year, activity_tag) WHERE month IS NULL;

CREATE INDEX idx_caseload_periode ON caseload(year, month);
CREATE INDEX idx_caseload_unite   ON caseload(geo_pcode, year);
