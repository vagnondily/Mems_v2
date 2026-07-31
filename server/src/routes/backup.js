import { Router } from "express";
import { z } from "zod";
import { db, tx } from "../db.js";
import { newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";

/* ═══════════════════════════════════════════════════════════════════════
   Sauvegarder, et surtout REVENIR.

   Une base SQLite se copie, bien sûr. Mais un fichier .db ne se lit pas, ne se
   vérifie pas avant de le remettre, et ne se restaure pas par morceaux : on remplace
   tout, ou rien. C'est suffisant pour un incident matériel et parfaitement inadapté à
   ce qui arrive vraiment — un import qui a mal tourné, un plan qu'on voudrait
   reprendre tel qu'il était en mars, une configuration à recopier d'une instance vers
   une autre.

   D'où un export en JSON, lisible, partiel ou complet, et un retour qui commence
   toujours par dire ce qu'il va faire.

   TROIS RÈGLES tiennent tout le reste :

     1. Aucun secret ne sort. Les empreintes de mots de passe, les jetons de session
        et les jetons ODK chiffrés sont retirés à l'export. Un fichier de sauvegarde
        circule par courriel et finit sur une clé USB ; il ne doit jamais suffire à
        se faire passer pour quelqu'un.

     2. On voit avant d'écrire. Le retour propose un examen — combien de lignes
        seraient créées, modifiées, supprimées, poste par poste — et n'écrit qu'à la
        demande expresse. Restaurer est destructeur ; le faire d'un seul clic serait
        une faute de conception.

     3. Tout ou rien. La restauration est une transaction unique : une erreur au
        milieu ne laisse pas la base à moitié dans le passé et à moitié dans le
        présent, ce qui serait le pire des deux mondes.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

/* Les postes qu'on sauvegarde, dans l'ordre où ils doivent être RÉÉCRITS : une table
   ne peut entrer avant celles dont ses clés étrangères dépendent. C'est aussi l'ordre
   inverse de la suppression. */
const POSTES = [
  { cle:"country",     table:"country",             label:"Pays et vocabulaire",           groupe:"configuration" },
  { cle:"offices",     table:"offices",             label:"Bureaux",                       groupe:"configuration" },
  { cle:"partners",    table:"partners",            label:"Partenaires d'exécution",       groupe:"configuration" },
  { cle:"categories",  table:"activity_categories", label:"Catégories d'activité",         groupe:"configuration" },
  { cle:"poiSubtypes", table:"poi_subtypes",        label:"Sous-types de point d'intérêt", groupe:"configuration" },
  { cle:"settings",    table:"settings",            label:"Réglages",                      groupe:"configuration" },
  { cle:"tpm",         table:"tpm",                 label:"Prestataires de suivi tiers",    groupe:"configuration" },

  { cle:"geoVersion",  table:"geo_version",         label:"Millésimes de découpage",       groupe:"decoupage" },
  { cle:"geoUnit",     table:"geo_unit",            label:"Unités administratives",        groupe:"decoupage" },
  { cle:"geoGeom",     table:"geo_geom",            label:"Contours",                      groupe:"decoupage", lourd:true },
  { cle:"officeScope", table:"office_scope",        label:"Périmètres des bureaux",        groupe:"decoupage" },

  { cle:"sites",       table:"sites",               label:"Registre des sites",            groupe:"operations" },
  { cle:"siteMonths",  table:"site_months",         label:"Grille mensuelle des sites",    groupe:"operations" },
  { cle:"visits",      table:"visits",              label:"Visites",                       groupe:"operations" },
  { cle:"params",      table:"coverage_params",     label:"Paramètres de couverture",      groupe:"operations" },
  { cle:"pdd",         table:"pdd",                 label:"Plan de distribution",          groupe:"operations" },
  { cle:"caseload",    table:"caseload",            label:"Ciblage",                       groupe:"operations" },
  { cle:"population",  table:"population",          label:"Population",                    groupe:"operations" },
  { cle:"populationValues", table:"population_values", label:"Population par année",       groupe:"operations" },

  { cle:"indicators",  table:"indicators",          label:"Indicateurs",                   groupe:"suivi" },
  { cle:"outcomes",    table:"outcomes",            label:"Valeurs mesurées",              groupe:"suivi" },
  { cle:"outcomePlan", table:"outcome_plan",        label:"Calendrier de collecte",        groupe:"suivi" },
  { cle:"outputs",     table:"outputs",             label:"Outputs",                       groupe:"suivi" },
  { cle:"mreActivity", table:"mre_activity",        label:"Plan MRE — activités",          groupe:"suivi" },
  { cle:"mreFrequency",table:"mre_frequency",       label:"Plan MRE — fréquences",         groupe:"suivi" },
  { cle:"mreSpend",    table:"mre_spend",           label:"Plan MRE — dépenses",           groupe:"suivi" },
  { cle:"tpmPlan",     table:"tpm_plan",            label:"Plans de suivi tiers",          groupe:"suivi" },
  { cle:"tpmLine",     table:"tpm_line",            label:"Lignes de suivi tiers",         groupe:"suivi" },
  { cle:"tpmExpense",  table:"tpm_expense",         label:"Dépenses de suivi tiers",       groupe:"suivi" },

  { cle:"reportTemplates", table:"report_templates", label:"Modèles de rapport",           groupe:"analyses" },
  { cle:"dashboards",  table:"dashboards",          label:"Tableaux de bord",              groupe:"analyses" },
  { cle:"datasets",    table:"datasets",            label:"Jeux de données",               groupe:"analyses", lourd:true },
  { cle:"scripts",     table:"scripts",             label:"Scripts d'analyse",             groupe:"analyses" },
  { cle:"odkForms",    table:"odk_forms",           label:"Sources ODK",                   groupe:"analyses" },
];

/* Les comptes sont sauvegardés sans de quoi s'y connecter : ni empreinte de mot de
   passe, ni jeton. On restaure QUI existait, pas comment il entrait. À la restauration,
   un compte recréé devra recevoir un nouveau mot de passe — c'est voulu. */
const COMPTES = { cle:"users", table:"users", label:"Comptes (sans mots de passe)",
  groupe:"configuration", retire:["pw_hash","reset_token","reset_expires"] };

const TOUS = [...POSTES, COMPTES];
const PAR_CLE = Object.fromEntries(TOUS.map(p => [p.cle, p]));

/* Les colonnes qui ne sortent jamais, quelle que soit la table : un jeton chiffré
   reste un secret, et une sauvegarde n'est pas un coffre-fort. */
const JAMAIS = new Set(["pw_hash","token_enc","reset_token","reset_expires"]);

/* Ce que vider une table casse ailleurs.

   C'est le piège de la restauration destructrice, et il ne se voit pas : le schéma
   détache les lignes dépendantes (ON DELETE SET NULL) au lieu de refuser. Remplacer
   les seuls partenaires, en réinsérant exactement les mêmes identifiants, laisse donc
   TROIS CENTS SITES SANS PARTENAIRE — l'effacement a eu lieu avant la réécriture, et
   la réécriture ne recolle rien. On récupère un fichier de sauvegarde conforme et une
   base amputée d'un lien qu'aucun écran ne signale.

   On refuse donc de vider un poste dont d'autres dépendent, à moins que ces autres ne
   soient restaurés dans le même mouvement — auquel cas leurs propres lignes seront
   réécrites avec leurs rattachements. */
const DEPENDANTS = {
  partners:   [["sites","partner_id"], ["pdd","partner_id"]],
  offices:    [["sites","office_id"], ["pdd","office_id"], ["visits","office_id"],
               ["coverage_params","office_id"], ["users","office_id"], ["partners","office_id"]],
  categories: [["sites","category_id"], ["coverage_params","category_id"]],
  tpm:        [["users","tpm_id"], ["tpm_plan","tpm_id"]],
  indicators: [["outcomes","indicator_id"], ["outcome_plan","indicator_id"]],
  sites:      [["site_months","site_id"], ["visits","site_id"]],
  geoVersion: [["geo_unit","version_id"], ["geo_geom","version_id"]],
};

const existe = (table) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

const compter = (table) => existe(table)
  ? db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : null;

/* ── Ce qu'on peut sauvegarder, et combien cela pèse ── */
r.get("/parts", requireCap("admin"), (req, res) => {
  res.json({ postes: TOUS.map(p => ({ cle:p.cle, label:p.label, groupe:p.groupe,
    lourd: !!p.lourd, lignes: compter(p.table), absent: !existe(p.table) })) });
});

/* ── Export ───────────────────────────────────────────────────────────
   `parts` choisit les postes ; sans lui, tout sort sauf les contours et les jeux de
   données bruts, qui pèsent à eux seuls plus que le reste réuni et qu'on ne veut pas
   traîner dans une sauvegarde quotidienne. */
r.get("/", requireCap("admin"), (req, res) => {
  const demandes = String(req.query.parts || "").split(",").map(s => s.trim()).filter(Boolean);
  const choisis = demandes.length
    ? TOUS.filter(p => demandes.includes(p.cle))
    : TOUS.filter(p => !p.lourd);
  if(!choisis.length) return res.status(422).json({ error:"aucun poste reconnu à sauvegarder" });

  const donnees = {}; const resume = [];
  for(const p of choisis){
    if(!existe(p.table)) continue;
    const rows = db.prepare(`SELECT * FROM ${p.table}`).all();
    const propre = rows.map(row => {
      const o = {};
      for(const [k, v] of Object.entries(row)){
        if(JAMAIS.has(k) || (p.retire || []).includes(k)) continue;
        o[k] = v;
      }
      return o;
    });
    donnees[p.cle] = propre;
    resume.push({ cle:p.cle, label:p.label, lignes:propre.length });
  }

  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
              VALUES (?,?,?,'plan','backup','export',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
      `Sauvegarde JSON — ${resume.length} poste(s), ${resume.reduce((t,x)=>t+x.lignes,0)} ligne(s)`);

  const nom = `mems_sauvegarde_${new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")}.json`;
  res.setHeader("Content-Disposition", `attachment; filename="${nom}"`);
  res.json({
    manifeste: {
      format: "mems-sauvegarde/1",
      cree: new Date().toISOString(),
      par: req.user.email || req.user.first_name,
      postes: resume,
      /* Sans cette mention, on ne saurait pas, en relisant le fichier six mois plus
         tard, que les comptes n'y portent pas de mot de passe. */
      avertissements: [
        "Les empreintes de mots de passe et les jetons ne figurent pas dans ce fichier.",
        ...(choisis.some(p => p.lourd) ? [] :
          ["Les contours géographiques et les jeux de données bruts n'y figurent pas non plus : demandez-les explicitement."]),
      ],
    },
    donnees,
  });
});

/* ── Retour en arrière ────────────────────────────────────────────────
   Deux modes, et ils ne se ressemblent pas :

     « completer »  n'écrit que ce qui manque. Les lignes déjà présentes ne sont pas
                    touchées. C'est le mode sûr, et celui qui sert à recopier une
                    configuration d'une instance vers une autre.

     « remplacer »  vide chaque poste retenu avant de le réécrire. C'est un retour en
                    arrière véritable, et c'est destructeur : ce qui a été fait depuis
                    la sauvegarde disparaît.

   Dans les deux cas, `examiner` d'abord. */
const restoreSchema = z.object({
  donnees: z.record(z.array(z.record(z.any())).max(200000)),
  parts: z.array(z.string().max(40)).max(60).optional(),
  mode: z.enum(["completer","remplacer"]).default("completer"),
  examiner: z.boolean().default(true),
});

r.post("/restore", requireCap("admin"), (req, res) => {
  const p = restoreSchema.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"fichier de sauvegarde illisible",
    details:p.error.issues.slice(0,6).map(i => ({ champ:i.path.join("."), message:i.message })) });
  const { donnees, mode, examiner } = p.data;

  const demandes = p.data.parts?.length ? p.data.parts : Object.keys(donnees);
  const inconnus = demandes.filter(c => !PAR_CLE[c]);
  if(inconnus.length) return res.status(422).json({
    error:`poste(s) inconnu(s) dans ce fichier : ${inconnus.slice(0,5).join(", ")}` });

  /* On suit l'ordre de déclaration, pas celui du fichier : une table ne peut entrer
     avant celles dont ses clés étrangères dépendent. */
  const choisis = TOUS.filter(x => demandes.includes(x.cle) && Array.isArray(donnees[x.cle]));
  if(!choisis.length) return res.status(422).json({ error:"aucune donnée à restaurer" });

  /* Les tables que la restauration réécrira : si une dépendance en fait partie, son
     détachement sera réparé par sa propre réécriture. */
  const reecrites = new Set(choisis.map(x => PAR_CLE[x.cle].table));

  const plan = [];
  const casseraient = [];
  for(const poste of choisis){
    if(!existe(poste.table)){ plan.push({ cle:poste.cle, label:poste.label, absent:true }); continue; }
    const colonnes = new Set(db.prepare(`PRAGMA table_info(${poste.table})`).all().map(c => c.name));
    const presentes = new Set(db.prepare(`SELECT id FROM ${poste.table}`).all
      ? db.prepare(`SELECT * FROM ${poste.table}`).all().map(x => x.id ?? x.key) : []);
    const entrantes = donnees[poste.cle];
    const cle = colonnes.has("id") ? "id" : (colonnes.has("key") ? "key" : null);
    const nouvelles = cle ? entrantes.filter(x => !presentes.has(x[cle])).length : entrantes.length;
    /* Ce que vider ce poste détacherait ailleurs, et qui ne serait pas réparé. */
    const degats = [];
    if(mode === "remplacer"){
      for(const [table, colonne] of (DEPENDANTS[poste.cle] || [])){
        if(reecrites.has(table) || !existe(table)) continue;
        const n = db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${colonne} IS NOT NULL`).get().c;
        if(n) degats.push({ table, colonne, lignes:n });
      }
      if(degats.length) casseraient.push({ cle:poste.cle, label:poste.label, degats });
    }

    plan.push({ cle:poste.cle, label:poste.label, detacherait: degats.length ? degats : undefined,
      entrantes: entrantes.length,
      enBase: compter(poste.table),
      creees: mode === "remplacer" ? entrantes.length : nouvelles,
      inchangees: mode === "remplacer" ? 0 : entrantes.length - nouvelles,
      supprimees: mode === "remplacer" ? compter(poste.table) : 0,
      /* Une colonne du fichier qui n'existe plus dans le schéma est ignorée ; le dire
         vaut mieux que de la laisser disparaître sans bruit. */
      colonnesIgnorees: [...new Set(entrantes.flatMap(x => Object.keys(x)))]
        .filter(k => !colonnes.has(k)).slice(0, 8),
    });
  }

  const detacherait = casseraient.reduce((t,x) => t + x.degats.reduce((u,d)=>u+d.lignes,0), 0);
  if(examiner) return res.json({ mode, examen:true, plan, casseraient, detacherait,
    total: { creees: plan.reduce((t,x)=>t+(x.creees||0),0),
             supprimees: plan.reduce((t,x)=>t+(x.supprimees||0),0) } });

  /* Le refus vaut mieux que la réparation : on ne sait pas reconstruire un lien que
     le schéma vient d'effacer, et une restauration qui ampute la base en silence est
     bien pire que pas de restauration du tout. */
  if(casseraient.length) return res.status(409).json({
    error: `remplacer ces postes détacherait ${detacherait} ligne(s) ailleurs, sans possibilité de les recoller`,
    casseraient,
    remede: "ajoutez les postes dépendants à la restauration, ou choisissez le mode « compléter »",
  });

  let creees = 0, supprimees = 0;
  try{
    tx(() => {
      /* Suppression dans l'ordre INVERSE des dépendances, insertion dans l'ordre
         direct : sans cela, vider `offices` avant `sites` casserait les clés. */
      if(mode === "remplacer")
        for(const poste of [...choisis].reverse())
          if(existe(poste.table)) supprimees += db.prepare(`DELETE FROM ${poste.table}`).run().changes;

      for(const poste of choisis){
        if(!existe(poste.table)) continue;
        const colonnes = db.prepare(`PRAGMA table_info(${poste.table})`).all().map(c => c.name);
        const garde = new Set(colonnes);
        for(const brut of donnees[poste.cle]){
          const cols = Object.keys(brut).filter(k => garde.has(k) && !JAMAIS.has(k));
          if(!cols.length) continue;
          const sql = `INSERT OR IGNORE INTO ${poste.table} (${cols.join(",")})
                       VALUES (${cols.map(()=>"?").join(",")})`;
          creees += db.prepare(sql).run(...cols.map(k => {
            const v = brut[k];
            /* SQLite ne sait pas ranger un objet : ce qui arrive en JSON structuré
               vient d'une colonne qui contenait déjà du JSON. */
            return (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
          })).changes;
        }
      }
      db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,action,text)
                  VALUES (?,?,?,'plan','backup','restore',?)`)
        .run(newId("aud"), req.user.id, req.user.first_name || req.user.email,
          `Restauration ${mode} — ${choisis.length} poste(s), ${creees} ligne(s) écrites, ${supprimees} supprimées`);
    })();
  }catch(e){
    /* La transaction a été annulée : la base est exactement dans l'état d'avant. */
    return res.status(409).json({ error:`restauration annulée : ${e.message}`,
      note:"aucune modification n'a été conservée" });
  }

  res.json({ mode, examen:false, creees, supprimees,
    postes: choisis.map(x => x.cle),
    /* Une restauration de comptes laisse des comptes sans mot de passe utilisable. */
    note: choisis.some(x => x.cle === "users")
      ? "Les comptes restaurés n'ont pas de mot de passe : réinitialisez-les avant de les rouvrir."
      : undefined });
});

export default r;
