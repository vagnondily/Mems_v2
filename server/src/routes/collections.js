import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { encrypt } from "../lib/crypto.js";
import { requireCap, can } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { NOMS_SCHEMAS_AUTH } from "../lib/authSortante.js";

const r = Router();
const S = (max=200) => z.string().max(max).nullish().transform(v => v ?? null);
const N = (min=0, max=1e12) => z.coerce.number().min(min).max(max).default(0);
const I = (min=0, max=1e9) => z.coerce.number().int().min(min).max(max).default(0);
const B = z.union([z.boolean(), z.number(), z.string()]).transform(v =>
  (v===true || v===1 || v==="1" || v==="true") ? 1 : 0);

/* Chaque collection déclare sa table, le droit exigé, sa forme et sa projection en colonnes.
   Une écriture remplace la collection entière dans une transaction :
   les lignes absentes du corps sont supprimées, les autres insérées ou mises à jour.

   `office:true` marque les collections dont la table porte une colonne `office_id`,
   et elles seules : ce sont les deux mêmes que `GET /api/state` cloisonne
   (`coverage_params` et `pdd`). Les autres — indicateurs, résultats, modèles de
   rapport, sources ODK… — sont communes à toute l'installation ; y appliquer un
   filtre par bureau ne protégerait personne et couperait tout le monde de tout. */
const COLLECTIONS = {
  params: { table:"coverage_params", cap:"edit", office:true,
    schema: z.object({ id:S(64), csp:S(40), office_id:z.string().max(64),
      category_id:S(64), tag:z.string().min(1).max(20),
      duration:I(0,12), riskLevel:I(1,3), feasiblePerMonth:I(0,1000),
      /* Formulaires réalisables par jour et par personne — 0 = non renseigné.
         Sert au calcul des jours d'un plan TPM d'après le MMR (migration 041). */
      formsPerDay:I(0,200) }),
    map: (x) => ({ csp:x.csp, office_id:x.office_id, category_id:x.category_id,
      activity_tag:x.tag, duration:x.duration, risk_level:x.riskLevel,
      feasible_per_month:x.feasiblePerMonth, forms_per_day:x.formsPerDay }) },

  outputs: { table:"outputs", cap:"edit",
    schema: z.object({ id:S(64), tag:z.string().min(1).max(20), year:I(2000,2100),
      month:I(0,11), planned:I(), actual:I(),
      adjust:z.enum(["none","up","down","new"]).default("none"), note:S(400) }),
    map: (x) => ({ activity_tag:x.tag, year:x.year, month:x.month, planned:x.planned,
      actual:x.actual, adjust:x.adjust, note:x.note }) },

  indicators: { table:"indicators", cap:"edit",
    schema: z.object({ id:S(64), code:z.string().min(1).max(20), name:z.string().min(1).max(300),
      basket:S(120), unit:z.string().max(20).default("%"), target:N(-1e6,1e6),
      direction:z.enum(["up","down"]).default("up"), method:S(200), frequency:S(40),
      /* Nature de l'indicateur (migration 022). `level` n'a de sens que pour le
         CRF, `activity` que pour l'XLSForm : tous deux sont donc facultatifs, le
         serveur ne les impose pas selon `kind` — l'écran s'en charge. */
      kind:z.enum(["crf","xlsform"]).default("crf"),
      /* `crosscutting` est la quatrième nature du cadre de résultats, celle de
         l'Annex 4 de la masterlist (migration 027). Elle s'ajoute aux trois
         d'origine : la colonne est du TEXT sans contrainte, c'est cette
         énumération-ci qui fait foi. */
      /* « sdg » (migration 032) est le cinquième sous-groupe : les ODD de
         l'Annex 1. La colonne DB est du TEXT sans contrainte, cette énumération
         fait foi. */
      level:z.enum(["outcome","output","other_output","crosscutting","sdg"]).nullish()
        .transform(v => v ?? null),
      /* La catégorie thématique du classeur institutionnel — la maille à
         laquelle un bureau cherche un indicateur, et celle que l'écran filtre. */
      category:S(160),
      /* La pertinence (migration 029) : activités concernées et cibles.
         `activityTags` arrive en tableau du client, stocké en texte joint. */
      activityTags: z.array(z.string().trim().max(40)).max(80).optional(),
      targets:S(300),
      /* Colonnes riches de la masterlist (migration 032), toutes facultatives. */
      status:S(80), applicability:S(200), reportingReq:S(200), outputType:S(120),
      unitInterp:S(200), flexibility:S(80), followValue:S(200), intermediate:S(300),
      activity:S(40) }),
    map: (x) => ({ code:x.code, name:x.name, basket:x.basket, unit:x.unit,
      target:x.target, direction:x.direction, method:x.method, frequency:x.frequency,
      kind:x.kind, level:x.level, category:x.category, activity:x.activity,
      ...(x.activityTags !== undefined ? { activity_tags: x.activityTags.join(",") } : {}),
      ...(x.targets !== undefined ? { targets: x.targets } : {}),
      ...(x.status !== undefined ? { status: x.status } : {}),
      ...(x.applicability !== undefined ? { applicability: x.applicability } : {}),
      ...(x.reportingReq !== undefined ? { reporting_req: x.reportingReq } : {}),
      ...(x.outputType !== undefined ? { output_type: x.outputType } : {}),
      ...(x.unitInterp !== undefined ? { unit_interp: x.unitInterp } : {}),
      ...(x.flexibility !== undefined ? { flexibility: x.flexibility } : {}),
      ...(x.followValue !== undefined ? { follow_value: x.followValue } : {}),
      ...(x.intermediate !== undefined ? { intermediate: x.intermediate } : {}) }) },

  outcomes: { table:"outcomes", cap:"edit",
    schema: z.object({ id:S(64), indicator_id:z.string().min(1).max(64), adm1:S(120),
      round_label:S(80), planned:N(-1e6,1e6), value:N(-1e6,1e6),
      collected_at:S(20), sample:I() }),
    map: (x) => ({ indicator_id:x.indicator_id, adm1:x.adm1, round_label:x.round_label,
      planned:x.planned, value:x.value, collected_at:x.collected_at, sample:x.sample }) },

  population: { table:"population", cap:"edit",
    schema: z.object({ id:S(64), key:z.string().min(1).max(120),
      level:z.string().max(20).default("adm2"), base:I(), rate:N(-50,50) }),
    map: (x) => ({ area_key:x.key, level:x.level, base_year:2018, base:x.base, rate:x.rate }) },

  pdd: { table:"pdd", cap:"edit", office:true,
    schema: z.object({ id:S(64), year:I(2000,2100), month:I(0,11), wbs:S(40),
      actType:z.string().min(1).max(40), tag:S(20), actMain:S(200), office_id:S(64), geo_pcode:S(64),
      bureau:z.string().min(1).max(120), region:S(120), district:S(120), commune:S(120),
      partner_id:S(64), modality:z.enum(["Food","Cash","Voucher"]).default("Food"),
      commodity:S(120), days:I(0,366), benefPlanned:I(), households:I(), tonnage:N(),
      amount:N(), benefActual:I(), received:N(), distributed:N(),
      status:z.enum(["planned","ongoing","done","cancelled"]).default("planned"), note:S(500) }),
    map: (x) => ({ year:x.year, month:x.month, wbs:x.wbs, act_type:x.actType, geo_pcode:x.geo_pcode,
      activity_tag:x.tag, act_main:x.actMain, office_id:x.office_id, bureau:x.bureau,
      region:x.region, district:x.district, commune:x.commune, partner_id:x.partner_id,
      modality:x.modality, commodity:x.commodity, days:x.days, benef_planned:x.benefPlanned,
      households:x.households, tonnage:x.tonnage, amount:x.amount, benef_actual:x.benefActual,
      received:x.received, distributed:x.distributed, status:x.status, note:x.note }) },

  /* `blocks` porte DEUX formes, et la seconde n'est pas un raffinement gratuit.
     Les sept sections standard sont désignées par leur seul identifiant — une
     chaîne, comme depuis l'origine. Un CALCUL, lui, ne suffit pas à se désigner :
     il faut dire LEQUEL et COMMENT le montrer (chiffre, jauge, barre par
     activité, tableau). D'où l'objet `{ b:"calc", id, viz }`. Encoder ces trois
     informations dans une chaîne aurait tenu — jusqu'au premier identifiant
     technique un peu long, que le plafond de quarante caractères aurait tronqué
     en silence, c'est-à-dire en pointant vers un autre calcul ou vers aucun. */
  reportTemplates: { table:"report_templates", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      blocks: z.array(z.union([
        z.string().max(40),
        z.object({ b: z.literal("calc"), id: z.string().min(1).max(64),
                   viz: z.enum(["nombre","jauge","barres","tableau"]).default("nombre") }),
      ])).max(60).default([]),
      intro:S(4000) }),
    map: (x) => ({ name:x.name, blocks:JSON.stringify(x.blocks), intro:x.intro }) },

  /* Catalogue de rations (migration 031). « Une ration, une ligne » : un libellé
     de convention, UNE denrée (son code, = pdd.commodity), un grammage par
     personne et par jour, une activité par défaut facultative, une note. Une
     convention composée est plusieurs lignes de même libellé. Le tonnage se
     calcule à l'usage, jamais stocké. */
  rationCatalog: { table:"ration_catalog", cap:"edit",
    schema: z.object({ id:S(64), label:z.string().min(1).max(160),
      commodity:z.string().min(1).max(120), grams:N(0,1e7),
      /* La modalité de transfert (migration 034). Facultative et à défaut « Food »
         (vivres), pour qu'un client d'une version antérieure qui l'ignore n'efface
         pas la valeur des conventions existantes. Le grammage vaut alors montant
         (Ar) par personne et par jour pour les modalités espèces/coupons. */
      modality:z.string().trim().max(40).default("Food"),
      activityTag:S(40), note:S(500), sort:I(0,99999) }),
    map: (x) => ({ label:x.label, commodity:x.commodity, grams:x.grams,
      modality:x.modality || "Food",
      activity_tag:x.activityTag, note:x.note, sort_order:x.sort }) },

  dashboards: { table:"dashboards", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      widgets:z.array(z.record(z.any())).max(60).default([]) }),
    map: (x) => ({ name:x.name, widgets:JSON.stringify(x.widgets) }) },

  datasets: { table:"datasets", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160), formId:S(64),
      raw:z.array(z.record(z.any())).max(20000).default([]),
      rules:z.array(z.record(z.any())).max(200).default([]),
      formulas:z.array(z.record(z.any())).max(100).default([]) }),
    map: (x) => ({ name:x.name, form_id:x.formId, raw:JSON.stringify(x.raw),
      rules:JSON.stringify(x.rules), formulas:JSON.stringify(x.formulas) }) },

  scripts: { table:"scripts", cap:"edit",
    schema: z.object({ id:S(64), name:z.string().min(1).max(160),
      lang:z.enum(["R","SPSS"]).default("R"),
      stage:z.enum(["cleaning","analysis"]).default("analysis"),
      datasetId:S(64), code:z.string().max(200000).default(""), notes:S(2000),
      runs:z.array(z.record(z.any())).max(100).default([]) }),
    map: (x) => ({ name:x.name, language:x.lang, stage:x.stage, dataset_id:x.datasetId,
      code:x.code, notes:x.notes, runs:JSON.stringify(x.runs) }) },

  odkForms: { table:"odk_forms", cap:"admin",
    schema: z.object({ id:S(64), name:z.string().min(1).max(200),
      formId:z.string().min(1).max(120), project:S(40), token:S(400),
      /* Le schéma d'authentification de la source, contrôlé contre la table de
         lib/authSortante.js. Facultatif ici, et non « par défaut porteur » : une
         valeur par défaut réécrirait la colonne à chaque synchronisation, donc
         ramènerait à « porteur » toute source réglée en session ODK dès qu'un
         client un peu ancien renverrait la collection sans ce champ. */
      authSchema: z.enum(NOMS_SCHEMAS_AUTH).optional(),
      authIdentifiant: z.string().trim().max(200).optional(),
      kind:z.enum(["process","output","outcome","sites"]).default("process"),
      tag:S(20), siteField:S(120), dateField:S(120),
      labels:z.record(z.string().max(500)).default({}) }),
    map: (x) => ({ name:x.name, form_id:x.formId, project:x.project,
      kind:x.kind, activity_tag:x.tag, site_field:x.siteField, date_field:x.dateField,
      labels:JSON.stringify(x.labels),
      ...(x.authSchema !== undefined ? { auth_schema: x.authSchema } : {}),
      ...(x.authIdentifiant !== undefined ? { auth_identifiant: x.authIdentifiant || null } : {}),
      /* Le justificatif durable — jeton collé ou mot de passe selon le schéma —
         n'est jamais conservé en clair ; laissé vide, l'existant est préservé. */
      ...(x.token ? { token_enc: encrypt(x.token) } : {}) }) },
};

/* Synchronisation d'une collection.

   Deux différences essentielles avec la version précédente :

   — Les lignes absentes du corps ne sont PLUS supprimées. La suppression doit
     être demandée explicitement (`deletes`). Sans cela, un client qui n'avait
     jamais vu la ligne ajoutée par un collègue l'effaçait en enregistrant.

   — Chaque ligne peut porter la révision qu'elle avait à la lecture (`rev`).
     Si elle a changé depuis, l'écriture est refusée avec la valeur courante :
     le second à enregistrer est averti au lieu d'écraser en silence. */
r.put("/collections/:name", async (req, res, next) => {
  const def = COLLECTIONS[req.params.name];
  if(!def) return res.status(404).json({ error:"collection inconnue" });
  if(!can(req.user, def.cap))
    return res.status(403).json({ error:`droit « ${def.cap} » requis` });

  const withRev = def.schema.and(z.object({ rev: z.coerce.number().int().min(1).optional() }));
  const parsed = z.object({
    rows: z.array(withRev).max(60000),
    deletes: z.array(z.string().max(64)).max(60000).default([]),
  }).safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"données invalides",
    details: parsed.error.issues.slice(0,10).map(i=>({ champ:i.path.join("."), message:i.message })) });

  const { rows, deletes } = parsed.data;

  /* Supprimer n'est pas modifier. La matrice des rôles (lib/auth.js) réserve « del »
     à l'administration, mais la route entière n'était gardée que par « edit » : le
     tableau `deletes` passait donc avec, et un éditeur effaçait ce que son rôle lui
     interdit explicitement d'effacer. Le droit se vérifie ici, pas à l'écriture :
     un refus doit arriver avant que quoi que ce soit ne soit tenté. */
  if(deletes.length && !can(req.user, "del"))
    return res.status(403).json({ error:"droit « del » requis pour supprimer des lignes" });

  let created = 0, updated = 0, removed = 0;
  const conflits = [];

  /* ── Cloisonnement par bureau ────────────────────────────────────────
     `GET /api/state` cache déjà à un compte cloisonné les lignes des autres
     bureaux. L'écriture, elle, ne filtrait rien : il suffisait de nommer une ligne
     par son identifiant pour la modifier — et surtout pour la supprimer — dans un
     bureau qu'on n'a jamais eu le droit de voir. Le périmètre se calcule avec la
     même fonction que la lecture, pour que les deux ne puissent pas diverger ;
     un administrateur (officeBound = null) n'est borné par rien. */
  const bureau = def.office ? await officeBound(req.user) : null;

  if(bureau){
    /* Toucher la ligne d'un autre bureau se refuse explicitement plutôt que de se
       taire : sans ce contrôle, une ligne absente de `existing` retomberait dans la
       branche INSERT et échouerait sur une contrainte d'unicité — un 409 « doublon »
       parfaitement incompréhensible pour qui vient de tenter une modification. */
    const ailleurs = new Set((await db.prepare(
      `SELECT id FROM ${def.table} WHERE office_id IS NULL OR office_id<>?`).all(bureau))
      .map(x => x.id));
    const touchees = [...new Set([...rows.map(x => x.id), ...deletes]
      .filter(id => id && ailleurs.has(id)))];
    if(touchees.length) return res.status(403).json({
      error: "certaines lignes appartiennent à un autre bureau que le vôtre",
      lignes: touchees.slice(0, 20) });
  }

  /* Les conflits se détectent avant d'écrire : soit l'ensemble passe, soit rien. */
  const existing = new Map((bureau
    ? await db.prepare(`SELECT id, rev FROM ${def.table} WHERE office_id=?`).all(bureau)
    : await db.prepare(`SELECT id, rev FROM ${def.table}`).all()).map(x => [x.id, x.rev]));
  for(const raw of rows){
    if(!raw.id || !existing.has(raw.id)) continue;
    const courante = existing.get(raw.id);
    if(raw.rev !== undefined && raw.rev !== courante)
      conflits.push({ id:raw.id, revEnvoyee:raw.rev, revCourante:courante });
  }
  if(conflits.length){
    const qui = await db.prepare(`SELECT user_label, at FROM audit
      WHERE entity=? AND action='sync' ORDER BY at DESC LIMIT 1`).get(req.params.name);
    return res.status(409).json({
      error: `cette collection a été modifiée${qui?.user_label ? ` par ${qui.user_label}` : ""} `
        + "pendant votre saisie. Rechargez pour repartir de la version à jour.",
      conflits: conflits.slice(0, 20),
      /* Le client peut ainsi afficher ce qui a changé sans recharger tout l'état. */
      courant: await Promise.all(conflits.slice(0, 20).map(c =>
        db.prepare(`SELECT * FROM ${def.table} WHERE id=?`).get(c.id))),
    });
  }

  try{
    await tx(async (db) => {
      for(const raw of rows){
        const cols = def.map(raw);
        /* Le rattachement au bureau n'est pas une donnée que l'appelant choisit :
           un compte cloisonné qui déposerait une ligne dans un autre bureau ne
           pourrait plus jamais la relire ni la corriger — et l'aurait rendue
           invisible à ceux qu'elle concerne. */
        if(bureau) cols.office_id = bureau;
        const keys = Object.keys(cols);
        if(raw.id && existing.has(raw.id)){
          /* Le bureau est répété dans le WHERE, alors que `existing` le garantit déjà :
             la règle doit tenir dans le SQL lui-même, pour qu'aucune refonte future de
             la détection de conflits ne puisse la faire disparaître sans qu'on le voie. */
          await db.prepare(`UPDATE ${def.table} SET ${keys.map(k=>k+"=?").join(",")}, rev=rev+1
                      WHERE id=?${bureau ? " AND office_id=?" : ""}`)
            .run(...keys.map(k=>cols[k]), raw.id, ...(bureau ? [bureau] : []));
          updated++;
        } else {
          const nid = raw.id || newId(req.params.name.slice(0,4));
          await db.prepare(`INSERT INTO ${def.table} (id,${keys.join(",")})
                      VALUES (?,${keys.map(()=>"?").join(",")})`)
            .run(nid, ...keys.map(k=>cols[k]));
          created++;
        }
      }
      /* Suppressions demandées, et elles seules — bornées au bureau de l'appelant
         dans le SQL comme dans `existing`, pour la même raison que l'UPDATE. */
      const del = db.prepare(
        `DELETE FROM ${def.table} WHERE id=?${bureau ? " AND office_id=?" : ""}`);
      for(const id of deletes) if(existing.has(id))
        removed += (await del.run(id, ...(bureau ? [bureau] : []))).changes;
    });
  }catch(e){
    if(/foreign key|violates foreign key/i.test(e.message))
      return res.status(409).json({ error:"référence invalide : une clé étrangère ne correspond à aucun enregistrement" });
    if(/UNIQUE|unique constraint|duplicate key/i.test(e.message))
      return res.status(409).json({ error:"doublon : une contrainte d'unicité est violée" });
    return next(e);
  }
  /* Une synchronisation qui ne change rien n'a pas à polluer le journal. */
  if(created || updated || removed)
    await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                VALUES (?,?,?,'plan',?,'sync',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name, req.params.name,
           `${req.params.name} : ${created} créé(s), ${updated} modifié(s), ${removed} supprimé(s)`);
  res.json({ created, updated, removed });
});

/* Réglages : dictionnaire clé-valeur, réservé aux administrateurs. */
r.put("/settings", requireCap("admin"), async (req, res) => {
  const parsed = z.record(z.any()).safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"réglages invalides" });
  const FORBIDDEN = new Set(["apiToken","odkToken","jwtSecret"]);
  await tx(async (db) => {
    /* `stmt` est préparé DANS la transaction : préparé sur le pool, il tomberait
       sur une autre connexion que le BEGIN/COMMIT et perdrait l'atomicité. */
    const stmt = db.prepare(`INSERT INTO settings (key,value) VALUES (?,?)
                             ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    for(const [k,v] of Object.entries(parsed.data)){
      if(FORBIDDEN.has(k)) continue;                     /* aucun secret ne transite par ici */
      await stmt.run(k, JSON.stringify(v)); }
  });
  res.json({ ok:true });
});

/* Configuration de la PLANIFICATION du suivi — en droit ÉDITEUR (chantier S6 :
   « un éditeur peut être attribué à planifier les suivis »). Distincte de
   PUT /api/settings, qui reste réservée à l'admin pour la vraie configuration.

   Deux objets voyagent ici : les paramètres MRE (`mmr`, un réglage) et le
   calendrier de collecte (`outcomePlan`). Le calendrier va désormais dans sa
   TABLE `outcome_plan`, plus dans le blob `settings` : le reflet n'ombre plus la
   table (restriction 2 du lot de persistance). */
const mmrRow = z.object({ id:S(40), area:S(120), cashVoucher:S(10),
  duration:S(60), siteType:S(80), monitoring:S(80), guidance:S(400),
  coef:z.coerce.number().min(0).max(100) }).passthrough();
const planningConfigSchema = z.object({
  mmr: z.array(mmrRow).max(200).optional(),
  outcomePlan: z.record(z.array(z.boolean()).max(12)).optional(),
});
r.put("/planning-config", requireCap("edit"), async (req, res, next) => {
  const p = planningConfigSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"configuration de planification invalide",
    details: p.error.issues.slice(0,8).map(i=>({ champ:i.path.join("."), message:i.message })) });
  const year = new Date().getFullYear();
  try{
    await tx(async (db) => {
      if(p.data.mmr !== undefined)
        await db.prepare(`INSERT INTO settings (key,value) VALUES ('mmr',?)
                    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(p.data.mmr));
      if(p.data.outcomePlan !== undefined){
        /* Remplacement de l'année entière : une case décochée doit DISPARAÎTRE,
           pas seulement les cochées apparaître. */
        await db.prepare("DELETE FROM outcome_plan WHERE year=?").run(year);
        const ins = db.prepare(`INSERT INTO outcome_plan (indicator_id,year,month,planned) VALUES (?,?,?,1)
                                ON CONFLICT(indicator_id,year,month) DO UPDATE SET planned=1`);
        const idDe = db.prepare("SELECT id FROM indicators WHERE code=?");
        for(const [code, mois] of Object.entries(p.data.outcomePlan)){
          const ind = await idDe.get(code); if(!ind) continue;      /* un code inconnu est ignoré, pas une erreur */
          for(let m = 0; m < mois.length; m++){ if(mois[m] && m >= 0 && m < 12) await ins.run(ind.id, year, m); }
        }
        /* Purge de l'ancien reflet dans settings : il ne doit plus ombrer la table. */
        await db.prepare("DELETE FROM settings WHERE key='outcomePlan'").run();
      }
    });
  }catch(e){ return next(e); }
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','planning','config',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, "Configuration de planification mise à jour");
  res.json({ ok:true });
});

/* Validation d'une visite : action métier distincte, tracée et réservée. */
r.put("/visits/:id/status", requireCap("validate"), async (req, res) => {
  const p = z.object({ status: z.enum(["Validé","À valider","Erreur"]) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"statut invalide" });
  const v = await db.prepare("SELECT * FROM visits WHERE id=?").get(req.params.id);
  if(!v) return res.status(404).json({ error:"visite introuvable" });
  /* Cloisonnement par bureau : `validator` est un rôle borné (lib/scope.js), et
     valider est une écriture. Sans cette garde, un validateur du bureau A qui
     devine l'identifiant d'une visite du bureau B pouvait la valider ou la marquer
     « Erreur » — la même IDOR que les routes de sites/aliases/ciblage referment.
     404 plutôt que 403, pour ne pas confirmer l'existence d'une visite hors périmètre. */
  const bureau = await officeBound(req.user);
  if(bureau && v.office_id !== bureau) return res.status(404).json({ error:"visite introuvable" });
  await db.prepare("UPDATE visits SET status=?, validated_by=?, validated_at=now() WHERE id=?")
    .run(p.data.status, req.user.id, v.id);
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'odk','visits',?,'validate',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, v.id,
         `Visite ${p.data.status.toLowerCase()} — ${v.visit_date}`);
  res.json({ ok:true });
});

r.get("/audit", requireCap("admin"), async (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit,10) || 100);
  /* Même départage qu'à /api/state : `at` est à la seconde, et sans second critère
     ce « N plus récentes » rendait les plus anciennes de la seconde la plus récente.
     `id` (ULID triable) remplace `rowid`, qui n'existe pas en PostgreSQL. */
  res.json({ rows: await db.prepare("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?")
    .all(limit) });
});
export default r;
