import { Router } from "express";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db.js";
import { config } from "../config.js";
import { newId } from "../lib/crypto.js";
import { log } from "../lib/logger.js";

/* ═══════════════════════════════════════════════════════════════════════
   Mettre à jour depuis le dépôt.

   Un bouton qui va chercher du code sur internet et redémarre le serveur est, par
   construction, un chemin d'exécution de code à distance. Ce n'est pas une raison de
   ne pas le faire — sans lui, une correction urgente suppose un accès SSH, et il n'y
   en a pas toujours un le jour où il faut. C'est une raison de le construire avec des
   contraintes qui ne se contournent pas.

   QUATRE RÈGLES, et elles se tiennent l'une l'autre :

     1. RIEN NE VIENT DE LA REQUÊTE. Le dépôt, la branche, la commande à exécuter, ce
        qu'on fait après : tout est décidé à l'installation, dans l'environnement du
        serveur. Une requête ne peut que demander « applique ce qui est configuré ».
        Autrement, tout administrateur pourrait faire exécuter n'importe quoi sur la
        machine — ce ne serait plus une mise à jour mais une prise de contrôle.

     2. FERMÉ PAR DÉFAUT. Sans UPDATE_MODE, la route répond que la fonction n'est pas
        installée, et l'écran ne s'affiche pas. Une installation qui n'a pas voulu de
        cette porte ne doit pas en avoir une.

     3. LES DONNÉES NE BOUGENT PAS. La mise à jour touche le code, jamais le dossier
        de données. Une sauvegarde JSON est prise avant, par le serveur lui-même :
        compter sur la mémoire de l'exploitant au moment où il clique est une mauvaise
        façon de protéger des données.

     4. ON REGARDE AVANT. « Vérifier » lit ce qui a changé en amont et le dit —
        combien de commits, lesquels — sans rien écrire. Appliquer est un second geste,
        délibéré.

   Le mode « commande » existe parce que toutes les installations ne se mettent pas à
   jour par git : en conteneur, c'est « docker compose pull && up -d ». La commande
   vient de l'environnement et n'est jamais composée avec quoi que ce soit de reçu.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();
const exec = promisify(execFile);
const racine = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const off = () => config.update.mode === "off";
const refus = (res) => res.status(501).json({
  error: "la mise à jour depuis le dépôt n'a pas été installée sur ce serveur",
  remede: "elle se choisit à l'installation (UPDATE_MODE), pas depuis l'application" });

/* Seul le rôle « super » met à jour du code. « admin » administre des données ;
   remplacer le programme qui les traite est d'un autre ordre. */
function requireSuper(req, res, next){
  if(req.user?.role !== "super")
    return res.status(403).json({ error:"réservé au compte de super-utilisateur" });
  next();
}

const journal = (req, action, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'securite','update',?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, action, texte);

const git = (args, opts = {}) =>
  exec("git", args, { cwd:racine, timeout:60_000, maxBuffer:4 * 1024 * 1024, ...opts });

/* La version actuelle, telle que le dépôt la connaît. Sans dépôt git — une
   installation déployée par copie de fichiers — on le dit plutôt que d'inventer. */
async function versionCourante(){
  try{
    const [sha, date, sujet, branche, sale] = await Promise.all([
      git(["rev-parse","HEAD"]), git(["log","-1","--format=%cI"]),
      git(["log","-1","--format=%s"]), git(["rev-parse","--abbrev-ref","HEAD"]),
      git(["status","--porcelain"]),
    ]);
    return {
      commit: sha.stdout.trim().slice(0, 12),
      date: date.stdout.trim(),
      sujet: sujet.stdout.trim(),
      branche: branche.stdout.trim(),
      /* Des modifications locales non validées : appliquer par-dessus les écraserait
         ou ferait échouer l'avance rapide. On préfère le dire tout de suite. */
      modifieLocalement: sale.stdout.trim().split("\n").filter(Boolean).length,
    };
  }catch(e){ return { erreur:"ce serveur n'est pas un dépôt git : " + e.message }; }
}

/* ── Les dépendances ──────────────────────────────────────────────────
   C'est le trou le plus dangereux d'une mise à jour automatique, et il est silencieux :
   le code arrive, il importe une bibliothèque que la version précédente n'avait pas, et
   personne ne l'installe. Le serveur redémarre alors sur « Cannot find module », c'est-
   à-dire qu'il ne redémarre pas du tout — et l'on découvre la panne au moment où plus
   personne ne peut se connecter pour la comprendre.

   On regarde donc ce que la mise à jour touche AVANT de l'appliquer, et l'on
   réinstalle ce qu'il faut, là où il faut : `npm ci` plutôt que `npm install`, parce
   qu'on veut exactement le verrou versionné et rien d'autre — une résolution qui
   diffère du dépôt donnerait un serveur qui ne ressemble à aucun autre. */
const ESPACES = [
  { nom:"server", chemin:"server", verrou:/^server\/package(-lock)?\.json$/ },
  { nom:"web",    chemin:"web",    verrou:/^web\/package(-lock)?\.json$/ },
];
const espacesConcernes = (fichiers) =>
  ESPACES.filter(e => fichiers.some(f2 => e.verrou.test(f2))).map(e => e.nom);

r.get("/status", requireSuper, async (req, res) => {
  /* Demander l'état n'est pas demander une action : la réponse est 200 et dit que la
     fonction n'est pas installée. Un 501 ici faisait apparaître un appel en échec dans
     la console de tout administrateur ouvrant cet écran, pour une situation
     parfaitement normale — et une alerte qui se déclenche quand tout va bien est une
     alerte qu'on cesse de lire. */
  if(off()) return res.json({ mode:"off", disponible:false,
    message:"la mise à jour depuis le dépôt n'a pas été installée sur ce serveur",
    remede:"elle se choisit à l'installation (UPDATE_MODE), pas depuis l'application" });
  const derniere = db.prepare(
    `SELECT at, user_label, text, action FROM audit
     WHERE entity='update' ORDER BY at DESC LIMIT 1`).get();
  res.json({
    mode: config.update.mode,
    /* On annonce CE QUI SERA FAIT, pas seulement que c'est possible. */
    reglages: {
      remote: config.update.remote, branche: config.update.branch,
      commande: config.update.mode === "commande" ? config.update.commande : null,
      migrer: config.update.migrer, construire: config.update.construire,
      redemarrer: config.update.redemarrer, sauvegarder: config.update.sauvegarder,
    },
    version: await versionCourante(),
    derniere: derniere || null,
  });
});

/* ── Vérifier ─────────────────────────────────────────────────────────
   On récupère l'état du dépôt distant SANS toucher au code local : `git fetch` écrit
   dans .git, jamais dans l'arbre de travail. On rend ce qui sépare les deux. */
r.post("/check", requireSuper, async (req, res) => {
  if(off()) return refus(res);
  if(config.update.mode === "commande") return res.json({
    mode:"commande",
    message:"En mode « commande », l'écart n'est pas mesurable ici : c'est la commande d'installation qui décide de ce qui est repris.",
    commande: config.update.commande,
  });

  try{
    await git(["fetch", config.update.remote, config.update.branch]);
    const cible = `${config.update.remote}/${config.update.branch}`;
    const { stdout: retard } = await git(["rev-list","--count",`HEAD..${cible}`]);
    const { stdout: avance } = await git(["rev-list","--count",`${cible}..HEAD`]);
    const { stdout: liste } = await git([
      "log","--format=%h|%cI|%an|%s","-20",`HEAD..${cible}`]);
    /* Les fichiers qui changent : ce sont eux qui disent si une réinstallation de
       dépendances sera nécessaire. Une mise à jour qui ajoute une bibliothèque sans
       la poser fait tomber le serveur au redémarrage, et c'est exactement le genre
       de panne qu'on ne veut pas découvrir après coup. */
    const { stdout: fichiers } = await git(["diff","--name-only",`HEAD..${cible}`]);
    const touches = fichiers.split("\n").filter(Boolean);
    const deps = espacesConcernes(touches);
    const moteur = touches.some(f2 => /(^|\/)\.nvmrc$/.test(f2))
      || touches.some(f2 => /package\.json$/.test(f2));
    const commits = liste.trim().split("\n").filter(Boolean).map(l => {
      const [sha, date, auteur, ...reste] = l.split("|");
      return { sha, date, auteur, sujet: reste.join("|") };
    });
    journal(req, "check", `Vérification — ${retard.trim()} commit(s) en attente sur ${cible}`);
    res.json({
      mode:"git", cible,
      enAttente: Number(retard.trim()), enAvance: Number(avance.trim()),
      commits,
      /* Ce que la mise à jour impliquera au-delà du code lui-même. */
      dependances: deps.length ? deps : null,
      fichiersSensibles: touches.filter(f2 =>
        /package(-lock)?\.json$|^server\/migrations\/|\.nvmrc$|Dockerfile$/.test(f2)).slice(0, 20),
      migrations: touches.filter(f2 => /^server\/migrations\//.test(f2)).length,
      moteurPeutChanger: moteur,
      version: await versionCourante(),
      /* Une branche locale en avance signifie des commits qui n'existent pas en
         amont : l'avance rapide échouerait, et écraser serait perdre du travail. */
      avertissement: Number(avance.trim()) > 0
        ? "Ce serveur porte des commits absents du dépôt distant : la mise à jour en avance rapide sera refusée."
        : null,
    });
  }catch(e){
    res.status(502).json({ error:"impossible de joindre le dépôt : " + (e.stderr || e.message) });
  }
});

/* La sauvegarde d'avant, écrite sur disque à côté de la base. Elle réutilise la même
   projection que l'export JSON de l'application — un seul format à connaître le jour
   où il faut s'en servir. */
async function sauvegardeAvant(req){
  const dossier = path.resolve(racine, "server", config.update.dossierSauvegardes);
  fs.mkdirSync(dossier, { recursive:true });
  const { default: backupRouter } = await import("./backup.js");
  /* On appelle la route en interne plutôt que de dupliquer la liste des tables :
     deux listes divergeraient, et c'est la sauvegarde qui perdrait. */
  const capture = await new Promise((resolve, reject) => {
    const faux = { query:{}, user:req.user };
    const rep = { setHeader(){}, status(){ return this; },
      json(o){ resolve(o); return this; } };
    const couche = backupRouter.stack.find(l => l.route?.path === "/" && l.route.methods.get);
    if(!couche) return reject(new Error("route de sauvegarde introuvable"));
    /* La pile porte le contrôle de droit puis la poignée ; on saute le premier, le
       rôle ayant déjà été vérifié plus haut. */
    const poignee = couche.route.stack[couche.route.stack.length - 1].handle;
    try{ poignee(faux, rep, reject); }catch(e){ reject(e); }
  });
  const nom = `avant_maj_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.json`;
  const chemin = path.join(dossier, nom);
  fs.writeFileSync(chemin, JSON.stringify(capture));
  return { chemin, octets: fs.statSync(chemin).size };
}

/* ── Appliquer ────────────────────────────────────────────────────────
   L'ordre compte : sauvegarder, récupérer le code, migrer la base, reconstruire
   l'interface, et redémarrer en dernier. Chaque étape est rendue avec son issue, car
   une mise à jour qui échoue au milieu doit se raconter — « erreur » tout court
   laisserait à chercher dans les journaux du serveur. */
/* Revenir au commit d'où l'on partait, et remettre les dépendances de ce commit. On
   ne prétend pas rejouer une migration à l'envers — une migration appliquée reste
   appliquée, c'est pour cela que la sauvegarde est prise avant. Mais rendre au code
   son état antérieur suffit à laisser un serveur qui démarre, ce qui est la seule
   chose qui compte à cet instant. */
async function revenir(sha){
  if(!sha) return { fait:false, motif:"aucun point de retour connu" };
  try{
    await exec("git", ["reset","--hard", sha], { cwd:racine, timeout:120_000 });
    for(const e of ESPACES){
      try{ await exec("npm", ["ci","--no-audit","--no-fund"],
        { cwd:path.join(racine, e.chemin), timeout:600_000, maxBuffer:16 * 1024 * 1024 }); }
      catch(_){ /* on continue : mieux vaut un espace remis que zéro */ }
    }
    return { fait:true, commit:sha.slice(0,12) };
  }catch(e){ return { fait:false, motif:e.message }; }
}

r.post("/apply", requireSuper, async (req, res) => {
  if(off()) return refus(res);
  const p = z.object({
    /* Une confirmation explicite, et pas une case à cocher : on tape le mot. Le geste
       remplace le programme en cours d'exécution ; il mérite une seconde de plus. */
    confirmation: z.literal("METTRE A JOUR"),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({
    error:"confirmation manquante", attendu:"METTRE A JOUR" });

  const etapes = [];
  const etape = (nom, ok, detail) => { etapes.push({ nom, ok, detail }); return ok; };
  const ms = config.update.delaiSecondes * 1000;
  let avant = null;              /* le commit d'où l'on part, pour pouvoir y revenir */
  let deps = [];                 /* les espaces dont les dépendances auront bougé */

  try{
    if(config.update.sauvegarder){
      try{ const s = await sauvegardeAvant(req);
        etape("sauvegarde", true, `${s.chemin} (${Math.round(s.octets/1024)} Ko)`); }
      catch(e){
        /* Pas de filet, pas de saut. */
        etape("sauvegarde", false, e.message);
        journal(req, "apply-refus", "Mise à jour refusée : la sauvegarde préalable a échoué");
        return res.status(409).json({ error:"la sauvegarde préalable a échoué, la mise à jour est annulée",
          detail:e.message, etapes });
      }
    }

    if(config.update.mode === "git"){
      const cible = `${config.update.remote}/${config.update.branch}`;
      /* Le point de retour. Une mise à jour qui échoue à mi-parcours laisserait un
         serveur dont le code est neuf et les dépendances anciennes — le pire des deux
         états, et celui qui ne redémarre pas. On note donc où l'on était. */
      avant = (await git(["rev-parse","HEAD"])).stdout.trim();
      const { stdout: sale } = await git(["status","--porcelain"]);
      if(sale.trim()){
        etape("code", false, "des fichiers sont modifiés localement");
        journal(req, "apply-refus", "Mise à jour refusée : l'arbre de travail porte des modifications locales");
        return res.status(409).json({
          error:"ce serveur porte des modifications locales non validées ; la mise à jour les écraserait",
          fichiers: sale.trim().split("\n").slice(0,10), etapes });
      }
      await git(["fetch", config.update.remote, config.update.branch], { timeout:ms });
      /* Ce que la mise à jour va toucher, LU AVANT de l'appliquer. */
      const { stdout: changes } = await git(["diff","--name-only",`HEAD..${cible}`]);
      deps = espacesConcernes(changes.split("\n").filter(Boolean));
      try{
        const { stdout } = await git(["merge","--ff-only", cible], { timeout:ms });
        etape("code", true, (stdout.trim().split("\n").slice(-1)[0] || "à jour")
          + (deps.length ? ` — dépendances modifiées : ${deps.join(", ")}` : ""));
      }catch(e){
        /* Refuser vaut mieux que fusionner : une fusion automatique sur un serveur de
           production, sans personne pour lire le conflit, est une très mauvaise idée. */
        etape("code", false, e.stderr || e.message);
        journal(req, "apply-echec", "Avance rapide impossible");
        return res.status(409).json({
          error:"l'avance rapide est impossible : l'historique local a divergé du dépôt",
          remede:"réglez la divergence en ligne de commande — une fusion automatique sur un serveur en service n'est pas souhaitable",
          etapes });
      }
    } else {
      /* Mode « commande » : telle que l'exploitant l'a écrite, dans un shell, sans
         qu'aucune valeur reçue n'y soit jamais insérée. */
      const { stdout, stderr } = await exec("/bin/sh", ["-c", config.update.commande],
        { cwd:racine, timeout:ms, maxBuffer:4 * 1024 * 1024 });
      etape("commande", true, (stdout || stderr).trim().slice(-400));
    }

    /* Les dépendances AVANT la migration et la construction : la migration lit du
       code serveur, la construction lit du code web, et l'une comme l'autre échouerait
       sur une bibliothèque absente. `npm ci` supprime node_modules et repose
       exactement le verrou — c'est plus long, et c'est le seul résultat reproductible. */
    for(const nom of deps){
      const dossier = path.join(racine, nom);
      try{
        await exec("npm", ["ci","--no-audit","--no-fund"],
          { cwd:dossier, timeout:ms, maxBuffer:16 * 1024 * 1024 });
        etape(`dépendances ${nom}`, true, "npm ci");
      }catch(e){
        etape(`dépendances ${nom}`, false, (e.stderr || e.message || "").slice(-400));
        const retour = await revenir(avant);
        journal(req, "apply-echec", `Installation des dépendances (${nom}) échouée — retour à ${avant?.slice(0,8) || "?"}`);
        return res.status(500).json({
          error:`l'installation des dépendances de « ${nom} » a échoué ; la mise à jour a été annulée`,
          retourArriere: retour, etapes,
          note:"Le code a été remis dans son état précédent. Vérifiez l'accès au registre npm depuis ce serveur." });
      }
    }

    if(config.update.migrer){
      const { stdout } = await exec("npm", ["run","migrate"],
        { cwd:path.join(racine, "server"), timeout:ms, maxBuffer:4 * 1024 * 1024 });
      etape("migration", true, stdout.trim().split("\n").slice(-1)[0]);
    }
    if(config.update.construire){
      const { stdout } = await exec("npm", ["run","build"],
        { cwd:path.join(racine, "web"), timeout:ms, maxBuffer:8 * 1024 * 1024 });
      etape("interface", true, stdout.trim().split("\n").slice(-1)[0]);
    }

    const version = await versionCourante();
    journal(req, "apply", `Mise à jour appliquée — ${etapes.filter(e=>e.ok).length} étape(s), version ${version.commit || "?"}`);

    if(config.update.redemarrer){
      etape("redémarrage", true, "le service s'arrête ; le superviseur doit le relancer");
      /* On répond AVANT de s'arrêter : sinon l'écran resterait sur une requête morte
         sans savoir si la mise à jour a réussi. */
      res.json({ ok:true, etapes, version, redemarrage:true,
        note:"Le service s'arrête maintenant. Il revient dès que le superviseur l'a relancé." });
      setTimeout(() => { log.info("arrêt demandé après mise à jour"); process.exit(0); }, 400);
      return;
    }
    res.json({ ok:true, etapes, version, redemarrage:false,
      note:"Le code est à jour. Redémarrez le service pour qu'il soit chargé." });
  }catch(e){
    etape("erreur", false, (e.stderr || e.message || "").slice(0, 600));
    /* Migration ou construction en échec : on rend au code son état antérieur plutôt
       que de laisser un serveur mi-neuf mi-ancien, qui ne redémarrerait pas. */
    const retour = await revenir(avant);
    journal(req, "apply-echec", `Mise à jour interrompue : ${(e.message||"").slice(0,180)}`);
    res.status(500).json({ error:"la mise à jour s'est interrompue", etapes,
      retourArriere: retour,
      note:"Les données n'ont pas été touchées ; une sauvegarde a été prise avant la tentative." +
        (retour.fait ? " Le code a été remis dans son état précédent." : "") });
  }
});

export default r;
