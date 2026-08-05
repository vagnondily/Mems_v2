-- =====================================================================
--  Suivi tiers — TPM (Third Party Monitoring)
--
--  Ce que le fichier MAHAVOTSE_BUDGET_TPM montre, et qui manquait :
--
--  Le budget d'un TPM n'est pas un montant négocié puis suivi. C'est le RÉSULTAT
--  d'une affectation. On assigne des zones à couvrir dans le mois ; il en découle
--  un nombre d'équipes, de jours et de véhicules ; le barème contractuel donne le
--  montant. Le classeur le dit ligne à ligne : F = Coût unitaire × Qté2 × Qté1,
--  sous-total par équipe, total général. Rien n'y est saisi à la main que les
--  quantités et le barème.
--
--  D'où le choix structurant : ce module ne stocke AUCUN total. Il stocke des
--  affectations, un barème, des quantités — et calcule. Même principe que le plan
--  MRE, pour la même raison : un total qu'on ne peut pas décomposer ne se défend
--  pas devant un bailleur, et ne se rapproche pas de la dépense.
--
--  Trois niveaux de validation, parce que c'est le circuit réel :
--
--      responsable du TPM  →  suivi-évaluation du bureau  →  suivi-évaluation pays
--
--  Un état booléen « validé » ne suffirait pas : il faut savoir QUI a validé, QUAND,
--  et ce qu'il a dit en renvoyant. Une approbation qu'on ne peut pas auditer n'est
--  pas une approbation — c'est une case cochée.
--
--  Le plafond contractuel n'est pas décoratif : il est vérifié à la validation
--  finale. Un plan qui ferait dépasser le plafond exige un avenant, et l'avenant
--  est une ligne datée, pas un chiffre modifié en place.
-- =====================================================================

-- ── Le prestataire ──────────────────────────────────────────────────
CREATE TABLE tpm (
  id         text PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  code       text,
  -- Bureau de rattachement principal : c'est lui qui valide au deuxième niveau.
  -- Facultatif, car un TPM peut opérer sur plusieurs bureaux ; dans ce cas la
  -- validation de niveau bureau revient au bureau de la zone affectée.
  office_id  text REFERENCES offices(id) ON DELETE SET NULL,
  contact    text,
  email      text,
  phone      text,
  note       text,
  active     smallint NOT NULL DEFAULT 1,
  rev        integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

-- Un compte peut appartenir à un TPM. C'est la troisième forme de cloisonnement,
-- après le rôle et le bureau : un compte TPM ne voit que ses propres plans, quel
-- que soit son rôle. Sur la colonne du compte plutôt que dans un rôle dédié —
-- créer un sixième rôle aurait dupliqué la matrice des droits pour une seule
-- différence, qui n'est pas une différence de droits mais de périmètre.
ALTER TABLE users ADD COLUMN tpm_id text REFERENCES tpm(id) ON DELETE SET NULL;
CREATE INDEX idx_users_tpm ON users(tpm_id);

-- ── Le contrat et ses avenants ──────────────────────────────────────
CREATE TABLE tpm_contract (
  id         text PRIMARY KEY,
  tpm_id     text NOT NULL REFERENCES tpm(id) ON DELETE CASCADE,
  ref        text NOT NULL,
  -- Le plafond initial. Il ne bouge JAMAIS : les évolutions passent par des
  -- avenants, sinon on perd l'historique de ce qui a été engagé et pourquoi.
  ceiling    double precision NOT NULL DEFAULT 0 CHECK (ceiling >= 0),
  -- Le TPM facture en monnaie locale (70 000 MGA l'indemnité de superviseur),
  -- le plan MRE se tient en dollars. On ne convertit pas d'office : la devise est
  -- portée par le contrat et affichée telle quelle.
  currency   text NOT NULL DEFAULT 'MGA',
  start_date timestamptz,
  end_date   timestamptz,
  status     text NOT NULL DEFAULT 'actif'
      CHECK (status IN ('projet','actif','suspendu','clos')),
  note       text,
  rev        integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE UNIQUE INDEX idx_tpm_contract_ref ON tpm_contract(tpm_id, ref);
CREATE INDEX idx_tpm_contract_tpm ON tpm_contract(tpm_id);

CREATE TABLE tpm_amendment (
  id          text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES tpm_contract(id) ON DELETE CASCADE,
  ref         text,
  -- Signé : un avenant peut réduire le plafond, pas seulement l'augmenter.
  delta       double precision NOT NULL,
  reason      text NOT NULL,
  signed_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_tpm_amendment_c ON tpm_amendment(contract_id);

-- ── Le barème ───────────────────────────────────────────────────────
-- Ce qui transforme une affectation en budget. Attaché au contrat, parce que
-- c'est le contrat qui fixe les prix ; deux TPM n'ont pas le même barème, et le
-- barème d'un contrat clos doit rester lisible pour relire ses plans.
CREATE TABLE tpm_rate (
  id          text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES tpm_contract(id) ON DELETE CASCADE,
  -- Le rôle de la ligne dans le calcul, d'où la valeur dérive automatiquement.
  -- 'forfait' ne dérive de rien : sa quantité est saisie.
  driver      text NOT NULL DEFAULT 'forfait'
      CHECK (driver IN ('superviseur','agent','vehicule','carburant','forfait')),
  label       text NOT NULL,
  unit        text,
  unit_cost   double precision NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  active      smallint NOT NULL DEFAULT 1,
  sort        integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_tpm_rate_c ON tpm_rate(contract_id);

-- ── Le plan du mois ─────────────────────────────────────────────────
-- L'unité de travail et de validation : ce qu'un TPM couvre dans un mois, et ce
-- que cela coûte. Un plan par TPM et par mois — c'est la maille du circuit réel.
CREATE TABLE tpm_plan (
  id          text PRIMARY KEY,
  tpm_id      text NOT NULL REFERENCES tpm(id) ON DELETE CASCADE,
  contract_id text NOT NULL REFERENCES tpm_contract(id) ON DELETE CASCADE,
  year        integer NOT NULL,
  month       integer NOT NULL CHECK (month BETWEEN 0 AND 11),
  ref         text,
  -- Le circuit. 'renvoye' n'est pas un rejet définitif : c'est un retour au TPM
  -- avec un motif, et le motif est dans tpm_review.
  status      text NOT NULL DEFAULT 'brouillon'
      CHECK (status IN ('brouillon','soumis','valide_tpm','valide_bureau',
                        'valide_pays','renvoye','cloture')),
  note        text,
  rev         integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz
);
-- Un seul plan par TPM et par mois : deux plans concurrents pour le même mois
-- rendraient le plafond incalculable.
CREATE UNIQUE INDEX idx_tpm_plan_mois ON tpm_plan(tpm_id, year, month);
CREATE INDEX idx_tpm_plan_statut ON tpm_plan(status, year, month);

-- L'affectation : une zone à couvrir, avec l'équipe et les jours qu'elle demande.
-- C'est de ces quantités que le budget découle.
CREATE TABLE tpm_zone (
  id           text PRIMARY KEY,
  plan_id      text NOT NULL REFERENCES tpm_plan(id) ON DELETE CASCADE,
  -- La zone est une unité administrative du référentiel courant, en général une
  -- commune : c'est la maille à laquelle le classeur raisonne (« TEAM1: AMBANISARIKA »).
  geo_pcode    text NOT NULL,
  activity_tag text,
  team_label   text,
  -- Composition et durée. Le classeur porte exactement ces colonnes :
  -- Superviseur, Agent, Jour de travail, Déplacement, Moyen de déplacement.
  supervisors  integer NOT NULL DEFAULT 1 CHECK (supervisors >= 0),
  agents       integer NOT NULL DEFAULT 1 CHECK (agents >= 0),
  days         integer NOT NULL DEFAULT 1 CHECK (days >= 0),
  travel_days  integer NOT NULL DEFAULT 0 CHECK (travel_days >= 0),
  vehicles     integer NOT NULL DEFAULT 0 CHECK (vehicles >= 0),
  fuel_litres  double precision NOT NULL DEFAULT 0 CHECK (fuel_litres >= 0),
  sites        integer NOT NULL DEFAULT 0 CHECK (sites >= 0),
  note         text
);
CREATE INDEX idx_tpm_zone_plan ON tpm_zone(plan_id);
CREATE INDEX idx_tpm_zone_geo  ON tpm_zone(geo_pcode);

-- Les lignes de budget. Générées depuis la zone et le barème, puis ajustables :
-- le classeur comporte des lignes qui ne dérivent d'aucune quantité d'équipe
-- (« Groupe électrogène avec carburant », « Forfait 1st premium »), et les
-- interdire obligerait à les faire entrer de force dans une formule.
--
-- total = qty1 × qty2 × unit_cost, comme la colonne F du classeur.
CREATE TABLE tpm_line (
  id         text PRIMARY KEY,
  plan_id    text NOT NULL REFERENCES tpm_plan(id) ON DELETE CASCADE,
  zone_id    text REFERENCES tpm_zone(id) ON DELETE CASCADE,
  driver     text NOT NULL DEFAULT 'forfait',
  label      text NOT NULL,
  unit       text,
  qty1       double precision NOT NULL DEFAULT 1 CHECK (qty1 >= 0),
  qty2       double precision NOT NULL DEFAULT 1 CHECK (qty2 >= 0),
  unit_cost  double precision NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  -- Vrai tant que la ligne suit le barème et les quantités de la zone. Passe à
  -- faux dès qu'on la modifie à la main, pour que la régénération ne l'écrase pas.
  derived    smallint NOT NULL DEFAULT 1,
  sort       integer NOT NULL DEFAULT 0
);
CREATE INDEX idx_tpm_line_plan ON tpm_line(plan_id);
CREATE INDEX idx_tpm_line_zone ON tpm_line(zone_id);

-- ── Le circuit de validation ────────────────────────────────────────
-- Chaque passage laisse une trace. C'est la table qu'on relira dans six mois
-- quand quelqu'un demandera qui a laissé passer une ligne.
CREATE TABLE tpm_review (
  id        text PRIMARY KEY,
  plan_id   text NOT NULL REFERENCES tpm_plan(id) ON DELETE CASCADE,
  level     text NOT NULL CHECK (level IN ('tpm','bureau','pays')),
  decision  text NOT NULL CHECK (decision IN ('valide','renvoye')),
  comment   text,
  -- Montant du plan au moment de la décision : un plan modifié après validation
  -- ne doit pas laisser croire que ce montant-là avait été approuvé.
  amount    double precision,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   text REFERENCES users(id) ON DELETE SET NULL,
  user_label text
);
CREATE INDEX idx_tpm_review_plan ON tpm_review(plan_id, at);

-- ── La dépense ──────────────────────────────────────────────────────
-- Constatée après coup, rattachée au plan et si possible à sa ligne. Sans ce
-- rattachement on saurait combien a été dépensé, pas sur quoi — donc rien
-- d'actionnable.
CREATE TABLE tpm_expense (
  id         text PRIMARY KEY,
  plan_id    text NOT NULL REFERENCES tpm_plan(id) ON DELETE CASCADE,
  line_id    text REFERENCES tpm_line(id) ON DELETE SET NULL,
  spent_on   timestamptz,
  amount     double precision NOT NULL CHECK (amount >= 0),
  ref        text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_tpm_expense_plan ON tpm_expense(plan_id);
