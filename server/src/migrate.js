import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, integrity } from "./db.js";
import { log } from "./lib/logger.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const r = migrate(path.join(here, "..", "migrations"));
log.info("migrations terminées", { ...r, ...integrity() });
