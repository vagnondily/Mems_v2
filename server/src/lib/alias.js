/* ═══════════════════════════════════════════════════════════════════════
   Les codes externes d'un site — la table de correspondance.

   Un site n'a pas UN code externe, il en a autant que de sources qui le
   désignent. GD_PREVMA l'appelle « MG51507010014 », MIARO « MG51507010014001 »,
   SMP « 603140007 » — un entier qui n'appartient à aucun référentiel p-code et
   ne se déduit donc de rien. Ce fichier tient cette relation, et rien d'autre :
   le rapprochement lui-même reste dans lib/rattachement.js.

   ── Le code par défaut et les alias ──────────────────────────────────
   `sites.external_code` reste le code par défaut, saisi sur la fiche de site.
   Il est MIROITÉ ici sous la source réservée `SOURCE_FICHE`, pour qu'un écran
   puisse lister tous les codes d'un site en une seule requête. Ce miroir est la
   SEULE ligne qu'une modification de la fiche remplace : un alias importé
   depuis une table de correspondance ne bouge jamais quand on corrige la fiche,
   et réciproquement.

   Conséquence voulue : corriger une faute de frappe dans le code par défaut
   retire l'ancien du jeu. Une table qui ne serait qu'un historique continuerait
   à rattacher des soumissions sur un code que quelqu'un a explicitement
   désavoué — en silence, ce qui est la seule chose que cette chaîne s'interdit.

   ── Pourquoi le code est stocké tel qu'il est écrit ──────────────────
   Ni majuscules forcées, ni ponctuation retirée : seulement les espaces de
   bord. Le rapprochement, lui, normalise (lib/rattachement.js) — « mg 232 »
   et « MG232 » y sont le même code. Stocker la forme normalisée ferait
   disparaître l'écriture que l'opérateur reconnaît dans son fichier source, et
   rendrait un import impossible à relire ligne à ligne contre son original.
   ═══════════════════════════════════════════════════════════════════════ */

import { db, tx } from "../db.js";
import { newId } from "./crypto.js";
import { construireIndex, normaliserCode } from "./rattachement.js";

/* La source réservée au miroir de `sites.external_code`. Elle n'est pas un
   form_id : aucun formulaire ne peut porter ce nom sans qu'on le remarque, et
   c'est précisément ce qui permet de distinguer le miroir d'un alias importé.

   Depuis que le NOM D'UN RÉFÉRENTIEL, saisi librement, alimente lui aussi la
   colonne `source` (lib/codes.js), cette réserve doit être opposable : un
   référentiel baptisé « fiche du site » verrait tous ses codes effacés par la
   première édition de fiche venue, `synchroniserCodeParDefaut` étant un
   delete-then-insert sur cette source. D'où le refus, posé là où la valeur entre
   — le nom du référentiel, à l'import comme sur les routes. */
export const SOURCE_FICHE = "fiche du site";
export const estSourceReservee = (v) =>
  String(v ?? "").trim().toLowerCase() === SOURCE_FICHE.toLowerCase();
export const MOTIF_SOURCE_RESERVEE =
  `« ${SOURCE_FICHE} » est réservé au code par défaut de la fiche de site : un `
  + "référentiel portant ce nom verrait ses codes effacés à la première correction "
  + "de fiche. Choisissez un autre nom.";

const propre = (v) => {
  if(v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/* Tous les codes d'un site, le code par défaut compris. Le miroir de la fiche
   est déjà dans la table : la colonne n'est donc pas relue ici, sans quoi le
   code par défaut apparaîtrait deux fois dans la liste servie à l'écran. */
export const listerAlias = (site_id) =>
  db.prepare(`SELECT id, site_id, code, source, note, created_at
              FROM site_external_code WHERE site_id=?
              ORDER BY (source = ?) DESC, source, code`).all(site_id, SOURCE_FICHE);

/* Crée un alias, ou constate qu'il existe déjà. L'idempotence est portée par
   l'index unique (migration 018), pas par un SELECT préalable : deux imports
   simultanés du même fichier ne peuvent donc pas passer entre les gouttes.

   La migration 018 pose DEUX index uniques selon que `source` est renseignée
   ou non — `(site_id, code, source)` d'une part, `(site_id, code) WHERE
   source IS NULL` d'autre part, parce que Postgres, comme SQLite, ne traite
   jamais deux NULL comme égaux : le premier n'empêche donc pas deux alias
   `source IS NULL`. L'arbitre du ON CONFLICT est donc choisi selon le cas.

   `exec` : l'exécuteur à utiliser (le pool par défaut, ou le client d'une
   transaction en cours — voir poserAliasExclusif et importerCorrespondances
   ci-dessous, qui doivent écrire sur LA MÊME connexion que le reste de leur
   transaction pour rester atomiques). */
export async function ajouterAlias({ site_id, code, source = null, note = null }, exec = db){
  const c = propre(code);
  if(!c) return { cree: false, motif: "code vide" };
  const s = propre(source);
  const arbitre = s === null ? "(site_id, code) WHERE source IS NULL" : "(site_id, code, source)";
  const res = await exec.prepare(`INSERT INTO site_external_code (id, site_id, code, source, note)
                          VALUES (?,?,?,?,?)
                          ON CONFLICT ${arbitre} DO NOTHING`)
    .run(newId("alias"), site_id, c, s, propre(note));
  return { cree: res.changes === 1 };
}

export const supprimerAlias = async (id) =>
  (await db.prepare("DELETE FROM site_external_code WHERE id=?").run(id)).changes === 1;

/* Pose un alias en RETIRANT ceux que la même source portait sur le même code
   pour un autre site. C'est le geste du rapprochement, et il n'est pas
   interchangeable avec `ajouterAlias` : une source qui se corrige — l'entrée
   désignait le mauvais site, le bureau réédite son fichier — laissait sinon
   derrière elle sa conclusion d'hier. Le code désignait alors deux sites, le
   résolveur refusait de trancher (lib/rattachement.js), et la correction cassait
   le rattachement qu'elle venait débloquer.

   La règle est celle qu'énonce déjà `synchroniserCodeParDefaut` juste au-dessus :
   dans UNE source, un code désigne UN site. D'une source à l'autre, l'ambiguïté
   reste possible et reste signalée — deux référentiels qui se contredisent sont
   un fait à porter à la connaissance de l'opérateur, pas une erreur d'écriture. */
export async function poserAliasExclusif({ site_id, code, source = null, note = null }){
  const c = propre(code);
  if(!c) return { cree:false, retires:0, motif:"code vide" };
  const s = propre(source);
  let retires = 0;
  const res = await tx(async (db) => {
    retires = (await db.prepare(`DELETE FROM site_external_code
                          WHERE code=? AND site_id<>? AND source IS ?`).run(c, site_id, s)).changes;
    return ajouterAlias({ site_id, code:c, source:s, note }, db);
  });
  return { ...res, retires };
}

/* Aligne le miroir de la fiche sur la valeur de la colonne. Appelée après toute
   écriture qui touche `sites.external_code`, et seulement dans ce cas : un site
   dont on renomme l'antenne n'a aucune raison de voir ses alias remaniés. */
export async function synchroniserCodeParDefaut(site_id, code){
  const c = propre(code);
  await tx(async (db) => {
    await db.prepare("DELETE FROM site_external_code WHERE site_id=? AND source=?")
      .run(site_id, SOURCE_FICHE);
    /* `source` vaut toujours SOURCE_FICHE ici (non nulle) : l'arbitre est donc
       sans ambiguïté l'index unique du triplet (site_id, code, source). */
    if(c) await db.prepare(`INSERT INTO site_external_code (id, site_id, code, source, note)
                      VALUES (?,?,?,?,?)
                      ON CONFLICT (site_id, code, source) DO NOTHING`)
      .run(newId("alias"), site_id, c, SOURCE_FICHE, "code par défaut de la fiche de site");
  });
}

/* ── Import d'une table de correspondance ─────────────────────────────
   C'est ce qui débloque SMP : le bureau possède la liste des 1 251 codes école,
   MEMS doit pouvoir l'avaler d'un coup plutôt que site par site.

   Chaque ligne désigne son site par `site_code` (le code métier MEMS, celui que
   l'opérateur lit dans son tableur) ou par `site_id`. Rien n'est deviné : une
   ligne dont le site est introuvable est REFUSÉE et LISTÉE. Un import qui
   avalerait 1 251 lignes en n'en rattachant que 900 sans dire lesquelles
   manquent ne serait pas un import, ce serait une perte de données lente.

   Idempotent : rejouer le même fichier ne crée rien et le dit
   (`dejaPresents`). L'index unique de la migration 018 en est la garantie. */
export async function importerCorrespondances({ lignes, office_id = null, source = null }){
  const parCodeSite = db.prepare("SELECT id, code, name, office_id FROM sites WHERE code=?");
  const parIdSite   = db.prepare("SELECT id, code, name, office_id FROM sites WHERE id=?");

  const sitesIntrouvables = [];
  const invalides = [];
  const aCreer = [];

  let i = 0;
  for(const l of (lignes || [])){
    const ligne = ++i;
    const code = propre(l?.code);
    if(!code){ invalides.push({ ligne, message: "code externe absent" }); continue; }
    const siteCode = propre(l?.site_code);
    const siteId = propre(l?.site_id);
    if(!siteCode && !siteId){
      invalides.push({ ligne, code, message: "ni site_code ni site_id" });
      continue;
    }
    const site = siteId ? await parIdSite.get(siteId) : await parCodeSite.get(siteCode);
    if(!site){
      sitesIntrouvables.push({ ligne, code, site_code: siteCode, site_id: siteId,
        message: "aucun site ne porte cet identifiant dans le registre" });
      continue;
    }
    /* Le cloisonnement par bureau s'applique ici comme au rapprochement : un
       bureau ne déclare pas les codes des sites d'un autre. Le motif est
       explicite plutôt que confondu avec « introuvable » — un opérateur qui
       lit « hors de votre bureau » sait à qui s'adresser. */
    if(office_id && site.office_id !== office_id){
      sitesIntrouvables.push({ ligne, code, site_code: site.code, site_id: site.id,
        message: "ce site relève d'un autre bureau" });
      continue;
    }
    aCreer.push({ ligne, site, code,
      source: propre(l?.source) ?? propre(source),
      note: propre(l?.note) });
  }

  let crees = 0, dejaPresents = 0;
  await tx(async (db) => {
    for(const x of aCreer){
      if((await ajouterAlias({ site_id: x.site.id, code: x.code, source: x.source, note: x.note }, db)).cree)
        crees++;
      else dejaPresents++;
    }
  });

  /* ── Les doublons de code, une fois l'import posé ──────────────────
     Signalés en relisant l'index que le résolveur construira lui-même : ce que
     l'import annonce comme ambigu est donc exactement ce que le rattachement
     refusera de trancher, sans qu'une seconde règle ait été écrite ici. */
  const index = aCreer.length ? await construireIndex({ office_id }) : { parCode: new Map(), parId: new Map() };
  const vus = new Set();
  const codesAmbigus = [];
  for(const x of aCreer){
    const n = normaliserCode(x.code);
    if(!n || vus.has(n)) continue;
    vus.add(n);
    const ids = index.parCode.get(n) || [];
    if(ids.length > 1) codesAmbigus.push({ code: x.code,
      sites: ids.map(id => ({ id, code: index.parId.get(id)?.code,
                              name: index.parId.get(id)?.name })) });
  }

  return { lues: (lignes || []).length, crees, dejaPresents,
    sitesIntrouvables, invalides, codesAmbigus };
}
