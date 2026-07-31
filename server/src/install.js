#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   Installation.

   Jusqu'ici, installer MEMS voulait dire copier `.env.example`, y écrire deux secrets
   à la main, deviner ce que valaient une douzaine de variables, et découvrir après
   coup celles qu'on avait oubliées. Cela fonctionne quand on a écrit le programme ; ce
   n'est pas raisonnable autrement.

   Ce script pose les questions dans l'ordre où elles se posent, et écrit le fichier
   `.env`. Il ne demande QUE ce qui ne peut pas être deviné : les secrets sont
   engendrés, les valeurs raisonnables sont proposées, et l'on valide en tapant Entrée.

   La question de la MISE À JOUR est ici, et pas dans l'application, et c'est délibéré.
   Un bouton qui va chercher du code sur internet et redémarre le serveur est un chemin
   d'exécution de code à distance : il appartient à la personne qui tient la machine
   d'en décider, une fois, au moment où elle l'installe. Rien de ce qui est répondu ici
   ne pourra être modifié depuis une requête HTTP.

   Le script ne détruit rien : s'il existe déjà un `.env`, il le lit, propose les
   valeurs en place comme défaut, et n'écrit qu'après avoir montré ce qui change.
   ═══════════════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ici = path.dirname(fileURLToPath(import.meta.url));
const racineServeur = path.resolve(ici, "..");
const racine = path.resolve(racineServeur, "..");
const fichierEnv = path.join(racineServeur, ".env");

const G = (t) => `\x1b[32m${t}\x1b[0m`;
const J = (t) => `\x1b[33m${t}\x1b[0m`;
const S = (t) => `\x1b[2m${t}\x1b[0m`;
const B = (t) => `\x1b[1m${t}\x1b[0m`;

/* Hors terminal — un déploiement scripté, une image Docker qui se prépare — les
   réponses sont lues d'un coup sur l'entrée standard, dans l'ordre des questions.
   Sans cela, l'installation ne serait possible qu'à la main, ce qui condamnerait
   toute mise en service automatisée. */
const interactif = stdin.isTTY;
let file = [];
if(!interactif){
  const brut = fs.readFileSync(0, "utf8");
  file = brut.split("\n");
}
const rl = interactif ? readline.createInterface({ input:stdin, output:stdout }) : null;
const lire = async (invite) => {
  if(interactif) return rl.question(invite);
  const v = file.length ? file.shift() : "";
  stdout.write(invite + v + "\n");
  return v;
};
const secret = () => crypto.randomBytes(32).toString("hex");

/* L'existant fait foi comme valeur par défaut : réinstaller ne doit pas réinventer un
   secret et invalider toutes les sessions sans prévenir. */
const existant = {};
if(fs.existsSync(fichierEnv))
  for(const ligne of fs.readFileSync(fichierEnv, "utf8").split("\n")){
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if(m) existant[m[1]] = m[2];
  }

async function demander(question, defaut, aide){
  if(aide) console.log(S("   " + aide));
  const suffixe = defaut !== undefined && defaut !== "" ? S(` [${defaut}]`) : "";
  const r = (await lire(`   ${question}${suffixe} : `)).trim();
  return r || defaut || "";
}
async function choisir(question, options, defaut, aide){
  console.log("\n" + B(question));
  if(aide) console.log(S("   " + aide));
  options.forEach(([cle, titre, detail], i) => {
    console.log(`   ${J(String(i+1))}. ${B(titre)}`);
    if(detail) console.log(S(`      ${detail}`));
  });
  const parDefaut = options.findIndex(o => o[0] === defaut) + 1 || 1;
  while(true){
    const r = (await lire(`   Votre choix ${S(`[${parDefaut}]`)} : `)).trim();
    const i = r ? Number(r) : parDefaut;
    if(Number.isInteger(i) && i >= 1 && i <= options.length) return options[i-1][0];
    console.log(J("   Répondez par un numéro de la liste."));
  }
}
const ouiNon = async (question, defaut = true, aide) => {
  if(aide) console.log(S("   " + aide));
  const r = (await lire(`   ${question} ${S(defaut ? "[O/n]" : "[o/N]")} : `)).trim();
  return r ? /^(o|oui|y|yes)$/i.test(r) : defaut;
};

const env = {};
const poser = (cle, valeur) => { if(valeur !== "" && valeur !== undefined) env[cle] = String(valeur); };

console.log(`
${B("╔══════════════════════════════════════════════════════════════╗")}
${B("║  MEMS — installation                                         ║")}
${B("╚══════════════════════════════════════════════════════════════╝")}
${S("Entrée valide la valeur proposée entre crochets.")}
${fs.existsSync(fichierEnv) ? J("Un fichier .env existe : ses valeurs servent de défaut.") : ""}
`);

/* ── 1. Le service ─────────────────────────────────────────────────── */
console.log(B("① Le service"));
poser("NODE_ENV", await demander("Environnement", existant.NODE_ENV || "production",
  "« production » exige de vrais secrets et pose le cookie en HTTPS uniquement."));
poser("PORT", await demander("Port d'écoute", existant.PORT || "4000"));
poser("HOST", await demander("Adresse d'écoute", existant.HOST || "0.0.0.0",
  "127.0.0.1 si un reverse proxy est devant, 0.0.0.0 sinon."));
poser("DB_FILE", await demander("Fichier de base", existant.DB_FILE || "./data/mems.db",
  "Ce dossier n'est JAMAIS touché par une mise à jour."));

/* ── 2. Les secrets ────────────────────────────────────────────────── */
console.log("\n" + B("② Les secrets"));
console.log(S("   Engendrés ici. Ne les retapez pas à la main : la longueur compte plus que"));
console.log(S("   l'imagination, et un secret court est refusé au démarrage en production."));
poser("JWT_SECRET", existant.JWT_SECRET && existant.JWT_SECRET.length >= 32
  ? existant.JWT_SECRET : secret());
poser("DATA_KEY", existant.DATA_KEY && existant.DATA_KEY.length >= 32
  ? existant.DATA_KEY : secret());
console.log(`   ${G("✓")} JWT_SECRET  ${existant.JWT_SECRET ? S("(conservé)") : G("(engendré)")}`);
console.log(`   ${G("✓")} DATA_KEY    ${existant.DATA_KEY ? S("(conservé)") : G("(engendré)")}`);
if(existant.DATA_KEY)
  console.log(S("   DATA_KEY est conservée : la changer rendrait illisibles les jetons ODK déjà enregistrés."));

/* ── 3. Devant le service ──────────────────────────────────────────── */
console.log("\n" + B("③ Devant le service"));
poser("CORS_ORIGINS", await demander("Origines autorisées",
  existant.CORS_ORIGINS || "http://localhost:5173",
  "Séparées par des virgules. L'adresse à laquelle vos utilisateurs ouvrent MEMS."));
poser("TRUST_PROXY", await ouiNon("Un reverse proxy est-il devant (nginx, Traefik) ?",
  /^(1|true|yes|on)$/i.test(existant.TRUST_PROXY || ""),
  "Sans cela, la limitation de débit compte toutes les requêtes comme venant du proxy.") ? "1" : "0");
poser("TILE_HOSTS", await demander("Fond de carte",
  existant.TILE_HOSTS ?? "https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "Laisser vide interdit toute origine externe : la carte s'affichera sans fond."));

/* ── 4. La mise à jour ─────────────────────────────────────────────── */
console.log(`
${B("④ La mise à jour depuis le dépôt")}
${S("   C'est la décision la plus lourde de cette installation, et c'est pourquoi elle")}
${S("   se prend ici plutôt que dans l'application. Un bouton qui va chercher du code")}
${S("   sur internet et redémarre le serveur est un chemin d'exécution de code à")}
${S("   distance. Ce que vous répondez maintenant ne pourra pas être modifié depuis")}
${S("   une requête HTTP : ni le dépôt, ni la branche, ni la commande.")}`);

const mode = await choisir("Comment ce serveur se met-il à jour ?", [
  ["off", "Jamais depuis l'application",
   "Les mises à jour se font en ligne de commande. L'écran n'existe pas. C'est le choix le plus sûr."],
  ["git", "Depuis ce dépôt git (avance rapide)",
   "MEMS relit le dépôt cloné, avance sur la branche choisie, migre et reconstruit. Refuse toute fusion non triviale."],
  ["commande", "Par une commande que vous fournissez",
   "Pour les installations en conteneur : « docker compose pull && docker compose up -d »."],
], existant.UPDATE_MODE || "off");
poser("UPDATE_MODE", mode);

if(mode !== "off"){
  let branche = existant.UPDATE_BRANCH || "main";
  if(mode === "git"){
    try{ branche = existant.UPDATE_BRANCH
      || execFileSync("git", ["rev-parse","--abbrev-ref","HEAD"], { cwd:racine })
        .toString().trim(); }catch(e){}
    poser("UPDATE_REMOTE", await demander("Dépôt distant", existant.UPDATE_REMOTE || "origin"));
    poser("UPDATE_BRANCH", await demander("Branche à suivre", branche,
      "La mise à jour n'avancera que sur celle-ci, et jamais par fusion."));
  } else {
    let cmd = "";
    while(!cmd){
      cmd = await demander("Commande de mise à jour", existant.UPDATE_COMMAND || "",
        "Lancée telle quelle, dans le dossier du projet. Aucune valeur reçue n'y sera insérée.");
      if(!cmd) console.log(J("   Une commande est nécessaire en mode « commande »."));
    }
    poser("UPDATE_COMMAND", cmd);
  }

  console.log("\n" + S("   Ce que MEMS fait APRÈS avoir récupéré le code :"));
  poser("UPDATE_BACKUP", await ouiNon("Sauvegarder la base avant chaque mise à jour ?", true,
    "Fortement conseillé : sans sauvegarde réussie, la mise à jour est annulée.") ? "1" : "0");
  poser("UPDATE_MIGRATE", await ouiNon("Appliquer les migrations de base ?", true) ? "1" : "0");
  poser("UPDATE_BUILD", await ouiNon("Reconstruire l'interface ?", true,
    "Nécessaire si le serveur sert lui-même les fichiers construits.") ? "1" : "0");
  poser("UPDATE_RESTART", await ouiNon("Arrêter le service à la fin pour qu'il redémarre ?", false,
    "Ne répondez oui que si un superviseur le relance (systemd, Docker « restart: always »). Sinon il resterait éteint.") ? "1" : "0");

  console.log(`
${J("   ⚠ ")}${B("À retenir")} : seul le compte « super-utilisateur » pourra déclencher une mise
${S("   à jour, en tapant une confirmation explicite. Chaque tentative est journalisée,")}
${S("   et le dossier de données n'est jamais touché.")}`);
}

/* ── 5. Le premier compte ──────────────────────────────────────────── */
console.log("\n" + B("⑤ Le premier compte"));
poser("BOOTSTRAP_EMAIL", await demander("Adresse de l'administrateur",
  existant.BOOTSTRAP_EMAIL || "admin@mems.local",
  "Son mot de passe est engendré au premier démarrage et affiché une seule fois."));

/* ── Écriture ──────────────────────────────────────────────────────── */
const lignes = [
  "# Fichier engendré par « npm run install:mems ».",
  "# Les secrets ci-dessous ne doivent jamais être versionnés.",
  `# Écrit le ${new Date().toISOString()}`,
  "",
  ...Object.entries(env).map(([k,v]) => `${k}=${v}`),
  "",
];

console.log("\n" + B("Récapitulatif"));
for(const [k,v] of Object.entries(env)){
  const masque = /SECRET|KEY/.test(k) ? v.slice(0,6) + "…" + S(" (masqué)") : v;
  const change = existant[k] !== undefined && existant[k] !== v;
  console.log(`   ${change ? J("~") : G("✓")} ${k.padEnd(16)} ${masque}`);
}

if(await ouiNon(`\nÉcrire ${path.relative(racine, fichierEnv)} ?`, true)){
  if(fs.existsSync(fichierEnv)){
    const copie = fichierEnv + "." + new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
    fs.copyFileSync(fichierEnv, copie);
    console.log(S(`   Ancien fichier conservé sous ${path.basename(copie)}`));
  }
  fs.writeFileSync(fichierEnv, lignes.join("\n"), { mode:0o600 });
  console.log(G(`   ✓ ${fichierEnv} écrit (lisible par vous seul).`));
  console.log(`
${B("Ensuite :")}
   ${G("npm --prefix server run migrate")}   ${S("crée ou met à jour le schéma")}
   ${G("npm --prefix web run build")}        ${S("construit l'interface")}
   ${G("npm --prefix server start")}         ${S("démarre — le mot de passe initial s'affiche une fois")}
`);
} else {
  console.log(J("   Rien n'a été écrit."));
}
rl?.close();
