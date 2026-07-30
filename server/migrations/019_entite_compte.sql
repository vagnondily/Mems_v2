-- =====================================================================
--  L'entité d'appartenance d'un compte
--
--  Le rôle disait ce qu'un compte peut FAIRE (lire, modifier, valider, administrer),
--  le bureau et le pays disaient OÙ. Il manquait la troisième question, que tout le
--  monde pose en créant un compte : QUI est-ce ? Un chargé de programme, un
--  logisticien, un agent de suivi-évaluation et un partenaire d'exécution ont le
--  même rôle « éditeur » et n'ont pas du tout le même travail.
--
--  L'entité ne donne aucun droit — c'est le rôle qui les donne, et il ne faut surtout
--  pas deux façons de décider d'un accès. Elle sert à deux choses honnêtes :
--
--    1. proposer les bonnes destinations par défaut à la création du compte,
--       plutôt que de laisser cocher douze cases sans savoir lesquelles ;
--    2. dire, sur l'écran des comptes, à qui l'on a affaire — ce que « éditeur,
--       bureau d'Ambovombe » ne disait pas.
--
--  Elle est facultative : les comptes existants n'en ont pas, et un compte sans
--  entité fonctionne exactement comme avant.
-- =====================================================================

ALTER TABLE users ADD COLUMN entity TEXT;
CREATE INDEX idx_users_entity ON users(entity);
