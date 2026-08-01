import { db } from "../db.js";

/* ═══════════════════════════════════════════════════════════════════════
   LE REGISTRE DES LISTES TYPÉES  (chantier S8, points 1 à 4)

   « J'aurai besoin des listes à paramétrer par types (activité, denrées,
   tiers, partenaire, type de partenariat, etc.) en sous-groupe
   sélectionnable à gauche et à droite la configuration des listes. »

   Ce fichier est LA déclaration de ces listes — une entrée par type. Il ne
   contient aucune requête métier : il dit où vit chaque liste, comment ses
   colonnes s'appellent, et surtout CE QUI LA RÉFÉRENCE. Les trois autres
   exigences du chantier en découlent mécaniquement :

     · l'intégrité référentielle (point 2) est le comptage des `liens` ;
     · le renommage en cascade (point 3) est la réécriture des liens `code` ;
     · le mappage puis validation (point 4) est ce même calcul, rendu avant
       d'écrire au lieu d'être appliqué.

   Une seule déclaration nourrit les quatre : c'est ce qui garantit qu'un
   lien ajouté ici est immédiatement compté, refusé et renommé partout, et
   qu'aucun des trois ne peut prendre du retard sur les deux autres.

   ── Deux formes de stockage, une seule forme d'écran ─────────────────
   Quatre listes SONT DÉJÀ des tables réelles, référencées par clé
   étrangère — les activités (`activity_categories`), les partenaires
   (`partners`), les sous-types de point d'intérêt (`poi_subtypes`) et les
   tiers (`tpm`). Les autres vivent dans `list_item`, discriminées par
   `type` (migration 026). Le registre les présente identiquement : la
   route et l'écran ne savent pas laquelle est native.

   ── LE CODE EST CE QUE PORTENT LES TABLES FILLES ─────────────────────
   `pdd.commodity` contient « Riz », `sites.site_type` contient
   « School », `pdd.modality` contient « Food ». Le code d'un item est
   donc cette valeur-là, et non un identifiant inventé à côté. C'est ce
   qui rend le comptage d'usage exact et le renommage en cascade possible.
   ═══════════════════════════════════════════════════════════════════════ */

/* Un lien : une colonne d'une table fille qui désigne un item de la liste.

     par:"id"    la colonne porte l'identifiant technique (clé étrangère) ;
     par:"code"  la colonne porte le CODE — c'est celle que le renommage
                 en cascade réécrit ;
     par:"nom"   la colonne porte le LIBELLÉ recopié. Elle compte dans
                 l'usage (on ne supprime pas un item dont le nom est
                 inscrit ailleurs) mais le renommage de code n'y touche
                 pas : ce n'est pas un code. */
const lien = (table, colonne, par, label) => ({ table, colonne, par, label });

/* Les tables filles qui portent un TAG d'activité. Elles sont dix : les
   énumérer une fois ici plutôt que dans chaque route est ce qui évite
   qu'un renommage d'activité oublie `caseload` ou `submissions`. */
const LIENS_TAG_ACTIVITE = [
  lien("sites",           "activity_tag", "code", "Sites"),
  lien("coverage_params", "activity_tag", "code", "Paramètres de couverture"),
  lien("pdd",             "activity_tag", "code", "Plan de distribution"),
  lien("outputs",         "activity_tag", "code", "Produits"),
  lien("visits",          "activity_tag", "code", "Visites"),
  lien("odk_forms",       "activity_tag", "code", "Formulaires ODK"),
  lien("caseload",        "activity_tag", "code", "Caseload"),
  lien("tpm_zone",        "activity_tag", "code", "Zones TPM"),
  lien("submissions",     "activity_tag", "code", "Soumissions"),
  lien("indicators",      "activity",     "code", "Indicateurs de processus"),
];

/* Colonnes d'une liste générique (`list_item`). Les listes natives
   redéclarent les leurs, qui portent d'autres noms. */
const COLS_GENERIQUES = { code:"code", label:"label", active:"active", rev:"rev",
                          note:"note", ordre:"sort_order", updated:"updated_at" };

const generique = (cle, type, label, opts = {}) => ({
  cle, type, label, table:"list_item", cols:COLS_GENERIQUES, champs:[], cap:"admin",
  prefixeId:"li", ...opts });

export const TYPES = [
  /* `activites` reste déclarée — la route des activités s'en sert pour compter
     l'usage sur ses douze colonnes et pour le renommage de tag en cascade —
     mais elle est MASQUÉE du gestionnaire de listes typées : les activités ont
     leur propre onglet (« Activités »), plus riche (sous-activités, liaisons).
     Deux endroits pour la même liste étaient précisément la redondance à
     supprimer. `hidden` retire l'entrée du rail sans casser les usages
     internes. */
  { cle:"activites", label:"Activités", table:"activity_categories", prefixeId:"act", cap:"admin",
    hidden: true,
    description: "Le référentiel des activités du programme — la colonne vertébrale réutilisée "
      + "pour rattacher un site, suivre un indicateur de processus et planifier.",
    cols: { code:"tag", label:"name", active:"active", rev:"rev" },
    champs: [{ cle:"program_area", colonne:"program_area", label:"Domaine programme",
               max:120, liste:"domaines" }],
    liens: [
      lien("sites",           "category_id", "id", "Sites"),
      lien("coverage_params", "category_id", "id", "Paramètres de couverture"),
      ...LIENS_TAG_ACTIVITE,
    ] },

  generique("denrees", "denree", "Denrées et commodités", {
    description: "Les denrées transportées et distribuées. Le code est la valeur portée par "
      + "la colonne « commodity » du plan de distribution et du catalogue de rations.",
    liens: [lien("pdd",           "commodity", "code", "Plan de distribution"),
            /* Le catalogue de rations (migration 031) désigne aussi la denrée par
               son code : renommer une denrée y réécrit en cascade, et on ne
               supprime pas une denrée qu'une convention de ration utilise. */
            lien("ration_catalog", "commodity", "code", "Catalogue de rations")] }),

  generique("modalites", "modalite", "Modalités de transfert", {
    description: "Vivres, espèces, coupons… La liste n'est plus enfermée dans le schéma "
      + "(l'énumération de pdd.modality a été levée par la migration 026).",
    liens: [lien("pdd",   "modality", "code", "Plan de distribution"),
            lien("sites", "modality", "code", "Sites")] }),

  { cle:"partenaires", label:"Partenaires coopérants", table:"partners", prefixeId:"part", cap:"admin",
    description: "Les partenaires de mise en œuvre. Ils portent désormais un code "
      + "d'identification et un type de partenariat.",
    cols: { code:"code", label:"name", active:"active", rev:"rev", note:"note", updated:"updated_at" },
    champs: [{ cle:"partnership_type", colonne:"partnership_type", label:"Type de partenariat",
               max:40, liste:"types_partenariat" }],
    liens: [
      lien("sites",       "partner_id", "id",  "Sites"),
      lien("pdd",         "partner_id", "id",  "Plan de distribution"),
      /* La grille mensuelle recopie le NOM du partenaire coopérant. */
      lien("site_months", "cp_name",    "nom", "Grille mensuelle"),
    ] },

  generique("types_partenariat", "type_partenariat", "Types de partenariat", {
    description: "ONG internationale, ONG nationale, service technique de l'État… "
      + "Ce que la fiche d'un partenaire déclare comme nature de la relation.",
    liens: [lien("partners", "partnership_type", "code", "Partenaires")] }),

  { cle:"tiers", label:"Tiers et prestataires (TPM)", table:"tpm", prefixeId:"tpm", cap:"admin",
    description: "Les prestataires de suivi par tierce partie. Leur contractualisation, "
      + "leurs plans et leurs dépenses se gèrent dans le module TPM ; leur identité ici.",
    cols: { code:"code", label:"name", active:"active", rev:"rev", note:"note", updated:"updated_at" },
    champs: [],
    liens: [
      lien("tpm_contract", "tpm_id", "id", "Contrats"),
      lien("tpm_plan",     "tpm_id", "id", "Plans de suivi"),
      lien("users",        "tpm_id", "id", "Comptes"),
    ] },

  { cle:"sous_types_pi", label:"Sous-types de point d'intérêt", table:"poi_subtypes",
    prefixeId:"poi", cap:"admin",
    description: "La nature d'un point d'intérêt — école, formation sanitaire, entrepôt, "
      + "point de distribution. Le code voyage avec le site.",
    cols: { code:"code", label:"label", active:"active", rev:"rev", updated:"updated_at" },
    champs: [],
    liens: [lien("sites", "poi_subtype_code", "code", "Sites"),
            lien("sites", "poi_subtype",      "nom",  "Sites (libellé recopié)")] },

  generique("types_site", "type_site", "Types de site", {
    description: "Le type d'implantation d'un site, tel que la colonne « site_type » le porte.",
    liens: [lien("sites", "site_type", "code", "Sites")] }),

  generique("types_suivi", "type_suivi", "Types de suivi", {
    description: "Suivi de distribution, de mise en œuvre, post-distribution, des résultats.",
    liens: [lien("sites", "monitoring_type", "code", "Sites")] }),

  generique("durees", "duree", "Durées d'intervention", {
    description: "La durée d'intervention attendue sur un site — elle pèse dans le calcul "
      + "de la fréquence de suivi requise.",
    liens: [lien("sites", "duration", "code", "Sites")] }),

  generique("domaines", "domaine", "Domaines programme", {
    description: "Les grands domaines du portefeuille, portés par les sites et par les activités.",
    liens: [lien("sites",               "program_area", "code", "Sites"),
            lien("activity_categories", "program_area", "code", "Activités")] }),
];

export const parCle = (cle) => TYPES.find(t => t.cle === cle) || null;

/* ── Requêtes bâties sur la déclaration ──────────────────────────────
   Les listes génériques partagent une table : toute lecture et toute
   écriture porte donc la restriction `type=?`. Elle est calculée ici, une
   fois, et jamais recopiée dans la route — un oubli y ferait fuiter les
   denrées dans les modalités. */
const restriction = (def) => def.type ? { sql:" AND type=?", args:[def.type] } : { sql:"", args:[] };

export function lignes(def){
  const r = restriction(def);
  const ordre = def.cols.ordre ? `${def.cols.ordre}, ` : "";
  return db.prepare(`SELECT * FROM ${def.table} WHERE 1=1${r.sql}
                     ORDER BY ${def.cols.active} DESC, ${ordre}${def.cols.label}`).all(...r.args);
}

export function ligne(def, id){
  const r = restriction(def);
  return db.prepare(`SELECT * FROM ${def.table} WHERE id=?${r.sql}`).get(id, ...r.args) || null;
}

export function ligneParCode(def, code){
  const r = restriction(def);
  return db.prepare(`SELECT * FROM ${def.table} WHERE ${def.cols.code}=? COLLATE NOCASE${r.sql}`)
    .get(code, ...r.args) || null;
}

/* Ce qui référence un item, lien par lien. Sert trois fois : informer
   l'écran, refuser une suppression destructrice, et chiffrer l'impact d'un
   renommage avant de l'appliquer. Une entrée par lien NON VIDE — un tableau
   de zéros n'apprend rien à personne. */
export function usage(def, row){
  const valeur = (l) => l.par === "id" ? row.id
    : l.par === "code" ? row[def.cols.code]
    : row[def.cols.label];
  const out = [];
  for(const l of def.liens || []){
    const v = valeur(l);
    if(v == null || v === "") continue;
    const c = db.prepare(`SELECT COUNT(*) c FROM ${l.table} WHERE ${l.colonne}=?`).get(v).c;
    if(c) out.push({ table:l.table, colonne:l.colonne, par:l.par, label:l.label, lignes:c });
  }
  return out;
}

export const totalUsage = (u) => u.reduce((a, x) => a + x.lignes, 0);

/* Projection d'un item vers le client. Les noms de colonnes physiques ne
   sortent jamais : l'écran manipule `code`, `label`, `active`, `rev` quelle
   que soit la table dessous. */
export function forme(def, row, { avecUsage = true } = {}){
  const out = {
    id: row.id,
    code: row[def.cols.code] || "",
    label: row[def.cols.label] || "",
    note: def.cols.note ? (row[def.cols.note] || "") : "",
    ordre: def.cols.ordre ? (row[def.cols.ordre] ?? 0) : 0,
    active: !!row[def.cols.active],
    rev: row[def.cols.rev] || 1,
    champs: Object.fromEntries((def.champs || []).map(c => [c.cle, row[c.colonne] ?? ""])),
  };
  if(avecUsage){ out.usage = usage(def, row); out.usageTotal = totalUsage(out.usage); }
  return out;
}

/* La validation d'une liste — le quatrième geste demandé (« ajout,
   modification, suppression, validation »). Elle porte sur le TYPE, pas
   sur l'item : quelqu'un a relu la liste entière et l'a déclarée bonne.
   Toute écriture sur un item l'efface (voir `invalider`), sans quoi le
   badge « validée » survivrait à ce qu'il certifie. */
export function validation(def){
  const v = db.prepare("SELECT * FROM list_validation WHERE type=?").get(def.cle);
  return v ? { at:v.validated_at, par:v.user_label || "", items:v.items, note:v.note || "" } : null;
}

export const invalider = (def) =>
  db.prepare("DELETE FROM list_validation WHERE type=?").run(def.cle);
