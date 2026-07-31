-- Lecture des soumissions ODK Central (chantier 1 du carnet).

CREATE TABLE odk_submission (
  id          TEXT PRIMARY KEY,      -- __id de la soumission ODK, pas un id à nous :
                                     -- c'est lui qui rend l'extraction idempotente
  form_id     TEXT NOT NULL REFERENCES odk_forms(id) ON DELETE CASCADE,
  submitted_at TEXT,                 -- __system/submissionDate
  site_id     TEXT REFERENCES sites(id) ON DELETE SET NULL,
  site_key    TEXT,                  -- la valeur brute du champ site, avant résolution
  periode     TEXT,                  -- AAAA-MM déduit de la date
  payload     TEXT NOT NULL,         -- la soumission entière, en JSON
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_sub_form   ON odk_submission(form_id, submitted_at);
CREATE INDEX idx_sub_site   ON odk_submission(site_id);

-- Où en est chaque source : sans cela chaque extraction relirait tout.
-- `last_pull` existe déjà depuis 001_init.sql ; seuls le curseur et la
-- dernière erreur manquent.
ALTER TABLE odk_forms ADD COLUMN last_cursor TEXT;
ALTER TABLE odk_forms ADD COLUMN last_error  TEXT;
