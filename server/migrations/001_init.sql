-- =====================================================================
--  MEMS — schéma relationnel
--  Toutes les clés étrangères sont déclarées et contrôlées (PRAGMA foreign_keys=ON).
--  Convention : identifiants texte (ULID-like) générés côté serveur, jamais côté client.
-- =====================================================================

-- ── Référentiels ────────────────────────────────────────────────────
CREATE TABLE offices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  code        TEXT,
  kind        TEXT NOT NULL DEFAULT 'field'   -- field | hq
      CHECK (kind IN ('field','hq')),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE activity_categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  tag           TEXT NOT NULL,                 -- URT, SMP, NTA…
  program_area  TEXT,
  active        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_actcat_tag ON activity_categories(tag);

CREATE TABLE partners (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE poi_subtypes (
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  code  TEXT NOT NULL
);

-- ── Découpage administratif (jusqu'à 17 500 lignes) ─────────────────
CREATE TABLE geo (
  id     TEXT PRIMARY KEY,
  adm0   TEXT, adm1 TEXT, adm2 TEXT, adm3 TEXT, adm4 TEXT,
  pcode  TEXT,
  lat    REAL, lon REAL
);
CREATE INDEX idx_geo_adm1  ON geo(adm1);
CREATE INDEX idx_geo_adm2  ON geo(adm2);
CREATE INDEX idx_geo_adm3  ON geo(adm3);
CREATE INDEX idx_geo_pcode ON geo(pcode);

-- ── Comptes et sécurité ─────────────────────────────────────────────
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash       TEXT NOT NULL,                 -- bcrypt, jamais exposé par l'API
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  title         TEXT,
  office_id     TEXT REFERENCES offices(id) ON DELETE SET NULL,
  role          TEXT NOT NULL DEFAULT 'viewer'
      CHECK (role IN ('super','admin','validator','editor','viewer')),
  tabs          TEXT NOT NULL DEFAULT '[]',    -- JSON : onglets autorisés
  active        INTEGER NOT NULL DEFAULT 1,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_office ON users(office_id);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- jti du jeton
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked);

-- ── Registre des sites ──────────────────────────────────────────────
CREATE TABLE sites (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,         -- « ID Sites » métier
  name              TEXT NOT NULL,                -- Point of Interest
  status            TEXT NOT NULL DEFAULT 'Active'
      CHECK (status IN ('Active','Inactive')),
  office_id         TEXT REFERENCES offices(id) ON DELETE SET NULL,
  antenne           TEXT,
  category_id       TEXT REFERENCES activity_categories(id) ON DELETE SET NULL,
  activity_tag      TEXT,
  program_area      TEXT,
  program_tag       TEXT,
  poi_subtype       TEXT,
  poi_subtype_code  TEXT,
  site_type         TEXT,
  monitoring_type   TEXT,
  duration          TEXT,
  geo_id            TEXT REFERENCES geo(id) ON DELETE SET NULL,
  adm1 TEXT, adm2 TEXT, adm3 TEXT, adm4 TEXT,
  urban_area        TEXT NOT NULL DEFAULT 'Non' CHECK (urban_area IN ('Oui','Non')),
  lat REAL, lon REAL,
  security          INTEGER NOT NULL DEFAULT 0 CHECK (security IN (0,1,3,99)),
  modality          TEXT,
  beneficiaries     INTEGER NOT NULL DEFAULT 0 CHECK (beneficiaries >= 0),
  partner_id        TEXT REFERENCES partners(id) ON DELETE SET NULL,
  responsible       TEXT,
  last_visit        TEXT,
  synergies         INTEGER NOT NULL DEFAULT 0 CHECK (synergies BETWEEN 0 AND 1),
  new_partner       INTEGER NOT NULL DEFAULT 0 CHECK (new_partner BETWEEN 0 AND 1),
  exp_partner       INTEGER NOT NULL DEFAULT 0 CHECK (exp_partner BETWEEN 0 AND 2),
  issue_ipm         INTEGER NOT NULL DEFAULT 0 CHECK (issue_ipm BETWEEN 0 AND 2),
  issue_report      INTEGER NOT NULL DEFAULT 0 CHECK (issue_report BETWEEN 0 AND 2),
  issue_cfm         INTEGER NOT NULL DEFAULT 0 CHECK (issue_cfm BETWEEN 0 AND 2),
  fraud             INTEGER NOT NULL DEFAULT 0 CHECK (fraud BETWEEN 0 AND 2),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sites_office   ON sites(office_id);
CREATE INDEX idx_sites_category ON sites(category_id);
CREATE INDEX idx_sites_adm      ON sites(adm1, adm2, adm3);
CREATE INDEX idx_sites_status   ON sites(status);
CREATE INDEX idx_sites_geo      ON sites(lat, lon);

-- Une ligne par site et par mois : c'est la grille de planification.
CREATE TABLE site_months (
  site_id   TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month     INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  year      INTEGER NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  planned   INTEGER NOT NULL DEFAULT 0,
  done      INTEGER NOT NULL DEFAULT 0,
  cp_name   TEXT,
  monitor   TEXT,
  report    TEXT,
  moda      TEXT,
  PRIMARY KEY (site_id, year, month)
);
CREATE INDEX idx_sitemonths_year ON site_months(year, month);

-- ── Paramètres de couverture ────────────────────────────────────────
CREATE TABLE coverage_params (
  id                 TEXT PRIMARY KEY,
  csp                TEXT,
  office_id          TEXT NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  category_id        TEXT REFERENCES activity_categories(id) ON DELETE SET NULL,
  activity_tag       TEXT NOT NULL,
  duration           INTEGER NOT NULL DEFAULT 12 CHECK (duration BETWEEN 0 AND 12),
  risk_level         INTEGER NOT NULL DEFAULT 2  CHECK (risk_level BETWEEN 1 AND 3),
  feasible_per_month INTEGER NOT NULL DEFAULT 0  CHECK (feasible_per_month >= 0),
  UNIQUE (office_id, activity_tag)
);

-- ── Suivi de processus ──────────────────────────────────────────────
CREATE TABLE visits (
  id         TEXT PRIMARY KEY,
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  office_id  TEXT REFERENCES offices(id) ON DELETE SET NULL,
  visit_date TEXT NOT NULL,
  activity_tag TEXT,
  monitor    TEXT,
  form_id    TEXT,
  status     TEXT NOT NULL DEFAULT 'À valider'
      CHECK (status IN ('Validé','À valider','Erreur')),
  validated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_visits_site ON visits(site_id);
CREATE INDEX idx_visits_date ON visits(visit_date);

-- ── Produits et population ──────────────────────────────────────────
CREATE TABLE outputs (
  id           TEXT PRIMARY KEY,
  activity_tag TEXT NOT NULL,
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  planned      INTEGER NOT NULL DEFAULT 0 CHECK (planned >= 0),
  actual       INTEGER NOT NULL DEFAULT 0 CHECK (actual  >= 0),
  adjust       TEXT NOT NULL DEFAULT 'none'
      CHECK (adjust IN ('none','up','down','new')),
  note         TEXT,
  UNIQUE (activity_tag, year, month)
);

CREATE TABLE population (
  id         TEXT PRIMARY KEY,
  area_key   TEXT NOT NULL UNIQUE,
  level      TEXT NOT NULL DEFAULT 'adm2',
  base_year  INTEGER NOT NULL DEFAULT 2018,
  base       INTEGER NOT NULL DEFAULT 0 CHECK (base >= 0),
  rate       REAL    NOT NULL DEFAULT 0
);
CREATE TABLE population_values (
  population_id TEXT NOT NULL REFERENCES population(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  value         INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (population_id, year)
);

-- ── Indicateurs et résultats ────────────────────────────────────────
CREATE TABLE indicators (
  id        TEXT PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  basket    TEXT,
  unit      TEXT NOT NULL DEFAULT '%',
  target    REAL NOT NULL DEFAULT 0,
  direction TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
  method    TEXT,
  frequency TEXT
);
CREATE TABLE outcomes (
  id           TEXT PRIMARY KEY,
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  adm1         TEXT,
  round_label  TEXT,
  planned      REAL NOT NULL DEFAULT 0,
  value        REAL NOT NULL DEFAULT 0,
  collected_at TEXT,
  sample       INTEGER NOT NULL DEFAULT 0 CHECK (sample >= 0)
);
CREATE INDEX idx_outcomes_ind ON outcomes(indicator_id);
CREATE TABLE outcome_plan (
  indicator_id TEXT NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  planned      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (indicator_id, year, month)
);

-- ── Plan de distribution ────────────────────────────────────────────
CREATE TABLE pdd (
  id             TEXT PRIMARY KEY,
  year           INTEGER NOT NULL,
  month          INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  wbs            TEXT,
  act_type       TEXT NOT NULL,
  activity_tag   TEXT,
  act_main       TEXT,
  office_id      TEXT REFERENCES offices(id) ON DELETE SET NULL,
  bureau         TEXT NOT NULL,
  region         TEXT, district TEXT, commune TEXT,
  partner_id     TEXT REFERENCES partners(id) ON DELETE SET NULL,
  modality       TEXT NOT NULL DEFAULT 'Food'
      CHECK (modality IN ('Food','Cash','Voucher')),
  commodity      TEXT,
  days           INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
  benef_planned  INTEGER NOT NULL DEFAULT 0 CHECK (benef_planned >= 0),
  households     INTEGER NOT NULL DEFAULT 0 CHECK (households >= 0),
  tonnage        REAL    NOT NULL DEFAULT 0 CHECK (tonnage >= 0),
  amount         REAL    NOT NULL DEFAULT 0 CHECK (amount  >= 0),
  benef_actual   INTEGER NOT NULL DEFAULT 0 CHECK (benef_actual >= 0),
  received       REAL    NOT NULL DEFAULT 0 CHECK (received    >= 0),
  distributed    REAL    NOT NULL DEFAULT 0 CHECK (distributed >= 0),
  status         TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned','ongoing','done','cancelled')),
  note           TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pdd_period ON pdd(year, month);
CREATE INDEX idx_pdd_bureau ON pdd(bureau);

-- ── Sources de données et analyses ──────────────────────────────────
CREATE TABLE odk_forms (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  form_id     TEXT NOT NULL,
  project     TEXT,
  token_enc   TEXT,                    -- AES-256-GCM, jamais renvoyé en clair
  kind        TEXT NOT NULL DEFAULT 'process'
      CHECK (kind IN ('process','output','outcome','sites')),
  activity_tag TEXT,
  site_field  TEXT, date_field TEXT,
  labels      TEXT NOT NULL DEFAULT '{}',
  records     INTEGER NOT NULL DEFAULT 0,
  last_pull   TEXT,
  UNIQUE (project, form_id)
);
CREATE TABLE datasets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  form_id    TEXT REFERENCES odk_forms(id) ON DELETE SET NULL,
  raw        TEXT NOT NULL DEFAULT '[]',
  rules      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE scripts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  language   TEXT NOT NULL DEFAULT 'R' CHECK (language IN ('R','SPSS')),
  stage      TEXT NOT NULL DEFAULT 'analysis' CHECK (stage IN ('cleaning','analysis')),
  dataset_id TEXT REFERENCES datasets(id) ON DELETE SET NULL,
  code       TEXT NOT NULL DEFAULT '',
  notes      TEXT,
  runs       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Restitution ─────────────────────────────────────────────────────
CREATE TABLE report_templates (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  blocks TEXT NOT NULL DEFAULT '[]',
  intro  TEXT
);
CREATE TABLE dashboards (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  widgets TEXT NOT NULL DEFAULT '[]'
);

-- ── Configuration et traçabilité ────────────────────────────────────
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE audit (
  id         TEXT PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_label TEXT,
  office     TEXT,
  kind       TEXT NOT NULL DEFAULT 'plan',
  entity     TEXT,
  entity_id  TEXT,
  action     TEXT,
  text       TEXT NOT NULL
);
CREATE INDEX idx_audit_at ON audit(at DESC);
