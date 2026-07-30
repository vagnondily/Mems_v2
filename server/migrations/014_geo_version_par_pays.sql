-- =====================================================================
--  Un millésime courant PAR PAYS
--
--  La migration 013 a rattaché les millésimes du découpage à un pays. Restait un
--  défaut : l'index d'unicité de `is_current` portait sur toute la table, donc un
--  seul millésime pouvait être courant au monde. Changer de pays courant obligeait
--  alors à désactiver le millésime du pays précédent et à en activer un autre —
--  et à le retrouver au retour.
--
--  Ma première version le retrouvait « par date d'import la plus récente ». C'est
--  faux : on peut avoir délibérément activé un millésime plus ancien — le COD-AB
--  v2023 plutôt que le v2024 parce que les données de l'année s'y raccrochent — et
--  un aller-retour entre deux pays aurait silencieusement basculé sur le plus
--  récent.
--
--  Le bon modèle n'a pas d'état à retenir : chaque pays a SON millésime courant, et
--  « le référentiel courant » est celui du pays courant. Changer de pays ne touche
--  plus aux millésimes du tout.
-- =====================================================================

DROP INDEX IF EXISTS idx_geo_version_current;

-- Un courant par pays. Les millésimes sans pays — une base antérieure à la
-- migration 013 dont le rattrapage n'aurait pas eu lieu — partagent le groupe
-- NULL, où deux NULL sont distincts en SQLite : l'unicité ne s'y applique pas,
-- ce qui est le comportement le moins destructeur pour une base ancienne.
CREATE UNIQUE INDEX idx_geo_version_current
  ON geo_version(country) WHERE is_current = 1;
