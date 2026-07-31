-- =====================================================================
--  Connexion à ODK Central depuis le serveur, et formules de performance
--
--  Jusqu'ici, les soumissions ODK Central étaient lues depuis le navigateur
--  (voir README §9) : rien n'en restait côté serveur, et « Créer un jeu de
--  données depuis un formulaire » ne trouvait jamais de lignes en dehors de
--  la démonstration hors ligne. `odk_forms.raw` accueille désormais le
--  dernier tirage de soumissions effectué par le serveur — un simple cache,
--  au même format que `datasets.raw`, et non une nouvelle relation : la
--  création d'un jeu de données continue de figer une copie indépendante.
--
--  `datasets.formulas` porte les indicateurs que l'administrateur définit
--  sur les variables du jeu, au même titre que `datasets.rules` porte les
--  règles d'apurement. Les deux s'exécutent dans le navigateur, jamais sur
--  le serveur : rien de nouveau à faire tourner côté serveur, seulement à
--  stocker.
-- =====================================================================

ALTER TABLE odk_forms ADD COLUMN raw TEXT NOT NULL DEFAULT '[]';
ALTER TABLE datasets  ADD COLUMN formulas TEXT NOT NULL DEFAULT '[]';
