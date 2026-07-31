/* ═══════════════════════════════════════════════════════════════════════
   Registre des champs MEMS raccordables — la seule source de vérité.

   Le propriétaire du produit a formulé le besoin ainsi : « à chaque liaison,
   mets en place un système de mapping des variables pour correspondre à ceux
   utilisés par MEMS, et ainsi on ne se perd pas à recoder à chaque fois ».
   Recoder à chaque fois, c'est ce que fait aujourd'hui le dépôt : `odk_forms`
   porte deux champs de rattachement en dur, l'import Excel a ses colonnes
   figées, et rien de tout cela ne se réutilise d'une source à l'autre.

   Ce fichier est la moitié déclarative de la réponse : QUELS champs MEMS une
   source peut alimenter, de quel type, obligatoires ou non. L'autre moitié —
   COMMENT une valeur de la source devient une valeur MEMS — est dans
   lib/mapping.js. Ensemble, elles remplacent le code qu'il fallait écrire.

   Trois règles tiennent tout l'édifice, et il faut les respecter :

   1. Ce registre est lu, jamais recopié. L'écran de réglage (Paramètres →
      Connecteurs) le reçoit par GET /api/connectors/champs, et la validation
      serveur le lit par `champ()`. Une liste de champs écrite une seconde fois
      dans le navigateur divergerait de celle-ci au premier ajout — c'est
      exactement ce qui était arrivé à la matrice des droits avant sa reprise.

   2. `obligatoire` dit ce sans quoi l'enregistrement n'a pas de sens, pas ce
      que la base refuse. Une soumission sans identifiant d'instance ne peut pas
      être dédoublonnée ; une ligne de bénéficiaires sans p-code ni période ne
      peut se rattacher à rien. Le reste est facultatif, quitte à ce qu'un
      branchement donné le rende obligatoire pour lui-même (voir
      `connector_mapping.required`, migration 016).

   3. Les `synonymes` ne décident de rien. Ils servent uniquement à proposer une
      correspondance à l'humain (POST /api/connectors/:id/suggestions), avec un
      score, qu'il valide ou corrige. Aucun import ne s'appuie dessus : deviner
      en silence sur un nom de variable est précisément la faute que ce registre
      existe pour empêcher. Ceux qui suivent viennent des quatre XLSForms du
      bureau Madagascar dépouillés dans docs/A_FAIRE.md (chantier O) : `DPName`,
      `POIName`, `Adm4Code_SMP`, `SvyDate`, `HHCoord`.
   ═══════════════════════════════════════════════════════════════════════ */

/* Les types sont volontairement peu nombreux : ils ne décrivent pas une colonne
   SQL, ils décident de la transformation proposée par défaut. */
export const TYPES = ["texte", "entier", "nombre", "date", "booleen"];

/* Le type d'un champ donne la transformation qui le rend correctement dans MEMS.
   C'est ce qui permet à l'écran de pré-remplir la colonne « transformation »
   sans que l'utilisateur ait à connaître le jeu de transformations. */
export const TRANSFORM_PAR_TYPE = {
  texte:   "texte",
  entier:  "entier",
  nombre:  "nombre",
  date:    "date_iso",
  booleen: "booleen",
};

const c = (nom, type, obligatoire, note, synonymes = []) =>
  ({ nom, type, obligatoire, note, synonymes });

export const REGISTRE = {
  /* ── Sites ─────────────────────────────────────────────────────────
     Le registre des points d'intérêt. Une source « registre des sites »
     (odk_forms.kind = 'sites', un export du partenaire, un dataset Foundry)
     alimente ces champs. */
  site: {
    cle: "site",
    label: "Site",
    table: "sites",
    note: "Point d'intérêt suivi : école, formation sanitaire, point de distribution. "
      + "Le code est l'identifiant métier, il doit être stable d'un import à l'autre.",
    champs: [
      c("code", "texte", true,
        "Identifiant métier du site, unique. C'est la clé de rapprochement entre deux imports : "
        + "s'il change, le site est vu comme nouveau.",
        ["code", "site_code", "codesite", "id_site", "site_id", "poi_code", "dpcode"]),
      c("name", "texte", true,
        "Nom du point d'intérêt tel qu'il est connu sur le terrain.",
        ["name", "nom", "site_name", "sitename", "poiname", "dpname", "libelle"]),
      c("adm1", "texte", false, "Niveau administratif 1 (région à Madagascar), pour l'affichage et l'export.",
        ["adm1", "region", "adm1name", "province"]),
      c("adm2", "texte", false, "Niveau administratif 2 (district).",
        ["adm2", "district", "adm2name"]),
      c("adm3", "texte", false, "Niveau administratif 3 (commune).",
        ["adm3", "commune", "adm3name"]),
      c("adm4", "texte", false, "Niveau administratif 4 (fokontany).",
        ["adm4", "fokontany", "adm4name", "village"]),
      c("geo_pcode", "texte", false,
        "P-code de l'unité administrative qui contient le site. C'est lui qui rattache "
        + "réellement le site au référentiel ; les colonnes adm1 à adm4 n'en sont que l'affichage.",
        ["pcode", "geo_pcode", "adm4code", "adm4pcode", "adm3code", "codepcode"]),
      c("lat", "nombre", false,
        "Latitude en degrés décimaux. Depuis un geopoint ODK (« lat lon altitude précision »), "
        + "utiliser la transformation geopoint_lat.",
        ["lat", "latitude", "gps_lat", "hhcoord", "coord", "geopoint"]),
      c("lon", "nombre", false,
        "Longitude en degrés décimaux. Depuis un geopoint ODK, utiliser geopoint_lon.",
        ["lon", "lng", "longitude", "gps_lon", "hhcoord", "coord", "geopoint"]),
      c("category", "texte", false, "Catégorie d'activité du site, telle que déclarée dans les référentiels.",
        ["category", "categorie", "activity", "activite"]),
      c("activity_tag", "texte", false,
        "Code d'activité (URT, SMP, NTA…). Il conditionne les rattachements de planification.",
        ["tag", "activity_tag", "activitytag", "code_activite", "wbs"]),
      c("beneficiaries", "entier", false, "Nombre de bénéficiaires rattachés au site.",
        ["beneficiaries", "beneficiaires", "benef", "nb_benef", "caseload"]),
      c("security", "entier", false,
        "Niveau de sécurité : 0, 1, 3 ou 99. Toute autre valeur est refusée par la base.",
        ["security", "securite", "niveau_securite", "phase"]),
      c("status", "texte", false, "« Active » ou « Inactive ».",
        ["status", "statut", "etat", "actif"]),
    ],
  },

  /* ── Soumissions ───────────────────────────────────────────────────
     Ce qui remonte d'ODK Central ou de KoboToolbox. Les noms retenus sont ceux
     du chantier O : c'est ce que la table `submissions` portera quand elle
     existera, et le branchement n'aura alors rien à réapprendre. */
  submission: {
    cle: "submission",
    label: "Soumission",
    table: "submissions",
    note: "Une soumission de formulaire ODK Central ou KoboToolbox. Le champ site porte "
      + "un code de la feuille « choices » du XLSForm, jamais du texte libre — et pas le "
      + "même code d'un formulaire à l'autre (voir docs/A_FAIRE.md, chantier O).",
    champs: [
      c("instance_id", "texte", true,
        "Identifiant unique de la soumission (`__id` dans l'API OData d'ODK Central). "
        + "Sans lui, deux tirages successifs créent des doublons au lieu de se recouvrir.",
        ["instance_id", "instanceid", "__id", "id", "uuid", "meta_instanceid"]),
      c("form_id", "texte", true, "Identifiant du formulaire d'origine.",
        ["form_id", "formid", "xform_id", "formulaire"]),
      c("site_code", "texte", true,
        "Code du site tel que le formulaire le porte. Il n'est pas un identifiant MEMS : "
        + "le rattachement au site se fait ensuite, et peut échouer — c'est voulu, un code "
        + "non résolu doit rester visible.",
        ["site_code", "dpname", "poiname", "adm4code_smp", "sitecode", "site", "ecole"]),
      c("svy_date", "date", false, "Date de collecte déclarée dans le formulaire.",
        ["svydate", "svy_date", "date", "date_visite", "visit_date", "today"]),
      c("lat", "nombre", false,
        "Latitude relevée. Depuis `HHCoord` — présent dans les quatre XLSForms MDG — "
        + "utiliser la transformation geopoint_lat.",
        ["lat", "latitude", "hhcoord", "gps", "geopoint", "coordonnees"]),
      c("lon", "nombre", false, "Longitude relevée, via geopoint_lon depuis le même geopoint.",
        ["lon", "lng", "longitude", "hhcoord", "gps", "geopoint", "coordonnees"]),
      c("gps_accuracy", "nombre", false,
        "Précision en mètres rendue par l'appareil, quatrième composante du geopoint. "
        + "Elle sert à écarter un relevé trop imprécis plutôt qu'à le corriger.",
        ["accuracy", "precision", "gps_accuracy", "hhcoord"]),
    ],
  },

  /* ── Bénéficiaires ─────────────────────────────────────────────────
     Première des deux entités que la demande vise explicitement avec Foundry :
     « les chiffres de bénéficiaires et réceptions ». Le grain est la période et
     l'unité administrative — c'est celui des tableaux de suivi, pas celui du
     ménage : aucune donnée nominative n'entre ici. */
  beneficiaire: {
    cle: "beneficiaire",
    label: "Bénéficiaires",
    table: "—",
    note: "Chiffres de bénéficiaires par période et par unité administrative. Le grain est "
      + "agrégé : ni nom, ni identifiant de ménage. Une source qui en porterait ne doit pas "
      + "les faire entrer par ce chemin.",
    champs: [
      c("geo_pcode", "texte", true,
        "P-code de l'unité administrative concernée. C'est la clé de rattachement : "
        + "un libellé de commune ne suffit pas, deux communes portent le même nom.",
        ["pcode", "geo_pcode", "adm3code", "adm4code", "code_commune", "location_code"]),
      c("annee", "entier", true, "Année de la période, sur quatre chiffres.",
        ["annee", "year", "an", "exercice"]),
      c("mois", "entier", true, "Mois de la période, de 1 à 12.",
        ["mois", "month", "periode", "period"]),
      c("activity_tag", "texte", false, "Code d'activité (URT, SMP, NTA…).",
        ["tag", "activity_tag", "activity", "activite", "wbs", "programme"]),
      c("planifies", "entier", false, "Bénéficiaires planifiés pour la période.",
        ["planifies", "planned", "planned_beneficiaries", "prevu", "target", "cible"]),
      c("atteints", "entier", false, "Bénéficiaires effectivement atteints.",
        ["atteints", "actual", "reached", "actual_beneficiaries", "realise", "servis"]),
      /* Les quatre ventilations ne portent PAS de seuil d'âge : MEMS n'en impose
         aucun, et en inventer un ici ferait passer pour comparable ce qui ne
         l'est pas. Le seuil est celui de la source ; il doit être le même d'une
         source à l'autre, sinon les totaux ne s'additionnent pas. */
      c("hommes", "entier", false,
        "Hommes, selon la tranche d'âge retenue par la source. Le seuil n'est pas imposé "
        + "par MEMS : il doit rester le même d'un import à l'autre.",
        ["hommes", "men", "male", "adult_men", "h"]),
      c("femmes", "entier", false,
        "Femmes, selon la même tranche d'âge que les hommes dans la source.",
        ["femmes", "women", "female", "adult_women", "f"]),
      c("garcons", "entier", false,
        "Garçons, c'est-à-dire les enfants de sexe masculin selon le seuil d'âge de la source.",
        ["garcons", "boys", "male_children", "enfants_g"]),
      c("filles", "entier", false,
        "Filles, selon le même seuil d'âge que les garçons dans la source.",
        ["filles", "girls", "female_children", "enfants_f"]),
    ],
  },

  /* ── Réceptions ────────────────────────────────────────────────────
     Seconde entité visée par la demande. Le tonnage prévu et le tonnage reçu
     sont gardés distincts : leur écart EST l'information utile, et une source
     qui n'apporte que l'un des deux reste exploitable. */
  reception: {
    cle: "reception",
    label: "Réceptions",
    table: "—",
    note: "Réceptions de denrées par période et par unité administrative. Prévu et reçu "
      + "restent deux champs distincts : c'est leur écart qui se suit.",
    champs: [
      c("geo_pcode", "texte", true, "P-code de l'unité administrative de réception.",
        ["pcode", "geo_pcode", "adm3code", "adm4code", "location_code", "code_lieu"]),
      c("annee", "entier", true, "Année de la période, sur quatre chiffres.",
        ["annee", "year", "an", "exercice"]),
      c("mois", "entier", true, "Mois de la période, de 1 à 12.",
        ["mois", "month", "periode", "period"]),
      c("activity_tag", "texte", false, "Code d'activité rattachée.",
        ["tag", "activity_tag", "activity", "activite", "wbs"]),
      c("denree", "texte", false, "Denrée reçue (riz, huile, CSB…).",
        ["denree", "commodity", "commodite", "produit", "item"]),
      c("tonnage_prevu", "nombre", false, "Tonnage prévu pour la période, en tonnes métriques.",
        ["tonnage_prevu", "planned_mt", "planned_tonnage", "prevu", "tonnage_planifie"]),
      c("tonnage_recu", "nombre", false, "Tonnage effectivement reçu, en tonnes métriques.",
        ["tonnage_recu", "received_mt", "received", "recu", "actual_tonnage", "tonnage"]),
    ],
  },
};

/* ── Accès au registre ─────────────────────────────────────────────────
   Les appelants passent par ces trois fonctions plutôt que par REGISTRE
   directement : le jour où le registre change de forme (des champs venant de la
   configuration du pays, par exemple), c'est ici que ça se règle. */

export const entites = () => Object.keys(REGISTRE);

export const entite = (cle) => REGISTRE[cle] || null;

export const champs = (cleEntite) => entite(cleEntite)?.champs || [];

/* Un champ précis, ou null. C'est la fonction que la validation d'écriture
   appelle : refuser un `mems_field` inconnu est ce qui garantit qu'une
   correspondance enregistrée pointe vers quelque chose de réel. */
export const champ = (cleEntite, nomChamp) =>
  champs(cleEntite).find(x => x.nom === nomChamp) || null;

export const champsObligatoires = (cleEntite) =>
  champs(cleEntite).filter(x => x.obligatoire).map(x => x.nom);

/* La forme servie par l'API : le registre entier, prêt à être affiché. Aucun
   filtrage, aucune traduction — l'écran montre ce que le serveur valide. */
export const registrePublic = () => entites().map(cle => {
  const e = REGISTRE[cle];
  return {
    cle: e.cle, label: e.label, note: e.note,
    champs: e.champs.map(x => ({
      nom: x.nom, type: x.type, obligatoire: x.obligatoire, note: x.note,
      transformDefaut: TRANSFORM_PAR_TYPE[x.type] || "brut",
    })),
  };
});
