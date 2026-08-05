-- =====================================================================
--  MEMS — périmètre géographique d'un bureau, déclaré
--
--  Jusqu'ici le périmètre d'un bureau se déduisait de ses sites et de son plan
--  de distribution : « ce bureau couvre les communes où il a déjà quelque chose ».
--  Cela fonctionne, mais trois choses en découlent :
--
--    — Un bureau qui vient d'ouvrir n'a aucun périmètre, donc ne peut rien
--      saisir : il faudrait d'abord créer un site, ce qui suppose déjà de
--      pouvoir écrire quelque part. Le raisonnement tourne en rond.
--    — On ne peut pas préparer une extension : « à partir de janvier, Ampanihy
--      couvre aussi Beahitse » n'est pas exprimable avant d'y créer des données.
--    — Le périmètre n'est ni visible ni vérifiable : il change à chaque site
--      ajouté, sans que personne ne l'ait décidé.
--
--  `office_scope` le rend déclaratif : un bureau couvre les unités qu'on lui a
--  attribuées, à n'importe quel niveau — une région, un district, une commune.
--  Le périmètre effectif est tout ce qui en descend, par le chemin matérialisé.
--
--  Le p-code seul, sans le millésime, comme partout ailleurs : il est stable par
--  construction, donc une attribution survit à un changement de référentiel.
-- =====================================================================

CREATE TABLE office_scope (
  office_id  text NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  geo_pcode  text NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (office_id, geo_pcode)
);
CREATE INDEX idx_office_scope_pcode ON office_scope(geo_pcode);
