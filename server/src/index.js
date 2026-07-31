import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { db, migrate, integrity } from "./db.js";
import { log } from "./lib/logger.js";
import { backfillFromLegacy } from "./lib/geo.js";
import { authenticate } from "./lib/auth.js";
import { runWithCtx } from "./lib/ctx.js";
import { countryFor } from "./lib/country.js";
import authRoutes from "./routes/auth.js";
import stateRoutes from "./routes/state.js";
import siteRoutes from "./routes/sites.js";
import collectionRoutes from "./routes/collections.js";
import geoRoutes from "./routes/geo.js";
import countryRoutes from "./routes/country.js";
import tpmRoutes from "./routes/tpm.js";
import mreRoutes from "./routes/mre.js";
import pddRoutes from "./routes/pdd.js";
import backupRoutes from "./routes/backup.js";
import updateRoutes from "./routes/update.js";
import officeRoutes from "./routes/offices.js";
import partnerRoutes from "./routes/partners.js";
import userRoutes from "./routes/users.js";
import analyticsRoutes from "./routes/analytics.js";
import caseloadRoutes from "./routes/caseload.js";
import importRoutes from "./routes/import.js";

const here = path.dirname(fileURLToPath(import.meta.url));
migrate(path.join(here, "..", "migrations"));
/* Une base créée avant la migration 002 a son découpage dans l'ancienne table plate :
   on le reprend une seule fois vers l'arbre, sinon le référentiel apparaîtrait vide. */
const _geoBackfill = backfillFromLegacy();
if(_geoBackfill) log.info("référentiel repris depuis l'ancienne table", _geoBackfill);

export const app = express();
app.disable("x-powered-by");
if(config.trustProxy) app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      /* Plus aucune fonte distante : le client utilise la fonte système. Les deux
         autorisations vers Google ont donc été retirées — une exception de
         politique de sécurité que rien ne justifie plus est une exception à
         supprimer, pas à conserver au cas où. */
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      /* Les tuiles du fond de carte sont la seule origine externe tolérée, et
         seulement si l'exploitant l'a voulu (TILE_HOSTS, vide pour interdire). */
      imgSrc: ["'self'", "data:", "blob:", ...config.tileHosts],
      connectSrc: ["'self'", ...config.corsOrigins],
      frameSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "same-origin" },
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: `${config.maxBodyMb}mb` }));
const isGithubDevOrigin = origin => /^https:\/\/[a-z0-9-]+\.app\.github\.dev$/i.test(origin);
app.use(cors({
  origin(origin, cb){
    /* Requêtes sans origine : outils en ligne de commande, sondes de santé. */
    if(!origin) return cb(null, true);
    if(!config.isProd) return cb(null, true);
    if(config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("origine non autorisée"));
  },
  credentials: true,
}));

/* Journalisation courte, sans corps de requête : aucun secret ne transite par les logs. */
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    if(req.path === "/api/health") return;
    log.debug("requête", { m:req.method, p:req.path, s:res.statusCode, ms:Date.now()-t0 });
  });
  next();
});

const apiLimiter = rateLimit({ windowMs: 60_000, limit: config.rateApiMax,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error:"trop de requêtes, patientez une minute" } });
app.use("/api", apiLimiter);

app.get("/api/health", (req, res) => {
  const i = integrity();
  res.json({ status: i.foreignKeyViolations===0 && i.integrity==="ok" ? "ok" : "dégradé",
    version:"1.0.0", uptime: Math.round(process.uptime()), database: i });
});

app.use("/api/auth", authRoutes);

/* ── Contexte de pays ────────────────────────────────────────────────
   Une instance sert plusieurs pays. Chaque requête authentifiée porte donc son
   pays, et tout ce qui en dépend — le référentiel géographique, le vocabulaire
   des niveaux, la devise locale — le lit dans ce contexte plutôt que dans une
   variable globale qui serait partagée entre requêtes concurrentes.

   Le pays vient du compte quand il en déclare un. Un compte non borné — bureau
   régional, administrateur de l'instance — peut se placer dans un pays le temps
   d'une requête, par l'en-tête `X-MEMS-Country`. Un compte borné ne peut pas en
   sortir : sa demande est ignorée.

   Deux notions distinctes sortent d'ici, et les confondre serait une erreur :

     `country`       le pays qui NOMME — vocabulaire des niveaux, découpage
                     géographique, devise locale. Toujours renseigné, sinon les
                     écrans afficheraient « adm3 ».
     `countryFilter` le pays qui FILTRE les données. Vide pour un compte non borné
                     qui n'a rien demandé : c'est la vue d'ensemble d'un bureau
                     régional, et c'est aussi ce qui permet au premier
                     administrateur de configurer le deuxième pays. */
app.use("/api", authenticate, (req, res, next) => {
  const demande = req.get("x-mems-country") || req.query.country;
  const pays = countryFor(req.user, demande);
  runWithCtx({
    user: req.user,
    country: pays,
    countryFilter: req.user?.country_code || (demande ? pays.code : null),
  }, () => next());
});

app.use("/api", stateRoutes);
app.use("/api/sites", siteRoutes);
app.use("/api/geo", geoRoutes);
app.use("/api/users", userRoutes);
app.use("/api/offices", officeRoutes);
app.use("/api/partners", partnerRoutes);
app.use("/api/country", countryRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/caseload", caseloadRoutes);
app.use("/api/import", importRoutes);
app.use("/api/mre", mreRoutes);
app.use("/api/pdd", pddRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/update", updateRoutes);
app.use("/api/tpm", tpmRoutes);
app.use("/api", collectionRoutes);

/* En production le serveur sert aussi le frontend compilé. */
const webDist = path.join(here, "..", "..", "web", "dist");
if(fs.existsSync(webDist)){
  app.use(express.static(webDist, { maxAge:"1h", index:false }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(webDist, "index.html")));
}

app.use((req, res) => res.status(404).json({ error:"ressource introuvable" }));

/* Rien du détail interne ne remonte au client. */
app.use((err, req, res, next) => {
  const status = err.status || (/origine non autorisée/.test(err.message) ? 403 : 500);
  if(status >= 500) log.error("erreur non gérée", { message:err.message, stack:err.stack?.split("\n")[1] });
  res.status(status).json({ error: status >= 500 ? "erreur interne" : err.message });
});

if(process.env.NODE_ENV !== "test"){
  app.listen(config.port, config.host, () => {
    log.info("MEMS démarré", { port:config.port, base:config.dbFile, production:config.isProd });
    const n = db.prepare("SELECT COUNT(*) c FROM users").get().c;
    if(!n) log.warn("aucun compte : lancez « npm run seed » pour créer l'administrateur initial");
  });
}
export default app;
