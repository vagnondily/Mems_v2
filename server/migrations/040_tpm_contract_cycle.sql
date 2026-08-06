-- =====================================================================
--  Suivi tiers — le CYCLE DE VIE du contrat
--
--  Demande : un contrat se lit ligne par ligne avec un statut parmi
--  brouillon / soumis / validé / annulé / modèle (draft / submitted /
--  validated / canceled / template), et non plus le couple actif/clos hérité
--  du premier jet.
--
--  La règle du circuit :
--      draft      en cours de conception, rien n'y est engagé
--      submitted  transmis pour validation
--      validated  approuvé — SEUL état où des plans mensuels peuvent se rattacher
--      canceled   abandonné
--      template   modèle : un brouillon SAUVEGARDÉ, non actif, que l'on
--                 duplique pour repartir d'une base plutôt que d'une page blanche
--
--  « validated » remplace « actif » comme état opérationnel : c'est le seul qui
--  reçoit des plans (routes/tpm.js). Un nouveau contrat naît « draft » — on le
--  conçoit avant de l'activer, on ne le déclare pas actif d'emblée.
--
--  Reprise des valeurs existantes, sans perte :
--      projet   → draft       (en conception)
--      actif    → validated   (opérationnel)
--      suspendu → submitted    (retiré du service, en attente d'une décision)
--      clos     → canceled     (terminé)
-- =====================================================================

ALTER TABLE tpm_contract DROP CONSTRAINT tpm_contract_status_check;

UPDATE tpm_contract SET status = CASE status
  WHEN 'projet'   THEN 'draft'
  WHEN 'actif'    THEN 'validated'
  WHEN 'suspendu' THEN 'submitted'
  WHEN 'clos'     THEN 'canceled'
  ELSE status END;

ALTER TABLE tpm_contract ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE tpm_contract ADD CONSTRAINT tpm_contract_status_check
  CHECK (status IN ('draft','submitted','validated','canceled','template'));
