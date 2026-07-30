import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { requireCap } from "../lib/auth.js";
import { LEVELS } from "../lib/geo.js";
import { allCountries, defaultCountry } from "../lib/country.js";
import { newId } from "../lib/crypto.js";

/* ═══════════════════════════════════════════════════════════════════════
   Pays et vocabulaire administratif.

   Cette première version sert Madagascar. Ce que cette route rend possible n'est
   pas de servir plusieurs pays en même temps — cela demanderait de rattacher les
   sites, les bureaux et les comptes à un pays — mais de ne plus avoir Madagascar
   écrit dans le code. Ajouter le pays suivant devient un acte de configuration
   suivi d'un import de découpage, non une chasse aux libellés.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

const niveau = z.object({ one: z.string().trim().min(1).max(40),
                          many: z.string().trim().min(1).max(40) });
const schema = z.object({
  code: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/, "trois lettres, ISO 3166-1 alpha-3")
    .transform(v => v.toUpperCase()),
  name: z.string().trim().min(2).max(120),
  currency: z.string().trim().length(3).transform(v => v.toUpperCase()),
  /* Les cinq niveaux sont tous exigés : un pays dont on ne nommerait que trois
     niveaux laisserait deux écrans afficher « adm4 » sans qu'on sache pourquoi. */
  levels: z.object(Object.fromEntries(LEVELS.map(l => [l, niveau]))),
  lat: z.coerce.number().min(-90).max(90).nullish().transform(v => v ?? null),
  lon: z.coerce.number().min(-180).max(180).nullish().transform(v => v ?? null),
  note: z.string().trim().max(600).nullish().transform(v => v || null),
  active: z.boolean().default(true),
  rev: z.coerce.number().int().min(1).optional(),
});

const audit = (req, action, code, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','country',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, code, action, text);

r.get("/", (req, res) => res.json({
  rows: allCountries(), current: defaultCountry(),
  /* Les codes de niveaux du schéma, pour que l'écran de configuration sache
     lesquels nommer sans les redéclarer de son côté. */
  levels: LEVELS,
}));

r.post("/", requireCap("admin"), (req, res) => {
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"pays invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(db.prepare("SELECT 1 FROM country WHERE code=?").get(b.code))
    return res.status(409).json({ error:`le pays ${b.code} est déjà configuré` });
  db.prepare(`INSERT INTO country (code,name,currency,levels,lat,lon,note,active,updated_at)
              VALUES (?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(b.code, b.name, b.currency, JSON.stringify(b.levels), b.lat, b.lon, b.note, b.active?1:0);
  audit(req, "create", b.code, `Pays configuré — ${b.name} (${b.code}), devise ${b.currency}`);
  res.status(201).json({ country: allCountries().find(c => c.code === b.code) });
});

r.put("/:code", requireCap("admin"), (req, res) => {
  const cur = db.prepare("SELECT * FROM country WHERE code=?").get(req.params.code.toUpperCase());
  if(!cur) return res.status(404).json({ error:"pays introuvable" });
  const p = schema.safeParse({ ...req.body, code:cur.code });
  if(!p.success) return res.status(422).json({ error:"pays invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(b.rev && b.rev !== cur.rev)
    return res.status(409).json({ error:"ce pays a été modifié entre-temps" });
  /* Désactiver le pays courant laisserait l'application sans vocabulaire : on
     refuse plutôt que de rendre un repli qui afficherait « adm3 » partout. */
  if(!b.active && cur.is_current)
    return res.status(409).json({
      error:"le pays courant ne peut pas être désactivé : rendez d'abord un autre pays courant" });

  db.prepare(`UPDATE country SET name=?, currency=?, levels=?, lat=?, lon=?, note=?, active=?,
              rev=rev+1, updated_at=datetime('now') WHERE code=?`)
    .run(b.name, b.currency, JSON.stringify(b.levels), b.lat, b.lon, b.note, b.active?1:0, cur.code);
  audit(req, "update", cur.code, `Pays ${b.name} modifié — devise ${b.currency}`);
  res.json({ country: allCountries().find(c => c.code === cur.code) });
});

/* Définir le pays PAR DÉFAUT de l'instance : celui des comptes qui n'en déclarent
   aucun, et celui qu'un nouveau compte reçoit. Ce n'est plus « le pays courant » au
   sens où un utilisateur y travaille — cela, c'est `users.country_code`, et un
   compte non borné le change par l'en-tête X-MEMS-Country. Un drapeau global
   serait sinon un état partagé que deux comptes de deux pays se disputeraient. */
r.put("/:code/current", requireCap("admin"), (req, res) => {
  const c = db.prepare("SELECT * FROM country WHERE code=?").get(req.params.code.toUpperCase());
  if(!c) return res.status(404).json({ error:"pays introuvable" });
  if(!c.active) return res.status(409).json({ error:"ce pays est désactivé" });

  /* Chaque pays a son millésime courant : changer de pays n'y touche pas.
     Ma première version désactivait le millésime du pays quitté puis activait « le
     plus récemment importé » du pays rejoint. C'était faux : on peut avoir
     délibérément activé un millésime plus ancien parce que les données de l'année
     s'y raccrochent, et un aller-retour l'aurait remplacé sans le dire. */
  const actif = db.prepare("SELECT * FROM geo_version WHERE country=? AND is_current=1").get(c.code);
  const total = db.prepare("SELECT COUNT(*) n FROM geo_version WHERE country=?").get(c.code).n;
  db.transaction(() => {
    db.prepare("UPDATE country SET is_current=0 WHERE is_current=1").run();
    db.prepare("UPDATE country SET is_current=1 WHERE code=?").run(c.code);
  })();
  const millesimes = actif ? [actif] : [];
  audit(req, "update", c.code, `Pays courant : ${c.name}` +
    (actif ? ` — référentiel « ${actif.label} »`
           : total ? ` — ${total} découpage(s) chargé(s), aucun activé`
                   : " — aucun découpage chargé pour ce pays"));
  /* On rend le pays lu en base, non celui du contexte de la requête : ce dernier a
     été calculé au début de l'appel, donc avant le changement. */
  res.json({ current: defaultCountry(),
    referentiel: actif ? { id:actif.id, label:actif.label } : null,
    avertissement: actif ? null
      : total ? `${total} découpage(s) existent pour ce pays mais aucun n'est activé : choisissez-en un dans Localités.`
              : "Aucun découpage administratif n'est chargé pour ce pays : importez-en un avant de saisir." });
});

r.delete("/:code", requireCap("admin"), (req, res) => {
  const c = db.prepare("SELECT * FROM country WHERE code=?").get(req.params.code.toUpperCase());
  if(!c) return res.status(404).json({ error:"pays introuvable" });
  if(c.is_current) return res.status(409).json({ error:"le pays courant ne se supprime pas" });
  const v = db.prepare("SELECT COUNT(*) n FROM geo_version WHERE country=?").get(c.code).n;
  /* Un pays qui porte un découpage porte, à travers lui, des sites et des plans :
     la suppression en cascade effacerait des données par un geste de configuration. */
  if(v) return res.status(409).json({
    error:`ce pays porte ${v} millésime(s) de découpage ; désactivez-le plutôt`, versions:v });
  db.prepare("DELETE FROM country WHERE code=?").run(c.code);
  audit(req, "delete", c.code, `Pays retiré de la configuration — ${c.name}`);
  res.json({ ok:true });
});

export default r;
