import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap, can } from "../lib/auth.js";
import { isNational, officeBound, tpmBound } from "../lib/scope.js";
import { currentVersion } from "../lib/geo.js";
import { localCurrency } from "../lib/country.js";
import { contractBalance, contractZones, contractZoneSet, lineTotal, modifiable, niveauAttendu,
         planAmount, planDetail, regenerate, suggestZones, TRANSITIONS,
         zoneDansPerimetre } from "../lib/tpm.js";

/* ═══════════════════════════════════════════════════════════════════════
   Suivi tiers — contrats, affectation, budget, validation, dépenses.

   Le circuit décide de presque tout dans cette route. Trois niveaux successifs,
   et chacun ne peut être franchi que par quelqu'un qui a le droit de le
   franchir :

     tpm     le responsable du prestataire  — un compte rattaché à ce TPM
     bureau  le suivi-évaluation du bureau  — un compte du bureau, droit de valider
     pays    le suivi-évaluation pays       — un compte à périmètre national

   Le troisième niveau s'appuie sur le `scope_mode` des bureaux : « responsable
   suivi-évaluation du bureau pays » n'est pas un rôle, c'est un compte du bureau
   pays. C'est exactement ce que la migration 009 a rendu exprimable, et il n'y
   avait donc pas de nouveau rôle à créer.

   Le plafond contractuel est vérifié au dernier niveau, pas au premier : tant que
   le plan circule il n'engage rien. Le vérifier trop tôt bloquerait des plans qui
   ne dépassent finalement pas, le vérifier trop tard laisserait engager
   au-delà du contrat.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();
const S = (max) => z.string().trim().max(max).nullish().transform(v => (v ? v : null));

const audit = async (req, entity, id, action, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'plan',?,?,?,?)`)
    .run(newId("aud"), req.user.id, `${req.user.first_name||""} ${req.user.last_name||""}`.trim()
         || req.user.email, req.user.office_id || "", entity, id, action, text);

const label = (u) => `${u.first_name||""} ${u.last_name||""}`.trim() || u.email;

/* ── Prestataires ────────────────────────────────────────────────────
   Un compte rattaché à un prestataire ne voit que le sien. La règle vient de
   lib/scope.js et s'applique avant toute autre : c'est un intervenant externe. */
const visibleTpm = async (req) => {
  const mien = tpmBound(req.user);
  if(mien) return { sql:" AND t.id = ?", args:[mien] };
  const bureau = await officeBound(req.user);
  /* Un bureau voit les prestataires qui lui sont rattachés et ceux qui ne le sont
     à aucun bureau — un TPM national travaille pour tout le monde. */
  if(bureau) return { sql:" AND (t.office_id = ? OR t.office_id IS NULL)", args:[bureau] };
  return { sql:"", args:[] };
};

r.get("/", async (req, res) => {
  const v = await visibleTpm(req);
  const rows = await db.prepare(`
    SELECT t.*, o.name office_name FROM tpm t
    LEFT JOIN offices o ON o.id = t.office_id
    WHERE 1=1 ${v.sql} ORDER BY t.name`).all(...v.args);
  res.json({ rows: await Promise.all(rows.map(async t => {
    const contratsRaw = await db.prepare("SELECT * FROM tpm_contract WHERE tpm_id=? ORDER BY ref").all(t.id);
    const contrats = await Promise.all(contratsRaw.map(async c => ({ id:c.id, ref:c.ref, currency:c.currency, status:c.status,
        start_date:c.start_date, end_date:c.end_date, note:c.note || "", rev:c.rev,
        solde: await contractBalance(c.id),
        /* Le périmètre géographique confié par ce contrat — ce que le détail
           montre comme « communes/districts affectés », et ce dans quoi ses
           plans mensuels pourront puiser. */
        zones: await contractZones(c.id),
        rates: (await db.prepare("SELECT * FROM tpm_rate WHERE contract_id=? ORDER BY sort, label")
          .all(c.id)).map(x => ({ id:x.id, driver:x.driver, label:x.label, unit:x.unit || "",
            unit_cost:x.unit_cost, active:!!x.active, sort:x.sort })),
        amendments: (await db.prepare("SELECT * FROM tpm_amendment WHERE contract_id=? ORDER BY signed_at, id")
          .all(c.id)).map(a => ({ id:a.id, ref:a.ref || "", delta:a.delta, reason:a.reason,
            signed_at:a.signed_at })),
      })));
    return { id:t.id, name:t.name, code:t.code || "", office_id:t.office_id,
      office:t.office_name || "", contact:t.contact || "", email:t.email || "",
      phone:t.phone || "", note:t.note || "", active:!!t.active, rev:t.rev,
      users: (await db.prepare("SELECT COUNT(*) c FROM users WHERE tpm_id=?").get(t.id)).c,
      contrats };
  })) });
});

const tpmSchema = z.object({
  name: z.string().trim().min(2).max(120), code:S(24), office_id:S(64),
  contact:S(120), email:S(160), phone:S(40), note:S(600),
  active: z.boolean().default(true), rev: z.coerce.number().int().min(1).optional(),
});

r.post("/", requireCap("admin"), async (req, res) => {
  const p = tpmSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"prestataire invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  if(await db.prepare("SELECT 1 FROM tpm WHERE lower(name)=lower(?)").get(p.data.name))
    return res.status(409).json({ error:"un prestataire porte déjà ce nom" });
  const id = newId("tpm"); const b = p.data;
  await db.prepare(`INSERT INTO tpm (id,name,code,office_id,contact,email,phone,note,active,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,now())`)
    .run(id, b.name, b.code, b.office_id, b.contact, b.email, b.phone, b.note, b.active?1:0);
  await audit(req, "tpm", id, "create", `Prestataire de suivi créé — ${b.name}`);
  res.status(201).json({ ok:true, id });
});

r.put("/:id", requireCap("admin"), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM tpm WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"prestataire introuvable" });
  const p = tpmSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"prestataire invalide" });
  const b = p.data;
  if(b.rev && b.rev !== cur.rev)
    return res.status(409).json({ error:"ce prestataire a été modifié entre-temps" });
  if(await db.prepare("SELECT 1 FROM tpm WHERE lower(name)=lower(?) AND id<>?").get(b.name, cur.id))
    return res.status(409).json({ error:"un prestataire porte déjà ce nom" });
  await db.prepare(`UPDATE tpm SET name=?, code=?, office_id=?, contact=?, email=?, phone=?,
              note=?, active=?, rev=rev+1, updated_at=now() WHERE id=?`)
    .run(b.name, b.code, b.office_id, b.contact, b.email, b.phone, b.note, b.active?1:0, cur.id);
  await audit(req, "tpm", cur.id, "update", `Prestataire modifié — ${b.name}`);
  res.json({ ok:true });
});

r.delete("/:id", requireCap("admin"), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM tpm WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"prestataire introuvable" });
  const plans = (await db.prepare("SELECT COUNT(*) c FROM tpm_plan WHERE tpm_id=?").get(cur.id)).c;
  const comptes = (await db.prepare("SELECT COUNT(*) c FROM users WHERE tpm_id=?").get(cur.id)).c;
  /* Un prestataire porteur de plans validés est une pièce du dossier budgétaire :
     le supprimer effacerait des montants engagés en cascade. */
  if(plans || comptes) return res.status(409).json({
    error:"ce prestataire porte des plans ou des comptes ; désactivez-le plutôt",
    usage:{ plans, comptes } });
  await db.prepare("DELETE FROM tpm WHERE id=?").run(cur.id);
  await audit(req, "tpm", cur.id, "delete", `Prestataire supprimé — ${cur.name}`);
  res.json({ ok:true });
});

/* ── Contrats, avenants, barème ──────────────────────────────────────
   Le plafond initial ne se modifie pas : la route l'accepte à la création et
   l'ignore ensuite. Un plafond corrigé en place effacerait la raison du
   changement, et le suivi budgétaire d'un contrat amendé n'aurait plus de sens. */
const contractSchema = z.object({
  tpm_id: z.string().min(1).max(64), ref: z.string().trim().min(1).max(60),
  ceiling: z.coerce.number().min(0).max(1e12).default(0),
  /* Pas de valeur par défaut ici : « MGA » était le vocabulaire de Madagascar
     inscrit dans le code. La devise locale vient de la configuration du pays, et
     elle est résolue à l'écriture — un défaut de schéma serait figé au chargement
     du module, donc avant que le pays courant soit connu. */
  currency: z.string().trim().length(3).optional(),
  start_date:S(10), end_date:S(10),
  /* Le cycle de vie du contrat (migration 040). Un contrat naît « draft » ;
     « validated » est le seul état opérationnel — celui qui reçoit des plans. */
  status: z.enum(["draft","submitted","validated","canceled","template"]).default("draft"),
  note:S(600), rev: z.coerce.number().int().min(1).optional(),
});

/* Le vocabulaire du cycle, pour les libellés et les gestes. Exposé au client via
   le référentiel des plans (GET /plans) pour que l'écran n'ait pas à le redéfinir. */
export const CONTRACT_STATUSES = ["draft","submitted","validated","canceled","template"];
const CONTRACT_STATUS_LABEL = {
  draft:"Brouillon", submitted:"Soumis", validated:"Validé",
  canceled:"Annulé", template:"Modèle",
};

r.post("/contracts", requireCap("admin"), async (req, res) => {
  const p = contractSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"contrat invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(!(await db.prepare("SELECT 1 FROM tpm WHERE id=?").get(b.tpm_id)))
    return res.status(404).json({ error:"prestataire introuvable" });
  if(await db.prepare("SELECT 1 FROM tpm_contract WHERE tpm_id=? AND ref=?").get(b.tpm_id, b.ref))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ce prestataire` });
  if(b.start_date && b.end_date && b.end_date < b.start_date)
    return res.status(422).json({ error:"la date de fin précède la date de début" });
  const id = newId("tct");
  const devise = b.currency || await localCurrency();
  await db.prepare(`INSERT INTO tpm_contract (id,tpm_id,ref,ceiling,currency,start_date,end_date,
              status,note,updated_at) VALUES (?,?,?,?,?,?,?,?,?,now())`)
    .run(id, b.tpm_id, b.ref, b.ceiling, devise, b.start_date, b.end_date, b.status, b.note);
  await audit(req, "tpm_contract", id, "create",
    `Contrat ${b.ref} — plafond ${b.ceiling} ${devise}`);
  res.status(201).json({ ok:true, id });
});

r.put("/contracts/:id", requireCap("admin"), async (req, res) => {
  const cur = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!cur) return res.status(404).json({ error:"contrat introuvable" });
  const p = contractSchema.safeParse({ ...req.body, tpm_id:cur.tpm_id });
  if(!p.success) return res.status(422).json({ error:"contrat invalide" });
  const b = p.data;
  if(b.rev && b.rev !== cur.rev)
    return res.status(409).json({ error:"ce contrat a été modifié entre-temps" });
  if(await db.prepare("SELECT 1 FROM tpm_contract WHERE tpm_id=? AND ref=? AND id<>?")
      .get(cur.tpm_id, b.ref, cur.id))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ce prestataire` });
  /* Le plafond n'est pas dans la mise à jour, volontairement. */
  await db.prepare(`UPDATE tpm_contract SET ref=?, currency=?, start_date=?, end_date=?, status=?,
              note=?, rev=rev+1, updated_at=now() WHERE id=?`)
    .run(b.ref, b.currency || cur.currency, b.start_date, b.end_date, b.status, b.note, cur.id);
  await audit(req, "tpm_contract", cur.id, "update", `Contrat ${b.ref} modifié`);
  res.json({ ok:true, avertissement: b.ceiling !== cur.ceiling
    ? "Le plafond ne se modifie pas en place : passez par un avenant."
    : undefined });
});

r.post("/contracts/:id/amendments", requireCap("admin"), async (req, res) => {
  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  const p = z.object({ ref:S(60), delta: z.coerce.number().refine(v => v !== 0,
      "un avenant à zéro ne change rien"),
    reason: z.string().trim().min(3).max(500), signed_at:S(10) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"avenant invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  const solde = await contractBalance(c.id);
  /* Un avenant à la baisse ne peut pas passer sous ce qui est déjà engagé :
     l'argent est promis, le réduire après coup rendrait le contrat incohérent. */
  if(b.delta < 0 && solde.plafond + b.delta < solde.engage)
    return res.status(409).json({
      error:`cet avenant ramènerait le plafond sous les ${solde.engage} ${c.currency} déjà engagés`,
      solde });
  const id = newId("tam");
  await db.prepare(`INSERT INTO tpm_amendment (id,contract_id,ref,delta,reason,signed_at,created_by)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, c.id, b.ref, b.delta, b.reason, b.signed_at, req.user.id);
  await audit(req, "tpm_contract", c.id, "update",
    `Avenant ${b.ref || ""} au contrat ${c.ref} : ${b.delta > 0 ? "+" : ""}${b.delta} ${c.currency} — ${b.reason}`);
  res.status(201).json({ ok:true, id, solde: await contractBalance(c.id) });
});

/* ── Le cycle de vie du contrat ──────────────────────────────────────
   Changer le statut est un geste à part, distinct de la modification des champs :
   c'est ce que la liste ligne à ligne propose en un clic. La seule règle dure —
   un contrat qui porte des plans ne peut pas quitter « validé », sinon ces plans
   perdraient le contrat sur lequel ils reposent. « Modèle » est un brouillon
   sauvegardé : on le range là, on le duplique ensuite pour repartir d'une base. */
r.put("/contracts/:id/status", requireCap("admin"), async (req, res) => {
  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  const p = z.object({ status: z.enum(CONTRACT_STATUSES) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"statut invalide" });
  const nouveau = p.data.status;
  if(nouveau === c.status) return res.json({ ok:true, status:nouveau });

  if(c.status === "validated" && nouveau !== "validated"){
    const plans = (await db.prepare("SELECT COUNT(*) c FROM tpm_plan WHERE contract_id=?").get(c.id)).c;
    if(plans) return res.status(409).json({
      error:`ce contrat porte ${plans} plan(s) : il ne peut quitter « validé » sans les laisser sans contrat. `
        + "Clôturez ou supprimez d'abord les plans concernés." });
  }
  await db.prepare("UPDATE tpm_contract SET status=?, rev=rev+1, updated_at=now() WHERE id=?")
    .run(nouveau, c.id);
  await audit(req, "tpm_contract", c.id, "update",
    `Contrat ${c.ref} : ${CONTRACT_STATUS_LABEL[c.status] || c.status} → ${CONTRACT_STATUS_LABEL[nouveau]}`);
  res.json({ ok:true, status:nouveau });
});

/* Dupliquer un contrat — le geste qui rend un « modèle » utile : on repart de sa
   base (plafond, devise, période, barème, périmètre) plutôt que d'une page
   blanche. La copie naît « draft », avec une référence dérivée, et sans avenants
   ni plans : ceux-là appartiennent à l'original, pas au modèle. */
r.post("/contracts/:id/clone", requireCap("admin"), async (req, res) => {
  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  /* Une référence libre parmi « <ref> (copie) », « <ref> (copie 2) »… */
  let ref = `${c.ref} (copie)`;
  for(let i = 2; await db.prepare("SELECT 1 FROM tpm_contract WHERE tpm_id=? AND ref=?").get(c.tpm_id, ref); i++)
    ref = `${c.ref} (copie ${i})`;

  const id = newId("tct");
  await tx(async (db) => {
    await db.prepare(`INSERT INTO tpm_contract (id,tpm_id,ref,ceiling,currency,start_date,end_date,
                status,note,updated_at) VALUES (?,?,?,?,?,?,?,'draft',?,now())`)
      .run(id, c.tpm_id, ref, c.ceiling, c.currency, c.start_date, c.end_date, c.note);
    const rates = await db.prepare("SELECT * FROM tpm_rate WHERE contract_id=?").all(c.id);
    const insR = db.prepare(`INSERT INTO tpm_rate (id,contract_id,driver,label,unit,unit_cost,active,sort)
                             VALUES (?,?,?,?,?,?,?,?)`);
    for(const x of rates) await insR.run(newId("trt"), id, x.driver, x.label, x.unit, x.unit_cost, x.active, x.sort);
    const zones = await db.prepare("SELECT geo_pcode FROM tpm_contract_zone WHERE contract_id=?").all(c.id);
    const insZ = db.prepare("INSERT INTO tpm_contract_zone (contract_id,geo_pcode) VALUES (?,?)");
    for(const zn of zones) await insZ.run(id, zn.geo_pcode);
  });
  await audit(req, "tpm_contract", id, "create", `Contrat ${ref} dupliqué depuis ${c.ref}`);
  res.status(201).json({ ok:true, id, ref });
});

/* ── Le périmètre géographique du contrat ────────────────────────────
   Les communes (ou districts) que le contrat confie au prestataire. Défini à la
   conception du contrat ; les plans mensuels n'y puisent ensuite que ce qui leur
   est ouvert (voir PUT /plans/:id/zones). */
r.get("/contracts/:id/zones", async (req, res) => {
  const c = await db.prepare("SELECT id FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  res.json({ zones: await contractZones(c.id) });
});

/* Remplacé en bloc, comme le barème : l'écran a le périmètre entier sous les
   yeux. On n'admet que des unités du référentiel courant ; le niveau (district
   ou commune) est libre — assigner un district ouvrira toutes ses communes. */
r.put("/contracts/:id/zones", requireCap("admin"), async (req, res) => {
  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  const p = z.object({ zones: z.array(z.string().trim().min(1).max(64)).max(3000) })
    .safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"périmètre invalide" });

  const v = await currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant" });
  const connus = new Set((await db.prepare(
    "SELECT pcode FROM geo_unit WHERE version_id=?").all(v.id)).map(x => x.pcode));
  const pcodes = [...new Set(p.data.zones)];          /* dédoublonnés */
  const inconnus = pcodes.filter(pc => !connus.has(pc));
  if(inconnus.length) return res.status(422).json({
    error:"certaines unités sont absentes du référentiel courant",
    details: inconnus.slice(0, 10).map(pc => ({ champ:"geo_pcode", message:pc })) });

  await tx(async (db) => {
    await db.prepare("DELETE FROM tpm_contract_zone WHERE contract_id=?").run(c.id);
    const ins = db.prepare("INSERT INTO tpm_contract_zone (contract_id,geo_pcode) VALUES (?,?)");
    for(const pc of pcodes) await ins.run(c.id, pc);
  });
  const zones = await contractZones(c.id);
  await audit(req, "tpm_contract", c.id, "update",
    `Périmètre du contrat ${c.ref} : ${zones.length} zone(s) éligible(s)`);
  res.json({ ok:true, zones });
});

/* Le barème, remplacé en bloc : c'est une grille tarifaire, on la relit et on la
   réécrit d'un tenant. Les plans déjà validés ne sont pas recalculés — leurs
   lignes portent le coût unitaire du jour où ils ont été montés. */
r.put("/contracts/:id/rates", requireCap("admin"), async (req, res) => {
  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(req.params.id);
  if(!c) return res.status(404).json({ error:"contrat introuvable" });
  const p = z.object({ rates: z.array(z.object({
    driver: z.enum(["superviseur","agent","vehicule","carburant","forfait"]).default("forfait"),
    label: z.string().trim().min(1).max(120), unit:S(40),
    unit_cost: z.coerce.number().min(0).max(1e10).default(0),
    active: z.boolean().default(true), sort: z.coerce.number().int().min(0).max(999).default(0),
  })).max(80) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"barème invalide" });

  await tx(async (db) => {
    await db.prepare("DELETE FROM tpm_rate WHERE contract_id=?").run(c.id);
    const ins = db.prepare(`INSERT INTO tpm_rate (id,contract_id,driver,label,unit,unit_cost,active,sort)
                            VALUES (?,?,?,?,?,?,?,?)`);
    for(const [i, x] of p.data.rates.entries())
      await ins.run(newId("trt"), c.id, x.driver, x.label, x.unit,
        x.unit_cost, x.active?1:0, x.sort || i);
  });
  /* Les plans encore modifiables suivent le nouveau barème : ils ne sont pas
     engagés, et laisser un brouillon sur l'ancienne grille tromperait son auteur. */
  const touches = await db.prepare(
    `SELECT id FROM tpm_plan WHERE contract_id=? AND status IN ('brouillon','renvoye')`).all(c.id);
  for(const pl of touches) await regenerate(pl.id);
  await audit(req, "tpm_contract", c.id, "update",
    `Barème du contrat ${c.ref} : ${p.data.rates.length} ligne(s)${touches.length?`, ${touches.length} brouillon(s) recalculé(s)`:""}`);
  res.json({ ok:true, recalcules: touches.length });
});

/* ── Plans mensuels ──────────────────────────────────────────────────*/
async function visiblePlans(req, f){
  const where = []; const args = [];
  const mien = tpmBound(req.user);
  if(mien){ where.push("p.tpm_id = ?"); args.push(mien); }
  else {
    const bureau = await officeBound(req.user);
    if(bureau){ where.push("(t.office_id = ? OR t.office_id IS NULL)"); args.push(bureau); }
    if(f.tpm_id){ where.push("p.tpm_id = ?"); args.push(f.tpm_id); }
  }
  if(f.year   != null){ where.push("p.year = ?");   args.push(f.year); }
  if(f.month  != null){ where.push("p.month = ?");  args.push(f.month); }
  if(f.status){ where.push("p.status = ?"); args.push(f.status); }
  return (await db.prepare(`SELECT p.id FROM tpm_plan p JOIN tpm t ON t.id = p.tpm_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.year DESC, p.month DESC, t.name`).all(...args)).map(x => x.id);
}

/* Le plan est-il accessible à l'appelant, et en lecture ou en écriture ? */
async function reachable(req, id){
  const p = await db.prepare(`SELECT p.*, t.office_id tpm_office FROM tpm_plan p
    JOIN tpm t ON t.id = p.tpm_id WHERE p.id = ?`).get(id);
  if(!p) return { error:"plan introuvable", status:404 };
  const mien = tpmBound(req.user);
  if(mien && p.tpm_id !== mien)
    return { error:"ce plan relève d'un autre prestataire", status:403 };
  const bureau = await officeBound(req.user);
  if(!mien && bureau && p.tpm_office && p.tpm_office !== bureau)
    return { error:"ce prestataire relève d'un autre bureau", status:403 };
  return { plan:p };
}

r.get("/plans", async (req, res) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    month: z.coerce.number().int().min(0).max(11).optional(),
    tpm_id: z.string().max(64).optional(),
    status: z.string().max(20).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });

  const ids = await visiblePlans(req, q.data);
  const rows = (await Promise.all(ids.map(id => planDetail(id)))).filter(Boolean);
  /* Ce que l'appelant peut faire maintenant, par plan : l'écran n'a pas à
     redéduire le circuit, il le redéduirait autrement. */
  for(const p of rows) p.actions = await actionsFor(req, p);

  const devises = [...new Set(rows.map(p => p.currency))];
  const somme = (xs, k) => Math.round(xs.reduce((t, x) => t + (x[k] || 0), 0) * 100) / 100;
  const engages = rows.filter(p => ["valide_pays","cloture"].includes(p.status));
  res.json({
    rows,
    totals: {
      plans: rows.length,
      budget: somme(rows, "budget"),
      engage: somme(engages, "budget"),
      depense: somme(rows.filter(p => p.spent != null), "spent"),
      enAttente: rows.filter(p => niveauAttendu(p.status)).length,
      currency: devises.length === 1 ? devises[0] : null,
      devises,
    },
    /* Ma file d'attente : les plans que je peux valider tout de suite. */
    aValider: rows.filter(p => p.actions.valider).map(p => p.id),
    referentiel: { transitions: TRANSITIONS,
      contractStatuses: CONTRACT_STATUSES.map(s => ({ value:s, label:CONTRACT_STATUS_LABEL[s] })) },
  });
});

r.get("/plans/:id", async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const p = await planDetail(g.plan.id);
  p.actions = await actionsFor(req, p);
  p.solde = await contractBalance(g.plan.contract_id);
  /* Le périmètre du contrat, pour que l'éditeur de zones borne son sélecteur aux
     communes éligibles plutôt que d'offrir tout le référentiel. */
  p.eligibleZones = await contractZones(g.plan.contract_id);
  res.json({ plan:p });
});

/* Ce que l'appelant a le droit de faire sur ce plan, dans son état actuel.
   Une seule définition, utilisée par la lecture et vérifiée à l'écriture. */
async function actionsFor(req, p){
  const niveau = niveauAttendu(p.status);
  return {
    modifier: modifiable(p.status) && can(req.user, "edit") && await peutEditer(req, p),
    soumettre: modifiable(p.status) && can(req.user, "edit") && await peutEditer(req, p) && p.budget > 0,
    valider: !!niveau && await peutValider(req, p, niveau),
    niveau,
    niveauLabel: niveau ? TRANSITIONS[niveau].label : "",
    depenser: ["valide_pays","cloture"].includes(p.status) && can(req.user, "edit"),
  };
}

/* Qui peut monter le plan : le prestataire lui-même, ou le bureau pour lui.
   Les deux arrivent — un TPM sans accès à l'outil fait remplir son plan par le
   bureau, et le refuser figerait le module dans un seul mode de fonctionnement. */
async function peutEditer(req, p){
  const mien = tpmBound(req.user);
  if(mien) return mien === p.tpm_id;
  const bureau = await officeBound(req.user);
  return !bureau || !p.office_id || bureau === p.office_id;
}

/* Qui peut franchir un niveau donné. C'est le cœur du module. */
async function peutValider(req, p, niveau){
  const mien = tpmBound(req.user);
  if(niveau === "tpm"){
    /* Le responsable du prestataire. Un administrateur du bureau peut aussi le
       faire — sinon un TPM sans compte bloquerait tout le circuit — mais c'est
       tracé comme tel dans le journal de validation. */
    return (mien && mien === p.tpm_id && can(req.user, "edit")) || can(req.user, "admin");
  }
  /* Les deux niveaux suivants sont internes : un compte du prestataire n'y a
     jamais accès, quel que soit son rôle. C'est la raison d'être du cloisonnement
     par prestataire. */
  if(mien) return false;
  if(!can(req.user, "validate")) return false;
  if(niveau === "bureau"){
    const bureau = await officeBound(req.user);
    /* Un compte non borné (administrateur, ou bureau national) peut valider pour
       n'importe quel bureau ; un compte de terrain, seulement pour le sien. */
    return !bureau || !p.office_id || bureau === p.office_id;
  }
  /* Niveau pays : réservé au bureau pays. Le `scope_mode` national est le critère,
     pas le rôle — c'est précisément ce que la configuration des bureaux exprime. */
  return can(req.user, "admin") || (req.user.office_id && await isNational(req.user.office_id));
}

r.post("/plans", requireCap("edit"), async (req, res) => {
  const p = z.object({
    tpm_id: z.string().min(1).max(64), contract_id: z.string().min(1).max(64),
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(0).max(11),
    ref:S(60), note:S(600),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"plan invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  const mien = tpmBound(req.user);
  if(mien) b.tpm_id = mien;

  const c = await db.prepare("SELECT * FROM tpm_contract WHERE id=? AND tpm_id=?")
    .get(b.contract_id, b.tpm_id);
  if(!c) return res.status(404).json({ error:"contrat introuvable pour ce prestataire" });
  if(c.status !== "validated") return res.status(409).json({
    error:`le contrat ${c.ref} est « ${CONTRACT_STATUS_LABEL[c.status] || c.status} » : `
      + "seul un contrat validé peut recevoir des plans" });
  if(await db.prepare("SELECT 1 FROM tpm_plan WHERE tpm_id=? AND year=? AND month=?")
      .get(b.tpm_id, b.year, b.month))
    return res.status(409).json({ error:"un plan existe déjà pour ce prestataire et ce mois" });

  const id = newId("tpp");
  await db.prepare(`INSERT INTO tpm_plan (id,tpm_id,contract_id,year,month,ref,note,created_by,updated_at)
              VALUES (?,?,?,?,?,?,?,?,now())`)
    .run(id, b.tpm_id, b.contract_id, b.year, b.month, b.ref, b.note, req.user.id);
  await audit(req, "tpm_plan", id, "create",
    `Plan de suivi tiers créé — ${c.ref}, ${b.year}-${String(b.month+1).padStart(2,"0")}`);
  res.status(201).json({ ok:true, id, plan: await planDetail(id) });
});

/* Les zones affectées, remplacées en bloc, et les lignes dérivées régénérées.
   Le remplacement global est légitime : l'unité d'édition est le plan du mois,
   l'utilisateur a ses zones sous les yeux, et le plan n'est modifiable que tant
   qu'il n'est pas soumis. */
r.put("/plans/:id/zones", requireCap("edit"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const plan = g.plan;
  if(!modifiable(plan.status)) return res.status(409).json({
    error:`ce plan est « ${plan.status} » : il n'est plus modifiable` });
  if(!(await peutEditer(req, { tpm_id:plan.tpm_id, office_id:plan.tpm_office })))
    return res.status(403).json({ error:"vous ne pouvez pas modifier ce plan" });

  const p = z.object({ rev: z.coerce.number().int().min(1).optional(),
    zones: z.array(z.object({
      geo_pcode: z.string().min(1).max(64), activity_tag:S(20), team_label:S(80),
      supervisors: z.coerce.number().int().min(0).max(500).default(1),
      agents: z.coerce.number().int().min(0).max(500).default(1),
      days: z.coerce.number().int().min(0).max(31).default(1),
      travel_days: z.coerce.number().int().min(0).max(31).default(0),
      vehicles: z.coerce.number().int().min(0).max(100).default(0),
      fuel_litres: z.coerce.number().min(0).max(100000).default(0),
      sites: z.coerce.number().int().min(0).max(10000).default(0),
      note:S(300),
    })).max(300) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"affectation invalide",
    details:p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  if(p.data.rev && p.data.rev !== plan.rev)
    return res.status(409).json({ error:"ce plan a été modifié entre-temps",
      courant: await planDetail(plan.id) });

  const v = await currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant" });
  /* Le chemin matérialisé de chaque unité sert à décider de l'appartenance au
     périmètre du contrat (une commune sous un district affecté est éligible). */
  const chemins = Object.fromEntries((await db.prepare(
    "SELECT pcode, path FROM geo_unit WHERE version_id=?").all(v.id)).map(x => [x.pcode, x.path]));
  const inconnus = p.data.zones.filter(z => !(z.geo_pcode in chemins));
  if(inconnus.length) return res.status(422).json({
    error:"certaines zones sont absentes du référentiel courant",
    details:inconnus.slice(0,10).map(z => ({ champ:"geo_pcode", message:z.geo_pcode })) });

  /* Le périmètre du contrat : les plans n'y puisent que ce qui leur est ouvert.
     Un périmètre vide ne borne rien (le contrat n'a pas déclaré ses zones). Sinon
     chaque zone doit tomber dans une commune/district éligible — sans quoi le
     refus NOMME les zones hors périmètre, pour qu'on sache lesquelles retirer. */
  const eligible = await contractZoneSet(plan.contract_id);
  const horsPerimetre = p.data.zones.filter(
    z => !zoneDansPerimetre(z.geo_pcode, chemins[z.geo_pcode], eligible));
  if(horsPerimetre.length) return res.status(422).json({
    error:"certaines zones sont hors du périmètre géographique du contrat ; "
      + "elles doivent faire partie des communes (ou districts) que le contrat confie au prestataire",
    details:horsPerimetre.slice(0,10).map(z => ({ champ:"geo_pcode", message:z.geo_pcode })) });
  /* Deux fois la même zone pour la même activité, c'est un doublon de saisie —
     et le budget serait compté deux fois sans que rien ne le signale. */
  const clés = p.data.zones.map(z => z.geo_pcode + "|" + (z.activity_tag || ""));
  const dup = clés.find((k, i) => clés.indexOf(k) !== i);
  if(dup) return res.status(422).json({
    error:`la zone ${dup.split("|")[0]} apparaît deux fois pour la même activité` });

  await tx(async (db) => {
    /* Les lignes dérivées partent avec leur zone (ON DELETE CASCADE) ; les lignes
       saisies rattachées à une zone disparue aussi, ce qui est voulu. */
    await db.prepare("DELETE FROM tpm_zone WHERE plan_id=?").run(plan.id);
    const ins = db.prepare(`INSERT INTO tpm_zone (id,plan_id,geo_pcode,activity_tag,team_label,
      supervisors,agents,days,travel_days,vehicles,fuel_litres,sites,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const z of p.data.zones)
      await ins.run(newId("tpz"), plan.id, z.geo_pcode, z.activity_tag, z.team_label,
        z.supervisors, z.agents, z.days, z.travel_days, z.vehicles, z.fuel_litres,
        z.sites, z.note);
    /* On passe CE client de transaction à regenerate : son DELETE+INSERT sur
       tpm_line reste ainsi atomique avec le reste du bloc (même connexion, même
       ROLLBACK), ce que le pool par défaut ne garantirait pas. */
    await regenerate(plan.id, db);
    await db.prepare("UPDATE tpm_plan SET rev=rev+1, updated_at=now() WHERE id=?").run(plan.id);
  });

  const d = await planDetail(plan.id);
  await audit(req, "tpm_plan", plan.id, "update",
    `Affectation : ${p.data.zones.length} zone(s), budget ${d.budget} ${d.currency}`);
  res.json({ plan:d });
});

/* Les lignes de budget, ajustables. Une ligne modifiée perd son caractère dérivé
   et ne sera plus recalculée — sinon l'ajustement serait effacé au prochain
   changement d'affectation, ce qui est la pire des deux issues. */
r.put("/plans/:id/lines", requireCap("edit"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const plan = g.plan;
  if(!modifiable(plan.status)) return res.status(409).json({
    error:`ce plan est « ${plan.status} » : il n'est plus modifiable` });

  const p = z.object({ rev: z.coerce.number().int().min(1).optional(),
    lines: z.array(z.object({
      zone_id:S(64),
      driver: z.enum(["superviseur","agent","vehicule","carburant","forfait"]).default("forfait"),
      label: z.string().trim().min(1).max(120), unit:S(40),
      qty1: z.coerce.number().min(0).max(1e6).default(1),
      qty2: z.coerce.number().min(0).max(1e6).default(1),
      unit_cost: z.coerce.number().min(0).max(1e10).default(0),
      derived: z.boolean().default(false),
    })).max(600) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"lignes invalides",
    details:p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  if(p.data.rev && p.data.rev !== plan.rev)
    return res.status(409).json({ error:"ce plan a été modifié entre-temps",
      courant: await planDetail(plan.id) });

  const zones = new Set((await db.prepare("SELECT id FROM tpm_zone WHERE plan_id=?")
    .all(plan.id)).map(z => z.id));
  const orphelines = p.data.lines.filter(l => l.zone_id && !zones.has(l.zone_id));
  if(orphelines.length) return res.status(422).json({
    error:"certaines lignes désignent une zone qui n'appartient pas à ce plan" });

  await tx(async (db) => {
    await db.prepare("DELETE FROM tpm_line WHERE plan_id=?").run(plan.id);
    const ins = db.prepare(`INSERT INTO tpm_line
      (id,plan_id,zone_id,driver,label,unit,qty1,qty2,unit_cost,derived,sort)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for(const [i, l] of p.data.lines.entries())
      await ins.run(newId("tpl"), plan.id, l.zone_id, l.driver, l.label,
        l.unit, l.qty1, l.qty2, l.unit_cost, l.derived ? 1 : 0, i);
    await db.prepare("UPDATE tpm_plan SET rev=rev+1, updated_at=now() WHERE id=?").run(plan.id);
  });

  const d = await planDetail(plan.id);
  await audit(req, "tpm_plan", plan.id, "update",
    `Budget ajusté : ${p.data.lines.length} ligne(s), ${d.budget} ${d.currency}`);
  res.json({ plan:d });
});

r.put("/plans/:id", requireCap("edit"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const p = z.object({ ref:S(60), note:S(600) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"plan invalide" });
  await db.prepare("UPDATE tpm_plan SET ref=?, note=?, updated_at=now() WHERE id=?")
    .run(p.data.ref, p.data.note, g.plan.id);
  res.json({ plan: await planDetail(g.plan.id) });
});

r.delete("/plans/:id", requireCap("del"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  /* Un plan engagé fait partie du dossier budgétaire du contrat. */
  if(["valide_pays","cloture"].includes(g.plan.status)) return res.status(409).json({
    error:"un plan engagé ne se supprime pas ; il peut être clôturé" });
  await db.prepare("DELETE FROM tpm_plan WHERE id=?").run(g.plan.id);
  await audit(req, "tpm_plan", g.plan.id, "delete", `Plan de suivi tiers supprimé`);
  res.json({ ok:true });
});

/* ── Le circuit ──────────────────────────────────────────────────────*/
r.post("/plans/:id/submit", requireCap("edit"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const plan = g.plan;
  if(!modifiable(plan.status)) return res.status(409).json({
    error:`ce plan est déjà « ${plan.status} »` });
  const d = await planDetail(plan.id);
  if(!d.zones.length) return res.status(409).json({
    error:"aucune zone affectée : il n'y a rien à valider" });
  if(!d.budget) return res.status(409).json({
    error:"le budget est nul : vérifiez le barème du contrat et les quantités" });

  /* Avertissement, pas refus : le plafond se vérifie au dernier niveau. Mais le
     dire dès la soumission évite de faire circuler un plan qui sera refusé. */
  const solde = await contractBalance(plan.contract_id);
  await db.prepare("UPDATE tpm_plan SET status='soumis', rev=rev+1, updated_at=now() WHERE id=?")
    .run(plan.id);
  await audit(req, "tpm_plan", plan.id, "update",
    `Plan soumis à validation — ${d.budget} ${d.currency}`);
  res.json({ plan: await planDetail(plan.id),
    avertissement: d.budget > solde.disponible
      ? `Ce plan (${d.budget} ${d.currency}) dépasse le disponible du contrat (${solde.disponible} ${d.currency}) : un avenant sera nécessaire avant la validation finale.`
      : null,
    solde });
});

r.post("/plans/:id/review", async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  const plan = g.plan;
  const p = z.object({
    decision: z.enum(["valide","renvoye"]),
    comment: z.string().trim().max(600).optional().transform(v => v || null),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"décision invalide" });

  const niveau = niveauAttendu(plan.status);
  if(!niveau) return res.status(409).json({
    error:`ce plan est « ${plan.status} » : il n'attend aucune validation` });
  const d = await planDetail(plan.id);
  if(!(await peutValider(req, d, niveau))) return res.status(403).json({
    error:`la validation « ${TRANSITIONS[niveau].label} » ne vous est pas ouverte` });
  /* Un renvoi sans motif n'apprend rien à celui qui doit corriger. */
  if(p.data.decision === "renvoye" && !p.data.comment)
    return res.status(422).json({ error:"un renvoi doit être motivé" });

  /* Contrôle du plafond au dernier niveau seulement — c'est là que l'argent
     s'engage. On refuse, avec les chiffres : « dépassement » sans montant
     n'aide personne à décider s'il faut un avenant ou réduire le plan. */
  if(niveau === "pays" && p.data.decision === "valide"){
    const solde = await contractBalance(plan.contract_id);
    if(d.budget > solde.disponible) return res.status(409).json({
      error:`validation impossible : ${d.budget} ${d.currency} demandés pour ${solde.disponible} ${d.currency} disponibles sur le contrat`,
      solde, requis: Math.round((d.budget - solde.disponible) * 100) / 100 });
  }

  const suite = p.data.decision === "valide" ? TRANSITIONS[niveau].vers : "renvoye";
  await tx(async (db) => {
    await db.prepare(`INSERT INTO tpm_review (id,plan_id,level,decision,comment,amount,user_id,user_label)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(newId("trv"), plan.id, niveau, p.data.decision, p.data.comment, d.budget,
           req.user.id, label(req.user));
    await db.prepare("UPDATE tpm_plan SET status=?, rev=rev+1, updated_at=now() WHERE id=?")
      .run(suite, plan.id);
  });
  await audit(req, "tpm_plan", plan.id, "update",
    `${TRANSITIONS[niveau].label} — ${p.data.decision === "valide" ? "validé" : "renvoyé"}` +
    ` (${d.budget} ${d.currency})${p.data.comment ? ` : ${p.data.comment}` : ""}`);

  res.json({ plan: await planDetail(plan.id), solde: await contractBalance(plan.contract_id) });
});

r.post("/plans/:id/close", requireCap("validate"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  if(g.plan.status !== "valide_pays") return res.status(409).json({
    error:"seul un plan validé au niveau pays peut être clôturé" });
  await db.prepare("UPDATE tpm_plan SET status='cloture', rev=rev+1, updated_at=now() WHERE id=?")
    .run(g.plan.id);
  const d = await planDetail(g.plan.id);
  await audit(req, "tpm_plan", g.plan.id, "update",
    `Plan clôturé — budget ${d.budget}, dépensé ${d.spent ?? 0} ${d.currency}`);
  res.json({ plan:d });
});

/* ── Dépenses ────────────────────────────────────────────────────────*/
r.post("/plans/:id/expenses", requireCap("edit"), async (req, res) => {
  const g = await reachable(req, req.params.id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  if(!["valide_pays","cloture"].includes(g.plan.status)) return res.status(409).json({
    error:"une dépense ne se constate que sur un plan validé au niveau pays" });
  const p = z.object({ line_id:S(64), spent_on:S(10),
    amount: z.coerce.number().min(0).max(1e10), ref:S(60), note:S(300) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"dépense invalide",
    details:p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(b.line_id && !(await db.prepare("SELECT 1 FROM tpm_line WHERE id=? AND plan_id=?")
      .get(b.line_id, g.plan.id)))
    return res.status(422).json({ error:"cette ligne n'appartient pas au plan" });

  const id = newId("tex");
  await db.prepare(`INSERT INTO tpm_expense (id,plan_id,line_id,spent_on,amount,ref,note,created_by)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, g.plan.id, b.line_id, b.spent_on, b.amount, b.ref, b.note, req.user.id);
  const d = await planDetail(g.plan.id);
  await audit(req, "tpm_plan", g.plan.id, "update",
    `Dépense constatée ${b.amount} ${d.currency}${b.ref ? ` (${b.ref})` : ""}`);
  res.status(201).json({ plan:d,
    /* Le dépassement n'est pas refusé : une dépense réelle est un fait, et
       l'effacer pour respecter un budget serait falsifier le suivi. On le signale. */
    avertissement: d.spent > d.budget
      ? `La dépense constatée (${d.spent}) dépasse le budget validé (${d.budget} ${d.currency}).`
      : null });
});

r.delete("/expenses/:id", requireCap("del"), async (req, res) => {
  const e = await db.prepare("SELECT * FROM tpm_expense WHERE id=?").get(req.params.id);
  if(!e) return res.status(404).json({ error:"dépense introuvable" });
  const g = await reachable(req, e.plan_id);
  if(g.error) return res.status(g.status).json({ error:g.error });
  await db.prepare("DELETE FROM tpm_expense WHERE id=?").run(e.id);
  await audit(req, "tpm_plan", e.plan_id, "update", `Dépense annulée — ${e.amount}`);
  res.json({ plan: await planDetail(e.plan_id) });
});

/* ── Zones à proposer ────────────────────────────────────────────────
   La planification est déjà fondée sur le risque ; l'affectation d'un prestataire
   doit en partir plutôt que d'une page blanche. */
r.get("/suggest", async (req, res) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    month: z.coerce.number().int().min(0).max(11).default(new Date().getMonth()),
    office_id: z.string().max(64).optional(),
    /* Optionnel : borne les suggestions au périmètre d'un contrat. L'écran
       d'affectation le passe pour n'offrir que des communes éligibles. */
    contract_id: z.string().max(64).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const bureau = (await officeBound(req.user)) || q.data.office_id || null;
  let rows = await suggestZones({ year:q.data.year, month:q.data.month, officeId:bureau });
  if(q.data.contract_id){
    const eligible = await contractZoneSet(q.data.contract_id);
    if(eligible.size){
      const v = await currentVersion();
      const chemins = v ? Object.fromEntries((await db.prepare(
        "SELECT pcode, path FROM geo_unit WHERE version_id=?").all(v.id)).map(x => [x.pcode, x.path])) : {};
      rows = rows.filter(z => zoneDansPerimetre(z.geo_pcode, chemins[z.geo_pcode], eligible));
    }
  }
  res.json({ year:q.data.year, month:q.data.month, rows });
});

export default r;
