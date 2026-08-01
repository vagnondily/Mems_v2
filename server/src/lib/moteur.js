import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { newId } from "./crypto.js";
import { log } from "./logger.js";

/* ═══════════════════════════════════════════════════════════════════════════
   Exécution de scripts d'analyse (R, SPSS) sur le serveur.

   Ce module fait entrer dans MEMS la seule chose que le reste de l'application
   s'interdit : exécuter du code écrit par un utilisateur. Tout ce qui suit
   existe pour borner ce que ce code peut atteindre, et rien d'autre.

   CE QUI EST GARANTI
     — la fonction est absente tant qu'aucun interpréteur n'est déclaré ;
     — l'enfant ne reçoit AUCUNE variable d'environnement de l'application ;
     — il travaille dans un répertoire neuf, détruit dans tous les cas ;
     — il est tué par son GROUPE au bout d'un délai borné ;
     — ses sorties et ses fichiers produits sont plafonnés.

   CE QUI NE L'EST PAS — et qu'il faut lire avant d'activer la fonction :
     — l'enfant tourne sous L'UTILISATEUR DU PROCESSUS MEMS. Il lit donc tout
       ce que cet utilisateur lit : le fichier .env, la base SQLite, les
       sauvegardes. Purger l'environnement ferme le raccourci le plus court,
       pas l'accès au disque ;
     — le RÉSEAU est ouvert : un script peut appeler l'extérieur ;
     — ni processeur, ni mémoire, ni écritures disque hors du répertoire de
       travail ne sont limités. Node ne sait pas le faire ; cela relève du
       système (conteneur dédié, utilisateur sans droits, cgroups, seccomp).
   Autrement dit : ce module rend l'exécution traçable et bornée dans le temps,
   il ne remplace pas un bac à sable. Une instance qui active la fonction doit
   faire tourner MEMS dans un conteneur dont la perte est acceptable.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Table des interpréteurs ───────────────────────────────────────────────
   En ajouter un est une ligne : le nom de la variable d'environnement, le nom
   du fichier de script et les arguments. Rien d'autre dans le module ne connaît
   R ni SPSS. La clé est la valeur de `scripts.language` en base. */
export const INTERPRETEURS = {
  R: {
    libelle: "R (Rscript)",
    variable: "ANALYSIS_R",
    fichier: "analyse.R",
    /* --vanilla : ni ~/.Rprofile, ni ~/.Renviron, ni .RData rechargé. HOME est
       déjà un répertoire neuf, mais un exploitant qui pointerait ailleurs ne
       doit pas pouvoir faire exécuter un profil au passage. */
    args: (f) => ["--vanilla", f],
  },
  SPSS: {
    libelle: "SPSS (pspp)",
    variable: "ANALYSIS_SPSS",
    fichier: "analyse.sps",
    /* pspp est la seule implémentation libre du langage SPSS. --batch lit la
       syntaxe d'un bout à l'autre sans jamais attendre de réponse à une invite :
       sans lui un script mal formé resterait bloqué jusqu'au délai maximal. */
    args: (f) => ["--batch", f],
  },
};

/* Le jeu de données et le script portent des noms fixes, connus des modèles de
   l'interface (web/src/views/Analytics.jsx lit déjà « donnees.csv »). */
export const FICHIER_DONNEES = "donnees.csv";
/* HOME et TMPDIR de l'enfant, dans le répertoire de travail : ce que
   l'interpréteur écrit « chez lui » disparaît avec le reste et ne se mêle pas
   aux fichiers produits par le script. */
const FOYER = ".foyer";

/* État d'un interpréteur : déclaré ? utilisable ? sinon, pourquoi. Le « pourquoi »
   remonte jusqu'à l'exploitant, c'est lui qui doit corriger sa configuration. */
export function etatMoteur(lang){
  const def = INTERPRETEURS[lang];
  if(!def) return { lang, libelle:lang, disponible:false, raison:"langage inconnu" };
  const chemin = config.analyse.chemin(def.variable);
  /* « déclaré » et « disponible » sont deux choses distinctes, et les confondre
     donne le pire message d'erreur qui soit : répondre « déclarez la variable »
     à l'exploitant qui vient de la déclarer, mais avec un chemin fautif. */
  const base = { lang, libelle:def.libelle, variable:def.variable, declare: !!chemin };
  if(!chemin) return { ...base, disponible:false,
    raison:`${def.variable} n'est pas renseignée` };
  if(!path.isAbsolute(chemin)) return { ...base, disponible:false,
    raison:`${def.variable} doit porter un chemin absolu, pas « ${chemin} »` };
  try{ fs.accessSync(chemin, fs.constants.X_OK); }
  catch{ return { ...base, disponible:false,
    raison:`${chemin} est introuvable ou n'est pas exécutable` }; }
  return { ...base, disponible:true, chemin };
}
export const etatMoteurs = () => Object.keys(INTERPRETEURS).map(etatMoteur);
export const moteurActif = () => etatMoteurs().some(m => m.disponible);

/* ── Jeu de données ────────────────────────────────────────────────────────
   Les données sont écrites en CSV à côté du script, jamais interpolées dans le
   code : une valeur venue du terrain qui contient une apostrophe ou un appel de
   fonction serait autrement exécutée comme du code. Le script la lit par un
   chemin RELATIF, il n'a donc besoin d'aucune notion du disque du serveur. */
export function versCsv(lignes){
  const colonnes = [];
  const vues = new Set();
  for(const l of lignes) for(const k of Object.keys(l || {}))
    if(!vues.has(k)){ vues.add(k); colonnes.push(k); }
  const cellule = (v) => {
    if(v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lignesCsv = [colonnes.map(cellule).join(",")];
  for(const l of lignes) lignesCsv.push(colonnes.map(c => cellule((l||{})[c])).join(","));
  return lignesCsv.join("\n") + "\n";
}

/* ── Environnement expurgé ─────────────────────────────────────────────────
   LE POINT CENTRAL DU MODULE. `spawn` hérite de `process.env` par défaut : sans
   cette fonction, un script de trois lignes — `Sys.getenv("DATA_KEY")` — lit la
   clé de chiffrement des jetons, le secret de signature des sessions et le
   chemin de la base. On construit donc l'environnement à la main, par liste
   blanche : ce qui n'est pas nommé ici n'existe pas pour l'enfant, y compris les
   variables que MEMS ne connaît pas encore.
   PATH et LANG sont réglables (ANALYSIS_PATH, ANALYSIS_LANG) parce qu'un
   interpréteur a besoin des outils de son installation ; ce sont des valeurs
   d'exploitant, jamais des secrets. */
function envExpurge(foyer){
  const env = Object.create(null);
  env.PATH   = config.analyse.pathEnfant;
  env.HOME   = foyer;   /* neuf, et détruit avec le répertoire de travail */
  env.TMPDIR = foyer;
  env.LANG   = config.analyse.langEnfant;
  env.LC_ALL = config.analyse.langEnfant;
  return env;
}

/* Tampon de sortie plafonné : on continue de lire le flux — sinon l'enfant se
   bloquerait sur un tube plein et ne rendrait jamais la main — mais on cesse
   d'accumuler, et on le dit. */
function tampon(maxOctets){
  const morceaux = []; let octets = 0; let tronque = false;
  return {
    ajoute(d){
      const reste = maxOctets - octets;
      if(reste <= 0){ tronque = true; return; }
      if(d.length > reste){ morceaux.push(d.subarray(0, reste)); octets = maxOctets; tronque = true; }
      else { morceaux.push(d); octets += d.length; }
    },
    get texte(){ return Buffer.concat(morceaux).toString("utf8"); },
    get tronque(){ return tronque; },
    get octets(){ return octets; },
  };
}

/* Le processus a été lancé « detached » : il est chef de son propre groupe, et
   -pid désigne le groupe entier. Tuer le seul pid laisserait vivre tout ce que
   le script a lancé lui-même — un `system("... &")` en R suffit à survivre à
   son parent, à garder le processeur et à retenir le tube de sortie. */
function tuerGroupe(pid){
  const signal = (sig) => { try{ process.kill(-pid, sig); }catch{ /* déjà mort */ } };
  signal("SIGTERM");
  /* Un interpréteur peut intercepter SIGTERM ; SIGKILL ne se refuse pas. */
  setTimeout(() => signal("SIGKILL"), config.analyse.sursisMs).unref();
}

function lancer({ chemin, args, travail, foyer }){
  return new Promise((resolve) => {
    const t0 = Date.now();
    const max = config.analyse.sortieMaxOctets;
    const sortie = tampon(max), erreur = tampon(max);
    let enfant;
    try{
      enfant = spawn(chemin, args, {
        cwd: travail,
        env: envExpurge(foyer),
        /* Jamais de shell : les arguments sont passés tels quels, aucune
           expansion, aucune chaîne à échapper. */
        shell: false,
        /* Nouveau groupe de processus — voir tuerGroupe. */
        detached: true,
        /* stdin fermé : un script qui attend une saisie échoue tout de suite
           au lieu de consommer le délai maximal. */
        stdio: ["ignore", "pipe", "pipe"],
      });
    }catch(e){
      return resolve({ statut:"echec", code:null, signal:null, dureeMs:0,
        sortie:"", erreur:String(e.message), tronque:false,
        message:"l'interpréteur n'a pas pu être lancé" });
    }
    let delaiDepasse = false;
    enfant.stdout.on("data", d => sortie.ajoute(d));
    enfant.stderr.on("data", d => erreur.ajoute(d));
    const minuterie = setTimeout(() => { delaiDepasse = true; tuerGroupe(enfant.pid); },
      config.analyse.delaiMs);
    const fin = (r) => { clearTimeout(minuterie); resolve(r); };
    enfant.on("error", (e) => fin({ statut:"echec", code:null, signal:null,
      dureeMs: Date.now()-t0, sortie:sortie.texte, erreur:String(e.message),
      tronque:false, message:"l'interpréteur n'a pas pu être lancé" }));
    /* « close » et non « exit » : on attend la fermeture des tubes, donc la
       sortie complète, y compris celle des enfants du script. */
    enfant.on("close", (code, signal) => fin({
      statut: delaiDepasse ? "delai" : (code === 0 ? "ok" : "echec"),
      code, signal, dureeMs: Date.now()-t0,
      sortie: sortie.texte, erreur: erreur.texte,
      tronque: sortie.tronque || erreur.tronque,
      sortieTronquee: sortie.tronque, erreurTronquee: erreur.tronque,
    }));
  });
}

/* ── Répertoires ───────────────────────────────────────────────────────────
   Deux racines sous ANALYSIS_WORKDIR : « travail-* », détruit dans tous les cas,
   et « resultats/ », qui ne garde que les fichiers produits, le temps de les
   télécharger. Le contenu de « resultats/ » est effacé au démarrage : après un
   redémarrage plus rien ne sait à qui appartenait quoi, donc plus rien ne doit
   être servi. Deux instances MEMS sur la même machine doivent recevoir des
   ANALYSIS_WORKDIR distincts, sans quoi elles s'effacent mutuellement. */
const racine = () => path.join(config.analyse.racineTravail, "mems-analyse");
const racineResultats = () => path.join(racine(), "resultats");
let amorce = false;
function preparerRacines(){
  if(!amorce){
    fs.rmSync(racineResultats(), { recursive:true, force:true });
    amorce = true;
  }
  fs.mkdirSync(racineResultats(), { recursive:true, mode:0o700 });
}

/* Nom de fichier acceptable : servi plus tard par une route, il ne doit ni
   remonter l'arborescence, ni se confondre avec un fichier caché. */
const NOM_SUR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/* Ce que le script a produit dans son répertoire de travail : c'est la seule
   raison de lancer une analyse. Les entrées (données, script) en sont exclues,
   ainsi que tout ce qui n'est pas un fichier ordinaire — un lien symbolique
   posé par le script pointerait vers n'importe quel fichier du serveur, et la
   route de téléchargement le suivrait. */
async function recolter(travail, exclus){
  const entrees = await fsp.readdir(travail, { withFileTypes:true });
  const gardes = []; const ecartes = [];
  for(const e of entrees.sort((a,b) => a.name.localeCompare(b.name))){
    if(exclus.has(e.name)) continue;
    if(!e.isFile()){ ecartes.push(`${e.name} (n'est pas un fichier ordinaire)`); continue; }
    if(!NOM_SUR.test(e.name)){ ecartes.push(`${e.name} (nom refusé)`); continue; }
    if(gardes.length >= config.analyse.fichiersMax){ ecartes.push(`${e.name} (au-delà de ${config.analyse.fichiersMax} fichiers)`); continue; }
    /* Le répertoire est encore le terrain de jeu d'un processus qu'on vient de
       tuer : un fichier peut disparaître entre l'inventaire et sa mesure. Ce
       n'est pas une panne du serveur, c'est un fichier en moins. */
    let st;
    try{ st = await fsp.stat(path.join(travail, e.name)); }
    catch{ ecartes.push(`${e.name} (disparu avant d'être récupéré)`); continue; }
    if(st.size > config.analyse.fichierMaxOctets){ ecartes.push(`${e.name} (trop volumineux)`); continue; }
    gardes.push({ nom:e.name, octets:st.size });
  }
  return { gardes, ecartes };
}

/* Registre en mémoire des fichiers conservés. En mémoire volontairement : ces
   fichiers ne survivent pas au processus, les inscrire en base laisserait des
   lignes qui ne désignent plus rien. */
const RESULTATS = new Map();

function purger(){
  const limite = Date.now() - config.analyse.retentionMs;
  for(const [id, r] of RESULTATS)
    if(r.at < limite) oublier(id);
  while(RESULTATS.size > config.analyse.executionsConservees)
    oublier(RESULTATS.keys().next().value);   /* Map : insertion d'abord, donc le plus ancien */
}
function oublier(id){
  const r = RESULTATS.get(id);
  RESULTATS.delete(id);
  if(r) fs.rmSync(r.dossier, { recursive:true, force:true });
}

async function conserver(id, userId, travail, fichiers){
  if(!fichiers.length) return [];
  const dossier = path.join(racineResultats(), id);
  await fsp.mkdir(dossier, { recursive:true, mode:0o700 });
  for(const f of fichiers)
    await fsp.copyFile(path.join(travail, f.nom), path.join(dossier, f.nom));
  RESULTATS.set(id, { at:Date.now(), userId, dossier, fichiers });
  purger();
  return fichiers;
}

/* Résolution d'un téléchargement. Le nom demandé n'est jamais assemblé en
   chemin : il doit figurer au manifeste de l'exécution, sinon il n'existe pas.
   Une exécution n'appartient qu'à celui qui l'a lancée — deux super-utilisateurs
   ne se lisent pas mutuellement leurs résultats. */
export function fichierResultat(execId, nom, userId){
  const r = RESULTATS.get(execId);
  if(!r || r.userId !== userId) return null;
  if(r.at < Date.now() - config.analyse.retentionMs){ oublier(execId); return null; }
  const f = r.fichiers.find(x => x.nom === nom);
  if(!f) return null;
  const chemin = path.join(r.dossier, f.nom);
  return fs.existsSync(chemin) ? { chemin, ...f } : null;
}

/* ── Exécutions simultanées ────────────────────────────────────────────────
   Un interpréteur statistique prend tout le processeur qu'on lui laisse. Sans
   ce compteur, quelques appels suffisent à mettre le serveur à genoux — la
   fonction est réservée au super-utilisateur, elle n'est pas pour autant un
   droit d'épuiser la machine. */
let enCours = 0;
export const placeLibre = () => enCours < config.analyse.simultaneesMax;

/* ── Exécution ─────────────────────────────────────────────────────────────
   Rend toujours un compte rendu, y compris quand le script échoue : un script
   faux est un résultat d'analyse, pas une panne du serveur. */
export async function executer({ lang, code, lignes, userId }){
  const moteur = etatMoteur(lang);
  if(!moteur.disponible){ const e = new Error(moteur.raison); e.indisponible = true; throw e; }
  const def = INTERPRETEURS[lang];

  const csv = versCsv(lignes);
  const octets = Buffer.byteLength(csv);
  if(octets > config.analyse.donneesMaxOctets){
    const e = new Error(`le jeu de données pèse ${Math.round(octets/1048576)} Mo, au-delà de la limite `
      + `de ${Math.round(config.analyse.donneesMaxOctets/1048576)} Mo`);
    e.tropGros = true; throw e;
  }

  preparerRacines();
  const id = newId("exec");
  fs.mkdirSync(racine(), { recursive:true, mode:0o700 });
  /* Compté AVANT la première attente, donc dans le même tour de boucle que le
     `placeLibre()` de l'appelant : deux requêtes arrivées ensemble ne peuvent
     pas franchir toutes les deux un compteur encore à zéro. */
  enCours++;
  let travail = null;
  try{
    travail = await fsp.mkdtemp(path.join(racine(), "travail-"));
    const foyer = path.join(travail, FOYER);
    await fsp.mkdir(foyer, { mode:0o700 });
    await fsp.writeFile(path.join(travail, FICHIER_DONNEES), csv, { mode:0o600 });
    await fsp.writeFile(path.join(travail, def.fichier), code, { mode:0o600 });

    const r = await lancer({ chemin:moteur.chemin, args:def.args(def.fichier), travail, foyer });
    const { gardes, ecartes } = await recolter(travail, new Set([FICHIER_DONNEES, def.fichier, FOYER]));
    const fichiers = await conserver(id, userId, travail, gardes);

    return { id, lang, moteur:moteur.libelle, interpreteur:moteur.chemin,
      lignes: lignes.length, octetsDonnees: octets, fichiers, fichiersEcartes: ecartes, ...r };
  }finally{
    enCours--;
    /* Dans tous les cas : succès, échec, délai dépassé, exception. Le répertoire
       contient le jeu de données du pays, il ne traîne pas dans /tmp. */
    if(travail) await fsp.rm(travail, { recursive:true, force:true }).catch(e =>
      log.warn("répertoire d'analyse non supprimé", { travail, message:e.message }));
  }
}
