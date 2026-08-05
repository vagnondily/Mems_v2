-- =====================================================================
--  Géométries administratives — le fond de carte
--
--  Le référentiel ne portait que des POINTS : chaque unité avait un couple
--  lat/lon, et la cartographie projetait des cercles sur un fond vide. On voyait
--  donc où sont les sites, mais pas dans quoi. Une commune non couverte
--  n'apparaissait nulle part — c'est un vide, et un vide ne se dessine pas avec
--  des points.
--
--  Ce qui manquait sont les CONTOURS. Avec eux, la carte peut répondre aux
--  questions que le module de ciblage pose déjà en tableau : quelles communes
--  sont couvertes, où le taux de ciblage est faible, quelle zone un prestataire
--  couvre ce mois-ci. Un aplat par unité, et la question se lit d'un coup d'œil.
--
--  Trois décisions structurent cette table.
--
--  1. GeoJSON en JSON natif (jsonb), pas une extension spatiale. PostGIS existe,
--     mais l'application n'a aucun besoin de calcul géométrique : elle a besoin
--     de DESSINER. Stocker le contour prêt à servir évite une dépendance native,
--     et le rendu se fait dans le navigateur. `geometry`/`simple` sont typées
--     jsonb (et non text) parce que le code applicatif les manipule déjà comme
--     du JSON (JSON.stringify à l'écriture, JSON.parse à la lecture) — jsonb
--     reste un simple format de stockage, pas une extension géospatiale.
--
--  2. Deux résolutions. Madagascar compte près de 18 000 fokontany ; leurs
--     contours en pleine résolution pèsent des dizaines de mégaoctets et aucun
--     navigateur ne les affiche utilement à l'échelle du pays. On stocke donc une
--     version simplifiée pour la vue d'ensemble et la version fine pour le zoom.
--     Sans cette distinction, la carte serait soit fausse, soit inutilisable.
--
--  3. Le cadre englobant (`bbox`) est stocké, pas recalculé. Cadrer la carte sur
--     une région suppose de connaître son étendue ; la déduire à chaque requête
--     obligerait à parcourir tous les points de tous les contours affichés.
-- =====================================================================

CREATE TABLE geo_geom (
  pcode       text NOT NULL,
  version_id  text NOT NULL REFERENCES geo_version(id) ON DELETE CASCADE,
  level       text NOT NULL,

  -- La géométrie GeoJSON : { "type":"Polygon"|"MultiPolygon", "coordinates":[…] }.
  -- `simple` est la même, réduite par Douglas-Peucker à l'import.
  geometry    jsonb NOT NULL,
  simple      jsonb,

  -- Cadre englobant, en degrés : ouest, sud, est, nord.
  min_lon     double precision, min_lat double precision, max_lon double precision, max_lat double precision,
  -- Nombre de sommets conservés, pour mesurer ce que la simplification a coûté.
  points      integer NOT NULL DEFAULT 0,
  points_simple integer NOT NULL DEFAULT 0,

  PRIMARY KEY (pcode, version_id)
);
-- La requête normale est « les contours de ce niveau, sous ce parent » : c'est
-- l'index qui doit la servir.
CREATE INDEX idx_geo_geom_niveau ON geo_geom(version_id, level);

-- Le millésime se souvient s'il porte des contours, et combien : l'écran de
-- configuration doit pouvoir le dire sans compter 18 000 lignes à chaque affichage.
ALTER TABLE geo_version ADD COLUMN geom_units integer NOT NULL DEFAULT 0;
ALTER TABLE geo_version ADD COLUMN geom_source text;
ALTER TABLE geo_version ADD COLUMN geom_at timestamptz;
