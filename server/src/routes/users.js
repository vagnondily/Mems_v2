import { Router } from "express";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { validate, schemas } from "../lib/validate.js";
import { hashPassword, passwordProblems, motDePasseProvisoire } from "../lib/auth.js";

const r = Router();
/* `users.tabs` est du jsonb : pg le renvoie déjà désérialisé (plus de JSON.parse).
   L'écriture continue de passer par JSON.stringify — un paramètre jsonb reçoit du
   texte JSON que Postgres analyse. */
const shape = (u) => ({ id:u.id, email:u.email, username:u.username || "",
  first_name:u.first_name, last_name:u.last_name,
  title:u.title, office_id:u.office_id, tpm_id:u.tpm_id || null, role:u.role,
  tabs:u.tabs ?? [], active:!!u.active, last_login:u.last_login });

/* L'identifiant de connexion facultatif, validé comme dans le self-service
   (routes/auth.js) : même alphabet, même unicité contre courriels ET identifiants.
   Rend soit { value } (à écrire, éventuellement null), soit { erreur }. */
const IDENTIFIANT = /^[a-z0-9._-]{3,40}$/;
async function verifierIdentifiant(brutIn, idExclu){
  if(brutIn == null || String(brutIn).trim() === "") return { value: null };
  const brut = String(brutIn).trim().toLowerCase();
  if(!IDENTIFIANT.test(brut) || brut.includes("@"))
    return { erreur:"identifiant : 3 à 40 caractères, lettres minuscules, chiffres, point, tiret ou tiret bas, sans « @ »" };
  const pris = await db.prepare(`SELECT 1 FROM users WHERE (username=? OR email=?)${idExclu ? " AND id<>?" : ""}`)
    .get(...(idExclu ? [brut, brut, idExclu] : [brut, brut]));
  if(pris) return { erreur:"cet identifiant est déjà utilisé" };
  return { value: brut };
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

/* ── Modifier n'est pas recréer ──────────────────────────────────────
   `PUT /api/users/:id` réutilisait le schéma de création. Or ce schéma a des
   défauts — `role="viewer"`, `tabs=[]`, `active=true` — et des transformations qui
   ramènent l'absence à `null`. Conséquence : un enregistrement partiel, celui que
   fait tout écran qui ne connaît qu'une partie du compte, rétrogradait le rôle,
   effaçait le rattachement au prestataire et au bureau, et surtout RÉACTIVAIT un
   compte désactivé — sans un mot d'erreur, puisque rien n'était invalide.

   Le schéma de création reste intact : il a raison d'exiger un compte complet.
   C'est la modification qui doit accepter le partiel, et fusionner avec l'existant. */
const userPatch = schemas.user.partial();

/* Ce qui n'est pas envoyé n'est pas modifié. Seul `undefined` vaut absence : un
   `null` explicite reste une valeur, c'est ainsi qu'on détache un bureau. */
const fusion = (envoye, actuel) => envoye === undefined ? actuel : envoye;

r.use(requireCap("admin"));

r.get("/", async (req, res) => res.json({ users:
  (await db.prepare("SELECT * FROM users ORDER BY first_name").all()).map(shape) }));

r.post("/", validate(schemas.user), async (req, res) => {
  const b = req.body;
  /* Le mot de passe initial est GÉNÉRÉ par défaut : l'administrateur ne le choisit
     pas (demande du 01/08). S'il en fournit un — chemin conservé pour l'amorçage et
     les tests —, il doit passer la politique. Dans les deux cas `must_change_pw=1`,
     et le provisoire généré n'est renvoyé qu'ICI, une seule fois. */
  const genere = !b.password;
  if(b.password){
    const problems = passwordProblems(b.password);
    if(problems.length) return res.status(422).json({
      error:"le mot de passe doit contenir " + problems.join(", ") });
  }
  const clair = b.password || motDePasseProvisoire();
  if(await db.prepare("SELECT 1 FROM users WHERE email=?").get(b.email))
    return res.status(409).json({ error:"cette adresse est déjà utilisée" });
  const ident = await verifierIdentifiant(b.username, null);
  if(ident.erreur) return res.status(ident.erreur.includes("déjà")?409:422).json({ error:ident.erreur });
  const interdit = tpmInterdit(b);
  if(interdit) return res.status(422).json({ error:interdit });
  /* La frontière super / admin ne vit pas dans CAPS (qui accorde « admin » aux
     deux) mais dans requireSuper : le super seul exécute des scripts R/SPSS
     — c'est-à-dire du code arbitraire sur le serveur. Un administrateur qui
     pourrait créer un compte « super » et en recevoir le mot de passe provisoire
     s'octroierait donc un interpréteur de commandes en trois lignes. On l'interdit :
     seul un super crée ou promeut un super. */
  if(b.role === "super" && req.user.role !== "super")
    return res.status(403).json({ error:"seul un super-utilisateur peut créer un compte super-utilisateur" });
  const id = newId("user");
  await db.prepare(`INSERT INTO users (id,email,username,pw_hash,first_name,last_name,title,office_id,tpm_id,role,tabs,active,must_change_pw)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`)
    .run(id, b.email, ident.value, await hashPassword(clair), b.first_name, b.last_name, b.title,
         b.office_id, b.tpm_id, b.role, JSON.stringify(b.tabs), b.active?1:0);
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'create',?)`)
    .run(newId("aud"), req.user.id, req.user.email, id, `Compte créé — ${b.email}`);
  res.status(201).json({
    user: shape(await db.prepare("SELECT * FROM users WHERE id=?").get(id)),
    /* Le provisoire ne sort QUE s'il a été généré, et jamais une seconde fois. */
    provisionalPassword: genere ? clair : undefined });
});

/* Réinitialisation par l'administrateur (demande du 01/08). L'admin ne connaît pas
   le mot de passe : il en DÉCLENCHE un nouveau, provisoire, généré par le serveur,
   affiché une seule fois ici pour qu'il le communique. À la connexion suivante,
   `must_change_pw` impose son remplacement, et toutes les sessions ouvertes tombent. */
r.post("/:id/reset-password", async (req, res) => {
  const cur = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"compte introuvable" });
  if(cur.role === "super" && req.user.role !== "super")
    return res.status(403).json({ error:"seul un super-utilisateur réinitialise un super-utilisateur" });
  const clair = motDePasseProvisoire();
  await db.prepare("UPDATE users SET pw_hash=?, must_change_pw=1, updated_at=now() WHERE id=?")
    .run(await hashPassword(clair), cur.id);
  await db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=?").run(cur.id);
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'password_reset',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Mot de passe réinitialisé — ${cur.email}`);
  res.json({ provisionalPassword: clair });
});

r.put("/:id", validate(userPatch), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"compte introuvable" });
  const b = req.body;
  /* Le compte tel qu'il sera : l'envoi par-dessus l'existant. Tous les contrôles
     ci-dessous portent sur ce résultat, jamais sur le seul corps de la requête —
     sans quoi ils raisonneraient sur des champs que l'appelant n'a pas envoyés. */
  /* L'identifiant, s'il est envoyé, est validé et son unicité vérifiée avant tout
     le reste — même règle qu'à la création et qu'en self-service. */
  let username = cur.username;
  if(b.username !== undefined){
    const ident = await verifierIdentifiant(b.username, cur.id);
    if(ident.erreur) return res.status(ident.erreur.includes("déjà")?409:422).json({ error:ident.erreur });
    username = ident.value;
  }
  const m = {
    email:      fusion(b.email, cur.email),
    first_name: fusion(b.first_name, cur.first_name),
    last_name:  fusion(b.last_name, cur.last_name),
    title:      fusion(b.title, cur.title),
    office_id:  fusion(b.office_id, cur.office_id),
    tpm_id:     fusion(b.tpm_id, cur.tpm_id),
    role:       fusion(b.role, cur.role),
    tabs:       b.tabs === undefined ? cur.tabs : JSON.stringify(b.tabs),
    active:     b.active === undefined ? cur.active : (b.active ? 1 : 0),
  };
  /* Un administrateur ne peut ni se retirer ses propres droits ni se désactiver :
     cela permettrait de fermer l'accès à la configuration sans recours. */
  if(cur.id === req.user.id && (m.role !== cur.role || !m.active))
    return res.status(409).json({ error:"vous ne pouvez pas modifier votre propre rôle ni vous désactiver" });
  if(cur.role === "super" && req.user.role !== "super")
    return res.status(403).json({ error:"seul un super-utilisateur modifie un super-utilisateur" });
  /* Symétrique du garde ci-dessus, mais sur le rôle VOULU et non le rôle actuel :
     sans lui, un administrateur promeut un éditeur en « super » (cur.role n'est pas
     encore super, le test précédent laisse passer) et franchit la frontière que
     requireSuper trace. Promouvoir vers super est réservé au super. */
  if(m.role === "super" && cur.role !== "super" && req.user.role !== "super")
    return res.status(403).json({ error:"seul un super-utilisateur peut promouvoir un compte en super-utilisateur" });
  const dup = await db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(m.email, cur.id);
  if(dup) return res.status(409).json({ error:"cette adresse est déjà utilisée" });
  const interdit = tpmInterdit(m);
  if(interdit) return res.status(422).json({ error:interdit });
  let pwSql = "", pwArg = [];
  if(b.password){
    const problems = passwordProblems(b.password);
    if(problems.length) return res.status(422).json({
      error:"le mot de passe doit contenir " + problems.join(", ") });
    pwSql = ", pw_hash=?, must_change_pw=1"; pwArg = [await hashPassword(b.password)];
    await db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=?").run(cur.id);
  }
  await db.prepare(`UPDATE users SET email=?, username=?, first_name=?, last_name=?, title=?, office_id=?,
              tpm_id=?, role=?, tabs=?, active=?, updated_at=now() ${pwSql} WHERE id=?`)
    .run(m.email, username, m.first_name, m.last_name, m.title, m.office_id, m.tpm_id, m.role,
         m.tabs, m.active, ...pwArg, cur.id);
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'update',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Compte modifié — ${m.email}`);
  res.json({ user: shape(await db.prepare("SELECT * FROM users WHERE id=?").get(cur.id)) });
});

r.delete("/:id", async (req, res) => {
  if(req.params.id === req.user.id)
    return res.status(409).json({ error:"vous ne pouvez pas supprimer votre propre compte" });
  const cur = await db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"compte introuvable" });
  const supers = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='super' AND active=1").get()).c;
  if(cur.role === "super" && supers <= 1)
    return res.status(409).json({ error:"il doit rester au moins un super-utilisateur actif" });
  await db.prepare("DELETE FROM users WHERE id=?").run(cur.id);
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','users',?,'delete',?)`)
    .run(newId("aud"), req.user.id, req.user.email, cur.id, `Compte supprimé — ${cur.email}`);
  res.json({ ok:true });
});
export default r;
