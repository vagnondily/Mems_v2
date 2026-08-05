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
  id           text PRIMARY KEY,
  kind         text NOT NULL,                -- caseload | pdd | sites
  user_id      text REFERENCES users(id) ON DELETE SET NULL,
  user_label   text,
  office_id    text REFERENCES offices(id) ON DELETE SET NULL,
  filename     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'preview'
      CHECK (status IN ('preview','committed','cancelled')),
  committed_at timestamptz,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb    -- JSON : créés, modifiés, inchangés, rejetés
);
CREATE INDEX idx_import_batch_user ON import_batch(user_id, created_at DESC);

CREATE TABLE import_row (
  batch_id text NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  line     integer NOT NULL,                 -- numéro de ligne dans le fichier
  action   text NOT NULL
      CHECK (action IN ('create','update','unchanged','reject')),
  field    text,                             -- champ en cause pour un rejet
  message  text,
  payload  jsonb NOT NULL,                    -- JSON de la ligne validée
  before   jsonb,                             -- JSON de l'état précédent, pour un update
  PRIMARY KEY (batch_id, line)
);

-- Verrou consultatif : deux téléversements du même type et du même périmètre
-- s'enchaînent au lieu de s'entrelacer.
CREATE TABLE import_lock (
  scope      text PRIMARY KEY,               -- kind + périmètre
  batch_id   text,
  taken_at   timestamptz NOT NULL DEFAULT now()
);
