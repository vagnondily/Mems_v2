import { Router } from "express";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { hashPassword, passwordProblems } from "../lib/auth.js";

const r = Router();
const shape = (u) => ({ id:u.id, email:u.email, first_name:u.first_name, last_name:u.last_name,
  title:u.title, office_id:u.office_id, tpm_id:u.tpm_id || null, role:u.role,
  tabs:JSON.parse(u.tabs||"[]"), active:!!u.active, last_login:u.last_login });

/* Un compte de prestataire n'administre pas l'application. Il est déjà borné à son
   prestataire par lib/scope.js, mais le droit d'administration lui donnerait la
   gestion des comptes et des bureaux — ce que le cloisonnement ne couvre pas.
   Refuser ici est la seule barrière qui tienne. */
function tpmInterdit(b){
  if(b.tpm_id && (b.role === "admin" || b.role === "super"))
    return "un compte rattaché à un prestataire ne peut pas être administrateur";
  if(b.tpm_id && b.office_id)
    return "un compte de prestataire n'est pas rattaché à un bureau : choisissez l'un ou l'autre";
  return null;
}

r.use(requireCap("admin"));

r.get("/", (req, res) => res.json({ users:
  db.prepare("SELECT * FROM users ORDER BY first_name").all().map(shape) }));

r.post("/", validate(schemas.user), async (req, res) => {
  const b = req.body;
  if(!b.password) return res.status(422).json({ error:"un mot de passe initial est requis" });
  const problems = passwordProblems(b.password);
  if(problems.length) return res.status(422).json({
    error:"le mot de passe doit contenir " + problems.join(", ") });
  if(db.prepare("SELECT 1 FROM users WHERE email=?").get(b.email))
    return res.status(409).json({ error:"cette adresse est déjà utilisée" });
  const interdit = tpmInterdit(b);
  if(interdit) return res.status(422).json({ error:interdit });
  const id = newId("user");
  db.prepare(`INSERT INTO users (id,email,pw_hash,first_name,last_name,title,office_id,tpm_id,role,tabs,active,must_change_pw)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`)
    .run(id, b.email, await hashPassword(b.password), b.first_name, b.last_name, b.title,
         b.office_id, b.tpm_id, b.role, JSON.stringify(b.tabs), b.active?1:0);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'create',?)`)
    .run(newId("aud"), req.user.id, req.user.email, id, `Compte créé — ${b.email}`);
  res.status(201).json({ user: shape(db.prepare("SELECT * FROM users WHERE id=?").get(id)) });
});

r.put("/:id", validate(schemas.user), async (req, res) => {
  const cur = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"compte introuvable" });
  const b = req.body;
  /* Un administrateur ne peut ni se retirer ses propres droits ni se désactiver :
     cela permettrait de fermer l'accès à la configuration sans recours. */
  if(cur.id === req.user.id && (b.role !== cur.role || !b.active))
    return res.status(409).json({ error:"vous ne pouvez pas modifier votre propre rôle ni vous désactiver" });
  if(cur.role === "super" && req.user.role !== "super")
    return res.status(403).json({ error:"seul un super-utilisateur modifie un super-utilisateur" });
  const dup = db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(b.email, cur.id);
  if(dup) return res.status(409).json({ error:"cette adresse est déjà utilisée" });
  const interdit = tpmInterdit(b);
  if(interdit) return res.status(422).json({ error:interdit });
  let pwSql = "", pwArg = [];
  if(b.password){
    const problems = passwordProblems(b.password);
    if(problems.length) return res.status(422).json({
      error:"le mot de passe doit contenir " + problems.join(", ") });
    pwSql = ", pw_hash=?, must_change_pw=1"; pwArg = [await hashPassword(b.password)];
    db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=?").run(cur.id);
  }
  db.prepare(`UPDATE users SET email=?, first_name=?, last_name=?, title=?, office_id=?,
              tpm_id=?, role=?, tabs=?, active=?, updated_at=datetime('now') ${pwSql} WHERE id=?`)
    .run(b.email, b.first_name, b.last_name, b.title, b.office_id, b.tpm_id, b.role,
         JSON.stringify(b.tabs), b.active?1:0, ...pwArg, cur.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'update',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Compte modifié — ${b.email}`);
  res.json({ user: shape(db.prepare("SELECT * FROM users WHERE id=?").get(cur.id)) });
});

r.delete("/:id", (req, res) => {
  if(req.params.id === req.user.id)
    return res.status(409).json({ error:"vous ne pouvez pas supprimer votre propre compte" });
  const cur = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"compte introuvable" });
  const supers = db.prepare("SELECT COUNT(*) c FROM users WHERE role='super' AND active=1").get().c;
  if(cur.role === "super" && supers <= 1)
    return res.status(409).json({ error:"il doit rester au moins un super-utilisateur actif" });
  db.prepare("DELETE FROM users WHERE id=?").run(cur.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'delete',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Compte supprimé — ${cur.email}`);
  res.json({ ok:true });
});
export default r;
