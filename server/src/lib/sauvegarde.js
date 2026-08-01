import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { db } from "../db.js";
import { config } from "../config.js";
import { log } from "./logger.js";

/* ═══════════════════════════════════════════════════════════════════════
   Sauvegarde et restauration — chantier K2 de docs/A_FAIRE.md.

   Deux règles portent tout ce fichier.

   1. UNE SAUVEGARDE N'EST PAS UNE COPIE DE FICHIER. La base tourne en WAL
      (db.js:11) : à tout instant une partie des transactions validées vit
      dans `mems.db-wal` et pas dans `mems.db`. `cp mems.db ailleurs.db`
      produit donc un fichier amputé des dernières transactions, et le plus
      souvent structurellement incohérent — on ne s'en aperçoit qu'au jour
      de la restauration. L'API de sauvegarde en ligne de SQLite, exposée
      par better-sqlite3 sous `db.backup()`, lit la base *par la connexion* :
      elle voit WAL compris, elle prend un verrou de lecture cohérent, et
      elle rend la main entre deux paquets de pages pour ne pas figer le
      serveur. C'est la seule façon correcte, et c'est celle employée ici.

   2. UNE SAUVEGARDE NON RELUE N'EST PAS UNE SAUVEGARDE. Chaque fichier
      produit est immédiatement rouvert, soumis à `integrity_check` et à
      `foreign_key_check`, et supprimé s'il échoue. Une sauvegarde dont on
      découvre le vice le jour du sinistre est pire que pas de sauvegarde :
      elle a fait renoncer aux autres.

   Sur le SECRET : le fichier produit est la base elle-même. Il contient donc
   `users.pw_hash` (empreintes bcrypt) et les colonnes `*_enc` (AES-256-GCM).
   Aucune des deux n'est un secret en clair, et la clé de déchiffrement
   (`DATA_KEY`) vit dans l'environnement, jamais dans la base : un fichier de
   sauvegarde ne permet pas de retrouver un jeton ODK. Il reste évidemment
   sensible — d'où la réserve au super-utilisateur et la journalisation de
   chaque téléchargement. ═══════════════════════════════════════════════ */

/* Les sauvegardes vivent à côté de la base, donc sur le volume que
   l'exploitant a déjà pensé à monter et à sauvegarder à son tour. Les
   déposer ailleurs supposerait une variable de configuration ; config.js
   est hors du périmètre de ce lot, et le répertoire de la base est de
   toute façon le seul emplacement dont on sait qu'il est accessible en
   écriture. */
export function dossierSauvegardes(){
  const d = path.join(path.dirname(path.resolve(config.dbFile)), "sauvegardes");
  if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true });
  return d;
}

/* Un nom de fichier arrive du client : il ne sert jamais tel quel à
   construire un chemin. On impose une forme close — pas de séparateur, pas
   de point d'entrée relatif — puis on vérifie que le chemin résolu tombe
   bien DANS le dossier des sauvegardes. Les deux contrôles sont redondants,
   et c'est voulu : le second tient encore si le premier est un jour élargi.
   La forme reste assez large pour accepter un fichier déposé à la main par
   l'exploitant, cas d'un transfert entre instances. */
const NOM_ACCEPTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.db$/;

export function cheminSauvegarde(nom){
  if(typeof nom !== "string" || !NOM_ACCEPTE.test(nom) || nom.includes(".."))
    return null;
  const dossier = dossierSauvegardes();
  const chemin = path.resolve(dossier, nom);
  if(path.dirname(chemin) !== path.resolve(dossier)) return null;
  return chemin;
}

/* « 2026-08-01T05:13:03.008Z » → « 20260801051303 » : les quatorze premiers
   caractères, soit la seconde. Le suffixe aléatoire tranche les collisions
   quand deux sauvegardes tombent dans la même seconde. */
const horodatage = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const suffixe = () => Array.from({ length:4 },
  () => ALPHA[Math.floor(Math.random()*ALPHA.length)]).join("");

/* ── Verrou d'entretien ──────────────────────────────────────────────
   Sauvegarde, VACUUM et point de contrôle WAL sont des opérations lourdes
   qui se gênent : un VACUUM réécrit toute la base pendant qu'une sauvegarde
   la lit page à page, et la sauvegarde repart alors de zéro — ou pire, se
   traîne indéfiniment.

   On pourrait croire le verrou inutile parce que better-sqlite3 est
   synchrone : tant qu'un VACUUM tourne, la boucle d'événements est bloquée
   et aucune autre requête ne démarre. C'est vrai du VACUUM et du point de
   contrôle. Ça ne l'est PAS de la sauvegarde : `db.backup()` rend la main
   entre deux paquets de pages, précisément pour ne pas figer le serveur.
   Pendant une sauvegarde, les autres requêtes s'exécutent — dont un VACUUM
   ou une seconde sauvegarde. Le verrou est donc une vraie protection, pas
   une précaution de principe. */
let _entretien = null;

export const entretienEnCours = () => _entretien
  ? { operation:_entretien.operation, par:_entretien.par,
      depuis:_entretien.depuis, ms: Date.now() - _entretien.t0 }
  : null;

export function prendreVerrou(operation, par){
  if(_entretien) return false;
  _entretien = { operation, par, depuis:new Date().toISOString(), t0:Date.now() };
  return true;
}
export function rendreVerrou(){ _entretien = null; }

/* ── Relecture d'un fichier de sauvegarde ──────────────────────────── */
export function verifier(chemin){
  let c;
  try{ c = new Database(chemin, { readonly:true, fileMustExist:true }); }
  catch(e){ return { lisible:false, motif:`fichier illisible par SQLite : ${e.message}` }; }
  try{
    const integrite = c.pragma("integrity_check", { simple:true });
    const violations = c.pragma("foreign_key_check").length;
    const tables = c.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`).all().map(r => r.name);
    const migrations = tables.includes("_migrations")
      ? c.prepare("SELECT name FROM _migrations ORDER BY name").all().map(r => r.name)
      : [];
    const lisible = integrite === "ok" && violations === 0 && tables.length > 0;
    return { lisible, integrite, violations, tables, migrations,
      motif: lisible ? null
        : `intégrité « ${integrite} », ${violations} violation(s) de clé étrangère` };
  }catch(e){
    return { lisible:false, motif:`relecture impossible : ${e.message}` };
  }finally{ try{ c?.close(); }catch{ /* rien à faire de plus */ } }
}

/* ── Produire une sauvegarde ───────────────────────────────────────── */
export async function sauvegarder({ motif = "manuelle" } = {}){
  const nom = `mems-${horodatage()}-${suffixe()}.db`;
  const chemin = path.join(dossierSauvegardes(), nom);
  const t0 = Date.now();
  const { totalPages } = await db.backup(chemin);
  const ms = Date.now() - t0;

  const controle = verifier(chemin);
  if(!controle.lisible){
    /* Un fichier douteux n'est pas conservé : il ferait croire à une
       sauvegarde là où il n'y en a pas. */
    try{ fs.unlinkSync(chemin); }catch{ /* déjà absent */ }
    const err = new Error(`la sauvegarde produite est illisible (${controle.motif})`);
    err.status = 500;
    throw err;
  }
  const octets = fs.statSync(chemin).size;
  log.info("sauvegarde produite", { fichier:nom, octets, ms, motif });
  return { nom, chemin, octets, ms, pages:totalPages, motif, controle };
}

export function listerSauvegardes(){
  const dossier = dossierSauvegardes();
  return fs.readdirSync(dossier)
    .filter(n => NOM_ACCEPTE.test(n))
    .map(n => {
      const s = fs.statSync(path.join(dossier, n));
      return { nom:n, octets:s.size, cree_le:s.mtime.toISOString() };
    })
    .sort((a, b) => b.cree_le.localeCompare(a.cree_le));
}

/* ── Restauration à chaud ────────────────────────────────────────────
   Le lot demandait de livrer la sauvegarde et d'expliquer si la restauration
   exigeait un redémarrage. Elle ne l'exige pas, et voici pourquoi la
   remplacer à chaud est ici *plus* sûr qu'un échange de fichiers.

   Ce qu'on ne peut PAS faire : écraser `mems.db` sur le disque. Le processus
   tient un descripteur ouvert sur l'ancien fichier ; il continuerait de lire
   et d'écrire dans l'inode remplacé, avec un WAL qui ne correspond plus à
   rien. C'est le scénario « base dans un état douteux » à éviter.

   Ce qu'on fait à la place : on attache le fichier de sauvegarde en seconde
   base, et on remplace le contenu de chaque table dans UNE transaction. Le
   schéma, lui, n'est pas touché — il est vérifié identique avant de
   commencer, ce que garantit l'égalité des jeux de migrations appliquées.
   L'atomicité vient alors de SQLite : si quoi que ce soit échoue, le ROLLBACK
   rend la base exactement telle qu'elle était. Il n'existe pas d'état
   intermédiaire observable.

   Deux détails qui ne s'improvisent pas :

   • `foreign_keys` est coupé le temps de l'opération, et REMIS ensuite dans
     un `finally`. Ce n'est pas un contournement : vider puis remplir cinquante
     tables liées entre elles viole forcément les clés étrangères en cours de
     route. On a d'abord essayé `defer_foreign_keys=ON`, qui reporte le
     contrôle au COMMIT — mesuré ici : le compteur de violations différées ne
     revient pas à zéro après un remplacement complet, et le COMMIT échoue
     alors que `foreign_key_check` ne trouve aucune violation. La méthode
     retenue est celle que documente SQLite pour la chirurgie de masse :
     couper l'application des clés, puis vérifier explicitement par
     `foreign_key_check` AVANT de valider, et refuser de valider s'il reste
     la moindre violation. Le contrôle est donc plus strict, pas moins.

   • L'écriture au journal d'audit a lieu APRÈS le COMMIT. La table `audit`
     fait partie des tables remplacées : une trace écrite avant serait effacée
     par la restauration elle-même. */
export function restaurer({ chemin, nom }){
  const refus = (message, status = 422) => {
    const e = new Error(message); e.status = status; return e;
  };

  const controle = verifier(chemin);
  if(!controle.lisible)
    throw refus(`sauvegarde inexploitable : ${controle.motif}`);

  const tablesVivantes = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`).all().map(r => r.name);
  const migrationsVivantes = db.prepare("SELECT name FROM _migrations ORDER BY name")
    .all().map(r => r.name);

  /* Un jeu de migrations différent, c'est un schéma différent : les colonnes
     ne se correspondent plus et un `INSERT … SELECT *` écrirait les valeurs
     dans les mauvaises colonnes, ou échouerait à mi-course. On refuse avant
     de commencer plutôt que de découvrir le problème pendant. */
  const absentes = migrationsVivantes.filter(m => !controle.migrations.includes(m));
  const surplus  = controle.migrations.filter(m => !migrationsVivantes.includes(m));
  if(absentes.length || surplus.length)
    throw refus("cette sauvegarde ne correspond pas au schéma de l'instance : "
      + `${absentes.length} migration(s) appliquée(s) ici et absente(s) du fichier, `
      + `${surplus.length} l'inverse. Restaurez-la sur une instance de même niveau.`);

  const ecart = tablesVivantes.filter(t => !controle.tables.includes(t))
    .concat(controle.tables.filter(t => !tablesVivantes.includes(t)));
  if(ecart.length)
    throw refus(`tables divergentes entre la base et la sauvegarde : ${ecart.join(", ")}`);

  const t0 = Date.now();
  db.prepare("ATTACH DATABASE ? AS restauration").run(chemin);
  /* `foreign_keys` est une propriété de connexion, jamais du fichier : la
     couper ici n'affecte ni la base au repos ni un autre processus. */
  db.pragma("foreign_keys = OFF");
  try{
    db.exec("BEGIN IMMEDIATE");
    try{
      for(const t of tablesVivantes) db.exec(`DELETE FROM main."${t}"`);
      for(const t of tablesVivantes)
        db.exec(`INSERT INTO main."${t}" SELECT * FROM restauration."${t}"`);
      const restantes = db.pragma("foreign_key_check");
      if(restantes.length)
        throw refus(`la sauvegarde restaurée laisserait ${restantes.length} `
          + "violation(s) de clé étrangère : restauration annulée", 409);
      db.exec("COMMIT");
    }catch(e){
      /* Le ROLLBACK est ce qui garantit qu'aucun état intermédiaire ne
         survit : s'il échouait à son tour, son erreur masquerait la cause
         réelle et rendrait l'incident illisible. On la laisse passer. */
      try{ db.exec("ROLLBACK"); }
      catch(annulation){ log.error("annulation de la restauration en échec",
        { message: annulation.message }); }
      throw e;
    }
  }finally{
    db.pragma("foreign_keys = ON");
    try{ db.exec("DETACH DATABASE restauration"); }catch{ /* déjà détachée */ }
  }
  const ms = Date.now() - t0;

  /* Le WAL porte encore tout le remplacement : on le replie tout de suite,
     sinon la première lecture venue traîne un journal de la taille de la base. */
  db.pragma("wal_checkpoint(TRUNCATE)");
  const apres = {
    integrite: db.pragma("integrity_check", { simple:true }),
    violations: db.pragma("foreign_key_check").length,
  };
  log.warn("base restaurée depuis une sauvegarde", { fichier:nom, ms, ...apres });
  return { ms, tables:tablesVivantes.length, apres };
}
