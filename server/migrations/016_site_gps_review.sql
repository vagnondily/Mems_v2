-- Un site importé/enregistré peut porter des coordonnées éloignées de celles
-- observées sur le terrain par ODK Central. Plutôt que de corriger en silence,
-- l'écart se signale et se laisse vérifier par un administrateur.
ALTER TABLE sites ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sites ADD COLUMN review_note TEXT;
ALTER TABLE sites ADD COLUMN review_distance_km REAL;

-- Le champ GPS d'une source ODK Central varie d'un formulaire à l'autre
-- (HHCoord, HHCoord_DP...), comme site_field et date_field déjà présents.
ALTER TABLE odk_forms ADD COLUMN gps_field TEXT;
