-- =====================================================================
--  Un site, plusieurs codes externes  (chantier O, lot A1)
--
--  La migration 017 a ajouté `sites.external_code`, une colonne UNIQUE en son
--  genre : un site, un code. Le terrain dit autre chose. Un même point de suivi
--  est désigné différemment selon le formulaire qui le renseigne :
--
--    — GD_PREVMA envoie un p-code fokontany de 13 caractères (MG51507010014) ;
--    — MIARO envoie ce même p-code suivi d'un numéro d'ordre (…0014001) ;
--    — SMP envoie un ENTIER hors référentiel p-code (603140007), tiré de la
--      liste des 1 251 codes école que le bureau tient à part.
--
--  Avec une seule colonne, brancher le deuxième formulaire écrase le premier :
--  le site cesse d'être rattachable par la source qu'on avait déjà câblée. Le
--  code externe n'est donc pas un attribut du site, c'est une RELATION entre un
--  site et une source — d'où une table.
--
--  ── La stratégie retenue : la colonne reste, et devient le code par défaut ──
--  `sites.external_code` n'est ni supprimée ni dépréciée. Elle garde un rôle
--  précis et unique : c'est LE code par défaut, celui que porte la fiche de site
--  et que l'opérateur saisit à la main. Trois raisons de la garder :
--
--    1. le schéma zod (lib/validate.js), la fiche de site du frontend et les
--       tests existants la connaissent. La retirer imposerait de tout réécrire
--       pour ne rien gagner : un code par défaut RESTE utile, c'est celui qu'on
--       renseigne quand on n'a affaire qu'à une source ;
--    2. une table d'alias vide est le cas courant. Obliger à passer par une
--       seconde entité pour saisir un seul code alourdirait le geste le plus
--       fréquent au bénéfice du plus rare ;
--    3. la colonne est la seule des deux qui puisse porter une contrainte lue
--       par le formulaire de saisie (longueur, obligation) sans imposer un
--       aller-retour supplémentaire.
--
--  Le résolveur (lib/rattachement.js) lit l'UNION des deux : la colonne ET la
--  table. Aucune des deux n'a autorité sur l'autre, donc aucune ne peut
--  « diverger » de l'autre au sens où l'on divergerait d'une source de vérité.
--
--  Une seule synchronisation existe, et elle est étroite : la valeur de la
--  colonne est MIROITÉE dans la table sous la source réservée « fiche du site »
--  (voir lib/alias.js), de sorte qu'un écran puisse lister tous les codes d'un
--  site en une requête. Corriger la colonne remplace ce miroir et lui seul :
--  un alias importé depuis une table de correspondance n'est jamais touché par
--  une modification de la fiche. C'est ce qui permet de corriger une faute de
--  frappe dans le code par défaut sans que l'ancien continue à rattacher en
--  douce — le reproche exact qu'on ferait à une table qui ne serait qu'un
--  historique.
--
--  ── Les index disent la règle métier ────────────────────────────────
--  `code` est indexé mais NON unique, et c'est délibéré : sept codes GD_PREVMA
--  désignent deux points de distribution distincts, ce que le XLSForm autorise
--  explicitement (`allow_choice_duplicates='yes'`). Une contrainte d'unicité
--  obligerait à en fausser un pour enregistrer l'autre ; sans elle, l'ambiguïté
--  entre en base telle qu'elle est et le résolveur la traite pour ce qu'elle
--  est : deux candidats égaux, donc aucun.
--
--  Le triplet (site_id, code, source) est unique : c'est ce qui rend l'import
--  d'une table de correspondance idempotent sans qu'aucun code applicatif n'ait
--  à le garantir. Il est doublé d'un index partiel sur (site_id, code) quand la
--  source est absente, parce que SQLite considère deux NULL comme distincts :
--  sans lui, la même paire sans source pourrait entrer autant de fois qu'on la
--  soumettrait, et l'idempotence promise serait fausse précisément dans le cas
--  le plus dépouillé.
-- =====================================================================

CREATE TABLE site_external_code (
  id         TEXT PRIMARY KEY,
  -- CASCADE, contrairement à `submissions.site_id` : un alias n'a aucune
  -- existence propre. Il ne porte ni observation, ni date, ni décision — il ne
  -- dit que « telle source appelle ce site comme ceci ». Le site supprimé, il ne
  -- désigne plus rien et le conserver ne ferait que polluer l'index des codes.
  site_id    TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  code       TEXT NOT NULL,
  -- Le form_id, ou le nom de la source, qui emploie ce code. Nullable : le
  -- bureau possède des tables de correspondance dont on ne sait plus de quel
  -- formulaire elles viennent, et refuser de les charger pour cette seule raison
  -- reviendrait à préférer aucune donnée à une donnée incomplète.
  source     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_site_alias_code ON site_external_code(code);
CREATE UNIQUE INDEX idx_site_alias_triplet ON site_external_code(site_id, code, source);
CREATE UNIQUE INDEX idx_site_alias_sans_source
  ON site_external_code(site_id, code) WHERE source IS NULL;
-- Lister les codes d'un site est le geste de la fiche de site : il doit tenir
-- en un parcours d'index, pas en un balayage de la table.
CREATE INDEX idx_site_alias_site ON site_external_code(site_id);

-- ── Reprise de l'existant ────────────────────────────────────────────
-- Les codes déjà saisis dans la colonne entrent dans la table sous la source
-- réservée « fiche du site ». Sans cette reprise, un site configuré avant cette
-- migration apparaîtrait sans aucun code dans l'écran qui les liste, alors qu'il
-- en porte un — et l'opérateur le ressaisirait, créant un doublon.
INSERT INTO site_external_code (id, site_id, code, source, note)
SELECT 'alias_' || upper(hex(randomblob(10))), id, trim(external_code), 'fiche du site',
       'repris de sites.external_code lors de la migration 018'
FROM sites
WHERE external_code IS NOT NULL AND trim(external_code) <> '';
