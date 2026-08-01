-- =====================================================================
--  Listes paramétrables TYPÉES  (chantier S8, points 1 et 2)
--
--  Le propriétaire : « J'aurai besoin des listes à paramétrer par types
--  (activité, denrées, tiers, partenaire, type de partenariat, etc.) en
--  sous-groupe sélectionnable à gauche et à droite la configuration des
--  listes (ajout, modification, suppression, validation). »
--
--  ── Ce qui existait déjà, et qu'on ne duplique pas ───────────────────
--  Quatre de ces listes SONT DÉJÀ des tables réelles, référencées par
--  clé étrangère : `activity_categories` (les activités, migration 025),
--  `partners`, `poi_subtypes` et `tpm` (les tiers). Les recopier dans une
--  table générique aurait créé deux vérités pour la même liste — la
--  faute que l'étoile polaire S4 nomme explicitement. Elles restent donc
--  où elles sont ; c'est le REGISTRE (server/src/lib/listes.js) qui les
--  présente sous une forme commune, table native ou non.
--
--  ── Ce qui manquait : les listes sans table ──────────────────────────
--  Les denrées, les modalités, les types de partenariat, les types de
--  site, les types de suivi, les durées et les domaines programme
--  n'existaient QUE comme constantes du navigateur
--  (`web/src/lib/constants.js`, `PDD_COMMODITIES`, `SITE_TYPES`…) : rien
--  ne les stockait, donc rien ne pouvait les paramétrer. `list_item` leur
--  donne une table, une par type, discriminées par la colonne `type`.
--
--  Une table générique plutôt que sept tables : ces listes portent
--  exactement les mêmes colonnes (un code, un libellé, un ordre, un
--  drapeau actif, une note), aucune n'a de colonne propre, et aucune
--  n'est cible d'une clé étrangère. Sept tables identiques auraient
--  demandé sept routes, sept écrans et sept jeux de tests pour la même
--  chose.
--
--  ── LE CODE EST CE QUE PORTENT LES TABLES FILLES ─────────────────────
--  Décision structurante, et elle explique les valeurs semées plus bas :
--  le `code` d'un item n'est pas un identifiant inventé, c'est LA VALEUR
--  QUE LES COLONNES FILLES CONTIENNENT DÉJÀ. `pdd.commodity` contient
--  « Riz », `sites.site_type` contient « School », `pdd.modality`
--  contient « Food ». Le code d'une denrée est donc « Riz », celui d'un
--  type de site « School ». C'est ce qui rend le comptage d'usage exact
--  et le renommage en cascade (point 3 du chantier) possible : renommer
--  le code, c'est réécrire ces colonnes-là, et il faut qu'elles portent
--  bien le code.
--
--  ── La contrainte d'énumération de `pdd.modality` ────────────────────
--  `modality TEXT NOT NULL CHECK (modality IN ('Food','Cash','Voucher'))`
--  (001_init.sql:248) enferme la modalité dans trois valeurs écrites dans
--  le schéma. Deux raisons de la lever : une liste PARAMÉTRABLE dont le
--  schéma refuse toute valeur nouvelle n'est pas paramétrable ; et les
--  fichiers réels du bureau portent déjà une modalité « hybride » que
--  cette énumération rejette (constat consigné au chantier T). La liste
--  des modalités devient donc la table ci-dessous, et le contrôle se fait
--  là où il se corrige. SQLite ne sait pas retirer un CHECK par ALTER :
--  la table est reconstruite à l'identique, colonne pour colonne, index
--  pour index — c'est la seule différence.
-- =====================================================================

-- ── La table des listes sans table propre ────────────────────────────
CREATE TABLE list_item (
  id         TEXT PRIMARY KEY,
  -- Le type de liste : 'denree', 'modalite', 'type_partenariat'… Il est
  -- déclaré dans le registre (lib/listes.js), pas contraint ici : ajouter
  -- un type ne doit pas demander une migration.
  type       TEXT NOT NULL,
  -- Le code d'identification. C'est la clé de jointure : les tables
  -- filles le portent, et il est préservé par les mises à jour ordinaires.
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  note       TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  -- Verrouillage optimiste, comme les bureaux et les activités : deux
  -- administrateurs sur la même ligne ne s'écrasent pas en silence.
  rev        INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
-- Un code par type, un libellé par type. Insensible à la casse pour le
-- libellé : « Riz » et « riz » sont la même denrée pour qui la saisit.
CREATE UNIQUE INDEX idx_list_item_code  ON list_item(type, code);
CREATE UNIQUE INDEX idx_list_item_label ON list_item(type, label COLLATE NOCASE);
CREATE INDEX        idx_list_item_type  ON list_item(type, sort_order, label);

-- ── La VALIDATION d'une liste ────────────────────────────────────────
-- Le quatrième geste demandé (« ajout, modification, suppression,
-- validation ») n'est pas la validation d'un formulaire — celle-là est
-- déjà faite par Zod à chaque écriture. C'est la validation de la LISTE :
-- quelqu'un l'a relue, elle est bonne, et cela se voit. Toute écriture
-- sur un item du type efface la validation : une liste modifiée après sa
-- relecture n'est plus une liste relue.
CREATE TABLE list_validation (
  type        TEXT PRIMARY KEY,
  validated_at TEXT NOT NULL DEFAULT (datetime('now')),
  validated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  user_label  TEXT,
  items       INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

-- ── Les partenaires deviennent une liste comme les autres ────────────
-- `partners` n'avait que (id, name, active) : aucun code d'identification,
-- donc aucune clé de jointure stable, et aucune révision, donc aucun
-- verrou optimiste. Les deux manquaient pour que la liste se paramètre
-- comme les autres.
ALTER TABLE partners ADD COLUMN code             TEXT;
ALTER TABLE partners ADD COLUMN partnership_type TEXT;   -- code d'un list_item 'type_partenariat'
ALTER TABLE partners ADD COLUMN note             TEXT;
ALTER TABLE partners ADD COLUMN rev              INTEGER NOT NULL DEFAULT 1;
ALTER TABLE partners ADD COLUMN updated_at       TEXT;
-- Index PARTIEL : les partenaires déjà semés n'ont pas de code, et deux
-- NULL ne se heurtent pas en SQLite — mais l'index partiel dit la règle
-- pour de bon, plutôt que de compter sur ce comportement.
CREATE UNIQUE INDEX idx_partners_code ON partners(code) WHERE code IS NOT NULL;

-- ── Les sous-types de point d'intérêt aussi ──────────────────────────
ALTER TABLE poi_subtypes ADD COLUMN active     INTEGER NOT NULL DEFAULT 1;
ALTER TABLE poi_subtypes ADD COLUMN rev        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE poi_subtypes ADD COLUMN updated_at TEXT;

-- ── Le plan de distribution, sans l'énumération de modalité ──────────
-- Reconstruction à l'identique : mêmes colonnes, mêmes types, mêmes
-- défauts, mêmes CHECK — sauf celui de `modality`, qui passe à la table
-- des modalités. Aucune table ne référence `pdd` : le renommage ne casse
-- aucune clé étrangère.
CREATE TABLE pdd_nouveau (
  id             TEXT PRIMARY KEY,
  year           INTEGER NOT NULL,
  month          INTEGER NOT NULL CHECK (month BETWEEN 0 AND 11),
  wbs            TEXT,
  act_type       TEXT NOT NULL,
  activity_tag   TEXT,
  act_main       TEXT,
  office_id      TEXT REFERENCES offices(id) ON DELETE SET NULL,
  bureau         TEXT NOT NULL,
  region         TEXT, district TEXT, commune TEXT,
  partner_id     TEXT REFERENCES partners(id) ON DELETE SET NULL,
  -- Plus de CHECK : la liste des modalités se paramètre (list_item).
  modality       TEXT NOT NULL DEFAULT 'Food',
  commodity      TEXT,
  days           INTEGER NOT NULL DEFAULT 0 CHECK (days >= 0),
  benef_planned  INTEGER NOT NULL DEFAULT 0 CHECK (benef_planned >= 0),
  households     INTEGER NOT NULL DEFAULT 0 CHECK (households >= 0),
  tonnage        REAL    NOT NULL DEFAULT 0 CHECK (tonnage >= 0),
  amount         REAL    NOT NULL DEFAULT 0 CHECK (amount  >= 0),
  benef_actual   INTEGER NOT NULL DEFAULT 0 CHECK (benef_actual >= 0),
  received       REAL    NOT NULL DEFAULT 0 CHECK (received    >= 0),
  distributed    REAL    NOT NULL DEFAULT 0 CHECK (distributed >= 0),
  status         TEXT NOT NULL DEFAULT 'planned'
      CHECK (status IN ('planned','ongoing','done','cancelled')),
  note           TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  geo_pcode      TEXT,
  rev            INTEGER NOT NULL DEFAULT 1
);
INSERT INTO pdd_nouveau (id,year,month,wbs,act_type,activity_tag,act_main,office_id,bureau,
  region,district,commune,partner_id,modality,commodity,days,benef_planned,households,
  tonnage,amount,benef_actual,received,distributed,status,note,updated_at,geo_pcode,rev)
SELECT id,year,month,wbs,act_type,activity_tag,act_main,office_id,bureau,
  region,district,commune,partner_id,modality,commodity,days,benef_planned,households,
  tonnage,amount,benef_actual,received,distributed,status,note,updated_at,geo_pcode,rev
FROM pdd;
DROP TABLE pdd;
ALTER TABLE pdd_nouveau RENAME TO pdd;
CREATE INDEX idx_pdd_period    ON pdd(year, month);
CREATE INDEX idx_pdd_bureau    ON pdd(bureau);
CREATE INDEX idx_pdd_geo_pcode ON pdd(geo_pcode);

-- ── Les valeurs de départ : ce que les écrans employaient déjà ───────
-- Chaque code est la valeur réellement portée par la colonne fille, pour
-- que le comptage d'usage soit exact dès la première ouverture de l'écran.
-- Les libellés sont en français, les codes non : ce sont des données.

-- Denrées — `pdd.commodity` (web/src/views/Planning.jsx, PDD_COMMODITIES)
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_den_01','denree','Riz','Riz',1),
  ('li_den_02','denree','Sorgho','Sorgho',2),
  ('li_den_03','denree','Maïs concassé','Maïs concassé',3),
  ('li_den_04','denree','Maïs en grain','Maïs en grain',4),
  ('li_den_05','denree','Légumineuses','Légumineuses',5),
  ('li_den_06','denree','Huile','Huile',6),
  ('li_den_07','denree','Super Cereal CSB+','Super Cereal CSB+',7),
  ('li_den_08','denree','Super Cereal CSB++','Super Cereal CSB++',8),
  ('li_den_09','denree','LNS-mq/Plumpy Doz','LNS-mq/Plumpy Doz',9),
  ('li_den_10','denree','LNS-sq/Nutributter','LNS-sq/Nutributter',10),
  ('li_den_11','denree','Plumpy Sup','Plumpy Sup',11),
  ('li_den_12','denree','Dattes','Dattes',12);

-- Modalités — `pdd.modality` et `sites.modality`. Les trois premières
-- sont celles que l'énumération levée plus haut autorisait ; les deux
-- suivantes existent dans les données réelles et étaient refusées.
INSERT INTO list_item (id,type,code,label,sort_order,note) VALUES
  ('li_mod_01','modalite','Food','Vivres en nature',1,NULL),
  ('li_mod_02','modalite','Cash','Transfert monétaire',2,NULL),
  ('li_mod_03','modalite','Voucher','Coupons',3,NULL),
  ('li_mod_04','modalite','Capacity Strengthening','Renforcement de capacités',4,NULL),
  ('li_mod_05','modalite','Mix','Modalité mixte (hybride)',5,
   'Présente dans les plans de distribution réels ; refusée par l''ancienne énumération du schéma.');

-- Types de partenariat — `partners.partnership_type`
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_tpa_01','type_partenariat','ONG_INT','ONG internationale',1),
  ('li_tpa_02','type_partenariat','ONG_NAT','ONG nationale',2),
  ('li_tpa_03','type_partenariat','GOUV','Gouvernement / service technique',3),
  ('li_tpa_04','type_partenariat','ONU','Agence des Nations unies',4),
  ('li_tpa_05','type_partenariat','OSC','Organisation communautaire',5),
  ('li_tpa_06','type_partenariat','PRIVE','Secteur privé',6);

-- Types de site — `sites.site_type` (SITE_TYPES)
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_tsi_01','type_site','FDP','Point de distribution',1),
  ('li_tsi_02','type_site','Health Center','Formation sanitaire',2),
  ('li_tsi_03','type_site','School','École',3),
  ('li_tsi_04','type_site','Warehouse','Entrepôt',4),
  ('li_tsi_05','type_site','Market','Marché',5),
  ('li_tsi_06','type_site','Community site','Site communautaire',6),
  ('li_tsi_07','type_site','Other (smallholder farmers, communities)','Autre (petits producteurs, communautés)',7);

-- Types de suivi — `sites.monitoring_type` (MONITORING_TYPES)
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_tsu_01','type_suivi','Distribution monitoring','Suivi de distribution',1),
  ('li_tsu_02','type_suivi','Activity Implementation Monitoring','Suivi de mise en œuvre',2),
  ('li_tsu_03','type_suivi','Post-distribution monitoring','Suivi post-distribution',3),
  ('li_tsu_04','type_suivi','Outcome monitoring','Suivi des résultats',4);

-- Durées d'intervention — `sites.duration` (DURATIONS)
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_dur_01','duree','Under 3 months','Moins de 3 mois',1),
  ('li_dur_02','duree','3-6 months','3 à 6 mois',2),
  ('li_dur_03','duree','6-12 months','6 à 12 mois',3),
  ('li_dur_04','duree','Over 12 months','Plus de 12 mois',4);

-- Domaines programme — `sites.program_area` et
-- `activity_categories.program_area` (PROG_AREAS)
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_dom_01','domaine','Unconditional Resource Transfers (URT)','Transferts de ressources non conditionnels',1),
  ('li_dom_02','domaine','Asset Creation and Livelihood (ACL)','Création d''actifs et moyens d''existence',2),
  ('li_dom_03','domaine','Action to protect against climate shocks','Protection contre les chocs climatiques',3),
  ('li_dom_04','domaine','School based programmes (SMP)','Programmes en milieu scolaire',4),
  ('li_dom_05','domaine','Malnutrition treatment programme (NTA)','Traitement de la malnutrition',5),
  ('li_dom_06','domaine','Malnutrition prevention programme (NPA)','Prévention de la malnutrition',6),
  ('li_dom_07','domaine','Smallholder agricultural market support (SAMS)','Appui aux marchés des petits producteurs',7);
