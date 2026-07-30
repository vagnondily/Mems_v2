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
  /* Serveurs de tuiles autorisés par la politique de sécurité du contenu.

     C'est la SEULE ressource externe que l'application accepte de charger, et
     seulement si l'utilisateur l'a demandée dans les réglages. Le compromis est
     assumé et il se dit : un fond de carte OpenStreetMap rend la carte lisible pour
     qui ne connaît pas la zone par cœur, au prix d'une requête sortante par tuile —
     laquelle ne porte aucune donnée du programme, juste des coordonnées de tuile.

     Un bureau sans connexion sortante, ou qui ne veut aucune fuite, laisse le
     réglage sur « aucun » : les contours administratifs restent le fond, et la carte
     fonctionne hors ligne comme avant. Une installation qui héberge ses propres
     tuiles remplace la liste par son domaine (TILE_HOSTS).                       */
  tileHosts: (process.env.TILE_HOSTS
    || "https://tile.openstreetmap.org https://*.tile.openstreetmap.org")
    .split(/[\s,]+/).map(s => s.trim()).filter(Boolean),
  /* Le gabarit d'URL des tuiles. Il part au client avec l'état initial : c'est
     l'exploitant qui décide de la source, pas le code de l'interface. */
  tileUrl: process.env.TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: process.env.TILE_ATTRIBUTION || "© OpenStreetMap",
  trustProxy: bool(process.env.TRUST_PROXY, false),
  rateLoginMax: int(process.env.RATE_LOGIN_MAX, 10),
  rateApiMax: int(process.env.RATE_API_MAX, 600),
  maxBodyMb: int(process.env.MAX_BODY_MB, 25),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
  lockAfter: int(process.env.LOCK_AFTER_FAILED, 8),
  lockMinutes: int(process.env.LOCK_MINUTES, 15),
  bootstrapEmail: process.env.BOOTSTRAP_EMAIL || "admin@mems.local",
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD || "",
  logLevel: process.env.LOG_LEVEL || "info",
};
