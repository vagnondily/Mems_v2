import { Router } from "express";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { hashPassword, passwordProblems } from "../lib/auth.js";
import { countryBound } from "../lib/scope.js";

const r = Router();
const shape = (u) => ({ id:u.id, email:u.email, first_name:u.first_name, last_name:u.last_name,
  title:u.title, office_id:u.office_id, country_code:u.country_code || null,
  tpm_id:u.tpm_id || null, role:u.role,
  tabs:JSON.parse(u.tabs||"[]"), active:!!u.active, last_login:u.last_login });

/* Le pays d'un compte qu'on crée ou modifie.

   Un administrateur borné à un pays administre son pays : il ne peut ni créer un
   compte ailleurs, ni créer un compte SANS pays — ce dernier verrait tous les pays,
   ce qui serait une élévation de privilège offerte par un champ laissé vide. Un
   administrateur non borné choisit, y compris de ne rien mettre.

   Rendre 403 plutôt que d'imposer silencieusement : ici l'appelant a le droit
   d'administrer, il faut donc lui dire ce qu'il ne peut pas faire au lieu de
   corriger son geste dans son dos. */
function paysDuCompte(req, b){
  const mien = countryBound(req.user);
  if(!mien) return { code: b.country_code ?? null };
  if(b.country_code && b.country_code !== mien)
    return { error:"vous n'administrez que les comptes de votre pays" };
  return { code: mien };
}

/* Le compte visible de l'appelant. Un administrateur borné ne voit ni les comptes
   d'un autre pays, ni les comptes non bornés — ces derniers ont, par construction,
   une portée plus large que la sienne. */
function joignable(req, id){
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
  if(!u) return null;
  const mien = countryBound(req.user);
  if(mien && u.country_code !== mien) return null;
  return u;
}

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

r.get("/", (req, res) => {
  /* Pas de `countryClause` ici : elle inclut volontairement les lignes sans pays, ce
     qui convient à un bureau ou à un prestataire mais pas à un compte — un compte
     sans pays voit tous les pays, et l'exposer à un administrateur borné lui
     donnerait une cible à modifier. Le filtre est donc strict. */
  const mien = countryBound(req.user);
  const rows = mien
    ? db.prepare("SELECT * FROM users WHERE country_code=? ORDER BY first_name").all(mien)
    : db.prepare("SELECT * FROM users ORDER BY first_name").all();
  res.json({ users: rows.map(shape) });
});

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
  const pays = paysDuCompte(req, b);
  if(pays.error) return res.status(403).json({ error:pays.error });
  const id = newId("user");
  db.prepare(`INSERT INTO users (id,email,pw_hash,first_name,last_name,title,office_id,country_code,
              tpm_id,role,tabs,active,must_change_pw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`)
    .run(id, b.email, await hashPassword(b.password), b.first_name, b.last_name, b.title,
         b.office_id, pays.code, b.tpm_id, b.role, JSON.stringify(b.tabs), b.active?1:0);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'create',?)`)
    .run(newId("aud"), req.user.id, req.user.email, id, `Compte créé — ${b.email}`);
  res.status(201).json({ user: shape(db.prepare("SELECT * FROM users WHERE id=?").get(id)) });
});

r.put("/:id", validate(schemas.user), async (req, res) => {
  const cur = joignable(req, req.params.id);
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
  const pays = paysDuCompte(req, b);
  if(pays.error) return res.status(403).json({ error:pays.error });
  /* Se retirer son propre pays serait s'élargir soi-même à toute l'instance. */
  if(cur.id === req.user.id && (pays.code || null) !== (cur.country_code || null))
    return res.status(409).json({ error:"vous ne pouvez pas changer votre propre pays" });
  let pwSql = "", pwArg = [];
  if(b.password){
    const problems = passwordProblems(b.password);
    if(problems.length) return res.status(422).json({
      error:"le mot de passe doit contenir " + problems.join(", ") });
    pwSql = ", pw_hash=?, must_change_pw=1"; pwArg = [await hashPassword(b.password)];
    db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=?").run(cur.id);
  }
  db.prepare(`UPDATE users SET email=?, first_name=?, last_name=?, title=?, office_id=?,
              country_code=?, tpm_id=?, role=?, tabs=?, active=?, updated_at=datetime('now')
              ${pwSql} WHERE id=?`)
    .run(b.email, b.first_name, b.last_name, b.title, b.office_id, pays.code, b.tpm_id, b.role,
         JSON.stringify(b.tabs), b.active?1:0, ...pwArg, cur.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'update',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Compte modifié — ${b.email}`);
  res.json({ user: shape(db.prepare("SELECT * FROM users WHERE id=?").get(cur.id)) });
});

r.delete("/:id", (req, res) => {
  if(req.params.id === req.user.id)
    return res.status(409).json({ error:"vous ne pouvez pas supprimer votre propre compte" });
  const cur = joignable(req, req.params.id);
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
