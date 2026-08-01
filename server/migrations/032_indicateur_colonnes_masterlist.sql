-- =====================================================================
--  L'indicateur porte plus de colonnes de la masterlist
--
--  Demande du propriétaire : montrer, par sous-groupe, les colonnes réelles du
--  classeur du PAM (« tu peux adapter les noms ») —
--    · Outcome     : statut, applicabilité, activity tag, exigence de report,
--                    catégories ;
--    · Output      : + « output ou other output », valeur de suivi reportée ;
--    · Detailed    : indicateur détaillé et intermédiaire, unité et son
--                    interprétation, flexibilité (obligatoire/optionnel) ;
--    · Cross cutting, SDGs.
--
--  Ces colonnes existent déjà, sheet par sheet, dans la masterlist ; il fallait
--  les extraire et leur donner une place. On en ajoute huit, toutes en TEXT et
--  toutes facultatives — un onglet qui ne porte pas l'une d'elles la laisse
--  vide, et le seed ne l'impose pas. Le `level` accepte désormais la valeur
--  « sdg » (Annex 1), un cinquième sous-groupe ; la colonne est du TEXT sans
--  contrainte, c'est l'énumération de routes/collections.js qui fait foi.
-- =====================================================================

ALTER TABLE indicators ADD COLUMN status        TEXT;  -- statut brut (Active/Inactive/…)
ALTER TABLE indicators ADD COLUMN applicability TEXT;  -- Applicability / Application of Indicator
ALTER TABLE indicators ADD COLUMN reporting_req TEXT;  -- exigence de report (CSP logframe / NBP-OOP)
ALTER TABLE indicators ADD COLUMN output_type   TEXT;  -- « Output or Other Output »
ALTER TABLE indicators ADD COLUMN unit_interp   TEXT;  -- interprétation de l'unité (other output)
ALTER TABLE indicators ADD COLUMN flexibility   TEXT;  -- Mandatory / Optional (detailed)
ALTER TABLE indicators ADD COLUMN follow_value  TEXT;  -- valeurs de suivi reportées (DR / completion)
ALTER TABLE indicators ADD COLUMN intermediate  TEXT;  -- indicateur intermédiaire (detailed)
