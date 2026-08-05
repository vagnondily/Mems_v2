import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db.js";
import { can } from "../lib/auth.js";
import { config } from "../config.js";
import { currentVersion } from "../lib/geo.js";
import { KINDS, buildTemplate, readUpload, analyse, saveBatch, readBatch,
         commitBatch, scopeFor } from "../lib/import.js";
import { MOTIF_SOURCE_RESERVEE, estSourceReservee } from "../lib/alias.js";

const r = Router();

/* Le fichier reste en mémoire : rien n'est écrit sur le disque du serveur, donc
   rien à nettoyer et aucune trace en cas d'incident. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxBodyMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname)
      || file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    cb(ok ? null : new Error("Format attendu : .xlsx"), ok);
  },
});

const defOf = (name) => KINDS[name] || null;

r.get("/kinds", (req, res) => {
  res.json({ rows: Object.entries(KINDS).map(([id, d]) => ({
    id, label:d.label, cap:d.cap, autorise: can(req.user, d.cap),
    colonnes: d.columns.map(c => ({ header:c.header, cle:!!c.key, verrouillee:!!c.locked,
      valeurs:c.enum || null, aide:c.hint || null })) })) });
});

/* ── ① Le modèle ─────────────────────────────────────────────────────
   Pré-rempli avec les lignes du périmètre de l'utilisateur : il remplit des
   cases, il ne saisit pas de clés. C'est ce qui supprime la première source
   d'erreurs d'un import fait à la main.

   Les deux refus géographiques ci-dessous ne s'appliquent qu'aux types de portée
   « geo ». Exiger un millésime chargé et une unité dans le périmètre pour
   produire le modèle d'un référentiel de codes serait inventer une condition :
   ces codes n'appartiennent à aucun découpage administratif — c'est précisément
   pour cela qu'ils ont leur propre table. */
r.get("/:kind/template", async (req, res, next) => {
  const def = defOf(req.params.kind);
  if(!def) return res.status(404).json({ error:"type d'import inconnu" });
  if(!can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def.cap} » requis` });
  const geo = def.portee === "geo";

  const v = currentVersion();
  if(geo && !v) return res.status(409).json({
    error:"aucun référentiel géographique courant : chargez un millésime avant d'importer" });

  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    /* La constante de lot d'un type national. Validée ici comme n'importe quelle
       entrée : c'est elle qui deviendra la moitié de la clé métier — et la
       `source` des alias posés au rapprochement, d'où le nom réservé. */
    referentiel: z.string().trim().min(1).max(60)
      .refine(v => !estSourceReservee(v), MOTIF_SOURCE_RESERVEE).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({
    error: q.error.issues[0]?.message || "paramètres de modèle invalides" });
  const year = q.data.year;
  const referentiel = q.data.referentiel;

  const officeLabel = req.user.office_id
    ? (await db.prepare("SELECT name FROM offices WHERE id=?").get(req.user.office_id))?.name
    : "tous les bureaux";

  let ctx;
  if(geo){
    const { units } = await scopeFor(req.user);
    if(!units.length) return res.status(409).json({
      error:"aucune unité dans votre périmètre : rattachez d'abord vos sites au référentiel" });
    const tags = (await db.prepare(
      "SELECT DISTINCT tag FROM activity_categories WHERE tag<>'' ORDER BY tag").all()).map(x=>x.tag);
    ctx = { year, units, tags, versionId:v.id, officeLabel, officeId:req.user.office_id };
  } else {
    if(!referentiel) return res.status(422).json({
      error:"précisez le référentiel à charger (paramètre « referentiel ») : c'est lui qui "
        + "nomme la liste et qui forme, avec le code, la clé de chaque entrée" });
    ctx = { referentiel, officeLabel };
  }

  try{
    const wb = await buildTemplate(req.params.kind, ctx);
    const nom = geo
      ? `mems_${req.params.kind}_${year}.xlsx`
      : `mems_${req.params.kind}_${referentiel.replace(/[^\w.-]+/g, "_")}.xlsx`;
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nom}"`);
    await wb.xlsx.write(res);
    res.end();
  }catch(e){ next(e); }
});

/* ── ② Le téléversement : analyse et prévisualisation, rien n'est écrit ── */
r.post("/:kind", (req, res, next) => {
  upload.single("file")(req, res, async (err) => {
    if(err) return res.status(422).json({ error: err.message });
    const def = defOf(req.params.kind);
    if(!def) return res.status(404).json({ error:"type d'import inconnu" });
    if(!can(req.user, def.cap))
      return res.status(403).json({ error:`droit « ${def.cap} » requis` });
    if(!req.file) return res.status(422).json({ error:"aucun fichier reçu" });
    const geo = def.portee === "geo";

    const v = currentVersion();
    if(geo && !v) return res.status(409).json({ error:"aucun référentiel géographique courant" });

    try{
      const { meta, rows, absentes } = await readUpload(req.params.kind, req.file.buffer);

      /* Un modèle issu d'un autre type ou d'un autre millésime est refusé net :
         importé de travers, il rattacherait des chiffres aux mauvaises unités. */
      if(meta.kind && meta.kind !== req.params.kind)
        return res.status(422).json({ error:
          `ce fichier est un modèle « ${meta.kind} », pas « ${req.params.kind} »` });
      /* Le contrôle de millésime se garde tout seul : `buildTemplate` écrit une
         chaîne vide pour un type national, donc la condition est fausse et rien
         n'est comparé. */
      if(meta.geoVersion && meta.geoVersion !== v?.id)
        return res.status(409).json({ error:
          "ce modèle a été produit avec un autre millésime du référentiel. "
          + "Téléchargez un modèle à jour : les p-codes ont pu changer.",
          details:[{ champ:"millésime", message:`fichier ${meta.geoVersion} · courant ${v?.id}` }] });

      if(!rows.length) return res.status(422).json({
        error:"aucune ligne exploitable : les lignes doivent porter une valeur en colonne "
          + `« ${def.columns.find(c => c.key)?.header || "clé"} »` });

      /* `scopeFor` n'est pas appelé du tout pour un type national : sur une
         installation sans millésime il rendrait un périmètre VIDE pour un compte
         borné, et ce Set vide rejetterait toutes les lignes si jamais la garde de
         portée venait à manquer ailleurs. */
      const { scope } = geo ? await scopeFor(req.user) : { scope:null };
      const { rows:analysees, vides } = await analyse(req.params.kind, rows,
        { scope, referentiel: meta.referentiel || null, absentes });
      const { id, summary } = await saveBatch({ kind:req.params.kind, user:req.user,
        filename:req.file.originalname, rows:analysees, absentes });

      /* On renvoie un aperçu borné : le lot entier est relisible par son identifiant. */
      const echantillon = (action, n) => analysees.filter(x => x.action === action).slice(0, n)
        .map(x => ({ ligne:x.line, message:x.message || null, champ:x.field || null,
          /* Ce qui identifie la ligne pour l'œil. Un type non géographique le dit
             lui-même, sans quoi la colonne resterait vide devant vingt motifs. */
          unite: def.designation ? def.designation(x.payload)
                                 : (x.payload?.adm3 || x.payload?.geo_pcode) }));

      /* Ce que le fichier ne porte pas est annoncé AVANT la confirmation : une
         colonne absente n'est ni comparée ni écrite, et l'opérateur doit savoir
         que ces valeurs restent celles d'aujourd'hui plutôt que de le déduire
         d'un aperçu muet. */
      const colonnesAbsentes = absentes
        .map(f => def.columns.find(c => c.field === f)?.header).filter(Boolean);
      res.json({ batch:id, fichier:req.file.originalname, lignes:rows.length,
        resume:{ ...summary, vides },
        colonnesAbsentes,
        apercu: { crees:echantillon("create", 8), modifies:echantillon("update", 8) },
        rejets: echantillon("reject", 20),
        /* Rien n'est écrit à ce stade : c'est le point de tout le dispositif. */
        message: (summary.crees + summary.modifies > 0
          ? `Rien n'a encore été enregistré. Confirmez pour appliquer ${summary.crees + summary.modifies} ligne(s).`
          : "Rien à appliquer : aucune ligne ne change.")
          + (colonnesAbsentes.length
            ? ` Le fichier ne porte pas la ou les colonnes « ${colonnesAbsentes.join(" », « ")} » : `
              + "elles ne sont ni comparées ni modifiées."
            : "") });
    }catch(e){
      /* Archive refusée avant décompression (entrée étrangère au format, ou taille
         inflatée disproportionnée) : c'est un fichier fautif, pas une panne — et son
         motif exact doit remonter à l'utilisateur, qui seul peut le corriger. */
      if(e.code === "ARCHIVE") return res.status(422).json({ error:e.message });
      if(/zip|corrupt|End of (central|data)/i.test(e.message))
        return res.status(422).json({ error:"fichier illisible : est-ce bien un .xlsx ?" });
      if(e.code === "WRONG_KIND") return res.status(422).json({ error:e.message });
      if(/Colonnes de clé|feuille/.test(e.message))
        return res.status(422).json({ error:e.message });
      next(e);
    }
  });
});

/* ── Relire un lot ─────────────────────────────────────────────────── */
r.get("/batches/:id", async (req, res) => {
  const b = await readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  /* Un lot n'est visible que par son auteur, ou par un administrateur. */
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  res.json({ ...b, rows: b.rows.slice(0, 500), tronque: b.rows.length > 500 });
});

r.get("/batches", async (req, res) => {
  const mine = can(req.user, "admin") ? "" : "WHERE user_id=?";
  const rows = await db.prepare(`SELECT id,kind,user_label,filename,created_at,status,committed_at,summary
    FROM import_batch ${mine} ORDER BY created_at DESC LIMIT 40`)
    .all(...(mine ? [req.user.id] : []));
  /* TODO-PG: `summary` reste lu ici comme du TEXT JSON (JSON.parse), conformément
     à la liste des colonnes jsonb communiquée pour ce portage (connector.config,
     mre_activity.months — import_batch.summary n'y figure pas). À vérifier contre
     le schéma Postgres réel : si cette colonne a été déclarée jsonb, le
     JSON.parse doit être retiré (pg la rend déjà en objet). Voir la même remarque
     sur lib/import.js:readBatch, qui lit la même colonne. */
  /* `summary` est jsonb : pg la rend déjà en objet, aucun JSON.parse. */
  res.json({ rows: rows.map(b => ({ ...b, summary: b.summary ?? {} })) });
});

/* ── ③ La confirmation : une transaction ───────────────────────────── */
r.post("/batches/:id/commit", async (req, res, next) => {
  const b = await readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  const def = defOf(b.kind);
  if(!def || !can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def?.cap || "edit"} » requis` });

  /* Verrou consultatif : deux confirmations du même type et du même périmètre
     s'enchaînent au lieu de s'entrelacer.

     Un type national n'a pas de périmètre, donc pas de verrou par bureau : deux
     administrateurs de bureaux différents obtiendraient deux verrous distincts et
     confirmeraient en même temps sur la MÊME table. L'upsert resterait sûr, mais
     le diff que chacun a vu à l'aperçu ne décrirait plus ce qui s'est passé. */
  const scope = def.portee === "national"
    ? `${b.kind}:global`
    : `${b.kind}:${req.user.office_id || "global"}`;
  try{
    await db.prepare("INSERT INTO import_lock (scope,batch_id) VALUES (?,?)").run(scope, b.id);
  }catch(e){
    const held = await db.prepare("SELECT * FROM import_lock WHERE scope=?").get(scope);
    /* Un verrou de plus de cinq minutes est un reste d'incident : on le reprend. */
    if(held && (Date.now() - new Date(held.taken_at + "Z").getTime()) > 5*60_000)
      await db.prepare("UPDATE import_lock SET batch_id=?, taken_at=now() WHERE scope=?")
        .run(b.id, scope);
    else return res.status(409).json({
      error:"un autre import du même type est en cours pour votre périmètre ; réessayez dans un instant" });
  }
  try{
    const out = await commitBatch(req.params.id, req.user);
    if(out.error) return res.status(out.status || 409).json({ error:out.error });
    res.json(out);
  }catch(e){ next(e); }
  finally{ await db.prepare("DELETE FROM import_lock WHERE scope=?").run(scope); }
});

r.post("/batches/:id/cancel", async (req, res) => {
  const b = await readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  if(b.status === "committed") return res.status(409).json({ error:"ce lot a déjà été appliqué" });
  await db.prepare("UPDATE import_batch SET status='cancelled' WHERE id=?").run(b.id);
  res.json({ ok:true });
});

export default r;
