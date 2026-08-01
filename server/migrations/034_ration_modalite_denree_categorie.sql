-- =====================================================================
--  Rations : modalité de transfert + catégorie de denrée (food / cbt / other)
--
--  (Demande du 01/08/2026 : « Pour les denrées mettre la catégorie food ou
--  cbt ou autres et aussi donner la possibilité de créer une ration cash (cbt)
--  ou voucher. Je préfère avoir modalité, denrée, g/pers/jour, activité, note
--  pour les rations. »)
--
--  Deux ajouts, minimaux et réversibles à la lecture :
--
--  1. `ration_catalog.modality` — la MODALITÉ de transfert de la convention.
--     Elle reprend les codes de la liste paramétrable « modalites » déjà semée
--     (migration 026 : Food, Cash, Voucher, Capacity Strengthening, Mix). Le
--     défaut « Food » vaut vivres en nature : toutes les conventions déjà au
--     catalogue restent donc des rations de vivres, sans rien réécrire. C'est
--     elle qui décide de l'unité du grammage à l'écran — grammes pour Food/Mix,
--     montant (Ar) pour Cash/Voucher — sans nouvelle colonne : une ration
--     espèces range son montant/personne/jour dans le même champ.
--
--  2. `list_item.category` — la CATÉGORIE d'une denrée : « food » (vivres),
--     « cbt » (espèces / coupons), « other ». Toutes les denrées existantes
--     sont des vivres. Deux « denrées » CBT rejoignent la liste pour qu'on
--     puisse composer une ration cash ou coupon comme on compose une ration de
--     vivres. La catégorie est elle-même une petite liste paramétrable
--     (`categorie_denree`), déclarée au registre (lib/listes.js).
-- =====================================================================

ALTER TABLE ration_catalog ADD COLUMN modality TEXT NOT NULL DEFAULT 'Food';

ALTER TABLE list_item ADD COLUMN category TEXT;
UPDATE list_item SET category = 'food' WHERE type = 'denree';

-- Les trois catégories, dans l'ordre d'usage.
INSERT INTO list_item (id, type, code, label, sort_order) VALUES
  ('li_dc_food',  'categorie_denree', 'food',  'Vivres (food)',            1),
  ('li_dc_cbt',   'categorie_denree', 'cbt',   'Espèces / Coupons (CBT)',  2),
  ('li_dc_other', 'categorie_denree', 'other', 'Autre',                    3);

-- Deux denrées CBT : la matière d'une ration espèces et d'une ration coupon.
INSERT INTO list_item (id, type, code, label, category, sort_order) VALUES
  ('li_dn_cash',    'denree', 'Espèces', 'Espèces (transfert monétaire)', 'cbt', 40),
  ('li_dn_voucher', 'denree', 'Coupon',  'Coupon-valeur (voucher)',       'cbt', 41);
