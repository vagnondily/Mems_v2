# =====================================================================================
#  PAM Madagascar — Cantines Scolaires (MDG SMP 2025-2026, version Cadre Logique v4)
#  Application R Shiny — CONTRÔLE QUALITÉ DES DONNÉES PAR AGENT (conscient du module)
#  Prend en compte le TYPE DE VISITE (SBPSiteSvyType) : une soumission ne couvre que
#  les modules collectes (1=directeur, 2=eleves, 3=enseignants, 4=cuisiniers, 5=observation).
#    -> completude et coherence evaluees UNIQUEMENT sur les modules presents,
#    -> distinction visite COMPLETE (dir+obs) vs PARTIELLE.
#  Familles de controles : (A) erreurs dures, (B) coherence a confirmer, (C) integrite.
#  RAM Unit  ·   Lancement : shiny::runApp("QC_ShinyApp_SMP.R")
# =====================================================================================

pkgs <- c("shiny","DT","readxl","readr","dplyr","tidyr","stringr","ggplot2","openxlsx")
new  <- pkgs[!(pkgs %in% installed.packages()[,"Package"])]
if(length(new)) install.packages(new, repos = "https://cloud.r-project.org")
invisible(lapply(pkgs, require, character.only = TRUE))

# ----------------------- Utilitaires -----------------------
getcol <- function(df, name){
  nm <- names(df); hit <- which(nm == name)
  if(length(hit)) return(df[[hit[1]]])
  hit <- which(str_detect(nm, paste0("(^|[/_])", name, "$")))
  if(length(hit)) return(df[[hit[1]]]); rep(NA, nrow(df))
}
num  <- function(x) suppressWarnings(as.numeric(as.character(x)))
cz   <- function(x){ v <- num(x); ifelse(is.na(v), 0, v) }
cnt_selected <- function(x){ v<-as.character(x); v[is.na(v)]<-""; sapply(strsplit(trimws(v),"\\s+"), function(z) sum(nchar(z)>0)) }
sel  <- function(x, opt) str_detect(paste0(" ", ifelse(is.na(x),"",as.character(x)), " "), paste0(" ", opt, " "))
read_any <- function(path, name){
  ext <- tolower(tools::file_ext(name))
  if(ext %in% c("xlsx","xls")) readxl::read_excel(path, guess_max=100000)
  else readr::read_csv(path, show_col_types=FALSE, guess_max=100000, locale=locale(encoding="UTF-8"))
}
agent_of  <- function(d){ a<-as.character(getcol(d,"EnuName")); ao<-as.character(getcol(d,"EnuName_oth"))
  a<-ifelse(is.na(a)|a=="",ao,a); ifelse(is.na(a)|a=="","(inconnu)",a) }
office_of <- function(d){ o<-as.character(getcol(d,"Field_office")); ifelse(is.na(o)|o=="","(non renseigne)",o) }
# Module present dans la visite ? (SBPSiteSvyType = liste des modules collectes).
# Si la colonne n'existe pas dans l'export -> on considere tous les modules presents.
mod_present <- function(d, code){ sv<-getcol(d,"SBPSiteSvyType")
  if(all(is.na(sv))) return(rep(TRUE, nrow(d))); sel(sv, code) }

# ============================ (A) ERREURS DURES (impossibles) ============================
dq_rules <- list(
 list(id="DQ1_meals_gt20", mod="1", lib="Jours de repas servis > 20/20",
      f=function(d) cz(getcol(d,"DIRNBSchMealsProvided"))>20 & cz(getcol(d,"DIRNBSchMealsProvided"))!=888),
 list(id="DQ2_absent_gt_enrol", mod="1", lib="Total absents > effectif inscrit",
      f=function(d)(cz(getcol(d,"DIRAttendAbsentM"))+cz(getcol(d,"DIRAttendAbsentF")))>(cz(getcol(d,"DIRNbEnrChildM"))+cz(getcol(d,"DIRNbEnrChildF")))),
 list(id="DQ3_disab_gt_enrol", mod="1", lib="Eleves handicapes > effectif inscrit",
      f=function(d)(cz(getcol(d,"DIRNBDisabChildrenM"))+cz(getcol(d,"DIRNBDisabChildrenF")))>(cz(getcol(d,"DIRNbEnrChildM"))+cz(getcol(d,"DIRNbEnrChildF")))),
 list(id="DQ8_foyer_gt_total", mod="5", lib="Foyers bon etat > total",
      f=function(d) cz(getcol(d,"G_FoyerGood"))>cz(getcol(d,"G_FoyerNb"))),
 list(id="DQ9_deworm_gt_enrol", mod="1", lib="Enfants deparasites > effectif inscrit",
      f=function(d) cz(getcol(d,"G_DewormCount"))>(cz(getcol(d,"DIRNbEnrChildM"))+cz(getcol(d,"DIRNbEnrChildF")))),
 list(id="DQ10_days_gt31", mod="1", lib="Jours diversifies > 31",
      f=function(d) cz(getcol(d,"G_DaysDiverse"))>31),
 list(id="DQ12_ration_no_bal", mod="5", lib="Ration non conforme ET sans balance",
      f=function(d) cz(getcol(d,"G_RationConform"))==0 & cz(getcol(d,"G_BalanceUsed"))==0)
)

# ================= (B) COHÉRENCE À CONFIRMER (logique inter-questions) =================
coherence_rules <- list(
 list(id="LC1_cook_no_kitchen", mod="5", lib="Pas de cuisine sur site mais repas prepare/distribue observe",
      f=function(d) cz(getcol(d,"MOFoodPrepOnsite"))==0 & (cz(getcol(d,"MOFoodDistrObs"))==1 | cz(getcol(d,"MOCookedOnsiteVisit"))==1)),
 list(id="LC2_distrib_no_groups", mod="5", lib="Distribution observee mais aucun groupe alimentaire",
      f=function(d) cz(getcol(d,"MOFoodDistrObs"))==1 & cnt_selected(getcol(d,"MealFoodGroups"))==0),
 list(id="LC3_cook_no_distrib", mod="5", lib="Preparation observee mais aucune distribution observee",
      f=function(d) cz(getcol(d,"MOCookedOnsiteVisit"))==1 & cz(getcol(d,"MOFoodDistrObs"))==0),
 list(id="LC4_ration_no_scale", mod="5", lib="Ration conforme mais balance non utilisee",
      f=function(d) cz(getcol(d,"G_RationConform"))==1 & cz(getcol(d,"G_BalanceUsed"))==0),
 list(id="LC5_nostore_but_moves", mod="1", lib="Stock absent mais quantites recues/distribuees > 0",
      f=function(d) cz(getcol(d,"MOFoodStored"))==0 & (cz(getcol(d,"MOComReceived"))>0 | cz(getcol(d,"MOComDistributed"))>0)),
 list(id="LC6_nocommittee_but_roles", mod="1", lib="Comite absent mais des roles CLG renseignes",
      f=function(d) cz(getcol(d,"MOPTAMgmt"))==0 & cnt_selected(getcol(d,"G_CLGRoles"))>0),
 list(id="LC7_waterfunc_no_source", mod="5", lib="Source d'eau fonctionnelle mais aucune source listee",
      f=function(d) cz(getcol(d,"G_WaterFunctional"))==1 & cnt_selected(getcol(d,"G_WaterSource"))==0),
 list(id="LC8_potwater_but_nowater", mod="5", lib="Eau potable pour cuisson mais eau 'pas disponible'",
      f=function(d) cz(getcol(d,"MOPotWaterAvailable"))==1 & cz(getcol(d,"MOWaterCook"))==0),
 list(id="LC9_local_no_volume", mod="1", lib="Source locale (HGSF) mais volume ET fournisseurs = 0",
      f=function(d) sel(getcol(d,"DIRFoodSrc"),"1") & cz(getcol(d,"G_LocalVolume"))==0 & cz(getcol(d,"G_NbSuppliers"))==0),
 list(id="LC10_ration_low_diversity", mod="5", lib="Ration conforme mais < 2 groupes alimentaires observes",
      f=function(d) cz(getcol(d,"G_RationConform"))==1 & cz(getcol(d,"MOFoodDistrObs"))==1 & cnt_selected(getcol(d,"MealFoodGroups"))<2),
 list(id="LC11_meals_no_source", mod="1", lib="Jours de repas > 0 mais aucune source de nourriture",
      f=function(d) cz(getcol(d,"DIRNBSchMealsProvided"))>0 & cz(getcol(d,"DIRNBSchMealsProvided"))!=888 & cnt_selected(getcol(d,"DIRFoodSrc"))==0),
 list(id="LC12_wash_no_water", mod="5", lib="Enfants se lavent les mains mais eau potable non disponible",
      f=function(d) cz(getcol(d,"MOChildWashHands"))==1 & cz(getcol(d,"MOPotWaterAvailable"))==0)
)

# ================= (C) SIGNAUX D'INTÉGRITÉ (module observation, non scorés) =================
integ_rules <- list(
 list(id="INT_diversion", lib="Signes de detournement observes", v="G_DivSigns"),
 list(id="INT_resale",    lib="Vente de vivres PAM signalee",     v="G_FoodResale"),
 list(id="INT_ghost",     lib="Beneficiaires possiblement fictifs", v="G_GhostBenef"),
 list(id="INT_records",   lib="Registres alteres/antidates",      v="G_RecordsAltered"),
 list(id="INT_collusion", lib="Collusion fournisseur/prix gonfles", v="G_SupplierCollusion"),
 list(id="INT_fees",      lib="Frais/contributions coercitifs",   v="G_CoercedFees"),
 list(id="INT_favor",     lib="Faveurs exigees (risque EAS/SEA)", v="G_ExchangeFavor")
)

# Variables cles de completude, avec le module dont elles dependent.
KEYMOD <- list(
 c("DIRNbEnrChildM","1"),c("DIRNbEnrChildF","1"),c("DIRNBSchMealsProvided","1"),c("MOPTAMgmt","1"),
 c("DIRCooksRecTraining","1"),c("MOFoodStored","1"),c("G_CLGRoles","1"),c("G_FIFO","1"),c("DIRFoodSrc","1"),
 c("MOFoodDistrObs","5"),c("MealFoodGroups","5"),c("MOFoodPrepAgr","5"),c("MOLatrines","5"),
 c("G_RationConform","5"),c("G_MealTime","5"),c("G_BalanceUsed","5"),c("G_WaterFunctional","5"))

# --------- application d'un jeu de règles -> matrice 0/1 (avec cadrage module optionnel) ---------
apply_rules <- function(d, rules, scope=TRUE){
  n <- nrow(d)
  M <- sapply(rules, function(r){
    x <- tryCatch(r$f(d), error=function(e) rep(FALSE,n)); x[is.na(x)]<-FALSE; x <- as.integer(x)
    if(scope && !is.null(r$mod)) x <- x * as.integer(mod_present(d, r$mod))   # motif ignore si module absent
    x })
  if(is.null(dim(M))) M <- matrix(M, nrow=n)
  colnames(M) <- sapply(rules, function(r) r$id); M
}

# ----------------------- Qualité par soumission (module-aware) -----------------------
per_submission <- function(d){
  n <- nrow(d)
  hard <- rowSums(apply_rules(d, dq_rules))
  soft <- rowSums(apply_rules(d, coherence_rules))
  intM <- sapply(integ_rules, function(r) as.integer(cz(getcol(d,r$v))==1)); if(is.null(dim(intM))) intM<-matrix(intM,nrow=n)
  integ <- rowSums(intM)
  # completude : seulement sur les variables dont le module etait dans la visite
  filled  <- sapply(KEYMOD, function(k){ x<-getcol(d,k[1]); as.integer(!is.na(x) & as.character(x)!="") })
  inscope <- sapply(KEYMOD, function(k) as.integer(mod_present(d,k[2])))
  if(is.null(dim(filled)))  filled  <- matrix(filled,  nrow=n)
  if(is.null(dim(inscope))) inscope <- matrix(inscope, nrow=n)
  den <- rowSums(inscope); comp <- ifelse(den>0, round(rowSums(filled*inscope)/den*100,1), 100)
  gps <- getcol(d,"HHCoord"); gps_ok <- as.integer(!is.na(gps) & as.character(gps)!="")
  key <- paste(agent_of(d), as.character(getcol(d,"Adm4Code_SMP")), as.character(getcol(d,"SvyDate")))
  dup <- as.integer(duplicated(key) | duplicated(key, fromLast=TRUE))
  visite <- ifelse(mod_present(d,"1") & mod_present(d,"5"), "Complete",
             ifelse(mod_present(d,"1"), "Directeur",
              ifelse(mod_present(d,"5"), "Observation", "Autre")))
  data.frame(Agent=agent_of(d), Bureau=office_of(d), Ecole=as.character(getcol(d,"Adm4Code_SMP")),
             Visite=visite, Erreurs=hard, A_confirmer=soft, Integrite=integ,
             Completude=comp, GPS_ok=gps_ok, Doublon=dup, stringsAsFactors=FALSE)
}

# ----------------------- Scorecard par AGENT -----------------------
agent_scorecard <- function(ps){
  ps %>% group_by(Bureau, Agent) %>% summarise(
    Soumissions        = n(),
    Visites_completes  = sum(Visite=="Complete"),
    Taux_erreur        = round(mean(Erreurs>0)*100,1),
    Taux_a_confirmer   = round(mean(A_confirmer>0)*100,1),
    Completude         = round(mean(Completude),1),
    GPS_manquant       = sum(GPS_ok==0),
    Doublons           = sum(Doublon),
    Signaux_integrite  = sum(Integrite>0),
    .groups="drop") %>%
    mutate(
      pattern_ok = 1 - (GPS_manquant + Doublons)/pmax(Soumissions,1),
      Score_QC = round(40*(1 - Taux_erreur/100) + 20*(1 - Taux_a_confirmer/100) +
                       30*(Completude/100) + 10*pmax(0,pattern_ok)),
      Classe   = ifelse(Score_QC>=85,"Bon", ifelse(Score_QC>=70,"A surveiller","A renforcer"))
    ) %>% select(-pattern_ok) %>% arrange(Bureau, desc(Score_QC))
}

incidents <- function(d){
  n<-nrow(d); res<-list()
  emitM <- function(rules,type){ M<-apply_rules(d,rules); for(cn in colnames(M)){ fl<-M[,cn]==1
    if(any(fl)){ r<-rules[[which(sapply(rules,function(z) z$id)==cn)]]
      res[[length(res)+1]]<<-data.frame(Type=type,Controle=cn,Libelle=r$lib,
        Agent=agent_of(d)[fl],Bureau=office_of(d)[fl],Ecole=as.character(getcol(d,"Adm4Code_SMP"))[fl]) } } }
  emitM(dq_rules,"Erreur (impossible)"); emitM(coherence_rules,"A confirmer")
  for(r in integ_rules){ fl<-(cz(getcol(d,r$v))==1) & mod_present(d,"5"); fl[is.na(fl)]<-FALSE
    if(any(fl)) res[[length(res)+1]]<-data.frame(Type="Integrite",Controle=r$id,Libelle=r$lib,
      Agent=agent_of(d)[fl],Bureau=office_of(d)[fl],Ecole=as.character(getcol(d,"Adm4Code_SMP"))[fl]) }
  if(!length(res)) return(data.frame(Type=character(),Controle=character(),Libelle=character(),Agent=character(),Bureau=character(),Ecole=character()))
  do.call(rbind,res)
}

rule_counts_by_agent <- function(d, rules){
  M  <- apply_rules(d, rules)
  base <- data.frame(Bureau=office_of(d), Agent=agent_of(d), M, check.names=FALSE)
  agg  <- aggregate(. ~ Bureau + Agent, data=base, FUN=sum)
  agg$Total <- rowSums(agg[,-(1:2),drop=FALSE]); agg[order(agg$Bureau, -agg$Total), ]
}
legend_df <- function(rules) data.frame(Controle=sapply(rules,function(r) r$id), Signification=sapply(rules,function(r) r$lib))

# =====================================================================================
ui <- fluidPage(
  tags$head(tags$style(HTML("
    .brand{background:#0B5394;color:#fff;padding:14px 18px;border-radius:8px;margin-bottom:12px}
    .kpi{background:#f4f7fb;border:1px solid #dbe5f0;border-radius:8px;padding:12px;text-align:center}
    .kpi h2{margin:0;color:#0B5394}"))),
  div(class="brand", h3("PAM Madagascar - Controle Qualite ODK/Kobo par AGENT (conscient du module)"),
      span("Cantines scolaires - MDG SMP 2025-2026 - RAM Unit")),
  sidebarLayout(
    sidebarPanel(width=3,
      fileInput("f_main","Donnees ODK/Kobo (CSV ou XLSX)", accept=c(".csv",".xlsx",".xls")),
      selectInput("bureau","Filtrer par bureau", choices="(tous)"),
      selectInput("visite","Type de visite", choices=c("(toutes)","Complete","Directeur","Observation")),
      hr(),
      downloadButton("dl_agents","Scorecard agents (Excel)", class="btn-primary"), br(),br(),
      downloadButton("dl_inc","Erreurs & coherence (Excel)"),
      hr(),
      helpText("Completude et coherence evaluees UNIQUEMENT sur les modules presents dans chaque visite."),
      helpText("Score QC = 40% erreurs dures + 20% coherence + 30% completude + 10% bonnes pratiques.")
    ),
    mainPanel(width=9,
      tabsetPanel(
        tabPanel("Qualite par agent", br(),
          fluidRow(
            column(3, div(class="kpi", h4("Agents"), h2(textOutput("k_agents")))),
            column(3, div(class="kpi", h4("Soumissions"), h2(textOutput("k_n")))),
            column(3, div(class="kpi", h4("Score QC moyen"), h2(textOutput("k_qc")))),
            column(3, div(class="kpi", h4("Signaux integrite"), h2(textOutput("k_int"))))),
          br(), plotOutput("p_agents", height=320),
          br(), h4("Scorecard qualite par agent (filtrable par bureau / type de visite)"), DTOutput("t_agents")),
        tabPanel("Erreurs & coherence", br(),
          helpText("Erreurs impossibles (rouge), incoherences a confirmer (orange), signaux d'integrite (violet). Motifs ignores si leur module n'a pas ete collecte."),
          DTOutput("t_inc")),
        tabPanel("Motifs a confirmer / agent", br(),
          helpText("Occurrences de chaque incoherence a confirmer par agent (cadrees sur le module collecte)."),
          DTOutput("t_motifs"), br(), h4("Legende"), DTOutput("t_legend")),
        tabPanel("Synthese par ecole", br(), DTOutput("t_perf")),
        tabPanel("Aide", br(), htmlOutput("help"))
      )
    )
  )
)

# =====================================================================================
server <- function(input, output, session){
  raw <- reactive({ req(input$f_main); read_any(input$f_main$datapath, input$f_main$name) })
  observeEvent(raw(), updateSelectInput(session,"bureau", choices=c("(tous)", sort(unique(office_of(raw()))))))
  dat <- reactive({ d<-raw()
    if(input$bureau!="(tous)") d<-d[office_of(d)==input$bureau,,drop=FALSE]
    if(input$visite!="(toutes)"){ vc<-ifelse(mod_present(d,"1")&mod_present(d,"5"),"Complete",ifelse(mod_present(d,"1"),"Directeur",ifelse(mod_present(d,"5"),"Observation","Autre")))
      d<-d[vc==input$visite,,drop=FALSE] }
    d })
  ps  <- reactive(per_submission(dat()))
  sc  <- reactive(agent_scorecard(ps()))
  inc <- reactive(incidents(dat()))
  motifs <- reactive(rule_counts_by_agent(dat(), coherence_rules))

  output$k_agents <- renderText(nrow(sc()))
  output$k_n      <- renderText(nrow(dat()))
  output$k_qc     <- renderText(round(mean(sc()$Score_QC),1))
  output$k_int    <- renderText(sum(ps()$Integrite>0))

  output$p_agents <- renderPlot({
    s <- sc(); s$lab <- paste0(s$Agent," (",s$Bureau,")")
    ggplot(s, aes(reorder(lab,Score_QC), Score_QC, fill=Classe)) + geom_col(width=.65) + coord_flip() +
      geom_text(aes(label=Score_QC), hjust=-0.2, size=3.4) +
      scale_fill_manual(values=c("Bon"="#27AE60","A surveiller"="#E67E22","A renforcer"="#C0392B")) +
      labs(title="Score de controle qualite par agent", x=NULL, y="Score QC / 100") +
      ylim(0,105) + theme_minimal(base_size=12) + theme(legend.position="top")
  })
  output$t_agents <- renderDT(
    datatable(sc(), rownames=FALSE, filter="top", options=list(pageLength=15, scrollX=TRUE)) %>%
      formatStyle("Score_QC", backgroundColor=styleInterval(c(70,85), c("#fde8e8","#fff7e6","#e8f8ee"))) %>%
      formatStyle("Signaux_integrite", color=styleInterval(0, c("black","#c0392b")), fontWeight=styleInterval(0, c("normal","bold")))
  )
  output$t_inc <- renderDT(
    datatable(inc(), rownames=FALSE, filter="top", options=list(pageLength=20)) %>%
      formatStyle("Type", fontWeight="bold",
        color=styleEqual(c("Erreur (impossible)","A confirmer","Integrite"), c("#c0392b","#E67E22","#8e44ad")))
  )
  output$t_motifs <- renderDT({
    m <- motifs(); lc <- setdiff(names(m), c("Bureau","Agent","Total"))
    dt <- datatable(m, rownames=FALSE, filter="top", options=list(pageLength=15, scrollX=TRUE))
    for(cn in lc) dt <- dt %>% formatStyle(cn, backgroundColor=styleInterval(c(0,1,3), c("white","#fff3e0","#ffe0b2","#ffb74d")))
    dt %>% formatStyle("Total", fontWeight="bold", backgroundColor=styleInterval(c(0,2,5), c("white","#fff3e0","#ffcc80","#ff9800")))
  })
  output$t_legend <- renderDT(datatable(legend_df(coherence_rules), rownames=FALSE, options=list(dom="t", pageLength=20)))
  output$t_perf <- renderDT({
    p <- ps() %>% group_by(Bureau, Ecole, Visite) %>%
      summarise(Erreurs=sum(Erreurs), A_confirmer=sum(A_confirmer), Integrite=sum(Integrite),
                Completude=round(mean(Completude),1), .groups="drop")
    datatable(p, rownames=FALSE, filter="top", options=list(pageLength=15))
  })
  output$help <- renderUI(HTML(
    "<h4>Conscient du module (type de visite)</h4>
     <p>Une soumission ne couvre que les modules collectes (SBPSiteSvyType : 1=directeur, 5=observation, ...).
     La <b>completude</b> et les <b>controles de coherence</b> ne sont evalues que sur les modules <b>reellement presents</b> :
     un agent en visite d'observation seule n'est pas penalise pour les variables du module directeur.</p>
     <h4>Trois familles de controles</h4>
     <ul><li><b>Erreurs dures</b> : valeurs impossibles. A corriger.</li>
     <li><b>A confirmer</b> : reponses contradictoires entre questions liees (ex : pas de cuisine mais repas cuit ;
     ration conforme mais balance non utilisee). A verifier.</li>
     <li><b>Signaux d'integrite</b> : detournement / coercition / fraude. A escalader (CFM/anti-fraude) ; ne baissent pas le score QC.</li></ul>
     <p><b>Score QC</b> = 40% (1 - erreurs dures) + 20% (1 - a confirmer) + 30% completude + 10% bonnes pratiques.
     Classes : Bon &ge; 85 ; A surveiller 70-84 ; A renforcer &lt; 70.</p>
     <p><b>Note scoring performance :</b> le score de performance de l'EPP (PERF_SECT_100) n'est pleinement valide que pour une
     <b>visite complete</b> (directeur + observation). Pour les visites partielles, ne comparez que les domaines des modules collectes.</p>"))
  output$dl_agents <- downloadHandler(
    filename=function() paste0("Scorecard_Agents_QC_", Sys.Date(), ".xlsx"),
    content=function(file){ wb<-createWorkbook()
      addWorksheet(wb,"Scorecard_agents"); writeData(wb,"Scorecard_agents", sc())
      addWorksheet(wb,"Par_soumission"); writeData(wb,"Par_soumission", ps())
      addWorksheet(wb,"Motifs_a_confirmer"); writeData(wb,"Motifs_a_confirmer", motifs())
      addWorksheet(wb,"Legende"); writeData(wb,"Legende", legend_df(coherence_rules))
      addStyle(wb,"Scorecard_agents",createStyle(fgFill="#0B5394",fontColour="white",textDecoration="bold"),rows=1,cols=1:ncol(sc()),gridExpand=TRUE)
      saveWorkbook(wb,file,overwrite=TRUE) })
  output$dl_inc <- downloadHandler(
    filename=function() paste0("Erreurs_Coherence_", Sys.Date(), ".xlsx"),
    content=function(file){ wb<-createWorkbook(); addWorksheet(wb,"Incidents"); writeData(wb,"Incidents", inc())
      saveWorkbook(wb,file,overwrite=TRUE) })
}
shinyApp(ui, server)
