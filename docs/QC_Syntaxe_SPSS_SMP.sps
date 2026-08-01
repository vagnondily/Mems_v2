* =====================================================================================.
* PAM Madagascar - Cantines Scolaires (MDG SMP 2025-2026).
* SYNTAXE SPSS - CONTROLE QUALITE des donnees KoboToolbox.
* Cellule S&E / VAM-MEAL.
*
* UTILISATION :
*   1) Exporter depuis Kobo en CSV, en-tetes = noms XML des questions.
*   2) Adapter le chemin FILE ci-dessous.
*   3) Si l'export a prefixe les noms par le chemin des groupes (ex. MO.MOFoodStored),
*      utiliser RENAME VARIABLES pour retrouver les noms-feuilles utilises ci-dessous.
*   4) Executer toute la syntaxe (Run > All).
* =====================================================================================.

* ------------------------------------------------------------------------------------.
* 1. IMPORT DES DONNEES (adapter le chemin et le delimiteur).
* ------------------------------------------------------------------------------------.
GET DATA
  /TYPE=TXT
  /FILE="C:\PAM\SMP\export_kobo.csv"
  /ENCODING="UTF8"
  /DELIMITERS=","
  /QUALIFIER='"'
  /ARRANGEMENT=DELIMITED
  /FIRSTCASE=2
  /IMPORTCASE=ALL
  /VARIABLES=ALL.
CACHE.
EXECUTE.
DATASET NAME smp WINDOW=FRONT.

* ------------------------------------------------------------------------------------.
* 2. VERSIONS "coalesce(x,0)" : copie numerique avec SYSMIS -> 0.
*    (SPSS n'a pas coalesce ; on cree des variables z* neutralisant les valeurs manquantes).
* ------------------------------------------------------------------------------------.
* Liste des variables numeriques utilisees dans les controles et le scoring.
* (Si une variable est absente de votre export, commentez la ligne correspondante.).

* -- Effectifs / assiduite --.
COMPUTE zDIRNbEnrChildM      = DIRNbEnrChildM.
COMPUTE zDIRNbEnrChildF      = DIRNbEnrChildF.
COMPUTE zDIRAttendAbsentM    = DIRAttendAbsentM.
COMPUTE zDIRAttendAbsentF    = DIRAttendAbsentF.
COMPUTE zDIRNBDisabChildrenM = DIRNBDisabChildrenM.
COMPUTE zDIRNBDisabChildrenF = DIRNBDisabChildrenF.
COMPUTE zDIRNBSchMealsProvided = DIRNBSchMealsProvided.
* -- Stocks (repeat produit ; presents si vous travaillez sur le fichier produit) --.
COMPUTE zMOComOpeningBalance = MOComOpeningBalance.
COMPUTE zMOComReceived       = MOComReceived.
COMPUTE zMOComDamaged        = MOComDamaged.
COMPUTE zMOComDistributed    = MOComDistributed.
* -- Eleve (repeat eleve) --.
COMPUTE zSTUComeSchool       = STUComeSchool.
COMPUTE zSTUNbEatMeal        = STUNbEatMeal.
EXECUTE.

RECODE
  zDIRNbEnrChildM zDIRNbEnrChildF zDIRAttendAbsentM zDIRAttendAbsentF
  zDIRNBDisabChildrenM zDIRNBDisabChildrenF zDIRNBSchMealsProvided
  zMOComOpeningBalance zMOComReceived zMOComDamaged zMOComDistributed
  zSTUComeSchool zSTUNbEatMeal
  (SYSMIS=0).
EXECUTE.

* ------------------------------------------------------------------------------------.
* 3. LES 7 CONTROLES QUALITE (miroir des notes dq_* du XLSForm) -> indicateurs 0/1.
* ------------------------------------------------------------------------------------.
COMPUTE DQ1_meals_gt20      = (zDIRNBSchMealsProvided > 20 AND zDIRNBSchMealsProvided <> 888).
COMPUTE DQ2_absent_gt_enrol = ((zDIRAttendAbsentM + zDIRAttendAbsentF) >
                               (zDIRNbEnrChildM + zDIRNbEnrChildF)).
COMPUTE DQ3_disab_gt_enrol  = ((zDIRNBDisabChildrenM + zDIRNBDisabChildrenF) >
                               (zDIRNbEnrChildM + zDIRNbEnrChildF)).
COMPUTE DQ4_stu_days_gt5    = (zSTUComeSchool > 5).
COMPUTE DQ5_stu_ate_gt_came = (zSTUNbEatMeal > zSTUComeSchool).
COMPUTE MOCloseBalance_chk  = (zMOComOpeningBalance + zMOComReceived - zMOComDamaged - zMOComDistributed).
COMPUTE DQ6_stock_negative  = (MOCloseBalance_chk < 0).
COMPUTE DQ7_distr_gt_avail  = (zMOComDistributed > (zMOComOpeningBalance + zMOComReceived)).
EXECUTE.

VARIABLE LABELS
  DQ1_meals_gt20      "DQ1 - Jours de repas > 20/20"
  DQ2_absent_gt_enrol "DQ2 - Absents > effectif inscrit"
  DQ3_disab_gt_enrol  "DQ3 - Handicap > effectif inscrit"
  DQ4_stu_days_gt5    "DQ4 - Presence eleve > 5 j/semaine"
  DQ5_stu_ate_gt_came "DQ5 - A mange > jours de presence"
  DQ6_stock_negative  "DQ6 - Solde theorique de stock negatif"
  DQ7_distr_gt_avail  "DQ7 - Distribue > stock disponible".

* Indicateur global : au moins une incoherence sur la ligne.
COMPUTE DQ_ANY = ANY(1, DQ1_meals_gt20, DQ2_absent_gt_enrol, DQ3_disab_gt_enrol,
                       DQ4_stu_days_gt5, DQ5_stu_ate_gt_came, DQ6_stock_negative, DQ7_distr_gt_avail).
VARIABLE LABELS DQ_ANY "Ligne avec >=1 incoherence".
EXECUTE.

* ------------------------------------------------------------------------------------.
* 4. RECALCUL DES SCORES (verification independante - niveau site).
*    Hypothese : Oui=1/Non=0 dans les listes Yesno.
* ------------------------------------------------------------------------------------.
* Copies neutralisees supplementaires pour le scoring.
COMPUTE zMOFoodDistrObs=MOFoodDistrObs. COMPUTE zMOFoodPrepAgr=MOFoodPrepAgr.
COMPUTE zMOPercRecSM=MOPercRecSM.
RECODE zMOFoodDistrObs zMOFoodPrepAgr zMOPercRecSM (SYSMIS=0). EXECUTE.

* --- Pilier SERVICE ---.
DO IF (zDIRNBSchMealsProvided=888 OR zDIRNBSchMealsProvided=0).
  COMPUTE sub_serv_cont=0.
ELSE.
  COMPUTE sub_serv_cont=MIN(100,(zDIRNBSchMealsProvided/20)*100).
END IF.
COMPUTE sub_serv_today=(zMOFoodDistrObs=1)*100.
COMPUTE P_SERV=RND(sub_serv_cont*0.70 + sub_serv_today*0.30).

* --- Pilier QUALITE ---.
COMPUTE Q_menu=(zMOFoodPrepAgr=1)*100.
* Diversite alimentaire : adapter selon l'export du select_multiple MealFoodGroups.
* Cas A (une colonne texte "1 3 5") : compter les jetons.
IF (MISSING(MealFoodGroups)) Qdivc=0.
DO IF NOT MISSING(MealFoodGroups).
  COMPUTE Qdivc = 1 + (LENGTH(RTRIM(MealFoodGroups)) - LENGTH(REPLACE(RTRIM(MealFoodGroups)," ",""))).
END IF.
RECODE Qdivc (SYSMIS=0).
DO IF Qdivc<=0.
  COMPUTE Q_div=0.
ELSE IF Qdivc>=7.
  COMPUTE Q_div=100.
ELSE.
  COMPUTE Q_div=(Qdivc/7)*100.
END IF.
DO IF zMOPercRecSM=1.
  COMPUTE Q_finish=100.
ELSE IF zMOPercRecSM=2.
  COMPUTE Q_finish=75.
ELSE IF zMOPercRecSM=3.
  COMPUTE Q_finish=25.
ELSE.
  COMPUTE Q_finish=0.
END IF.
COMPUTE P_QUALITY=RND(Q_menu*0.40 + Q_div*0.40 + Q_finish*0.20).

* --- Pilier HYGIENE & SECURITE (FSQ) ---.
DO IF MISSING(MOHighRiskFoods).
  COMPUTE FSQ_cold=0.
ELSE IF (MOHighRiskFoods=1 AND MOStoredOptTemp=1 AND MOFreezerWorking=1).
  COMPUTE FSQ_cold=1.
ELSE IF (MOHighRiskFoods=1).
  COMPUTE FSQ_cold=0.
ELSE.
  COMPUTE FSQ_cold=1.
END IF.
COMPUTE P_FSQ=(MOCooksGoodHygienePractice=1)*25 + (MOChildWashHands=1)*25 +
              (MOPotWaterAvailable=1)*25 + (FSQ_cold=1)*25.

* --- Pilier ENTREPOSAGE ---.
COMPUTE stor_num = (NOT MISSING(MOWhStackPall)) + (NOT MISSING(MOWhTarps)) + (NOT MISSING(MOWhStackProp))
                 + (NOT MISSING(MOStoreWellSec)) + (NOT MISSING(MOWhStoreVent)) + (NOT MISSING(MOWhStoreDrain)).
COMPUTE stor_sum = (MOWhStackPall=1)+(MOWhTarps=1)+(MOWhStackProp=1)+(MOStoreWellSec=1)+(MOWhStoreVent=1)+(MOWhStoreDrain=1).
DO IF (MOFoodStored=1 AND stor_num>0).
  COMPUTE P_STORAGE=RND((stor_sum/stor_num)*100).
ELSE.
  COMPUTE P_STORAGE=0.
END IF.

* --- Pilier STOCKS & DOCUMENTATION ---.
COMPUTE DOC_den=(ANY(DIRSchAttendanceRecord,0,1,2))+(ANY(DIRSchFeedingRecord,0,1,2))+
                (ANY(DIRCashReceivedRecord,0,1,2))+(ANY(DIRNFIRecRecords,0,1,2))+(ANY(DIRListSupplRecord,0,1,2)).
COMPUTE DOC_num=(ANY(DIRSchAttendanceRecord,1,2))+(ANY(DIRSchFeedingRecord,1,2))+
                (ANY(DIRCashReceivedRecord,1,2))+(ANY(DIRNFIRecRecords,1,2))+(ANY(DIRListSupplRecord,1,2)).
DO IF DOC_den>0.
  COMPUTE DOC_score=RND((DOC_num/DOC_den)*100).
ELSE.
  COMPUTE DOC_score=0.
END IF.
* Concordances waybill/solde : colonnes agregees si presentes, sinon 0.
COMPUTE zARM=0. COMPUTE zABM=0.
IF (NOT MISSING(any_received_match)) zARM=any_received_match.
IF (NOT MISSING(any_balance_match)) zABM=any_balance_match.
COMPUTE P_STOCKS_DOC=RND(((zARM=1)*100*0.40)+((zABM=1)*100*0.40)+(DOC_score*0.20)).

* --- Pilier GOUVERNANCE & AAP ---.
COMPUTE P_GOV_AAP=(MOPTAMgmt=1)*25 + (MOPTAMgmtGender=3)*15 + (HHInfoCFMSupport=1)*20 +
                  (HHAsstUseCFM=1)*15 + (DIRNBSchMealMenu=1)*10 + (DIRContributing=1)*10 + (DIRComplActYN=1)*5.

* --- Pilier RESSOURCES HUMAINES ---.
COMPUTE HR_train=(DIRCooksRecTraining=1)*40.
COMPUTE HR_incent=(DIRCooksRecIncentives=1)*20.
COMPUTE zA=0. COMPUTE zB=0.
IF (NOT MISSING(DIRAvgDailyCooks)) zA=DIRAvgDailyCooks.
IF (NOT MISSING(MONbCooksVisit))  zB=MONbCooksVisit.
DO IF (zA=0 OR zB=0 OR zB=888).
  COMPUTE HR_align=0.
ELSE IF (ABS(zB-zA)<=1).
  COMPUTE HR_align=40.
ELSE IF (ABS(zB-zA)<=2).
  COMPUTE HR_align=30.
ELSE IF (ABS(zB-zA)<=3).
  COMPUTE HR_align=20.
ELSE.
  COMPUTE HR_align=10.
END IF.
COMPUTE P_HR=HR_train+HR_incent+HR_align.

* --- Pilier INTEGRITE ASSIDUITE ---.
DO IF (MISSING(DIRDiscRec) AND MISSING(DIRDiscDailyRec)).
  COMPUTE P_ATT_INTEGRITY=0.
ELSE.
  COMPUTE P_ATT_INTEGRITY=100-((DIRDiscRec=1)*50 + (DIRDiscDailyRec=1)*50).
END IF.

* --- Infrastructure WASH (SanitaryLevel 0-3 -> %) ---.
COMPUTE latmap=MOLatrines.  COMPUTE hwmap=MOHandwashing.  COMPUTE wcmap=MOWaterCook.
RECODE latmap hwmap wcmap (3=100)(2=50)(1=25)(0=0)(ELSE=0).
COMPUTE wnum=(NOT MISSING(MOLatrines))+(NOT MISSING(MOHandwashing))+(NOT MISSING(MOWaterCook)).
COMPUTE wsum= latmap*(NOT MISSING(MOLatrines)) + hwmap*(NOT MISSING(MOHandwashing)) + wcmap*(NOT MISSING(MOWaterCook)).
DO IF wnum>0.
  COMPUTE WASH_infra=RND(wsum/wnum).
ELSE.
  COMPUTE WASH_infra=0.
END IF.
EXECUTE.

* --- DOMAINES SECTORIELS ET SCORE FINAL /100 ---.
COMPUTE D_LOG = RND(P_STOCKS_DOC*0.5 + P_STORAGE*0.5).
COMPUTE D_NUT = RND(P_SERV*0.5 + P_QUALITY*0.5).
COMPUTE D_WASH= RND(P_FSQ*0.6 + WASH_infra*0.4).
COMPUTE D_COM = RND(P_GOV_AAP).
COMPUTE D_SCH = RND(P_ATT_INTEGRITY*0.5 + P_HR*0.5).
COMPUTE PERF_SECT_100 = RND(D_NUT*0.25 + D_LOG*0.20 + D_WASH*0.20 + D_COM*0.20 + D_SCH*0.15).

STRING perf_class (A12).
DO IF PERF_SECT_100>=80.
  COMPUTE perf_class="Excellente".
ELSE IF PERF_SECT_100>=60.
  COMPUTE perf_class="Moyenne".
ELSE.
  COMPUTE perf_class="Insuffisante".
END IF.
VARIABLE LABELS PERF_SECT_100 "Score de performance sectoriel /100"
                perf_class "Classe de performance EPP".
EXECUTE.

* ------------------------------------------------------------------------------------.
* 5. RAPPORT : FREQUENCES DES INCOHERENCES ET SYNTHESE DES SCORES.
* ------------------------------------------------------------------------------------.
FREQUENCIES VARIABLES=DQ1_meals_gt20 DQ2_absent_gt_enrol DQ3_disab_gt_enrol
  DQ4_stu_days_gt5 DQ5_stu_ate_gt_came DQ6_stock_negative DQ7_distr_gt_avail DQ_ANY
  /ORDER=ANALYSIS.

FREQUENCIES VARIABLES=perf_class /ORDER=ANALYSIS.

DESCRIPTIVES VARIABLES=D_NUT D_LOG D_WASH D_COM D_SCH PERF_SECT_100
  /STATISTICS=MEAN STDDEV MIN MAX.

* ------------------------------------------------------------------------------------.
* 6. LISTE DETAILLEE DES LIGNES INCOHERENTES (a transmettre aux superviseurs).
* ------------------------------------------------------------------------------------.
TEMPORARY.
SELECT IF (DQ_ANY=1).
LIST VARIABLES=Adm1Code_SMP Adm2Code_SMP Adm4Code_SMP
  DQ1_meals_gt20 DQ2_absent_gt_enrol DQ3_disab_gt_enrol
  DQ4_stu_days_gt5 DQ5_stu_ate_gt_came DQ6_stock_negative DQ7_distr_gt_avail.

* ------------------------------------------------------------------------------------.
* 7. SYNTHESE PAR REGION (DREN) - score moyen et taux d'incoherence.
* ------------------------------------------------------------------------------------.
DATASET DECLARE synth_region.
AGGREGATE
  /OUTFILE='synth_region'
  /BREAK=Adm1Code_SMP
  /Nb_ecoles=N
  /Score_moyen=MEAN(PERF_SECT_100)
  /Pct_incoherence=MEAN(DQ_ANY)
  /Pct_insuffisante=PIN(PERF_SECT_100, 0, 59).
DATASET ACTIVATE synth_region.
LIST.
DATASET ACTIVATE smp.

* ------------------------------------------------------------------------------------.
* 8. EXPORT DU JEU DE DONNEES ENRICHI (scores + drapeaux qualite).
* ------------------------------------------------------------------------------------.
SAVE OUTFILE="C:\PAM\SMP\smp_qualite_scores.sav"
  /KEEP=Adm1Code_SMP Adm2Code_SMP Adm4Code_SMP
        D_NUT D_LOG D_WASH D_COM D_SCH PERF_SECT_100 perf_class
        DQ1_meals_gt20 DQ2_absent_gt_enrol DQ3_disab_gt_enrol DQ4_stu_days_gt5
        DQ5_stu_ate_gt_came DQ6_stock_negative DQ7_distr_gt_avail DQ_ANY.
EXECUTE.

* ============================== FIN DE LA SYNTAXE ===================================.
