# =====================================================================================
#  PAM Madagascar — PECMAM · CONTRÔLE QUALITÉ DÉTAILLÉ (v3, scoring)
#  Suivi de processus des sites CRENAM + FARNE. Approche centrée PB/MUAC (toise non requise).
#  - Lit les scores calculés sur l'appareil : score_total, score_couleur, score_farne,
#    et les 8 domaines (anthropométrie PB, admission, sortie, ration, registre, stock,
#    organisation, SBCC) pour une analyse par domaine.
#  - 3 familles de contrôles : (A) erreurs dures, (B) cohérence protocole/magasin/FARNE,
#    (C) signaux d'intégrité. Scorecard par agent, filtrable par bureau.
#  RAM Unit  ·  Lancement : shiny::runApp("QC_ShinyApp_PECMAM_detaille.R")
# =====================================================================================

pkgs <- c("shiny","DT","readxl","readr","dplyr","tidyr","stringr","ggplot2","openxlsx")
new  <- pkgs[!(pkgs %in% installed.packages()[,"Package"])]
if(length(new)) install.packages(new, repos="https://cloud.r-project.org")
invisible(lapply(pkgs, require, character.only=TRUE))

# ----------------------- Utilitaires -----------------------
getcol <- function(df,name){ nm<-names(df); h<-which(nm==name)
  if(length(h)) return(df[[h[1]]]); h<-which(str_detect(nm,paste0("(^|[/_])",name,"$")))
  if(length(h)) return(df[[h[1]]]); rep(NA,nrow(df)) }
num <- function(x) suppressWarnings(as.numeric(as.character(x)))
cz  <- function(x){ v<-num(x); ifelse(is.na(v),0,v) }
read_any <- function(path,name){ ext<-tolower(tools::file_ext(name))
  if(ext %in% c("xlsx","xls")) readxl::read_excel(path,guess_max=100000)
  else readr::read_csv(path,show_col_types=FALSE,guess_max=100000,locale=locale(encoding="UTF-8")) }
agent_of <- function(d){ a<-as.character(getcol(d,"EnuName")); b<-as.character(getcol(d,"EnuName_Other"))
  a<-ifelse(is.na(a)|a==""|a=="9999",b,a); ifelse(is.na(a)|a=="","(inconnu)",a) }
office_of <- function(d){ o<-as.character(getcol(d,"Field_office")); ifelse(is.na(o)|o=="","(non renseigne)",o) }
site_of <- function(d){ s<-as.character(getcol(d,"Adm4Code_MAM")); s2<-as.character(getcol(d,"Adm3Code_MAM"))
  s<-ifelse(is.na(s)|s=="",s2,s); ifelse(is.na(s)|s=="","(site ?)",s) }
# "répond Non" pour un select_one Yesno (0=Non), en ignorant les non-renseignés
no <- function(d,v){ x<-getcol(d,v); cz(x)==0 & !is.na(x) & as.character(x)!="" }
yes <- function(d,v){ x<-getcol(d,v); cz(x)==1 }

# ============================ (A) ERREURS DURES (impossibles) ============================
dq_rules <- list(
 list(id="DQ_adm_wrong_gt", lib="Cas d'admission incorrects > cas échantillonnés",
      f=function(d) cz(getcol(d,"MOAdmCritNumWrong"))>cz(getcol(d,"MOAdmCritNum"))),
 list(id="DQ_adm_pct", lib="Proportion d'admissions non conformes > 100%", f=function(d) cz(getcol(d,"MOAdmPerc"))>100),
 list(id="DQ_disch_met_gt", lib="Sorties non conformes > sorties échantillonnées",
      f=function(d) cz(getcol(d,"MODischCritMet"))>cz(getcol(d,"MODischCritDenom"))),
 list(id="DQ_disch_pct", lib="Proportion de sorties non conformes > 100%", f=function(d) cz(getcol(d,"MODischCritCalc"))>100),
 list(id="DQ_present_gt_reg", lib="Bénéficiaires présents > enregistrés",
      f=function(d) cz(getcol(d,"MODBenefPresnb"))>cz(getcol(d,"MODRegBenefnb")) & cz(getcol(d,"MODRegBenefnb"))>0),
 list(id="DQ_stock_neg", lib="Stock de clôture réel négatif", f=function(d) cz(getcol(d,"MOActualBalance"))<0),
 list(id="DQ_farne_present_gt", lib="Enfants FARNE présents > inscrits",
      f=function(d) cz(getcol(d,"FARNE_ChildrenPresent"))>cz(getcol(d,"FARNE_ChildrenEnrolled")) & cz(getcol(d,"FARNE_ChildrenEnrolled"))>0)
)

# ================= (B) COHÉRENCE À CONFIRMER (protocole / magasin / FARNE) =================
coherence_rules <- list(
 # --- Anthropométrie PB / dépistage ---
 list(id="LC_muac_tech", act="Anthropométrie", lib="Technique de prise du PB non respectée", f=function(d) no(d,"MOMUACMeas")),
 list(id="LC_muac_notreg", act="Anthropométrie", lib="Données de PB non reportées sur la fiche", f=function(d) no(d,"MUACReg")),
 list(id="LC_oedema_nocheck", act="Anthropométrie", lib="Œdèmes non contrôlés (risque de MAS non détectée)", f=function(d) no(d,"MOOedamaCheck")),
 list(id="LC_scale_notfunc", act="Anthropométrie", lib="Balance non fonctionnelle", f=function(d) no(d,"MOScaleFunctional")),
 # --- Admission / sortie / référence ---
 list(id="LC_adm_notadhered", act="Admission", lib="Critères d'admission non respectés", f=function(d) no(d,"MOAdmCritAdhered")),
 list(id="LC_admcrit_notposted", act="Admission", lib="Critères d'admission non affichés sur le site", f=function(d) no(d,"MOAdminAff")),
 list(id="LC_sam_notref", act="Admission", lib="Arrivants MAS non systématiquement référés", f=function(d) no(d,"MOMalArrRef")),
 list(id="LC_disch_notadhered", act="Sortie", lib="Critères de sortie non respectés (PB ≥125 mm × 2)", f=function(d) no(d,"MODischCrit")),
 list(id="LC_reg_mismatch", act="Registre", lib="Écart registre/présents > 10%",
      f=function(d){ reg<-cz(getcol(d,"MODRegBenefnb")); pres<-cz(getcol(d,"MODBenefPresnb")); reg>0 & abs(pres-reg)/reg*100>10 }),
 # --- Ration ---
 list(id="LC_ration_no", act="Ration", lib="Ration non respectée", f=function(d) no(d,"MORation")),
 list(id="LC_ration_qty", act="Ration", lib="Nombre de sachets non conforme (LQ≠15 / MQ≠30)",
      f=function(d){ lq<-cz(getcol(d,"RCNBInkindLQ")); mq<-cz(getcol(d,"RCNBInkindMQ")); (lq>0 & lq!=15)|(mq>0 & mq!=30) }),
 # --- Magasin / traçabilité (FEFO) ---
 list(id="LC_stock_diff", act="Stock", lib="Écart de stock (théorique vs réel) > 5", f=function(d) abs(cz(getcol(d,"MOFoodBalanceDiff")))>5),
 list(id="LC_stockcard_missing", act="Stock", lib="Fiches de lots absentes/incomplètes", f=function(d) no(d,"MOWhStockCard")),
 list(id="LC_fefo_notsep", act="Stock", lib="Piles non séparées par date de péremption (FEFO)", f=function(d) no(d,"MOWhBatchBBD")),
 list(id="LC_damaged_notisol", act="Stock", lib="Vivres endommagés non isolés", f=function(d) yes(d,"MOWHBadCommod") & no(d,"MOWHBadCommodIsol")),
 list(id="LC_notlocked", act="Stock", lib="Magasin non fermé à clé", f=function(d) no(d,"MOStorageLocked")),
 list(id="LC_nfi_withfood", act="Stock", lib="Articles non alimentaires stockés avec les vivres", f=function(d) yes(d,"MONFIwithFood")),
 list(id="LC_noreg_insp", act="Stock", lib="Pas d'inspection régulière du stock", f=function(d) no(d,"MOWhRegInsp")),
 # --- FARNE ---
 list(id="LC_farne_meal_norecipe", act="FARNE", lib="Repas préparé mais pas de recette locale", f=function(d) yes(d,"FARNE_Meal") & no(d,"FARNE_LocalRecipe")),
 list(id="LC_farne_noeveil", act="FARNE", lib="Site FARNE sans activités d'éveil", f=function(d) yes(d,"FARNE_Site") & no(d,"FARNE_Eveil"))
)

# ================= (C) SIGNAUX D'INTÉGRITÉ / SAUVEGARDES (à escalader) =================
integ_rules <- list(
 list(id="INT_damage_notreported", lib="Dommages/pertes non signalés au PAM", f=function(d) no(d,"MOWhAllDamageRep")),
 list(id="INT_wh_otheruse", lib="Entrepôt non réservé aux vivres PAM (risque de détournement)", f=function(d) no(d,"MOWhOtherUse")),
 list(id="INT_stock_nomovement", lib="Aucun enregistrement des mouvements de stock", f=function(d) no(d,"MOStockMovementRecord")),
 list(id="INT_waybill_notreflect", lib="Dommages/pertes non reflétés sur les waybills", f=function(d) no(d,"MOWhWayBillRep"))
)

# Domaines de performance (scores calculés sur l'appareil) + poids max
PILLARS <- c(score_anthro=14, score_admission=15, score_sortie=12, score_ration=12,
             score_registre=13, score_stock=12, score_organisation=12, score_sbcc=10)
PILLAB  <- c(score_anthro="Anthropométrie PB", score_admission="Admission", score_sortie="Sortie",
             score_ration="Ration", score_registre="Registre", score_stock="Stock/traçabilité",
             score_organisation="Organisation", score_sbcc="SBCC")

KEY <- c("MODRegBenefnb","MODBenefPresnb","MOAdmCritAdhered","MODischCrit","MOMUACMeas","MUACReg",
         "MOOedamaCheck","MOMalArrRef","MORation","RCInkind","SBNutEduPres","MOFoodStored","MOWhStockCard","MOWhBatchBBD")

apply_rules <- function(d, rules){ n<-nrow(d)
  M<-sapply(rules,function(r){ x<-tryCatch(r$f(d),error=function(e) rep(FALSE,n)); x[is.na(x)]<-FALSE; as.integer(x) })
  if(is.null(dim(M))) M<-matrix(M,nrow=n); colnames(M)<-sapply(rules,function(r) r$id); M }

per_submission <- function(d){ n<-nrow(d)
  hard<-rowSums(apply_rules(d,dq_rules)); soft<-rowSums(apply_rules(d,coherence_rules)); integ<-rowSums(apply_rules(d,integ_rules))
  filled<-sapply(KEY,function(k){ x<-getcol(d,k); as.integer(!is.na(x)&as.character(x)!="") })
  if(is.null(dim(filled))) filled<-matrix(filled,nrow=n); comp<-round(rowSums(filled)/length(KEY)*100,1)
  photo<-as.integer(!is.na(getcol(d,"MODRegPho"))&as.character(getcol(d,"MODRegPho"))!="")
  key<-paste(site_of(d),as.character(getcol(d,"SvyDate"))); dup<-as.integer(duplicated(key)|duplicated(key,fromLast=TRUE))
  data.frame(Agent=agent_of(d),Bureau=office_of(d),Site=site_of(d),Erreurs=hard,A_confirmer=soft,Integrite=integ,
             Completude=comp,Photo_registre=photo,Doublon=dup,
             Score_site=cz(getcol(d,"score_total")),Classe_site=as.character(getcol(d,"score_couleur")),
             Score_FARNE=cz(getcol(d,"score_farne")),stringsAsFactors=FALSE)
}
agent_scorecard <- function(ps){
  ps %>% group_by(Bureau,Agent) %>% summarise(
    Visites=n(), Taux_erreur=round(mean(Erreurs>0)*100,1), Taux_a_confirmer=round(mean(A_confirmer>0)*100,1),
    Completude=round(mean(Completude),1), Photos_manquantes=sum(Photo_registre==0), Doublons=sum(Doublon),
    Signaux_integrite=sum(Integrite>0), Score_site_moyen=round(mean(Score_site),1), .groups="drop") %>%
    mutate(bp=1-(Photos_manquantes+Doublons)/pmax(Visites,1),
      Score_QC=round(40*(1-Taux_erreur/100)+20*(1-Taux_a_confirmer/100)+30*(Completude/100)+10*pmax(0,bp)),
      Classe=ifelse(Score_QC>=85,"Bon",ifelse(Score_QC>=70,"A surveiller","A renforcer"))) %>%
    select(-bp) %>% arrange(Bureau,desc(Score_QC))
}
incidents <- function(d){ res<-list()
  emit<-function(rules,type){ M<-apply_rules(d,rules); for(cn in colnames(M)){ fl<-M[,cn]==1
    if(any(fl)){ r<-rules[[which(sapply(rules,function(z) z$id)==cn)]]
      res[[length(res)+1]]<<-data.frame(Type=type,Domaine=ifelse(is.null(r$act),"—",r$act),Controle=cn,Libelle=r$lib,
        Agent=agent_of(d)[fl],Bureau=office_of(d)[fl],Site=site_of(d)[fl]) } } }
  emit(dq_rules,"Erreur (impossible)"); emit(coherence_rules,"A confirmer"); emit(integ_rules,"Integrite")
  if(!length(res)) return(data.frame(Type=character(),Domaine=character(),Controle=character(),Libelle=character(),Agent=character(),Bureau=character(),Site=character()))
  do.call(rbind,res) }
rule_counts_by_agent <- function(d,rules){ M<-apply_rules(d,rules)
  base<-data.frame(Bureau=office_of(d),Agent=agent_of(d),M,check.names=FALSE)
  agg<-aggregate(. ~ Bureau+Agent,data=base,FUN=sum); agg$Total<-rowSums(agg[,-(1:2),drop=FALSE]); agg[order(agg$Bureau,-agg$Total),] }
legend_df <- function(rules) data.frame(Controle=sapply(rules,function(r) r$id),
  Domaine=sapply(rules,function(r) ifelse(is.null(r$act),"—",r$act)), Signification=sapply(rules,function(r) r$lib))
domain_perf <- function(d){ out<-lapply(names(PILLARS),function(p){ v<-num(getcol(d,p))
  data.frame(Domaine=PILLAB[[p]], Max=PILLARS[[p]], Moyen=round(mean(v,na.rm=TRUE),1),
             Pct=round(mean(v,na.rm=TRUE)/PILLARS[[p]]*100,0)) }); do.call(rbind,out) }
site_perf <- function(ps){ ps %>% group_by(Bureau,Site) %>%
  summarise(Visites=n(),Score_site=round(mean(Score_site),1),FARNE=round(mean(Score_FARNE),1),
    Pct_faible=round(mean(Score_site<60)*100,1),.groups="drop") %>% arrange(Score_site) }

# =====================================================================================
ui <- fluidPage(
  tags$head(tags$style(HTML(".brand{background:#1B7A43;color:#fff;padding:14px 18px;border-radius:8px;margin-bottom:12px}
    .kpi{background:#f2f8f4;border:1px solid #cfe6d8;border-radius:8px;padding:12px;text-align:center}.kpi h2{margin:0;color:#1B7A43}"))),
  div(class="brand", h3("PAM Madagascar — PECMAM · Contrôle Qualité DÉTAILLÉ (scoring refait)"),
      span("CRENAM + FARNE — anthropométrie PB · admission/sortie · ration · magasin/FEFO · SBCC — RAM Unit")),
  sidebarLayout(
    sidebarPanel(width=3,
      fileInput("f_main","Données ODK/Kobo (CSV ou XLSX)",accept=c(".csv",".xlsx",".xls")),
      selectInput("bureau","Filtrer par bureau",choices="(tous)"),
      hr(), downloadButton("dl_agents","Scorecard + domaines (Excel)",class="btn-success"), br(),br(),
      downloadButton("dl_inc","Incidents détaillés (Excel)"),
      hr(), helpText("Approche PB/MUAC : la toise n'est pas requise."),
      helpText("Score QC = 40% erreurs + 20% cohérence + 30% complétude + 10% bonnes pratiques.")),
    mainPanel(width=9,
      tabsetPanel(
        tabPanel("Qualité par agent", br(),
          fluidRow(column(3,div(class="kpi",h4("Agents"),h2(textOutput("k_agents")))),
                   column(3,div(class="kpi",h4("Erreurs dures"),h2(textOutput("k_err")))),
                   column(3,div(class="kpi",h4("À confirmer"),h2(textOutput("k_conf")))),
                   column(3,div(class="kpi",h4("Signaux intégrité"),h2(textOutput("k_int"))))),
          br(), plotOutput("p_agents",height=320), br(), h4("Scorecard qualité par agent"), DTOutput("t_agents")),
        tabPanel("Incidents détaillés", br(), helpText("Type · domaine · contrôle · agent · site."), DTOutput("t_inc")),
        tabPanel("Motifs à confirmer / agent", br(), DTOutput("t_motifs"), br(), h4("Légende des contrôles"), DTOutput("t_legend")),
        tabPanel("Performance par domaine", br(),
          helpText("Score moyen par domaine (calculé sur l'appareil) vs maximum possible."),
          plotOutput("p_domain",height=320), br(), DTOutput("t_domain")),
        tabPanel("Sites & FARNE", br(), plotOutput("p_sites",height=300), br(), DTOutput("t_sites")),
        tabPanel("Aide", br(), htmlOutput("help"))
      )))
)
server <- function(input,output,session){
  raw<-reactive({ req(input$f_main); read_any(input$f_main$datapath,input$f_main$name) })
  observeEvent(raw(), updateSelectInput(session,"bureau",choices=c("(tous)",sort(unique(office_of(raw()))))))
  dat<-reactive({ d<-raw(); if(input$bureau!="(tous)") d<-d[office_of(d)==input$bureau,,drop=FALSE]; d })
  ps<-reactive(per_submission(dat())); sc<-reactive(agent_scorecard(ps())); inc<-reactive(incidents(dat()))
  motifs<-reactive(rule_counts_by_agent(dat(),coherence_rules))
  output$k_agents<-renderText(nrow(sc())); output$k_err<-renderText(sum(ps()$Erreurs))
  output$k_conf<-renderText(sum(ps()$A_confirmer)); output$k_int<-renderText(sum(ps()$Integrite>0))
  output$p_agents<-renderPlot({ s<-sc(); s$lab<-paste0(s$Agent," (",s$Bureau,")")
    ggplot(s,aes(reorder(lab,Score_QC),Score_QC,fill=Classe))+geom_col(width=.65)+coord_flip()+
      geom_text(aes(label=Score_QC),hjust=-0.2,size=3.4)+
      scale_fill_manual(values=c("Bon"="#1B7A43","A surveiller"="#E67E22","A renforcer"="#C0392B"))+
      labs(title="Score de contrôle qualité par agent",x=NULL,y="Score QC / 100")+ylim(0,105)+
      theme_minimal(base_size=12)+theme(legend.position="top") })
  output$t_agents<-renderDT(datatable(sc(),rownames=FALSE,filter="top",options=list(pageLength=15,scrollX=TRUE)) %>%
    formatStyle("Score_QC",backgroundColor=styleInterval(c(70,85),c("#fde8e8","#fff7e6","#e8f8ee"))) %>%
    formatStyle("Signaux_integrite",color=styleInterval(0,c("black","#c0392b")),fontWeight=styleInterval(0,c("normal","bold"))))
  output$t_inc<-renderDT(datatable(inc(),rownames=FALSE,filter="top",options=list(pageLength=20,scrollX=TRUE)) %>%
    formatStyle("Type",fontWeight="bold",color=styleEqual(c("Erreur (impossible)","A confirmer","Integrite"),c("#c0392b","#E67E22","#8e44ad"))))
  output$t_motifs<-renderDT({ m<-motifs(); lc<-setdiff(names(m),c("Bureau","Agent","Total"))
    dt<-datatable(m,rownames=FALSE,filter="top",options=list(pageLength=15,scrollX=TRUE))
    for(cn in lc) dt<-dt %>% formatStyle(cn,backgroundColor=styleInterval(c(0,1,3),c("white","#fff3e0","#ffe0b2","#ffb74d")))
    dt %>% formatStyle("Total",fontWeight="bold") })
  output$t_legend<-renderDT(datatable(rbind(cbind(Famille="Erreur",legend_df(dq_rules)),
    cbind(Famille="À confirmer",legend_df(coherence_rules)),cbind(Famille="Intégrité",legend_df(integ_rules))),
    rownames=FALSE,filter="top",options=list(pageLength=40,scrollX=TRUE)))
  output$p_domain<-renderPlot({ dp<-domain_perf(dat())
    ggplot(dp,aes(reorder(Domaine,Pct),Pct,fill=Pct))+geom_col()+coord_flip()+
      geom_text(aes(label=paste0(Pct,"%")),hjust=-0.15,size=3.4)+
      scale_fill_gradient2(low="#C0392B",mid="#E67E22",high="#1B7A43",midpoint=60)+
      labs(title="Atteinte moyenne par domaine (% du maximum)",x=NULL,y="% du score maximal")+ylim(0,110)+
      theme_minimal(base_size=12)+theme(legend.position="none") })
  output$t_domain<-renderDT(datatable(domain_perf(dat()),rownames=FALSE,options=list(dom="t",pageLength=10)))
  output$p_sites<-renderPlot({ sp<-site_perf(ps()) %>% head(15)
    ggplot(sp,aes(reorder(Site,Score_site),Score_site,fill=Score_site))+geom_col()+coord_flip()+
      geom_text(aes(label=Score_site),hjust=-0.2,size=3.2)+
      scale_fill_gradient2(low="#C0392B",mid="#E67E22",high="#1B7A43",midpoint=60)+
      labs(title="Score de site (les 15 plus faibles)",x=NULL,y="score_total / 100")+ylim(0,105)+
      theme_minimal(base_size=12)+theme(legend.position="none") })
  output$t_sites<-renderDT(datatable(site_perf(ps()),rownames=FALSE,filter="top",options=list(pageLength=15)))
  output$help<-renderUI(HTML("<h4>Centré PB/MUAC (toise non requise)</h4>
    <p>La performance repose sur les <b>critères PB</b> d'admission (&lt;125 mm) et de sortie (≥125 mm × 2), la technique de prise du PB et le contrôle des œdèmes.</p>
    <h4>Trois familles de contrôles</h4><ul>
    <li><b>Erreurs dures</b> (7) : valeurs impossibles. À corriger.</li>
    <li><b>À confirmer</b> (20) : entorses au protocole/magasin/FARNE (critères non respectés, MAS non référé, œdème non contrôlé, ration non conforme, FEFO, vivres endommagés non isolés, FARNE sans éveil…). À vérifier.</li>
    <li><b>Intégrité</b> (4) : dommages non signalés, entrepôt détourné, mouvements de stock non tracés, waybills non reflétés. À escalader (CFM) — n'affecte pas le score de l'agent.</li></ul>
    <p><b>Performance par domaine</b> : lit les 8 scores calculés sur l'appareil (anthropométrie PB, admission, sortie, ration, registre, stock, organisation, SBCC) pour cibler les faiblesses. Le <b>score FARNE</b> est suivi à part.</p>
    <p><b>Score QC agent</b> = 40% (1-erreurs) + 20% (1-à confirmer) + 30% complétude + 10% bonnes pratiques. Bon ≥85 · À surveiller 70-84 · À renforcer &lt;70.</p>"))
  output$dl_agents<-downloadHandler(filename=function() paste0("QC_PECMAM_Agents_Domaines_",Sys.Date(),".xlsx"),
    content=function(file){ wb<-createWorkbook()
      addWorksheet(wb,"Scorecard_agents"); writeData(wb,"Scorecard_agents",sc())
      addWorksheet(wb,"Par_visite"); writeData(wb,"Par_visite",ps())
      addWorksheet(wb,"Performance_domaine"); writeData(wb,"Performance_domaine",domain_perf(dat()))
      addWorksheet(wb,"Performance_sites"); writeData(wb,"Performance_sites",site_perf(ps()))
      addWorksheet(wb,"Motifs_a_confirmer"); writeData(wb,"Motifs_a_confirmer",motifs())
      addStyle(wb,"Scorecard_agents",createStyle(fgFill="#1B7A43",fontColour="white",textDecoration="bold"),rows=1,cols=1:ncol(sc()),gridExpand=TRUE)
      saveWorkbook(wb,file,overwrite=TRUE) })
  output$dl_inc<-downloadHandler(filename=function() paste0("QC_PECMAM_Incidents_",Sys.Date(),".xlsx"),
    content=function(file){ wb<-createWorkbook(); addWorksheet(wb,"Incidents"); writeData(wb,"Incidents",inc())
      addWorksheet(wb,"Legende"); writeData(wb,"Legende",rbind(cbind(Famille="Erreur",legend_df(dq_rules)),
        cbind(Famille="À confirmer",legend_df(coherence_rules)),cbind(Famille="Intégrité",legend_df(integ_rules))))
      saveWorkbook(wb,file,overwrite=TRUE) })
}
shinyApp(ui,server)
