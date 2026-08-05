-- =====================================================================
--  Le pays comme configuration, non comme hypothèse
--
--  Cette première version sert Madagascar, et d'autres pays suivront. Il ne
--  s'agit donc pas de construire tout de suite le multi-pays — ce serait bâtir sur
--  des décisions qui ne sont pas prises — mais de faire en sorte que rien de
--  spécifique à Madagascar ne soit plus écrit dans le code.
--
--  Trois choses l'étaient :
--
--  1. Les LIBELLÉS des niveaux administratifs. « Régions / Districts / Communes /
--     Fokontany » figuraient en dur dans huit endroits de deux fichiers. Ce
--     découpage est propre à Madagascar : la RDC a des Provinces, Territoires,
--     Secteurs et Groupements ; l'Éthiopie des Regions, Zones, Woredas et
--     Kebeles. Le schéma, lui, a toujours été neutre — adm0 à adm4 — et c'est la
--     seule couche qui l'était.
--
--  2. La DEVISE. Le contrat d'un prestataire est en monnaie locale, et « MGA »
--     était la valeur par défaut du schéma comme de la route.
--
--  3. Le RATTACHEMENT du référentiel. `geo_version` portait des millésimes
--     successifs — « COD-AB v2023.1 », puis v2024 — sans jamais dire de quel pays
--     ils décrivent le découpage. Tant qu'il n'y en a qu'un, la question ne se
--     pose pas ; au deuxième, deux millésimes courants devraient coexister, ce que
--     l'index partiel actuel interdit précisément.
--
--  Un seul pays est courant à la fois. C'est ce qui correspond à un déploiement
--  par bureau pays, et cela laisse le choix ouvert : servir plusieurs pays depuis
--  une même instance demanderait de rattacher les sites, les bureaux et les
--  comptes à un pays, ce qui est une autre décision — celle de savoir si un
--  utilisateur traverse les frontières.
-- =====================================================================

CREATE TABLE country (
  -- ISO 3166-1 alpha-3 : le code que les référentiels administratifs humanitaires
  -- utilisent déjà (les p-codes officiels commencent par l'alpha-2, mais les jeux
  -- de données COD sont nommés par l'alpha-3).
  code        text PRIMARY KEY,
  name        text NOT NULL,
  currency    text NOT NULL DEFAULT 'USD',

  -- Les libellés des cinq niveaux, au singulier et au pluriel. En JSON parce que
  -- c'est une liste de paires dont le nombre est fixe et le contenu variable :
  -- cinq colonnes × deux formes auraient fait dix colonnes pour la même chose.
  levels      jsonb NOT NULL,

  -- Centre approximatif, pour cadrer la carte avant tout import de contours.
  lat         double precision,
  lon         double precision,

  active      smallint NOT NULL DEFAULT 1,
  is_current  smallint NOT NULL DEFAULT 0,
  note        text,
  rev         integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

-- Un seul pays courant. Index partiel, pour la même raison que le millésime
-- courant du référentiel : deux zéros ne s'excluent pas, mais deux uns oui dès
-- qu'on restreint l'index à eux.
CREATE UNIQUE INDEX idx_country_current ON country(is_current) WHERE is_current = 1;

-- Le millésime du découpage appartient désormais à un pays.
ALTER TABLE geo_version ADD COLUMN country text REFERENCES country(code);

-- Madagascar, avec son vocabulaire administratif réel.
INSERT INTO country (code, name, currency, levels, lat, lon, is_current, note) VALUES (
  'MDG', 'Madagascar', 'MGA',
  ('{"adm0":{"one":"Pays","many":"Pays"},'
  || '"adm1":{"one":"Région","many":"Régions"},'
  || '"adm2":{"one":"District","many":"Districts"},'
  || '"adm3":{"one":"Commune","many":"Communes"},'
  || '"adm4":{"one":"Fokontany","many":"Fokontany"}}')::jsonb,
  -18.9, 47.5, 1,
  '23 régions, 119 districts, environ 1 700 communes et 18 000 fokontany.');

-- Les millésimes déjà chargés décrivent Madagascar : c'est le seul pays servi.
UPDATE geo_version SET country = 'MDG' WHERE country IS NULL;
