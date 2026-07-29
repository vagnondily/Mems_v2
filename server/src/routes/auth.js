import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db } from "../db.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { validate, schemas } from "../lib/validate.js";
import { verifyPassword, hashPassword, issueToken, revoke, authenticate,
         passwordProblems } from "../lib/auth.js";
import { newId } from "../lib/crypto.js";

const r = Router();
const loginLimiter = rateLimit({ windowMs: 15*60_000, limit: config.rateLoginMax,
  standardHeaders:"draft-7", legacyHeaders:false, skipSuccessfulRequests:true,
  message:{ error:"trop de tentatives, réessayez dans quelques minutes" } });

/* Le nom du bureau accompagne le compte : l'interface cloisonne et affiche par nom,
   pas par identifiant, et n'a aucun autre moyen de le résoudre avant /state. */
const officeName = (id) => id
  ? (db.prepare("SELECT name FROM offices WHERE id=?").get(id)?.name || "")
  : "";

const publicUser = (u) => ({
  id:u.id, email:u.email, first_name:u.first_name, last_name:u.last_name, title:u.title,
  office_id:u.office_id, office: officeName(u.office_id),
  role:u.role, tabs: JSON.parse(u.tabs || "[]"),
  active: !!u.active, must_change_pw: !!u.must_change_pw, last_login:u.last_login,
});

r.post("/login", loginLimiter, validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  /* Même message et même coût quel que soit l'échec : on ne révèle pas l'existence d'un compte. */
  const generic = { error:"identifiants incorrects" };
  if(!u){ await hashPassword(password); return res.status(401).json(generic); }
  if(u.locked_until && u.locked_until > new Date().toISOString())
    return res.status(423).json({ error:"compte temporairement verrouillé" });
  if(!u.active) return res.status(401).json(generic);

  const ok = await verifyPassword(password, u.pw_hash);
  if(!ok){
    const fails = u.failed_logins + 1;
    const lock = fails >= config.lockAfter
      ? new Date(Date.now() + config.lockMinutes*60_000).toISOString() : null;
    db.prepare("UPDATE users SET failed_logins=?, locked_until=? WHERE id=?").run(fails, lock, u.id);
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                VALUES (?,?,?,'securite','users','login_failed',?)`)
      .run(newId("aud"), u.id, u.email, `Échec de connexion (${fails})`);
    log.warn("échec de connexion", { email: email.replace(/(.).*(@.*)/, "$1***$2"), tentatives: fails });
    return res.status(401).json(generic);
  }
  db.prepare("UPDATE users SET failed_logins=0, locked_until=NULL, last_login=datetime('now') WHERE id=?").run(u.id);
  const { token } = issueToken(u, req);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'securite','users','login',?)`)
    .run(newId("aud"), u.id, u.email, "Connexion réussie");
  res.cookie(config.cookieName, token, {
    httpOnly:true, sameSite:"lax", secure:config.isProd, maxAge:8*3600*1000, path:"/",
  });
  res.json({ token, user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)) });
});

r.post("/logout", authenticate, (req, res) => {
  revoke(req.jti);
  res.clearCookie(config.cookieName, { path:"/" });
  res.json({ ok:true });
});

r.get("/me", authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

r.post("/password", authenticate, validate(schemas.changePassword), async (req, res) => {
  const ok = await verifyPassword(req.body.current, req.user.pw_hash);
  if(!ok) return res.status(401).json({ error:"mot de passe actuel incorrect" });
  const problems = passwordProblems(req.body.next);
  if(problems.length) return res.status(422).json({
    error:"le nouveau mot de passe doit contenir " + problems.join(", ") });
  db.prepare("UPDATE users SET pw_hash=?, must_change_pw=0, updated_at=datetime('now') WHERE id=?")
    .run(await hashPassword(req.body.next), req.user.id);
  /* Toutes les autres sessions du compte tombent. */
  db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=? AND id<>?").run(req.user.id, req.jti);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'securite','users','password_change',?)`)
    .run(newId("aud"), req.user.id, req.user.email, "Mot de passe modifié");
  res.json({ ok:true });
});

r.get("/sessions", authenticate, (req, res) => {
  res.json({ sessions: db.prepare(
    `SELECT id, issued_at, expires_at, revoked, ip FROM sessions
     WHERE user_id=? ORDER BY issued_at DESC LIMIT 20`).all(req.user.id) });
});
export default r;
