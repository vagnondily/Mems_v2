-- =====================================================================
--  Les denrées portent un GROUPE ALIMENTAIRE (inspiré de COMET)
--
--  Le formulaire Rations de COMET choisit une commodité dans un arbre par
--  FAMILLE : Cereals & Grains, Oils & Fats, Pulses & Vegetables, Mixed &
--  Blended Foods, Dairy Products, Meat, Fish, Fruit & Nuts, Roots & Tubers,
--  Pre-packaged Food Parcels, Beverages, Miscellaneous. On s'en inspire : une
--  denrée reçoit son groupe alimentaire, et l'écran regroupe les denrées par
--  famille comme le fait COMET.
--
--  Le groupe est lui-même une liste paramétrable (`groupe_denree`), déclarée au
--  registre (lib/listes.js) : on peut en ajouter sans toucher au schéma. La
--  denrée le porte via une colonne `food_group` sur `list_item` — la première
--  colonne « propre à un type » de cette table générique, nullable et ignorée
--  par les listes qui ne s'en servent pas.
-- =====================================================================

ALTER TABLE list_item ADD COLUMN food_group TEXT;

-- Les familles, dans l'ordre de la sélection COMET.
INSERT INTO list_item (id,type,code,label,sort_order) VALUES
  ('li_fg_01','groupe_denree','Cereals & Grains',          'Céréales et grains',1),
  ('li_fg_02','groupe_denree','Pulses & Vegetables',       'Légumineuses et légumes',2),
  ('li_fg_03','groupe_denree','Oils & Fats',               'Huiles et matières grasses',3),
  ('li_fg_04','groupe_denree','Mixed & Blended Foods',     'Aliments composés et enrichis',4),
  ('li_fg_05','groupe_denree','Dairy Products',            'Produits laitiers',5),
  ('li_fg_06','groupe_denree','Meat',                      'Viande',6),
  ('li_fg_07','groupe_denree','Fish',                      'Poisson',7),
  ('li_fg_08','groupe_denree','Fruit & Nuts',              'Fruits et fruits à coque',8),
  ('li_fg_09','groupe_denree','Roots & Tubers',            'Racines et tubercules',9),
  ('li_fg_10','groupe_denree','Pre-packaged Food Parcels', 'Colis alimentaires préemballés',10),
  ('li_fg_11','groupe_denree','Beverages',                 'Boissons',11),
  ('li_fg_12','groupe_denree','Miscellaneous',             'Divers',12);

-- Les douze denrées semées (migration 026) rejoignent leur famille.
UPDATE list_item SET food_group='Cereals & Grains'
  WHERE type='denree' AND code IN ('Riz','Sorgho','Maïs concassé','Maïs en grain');
UPDATE list_item SET food_group='Pulses & Vegetables'  WHERE type='denree' AND code='Légumineuses';
UPDATE list_item SET food_group='Oils & Fats'          WHERE type='denree' AND code='Huile';
UPDATE list_item SET food_group='Mixed & Blended Foods'
  WHERE type='denree' AND code IN ('Super Cereal CSB+','Super Cereal CSB++',
                                   'LNS-mq/Plumpy Doz','LNS-sq/Nutributter','Plumpy Sup');
UPDATE list_item SET food_group='Fruit & Nuts'         WHERE type='denree' AND code='Dattes';
