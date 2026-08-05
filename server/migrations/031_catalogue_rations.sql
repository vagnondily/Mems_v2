-- =====================================================================
--  Catalogue de rations — « les rations ne se codent pas, elles se cataloguent »
--
--  (Chantier R, docs/A_FAIRE.md ; demande du 01/08/2026 : « L'onglet ration
--  ne suit pas mes directives » et « pourquoi ne pas combiner la configuration
--  des rations et la création de denrée pour faire en une fois ».)
--
--  L'ancien onglet Rations était une MATRICE (settings.rationTable) : activité
--  × denrée → grammage, un seul chiffre par case, sans nom, sans note, sans
--  révision. Elle ne pouvait pas porter deux conventions concurrentes pour la
--  même activité (« GD standard » et « GD demi-ration »), ni tracer d'où sort
--  un grammage.
--
--  La demande, reformulée : « une ration, une ligne ». Un catalogue de
--  conventions — chaque ligne est un libellé (« GD standard », « Stunting FEFA
--  AMB jan-2023 »…), UNE denrée, un grammage par personne et par jour, une
--  activité par défaut facultative, une note. Une convention composée (riz 400
--  + légumineuses 60 + huile 35) est donc PLUSIEURS lignes partageant le même
--  libellé. CRUD complet, révisions comme partout.
--
--  `commodity` porte le CODE d'une denrée (list_item type « denree ») — la même
--  valeur que `pdd.commodity`. Le registre des listes typées (lib/listes.js) y
--  attache un lien : renommer une denrée réécrit ce catalogue en cascade, et on
--  ne supprime pas une denrée qu'une convention utilise encore.
--
--  Le tonnage se calcule à l'usage (PDD), jamais stocké ici :
--     tonnage = ration (g/pers/j) × jours × effectif ÷ 1 000 000.
-- =====================================================================

CREATE TABLE ration_catalog (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,                         -- libellé de la convention
  commodity    TEXT NOT NULL,                         -- code denrée (= pdd.commodity)
  grams        REAL NOT NULL DEFAULT 0,               -- grammes / personne / jour
  activity_tag TEXT,                                  -- activité par défaut (facultative)
  note         TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  rev          INTEGER NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_ration_catalog_commodity ON ration_catalog(commodity);
CREATE INDEX ix_ration_catalog_activity  ON ration_catalog(activity_tag);

-- ── Première charge : les conventions officielles lues dans les deux PDD ──
--  (docs/A_FAIRE.md, tableau « Rations officielles »). Une convention composée
--  est PLUSIEURS lignes de même libellé. Le grammage est en g/pers/jour ; les
--  jours typiques et la modalité espèces vivent dans la note, car les jours se
--  saisissent au PDD (ils changent d'une livraison à l'autre). Les codes de
--  denrée reprennent EXACTEMENT ceux de la liste « denree » (migration 026).
INSERT INTO ration_catalog (id, label, commodity, grams, activity_tag, note, sort_order) VALUES
  ('rc_gd_riz',   'GD / GFD standard (ménage ×5)', 'Riz',            400, 'GD',   '30 j (demi-ration : 15 j). Espèces : 120 000 Ar/ménage (150 000 cyclone 2023).', 10),
  ('rc_gd_leg',   'GD / GFD standard (ménage ×5)', 'Légumineuses',    60, 'GD',   '30 j (demi-ration : 15 j).', 11),
  ('rc_gd_hui',   'GD / GFD standard (ménage ×5)', 'Huile',           35, 'GD',   '30 j (demi-ration : 15 j).', 12),
  ('rc_hh_riz',   'HH protection',                 'Riz',            400, 'GD',   '30 j.', 20),
  ('rc_hh_leg',   'HH protection',                 'Légumineuses',    60, 'GD',   '30 j.', 21),
  ('rc_drr_riz',  'DRR',                           'Riz',            400, 'FFA',  '20 j.', 30),
  ('rc_drr_leg',  'DRR',                           'Légumineuses',    60, 'FFA',  '20 j.', 31),
  ('rc_ffa_riz',  'FFA / Résilience (ménage ×5)',  'Riz',            400, 'FFA',  '20 j. Espèces : 60 000 Ar (2023) · 120 000 Ar / 30 j (CAR 2024).', 40),
  ('rc_ffa_leg',  'FFA / Résilience (ménage ×5)',  'Légumineuses',    60, 'FFA',  '20 j.', 41),
  ('rc_ffa_hui',  'FFA / Résilience (ménage ×5)',  'Huile',           35, 'FFA',  '20 j.', 42),
  ('rc_mam_psup', 'MAM traitement (Plumpy Sup)',   'Plumpy Sup',     100, 'MAM',  '30 j (2024 : 30/60/90).', 50),
  ('rc_mam_csbpp','MAM traitement (CSB++)',        'Super Cereal CSB++', 200, 'MAM', '30 j.', 55),
  ('rc_prev_pdoz','PREVMA / MIARO enfants (Plumpy Doz)', 'LNS-mq/Plumpy Doz', 50, 'PREV', '30 j (90 trimestriel, 120 urgence).', 60),
  ('rc_prevf_hui','PREVMA FEFA',                   'Huile',           20, 'PREV', '30 j.', 65),
  ('rc_prevf_csb','PREVMA FEFA',                   'Super Cereal CSB+', 200, 'PREV', '30 j.', 66),
  ('rc_pec_hui',  'PEC FEFA',                      'Huile',           25, 'MAM',  '30 j.', 70),
  ('rc_pec_csb',  'PEC FEFA',                      'Super Cereal CSB+', 250, 'MAM', '30 j.', 71),
  ('rc_hiv_hui',  'HIV / TB',                      'Huile',           20, NULL,   '30 j. Espèces : 100 000 Ar.', 80),
  ('rc_hiv_csb',  'HIV / TB',                      'Super Cereal CSB+', 200, NULL, '30 j.', 81),
  ('rc_stu_pdoz', 'Stunting enfant (NPA)',         'LNS-mq/Plumpy Doz', 50, 'STUN', '30 j. Espèces : 21 000 Ar/enfant/mois.', 90),
  ('rc_stu_lns',  'Stunting enfant (NPA) — variante LNS 2023', 'LNS-sq/Nutributter', 20, 'STUN', '30 j. Variante datée 2023.', 91),
  ('rc_stuf_hui', 'Stunting FEFA',                 'Huile',           20, 'STUN', '30 j. Espèces : 60 000 Ar/mois.', 95),
  ('rc_stuf_csb', 'Stunting FEFA',                 'Super Cereal CSB+', 200, 'STUN', '30 j.', 96),
  ('rc_smp_riz',  'SMP cantines',                  'Riz',            140, NULL,   '60 j/trimestre. Espèces : 315 Ar/élève/j (2023) · 22 088 Ar/période (2024).', 100),
  ('rc_smp_leg',  'SMP cantines',                  'Légumineuses',    30, NULL,   '60 j/trimestre (13 j si cantine hybride).', 101),
  ('rc_smp_hui',  'SMP cantines',                  'Huile',           10, NULL,   '60 j/trimestre.', 102);
