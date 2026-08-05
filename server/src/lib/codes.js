/* ═══════════════════════════════════════════════════════════════════════
   Le référentiel de codes d'identification — le domaine.

   Ce fichier est le SEUL écrivain de `code_referentiel` (migration 020). Deux
   gestes y vivent, et ils sont volontairement séparés :

     — CHARGER la liste, par l'import Excel (type « codes » de lib/import.js).
       C'est la table du bureau, telle qu'elle est ;
     — RAPPROCHER cette liste du registre des sites, ce qui pose des alias dans
       `site_external_code` et rend enfin les soumissions SMP rattachables.

   ── Pourquoi le rapprochement n'est pas un effet de bord de l'import ──
   Trois raisons, toutes vérifiables dans le code voisin :

     1. `apply()` doit rendre `{crees, modifies}` et n'a aucune place pour un
        bilan de rapprochement — qui serait donc muet ;
     2. le scénario réel est « charger, voir ce qui manque, créer les sites
        manquants, RE-rapprocher ». C'est déjà ce que dit lib/alias.js ;
     3. un rapprochement automatique qui échoue à moitié se lit comme un import
        réussi. Le seul compte rendu que l'opérateur verrait serait
        « 1 251 lignes créées », et les 300 écoles restées sans site
        n'apparaîtraient nulle part.

   ── Le rapprochement réutilise le résolveur, il n'écrit pas une règle ──
   `construireIndex` une fois pour le lot, puis `resoudre` par entrée
   (lib/rattachement.js). Bénéfice décisif : une seule normalisation de code et
   de nom, un seul refus de trancher entre deux candidats égaux, et des motifs
   en français déjà rédigés. Une seconde règle écrite ici finirait par diverger
   de celle qui rattache réellement les soumissions — et l'écran annoncerait
   alors des rattachements que l'ingestion ne fait pas.

   ── Le seuil de preuve, et le cliquet qu'il évite ────────────────────
   Poser un alias n'est pas anodin : le code entre dans l'index, si bien qu'au
   rapprochement SUIVANT la passe « code externe » le retrouve à confiance 1,0.
   Une hypothèse à 0,4 (`nom_seul`) deviendrait ainsi une certitude au second
   passage, sans que personne n'ait rien confirmé — un cliquet silencieux,
   exactement ce que lib/rattachement.js s'interdit en tête de fichier.

   D'où `SEUIL_ALIAS` : rien n'est posé sous la confiance d'un p-code adm4. Les
   conclusions plus faibles sont ENREGISTRÉES sur l'entrée et comptées « à
   confirmer » — elles ne rattachent rien et ne se propagent pas.

   ── Relancer est sûr, et plus fort que la première fois ──────────────
   L'import est idempotent par l'index unique (referentiel, code) ; les alias le
   sont par celui de la migration 018 ; le rapprochement recalcule et réécrit les
   mêmes colonnes de trace. Relancé deux fois de suite il rend le même bilan avec
   `alias:0` au second tour. Le second passage est de surcroît PLUS FORT que le
   premier, puisque les alias posés au premier alimentent l'index — un lecteur
   qui l'ignore prendrait ce gain pour une instabilité.

   Sûr ne veut pas dire sans effet, et la nuance se paie cher si on la tait :
   quand le registre a bougé entre deux passages — un code MEMS corrigé sur une
   fiche de site, une désignation rectifiée dans le fichier — une entrée peut
   PERDRE son site. C'est la bonne conclusion (le fichier ne la soutient plus),
   mais c'est une perte : elle est comptée `detachees`, nommée dans le bilan et
   portée au journal, plutôt que constatée six mois plus tard sur un écran qui
   affiche « 0 rattachée ».
   ═══════════════════════════════════════════════════════════════════════ */

import { db, tx } from "../db.js";
import { newId } from "./crypto.js";
import { poserAliasExclusif } from "./alias.js";
import { CONFIANCE, construireIndex, normaliserCode, resoudre } from "./rattachement.js";

/* La passe qu'aucune passe automatique ne peut produire : l'entrée désigne son
   site par son code MEMS, dans la colonne prévue du modèle. C'est une décision
   humaine écrite dans le fichier, elle l'emporte sur le résolveur. */
export const PASSE_DESIGNEE = "designe";

/* Le seuil de preuve, exprimé par référence et non par un 0,7 recopié : les
   deux ne peuvent pas diverger le jour où la table des confiances bouge. */
export const SEUIL_ALIAS = CONFIANCE.pcode_adm4;

/* Combien d'échecs sont NOMMÉS dans un bilan. Un compte seul ne se corrige pas ;
   une liste de 1 251 lignes dans une réponse JSON ne se lit pas non plus. */
const LIMITE_LISTE = 50;

const propre = (v) => {
  if(v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/* ── Écriture des entrées ─────────────────────────────────────────────
   Appelée par `apply()` du type d'import « codes », donc DÉJÀ dans une
   transaction (lib/import.js). Elle ne touche jamais les colonnes de trace du
   rapprochement : recharger le fichier corrige des libellés, il ne défait pas
   des rattachements que quelqu'un est allé chercher.

   L'idempotence tient à `ON CONFLICT(referentiel, code)`, c'est-à-dire à
   l'index unique de la migration 020. Le SELECT préalable ne sert qu'à
   DISTINGUER une création d'une modification pour le compte rendu — il ne
   garantit rien, et c'est voulu : deux imports simultanés ne peuvent pas passer
   entre les gouttes d'un contrôle applicatif. */
/* TODO-PG: appelée par apply() du type d'import « codes » (lib/import.js, hors
   périmètre de cette conversion), qui l'exécute aujourd'hui dans SA PROPRE
   transaction via l'objet `db` importé globalement ici, pas via un exécuteur
   transmis par l'appelant. Tant que lib/import.js n'est pas lui-même porté au
   contrat async de db.js, les requêtes ci-dessous passeront par le pool plutôt
   que par la connexion de la transaction d'import — à vérifier une fois ce
   fichier converti. */
export async function ecrireEntrees(rows, ctx = {}){
  const existe = db.prepare("SELECT id FROM code_referentiel WHERE referentiel=? AND code=?");
  /* Les colonnes que le fichier ne portait pas ne sont pas réécrites. `readUpload`
     rend "" pour une colonne absente de la feuille, ce qui est indiscernable
     d'une case vidée : sans cette exclusion, reconstruire sa feuille en n'y
     gardant que le code et le libellé effaçait le code de site MEMS et la source
     de chacune des 1 251 lignes réimportées. Le fichier ne dit rien de ces
     colonnes ; on n'en conclut rien. */
  const absentes = new Set(ctx.absentes || []);
  const MODIFIABLES = ["libelle","geo_pcode","adm1","adm2","adm3","adm4",
    "site_code","source","note"];
  const ecrites = MODIFIABLES.filter(f => !absentes.has(f));
  const ecrire = db.prepare(`INSERT INTO code_referentiel
    (id, referentiel, code, libelle, geo_pcode, adm1, adm2, adm3, adm4,
     site_code, source, note, import_batch_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(referentiel, code) DO UPDATE SET
      ${ecrites.map(f => `${f}=excluded.${f}`).join(", ")}${ecrites.length ? "," : ""}
      import_batch_id=excluded.import_batch_id,
      updated_at=now(), rev=rev+1`);

  let crees = 0, modifies = 0;
  for(const r of rows){
    const referentiel = propre(r.referentiel);
    const code = propre(r.code);
    if(!referentiel || !code) continue;      /* déjà refusé par zod en amont */
    if(await existe.get(referentiel, code)) modifies++; else crees++;
    await ecrire.run(newId("cref"), referentiel, code, propre(r.libelle), propre(r.geo_pcode),
      propre(r.adm1), propre(r.adm2), propre(r.adm3), propre(r.adm4),
      propre(r.site_code), propre(r.source), propre(r.note), ctx.batchId || null);
  }
  return { crees, modifies };
}

/* ── Compteurs ────────────────────────────────────────────────────────
   La partition est stricte et se lit d'un coup d'œil :

     rattachée    site_id renseigné — une preuve suffisante a été trouvée
     à confirmer  une piste existe (passe et motif écrits) mais sous le seuil
     sans site    rapprochée, et rien trouvé — le motif dit quoi
     jamais rapprochée  chargée, pas encore confrontée au registre

   Les quatre s'additionnent au total. Un écran qui n'en montrerait que deux
   laisserait croire que le reste n'existe pas. */
const COMPTEURS = `
  COUNT(*) entrees,
  SUM(CASE WHEN site_id IS NOT NULL THEN 1 ELSE 0 END) rattachees,
  SUM(CASE WHEN site_id IS NULL AND rapproche_passe IS NOT NULL THEN 1 ELSE 0 END) aConfirmer,
  SUM(CASE WHEN site_id IS NULL AND rapproche_passe IS NULL AND rapproche_at IS NOT NULL
           THEN 1 ELSE 0 END) sansSite,
  SUM(CASE WHEN rapproche_at IS NULL THEN 1 ELSE 0 END) jamaisRapprochees,
  MAX(rapproche_at) dernierRapprochement,
  MAX(updated_at) dernierChargement`;

export const listerReferentiels = () =>
  db.prepare(`SELECT referentiel, ${COMPTEURS}
              FROM code_referentiel GROUP BY referentiel ORDER BY referentiel`).all();

/* Les sites que ce référentiel ne couvre pas, VENTILÉS PAR ACTIVITÉ.

   Jamais en nombre brut, et ce n'est pas un ornement : pour un référentiel
   d'écoles SMP, les centaines de points de distribution URT sans entrée sont
   parfaitement normaux. Les afficher au même rang que les douze écoles
   réellement manquantes noierait la seule information utile, et l'écran serait
   ignoré au bout de deux semaines. */
export function sitesSansEntree(referentiel, office_id = null){
  return db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(s.activity_tag),''), '(sans activité)') tag, COUNT(*) sites
    FROM sites s
    WHERE ${office_id ? "s.office_id = ? AND" : ""} s.id NOT IN (
      SELECT site_id FROM code_referentiel WHERE referentiel = ? AND site_id IS NOT NULL)
    GROUP BY tag ORDER BY sites DESC, tag`)
    .all(...(office_id ? [office_id] : []), referentiel);
}

/* L'état, lu sans rien recalculer ni écrire. C'est ce que l'écran interroge à
   l'ouverture ; relancer un rapprochement pour connaître son résultat serait
   payer une écriture pour une lecture. */
export async function etatRapprochement(referentiel, office_id = null){
  const c = await db.prepare(`SELECT ${COMPTEURS} FROM code_referentiel WHERE referentiel=?`)
    .get(referentiel);
  /* Sur un référentiel inconnu, SQLite rend 0 pour le COUNT et NULL pour chaque
     SUM. Un « — » à l'écran là où l'on attend « 0 » se lit comme une panne. */
  const n = (v) => v || 0;
  return { referentiel,
    entrees: n(c.entrees), rattachees: n(c.rattachees), aConfirmer: n(c.aConfirmer),
    sansSite: n(c.sansSite), jamaisRapprochees: n(c.jamaisRapprochees),
    dernierRapprochement: c.dernierRapprochement || null,
    dernierChargement: c.dernierChargement || null,
    sitesSansEntree: await sitesSansEntree(referentiel, office_id),
    seuil: SEUIL_ALIAS };
}

/* ── Consultation ─────────────────────────────────────────────────────
   La recherche porte sur le code ET le libellé : l'opérateur arrive avec l'un
   ou avec l'autre, jamais avec les deux.

   Le site rattaché est joint SOUS RÉSERVE DU BUREAU de l'appelant. Les entrées,
   elles, restent visibles de tous — c'est un référentiel national. Un compte
   borné voit donc qu'une entrée est rattachée sans apprendre à quel site d'un
   autre bureau : `rattacheHorsBureau` le dit, plutôt que de faire passer un
   rattachement existant pour une absence.

   ── Le motif suit la même règle que la jointure ───────────────────────
   Il est rédigé par le résolveur, qui NOMME les sites : « rapproché à
   l'identique du site « EPP Lot B » (LOTB-2) », « un seul site correspond… ».
   Servi tel quel, il rendrait la jointure bornée décorative — il suffirait de
   lire la colonne « Pourquoi » pour énumérer le nom et le code MEMS des sites
   d'un autre bureau, y compris les homonymes que le résolveur a refusé de
   départager. Un compte borné ne le reçoit donc que lorsqu'il porte sur un site
   qu'il a le droit de voir ; sinon il apprend qu'une conclusion existe, et à qui
   la demander. Le rapprochement, lui, construit son index avec le même bornage :
   ce qu'un bureau écrit ne nomme jamais que ses propres sites. */
export async function lister({ referentiel, q = "", rattache = "", limit = 100, offset = 0,
                         office_id = null } = {}){
  const where = ["c.referentiel = ?"];
  const args = [referentiel];
  const terme = String(q || "").trim();
  if(terme){
    where.push("(c.code LIKE ? OR c.libelle LIKE ?)");
    args.push(`%${terme}%`, `%${terme}%`);
  }
  if(rattache === "oui") where.push("c.site_id IS NOT NULL");
  if(rattache === "non") where.push("c.site_id IS NULL");

  const total = (await db.prepare(`SELECT COUNT(*) c FROM code_referentiel c WHERE ${where.join(" AND ")}`)
    .get(...args)).c;
  const rows = await db.prepare(`
    SELECT c.id, c.referentiel, c.code, c.libelle, c.geo_pcode, c.adm1, c.adm2, c.adm3, c.adm4,
           c.site_code, c.source, c.note, c.site_id, c.rapproche_passe, c.rapproche_confiance,
           c.rapproche_motif, c.rapproche_at, c.updated_at,
           s.code siteCode, s.name siteNom
    FROM code_referentiel c
    LEFT JOIN sites s ON s.id = c.site_id ${office_id ? "AND s.office_id = ?" : ""}
    WHERE ${where.join(" AND ")}
    ORDER BY c.code LIMIT ? OFFSET ?`)
    .all(...(office_id ? [office_id] : []), ...args, Math.min(500, limit), offset);

  const motifServi = (r) => {
    if(!office_id || (r.site_id && r.siteCode)) return r.rapproche_motif;
    if(!r.rapproche_motif) return r.rapproche_motif;
    return r.site_id
      ? "cette entrée est rattachée à un site d'un autre bureau : le détail nomme ce site, "
        + "il n'est pas servi hors de son périmètre"
      : "le rapprochement a été mené sur le registre national : son détail nomme des sites "
        + "d'autres bureaux et n'est pas servi hors de leur périmètre";
  };
  return { total, rows: rows.map(r => ({ ...r,
    rapproche_motif: motifServi(r),
    rattacheHorsBureau: !!r.site_id && !r.siteCode })) };
}

/* ── Le rapprochement ─────────────────────────────────────────────────
   `office_id` borne le registre des sites, exactement comme le fait
   `importerCorrespondances` (lib/alias.js) et pour la même raison : un bureau ne
   déclare pas les codes des sites d'un autre, même par homonymie. Le référentiel,
   lui, n'a pas de bureau — c'est la lecture qui est nationale, pas l'écriture
   dans `sites`. */
export async function rapprocher({ referentiel, office_id = null }){
  const entrees = await db.prepare(`SELECT id, code, libelle, geo_pcode, site_code, site_id
                              FROM code_referentiel WHERE referentiel=? ORDER BY code`)
    .all(referentiel);

  const vide = { referentiel, lues:0, rattachees:0, alias:0, aliasRetires:0, dejaPresents:0,
    detachees:[], detacheesTotal:0,
    aConfirmer:[], aConfirmerTotal:0, sansSite:[], sansSiteTotal:0,
    sitesSansEntree: await sitesSansEntree(referentiel, office_id), codesAmbigus:[],
    seuil: SEUIL_ALIAS };
  if(!entrees.length) return vide;

  const index = await construireIndex({ office_id });
  const siteDesigne = db.prepare(`SELECT id, code, name FROM sites WHERE code = ?
    ${office_id ? "AND office_id = ?" : ""}`);

  /* La conclusion, entrée par entrée. Aucune écriture ici : on décide d'abord,
     on écrit ensuite en une transaction. */
  const conclusions = [];
  for(const e of entrees){
    const designation = propre(e.site_code);
    if(designation){
      const s = await siteDesigne.get(...(office_id ? [designation, office_id] : [designation]));
      /* Désignation explicite mais introuvable : PAS de repli sur le résolveur.
         Quelqu'un a écrit « ce site-là » ; deviner autre chose à sa place
         reviendrait à passer outre la seule instruction humaine de la ligne. */
      if(!s){ conclusions.push({ e, site_id:null, passe:null, confiance:0,
        motif:`le code de site MEMS « ${designation} » écrit dans le fichier ne désigne `
          + `aucun site${office_id ? " de votre bureau" : ""} : créez le site, ou corrigez la colonne` });
        continue; }
      conclusions.push({ e, site_id:s.id, passe:PASSE_DESIGNEE, confiance:1,
        motif:`site désigné explicitement dans le fichier par son code MEMS « ${s.code} » `
          + `— « ${s.name} »` });
      continue;
    }
    /* L'activité est volontairement nulle : une entrée de référentiel dit un
       code et un nom, elle ne dit pas au titre de quel programme le site est
       suivi. Passer une activité inventée ferait échouer la passe (c) sur un
       critère que le fichier ne porte pas.

       `sujet` nomme ce qu'on rapproche : le résolveur est écrit pour des
       soumissions, et servir « la soumission ne porte aucun nom de site » à un
       opérateur qui vient de charger un tableur lui parle d'un objet qu'il n'a
       jamais manipulé. Même règle, même code, même motif — un mot près. */
    const r = await resoudre({ site_code_raw: e.code, site_name_raw: e.libelle,
      activity_tag: null, geo_pcode: e.geo_pcode }, index, { sujet: "l'entrée" });
    conclusions.push({ e, site_id:r.site_id, passe:r.passe, confiance:r.confiance, motif:r.motif });
  }

  /* Ce qui sera RETENU, décidé avant toute écriture. Le seuil de preuve ne dépend
     que de la conclusion : le rejouer une seconde fois pour compter ferait deux
     règles là où il n'en faut qu'une. */
  const retenus = new Map(conclusions.map(c =>
    [c.e.id, c.passe === PASSE_DESIGNEE || c.confiance >= SEUIL_ALIAS ? c.site_id : null]));

  let alias = 0, aliasRetires = 0, dejaPresents = 0, rattachees = 0;
  const aConfirmer = [], sansSite = [], detachees = [];

  await tx(async (db) => {
    const trace = db.prepare(`UPDATE code_referentiel
      SET site_id=?, rapproche_passe=?, rapproche_confiance=?, rapproche_motif=?,
          rapproche_at=now(), updated_at=now()
      WHERE id=?`);
    for(const c of conclusions){
      const retenu = retenus.get(c.e.id);
      /* La trace AVANT l'alias, jamais après : si la pose échouait, l'entrée
         dirait tout de même ce qui a été conclu et sur quelle preuve. */
      await trace.run(retenu, c.passe, c.confiance || 0, c.motif, c.e.id);

      /* Une entrée qui PERD son site est un événement, pas un non-résultat : le
         fichier a changé, ou le site a été renommé, et personne ne le saurait
         d'un bilan qui ne compte que les gains. Relancer le rapprochement reste
         sûr pour les alias — ils sont repris ci-dessous — mais ce n'est pas
         « sans effet », et l'écran ne doit pas le promettre. */
      if(c.e.site_id && retenu !== c.e.site_id && detachees.length < LIMITE_LISTE)
        detachees.push({ code:c.e.code, libelle:c.e.libelle, motif:c.motif });

      if(retenu){
        rattachees++;
        /* Exclusif, et non simplement ajouté : la conclusion d'aujourd'hui
           REMPLACE celle d'hier pour cette source. Sans cela, corriger une
           désignation erronée laissait les deux codes en place, le code
           désignait deux sites, et le résolveur cessait de trancher — la
           correction cassait ce qu'elle venait réparer.
           TODO-PG: poserAliasExclusif (lib/alias.js) ouvre SA PROPRE transaction
           (son propre client via tx()) au lieu d'utiliser l'exécuteur `db` de la
           transaction en cours ici. Sur Postgres, ceci casse l'atomicité globale
           du rapprochement — un DELETE+INSERT d'alias se valide indépendamment
           de `trace.run` ci-dessus, alors qu'en SQLite/better-sqlite3 les deux
           partageaient la même connexion. À revoir : soit poserAliasExclusif
           accepte un exécuteur optionnel, soit ce bloc n'est plus dans une seule
           transaction — décision hors du périmètre mécanique de ce portage. */
        const pose = await poserAliasExclusif({ site_id: retenu, code: c.e.code, source: referentiel,
          note: `entrée du référentiel « ${referentiel} »`
            + (c.e.libelle ? ` — ${c.e.libelle}` : "") });
        aliasRetires += pose.retires;
        if(pose.cree) alias++; else dejaPresents++;
      } else if(c.site_id){
        /* Une piste sous le seuil : enregistrée, comptée, et rien de plus. */
        if(aConfirmer.length < LIMITE_LISTE) aConfirmer.push({ code:c.e.code,
          libelle:c.e.libelle, passe:c.passe, confiance:c.confiance, motif:c.motif });
      } else if(sansSite.length < LIMITE_LISTE){
        sansSite.push({ code:c.e.code, libelle:c.e.libelle, motif:c.motif });
      }
    }
  });

  const aConfirmerTotal = conclusions.filter(c =>
    c.site_id && c.passe !== PASSE_DESIGNEE && c.confiance < SEUIL_ALIAS).length;
  const sansSiteTotal = conclusions.filter(c => !c.site_id).length;
  const detacheesTotal = conclusions.filter(c =>
    c.e.site_id && retenus.get(c.e.id) !== c.e.site_id).length;

  /* ── Les codes devenus ambigus ─────────────────────────────────────
     Même calcul qu'à lib/alias.js : on relit l'index que le résolveur
     construira lui-même, de sorte que ce que ce bilan annonce comme ambigu soit
     EXACTEMENT ce que le rattachement refusera de trancher. L'index est
     reconstruit quand des alias viennent d'être posés — celui du début les
     ignore, et signaler l'ambiguïté d'après un état périmé serait pire que se
     taire. */
  const apres = alias ? await construireIndex({ office_id }) : index;
  const vus = new Set();
  const codesAmbigus = [];
  for(const e of entrees){
    const n = normaliserCode(e.code);
    if(!n || vus.has(n)) continue;
    vus.add(n);
    const ids = apres.parCode.get(n) || [];
    if(ids.length > 1 && codesAmbigus.length < LIMITE_LISTE)
      codesAmbigus.push({ code:e.code, sites: ids.map(id => ({ id,
        code: apres.parId.get(id)?.code, name: apres.parId.get(id)?.name })) });
  }

  return { referentiel, lues: entrees.length, rattachees, alias, aliasRetires, dejaPresents,
    detachees, detacheesTotal,
    aConfirmer, aConfirmerTotal, sansSite, sansSiteTotal,
    sitesSansEntree: await sitesSansEntree(referentiel, office_id),
    codesAmbigus, seuil: SEUIL_ALIAS, limiteListe: LIMITE_LISTE };
}
