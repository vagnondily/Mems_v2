-- =====================================================================
--  Configuration des bureaux — et le cas du bureau pays
--
--  Deux manques constatés :
--
--  1. La table `offices` n'avait que le strict nécessaire (nom, code, nature)
--     et AUCUNE route d'écriture. L'écran « Paramètres → Général » proposait
--     bien de modifier la liste des bureaux, mais écrivait dans `db.lists.offices`,
--     une liste de chaînes qui n'était pas synchronisée : la saisie était perdue
--     au rechargement. Même famille de défaut que le panneau API corrigé plus tôt —
--     une option qui a l'air de fonctionner et ne fait rien.
--
--  2. Le périmètre géographique (migration 007) borne tout compte de terrain aux
--     unités attribuées à son bureau. C'est la bonne règle pour une antenne, mais
--     le bureau pays a des staffs rattachés à Tana qui doivent voir TOUS les sites.
--     Les rendre administrateurs serait la mauvaise réponse : cela leur donnerait
--     aussi le droit de gérer les comptes. Le rôle et le périmètre sont deux axes
--     distincts, il faut donc régler le périmètre sans toucher au rôle.
--
--  D'où `scope_mode`, porté par le BUREAU et non par le compte :
--
--      'geo'      le périmètre est celui déclaré pour le bureau (défaut)
--      'national' le bureau couvre tout le pays, quel que soit le rôle du compte
--
--  Le mettre sur le bureau plutôt que sur l'utilisateur évite de le répéter sur
--  chaque compte, et de le voir diverger d'un compte à l'autre au fil des arrivées.
--
--  SQLite n'accepte pas d'ajouter une contrainte CHECK par ALTER TABLE : la valeur
--  est validée à l'écriture (Zod côté route) et le repli est sûr — toute valeur
--  inattendue est traitée comme 'geo', c'est-à-dire le périmètre le plus restreint.
-- =====================================================================

ALTER TABLE offices ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'geo';

-- Configuration proprement dite : de quoi décrire un bureau sans passer par une
-- liste de noms. `antennes` est un tableau JSON — les antennes ne sont pas des
-- bureaux (pas de comptes, pas de périmètre propre), seulement des lieux de
-- rattachement des visites, et une table entière serait disproportionnée.
ALTER TABLE offices ADD COLUMN antennes   TEXT NOT NULL DEFAULT '[]';
ALTER TABLE offices ADD COLUMN manager    TEXT;
ALTER TABLE offices ADD COLUMN email      TEXT;
ALTER TABLE offices ADD COLUMN phone      TEXT;
ALTER TABLE offices ADD COLUMN lat        REAL;
ALTER TABLE offices ADD COLUMN lon        REAL;
ALTER TABLE offices ADD COLUMN note       TEXT;

-- Verrouillage optimiste, comme les douze autres collections modifiables
-- (migration 006) : deux bureaux modifiés en même temps depuis deux postes se
-- signalent au lieu de s'écraser.
ALTER TABLE offices ADD COLUMN rev        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE offices ADD COLUMN updated_at TEXT;

-- Le bureau pays existant devient national : c'est précisément le cas qui a
-- motivé la colonne, et le laisser en 'geo' priverait ses staffs de la vue
-- d'ensemble dès l'application de cette migration.
UPDATE offices SET scope_mode = 'national' WHERE kind = 'hq';

CREATE INDEX IF NOT EXISTS idx_offices_scope ON offices(scope_mode);
