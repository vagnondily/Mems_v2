import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { currentVersion, LEVELS } from "../lib/geo.js";
import { scopeOf, covers, officeReach } from "../lib/scope.js";

/* ═══════════════════════════════════════════════════════════════════════
   Concevoir un plan de distribution.

   Il ne se concevait pas : il se SAISISSAIT. Une ligne par commune, par mois, par
   activité et par modalité, ajoutée une à une dans une fenêtre de vingt champs. Pour
   un pays qui compte quelques centaines de communes et douze mois d'exercice, cela
   fait des milliers de lignes à taper — et à retaper l'année suivante. Personne ne
   fait cela ; on le fait dans un tableur, et l'application ne sert plus à rien.

   Or le plan n'est pas une saisie : c'est une DÉRIVATION. On sait déjà, commune par
   commune, combien de personnes sont ciblées — c'est le ciblage, déjà dans la base.
   Le plan en découle : les communes retenues, les mois retenus, un taux de couverture,
   une ration, et les lignes s'écrivent toutes seules. Ce qui reste à la main, c'est
   l'ajustement — et l'ajustement de quelques dizaines de lignes est un travail
   raisonnable là où leur création ne l'était pas.

   Deux gestes, donc, et ils couvrent l'essentiel du travail réel :

     GÉNÉRER    à partir du ciblage, sur une zone et une période choisies ;
     REPRENDRE  un mois déjà conçu vers les mois suivants — car un plan de soudure
                se répète, avec des volumes qui varient peu.

   Tout se fait ici plutôt que dans le navigateur, pour trois raisons qui comptent :
   le rattachement géographique (geo_pcode) et le bureau responsable sont résolus par
   le découpage, qui vit ici ; la création de six cents lignes est une transaction, pas
   six cents allers-retours ; et le cloisonnement par bureau reste appliqué au même
   endroit que partout ailleurs.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

/* Une ration de vivres se compte en kilos par personne et par jour, un transfert
   monétaire en unités de la devise par personne et par jour. Ce sont des paramètres
   du plan, pas des constantes : ils changent d'une opération à l'autre. */
const DEFAUTS = { rationKg: 0.6, transfertJour: 1600 };

/* Le bureau qui couvre cette unité. Le périmètre déclaré d'un bureau est un ensemble
   de chemins ; une commune en relève si son chemin descend de l'un d'eux.

   Sans cette résolution, les lignes générées naîtraient sans bureau : invisibles de
   tous les écrans cloisonnés, y compris pour ceux qui viennent de les créer. */
function bureauxParChemin(){
  const offices = db.prepare(
    "SELECT id, name, code, kind FROM offices WHERE active IS NULL OR active=1 ORDER BY name").all();
  return offices.map(o => ({ ...o, scope: scopeOf({ role:"editor", office_id:o.id }) }));
}
function bureauDe(liste, path){
  /* Le plus précis d'abord : un bureau dont le périmètre est déclaré l'emporte sur un
     bureau national, qui couvrirait tout et ne dirait donc rien. */
  const declares = liste.filter(o => o.scope?.source === "declared" && covers(o.scope, path));
  if(declares.length) return declares[0];
  return liste.find(o => o.kind === "field" && covers(o.scope, path))
      || liste.find(o => covers(o.scope, path))
      || null;
}

/* ── Les zones où l'on peut planifier ─────────────────────────────────
   Les communes du périmètre de l'appelant, avec ce que l'on sait déjà d'elles : la
   population, les personnes ciblées pour cette activité, le bureau responsable, et ce
   qui est DÉJÀ planifié — sans quoi on regénérerait par-dessus sans le voir. */
r.get("/zones", (req, res) => {
  const q = z.object({
    year:  z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    tag:   z.string().max(20).optional(),
    level: z.enum(["adm2","adm3","adm4"]).default("adm3"),
    parent:z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(2000),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, tag, level, parent, limit } = q.data;

  const v = currentVersion();
  if(!v) return res.json({ rows:[], niveau:level,
    message:"aucun découpage administratif n'est chargé pour ce pays" });

  const where = ["u.version_id = ?", "u.level = ?"]; const args = [v.id, level];
  if(parent){
    const p = db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, parent);
    if(!p) return res.json({ rows:[], niveau:level });
    where.push("(u.path = ? OR u.path LIKE ?)"); args.push(p.path, p.path + "/%");
  }
  const units = db.prepare(
    `SELECT u.pcode, u.name, u.path, p1.name p1, p2.name p2, p3.name p3
     FROM geo_unit u
     LEFT JOIN geo_unit p1 ON p1.version_id=u.version_id AND p1.pcode=u.parent_pcode
     LEFT JOIN geo_unit p2 ON p2.version_id=u.version_id AND p2.pcode=p1.parent_pcode
     LEFT JOIN geo_unit p3 ON p3.version_id=u.version_id AND p3.pcode=p2.parent_pcode
     WHERE ${where.join(" AND ")} ORDER BY u.path LIMIT ?`).all(...args, limit);

  const scope = scopeOf(req.user);
  const kept = units.filter(u => covers(scope, u.path));

  /* Ciblage : la valeur annuelle de l'activité, ou le total dédoublonné si aucune
     activité n'est précisée. */
  const cl = {};
  for(const c of db.prepare(
    `SELECT geo_pcode, MAX(targeted) targeted, MAX(population) population, MAX(households) households
     FROM caseload WHERE year=? AND activity_tag=? GROUP BY geo_pcode`).all(year, tag || ""))
    cl[c.geo_pcode] = c;

  /* Ce qui existe déjà, par unité et par mois : le générateur doit pouvoir dire
     « 4 mois déjà planifiés ici » plutôt que d'empiler des doublons en silence. */
  const deja = {};
  for(const p of db.prepare(
    `SELECT geo_pcode, month, COUNT(*) n, SUM(benef_planned) benef FROM pdd
     WHERE year=? AND geo_pcode IS NOT NULL ${tag ? "AND activity_tag=?" : ""}
     GROUP BY geo_pcode, month`).all(...(tag ? [year, tag] : [year]))){
    (deja[p.geo_pcode] = deja[p.geo_pcode] || { mois:[], lignes:0, benef:0 });
    deja[p.geo_pcode].mois.push(p.month);
    deja[p.geo_pcode].lignes += p.n;
    deja[p.geo_pcode].benef  += p.benef || 0;
  }

  const bureaux = bureauxParChemin();
  const depth = LEVELS.indexOf(level);
  const rows = kept.map(u => {
    const c = cl[u.pcode] || {};
    const b = bureauDe(bureaux, u.path);
    const out = { pcode:u.pcode, name:u.name, path:u.path,
      population: c.population || 0, targeted: c.targeted || 0, households: c.households || 0,
      office_id: b?.id || null, bureau: b?.code || "", bureauNom: b?.name || "",
      dejaPlanifie: deja[u.pcode] || null };
    [u.p1, u.p2, u.p3].forEach((nm, i) => {
      const lvl = LEVELS[depth-1-i]; if(lvl && nm != null) out[lvl] = nm; });
    return out;
  });
  res.json({ rows, niveau:level, annee:year, tag: tag || null,
    sansCiblage: rows.filter(x => !x.targeted).length,
    sansBureau: rows.filter(x => !x.office_id).length });
});

const genSchema = z.object({
  year:   z.coerce.number().int().min(2000).max(2100),
  months: z.array(z.coerce.number().int().min(0).max(11)).min(1).max(12),
  pcodes: z.array(z.string().max(64)).min(1).max(3000),
  actType: z.string().trim().min(1).max(40),
  tag:     z.string().trim().max(20).default(""),
  actMain: z.string().trim().max(200).default(""),
  wbs:     z.string().trim().max(40).default(""),
  modality: z.enum(["Food","Cash","Voucher"]).default("Food"),
  commodity: z.string().trim().max(120).default(""),
  days: z.coerce.number().int().min(1).max(366).default(30),
  partner_id: z.string().max(64).nullish().transform(v => v || null),
  /* D'où viennent les bénéficiaires : du ciblage, à un taux de couverture donné,
     ou d'un nombre fixe par commune quand le ciblage n'est pas encore saisi. */
  source: z.enum(["ciblage","fixe"]).default("ciblage"),
  couverture: z.coerce.number().min(1).max(100).default(100),
  fixe: z.coerce.number().int().min(0).max(1e7).default(0),
  rationKg: z.coerce.number().min(0).max(10).default(DEFAUTS.rationKg),
  transfertJour: z.coerce.number().min(0).max(1e7).default(DEFAUTS.transfertJour),
  taillMenage: z.coerce.number().min(1).max(20).default(4.8),
  /* Que faire d'une ligne déjà présente pour la même commune, le même mois et la
     même activité : passer son tour, ou la remplacer. Jamais empiler en silence. */
  conflits: z.enum(["ignorer","remplacer"]).default("ignorer"),
});

/* ── Générer ──────────────────────────────────────────────────────────
   `apercu` calcule sans rien écrire : on montre ce qui va être créé, combien de
   lignes, combien de bénéficiaires, quel tonnage — et l'on écrit ensuite. Un plan de
   six cents lignes ne se crée pas sans l'avoir vu. */
function construire(b, req){
  const v = currentVersion();
  if(!v) return { error:"aucun découpage administratif n'est chargé pour ce pays" };

  const unites = db.prepare(
    `SELECT pcode, name, path FROM geo_unit WHERE version_id=? AND pcode IN (${
      b.pcodes.map(()=>"?").join(",")})`).all(v.id, ...b.pcodes);
  const scope = scopeOf(req.user);
  const hors = unites.filter(u => !covers(scope, u.path));
  if(hors.length) return { error:`${hors.length} unité(s) sont hors de votre périmètre`,
    unites: hors.slice(0,10).map(u => u.name) };
  if(!unites.length) return { error:"aucune unité reconnue dans ce découpage" };

  /* Les ancêtres, pour renseigner région / district / commune comme le fait la saisie
     manuelle : les écrans filtrent là-dessus. */
  const parNom = Object.fromEntries(db.prepare(
    "SELECT pcode, name, level FROM geo_unit WHERE version_id=?").all(v.id)
    .map(x => [x.pcode, x]));
  const ancetres = (path) => {
    const out = {};
    for(const p of (path || "").split("/").filter(Boolean)){
      const a = parNom[p]; if(a) out[a.level] = a.name;
    }
    return out;
  };

  const ciblage = {};
  for(const c of db.prepare(
    `SELECT geo_pcode, MAX(targeted) t FROM caseload WHERE year=? AND activity_tag=? GROUP BY geo_pcode`)
    .all(b.year, b.tag || ""))
    ciblage[c.geo_pcode] = c.t || 0;

  const bureaux = bureauxParChemin();

  /* Ce qui existe déjà pour la même commune, le même mois, la même activité. */
  const existant = new Map();
  for(const p of db.prepare(
    `SELECT id, geo_pcode, month FROM pdd WHERE year=? AND act_type=? AND geo_pcode IS NOT NULL`)
    .all(b.year, b.actType))
    existant.set(`${p.geo_pcode}|${p.month}`, p.id);

  const lignes = [], ignorees = [], remplacees = [];
  let sansBureau = 0, sansBenef = 0;
  for(const u of unites){
    const anc = ancetres(u.path);
    const bur = bureauDe(bureaux, u.path);
    if(!bur) sansBureau++;
    const cible = b.source === "fixe" ? b.fixe
      : Math.round((ciblage[u.pcode] || 0) * b.couverture / 100);
    if(!cible) sansBenef++;
    for(const m of b.months){
      const cle = `${u.pcode}|${m}`;
      if(existant.has(cle)){
        if(b.conflits === "ignorer"){ ignorees.push(cle); continue; }
        remplacees.push(existant.get(cle));
      }
      lignes.push({
        id: newId("pdd"), year:b.year, month:m, wbs:b.wbs, act_type:b.actType,
        activity_tag:b.tag, act_main:b.actMain,
        office_id: bur?.id || null, bureau: bur?.code || "",
        geo_pcode: u.pcode,
        region: anc.adm1 || "", district: anc.adm2 || "", commune: anc.adm3 || u.name,
        partner_id: b.partner_id, modality: b.modality, commodity: b.commodity, days: b.days,
        benef_planned: cible,
        households: Math.round(cible / b.taillMenage),
        tonnage: b.modality === "Food" ? Math.round(cible * b.days * b.rationKg) / 1000 : 0,
        amount:  b.modality === "Food" ? 0 : Math.round(cible * b.days * b.transfertJour),
        benef_actual:0, received:0, distributed:0, status:"planned",
        note:"Généré depuis le ciblage",
      });
    }
  }
  return { lignes, ignorees, remplacees, sansBureau, sansBenef };
}

r.post("/preview", requireCap("edit"), (req, res) => {
  const p = genSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"paramètres de génération invalides",
    details:p.error.issues.slice(0,8).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const c = construire(p.data, req);
  if(c.error) return res.status(422).json(c);
  const s = (k) => c.lignes.reduce((t,l) => t + (l[k] || 0), 0);
  res.json({
    lignes: c.lignes.length, ignorees: c.ignorees.length, remplacees: c.remplacees.length,
    sansBureau: c.sansBureau, sansBenef: c.sansBenef,
    beneficiaires: s("benef_planned"), menages: s("households"),
    tonnage: Math.round(s("tonnage") * 10) / 10, montant: s("amount"),
    /* Un échantillon suffit à reconnaître une erreur de paramétrage — mille lignes
       d'aperçu ne se lisent pas. */
    exemples: c.lignes.slice(0, 8).map(l => ({ commune:l.commune, district:l.district,
      bureau:l.bureau, month:l.month, benef:l.benef_planned, tonnage:l.tonnage, amount:l.amount })),
  });
});

r.post("/generate", requireCap("edit"), (req, res) => {
  const p = genSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"paramètres de génération invalides",
    details:p.error.issues.slice(0,8).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const c = construire(p.data, req);
  if(c.error) return res.status(422).json(c);
  if(!c.lignes.length) return res.status(409).json({
    error:"rien à générer : toutes les lignes demandées existent déjà pour cette activité",
    ignorees:c.ignorees.length });

  const ins = db.prepare(`INSERT INTO pdd
    (id,year,month,wbs,act_type,activity_tag,act_main,office_id,bureau,geo_pcode,region,district,
     commune,partner_id,modality,commodity,days,benef_planned,households,tonnage,amount,
     benef_actual,received,distributed,status,note)
    VALUES (@id,@year,@month,@wbs,@act_type,@activity_tag,@act_main,@office_id,@bureau,@geo_pcode,
     @region,@district,@commune,@partner_id,@modality,@commodity,@days,@benef_planned,@households,
     @tonnage,@amount,@benef_actual,@received,@distributed,@status,@note)`);
  const del = db.prepare("DELETE FROM pdd WHERE id=?");

  tx(() => {
    for(const id of c.remplacees) del.run(id);
    for(const l of c.lignes) ins.run(l);
    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                VALUES (?,?,?,'plan','pdd','generate',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
        `Plan de distribution ${p.data.year} — ${c.lignes.length} ligne(s) générée(s) sur ` +
        `${p.data.pcodes.length} unité(s) et ${p.data.months.length} mois (${p.data.actType})`);
  })();

  res.status(201).json({ creees:c.lignes.length, remplacees:c.remplacees.length,
    ignorees:c.ignorees.length, sansBureau:c.sansBureau, sansBenef:c.sansBenef });
});

/* ── Reprendre un mois ────────────────────────────────────────────────
   Un plan de soudure se répète : les mêmes communes, les mêmes partenaires, des
   volumes qui varient peu. Le recopier à la main mois après mois est exactement le
   genre de travail qu'une machine doit faire. */
r.post("/duplicate", requireCap("edit"), (req, res) => {
  const p = z.object({
    year: z.coerce.number().int().min(2000).max(2100),
    fromMonth: z.coerce.number().int().min(0).max(11),
    toMonths: z.array(z.coerce.number().int().min(0).max(11)).min(1).max(12),
    actType: z.string().trim().max(40).optional(),
    /* Les réalisations ne se recopient jamais : elles n'ont pas eu lieu. */
    conflits: z.enum(["ignorer","remplacer"]).default("ignorer"),
    facteur: z.coerce.number().min(0.01).max(10).default(1),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"paramètres invalides" });
  const b = p.data;
  if(b.toMonths.includes(b.fromMonth))
    return res.status(422).json({ error:"le mois d'origine ne peut pas être aussi un mois de destination" });

  const oc = officeReach;   /* rappel : la portée est vérifiée ligne à ligne ci-dessous */
  const source = db.prepare(
    `SELECT * FROM pdd WHERE year=? AND month=? ${b.actType ? "AND act_type=?" : ""}`)
    .all(...(b.actType ? [b.year, b.fromMonth, b.actType] : [b.year, b.fromMonth]))
    .filter(l => !oc(req.user, l.office_id ?? null));
  if(!source.length) return res.status(404).json({
    error:"aucune ligne à reprendre pour ce mois dans votre périmètre" });

  const existant = new Set(db.prepare(
    `SELECT geo_pcode, month, act_type FROM pdd WHERE year=?`).all(b.year)
    .map(x => `${x.geo_pcode}|${x.month}|${x.act_type}`));

  const ins = db.prepare(`INSERT INTO pdd
    (id,year,month,wbs,act_type,activity_tag,act_main,office_id,bureau,geo_pcode,region,district,
     commune,partner_id,modality,commodity,days,benef_planned,households,tonnage,amount,
     benef_actual,received,distributed,status,note)
    VALUES (@id,@year,@month,@wbs,@act_type,@activity_tag,@act_main,@office_id,@bureau,@geo_pcode,
     @region,@district,@commune,@partner_id,@modality,@commodity,@days,@benef_planned,@households,
     @tonnage,@amount,0,0,0,'planned',@note)`);
  const del = db.prepare("DELETE FROM pdd WHERE year=? AND month=? AND geo_pcode IS ? AND act_type=?");

  let creees = 0, ignorees = 0;
  tx(() => {
    for(const m of b.toMonths){
      for(const l of source){
        const cle = `${l.geo_pcode}|${m}|${l.act_type}`;
        if(existant.has(cle)){
          if(b.conflits === "ignorer"){ ignorees++; continue; }
          del.run(b.year, m, l.geo_pcode, l.act_type);
        }
        ins.run({ ...l, id:newId("pdd"), month:m,
          benef_planned: Math.round((l.benef_planned || 0) * b.facteur),
          households:    Math.round((l.households || 0) * b.facteur),
          tonnage: Math.round((l.tonnage || 0) * b.facteur * 100) / 100,
          amount:  Math.round((l.amount || 0) * b.facteur),
          note: `Repris de ${String(b.fromMonth + 1).padStart(2,"0")}/${b.year}` });
        creees++;
      }
    }
    if(creees) db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                VALUES (?,?,?,'plan','pdd','duplicate',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
        `Plan de distribution ${b.year} — ${creees} ligne(s) reprises du mois ` +
        `${b.fromMonth + 1} vers ${b.toMonths.map(m => m + 1).join(", ")}`);
  })();

  res.status(201).json({ creees, ignorees, source:source.length });
});

export default r;
