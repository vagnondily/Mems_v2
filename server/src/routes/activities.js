import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";

/* ═══════════════════════════════════════════════════════════════════════
   Référentiel des ACTIVITÉS — configuration réelle (chantier S4 / S7).

   `activity_categories` est la liste canonique des activités du programme :
   un nom, un tag (le code — URT, SMP, NTA…), un domaine programme, un
   drapeau actif. Elle est référencée par clé étrangère depuis les sites et
   les paramètres de couverture. Jusqu'ici elle n'existait qu'au semis ; on
   lui donne sa route d'administration, sur le modèle des bureaux :

     la lecture est ouverte à tout compte — l'application a besoin des noms
     d'activité pour afficher un site, une soumission, un indicateur ;
     l'écriture demande le droit d'administration ;
     la suppression est refusée si l'activité est référencée, plutôt que
     d'accepter le ON DELETE SET NULL qui détacherait des sites en silence.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

const S = (max) => z.string().trim().max(max).optional().nullable()
  .transform(v => (v === "" ? null : v ?? null));

const schema = z.object({
  name:         z.string().trim().min(2).max(120),
  /* Le tag est le CODE de l'activité : court, en majuscules, c'est lui que
     les sources et les tables portent (activity_tag). */
  tag:          z.string().trim().min(1).max(24).transform(v => v.toUpperCase()),
  program_area: S(120),
  active:       z.boolean().default(true),
  rev:          z.number().int().min(1).optional(),
});

const audit = (req, action, id, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','activities',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, id, action, text);

/* Ce qui référence une activité par clé étrangère (category_id). Sert deux
   fois : informer l'écran, et refuser une suppression destructrice. */
const usage = (id) => ({
  sites:  db.prepare("SELECT COUNT(*) c FROM sites WHERE category_id=?").get(id).c,
  params: db.prepare("SELECT COUNT(*) c FROM coverage_params WHERE category_id=?").get(id).c,
});

const shape = (a) => ({
  id:a.id, name:a.name, tag:a.tag, program_area:a.program_area || "",
  active:!!a.active, rev:a.rev || 1, usage: usage(a.id),
});

r.get("/", (req, res) => res.json({ activities:
  db.prepare("SELECT * FROM activity_categories ORDER BY active DESC, name").all().map(shape) }));

r.post("/", requireCap("admin"), (req, res) => {
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"activité invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(db.prepare("SELECT 1 FROM activity_categories WHERE name=? COLLATE NOCASE").get(b.name))
    return res.status(409).json({ error:"une activité porte déjà ce nom" });
  const id = newId("act");
  db.prepare(`INSERT INTO activity_categories (id,name,tag,program_area,active)
              VALUES (?,?,?,?,?)`)
    .run(id, b.name, b.tag, b.program_area, b.active?1:0);
  audit(req, "create", id, `Activité créée — ${b.name} (${b.tag})`);
  res.status(201).json({ activity: shape(db.prepare("SELECT * FROM activity_categories WHERE id=?").get(id)) });
});

r.put("/:id", requireCap("admin"), (req, res) => {
  const cur = db.prepare("SELECT * FROM activity_categories WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"activité introuvable" });
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"activité invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  /* Verrouillage optimiste, comme les bureaux : on rend la valeur courante. */
  if(b.rev && b.rev !== (cur.rev || 1))
    return res.status(409).json({ error:"cette activité a été modifiée entre-temps", courant: shape(cur) });
  if(db.prepare("SELECT 1 FROM activity_categories WHERE name=? COLLATE NOCASE AND id<>?").get(b.name, cur.id))
    return res.status(409).json({ error:"une activité porte déjà ce nom" });
  db.prepare(`UPDATE activity_categories SET name=?, tag=?, program_area=?, active=?, rev=rev+1 WHERE id=?`)
    .run(b.name, b.tag, b.program_area, b.active?1:0, cur.id);
  const chg = [];
  if(b.name !== cur.name) chg.push(`renommée « ${cur.name} » → « ${b.name} »`);
  if(b.tag !== cur.tag) chg.push(`tag ${cur.tag} → ${b.tag}`);
  if(b.active !== !!cur.active) chg.push(b.active ? "réactivée" : "désactivée");
  audit(req, "update", cur.id, `Activité ${b.name}${chg.length ? ` — ${chg.join(", ")}` : " modifiée"}`);
  res.json({ activity: shape(db.prepare("SELECT * FROM activity_categories WHERE id=?").get(cur.id)) });
});

r.delete("/:id", requireCap("admin"), (req, res) => {
  const cur = db.prepare("SELECT * FROM activity_categories WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"activité introuvable" });
  const u = usage(cur.id);
  const total = u.sites + u.params;
  /* Le schéma détacherait les lignes (ON DELETE SET NULL) : des sites sans
     activité, invisibles des filtres par activité. On refuse et on propose la
     désactivation, qui conserve l'historique et le rattachement. */
  if(total) return res.status(409).json({
    error:"cette activité est encore référencée ; désactivez-la plutôt que de la supprimer", usage:u });
  db.prepare("DELETE FROM activity_categories WHERE id=?").run(cur.id);
  audit(req, "delete", cur.id, `Activité supprimée — ${cur.name}`);
  res.json({ ok:true });
});

export default r;
