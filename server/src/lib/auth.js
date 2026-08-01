import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "../config.js";
import { db } from "../db.js";
import { newId } from "./crypto.js";

export const hashPassword = (pw) => bcrypt.hash(pw, config.bcryptRounds);
export const verifyPassword = (pw, hash) => bcrypt.compare(pw, hash);

/* Politique de mot de passe : longueur d'abord, puis variété. */
export function passwordProblems(pw){
  const p = [];
  if(!pw || pw.length < 12) p.push("au moins 12 caractères");
  if(!/[a-z]/.test(pw||"")) p.push("une minuscule");
  if(!/[A-Z]/.test(pw||"")) p.push("une majuscule");
  if(!/[0-9]/.test(pw||"")) p.push("un chiffre");
  if(/^(.)\1+$/.test(pw||"")) p.push("autre chose qu'un caractère répété");
  return p;
}

export function issueToken(user, req){
  const jti = newId("sess");
  const expSeconds = 8*3600;
  const token = jwt.sign(
    { sub:user.id, role:user.role, office:user.office_id || null },
    config.jwtSecret, { expiresIn: config.tokenTtl, jwtid: jti });
  db.prepare(`INSERT INTO sessions (id,user_id,expires_at,ip,user_agent)
              VALUES (?,?,datetime('now', ?),?,?)`)
    .run(jti, user.id, `+${expSeconds} seconds`,
         (req?.ip || "").slice(0,64), (req?.get?.("user-agent") || "").slice(0,200));
  return { token, jti };
}
export function revoke(jti){ db.prepare("UPDATE sessions SET revoked=1 WHERE id=?").run(jti); }

/* ═══════════════════════════════════════════════════════════════════════
   Mot de passe provisoire : ce qu'un compte peut faire avant de l'avoir changé.

   `must_change_pw` était posé à la création d'un compte et à toute réinitialisation,
   mais n'était lu que par l'écran de connexion (web/src/views/Login.jsx). Un appel
   direct à l'API avec le mot de passe provisoire — celui que l'administrateur a
   communiqué par courriel, par message, ou lu dans un journal d'amorçage — donnait
   donc un accès complet et sans limite de durée. Un drapeau appliqué côté client
   seulement n'est pas une règle, c'est une suggestion.

   La liste ci-dessous est exactement ce qu'exige le parcours de changement :
     POST /api/auth/password  change le mot de passe et lève le drapeau ;
     GET  /api/auth/me        l'interface relit le compte après le changement ;
     POST /api/auth/logout    on doit toujours pouvoir refermer sa session.
   `POST /api/auth/login` n'y figure pas : il n'est pas authentifié, il ne passe
   pas ici. Tout le reste — /api/state compris — est refusé en 403. */
const CHEMINS_SANS_MOT_DE_PASSE_DEFINITIF = new Set([
  "POST /api/auth/password",
  "GET /api/auth/me",
  "POST /api/auth/logout",
]);

/* Le chemin complet, quel que soit le routeur qui nous monte : `req.path` est
   relatif au point de montage et vaudrait « /state » aussi bien que « /me ». */
const cheminComplet = (req) =>
  `${req.method} ${(req.originalUrl || req.url || "").split("?")[0].replace(/\/+$/, "")}`;

/* Le porteur du jeton doit correspondre à une session vivante et à un compte actif. */
export function authenticate(req, res, next){
  const header = req.get("authorization");
  const bearer = header && header.startsWith("Bearer ") ? header.slice(7) : null;
  const token = bearer || req.cookies?.[config.cookieName];
  if(!token) return res.status(401).json({ error:"authentification requise" });
  let payload;
  try{ payload = jwt.verify(token, config.jwtSecret); }
  catch(e){ return res.status(401).json({ error:"jeton invalide ou expiré" }); }
  const sess = db.prepare(
    "SELECT * FROM sessions WHERE id=? AND revoked=0 AND expires_at > datetime('now')").get(payload.jti);
  if(!sess) return res.status(401).json({ error:"session close" });
  const user = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(payload.sub);
  if(!user) return res.status(401).json({ error:"compte inactif" });
  if(user.must_change_pw && !CHEMINS_SANS_MOT_DE_PASSE_DEFINITIF.has(cheminComplet(req)))
    return res.status(403).json({ error:
      "mot de passe provisoire : changez-le avant tout autre accès "
      + "(POST /api/auth/password), puis reconnectez-vous." });
  req.user = user; req.jti = payload.jti;
  return next();
}

const CAPS = {
  super:     { edit:true,  del:true,  validate:true,  admin:true },
  admin:     { edit:true,  del:true,  validate:true,  admin:true },
  validator: { edit:true,  del:false, validate:true,  admin:false },
  editor:    { edit:true,  del:false, validate:false, admin:false },
  viewer:    { edit:false, del:false, validate:false, admin:false },
};
export const can = (user, capability) => !!(CAPS[user?.role]?.[capability]);
export const requireCap = (capability) => (req, res, next) =>
  can(req.user, capability) ? next()
    : res.status(403).json({ error:`droit « ${capability} » requis pour cette action` });

/* Réservé au super-utilisateur, et non à la capacité « admin ».
   La matrice ci-dessus donne les mêmes droits à `super` et à `admin` : les
   deux rôles administrent le contenu de l'application. Ce garde marque la
   frontière que la matrice ne sait pas exprimer, celle de l'administration de
   l'installation elle-même — exécuter un script sur le serveur, restaurer une
   sauvegarde, fermer la session d'un tiers. Un administrateur gère des comptes
   et des référentiels ; il n'a pas à obtenir un interpréteur de commandes sur
   le serveur en écrivant trois lignes de R. */
export const requireSuper = (req, res, next) =>
  req.user?.role === "super" ? next()
    : res.status(403).json({ error:"action réservée au super-utilisateur" });
