import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId, encrypt, decrypt } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { log } from "../lib/logger.js";
import { champ, champsObligatoires, champs as champsDe, entite, entites,
         registrePublic, TRANSFORM_PAR_TYPE } from "../lib/champs.js";
import { appliquerLot, NOMS_TRANSFORMATIONS, transformationsPubliques } from "../lib/mapping.js";
import { lireDatasetFoundry, lireJsonHttp } from "../lib/foundry.js";
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

const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

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
const shape = (c) => ({
  id: c.id, name: c.name, kind: c.kind, base_url: c.base_url || "",
  config: J(c.config, {}),
  hasSecret: !!c.secret_enc,
  office_id: c.office_id || null,
  active: !!c.active,
  created_at: c.created_at, updated_at: c.updated_at, rev: c.rev || 1,
  mappings: db.prepare("SELECT COUNT(*) c FROM connector_mapping WHERE connector_id=?").get(c.id).c,
});

const audit = (req, action, id, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'connecteur','connector',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, id, action, texte);

/* Charge un connecteur en appliquant le cloisonnement, ou répond et rend null.
   Le même chemin sert à la lecture et à l'écriture : deux contrôles distincts
   finiraient par ne plus dire la même chose. */
function charger(req, res){
  const c = db.prepare("SELECT * FROM connector WHERE id=?").get(req.params.id);
  if(!c){ res.status(404).json({ error: "connecteur introuvable" }); return null; }
  const bureau = officeBound(req.user);
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
  });
});

/* ── Liste ────────────────────────────────────────────────────────────
   Cloisonnée comme le reste : un compte borné à un bureau ne voit que les
   connecteurs de son bureau. Les connecteurs sans bureau (portée nationale) ne
   lui sont pas montrés non plus — c'est la règle déjà appliquée à l'écriture des
   collections, où une ligne sans bureau est « ailleurs ». */
r.get("/connectors", (req, res) => {
  const bureau = officeBound(req.user);
  const rows = bureau
    ? db.prepare("SELECT * FROM connector WHERE office_id=? ORDER BY name").all(bureau)
    : db.prepare("SELECT * FROM connector ORDER BY name").all();
  res.json({ rows: rows.map(shape) });
});

r.post("/connectors", requireCap("admin"), (req, res, next) => {
  const parsed = schemaConnecteur.safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "connecteur invalide");
  const d = parsed.data;

  const probleme = verifierConfig(d);
  if(probleme) return res.status(422).json({ error: probleme });

  const id = newId("conn");
  try{
    db.prepare(`INSERT INTO connector (id,name,kind,base_url,config,secret_enc,office_id,active)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, d.name, d.kind, d.base_url, JSON.stringify(d.config),
           d.secret ? encrypt(d.secret) : null, d.office_id, d.active ? 1 : 0);
  }catch(e){
    if(/FOREIGN KEY/.test(e.message))
      return res.status(409).json({ error: "bureau inconnu : le connecteur n'a pas été créé" });
    return next(e);
  }
  audit(req, "create", id, `Connecteur créé — ${d.name} (${d.kind})`);
  res.status(201).json({ connector: shape(db.prepare("SELECT * FROM connector WHERE id=?").get(id)) });
});

r.put("/connectors/:id", requireCap("admin"), (req, res, next) => {
  const c = charger(req, res); if(!c) return;
  const parsed = schemaConnecteur.safeParse(req.body);
  if(!parsed.success) return invalide(res, parsed, "connecteur invalide");
  const d = parsed.data;

  const probleme = verifierConfig(d);
  if(probleme) return res.status(422).json({ error: probleme });

  if(d.rev !== undefined && d.rev !== c.rev)
    return res.status(409).json({
      error: "ce connecteur a été modifié pendant votre saisie. Rechargez pour repartir de la version à jour.",
      courant: shape(c) });

  try{
    db.prepare(`UPDATE connector SET name=?, kind=?, base_url=?, config=?, office_id=?, active=?,
                  ${d.secret ? "secret_enc=?," : ""} updated_at=datetime('now'), rev=rev+1
                WHERE id=?`)
      .run(d.name, d.kind, d.base_url, JSON.stringify(d.config), d.office_id, d.active ? 1 : 0,
           ...(d.secret ? [encrypt(d.secret)] : []), c.id);
  }catch(e){
    if(/FOREIGN KEY/.test(e.message))
      return res.status(409).json({ error: "bureau inconnu : le connecteur n'a pas été modifié" });
    return next(e);
  }
  audit(req, "update", c.id, `Connecteur modifié — ${d.name} (${d.kind})`);
  res.json({ connector: shape(db.prepare("SELECT * FROM connector WHERE id=?").get(c.id)) });
});

r.delete("/connectors/:id", requireCap("admin"), (req, res) => {
  const c = charger(req, res); if(!c) return;
  /* Les correspondances partent avec le connecteur (ON DELETE CASCADE,
     migration 016) : elles n'ont aucun sens sans lui. */
  const n = db.prepare("SELECT COUNT(*) c FROM connector_mapping WHERE connector_id=?").get(c.id).c;
  db.prepare("DELETE FROM connector WHERE id=?").run(c.id);
  audit(req, "delete", c.id, `Connecteur supprimé — ${c.name} (${n} correspondance(s) emportée(s))`);
  res.json({ ok: true, mappingsSupprimees: n });
});

/* Contrôles qui dépendent de la nature de la source, donc hors de portée de zod. */
function verifierConfig(d){
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
  return null;
}

/* ── Correspondances ──────────────────────────────────────────────────── */

r.get("/connectors/:id/mappings", (req, res) => {
  const c = charger(req, res); if(!c) return;
  const rows = db.prepare(
    `SELECT * FROM connector_mapping WHERE connector_id=?
      ${req.query.entity ? "AND entity=?" : ""} ORDER BY entity, position, mems_field`)
    .all(...(req.query.entity ? [c.id, String(req.query.entity)] : [c.id]));
  res.json({
    connector: shape(c),
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
r.put("/connectors/:id/mappings", requireCap("admin"), (req, res, next) => {
  const c = charger(req, res); if(!c) return;
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
    tx(() => {
      if(entity) db.prepare("DELETE FROM connector_mapping WHERE connector_id=? AND entity=?")
        .run(c.id, entity);
      else db.prepare("DELETE FROM connector_mapping WHERE connector_id=?").run(c.id);
      const ins = db.prepare(`INSERT INTO connector_mapping
        (id,connector_id,entity,mems_field,source_path,transform,required,default_value,note,position)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      mappings.forEach((m, i) => ins.run(newId("cmap"), c.id, m.entity, m.mems_field,
        m.source_path, m.transform, m.required ? 1 : 0, m.default_value, m.note,
        m.position ?? i));
      db.prepare("UPDATE connector SET updated_at=datetime('now') WHERE id=?").run(c.id);
    })();
  }catch(e){ return next(e); }

  audit(req, "mappings", c.id,
    `Correspondances enregistrées — ${c.name}${entity ? ` / ${entity}` : ""} : ${mappings.length} ligne(s)`);
  const rows = db.prepare(
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
  const c = charger(req, res); if(!c) return;
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
  const entitesEnregistrees = db.prepare(
    "SELECT DISTINCT entity FROM connector_mapping WHERE connector_id=?").all(c.id).map(x => x.entity);
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
    mappings = db.prepare(`SELECT * FROM connector_mapping WHERE connector_id=? AND entity=?
                           ORDER BY position, mems_field`).all(c.id, entityDemandee);
  }

  /* La source des lignes : ce qui a été collé, ou une lecture distante pour les
     natures qui savent aller chercher. Pour ODK, le tirage a déjà son écran et
     son cache (odk_forms.raw) : le dupliquer ici ferait un second chemin
     d'appel sortant à sécuriser, pour rien. */
  let lignes = echantillon.slice(0, limite);
  let provenance = "échantillon fourni";
  if(!lignes.length){
    if(c.kind === "foundry" || c.kind === "http"){
      try{
        const cfg = J(c.config, {});
        const jeton = c.secret_enc ? decrypt(c.secret_enc) : null;
        const lu = c.kind === "foundry"
          ? await lireDatasetFoundry({ baseUrl: c.base_url, datasetRid: cfg.datasetRid,
              token: jeton, branche: cfg.branche || cfg.branchName || "master",
              limite, format: cfg.format || "CSV", chemin: cfg.chemin, pointeur: cfg.pointeur })
          : await lireJsonHttp({ baseUrl: c.base_url, chemin: cfg.chemin, token: jeton,
              pointeur: cfg.pointeur, limite });
        lignes = (lu.rows || []).slice(0, limite);
        provenance = `lecture distante (${c.kind}, ${lu.format})`;
      }catch(e){
        if(e.code === "SOURCE_URL" || e.code === "SOURCE_CONFIG" || e.code === "SOURCE_AUTH"
           || e.code === "SOURCE_NOT_FOUND")
          return res.status(422).json({ error: e.message });
        if(e.code === "SOURCE_NETWORK" || e.code === "SOURCE_HTTP"){
          log.warn("lecture de source en échec", { connecteur: c.id, kind: c.kind, code: e.code });
          return res.status(502).json({ error:
            "la source n'a pas répondu correctement : vérifiez l'adresse, le jeton et la connectivité." });
        }
        return next(e);
      }
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

/* ── Suggestions ──────────────────────────────────────────────────────
   Rapprochement de noms entre les variables de la source et les champs MEMS.

   Ce que cette route NE FAIT PAS, et c'est le point essentiel : elle n'écrit
   rien, et elle ne tranche rien. Elle rend un score et le motif du rapprochement,
   et l'humain valide. Un appariement automatique silencieux sur des noms de
   variables est exactement ce qui fait qu'un import « marche » pendant six mois
   avant qu'on découvre que la colonne « planned » alimentait « atteints ». */
r.post("/connectors/:id/suggestions", (req, res) => {
  const c = charger(req, res); if(!c) return;
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
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");

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
