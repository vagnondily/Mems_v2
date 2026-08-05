-- =====================================================================
--  MEMS — schéma relationnel
--  Toutes les clés étrangères sont déclarées et contrôlées (appliquées nativement par PostgreSQL).
--  Convention : identifiants texte (ULID-like) générés côté serveur, jamais côté client.
-- =====================================================================

-- ── Référentiels ────────────────────────────────────────────────────
CREATE TABLE offices (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  code        text,
  kind        text NOT NULL DEFAULT 'field'   -- field | hq
      CHECK (kind IN ('field','hq')),
  active      smallint NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activity_categories (
  id            text PRIMARY KEY,
  name          text NOT NULL UNIQUE,
  tag           text NOT NULL,                 -- URT, SMP, NTA…
  program_area  text,
  active        smallint NOT NULL DEFAULT 1
);
CREATE INDEX idx_actcat_tag ON activity_categories(tag);

CREATE TABLE partners (
  id     text PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  active smallint NOT NULL DEFAULT 1
);

CREATE TABLE poi_subtypes (
  id    text PRIMARY KEY,
  label text NOT NULL UNIQUE,
  code  text NOT NULL
);

-- ── Découpage administratif (jusqu'à 17 500 lignes) ─────────────────
CREATE TABLE geo (
  id     text PRIMARY KEY,
  adm0   text, adm1 text, adm2 text, adm3 text, adm4 text,
  pcode  text,
  lat    double precision, lon double precision
);
CREATE INDEX idx_geo_adm1  ON geo(adm1);
CREATE INDEX idx_geo_adm2  ON geo(adm2);
CREATE INDEX idx_geo_adm3  ON geo(adm3);
CREATE INDEX idx_geo_pcode ON geo(pcode);

-- ── Comptes et sécurité ─────────────────────────────────────────────
CREATE TABLE users (
  id            text PRIMARY KEY,
  -- Insensible à la casse : COLLATE NOCASE n'a pas d'équivalent direct en
  -- PostgreSQL, l'unicité est donc portée par un index fonctionnel sur
  -- lower(email) ci-dessous plutôt que par une contrainte UNIQUE en ligne.
  email         text NOT NULL,
  pw_hash       text NOT NULL,                 -- bcrypt, jamais exposé par l'API
  first_name    text NOT NULL,
  last_name     text,
  title         text,
  office_id     text REFERENCES offices(id) ON DELETE SET NULL,
  role          text NOT NULL DEFAULT 'viewer'
      CHECK (role IN ('super','admin','validator','editor','viewer')),
  tabs          jsonb NOT NULL DEFAULT '[]'::jsonb,    -- JSON : onglets autorisés
  active        smallint NOT NULL DEFAULT 1,
  must_change_pw smallint NOT NULL DEFAULT 0,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  last_login    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_office ON users(office_id);
CREATE UNIQUE INDEX idx_users_email ON users(lower(email));

CREATE TABLE sessions (
  id         text PRIMARY KEY,               -- jti du jeton
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked    smallint NOT NULL DEFAULT 0,
  ip         text,
  user_agent text
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked);

-- ── Registre des sites ──────────────────────────────────────────────
CREATE TABLE sites (
  id                text PRIMARY KEY,
  code              text NOT NULL UNIQUE,         -- « ID Sites » métier
  name              text NOT NULL,                -- Point of Interest
  status            text NOT NULL DEFAULT 'Active'
      CHECK (status IN ('Active','Inactive')),
  office_id         text REFERENCES offices(id) ON DELETE SET NULL,
  antenne           text,
  category_id       text REFERENCES activity_categories(id) ON DELETE SET NULL,
  activity_tag      text,
  program_area      text,
  program_tag       text,
  poi_subtype       text,
  poi_subtype_code  text,
  site_type         text,
  monitoring_type   text,
  duration          text,
  geo_id            text REFERENCES geo(id) ON DELETE SET NULL,
  adm1 text, adm2 text, adm3 text, adm4 text,
  urban_area        text NOT NULL DEFAULT 'Non' CHECK (urban_area IN ('Oui','Non')),
  lat double precision, lon double precision,
  security          integer NOT NULL DEFAULT 0 CHECK (security IN (0,1,3,99)),
  modality          text,
  beneficiaries     integer NOT NULL DEFAULT 0 CHECK (beneficiaries >= 0),
  partner_id        text REFERENCES partners(id) ON DELETE SET NULL,
  responsible       text,
  last_visit        timestamptz,
  synergies         smallint NOT NULL DEFAULT 0 CHECK (synergies BETWEEN 0 AND 1),
  new_partner       smallint NOT NULL DEFAULT 0 CHECK (new_partner BETWEEN 0 AND 1),
  exp_partner       integer NOT NULL DEFAULT 0 CHECK (exp_partner BETWEEN 0 AND 2),
  issue_ipm         integer NOT NULL DEFAULT 0 CHECK (issue_ipm BETWEEN 0 AND 2),
  issue_report      integer NOT NULL DEFAULT 0 CHECK (issue_report BETWEEN 0 AND 2),
  issue_cfm         integer NOT NULL DEFAULT 0 CHECK (issue_cfm BETWEEN 0 AND 2),
  fraud             integer NOT NULL DEFAULT 0 CHECK (fraud BETWEEN 0 AND 2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sites_office   ON sites(office_id);
CREATE INDEX idx_sites_category ON sites(category_id);
CREATE INDEX idx_sites_adm      ON sites(adm1, adm2, adm3);
CREATE INDEX idx_sites_status   ON sites(status);
CREATE INDEX idx_sites_geo      ON sites(lat, lon);

-- Une ligne par site et par mois : c'est la grille de planification.
CREATE TABLE site_months (
  site_id   text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month     integer NOT NULL CHECK (month BETWEEN 0 AND 11),
  year      integer NOT NULL,
  active    smallint NOT NULL DEFAULT 1,
  planned   smallint NOT NULL DEFAULT 0,
  done      smallint NOT NULL DEFAULT 0,
  cp_name   text,
  monitor   text,
  report    text,
  moda      text,
  PRIMARY KEY (site_id, year, month)
);
CREATE INDEX idx_sitemonths_year ON site_months(year, month);

-- ── Paramètres de couverture ────────────────────────────────────────
CREATE TABLE coverage_params (
  id                 text PRIMARY KEY,
  csp                text,
  office_id          text NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  category_id        text REFERENCES activity_categories(id) ON DELETE SET NULL,
  activity_tag       text NOT NULL,
  duration           integer NOT NULL DEFAULT 12 CHECK (duration BETWEEN 0 AND 12),
  risk_level         integer NOT NULL DEFAULT 2  CHECK (risk_level BETWEEN 1 AND 3),
  feasible_per_month integer NOT NULL DEFAULT 0  CHECK (feasible_per_month >= 0),
  UNIQUE (office_id, activity_tag)
);

-- ── Suivi de processus ──────────────────────────────────────────────
CREATE TABLE visits (
  id         text PRIMARY KEY,
  site_id    text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  office_id  text REFERENCES offices(id) ON DELETE SET NULL,
  visit_date timestamptz NOT NULL,
  activity_tag text,
  monitor    text,
  form_id    text,
  status     text NOT NULL DEFAULT 'À valider'
      CHECK (status IN ('Validé','À valider','Erreur')),
  validated_by text REFERENCES users(id) ON DELETE SET NULL,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_visits_site ON visits(site_id);
CREATE INDEX idx_visits_date ON visits(visit_date);

-- ── Produits et population ──────────────────────────────────────────
CREATE TABLE outputs (
  id           text PRIMARY KEY,
  activity_tag text NOT NULL,
  year         integer NOT NULL,
  month        integer NOT NULL CHECK (month BETWEEN 0 AND 11),
  planned      integer NOT NULL DEFAULT 0 CHECK (planned >= 0),
  actual       integer NOT NULL DEFAULT 0 CHECK (actual  >= 0),
  adjust       text NOT NULL DEFAULT 'none'
      CHECK (adjust IN ('none','up','down','new')),
  note         text,
  UNIQUE (activity_tag, year, month)
);

CREATE TABLE population (
  id         text PRIMARY KEY,
  area_key   text NOT NULL UNIQUE,
  level      text NOT NULL DEFAULT 'adm2',
  base_year  integer NOT NULL DEFAULT 2018,
  base       integer NOT NULL DEFAULT 0 CHECK (base >= 0),
  rate       double precision NOT NULL DEFAULT 0
);
CREATE TABLE population_values (
  population_id text NOT NULL REFERENCES population(id) ON DELETE CASCADE,
  year          integer NOT NULL,
  value         integer NOT NULL CHECK (value >= 0),
  PRIMARY KEY (population_id, year)
);

-- ── Indicateurs et résultats ────────────────────────────────────────
CREATE TABLE indicators (
  id        text PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  basket    text,
  unit      text NOT NULL DEFAULT '%',
  target    double precision NOT NULL DEFAULT 0,
  direction text NOT NULL DEFAULT 'up' CHECK (direction IN ('up','down')),
  method    text,
  frequency text
);
CREATE TABLE outcomes (
  id           text PRIMARY KEY,
  indicator_id text NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  adm1         text,
  round_label  text,
  planned      double precision NOT NULL DEFAULT 0,
  value        double precision NOT NULL DEFAULT 0,
  collected_at timestamptz,
  sample       integer NOT NULL DEFAULT 0 CHECK (sample >= 0)
);
CREATE INDEX idx_outcomes_ind ON outcomes(indicator_id);
CREATE TABLE outcome_plan (
  indicator_id text NOT NULL REFERENCES indicators(id) ON DELETE CASCADE,
  year         integer NOT NULL,
  month        integer NOT NULL CHECK (month BETWEEN 0 AND 11),
  planned      smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (indicator_id, year, month)
);

-- ── Plan de distribution ────────────────────────────────────────────
CREATE TABLE pdd (
  id             text PRIMARY KEY,
  year           integer NOT NULL,
  month          integer NOT NULL CHECK (month BETWEEN 0 AND 11),
  wbs            text,
  act_type       text NOT NULL,
  activity_tag   text,
  act_main       text,
  office_id      text REFERENCES offices(id) ON DELETE SET NULL,
  bureau         text NOT NULL,
  region         text, district text, commune text,
  partner_id     text REFERENCES partners(id) ON DELETE SET NULL,
  modality       text NOT NULL DEFAULT 'Food'
      CHECK (modality IN ('Food','Cash','Voucher')),
  commodity      text,
  days           integer NOT NULL DEFAULT 0 CHECK (days >= 0),
  benef_planned  integer NOT NULL DEFAULT 0 CHECK (benef_planned >= 0),
  households     integer NOT NULL DEFAULT 0 CHECK (households >= 0),
  tonnage        double precision NOT NULL DEFAULT 0 CHECK (tonnage >= 0),
  amount         double precision NOT NULL DEFAULT 0 CHECK (amount  >= 0),
  benef_actual   integer NOT NULL DEFAULT 0 CHECK (benef_actual >= 0),
  received       double precision NOT NULL DEFAULT 0 CHECK (received    >= 0),
  distributed    double precision NOT NULL DEFAULT 0 CHECK (distributed >= 0),
  status         text NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned','ongoing','done','cancelled')),
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_pdd_period ON pdd(year, month);
CREATE INDEX idx_pdd_bureau ON pdd(bureau);

-- ── Sources de données et analyses ──────────────────────────────────
CREATE TABLE odk_forms (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  form_id     text NOT NULL,
  project     text,
  token_enc   text,                    -- AES-256-GCM, jamais renvoyé en clair
  kind        text NOT NULL DEFAULT 'process'
      CHECK (kind IN ('process','output','outcome','sites')),
  activity_tag text,
  site_field  text, date_field text,
  labels      jsonb NOT NULL DEFAULT '{}'::jsonb,
  records     integer NOT NULL DEFAULT 0,
  last_pull   timestamptz,
  UNIQUE (project, form_id)
);
CREATE TABLE datasets (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  form_id    text REFERENCES odk_forms(id) ON DELETE SET NULL,
  raw        jsonb NOT NULL DEFAULT '[]'::jsonb,
  rules      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scripts (
  id         text PRIMARY KEY,
  name       text NOT NULL,
  language   text NOT NULL DEFAULT 'R' CHECK (language IN ('R','SPSS')),
  stage      text NOT NULL DEFAULT 'analysis' CHECK (stage IN ('cleaning','analysis')),
  dataset_id text REFERENCES datasets(id) ON DELETE SET NULL,
  code       text NOT NULL DEFAULT '',
  notes      text,
  runs       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Restitution ─────────────────────────────────────────────────────
CREATE TABLE report_templates (
  id     text PRIMARY KEY,
  name   text NOT NULL,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  intro  text
);
CREATE TABLE dashboards (
  id      text PRIMARY KEY,
  name    text NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- ── Configuration et traçabilité ────────────────────────────────────
-- `settings.value` reste du texte brut, volontairement : cette table sert de
-- fourre-tout de configuration, et toutes ses valeurs ne sont pas du JSON
-- (voir la migration 024, qui teste explicitement la validité JSON avant de
-- l'interpréter comme tel).
CREATE TABLE settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE audit (
  id         text PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    text REFERENCES users(id) ON DELETE SET NULL,
  user_label text,
  office     text,
  kind       text NOT NULL DEFAULT 'plan',
  entity     text,
  entity_id  text,
  action     text,
  text       text NOT NULL
);
CREATE INDEX idx_audit_at ON audit(at DESC);
