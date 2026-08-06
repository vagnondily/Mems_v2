import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { db, pool } from "../db.js";
import { config } from "../config.js";
import { log } from "./logger.js";

/* ═══════════════════════════════════════════════════════════════════════
   Sauvegarde et restauration — chantier K2 de docs/A_FAIRE.md, porté sur
   PostgreSQL.

   La version SQLite lisait la base par la connexion (`db.backup()`, cohérent
   avec le WAL) et rejouait un ATTACH DATABASE + remplacement table par table
   pour restaurer. Aucun des deux ne s'applique à Postgres, qui a son propre
   outillage EXACTEMENT fait pour ça :

   - `pg_dump -Fc` produit un dump binaire cohérent — un instantané pris par
     la base elle-même à l'intérieur d'une transaction, pas une copie de
     fichier qui pourrait tomber au milieu d'une écriture.
   - `pg_restore --clean --single-transaction` vide et recharge tout le
     contenu dans UNE SEULE transaction : soit la restauration passe en
     entier, soit un ROLLBACK annule tout — même garantie d'atomicité qu'avant,
     obtenue nativement plutôt qu'en coupant les clés étrangères à la main.

   Ce qui reste identique en esprit : une sauvegarde non relue n'est pas une
   sauvegarde (vérifiée avec `pg_restore --list` avant d'être conservée), et
   le fichier produit contient les mêmes secrets qu'avant — `users.pw_hash`,
   les colonnes `*_enc` — donc la même réserve au super-utilisateur. */

export function dossierSauvegardes(){
  const d = path.resolve(config.backupDir);
  if(!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true });
  return d;
}

const NOM_ACCEPTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.dump$/;

export function cheminSauvegarde(nom){
  if(typeof nom !== "string" || !NOM_ACCEPTE.test(nom) || nom.includes(".."))
    return null;
  const dossier = dossierSauvegardes();
  const chemin = path.resolve(dossier, nom);
  if(path.dirname(chemin) !== path.resolve(dossier)) return null;
  return chemin;
}
const cheminManifeste = (cheminDump) => cheminDump.replace(/\.dump$/, ".json");

const horodatage = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const suffixe = () => Array.from({ length:4 },
  () => ALPHA[Math.floor(Math.random()*ALPHA.length)]).join("");

/* ── Verrou d'entretien ──────────────────────────────────────────────
   Toujours en mémoire, donc toujours mono-processus : cette étape de
   portage garde MEMS en une seule instance (voir docs/A_FAIRE.md, Étape 2
   du programme SaaS, pour le verrou Postgres `pg_advisory_lock` qu'exigera
   le passage à plusieurs instances). Sauvegarde, VACUUM et CHECKPOINT restent
   des opérations lourdes qui se gênent : ce verrou les sérialise. */
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

/* ── Connexion transmise à pg_dump/pg_restore ──────────────────────────
   Le mot de passe passe par la variable d'environnement PGPASSWORD, jamais
   en argument de ligne de commande : les arguments d'un processus sont
   visibles par n'importe qui sur la machine (`ps`), l'environnement d'un
   sous-processus ne l'est pas. */
function connexion(){
  const u = new URL(config.databaseUrl);
  return {
    args: ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username),
           "-d", decodeURIComponent(u.pathname.slice(1))],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(u.password || "") },
  };
}

/* Exécute un binaire du client Postgres (pg_dump/pg_restore), avec un délai
   borné — une sauvegarde ou une restauration qui ne termine jamais bloquerait
   le verrou d'entretien indéfiniment. */
function executer(bin, args, env){
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env });
    let sortie = "", erreur = "";
    const auDelai = setTimeout(() => { p.kill("SIGKILL"); }, config.backupTimeoutMs);
    p.stdout?.on("data", (d) => { sortie += d; });
    p.stderr?.on("data", (d) => { erreur += d; });
    p.on("error", (e) => { clearTimeout(auDelai); reject(e); });
    p.on("close", (code) => {
      clearTimeout(auDelai);
      if(code === 0) resolve({ sortie, erreur });
      else reject(new Error(`${bin} a échoué (code ${code}) : ${erreur.trim().slice(0, 2000) || "aucun détail"}`));
    });
  });
}

/* ── Relecture d'un fichier de sauvegarde ──────────────────────────── */
export async function verifier(chemin){
  const manifeste = cheminManifeste(chemin);
  if(!fs.existsSync(manifeste))
    return { lisible:false, motif:"manifeste absent — fichier déposé à la main, non produit par MEMS" };
  let m;
  try{ m = JSON.parse(fs.readFileSync(manifeste, "utf8")); }
  catch(e){ return { lisible:false, motif:`manifeste illisible : ${e.message}` }; }

  try{
    const { env } = connexion();
    const { sortie } = await executer("pg_restore", ["--list", chemin], env);
    /* `pg_restore --list` échoue (rejette la promesse) si l'archive est
       corrompue ou tronquée — l'atteindre suffit à prouver que le fichier
       s'ouvre. Le nombre d'entrées de table y est un contrôle de plausibilité
       en plus, pas une preuve à lui seul. */
    /* Format d'une entrée de TOC : « <id>; <n> <n> TABLE DATA <schéma> <table>
       <propriétaire> ». Le séparateur avant « TABLE DATA » est une ESPACE, pas
       « ; » — pg_dump -Fc émet une entrée par table, même vide, donc leur nombre
       égale bien celui du manifeste. */
    const entreesTable = (sortie.match(/ TABLE DATA /g) || []).length;
    const lisible = entreesTable >= m.tables?.length;
    return { lisible, tables:m.tables || [], migrations:m.migrations || [],
      entreesTable, motif: lisible ? null
        : `l'archive ne porte que ${entreesTable} table(s) sur ${m.tables?.length ?? 0} attendues` };
  }catch(e){
    return { lisible:false, motif:`relecture impossible : ${e.message}` };
  }
}

/* ── Produire une sauvegarde ───────────────────────────────────────── */
export async function sauvegarder({ motif = "manuelle" } = {}){
  const nom = `mems-${horodatage()}-${suffixe()}.dump`;
  const chemin = path.join(dossierSauvegardes(), nom);
  const t0 = Date.now();

  /* Capturé AVANT le dump, depuis la connexion applicative : c'est ce à quoi
     une restauration future comparera le schéma vivant, exactement comme le
     faisait la comparaison des migrations côté SQLite. */
  const tables = (await db.prepare(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`).all())
    .map(r => r.table_name);
  const migrations = (await db.prepare("SELECT name FROM _migrations ORDER BY name").all())
    .map(r => r.name);

  const { args, env } = connexion();
  /* `-w` : ne jamais demander de mot de passe de façon interactive. Sans lui, un
     échec d'authentification ferait attendre pg_dump sur « Password: » jusqu'au
     SIGKILL du délai — un blocage au lieu d'une erreur lisible. PGPASSWORD (env)
     porte le secret. */
  await executer("pg_dump", [...args, "-w", "-Fc", "--no-owner", "--file", chemin], env);
  fs.writeFileSync(cheminManifeste(chemin),
    JSON.stringify({ tables, migrations, creeLe:new Date().toISOString() }, null, 2));

  const ms = Date.now() - t0;
  const controle = await verifier(chemin);
  if(!controle.lisible){
    /* Un fichier douteux n'est pas conservé : il ferait croire à une
       sauvegarde là où il n'y en a pas. */
    try{ fs.unlinkSync(chemin); fs.unlinkSync(cheminManifeste(chemin)); }catch{ /* déjà absent */ }
    const err = new Error(`la sauvegarde produite est illisible (${controle.motif})`);
    err.status = 500;
    throw err;
  }
  const octets = fs.statSync(chemin).size;
  log.info("sauvegarde produite", { fichier:nom, octets, ms, motif });
  return { nom, chemin, octets, ms, motif, controle };
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
   `--single-transaction` donne l'atomicité que la version SQLite obtenait en
   coupant les clés étrangères et en les revérifiant à la main : ici,
   pg_restore ordonne lui-même DROP/CREATE/COPY selon les dépendances, et
   Postgres les valide en continu — rien à désactiver. Les lecteurs déjà
   connectés voient l'ancien contenu jusqu'au COMMIT final (isolation MVCC),
   puis basculent d'un coup sur le nouveau : pas d'état intermédiaire visible. */
export async function restaurer({ chemin, nom }){
  const refus = (message, status = 422) => {
    const e = new Error(message); e.status = status; return e;
  };

  const controle = await verifier(chemin);
  if(!controle.lisible)
    throw refus(`sauvegarde inexploitable : ${controle.motif}`);

  const migrationsVivantes = (await db.prepare("SELECT name FROM _migrations ORDER BY name")
    .all()).map(r => r.name);
  const tablesVivantes = (await db.prepare(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`).all())
    .map(r => r.table_name);

  /* Un jeu de migrations différent, c'est un schéma différent : restaurer
     quand même écrirait des lignes dans des colonnes qui n'existent plus, ou
     laisserait les nouvelles colonnes sans valeur. On refuse avant de
     commencer plutôt que de découvrir le problème pendant. */
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
  const { args, env } = connexion();
  await executer("pg_restore",
    [...args, "-w", "--clean", "--if-exists", "--no-owner", "--single-transaction", chemin], env);
  const ms = Date.now() - t0;

  const apresTables = (await db.prepare(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'`).all()).length;
  log.warn("base restaurée depuis une sauvegarde", { fichier:nom, ms, tables:apresTables });
  return { ms, tables:apresTables, apres:{ conforme:true } };
}

export async function tailleBase(){
  const { rows } = await pool.query(
    "SELECT pg_database_size(current_database()) AS octets");
  return { octets: Number(rows[0].octets) };
}
