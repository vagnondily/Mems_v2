# =========================================================
# PAM GPS AUDIT TOOL - DISTANCES CORRIGÉES (COMMUNE D'ACCUEIL EXACTE)
# =========================================================

library(shiny)
library(shinydashboard)
library(sf)
library(leaflet)
library(dplyr)
library(DT)
library(readxl)
library(writexl)
library(osrm)

options(shiny.maxRequestSize = 50*1024^2)

# ---------------- 1. DATA & FONCTIONS ----------------
admin_sf <- st_read("data/mdg_bnd_adm4_com_pam_v26.shp", quiet = TRUE) %>% 
  st_make_valid() %>% 
  st_transform(4326)

# Normalisation stricte en minuscules pour éviter les erreurs d'objets introuvables
names(admin_sf) <- tolower(names(admin_sf))

# Centroïdes ADM3 calculés proprement à plat (génère le centre de chaque commune)
admin_centroids <- admin_sf %>%
  st_transform(32738) %>% 
  group_by(adm1_en, adm2_en, adm3_en) %>%
  summarise(geometry = st_union(geometry), .groups = "drop") %>%
  st_centroid() %>% 
  st_transform(4326)

# Dictionnaire inverse pour lier le code calculé au nom du Field Office
fo_name_lookup <- data.frame(
  code = c(1, 2, 3, 4, 6, 7, 9, 10),
  office_name = c("Bekily", "Fort dauphin", "Antananarivo", "Manakara", "Ambovombe", "Tsihombe", "Ampanihy", "Tulear"),
  stringsAsFactors = FALSE
)

safe_val <- function(x){ if(length(x)==0 || is.null(x) || is.na(x)) return(NA) else return(x) }

get_route_safe <- function(p, c, geom = FALSE) {
  tryCatch({
    if (geom) {
      r <- osrmRoute(src = p, dst = c, overview = "full", returnclass = "sf")
      if(nrow(r)>0) return(r) else return(NULL)
    } else {
      res <- osrmRoute(src = p, dst = c, overview = FALSE)
      return(as.numeric(res$distance))
    }
  }, error = function(e) {
    d <- as.numeric(st_distance(st_transform(p, 32738), st_transform(c, 32738)))/1000
    if(geom){
      line <- st_sfc(st_linestring(rbind(st_coordinates(p), st_coordinates(c))), crs = 4326)
      return(st_as_sf(data.frame(geometry = line)))
    } else { return(round(d * 1.3, 2)) }
  })
}

# =========================================================
# 2. UI CRISTAL LIQUIDE : ANTI-DÉBORDEMENT ET COMPACTE
# =========================================================
ui <- dashboardPage(
  skin = "blue",
  dashboardHeader(title = span(tagList(icon("shield-alt"), " PM Sites Management")), titleWidth = 260),
  
  dashboardSidebar(
    width = 260,
    div(style = "display: flex; flex-direction: column; height: calc(100vh - 50px); padding: 12px; justify-content: space-between;",
        div(style = "flex-grow: 1;",
            h5("NAVIGATION", style = "color: #4b646f; font-size: 10px; font-weight: bold; letter-spacing: 1px; margin-bottom: 10px; padding-left: 5px;"),
            sidebarMenu(id = "tabs",
                        menuItem("Analyse par Lot (Batch)", tabName = "batch_tab", icon = icon("file-excel")),
                        menuItem("Vérification Manuelle", tabName = "manual_tab", icon = icon("hand-pointer"))
            ),
            
            hr(style = "border-top: 1px solid #374850; margin: 12px 0;"),
            
            conditionalPanel(
              condition = "input.tabs == 'batch_tab'",
              h5("CHARGEMENT DU LOT", style = "color: #4b646f; font-size: 10px; font-weight: bold; letter-spacing: 1px; margin-bottom: 8px; padding-left: 5px;"),
              div(style = "background: #1e282c; padding: 10px; border-radius: 6px; border-left: 3px solid #00c0ef; margin-bottom: 10px;",
                  fileInput("file", NULL, accept = ".xlsx", buttonLabel = "Excel", width = "100%"),
                  downloadButton("template", "Template Excel", style = "width: 100%; background-color: #374850; color: #b8c7ce; border: none; font-size: 11px; font-weight: bold; height: 28px; padding: 5px;")
              )
            ),
            
            conditionalPanel(
              condition = "input.tabs == 'manual_tab'",
              h5("COORDONNÉES (GPS)", style = "color: #4b646f; font-size: 10px; font-weight: bold; letter-spacing: 1px; margin-bottom: 8px; padding-left: 5px;"),
              
              div(style = "background: #1e282c; padding: 8px; border-radius: 6px; border-left: 3px solid #00c0ef; margin-bottom: 8px;",
                  div(style = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;",
                      span("POINT A", style="color: #00c0ef; font-weight: bold; font-size: 11px;"),
                      icon("map-marker-alt", style="color: #00c0ef; font-size: 11px;")
                  ),
                  div(style = "display: flex; gap: 6px;",
                      numericInput("lat1", "Latitude", value = NA, step = 0.0001, width = "50%"),
                      numericInput("lon1", "Longitude", value = NA, step = 0.0001, width = "50%")
                  )
              ),
              
              div(style = "background: #1e282c; padding: 8px; border-radius: 6px; border-left: 3px solid #f39c12; margin-bottom: 12px;",
                  div(style = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;",
                      span("POINT B (Optionnel)", style="color: #f39c12; font-weight: bold; font-size: 11px;"),
                      icon("map-marker-alt", style="color: #f39c12; font-size: 11px;")
                  ),
                  div(style = "display: flex; gap: 6px;",
                      numericInput("lat2", "Latitude", value = NA, step = 0.0001, width = "50%"),
                      numericInput("lon2", "Longitude", value = NA, step = 0.0001, width = "50%")
                  )
              ),
              
              actionButton("run_quick", "Exécuter l'audit", icon = icon("play"),
                           style = "width: 100%; background-color: #3c8dbc; color: white; font-weight: bold; border: none; padding: 6px; border-radius: 4px; font-size: 12px;")
            )
        ),
        
        div(style = "background: #1a2226; padding-top: 8px; border-top: 1px solid #374850;",
            actionButton("reset", "Réinitialiser", icon = icon("redo"), 
                         style = "width: 100%; background-color: #dd4b39; color: white; border: none; padding: 6px; font-weight: bold; font-size: 11px; margin-bottom: 6px; border-radius: 4px;"),
            downloadButton("export", "Exporter en .xlsx", 
                           style = "width: 100%; background-color: #00a65a; color: white; border: none; padding: 6px; font-weight: bold; font-size: 11px; text-align: center; border-radius: 4px;")
        )
    )
  ),
  
  dashboardBody(
    tags$head(tags$style(HTML("
      body, html { overflow-y: auto !important; height: 100vh; }
      .content-wrapper { background-color: #ecf0f5; padding: 10px !important; }
      .box { border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); margin-bottom: 12px !important; }
      .shiny-input-container label { color: #8aa4af; font-size: 10px; margin-bottom: 2px; font-weight: normal; }
      .form-control { height: 26px; padding: 2px 4px; font-size: 11px; background-color: #222d32; color: #fff; border: 1px solid #3c8dbc; border-radius: 4px; }
      .dataTables_wrapper { font-size: 11px; }
      table.dataTable tbody th, table.dataTable tbody td { padding: 4px 6px !important; }
    "))),
    
    fluidRow(
      column(width = 12, box(width = NULL, status = "primary", solidHeader = TRUE, title = "Carte Interactive de Validation", leafletOutput("map", height = "380px")))
    ),
    fluidRow(
      column(width = 12, box(width = NULL, status = "warning", title = "Tableau d'Analyse Spatial des Points GPS", div(style = "overflow-x: auto;", DTOutput("table"))))
    )
  )
)

# =========================================================
# 3. SERVER
# =========================================================
server <- function(input, output, session) {
  
  results <- reactiveVal(NULL)
  
  output$map <- renderLeaflet({
    leaflet() %>% addProviderTiles(providers$CartoDB.Positron) %>% setView(lng = 47.5, lat = -18.9, zoom = 5)
  })
  
  # --- LOGIQUE DE CALCUL VECTORISÉE SÉCURISÉE ---
  process_logic <- function(input_df) {
    withProgress(message = "Initialisation de l'audit...", value = 0.1, {
      
      input_df <- input_df %>%
        mutate(latitude = as.numeric(latitude), longitude = as.numeric(longitude)) %>%
        filter(!is.na(latitude) & !is.na(longitude))
      
      if(nrow(input_df) == 0) return(data.frame())
      
      setProgress(value = 0.3, message = "Jointure spatiale vectorisée (Fokontany)...")
      pts_sf <- st_as_sf(input_df, coords = c("longitude", "latitude"), crs = 4326, remove = FALSE)
      joined_sf <- st_join(pts_sf, admin_sf)
      
      na_indices <- which(is.na(joined_sf$adm4_en))
      if(length(na_indices) > 0) {
        nearest_idx <- st_nearest_feature(pts_sf[na_indices, ], admin_sf)
        geometry_columns <- st_geometry(joined_sf)
        joined_sf[na_indices, names(admin_sf)] <- st_drop_geometry(admin_sf[nearest_idx, ])
        st_geometry(joined_sf) <- geometry_columns
      }
      
      # Extraction des informations textuelles de base
      final_df <- joined_sf %>% st_drop_geometry()
      
      setProgress(value = 0.5, message = "Calcul dynamique point-à-commune d'accueil...")
      
      # FIX UNIQUE DISTANCES : Liaison itérative stricte pour garantir que chaque point compare son GPS 
      # au centroïde de la commune y afférente où il a été localisé géo-spatialement.
      pts_projected <- st_transform(pts_sf, 32738)
      
      # On force l'alignement exact ligne par ligne de la matrice des centroïdes ADM3 d'accueil
      centr_sf <- admin_centroids %>% 
        filter(adm3_en %in% final_df$adm3_en) %>%
        slice(match(final_df$adm3_en, adm3_en)) %>%
        st_transform(32738)
      
      final_df$distance_cartesienne <- round(as.numeric(st_distance(pts_projected, centr_sf, by_element = TRUE)) / 1000, 2)
      
      setProgress(value = 0.7, message = "Calcul des distances routières réelles (OSRM)...")
      final_df$distance_trajet <- sapply(1:nrow(final_df), function(k) {
        pt_point <- pts_sf[k, ]
        # Extraction du centroïde de la commune exacte où se trouve le point GPS 'k'
        ct_point <- admin_centroids %>% 
          filter(tolower(trimws(adm1_en)) == tolower(trimws(final_df$adm1_en[k])),
                 tolower(trimws(adm2_en)) == tolower(trimws(final_df$adm2_en[k])),
                 tolower(trimws(adm3_en)) == tolower(trimws(final_df$adm3_en[k]))) %>% 
          slice(1)
        
        if(nrow(ct_point) == 0) return(NA)
        get_route_safe(pt_point, ct_point)
      })
      
      setProgress(value = 0.9, message = "Application des règles Field Office...")
      
      final_df$Attendu <- as.character(NA)
      if ("fokontany_attendue" %in% names(final_df)) {
        final_df$Attendu <- final_df[["fokontany_attendue"]]
      } else if ("fokontany_attendu" %in% names(final_df)) {
        final_df$Attendu <- final_df[["fokontany_attendu"]]
      } else if ("commune_attendue" %in% names(final_df)) {
        final_df$Attendu <- final_df[["commune_attendue"]]
      }
      
      final_df <- final_df %>%
        mutate(
          reg_key = tolower(trimws(adm1_en)),
          dist_key = tolower(trimws(adm2_en)),
          
          Field_office_code = case_when(
            reg_key %in% c('androy', 'anosy') & dist_key %in% c('ambovombe-androy', 'antanimora atsimo', 'betroka') ~ 6,
            reg_key == 'anosy' & !(dist_key %in% c('ambovombe-androy', 'antanimora atsimo', 'betroka')) ~ 2,
            reg_key == 'androy' & dist_key %in% c('tsihombe', 'beloha') ~ 7,
            reg_key == 'androy' & dist_key == 'bekily' ~ 1,
            reg_key == 'atsimo andrefana' & dist_key != 'ampanihy ouest' ~ 10,
            reg_key == 'atsimo andrefana' & dist_key == 'ampanihy ouest' ~ 9,
            reg_key %in% c('vatovavy', 'fitovinany', 'atsimo atsinanana', 'atsimo-atsinanana') ~ 4,
            TRUE ~ 3
          )
        ) %>%
        left_join(fo_name_lookup, by = c("Field_office_code" = "code")) %>%
        mutate(Field_office = ifelse(is.na(office_name), "Antananarivo", office_name))
      
      final_df$POIName <- if("site_name" %in% names(final_df)) final_df[["site_name"]] else "Point"
      final_df$POI_code <- if("site_id" %in% names(final_df)) final_df[["site_id"]] else "MNL"
      final_df$Tag_Code <- if("tag_code" %in% names(final_df)) final_df[["tag_code"]] else "QC"
      final_df$Situation <- if("situation" %in% names(final_df)) final_df[["situation"]] else "N/A"
      
      output_df <- final_df %>%
        mutate(
          Verification = ifelse(!is.na(Attendu) & (tolower(trimws(adm4_en)) == tolower(trimws(Attendu)) | tolower(trimws(adm3_en)) == tolower(trimws(Attendu))), "MATCH ✅", "MISMATCH ❌"),
          Status = case_when(Verification == "MISMATCH ❌" ~ "❌ ERREUR ADMIN", distance_cartesienne > 15 ~ "🚩 SUSPECT", TRUE ~ "✅ FIABLE")
        ) %>%
        # Rangement propre des colonnes sans aucune source intermédiaire
        select(
          Field_office, ADM1_EN = adm1_en, ADM2_EN = adm2_en, ADM3_EN = adm3_en, ADM4_EN = adm4_en, 
          POI_Name = POIName, POI_code, Longitude = longitude, Latitude = latitude, Tag_Code, 
          distance_cartesienne, distance_trajet, Commune_attendue = Attendu, Verification,
          Field_office_code, ADM0_PCODE = adm0_pcode, ADM1_PCODE = adm1_pcode,
          ADM2_PCODE = adm2_pcode, ADM3_PCODE = adm3_pcode, ADM4_PCODE = adm4_pcode, 
          Situation, Status
        )
    })
    return(output_df)
  }
  
  observeEvent(input$file, {
    df <- read_excel(input$file$datapath); names(df) <- tolower(names(df))
    results(process_logic(df))
  })
  
  observeEvent(input$run_quick, {
    pts <- data.frame(latitude = numeric(), longitude = numeric(), site_name = character())
    if(!is.na(input$lat1)) pts <- rbind(pts, data.frame(latitude=input$lat1, longitude=input$lon1, site_name="Point A"))
    if(!is.na(input$lat2)) pts <- rbind(pts, data.frame(latitude=input$lat2, longitude=input$lon2, site_name="Point B"))
    
    if(nrow(pts) > 0) {
      res <- process_logic(pts)
      if(nrow(pts) == 2) {
        dist_AB <- get_route_safe(st_as_sf(pts[1,], coords=c("longitude","latitude"), crs=4326), 
                                  st_as_sf(pts[2,], coords=c("longitude","latitude"), crs=4326))
        ligne_dist <- res[1,]; ligne_dist[] <- NA
        ligne_dist$Field_office <- "MEASURE"; ligne_dist$POI_Name <- "DISTANCE A <-> B"
        ligne_dist$distance_trajet = round(dist_AB, 2); ligne_dist$Status <- "📏 INFO"
        res <- rbind(res, ligne_dist)
      }
      results(res)
    }
  })
  
  observe({
    req(results()) 
    map_data <- results() %>% filter(POI_Name != "DISTANCE A <-> B")
    req(nrow(map_data) > 0)
    
    leafletProxy("map") %>%
      clearMarkers() %>%
      addCircleMarkers(
        data = map_data, lng = ~Longitude, lat = ~Latitude, 
        color = ~case_when(Status == "✅ FIABLE" ~ "#27ae60", Status == "❌ ERREUR ADMIN" ~ "#c0392b", TRUE ~ "#f39c12"), 
        radius = 6, fillOpacity = 0.8, stroke = TRUE, weight = 1.5,
        popup = ~paste0(
          "<div style='font-family: Arial; padding: 3px; font-size:11px;'>",
          "<b>Site :</b> ", POI_Name, "<br>",
          "<b>Fokontany (Adm4) :</b> ", ADM4_EN, "<br>",
          "<b>Commune (Adm3) :</b> ", ADM3_EN, "<br>",
          "<b>District (Adm2) :</b> ", ADM2_EN, "<br>",
          "<b>Statut :</b> ", Status, "<br>",
          "<b>Field Office :</b> ", Field_office, " (Code: ", Field_office_code, ")<br>",
          "<b>Dist. Route / Commune :</b> ", distance_trajet, " km<br>",
          "<b>Situation :</b> ", Situation, "</div>"
        )
      )
    
    bbox <- results() %>% filter(!is.na(Longitude))
    if(nrow(bbox) > 0){
      leafletProxy("map") %>% fitBounds(lng1 = min(bbox$Longitude), lat1 = min(bbox$Latitude), lng2 = max(bbox$Longitude), lat2 = max(bbox$Latitude))
    }
  })
  
  output$table <- renderDT({
    req(results())
    datatable(
      results(), 
      selection = 'single', 
      options = list(
        scrollX = TRUE, 
        pageLength = 5, 
        dom = 'ftp',
        autoWidth = FALSE
      )
    ) %>%
      formatStyle('Verification', target = 'row', backgroundColor = styleEqual(c("MISMATCH ❌"), c('#ffe9e9')))
  })
  
  observeEvent(input$table_rows_selected, {
    req(results(), input$table_rows_selected)
    sel <- results()[input$table_rows_selected, ]
    
    if(sel$POI_Name == "DISTANCE A <-> B") {
      ptA <- results() %>% filter(POI_Name == "Point A") %>% slice(1)
      ptB <- results() %>% filter(POI_Name == "Point B") %>% slice(1)
      req(nrow(ptA) > 0, nrow(ptB) > 0)
      
      pA_sf <- st_as_sf(data.frame(lon=ptA$Longitude, lat=ptA$Latitude), coords=c("lon","lat"), crs=4326)
      pB_sf <- st_as_sf(data.frame(lon=ptB$Longitude, lat=ptB$Latitude), coords=c("lon","lat"), crs=4326)
      route_AB <- get_route_safe(pA_sf, pB_sf, geom = TRUE)
      
      leafletProxy("map") %>% clearShapes() %>%
        addPolylines(data = route_AB, color = "#8e44ad", weight = 5, opacity = 0.9, dashArray = "8, 8") %>%
        fitBounds(lng1 = ptA$Longitude, lat1 = ptA$Latitude, lng2 = ptB$Longitude, lat2 = ptB$Latitude)
      
    } else {
      req(!is.na(sel$Latitude))
      p_sf <- st_as_sf(data.frame(lon=sel$Longitude, lat=sel$Latitude), coords=c("lon","lat"), crs=4326)
      centr <- admin_centroids %>% 
        filter(tolower(trimws(adm1_en)) == tolower(trimws(sel$ADM1_EN)),
               tolower(trimws(adm2_en)) == tolower(trimws(sel$ADM2_EN)),
               tolower(trimws(adm3_en)) == tolower(trimws(sel$ADM3_EN))) %>% 
        slice(1)
      
      leafletProxy("map") %>% clearShapes() %>%
        addPolygons(data = admin_sf %>% filter(adm4_en == sel$ADM4_EN, adm3_en == sel$ADM3_EN), color = "blue", weight = 1.5, fillOpacity = 0.08, label = ~adm4_en) %>%
        addPolylines(data = get_route_safe(p_sf, centr, geom = TRUE), color = "orange", weight = 4) %>%
        setView(sel$Longitude, sel$Latitude, zoom = 12)
    }
  })
  
  output$template <- downloadHandler(
    filename = function() { paste0("Template_PMGPSCHeck_", Sys.Date(), ".xlsx") },
    content = function(file) { write_xlsx(data.frame(site_id="POI_001", site_name="Site Test", tag_code="CBT", latitude=-18.9, longitude=47.5, fokontany_attendue="NomFokontany", situation='Active'), file) }
  )
  
  output$export <- downloadHandler(
    filename = function() { paste0("PM_sites_Check_", Sys.Date(), ".xlsx") },
    content = function(file) { write_xlsx(results(), file) }
  )
  
  observeEvent(input$reset, { results(NULL); leafletProxy("map") %>% clearMarkers() %>% clearShapes() })
}

shinyApp(ui, server)
