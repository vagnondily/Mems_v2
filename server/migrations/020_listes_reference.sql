-- =====================================================================
--  Les catégories d'activité et les sous-types de point d'intérêt
--  deviennent des listes qu'on peut réellement tenir.
--
--  Elles s'éditaient déjà dans Paramètres → Général. Elles ne s'enregistraient
--  nulle part : l'écran modifiait une copie en mémoire, dérivée à chaque chargement
--  de l'état, et aucune route n'existait pour les renvoyer. On ajoutait une
--  catégorie, elle apparaissait, on rechargeait la page, elle avait disparu — sans
--  un message, sans une trace dans le journal.
--
--  Les sous-types de point d'intérêt allaient plus loin : la table existe et le
--  semis la remplit, mais l'état ne l'exposait pas. L'écran affichait donc une liste
--  vide sur des données présentes, et proposait d'y ajouter des lignes qui
--  n'atteignaient jamais la base.
--
--  Les deux passent par la synchronisation de collections, comme les indicateurs ou
--  les modèles de rapport. Il leur manque pour cela la révision de ligne, seul moyen
--  d'avertir le second qui enregistre au lieu d'écraser le premier en silence.
-- =====================================================================

ALTER TABLE activity_categories ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;
ALTER TABLE poi_subtypes        ADD COLUMN rev INTEGER NOT NULL DEFAULT 1;

-- Le domaine programmatique manquait aux sous-types : un « marché » et une « école »
-- ne se suivent pas pour les mêmes raisons, et le libellé seul ne le disait pas.
ALTER TABLE poi_subtypes ADD COLUMN note TEXT;
