-- =====================================================================
--  Ciblage daté — le ciblage se fait PLUSIEURS FOIS, on garde tout
--
--  (Demande du 01/08/2026 : « Le ciblage peut se faire plusieurs fois pour un
--  même cas ou une même activité… afficher le DERNIER ciblage mais donner la
--  possibilité d'insérer TOUS les ciblages avec la date du ciblage. Option de
--  sélectionner les districts et communes à cibler en amont, et un genre affecté
--  au ciblage pour telle activité tag, et pour telle raison — sécheresse,
--  cyclone, projet, FSRP, RRT — liste à faire dans paramètres. »)
--
--  `caseload` (migration 004) porte l'état COURANT — population, ménages, ciblés
--  du moment. Il n'a qu'une ligne par (unité, année, activité) : il ne peut donc
--  pas mémoriser un ciblage refait un mois plus tard, ni sa raison, ni son genre.
--  `targeting` est l'HISTORIQUE : une ligne par ÉVÉNEMENT de ciblage, datée. Le
--  dernier ciblage d'une unité pour une activité est simplement la ligne à la
--  `targeted_at` la plus récente — on affiche celui-là, on garde les autres.
--
--  La raison est un CODE de la liste paramétrable « raison_ciblage », déclarée au
--  registre (lib/listes.js) et éditable dans Paramètres, comme demandé.
-- =====================================================================

CREATE TABLE targeting (
  id           TEXT PRIMARY KEY,
  geo_pcode    TEXT NOT NULL,                       -- unité ciblée (district ou commune)
  level        TEXT NOT NULL DEFAULT 'adm3'
      CHECK (level IN ('adm1','adm2','adm3','adm4')),
  year         INTEGER NOT NULL,
  activity_tag TEXT NOT NULL DEFAULT '',            -- '' = toutes activités
  targeted_at  TEXT NOT NULL,                       -- DATE du ciblage (ISO) — la clé du « dernier »
  targeted     INTEGER NOT NULL DEFAULT 0 CHECK (targeted    >= 0),  -- personnes ciblées
  targeted_hh  INTEGER NOT NULL DEFAULT 0 CHECK (targeted_hh >= 0),  -- ménages ciblés
  gender       TEXT,                                -- genre affecté au ciblage
  reason       TEXT,                                -- raison (code de raison_ciblage)
  note         TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_targeting_unit ON targeting(geo_pcode, year, activity_tag);
CREATE INDEX idx_targeting_year ON targeting(year, activity_tag);
CREATE INDEX idx_targeting_date ON targeting(targeted_at);

-- ── La liste des raisons de ciblage (éditable dans Paramètres › Listes) ──
INSERT INTO list_item (id, type, code, label, sort_order) VALUES
  ('li_rc_sech', 'raison_ciblage', 'Sécheresse', 'Sécheresse',                 1),
  ('li_rc_cycl', 'raison_ciblage', 'Cyclone',    'Cyclone',                    2),
  ('li_rc_proj', 'raison_ciblage', 'Projet',     'Projet',                     3),
  ('li_rc_fsrp', 'raison_ciblage', 'FSRP',       'FSRP',                       4),
  ('li_rc_rrt',  'raison_ciblage', 'RRT',        'RRT (Rapid Response Team)',  5);
