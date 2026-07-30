-- =====================================================================
--  La référence d'une activité MRE est unique PAR PAYS
--
--  La migration 010 posait `UNIQUE(year, ref)` pour toute l'instance. C'était juste
--  quand l'instance servait un pays ; ce ne l'est plus. Deux bureaux pays numérotent
--  leurs activités indépendamment — ils ne se consultent pas pour cela — et le
--  premier à saisir « ME-2026-01 » interdirait la même référence au second, avec un
--  message parlant d'un doublon que celui-ci ne peut pas voir.
--
--  Une remarque sur les NULL : deux lignes sans pays sont considérées comme
--  distinctes par SQLite, donc deux activités non rattachées peuvent porter la même
--  référence. C'est accepté et non subi — la migration 015 a rattaché tout
--  l'existant, et une ligne sans pays est déjà un défaut de saisie qu'on veut voir
--  plutôt qu'un conflit qu'on veut masquer.
-- =====================================================================

DROP INDEX idx_mre_ref;
CREATE UNIQUE INDEX idx_mre_ref ON mre_activity(country_code, year, ref) WHERE ref IS NOT NULL;
