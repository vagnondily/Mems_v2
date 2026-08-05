import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./lib/logger.js";

/* `pg` renvoie les colonnes bigint (dont COUNT(*)) sous forme de CHAÎNE, pour
   ne pas perdre de précision au-delà de Number.MAX_SAFE_INTEGER. Aucun
   compte de MEMS ne l'approche, et tout le code existant attend un nombre
   (`SELECT COUNT(*) c ...`, comparé, additionné, sérialisé en JSON) — un seul
   réglage global évite de traquer chaque site un par un. OID 20 = int8. */
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

/* ═══════════════════════════════════════════════════════════════════════
   PostgreSQL, derrière une forme d'appel qui reste celle de better-sqlite3.

   Le portage touche ~600 points d'appel dans 46 fichiers, tous écrits comme
   `db.prepare(sql).all(...)/.get(...)/.run(...)`, avec des paramètres
   positionnels `?`. Réécrire chaque requête aurait démultiplié le risque
   pour un gain nul : cette couche traduit UNE FOIS la syntaxe des
   paramètres et la forme de résultat, pour que les points d'appel n'aient
   à changer que de deux choses, mécaniques et repérables partout : devenir
   `async` et recevoir un `await`.

   Ce qui NE porte PAS à l'identique, volontairement :
   - `.run()` n'a plus de `lastInsertRowid` : tous les identifiants de MEMS
     sont générés côté application (`lib/crypto.js:newId`), jamais par la
     base — aucun point d'appel n'en dépendait déjà.
   - `.changes` est recalculé depuis `rowCount` (pg) au lieu de venir de
     better-sqlite3 : la sémantique — nombre de lignes affectées — est la
     même, c'est ce dont dépend le verrouillage optimiste par `rev`.
   ═══════════════════════════════════════════════════════════════════════ */

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
});

pool.on("error", (err) => {
  /* Une erreur sur une connexion IDLE du pool (réseau coupé, base redémarrée) :
     elle ne doit pas faire planter le process, seulement se signaler. */
  log.error("erreur inattendue sur une connexion inactive du pool pg", { message: err.message });
});

/* `?` → `$1, $2, …` — un seul endroit traduit la syntaxe, mis en cache par
   texte de requête pour ne pas répéter le travail à chaque appel.

   Deux différences de dialecte sont absorbées ici, pour la même raison qu'on
   traduit les placeholders au lieu de réécrire 600 requêtes : SQLite accepte
   `col IS ?` comme une égalité NULL-safe (NULL comparé à NULL vaut vrai), que
   Postgres écrit `IS NOT DISTINCT FROM`, et `col IS NOT ?` que Postgres écrit
   `IS DISTINCT FROM`. La substitution garde le `?` en place, donc la
   numérotation qui suit reste juste. `IS NULL` / `IS NOT NULL` (sans `?`) ne
   sont pas touchés. */
const positional = new Map();
function translate(sql){
  let t = positional.get(sql);
  if(t === undefined){
    let i = 0;
    t = sql
      .replace(/\bIS\s+NOT\s+\?/gi, "IS DISTINCT FROM ?")
      .replace(/\bIS\s+\?/gi, "IS NOT DISTINCT FROM ?")
      .replace(/\?/g, () => `$${++i}`);
    positional.set(sql, t);
  }
  return t;
}

function normalizeArgs(args){
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

/* Reproduit `db.prepare(sql)` : un exécuteur (le pool, ou un client de
   transaction) suffit à fabriquer les trois méthodes attendues partout. */
function statement(executor, sql){
  const text = translate(sql);
  const query = (args) => executor.query(text, normalizeArgs(args));
  return {
    all: async (...args) => (await query(args)).rows,
    get: async (...args) => (await query(args)).rows[0],
    run: async (...args) => {
      const r = await query(args);
      return { changes: r.rowCount };
    },
  };
}

function makeDb(executor){
  return {
    prepare: (sql) => statement(executor, sql),
    exec: (sql) => executor.query(sql),
  };
}

export const db = makeDb(pool);

/* Remplace `db.transaction(fn)` (synchrone, better-sqlite3) : extrait un
   client DÉDIÉ du pool pour que BEGIN…COMMIT porte sur une seule connexion.
   `fn` reçoit un objet `db`-compatible lié à ce client, pas le pool global —
   c'est ce qui rend la transaction atomique. */
export async function tx(fn){
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    const result = await fn(makeDb(client));
    await client.query("COMMIT");
    return result;
  }catch(e){
    try{ await client.query("ROLLBACK"); }
    catch(annulation){ log.error("annulation de transaction en échec", { message: annulation.message }); }
    throw e;
  }finally{
    client.release();
  }
}

/* Migrations : chaque fichier n'est appliqué qu'une fois, dans sa propre
   transaction — comme avant, sur une connexion dédiée par fichier plutôt que
   par migration complète, pour qu'un fichier fautif n'entraîne jamais les
   suivants. */
export async function migrate(dirPath){
  await pool.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query("SELECT name FROM _migrations");
  const done = new Set(rows.map(r => r.name));
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".sql")).sort();
  let applied = 0;
  for(const f of files){
    if(done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dirPath, f), "utf8");
    const client = await pool.connect();
    try{
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
    }catch(e){
      try{ await client.query("ROLLBACK"); }catch{ /* la cause d'origine prime */ }
      throw new Error(`migration ${f} en échec : ${e.message}`, { cause:e });
    }finally{
      client.release();
    }
    log.info("migration appliquée", { fichier:f });
    applied++;
  }
  return { applied, total: files.length };
}

/* Contrôle de santé, utile au démarrage et dans /api/health. `PRAGMA
   integrity_check`/`foreign_key_check` n'ont pas d'équivalent Postgres : les
   clés étrangères y sont TOUJOURS appliquées (aucune ligne ne peut exister en
   violation), donc rien à vérifier après coup. Ce que cette fonction rend à
   la place : la base répond, et sa taille — le signal opérationnel utile. */
export async function integrity(){
  try{
    const { rows } = await pool.query(
      `SELECT pg_database_size(current_database()) AS octets,
              (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS connexions`);
    return { status:"ok", octets:Number(rows[0].octets), connexions:Number(rows[0].connexions) };
  }catch(e){
    return { status:"erreur", message:e.message };
  }
}

export async function close(){ await pool.end(); }
