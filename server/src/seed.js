import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, migrate, tx } from "./db.js";
import { config } from "./config.js";
import { log } from "./lib/logger.js";
import { newId } from "./lib/crypto.js";
import { buildUnits, writeVersion, resolveUnit } from "./lib/geo.js";
import { planAmount, regenerate } from "./lib/tpm.js";
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
/* Un bureau de terrain couvre des districts précis, pas tout le pays. Sans ce
   découpage, chaque bureau se retrouvait présent dans les dix communes et le
   cloisonnement par bureau ne cloisonnait plus rien. Index dans GEO. */
const ZONES = {
  "Bureau de terrain d'Ambovombe": [0,1,2,3],   /* Androy */
  "Bureau de terrain d'Ampanihy":  [6],         /* Ampanihy Ouest */
  "Bureau de terrain de Toliara":  [7,8],       /* Toliara II */
  "Bureau de terrain de Manakara": [9],         /* Manakara */
  "Bureau de terrain de Tolagnaro":[4,5],       /* Anosy */
};

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
                    "population_values","population","caseload","pdd","datasets","scripts","odk_forms",
                    "report_templates","dashboards","indicators","activity_categories","partners",
                    "poi_subtypes","mre_activity",
                    /* tpm efface contrats, plans, zones, lignes et dépenses en cascade */
                    "tpm","offices","users","settings",
                    /* geo_version efface geo_unit en cascade */
                    "office_scope","geo_version","geo"]) db.prepare(`DELETE FROM ${t}`).run();

    const officeId = {};
    /* Le bureau central est national : ses staffs voient tous les sites sans être
       administrateurs. Les antennes viennent de ZONES pour rester cohérentes
       avec les districts réellement couverts. */
    /* Le pays de rattachement vient de la configuration, pas d'un « MDG » écrit ici :
       une instance sert plusieurs pays, et un bureau sans pays serait visible depuis
       tous — ce qui est le bon repli pour une ligne ancienne, mais un défaut pour une
       ligne qu'on crée. Le rattrapage de la migration 015 ne peut rien pour elles :
       elle s'exécute avant l'amorçage, sur une table vide. */
    const paysSeed = db.prepare("SELECT code FROM country WHERE is_current=1").get()?.code
      || db.prepare("SELECT code FROM country ORDER BY name LIMIT 1").get()?.code || null;
    const insOffice = db.prepare(`INSERT INTO offices (id,name,code,kind,country_code,scope_mode,antennes,manager)
                                  VALUES (?,?,?,?,?,?,?,?)`);
    OFFICES.forEach(([name,code]) => { const id = newId("off"); const hq = code === "HQ";
      officeId[name] = id;
      insOffice.run(id, name, code, hq ? "hq" : "field", paysSeed, hq ? "national" : "geo",
        JSON.stringify(hq ? [] : [code[0] + code.slice(1).toLowerCase()]),
        hq ? "Chef de l'unité suivi-évaluation" : "Chef de bureau"); });

    const catId = {};
    const insCat = db.prepare("INSERT INTO activity_categories (id,name,tag,program_area) VALUES (?,?,?,?)");
    CATS.forEach(([name,tag,area]) => { const id = newId("cat");
      catId[tag] = { id, name, area }; insCat.run(id, name, tag, area); });

    const partnerId = {};
    const insP = db.prepare("INSERT INTO partners (id,name) VALUES (?,?)");
    PARTNERS.forEach(n => { const id = newId("part"); partnerId[n] = id; insP.run(id, n); });

    const insPoi = db.prepare("INSERT INTO poi_subtypes (id,label,code) VALUES (?,?,?)");
    POI.forEach(([l,c]) => insPoi.run(newId("poi"), l, c));

    /* Un centre par commune, partagé par tout ce qui porte des coordonnées : la
       table plate historique, le référentiel arborescent et les sites. Avant, les
       trois tiraient au hasard dans tout le sud de l'île indépendamment les uns
       des autres — invisible sur une carte de points, absurde dès qu'on dessine les
       contours, où chaque commune devenait un rectangle grand comme une région. */
    const CENTRE = GEO.map((_, gi) => [
      -25.4 + Math.floor(gi / 4) * 1.9 + (gi % 2) * 0.35,   /* latitude  */
      43.8 + (gi % 4) * 1.15,                                /* longitude */
    ]);
    const autour = (gi, rayon) => {
      const [la, lo] = CENTRE[gi]; const a = Math.random() * 2 * Math.PI;
      const d = Math.sqrt(Math.random()) * rayon;
      return [r5(la + Math.sin(a) * d), r5(lo + Math.cos(a) * d * 1.1)];
    };

    /* Table plate historique — conservée tant que sites.geo_id la référence. */
    const insGeo = db.prepare("INSERT INTO geo (id,adm0,adm1,adm2,adm3,lat,lon) VALUES (?,?,?,?,?,?,?)");
    GEO.forEach((g, gi) => insGeo.run(newId("geo"), g[0], g[1], g[2], g[3],
      CENTRE[gi][0], CENTRE[gi][1]));

    /* Référentiel arborescent : c'est lui que l'application interroge désormais.
       Trois fokontany par commune, pour que la cascade ait quatre niveaux réels. */
    /* Les coordonnées étaient tirées au hasard dans tout le sud de l'île, y compris
       pour les fokontany d'une même commune. Sur une carte de points cela passait
       inaperçu ; dès qu'on dessine les contours, chaque commune devient un
       rectangle grand comme une région et l'emboîtement n'a plus de sens. Les
       localités sont donc regroupées : une commune occupe une petite zone, ses
       fokontany se répartissent autour de son centre. */
    const geoRows = [];
    GEO.forEach(([adm0, adm1, adm2, adm3], gi) => {
      const [cLat, cLon] = CENTRE[gi];
      for(let k = 1; k <= 3; k++){
        const a = (k / 3) * 2 * Math.PI;
        geoRows.push({ adm0, adm1, adm2, adm3,
          adm4: `${adm3} ${["Centre","Nord","Sud"][k-1]}`,
          lat: r5(cLat + Math.sin(a) * 0.14), lon: r5(cLon + Math.cos(a) * 0.16) });
      }
    });
    const { units } = buildUnits(geoRows);
    /* Le rattachement au pays courant est fait par writeVersion. */
    writeVersion({ label:"Jeu de démonstration", source:"seed.js", units });

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
        const zone = ZONES[office] || GEO.map((_,i)=>i);
        const g = GEO[zone[n % zone.length]];
        const pos = autour(zone[n % zone.length], 0.1);
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
          /* Le site est dans sa commune, pas ailleurs dans l'île — et d'un seul
             tirage : deux appels auraient croisé la latitude d'un point avec la
             longitude d'un autre. Le rayon reste sous celui du cadre de la commune,
             sinon des sites se retrouveraient hors de leur propre contour. */
          lat: pos[0], lon: pos[1],
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

    /* Table historique, conservée le temps de la reprise (voir src/link-geo.js). */
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
    /* Un bureau par commune, pas tous les bureaux dans toutes les communes :
       sinon les volumes cumulés donnent des communes à un million d'habitants. */
    const bureauDe = {};
    for(const [office, idx] of Object.entries(ZONES))
      for(const i of idx){ const b = BUREAUX.find(o => o[0] === office); if(b) bureauDe[GEO[i][3]] = b; }
    /* Filet : une commune non attribuée revient au premier bureau. */
    GEO.forEach(g => { bureauDe[g[3]] = bureauDe[g[3]] || BUREAUX[0]; });
    [Math.max(0,new Date().getMonth()-1), new Date().getMonth()].forEach(mi =>
      GEO.forEach(g => { const [oname, code] = bureauDe[g[3]];
        ["GD","PREVMA"].forEach(actType => {
          if(Math.random() < 0.25) return;
          const modality = actType==="GD" ? pick(["Food","Food","Cash"]) : "Food";
          const bp = 1200 + Math.floor(Math.random()*9000);
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
        }); }));

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


    /* Périmètre déclaré de chaque bureau : on attribue le district de chacune de
       ses communes. Déclarer le district plutôt que la commune est plus proche de
       la réalité — un bureau couvre un district, pas une liste de communes. */
    {
      const gv0 = db.prepare("SELECT id FROM geo_version WHERE is_current=1").get();
      const insScope = db.prepare(
        "INSERT OR IGNORE INTO office_scope (office_id,geo_pcode) VALUES (?,?)");
      for(const [office, idx] of Object.entries(ZONES)){
        if(!officeId[office]) continue;
        for(const i of idx){
          const m = resolveUnit({ adm1:GEO[i][1], adm2:GEO[i][2] }, gv0.id);
          if(m.pcode) insScope.run(officeId[office], m.pcode);
        }
      }
      /* Le bureau central n'a pas de périmètre : il voit tout par son rôle. */
    }

    /* Sites et plan de distribution rattachés au référentiel dès la génération :
       le jeu de démonstration est cohérent sans passer par src/link-geo.js. */
    {
      const gv = db.prepare("SELECT id FROM geo_version WHERE is_current=1").get();
      const lier = (table, cols) => {
        const upd = db.prepare(`UPDATE ${table} SET geo_pcode=? WHERE id=?`);
        let n = 0;
        for(const row of db.prepare(`SELECT * FROM ${table}`).all()){
          const names = {}; for(const [lvl, col] of Object.entries(cols)) names[lvl] = row[col];
          const m = resolveUnit(names, gv.id);
          if(m.pcode){ upd.run(m.pcode, row.id); n++; }
        }
        return n;
      };
      lier("sites", { adm1:"adm1", adm2:"adm2", adm3:"adm3", adm4:"adm4" });
      lier("pdd",   { adm1:"region", adm2:"district", adm3:"commune" });
    }

    /* Population et ciblage par commune — dérivés du plan de distribution afin que
       les taux restent plausibles. Un taux de couverture de 2 700 % dans un jeu de
       démonstration décrédibilise l'outil avant même qu'on l'ait regardé.

       Le ciblage diffère selon l'activité ; la ligne « toutes activités » porte le
       total dédoublonné, donc inférieur à la somme des activités. */
    const insCl = db.prepare(`INSERT INTO caseload
      (id,geo_pcode,level,year,month,activity_tag,population,households,targeted,targeted_hh,source)
      VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`);
    const SOURCE = "INSTAT RGPH-3 2018, projeté 2,7 %";
    const plannedBy = Object.fromEntries(db.prepare(
      `SELECT geo_pcode, SUM(benef_planned) p FROM pdd
       WHERE year=? AND geo_pcode IS NOT NULL GROUP BY geo_pcode`).all(YEAR).map(x=>[x.geo_pcode,x.p]));
    db.prepare(`SELECT pcode, name FROM geo_unit
      WHERE version_id=(SELECT id FROM geo_version WHERE is_current=1) AND level='adm3'`)
      .all().forEach(c => {
        const planned = plannedBy[c.pcode] || 0;
        /* Cible déduite du planifié : couverture entre 80 % et 110 %. */
        const total = planned
          ? Math.round(planned / (0.8 + Math.random()*0.3))
          : 4000 + Math.floor(Math.random()*16000);
        /* Population telle que le taux de ciblage tombe entre 20 % et 35 %. */
        const pop = Math.round(total / (0.20 + Math.random()*0.15));
        const hh  = Math.round(pop/4.8);
        insCl.run(newId("cl"), c.pcode, "adm3", YEAR, "", pop, hh, total, Math.round(total/4.8), SOURCE);
        /* Les activités se recouvrent : leur somme dépasse le total dédoublonné. */
        const brut = total / 0.72;
        [["URT",0.46],["NTA",0.26],["SMP",0.28]].forEach(([tag,share]) => {
          const t = Math.round(brut*share);
          insCl.run(newId("cl"), c.pcode, "adm3", YEAR, tag, pop, hh, t, Math.round(t/4.8), SOURCE);
        });
      });

    /* ── Plan MRE et budget ────────────────────────────────────────────
       Un plan annuel plausible : quelques activités portées par le bureau pays,
       quelques-unes par les bureaux de terrain, chacune chiffrée par lignes. Le
       budget n'est jamais saisi en bloc — il se déduit des lignes, comme la
       route le calcule. La dépense n'est renseignée que sur les mois écoulés,
       sinon l'exécution budgétaire afficherait 0 % pour toute l'année à venir. */
    const hqId = officeId["Bureau central d'Antananarivo"];
    const moisCourant = new Date().getMonth();
    const insMre = db.prepare(`INSERT INTO mre_activity
      (id,year,ref,title,kind,purpose,method,office_id,activity_tag,responsible,entity,
       cost_category,high_category,unit_cost,sample,status,funding,currency,note,country_code)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'USD',?,?)`);
    const insFreq  = db.prepare(`INSERT INTO mre_frequency (id,activity_id,year,quarter,n)
                                 VALUES (?,?,?,?,?)`);
    const insSpend = db.prepare(`INSERT INTO mre_spend (id,activity_id,year,amount) VALUES (?,?,?,?)`);

    /* Le plan suit le modèle du classeur de référence : coût UNITAIRE et fréquence
       par trimestre, sur plusieurs années. Le budget d'une année en découle — il
       n'est écrit nulle part, ici pas plus qu'en production. */
    const PLAN_MRE = [
      ["MRE-01","Suivi de processus des distributions générales","suivi",
       "Vérifier la conformité des distributions aux procédures et recueillir les plaintes",
       "Visites de site avec formulaire ODK","interne","Suivi de distribution","dsc_monitoring",
       "URT","Unité suivi-évaluation",null,7400,
       { [YEAR]:[3,3,3,3], [YEAR+1]:[3,3,3,3] },
       "Formulaire de suivi mensuel dans chaque bureau"],
      ["MRE-02","Enquête post-distribution — transferts non conditionnels","enquete",
       "Mesurer la satisfaction, l'utilisation de l'assistance et les délais de service",
       "Entretiens ménages, échantillon aléatoire","externe","PDM (général)","dsc_assessment",
       "URT","Cabinet d'enquête",1200,42000,
       { [YEAR]:[0,1,0,1], [YEAR+1]:[0,1,0,1] },
       "Deux passages par an, semestriels"],
      ["MRE-03","Enquête de référence — création d'actifs","enquete",
       "Établir la référence des indicateurs de résilience avant la nouvelle phase",
       "Enquête ménages et groupes de discussion","externe","Référence (général)","dsc_assessment",
       "ACL","Cabinet d'enquête",900,58000,
       { [YEAR]:[0,0,1,0] },
       "Une seule fois, au démarrage de la phase"],
      ["MRE-04","Revue annuelle du programme","revue",
       "Rapprocher le réalisé du plan et arrêter les corrections de l'exercice suivant",
       "Atelier de revue avec les partenaires","interne","Revue annuelle","dsc_monitoring",
       null,"Chef de l'unité suivi-évaluation",null,19000,
       { [YEAR]:[0,0,0,1], [YEAR+1]:[0,0,0,1] },
       "Atelier de trois jours, partenaires inclus"],
      ["MRE-05","Évaluation décentralisée de l'activité de résilience","evaluation",
       "Apprécier la pertinence, l'efficacité et la durabilité de l'activité",
       "Évaluation externe conforme aux normes d'évaluation","externe",
       "Évaluation décentralisée","dsc_evaluation",
       "ACL","Bureau d'évaluation",null,96000,
       { [YEAR+1]:[0,1,0,0] },
       "Prévue l'an prochain, gestion par le bureau régional"],
      ["MRE-06","Renforcement des capacités de suivi des partenaires","capacite",
       "Mettre les partenaires coopérants au niveau attendu sur la collecte et la qualité",
       "Formation et accompagnement sur site","interne","Formation des partenaires","isc_staff",
       null,"Unité suivi-évaluation",null,11500,
       { [YEAR]:[1,0,1,0], [YEAR+1]:[1,0,0,0] },
       "Deux sessions par an, plus l'accompagnement"],
      ["MRE-07","Mécanisme de retour d'information des bénéficiaires","suivi",
       "Recueillir et traiter les plaintes et retours, et en rendre compte",
       "Centre d'appel et registres de site","externe","Mécanisme de retour d'information","equipment",
       null,"Prestataire de centre d'appel",null,5200,
       { [YEAR]:[1,1,1,1], [YEAR+1]:[1,1,1,1] },
       "Coût trimestriel de la licence et du centre d'appel"],
    ];

    /* Le trimestre courant borne ce qui peut être « réalisé » et ce qui peut porter
       une dépense : un plan de démonstration où l'avenir serait déjà dépensé
       n'apprendrait rien à personne. */
    const trimCourant = Math.floor(moisCourant / 3);
    PLAN_MRE.forEach(([ref,title,kind,purpose,method,entity,cat,high,tag,resp,sample,unitCost,freq,note]) => {
      const id = newId("mre");
      const annees = Object.keys(freq).map(Number).sort();
      const passe = annees[0] < YEAR || (annees[0] === YEAR && freq[YEAR] &&
        freq[YEAR].slice(trimCourant+1).every(x => !x));
      insMre.run(id, YEAR, ref, title, kind, purpose, method, hqId, tag, resp, entity,
        cat, high, unitCost, sample,
        annees[0] > YEAR ? "planifie" : passe ? "realise" : "en_cours",
        "Ressources programme", note, paysSeed);
      for(const [an, qs] of Object.entries(freq))
        qs.forEach((n2, q) => { if(n2 > 0) insFreq.run(newId("mfr"), id, Number(an), q, n2); });
      /* Dépense constatée sur les trimestres écoulés seulement, avec un écart
         réaliste de part et d'autre du budget. */
      const faites = (freq[YEAR] || []).slice(0, trimCourant + 1).reduce((t, x) => t + x, 0);
      if(faites > 0) insSpend.run(newId("msp"), id, YEAR,
        r2(faites * unitCost * (0.84 + Math.random()*0.28)));
    });

    /* Chaque bureau de terrain porte son propre suivi de proximité : le plan
       n'est pas seulement national, et le cloisonnement doit avoir de la matière. */
    Object.keys(ZONES).forEach((office, i) => {
      const id = newId("mre");
      const court = office.replace("Bureau de terrain d'","").replace("Bureau de terrain de ","");
      insMre.run(id, YEAR, `MRE-B${String(i+1).padStart(2,"0")}`,
        `Suivi de proximité — ${court}`,
        "suivi", "Couvrir les sites du bureau selon l'exigence minimale de suivi",
        "Visites de site planifiées par le risque", officeId[office], null, "Chef de bureau",
        "interne", "Suivi sur site", "dsc_monitoring", 2600, null,
        moisCourant > 0 ? "en_cours" : "planifie", "Ressources programme",
        "Décliné du plan national sur la zone du bureau", paysSeed);
      [0,1,2,3].forEach(q => insFreq.run(newId("mfr"), id, YEAR, q, 3));
      const faites = (trimCourant + 1) * 3;
      insSpend.run(newId("msp"), id, YEAR, r2(faites * 2600 * (0.85 + Math.random()*0.25)));
    });

    /* ── Contours administratifs du jeu de démonstration ───────────────
       Un fond de carte réel suppose un shapefile officiel, qui ne peut pas vivre
       dans un dépôt de code. On fabrique donc des contours COHÉRENTS : chaque
       district est un rectangle autour de ses communes, chaque commune un
       rectangle autour de ses fokontany, et l'emboîtement est respecté. Ce n'est
       pas la géographie de Madagascar, et le libellé de la source le dit — mais
       cela suffit à ce que la carte, les aplats thématiques et le cadrage soient
       exerçables sans fichier externe. */
    {
      const gvG = db.prepare("SELECT id FROM geo_version WHERE is_current=1").get();
      /* Les unités feuilles portent déjà des coordonnées (posées à la génération) :
         on remonte les cadres depuis elles. */
      const unites = db.prepare(
        `SELECT pcode, parent_pcode, level, lat, lon FROM geo_unit WHERE version_id=?`).all(gvG.id);
      const enfantsDe = {};
      unites.forEach(u => { if(u.parent_pcode)
        (enfantsDe[u.parent_pcode] = enfantsDe[u.parent_pcode] || []).push(u); });

      /* Cadre d'une unité : ses propres coordonnées, élargies par celles de ses
         descendants. Calculé de bas en haut, une seule fois par unité. */
      const cadres = {};
      const cadreDe = (u) => {
        if(cadres[u.pcode]) return cadres[u.pcode];
        let box = null;
        const etendre = (lon, lat, m) => {
          const b = { w:lon-m, e:lon+m, s:lat-m, n:lat+m };
          box = box ? { w:Math.min(box.w,b.w), e:Math.max(box.e,b.e),
                        s:Math.min(box.s,b.s), n:Math.max(box.n,b.n) } : b;
        };
        for(const c of (enfantsDe[u.pcode] || [])){
          const cb = cadreDe(c);
          if(cb) box = box ? { w:Math.min(box.w,cb.w), e:Math.max(box.e,cb.e),
                               s:Math.min(box.s,cb.s), n:Math.max(box.n,cb.n) } : { ...cb };
        }
        /* Marge propre au niveau : un fokontany est petit, une région large. */
        const marge = { adm4:0.03, adm3:0.06, adm2:0.12, adm1:0.2, adm0:0.4 }[u.level] || 0.05;
        if(u.lat != null && u.lon != null) etendre(u.lon, u.lat, marge);
        if(!box) return (cadres[u.pcode] = null);
        /* Un cadre plat ne se dessine pas : on l'épaissit du minimum. */
        if(box.e - box.w < 0.01){ box.w -= 0.01; box.e += 0.01; }
        if(box.n - box.s < 0.01){ box.s -= 0.01; box.n += 0.01; }
        return (cadres[u.pcode] = box);
      };

      const insG = db.prepare(`INSERT INTO geo_geom
        (pcode,version_id,level,geometry,simple,min_lon,min_lat,max_lon,max_lat,points,points_simple)
        VALUES (?,?,?,?,?,?,?,?,?,5,5)`);
      let nG = 0;
      for(const u of unites){
        if(u.level === "adm0") continue;   /* le pays n'a pas à être dessiné */
        const b = cadreDe(u);
        if(!b) continue;
        const g = JSON.stringify({ type:"Polygon", coordinates:[[
          [r5(b.w), r5(b.s)], [r5(b.e), r5(b.s)], [r5(b.e), r5(b.n)],
          [r5(b.w), r5(b.n)], [r5(b.w), r5(b.s)] ]] });
        /* Cinq sommets : la simplification n'aurait rien à retirer, les deux
           résolutions sont donc identiques ici. */
        insG.run(u.pcode, gvG.id, u.level, g, g, r5(b.w), r5(b.s), r5(b.e), r5(b.n));
        nG++;
      }
      db.prepare(`UPDATE geo_version SET geom_units=?,
                  geom_source='Contours de démonstration — rectangles emboîtés, non géographiques',
                  geom_at=datetime('now') WHERE id=?`).run(nG, gvG.id);
    }

    /* ── Suivi tiers ───────────────────────────────────────────────────
       Le barème et les quantités reprennent le classeur réel d'un prestataire de
       suivi : indemnité de superviseur et d'agent à la personne-jour, location et
       carburant au véhicule-jour, forfait de communication. Le budget des plans
       n'est pas écrit ici — il est calculé par lib/tpm.js à partir de ce barème et
       des affectations, comme il le sera en production. */
    {
      const gvT = db.prepare("SELECT id FROM geo_version WHERE is_current=1").get();
      const insTpm = db.prepare(`INSERT INTO tpm (id,name,code,office_id,country_code,contact,email,active,updated_at)
                                 VALUES (?,?,?,?,?,?,?,1,datetime('now'))`);
      const insCtr = db.prepare(`INSERT INTO tpm_contract
        (id,tpm_id,ref,ceiling,currency,start_date,end_date,status,note,updated_at)
        VALUES (?,?,?,?,'MGA',?,?,'actif',?,datetime('now'))`);
      const insRate = db.prepare(`INSERT INTO tpm_rate
        (id,contract_id,driver,label,unit,unit_cost,active,sort) VALUES (?,?,?,?,?,?,1,?)`);
      const insPlan = db.prepare(`INSERT INTO tpm_plan
        (id,tpm_id,contract_id,year,month,ref,status,note,updated_at)
        VALUES (?,?,?,?,?,?,?,?,datetime('now'))`);
      const insZone = db.prepare(`INSERT INTO tpm_zone (id,plan_id,geo_pcode,activity_tag,
        team_label,supervisors,agents,days,travel_days,vehicles,fuel_litres,sites,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insRev = db.prepare(`INSERT INTO tpm_review
        (id,plan_id,level,decision,comment,amount,user_id,user_label) VALUES (?,?,?,?,?,?,NULL,?)`);
      const insExp = db.prepare(`INSERT INTO tpm_expense (id,plan_id,line_id,spent_on,amount,ref)
                                 VALUES (?,?,?,?,?,?)`);

      /* Barème commun, en ariary — les montants du classeur de référence. */
      const BAREME = [
        ["superviseur", "Indemnité des superviseurs", "pers-jour", 70000],
        ["agent",       "Indemnité des agents",       "pers-jour", 60000],
        ["vehicule",    "Location voiture",           "véhicule-jour", 300000],
        ["carburant",   "Carburant voiture",          "litre", 5000],
        ["forfait",     "Forfait communication",      "forfait", 10000],
      ];
      const PRESTATAIRES = [
        ["Mahavotse Suivi", "MAHAVOTSE", "Bureau de terrain d'Ambovombe",
         "R. Randriamalala", 240_000_000],
        ["Fanavotana Monitoring", "FANAVOTANA", "Bureau de terrain d'Ampanihy",
         "S. Rakotomalala", 120_000_000],
      ];
      const contratDe = {};
      PRESTATAIRES.forEach(([nom, code, bureau, contact, plafond], i) => {
        const tid = newId("tpm");
        insTpm.run(tid, nom, code, officeId[bureau] || null, paysSeed, contact,
          `${code.toLowerCase()}@prestataire.mg`);
        const cid = newId("tct");
        insCtr.run(cid, tid, `TPM-${YEAR}-${String(i+1).padStart(2,"0")}`, plafond,
          `${YEAR}-01-01`, `${YEAR}-12-31`,
          "Suivi de processus et de distribution des activités du bureau");
        BAREME.forEach(([driver, label, unit, cost], k) =>
          insRate.run(newId("trt"), cid, driver, label, unit, cost, k));
        contratDe[nom] = { tid, cid, bureau, plafond };
        /* Un avenant sur le premier contrat : le suivi budgétaire n'a d'intérêt
           que si le plafond a une histoire. */
        if(i === 0) db.prepare(`INSERT INTO tpm_amendment (id,contract_id,ref,delta,reason,signed_at)
                                VALUES (?,?,?,?,?,?)`)
          .run(newId("tam"), cid, "AV-01", 30_000_000,
               "Extension du périmètre au district de Beloha", `${YEAR}-04-15`);
      });

      /* Trois mois de plans, à des étapes différentes du circuit : un clôturé, un
         validé au niveau pays avec ses dépenses, un en cours de validation, et un
         brouillon. Sans cette variété, l'écran de validation serait toujours vide
         et le circuit ne se verrait pas. */
      const mois = new Date().getMonth();
      const ETAPES = [
        [Math.max(0, mois - 2), "cloture",       ["tpm","bureau","pays"]],
        [Math.max(0, mois - 1), "valide_pays",   ["tpm","bureau","pays"]],
        [mois,                  "valide_tpm",    ["tpm"]],
        [Math.min(11, mois + 1),"brouillon",     []],
      ];
      Object.entries(contratDe).forEach(([nom, c], pi) => {
        /* Les zones du prestataire : les communes des districts de son bureau. */
        const idx = ZONES[c.bureau] || [];
        const communes = idx.map(i => resolveUnit(
          { adm1:GEO[i][1], adm2:GEO[i][2], adm3:GEO[i][3] }, gvT.id))
          .filter(m => m.pcode);
        if(!communes.length) return;

        ETAPES.forEach(([m, statut, niveaux], si) => {
          const pid = newId("tpp");
          insPlan.run(pid, c.tid, c.cid, YEAR, m,
            `${YEAR}-${String(m+1).padStart(2,"0")}-${(pi+1)}`, statut,
            "Suivi de processus des distributions générales et de la prise en charge nutritionnelle");
          communes.forEach((cm, zi) => {
            const jours = 2 + (zi % 3) * 2;
            insZone.run(newId("tpz"), pid, cm.pcode, ["URT","NTA","SMP"][zi % 3],
              `TEAM${zi+1}`, 1 + (zi % 2), 1 + (zi % 3), jours, jours > 4 ? 1 : 0,
              1, 15 * jours, 3 + zi, null);
          });
          /* Les lignes dérivent du barème : on appelle la même fonction que la route. */
          regenerate(pid);
          /* Les frais communs du mois, hors équipe — comme le groupe électrogène
             du classeur, qui ne dérive d'aucune quantité d'équipe. */
          db.prepare(`INSERT INTO tpm_line (id,plan_id,zone_id,driver,label,unit,qty1,qty2,unit_cost,derived,sort)
                      VALUES (?,?,NULL,'forfait',?,?,?,1,?,0,900)`)
            .run(newId("tpl"), pid, "Groupe électrogène avec carburant", "groupe", 1, 80000);

          const montant = planAmount(pid);
          niveaux.forEach(niv => insRev.run(newId("trv"), pid, niv, "valide",
            niv === "pays" ? "Conforme au périmètre contractuel." : null, montant,
            niv === "tpm" ? "Responsable prestataire" :
            niv === "bureau" ? "Suivi-évaluation du bureau" : "Suivi-évaluation pays"));

          /* Dépenses sur les plans engagés seulement : une dépense sur un plan non
             validé serait incohérente avec ce que la route autorise. */
          if(["valide_pays","cloture"].includes(statut)){
            const lignes = db.prepare("SELECT id,qty1,qty2,unit_cost FROM tpm_line WHERE plan_id=?").all(pid);
            lignes.forEach((l, li) => {
              if(li % 3 === 2) return;   /* toutes les lignes ne sont pas encore réglées */
              const prevu = l.qty1 * l.qty2 * l.unit_cost;
              insExp.run(newId("tex"), pid, l.id,
                `${YEAR}-${String(m+1).padStart(2,"0")}-${String(10 + (li % 15)).padStart(2,"0")}`,
                r2(prevu * (0.88 + Math.random() * 0.22)), `FAC-${m+1}-${li+1}`);
            });
          }
        });
      });
    }

    const uid = newId("user");
    db.prepare(`INSERT INTO users (id,email,pw_hash,first_name,last_name,title,office_id,role,tabs,active,must_change_pw)
                VALUES (?,?,?,?,?,?,?, 'super', ?, 1, 1)`)
      .run(uid, config.bootstrapEmail, pwHash, "Administrateur", "MEMS",
           "Responsable suivi et évaluation", null,
           JSON.stringify(["home","suivi","programme","analytics","reports","settings"]));
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
