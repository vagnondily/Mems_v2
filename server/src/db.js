import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { log } from "./lib/logger.js";

const dir = path.dirname(config.dbFile);
if(dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive:true });

export const db = new Database(config.dbFile);
db.pragma("journal_mode = WAL");     /* lectures concurrentes pendant l'écriture */
db.pragma("foreign_keys = ON");      /* l'intégrité référentielle est contrôlée */
db.pragma("busy_timeout = 5000");

export const tx = (fn) => db.transaction(fn);

/* Migrations : chaque fichier n'est appliqué qu'une fois, dans une transaction. */
export function migrate(dirPath){
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  const done = new Set(db.prepare("SELECT name FROM _migrations").all().map(r=>r.name));
  const files = fs.readdirSync(dirPath).filter(f=>f.endsWith(".sql")).sort();
  let applied = 0;
  for(const f of files){
    if(done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dirPath, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run(f);
    })();
    log.info("migration appliquée", { fichier:f });
    applied++;
  }
  return { applied, total: files.length };
}

/* Contrôle d'intégrité : utile au démarrage et dans /api/health. */
export function integrity(){
  const fk = db.pragma("foreign_key_check");
  const ic = db.pragma("integrity_check", { simple:true });
  return { foreignKeyViolations: fk.length, integrity: ic };
}
