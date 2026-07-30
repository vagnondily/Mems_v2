-- =====================================================================
--  Les partenaires d'exécution deviennent une vraie liste de référence
--
--  `partners` n'avait qu'un nom et un drapeau d'activité, et surtout : aucune route
--  d'écriture. L'écran de configuration proposait pourtant de la modifier — une
--  liste de NOMS, dérivée de la table à chaque chargement et jamais renvoyée au
--  serveur. Toute saisie était donc perdue au rechargement, sans un message.
--
--  C'est exactement le défaut qui avait été corrigé pour les bureaux, et qui
--  subsistait ici. Or un partenaire d'exécution n'est pas un libellé : il porte un
--  sigle, un type, un contact, une convention, et il est ASSIGNÉ par commune dans le
--  plan de distribution — ce que `pdd.partner_id` fait déjà. Le renommer par
--  écrasement d'une liste de chaînes ne pouvait pas fonctionner.
--
--  Le pays suit la même règle que les bureaux et les prestataires de suivi
--  (migration 015) : un partenaire est conventionné dans un pays.
-- =====================================================================

ALTER TABLE partners ADD COLUMN code         TEXT;    -- sigle usuel, ex. « CRM », « ASOS »
ALTER TABLE partners ADD COLUMN kind         TEXT;    -- ong_nationale, ong_internationale, gouvernement, agence_onu, prive
ALTER TABLE partners ADD COLUMN contact      TEXT;
ALTER TABLE partners ADD COLUMN email        TEXT;
ALTER TABLE partners ADD COLUMN phone        TEXT;
ALTER TABLE partners ADD COLUMN agreement    TEXT;    -- référence de la convention
ALTER TABLE partners ADD COLUMN start_date   TEXT;
ALTER TABLE partners ADD COLUMN end_date     TEXT;
ALTER TABLE partners ADD COLUMN note         TEXT;
ALTER TABLE partners ADD COLUMN country_code TEXT REFERENCES country(code);
ALTER TABLE partners ADD COLUMN office_id    TEXT REFERENCES offices(id) ON DELETE SET NULL;
ALTER TABLE partners ADD COLUMN rev          INTEGER NOT NULL DEFAULT 1;
ALTER TABLE partners ADD COLUMN updated_at   TEXT;

-- Rattrapage : l'existant décrit le pays servi jusqu'ici, comme pour les bureaux.
UPDATE partners SET country_code = (SELECT code FROM country WHERE is_current = 1)
WHERE country_code IS NULL;

CREATE INDEX idx_partners_country ON partners(country_code);
