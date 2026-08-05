import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId, encrypt, decrypt } from "../lib/crypto.js";
import { can, requireCap } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { log } from "../lib/logger.js";
import { champ, champsObligatoires, champs as champsDe, entite, entites,
         registrePublic, TRANSFORM_PAR_TYPE } from "../lib/champs.js";
import { appliquerLot, NOMS_TRANSFORMATIONS, transformationsPubliques } from "../lib/mapping.js";
import { cheminFoundry, lireDatasetFoundry, lireJsonHttp, lireKobo, verifierBaseSortante,
         CHEMIN_DONNEES_KOBO_DEFAUT, CHEMIN_DONNEES_KOBO_V1_DEFAUT } from "../lib/foundry.js";
import { porteurAuth, sonder, schemasAuthPublics, indicesSecret, CAUSES_AUTH,
         NOMS_SCHEMAS_AUTH, SCHEMAS_AUTH, CHEMIN_EPREUVE_KOBO_DEFAUT,
         CHEMIN_EPREUVE_ODK_DEFAUT } from "../lib/authSortante.js";
import { TYPES_STRUCTURE } from "../lib/xlsform.js";

/* ═══════════════════════════════════════════════════════════════════════
   Connecteurs et correspondance des variables.

   « À chaque liaison, mets en place un système de mapping des variables pour
   correspondre à ceux utilisés par MEMS, et ainsi on ne se perd pas à recoder à
   chaque fois. » Ces routes sont la mise en œuvre littérale de cette demande :
   déclarer une source, dire quelle variable alimente quel champ MEMS, vérifier
   le résultat sur de vraies lignes — sans écrire une ligne de code par source.

   Quatre principes, tous vérifiables dans les tests :

   — Le registre des champs (lib/champs.js) est la seule source de vérité. La
     route `/champs` le sert tel quel, la validation d'écriture le relit. L'écran
     n'en tient aucune copie.
   — Aucun secret ne ressort. Le jeton est chiffré à l'écriture, jamais renvoyé,
     et seule sa présence (`hasSecret`) est visible.
   — Rien n'est deviné en silence. `/suggestions` propose et note ; il n'écrit
     jamais. `/apercu` montre l'avant et l'après, et dit ce qui manquerait.
   — La lecture est cloisonnée par bureau, comme le reste de l'application.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

const S = (max) => z.string().trim().max(max).optional().nullable()
  .transform(v => (v === "" ? null : v ?? null));

const NATURES = ["odk", "kobo", "foundry", "csv", "http"];
/* Les natures qui vont chercher la donnée par le réseau : pour elles, une adresse
   de base est indispensable, et son absence doit se dire à la création — pas au
   premier aperçu, trois écrans plus loin. */
const NATURES_RESEAU = new Set(["odk", "kobo", "foundry", "http"]);
/* Les natures que le serveur sait réellement ALLER LIRE. « kobo » y entre avec
   ce chantier : elle était déclarable depuis la migration 016 mais n'était lue
   par personne — l'aperçu la renvoyait à un échantillon collé, alors que la
   configuration exigeait une adresse de base. Une nature réseau sans lecteur est
   une promesse non tenue ; il ne lui manquait que le bon en-tête (`Token` et non
   `Bearer`) et le bon chemin.
   « odk » reste dehors, et c'est délibéré : le tirage ODK a son propre écran et
   son propre cache (`odk_forms.raw`). Le dupliquer ici ferait un second chemin
   d'appel sortant à sécuriser, pour rien. */
const NATURES_LUES = new Set(["foundry", "http", "kobo"]);

/* Une configuration ne porte JAMAIS de secret : le jeton a sa colonne chiffrée.
   Sans ce refus, un administrateur pressé collerait son jeton dans `config` —
   d'où il ressortirait en clair par GET /api/connectors, pour tout le bureau. */
const CLES_INTERDITES = /(token|secret|password|passwd|mot_de_passe|api_?key|bearer|credential)/i;

const schemaConnecteur = z.object({
  name:      z.string().trim().min(2).max(160),
  kind:      z.enum(NATURES),
  base_url:  S(400),
  config:    z.record(z.any()).default({}),
  /* Écrit, jamais relu : laissé vide lors d'une modification, l'existant est conservé. */
  secret:    z.string().max(4000).optional().nullable(),
  /* Le schéma d'authentification est une DONNÉE de la source, contrôlée contre la
     table de lib/authSortante.js et non contre une liste recopiée ici — même règle
     que pour les transformations, et même raison.

     FACULTATIF, et non « porteur par défaut » : une valeur par défaut réécrit la
     colonne à chaque enregistrement, donc ramène à « porteur » toute source
     réglée autrement dès qu'un client qui ignore ce champ neuf — script
     d'exploitation, écran d'une version antérieure — renvoie la fiche sans lui.
     Le mot de passe d'un compte de service partirait alors en clair comme jeton
     porteur, et les connecteurs sans secret que la migration 021 a basculés en
     « aucun » redeviendraient refusés avant l'appel. routes/collections.js pose
     la même règle pour les sources ODK, et l'explique dans les mêmes termes ; la
     poser d'un seul côté revenait à ne pas la poser. « porteur » reste le défaut
     à la CRÉATION, où l'absence de champ n'écrase rien. */
  auth_schema: z.enum(NOMS_SCHEMAS_AUTH).optional(),
  /* La moitié non secrète d'un justificatif à deux parties. Elle n'a rien à faire
     dans `config` : CLES_INTERDITES y refuse déjà tout ce qui ressemble à un
     secret, et séparer les deux moitiés d'une même paire entre deux mécanismes de
     rangement est le meilleur moyen qu'elles cessent un jour de correspondre.

     Facultative pour la même raison que le schéma, et distinguée de la chaîne
     vide : absente, elle conserve l'existant ; envoyée vide, elle l'efface. */
  auth_identifiant: z.string().trim().max(200).optional().nullable(),
  office_id: S(64),
  active:    z.boolean().default(true),
  rev:       z.number().int().min(1).optional(),
});

const schemaCorrespondance = z.object({
  entity:        z.string().trim().min(1).max(40),
  mems_field:    z.string().trim().min(1).max(60),
  source_path:   S(200),
  transform:     z.string().trim().max(40).default("brut"),
  required:      z.boolean().default(false),
  default_value: S(400),
  note:          S(400),
  position:      z.number().int().min(0).max(9999).optional(),
});

const invalide = (res, parsed, message = "données invalides") =>
  res.status(422).json({ error: message,
    details: parsed.error.issues.slice(0, 10)
      .map(i => ({ champ: i.path.join("."), message: i.message })) });

/* La forme publique d'un connecteur. Le jeton n'y figure pas — seulement le fait
   qu'il existe : c'est ce dont l'écran a besoin pour afficher « présent » ou
   « manquant », et rien de plus ne doit sortir. */
async function shape(c, { administration = false } = {}){
  return {
    id: c.id, name: c.name, kind: c.kind, base_url: c.base_url || "",
    /* `connector.config` est une colonne jsonb : pg la rend déjà comme un objet
       JS, plus besoin de JSON.parse (contrairement à SQLite où c'était du TEXT). */
    config: c.config || {},
    hasSecret: !!c.secret_enc,
    /* Le schéma sort, le secret jamais : l'écran en a besoin pour demander les bons
       champs à la prochaine ouverture de la fiche.

       L'IDENTIFIANT, lui, ne sort que vers l'administration. Il n'est pas un secret
       — c'est ce qui l'accompagne qui en est un — mais c'est la moitié NOMMÉE d'un
       couple : le courriel du compte de service ODK Central, l'identifiant d'un
       Basic. Servi à tout compte authentifié, il donnait à un rôle « lecteur »,
       avec l'adresse du serveur déjà publiée, la moitié du travail d'une attaque
       par mot de passe menée directement chez la source — hors de portée du
       limiteur de débit de MEMS. La fiche qui le modifie est réservée à
       l'administration ; sa lecture le sera aussi. */
    ...(administration ? { auth_identifiant: c.auth_identifiant || "" } : {}),
    auth_schema: c.auth_schema || "porteur",
    office_id: c.office_id || null,
    active: !!c.active,
    created_at: c.created_at, updated_at: c.updated_at, rev: c.rev || 1,
    mappings: (await db.prepare("SELECT COUNT(*) c FROM connector_mapping WHERE connector_id=?").get(c.id)).c,
  };
}

const audit = async (req, action, id, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'connecteur','connector',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, id, action, texte);

/* Charge un connecteur en appliquant le cloisonnement, ou répond et rend null.
   Le même chemin sert à la lecture et à l'écriture : deux contrôles distincts
   finiraient par ne plus dire la même chose. */
async function charger(req, res){
  const c = await db.prepare("SELECT * FROM connector WHERE id=?").get(req.params.id);
  if(!c){ res.status(404).json({ error: "connecteur introuvable" }); return null; }
  const bureau = await officeBound(req.user);
  if(bureau && c.office_id !== bureau){
    /* 404 et non 403 : répondre « interdit » confirmerait l'existence d'un
       connecteur d'un autre bureau, ce que ce compte n'a pas à savoir. */
    res.status(404).json({ error: "connecteur introuvable" }); return null;
  }
  return c;
}

/* ── Registre des champs MEMS ─────────────────────────────────────────
   Déclarée avant toute route à paramètre : « champs » ne doit jamais être lu
   comme un identifiant de connecteur.

   Ouverte à tout compte authentifié : c'est une description du modèle, sans
   aucune donnée. L'écran qui la consomme est réservé aux administrateurs, mais
   fonder le secret d'un modèle de données sur une route serait illusoire. */
r.get("/connectors/champs", (req, res) => {
  res.json({
    entites: registrePublic(),
    transformations: transformationsPubliques(),
    /* La troisième liste fermée servie par le serveur, au même titre et pour la
       même raison que les deux autres : l'écran demande les champs qu'exige le
       schéma choisi, et affiche l'indication « où trouver ce justificatif »
       telle qu'elle est écrite dans lib/authSortante.js. Une copie dans le
       navigateur proposerait tôt ou tard un schéma que le serveur refuse. */
    schemasAuth: schemasAuthPublics(),
    causesAuth: CAUSES_AUTH,
  });
});

/* ── Liste ────────────────────────────────────────────────────────────
   Cloisonnée comme le reste : un compte borné à un bureau ne voit que les
   connecteurs de son bureau. Les connecteurs sans bureau (portée nationale) ne
   lui sont pas montrés non plus — c'est la règle déjà appliquée à l'écriture des
   collections, où une ligne sans bureau est « ailleurs ». */
r.get("/connectors", async (req, res) => {
  const bureau = await officeBound(req.user);
  const rows = bureau
    ? await db.prepare("SELECT * FROM connector WHERE office_id=? ORDER BY name").all(bureau)
    : await db.prepare("SELECT * FROM connector ORDER BY name").all();
  const administration = can(req.user, "admin");
  res.json({ rows: await Promise.all(rows.map(c => shape(c, { administration }))) });
});

r.post("/connectors", requireCap("admin"), async (req, res, next) => {
  const parsed = schemaConnecteur.safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "connecteur invalide");
  /* À la création, l'absence de schéma vaut « porteur » : c'est le seul
     comportement que l'ancien code ait jamais eu, et rien n'est écrasé puisqu'il
     n'y avait rien. La modification, elle, ne comble aucun blanc. */
  const d = { ...parsed.data, auth_schema: parsed.data.auth_schema || "porteur",
              auth_identifiant: parsed.data.auth_identifiant || null };

  const probleme = verifierConfig(d, null);
  if(probleme) return res.status(422).json({ error: probleme });

  const id = newId("conn");
  try{
    await db.prepare(`INSERT INTO connector
                  (id,name,kind,base_url,config,secret_enc,auth_schema,auth_identifiant,office_id,active)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, d.name, d.kind, d.base_url, JSON.stringify(d.config),
           d.secret ? encrypt(d.secret) : null, d.auth_schema, d.auth_identifiant,
           d.office_id, d.active ? 1 : 0);
  }catch(e){
    /* TODO-PG: ce test reconnaissait une violation de clé étrangère au message
       d'erreur de better-sqlite3 ("FOREIGN KEY..."). Le pilote pg formule cette
       erreur autrement (message "violates foreign key constraint", code SQLSTATE
       23503) ; à vérifier contre le comportement réel du driver et ajuster le
       test — laissé tel quel pour ne pas deviner un nouveau motif. */
    if(/FOREIGN KEY/.test(e.message))
      return res.status(409).json({ error: "bureau inconnu : le connecteur n'a pas été créé" });
    return next(e);
  }
  await audit(req, "create", id, `Connecteur créé — ${d.name} (${d.kind})`);
  res.status(201).json({ connector: await shape(await db.prepare("SELECT * FROM connector WHERE id=?").get(id),
    { administration: true }) });
});

/* Les cinq connecteurs MoDa, un par formulaire de suivi de processus. « Créer les
   5 connecteurs où l'admin modifiera juste les numéros des formulaires et se
   liera automatiquement à la base. » On les pré-crée (idempotent, par nom),
   pré-réglés sur MoDa (API v1) et rattachés à leur ACTIVITÉ (config.activityTag) :
   l'administrateur n'a plus qu'à saisir le numéro du formulaire et le jeton, et
   les soumissions tirées se rattacheront à l'activité — donc à ses indicateurs. */
const CONNECTEURS_MODA = [
  { tag:"GD",    label:"GD / PREVMA" },
  { tag:"SMP",   label:"Repas scolaires (SMP)" },
  { tag:"MIARO", label:"MIARO — Résilience / Production" },
  { tag:"NUT",   label:"Nutrition (PECMAM / AIM)" },
  { tag:"SAMS",  label:"Résilience (SAMS)" },
];
r.post("/connectors/moda-preparer", requireCap("admin"), async (req, res, next) => {
  try{
    const bound = req.user?.office_id && !can(req.user, "admin") ? req.user.office_id : null;
    const ins = db.prepare(`INSERT INTO connector
        (id,name,kind,base_url,config,secret_enc,auth_schema,auth_identifiant,office_id,active)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const crees = [], existants = [];
    for(const c of CONNECTEURS_MODA){
      const nom = `MoDa — ${c.label}`;
      const deja = await db.prepare("SELECT id FROM connector WHERE name=?").get(nom);
      if(deja){ existants.push(nom); continue; }
      const id = newId("conn");
      /* MoDa est un déploiement KoboToolbox : son API v1 lit un GET
         « /api/v1/data/{n°}?format=json » et attend « Authorization: Token <clé> »
         — le schéma « jeton », PAS « porteur » (Bearer). Une clé MoDa présentée en
         Bearer revient en 401. On pré-règle donc le bon schéma : l'administrateur
         n'a que le numéro du formulaire et la clé à saisir. */
      await ins.run(id, nom, "kobo", "https://moda.wfp.org",
        JSON.stringify({ apiVersion:"v1", formId:"", activityTag:c.tag }),
        null, "jeton", null, bound, 0);
      crees.push(nom);
    }
    if(crees.length) await audit(req, "create", "moda", `Connecteurs MoDa préparés — ${crees.length} activité(s)`);
    const modaRows = await db.prepare("SELECT * FROM connector WHERE name LIKE 'MoDa — %' ORDER BY name").all();
    res.json({ crees, existants,
      connectors: await Promise.all(modaRows.map(x => shape(x, { administration: true }))) });
  }catch(e){ next(e); }
});

r.put("/connectors/:id", requireCap("admin"), async (req, res, next) => {
  const c = await charger(req, res); if(!c) return;
  const parsed = schemaConnecteur.safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "connecteur invalide");
  const d = parsed.data;

  const probleme = verifierConfig(d, c);
  if(probleme) return res.status(422).json({ error: probleme });

  if(d.rev !== undefined && d.rev !== c.rev)
    return res.status(409).json({
      error: "ce connecteur a été modifié pendant votre saisie. Rechargez pour repartir de la version à jour.",
      courant: await shape(c, { administration: true }) });

  /* Les colonnes d'authentification ne s'écrivent que si le corps les porte.
     Un `UPDATE` qui les nomme toujours remet la valeur par défaut du schéma de
     validation à chaque enregistrement — c'est-à-dire qu'un client qui ignore ces
     champs neufs reconfigure l'authentification de la source sans le savoir, et
     sans que rien ne l'en avertisse. */
  const colonnes = ["name=?", "kind=?", "base_url=?", "config=?", "office_id=?", "active=?"];
  const valeurs = [d.name, d.kind, d.base_url, JSON.stringify(d.config), d.office_id, d.active ? 1 : 0];
  if(d.auth_schema !== undefined){ colonnes.push("auth_schema=?"); valeurs.push(d.auth_schema); }
  if(d.auth_identifiant !== undefined){
    colonnes.push("auth_identifiant=?"); valeurs.push(d.auth_identifiant || null); }
  if(d.secret){ colonnes.push("secret_enc=?"); valeurs.push(encrypt(d.secret)); }

  try{
    await db.prepare(`UPDATE connector SET ${colonnes.join(", ")},
                  updated_at=now(), rev=rev+1
                WHERE id=?`).run(...valeurs, c.id);
  }catch(e){
    /* TODO-PG: même remarque que sur POST /connectors — le motif de détection de
       la violation de clé étrangère ("FOREIGN KEY") vient de better-sqlite3 et
       n'est pas garanti de matcher le message d'erreur de pg. */
    if(/FOREIGN KEY/.test(e.message))
      return res.status(409).json({ error: "bureau inconnu : le connecteur n'a pas été modifié" });
    return next(e);
  }
  await audit(req, "update", c.id, `Connecteur modifié — ${d.name} (${d.kind})`);
  res.json({ connector: await shape(await db.prepare("SELECT * FROM connector WHERE id=?").get(c.id),
    { administration: true }) });
});

r.delete("/connectors/:id", requireCap("admin"), async (req, res) => {
  const c = await charger(req, res); if(!c) return;
  /* Les correspondances partent avec le connecteur (ON DELETE CASCADE,
     migration 016) : elles n'ont aucun sens sans lui. */
  const n = (await db.prepare("SELECT COUNT(*) c FROM connector_mapping WHERE connector_id=?").get(c.id)).c;
  await db.prepare("DELETE FROM connector WHERE id=?").run(c.id);
  await audit(req, "delete", c.id, `Connecteur supprimé — ${c.name} (${n} correspondance(s) emportée(s))`);
  res.json({ ok: true, mappingsSupprimees: n });
});

/* Le porteur d'authentification d'un connecteur. Construit à un seul endroit —
   l'aperçu et l'épreuve de connexion s'en servent tous les deux — et il ne
   déchiffre le secret que là, au moment de sortir. */
function porteurDeConnecteur(c){
  /* `connector.config` est jsonb : déjà un objet côté pg, pas de JSON.parse. */
  const cfg = c.config || {};
  return porteurAuth({
    nature: "connector", id: c.id,
    schema: c.auth_schema || "porteur",
    identifiant: c.auth_identifiant || "",
    secret: c.secret_enc ? decrypt(c.secret_enc) : "",
    /* `decrypt` rend null quand la ligne ne s'authentifie pas — clé de
       chiffrement changée, base recopiée. Le porteur doit savoir distinguer ce
       cas d'un secret jamais saisi : les deux remèdes sont opposés. */
    secretPresent: !!c.secret_enc,
    baseUrl: c.base_url,
    /* Le chemin d'obtention du second secret, quand le schéma en dérive un.
       Réglable par connecteur : la valeur par défaut est celle du dépôt source du
       produit d'aujourd'hui, pas une constante du monde — voir lib/authSortante.js. */
    cheminSession: cfg.cheminAuth,
    verifierBase: (u) => verifierBaseSortante(u, `la source « ${c.name} »`),
    codeErreur: "SOURCE_AUTH",
    quoi: `la source « ${c.name} »`,
  });
}

/* Lecture d'un échantillon distant, partagée par l'aperçu et la découverte des
   variables : deux appels sortants au corps identique finiraient par diverger.
   Rend les lignes brutes de la source et le format lu, ou lève une erreur codée
   (SOURCE_*) que `repondreErreurSource` traduit en réponse HTTP. */
async function lireEchantillonDistant(c, limite){
  const cfg = c.config || {};
  const porteur = porteurDeConnecteur(c);
  const lu = c.kind === "foundry"
    ? await lireDatasetFoundry({ baseUrl: c.base_url, datasetRid: cfg.datasetRid,
        porteur, branche: cfg.branche || cfg.branchName || "master",
        limite, format: cfg.format || "CSV", chemin: cfg.chemin, pointeur: cfg.pointeur })
    : c.kind === "kobo"
    ? await lireKobo({ baseUrl: c.base_url, uid: cfg.uid, formId: cfg.formId,
        apiVersion: cfg.apiVersion === "v1" ? "v1" : "v2", porteur,
        chemin: cfg.chemin || (cfg.apiVersion === "v1" ? CHEMIN_DONNEES_KOBO_V1_DEFAUT : CHEMIN_DONNEES_KOBO_DEFAUT),
        pointeur: cfg.pointeur, limite })
    : await lireJsonHttp({ baseUrl: c.base_url, chemin: cfg.chemin, porteur,
        pointeur: cfg.pointeur, limite });
  return { lignes: (lu.rows || []).slice(0, limite), format: lu.format };
}

/* La traduction d'une erreur de lecture sortante en réponse : les mêmes codes,
   au même endroit, pour l'aperçu comme pour la découverte des variables. */
function repondreErreurSource(res, e, next, c){
  if(e.code === "SOURCE_URL" || e.code === "SOURCE_CONFIG" || e.code === "SOURCE_AUTH"
     || e.code === "SOURCE_NOT_FOUND")
    return res.status(422).json({ error: e.message, cause: e.causeAuth || null });
  if(e.code === "SOURCE_NETWORK" || e.code === "SOURCE_HTTP"){
    log.warn("lecture de source en échec", { connecteur: c.id, kind: c.kind, code: e.code });
    return res.status(502).json({ error:
      "la source n'a pas répondu correctement : vérifiez l'adresse, le jeton et la connectivité." });
  }
  return next(e);
}

/* Contrôles qui dépendent de la nature de la source, donc hors de portée de zod.
   `existant` est la ligne en base lors d'une modification, null à la création :
   plusieurs de ces règles ne peuvent se prononcer qu'en sachant ce qui était déjà
   là — un champ neuf ne peut pas être exigé d'une ligne écrite avant lui. */
function verifierConfig(d, existant){
  const json = JSON.stringify(d.config || {});
  if(json.length > 8000)
    return "configuration trop volumineuse : elle décrit où lire, elle ne porte pas les données.";
  for(const cle of Object.keys(d.config || {}))
    if(CLES_INTERDITES.test(cle))
      return `« ${cle} » ne peut pas figurer dans la configuration : les secrets ont leur propre `
        + "champ, chiffré au repos et jamais renvoyé par l'API.";
  if(NATURES_RESEAU.has(d.kind) && !d.base_url)
    return `une source de type « ${d.kind} » se lit par le réseau : son adresse de base est requise.`;
  if(d.kind === "foundry" && !d.config?.datasetRid)
    return "un connecteur Foundry a besoin de l'identifiant du jeu de données (config.datasetRid).";
  /* L'uid Kobo est exigé à la CRÉATION, et défendu contre l'effacement — pas
     réclamé d'une ligne qui n'en a jamais eu. Un connecteur « kobo » est
     déclarable depuis la migration 016 : ceux d'alors portent le couple
     projet / formulaire d'ODK, que l'écran leur proposait à tort. Exiger l'uid de
     tout enregistrement les rendait immodifiables — impossible de les renommer, de
     les désactiver ou de les rattacher à un bureau sans inventer d'abord un
     identifiant d'asset que personne n'avait eu à saisir. Ils restent illisibles
     tant que l'uid manque, et c'est `lireKobo` qui le dit, au moment où l'on
     essaie de lire, avec le geste à faire. */
  /* v1 (MoDa / ONA) désigne un formulaire par son NUMÉRO (config.formId), v2 par
     l'uid de l'asset (config.uid). On exige l'un OU l'autre selon la version — pas
     les deux — et, comme pour l'uid, seulement lorsque l'existant en portait déjà
     un : un connecteur v2 d'avant ne doit pas devenir immodifiable parce que la
     branche v1 est apparue. */
  const cfgExistant = existant ? (existant.config || {}) : null;
  const v1 = d.config?.apiVersion === "v1";
  if(d.kind === "kobo" && v1){
    if(!d.config?.formId && (!existant || cfgExistant?.formId))
      return "un connecteur MoDa/Kobo (API v1) a besoin du NUMÉRO du formulaire (config.formId) — "
        + "celui de l'adresse …/api/v1/data/340943.";
  } else if(d.kind === "kobo" && !d.config?.uid && (!existant || cfgExistant?.uid)){
    return "un connecteur KoboToolbox (API v2) a besoin de l'identifiant du formulaire (config.uid). "
      + "Kobo n'a pas de « projet » au sens d'ODK Central : un formulaire y est désigné par son seul uid.";
  }
  /* Le schéma choisi dit lui-même ce qu'il exige. Le contrôle est fait ici plutôt
     qu'au premier appel sortant, pour la même raison que l'adresse de base : une
     source à qui il manque de quoi s'authentifier doit le dire à la déclaration,
     pas trois écrans plus loin. `secret` peut rester vide en modification —
     l'existant est alors conservé, et c'est `hasSecret` qui fait foi.

     Le schéma et l'identifiant EFFECTIFS, c'est-à-dire ceux que la ligne portera
     après écriture : un corps qui ne les envoie pas conserve les siens, et
     contrôler la valeur envoyée reviendrait à contrôler autre chose que ce qui
     sera écrit. */
  const schemaEffectif = d.auth_schema ?? existant?.auth_schema ?? "porteur";
  const identifiantEffectif = d.auth_identifiant !== undefined
    ? d.auth_identifiant : (existant?.auth_identifiant || null);
  const defAuth = SCHEMAS_AUTH[schemaEffectif];
  if(!defAuth) return `schéma d'authentification inconnu : « ${schemaEffectif} ».`;
  if(defAuth.champs.some(x => x.cle === "identifiant" && x.requis) && !identifiantEffectif)
    return `le schéma « ${defAuth.libelle} » exige un identifiant en plus du secret : renseignez-le.`;
  return null;
}

/* ── Correspondances ──────────────────────────────────────────────────── */

r.get("/connectors/:id/mappings", async (req, res) => {
  const c = await charger(req, res); if(!c) return;
  const rows = await db.prepare(
    `SELECT * FROM connector_mapping WHERE connector_id=?
      ${req.query.entity ? "AND entity=?" : ""} ORDER BY entity, position, mems_field`)
    .all(...(req.query.entity ? [c.id, String(req.query.entity)] : [c.id]));
  res.json({
    connector: await shape(c),
    rows: rows.map(m => ({ ...m, required: !!m.required })),
  });
});

/* Validation contre le registre : c'est ici que « le registre est la seule source
   de vérité » cesse d'être une intention. Un champ MEMS inexistant, une entité
   inconnue ou une transformation hors du jeu fermé sont refusés, avec assez de
   détail pour corriger sans deviner.

   La même fonction sert à l'enregistrement ET à l'aperçu : un aperçu qui
   accepterait ce que l'enregistrement refuse enverrait travailler une heure sur
   une correspondance qui ne pourra jamais être sauvegardée. */
function validerCorrespondances(mappings, entity){
  const erreurs = [];
  const vues = new Set();
  mappings.forEach((m, i) => {
    if(entity && m.entity !== entity)
      erreurs.push({ ligne: i, message: `entité « ${m.entity} » incohérente avec « ${entity} »` });
    if(!entite(m.entity))
      erreurs.push({ ligne: i, message: `entité inconnue : « ${m.entity} ». Connues : ${entites().join(", ")}` });
    else if(!champ(m.entity, m.mems_field))
      erreurs.push({ ligne: i, message: `champ inconnu pour « ${m.entity} » : « ${m.mems_field} ». `
        + `Champs : ${champsDe(m.entity).map(x => x.nom).join(", ")}` });
    if(!NOMS_TRANSFORMATIONS.includes(m.transform))
      erreurs.push({ ligne: i, message: `transformation inconnue : « ${m.transform} ». `
        + `Disponibles : ${NOMS_TRANSFORMATIONS.join(", ")}` });
    const cle = `${m.entity}::${m.mems_field}`;
    if(vues.has(cle))
      erreurs.push({ ligne: i, message: `ce champ est déclaré deux fois : « ${m.mems_field} ». `
        + "Un champ MEMS ne peut être alimenté que par une seule variable source." });
    vues.add(cle);
  });
  return erreurs;
}

/* Remplacement en bloc. Deux portées possibles, et la différence compte :
   — avec `entity`, seules les correspondances de CETTE entité sont remplacées ;
   — sans, toutes celles du connecteur le sont.
   L'écran travaille entité par entité : sans la première forme, éditer les
   correspondances « site » effacerait celles des « réceptions » sans le dire. */
r.put("/connectors/:id/mappings", requireCap("admin"), async (req, res, next) => {
  const c = await charger(req, res); if(!c) return;
  const parsed = z.object({
    entity: z.string().trim().max(40).optional(),
    mappings: z.array(schemaCorrespondance).max(500).default([]),
  }).safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "correspondances invalides");
  const { entity, mappings } = parsed.data;

  const erreurs = validerCorrespondances(mappings, entity);
  if(erreurs.length)
    return res.status(422).json({ error: "correspondances refusées", details: erreurs.slice(0, 10) });

  try{
    await tx(async (db) => {
      if(entity) await db.prepare("DELETE FROM connector_mapping WHERE connector_id=? AND entity=?")
        .run(c.id, entity);
      else await db.prepare("DELETE FROM connector_mapping WHERE connector_id=?").run(c.id);
      const ins = db.prepare(`INSERT INTO connector_mapping
        (id,connector_id,entity,mems_field,source_path,transform,required,default_value,note,position)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      for(const [i, m] of mappings.entries())
        await ins.run(newId("cmap"), c.id, m.entity, m.mems_field,
          m.source_path, m.transform, m.required ? 1 : 0, m.default_value, m.note,
          m.position ?? i);
      await db.prepare("UPDATE connector SET updated_at=now() WHERE id=?").run(c.id);
    });
  }catch(e){ return next(e); }

  await audit(req, "mappings", c.id,
    `Correspondances enregistrées — ${c.name}${entity ? ` / ${entity}` : ""} : ${mappings.length} ligne(s)`);
  const rows = await db.prepare(
    "SELECT * FROM connector_mapping WHERE connector_id=? ORDER BY entity, position, mems_field").all(c.id);
  res.json({ ok: true, enregistrees: mappings.length,
    rows: rows.map(m => ({ ...m, required: !!m.required })) });
});

/* ── Aperçu ───────────────────────────────────────────────────────────
   Le point qui rend la correspondance vérifiable : mêmes lignes, avant et après,
   plus la liste de ce qui manquerait. C'est ce qui permet de corriger un mapping
   sans rien importer, donc sans rien abîmer.

   Réservé à l'administration, alors que la lecture de la configuration ne l'est
   pas : cette route-ci déchiffre le jeton du connecteur, déclenche un appel
   sortant en son nom, et renvoie les lignes SOURCE telles quelles — c'est-à-dire
   des colonnes que la correspondance ne retient pas forcément. Ce n'est pas de la
   configuration, c'est de la donnée. */
r.post("/connectors/:id/apercu", requireCap("admin"), async (req, res, next) => {
  const c = await charger(req, res); if(!c) return;
  const parsed = z.object({
    entity: z.string().trim().max(40).optional(),
    echantillon: z.array(z.record(z.any())).max(200).default([]),
    /* Facultatif : permet de vérifier des correspondances AVANT de les
       enregistrer. Sans cela, il faudrait écrire pour voir — l'inverse de ce
       qu'on veut d'un aperçu. */
    mappings: z.array(schemaCorrespondance).max(500).optional(),
    limite: z.number().int().min(1).max(50).default(5),
  }).safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "demande d'aperçu invalide");
  const { echantillon, limite } = parsed.data;

  /* L'entité : celle demandée, sinon la seule des correspondances enregistrées.
     S'il y en a plusieurs, on ne choisit pas à la place de l'utilisateur. */
  const entitesEnregistrees = (await db.prepare(
    "SELECT DISTINCT entity FROM connector_mapping WHERE connector_id=?").all(c.id)).map(x => x.entity);
  const entityDemandee = parsed.data.entity
    || (entitesEnregistrees.length === 1 ? entitesEnregistrees[0] : null);
  if(!entityDemandee) return res.status(422).json({ error: entitesEnregistrees.length
    ? `ce connecteur porte des correspondances pour ${entitesEnregistrees.join(", ")} : précisez l'entité.`
    : "aucune correspondance enregistrée : précisez l'entité et fournissez des correspondances à tester." });
  if(!entite(entityDemandee))
    return res.status(422).json({ error: `entité inconnue : « ${entityDemandee} »` });

  let mappings;
  if(parsed.data.mappings){
    /* Correspondances fournies dans la demande : elles passent par la MÊME
       validation que l'enregistrement, sinon l'aperçu accepterait ce que
       « Enregistrer » refusera trois clics plus loin. */
    const erreurs = validerCorrespondances(parsed.data.mappings, entityDemandee);
    if(erreurs.length)
      return res.status(422).json({ error: "correspondances refusées", details: erreurs.slice(0, 10) });
    mappings = parsed.data.mappings
      .map((m, i) => ({ ...m, required: m.required ? 1 : 0, position: m.position ?? i }));
  } else {
    mappings = await db.prepare(`SELECT * FROM connector_mapping WHERE connector_id=? AND entity=?
                           ORDER BY position, mems_field`).all(c.id, entityDemandee);
  }

  /* La source des lignes : ce qui a été collé, ou une lecture distante pour les
     natures qui savent aller chercher. Pour ODK, le tirage a déjà son écran et
     son cache (odk_forms.raw) : le dupliquer ici ferait un second chemin
     d'appel sortant à sécuriser, pour rien. */
  let lignes = echantillon.slice(0, limite);
  let provenance = "échantillon fourni";
  if(!lignes.length){
    if(NATURES_LUES.has(c.kind)){
      try{
        /* La cause nommée part avec le message (voir repondreErreurSource) :
           l'écran distingue « corrigez le justificatif » de « demandez des
           droits à la source », ce qu'un texte unique ne permettait pas. */
        const lu = await lireEchantillonDistant(c, limite);
        lignes = lu.lignes;
        provenance = `lecture distante (${c.kind}, ${lu.format})`;
      }catch(e){ return repondreErreurSource(res, e, next, c); }
    } else {
      return res.status(422).json({ error:
        `aucun échantillon fourni. Une source de type « ${c.kind} » n'est pas lue par le serveur : `
        + "collez quelques enregistrements pour vérifier la correspondance." });
    }
  }

  let resultat;
  try{
    resultat = appliquerLot(mappings, lignes, { obligatoires: champsObligatoires(entityDemandee) });
  }catch(e){
    if(e.code === "MAPPING_TRANSFORM") return res.status(422).json({ error: e.message });
    return next(e);
  }

  /* Les manquants agrégés : c'est la réponse à « est-ce que ça passera ? ».
     Une seule ligne fautive suffit à répondre non — d'où `ok` calculé sur
     l'ensemble et non ligne à ligne. */
  const manquants = [];
  for(const l of resultat) for(const m of l.manquants)
    if(!manquants.some(x => x.champ === m.champ)) manquants.push(m);

  res.json({
    entity: entityDemandee,
    provenance,
    lignesLues: lignes.length,
    correspondances: mappings.length,
    champsObligatoires: champsObligatoires(entityDemandee),
    manquants,
    ok: manquants.length === 0,
    lignes: resultat,
  });
});

/* ── Variables de la source ───────────────────────────────────────────
   « Config facile : à l'enregistrement, tester la connexion et, si elle passe,
   peupler automatiquement la table de correspondance. » C'est le maillon qui
   manquait entre l'épreuve et les suggestions : lire un petit échantillon et en
   rendre les COLONNES, pour proposer les correspondances SANS que l'utilisateur
   ait à coller un échantillon ni joindre un XLSForm.

   Elle ne rend que des noms de colonnes et quelques lignes d'exemple — la même
   donnée que l'aperçu, et réservée à l'administration pour la même raison :
   elle déchiffre le jeton et déclenche un appel sortant au nom du bureau. */
r.post("/connectors/:id/variables", requireCap("admin"), async (req, res, next) => {
  const c = await charger(req, res); if(!c) return;
  if(!NATURES_LUES.has(c.kind)) return res.status(422).json({ error:
    `une source de type « ${c.kind} » n'est pas lue par le serveur : joignez le XLSForm `
    + "ou collez un échantillon pour découvrir ses variables." });
  const limite = z.coerce.number().int().min(1).max(50).catch(10).parse(req.body?.limite);
  let lignes, format;
  try{ ({ lignes, format } = await lireEchantillonDistant(c, limite)); }
  catch(e){ return repondreErreurSource(res, e, next, c); }

  /* Les colonnes, dans l'ordre de première apparition : une ligne peut en
     omettre une (valeur absente), l'union sur tout l'échantillon les retrouve. */
  const cles = [];
  const vus = new Set();
  for(const l of lignes) for(const k of Object.keys(l || {}))
    if(!vus.has(k)){ vus.add(k); cles.push(k); }

  res.json({
    variables: cles.map(name => ({ name, type: "", label: "" })),
    lignes, lignesLues: lignes.length,
    provenance: `lecture distante (${c.kind}, ${format})`,
  });
});

/* ── Épreuve de connexion ─────────────────────────────────────────────
   « Tester cette source » : ce que l'écran affichait jusqu'ici sous ce nom
   n'appelait rien du tout — il se contentait d'un message rassurant. Voici
   l'épreuve réelle.

   Elle vise le point d'entrée le moins coûteux de chaque produit, celui qui
   valide un justificatif SANS lire de données : `/me/` chez KoboToolbox,
   `/v1/users/current` chez ODK Central. Pour les natures sans point d'entrée
   connu, elle appelle le chemin de lecture réglé — c'est le seul honnête, et un
   404 y est un renseignement utile plutôt qu'un échec d'authentification.

   `exigeAuth` dit ce qu'un succès prouve, et c'est la moitié du travail. Sur les
   deux points d'entrée connus, un 2xx prouve que le justificatif a été accepté.
   Ailleurs, il ne prouve rien : « / » sur une source dont la page d'accueil est
   publique répond 200 à un secret entièrement faux. Sans cette distinction,
   l'épreuve rendait « justificatif accepté » là où tout aperçu échouerait en 401
   — un feu vert sur le bouton dont c'est précisément la raison d'être. Un chemin
   d'épreuve choisi par l'administrateur ne prouve rien non plus, faute de savoir
   ce qu'il y a au bout : `sonder` le vérifie alors lui-même, en refaisant l'appel
   sans justificatif.

   Réservée à l'administration, comme l'aperçu et pour la même raison : elle
   déchiffre un secret et déclenche un appel sortant au nom du bureau. Elle ne
   renvoie du secret que ce que la maison s'autorise déjà — sa présence — plus sa
   longueur, qui diagnostique un copier-coller tronqué. Jamais sa valeur, jamais
   ses derniers caractères. */
const POINT_EPREUVE = {
  /* v2 : `/me/` valide le justificatif sans lire de données. v1 (MoDa) n'a pas
     d'équivalent universel ; on éprouve alors l'adresse même que le tirage vise,
     `/api/v1/data/{formId}` bornée à une ligne — un point protégé, donc un 2xx y
     prouve l'authentification ET l'existence du formulaire, ce que l'on veut au
     moment d'« enregistrer si ça marche ». */
  kobo:    (cfg) => cfg.apiVersion === "v1"
             ? ({ chemin: cfg.cheminEpreuve
                   || (cfg.formId ? `/api/v1/data/${encodeURIComponent(cfg.formId)}?limit=1` : "/api/v1/user.json"),
                  exigeAuth: !cfg.cheminEpreuve })
             : ({ chemin: cfg.cheminEpreuve || CHEMIN_EPREUVE_KOBO_DEFAUT,
                  exigeAuth: !cfg.cheminEpreuve }),
  odk:     (cfg) => ({ chemin: cfg.cheminEpreuve || CHEMIN_EPREUVE_ODK_DEFAUT,
                       exigeAuth: !cfg.cheminEpreuve }),
  /* Le gabarit `{rid}` est résolu par la fonction de lecture elle-même : l'épreuve
     doit viser l'adresse que le tirage vise, sans quoi elle éprouve une adresse
     qui ne peut pas exister et accuse ensuite le chemin réglé. */
  foundry: (cfg) => ({ chemin: cfg.cheminEpreuve
                         || (cfg.datasetRid ? cheminFoundry(cfg.chemin, cfg.datasetRid) : "/"),
                       exigeAuth: false }),
  http:    (cfg) => ({ chemin: cfg.cheminEpreuve || cfg.chemin || "/", exigeAuth: false }),
};

r.post("/connectors/:id/test", requireCap("admin"), async (req, res, next) => {
  const c = await charger(req, res); if(!c) return;
  if(!NATURES_RESEAU.has(c.kind)) return res.status(422).json({ error:
    `une source de type « ${c.kind} » ne se joint pas par le réseau : il n'y a rien à éprouver.` });

  const cfg = c.config || {};
  let porteur;
  try{ porteur = porteurDeConnecteur(c); }
  catch(e){
    return res.json({ ok:false, connecteur:{ id:c.id, name:c.name, kind:c.kind },
      etapes: [{ etape:"justificatif", ok:false, verdict:"indetermine",
        hote_verifie:false, joignable:false, code_http:null,
        schema_employe: c.auth_schema || "porteur",
        schema_libelle: SCHEMAS_AUTH[c.auth_schema || "porteur"]?.libelle || "",
        cause: e.causeAuth || "AUTH_ABSENT", message: e.message,
        indices: indicesSecret("", !!c.secret_enc), session: null }] });
  }

  const point = POINT_EPREUVE[c.kind](cfg);
  let etape;
  try{ etape = await sonder({ porteur, etape: "justificatif", ...point }); }
  catch(e){ return next(e); }

  await audit(req, "test", c.id, `Épreuve de connexion — ${c.name} : `
    + `${etape.ok ? (etape.verdict === "accepte" ? "réussie" : "sans verdict sur le justificatif")
                  : `échouée (${etape.cause || "cause non déterminée"})`}`);
  res.json({ ok: !!etape.ok, connecteur: { id: c.id, name: c.name, kind: c.kind }, etapes: [etape] });
});

/* ── Suggestions ──────────────────────────────────────────────────────
   Rapprochement de noms entre les variables de la source et les champs MEMS.

   Ce que cette route NE FAIT PAS, et c'est le point essentiel : elle n'écrit
   rien, et elle ne tranche rien. Elle rend un score et le motif du rapprochement,
   et l'humain valide. Un appariement automatique silencieux sur des noms de
   variables est exactement ce qui fait qu'un import « marche » pendant six mois
   avant qu'on découvre que la colonne « planned » alimentait « atteints ». */
r.post("/connectors/:id/suggestions", async (req, res) => {
  const c = await charger(req, res); if(!c) return;
  const parsed = z.object({
    entity: z.string().trim().min(1).max(40),
    /* Variables d'un XLSForm, telles que POST /api/xlsform/parse les rend. */
    variables: z.array(z.object({
      name: z.string().max(200),
      type: z.string().max(60).optional().nullable(),
      label: z.string().max(1000).optional().nullable(),
      structure: z.boolean().optional(),
    })).max(5000).optional(),
    /* Ou simplement les clés d'un échantillon JSON. */
    cles: z.array(z.string().max(200)).max(5000).optional(),
    echantillon: z.array(z.record(z.any())).max(50).optional(),
    seuil: z.number().min(0).max(1).default(0.45),
  }).safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "demande de suggestions invalide");
  const { entity, seuil } = parsed.data;
  if(!entite(entity)) return res.status(422).json({ error: `entité inconnue : « ${entity} »` });

  /* Les candidats, quelle que soit la façon dont on les a obtenus. Les lignes de
     structure d'un XLSForm (begin_group, note, calculate) sont écartées : ce ne
     sont pas des questions, et les garder faisait remonter un `begin_group`
     comme meilleur candidat sur GD_PREVMA (docs/A_FAIRE.md, chantier O). */
  const candidats = [];
  const vus = new Set();
  const ajouter = (name, type, label) => {
    const n = String(name || "").trim();
    if(!n || vus.has(n)) return;
    vus.add(n); candidats.push({ name: n, type: type || "", label: label || "" });
  };
  for(const v of parsed.data.variables || []){
    /* Le drapeau `structure` posé par lib/xlsform.js ne suffit pas : il n'est
       renseigné que si l'appelant nous rend la lecture du serveur telle quelle.
       Le type est donc revérifié ici, avec le MÊME motif que celui du lecteur —
       importé, non recopié. C'est précisément le défaut relevé sur l'ancien
       script d'ingestion, où un `begin_group` sortait premier candidat. */
    if(v.structure || TYPES_STRUCTURE.test(String(v.type || "").trim())) continue;
    ajouter(v.name, v.type, v.label);
  }
  for(const k of parsed.data.cles || []) ajouter(k, "", "");
  for(const ligne of parsed.data.echantillon || [])
    for(const k of Object.keys(ligne || {})) ajouter(k, "", "");

  if(!candidats.length) return res.status(422).json({ error:
    "aucune variable source à rapprocher : joignez le XLSForm, ou collez un échantillon." });

  const suggestions = champsDe(entity).map(ch => {
    const notes = candidats
      .map(cand => ({ cand, ...noter(cand, ch) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const meilleur = notes[0];
    const retenu = meilleur && meilleur.score >= seuil ? meilleur : null;
    return {
      mems_field: ch.nom,
      type: ch.type,
      obligatoire: ch.obligatoire,
      note: ch.note,
      source_path: retenu ? retenu.cand.name : null,
      transform: retenu ? retenu.transform : (TRANSFORM_PAR_TYPE[ch.type] || "brut"),
      score: retenu ? Math.round(retenu.score * 100) / 100 : 0,
      motif: retenu ? retenu.motif
        : "aucun nom de variable ne s'en approche : à renseigner à la main",
      /* Les suivants, pour que l'écran offre un choix plutôt qu'un verdict. */
      candidats: notes.slice(0, 4).map(x => ({ name: x.cand.name,
        score: Math.round(x.score * 100) / 100, motif: x.motif })),
    };
  });

  res.json({
    entity,
    applique: false,      /* dit explicitement que rien n'a été enregistré */
    variablesExaminees: candidats.length,
    seuil,
    suggestions,
  });
});

/* ── Rapprochement de noms ────────────────────────────────────────────
   Trois mesures, de la plus sûre à la plus faible, et le motif est rendu avec le
   score : un rapprochement qu'on ne peut pas expliquer ne se valide pas. */
const normaliser = (s) => String(s || "").toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/* Coefficient de Dice sur les bigrammes : « tonnage_recu » et « tonnagerecus »
   se ressemblent, « planifies » et « atteints » non. Simple, symétrique, et sans
   dépendance — une distance d'édition ne dirait pas mieux ici. */
function dice(a, b){
  if(!a || !b) return 0;
  if(a === b) return 1;
  if(a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bg = (s) => { const m = new Map();
    for(let i = 0; i < s.length - 1; i++){ const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); }
    return m; };
  const ma = bg(a), mb = bg(b);
  let communs = 0, ta = 0, tb = 0;
  for(const [g, n] of ma){ ta += n; communs += Math.min(n, mb.get(g) || 0); }
  for(const [, n] of mb) tb += n;
  return (2 * communs) / (ta + tb);
}

function noter(cand, ch){
  const nom = normaliser(cand.name);
  const cibles = [ch.nom, ...(ch.synonymes || [])].map(normaliser).filter(Boolean);
  let score = 0, motif = "";

  for(const cible of cibles){
    if(nom === cible){ score = 1; motif = `nom identique à « ${cible} »`; break; }
    if(nom.includes(cible) || cible.includes(nom)){
      const ratio = Math.min(nom.length, cible.length) / Math.max(nom.length, cible.length);
      const s = 0.6 + 0.25 * ratio;
      if(s > score){ score = s; motif = `« ${cand.name} » contient « ${cible} »`; }
      continue;
    }
    const d = dice(nom, cible) * 0.85;
    if(d > score){ score = d; motif = `nom proche de « ${cible} » (${Math.round(d * 100)} %)`; }
  }

  /* Le libellé compte moins que le nom : c'est de la prose, souvent une phrase
     entière, et un mot commun y suffirait à créer un faux rapprochement. */
  if(cand.label){
    const lab = normaliser(cand.label);
    for(const cible of cibles){
      const d = (lab.includes(cible) ? 0.55 : dice(lab, cible) * 0.5);
      if(d > score){ score = d; motif = `libellé « ${String(cand.label).slice(0, 40)} » proche de « ${cible} »`; }
    }
  }

  /* La transformation proposée découle du type du champ MEMS, et du type de la
     variable source quand on le connaît. Un geopoint ODK porte quatre nombres
     dans une seule chaîne : proposer « nombre » sur un champ lat en ferait null
     à chaque ligne, sans que personne comprenne pourquoi. */
  let transform = TRANSFORM_PAR_TYPE[ch.type] || "brut";
  const typeSource = String(cand.type || "").toLowerCase();
  if(typeSource.startsWith("geopoint") || /coord|geopoint/.test(normaliser(cand.name))){
    if(ch.nom === "lat"){ transform = "geopoint_lat"; score = Math.max(score, 0.8);
      motif = `geopoint « ${cand.name} » : latitude extraite`; }
    else if(ch.nom === "lon"){ transform = "geopoint_lon"; score = Math.max(score, 0.8);
      motif = `geopoint « ${cand.name} » : longitude extraite`; }
  }
  if(/pcode/.test(normaliser(ch.nom))) transform = "pcode";

  return { score, motif, transform };
}

export default r;
