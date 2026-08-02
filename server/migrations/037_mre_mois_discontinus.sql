-- ══════════════════════════════════════════════════════════════════════════
-- Plan MRE : mois de mise en œuvre DISCONTINUS.
--
-- « Dans la planification, j'ai planifié janvier et août seulement, pas
--  forcément en période continue mais peut-être discontinue. » — le couple
--  (start_month, end_month) ne décrit qu'une PLAGE continue. On ajoute `months`,
--  un tableau JSON d'indices de mois (0 = janvier … 11 = décembre), qui devient
--  la source de vérité quand il est renseigné. start_month/end_month restent
--  peuplés (min/max) pour la compatibilité de l'affichage et du tri hérités.
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE mre_activity ADD COLUMN months TEXT;   -- JSON: [0, 7] pour janvier + août
