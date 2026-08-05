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
--  déplie (les codes, puis les douze mois), on mappe chaque code sur
--  l'`indicator_id` réel, et on insère une ligne « planifié » pour chaque
--  mois COCHÉ. L'année n'était pas portée par le reflet (il était
--  implicitement « l'année courante ») : on prend donc l'année du
--  déploiement, ce que fait aussi le serveur (getFullYear).
--
--  `settings.value` reste du texte brut (voir 001_init.sql) : toutes les
--  clés du dictionnaire ne sont pas du JSON, donc la validité est
--  vérifiée explicitement (`value IS JSON`, l'équivalent PostgreSQL 16 de
--  `json_valid`) et le cast en jsonb n'a lieu que sur la ligne déjà
--  filtrée par clé ET par validité — dans une sous-requête à part, pour ne
--  jamais tenter de parser en JSON une autre ligne de `settings` qui n'en
--  serait pas.
--
--  `json_each` imbriqué (les codes, puis les mois de chaque code) devient
--  deux LATERAL : `jsonb_each` sur l'objet, puis
--  `jsonb_array_elements ... WITH ORDINALITY` sur le tableau de douze
--  booléens — l'ordinalité (1-based) moins un restitue l'index de mois
--  0-11 que rendait `json_each` sur un tableau SQLite.
--
--  ON CONFLICT DO NOTHING : la clé primaire (indicator_id, year, month) rend
--  la reprise idempotente si la table portait déjà la ligne. Un code inconnu
--  (indicateur supprimé depuis) est ignoré par la jointure, sans erreur.
--
--  Sur une base neuve, ou sans ce reflet, la requête ne fait rien : il n'y
--  a aucune ligne `settings` nommée 'outcomePlan'. La purge finale retire
--  le reflet pour qu'il n'ombre plus jamais la table.
-- =====================================================================

INSERT INTO outcome_plan (indicator_id, year, month, planned)
SELECT ind.id,
       EXTRACT(YEAR FROM now())::integer,
       (mois.ord - 1)::integer,
       1
FROM (
  SELECT value::jsonb AS value
  FROM settings
  WHERE key = 'outcomePlan' AND value IS JSON
) s
JOIN LATERAL jsonb_each(s.value) AS codes(key, value) ON true
JOIN LATERAL jsonb_array_elements(codes.value) WITH ORDINALITY AS mois(elem, ord) ON true
JOIN indicators ind ON ind.code = codes.key
WHERE mois.elem = 'true'::jsonb
  AND (mois.ord - 1) BETWEEN 0 AND 11
ON CONFLICT (indicator_id, year, month) DO NOTHING;

DELETE FROM settings WHERE key = 'outcomePlan';
