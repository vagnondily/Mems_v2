-- =====================================================================
--  Connecteurs et correspondance des variables
--
--  Chaque source de données a jusqu'ici été branchée en écrivant du code :
--  `odk_forms` porte deux champs de rattachement en dur (`site_field`,
--  `date_field`), l'import Excel a ses colonnes figées dans lib/import.js, et
--  la lecture d'un XLSForm ne sert qu'à afficher des libellés. Brancher une
--  cinquième source — un dataset Foundry pour les chiffres de bénéficiaires et
--  de réceptions, un KoboToolbox, un export CSV d'un partenaire — supposait
--  donc de recommencer : lire la source, deviner ses noms de variables, écrire
--  la conversion, la tester. Le même travail, une fois par source, pour toujours.
--
--  Ces deux tables déplacent ce travail du code vers la configuration. Un
--  connecteur dit OÙ lire ; ses correspondances disent QUELLE variable de la
--  source alimente QUEL champ MEMS, et par quelle transformation. Le code
--  d'application, lui, est écrit une seule fois (lib/mapping.js) et sert à
--  toutes les sources — c'est précisément ce qu'on ne veut plus recoder.
--
--  Deux choix qu'il faut expliquer, parce qu'ils se discutent :
--
--  1. `config` est du JSON, pas des colonnes. Ce que chaque nature de source a
--     besoin de savoir n'a rien de commun : un identifiant de projet et de
--     formulaire pour ODK, un RID de dataset et une branche pour Foundry, un
--     chemin et un pointeur JSON pour une API HTTP quelconque. Une colonne par
--     besoin donnerait une table à trous, dont la moitié serait vide pour toute
--     ligne, et il faudrait une migration à chaque nature ajoutée. Le contrôle
--     de forme se fait à l'écriture, par la route, selon `kind`.
--
--  2. `transform` n'a PAS de contrainte CHECK, alors que `kind` en a une. Le
--     jeu de transformations est fermé, mais sa définition vit dans
--     lib/mapping.js — c'est là qu'elles sont écrites, testées et documentées.
--     La lister ici en ferait une seconde source de vérité, qui finirait par
--     diverger de la première : exactement ce qui était arrivé à la matrice des
--     droits. `kind`, lui, ne décrit aucun code : il énumère des natures de
--     source, il est donc à sa place dans le schéma.
--
--  `secret_enc` suit la règle déjà posée pour `odk_forms.token_enc` : chiffré au
--  repos par lib/crypto.js, jamais renvoyé par l'API — seule sa présence l'est.
-- =====================================================================

CREATE TABLE connector (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  kind        text NOT NULL
      CHECK (kind IN ('odk','kobo','foundry','csv','http')),
  base_url    text,                             -- adresse du serveur, vérifiée avant tout appel sortant
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,       -- JSON, jamais de secret : voir le point 1 ci-dessus
  secret_enc  text,                             -- AES-256-GCM, jamais renvoyé en clair
  -- Un connecteur appartient au bureau qui l'a déclaré : c'est ce qui permet de
  -- cloisonner sa lecture comme le reste. ON DELETE SET NULL, et non CASCADE :
  -- supprimer un bureau ne doit pas emporter silencieusement sa configuration
  -- de sources, qui reste utile à l'administration nationale.
  office_id   text REFERENCES offices(id) ON DELETE SET NULL,
  active      smallint NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Même mécanique de révision que partout ailleurs : le second à enregistrer
  -- est averti au lieu d'écraser en silence le travail du premier.
  rev         integer NOT NULL DEFAULT 1
);
CREATE INDEX idx_connector_office ON connector(office_id);
CREATE INDEX idx_connector_kind   ON connector(kind);

CREATE TABLE connector_mapping (
  id            text PRIMARY KEY,
  connector_id  text NOT NULL REFERENCES connector(id) ON DELETE CASCADE,
  -- L'entité MEMS visée (site, submission, beneficiaire, reception) et le champ
  -- visé dans cette entité. Les deux valeurs sont contrôlées à l'écriture contre
  -- le registre de lib/champs.js, pour la raison dite plus haut à propos de
  -- `transform` : le registre est la seule source de vérité, le schéma ne la copie pas.
  entity        text NOT NULL,
  mems_field    text NOT NULL,
  -- Le nom de la variable dans la source, ou un chemin JSON quand la source rend
  -- des objets imbriqués. Peut rester vide : une correspondance déclarée mais non
  -- encore renseignée est une ligne de travail légitime, pas une erreur.
  source_path   text,
  transform     text NOT NULL DEFAULT 'brut',
  -- Obligatoire au sens de CE branchement, ce qui n'est pas la même chose que
  -- l'obligation portée par le registre : un champ facultatif dans MEMS peut être
  -- indispensable à un import donné (le tonnage reçu, pour une source de réceptions).
  -- L'application retient l'union des deux.
  required      smallint NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  -- Valeur de repli quand la source ne renseigne rien. Elle passe par la même
  -- transformation que la valeur lue, sans quoi un défaut arriverait sous une autre
  -- forme que les valeurs qu'il remplace.
  default_value text,
  note          text,
  position      integer NOT NULL DEFAULT 0
);
-- Un champ MEMS ne peut être alimenté que par une seule variable source pour une
-- entité donnée : deux correspondances concurrentes sur le même champ ne se
-- départageraient que par l'ordre d'écriture, c'est-à-dire par hasard.
CREATE UNIQUE INDEX idx_cmap_cle ON connector_mapping(connector_id, entity, mems_field);
CREATE INDEX idx_cmap_ordre ON connector_mapping(connector_id, entity, position);
