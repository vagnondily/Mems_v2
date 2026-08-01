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
import authRoutes from "./routes/auth.js";
import stateRoutes from "./routes/state.js";
import siteRoutes from "./routes/sites.js";
import collectionRoutes from "./routes/collections.js";
import geoRoutes from "./routes/geo.js";
import countryRoutes from "./routes/country.js";
import tpmRoutes from "./routes/tpm.js";
import mreRoutes from "./routes/mre.js";
import officeRoutes from "./routes/offices.js";
import userRoutes from "./routes/users.js";
import analyticsRoutes from "./routes/analytics.js";
import caseloadRoutes from "./routes/caseload.js";
import importRoutes from "./routes/import.js";
import xlsformRoutes from "./routes/xlsform.js";
import odkRoutes from "./routes/odk.js";
import submissionRoutes from "./routes/submissions.js";
import aliasRoutes from "./routes/aliases.js";
import connectorRoutes from "./routes/connectors.js";

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
      /* Les tuiles du fond de carte sont des images tierces : elles sont la
         SEULE exception, et elle est déclarée par une liste d'hôtes explicite
         (config.tileHosts, réglable par TILE_HOSTS) plutôt que par un joker.
         Une instance sans fond de carte se configure en vidant cette variable :
         la carte continue alors d'afficher contours et points. */
      imgSrc: ["'self'", "data:", "blob:", ...config.tileHosts],
      connectSrc: ["'self'", ...config.corsOrigins],
      /* Déclarée explicitement : sans elle, worker-src retombe sur default-src
         et un worker créé depuis un blob: est refusé sans message lisible. */
      workerSrc: ["'self'", "blob:"],
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
/* Un Codespace expose chaque port sous son propre sous-domaine généré
   (https://<nom>-4000.app.github.dev, https://<nom>-5173.app.github.dev) :
   deux origines différentes, imprévisibles à l'avance, donc absentes de
   CORS_ORIGINS. Cette fonction existait déjà mais n'était jamais appelée —
   la vérification ne la consultait jamais, et un test en mode « production »
   depuis un Codespace échouait avec « origine non autorisée » sans que rien
   dans le code ne l'explique. */
const isGithubDevOrigin = origin => /^https:\/\/[a-z0-9-]+\.app\.github\.dev$/i.test(origin);
app.use(cors({
  origin(origin, cb){
    /* Requêtes sans origine : outils en ligne de commande, sondes de santé. */
    if(!origin) return cb(null, true);
    if(!config.isProd) return cb(null, true);
    if(config.corsOrigins.includes(origin) || isGithubDevOrigin(origin)) return cb(null, true);
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
app.use("/api", authenticate, stateRoutes);
app.use("/api/sites", authenticate, siteRoutes);
app.use("/api/geo", authenticate, geoRoutes);
app.use("/api/users", authenticate, userRoutes);
app.use("/api/offices", authenticate, officeRoutes);
app.use("/api/country", authenticate, countryRoutes);
app.use("/api/analytics", authenticate, analyticsRoutes);
app.use("/api/caseload", authenticate, caseloadRoutes);
app.use("/api/import", authenticate, importRoutes);
app.use("/api", authenticate, odkRoutes);
/* Suite immédiate du tirage ODK : `odk-forms/:id/pull` remplit le cache,
   `submissions/ingest` en tire des lignes rattachées à des sites. */
app.use("/api", authenticate, submissionRoutes);
/* Les codes externes des sites : monté sous /api et APRÈS le routeur des sites,
   parce qu'il sert « /sites/:id/aliases » — deux segments, que `/:id` du routeur
   des sites ne capte pas, et qui lui reviennent donc naturellement. */
app.use("/api", authenticate, aliasRoutes);
app.use("/api", authenticate, xlsformRoutes);
/* Connecteurs et correspondance des variables : monté sous /api comme les deux
   précédents, dont il prolonge le travail — le XLSForm dit ce que la source
   contient, le connecteur dit ce que MEMS en retient. */
app.use("/api", authenticate, connectorRoutes);
app.use("/api/mre", authenticate, mreRoutes);
app.use("/api/tpm", authenticate, tpmRoutes);
app.use("/api", authenticate, collectionRoutes);

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
