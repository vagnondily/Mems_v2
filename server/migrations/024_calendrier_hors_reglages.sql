-- =====================================================================
--  Le calendrier de collecte quitte le blob de réglages  (chantier S6)
--
--  Jusqu'ici, le calendrier de collecte (`outcomePlan`) était saisi puis
--  persisté dans le dictionnaire `settings`, sous une clé unique, et
--  `hydrate` le RELISAIT de là en priorité — il OMBRAIT donc la table
--  `outcome_plan` (001_init.sql:227), qui existait mais que rien
--  n'écrivait. C'est la « restriction 2 » du lot de persistance.
--
--  Depuis S6, la route `PUT /api/planning-config` (droit éditeur) écrit le
--  calendrier dans SA table, année par année, et le client lit la table.
--  Cette migration reprend ce qui avait pu être saisi dans l'ancien reflet,
--  pour qu'une installation qui l'utilisait ne voie pas son calendrier
--  disparaître au déploiement.
--
--  ── Reprise best-effort, puis purge du reflet ────────────────────────
--  Le reflet est un objet JSON { CODE_INDICATEUR: [12 booléens] }. On le
--  déplie avec json_each (imbriqué : les codes, puis les douze mois), on
--  mappe chaque code sur l'`indicator_id` réel, et on insère une ligne
--  « planifié » pour chaque mois COCHÉ. L'année n'était pas portée par le
--  reflet (il était implicitement « l'année courante ») : on prend donc
--  l'année du déploiement, ce que fait aussi le serveur (getFullYear).
--
--  INSERT OR IGNORE : la clé primaire (indicator_id, year, month) rend la
--  reprise idempotente si la table portait déjà la ligne. Un code inconnu
--  (indicateur supprimé depuis) est ignoré par la jointure, sans erreur.
--
--  Sur une base neuve, ou sans ce reflet, la requête ne fait rien : il n'y
--  a aucune ligne `settings` nommée 'outcomePlan'. La purge finale retire
--  le reflet pour qu'il n'ombre plus jamais la table.
-- =====================================================================

INSERT OR IGNORE INTO outcome_plan (indicator_id, year, month, planned)
SELECT ind.id,
       CAST(strftime('%Y','now') AS INTEGER),
       mois.key,
       1
FROM settings s
JOIN json_each(s.value)      AS codes
JOIN json_each(codes.value)  AS mois
JOIN indicators ind ON ind.code = codes.key
WHERE s.key = 'outcomePlan'
  AND json_valid(s.value)
  AND mois.type = 'true'
  AND mois.key BETWEEN 0 AND 11;

DELETE FROM settings WHERE key = 'outcomePlan';
