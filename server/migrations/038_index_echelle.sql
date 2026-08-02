-- ════════════════════════════════════════════════════════════════════
--  Index de tenue à l'échelle
--
--  MEMS traitera des milliers de sites et des dizaines de milliers de
--  soumissions. Deux écrans très fréquentés triaient alors sur des colonnes
--  qu'aucun index ne servait, ce qui oblige SQLite à lire puis trier
--  l'INTÉGRALITÉ du jeu filtré avant d'en rendre une page de vingt lignes.
--
--  1. La liste des soumissions (routes/submissions.js) trie par
--     `svy_date DESC, id`. Les index posés par la migration 017 portent sur
--     (site_id, svy_date), (form_id), (instance_id) et un partiel sur
--     created_at : aucun ne sert un tri GLOBAL par svy_date. Chaque page
--     coûtait donc un balayage complet, et ce coût croît avec la table.
--
--     L'index nommé ici reprend l'ordre exact du ORDER BY — décroissant sur la
--     date, croissant sur l'identifiant qui départage les ex æquo — pour que
--     SQLite le parcoure au lieu de trier.
--
--  2. `submissions(site_id)` seul (sans la date) sert les jointures et les
--     comptages par site que la liste des sites et la carte réclament. Le
--     composite (site_id, svy_date) de la migration 017 le couvre déjà en
--     préfixe : on ne le double pas.
--
--  Aucune donnée n'est touchée : ce fichier ne crée que des index.
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_submissions_svy_date
  ON submissions(svy_date DESC, id);

-- Les résultats d'enquête sont désormais servis par millésime récent dans
-- /api/state (le filtre porte sur les quatre premiers caractères de la date
-- ISO). L'index sur la date rend ce filtre parcourable plutôt que balayé.
CREATE INDEX IF NOT EXISTS idx_outcomes_collected
  ON outcomes(collected_at);

-- Le plan de distribution est servi borné à l'année. `idx_pdd_period(year, month)`
-- sert déjà ce filtre ; on ajoute le couple (office_id, year) parce que la
-- requête d'un compte cloisonné porte sur les deux à la fois, et que le filtre de
-- bureau sans la date obligeait à relire toutes les années du bureau.
CREATE INDEX IF NOT EXISTS idx_pdd_office_year
  ON pdd(office_id, year);
