import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, integrity } from "./db.js";
import { log } from "./lib/logger.js";
import { backfillFromLegacy } from "./lib/geo.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const r = migrate(path.join(here, "..", "migrations"));
/* Une base créée avant la migration 002 a son découpage dans l'ancienne table plate :
   on le reprend une seule fois vers l'arbre, sinon le référentiel apparaîtrait vide. */
const _geoBackfill = backfillFromLegacy();
if(_geoBackfill) log.info("référentiel repris depuis l'ancienne table", _geoBackfill);
log.info("migrations terminées", { ...r, ...integrity() });
