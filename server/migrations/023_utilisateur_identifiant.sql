-- =====================================================================
--  Un identifiant de connexion (username) en plus du courriel  (lot S)
--
--  La demande, mot pour mot : « un user devrait avoir la possibilité de
--  regarder ces infos de compte (modifier le mot de passe au besoin,
--  créer un username, etc.) ».
--
--  ── Second identifiant, pas seulement un nom affiché ─────────────────
--  Le choix (tranché faute d'objection, noté dans docs/A_FAIRE.md S) :
--  `username` est un IDENTIFIANT DE CONNEXION, au même titre que le
--  courriel. Se connecter par l'un ou par l'autre est ce que « créer un
--  username » veut dire dans un outil interne — un nom d'affichage seul
--  se déduirait déjà de first_name/last_name et n'aurait pas à être
--  « créé ». La connexion (routes/auth.js) cherche donc désormais
--  `email = ? OR username = ?`.
--
--  ── Facultatif, et unique quand il est posé ──────────────────────────
--  La colonne naît NULL partout : aucun compte existant n'a d'identifiant,
--  et le courriel reste le moyen de connexion par défaut. L'unicité ne
--  vaut donc QUE sur les valeurs renseignées — un index unique ordinaire
--  refuserait le deuxième compte sans identifiant (NULL = NULL ici,
--  contrairement à la sémantique SQL habituelle, better-sqlite3 traitant
--  plusieurs NULL comme distincts mais un index unique simple restant
--  fragile au fil des moteurs). L'index PARTIEL `WHERE username IS NOT
--  NULL` dit exactement l'intention : deux comptes ne partagent pas un
--  identifiant, mais autant de comptes qu'on veut peuvent n'en avoir aucun.
--
--  ── Aucune reprise, aucune valeur par défaut ─────────────────────────
--  On ne fabrique pas d'identifiant à partir du courriel : ce serait
--  deviner ce que l'utilisateur veut taper, et créer des collisions
--  (deux « jean.dupont » de bureaux différents). Chacun pose le sien
--  depuis « Mon compte », ou l'administrateur à la création.
-- =====================================================================

ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
