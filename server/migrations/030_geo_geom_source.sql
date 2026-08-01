-- =====================================================================
--  Chaque contour se souvient d'où il vient
--
--  « Si je remplace le niveau 3 ou 4, la dérivation des niveaux supérieurs
--  devrait se faire automatiquement. »
--
--  Pour rafraîchir automatiquement les niveaux dérivés SANS écraser un
--  contour importé à la main, il faut distinguer les deux. La marque
--  existait déjà au niveau du millésime (`geo_version.geom_source`) mais
--  pas par contour : impossible de dire, ligne à ligne, « celui-ci est
--  dérivé, celui-là est officiel ». Cette colonne le dit — `writeGeometries`
--  y écrit « dérivé de adm3 » pour un contour calculé, le nom du fichier
--  pour un import. La dérivation automatique ne touche alors qu'aux niveaux
--  entièrement dérivés.
-- =====================================================================

ALTER TABLE geo_geom ADD COLUMN source TEXT;
