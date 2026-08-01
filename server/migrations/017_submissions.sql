-- =====================================================================
--  Soumissions ODK et rattachement aux sites  (chantier O, lot C)
--
--  Jusqu'ici la chaîne ODK s'arrêtait au cache : `odk_forms.raw` garde le
--  dernier tirage, `datasets.raw` en fige une copie, et rien n'en sort. Aucune
--  soumission n'était donc rattachable à un site, ce qui rendait impossibles
--  les deux demandes du propriétaire du produit : « si 01 sites existe sur les
--  bases de données alors on note qu'il a été suivi » et « date de dernière
--  visite = dernière date de suivi disponible dans odk selon svydate ».
--
--  Cette table est le grain manquant : UNE ligne par soumission, conservée
--  qu'elle soit rattachée ou non.
--
--  Cinq choix qui se discutent, donc qui s'expliquent :
--
--  1. `site_id` est NULLABLE, et c'est le cœur du dispositif. Les quatre
--     XLSForms du bureau Madagascar portent quatre formes de code de site
--     différentes (p-code fokontany 13 caractères, p-code adm4 + numéro d'ordre
--     sur 16-17, entier hors référentiel pour SMP), et 7 codes GD_PREVMA
--     désignent deux points de distribution distincts. Une partie des
--     soumissions ne se rattachera donc à rien tant que le référentiel de sites
--     n'aura pas été complété. Les jeter, ou les rattacher au « site le plus
--     probable », ferait disparaître le travail à faire. Elles restent, avec le
--     motif de leur non-résolution — c'est la seule façon de le voir.
--
--  2. `resolution_motif` est NOT NULL, y compris quand le rattachement réussit.
--     Une ligne rattachée sans dire par quelle passe ni sur quel indice est une
--     ligne qu'on ne peut plus contester six mois plus tard.
--
--  3. `raw` conserve la soumission source entière. C'est ce qui permet de
--     rejouer le rattachement après avoir corrigé un code externe ou un nom de
--     site, sans re-tirer depuis ODK Central — un tirage plafonné à
--     20 000 lignes ne remonte pas indéfiniment dans le temps.
--
--  4. `lat`, `lon` et `gps_accuracy` sont sur la SOUMISSION, jamais recopiés
--     dans `sites`. Un geopoint dit où se tenait l'agent au moment de la
--     collecte, pas où est officiellement le site : sur un point de
--     distribution l'écart atteint plusieurs centaines de mètres, et plusieurs
--     soumissions produisent un nuage, pas un point. Écraser `sites.lat/lon`
--     détruirait sans trace la position déclarée — voir Q25 et Q26 de
--     docs/A_FAIRE.md, qui ne sont pas tranchées. La position observée est donc
--     servie comme une couche distincte (GET /api/submissions/positions).
--
--  5. Deux clés de source, toutes deux facultatives : `odk_form_id` quand la
--     soumission vient d'une source ODK déclarée, `connector_id` quand elle
--     vient d'un connecteur avec ses correspondances (migration 016). Une
--     soumission collée à la main n'a ni l'une ni l'autre, et reste valide :
--     `form_id`, lui, est toujours renseigné, parce que sans identifiant de
--     formulaire on ne sait plus quelle grille de variables a produit la ligne.
-- =====================================================================

CREATE TABLE submissions (
  id            TEXT PRIMARY KEY,
  -- Identifiant du formulaire d'origine, tel que la source le nomme.
  form_id       TEXT NOT NULL,
  -- ON DELETE SET NULL et non CASCADE : retirer une source de son écran de
  -- configuration ne doit pas effacer les soumissions déjà versées, qui portent
  -- des visites et des dates de dernier suivi.
  odk_form_id   TEXT REFERENCES odk_forms(id) ON DELETE SET NULL,
  connector_id  TEXT REFERENCES connector(id) ON DELETE SET NULL,
  -- La clé d'idempotence : deux tirages successifs se recouvrent au lieu de
  -- créer des doublons. C'est `__id` dans l'API OData d'ODK Central.
  instance_id   TEXT NOT NULL,
  submitted_at  TEXT,                 -- horodatage du dépôt sur le serveur
  svy_date      TEXT,                 -- SvyDate : la date DÉCLARÉE de collecte
  -- Ce que le formulaire portait, avant tout rattachement. Conservé brut : un
  -- code corrigé par le rattachement ferait perdre la trace de ce qui a été saisi.
  site_code_raw TEXT,
  site_name_raw TEXT,
  activity_tag  TEXT,
  site_id       TEXT REFERENCES sites(id) ON DELETE SET NULL,
  geo_pcode     TEXT,
  lat           REAL,
  lon           REAL,
  gps_accuracy  REAL,                 -- en mètres, 4e composante du geopoint
  -- Quelle passe a conclu ('code_externe', 'pcode_adm4', 'nom_activite',
  -- 'nom_seul'), ou NULL quand aucune n'a conclu. Pas de contrainte CHECK : la
  -- liste des passes vit dans lib/rattachement.js, où elle est écrite, testée et
  -- documentée. La recopier ici en ferait une seconde source de vérité.
  resolution_passe     TEXT,
  resolution_motif     TEXT NOT NULL DEFAULT '',
  -- Indice de confiance de 0 à 1. Il ne sert pas à trier automatiquement : il
  -- sert à ce qu'un humain sache lesquels relire en premier.
  resolution_confiance REAL NOT NULL DEFAULT 0,
  resolution_at        TEXT,
  raw           TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- L'unicité est portée par un index NOMMÉ plutôt que par un UNIQUE en ligne :
-- l'index implicite d'une contrainte s'appelle `sqlite_autoindex_…` et n'est ni
-- lisible dans un plan de requête, ni supprimable si la règle changeait.
CREATE UNIQUE INDEX idx_submissions_instance ON submissions(instance_id);

-- « Dernière date de suivi disponible dans odk selon svydate » se lit par un
-- MAX(svy_date) GROUP BY site_id : c'est exactement ce que cet index sert.
CREATE INDEX idx_submissions_site_date ON submissions(site_id, svy_date);
CREATE INDEX idx_submissions_form      ON submissions(form_id);
-- Les non résolues sont la file de travail : elles doivent se lister vite, et
-- elles sont minoritaires — d'où un index partiel plutôt qu'un index complet.
CREATE INDEX idx_submissions_orphelines ON submissions(created_at) WHERE site_id IS NULL;

-- ── Le code externe d'un site ────────────────────────────────────────
-- `sites.code` porte des identifiants internes générés (« L0001 ») et ne peut
-- pas accueillir « MG23210070009001 » : il est UNIQUE et sert de clé de
-- rapprochement entre deux imports du registre des sites.
--
-- `external_code` n'est délibérément PAS unique. Deux sites peuvent porter le
-- même code externe — c'est le cas avéré de 7 codes GD_PREVMA, que le XLSForm
-- autorise explicitement par `allow_choice_duplicates='yes'`. Une contrainte
-- d'unicité obligerait à en fausser un pour pouvoir enregistrer l'autre ; sans
-- elle, l'ambiguïté entre dans la base telle qu'elle est, et le résolveur la
-- traite pour ce qu'elle est : deux candidats égaux, donc aucun.
ALTER TABLE sites ADD COLUMN external_code TEXT;
CREATE INDEX idx_sites_external_code ON sites(external_code);

-- ── Une visite peut venir d'une soumission ───────────────────────────
-- « Si 01 sites existe sur les bases de données alors on note qu'il a été
-- suivi. » Marquer le suivi crée une visite ; relancer le traitement ne doit
-- pas en créer une seconde. L'index partiel unique fait porter cette garantie
-- par la base plutôt que par le code appelant : une idempotence qui ne tient
-- qu'à un `SELECT` préalable se perd à la première exécution concurrente.
ALTER TABLE visits ADD COLUMN submission_id TEXT REFERENCES submissions(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX idx_visits_submission ON visits(submission_id) WHERE submission_id IS NOT NULL;
