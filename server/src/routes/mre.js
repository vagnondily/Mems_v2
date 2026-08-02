import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { currentVersion } from "../lib/geo.js";

/* ═══════════════════════════════════════════════════════════════════════
   Plan MRE et budget — suivi, revue, évaluation.

   Le plan répond à deux questions distinctes, et c'est pourquoi il y a deux
   tables : ce que l'unité entreprend dans l'année, et ce que cela coûte.

   Le budget est TOUJOURS calculé (Σ quantité × coût unitaire), jamais saisi.
   Un montant global saisi à la main ne se défend pas : on ne peut ni le
   décomposer devant un bailleur, ni le rapprocher de la dépense. Les totaux
   renvoyés ici sont donc dérivés, et le client n'a pas à les recalculer — il
   les recalculerait autrement, et les deux chiffres finiraient par diverger.

   Le cloisonnement suit la règle unique de lib/scope.js, avec une nuance : un
   bureau voit aussi les activités SANS bureau, c'est-à-dire le plan national.
   Les lui cacher reviendrait à lui dire qu'aucune évaluation n'est prévue sur
   sa zone alors qu'elle est portée par Tana.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

export const KINDS = {
  suivi:      "Suivi de processus et de distribution",
  revue:      "Revue de programme",
  evaluation: "Évaluation",
  enquete:    "Enquête (post-distribution, base, finale)",
  etude:      "Étude ou analyse",
  capacite:   "Renforcement de capacités en suivi-évaluation",
};
export const CATEGORIES = {
  personnel:     "Personnel de suivi",
  enqueteurs:    "Enquêteurs et superviseurs",
  deplacement:   "Indemnités de déplacement",
  transport:     "Transport et carburant",
  atelier:       "Atelier et restitution",
  consultant:    "Consultant ou cabinet",
  equipement:    "Équipement et tablettes",
  impression:    "Impression et fournitures",
  communication: "Communication et connectivité",
  autre:         "Autre",
};
const STATUSES = ["planifie", "en_cours", "realise", "reporte", "annule"];

const S = (max) => z.string().trim().max(max).nullish().transform(v => (v ? v : null));
const r2 = (x) => Math.round(x * 100) / 100;

const activitySchema = z.object({
  year:         z.coerce.number().int().min(2000).max(2100),
  ref:          S(40),
  title:        z.string().trim().min(3).max(200),
  kind:         z.enum(Object.keys(KINDS)).default("suivi"),
  purpose:      S(600),
  method:       S(300),
  office_id:    S(64),
  activity_tag: S(20),
  indicator_id: S(64),
  geo_pcode:    S(64),
  responsible:  S(120),
  start_month:  z.coerce.number().int().min(0).max(11).nullish().transform(v => v ?? null),
  end_month:    z.coerce.number().int().min(0).max(11).nullish().transform(v => v ?? null),
  /* Les mois de mise en œuvre, éventuellement DISCONTINUS (janvier + août). Quand
     il est fourni, ce tableau prime sur start/end (qui en deviennent le min/max). */
  months:       z.array(z.coerce.number().int().min(0).max(11)).max(12).nullish(),
  sample:       z.coerce.number().int().min(0).max(10_000_000).nullish().transform(v => v ?? null),
  status:       z.enum(STATUSES).default("planifie"),
  funding:      S(120),
  currency:     z.string().trim().length(3).default("USD"),
  note:         S(1000),
  rev:          z.coerce.number().int().min(1).optional(),
});

const costSchema = z.object({
  id:        S(64),
  category:  z.enum(Object.keys(CATEGORIES)).default("autre"),
  label:     S(160),
  unit:      S(40),
  qty:       z.coerce.number().min(0).max(1_000_000).default(1),
  unit_cost: z.coerce.number().min(0).max(100_000_000).default(0),
  /* Nul ≠ zéro : « rien de dépensé pour l'instant » et « dépense constatée nulle »
     sont deux états différents dans un suivi budgétaire. */
  spent:     z.coerce.number().min(0).max(100_000_000).nullish().transform(v => (v ?? null)),
  month:     z.coerce.number().int().min(0).max(11).nullish().transform(v => v ?? null),
  note:      S(300),
});

const audit = (req, action, id, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'plan','mre_activity',?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
         req.user.office_id || "", id, action, text);

/* Libellé lisible d'une portée géographique, pour un lot de p-codes.
   En un seul passage : une activité par ligne × un aller-retour chacune ferait
   autant de requêtes que d'activités pour afficher une colonne. */
function porteeLabels(pcodes){
  const uniques = [...new Set(pcodes.filter(Boolean))];
  if(!uniques.length) return {};
  const v = currentVersion(); if(!v) return {};
  const rows = db.prepare(
    `SELECT u.pcode, u.name, u.level, p.name parent
     FROM geo_unit u LEFT JOIN geo_unit p ON p.version_id=u.version_id AND p.pcode=u.parent_pcode
     WHERE u.version_id=? AND u.pcode IN (${uniques.map(()=>"?").join(",")})`).all(v.id, ...uniques);
  return Object.fromEntries(rows.map(x => [x.pcode, x.parent ? `${x.name} (${x.parent})` : x.name]));
}

/* Le budget d'une activité : ses lignes, leur total, la dépense constatée.
   Une seule définition, utilisée par la liste comme par la fiche. */
function costsOf(ids){
  if(!ids.length) return {};
  const lignes = db.prepare(
    `SELECT * FROM mre_cost WHERE activity_id IN (${ids.map(()=>"?").join(",")})
     ORDER BY category, label`).all(...ids);
  const out = {};
  for(const l of lignes){
    const a = out[l.activity_id] = out[l.activity_id] || { lines:[], budget:0, spent:0, engaged:0 };
    const total = r2((l.qty || 0) * (l.unit_cost || 0));
    a.lines.push({ id:l.id, category:l.category, label:l.label || "", unit:l.unit || "",
      qty:l.qty, unit_cost:l.unit_cost, spent:l.spent, month:l.month, note:l.note || "",
      total, rev:l.rev });
    a.budget = r2(a.budget + total);
    if(l.spent != null){ a.spent = r2(a.spent + l.spent); a.engaged++; }
  }
  return out;
}

/* Normalisation des mois de mise en œuvre — le tableau `months` (éventuellement
   discontinu) prime ; à défaut, la plage continue start→end. */
const range = (a, b) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
function normaliserMois(b){
  const mois = Array.isArray(b.months) && b.months.length
    ? [...new Set(b.months)].sort((x, y) => x - y)
    : (b.start_month != null ? range(b.start_month, b.end_month ?? b.start_month) : []);
  return { mois, start: mois.length ? mois[0] : null, end: mois.length ? mois[mois.length - 1] : null,
    json: mois.length ? JSON.stringify(mois) : null };
}
const moisDeLigne = (a) => { try{ const m = a.months ? JSON.parse(a.months) : null;
    if(Array.isArray(m) && m.length) return m; }catch(e){}
  return a.start_month != null ? range(a.start_month, a.end_month ?? a.start_month) : []; };

const shape = (a, cost, labels) => {
  const c = cost || { lines:[], budget:0, spent:0, engaged:0 };
  return {
    id:a.id, year:a.year, ref:a.ref || "", title:a.title, kind:a.kind,
    kindLabel: KINDS[a.kind] || a.kind,
    purpose:a.purpose || "", method:a.method || "",
    office_id:a.office_id, office:a.office_name || "", activity_tag:a.activity_tag || "",
    indicator_id:a.indicator_id, indicator:a.indicator_code || "",
    geo_pcode:a.geo_pcode, portee: a.geo_pcode ? (labels?.[a.geo_pcode] || a.geo_pcode) : "National",
    responsible:a.responsible || "", start_month:a.start_month, end_month:a.end_month,
    months: moisDeLigne(a),
    sample:a.sample, status:a.status, funding:a.funding || "", currency:a.currency,
    note:a.note || "", rev:a.rev, updated_at:a.updated_at,
    costs:c.lines, budget:c.budget, spent:c.engaged ? c.spent : null,
    /* Écart en points : au-dessus de 100, l'activité a coûté plus que budgété. */
    execution: c.budget && c.engaged ? Math.round((c.spent / c.budget) * 1000) / 10 : null,
  };
};

/* Lecture. Un bureau voit son plan et le plan national ; personne n'écrit chez
   le voisin. Le filtre est en SQL, pas en mémoire : le plan grossit chaque année. */
function visibles(req, extra = {}){
  const bound = officeBound(req.user);
  const where = ["a.year = ?"]; const args = [extra.year];
  if(bound){ where.push("(a.office_id = ? OR a.office_id IS NULL)"); args.push(bound); }
  else if(extra.office_id){ where.push("a.office_id = ?"); args.push(extra.office_id); }
  if(extra.kind){   where.push("a.kind = ?");   args.push(extra.kind); }
  if(extra.status){ where.push("a.status = ?"); args.push(extra.status); }
  return db.prepare(
    `SELECT a.*, o.name office_name, i.code indicator_code
     FROM mre_activity a
     LEFT JOIN offices o    ON o.id = a.office_id
     LEFT JOIN indicators i ON i.id = a.indicator_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.start_month IS NULL, a.start_month, a.ref, a.title`).all(...args);
}

r.get("/", (req, res) => {
  const q = z.object({
    year:      z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    kind:      z.enum(Object.keys(KINDS)).optional(),
    status:    z.enum(STATUSES).optional(),
    office_id: z.string().max(64).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });

  const acts = visibles(req, q.data);
  const cost = costsOf(acts.map(a => a.id));
  const labels = porteeLabels(acts.map(a => a.geo_pcode));
  const rows = acts.map(a => shape(a, cost[a.id], labels));

  /* Agrégations. Elles vivent ici parce qu'elles doivent être les mêmes pour
     l'écran, l'export et un futur rapport — trois recalculs séparés finiraient
     par donner trois totaux. */
  const somme = (xs, k) => r2(xs.reduce((t, x) => t + (x[k] || 0), 0));
  const parKind = Object.keys(KINDS).map(k => {
    const g = rows.filter(x => x.kind === k);
    return { kind:k, label:KINDS[k], n:g.length, budget:somme(g,"budget"),
             spent:somme(g.filter(x=>x.spent!=null),"spent") };
  }).filter(x => x.n);

  const parCategorie = Object.keys(CATEGORIES).map(c => {
    const l = rows.flatMap(x => x.costs).filter(x => x.category === c);
    return { category:c, label:CATEGORIES[c], n:l.length, budget:somme(l,"total"),
             spent:r2(l.reduce((t,x)=>t+(x.spent||0),0)) };
  }).filter(x => x.n);

  /* Répartition mensuelle.

     Une ligne de coût qui porte un mois y est imputée. Une ligne sans mois est
     RÉPARTIE sur la durée de son activité, pas posée sur le mois de début : un
     suivi de processus qui court de janvier à décembre dépense tous les mois, et
     l'imputer en janvier faisait un plan de trésorerie où 80 % de l'année tombait
     au premier mois — un graphique faux, pas une approximation.

     C'est une convention, énoncée à l'écran. Un plan de trésorerie sans hypothèse
     explicite n'existe pas ; ce qui compte est qu'elle soit dite et défendable.
     L'accumulation se fait sans arrondi intermédiaire, et l'arrondi final est
     corrigé par la méthode du plus fort reste : répartir 4 400 sur trois mois
     donne trois fois 1 466,67, soit 4 400,01 une fois arrondi. Un centime n'a
     aucune importance à l'écran, mais l'invariant en a une — la somme des mois
     doit être le budget affiché à côté, faute de quoi le tableau et le graphique
     se contredisent et plus rien n'est croyable. */
  const parMois = Array.from({ length:12 }, (_, m) => ({ month:m, budget:0, spent:0 }));
  for(const a of rows) for(const l of a.costs){
    if(l.month != null){
      parMois[l.month].budget += l.total;
      if(l.spent != null) parMois[l.month].spent += l.spent;
      continue;
    }
    /* Une ligne sans date est répartie sur les MOIS de l'activité — désormais
       éventuellement discontinus (janvier + août), non plus une plage continue. */
    const mois = (a.months && a.months.length) ? a.months : range(0, 11);
    const span = mois.length;
    for(const m of mois){
      parMois[m].budget += l.total / span;
      if(l.spent != null) parMois[m].spent += l.spent / span;
    }
  }
  /* Arrondi à somme conservée : on arrondit vers le bas, puis on rend le reste
     aux mois dont la partie décimale était la plus forte. */
  const repartir = (champ, total) => {
    const brut = parMois.map(m => m[champ]);
    const bas  = brut.map(v => Math.floor(v * 100) / 100);
    let reste  = Math.round((r2(total) - bas.reduce((t,v)=>t+v, 0)) * 100);
    const ordre = brut.map((v,i)=>[i, v*100 - Math.floor(v*100)]).sort((a,b)=>b[1]-a[1]);
    for(let k = 0; reste > 0 && k < ordre.length; k++, reste--) bas[ordre[k][0]] = r2(bas[ordre[k][0]] + 0.01);
    parMois.forEach((m,i) => { m[champ] = bas[i]; });
  };
  repartir("budget", rows.reduce((t,a)=>t+a.budget, 0));
  repartir("spent",  rows.reduce((t,a)=>t+(a.spent || 0), 0));

  const engagees = rows.filter(x => x.spent != null);
  const devises = [...new Set(rows.map(x => x.currency))];
  res.json({
    year:q.data.year, rows,
    totals: {
      activites: rows.length,
      budget: somme(rows, "budget"),
      spent: somme(engagees, "spent"),
      /* On ne prétend pas convertir : si le plan mélange les devises, le total
         n'a pas de sens et il faut le dire au lieu d'additionner des pommes. */
      currency: devises.length === 1 ? devises[0] : null,
      devises,
      chiffrees: rows.filter(x => x.budget > 0).length,
      sansBudget: rows.filter(x => !x.budget).length,
      realisees: rows.filter(x => x.status === "realise").length,
      enCours: rows.filter(x => x.status === "en_cours").length,
      execution: (() => { const b = somme(engagees,"budget"), s = somme(engagees,"spent");
        return b ? Math.round((s / b) * 1000) / 10 : null; })(),
    },
    parKind, parCategorie, parMois,
    referentiel: { kinds:KINDS, categories:CATEGORIES, statuses:STATUSES },
  });
});

r.post("/", requireCap("edit"), (req, res) => {
  const p = activitySchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"activité invalide",
    details: p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  const bound = officeBound(req.user);
  /* Un compte cloisonné ne crée que pour son bureau, quoi que dise le corps. */
  if(bound) b.office_id = bound;
  if(b.ref && db.prepare("SELECT 1 FROM mre_activity WHERE year=? AND ref=?").get(b.year, b.ref))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ${b.year}` });
  if(b.start_month != null && b.end_month != null && b.end_month < b.start_month)
    return res.status(422).json({ error:"le mois de fin précède le mois de début" });

  const id = newId("mre");
  const nm = normaliserMois(b);
  db.prepare(`INSERT INTO mre_activity (id,year,ref,title,kind,purpose,method,office_id,activity_tag,
    indicator_id,geo_pcode,responsible,start_month,end_month,months,sample,status,funding,currency,note,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.year, b.ref, b.title, b.kind, b.purpose, b.method, b.office_id, b.activity_tag,
         b.indicator_id, b.geo_pcode, b.responsible, nm.start, nm.end, nm.json, b.sample,
         b.status, b.funding, b.currency, b.note, req.user.id);
  audit(req, "create", id, `Plan MRE ${b.year} — activité créée : ${b.title}`);
  res.status(201).json({ activity: one(req, id) });
});

r.put("/:id", requireCap("edit"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  const p = activitySchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"activité invalide",
    details: p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;
  if(b.rev && b.rev !== cur.row.rev)
    return res.status(409).json({ error:"cette activité a été modifiée entre-temps",
      courant: one(req, cur.row.id) });
  if(officeBound(req.user)) b.office_id = cur.row.office_id;
  if(b.ref && db.prepare("SELECT 1 FROM mre_activity WHERE year=? AND ref=? AND id<>?")
      .get(b.year, b.ref, cur.row.id))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ${b.year}` });
  if(b.start_month != null && b.end_month != null && b.end_month < b.start_month)
    return res.status(422).json({ error:"le mois de fin précède le mois de début" });

  const nm = normaliserMois(b);
  db.prepare(`UPDATE mre_activity SET year=?, ref=?, title=?, kind=?, purpose=?, method=?,
    office_id=?, activity_tag=?, indicator_id=?, geo_pcode=?, responsible=?, start_month=?,
    end_month=?, months=?, sample=?, status=?, funding=?, currency=?, note=?, rev=rev+1,
    updated_at=datetime('now') WHERE id=?`)
    .run(b.year, b.ref, b.title, b.kind, b.purpose, b.method, b.office_id, b.activity_tag,
         b.indicator_id, b.geo_pcode, b.responsible, nm.start, nm.end, nm.json, b.sample,
         b.status, b.funding, b.currency, b.note, cur.row.id);
  audit(req, "update", cur.row.id, `Plan MRE ${b.year} — ${b.title}` +
    (b.status !== cur.row.status ? ` (statut : ${b.status})` : ""));
  res.json({ activity: one(req, cur.row.id) });
});

/* Les lignes de coût d'UNE activité, remplacées en bloc.
   Le remplacement global est légitime ici — contrairement aux collections, où il
   effaçait le travail du voisin : l'unité d'édition est l'activité, l'utilisateur
   a ses lignes sous les yeux, et la révision de l'activité garde la porte. */
r.put("/:id/costs", requireCap("edit"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  const p = z.object({ rev: z.coerce.number().int().min(1).optional(),
                       lines: z.array(costSchema).max(200) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"lignes de coût invalides",
    details: p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  if(p.data.rev && p.data.rev !== cur.row.rev)
    return res.status(409).json({ error:"le budget de cette activité a été modifié entre-temps",
      courant: one(req, cur.row.id) });

  const ins = db.prepare(`INSERT INTO mre_cost
    (id,activity_id,category,label,unit,qty,unit_cost,spent,month,note) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  tx(() => {
    db.prepare("DELETE FROM mre_cost WHERE activity_id=?").run(cur.row.id);
    for(const l of p.data.lines)
      ins.run(newId("mrc"), cur.row.id, l.category, l.label, l.unit, l.qty, l.unit_cost,
              l.spent, l.month, l.note);
    db.prepare("UPDATE mre_activity SET rev=rev+1, updated_at=datetime('now') WHERE id=?")
      .run(cur.row.id);
  })();

  const a = one(req, cur.row.id);
  audit(req, "update", cur.row.id,
    `Budget MRE — ${cur.row.title} : ${p.data.lines.length} ligne(s), ${a.budget} ${a.currency}`);
  res.json({ activity:a });
});

r.delete("/:id", requireCap("del"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  /* Les lignes de coût partent en cascade : elles n'ont pas d'existence propre. */
  db.prepare("DELETE FROM mre_activity WHERE id=?").run(cur.row.id);
  audit(req, "delete", cur.row.id, `Plan MRE — activité supprimée : ${cur.row.title}`);
  res.json({ ok:true });
});

/* Une activité, telle que la voit l'appelant. */
function one(req, id){
  const a = db.prepare(
    `SELECT a.*, o.name office_name, i.code indicator_code FROM mre_activity a
     LEFT JOIN offices o ON o.id=a.office_id LEFT JOIN indicators i ON i.id=a.indicator_id
     WHERE a.id=?`).get(id);
  if(!a) return null;
  return shape(a, costsOf([id])[id], porteeLabels([a.geo_pcode]));
}

/* L'activité existe-t-elle, et relève-t-elle de l'appelant ?
   Un compte cloisonné lit le plan national mais ne le modifie pas : les deux
   sont vrais en même temps, d'où la distinction 404 / 403. */
function mine(req, id){
  const row = db.prepare("SELECT * FROM mre_activity WHERE id=?").get(id);
  if(!row) return { error:"activité introuvable", status:404 };
  const bound = officeBound(req.user);
  if(bound && row.office_id !== bound)
    return { error: row.office_id
      ? "cette activité relève d'un autre bureau"
      : "cette activité relève du plan national : seul le bureau pays la modifie",
      status:403 };
  return { row };
}

export default r;
