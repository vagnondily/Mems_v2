-- =====================================================================
--  Productivité de collecte — formulaires par jour et par personne
--
--  Le nombre de jours d'un plan TPM ne se devine pas : il se CALCULE, sur la
--  base du MMR (exigence minimale de suivi). La règle, dictée par le métier :
--
--      jours-personnes = Σ (formulaires à faire) / (formulaires par jour et
--                          par personne, PROPRE au type d'activité)
--      jours de l'équipe = jours-personnes / nombre d'agents
--
--  « Combien de formulaires une personne remplit-elle en un jour » dépend du
--  type d'activité (un GD et un PECMAM ne se collectent pas au même rythme).
--  C'est donc un paramètre du plan de suivi, à la même maille que le reste de la
--  configuration de couverture : par bureau ET par activité.
--
--  0 = non renseigné : tant qu'aucune productivité n'est déclarée, le calcul ne
--  s'impose pas et l'affectation retombe sur son estimation par défaut. Déclarer
--  la valeur active le calcul, sans migration de données ni rupture.
-- =====================================================================

ALTER TABLE coverage_params
  ADD COLUMN forms_per_day integer NOT NULL DEFAULT 0 CHECK (forms_per_day >= 0);
