-- =====================================================================
--  Suivi tiers — le PÉRIMÈTRE GÉOGRAPHIQUE du contrat
--
--  Demande : « le contrat définit les communes éligibles ; les plans y
--  puisent ». Jusqu'ici une zone de plan (tpm_zone) pouvait viser n'importe
--  quelle unité du référentiel courant — rien n'attachait un prestataire aux
--  communes que son contrat lui confie. C'est pourtant au niveau du contrat que
--  le périmètre se décide, une fois, à sa conception ; les plans mensuels n'y
--  puisent ensuite que ce qui leur est ouvert.
--
--  Cette table porte ce périmètre : les unités administratives éligibles d'un
--  contrat. On l'assigne à la maille que l'on veut — une COMMUNE (adm3) pour un
--  périmètre fin, un DISTRICT (adm2) pour confier tout un district d'un coup.
--  Une zone de plan est alors admise si son pcode, ou l'un de ses ancêtres dans
--  le chemin (geo_unit.path), figure dans ce périmètre : assigner un district
--  ouvre donc toutes ses communes, sans avoir à les énumérer.
--
--  Périmètre VIDE = aucune restriction : un contrat qui n'a pas encore déclaré
--  ses zones n'empêche pas de travailler, il ne borne simplement rien. La
--  contrainte n'apparaît qu'une fois le périmètre défini — c'est un choix de
--  conception du contrat, pas une étape obligatoire imposée d'office.
--
--  Le pcode est stocké NU (sans version géographique) : le référentiel se
--  remillésime, les pcodes officiels survivent d'un millésime à l'autre, et
--  attacher le périmètre à un millésime précis le ferait disparaître au premier
--  redécoupage. Le nom et le niveau sont résolus à l'affichage contre le
--  référentiel courant. C'est la même règle que tpm_zone.geo_pcode.
-- =====================================================================

CREATE TABLE tpm_contract_zone (
  contract_id text NOT NULL REFERENCES tpm_contract(id) ON DELETE CASCADE,
  geo_pcode   text NOT NULL,
  PRIMARY KEY (contract_id, geo_pcode)
);
CREATE INDEX idx_tpm_contract_zone_c ON tpm_contract_zone(contract_id);
