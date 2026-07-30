-- =====================================================================
--  Une instance, plusieurs pays
--
--  La migration 013 avait rendu le pays configurable, mais avec une hypothèse :
--  un seul pays courant, porté par un drapeau global (`country.is_current`).
--  Cette hypothèse ne tient plus. Elle avait d'ailleurs un défaut que le
--  changement d'échelle rend évident : un drapeau global est un état PARTAGÉ. Deux
--  comptes de deux pays différents se le disputeraient — le premier bascule sur
--  Madagascar, le second voit sa géographie changer sous ses yeux.
--
--  Le pays devient donc une propriété des ENTITÉS, et le pays « courant » une
--  propriété du COMPTE. `country.is_current` reste, mais seulement comme valeur
--  par défaut : celle qu'un compte sans pays déclaré utilise, et celle qu'un
--  nouveau compte reçoit.
--
--  Ce qui reçoit un pays, et pourquoi seulement ceux-là :
--
--    offices        un bureau appartient à un pays, par définition
--    users          le pays d'un compte ; NULL = tous les pays (bureau régional)
--    tpm            un prestataire est contracté dans un pays
--    mre_activity   le plan MRE est celui d'un bureau pays
--
--  Tout le reste est atteignable à travers l'un de ces quatre, ou à travers le
--  découpage géographique : les sites, visites, paramètres de couverture et lignes
--  de distribution passent par leur bureau ; le ciblage et la population passent
--  par leur p-code, dont le chemin normalisé commence par le nom du pays et qui ne
--  peut donc pas collisionner d'un pays à l'autre. Dupliquer le pays sur chacune
--  de ces tables aurait créé autant d'occasions de le voir diverger de son bureau.
-- =====================================================================

-- Un bureau appartient à un pays. Pas de NOT NULL : SQLite l'exigerait avec une
-- valeur par défaut, et une valeur par défaut sur une clé étrangère de pays serait
-- un piège — un bureau créé sans pays vaudrait mieux visible que rattaché au
-- hasard. La route l'exige, et la contrainte est vérifiée là.
ALTER TABLE offices ADD COLUMN country_code TEXT REFERENCES country(code);

-- Le pays d'un compte. NULL a un sens précis et voulu : le compte n'est borné à
-- aucun pays — c'est le cas d'un bureau régional, qui supervise plusieurs pays,
-- et celui de l'administrateur de l'instance.
ALTER TABLE users ADD COLUMN country_code TEXT REFERENCES country(code);

ALTER TABLE tpm ADD COLUMN country_code TEXT REFERENCES country(code);
ALTER TABLE mre_activity ADD COLUMN country_code TEXT REFERENCES country(code);

-- Rattrapage : tout ce qui existe décrit Madagascar, le seul pays servi jusqu'ici.
-- Les comptes ne sont volontairement PAS rattrapés : les rattacher tous à
-- Madagascar retirerait au premier administrateur la vue d'ensemble dont il a
-- besoin pour configurer le deuxième pays. Un compte sans pays voit tout, ce qui
-- est le comportement d'avant cette migration.
UPDATE offices      SET country_code = 'MDG' WHERE country_code IS NULL;
UPDATE tpm          SET country_code = 'MDG' WHERE country_code IS NULL;
UPDATE mre_activity SET country_code = 'MDG' WHERE country_code IS NULL;

CREATE INDEX idx_offices_country ON offices(country_code);
CREATE INDEX idx_users_country   ON users(country_code);
CREATE INDEX idx_tpm_country     ON tpm(country_code);
CREATE INDEX idx_mre_country     ON mre_activity(country_code, year);
