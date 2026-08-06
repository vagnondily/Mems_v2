import { pool } from "../db.js";
import { log } from "./logger.js";

/* ═══════════════════════════════════════════════════════════════════════
   Le MIROIR — le mode test comme environnement de bac à sable.

   Ce que l'utilisateur a demandé : un mode test qui soit un miroir de la
   production. En l'activant, on fige les données réelles à l'instant t dans un
   espace isolé où l'on peut écrire, importer, supprimer, sans jamais toucher à
   la production — et où l'on retrouve aussi les données de prod telles qu'elles
   étaient au moment du clic.

   Comment : un CLONE dans le schéma PostgreSQL `test` de la même base. Le clone
   reprend, table par table, la structure exacte (colonnes, défauts, contraintes
   CHECK, index, clés primaires — via LIKE INCLUDING ALL), puis les données, puis
   les clés étrangères recréées de sorte qu'elles pointent vers le schéma test et
   non la production. Le résultat est un jumeau strictement isolé : y supprimer
   toutes les écoles laisse la production intacte.

   Le routage d'une requête vers ce schéma se fait dans db.js (poolTest +
   AsyncLocalStorage) ; ce module ne s'occupe que de FABRIQUER et de DÉFAIRE le
   miroir, et de dire s'il existe. Il travaille TOUJOURS sur la production
   (`pool` direct, jamais le `db` routé) : l'état du miroir — existe-t-il, de
   quand date l'instantané — est une donnée de production, pas du bac à sable.

   Hors périmètre ici (Étape 2) : le cloisonnement multi-tenant par RLS. Le
   miroir est mono-tenant comme le reste ; c'est un instantané complet, pas une
   partition par organisation. ═══════════════════════════════════════════════ */

const CLE = "miroir";

/* Drapeau en mémoire, lu à chaque requête par le middleware de routage : une
   requête SQL par requête HTTP juste pour savoir si le miroir existe serait un
   coût inutile. Il est synchronisé au démarrage puis à chaque activation ou
   désactivation. */
let actif = false;
export const miroirActif = () => actif;

/* Le schéma test existe-t-il vraiment ? (Source de vérité au démarrage.) */
async function schemaTestExiste(){
  const { rows } = await pool.query(
    "SELECT 1 FROM information_schema.schemata WHERE schema_name='test'");
  return rows.length > 0;
}

/* Appelé au démarrage : aligne le drapeau mémoire sur l'état réel de la base. */
export async function initMiroir(){
  actif = await schemaTestExiste();
  if(actif) log.info("miroir présent au démarrage (mode test disponible)");
  return actif;
}

/* L'instantané enregistré (quand, par qui), lu dans `settings` de la prod. */
async function metadonnees(){
  const { rows } = await pool.query("SELECT value FROM settings WHERE key=$1", [CLE]);
  if(!rows.length) return null;
  try{ return JSON.parse(rows[0].value); }catch{ return null; }
}

/* ── L'état, pour l'écran et le middleware ────────────────────────────── */
export async function etatMiroir(){
  const existe = await schemaTestExiste();
  actif = existe;
  if(!existe) return { actif:false, instantane:null, par:null, tables:0, lignes:null };
  const meta = await metadonnees();
  /* Un décompte parlant sans tout recompter : deux tables représentatives. */
  const { rows:[c] } = await pool.query(
    `SELECT (SELECT count(*) FROM test.sites)  AS sites,
            (SELECT count(*) FROM test.submissions) AS soumissions`);
  const { rows:[t] } = await pool.query(
    "SELECT count(*) n FROM information_schema.tables WHERE table_schema='test' AND table_type='BASE TABLE'");
  return { actif:true, instantane: meta?.instantane || null, par: meta?.par || null,
    tables: Number(t.n), lignes: { sites: Number(c.sites), soumissions: Number(c.soumissions) } };
}

/* ── Activer / rafraîchir : (re)cloner la production dans `test` ─────────
   Idempotent par construction : on repart d'un schéma test vide à chaque fois.
   Toute la fabrication tient dans UNE transaction — un clone à moitié fait ne
   doit jamais rester. */
export async function activerMiroir({ par = null } = {}){
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("DROP SCHEMA IF EXISTS test CASCADE");
    await client.query("CREATE SCHEMA test");

    /* Structure + données, table par table. Les noms sont pleinement qualifiés :
       aucune dépendance au search_path à cette étape. Le nom de table vient du
       catalogue, jamais de l'utilisateur — pas d'injection possible. */
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
    for(const { table_name: t } of tables){
      await client.query(`CREATE TABLE test."${t}" (LIKE public."${t}" INCLUDING ALL)`);
      await client.query(`INSERT INTO test."${t}" SELECT * FROM public."${t}"`);
    }

    /* Clés étrangères recréées SUR le schéma test. On lit leur définition, on
       en retire la qualification `public.` (les tables référencées sont dans le
       même schéma), et on les pose avec `test` en tête du search_path : les
       références non qualifiées résolvent alors vers le miroir, pas la prod —
       sans cela le jumeau resterait accroché à la production par ses FK. */
    await client.query("SET LOCAL search_path = test, public");
    const { rows: fks } = await client.query(
      `SELECT conrelid::regclass::text AS tbl, conname,
              regexp_replace(pg_get_constraintdef(oid), 'public\\.', '', 'g') AS def
       FROM pg_constraint
       WHERE contype='f' AND connamespace='public'::regnamespace`);
    for(const fk of fks){
      const tbl = fk.tbl.includes(".") ? fk.tbl.split(".").pop() : fk.tbl;
      await client.query(`ALTER TABLE test."${tbl}" ADD CONSTRAINT "${fk.conname}" ${fk.def}`);
    }

    /* L'instantané est daté et signé dans la PRODUCTION (settings public) : le
       clone contient une copie de cette même ligne, mais c'est celle de la prod
       qui fait foi pour l'écran. */
    const instantane = new Date().toISOString();
    await client.query(
      `INSERT INTO public.settings (key,value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=excluded.value`,
      [CLE, JSON.stringify({ instantane, par })]);

    await client.query("COMMIT");
    actif = true;
    log.info("miroir activé (mode test)", { tables: tables.length, par });
    return await etatMiroir();
  }catch(e){
    try{ await client.query("ROLLBACK"); }
    catch(annulation){ log.error("annulation du clonage miroir en échec", { message: annulation.message }); }
    throw e;
  }finally{
    client.release();
  }
}

/* ── Désactiver : jeter le bac à sable ──────────────────────────────────
   La production n'est jamais touchée : on ne supprime que le schéma test et la
   trace de l'instantané. */
export async function desactiverMiroir(){
  await pool.query("DROP SCHEMA IF EXISTS test CASCADE");
  await pool.query("DELETE FROM settings WHERE key=$1", [CLE]);
  actif = false;
  log.info("miroir désactivé (mode test fermé)");
  return { actif:false, instantane:null, par:null, tables:0, lignes:null };
}
