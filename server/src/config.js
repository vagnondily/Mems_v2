import "dotenv/config";
import crypto from "node:crypto";
import os from "node:os";

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
  tileHosts: (process.env.TILE_HOSTS || [
    "https://*.tile.openstreetmap.org", "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.fr",
    "https://*.basemaps.cartocdn.com",
    "https://server.arcgisonline.com",
  ].join(" ")).split(/[,\s]+/).map(s => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  rateLoginMax: int(process.env.RATE_LOGIN_MAX, 10),
  rateApiMax: int(process.env.RATE_API_MAX, 600),
  maxBodyMb: int(process.env.MAX_BODY_MB, 25),
  /* Un shapefile de communes pèse des dizaines de mégaoctets — le .shp de
     Madagascar en fait 23,5. Il ne passe donc pas sous `maxBodyMb`, qui protège
     le corps JSON. Cette borne-ci ne s'applique QUE au téléversement du
     découpage (multer, route /geo/shapefile), jamais au corps JSON global : un
     corps JSON de 64 Mo resterait un vecteur d'abus. Un .zip compresse bien et
     passe largement en dessous ; la marge couvre le dépôt des fichiers séparés. */
  maxShapefileMb: int(process.env.MAX_SHAPEFILE_MB, 64),
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),
  lockAfter: int(process.env.LOCK_AFTER_FAILED, 8),
  lockMinutes: int(process.env.LOCK_MINUTES, 15),
  /* Hôtes ODK Central explicitement autorisés, séparés par des virgules.
     Vide — le cas par défaut — signifie « tout serveur https dont l'adresse est
     publique » ; voir lib/odkClient.js pour la règle complète et son pourquoi. */
  odkAllowedHosts: (process.env.ODK_ALLOWED_HOSTS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  /* Hôtes que les connecteurs sortants (Foundry, HTTP générique) ont le droit de
     joindre. Même logique et même raison que ODK_ALLOWED_HOSTS, pour une famille
     de sources différente : l'adresse d'un connecteur est saisie par un
     administrateur, donc venue de l'extérieur, donc jamais suivie telle quelle.
     Vide — le cas par défaut — signifie « tout serveur https dont l'adresse est
     publique » ; voir lib/foundry.js. Une instance Foundry d'entreprise porte un
     nom public, elle n'a normalement pas besoin d'y figurer. */
  connectorAllowedHosts: (process.env.CONNECTOR_ALLOWED_HOSTS || "")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
  /* ── Justificatifs dérivés des sources extérieures ───────────────────────
     Quand une source ne délivre pas de justificatif durable mais une SESSION
     (ODK Central), MEMS l'ouvre lui-même et la renouvelle. Ces quatre valeurs
     règlent ce renouvellement, et aucune ne code de durée absolue : la durée de
     vie d'une session ODK est un réglage de l'INSTANCE ODK (`sessionLifetime`,
     86 400 s par défaut chez eux), pas une propriété du monde. MEMS lit donc
     l'échéance annoncée par la source, et ne se rabat sur `dureeParDefautMs`
     que si elle n'en annonce aucune — volontairement courte, pour découvrir une
     expiration par un renouvellement plutôt que par un échec de tirage. */
  authSortante: {
    /* De combien on renouvelle AVANT l'échéance annoncée. Cette marge est un
       plafond, pas une règle absolue : une source qui annonce une durée de vie
       plus courte qu'elle rendrait tout jeton périmé à sa naissance, et MEMS
       rouvrirait une session à chaque appel sortant — voir `etatCache`. */
    get margeMs(){ return int(process.env.AUTH_SESSION_MARGIN_S, 120) * 1000; },
    /* Le temps minimal entre deux ouvertures de session pour une même source.
       C'est le garde-fou de dernier recours contre le martèlement : quelle que
       soit l'échéance annoncée — courte, passée, absurde — une session ouverte il
       y a moins que cela est réemployée. Un 401 reste le filet, et lui ne passe
       pas par le cache. */
    get plancherOuvertureMs(){ return int(process.env.AUTH_SESSION_MIN_INTERVAL_S, 30) * 1000; },
    get dureeParDefautMs(){ return int(process.env.AUTH_SESSION_DEFAULT_TTL_S, 3600) * 1000; },
    /* Combien de temps un échec d'ouverture bloque les tentatives suivantes.
       Un échec se signale, il ne se rejoue pas : sans ce délai, chaque tirage
       martèlerait une source qui vient de dire non. Enregistrer un justificatif
       corrigé lève le blocage sans attendre — voir lib/authSortante.js. */
    get delaiApresEchecMs(){ return int(process.env.AUTH_SESSION_RETRY_DELAY_S, 300) * 1000; },
    get delaiMs(){ return int(process.env.AUTH_SESSION_TIMEOUT_S, 20) * 1000; },
  },
  bootstrapEmail: process.env.BOOTSTRAP_EMAIL || "admin@mems.local",
  bootstrapPassword: process.env.BOOTSTRAP_PASSWORD || "",
  logLevel: process.env.LOG_LEVEL || "info",

  /* ── Exécution de scripts d'analyse (R, SPSS) ────────────────────────────
     Lancer un script, c'est exécuter du code arbitraire sur le serveur avec
     les droits du processus MEMS. La fonction est donc absente tant qu'aucun
     interpréteur n'est nommément déclaré : une instance qui ne s'en sert pas
     ne peut pas exécuter de code par accident, même si un compte est compromis.

     Ces valeurs sont des accesseurs et non des constantes figées au démarrage :
     la présence de l'interpréteur est vérifiée au moment où l'on s'en sert, pas
     une fois pour toutes — un binaire retiré du serveur doit refermer la porte
     sans attendre un redémarrage. */
  analyse: {
    /* Le chemin absolu de l'interpréteur, tel que déclaré par l'exploitant.
       Le nom de la variable vient de la table de lib/moteur.js : ajouter un
       interpréteur ne touche donc pas à ce fichier. */
    chemin: (variable) => (process.env[variable] || "").trim(),
    get delaiMs(){ return int(process.env.ANALYSIS_TIMEOUT_S, 60) * 1000; },
    /* Délai laissé au groupe de processus entre le SIGTERM et le SIGKILL. */
    get sursisMs(){ return int(process.env.ANALYSIS_KILL_GRACE_S, 3) * 1000; },
    get sortieMaxOctets(){ return int(process.env.ANALYSIS_MAX_OUTPUT_KB, 256) * 1024; },
    get lignesMax(){ return int(process.env.ANALYSIS_MAX_ROWS, 200_000); },
    get donneesMaxOctets(){ return int(process.env.ANALYSIS_MAX_DATASET_MB, 32) * 1024 * 1024; },
    get fichiersMax(){ return int(process.env.ANALYSIS_MAX_FILES, 25); },
    get fichierMaxOctets(){ return int(process.env.ANALYSIS_MAX_FILE_MB, 16) * 1024 * 1024; },
    /* Au-delà, les fichiers produits sont effacés : ce sont des résultats de
       travail, pas un entrepôt. */
    get retentionMs(){ return int(process.env.ANALYSIS_RESULT_TTL_MIN, 60) * 60_000; },
    get executionsConservees(){ return int(process.env.ANALYSIS_KEEP_RUNS, 20); },
    /* Deux exécutions simultanées au plus : un interpréteur statistique prend
       tout le processeur qu'on lui laisse, et la route est ouverte à un humain,
       pas à une file d'attente. */
    get simultaneesMax(){ return int(process.env.ANALYSIS_MAX_CONCURRENT, 2); },
    get racineTravail(){ return process.env.ANALYSIS_WORKDIR || os.tmpdir(); },
    /* Le PATH transmis à l'enfant. Volontairement court et explicite : il fait
       partie de l'environnement construit à la main (voir lib/moteur.js), il
       n'est jamais hérité du processus MEMS. */
    get pathEnfant(){ return process.env.ANALYSIS_PATH || "/usr/local/bin:/usr/bin:/bin"; },
    get langEnfant(){ return process.env.ANALYSIS_LANG || "C.UTF-8"; },
  },
};
