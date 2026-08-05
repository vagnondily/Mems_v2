import { Router } from "express";
import { z } from "zod";
import ExcelJS from "exceljs";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";
import { currentVersion, LEVELS } from "../lib/geo.js";
import { scopeOf } from "../lib/scope.js";

/* ── Ciblage daté ─────────────────────────────────────────────────────
   Le ciblage se refait dans le temps ; on garde CHAQUE événement, daté, avec sa
   raison et son genre. Le « dernier ciblage » d'une unité pour une activité est
   la ligne à la date la plus récente. On sélectionne des districts/communes en
   amont, on leur affecte un ciblage (personnes, ménages, genre, raison, date),
   puis on peut extraire un classeur prérempli — seules les unités ciblées y
   figurent — modifiable puis réimportable dans le flux d'import existant. */
const r = Router();

/* Le chemin d'une unité (pour le cloisonnement par bureau) et son libellé.

   `pcodes` borne la lecture aux unités RÉELLEMENT concernées — celles que les
   ciblages citent, ou celles qu'un enregistrement vise. Sans borne, chaque appel
   chargeait le découpage ENTIER (à Madagascar, ~18 000 fokontany avec trois
   jointures d'ancêtres) pour n'en regarder que quelques dizaines, à chaque
   ouverture de l'écran et à chaque enregistrement. Le découpage est le plus gros
   référentiel de MEMS ; il n'a pas à traverser la mémoire pour dater un ciblage.

   La liste est DÉCOUPÉE en tranches : SQLite plafonne le nombre de paramètres
   d'une requête, et un ciblage national portant des milliers de communes ferait
   sinon échouer l'appel — c'est-à-dire l'écran. */
const PAR_TRANCHE = 800;
async function chargerUnites(v, pcodes){
  const sql = (clause) => `SELECT u.pcode, u.name, u.path, u.level, p1.name p1, p2.name p2, p3.name p3
     FROM geo_unit u
     LEFT JOIN geo_unit p1 ON p1.version_id=u.version_id AND p1.pcode=u.parent_pcode
     LEFT JOIN geo_unit p2 ON p2.version_id=u.version_id AND p2.pcode=p1.parent_pcode
     LEFT JOIN geo_unit p3 ON p3.version_id=u.version_id AND p3.pcode=p2.parent_pcode
     WHERE u.version_id=? ${clause}`;
  const out = {};
  if(!pcodes){
    for(const u of await db.prepare(sql("")).all(v.id)) out[u.pcode] = u;
    return out;
  }
  const liste = [...new Set(pcodes)];
  for(let i = 0; i < liste.length; i += PAR_TRANCHE){
    const tranche = liste.slice(i, i + PAR_TRANCHE);
    if(!tranche.length) continue;
    for(const u of await db.prepare(sql(`AND u.pcode IN (${tranche.map(()=>"?").join(",")})`))
      .all(v.id, ...tranche)) out[u.pcode] = u;
  }
  return out;
}

const dansPerimetre = (scope, path) => scope.unbounded
  || (path && scope.paths.some(p => path === p || path.startsWith(p + "/")));

/* Les libellés d'ancêtres d'une unité, rangés par niveau (adm1/adm2/adm3…). */
function libellesAncetres(u){
  const out = {}; const depth = LEVELS.indexOf(u.level);
  [u.p1, u.p2, u.p3].forEach((nm, i) => { const lvl = LEVELS[depth-1-i];
    if(lvl && nm != null) out[lvl] = nm; });
  out[u.level] = u.name;
  return out;
}

/* ── L'état courant suit l'historique ─────────────────────────────────
   `caseload` porte « les ciblés du moment » et c'est de lui que se calculent les
   trois taux (ciblage, couverture, réalisation) ; `targeting` porte l'historique
   daté. La valeur courante d'une unité est, par définition du module, celle de
   son ciblage le plus RÉCENT — pas celle du dernier enregistrement effectué.

   La nuance décide de la correction : un ciblage saisi en retard, portant une
   date antérieure à un ciblage déjà connu, ne doit PAS écraser l'état courant, et
   supprimer le plus récent doit faire remonter celui d'avant. On ne recopie donc
   jamais la ligne qu'on vient d'écrire : on RECALCULE depuis l'historique.

   La ligne de caseload créée si besoin porte une population de 0 : c'est
   l'inconnu, pas un zéro affirmé, et le taux de ciblage reste nul (division par
   zéro rendue `null`) jusqu'à ce que la population soit renseignée. Écrire un
   ciblage ne prétend pas connaître la population.

   `exec` : l'exécuteur de requêtes. Les appelants (POST, DELETE) invoquent cette
   fonction DANS leur transaction et lui passent SON client, pour que le recalcul
   de l'état courant partage le ROLLBACK de l'écriture qui le déclenche. */
async function reporterCiblageCourant(pcode, year, tag, level, exec = db){
  const dernier = await exec.prepare(
    `SELECT targeted, targeted_hh, targeted_at FROM targeting
     WHERE geo_pcode=? AND year=? AND activity_tag=?
     ORDER BY targeted_at DESC, created_at DESC LIMIT 1`).get(pcode, year, tag);
  const ligne = await exec.prepare(
    `SELECT id, source FROM caseload
     WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS NULL`).get(pcode, year, tag);

  /* Plus aucun ciblage daté : l'état courant retombe à zéro plutôt que de garder
     le chiffre d'un événement effacé. La population, elle, ne se touche pas —
     elle ne vient pas du ciblage. */
  const cible = dernier?.targeted ?? 0, menages = dernier?.targeted_hh ?? 0;

  /* La provenance se COMPLÈTE, elle ne s'écrase pas. `source` documente d'où
     viennent les chiffres de la ligne — « RGPH3 » pour la population, par exemple.
     Y écrire la date du ciblage à la place ferait perdre l'origine du recensement
     pour gagner celle du ciblage : deux informations dont une seule tiendrait. On
     retire l'ancienne mention de ciblage (il n'y en a qu'une à la fois) et on pose
     la nouvelle à côté de ce qui était déjà là. */
  const MENTION = /(^|\s·\s)Ciblage daté du \d{4}-\d{2}-\d{2}/g;
  const reste = String(ligne?.source || "").replace(MENTION, "").replace(/^\s*·\s*/, "").trim();
  const mention = dernier ? `Ciblage daté du ${dernier.targeted_at}` : "";
  const source = [reste, mention].filter(Boolean).join(" · ").slice(0, 200);

  if(ligne){
    await exec.prepare(`UPDATE caseload SET targeted=?, targeted_hh=?, source=?,
                rev=rev+1, updated_at=now() WHERE id=?`)
      .run(cible, menages, source, ligne.id);
  } else if(dernier){
    await exec.prepare(`INSERT INTO caseload
      (id,geo_pcode,level,year,month,activity_tag,population,households,targeted,targeted_hh,source)
      VALUES (?,?,?,?,NULL,?,0,0,?,?,?)`)
      .run(newId("cl"), pcode, level || "adm3", year, tag, cible, menages, source);
  }
}

/* GET /api/targeting — les ciblages datés de l'année, chacun rattaché à son
   unité, avec un drapeau « dernier » (le plus récent par unité × activité). */
r.get("/", async (req, res) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    tag:  z.string().max(20).optional(),
    onlyLast: z.coerce.boolean().optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, tag, onlyLast } = q.data;

  const v = currentVersion();
  if(!v) return res.json({ year, rows:[], reasons:[] });
  const scope = await scopeOf(req.user);

  const where = ["year=?"]; const args = [year];
  if(tag !== undefined){ where.push("activity_tag=?"); args.push(tag); }
  const brut = await db.prepare(
    `SELECT * FROM targeting WHERE ${where.join(" AND ")} ORDER BY targeted_at DESC, created_at DESC`)
    .all(...args);
  /* Les unités citées par ces ciblages, et elles seules. */
  const unites = await chargerUnites(v, brut.map(t => t.geo_pcode));

  /* Le dernier par (unité, activité) : premier vu en ordre décroissant de date. */
  const vus = new Set();
  const rows = [];
  for(const t of brut){
    const u = unites[t.geo_pcode];
    if(!u || !dansPerimetre(scope, u.path)) continue;
    const cle = `${t.geo_pcode}|${t.activity_tag}`;
    const dernier = !vus.has(cle); vus.add(cle);
    if(onlyLast && !dernier) continue;
    rows.push({ id:t.id, pcode:t.geo_pcode, name:u.name, level:t.level,
      year:t.year, tag:t.activity_tag, targetedAt:t.targeted_at,
      targeted:t.targeted, targetedHh:t.targeted_hh, gender:t.gender||"",
      reason:t.reason||"", note:t.note||"", dernier, ...libellesAncetres(u) });
  }
  res.json({ year, rows, version:{ id:v.id, label:v.label } });
});

/* POST /api/targeting — enregistre UN ciblage (une date, une activité, une
   raison, un genre) sur une ou plusieurs unités sélectionnées en amont. */
/* La date du ciblage est la CLÉ de tout ce module : « le dernier ciblage est la
   ligne à la `targeted_at` la plus récente ». Elle était pourtant acceptée telle
   quelle — n'importe quelle chaîne de 4 à 20 caractères. Comme le classement se
   fait par comparaison de CHAÎNES (`ORDER BY targeted_at DESC`), une valeur non
   datée se range selon son premier caractère : « pas-une-date » passe devant
   « 2026-05-01 » et devient le « dernier ciblage » de la commune. L'écran
   préremplit alors le quota avec elle, l'extract la reprend, et la valeur
   réellement décidée disparaît sans un mot.

   On exige donc une date ISO complète, ET une date qui existe : `2026-02-31`
   satisfait l'expression régulière mais n'est pas un jour de l'année. */
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const dateReelle = (v) => {
  if(!DATE_ISO.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === v;
};

const corpsSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  activity_tag: z.string().max(20).default(""),
  targeted_at: z.string().refine(dateReelle,
    { message:"date du ciblage attendue au format AAAA-MM-JJ (et devant exister)" }),
  gender: z.string().max(30).nullish().transform(v => v ?? null),
  reason: z.string().max(60).nullish().transform(v => v ?? null),
  note: z.string().max(500).nullish().transform(v => v ?? null),
  units: z.array(z.object({
    geo_pcode: z.string().min(1).max(64),
    level: z.enum(["adm1","adm2","adm3","adm4"]).default("adm3"),
    targeted: z.coerce.number().int().min(0).default(0),
    targeted_hh: z.coerce.number().int().min(0).default(0),
  })).min(1).max(5000),
});

r.post("/", requireCap("edit"), async (req, res) => {
  const parsed = corpsSchema.safeParse(req.body);
  if(!parsed.success) return res.status(422).json({ error:"données invalides",
    details: parsed.error.issues.slice(0,10).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const d = parsed.data;

  const v = currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant : chargez un millésime d'abord" });
  const unites = await chargerUnites(v, d.units.map(x => x.geo_pcode));
  const scope = await scopeOf(req.user);

  /* La population connue de l'unité pour cette année et cette activité. Elle sert
     au même contrôle que celui de `PUT /api/caseload` : on ne cible pas plus de
     personnes qu'il n'en habite. Ce garde existait d'un côté et manquait de
     l'autre — deux portes vers le même fait, une seule surveillée. */
  const popDe = db.prepare(`SELECT population FROM caseload
    WHERE geo_pcode=? AND year=? AND activity_tag=? AND month IS NULL`);
  const popToutesActivites = db.prepare(`SELECT MAX(population) p FROM caseload
    WHERE geo_pcode=? AND year=?`);

  const rejets = [];
  const ok = [];
  for(const [i, x] of d.units.entries()){
    const u = unites[x.geo_pcode];
    if(!u){ rejets.push({ ligne:i+1, pcode:x.geo_pcode, message:"p-code absent du référentiel" }); continue; }
    if(!dansPerimetre(scope, u.path)){ rejets.push({ ligne:i+1, pcode:x.geo_pcode, message:"hors de votre périmètre" }); continue; }
    /* La population de l'activité si elle est renseignée, sinon la plus grande
       connue pour l'unité : le ciblage d'une activité donnée s'appuie sur la même
       population que les autres, et exiger une ligne par activité ferait échouer
       le contrôle là où la donnée existe pourtant. */
    const pop = (await popDe.get(x.geo_pcode, d.year, d.activity_tag))?.population
      || (await popToutesActivites.get(x.geo_pcode, d.year))?.p || 0;
    if(pop > 0 && x.targeted > pop){
      rejets.push({ ligne:i+1, pcode:x.geo_pcode,
        message:`${x.targeted} ciblés pour ${pop} habitants (${u.name})` });
      continue;
    }
    ok.push(x);
  }

  let crees = 0;
  await tx(async (db) => {
    const ins = db.prepare(`INSERT INTO targeting
      (id,geo_pcode,level,year,activity_tag,targeted_at,targeted,targeted_hh,gender,reason,note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for(const x of ok){
      await ins.run(newId("tg"), x.geo_pcode, x.level, d.year, d.activity_tag, d.targeted_at,
        x.targeted, x.targeted_hh, d.gender, d.reason, d.note, req.user.id);
      crees++;
      /* ── Et l'état COURANT suit ─────────────────────────────────────
         `targeting` est l'historique, `caseload` porte « les ciblés du moment »
         (migration 035) : c'est de LUI que les trois taux de l'écran « Population,
         ciblage et distribution » sont calculés. Rien ne reliait les deux. Un agent
         qui saisissait un ciblage de 1 234 personnes voyait donc son taux de
         ciblage et sa couverture rester inchangés — la valeur qu'il venait de
         décider n'entrait nulle part dans les chiffres, et il fallait la retaper
         dans un second écran pour qu'elle compte. Deux vérités pour un seul fait.

         On aligne l'état courant sur l'historique, à chaque écriture — dans CETTE
         transaction (on passe le client `db`), pour que les deux tables restent
         cohérentes même si l'écriture échoue en cours de route. */
      await reporterCiblageCourant(x.geo_pcode, d.year, d.activity_tag, x.level, db);
    }
  });

  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','targeting','cibler',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name,
      `Ciblage daté du ${d.targeted_at}${d.activity_tag?` (${d.activity_tag})`:""}${d.reason?` — ${d.reason}`:""} : ${crees} unité(s)`);

  res.json({ crees, rejetes: rejets.length, rejets: rejets.slice(0,20) });
});

/* Suppression dure d'un ciblage daté : elle exige « del », pas « edit » — un
   module qui conserve délibérément chaque événement daté suit la règle
   suppression ⇒ del, comme sites, mre et tpm. */
r.delete("/:id", requireCap("del"), async (req, res) => {
  const row = await db.prepare("SELECT * FROM targeting WHERE id=?").get(req.params.id);
  if(!row) return res.status(404).json({ error:"ciblage introuvable" });
  const v = currentVersion();
  const u = v && await db.prepare("SELECT path FROM geo_unit WHERE version_id=? AND pcode=?").get(v.id, row.geo_pcode);
  if(!dansPerimetre(await scopeOf(req.user), u?.path)) return res.status(403).json({ error:"hors de votre périmètre" });
  /* Supprimer le ciblage le plus récent fait remonter celui d'avant : l'état
     courant se recalcule depuis l'historique restant, dans la même transaction
     que la suppression. Sans cela, effacer une erreur de saisie laissait sa
     valeur dans les taux — c'est-à-dire que la correction ne corrigeait rien. */
  await tx(async (db) => {
    await db.prepare("DELETE FROM targeting WHERE id=?").run(req.params.id);
    await reporterCiblageCourant(row.geo_pcode, row.year, row.activity_tag, row.level, db);
  });
  await db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan','targeting',?,'delete',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, req.params.id,
      `Ciblage du ${row.targeted_at} supprimé${row.activity_tag?` (${row.activity_tag})`:""}`);
  res.json({ ok:true });
});

/* GET /api/targeting/extract — le classeur PRÉREMPLI des unités ciblées, et
   d'elles seules : le dernier ciblage par unité (× activité), modifiable puis
   réimportable. « Seules les unités ciblées s'afficheront dans l'extract. » */
r.get("/extract", async (req, res, next) => {
  const q = z.object({
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()),
    tag:  z.string().max(20).optional(),
  }).safeParse(req.query);
  if(!q.success) return res.status(422).json({ error:"filtres invalides" });
  const { year, tag } = q.data;

  const v = currentVersion();
  if(!v) return res.status(409).json({ error:"aucun référentiel courant" });
  const scope = await scopeOf(req.user);

  const where = ["year=?"]; const args = [year];
  if(tag !== undefined){ where.push("activity_tag=?"); args.push(tag); }
  const brut = await db.prepare(
    `SELECT * FROM targeting WHERE ${where.join(" AND ")} ORDER BY targeted_at DESC, created_at DESC`)
    .all(...args);
  const unites = await chargerUnites(v, brut.map(t => t.geo_pcode));

  const vus = new Set(); const lignes = [];
  for(const t of brut){
    const u = unites[t.geo_pcode]; if(!u || !dansPerimetre(scope, u.path)) continue;
    const cle = `${t.geo_pcode}|${t.activity_tag}`; if(vus.has(cle)) continue; vus.add(cle);
    const anc = libellesAncetres(u);
    lignes.push({ region:anc.adm1||"", district:anc.adm2||"", commune:anc.adm3||"",
      pcode:t.geo_pcode, activite:t.activity_tag, date:t.targeted_at,
      cibles:t.targeted, menages:t.targeted_hh, genre:t.gender||"", raison:t.reason||"", note:t.note||"" });
  }

  try{
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ciblage", { views:[{ state:"frozen", ySplit:1 }] });
    ws.columns = [
      { header:"Région", key:"region", width:20 },
      { header:"District", key:"district", width:20 },
      { header:"Commune", key:"commune", width:22 },
      { header:"P-code", key:"pcode", width:16 },
      { header:"Activité", key:"activite", width:12 },
      { header:"Date du ciblage", key:"date", width:16 },
      { header:"Personnes ciblées", key:"cibles", width:16 },
      { header:"Ménages ciblés", key:"menages", width:15 },
      { header:"Genre", key:"genre", width:12 },
      { header:"Raison", key:"raison", width:16 },
      { header:"Note", key:"note", width:30 },
    ];
    ws.getRow(1).font = { bold:true };
    ws.getRow(1).fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF0B4F6C" } };
    ws.getRow(1).font = { bold:true, color:{ argb:"FFFFFFFF" } };
    for(const l of lignes) ws.addRow(l);

    const nom = `mems_ciblage_${year}${tag?`_${tag}`:""}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${nom}"`);
    await wb.xlsx.write(res);
    res.end();
  }catch(e){ next(e); }
});

export default r;
