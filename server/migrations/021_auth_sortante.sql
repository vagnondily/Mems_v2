-- =====================================================================
--  Le schéma d'authentification devient une donnée de la source
--
--  Jusqu'ici tout l'accès sortant de MEMS supposait un seul schéma :
--  `Authorization: Bearer <jeton>`, écrit en dur dans lib/odkClient.js et dans
--  lib/foundry.js. C'était une hypothèse, pas une règle du monde. KoboToolbox
--  emploie `Token` (c'est le TokenAuthentication de Django REST Framework), une
--  API d'entreprise peut demander `Basic`, et ODK Central lui-même ne délivre
--  pas de jeton permanent à un compte web : il délivre une SESSION qui expire.
--
--  D'où deux ajouts, et un seul est une colonne de plus sur l'existant.
--
--  1. `auth_schema` — QUEL schéma cette source attend. Vaut 'porteur' par
--     défaut : toute source déjà configurée continue donc d'émettre exactement
--     `Bearer <jeton>`, sans ressaisie, ce qui est le seul comportement que le
--     tirage ODK ait jamais eu.
--
--     PAS de contrainte CHECK, et c'est un choix, pas un oubli. La migration 016
--     a posé la règle : `kind` porte un CHECK parce qu'il énumère des NATURES DE
--     SOURCE, `transform` n'en porte pas parce qu'il nomme des entrées d'une
--     table de code (lib/mapping.js) qu'un CHECK transformerait en seconde source
--     de vérité vouée à diverger. `auth_schema` est exactement dans le second cas :
--     il nomme les entrées de SCHEMAS_AUTH (lib/authSortante.js). La demande dit
--     d'ailleurs qu'ajouter un schéma doit être « une entrée dans une table » —
--     un CHECK ici en ferait une entrée dans une table PLUS une migration.
--     Le contrôle de valeur est fait à l'écriture, par les routes, contre la table.
--
--  2. `auth_identifiant` — la moitié NON SECRÈTE d'un justificatif à deux
--     parties : le courriel du compte ODK Central, l'identifiant d'un Basic. Elle
--     a sa colonne à côté de la moitié chiffrée plutôt que de vivre dans le JSON
--     `config` : une paire d'identification dont les deux moitiés sont rangées
--     par deux mécanismes différents finit par se désynchroniser, et personne ne
--     saurait dire laquelle des deux fait foi. Elle n'est pas chiffrée parce
--     qu'elle n'est pas un secret — mais elle ne se lit qu'ici, jamais ailleurs.
--
--  `odk_forms.token_enc` et `connector.secret_enc` gardent leur nom et changent
--  de sens : ils portent désormais le JUSTIFICATIF DURABLE — un jeton collé, un
--  jeton d'API permanent, ou un MOT DE PASSE. Le chiffrement AES-256-GCM de
--  lib/crypto.js les couvrait déjà, et c'est bien ce qu'exige un mot de passe.
--
--  ── La table des sessions, et pourquoi elle est à part ────────────────
--
--  Le second secret — le jeton COURT qu'ODK Central délivre contre un couple
--  courriel/mot de passe — ne se saisit jamais et ne ressort jamais. Il pourrait
--  tenir dans une colonne de plus sur `odk_forms` et `connector`. Il n'y tient
--  pas, pour une raison précise : ces deux tables portent un `rev` de contrôle
--  de concurrence (migrations 006 et 016), et routes/connectors.js répond 409
--  dès que la révision envoyée diffère de la sienne. Un renouvellement de
--  session — qui survient tout seul, sans intervention humaine — incrémenterait
--  `rev` et ferait échouer par 409 l'administrateur en train d'éditer
--  tranquillement sa fiche, sans qu'il puisse comprendre pourquoi. Une table
--  séparée supprime ce couplage : c'est un cache, il n'a pas de révision.
--
--  `empreinte` mérite son explication. C'est un HMAC-SHA256 du justificatif
--  durable, clé par `config.dataKey`. Il sert à une seule chose : détecter
--  qu'on a changé de justificatif ou de schéma, pour que la session en cache
--  cesse d'être servie et que le blocage après échec soit levé du même coup.
--  Un administrateur qui corrige son mot de passe est ainsi débloqué sur-le-champ,
--  sans qu'aucun code n'ait à penser à vider ce cache — ce à quoi on finit
--  toujours par oublier de penser quelque part. HMAC et non simple SHA-256 :
--  un condensé nu d'un mot de passe, stocké en base, s'attaque au dictionnaire ;
--  clé par DATA_KEY, il ne dit rien de plus que `secret_enc` à côté de lui.
-- =====================================================================

ALTER TABLE odk_forms ADD COLUMN auth_schema      text NOT NULL DEFAULT 'porteur';
ALTER TABLE odk_forms ADD COLUMN auth_identifiant text;

ALTER TABLE connector ADD COLUMN auth_schema      text NOT NULL DEFAULT 'porteur';
ALTER TABLE connector ADD COLUMN auth_identifiant text;

-- Un connecteur réseau SANS secret n'émettait aucun en-tête : lib/foundry.js
-- écrivait `...(token ? { Authorization: ... } : {})`. Le laisser à 'porteur' le
-- ferait désormais refuser avant même de sortir, avec « justificatif absent » —
-- ce qui est le bon comportement pour une source privée mal configurée, mais une
-- REGRESSION pour une source réellement publique, qui fonctionnait la veille.
-- On écrit donc noir sur blanc ce que ces lignes faisaient déjà en silence. La
-- différence n'est pas cosmétique : à partir de maintenant, « pas de justificatif
-- parce qu'il n'en faut pas » est une déclaration de l'administrateur, tandis
-- qu'une source déclarée sous un autre schéma et laissée sans secret est refusée
-- avant l'appel. Le défaut d'une source NOUVELLE reste 'porteur', pour que la
-- configuration incomplète continue de se voir.
UPDATE connector SET auth_schema = 'aucun'
 WHERE secret_enc IS NULL AND kind IN ('odk','kobo','foundry','http');

CREATE TABLE source_session (
  -- Deux familles de sources, deux tables d'origine : la clé est composite plutôt
  -- que deux tables de cache jumelles qu'il faudrait corriger deux fois.
  source_kind text NOT NULL CHECK (source_kind IN ('odk_forms','connector')),
  source_id   text NOT NULL,
  -- Le jeton court dérivé. Chiffré comme tout secret au repos, bien qu'il soit
  -- éphémère : « éphémère » n'est pas « sans valeur », il ouvre la source.
  jeton_enc   text,
  -- Ce que la SOURCE a annoncé, pas ce que MEMS a calculé. Nul quand le second
  -- secret n'expire pas (un jeton d'API Kobo n'a pas de date de péremption).
  expire_le   timestamptz,
  obtenu_le   timestamptz,
  -- Un échec de renouvellement se SIGNALE et ne se rejoue pas en boucle : tant que
  -- ces deux colonnes sont fraîches, MEMS refuse de retenter et rend le motif.
  echec_le    timestamptz,
  echec_motif text,
  empreinte   text NOT NULL,
  PRIMARY KEY (source_kind, source_id)
);

-- Une clé étrangère ne peut pas viser deux tables. Les deux déclencheurs font le
-- même travail : la disparition d'une source emporte le jeton dérivé qu'elle avait
-- ouvert. Sans eux, un secret — même éphémère — survivrait à ce qu'il déverrouille.
-- PostgreSQL exige une fonction PL/pgSQL séparée pour porter le corps du
-- déclencheur (contrairement à SQLite, où le corps s'écrit en ligne dans le
-- CREATE TRIGGER) : c'est la seule différence de forme, le comportement est
-- identique.
CREATE FUNCTION trg_source_session_purge_odk() RETURNS trigger AS $$
BEGIN
  DELETE FROM source_session WHERE source_kind='odk_forms' AND source_id=OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_purge_odk AFTER DELETE ON odk_forms
FOR EACH ROW EXECUTE FUNCTION trg_source_session_purge_odk();

CREATE FUNCTION trg_source_session_purge_connector() RETURNS trigger AS $$
BEGIN
  DELETE FROM source_session WHERE source_kind='connector' AND source_id=OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_purge_connector AFTER DELETE ON connector
FOR EACH ROW EXECUTE FUNCTION trg_source_session_purge_connector();
