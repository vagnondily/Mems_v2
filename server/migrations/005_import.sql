-- =====================================================================
--  MEMS — import par fichier, en trois temps
--
--  Un import ne s'applique jamais directement. Il passe par un lot :
--    1. le serveur analyse le fichier et calcule le diff, sans rien écrire
--    2. l'utilisateur voit ce qui sera créé, modifié, inchangé, rejeté
--    3. il confirme, et le lot s'applique en une transaction
--
--  Le lot survit à un rechargement de page, et reste consultable après coup :
--  qui a téléversé quoi, quand, avec quel résultat.
-- =====================================================================

CREATE TABLE import_batch (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,                -- caseload | pdd | sites
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_label   TEXT,
  office_id    TEXT REFERENCES offices(id) ON DELETE SET NULL,
  filename     TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  status       TEXT NOT NULL DEFAULT 'preview'
      CHECK (status IN ('preview','committed','cancelled')),
  committed_at TEXT,
  summary      TEXT NOT NULL DEFAULT '{}'    -- JSON : créés, modifiés, inchangés, rejetés
);
CREATE INDEX idx_import_batch_user ON import_batch(user_id, created_at DESC);

CREATE TABLE import_row (
  batch_id TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  line     INTEGER NOT NULL,                 -- numéro de ligne dans le fichier
  action   TEXT NOT NULL
      CHECK (action IN ('create','update','unchanged','reject')),
  field    TEXT,                             -- champ en cause pour un rejet
  message  TEXT,
  payload  TEXT NOT NULL,                    -- JSON de la ligne validée
  before   TEXT,                             -- JSON de l'état précédent, pour un update
  PRIMARY KEY (batch_id, line)
);

-- Verrou consultatif : deux téléversements du même type et du même périmètre
-- s'enchaînent au lieu de s'entrelacer.
CREATE TABLE import_lock (
  scope      TEXT PRIMARY KEY,               -- kind + périmètre
  batch_id   TEXT,
  taken_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
