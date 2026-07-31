import "dotenv/config";
import crypto from "node:crypto";

const bool = (v, d=false) => v===undefined ? d : /^(1|true|yes|on)$/i.test(String(v));
const int  = (v, d) => Number.isFinite(parseInt(v,10)) ? parseInt(v,10) : d;

const isProd = process.env.NODE_ENV === "production";

/* Un secret faible en production est une faute : on refuse de démarrer. */
function requireSecret(name, fallback){
  const v = process.env[name];
  if(v && v.length >= 32) return v;
  if(isProd) throw new Error(
    `${name} est absent ou trop court. Générez-en un avec : openssl rand -hex 32`);
  return fallback || crypto.randomBytes(32).toString("hex");
}

export const config = {
  isProd,
  port: int(process.env.PORT, 4000),
  host: process.env.HOST || "0.0.0.0",
  dbFile: process.env.DB_FILE || "./data/mems.db",
  jwtSecret: requireSecret("JWT_SECRET"),
  /* Clé de chiffrement au repos des jetons de sources externes */
  dataKey: crypto.createHash("sha256").update(requireSecret("DATA_KEY")).digest(),
  tokenTtl: process.env.TOKEN_TTL || "8h",
  cookieName: "mems_token",
  corsOrigins: (() => {
    const defaultDev = [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://10.0.10.147:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ];
    const envOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173")
      .split(",").map(s => s.trim()).filter(Boolean);
    return isProd ? envOrigins : [...new Set([...envOrigins, ...defaultDev])];
  })(),
  /* Hôtes autorisés à servir les tuiles du fond de carte. Par défaut
     OpenStreetMap, qui ne demande ni clé ni compte de facturation. Pointer
     TILE_HOSTS vers un serveur de tuiles interne est la bonne réponse dès que
     l'usage dépasse la politique d'usage d'OSM ; le vider ferme la carte à
     toute image tierce, au prix du fond (contours et points restent). */
  tileHosts: (process.env.TILE_HOSTS
    || "https://*.tile.openstreetmap.org https://tile.openstreetmap.org")
    .split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  rateLoginMax: int(process.env.RATE_LOGIN_MAX, 10),
  rateApiMax: int(process.env.RATE_API_MAX, 600),
  maxBodyMb: int(process.env.MAX_BODY_MB, 25),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
  lockAfter: int(process.env.LOCK_AFTER_FAILED, 8),
  lockMinutes: int(process.env.LOCK_MINUTES, 15),
  /* Hôtes ODK Central explicitement autorisés, séparés par des virgules.
     Vide — le cas par défaut — signifie « tout serveur https dont l'adresse est
     publique » ; voir lib/odkClient.js pour la règle complète et son pourquoi. */
  odkAllowedHosts: (process.env.ODK_ALLOWED_HOSTS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  bootstrapEmail: process.env.BOOTSTRAP_EMAIL || "admin@mems.local",
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD || "",
  logLevel: process.env.LOG_LEVEL || "info",
};
