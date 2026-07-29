-- =====================================================================
--  MEMS — référentiel géographique versionné
--
--  La table `geo` d'origine est plate : une ligne par fokontany, avec les
--  niveaux supérieurs répétés en texte. Elle ne permet pas d'attacher une
--  donnée à une commune — il n'existe pas de ligne « commune ». C'est ce qui
--  bloquait la population, le ciblage et l'agrégation par commune.
--
--  `geo_unit` est un arbre : une ligne par unité administrative, à tous les
--  niveaux. Environ 19 800 lignes pour Madagascar (23 régions, 119 districts,
--  ~1 695 communes, ~18 000 fokontany) — négligeable pour SQLite.
--
--  La table `geo` n'est pas supprimée ici : `sites.geo_id` la référence encore.
--  Elle est gelée (plus aucune écriture) et disparaîtra avec la migration de
--  `sites` vers `geo_pcode`.
-- =====================================================================

-- ── Millésimes du référentiel ───────────────────────────────────────
-- Deux partenaires n'ont pas la même liste de fokontany, et le découpage
-- évolue. Sans millésime, personne ne sait plus sur quelle liste les chiffres
-- ont été calculés.
CREATE TABLE geo_version (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,                 -- « COD-AB v2023.1 », « INSTAT 2018 »
  source      TEXT,                          -- provenance du fichier
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  units       INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1))
);
-- Un seul millésime courant à la fois, garanti par la base.
CREATE UNIQUE INDEX idx_geo_version_current ON geo_version(is_current) WHERE is_current = 1;

-- ── Unités administratives ──────────────────────────────────────────
CREATE TABLE geo_unit (
  pcode        TEXT NOT NULL,                -- code officiel, ou dérivé si absent
  version_id   TEXT NOT NULL REFERENCES geo_version(id) ON DELETE CASCADE,
  parent_pcode TEXT,                         -- NULL au niveau adm0
  level        TEXT NOT NULL CHECK (level IN ('adm0','adm1','adm2','adm3','adm4')),
  name         TEXT NOT NULL,
  -- Sans accents ni ponctuation, en minuscules : c'est la clé de rapprochement
  -- d'un fichier Excel saisi à la main vers le référentiel.
  name_norm    TEXT NOT NULL,
  -- Chemin matérialisé des pcodes : « MG/MG81/MG81101/MG81101001 ».
  -- Permet « tout ce qui est sous la région Androy » en un seul LIKE.
  path         TEXT NOT NULL,
  lat          REAL, lon REAL,
  PRIMARY KEY (pcode, version_id)
);
CREATE INDEX idx_geo_unit_parent ON geo_unit(version_id, parent_pcode);
CREATE INDEX idx_geo_unit_level  ON geo_unit(version_id, level, name);
CREATE INDEX idx_geo_unit_norm   ON geo_unit(version_id, level, name_norm);
CREATE INDEX idx_geo_unit_path   ON geo_unit(version_id, path);
