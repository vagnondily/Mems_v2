-- =====================================================================
--  MEMS — fusion des onglets « Planning » et « Actual Data »
--
--  La navigation était organisée par nature de donnée — le prévu d'un côté, le
--  réalisé de l'autre — ce qui dupliquait chaque sujet :
--
--    Planning → Plan de suivi des sites     Actual Data → Suivi de processus
--    Planning → Plan de distribution        Actual Data → Distributions
--    Planning → Plan des résultats          Actual Data → Outcomes
--
--  Pour saisir la distribution de mars, il fallait savoir lequel des deux menus.
--  Rien dans l'interface ne l'expliquait : le code lui-même écrivait les chemins
--  en toutes lettres dans les tâches urgentes (« Actual Data → Distributions »),
--  ce qui est le symptôme d'une navigation qui ne se devine pas.
--
--  Le prévu et le réalisé ne sont pas deux sujets : ce sont deux vues du même
--  sujet. Chaque sujet devient donc une destination unique, avec une bascule.
--  Le découpage de premier niveau suit désormais les deux métiers réellement
--  distincts : le suivi-évaluation et le programme.
--
--  `users.tabs` stocke des identifiants d'onglets : il faut les reporter, sinon
--  les comptes qui avaient un choix explicite se retrouveraient sans navigation.
-- =====================================================================

-- Quiconque avait accès à l'un des deux anciens onglets reçoit les deux nouveaux :
-- leur contenu s'est réparti entre eux, restreindre serait retirer un accès.
UPDATE users
SET tabs = (
  SELECT json_group_array(t.value) FROM (
    SELECT j.value AS value FROM json_each(users.tabs) j
    WHERE j.value NOT IN ('planning','actual')
    UNION SELECT 'suivi'
    UNION SELECT 'programme'
  ) t
)
WHERE EXISTS (SELECT 1 FROM json_each(users.tabs) k WHERE k.value IN ('planning','actual'));
