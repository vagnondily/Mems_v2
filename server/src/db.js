import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
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

/* ── Le pool du MIROIR (mode test) ──────────────────────────────────────
   Le mode test est un environnement miroir : un instantané de la production
   cloné dans le schéma `test` de la MÊME base (mêmes tables, mêmes clés
   étrangères, mêmes données au moment du clic), où l'on peut écrire sans
   toucher à la production. Ce second pool ne diffère du premier que par son
   `search_path` fixé à `test` : chaque connexion résout donc les noms de
   table non qualifiés dans le schéma miroir, sans qu'aucune des ~600 requêtes
   de l'application n'ait à être réécrite. `pg_catalog` reste implicitement en
   tête du chemin, donc les fonctions natives (now(), etc.) restent trouvables.
   Tant que le miroir n'est pas activé, ce pool n'est jamais sollicité — ses
   connexions inactives ne coûtent rien. */
export const poolTest = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  options: "-c search_path=test",
});

/* Le schéma actif de la requête EN COURS, porté par le contexte asynchrone.
   Un middleware l'établit sur `test` quand la requête demande explicitement le
   miroir (en-tête X-MEMS-Env: test) ET que le miroir existe ; partout ailleurs
   le contexte est absent et l'on tombe sur la production. AsyncLocalStorage
   propage cette valeur à travers tous les `await` de la requête sans qu'aucun
   point d'appel n'ait à la transmettre. */
export const envStore = new AsyncLocalStorage();

/* Le pool à employer POUR CETTE REQUÊTE : le miroir si le contexte le dit, la
   production sinon. Résolu à chaque requête (et non à la préparation), car des
   modules préparent leurs `db.prepare(...)` au chargement, bien avant qu'une
   requête n'ait choisi son schéma. */
function poolActif(){
  return envStore.getStore()?.schema === "test" ? poolTest : pool;
}

for(const [nom, p] of [["production", pool], ["miroir", poolTest]])
  p.on("error", (err) => {
    /* Une erreur sur une connexion IDLE du pool (réseau coupé, base redémarrée) :
       elle ne doit pas faire planter le process, seulement se signaler. */
    log.error(`erreur inattendue sur une connexion inactive du pool pg (${nom})`,
      { message: err.message });
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

/* Reproduit `db.prepare(sql)`. L'exécuteur est fourni par une FONCTION appelée
   à chaque requête, non capturé une fois pour toutes : c'est ce qui permet au
   `db` global de router vers la production ou vers le miroir selon le contexte
   de la requête en cours, alors même que le `db.prepare(...)` a pu être écrit
   au chargement du module. Une transaction, elle, passe une fonction constante
   (son client dédié) — elle reste liée à sa connexion. */
function statement(getExecutor, sql){
  const text = translate(sql);
  const query = (args) => getExecutor().query(text, normalizeArgs(args));
  return {
    all: async (...args) => (await query(args)).rows,
    get: async (...args) => (await query(args)).rows[0],
    run: async (...args) => {
      const r = await query(args);
      return { changes: r.rowCount };
    },
  };
}

function makeDb(getExecutor){
  return {
    prepare: (sql) => statement(getExecutor, sql),
    exec: (sql) => getExecutor().query(sql),
  };
}

/* Le `db` global route par requête : production par défaut, miroir quand le
   contexte asynchrone le demande. */
export const db = makeDb(poolActif);

/* Remplace `db.transaction(fn)` (synchrone, better-sqlite3) : extrait un
   client DÉDIÉ du pool pour que BEGIN…COMMIT porte sur une seule connexion.
   `fn` reçoit un objet `db`-compatible lié à ce client, pas le pool global —
   c'est ce qui rend la transaction atomique. */
export async function tx(fn){
  /* La transaction s'ouvre sur le pool ACTIF de la requête : dans le miroir,
     elle porte donc sur le schéma test, isolée de la production. */
  const client = await poolActif().connect();
  try{
    await client.query("BEGIN");
    const result = await fn(makeDb(() => client));
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
    /* `foreignKeyViolations` est toujours 0 par construction : Postgres refuse
       toute ligne qui violerait une clé étrangère, il n'existe donc aucun état
       incohérent à recompter après coup. Le champ est conservé — l'écran de
       santé et le contrat /health le lisent — mais sa valeur est une garantie
       du moteur, pas le résultat d'un balayage comme le PRAGMA de SQLite. */
    return { status:"ok", octets:Number(rows[0].octets), connexions:Number(rows[0].connexions),
      foreignKeyViolations:0 };
  }catch(e){
    return { status:"erreur", message:e.message };
  }
}

export async function close(){ await Promise.all([pool.end(), poolTest.end()]); }
