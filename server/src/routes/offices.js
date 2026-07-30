import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { countryBound, countryClause, declaredFor, outsideDeclared, scopeOf, unitsIn } from "../lib/scope.js";
import { currentVersion } from "../lib/geo.js";
import { writeCountry } from "../lib/country.js";

/* ═══════════════════════════════════════════════════════════════════════
   Bureaux et antennes — configuration réelle.

   Jusqu'ici la table `offices` n'avait aucune route d'écriture : l'écran de
   configuration modifiait une liste de chaînes qui n'était jamais synchronisée.
   Un bureau ne se réduit d'ailleurs pas à son nom — il porte sa nature, son
   périmètre, ses antennes, son responsable — et il est référencé par les sites,
   les comptes, les paramètres de couverture et le plan de distribution. Le
   renommer par écrasement d'une liste ne pouvait donc pas fonctionner.

   Trois précautions structurent cette route :

     la lecture est ouverte à tous les comptes — l'application a besoin des noms
     de bureaux pour afficher un site ou filtrer un tableau ;
     l'écriture demande le droit d'administration ;
     la suppression est refusée si le bureau est référencé, plutôt que d'accepter
     le ON DELETE SET NULL du schéma qui détacherait silencieusement des sites.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

const S = (max) => z.string().trim().max(max).optional().nullable()
  .transform(v => (v === "" ? null : v ?? null));

const schema = z.object({
  name:       z.string().trim().min(2).max(120),
  code:       S(24),
  kind:       z.enum(["field", "hq"]).default("field"),
  /* Le pays de rattachement. Optionnel dans le schéma, mais pas facultatif : la
     route le résout, et un compte borné ne peut pas le choisir. */
  country_code: z.string().trim().length(3).optional().nullable()
    .transform(v => (v ? v.toUpperCase() : null)),
  /* 'national' fait sauter le cloisonnement géographique du bureau — d'où
     l'énumération stricte : une valeur libre finirait par élargir un accès. */
  scope_mode: z.enum(["geo", "national"]).default("geo"),
  antennes:   z.array(z.string().trim().max(80)).max(60).default([]),
  manager:    S(120),
  email:      S(160),
  phone:      S(40),
  lat:        z.number().min(-90).max(90).optional().nullable(),
  lon:        z.number().min(-180).max(180).optional().nullable(),
  note:       S(600),
  active:     z.boolean().default(true),
  rev:        z.number().int().min(1).optional(),
});

const audit = (req, action, id, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'securite','offices',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, id, action, text);

/* Ce qui référence un bureau. Sert deux fois : à informer l'écran de
   configuration, et à refuser une suppression destructrice. */
const usage = (id) => {
  const c = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE office_id=?`).get(id).c;
  return { sites:c("sites"), users:c("users"), params:c("coverage_params"),
           visits:c("visits"), pdd:c("pdd") };
};

const shape = (o) => {
  const v = currentVersion();
  const sc = scopeOf({ role:"editor", office_id:o.id });
  const hors = outsideDeclared(o.id);
  return {
    id:o.id, name:o.name, code:o.code || "", kind:o.kind, scope_mode:o.scope_mode || "geo",
    country_code:o.country_code || null, country:o.country_name || "",
    antennes: (() => { try{ return JSON.parse(o.antennes || "[]"); }catch(e){ return []; } })(),
    manager:o.manager || "", email:o.email || "", phone:o.phone || "",
    lat:o.lat, lon:o.lon, note:o.note || "", active:!!o.active, rev:o.rev || 1,
    /* Le périmètre effectif, calculé : c'est la seule réponse fiable à
       « ce bureau voit-il vraiment ce qu'on croit ? ». */
    scope: {
      source: sc.source,
      declared: declaredFor(o.id).length,
      communes: v ? unitsIn(sc, "adm3").length : 0,
      horsPerimetre: hors.declared ? { sites:hors.sites, pdd:hors.pdd } : null,
    },
    usage: usage(o.id),
  };
};

/* Le bureau introuvable et le bureau d'un autre pays donnent la MÊME réponse.
   Distinguer les deux apprendrait à un compte de Madagascar qu'un bureau existe
   ailleurs, et un identifiant se devine par essais. */
const lire = (id) => db.prepare(
  `SELECT o.*, p.name country_name FROM offices o
   LEFT JOIN country p ON p.code = o.country_code WHERE o.id=?`).get(id);

const visible = (req, id) => {
  const o = lire(id);
  if(!o) return null;
  const pays = countryBound(req.user);
  if(pays && o.country_code && o.country_code !== pays) return null;
  return o;
};

r.get("/", (req, res) => {
  const c = countryClause(req.user, "o");
  res.json({ offices: db.prepare(
    `SELECT o.*, p.name country_name FROM offices o
     LEFT JOIN country p ON p.code = o.country_code
     WHERE 1=1 ${c.sql} ORDER BY o.kind DESC, o.name`).all(...c.args).map(shape) });
});

r.post("/", requireCap("admin"), (req, res) => {
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"bureau invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  const pays = writeCountry(req.user, b.country_code);
  if(pays.error) return res.status(422).json({ error:pays.error });
  /* L'unicité du nom reste globale à l'instance et non par pays : deux bureaux
     homonymes dans deux pays rendraient tous les écrans de rattachement ambigus,
     et « Bureau de Tana » n'a de sens qu'une fois. */
  if(db.prepare("SELECT 1 FROM offices WHERE name=? COLLATE NOCASE").get(b.name))
    return res.status(409).json({ error:"un bureau porte déjà ce nom" });

  const id = newId("off");
  db.prepare(`INSERT INTO offices (id,name,code,kind,country_code,scope_mode,antennes,manager,email,
              phone,lat,lon,note,active,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
    .run(id, b.name, b.code, b.kind, pays.code, b.scope_mode, JSON.stringify(b.antennes),
         b.manager, b.email, b.phone, b.lat ?? null, b.lon ?? null, b.note, b.active?1:0);
  audit(req, "create", id, `Bureau créé — ${b.name} (${pays.code})` +
    (b.scope_mode === "national" ? " (périmètre national)" : ""));
  res.status(201).json({ office: shape(lire(id)) });
});

r.put("/:id", requireCap("admin"), (req, res) => {
  const cur = visible(req, req.params.id);
  if(!cur) return res.status(404).json({ error:"bureau introuvable" });
  const p = schema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"bureau invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;

  /* Verrouillage optimiste : même règle que les autres collections. On rend la
     valeur courante pour que l'écran puisse montrer ce qui a changé. */
  if(b.rev && b.rev !== (cur.rev || 1))
    return res.status(409).json({ error:"ce bureau a été modifié entre-temps",
      courant: shape(cur) });

  if(db.prepare("SELECT 1 FROM offices WHERE name=? COLLATE NOCASE AND id<>?").get(b.name, cur.id))
    return res.status(409).json({ error:"un bureau porte déjà ce nom" });

  /* Changer un bureau de pays emmènerait avec lui ses sites, son périmètre déclaré
     et ses comptes — or ce périmètre est fait de p-codes appartenant au découpage de
     l'ancien pays, qui ne veulent rien dire dans le nouveau. On l'autorise donc tant
     que rien n'est rattaché, et on refuse ensuite : créer le bureau du nouveau pays
     et y déplacer les données est un geste explicite, celui-ci ne l'était pas.
     Un compte borné ne change de toute façon rien : son pays est imposé. */
  const paysVoulu = countryBound(req.user) ? cur.country_code
                                           : (b.country_code || cur.country_code);
  if(paysVoulu !== cur.country_code){
    const u = { ...usage(cur.id), perimetre: declaredFor(cur.id).length };
    const total = Object.values(u).reduce((a, x) => a + x, 0);
    if(total) return res.status(409).json({
      error:"ce bureau porte des données : il ne peut pas changer de pays", usage:u });
    const v = writeCountry(null, paysVoulu);
    if(v.error) return res.status(422).json({ error:v.error });
  }

  /* Désactiver un bureau qui porte encore des comptes actifs les enfermerait :
     ils resteraient rattachés à un bureau inexistant du point de vue des
     filtres, sans que personne ne le voie. */
  if(!b.active && cur.active){
    const actifs = db.prepare("SELECT COUNT(*) c FROM users WHERE office_id=? AND active=1").get(cur.id).c;
    if(actifs) return res.status(409).json({
      error:`${actifs} compte(s) actif(s) dépendent de ce bureau : rattachez-les ailleurs d'abord` });
  }

  db.prepare(`UPDATE offices SET name=?, code=?, kind=?, country_code=?, scope_mode=?, antennes=?,
              manager=?, email=?, phone=?, lat=?, lon=?, note=?, active=?, rev=rev+1,
              updated_at=datetime('now') WHERE id=?`)
    .run(b.name, b.code, b.kind, paysVoulu, b.scope_mode, JSON.stringify(b.antennes), b.manager,
         b.email, b.phone, b.lat ?? null, b.lon ?? null, b.note, b.active?1:0, cur.id);

  const changements = [];
  if(b.name !== cur.name) changements.push(`renommé « ${cur.name} » → « ${b.name} »`);
  if(paysVoulu !== cur.country_code)
    changements.push(`rattaché au pays ${paysVoulu}`);
  if(b.scope_mode !== (cur.scope_mode || "geo"))
    changements.push(`périmètre ${b.scope_mode === "national" ? "porté au national" : "ramené au périmètre déclaré"}`);
  if(b.active !== !!cur.active) changements.push(b.active ? "réactivé" : "désactivé");
  audit(req, "update", cur.id, `Bureau ${b.name}` +
    (changements.length ? ` — ${changements.join(", ")}` : " modifié"));

  res.json({ office: shape(lire(cur.id)) });
});

r.delete("/:id", requireCap("admin"), (req, res) => {
  const cur = visible(req, req.params.id);
  if(!cur) return res.status(404).json({ error:"bureau introuvable" });
  const u = usage(cur.id);
  const total = Object.values(u).reduce((a,b)=>a+b, 0);
  /* Le schéma détacherait les lignes (ON DELETE SET NULL) : des sites sans
     bureau, invisibles de tous les filtres. On refuse et on propose la
     désactivation, qui conserve l'historique. */
  if(total) return res.status(409).json({
    error:"ce bureau est encore référencé ; désactivez-le plutôt que de le supprimer",
    usage:u });
  db.prepare("DELETE FROM offices WHERE id=?").run(cur.id);
  audit(req, "delete", cur.id, `Bureau supprimé — ${cur.name}`);
  res.json({ ok:true });
});

export default r;
