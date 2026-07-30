import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db.js";
import { can } from "../lib/auth.js";
import { config } from "../config.js";
import { currentVersion } from "../lib/geo.js";
import { KINDS, buildTemplate, readUpload, analyse, saveBatch, readBatch,
         commitBatch, scopeFor } from "../lib/import.js";

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
   d'erreurs d'un import fait à la main. */
r.get("/:kind/template", async (req, res, next) => {
  const def = defOf(req.params.kind);
  if(!def) return res.status(404).json({ error:"type d'import inconnu" });
  if(!can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def.cap} » requis` });

  const v = currentVersion();
  if(!v) return res.status(409).json({
    error:"aucun référentiel géographique courant : chargez un millésime avant d'importer" });

  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
  }).safeParse(req.query);
  const year = q.success ? q.data.year : new Date().getFullYear();

  const { units } = scopeFor(req.user);
  if(!units.length) return res.status(409).json({
    error:"aucune unité dans votre périmètre : rattachez d'abord vos sites au référentiel" });

  const tags = db.prepare(
    "SELECT DISTINCT tag FROM activity_categories WHERE tag<>'' ORDER BY tag").all().map(x=>x.tag);
  const officeLabel = req.user.office_id
    ? db.prepare("SELECT name FROM offices WHERE id=?").get(req.user.office_id)?.name
    : "tous les bureaux";

  try{
    const wb = await buildTemplate(req.params.kind,
      { year, units, tags, versionId:v.id, officeLabel, officeId:req.user.office_id });
    const nom = `mems_${req.params.kind}_${year}.xlsx`;
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

    const v = currentVersion();
    if(!v) return res.status(409).json({ error:"aucun référentiel géographique courant" });

    try{
      const { meta, rows } = await readUpload(req.params.kind, req.file.buffer);

      /* Un modèle issu d'un autre type ou d'un autre millésime est refusé net :
         importé de travers, il rattacherait des chiffres aux mauvaises unités. */
      if(meta.kind && meta.kind !== req.params.kind)
        return res.status(422).json({ error:
          `ce fichier est un modèle « ${meta.kind} », pas « ${req.params.kind} »` });
      if(meta.geoVersion && meta.geoVersion !== v.id)
        return res.status(409).json({ error:
          "ce modèle a été produit avec un autre millésime du référentiel. "
          + "Téléchargez un modèle à jour : les p-codes ont pu changer.",
          details:[{ champ:"millésime", message:`fichier ${meta.geoVersion} · courant ${v.id}` }] });

      if(!rows.length) return res.status(422).json({
        error:"aucune ligne exploitable : les lignes doivent porter un p-code" });

      const { scope } = scopeFor(req.user);
      const { rows:analysees, vides } = analyse(req.params.kind, rows, { scope });
      const { id, summary } = saveBatch({ kind:req.params.kind, user:req.user,
        filename:req.file.originalname, rows:analysees });

      /* On renvoie un aperçu borné : le lot entier est relisible par son identifiant. */
      const echantillon = (action, n) => analysees.filter(x => x.action === action).slice(0, n)
        .map(x => ({ ligne:x.line, message:x.message || null, champ:x.field || null,
          unite: x.payload?.adm3 || x.payload?.geo_pcode }));

      res.json({ batch:id, fichier:req.file.originalname, lignes:rows.length,
        resume:{ ...summary, vides },
        apercu: { crees:echantillon("create", 8), modifies:echantillon("update", 8) },
        rejets: echantillon("reject", 20),
        /* Rien n'est écrit à ce stade : c'est le point de tout le dispositif. */
        message: summary.crees + summary.modifies > 0
          ? `Rien n'a encore été enregistré. Confirmez pour appliquer ${summary.crees + summary.modifies} ligne(s).`
          : "Rien à appliquer : aucune ligne ne change." });
    }catch(e){
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
r.get("/batches/:id", (req, res) => {
  const b = readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  /* Un lot n'est visible que par son auteur, ou par un administrateur. */
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  res.json({ ...b, rows: b.rows.slice(0, 500), tronque: b.rows.length > 500 });
});

r.get("/batches", (req, res) => {
  const mine = can(req.user, "admin") ? "" : "WHERE user_id=?";
  const rows = db.prepare(`SELECT id,kind,user_label,filename,created_at,status,committed_at,summary
    FROM import_batch ${mine} ORDER BY created_at DESC LIMIT 40`)
    .all(...(mine ? [req.user.id] : []));
  res.json({ rows: rows.map(b => ({ ...b, summary: JSON.parse(b.summary || "{}") })) });
});

/* ── ③ La confirmation : une transaction ───────────────────────────── */
r.post("/batches/:id/commit", (req, res, next) => {
  const b = readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  const def = defOf(b.kind);
  if(!def || !can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def?.cap || "edit"} » requis` });

  /* Verrou consultatif : deux confirmations du même type et du même périmètre
     s'enchaînent au lieu de s'entrelacer. */
  const scope = `${b.kind}:${req.user.office_id || "global"}`;
  try{
    db.prepare("INSERT INTO import_lock (scope,batch_id) VALUES (?,?)").run(scope, b.id);
  }catch(e){
    const held = db.prepare("SELECT * FROM import_lock WHERE scope=?").get(scope);
    /* Un verrou de plus de cinq minutes est un reste d'incident : on le reprend. */
    if(held && (Date.now() - new Date(held.taken_at + "Z").getTime()) > 5*60_000)
      db.prepare("UPDATE import_lock SET batch_id=?, taken_at=datetime('now') WHERE scope=?")
        .run(b.id, scope);
    else return res.status(409).json({
      error:"un autre import du même type est en cours pour votre périmètre ; réessayez dans un instant" });
  }
  try{
    const out = commitBatch(req.params.id, req.user);
    if(out.error) return res.status(out.status || 409).json({ error:out.error });
    res.json(out);
  }catch(e){ next(e); }
  finally{ db.prepare("DELETE FROM import_lock WHERE scope=?").run(scope); }
});

r.post("/batches/:id/cancel", (req, res) => {
  const b = readBatch(req.params.id);
  if(!b) return res.status(404).json({ error:"lot introuvable" });
  if(b.user_id !== req.user.id && !can(req.user, "admin"))
    return res.status(403).json({ error:"ce lot appartient à un autre utilisateur" });
  if(b.status === "committed") return res.status(409).json({ error:"ce lot a déjà été appliqué" });
  db.prepare("UPDATE import_batch SET status='cancelled' WHERE id=?").run(b.id);
  res.json({ ok:true });
});

export default r;
