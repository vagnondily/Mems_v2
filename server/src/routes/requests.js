import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { authenticate, can } from "../lib/auth.js";
import { countryBound } from "../lib/scope.js";
import { allCountries } from "../lib/country.js";
import { config } from "../config.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

/* ═══════════════════════════════════════════════════════════════════════
   Demander un accès soi-même, sans se l'accorder.

   Un compte ne pouvait naître que de la main d'un administrateur. C'est sûr, et c'est
   un goulot : dans un bureau qui recrute un agent de suivi un lundi matin, la personne
   attend que quelqu'un, ailleurs, trouve le temps de créer son compte — et pendant ce
   temps elle travaille sur un tableur, ce qui est précisément ce qu'on voulait éviter.

   L'inscription libre, à l'inverse, laisserait n'importe qui se faire un accès à des
   données de bénéficiaires. La forme juste tient en deux verbes : la personne DEMANDE,
   l'administrateur du pays DÉCIDE.

   QUATRE CHOSES qui font que ce n'est pas une porte dérobée :

     1. Une demande n'est pas un compte. Pas de mot de passe, pas de session, aucune
        lecture possible. Elle ne devient un compte qu'au moment où quelqu'un qui en a
        le droit lui attribue un rôle, un bureau et des destinations.

     2. LE RÔLE NE SE DEMANDE PAS. Il ne figure nulle part dans le formulaire ni dans
        la table. Le demandeur déclare qui il est ; il ne déclare pas ce qu'il pourra
        faire. C'est la garantie principale, et elle est structurelle plutôt que
        vérifiée à l'exécution.

     3. La porte est fermée par défaut. Tant qu'un administrateur n'a pas ouvert
        l'option, la route publique répond qu'elle n'existe pas.

     4. La réponse ne dit jamais si l'adresse est connue. Un formulaire d'inscription
        qui répond « ce compte existe déjà » est un outil d'énumération de comptes
        offert à qui passe. On répond donc toujours la même chose.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

/* Une demande d'accès coûte cher à traiter — un humain la lit — et rien n'empêcherait
   d'en envoyer mille. Plus serré que la limite générale de l'API. */
const limiteur = rateLimit({ windowMs: 60 * 60_000, limit: 5,
  standardHeaders:"draft-7", legacyHeaders:false,
  message:{ error:"trop de demandes depuis cette adresse ; réessayez dans une heure" } });

const ouverte = () => {
  const v = db.prepare("SELECT value FROM settings WHERE key='selfRegistration'").get();
  try{ return v ? JSON.parse(v.value) === true : false; }catch(e){ return false; }
};
/* Restreindre aux adresses de l'organisation quand l'exploitant l'a voulu : une liste
   vide n'impose rien. */
const domaines = () => {
  const v = db.prepare("SELECT value FROM settings WHERE key='selfRegistrationDomains'").get();
  try{ return (JSON.parse(v?.value || '""') || "").split(/[,\s]+/).filter(Boolean).map(d => d.toLowerCase().replace(/^@/, "")); }
  catch(e){ return []; }
};

const S = (max) => z.string().trim().max(max).nullish().transform(v => (v ? v : null));

/* ── Ce que le public peut savoir ─────────────────────────────────────
   Juste assez pour remplir le formulaire, et rien qui renseigne un curieux : les noms
   des bureaux et des pays figurent de toute façon sur n'importe quel document public de
   l'organisation. Les comptes, les effectifs et les données, non. */
r.get("/options", (req, res) => {
  if(!ouverte()) return res.json({ ouverte:false });
  const pays = allCountries().filter(c => c.active !== 0);
  res.json({
    ouverte: true,
    domaines: domaines(),
    pays: pays.map(c => ({ code:c.code, name:c.name })),
    bureaux: db.prepare(
      `SELECT id, name, country_code FROM offices
       WHERE active IS NULL OR active=1 ORDER BY name`).all(),
    /* Les mêmes clés que l'écran des comptes (D_ENTITIES côté interface) : deux
       vocabulaires pour la même chose obligeraient l'administrateur à traduire la
       déclaration du demandeur avant de pouvoir s'en servir. */
    entites: ["se","programme","logistique","direction","tpm","partenaire","externe"],
  });
});

const demandeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(160),
  first_name: z.string().trim().min(2).max(80),
  last_name: S(80),
  title: S(120),
  entity: S(40),
  country_code: z.string().trim().length(3).nullish()
    .transform(v => (v ? v.toUpperCase() : null)),
  office_id: S(64),
  motif: S(600),
  /* Aucun champ « role » : il n'est pas oublié, il est délibérément absent. */
});

r.post("/", limiteur, (req, res) => {
  if(!ouverte()) return res.status(404).json({ error:"la demande d'accès n'est pas ouverte sur cette instance" });
  const p = demandeSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"demande incomplète",
    details:p.error.issues.slice(0,6).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;

  const liste = domaines();
  if(liste.length && !liste.includes(b.email.split("@")[1] || ""))
    return res.status(422).json({
      error:`seules les adresses ${liste.map(d => "@" + d).join(", ")} peuvent demander un accès` });

  /* La réponse est la même quoi qu'il arrive : compte déjà existant, demande déjà en
     attente, ou demande neuve. Sinon ce formulaire dirait à quiconque, adresse par
     adresse, qui travaille ici. */
  const memeReponse = () => res.status(202).json({
    recue: true,
    message: "Votre demande a été transmise à l'administrateur. Vous recevrez vos identifiants une fois qu'elle aura été examinée.",
  });

  const dejaCompte = db.prepare("SELECT 1 FROM users WHERE email=? COLLATE NOCASE").get(b.email);
  const dejaDemande = db.prepare(
    "SELECT 1 FROM account_request WHERE email=? COLLATE NOCASE AND status='pending'").get(b.email);
  if(dejaCompte || dejaDemande) return memeReponse();

  /* Le pays : celui demandé s'il existe, sinon celui de l'instance — une demande sans
     pays n'aurait aucun administrateur pour la voir. */
  const paysConnu = b.country_code
    && db.prepare("SELECT 1 FROM country WHERE code=?").get(b.country_code) ? b.country_code
    : (db.prepare("SELECT code FROM country WHERE is_current=1").get()?.code
       || db.prepare("SELECT code FROM country LIMIT 1").get()?.code || null);

  const id = newId("req");
  db.prepare(`INSERT INTO account_request
    (id,email,first_name,last_name,title,entity,country_code,office_id,motif,ip,user_agent)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.email, b.first_name, b.last_name, b.title, b.entity, paysConnu, b.office_id,
         b.motif, (req.ip || "").slice(0,64), (req.get("user-agent") || "").slice(0,200));

  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,NULL,?,'securite','account_request',?,'create',?)`)
    .run(newId("aud"), b.email, id,
      `Demande d'accès déposée — ${b.first_name} ${b.last_name || ""} (${b.email})`);

  memeReponse();
});

/* ─────────────────────────────────────────────────────────────────────
   À partir d'ici, tout exige une session et le droit d'administrer.
   ───────────────────────────────────────────────────────────────────── */
r.use(authenticate, (req, res, next) => {
  if(!can(req.user, "admin")) return res.status(403).json({ error:"droit « admin » requis" });
  next();
});

const bureau = (id) => id
  ? (db.prepare("SELECT name FROM offices WHERE id=?").get(id)?.name || "") : "";
const shape = (d) => ({
  id:d.id, email:d.email, first_name:d.first_name, last_name:d.last_name || "",
  title:d.title || "", entity:d.entity || null,
  country_code:d.country_code || null, office_id:d.office_id || null, office: bureau(d.office_id),
  motif:d.motif || "", status:d.status, created_at:d.created_at,
  decided_at:d.decided_at || null, decision_note:d.decision_note || "",
  decidedBy: d.decided_by
    ? (db.prepare("SELECT email FROM users WHERE id=?").get(d.decided_by)?.email || "") : "",
  user_id:d.user_id || null,
});

/* Un administrateur borné à un pays ne voit que les demandes de son pays — c'est tout
   l'intérêt de porter le pays sur la demande. Hors de son pays, une demande est
   INTROUVABLE et non refusée : un refus confirmerait son existence. */
const visible = (req, id) => {
  const d = db.prepare("SELECT * FROM account_request WHERE id=?").get(id);
  if(!d) return null;
  const pays = countryBound(req.user);
  return (pays && d.country_code && d.country_code !== pays) ? null : d;
};

r.get("/", (req, res) => {
  const statut = ["pending","approved","rejected"].includes(req.query.status)
    ? req.query.status : null;
  const pays = countryBound(req.user);
  const cond = [], args = [];
  if(statut){ cond.push("status = ?"); args.push(statut); }
  if(pays){ cond.push("(country_code = ? OR country_code IS NULL)"); args.push(pays); }
  const rows = db.prepare(
    `SELECT * FROM account_request ${cond.length ? "WHERE " + cond.join(" AND ") : ""}
     ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 500`)
    .all(...args);
  res.json({ rows: rows.map(shape),
    enAttente: rows.filter(x => x.status === "pending").length });
});

/* Un mot de passe initial lisible à l'oral : il sera dicté au téléphone ou recopié
   d'un message, et « Il1l0O » se recopie mal. Les caractères ambigus sont retirés. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function motDePasseInitial(){
  let s = "";
  while(s.length < 16) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  /* La politique exige minuscule, majuscule et chiffre : on les impose plutôt que de
     compter sur le hasard, sinon une acceptation sur cent échouerait à la validation. */
  return "Mems" + s.slice(0, 12) + crypto.randomInt(10) + "z";
}

r.post("/:id/approve", (req, res) => {
  const d = visible(req, req.params.id);
  if(!d) return res.status(404).json({ error:"demande introuvable" });
  if(d.status !== "pending")
    return res.status(409).json({ error:`cette demande a déjà été ${d.status === "approved" ? "acceptée" : "refusée"}` });

  const p = z.object({
    /* Ce que l'ADMINISTRATEUR décide, et qui n'était nulle part dans la demande. */
    role: z.enum(["admin","validator","editor","viewer"]),
    office_id: S(64),
    tabs: z.array(z.string().max(30)).max(30).default([]),
    entity: S(40),
    note: S(400),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"décision invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;

  /* Le rôle « super » ne s'accorde pas par ce chemin : il donne le contrôle total, y
     compris la mise à jour du code. Il se pose à la main, en connaissance de cause. */
  const bureauChoisi = b.office_id || d.office_id || null;
  if(bureauChoisi && !db.prepare("SELECT 1 FROM offices WHERE id=?").get(bureauChoisi))
    return res.status(422).json({ error:"bureau inconnu" });

  if(db.prepare("SELECT 1 FROM users WHERE email=? COLLATE NOCASE").get(d.email)){
    db.prepare(`UPDATE account_request SET status='rejected', decided_at=datetime('now'),
                decided_by=?, decision_note=? WHERE id=?`)
      .run(req.user.id, "Un compte existe déjà pour cette adresse", d.id);
    return res.status(409).json({ error:"un compte existe déjà pour cette adresse ; la demande a été close" });
  }

  const mdp = motDePasseInitial();
  /* Le hachage a lieu AVANT la transaction : better-sqlite3 est synchrone et ne peut
     pas attendre une promesse à l'intérieur. bcrypt coûte ici quelques dizaines de
     millisecondes, qu'il vaut mieux payer hors du verrou d'écriture. */
  const empreinte = bcrypt.hashSync(mdp, config.bcryptRounds);
  const uid = newId("user");
  try{
    tx(() => {
      db.prepare(`INSERT INTO users
        (id,email,pw_hash,first_name,last_name,title,office_id,role,tabs,entity,
         country_code,active,must_change_pw)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,1)`)
        .run(uid, d.email, empreinte, d.first_name, d.last_name, d.title,
             bureauChoisi, b.role, JSON.stringify(b.tabs), b.entity || d.entity,
             d.country_code);
      db.prepare(`UPDATE account_request SET status='approved', decided_at=datetime('now'),
                  decided_by=?, decision_note=?, user_id=? WHERE id=?`)
        .run(req.user.id, b.note, uid, d.id);
      db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                  VALUES (?,?,?,'securite','account_request',?,'approve',?)`)
        .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, d.id,
          `Demande acceptée — compte ${d.email} créé avec le rôle « ${b.role} »`);
    })();
  }catch(e){
    if(/UNIQUE/.test(e.message))
      return res.status(409).json({ error:"un compte existe déjà pour cette adresse" });
    throw e;
  }

  /* Le mot de passe n'est rendu QU'ICI, une seule fois : il n'est stocké nulle part en
     clair, et aucun autre appel ne le redonnera. L'application n'envoie pas de
     courriel — c'est à l'administrateur de le transmettre, et il doit donc le voir. */
  res.status(201).json({
    ok:true, user_id:uid, email:d.email, motDePasse:mdp,
    note:"Ce mot de passe n'est affiché qu'une fois. Transmettez-le par un canal sûr ; il devra être changé à la première connexion.",
  });
});

r.post("/:id/reject", (req, res) => {
  const d = visible(req, req.params.id);
  if(!d) return res.status(404).json({ error:"demande introuvable" });
  if(d.status !== "pending")
    return res.status(409).json({ error:"cette demande a déjà été traitée" });
  const p = z.object({ note: S(400) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"motif invalide" });

  db.prepare(`UPDATE account_request SET status='rejected', decided_at=datetime('now'),
              decided_by=?, decision_note=? WHERE id=?`)
    .run(req.user.id, p.data.note, d.id);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','account_request',?,'reject',?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, d.id,
      `Demande refusée — ${d.email}${p.data.note ? ` (${p.data.note})` : ""}`);
  res.json({ ok:true });
});

export default r;
