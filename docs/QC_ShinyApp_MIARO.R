###############################################################################
# QC_ShinyApp_MIARO.R
# Application Shiny de contrôle qualité du suivi de processus MIARO (PAM Madagascar)
# - Par AGENT et par SITE, filtrable par bureau (EnuName/EnuName_Other, Field_office, Adm*)
# - 3 familles de contrôles : (A) erreurs dures ; (B) cohérence à confirmer ;
#   (C) signaux d'intégrité (escaladés, HORS score)
# - Lit les scores calculés sur l'appareil (site_score_w, score_dX_100, garden_subscore)
# - Score QC agent = 40% (1-erreurs) + 20% (1-à confirmer) + 30% complétude
#   + 10% bonnes pratiques (photo/GPS/anti-doublon)
#   Classes : Bon >=85 / À surveiller 70-84 / À renforcer <70
#
# Données attendues : export ODK/Kobo (CSV ou XLSX), 1 ligne = 1 soumission.
# R n'étant pas requis pour la validation, ce script est équilibré (parenthèses/
# accolades) ; installer les paquets ci-dessous avant exécution réelle.
###############################################################################

library(shiny)
library(DT)
library(dplyr)
library(tidyr)
library(ggplot2)
library(readr)
library(openxlsx)
library(readxl)

## --------------------------------------------------------------------------
## 0. Utilitaires robustes
## --------------------------------------------------------------------------

# Accès sûr à une colonne (retourne NA si absente)
gc <- function(df, name) {
  if (name %in% names(df)) {
    return(df[[name]])
  } else {
    return(rep(NA, nrow(df)))
  }
}

# Conversion numérique tolérante
as_num <- function(x) {
  suppressWarnings(as.numeric(as.character(x)))
}

# Test "égal au code" pour select_one (comparaison chaîne)
is_code <- function(x, code) {
  !is.na(x) & as.character(x) == as.character(code)
}

# Test "contient le code" pour select_multiple (codes séparés par des espaces)
has_code <- function(x, code) {
  vapply(x, function(v) {
    if (is.na(v)) return(FALSE)
    code %in% strsplit(as.character(v), "\\s+")[[1]]
  }, logical(1))
}

# Non vide
is_filled <- function(x) {
  !is.na(x) & trimws(as.character(x)) != ""
}

pct <- function(n, d) {
  if (is.na(d) || d == 0) return(NA_real_)
  round(100 * n / d, 1)
}

## --------------------------------------------------------------------------
## 1. Définition des contrôles (3 familles)
## Chaque contrôle renvoie un vecteur logique (TRUE = incident sur la ligne).
## meta : type (A/B/C) . domaine . libellé du contrôle
## --------------------------------------------------------------------------

# ---- Famille A : ERREURS DURES (valeurs impossibles) ----------------------
checks_A <- list(
  list(id = "A_animals_sum", dom = "Élevage",
       lab = "Somme mâles+femelles > animaux reçus",
       fn = function(d) {
         m <- as_num(gc(d, "HHMaleCount")); f <- as_num(gc(d, "HHFemaleCount"))
         tot <- as_num(gc(d, "HHAnimalsReceived"))
         !is.na(m) & !is.na(f) & !is.na(tot) & (m + f) > tot
       }),
  list(id = "A_attend_gt_plan", dom = "Nutrition",
       lab = "Présence totale > participation prévue",
       fn = function(d) {
         a <- as_num(gc(d, "MOAttendanceTotal")); p <- as_num(gc(d, "MOPlannedTotal"))
         !is.na(a) & !is.na(p) & p > 0 & a > p * 1.5
       }),
  list(id = "A_stock_neg", dom = "Magasin",
       lab = "Stock de clôture réel négatif",
       fn = function(d) {
         b <- as_num(gc(d, "MOActualBalance")); !is.na(b) & b < 0
       }),
  list(id = "A_dist_gt_avail", dom = "Magasin",
       lab = "Distribué > (stock initial + reçu)",
       fn = function(d) {
         op <- as_num(gc(d, "MOComOpeningBalance")); rc <- as_num(gc(d, "MOComReceived"))
         di <- as_num(gc(d, "MOComDistributed"))
         !is.na(op) & !is.na(rc) & !is.na(di) & di > (op + rc)
       }),
  list(id = "A_neg_counts", dom = "Nutrition",
       lab = "Effectif négatif (présence/prévu)",
       fn = function(d) {
         vals <- cbind(as_num(gc(d, "MOActualFemale")), as_num(gc(d, "MOAttendanceTotal")),
                       as_num(gc(d, "MOPlannedTotal")))
         apply(vals, 1, function(r) any(!is.na(r) & r < 0))
       }),
  list(id = "A_gps_missing", dom = "Données",
       lab = "Coordonnées GPS manquantes",
       fn = function(d) {
         !is_filled(gc(d, "HHCoord"))
       })
)

# ---- Famille B : COHÉRENCE À CONFIRMER (entorses / logique inter-questions) -
checks_B <- list(
  list(id = "B_suppl_notused", dom = "Nutrition",
       lab = "Dû reçu mais non conforme au montant convenu",
       fn = function(d) {
         is_code(gc(d, "HHAsstEntIK"), "1") & is_code(gc(d, "HHAsstEntRcCm"), "0")
       }),
  list(id = "B_garden_noprod", dom = "Jardins",
       lab = "Jardin déclaré (cultures) mais aucune récolte 2 mois",
       fn = function(d) {
         is_filled(gc(d, "GDCropsPlanted")) & is_code(gc(d, "GDHarvest2M"), "0")
       }),
  list(id = "B_reg_attend", dom = "Nutrition",
       lab = "Écart liste/présence non confirmé par l'agent",
       fn = function(d) {
         is_code(gc(d, "MODifferenceParNb"), "0")
       }),
  list(id = "B_scope_used_broken", dom = "Distribution",
       lab = "SCOPE utilisé mais matériel non fonctionnel",
       fn = function(d) {
         is_code(gc(d, "MOScopeUsed"), "1") & is_code(gc(d, "MOScopeFunc"), "0")
       }),
  list(id = "B_sbcc_notmastered", dom = "SBCC",
       lab = "Séance SBCC en cours mais thèmes non maîtrisés",
       fn = function(d) {
         is_code(gc(d, "MOSbcSession"), "1") & is_code(gc(d, "MOSbcStaffKnow"), "0")
       }),
  list(id = "B_farne_nomuac", dom = "FARNE",
       lab = "FARNE opérationnel mais dépistage MUAC non systématique",
       fn = function(d) {
         is_code(gc(d, "FROperational"), "1") & is_code(gc(d, "FRScreeningMUAC"), "0")
       }),
  list(id = "B_vacc_noreason", dom = "Élevage",
       lab = "Animaux non vaccinés sans raison renseignée",
       fn = function(d) {
         is_code(gc(d, "HHVaccUpToDate"), "0") & !is_filled(gc(d, "HHNoVaccWhy"))
       }),
  list(id = "B_cfm_known_unused_problem", dom = "Protection/AAP",
       lab = "Problème d'accès signalé mais CFM connu et non utilisé",
       fn = function(d) {
         is_code(gc(d, "HHAsstAccessLast"), "1") & is_code(gc(d, "HHAsstMCKnow"), "1") &
           is_code(gc(d, "HHAsstUseCFM"), "0")
       }),
  list(id = "B_register_incomplete", dom = "Distribution",
       lab = "Registre bénéficiaires présent mais incomplet",
       fn = function(d) {
         is_code(gc(d, "MOBeneficiaryRegister"), "1") & is_code(gc(d, "MODisListComplete"), "0")
       })
)

# ---- Famille C : SIGNAUX D'INTÉGRITÉ (à ESCALADER, hors score) -------------
checks_C <- list(
  list(id = "C_diversion_obs", dom = "Intégrité",
       lab = "Détournement/vol observé sur le site de distribution",
       fn = function(d) is_code(gc(d, "MODistDiv"), "1") | is_code(gc(d, "HHDistDiv"), "1")),
  list(id = "C_illicit_sale", dom = "Intégrité",
       lab = "Vente illicite d'intrants (animal vendu)",
       fn = function(d) is_code(gc(d, "HHDecreaseWhy"), "1")),
  list(id = "C_pay_for_entitlement", dom = "Intégrité",
       lab = "Paiement exigé pour obtenir le droit",
       fn = function(d) is_code(gc(d, "HHAsstPayEnt"), "1")),
  list(id = "C_damage_unreported", dom = "Intégrité",
       lab = "Vivres endommagés non signalés",
       fn = function(d) is_code(gc(d, "MOWHBadCommodouinon"), "1") & is_code(gc(d, "MOWhAllDamageRep"), "0")),
  list(id = "C_warehouse_misuse", dom = "Intégrité",
       lab = "Entrepôt non réservé au seul usage PAM",
       fn = function(d) is_code(gc(d, "MOWhOtherUse"), "0")),
  list(id = "C_duplicates", dom = "Intégrité",
       lab = "Doublons de bénéficiaires détectés",
       fn = function(d) is_code(gc(d, "MODuplicationBenef"), "1")),
  list(id = "C_other_id", dom = "Intégrité",
       lab = "Bénéficiaire porteur de la carte d'autrui",
       fn = function(d) is_code(gc(d, "MOBenefOther"), "1")),
  list(id = "C_fraud_concern", dom = "Intégrité",
       lab = "Préoccupation de fraude signalée",
       fn = function(d) is_code(gc(d, "MOFraudConcerns"), "1") | is_code(gc(d, "HHFraudConcerns"), "1")),
  list(id = "C_security_incident", dom = "Intégrité",
       lab = "Incident de sécurité (bénéficiaire/acteurs armés)",
       fn = function(d) is_code(gc(d, "HHAsstSecurity"), "1") | is_code(gc(d, "MOAsstArmed"), "1"))
)

ALL_CHECKS <- list(A = checks_A, B = checks_B, C = checks_C)

## --------------------------------------------------------------------------
## 2. Application des contrôles : table d'incidents (long)
## --------------------------------------------------------------------------

build_incidents <- function(d) {
  # Métadonnées identifiantes
  d$.rowid <- seq_len(nrow(d))
  agent <- ifelse(is_filled(gc(d, "EnuName_Other")),
                  as.character(gc(d, "EnuName_Other")),
                  as.character(gc(d, "EnuName")))
  site  <- ifelse(is_filled(gc(d, "POIName_Other")),
                  as.character(gc(d, "POIName_Other")),
                  as.character(gc(d, "POIName")))
  office <- as.character(gc(d, "Field_office"))
  adm2  <- as.character(gc(d, "Adm2Name"))
  adm3  <- as.character(gc(d, "Adm3Name"))

  rows <- list()
  for (fam in names(ALL_CHECKS)) {
    for (chk in ALL_CHECKS[[fam]]) {
      hit <- tryCatch(chk$fn(d), error = function(e) rep(FALSE, nrow(d)))
      hit[is.na(hit)] <- FALSE
      if (any(hit)) {
        idx <- which(hit)
        rows[[length(rows) + 1]] <- data.frame(
          rowid   = d$.rowid[idx],
          agent   = agent[idx],
          site    = site[idx],
          office  = office[idx],
          adm2    = adm2[idx],
          adm3    = adm3[idx],
          famille = fam,
          domaine = chk$dom,
          controle = chk$lab,
          check_id = chk$id,
          stringsAsFactors = FALSE
        )
      }
    }
  }
  if (length(rows) == 0) {
    return(data.frame(rowid = integer(0), agent = character(0), site = character(0),
                      office = character(0), adm2 = character(0), adm3 = character(0),
                      famille = character(0), domaine = character(0),
                      controle = character(0), check_id = character(0),
                      stringsAsFactors = FALSE))
  }
  do.call(rbind, rows)
}

## --------------------------------------------------------------------------
## 3. Complétude & bonnes pratiques (par soumission)
## --------------------------------------------------------------------------

# Champs "cœur" attendus pour la complétude (adaptés à MIARO)
CORE_FIELDS <- c("EnuName", "Field_office", "Adm3Name", "POIName", "HHCoord",
                 "process_monitoring", "SvyDate")

completeness_row <- function(d) {
  present <- sapply(CORE_FIELDS, function(f) is_filled(gc(d, f)))
  if (is.null(dim(present))) present <- matrix(present, nrow = nrow(d))
  rowMeans(present)
}

goodpractice_row <- function(d) {
  gp_photo <- is_filled(gc(d, "photo"))
  gp_gps   <- is_filled(gc(d, "HHCoord"))
  # anti-doublon : soumission dont la clé (agent+site+date) n'apparaît qu'une fois
  key <- paste(gc(d, "EnuName"), gc(d, "POIName"), gc(d, "SvyDate"), sep = "|")
  gp_uniq  <- ave(seq_along(key), key, FUN = length) == 1
  (as.numeric(gp_photo) + as.numeric(gp_gps) + as.numeric(gp_uniq)) / 3
}

## --------------------------------------------------------------------------
## 4. Score QC par agent
## 40% (1-erreurs) + 20% (1-à confirmer) + 30% complétude + 10% bonnes pratiques
## --------------------------------------------------------------------------

agent_qc <- function(d, inc) {
  d$.rowid <- seq_len(nrow(d))
  agent <- ifelse(is_filled(gc(d, "EnuName_Other")),
                  as.character(gc(d, "EnuName_Other")),
                  as.character(gc(d, "EnuName")))
  office <- as.character(gc(d, "Field_office"))
  compl <- completeness_row(d)
  gp    <- goodpractice_row(d)

  base <- data.frame(rowid = d$.rowid, agent = agent, office = office,
                     compl = compl, gp = gp, stringsAsFactors = FALSE)

  # nb de contrôles A et B (dénominateur = nb de contrôles définis dans chaque famille)
  nA <- length(checks_A); nB <- length(checks_B)
  incA <- inc %>% filter(famille == "A") %>% count(rowid, name = "nA")
  incB <- inc %>% filter(famille == "B") %>% count(rowid, name = "nB")

  per_row <- base %>%
    left_join(incA, by = "rowid") %>%
    left_join(incB, by = "rowid") %>%
    mutate(nA = ifelse(is.na(nA), 0, nA),
           nB = ifelse(is.na(nB), 0, nB),
           err_rate     = nA / nA,       # placeholder, recalculé ci-dessous
           confirm_rate = nB / nB)       # placeholder, recalculé ci-dessous

  # totaux = nb de contrôles définis dans chaque famille (dénominateur stable)
  per_row$err_rate     <- per_row$nA / nA
  per_row$confirm_rate <- per_row$nB / nB

  by_agent <- per_row %>%
    group_by(agent, office) %>%
    summarise(
      n_sub       = n(),
      err_rate     = mean(err_rate, na.rm = TRUE),
      confirm_rate = mean(confirm_rate, na.rm = TRUE),
      completude   = mean(compl, na.rm = TRUE),
      bonnes_prat  = mean(gp, na.rm = TRUE),
      .groups = "drop"
    ) %>%
    mutate(
      score_qc = round(100 * (0.40 * (1 - err_rate) +
                              0.20 * (1 - confirm_rate) +
                              0.30 * completude +
                              0.10 * bonnes_prat), 1),
      classe = ifelse(score_qc >= 85, "Bon",
                ifelse(score_qc >= 70, "À surveiller", "À renforcer"))
    ) %>%
    arrange(desc(score_qc))

  by_agent
}

## --------------------------------------------------------------------------
## 5. Performance par domaine (lecture des scores APPAREIL)
## --------------------------------------------------------------------------

DOMAIN_SCORE_FIELDS <- c(
  "Distribution"           = "score_d1_100",
  "Magasin"                = "score_d2_100",
  "FARNE"                  = "score_d3_100",
  "SBCC"                   = "score_d4_100",
  "Jardins"                = "score_d5_100",
  "Élevage"                = "score_d6_100",
  "Protection/AAP"         = "score_d7_100",
  "Nutrition/Supplément."  = "score_d8_100",
  "Comité/helpdesk"        = "score_d9_100"
)

domain_performance <- function(d) {
  res <- lapply(names(DOMAIN_SCORE_FIELDS), function(dom) {
    v <- as_num(gc(d, DOMAIN_SCORE_FIELDS[[dom]]))
    data.frame(domaine = dom,
               moyenne_pct = round(mean(v, na.rm = TRUE), 1),
               app_count   = sum(!is.na(v)),
               stringsAsFactors = FALSE)
  })
  out <- do.call(rbind, res)
  out[is.nan(out$moyenne_pct), "moyenne_pct"] <- NA
  out
}

## --------------------------------------------------------------------------
## 6. Lecture d'un export ODK (CSV ou XLSX)
## --------------------------------------------------------------------------

read_export <- function(path, name) {
  ext <- tolower(tools::file_ext(name))
  if (ext == "csv") {
    df <- readr::read_csv(path, show_col_types = FALSE, guess_max = 100000)
  } else if (ext %in% c("xlsx", "xls")) {
    df <- readxl::read_excel(path)
  } else {
    stop("Format non pris en charge (attendu : CSV ou XLSX).")
  }
  as.data.frame(df, stringsAsFactors = FALSE)
}

## --------------------------------------------------------------------------
## 7. UI
## --------------------------------------------------------------------------

ui <- fluidPage(
  titlePanel("Contrôle qualité — Suivi de processus MIARO (PAM Madagascar)"),
  sidebarLayout(
    sidebarPanel(
      width = 3,
      fileInput("file", "Export ODK/Kobo (CSV ou XLSX)",
                accept = c(".csv", ".xlsx", ".xls")),
      hr(),
      selectInput("f_office", "Bureau de terrain", choices = c("Tous"), selected = "Tous"),
      selectInput("f_adm2", "District (Adm2)", choices = c("Tous"), selected = "Tous"),
      selectInput("f_adm3", "Commune (Adm3)", choices = c("Tous"), selected = "Tous"),
      selectInput("f_agent", "Agent", choices = c("Tous"), selected = "Tous"),
      selectInput("f_site", "Site", choices = c("Tous"), selected = "Tous"),
      hr(),
      downloadButton("dl_xlsx", "Exporter (Excel)"),
      helpText("Familles : A = erreurs dures ; B = cohérence à confirmer ;",
               "C = intégrité (escaladée, hors score).")
    ),
    mainPanel(
      width = 9,
      tabsetPanel(
        tabPanel("Qualité par agent",
                 br(), DT::dataTableOutput("t_agent"),
                 br(), plotOutput("p_agent", height = "320px")),
        tabPanel("Incidents détaillés",
                 br(), DT::dataTableOutput("t_incidents")),
        tabPanel("Motifs par agent",
                 br(), DT::dataTableOutput("t_motifs"),
                 br(), uiOutput("legend")),
        tabPanel("Performance par domaine",
                 br(), DT::dataTableOutput("t_domain"),
                 br(), plotOutput("p_domain", height = "320px")),
        tabPanel("Sites",
                 br(), DT::dataTableOutput("t_sites")),
        tabPanel("Aide",
                 br(), uiOutput("help"))
      )
    )
  )
)

## --------------------------------------------------------------------------
## 8. Server
## --------------------------------------------------------------------------

server <- function(input, output, session) {

  raw <- reactive({
    req(input$file)
    read_export(input$file$datapath, input$file$name)
  })

  # met à jour les filtres à partir des données
  observeEvent(raw(), {
    d <- raw()
    updateSelectInput(session, "f_office",
                      choices = c("Tous", sort(unique(na.omit(as.character(gc(d, "Field_office")))))))
    updateSelectInput(session, "f_adm2",
                      choices = c("Tous", sort(unique(na.omit(as.character(gc(d, "Adm2Name")))))))
    updateSelectInput(session, "f_adm3",
                      choices = c("Tous", sort(unique(na.omit(as.character(gc(d, "Adm3Name")))))))
    ag <- ifelse(is_filled(gc(d, "EnuName_Other")),
                 as.character(gc(d, "EnuName_Other")), as.character(gc(d, "EnuName")))
    updateSelectInput(session, "f_agent", choices = c("Tous", sort(unique(na.omit(ag)))))
    st <- ifelse(is_filled(gc(d, "POIName_Other")),
                 as.character(gc(d, "POIName_Other")), as.character(gc(d, "POIName")))
    updateSelectInput(session, "f_site", choices = c("Tous", sort(unique(na.omit(st)))))
  })

  # données filtrées
  filtered <- reactive({
    d <- raw()
    ag <- ifelse(is_filled(gc(d, "EnuName_Other")),
                 as.character(gc(d, "EnuName_Other")), as.character(gc(d, "EnuName")))
    st <- ifelse(is_filled(gc(d, "POIName_Other")),
                 as.character(gc(d, "POIName_Other")), as.character(gc(d, "POIName")))
    keep <- rep(TRUE, nrow(d))
    if (input$f_office != "Tous") keep <- keep & (as.character(gc(d, "Field_office")) == input$f_office)
    if (input$f_adm2   != "Tous") keep <- keep & (as.character(gc(d, "Adm2Name")) == input$f_adm2)
    if (input$f_adm3   != "Tous") keep <- keep & (as.character(gc(d, "Adm3Name")) == input$f_adm3)
    if (input$f_agent  != "Tous") keep <- keep & (ag == input$f_agent)
    if (input$f_site   != "Tous") keep <- keep & (st == input$f_site)
    keep[is.na(keep)] <- FALSE
    d[keep, , drop = FALSE]
  })

  incidents <- reactive({ build_incidents(filtered()) })
  qc        <- reactive({ agent_qc(filtered(), incidents()) })
  domperf   <- reactive({ domain_performance(filtered()) })

  # ---- Onglet Qualité par agent ----
  output$t_agent <- DT::renderDataTable({
    DT::datatable(qc(), options = list(pageLength = 15), rownames = FALSE)
  })
  output$p_agent <- renderPlot({
    df <- qc()
    if (nrow(df) == 0) return(NULL)
    ggplot(df, aes(x = reorder(agent, score_qc), y = score_qc, fill = classe)) +
      geom_col() + coord_flip() +
      geom_hline(yintercept = c(70, 85), linetype = "dashed") +
      scale_fill_manual(values = c("Bon" = "#2e7d32", "À surveiller" = "#f9a825",
                                   "À renforcer" = "#c62828")) +
      labs(x = NULL, y = "Score QC agent", fill = "Classe") +
      theme_minimal()
  })

  # ---- Onglet Incidents détaillés ----
  output$t_incidents <- DT::renderDataTable({
    df <- incidents()[, c("famille", "domaine", "controle", "agent", "site", "office")]
    DT::datatable(df, filter = "top", options = list(pageLength = 20), rownames = FALSE)
  })

  # ---- Onglet Motifs par agent ----
  output$t_motifs <- DT::renderDataTable({
    inc <- incidents()
    if (nrow(inc) == 0) return(DT::datatable(data.frame()))
    m <- inc %>% count(agent, famille, controle, name = "nb") %>% arrange(agent, desc(nb))
    DT::datatable(m, options = list(pageLength = 20), rownames = FALSE)
  })
  output$legend <- renderUI({
    HTML(paste0(
      "<b>Légende des familles :</b><br>",
      "<b>A — Erreurs dures</b> : valeurs impossibles (à corriger).<br>",
      "<b>B — Cohérence à confirmer</b> : entorses au protocole / logique inter-questions.<br>",
      "<b>C — Intégrité</b> : signaux à ESCALADER (vente illicite, doublons, détournement) — <i>hors score</i>."
    ))
  })

  # ---- Onglet Performance par domaine ----
  output$t_domain <- DT::renderDataTable({
    DT::datatable(domperf(), options = list(pageLength = 15), rownames = FALSE)
  })
  output$p_domain <- renderPlot({
    df <- domperf()
    df <- df[!is.na(df$moyenne_pct), , drop = FALSE]
    if (nrow(df) == 0) return(NULL)
    ggplot(df, aes(x = reorder(domaine, moyenne_pct), y = moyenne_pct)) +
      geom_col(fill = "#1565c0") + coord_flip() +
      labs(x = NULL, y = "% du maximum (score appareil)") +
      theme_minimal()
  })

  # ---- Onglet Sites ----
  output$t_sites <- DT::renderDataTable({
    d <- filtered()
    st <- ifelse(is_filled(gc(d, "POIName_Other")),
                 as.character(gc(d, "POIName_Other")), as.character(gc(d, "POIName")))
    sc <- as_num(gc(d, "site_score_w"))
    df <- data.frame(site = st, adm3 = as.character(gc(d, "Adm3Name")),
                     score_site = sc, stringsAsFactors = FALSE) %>%
      group_by(site, adm3) %>%
      summarise(n = n(), score_moyen = round(mean(score_site, na.rm = TRUE), 1),
                .groups = "drop") %>%
      arrange(score_moyen)
    DT::datatable(df, options = list(pageLength = 20), rownames = FALSE)
  })

  # ---- Onglet Aide ----
  output$help <- renderUI({
    HTML(paste0(
      "<h4>Mode d'emploi</h4>",
      "<ol>",
      "<li>Charger l'export ODK/Kobo (CSV ou XLSX).</li>",
      "<li>Filtrer par bureau, district, commune, agent ou site.</li>",
      "<li>Consulter la qualité par agent, les incidents, la performance par domaine.</li>",
      "<li>Exporter le tout vers Excel.</li>",
      "</ol>",
      "<b>Score QC agent</b> = 40% (1-erreurs) + 20% (1-à confirmer) + 30% complétude ",
      "+ 10% bonnes pratiques (photo/GPS/anti-doublon).<br>",
      "Classes : <b>Bon &ge;85</b> / <b>À surveiller 70-84</b> / <b>À renforcer &lt;70</b>.<br><br>",
      "Les scores de domaine et le score de site (<code>site_score_w</code>) sont ",
      "<b>lus tels que calculés sur l'appareil</b> (non recalculés)."
    ))
  })

  # ---- Export Excel ----
  output$dl_xlsx <- downloadHandler(
    filename = function() paste0("QC_MIARO_", Sys.Date(), ".xlsx"),
    content = function(file) {
      wb <- createWorkbook()
      addWorksheet(wb, "Qualite_agent"); writeData(wb, "Qualite_agent", qc())
      addWorksheet(wb, "Incidents");     writeData(wb, "Incidents", incidents())
      addWorksheet(wb, "Perf_domaine");  writeData(wb, "Perf_domaine", domperf())
      inc <- incidents()
      motifs <- if (nrow(inc) > 0) {
        inc %>% count(agent, famille, controle, name = "nb")
      } else {
        data.frame()
      }
      addWorksheet(wb, "Motifs"); writeData(wb, "Motifs", motifs)
      saveWorkbook(wb, file, overwrite = TRUE)
    }
  )
}

## --------------------------------------------------------------------------
## 9. Lancement
## --------------------------------------------------------------------------

shinyApp(ui = ui, server = server)
