-- =====================================================================
--  Demander un accès soi-même, sans l'obtenir soi-même.
--
--  Jusqu'ici, un compte ne pouvait naître que de la main d'un administrateur. C'est
--  sûr, et c'est un goulot : dans un bureau de terrain qui recrute un agent de suivi
--  un lundi matin, la personne attend que quelqu'un, ailleurs, trouve le temps de
--  créer son compte — et en attendant elle travaille sur un tableur, ce qui est
--  exactement ce qu'on cherchait à éviter.
--
--  L'inscription libre seule serait pire : n'importe qui saurait alors se faire un
--  accès à des données de bénéficiaires. La bonne forme est celle-ci : la personne
--  DEMANDE, l'administrateur du pays DÉCIDE.
--
--  Une demande n'est donc pas un compte. Elle n'a pas de mot de passe, elle ne peut
--  pas se connecter, et elle ne devient un compte qu'au moment où quelqu'un qui en a
--  le droit lui attribue un rôle, un bureau et des destinations. Ce que le demandeur
--  déclare — son nom, son service, le bureau qu'il pense être le sien — est une
--  DÉCLARATION, pas une décision : le rôle, en particulier, ne figure pas dans cette
--  table, et ne peut donc pas être demandé.
-- =====================================================================

CREATE TABLE account_request (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL COLLATE NOCASE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  title         TEXT,
  -- L'entité d'appartenance déclarée : programme, suivi-évaluation, logistique…
  -- Elle n'accorde aucun droit ; elle aide l'administrateur à proposer les bonnes
  -- destinations plutôt que de cocher douze cases à l'aveugle.
  entity        TEXT,
  -- Le pays décide QUI examine la demande : un administrateur borné à un pays ne voit
  -- que les demandes de ce pays, comme pour tout le reste.
  country_code  TEXT REFERENCES country(code) ON DELETE SET NULL,
  -- Le bureau SOUHAITÉ. L'administrateur peut en décider autrement.
  office_id     TEXT REFERENCES offices(id) ON DELETE SET NULL,
  motif         TEXT,

  status        TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','approved','rejected')),
  -- De quoi retrouver l'origine d'une demande douteuse sans conserver davantage.
  ip            TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  decided_at    TEXT,
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_note TEXT,
  -- Le compte issu de la demande, quand elle a été acceptée : c'est le lien qui
  -- permet de dire « ce compte vient de telle demande, acceptée par telle personne ».
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_request_status  ON account_request(status);
CREATE INDEX idx_request_country ON account_request(country_code);
-- Une seule demande en attente par adresse : sans cela, cliquer trois fois sur
-- « Envoyer » remplirait l'écran de l'administrateur de la même demande.
CREATE UNIQUE INDEX idx_request_pending ON account_request(email)
  WHERE status = 'pending';
