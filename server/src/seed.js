import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate, tx } from "./db.js";
import { config } from "./config.js";
import { log } from "./lib/logger.js";
import { newId } from "./lib/crypto.js";
import { hashPassword } from "./lib/auth.js";

const here = path.dirname(fileURLToPath(import.meta.url));
migrate(path.join(here, "..", "migrations"));

const YEAR = new Date().getFullYear();
const pick = a => a[Math.floor(Math.random()*a.length)];
const r2 = v => Math.round(v*100)/100;
const r5 = v => Math.round(v*1e5)/1e5;

/* ── Référentiels repris du plan de suivi ───────────────────────── */
const OFFICES = [
  ["Bureau de terrain d'Ambovombe","AMBOVOMBE"], ["Bureau de terrain d'Ampanihy","AMPANIHY"],
  ["Bureau de terrain de Toliara","TULEAR"],     ["Bureau de terrain de Manakara","MANAKARA"],
  ["Bureau de terrain de Bekily","BEKILY"],      ["Bureau de terrain de Tsihombe","TSIHOMBE"],
  ["Bureau de terrain de Tolagnaro","TOLAGNARO"],["Bureau central d'Antananarivo","HQ"],
];
const CATS = [
  ["Unconditional resource transfers to support access to food","URT","Unconditional Resource Transfers (URT)"],
  ["Asset creation and livelihood support activities","ACL","Asset Creation and Livelihood (ACL)"],
  ["Climate adaptation and risk management activities","CAR","Action to protect against climate shocks"],
  ["School meal activities","SMP","School based programmes (SMP)"],
  ["Nutrition treatment activities","NTA","Malnutrition treatment programme (NTA)"],
  ["Malnutrition prevention activities","MPA","Malnutrition prevention programme (NPA)"],
  ["Smallholder agricultural market support activities","SAMS","Smallholder agricultural market support (SAMS)"],
  ["Individual capacity strengthening activities","ICS",""],
  ["Institutional capacity strengthening activities","INS",""],
];
const PARTNERS = ["Partenaire A","Partenaire B","Partenaire C","Partenaire D","Partenaire E"];
const POI = [["Aéroport","APT"],["Point de distribution","FDP"],["Formation sanitaire","HEAL"],
  ["Marché","MKT"],["Unité de stockage mobile","MSU"],["Entrepôt partenaire","CP_WH"],["Port","PT"],
  ["Gare ferroviaire","TRN"],["Camp de déplacés","CMP"],["École","SCH"],["Commerce détaillant","SH"],
  ["Installation de stockage","STOR"],["Site de télécommunication","TC"],["Bureau","OFF"],
  ["Entrepôt principal","ST"],["Atelier","WS"]];
const INDICATORS = [
  ["FCS","Score de consommation alimentaire — ménages en consommation acceptable","Consommation alimentaire","%",80,"up","Enquête ménage","Semestriel"],
  ["rCSI","Indice réduit des stratégies d'adaptation","Stratégies d'adaptation","idx",12,"down","Enquête ménage","Semestriel"],
  ["LCSI","Stratégies d'adaptation des moyens d'existence — aucune stratégie","Stratégies d'adaptation","%",60,"up","Enquête ménage","Annuel"],
  ["FES","Part des dépenses consacrées à l'alimentation","Économie du ménage","%",65,"down","Enquête ménage","Annuel"],
  ["MAD","Régime alimentaire minimum acceptable — enfants 6 à 23 mois","Nutrition","%",35,"up","Enquête ménage","Annuel"],
  ["MAMR","Taux de guérison du traitement de la malnutrition aiguë modérée","Nutrition","%",75,"up","Registres des sites","Mensuel"],
  ["MAMD","Taux d'abandon du traitement de la malnutrition aiguë modérée","Nutrition","%",15,"down","Registres des sites","Mensuel"],
  ["RET","Taux de rétention scolaire","Éducation","%",90,"up","Registres scolaires","Annuel"],
  ["COV","Couverture du programme de prévention","Couverture","%",70,"up","Enquête de couverture","Annuel"],
  ["ADH","Adhérence — participation à un nombre suffisant de distributions","Couverture","%",80,"up","Suivi post-distribution","Trimestriel"],
];
const GEO = [
  ["Madagascar","Androy","Ambovombe-Androy","Ambanisarika"],["Madagascar","Androy","Ambovombe-Androy","Sihanamaro"],
  ["Madagascar","Androy","Bekily","Beraketa"],            ["Madagascar","Androy","Tsihombe","Marovato"],
  ["Madagascar","Anosy","Amboasary-Atsimo","Ebelo"],      ["Madagascar","Anosy","Amboasary-Atsimo","Ifotaka"],
  ["Madagascar","Atsimo-Andrefana","Ampanihy Ouest","Ejeda"],["Madagascar","Atsimo-Andrefana","Toliara II","Betioky"],
  ["Madagascar","Atsimo-Andrefana","Toliara II","Sakaraha"],["Madagascar","Vatovavy","Manakara","Ambila"],
];
/* [bureau, [catégorie, nombre de sites, durée, risque, capacité mensuelle]] — proportions du plan réel */
const PLAN = [
  ["Bureau de terrain d'Ambovombe", [["URT",30,6,2,4],["SMP",46,9,2,12],["NTA",38,12,2,10],["MPA",13,6,1,6],["ACL",2,3,1,1]]],
  ["Bureau de terrain d'Ampanihy",  [["URT",21,6,2,12],["SMP",43,9,2,30],["NTA",34,12,2,12],["MPA",10,6,1,10]]],
  ["Bureau de terrain de Toliara",  [["SMP",31,9,2,14],["NTA",30,12,2,9],["CAR",12,6,1,5],["MPA",8,6,1,4],["URT",7,6,2,3],["SAMS",3,3,1,2]]],
];
const CAT_SITE = { SMP:"École", NTA:"Formation sanitaire", MPA:"Point de distribution", URT:"Point de distribution" };

function seed(){
  const existing = db.prepare("SELECT COUNT(*) c FROM sites").get().c;
  if(existing && !process.env.FORCE_SEED){
    log.warn("la base contient déjà des données ; utilisez FORCE_SEED=1 pour réinitialiser");
    return null;
  }
  let plainPassword = config.bootstrapPassword;
  let generated = false;
  if(!plainPassword){
    /* Aucun mot de passe par défaut n'est inscrit dans le code : on en tire un au hasard. */
    plainPassword = crypto.randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g,"") + "9Aa";
    generated = true;
  }
  return { plainPassword, generated };
}

const info = seed();
if(info){
  const pwHash = await hashPassword(info.plainPassword);
  tx(() => {
    for(const t of ["site_months","visits","sites","coverage_params","outputs","outcomes","outcome_plan",
                    "population_values","population","pdd","datasets","scripts","odk_forms",
                    "report_templates","dashboards","indicators","activity_categories","partners",
                    "poi_subtypes","offices","users","settings"]) db.prepare(`DELETE FROM ${t}`).run();

    const officeId = {};
    const insOffice = db.prepare("INSERT INTO offices (id,name,code,kind) VALUES (?,?,?,?)");
    OFFICES.forEach(([name,code]) => { const id = newId("off");
      officeId[name] = id; insOffice.run(id, name, code, code==="HQ" ? "hq" : "field"); });

    const catId = {};
    const insCat = db.prepare("INSERT INTO activity_categories (id,name,tag,program_area) VALUES (?,?,?,?)");
    CATS.forEach(([name,tag,area]) => { const id = newId("cat");
      catId[tag] = { id, name, area }; insCat.run(id, name, tag, area); });

    const partnerId = {};
    const insP = db.prepare("INSERT INTO partners (id,name) VALUES (?,?)");
    PARTNERS.forEach(n => { const id = newId("part"); partnerId[n] = id; insP.run(id, n); });

    const insPoi = db.prepare("INSERT INTO poi_subtypes (id,label,code) VALUES (?,?,?)");
    POI.forEach(([l,c]) => insPoi.run(newId("poi"), l, c));

    const insGeo = db.prepare("INSERT INTO geo (id,adm0,adm1,adm2,adm3,lat,lon) VALUES (?,?,?,?,?,?,?)");
    GEO.forEach(g => insGeo.run(newId("geo"), g[0], g[1], g[2], g[3],
      r5(-25+Math.random()*8), r5(43.5+Math.random()*4)));

    const insInd = db.prepare(`INSERT INTO indicators (id,code,name,basket,unit,target,direction,method,frequency)
                               VALUES (?,?,?,?,?,?,?,?,?)`);
    const indId = {};
    INDICATORS.forEach(i => { const id = newId("ind"); indId[i[0]] = id; insInd.run(id, ...i); });

    const insSite = db.prepare(`INSERT INTO sites
      (id,code,name,status,office_id,antenne,category_id,activity_tag,program_area,poi_subtype,
       poi_subtype_code,site_type,adm1,adm2,adm3,adm4,urban_area,lat,lon,security,modality,
       beneficiaries,partner_id,responsible,last_visit,synergies,new_partner,exp_partner,
       issue_ipm,issue_report,issue_cfm,fraud)
      VALUES (@id,@code,@name,@status,@office_id,@antenne,@category_id,@activity_tag,@program_area,
       @poi_subtype,@poi_subtype_code,@site_type,@adm1,@adm2,@adm3,@adm4,@urban_area,@lat,@lon,
       @security,@modality,@beneficiaries,@partner_id,@responsible,@last_visit,@synergies,
       @new_partner,@exp_partner,@issue_ipm,@issue_report,@issue_cfm,@fraud)`);
    const insMonth = db.prepare(`INSERT INTO site_months
      (site_id,year,month,active,planned,done,cp_name,monitor) VALUES (?,?,?,?,?,?,?,?)`);
    const insVisit = db.prepare(`INSERT INTO visits
      (id,site_id,office_id,visit_date,activity_tag,monitor,form_id,status) VALUES (?,?,?,?,?,?,?,?)`);
    const insParam = db.prepare(`INSERT INTO coverage_params
      (id,csp,office_id,category_id,activity_tag,duration,risk_level,feasible_per_month)
      VALUES (?,?,?,?,?,?,?,?)`);

    let n = 0, pIdx = 0;
    PLAN.forEach(([office, cats]) => cats.forEach(([tag, count, dur, risk, feas]) => {
      insParam.run(newId("cov"), `ACT-${YEAR}-${String(++pIdx).padStart(3,"0")}`,
        officeId[office], catId[tag].id, tag, dur, risk, feas);
      for(let k=0;k<count;k++){
        const g = GEO[n % GEO.length];
        const label = CAT_SITE[tag] || pick(POI)[0];
        const poi = POI.find(p=>p[0]===label) || POI[1];
        const id = newId("site");
        const responsible = pick(["A. Rakoto","M. Rasoa","P. Rabe","S. Andria","L. Razafy"]);
        const partner = pick(PARTNERS);
        const row = {
          id, code:"L"+String(++n).padStart(4,"0"),
          name:`${label==="École"?"EPP":label==="Formation sanitaire"?"CSB":"Site"} ${g[3]} ${n}`,
          status: n % 17 === 0 ? "Inactive" : "Active",
          office_id: officeId[office], antenne: pick(["Bekily","Beloha","Tsihombe","Amboasary","Betioky","Manakara"]),
          category_id: catId[tag].id, activity_tag: tag, program_area: catId[tag].area,
          poi_subtype: poi[0], poi_subtype_code: poi[1], site_type: label==="École" ? "School"
            : label==="Formation sanitaire" ? "Health Center" : "FDP",
          adm1:g[1], adm2:g[2], adm3:g[3], adm4:`Fokontany ${g[3]} ${(n%9)+1}`,
          urban_area: n % 7 === 0 ? "Oui" : "Non",
          lat: r5(-25+Math.random()*8), lon: r5(43.5+Math.random()*4),
          security: pick([0,0,0,1,1,3]), modality: pick(["Espèces","Coupons","Vivres","Renforcement de capacités","Mixte"]),
          beneficiaries: 60 + Math.floor(Math.random()*7000),
          partner_id: partnerId[partner], responsible, last_visit:null,
          synergies: pick([0,0,1]), new_partner: pick([0,0,0,0,0,1]),
          exp_partner: pick([0,0,0,0,1,1,2]), issue_ipm: pick([0,0,0,0,1,1,2]),
          issue_report: pick([0,0,0,1]), issue_cfm: pick([0,0,0,0,1,2]), fraud: pick([0,0,0,0,0,0,1]),
        };
        insSite.run(row);
        let last = null;
        for(let m=0;m<12;m++){
          const active = row.status === "Active" ? 1 : 0;
          const planned = (active && m <= new Date().getMonth() && Math.random() < 0.3) ? 1 : 0;
          const done = (planned && Math.random() < 0.68) ? 1 : 0;
          insMonth.run(id, YEAR, m, active, planned, done, planned ? partner : null,
                       done ? responsible : null);
          if(done){
            const date = `${YEAR}-${String(m+1).padStart(2,"0")}-${String(3+Math.floor(Math.random()*24)).padStart(2,"0")}`;
            insVisit.run(newId("visit"), id, officeId[office], date, tag, responsible, "340943",
              Math.random() < 0.8 ? "Validé" : "À valider");
            last = date;
          }
        }
        if(!last && n % 6 === 0) last = `${YEAR-1}-${String(1+Math.floor(Math.random()*12)).padStart(2,"0")}-12`;
        if(last) db.prepare("UPDATE sites SET last_visit=? WHERE id=?").run(last, id);
      }
    }));

    const insOut = db.prepare(`INSERT INTO outputs (id,activity_tag,year,month,planned,actual,adjust)
                               VALUES (?,?,?,?,?,?,?)`);
    ["URT","ACL","CAR","SMP","NTA","MPA"].forEach(tag => {
      for(let m=0;m<=new Date().getMonth();m++){
        const planned = 4000 + Math.floor(Math.random()*9000);
        insOut.run(newId("out"), tag, YEAR, m, planned,
          Math.round(planned*(0.62+Math.random()*0.45)), pick(["none","none","up","down","new"]));
      }
    });

    const insOc = db.prepare(`INSERT INTO outcomes (id,indicator_id,adm1,round_label,planned,value,collected_at,sample)
                              VALUES (?,?,?,?,?,?,?,?)`);
    INDICATORS.forEach(i => ["Androy","Anosy","Atsimo-Andrefana","Vatovavy"].forEach(reg => {
      const base = i[5]==="up" ? i[4]*(0.6+Math.random()*0.5) : i[4]*(0.85+Math.random()*0.5);
      insOc.run(newId("oc"), indId[i[0]], reg, "Référence", i[4], r2(base), `${YEAR}-02-15`, 180+Math.floor(Math.random()*300));
      insOc.run(newId("oc"), indId[i[0]], reg, "Suivi S1", i[4],
        r2(i[5]==="up" ? base*(1+Math.random()*0.25) : base*(0.78+Math.random()*0.18)),
        `${YEAR}-06-20`, 180+Math.floor(Math.random()*300));
    }));

    const insPop = db.prepare("INSERT INTO population (id,area_key,level,base,rate) VALUES (?,?,?,?,?)");
    [...new Set(GEO.map(g=>g[2]))].forEach(k =>
      insPop.run(newId("pop"), k, "adm2", 40000+Math.floor(Math.random()*160000), 2.7));

    const insPdd = db.prepare(`INSERT INTO pdd
      (id,year,month,wbs,act_type,activity_tag,act_main,office_id,bureau,region,district,commune,
       partner_id,modality,commodity,days,benef_planned,households,tonnage,amount,
       benef_actual,received,distributed,status)
      VALUES (@id,@year,@month,@wbs,@act_type,@activity_tag,@act_main,@office_id,@bureau,@region,
       @district,@commune,@partner_id,@modality,@commodity,@days,@benef_planned,@households,
       @tonnage,@amount,@benef_actual,@received,@distributed,@status)`);
    const BUREAUX = OFFICES.filter(o=>o[1]!=="HQ");
    [Math.max(0,new Date().getMonth()-1), new Date().getMonth()].forEach(mi =>
      BUREAUX.forEach(([oname, code]) => GEO.slice(0,4).forEach(g =>
        ["GD","PREVMA"].forEach(actType => {
          if(Math.random() < 0.25) return;
          const modality = actType==="GD" ? pick(["Food","Food","Cash"]) : "Food";
          const bp = 1500 + Math.floor(Math.random()*22000);
          const days = actType==="GD" ? 15 : 30;
          const tonnage = modality==="Food" ? r2(bp*days*0.0006*(0.8+Math.random()*0.5)) : 0;
          const amount = modality==="Cash" ? Math.round(bp*days*1600) : 0;
          const cb = Math.random()<0.14 ? 0 : 0.55+Math.random()*0.5;
          const cr = Math.random()<0.10 ? 0 : 0.60+Math.random()*0.45;
          const cd = Math.random()<0.14 ? 0 : Math.min(cr, 0.5+Math.random()*0.75);
          insPdd.run({ id:newId("pdd"), year:YEAR, month:mi, wbs: actType==="GD"?"URT1":"URT2",
            act_type:actType, activity_tag: actType==="GD"?"URT_GD":"URT_PREV",
            act_main: actType==="GD" ? "Distribution générale sécheresse" : "Prévention de la malnutrition aiguë",
            office_id: officeId[oname], bureau: code, region:g[1], district:g[2], commune:g[3],
            partner_id: partnerId[pick(PARTNERS)], modality,
            commodity: modality==="Food" ? (actType==="GD" ? pick(["Riz","Sorgho"]) : pick(["Super Cereal CSB+","LNS-mq/Plumpy Doz"])) : null,
            days, benef_planned:bp, households:Math.round(bp/5), tonnage, amount,
            benef_actual:Math.round(bp*cb), received:r2((modality==="Food"?tonnage:amount)*cr),
            distributed:r2((modality==="Food"?tonnage:amount)*cd), status: cd>0 ? "done" : "planned" });
        }))));

    db.prepare("INSERT INTO report_templates (id,name,blocks,intro) VALUES (?,?,?,?)")
      .run(newId("tpl"), "Rapport mensuel de suivi",
           JSON.stringify(["kpi","coverage","activity","sites"]),
           "Rapport mensuel de suivi de processus\n\nPériode : {periode}\nOrganisation : {org}");
    db.prepare("INSERT INTO report_templates (id,name,blocks,intro) VALUES (?,?,?,?)")
      .run(newId("tpl"), "Note de couverture trimestrielle",
           JSON.stringify(["kpi","coverage"]), "Note de couverture\n\nPériode : {periode}");
    db.prepare("INSERT INTO dashboards (id,name,widgets) VALUES (?,?,?)")
      .run(newId("dash"), "Vue générale", JSON.stringify([
        { id:"w1", type:"bar", source:"sites", dim:"subOffice", measure:"count", title:"Sites par bureau" },
        { id:"w2", type:"pie", source:"sites", dim:"activityTag", measure:"beneficiaries", title:"Bénéficiaires par activité" }]));
    db.prepare("INSERT INTO odk_forms (id,name,form_id,project,kind,activity_tag,site_field,date_field) VALUES (?,?,?,?,?,?,?,?)")
      .run(newId("odk"), "Suivi de processus — visite de site", "340943", "1", "process", "NTA", "site_id", "visit_date");

    const setS = db.prepare("INSERT INTO settings (key,value) VALUES (?,?)");
    Object.entries({ org:"Bureau pays", unit:"Unité suivi et évaluation", logo:"", currency:"MGA",
      dateFmt:"DD/MM/YYYY", pageSize:25, syncInterval:30, notifications:true,
      odkBase:"https://odk-central.example.org", opSize:"Large" })
      .forEach(([k,v]) => setS.run(k, JSON.stringify(v)));

    const uid = newId("user");
    db.prepare(`INSERT INTO users (id,email,pw_hash,first_name,last_name,title,office_id,role,tabs,active,must_change_pw)
                VALUES (?,?,?,?,?,?,?, 'super', ?, 1, 1)`)
      .run(uid, config.bootstrapEmail, pwHash, "Administrateur", "MEMS",
           "Responsable suivi et évaluation", null,
           JSON.stringify(["home","planning","actual","analytics","reports","settings"]));
  })();

  const counts = ["offices","activity_categories","sites","site_months","visits","coverage_params",
    "outputs","outcomes","pdd","indicators","geo","users"]
    .map(t => `${t}=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`).join("  ");
  log.info("jeu de données initial créé", { tables: counts });
  process.stdout.write(
`\n──────────────────────────────────────────────────────────────
 Compte administrateur initial
   adresse      : ${config.bootstrapEmail}
   mot de passe : ${info.plainPassword}${info.generated ? "   (généré, notez-le maintenant)" : "   (repris de BOOTSTRAP_PASSWORD)"}
 Ce mot de passe devra être changé à la première connexion.
 Il n'est affiché qu'ici et n'apparaît nulle part dans l'application.
──────────────────────────────────────────────────────────────\n\n`);
}
