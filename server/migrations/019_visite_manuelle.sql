-- =====================================================================
--  La visite saisie à la main devient une exception justifiée  (lot A)
--
--  La demande, mot pour mot : « Visite ne devrais pas etre saisie que dans le
--  cas echeant ou il y a eu une visite mais qu un formulaire n a pas ete
--  remplie et meme si c est le cas il faudrait expliquer pourquoi. »
--
--  Autrement dit : la voie normale d'une visite est le formulaire ODK, qui la
--  date, la situe et la rattache à une soumission conservée (migration 017). La
--  saisie à la main reste indispensable — réseau coupé, appareil à plat, visite
--  antérieure au déploiement du formulaire — mais elle est un RATTRAPAGE, et un
--  rattrapage se justifie. D'où quatre colonnes : d'où vient la visite, pourquoi
--  elle a été saisie, ce que la personne a voulu préciser, et qui l'a saisie.
--
--  ── La reprise dit franchement qu'elle ne sait pas ───────────────────
--  Les visites déjà en base portent un `submission_id` ou non : c'est le seul
--  indice de provenance dont on dispose, et il suffit à trancher `origin`. Le
--  MOTIF, lui, n'existe nulle part — personne ne connaît la raison des lignes
--  saisies avant cette règle. Elles reçoivent donc `inconnu_anterieur`, qui dit
--  exactement cela. Leur attribuer un motif plausible (« formulaire non rempli »,
--  qui serait vrai neuf fois sur dix) fabriquerait une explication que personne
--  n'a donnée, et la rendrait indiscernable d'un motif réellement choisi. Ce
--  motif est le seul de la liste que le client ne peut jamais envoyer
--  (`saisissable:false` dans lib/visites.js) : il documente le passé, il n'ouvre
--  pas une case fourre-tout pour l'avenir.
--
--  ── Cette colonne ne protège rien à elle seule ───────────────────────
--  `origin` sert à distinguer et à afficher, pas à garder. Ce qui effaçait la
--  preuve de terrain, c'était la ROUTE : PUT /api/sites/:id/months supprimait
--  « une » visite du mois quand on décochait la case, sans regarder d'où elle
--  venait — donc y compris une visite issue d'ODK portant un `submission_id`.
--  La garde vit désormais dans la clause WHERE de ce DELETE
--  (`AND origin='manuelle' AND submission_id IS NULL`), doublée d'un contrôle
--  préalable qui permet de DIRE pourquoi c'est refusé. Même doctrine qu'à la
--  ligne 122 de la migration 017 : une garantie qui ne tient qu'à un SELECT
--  préalable se perd à la première exécution concurrente.
--
--  ── L'ordre des instructions est imposé, et vérifié à l'exécution ────
--  SQLite REVALIDE les lignes existantes lors d'un ADD COLUMN porteur d'un
--  CHECK : ajouter `manual_note` avant l'UPDATE de reprise échoue avec
--  « CHECK constraint failed », et le migrateur (db.js) enveloppant chaque
--  fichier dans une transaction, l'échec bloquerait le démarrage du serveur.
--  D'où : origin (son défaut satisfait son propre CHECK) → manual_reason →
--  created_by → reprise → et EN DERNIER manual_note, porteuse de la règle de
--  paire. Cette règle ne peut se poser qu'ainsi : SQLite n'accepte pas de CHECK
--  de table sans reconstruire la table entière.
--
--  ── Ce que ce schéma ne contraint délibérément pas ───────────────────
--  1. Aucun CHECK sur la VALEUR du motif. La liste vit dans lib/visites.js, où
--     elle est écrite, servie au client et testée ; la recopier ici en ferait une
--     seconde source de vérité, qui dériverait au premier ajout. C'est le choix
--     déjà tranché en 017 pour `resolution_passe`.
--  2. Aucun CHECK « origin='odk' ⇒ submission_id NOT NULL » : `submission_id`
--     est en ON DELETE SET NULL vers `submissions`, et supprimer une soumission
--     ferait alors échouer l'action de clé étrangère au lieu de simplement
--     délier. C'est aussi pourquoi la garde de la route regarde les DEUX
--     colonnes : une visite venue du terrain peut perdre son identifiant de
--     soumission, elle ne redevient pas pour autant effaçable.
--  3. Aucun index unique (site_id, mois) WHERE origin='manuelle', bien qu'il
--     porterait « une seule visite manuelle par site et par mois » au niveau de
--     la base. Il refuserait de se créer sur toute base ayant déjà accumulé deux
--     visites le même mois, transformant une migration en échec de déploiement
--     pour une règle qu'aucun chemin observé ne viole. Le contrôle préalable de
--     la route, déjà en place, reste le garde-fou.
-- =====================================================================

-- (1) Le défaut satisfait le CHECK, donc la revalidation des lignes existantes
-- passe. 'manuelle' plutôt que 'odk' : c'est la valeur la plus prudente, elle
-- n'affirme aucune provenance qu'une soumission ne soutienne.
ALTER TABLE visits ADD COLUMN origin TEXT NOT NULL DEFAULT 'manuelle'
  CHECK (origin IN ('odk','manuelle'));

-- (2) Le motif, pris dans la liste fermée de lib/visites.js.
ALTER TABLE visits ADD COLUMN manual_reason TEXT;

-- (3) Qui a saisi. Sans DEFAUT : SQLite n'accepte une clause REFERENCES en ADD
-- COLUMN que si le défaut est NULL. ON DELETE SET NULL parce qu'un compte
-- désactivé puis supprimé ne doit pas emporter la visite qu'il a enregistrée —
-- le journal d'audit, lui, garde le libellé lisible de son auteur.
ALTER TABLE visits ADD COLUMN created_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- (4) Reprise de l'existant, avant que le CHECK de paire ne se pose.
UPDATE visits SET
  origin = CASE WHEN submission_id IS NOT NULL THEN 'odk' ELSE 'manuelle' END,
  manual_reason = CASE WHEN submission_id IS NULL THEN 'inconnu_anterieur' END;

-- (5) EN DERNIER : la note libre, porteuse de la règle de paire « une visite
-- manuelle porte toujours un motif ». Obligatoire pour le motif « autre », mais
-- cela se juge sur la liste applicative, donc dans zod (lib/validate.js) — le
-- schéma ne connaît pas les valeurs des motifs, seulement leur présence.
ALTER TABLE visits ADD COLUMN manual_note TEXT
  CHECK (origin <> 'manuelle' OR manual_reason IS NOT NULL);

-- Distinguer les visites manuelles des visites issues d'ODK est le geste de
-- l'écran de suivi de processus, qui filtre sur l'origine par bureau.
CREATE INDEX idx_visits_origin ON visits(origin);
