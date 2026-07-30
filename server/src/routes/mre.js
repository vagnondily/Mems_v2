import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { countryBound, countryClause, officeBound } from "../lib/scope.js";
import { currentVersion } from "../lib/geo.js";
import { writeCountry } from "../lib/country.js";
import { CATEGORIES, ENTITIES, HIGH_CATEGORIES, KINDS, QUARTERS, STATUSES,
         budget, shape, spending } from "../lib/mre.js";

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
  /* Le pays du plan. Un compte borné ne le choisit pas : la route l'impose. */
  country_code: z.string().trim().length(3).nullish().transform(v => (v ? v.toUpperCase() : null)),
  activity_tag: S(20),
  indicator_id: S(64),
  geo_pcode:    S(64),
  responsible:  S(120),
  /* Le modèle du classeur : entité responsable, catégorie de coût, coût unitaire.
     Le calendrier n'est plus un intervalle de mois — il est porté par les fréquences
     trimestrielles, et deux calendriers concurrents laisseraient lire le mauvais. */
  entity:        z.enum(Object.keys(ENTITIES)).nullish().transform(v => v ?? null),
  cost_category: S(80),
  high_category: z.enum(Object.keys(HIGH_CATEGORIES)).nullish().transform(v => v ?? null),
  unit_cost:     z.coerce.number().min(0).max(100_000_000).default(0),
  sample:       z.coerce.number().int().min(0).max(10_000_000).nullish().transform(v => v ?? null),
  status:       z.enum(STATUSES).default("planifie"),
  funding:      S(120),
  currency:     z.string().trim().length(3).default("USD"),
  note:         S(1000),
  rev:          z.coerce.number().int().min(1).optional(),
});

/* Les fréquences : une ligne par année, quatre trimestres. C'est ce que le classeur
   appelle « Total Frequency » décomposé, et c'est la seule saisie de calendrier. */
const freqSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  q:    z.array(z.coerce.number().min(0).max(999)).length(4),
});

/* La dépense constatée, par année. Nul ≠ zéro, d'où le nullable explicite. */
const spendSchema = z.object({
  year:   z.coerce.number().int().min(2000).max(2100),
  amount: z.coerce.number().min(0).max(1e12).nullish().transform(v => (v ?? null)),
  note:   S(300),
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
/* Lecture. Un bureau voit son plan et le plan national ; personne n'écrit chez le
   voisin. Le filtre est en SQL, pas en mémoire : le plan grossit chaque année.

   L'ANNÉE demandée n'est plus celle de l'activité mais celle du BUDGET : une
   activité déclarée en 2024 avec des occurrences en 2026 appartient au plan 2026.
   C'est la conséquence directe du modèle pluriannuel — et l'ancien filtre sur
   `a.year` aurait fait disparaître d'un plan les activités qui le portent. */
function visibles(req, extra = {}){
  const where = ["1=1"]; const args = [];
  const pays = countryClause(req.user, "a");
  if(pays.sql){ where.push(pays.sql.replace(/^ AND /, "")); args.push(...pays.args); }
  const bound = officeBound(req.user);
  if(bound){ where.push("(a.office_id = ? OR a.office_id IS NULL)"); args.push(bound); }
  else if(extra.office_id){ where.push("a.office_id = ?"); args.push(extra.office_id); }
  if(extra.kind){   where.push("a.kind = ?");   args.push(extra.kind); }
  if(extra.status){ where.push("a.status = ?"); args.push(extra.status); }
  if(extra.entity){ where.push("a.entity = ?"); args.push(extra.entity); }
  if(extra.year != null){
    where.push(`(EXISTS (SELECT 1 FROM mre_frequency f WHERE f.activity_id = a.id AND f.year = ?)
                 OR (a.year = ? AND NOT EXISTS (SELECT 1 FROM mre_frequency f2 WHERE f2.activity_id = a.id)))`);
    args.push(extra.year, extra.year);
  }
  return db.prepare(
    `SELECT a.*, o.name office_name, i.code indicator_code
     FROM mre_activity a
     LEFT JOIN offices o    ON o.id = a.office_id
     LEFT JOIN indicators i ON i.id = a.indicator_id
     WHERE ${where.join(" AND ")}
     ORDER BY a.ref, a.title`).all(...args);
}

r.get("/", (req, res) => {
  const q = z.object({
    year:      z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    kind:      z.enum(Object.keys(KINDS)).optional(),
    status:    z.enum(STATUSES).optional(),
    entity:    z.enum(Object.keys(ENTITIES)).optional(),
    office_id: z.string().max(64).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const an = q.data.year;

  const acts = visibles(req, q.data);
  const labels = porteeLabels(acts.map(a => a.geo_pcode));
  const rows = acts.map(a => shape(a, labels));

  /* Ce qui concerne l'année demandée, extrait de chaque activité pluriannuelle. */
  const surAnnee = (x) => x.budgetParAnnee?.[an] || { occurrences:0, montant:0 };
  const depAnnee = (x) => x.depenses?.[an]?.amount ?? null;
  const somme = (xs, f) => r2(xs.reduce((t, x) => t + (f(x) || 0), 0));

  const parKind = Object.keys(KINDS).map(k => {
    const g = rows.filter(x => x.kind === k);
    return { kind:k, label:KINDS[k], n:g.length, budget:somme(g, x => surAnnee(x).montant),
             spent:somme(g, depAnnee) };
  }).filter(x => x.n);

  const parCategorie = Object.keys(HIGH_CATEGORIES).map(c => {
    const g = rows.filter(x => x.high_category === c);
    return { category:c, label:HIGH_CATEGORIES[c], n:g.length,
             budget:somme(g, x => surAnnee(x).montant), spent:somme(g, depAnnee) };
  }).filter(x => x.n);

  const parEntite = Object.keys(ENTITIES).map(e => {
    const g = rows.filter(x => x.entity === e);
    return { entity:e, label:ENTITIES[e], n:g.length, budget:somme(g, x => surAnnee(x).montant) };
  }).filter(x => x.n);

  /* Répartition TRIMESTRIELLE — la maille du classeur. Elle n'a plus rien d'une
     convention de répartition : chaque occurrence est déclarée dans son trimestre,
     et le total des quatre trimestres est, par construction, le budget de l'année.
     L'ancien plan mensuel devait étaler les lignes sans mois sur la durée de
     l'activité, avec un arrondi à somme conservée : une approximation qu'on
     défendait faute de mieux. Il n'y a plus rien à approximer. */
  const parTrimestre = QUARTERS.map((label, i) => ({ quarter:i, label, budget:0, occurrences:0 }));
  for(const x of rows){
    const qs = x.frequences?.[an]; if(!qs) continue;
    qs.forEach((n2, i) => {
      parTrimestre[i].occurrences += n2;
      parTrimestre[i].budget = r2(parTrimestre[i].budget + n2 * (x.unit_cost || 0));
    });
  }

  /* Le plan pluriannuel : ce que chaque année porte, toutes activités confondues.
     C'est la vue que le classeur donne en premier, et que l'outil ne savait pas
     produire — il ne connaissait qu'une année à la fois. */
  const annees = [...new Set(rows.flatMap(x => Object.keys(x.budgetParAnnee)))]
    .map(Number).sort();
  const parAnnee = annees.map(y => ({
    year:y,
    budget: somme(rows, x => x.budgetParAnnee?.[y]?.montant),
    occurrences: rows.reduce((t, x) => t + (x.budgetParAnnee?.[y]?.occurrences || 0), 0),
    spent: somme(rows, x => x.depenses?.[y]?.amount),
    activites: rows.filter(x => x.budgetParAnnee?.[y]).length,
  }));

  const engagees = rows.filter(x => depAnnee(x) != null);
  const devises = [...new Set(rows.map(x => x.currency))];
  res.json({
    year:an, rows,
    totals: {
      activites: rows.length,
      /* Le budget de l'ANNÉE demandée, et celui de tout le plan : les deux sont
         attendus, et n'afficher que l'un des deux fait croire que l'autre n'existe pas. */
      budget: somme(rows, x => surAnnee(x).montant),
      budgetTotal: somme(rows, x => x.budget),
      occurrences: rows.reduce((t, x) => t + surAnnee(x).occurrences, 0),
      spent: somme(engagees, depAnnee),
      currency: devises.length === 1 ? devises[0] : null,
      devises,
      chiffrees: rows.filter(x => surAnnee(x).montant > 0).length,
      sansBudget: rows.filter(x => !surAnnee(x).montant).length,
      sansFrequence: rows.filter(x => !Object.keys(x.frequences || {}).length).length,
      realisees: rows.filter(x => x.status === "realise").length,
      enCours: rows.filter(x => x.status === "en_cours").length,
      execution: (() => {
        const b = somme(engagees, x => surAnnee(x).montant), s2 = somme(engagees, depAnnee);
        return b ? Math.round((s2 / b) * 1000) / 10 : null; })(),
    },
    parKind, parCategorie, parEntite, parTrimestre, parAnnee,
    referentiel: { kinds:KINDS, categories:CATEGORIES, highCategories:HIGH_CATEGORIES,
                   entities:ENTITIES, statuses:STATUSES, quarters:QUARTERS },
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
  const pays = writeCountry(req.user, b.country_code);
  if(pays.error) return res.status(422).json({ error:pays.error });
  if(b.ref && db.prepare(
      "SELECT 1 FROM mre_activity WHERE year=? AND ref=? AND (country_code=? OR country_code IS NULL)")
      .get(b.year, b.ref, pays.code))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ${b.year}` });
  const id = newId("mre");
  db.prepare(`INSERT INTO mre_activity (id,year,ref,title,kind,purpose,method,office_id,country_code,
    activity_tag,indicator_id,geo_pcode,responsible,entity,cost_category,high_category,unit_cost,
    sample,status,funding,currency,note,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.year, b.ref, b.title, b.kind, b.purpose, b.method, b.office_id, pays.code, b.activity_tag,
         b.indicator_id, b.geo_pcode, b.responsible, b.entity, b.cost_category, b.high_category,
         b.unit_cost, b.sample, b.status, b.funding, b.currency, b.note, req.user.id);
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
  /* L'unicité de la référence est par pays : deux bureaux pays numérotent leurs
     activités indépendamment, et « MDG-2025-01 » n'entre pas en concurrence avec la
     numérotation du voisin. */
  if(b.ref && db.prepare(`SELECT 1 FROM mre_activity WHERE year=? AND ref=? AND id<>?
      AND (country_code IS ? OR country_code IS NULL)`)
      .get(b.year, b.ref, cur.row.id, cur.row.country_code))
    return res.status(409).json({ error:`la référence ${b.ref} existe déjà pour ${b.year}` });
  db.prepare(`UPDATE mre_activity SET year=?, ref=?, title=?, kind=?, purpose=?, method=?,
    office_id=?, activity_tag=?, indicator_id=?, geo_pcode=?, responsible=?, entity=?,
    cost_category=?, high_category=?, unit_cost=?, sample=?, status=?, funding=?, currency=?,
    note=?, rev=rev+1, updated_at=datetime('now') WHERE id=?`)
    .run(b.year, b.ref, b.title, b.kind, b.purpose, b.method, b.office_id, b.activity_tag,
         b.indicator_id, b.geo_pcode, b.responsible, b.entity, b.cost_category, b.high_category,
         b.unit_cost, b.sample, b.status, b.funding, b.currency, b.note, cur.row.id);
  audit(req, "update", cur.row.id, `Plan MRE ${b.year} — ${b.title}` +
    (b.status !== cur.row.status ? ` (statut : ${b.status})` : ""));
  res.json({ activity: one(req, cur.row.id) });
});

/* Le calendrier et le budget d'UNE activité : fréquences par année et par trimestre,
   remplacées en bloc. Le remplacement global est légitime ici — contrairement aux
   collections, où il effaçait le travail du voisin : l'unité d'édition est
   l'activité, l'utilisateur a sa grille sous les yeux, et la révision garde la porte. */
r.put("/:id/frequencies", requireCap("edit"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  const p = z.object({ rev: z.coerce.number().int().min(1).optional(),
                       rows: z.array(freqSchema).max(40) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"fréquences invalides",
    details: p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  if(p.data.rev && p.data.rev !== cur.row.rev)
    return res.status(409).json({ error:"cette activité a été modifiée entre-temps",
      courant: one(req, cur.row.id) });

  const ins = db.prepare(`INSERT INTO mre_frequency (id,activity_id,year,quarter,n)
                          VALUES (?,?,?,?,?)`);
  tx(() => {
    db.prepare("DELETE FROM mre_frequency WHERE activity_id=?").run(cur.row.id);
    for(const l of p.data.rows) l.q.forEach((n2, i) => {
      /* On n'écrit que les trimestres non nuls : une grille vide ne doit pas peser
         quarante lignes de zéros, et l'absence de ligne vaut zéro. */
      if(n2 > 0) ins.run(newId("mfr"), cur.row.id, l.year, i, n2);
    });
    db.prepare("UPDATE mre_activity SET rev=rev+1, updated_at=datetime('now') WHERE id=?")
      .run(cur.row.id);
  })();
  const b2 = budget(cur.row.id, cur.row.unit_cost);
  audit(req, "update", cur.row.id,
    `Plan MRE — calendrier de « ${cur.row.title} » : ${b2.occurrences} occurrence(s), ${b2.total} ${cur.row.currency}`);
  res.json({ activity: one(req, cur.row.id) });
});

/* La dépense constatée, année par année. Séparée du budget par nature : elle est
   saisie après coup, souvent par quelqu'un d'autre, et elle n'a pas à faire changer
   la révision du plan — sinon deux personnes qui travaillent l'une sur le prévu,
   l'autre sur le réalisé, se bloqueraient mutuellement. */
r.put("/:id/spend", requireCap("edit"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  const p = z.object({ rows: z.array(spendSchema).max(20) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"dépenses invalides",
    details: p.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });

  const ins = db.prepare(`INSERT INTO mre_spend (id,activity_id,year,amount,note) VALUES (?,?,?,?,?)`);
  tx(() => {
    db.prepare("DELETE FROM mre_spend WHERE activity_id=?").run(cur.row.id);
    for(const l of p.data.rows)
      /* Une année sans montant ET sans note n'a rien à dire : on ne la conserve pas,
         sinon « pas encore dépensé » et « ligne vide » se confondraient. */
      if(l.amount != null || l.note) ins.run(newId("msp"), cur.row.id, l.year, l.amount, l.note);
  })();
  audit(req, "update", cur.row.id, `Plan MRE — dépense constatée de « ${cur.row.title} » mise à jour`);
  res.json({ activity: one(req, cur.row.id) });
});

r.delete("/:id", requireCap("del"), (req, res) => {
  const cur = mine(req, req.params.id);
  if(cur.error) return res.status(cur.status).json({ error:cur.error });
  /* Fréquences et dépenses partent en cascade : elles n'ont pas d'existence propre. */
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
  return shape(a, porteeLabels([a.geo_pcode]));
}

/* L'activité existe-t-elle, et relève-t-elle de l'appelant ?
   Un compte cloisonné lit le plan national mais ne le modifie pas : les deux
   sont vrais en même temps, d'où la distinction 404 / 403. */
function mine(req, id){
  const row = db.prepare("SELECT * FROM mre_activity WHERE id=?").get(id);
  if(!row) return { error:"activité introuvable", status:404 };
  /* Un autre pays rend l'activité introuvable, non refusée : la distinction dirait
     qu'elle existe, ce qui ne regarde pas un compte d'un autre pays. */
  const pays = countryBound(req.user);
  if(pays && row.country_code && row.country_code !== pays)
    return { error:"activité introuvable", status:404 };
  const bound = officeBound(req.user);
  if(bound && row.office_id !== bound)
    return { error: row.office_id
      ? "cette activité relève d'un autre bureau"
      : "cette activité relève du plan national : seul le bureau pays la modifie",
      status:403 };
  return { row };
}

export default r;
