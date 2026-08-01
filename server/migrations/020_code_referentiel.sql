-- =====================================================================
--  Un référentiel de codes d'identification  (lot B)
--
--  La demande, mot pour mot : « Les smp utilise des code ecoles validee par
--  tous pour etre identifier donc elles peuvent etre inserer dans les
--  parametres comme base specifiques de la smp (que l on pourrait mettre a
--  jour a partir d un fichier excel comme referentiel). »
--
--  C'est ce qui débloque le rattachement des soumissions SMP. La migration 018
--  a livré le MÉCANISME — un site porte autant de codes que de sources qui le
--  désignent — mais pas la LISTE : les 1 251 codes école existent, ils sont
--  validés par tous, et MEMS n'avait aucun endroit où les tenir.
--
--  ── Pourquoi la table nomme son référentiel au lieu d'être « la table SMP » ──
--  Le même document annonce déjà le deuxième occupant : 247 codes ZAP, dans le
--  même formulaire. Et la raison qui a fait naître lib/champs.js et
--  lib/mapping.js vaut ici mot pour mot — « à chaque liaison, mets en place un
--  système de mapping […] et ainsi on ne se perd pas à recoder à chaque fois ».
--  Une table `code_ecole_smp` aurait imposé une migration 021 pour les ZAP, une
--  022 pour le formulaire suivant, et trois écrans presque identiques. La clé
--  métier porte donc le NOM du référentiel : (referentiel, code).
--
--  ── AUCUNE colonne office_id, et c'est une décision ──────────────────
--  Un référentiel de codes « validé par tous » est de la donnée de référence
--  NATIONALE, au même titre que `geo_unit` ou `country`. Lui donner un bureau
--  propriétaire produirait 1 251 lignes PAR BUREAU, et deux bureaux finiraient
--  par se contredire sur le code d'une même école — c'est-à-dire exactement la
--  situation que le référentiel existe pour supprimer.
--
--  Conséquences assumées, écrites ici pour qu'on n'ait pas à les redécouvrir :
--    — la lecture est ouverte à tout compte authentifié ;
--    — l'écriture (import et rapprochement) exige `admin`, comme
--      POST /api/geo/bulk et pour la même raison : une table chargée de travers
--      empoisonne le rattachement de TOUS les bureaux, pas du seul chargeur ;
--    — le cloisonnement par bureau réapparaît là où il a un sens, c'est-à-dire
--      au seul endroit où des SITES sont touchés : le rapprochement construit
--      son index avec `office_id`, comme le fait déjà lib/alias.js.
--
--  ── ON DELETE SET NULL, en contraste explicite avec la migration 018 ─
--  `site_external_code.site_id` est en CASCADE : un alias n'a aucune existence
--  propre, il ne dit que « telle source appelle ce site comme ceci ». Une entrée
--  de référentiel, si. C'est une ligne de la liste du bureau — un code école
--  reconnu par tous, avec son libellé et sa géographie. Supprimer un site de
--  MEMS ne doit pas effacer une ligne de cette liste : le site peut être recréé
--  demain, la liste, elle, ne se réinvente pas. On délie, on n'efface pas.
--
--  ── Le rapprochement laisse sa trace SUR l'entrée ────────────────────
--  `rapproche_passe`, `rapproche_confiance`, `rapproche_motif` et `rapproche_at`
--  sont écrits à CHAQUE rapprochement, y compris quand il échoue. Une entrée qui
--  n'a pas trouvé son site doit dire pourquoi, sinon l'écran ne peut afficher
--  qu'un compte — et un compte sans motif ne se corrige pas. Même doctrine que
--  `submissions.resolution_motif` (migration 017).
--
--  `site_id` n'est renseigné que sur une preuve suffisante ; une conclusion
--  faible s'inscrit dans les colonnes de trace SANS rattacher (voir lib/codes.js,
--  le seuil et le cliquet de confiance qu'il évite).
--
--  ── Aucune reprise de données, à la différence de la 018 ─────────────
--  La table naît vide. Il n'existe nulle part dans MEMS de liste de codes école
--  à reprendre : c'est précisément ce qui manquait. Elle se remplit par l'import
--  Excel (type « codes » de lib/import.js), donc par un lot tracé et annulable.
-- =====================================================================

CREATE TABLE code_referentiel (
  id           TEXT PRIMARY KEY,
  -- Le nom du référentiel : « SMP_2025 », « ZAP_2025 »… C'est lui qui rend la
  -- table générique, et il fait partie de la clé métier.
  referentiel  TEXT NOT NULL,
  -- Le code tel que la source l'écrit. Stocké tel quel — ni majuscules forcées,
  -- ni ponctuation retirée — pour la raison écrite en tête de lib/alias.js : le
  -- rapprochement normalise, la base conserve la forme que l'opérateur
  -- reconnaît dans son fichier d'origine.
  code         TEXT NOT NULL,
  libelle      TEXT,

  -- La géographie de l'entrée, quand le bureau la connaît. Facultative : le cas
  -- SMP est justement une liste de codes SANS p-code — s'ils en avaient un, la
  -- correspondance se déduirait et cette table n'aurait pas lieu d'être.
  geo_pcode    TEXT,
  adm1         TEXT,
  adm2         TEXT,
  adm3         TEXT,
  adm4         TEXT,

  -- Désignation humaine explicite : le code MEMS du site auquel cette entrée
  -- correspond. Facultatif, et volontairement distinct de `site_id` : l'un est
  -- ce que l'opérateur a ÉCRIT dans son fichier, l'autre ce que le rapprochement
  -- en a CONCLU. Les confondre rendrait impossible de rejouer un rapprochement
  -- en sachant ce qui venait de l'humain.
  site_code    TEXT,
  source       TEXT,
  note         TEXT,

  -- ── Trace du rapprochement ─────────────────────────────────────────
  site_id            TEXT REFERENCES sites(id) ON DELETE SET NULL,
  rapproche_passe    TEXT,      -- 'designe' ou l'une des passes de lib/rattachement.js
  rapproche_confiance REAL,
  rapproche_motif    TEXT,
  rapproche_at       TEXT,

  -- Le lot d'import qui a écrit cette ligne pour la dernière fois : d'où vient
  -- la ligne, qui l'a chargée et quand. SET NULL plutôt que CASCADE — purger
  -- l'historique des lots ne doit pas emporter le référentiel lui-même.
  import_batch_id TEXT REFERENCES import_batch(id) ON DELETE SET NULL,

  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  rev          INTEGER NOT NULL DEFAULT 1
);

-- La clé métier. C'est cet index qui porte l'idempotence de l'import : l'upsert
-- de lib/codes.js s'appuie dessus, aucun code applicatif n'a à la garantir.
CREATE UNIQUE INDEX idx_code_ref_cle ON code_referentiel(referentiel, code);
-- Lister un référentiel et compter ses entrées sont les deux gestes de l'écran.
CREATE INDEX idx_code_ref_nom  ON code_referentiel(referentiel);
-- « Quels sites n'ont pas d'entrée » se lit par cet index, pas par un balayage.
CREATE INDEX idx_code_ref_site ON code_referentiel(site_id);
