import { z } from "zod";

/* Le corps de requête est validé avant d'atteindre la base : rien ne passe en confiance. */
export const validate = (schema, source="body") => (req, res, next) => {
  const r = schema.safeParse(req[source]);
  if(!r.success){
    return res.status(422).json({ error:"données invalides",
      details: r.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  }
  req[source] = r.data;
  return next();
};

const id = z.string().min(1).max(64);
const nullableStr = (max=200) => z.string().max(max).nullish().transform(v => v ?? null);

export const schemas = {
  login: z.object({
    email: z.string().email().max(200),
    password: z.string().min(1).max(200),
  }),
  changePassword: z.object({
    current: z.string().min(1).max(200),
    next: z.string().min(12).max(200),
  }),
  site: z.object({
    id: id.optional(),
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    status: z.enum(["Active","Inactive"]).default("Active"),
    office_id: nullableStr(64), antenne: nullableStr(120),
    category_id: nullableStr(64), activity_tag: nullableStr(20),
    program_area: nullableStr(200), program_tag: nullableStr(200),
    poi_subtype: nullableStr(120), poi_subtype_code: nullableStr(20),
    site_type: nullableStr(120), monitoring_type: nullableStr(120), duration: nullableStr(40),
    geo_id: nullableStr(64),
    /* Rattachement au référentiel. Quand il est fourni, adm1…adm4 en sont dérivés
       côté serveur : les libellés ne peuvent plus diverger de l'arbre. */
    geo_pcode: nullableStr(64),
    adm1: nullableStr(120), adm2: nullableStr(120), adm3: nullableStr(120), adm4: nullableStr(120),
    urban_area: z.enum(["Oui","Non"]).default("Non"),
    lat: z.coerce.number().min(-90).max(90).nullish(),
    lon: z.coerce.number().min(-180).max(180).nullish(),
    security: z.coerce.number().refine(v=>[0,1,3,99].includes(v), "valeur attendue : 0, 1, 3 ou 99").default(0),
    modality: nullableStr(80),
    beneficiaries: z.coerce.number().int().min(0).max(100000000).default(0),
    partner_id: nullableStr(64), responsible: nullableStr(120), last_visit: nullableStr(20),
    synergies: z.coerce.number().int().min(0).max(1).default(0),
    new_partner: z.coerce.number().int().min(0).max(1).default(0),
    exp_partner: z.coerce.number().int().min(0).max(2).default(0),
    issue_ipm: z.coerce.number().int().min(0).max(2).default(0),
    issue_report: z.coerce.number().int().min(0).max(2).default(0),
    issue_cfm: z.coerce.number().int().min(0).max(2).default(0),
    fraud: z.coerce.number().int().min(0).max(2).default(0),
    /* Révision lue par le client, pour détecter l'écriture concurrente. */
    rev: z.coerce.number().int().min(1).optional(),
  }),
  siteMonth: z.object({
    month: z.coerce.number().int().min(0).max(11),
    year: z.coerce.number().int().min(2000).max(2100),
    active: z.coerce.boolean().default(true),
    planned: z.coerce.boolean().default(false),
    done: z.coerce.boolean().default(false),
    cp_name: nullableStr(160), monitor: nullableStr(120),
    report: nullableStr(300), moda: nullableStr(300),
  }),
  coverageParam: z.object({
    id: id.optional(), csp: nullableStr(40),
    office_id: id, category_id: nullableStr(64), activity_tag: z.string().min(1).max(20),
    duration: z.coerce.number().int().min(0).max(12).default(12),
    risk_level: z.coerce.number().int().min(1).max(3).default(2),
    feasible_per_month: z.coerce.number().int().min(0).max(1000).default(0),
  }),
  pdd: z.object({
    id: id.optional(),
    year: z.coerce.number().int().min(2000).max(2100),
    month: z.coerce.number().int().min(0).max(11),
    wbs: nullableStr(40), act_type: z.string().min(1).max(40),
    activity_tag: nullableStr(20), act_main: nullableStr(200),
    office_id: nullableStr(64), bureau: z.string().min(1).max(120),
    region: nullableStr(120), district: nullableStr(120), commune: nullableStr(120),
    partner_id: nullableStr(64),
    modality: z.enum(["Food","Cash","Voucher"]).default("Food"),
    commodity: nullableStr(120),
    days: z.coerce.number().int().min(0).max(366).default(0),
    benef_planned: z.coerce.number().int().min(0).default(0),
    households: z.coerce.number().int().min(0).default(0),
    tonnage: z.coerce.number().min(0).default(0),
    amount: z.coerce.number().min(0).default(0),
    benef_actual: z.coerce.number().int().min(0).default(0),
    received: z.coerce.number().min(0).default(0),
    distributed: z.coerce.number().min(0).default(0),
    status: z.enum(["planned","ongoing","done","cancelled"]).default("planned"),
    note: nullableStr(500),
  }),
  indicator: z.object({
    id: id.optional(), code: z.string().min(1).max(20),
    name: z.string().min(1).max(300), basket: nullableStr(120),
    unit: z.string().max(20).default("%"),
    target: z.coerce.number().default(0),
    direction: z.enum(["up","down"]).default("up"),
    method: nullableStr(200), frequency: nullableStr(40),
  }),
  outcome: z.object({
    id: id.optional(), indicator_id: id, adm1: nullableStr(120),
    round_label: nullableStr(80),
    planned: z.coerce.number().default(0), value: z.coerce.number().default(0),
    collected_at: nullableStr(20),
    sample: z.coerce.number().int().min(0).default(0),
  }),
  user: z.object({
    id: id.optional(),
    email: z.string().email().max(200),
    password: z.string().min(12).max(200).optional(),
    first_name: z.string().min(1).max(80),
    last_name: nullableStr(80), title: nullableStr(120),
    office_id: nullableStr(64),
    /* Rattachement à un prestataire de suivi. Un compte qui en porte un est un
       intervenant externe : il ne voit que les plans de son prestataire, quel que
       soit son rôle. Voir tpmBound dans lib/scope.js. */
    tpm_id: nullableStr(64),
    role: z.enum(["super","admin","validator","editor","viewer"]).default("viewer"),
    tabs: z.array(z.string().max(40)).max(20).default([]),
    active: z.coerce.boolean().default(true),
  }),
  /* Un import crée un millésime complet : il n'y a plus de « mode ». Remplacer ou
     fusionner n'aurait pas de sens sur un référentiel dont l'arbre doit être cohérent. */
  geoBulk: z.object({
    label:  z.string().min(1).max(160).optional(),
    source: z.string().max(300).optional(),
    rows: z.array(z.object({
      adm0: nullableStr(120), adm1: nullableStr(120), adm2: nullableStr(120),
      adm3: nullableStr(120), adm4: nullableStr(120),
      pcode:  nullableStr(40),
      pcode0: nullableStr(40), pcode1: nullableStr(40), pcode2: nullableStr(40),
      pcode3: nullableStr(40), pcode4: nullableStr(40),
      lat: z.coerce.number().min(-90).max(90).nullish(),
      lon: z.coerce.number().min(-180).max(180).nullish(),
    })).max(60000),
  }),
  visitStatus: z.object({ status: z.enum(["Validé","À valider","Erreur"]) }),
};
