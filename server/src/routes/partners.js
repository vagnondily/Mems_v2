import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { countryBound, countryClause } from "../lib/scope.js";
import { writeCountry } from "../lib/country.js";

/* ═══════════════════════════════════════════════════════════════════════
   Partenaires d'exécution.

   Ils étaient une liste de noms dans l'écran de configuration, dérivée de la table à
   chaque chargement et jamais renvoyée au serveur : la saisie était perdue au
   rechargement, sans un message. Le même défaut que les bureaux avant leur écran
   propre, et pour la même raison — une entité référencée par d'autres tables ne se
   modifie pas par écrasement d'une liste de chaînes.

   Un partenaire est référencé par les SITES (qui l'exécute sur place) et par le PLAN
   DE DISTRIBUTION (qui distribue dans cette commune, ce mois-là). C'est ce qui rend
   sa suppression dangereuse : le schéma détacherait les lignes en silence.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();
const S = (max) => z.string().trim().max(max).nullish().transform(v => (v ? v : null));

export const KINDS = {
  ong_nationale:     "ONG nationale",
  ong_internationale:"ONG internationale",
  gouvernement:      "Service de l'État",
  agence_onu:        "Agence des Nations unies",
  communautaire:     "Organisation communautaire",
  prive:             "Prestataire privé",
};

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  code: S(24), kind: z.enum(Object.keys(KINDS)).nullish().transform(v => v ?? null),
  contact:S(120), email:S(160), phone:S(40),
  agreement:S(80), start_date:S(10), end_date:S(10), note:S(600),
  office_id:S(64),
  country_code: z.string().trim().length(3).nullish().transform(v => (v ? v.toUpperCase() : null)),
  active: z.boolean().default(true),
  rev: z.coerce.number().int().min(1).optional(),
});

/* Ce qui référence un partenaire. Sert deux fois : à montrer son poids réel dans
   l'écran de configuration, et à refuser une suppression destructrice. */
const usage = (id) => ({
  sites: db.prepare("SELECT COUNT(*) c FROM sites WHERE partner_id=?").get(id).c,
  pdd:   db.prepare("SELECT COUNT(*) c FROM pdd WHERE partner_id=?").get(id).c,
});

const shape = (p) => ({
  id:p.id, name:p.name, code:p.code || "", kind:p.kind || null,
  kindLabel: KINDS[p.kind] || "", contact:p.contact || "", email:p.email || "",
  phone:p.phone || "", agreement:p.agreement || "", start_date:p.start_date || "",
  end_date:p.end_date || "", note:p.note || "", office_id:p.office_id || null,
  office:p.office_name || "", country_code:p.country_code || null,
  active:!!p.active, rev:p.rev || 1, usage: usage(p.id),
});

const lire = (id) => db.prepare(
  `SELECT p.*, o.name office_name FROM partners p
   LEFT JOIN offices o ON o.id = p.office_id WHERE p.id=?`).get(id);

/* Hors de son pays, un partenaire est introuvable et non refusé : même règle que
   partout ailleurs — un refus confirmerait son existence. */
const visible = (req, id) => {
  const p = lire(id);
  if(!p) return null;
  const pays = countryBound(req.user);
  return (pays && p.country_code && p.country_code !== pays) ? null : p;
};

const audit = (req, action, id, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','partners',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, id, action, text);

r.get("/", (req, res) => {
  const c = countryClause(req.user, "p");
  res.json({ rows: db.prepare(
    `SELECT p.*, o.name office_name FROM partners p
     LEFT JOIN offices o ON o.id = p.office_id
     WHERE 1=1 ${c.sql} ORDER BY p.active DESC, p.name`).all(...c.args).map(shape),
    referentiel: { kinds:KINDS } });
});

r.post("/", requireCap("admin"), (req, res) => {
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"partenaire invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  const pays = writeCountry(req.user, b.country_code);
  if(pays.error) return res.status(422).json({ error:pays.error });
  if(db.prepare("SELECT 1 FROM partners WHERE name=? COLLATE NOCASE").get(b.name))
    return res.status(409).json({ error:"un partenaire porte déjà ce nom" });
  if(b.start_date && b.end_date && b.end_date < b.start_date)
    return res.status(422).json({ error:"la date de fin précède la date de début" });

  const id = newId("part");
  db.prepare(`INSERT INTO partners (id,name,code,kind,contact,email,phone,agreement,start_date,
              end_date,note,office_id,country_code,active,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, b.name, b.code, b.kind, b.contact, b.email, b.phone, b.agreement, b.start_date,
         b.end_date, b.note, b.office_id, pays.code, b.active ? 1 : 0);
  audit(req, "create", id, `Partenaire d'exécution créé — ${b.name}`);
  res.status(201).json({ partner: shape(lire(id)) });
});

r.put("/:id", requireCap("admin"), (req, res) => {
  const cur = visible(req, req.params.id);
  if(!cur) return res.status(404).json({ error:"partenaire introuvable" });
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"partenaire invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(b.rev && b.rev !== (cur.rev || 1))
    return res.status(409).json({ error:"ce partenaire a été modifié entre-temps",
      courant: shape(lire(cur.id)) });
  if(db.prepare("SELECT 1 FROM partners WHERE name=? COLLATE NOCASE AND id<>?").get(b.name, cur.id))
    return res.status(409).json({ error:"un partenaire porte déjà ce nom" });

  db.prepare(`UPDATE partners SET name=?, code=?, kind=?, contact=?, email=?, phone=?,
              agreement=?, start_date=?, end_date=?, note=?, office_id=?, active=?,
              rev=rev+1, updated_at=datetime('now') WHERE id=?`)
    .run(b.name, b.code, b.kind, b.contact, b.email, b.phone, b.agreement, b.start_date,
         b.end_date, b.note, b.office_id, b.active ? 1 : 0, cur.id);
  audit(req, "update", cur.id, `Partenaire ${b.name}` +
    (b.name !== cur.name ? ` — renommé depuis « ${cur.name} »` : " modifié"));
  res.json({ partner: shape(lire(cur.id)) });
});

r.delete("/:id", requireCap("admin"), (req, res) => {
  const cur = visible(req, req.params.id);
  if(!cur) return res.status(404).json({ error:"partenaire introuvable" });
  const u = usage(cur.id);
  /* Le schéma détacherait les lignes (ON DELETE SET NULL) : des sites et des lignes
     de distribution sans partenaire, invisibles de tous les filtres. On refuse et on
     propose la désactivation, qui conserve l'historique. */
  if(u.sites || u.pdd) return res.status(409).json({
    error:"ce partenaire est référencé ; désactivez-le plutôt que de le supprimer", usage:u });
  db.prepare("DELETE FROM partners WHERE id=?").run(cur.id);
  audit(req, "delete", cur.id, `Partenaire supprimé — ${cur.name}`);
  res.json({ ok:true });
});

export default r;
