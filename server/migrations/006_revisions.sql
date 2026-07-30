-- =====================================================================
--  MEMS — concurrence : suppressions explicites et révisions de ligne
--
--  Jusqu'ici `PUT /collections/:name` recevait la collection entière et
--  supprimait tout ce qui n'était pas dans le corps. Deux conséquences, toutes
--  deux des pertes de données silencieuses :
--
--    1. Bureau A charge dix indicateurs. Bureau B en ajoute un onzième.
--       A enregistre — et le onzième disparaît, sans que personne ne le sache.
--       A n'a jamais vu cette ligne : il n'avait aucune raison de la supprimer.
--
--    2. A et B modifient la même ligne. Le second écrasait le premier, sans
--       aucun signal.
--
--  Le premier cas se règle par des suppressions explicites : le client dit ce
--  qu'il a retiré, au lieu de laisser déduire. Le second par une révision de
--  ligne : le client renvoie la révision qu'il a lue, et le serveur refuse
--  d'écrire par-dessus une révision plus récente.
-- =====================================================================

ALTER TABLE coverage_params  ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE outputs          ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE indicators       ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE outcomes         ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE population       ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE pdd              ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE report_templates ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE dashboards       ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE datasets         ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE scripts          ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE odk_forms        ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

-- Les sites et la grille mensuelle passent déjà par des routes ligne à ligne,
-- mais rien n'y détectait l'écriture concurrente sur la même ligne.
ALTER TABLE sites            ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE caseload         ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
