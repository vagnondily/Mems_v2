import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";
import { validate, schemas } from "../lib/validate.js";
import { verifyPassword, hashPassword, issueToken, revoke, authenticate,
         passwordProblems, requireSuper, dansPlageAffichage } from "../lib/auth.js";
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

const tpmName = (id) => id
  ? (db.prepare("SELECT name FROM tpm WHERE id=?").get(id)?.name || "")
  : "";

const publicUser = (u) => ({
  id:u.id, email:u.email, username:u.username || "",
  first_name:u.first_name, last_name:u.last_name, title:u.title,
  office_id:u.office_id, office: officeName(u.office_id),
  /* Un compte de prestataire doit se savoir tel : l'interface lui masque les
     destinations internes, et le serveur le borne de son côté. */
  tpm_id:u.tpm_id || null, tpm: tpmName(u.tpm_id),
  role:u.role, tabs: JSON.parse(u.tabs || "[]"),
  active: !!u.active, must_change_pw: !!u.must_change_pw, last_login:u.last_login,
});

r.post("/login", loginLimiter, validate(schemas.login), async (req, res) => {
  const { email, password } = req.body;
  /* `email` porte un courriel OU un identifiant (migration 023) : on cherche l'un
     ou l'autre. Un même compte ne peut pas être visé par les deux à la fois — le
     courriel a la forme d'un courriel, l'identifiant ne l'a pas. */
  const u = db.prepare("SELECT * FROM users WHERE email = ? OR username = ?").get(email, email);
  /* Même message et même coût quel que soit l'échec : on ne révèle pas l'existence d'un compte. */
  const generic = { error:"identifiants incorrects" };
  if(!u){ await hashPassword(password); return res.status(401).json(generic); }
  if(u.locked_until){
    if(u.locked_until > new Date().toISOString())
      return res.status(423).json({ error:"compte temporairement verrouillé" });
    /* Le verrou a expiré, mais le compteur restait au seuil : la tentative
       suivante — même unique, même du titulaire légitime qui vient de patienter
       ses quinze minutes — reverrouillait aussitôt pour quinze de plus. Le verrou
       « temporaire » était en fait définitif sans intervention d'un administrateur.
       Sa levée doit donc rendre au compte le compteur qu'il avait avant. */
    db.prepare("UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?").run(u.id);
    u.failed_logins = 0; u.locked_until = null;
  }
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
  /* L'écran de supervision (kiosque) ne se connecte qu'aux heures de bureau. */
  if(u.role === "dashboard" && !dansPlageAffichage())
    return res.status(403).json({ code:"hors_plage_affichage",
      error:"Écran de supervision : accès autorisé de 07h30 à 18h00 (heure de Madagascar)." });
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

/* « Créer un username » en self-service (demande du 01/08). C'est un identifiant
   de CONNEXION : il peut ensuite servir à se connecter à la place du courriel.
   Vide, on retire l'identifiant ; sinon on impose un alphabet sûr et l'unicité. */
const IDENTIFIANT = /^[a-z0-9._-]{3,40}$/;
r.put("/username", authenticate, validate(schemas.changeUsername), (req, res) => {
  const brut = String(req.body.username || "").trim().toLowerCase();
  if(brut === ""){
    db.prepare("UPDATE users SET username=NULL, updated_at=datetime('now') WHERE id=?").run(req.user.id);
    return res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
  }
  if(!IDENTIFIANT.test(brut)) return res.status(422).json({
    error:"identifiant : 3 à 40 caractères, lettres minuscules, chiffres, point, tiret ou tiret bas" });
  /* Un identifiant qui a la forme d'un courriel rendrait la connexion ambiguë. */
  if(brut.includes("@")) return res.status(422).json({ error:"l'identifiant ne peut pas contenir « @ »" });
  /* L'unicité couvre aussi les COURRIELS : sans quoi un identifiant pourrait
     usurper l'adresse d'un autre compte et détourner sa connexion. */
  const pris = db.prepare("SELECT 1 FROM users WHERE (username=? OR email=?) AND id<>?")
    .get(brut, brut, req.user.id);
  if(pris) return res.status(409).json({ error:"cet identifiant est déjà utilisé" });
  db.prepare("UPDATE users SET username=?, updated_at=datetime('now') WHERE id=?").run(brut, req.user.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'securite','users','username_set',?)`)
    .run(newId("aud"), req.user.id, req.user.email, `Identifiant défini — ${brut}`);
  res.json({ user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id)) });
});

/* ═══════════════════════════════════════════════════════════════════════
   SESSIONS — consultation, révocation, purge

   `GET /api/auth/sessions` existait et ne permettait rien : on voyait ses
   sessions ouvertes sans pouvoir en fermer une seule. Un ordinateur portable
   perdu restait connecté huit heures, et la seule parade était de désactiver
   le compte entier. Symétriquement, la table n'était jamais nettoyée : elle
   grossit d'une ligne par connexion, pour toujours (docs/A_FAIRE.md,
   chantier A, point 8).

   La lecture de ses PROPRES sessions reste ouverte à tous, inchangée. Tout ce
   qui agit — révoquer, purger — et tout ce qui regarde le compte d'autrui est
   réservé au super-utilisateur : fermer la session de quelqu'un d'autre, c'est
   l'expulser de l'application en cours de saisie.

   ── SE COUPER SOI-MÊME : le choix retenu, et pourquoi ──
   Deux gestes peuvent trancher la session de l'appelant, et ils ne méritent
   pas la même réponse.

   • Révoquer UNE session en la désignant : la sienne est refusée par défaut
     (409), et n'est acceptée qu'avec `?confirmer=1`. Se déconnecter est
     légitime — c'est ce que fait POST /api/auth/logout — mais ça ne doit
     jamais être l'effet de bord d'un ménage. Refuser puis demander confirme
     que l'intention est bien celle-là.

   • Révoquer TOUTES les sessions d'un compte : la sienne est préservée par
     défaut, et la réponse le dit (`courante_preservee`). Le geste sert à
     chasser un appareil compromis ; se couper au milieu empêcherait de
     terminer — désactiver le compte, changer le mot de passe. `?inclure_courante=1`
     force l'inclusion pour qui veut vraiment tout fermer.

   Interdire purement et simplement aurait été la troisième voie : elle rend
   impossible « je ferme tout, y compris d'ici », qui est un besoin réel le
   jour d'une compromission. On préfère prévenir que priver. ══════════════ */

const sessionsQuery = z.object({
  user_id: z.string().max(64).optional(),
  tous:    z.enum(["0","1"]).optional(),
  limite:  z.coerce.number().int().min(1).max(200).default(50),
}).strict();

/* Ce que l'on montre d'une session : de quoi la reconnaître et la révoquer,
   rien de plus. `id` est le `jti` du jeton, pas le jeton : il ne permet pas
   de s'authentifier — il ne sert qu'à désigner la ligne à fermer. */
const vueSession = (s, jti) => ({
  id:s.id, issued_at:s.issued_at, expires_at:s.expires_at, revoked:s.revoked,
  ip:s.ip, courante: s.id === jti, active: !!s.active,
});

/* « Vivante » se calcule en SQL et pas en JavaScript : c'est l'horloge de
   SQLite qui a émis `expires_at`, c'est elle qui doit dire s'il est passé.
   Comparer à une date construite côté Node, c'est parier sur un format et
   sur un fuseau. */
const COLONNES = `s.*, (s.revoked=0 AND s.expires_at > datetime('now')) AS active`;

r.get("/sessions", authenticate, validate(sessionsQuery, "query"), (req, res) => {
  const { user_id, tous, limite } = req.query;
  const elargi = tous === "1" || (user_id && user_id !== req.user.id);
  if(elargi && req.user.role !== "super") return res.status(403).json({
    error:"seul un super-utilisateur consulte les sessions d'un autre compte" });

  if(tous === "1"){
    const lignes = db.prepare(
      `SELECT ${COLONNES}, u.email FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.issued_at DESC LIMIT ?`).all(limite);
    return res.json({ portee:"toutes", total: db.prepare("SELECT COUNT(*) c FROM sessions").get().c,
      sessions: lignes.map(s => ({ ...vueSession(s, req.jti),
        user_id:s.user_id, email:s.email, user_agent:s.user_agent })) });
  }
  const cible = user_id || req.user.id;
  const lignes = db.prepare(
    `SELECT ${COLONNES} FROM sessions s WHERE s.user_id=?
     ORDER BY s.issued_at DESC LIMIT ?`).all(cible, limite);
  res.json({ portee: cible === req.user.id ? "compte" : "autre_compte", user_id:cible,
    sessions: lignes.map(s => elargi
      ? { ...vueSession(s, req.jti), user_id:s.user_id, user_agent:s.user_agent }
      : vueSession(s, req.jti)) });
});

/* Purge avant `/sessions/:id` par lisibilité seulement : les deux routes
   n'ont ni le même verbe ni le même chemin, elles ne se disputent rien. */
const purgeQuery = z.object({
  /* Fenêtre de conservation : une session close depuis peu reste parfois utile
     à une enquête. `0` — le défaut — purge tout ce qui est déjà mort. */
  jours: z.coerce.number().int().min(0).max(3650).default(0),
}).strict();

r.post("/sessions/purge", authenticate, requireSuper, validate(purgeQuery, "query"),
  (req, res) => {
    const { jours } = req.query;
    /* Une session VIVANTE a `revoked=0` ET `expires_at` dans le futur : la
       condition ci-dessous l'exclut par construction, pas par précaution.
       Aucun paramètre ne peut l'y ramener — `jours` ne fait que restreindre
       davantage. */
    const conditions = "revoked=1 OR expires_at <= datetime('now')";
    const fenetre = jours > 0 ? " AND issued_at <= datetime('now', ?)" : "";
    const args = jours > 0 ? [`-${jours} days`] : [];
    const avant = db.prepare("SELECT COUNT(*) c FROM sessions").get().c;
    const info = db.prepare(`DELETE FROM sessions WHERE (${conditions})${fenetre}`).run(...args);
    const restantes = db.prepare("SELECT COUNT(*) c FROM sessions").get().c;
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                VALUES (?,?,?,'securite','sessions','purge',?)`)
      .run(newId("aud"), req.user.id, req.user.email,
           `Purge des sessions closes — ${info.changes} supprimée(s), ${restantes} conservée(s)`);
    log.info("purge des sessions", { supprimees:info.changes, restantes, jours });
    res.json({ ok:true, supprimees:info.changes, avant, restantes, jours });
  });

r.delete("/sessions/:id", authenticate, requireSuper, (req, res) => {
  const s = db.prepare("SELECT * FROM sessions WHERE id=?").get(req.params.id);
  if(!s) return res.status(404).json({ error:"session introuvable" });

  if(s.id === req.jti && req.query.confirmer !== "1") return res.status(409).json({
    error:"c'est la session avec laquelle vous êtes connecté : elle ne sera plus "
      + "utilisable dès cette requête. Confirmez par ?confirmer=1, ou utilisez "
      + "POST /api/auth/logout qui fait exactement cela.", courante:true });

  /* Déjà révoquée : l'état voulu est atteint, on le dit sans échouer. Un
     refus pousserait à recommencer pour rien, au pire moment — celui où l'on
     ferme dans l'urgence les accès d'un appareil perdu. */
  if(s.revoked) return res.json({ ok:true, revoquee:s.id, deja_revoquee:true });

  revoke(s.id);
  const cible = db.prepare("SELECT email FROM users WHERE id=?").get(s.user_id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','sessions',?,'revoke',?)`)
    .run(newId("aud"), req.user.id, req.user.email, s.id,
         `Session révoquée — compte ${cible?.email || s.user_id}`
         + (s.id === req.jti ? " (la sienne, sur confirmation)" : ""));
  res.json({ ok:true, revoquee:s.id, compte:s.user_id, courante: s.id === req.jti });
});

const revocationQuery = z.object({
  inclure_courante: z.enum(["0","1"]).optional(),
}).strict();

r.delete("/users/:id/sessions", authenticate, requireSuper, validate(revocationQuery, "query"),
  (req, res) => {
    const u = db.prepare("SELECT id, email FROM users WHERE id=?").get(req.params.id);
    if(!u) return res.status(404).json({ error:"compte introuvable" });

    const inclure = req.query.inclure_courante === "1";
    const sienne = db.prepare("SELECT 1 FROM sessions WHERE id=? AND user_id=? AND revoked=0")
      .get(req.jti, u.id);
    const info = inclure
      ? db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0").run(u.id)
      : db.prepare("UPDATE sessions SET revoked=1 WHERE user_id=? AND revoked=0 AND id<>?")
          .run(u.id, req.jti);

    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'securite','sessions',?,'revoke_all',?)`)
      .run(newId("aud"), req.user.id, req.user.email, u.id,
           `Toutes les sessions du compte ${u.email} révoquées — ${info.changes} fermée(s)`
           + (sienne && !inclure ? ", la session courante préservée" : ""));
    res.json({ ok:true, compte:u.id, email:u.email, revoquees:info.changes,
      courante_preservee: !!sienne && !inclure,
      /* Dit explicitement quand le geste vient de couper l'appelant : la
         réponse arrive encore, le prochain appel non. */
      courante_revoquee: !!sienne && inclure });
  });

export default r;
