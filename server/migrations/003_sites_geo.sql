-- =====================================================================
--  MEMS — rattachement des sites au référentiel administratif
--
--  Un site est un point d'intérêt (école, formation sanitaire, marché, point
--  de distribution) situé DANS un fokontany, pas un fokontany lui-même :
--  plusieurs dizaines de sites partagent la même commune. Le rattachement est
--  donc « plusieurs sites pour une unité », jamais l'inverse.
--
--  `geo_pcode` désigne un p-code, sans le millésime. C'est délibéré : les
--  p-codes sont stables par construction (dérivation déterministe du chemin),
--  donc un site continue de pointer au bon endroit quand le référentiel change
--  de millésime. Si un millésime ne porte plus ce p-code, le site apparaît
--  « non rattaché » — c'est précisément le signal que l'on veut voir.
--
--  Les colonnes adm1…adm4 restent : elles servent à l'affichage et à l'export,
--  et sont désormais dérivées du rattachement à chaque écriture, jamais saisies.
-- =====================================================================

ALTER TABLE sites ADD COLUMN geo_pcode TEXT;
CREATE INDEX idx_sites_geo_pcode ON sites(geo_pcode);

-- Le plan de distribution suit la même logique : region/district/commune y sont
-- du texte libre, ce qui rend l'agrégation « par commune » dépendante d'une
-- comparaison de chaînes. Le p-code tranche.
ALTER TABLE pdd ADD COLUMN geo_pcode TEXT;
CREATE INDEX idx_pdd_geo_pcode ON pdd(geo_pcode);
