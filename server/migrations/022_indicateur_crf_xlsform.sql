-- =====================================================================
--  Deux natures d'indicateur : CRF et XLSForm  (chantier P)
--
--  La demande, mot pour mot : « Pour les indicateurs, sépare en deux
--  sous-modules le CRF qui est plutôt indicateur outcome et output (y
--  compris other output), et les indicateurs de l'XLSForm pour le suivi
--  de processus. »
--
--  ── UNE table, pas deux ──────────────────────────────────────────────
--  Le CRF (Corporate Results Framework — outcome/output/other output) et
--  les indicateurs de processus tirés des XLSForms sont DEUX natures d'un
--  MÊME objet : un indicateur porte un code, un intitulé, une unité, une
--  cible, un sens et une fréquence. Ils alimentent tous deux le même
--  tableau de bord et le même rapport (l'étoile polaire S4 : « une
--  bibliothèque unique CRF / XLSForm »). Les scinder en deux tables aurait
--  imposé de dupliquer les résultats (`outcomes`), la projection d'état,
--  la synchronisation et l'écran — pour distinguer ce qui tient dans une
--  seule colonne. On discrimine par `kind`, on ne divise pas la table.
--
--  ── kind, level, activity : ce que chaque nature ajoute ──────────────
--    kind      'crf' (défaut) | 'xlsform'. Toute ligne existante devient
--              CRF : c'est ce que la masterlist contenait jusqu'ici.
--    level     propre au CRF : 'outcome' | 'output' | 'other_output'.
--              NULL pour l'XLSForm, qui n'a pas de niveau de cadre logique.
--    activity  propre à l'XLSForm : l'activité dont ce processus est suivi
--              (le tag d'activité). NULL pour le CRF, mesuré par région et
--              non par activité. C'est le fil qui, plus tard, reliera un
--              indicateur de processus à l'XLSForm de SON activité (couche
--              de correspondance, chantier O) sans réécrire ce schéma.
--
--  ── Pourquoi un défaut, et pas de reprise ────────────────────────────
--  `kind` a un DÉFAUT 'crf' : les indicateurs déjà saisis sont, par
--  nature, des indicateurs de résultat — les process n'existaient pas
--  encore comme catégorie. Aucune donnée à migrer ligne à ligne ; la
--  colonne naît remplie de la bonne valeur. `level` et `activity` restent
--  vides : ils se renseignent à l'édition, l'écran ne les impose pas pour
--  ne pas bloquer la masterlist existante.
-- =====================================================================

ALTER TABLE indicators ADD COLUMN kind     text NOT NULL DEFAULT 'crf';
ALTER TABLE indicators ADD COLUMN level    text;
ALTER TABLE indicators ADD COLUMN activity text;

-- L'écran ouvre l'une ou l'autre nature : filtrer par `kind` est le geste
-- de base, il passe par un index plutôt que par un balayage de la table.
CREATE INDEX idx_indicators_kind ON indicators(kind);
