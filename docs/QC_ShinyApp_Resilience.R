# =====================================================================================
#  PAM Madagascar — RÉSILIENCE (SAMS / FFA / VSLA / Assurance / Transformation / RRT)
#  Application R Shiny — CONTRÔLE QUALITÉ DES DONNÉES PAR AGENT, CONSCIENT DE L'ACTIVITÉ
#  Le formulaire couvre plusieurs activités par site (process_monitoring, select_multiple,
#  codes 1..9). Complétude et cohérence évaluées UNIQUEMENT sur les activités collectées.
#  Familles : (A) erreurs dures, (B) cohérence à confirmer, (C) signaux d'intégrité.
#  Sortie : ERREURS + SCORE QC PAR ENQUÊTEUR, filtrable par BUREAU et par ACTIVITÉ.
#  RAM Unit  ·  Lancement : shiny::runApp("QC_ShinyApp_Resilience.R")
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
cnt_selected <- function(x){ v<-as.character(x); v[is.na(v)]<-""; sapply(strsplit(trimws(v),"\\s+"),function(z) sum(nchar(z)>0)) }
sel <- function(x,opt) str_detect(paste0(" ",ifelse(is.na(x),"",as.character(x))," "),paste0(" ",opt," "))
read_any <- function(path,name){ ext<-tolower(tools::file_ext(name))
  if(ext %in% c("xlsx","xls")) readxl::read_excel(path,guess_max=100000)
  else readr::read_csv(path,show_col_types=FALSE,guess_max=100000,locale=locale(encoding="UTF-8")) }
agent_of <- function(d){ a<-as.character(getcol(d,"EnuName_final"))
  for(alt in c("EnuName","EnuName_oth")){ b<-as.character(getcol(d,alt)); a<-ifelse(is.na(a)|a=="",b,a) }
  ifelse(is.na(a)|a=="","(inconnu)",a) }
office_of <- function(d){ o<-as.character(getcol(d,"Field_office")); ifelse(is.na(o)|o=="","(non renseigne)",o) }
# activité présente dans la visite ? (process_monitoring, select_multiple). Colonne absente -> tout présent.
act_present <- function(d,code){ pm<-getcol(d,"process_monitoring")
  if(all(is.na(pm))) return(rep(TRUE,nrow(d))); sel(pm,code) }
ACT_LABEL <- c("1"="SAMS-PDM","2"="SAMS-Obs","3"="Magasin","4"="MDM","5"="FFA","6"="VSLA","7"="Assurance","8"="Transformation","9"="RRT")

# ============================ (A) ERREURS DURES (impossibles) ============================
dq_rules <- list(
 list(id="DQ_ffa_progress", act="5", lib="Avancement FFA > 100%", f=function(d) cz(getcol(d,"FFA_Progress"))>100),
 list(id="DQ_ffa_survival", act="5", lib="Taux de reprise pépinière > 100%", f=function(d) cz(getcol(d,"FFA_NurserySurvival"))>100),
 list(id="DQ_vsla_repay",   act="6", lib="Taux de remboursement VSLA > 100%", f=function(d) cz(getcol(d,"VSLA_LoanRepayRate"))>100),
 list(id="DQ_vsla_women",   act="6", lib="Femmes au comité > 5", f=function(d) cz(getcol(d,"VSLA_CommitteeWomen"))>5),
 list(id="DQ_ins_delay",    act="7", lib="Délai d'indemnisation > 365 jours", f=function(d) cz(getcol(d,"INS_PayoutDelayDays"))>365),
 list(id="DQ_rrt_women",    act="9", lib="Usagères femmes > usagers totaux", f=function(d) cz(getcol(d,"RRT_UsersWomen"))>cz(getcol(d,"RRT_UsersLastMonth"))),
 list(id="DQ_rrt_youth",    act="9", lib="Usagers jeunes > usagers totaux", f=function(d) cz(getcol(d,"RRT_UsersYouth"))>cz(getcol(d,"RRT_UsersLastMonth")))
)

# ================= (B) COHÉRENCE À CONFIRMER (logique inter-questions) =================
coherence_rules <- list(
 list(id="LC_ffa_done_notconform", act="5", lib="Ouvrage achevé (100%) mais non conforme aux normes",
      f=function(d) cz(getcol(d,"FFA_Progress"))==100 & cz(getcol(d,"FFA_TechConform"))==0),
 list(id="LC_ffa_particip_nowork", act="5", lib="Participants > 0 mais 0 jour de travail réalisé",
      f=function(d) (cz(getcol(d,"FFA_ParticipM"))+cz(getcol(d,"FFA_ParticipF")))>0 & cz(getcol(d,"FFA_WorkDaysActual"))==0),
 list(id="LC_ffa_nursery_noplant", act="5", lib="Pépinière mais 0 plant produit",
      f=function(d) cz(getcol(d,"FFA_AssetType"))==8 & cz(getcol(d,"FFA_NurseryPlants"))==0),
 list(id="LC_ffa_maint_noplan", act="5", lib="Entretien réalisé mais aucun plan/comité d'entretien",
      f=function(d) cz(getcol(d,"FFA_MaintDone"))==1 & cz(getcol(d,"FFA_MaintPlan"))==0),
 list(id="LC_vsla_active_nomeet", act="6", lib="Groupe fonctionnel mais 0 réunion le mois dernier",
      f=function(d) cz(getcol(d,"VSLA_Exists"))==1 & cz(getcol(d,"VSLA_MeetHeld"))==0),
 list(id="LC_vsla_loan_nosaving", act="6", lib="Prêts en cours mais épargne totale nulle",
      f=function(d) cz(getcol(d,"VSLA_LoansOut"))>0 & cz(getcol(d,"VSLA_SavingsTotal"))==0),
 list(id="LC_vsla_size", act="6", lib="Effectif hors norme VSLA (10–25 attendus)",
      f=function(d){ m<-cz(getcol(d,"VSLA_MembersM"))+cz(getcol(d,"VSLA_MembersF")); cz(getcol(d,"VSLA_Exists"))==1 & (m>25 | (m>0 & m<10))}),
 list(id="LC_ins_payout_pending", act="7", lib="Indemnisation déclenchée mais non reçue",
      f=function(d) cz(getcol(d,"INS_PayoutTriggered"))==1 & cz(getcol(d,"INS_PayoutReceived"))==0),
 list(id="LC_ins_nounderstand", act="7", lib="Inscrit mais ne comprend pas le produit",
      f=function(d) cz(getcol(d,"INS_Enrolled"))==1 & cz(getcol(d,"INS_Understand"))==0),
 list(id="LC_proc_notemp", act="8", lib="Unité fonctionnelle mais aucune maîtrise de la température",
      f=function(d) cz(getcol(d,"PROC_Functional"))==1 & cz(getcol(d,"PROC_TempControl"))==0),
 list(id="LC_proc_notrace", act="8", lib="Unité fonctionnelle sans traçabilité des lots",
      f=function(d) cz(getcol(d,"PROC_Functional"))==1 & cz(getcol(d,"PROC_Traceability"))==0),
 list(id="LC_rrt_nofunc", act="9", lib="Hub en place mais équipements solaires non fonctionnels",
      f=function(d) cz(getcol(d,"RRT_HubExists"))==1 & cz(getcol(d,"RRT_SolarFunctional"))==0),
 list(id="LC_rrt_bm_nosold", act="9", lib="Modèle économique déclaré mais aucun service vendu",
      f=function(d) cz(getcol(d,"RRT_BusinessModel"))==1 & cnt_selected(getcol(d,"RRT_ServicesSold"))==0),
 # --- Module SAMS PDM existant (code 1) : analyse logique du questionnaire ---
 list(id="LC_sams_cbt_mismatch", act="1", lib="Montant CBT reçu différent du montant attendu",
      f=function(d) cz(getcol(d,"HHAsstCBTRec"))>0 & cz(getcol(d,"HHAsstCBTExp"))>0 & cz(getcol(d,"HHAsstCBTRec"))!=cz(getcol(d,"HHAsstCBTExp"))),
 list(id="LC_sams_ent_notcomm", act="1", lib="Dû en nature reçu différent de celui communiqué",
      f=function(d) cz(getcol(d,"HHAsstEntIK"))==1 & cz(getcol(d,"HHAsstEntRcCm"))==0),
 list(id="LC_sams_equip_notfunc", act="1", lib="Équipement/infrastructure reçu mais non fonctionnel",
      f=function(d) cz(getcol(d,"HHSAMSEqFunc"))==0 &
        (sel(getcol(d,"HHSAMSNFIType"),"2")|sel(getcol(d,"HHSAMSNFIType"),"3")|sel(getcol(d,"HHSAMSNFIType"),"4"))),
 list(id="LC_sams_respect", act="1", lib="Manque de respect du personnel signalé — suivi protection",
      f=function(d) cz(getcol(d,"HHAsstRespect"))==0 & !is.na(getcol(d,"HHAsstRespect")))
)

# ================= (C) SIGNAUX D'INTÉGRITÉ (à escalader, non scorés) =================
integ_rules <- list(
 list(id="INT_fraud_concern", lib="Préoccupation de fraude/détournement signalée (SAMS)", v="HHFraudConcerns"),
 list(id="INT_diversion",     lib="Indications de détournement des vivres/intrants (SAMS)", v="HHDistDiv"),
 list(id="INT_favor_entitle", lib="Faveur/paiement exigé pour recevoir le dû (SAMS)",       v="HHAsstPayEnt"),
 list(id="INT_fees_support",  lib="Frais/paiements exigés pour l'appui SAMS",               v="HHSAMSPay"),
 list(id="INT_fees_training", lib="Paiement exigé pour participer à la formation",           v="HHSAMSTrainPay")
)

# Variables clés de complétude, avec l'activité dont elles dépendent.
KEYACT <- list(
 c("FFA_AssetType","5"),c("FFA_Progress","5"),c("FFA_TechConform","5"),c("FFA_MaintPlan","5"),c("FFA_ParticipM","5"),c("FFA_ParticipF","5"),
 c("VSLA_Exists","6"),c("VSLA_MeetFreq","6"),c("VSLA_Committee","6"),c("VSLA_LoanRepayRate","6"),c("VSLA_Passbooks","6"),
 c("INS_Enrolled","7"),c("INS_Understand","7"),c("INS_Satisfaction","7"),c("INS_Channel","7"),
 c("PROC_Functional","8"),c("PROC_TempControl","8"),c("PROC_Traceability","8"),c("PROC_HygienePersonnel","8"),
 c("RRT_HubExists","9"),c("RRT_Services","9"),c("RRT_SolarFunctional","9"),c("RRT_Management","9"),
 c("HHSAMSMode","1"),c("HHAsstRespect","1"),c("HHFraudConcerns","1"))

apply_rules <- function(d, rules, scope=TRUE){
  n<-nrow(d)
  M<-sapply(rules,function(r){ x<-tryCatch(r$f(d),error=function(e) rep(FALSE,n)); x[is.na(x)]<-FALSE; x<-as.integer(x)
    if(scope && !is.null(r$act)) x<-x*as.integer(act_present(d,r$act)); x })
  if(is.null(dim(M))) M<-matrix(M,nrow=n); colnames(M)<-sapply(rules,function(r) r$id); M }

per_submission <- function(d){
  n<-nrow(d)
  hard<-rowSums(apply_rules(d,dq_rules)); soft<-rowSums(apply_rules(d,coherence_rules))
  intM<-sapply(integ_rules,function(r) as.integer(cz(getcol(d,r$v))==1)); if(is.null(dim(intM))) intM<-matrix(intM,nrow=n); integ<-rowSums(intM)
  filled <-sapply(KEYACT,function(k){ x<-getcol(d,k[1]); as.integer(!is.na(x)&as.character(x)!="") })
  inscope<-sapply(KEYACT,function(k) as.integer(act_present(d,k[2])))
  if(is.null(dim(filled))) filled<-matrix(filled,nrow=n); if(is.null(dim(inscope))) inscope<-matrix(inscope,nrow=n)
  den<-rowSums(inscope); comp<-ifelse(den>0,round(rowSums(filled*inscope)/den*100,1),100)
  gps<-getcol(d,"HHCoord_DP"); for(alt in c("HHCoord_wh","HHCoord_DSM","HHCoord")){ g2<-getcol(d,alt); gps<-ifelse(is.na(gps)|as.character(gps)=="",g2,gps) }
  gps_ok<-as.integer(!is.na(gps)&as.character(gps)!="")
  key<-paste(agent_of(d),as.character(getcol(d,"Field_office")),as.character(getcol(d,"SvyDate")))
  dup<-as.integer(duplicated(key)|duplicated(key,fromLast=TRUE))
  # activités de la visite (liste lisible)
  acts<-sapply(1:n,function(i){ codes<-names(ACT_LABEL)[sapply(names(ACT_LABEL),function(cd) act_present(d,cd)[i])]; paste(ACT_LABEL[codes],collapse=", ") })
  data.frame(Agent=agent_of(d),Bureau=office_of(d),Activites=acts,
             Erreurs=hard,A_confirmer=soft,Integrite=integ,Completude=comp,GPS_ok=gps_ok,Doublon=dup,stringsAsFactors=FALSE)
}

agent_scorecard <- function(ps){
  ps %>% group_by(Bureau,Agent) %>% summarise(
    Soumissions=n(), Taux_erreur=round(mean(Erreurs>0)*100,1), Taux_a_confirmer=round(mean(A_confirmer>0)*100,1),
    Completude=round(mean(Completude),1), GPS_manquant=sum(GPS_ok==0), Doublons=sum(Doublon),
    Signaux_integrite=sum(Integrite>0), .groups="drop") %>%
    mutate(pattern_ok=1-(GPS_manquant+Doublons)/pmax(Soumissions,1),
      Score_QC=round(40*(1-Taux_erreur/100)+20*(1-Taux_a_confirmer/100)+30*(Completude/100)+10*pmax(0,pattern_ok)),
      Classe=ifelse(Score_QC>=85,"Bon",ifelse(Score_QC>=70,"A surveiller","A renforcer"))) %>%
    select(-pattern_ok) %>% arrange(Bureau,desc(Score_QC))
}
incidents <- function(d){ n<-nrow(d); res<-list()
  emit<-function(rules,type){ M<-apply_rules(d,rules); for(cn in colnames(M)){ fl<-M[,cn]==1
    if(any(fl)){ r<-rules[[which(sapply(rules,function(z) z$id)==cn)]]
      res[[length(res)+1]]<<-data.frame(Type=type,Controle=cn,Libelle=r$lib,Agent=agent_of(d)[fl],Bureau=office_of(d)[fl]) } } }
  emit(dq_rules,"Erreur (impossible)"); emit(coherence_rules,"A confirmer")
  for(r in integ_rules){ fl<-cz(getcol(d,r$v))==1; fl[is.na(fl)]<-FALSE
    if(any(fl)) res[[length(res)+1]]<-data.frame(Type="Integrite",Controle=r$id,Libelle=r$lib,Agent=agent_of(d)[fl],Bureau=office_of(d)[fl]) }
  if(!length(res)) return(data.frame(Type=character(),Controle=character(),Libelle=character(),Agent=character(),Bureau=character()))
  do.call(rbind,res) }
rule_counts_by_agent <- function(d,rules){ M<-apply_rules(d,rules)
  base<-data.frame(Bureau=office_of(d),Agent=agent_of(d),M,check.names=FALSE)
  agg<-aggregate(. ~ Bureau+Agent,data=base,FUN=sum); agg$Total<-rowSums(agg[,-(1:2),drop=FALSE]); agg[order(agg$Bureau,-agg$Total),] }
legend_df <- function(rules) data.frame(Controle=sapply(rules,function(r) r$id),Signification=sapply(rules,function(r) r$lib))

# performance par activité (lit les scores calculés sur l'appareil)
perf_activity <- function(d){
  mods<-list(FFA="5",VSLA="6",INS="7",PROC="8",RRT="9"); out<-list()
  for(k in names(mods)){ pres<-act_present(d,mods[[k]]); sc<-num(getcol(d,paste0(k,"_score")))
    idx<-which(pres & !is.na(sc)); if(length(idx)) out[[k]]<-data.frame(Activite=k,Bureau=office_of(d)[idx],Score=sc[idx]) }
  if(!length(out)) return(data.frame(Activite=character(),Score_moyen=numeric(),Sites=integer()))
  do.call(rbind,out) %>% group_by(Activite) %>% summarise(Sites=n(),Score_moyen=round(mean(Score),1),
    Pct_insuffisant=round(mean(Score<60)*100,1),.groups="drop")
}

# =====================================================================================
ui <- fluidPage(
  tags$head(tags$style(HTML(".brand{background:#0B5394;color:#fff;padding:14px 18px;border-radius:8px;margin-bottom:12px}
    .kpi{background:#f4f7fb;border:1px solid #dbe5f0;border-radius:8px;padding:12px;text-align:center}.kpi h2{margin:0;color:#0B5394}"))),
  div(class="brand", h3("PAM Madagascar — Résilience · Contrôle Qualité par AGENT (conscient de l'activité)"),
      span("SAMS · FFA · VSLA · Assurance · Transformation · RRT — RAM UNit")),
  sidebarLayout(
    sidebarPanel(width=3,
      fileInput("f_main","Données ODK/Kobo (CSV ou XLSX)",accept=c(".csv",".xlsx",".xls")),
      selectInput("bureau","Filtrer par bureau",choices="(tous)"),
      selectInput("activite","Filtrer par activité",choices=c("(toutes)",unname(ACT_LABEL))),
      hr(), downloadButton("dl_agents","Scorecard agents (Excel)",class="btn-primary"), br(),br(),
      downloadButton("dl_inc","Erreurs & cohérence (Excel)"),
      hr(), helpText("Complétude et cohérence évaluées seulement sur les activités collectées (process_monitoring)."),
      helpText("Score QC = 40% erreurs dures + 20% cohérence + 30% complétude + 10% bonnes pratiques.")),
    mainPanel(width=9,
      tabsetPanel(
        tabPanel("Qualité par agent", br(),
          fluidRow(column(3,div(class="kpi",h4("Agents"),h2(textOutput("k_agents")))),
                   column(3,div(class="kpi",h4("Erreurs dures"),h2(textOutput("k_err")))),
                   column(3,div(class="kpi",h4("À confirmer"),h2(textOutput("k_conf")))),
                   column(3,div(class="kpi",h4("Signaux intégrité"),h2(textOutput("k_int"))))),
          br(), plotOutput("p_agents",height=320), br(), h4("Scorecard qualité par agent"), DTOutput("t_agents")),
        tabPanel("Erreurs & cohérence", br(), DTOutput("t_inc")),
        tabPanel("Motifs à confirmer / agent", br(), DTOutput("t_motifs"), br(), h4("Légende"), DTOutput("t_legend")),
        tabPanel("Performance par activité", br(),
          helpText("Scores de performance calculés sur l'appareil, agrégés par activité."), DTOutput("t_perf")),
        tabPanel("Aide", br(), htmlOutput("help"))
      )))
)
server <- function(input,output,session){
  raw<-reactive({ req(input$f_main); read_any(input$f_main$datapath,input$f_main$name) })
  observeEvent(raw(), updateSelectInput(session,"bureau",choices=c("(tous)",sort(unique(office_of(raw()))))))
  dat<-reactive({ d<-raw(); if(input$bureau!="(tous)") d<-d[office_of(d)==input$bureau,,drop=FALSE]
    if(input$activite!="(toutes)"){ code<-names(ACT_LABEL)[ACT_LABEL==input$activite]; d<-d[act_present(d,code),,drop=FALSE] }; d })
  ps<-reactive(per_submission(dat())); sc<-reactive(agent_scorecard(ps())); inc<-reactive(incidents(dat()))
  motifs<-reactive(rule_counts_by_agent(dat(),coherence_rules))
  output$k_agents<-renderText(nrow(sc())); output$k_err<-renderText(sum(ps()$Erreurs))
  output$k_conf<-renderText(sum(ps()$A_confirmer)); output$k_int<-renderText(sum(ps()$Integrite>0))
  output$p_agents<-renderPlot({ s<-sc(); s$lab<-paste0(s$Agent," (",s$Bureau,")")
    ggplot(s,aes(reorder(lab,Score_QC),Score_QC,fill=Classe))+geom_col(width=.65)+coord_flip()+
      geom_text(aes(label=Score_QC),hjust=-0.2,size=3.4)+
      scale_fill_manual(values=c("Bon"="#27AE60","A surveiller"="#E67E22","A renforcer"="#C0392B"))+
      labs(title="Score de contrôle qualité par agent",x=NULL,y="Score QC / 100")+ylim(0,105)+
      theme_minimal(base_size=12)+theme(legend.position="top") })
  output$t_agents<-renderDT(datatable(sc(),rownames=FALSE,filter="top",options=list(pageLength=15,scrollX=TRUE)) %>%
    formatStyle("Score_QC",backgroundColor=styleInterval(c(70,85),c("#fde8e8","#fff7e6","#e8f8ee"))) %>%
    formatStyle("Signaux_integrite",color=styleInterval(0,c("black","#c0392b")),fontWeight=styleInterval(0,c("normal","bold"))))
  output$t_inc<-renderDT(datatable(inc(),rownames=FALSE,filter="top",options=list(pageLength=20)) %>%
    formatStyle("Type",fontWeight="bold",color=styleEqual(c("Erreur (impossible)","A confirmer","Integrite"),c("#c0392b","#E67E22","#8e44ad"))))
  output$t_motifs<-renderDT({ m<-motifs(); lc<-setdiff(names(m),c("Bureau","Agent","Total"))
    dt<-datatable(m,rownames=FALSE,filter="top",options=list(pageLength=15,scrollX=TRUE))
    for(cn in lc) dt<-dt %>% formatStyle(cn,backgroundColor=styleInterval(c(0,1,3),c("white","#fff3e0","#ffe0b2","#ffb74d")))
    dt %>% formatStyle("Total",fontWeight="bold",backgroundColor=styleInterval(c(0,2,5),c("white","#fff3e0","#ffcc80","#ff9800"))) })
  output$t_legend<-renderDT(datatable(legend_df(coherence_rules),rownames=FALSE,options=list(dom="t",pageLength=20)))
  output$t_perf<-renderDT(datatable(perf_activity(dat()),rownames=FALSE,options=list(dom="t")))
  output$help<-renderUI(HTML("<h4>Conscient de l'activité</h4>
    <p>Un site peut porter plusieurs activités (process_monitoring). Complétude et cohérence ne portent que sur les
    activités <b>réellement collectées</b> : un agent en visite FFA seule n'est pas pénalisé pour les variables VSLA/assurance.</p>
    <h4>Trois familles</h4><ul><li><b>Erreurs dures</b> : impossibles (ex : avancement > 100%). À corriger.</li>
    <li><b>À confirmer</b> : contradictions logiques (ex : ouvrage achevé mais non conforme ; groupe VSLA actif mais 0 réunion). À vérifier.</li>
    <li><b>Intégrité</b> : fraude/détournement. À escalader (CFM/anti-fraude) ; ne baisse pas le score QC.</li></ul>
    <p><b>Score QC</b> = 40% (1-erreurs dures) + 20% (1-à confirmer) + 30% complétude + 10% bonnes pratiques. Bon ≥85 · À surveiller 70-84 · À renforcer <70.</p>"))
  output$dl_agents<-downloadHandler(filename=function() paste0("Scorecard_Agents_Resilience_",Sys.Date(),".xlsx"),
    content=function(file){ wb<-createWorkbook()
      addWorksheet(wb,"Scorecard_agents"); writeData(wb,"Scorecard_agents",sc())
      addWorksheet(wb,"Par_soumission"); writeData(wb,"Par_soumission",ps())
      addWorksheet(wb,"Motifs_a_confirmer"); writeData(wb,"Motifs_a_confirmer",motifs())
      addWorksheet(wb,"Performance_activite"); writeData(wb,"Performance_activite",perf_activity(dat()))
      addStyle(wb,"Scorecard_agents",createStyle(fgFill="#0B5394",fontColour="white",textDecoration="bold"),rows=1,cols=1:ncol(sc()),gridExpand=TRUE)
      saveWorkbook(wb,file,overwrite=TRUE) })
  output$dl_inc<-downloadHandler(filename=function() paste0("Erreurs_Coherence_Resilience_",Sys.Date(),".xlsx"),
    content=function(file){ wb<-createWorkbook(); addWorksheet(wb,"Incidents"); writeData(wb,"Incidents",inc()); saveWorkbook(wb,file,overwrite=TRUE) })
}
shinyApp(ui,server)
