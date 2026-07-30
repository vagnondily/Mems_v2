import { db } from "../db.js";
import { newId } from "./crypto.js";
import { currentVersion } from "./geo.js";

/* ═══════════════════════════════════════════════════════════════════════
   Suivi tiers — calculs.

   Tout ce qui est un montant est ici, et nulle part ailleurs. Le budget d'un
   plan, le solde d'un contrat, les lignes qu'une affectation engendre : trois
   fonctions, une seule définition chacune. Les routes ne font que les appeler.

   La règle du classeur MAHAVOTSE, reprise telle quelle :

       total d'une ligne = qté1 × qté2 × coût unitaire
       sous-total d'une équipe = somme de ses lignes
       total du plan = somme des sous-totaux

   Rien n'est stocké de ces sommes. Un total stocké finit par ne plus
   correspondre à ses lignes, et c'est le total qu'on présente au bailleur.
   ═══════════════════════════════════════════════════════════════════════ */

const r2 = (x) => Math.round(x * 100) / 100;
export const lineTotal = (l) => r2((l.qty1 || 0) * (l.qty2 || 0) * (l.unit_cost || 0));

/* ── Le barème appliqué à une affectation ────────────────────────────
   Ce qui fait qu'un budget est une conséquence de l'affectation et non une
   négociation. Chaque ligne du barème porte son rôle dans le calcul :

     superviseur  nombre de superviseurs × jours (déplacement compris)
     agent        nombre d'agents × jours
     vehicule     nombre de véhicules × jours
     carburant    litres × 1
     forfait      ne dérive de rien — la quantité reste saisie

   Le classeur comporte précisément des lignes de la dernière sorte (« Groupe
   électrogène avec carburant », « Forfait 1st premium »). Les faire entrer de
   force dans une formule aurait produit des quantités fausses ; on les laisse
   donc en saisie libre, et `derived` distingue les deux cas. */
export function derivedLines(zone, rates){
  const jours = (zone.days || 0) + (zone.travel_days || 0);
  /* L'ordre des deux quantités reprend celui du classeur de référence :
     « Qtté 1 (jr) » puis « Qtté 2 (nb) ». Le produit serait le même dans l'autre
     sens, mais les colonnes portent ces intitulés depuis des années et les
     inverser ferait relire de travers un tableau que les équipes connaissent. */
  const qty = {
    superviseur: [jours, zone.supervisors || 0],
    agent:       [jours, zone.agents || 0],
    vehicule:    [jours, zone.vehicles || 0],
    carburant:   [zone.fuel_litres || 0, 1],
  };
  return rates
    .filter(r => r.active && qty[r.driver])
    .map((r, i) => ({
      zone_id: zone.id, driver: r.driver, label: r.label, unit: r.unit,
      qty1: qty[r.driver][0], qty2: qty[r.driver][1], unit_cost: r.unit_cost,
      derived: 1, sort: (r.sort || 0) * 10 + i,
    }))
    /* Une quantité nulle ne produit pas de ligne : un plan sans véhicule n'a pas
       à porter une ligne « Location voiture — 0 ». */
    .filter(l => l.qty1 > 0 && l.qty2 > 0);
}

/* Régénère les lignes dérivées d'un plan à partir de ses zones et du barème.
   Les lignes saisies à la main (`derived = 0`) sont conservées : c'est tout
   l'intérêt du drapeau — recalculer ne doit pas effacer un ajustement voulu. */
export function regenerate(planId){
  const plan = db.prepare("SELECT * FROM tpm_plan WHERE id=?").get(planId);
  if(!plan) return 0;
  const rates = db.prepare("SELECT * FROM tpm_rate WHERE contract_id=? ORDER BY sort, label")
    .all(plan.contract_id);
  const zones = db.prepare("SELECT * FROM tpm_zone WHERE plan_id=? ORDER BY rowid").all(planId);

  db.prepare("DELETE FROM tpm_line WHERE plan_id=? AND derived=1").run(planId);
  const ins = db.prepare(`INSERT INTO tpm_line
    (id,plan_id,zone_id,driver,label,unit,qty1,qty2,unit_cost,derived,sort)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)`);
  let n = 0;
  for(const z of zones) for(const l of derivedLines(z, rates)){
    ins.run(newId("tpl"), planId, z.id, l.driver, l.label, l.unit,
            l.qty1, l.qty2, l.unit_cost, l.sort);
    n++;
  }
  return n;
}

/* ── Le budget d'un plan ─────────────────────────────────────────────
   Rendu par zone, parce que c'est ainsi qu'on le relit et qu'on l'arbitre :
   « quatre équipes, voici le sous-total de chacune ». */
export function planAmount(planId){
  const lignes = db.prepare("SELECT * FROM tpm_line WHERE plan_id=?").all(planId);
  return r2(lignes.reduce((t, l) => t + lineTotal(l), 0));
}

export function planDetail(planId){
  const plan = db.prepare(`
    SELECT p.*, t.name tpm_name, t.office_id tpm_office, c.ref contract_ref,
           c.currency, c.ceiling, o.name office_name
    FROM tpm_plan p
    JOIN tpm t ON t.id = p.tpm_id
    JOIN tpm_contract c ON c.id = p.contract_id
    LEFT JOIN offices o ON o.id = t.office_id
    WHERE p.id = ?`).get(planId);
  if(!plan) return null;

  const v = currentVersion();
  const noms = v ? Object.fromEntries(db.prepare(
    `SELECT u.pcode, u.name, p.name parent FROM geo_unit u
     LEFT JOIN geo_unit p ON p.version_id=u.version_id AND p.pcode=u.parent_pcode
     WHERE u.version_id=?`).all(v.id).map(x => [x.pcode, x.parent ? `${x.name} (${x.parent})` : x.name])) : {};

  const lignes = db.prepare("SELECT * FROM tpm_line WHERE plan_id=? ORDER BY sort, rowid").all(planId);
  const depenses = db.prepare("SELECT * FROM tpm_expense WHERE plan_id=? ORDER BY spent_on, rowid").all(planId);
  const parLigne = {};
  for(const d of depenses) if(d.line_id) parLigne[d.line_id] = r2((parLigne[d.line_id] || 0) + d.amount);

  const shapeLine = (l) => ({
    id:l.id, zone_id:l.zone_id, driver:l.driver, label:l.label, unit:l.unit || "",
    qty1:l.qty1, qty2:l.qty2, unit_cost:l.unit_cost, derived:!!l.derived,
    total: lineTotal(l), spent: parLigne[l.id] ?? null,
  });

  const zones = db.prepare("SELECT * FROM tpm_zone WHERE plan_id=? ORDER BY rowid").all(planId)
    .map(z => {
      const mien = lignes.filter(l => l.zone_id === z.id);
      return {
        id:z.id, geo_pcode:z.geo_pcode, zone: noms[z.geo_pcode] || z.geo_pcode,
        activity_tag:z.activity_tag || "", team_label:z.team_label || "",
        supervisors:z.supervisors, agents:z.agents, days:z.days, travel_days:z.travel_days,
        vehicles:z.vehicles, fuel_litres:z.fuel_litres, sites:z.sites, note:z.note || "",
        lines: mien.map(shapeLine),
        subtotal: r2(mien.reduce((t, l) => t + lineTotal(l), 0)),
      };
    });

  /* Les lignes sans zone : frais communs au plan, pas rattachables à une équipe. */
  const communes = lignes.filter(l => !l.zone_id).map(shapeLine);
  const budget = r2(lignes.reduce((t, l) => t + lineTotal(l), 0));
  const spent  = r2(depenses.reduce((t, d) => t + d.amount, 0));

  return {
    id:plan.id, tpm_id:plan.tpm_id, tpm:plan.tpm_name, office_id:plan.tpm_office,
    office:plan.office_name || "", contract_id:plan.contract_id, contract:plan.contract_ref,
    currency:plan.currency, year:plan.year, month:plan.month, ref:plan.ref || "",
    status:plan.status, note:plan.note || "", rev:plan.rev, updated_at:plan.updated_at,
    zones, communes, budget,
    spent: depenses.length ? spent : null,
    execution: budget && depenses.length ? Math.round((spent / budget) * 1000) / 10 : null,
    expenses: depenses.map(d => ({ id:d.id, line_id:d.line_id, spent_on:d.spent_on,
      amount:d.amount, ref:d.ref || "", note:d.note || "" })),
    reviews: db.prepare("SELECT * FROM tpm_review WHERE plan_id=? ORDER BY at").all(planId)
      .map(r => ({ level:r.level, decision:r.decision, comment:r.comment || "",
        amount:r.amount, at:r.at, by:r.user_label || "" })),
  };
}

/* ── Le solde d'un contrat ───────────────────────────────────────────
   « Combien reste-t-il ? » est la question à laquelle le plafond sert à répondre.
   Elle n'a de sens que si l'on distingue trois choses :

     engagé    les plans validés au niveau pays — l'argent est promis
     dépensé   les dépenses constatées, tous plans confondus
     en cours  les plans dans le circuit, pas encore engagés

   Confondre engagé et en cours ferait apparaître comme dépassé un plafond qui ne
   l'est pas encore ; les confondre dans l'autre sens laisserait valider un plan
   qui le dépasse. */
export function contractBalance(contractId){
  const c = db.prepare("SELECT * FROM tpm_contract WHERE id=?").get(contractId);
  if(!c) return null;
  const avenants = r2(db.prepare(
    "SELECT COALESCE(SUM(delta),0) s FROM tpm_amendment WHERE contract_id=?").get(contractId).s);
  const plans = db.prepare("SELECT id, status FROM tpm_plan WHERE contract_id=?").all(contractId);
  const somme = (filtre) => r2(plans.filter(filtre).reduce((t, p) => t + planAmount(p.id), 0));

  const engage  = somme(p => ["valide_pays", "cloture"].includes(p.status));
  const enCours = somme(p => ["soumis", "valide_tpm", "valide_bureau"].includes(p.status));
  const depense = r2(db.prepare(`SELECT COALESCE(SUM(e.amount),0) s FROM tpm_expense e
    JOIN tpm_plan p ON p.id = e.plan_id WHERE p.contract_id=?`).get(contractId).s);

  const plafond = r2(c.ceiling + avenants);
  return {
    ceiling:c.ceiling, avenants, plafond, engage, enCours, depense,
    disponible: r2(plafond - engage),
    /* Ce que le plafond deviendrait si tout ce qui est dans le circuit était validé. */
    projete: r2(plafond - engage - enCours),
    currency:c.currency,
    consommation: plafond ? Math.round((engage / plafond) * 1000) / 10 : null,
  };
}

/* ── Zones à proposer ────────────────────────────────────────────────
   L'affectation ne devrait pas partir d'une page blanche. La planification est
   déjà fondée sur le risque — priorité de suivi des sites, exigence minimale de
   suivi — et c'est cette information qu'on veut voir en assignant les zones :
   là où la priorité est haute et où le MMR n'est pas tenu, il faut aller.

   On agrège donc par commune : sites actifs, sites à visiter dans le mois selon
   le plan, sites déjà visités, priorité moyenne. Le tri met en tête ce qui est
   à la fois prioritaire et non couvert. */
export function suggestZones({ year, month, officeId, limit = 60 }){
  const v = currentVersion();
  if(!v) return [];
  /* Paramètres anonymes et dans l'ordre : SQLite refuse de mélanger la numérotation
     explicite (?1) et les points d'interrogation nus dans la même requête. */
  const args = [v.id, year, month];
  const filtreBureau = officeId ? " AND s.office_id = ?" : "";
  if(officeId) args.push(officeId);
  args.push(limit);

  return db.prepare(`
    SELECT u.pcode geo_pcode, u.name zone, p.name district,
           COUNT(*) sites,
           SUM(CASE WHEN s.status='Active' THEN 1 ELSE 0 END) actifs,
           SUM(CASE WHEN m.planned=1 THEN 1 ELSE 0 END) planifies,
           SUM(CASE WHEN m.done=1 THEN 1 ELSE 0 END) visites,
           AVG(COALESCE(s.issue_ipm,0) + COALESCE(s.issue_report,0)
               + COALESCE(s.issue_cfm,0) + COALESCE(s.fraud,0)) risque,
           SUM(COALESCE(s.beneficiaries,0)) beneficiaires,
           GROUP_CONCAT(DISTINCT s.activity_tag) tags
    FROM sites s
    JOIN geo_unit u ON u.pcode = s.geo_pcode AND u.version_id = ?
    LEFT JOIN geo_unit p ON p.version_id = u.version_id AND p.pcode = u.parent_pcode
    LEFT JOIN site_months m ON m.site_id = s.id AND m.year = ? AND m.month = ?
    WHERE s.geo_pcode IS NOT NULL ${filtreBureau}
    GROUP BY u.pcode
    HAVING actifs > 0
    ORDER BY (planifies - visites) DESC, risque DESC, actifs DESC
    LIMIT ?`).all(...args)
    .map(r => ({
      ...r,
      tags: (r.tags || "").split(",").filter(Boolean),
      /* L'écart de couverture du mois : ce qui était prévu et n'est pas fait. */
      ecart: Math.max(0, (r.planifies || 0) - (r.visites || 0)),
      risque: Math.round((r.risque || 0) * 100) / 100,
    }));
}

/* ── Le circuit ──────────────────────────────────────────────────────
   Une seule table de transitions, pour que l'ordre des trois niveaux ne puisse
   pas être contourné par une route qui l'aurait réécrit de son côté. */
export const NIVEAUX = ["tpm", "bureau", "pays"];
export const TRANSITIONS = {
  tpm:    { depuis:["soumis"],       vers:"valide_tpm",
            label:"Responsable du prestataire" },
  bureau: { depuis:["valide_tpm"],   vers:"valide_bureau",
            label:"Suivi-évaluation du bureau" },
  pays:   { depuis:["valide_bureau"],vers:"valide_pays",
            label:"Suivi-évaluation du bureau pays" },
};
/* Le niveau attendu pour la suite du circuit, ou null si le plan n'attend rien. */
export const niveauAttendu = (status) =>
  NIVEAUX.find(n => TRANSITIONS[n].depuis.includes(status)) || null;

/* Les états où le plan est encore modifiable. Une fois soumis, il ne bouge plus :
   valider un montant puis le laisser changer viderait la validation de son sens. */
export const modifiable = (status) => status === "brouillon" || status === "renvoye";
