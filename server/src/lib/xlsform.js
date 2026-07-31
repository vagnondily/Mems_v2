import ExcelJS from "exceljs";

/* Lecture d'un XLSForm (le format de formulaire d'ODK Central et de
   KoboToolbox : trois feuilles `survey`, `choices`, `settings`).
 *
 * Ce code vivait dans le script de ligne de commande import-odk-forms.js et n'y
 * était atteignable que depuis un terminal. Il est ici pour que le serveur
 * puisse rendre le même service à l'interface : le navigateur téléversait le
 * fichier et le lisait lui-même avec SheetJS (`xlsx`), un paquet qui porte deux
 * failles connues, qui a quitté le registre npm et dont la seule version
 * corrigée s'installe depuis un CDN tiers. Faire lire le fichier par le serveur
 * — qui a déjà exceljs pour les modèles d'import — supprime la faille et la
 * dépendance d'un seul geste.
 */

/* Un .xlsx est une archive ZIP. Un fichier de quelques centaines de kilo-octets
   peut en contenir plusieurs gigaoctets une fois décompressé, et exceljs
   décompresse chaque entrée sans plafond : le processus meurt avant d'avoir pu
   refuser quoi que ce soit. On inspecte donc le manifeste AVANT toute
   inflation. Aucun avis de sécurité ne couvre ce cas — npm audit ne le voit
   pas — mais le chemin est atteignable par tout compte autorisé à téléverser. */
const ENTREES_OOXML = /^(\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/|customXml\/)/;
const PLAFOND_ABSOLU = 200 * 1024 * 1024;
const RATIO_MAX = 100;

export async function verifierArchive(buffer){
  /* JSZip arrive avec exceljs ; on ne l'ajoute pas au manifeste pour cela. */
  const { default: JSZip } = await import("jszip");
  let zip;
  try{ zip = await JSZip.loadAsync(buffer); }
  catch(e){ throw new Error("fichier illisible : ce n'est pas un classeur .xlsx valide"); }

  let total = 0;
  for(const [nom, entree] of Object.entries(zip.files)){
    if(entree.dir) continue;
    if(!ENTREES_OOXML.test(nom))
      throw new Error(`entrée inattendue dans le classeur : « ${nom.slice(0, 80)} ». `
        + "Un .xlsx ne contient que les pièces du format Office.");
    /* _data.uncompressedSize est lu dans l'en-tête de l'archive, donc avant
       toute décompression. Il peut mentir : le plafond reste vérifié plus bas
       par la taille réellement lue par exceljs, mais ce premier filtre écarte
       le cas courant à coût nul. */
    total += entree._data?.uncompressedSize || 0;
  }
  const plafond = Math.min(PLAFOND_ABSOLU, buffer.length * RATIO_MAX);
  if(total > plafond)
    throw new Error(`classeur refusé : ${Math.round(total / 1048576)} Mo une fois décompressé, `
      + `pour ${Math.round(buffer.length / 1024)} Ko compressés. Taux d'expansion anormal.`);
  return true;
}

const enTetes = (ws) => {
  const h = [];
  ws.getRow(1).eachCell((cell, col) => { h[col] = String(cell.value ?? "").trim(); });
  return h;
};
const colonne = (headers, nom) => headers.findIndex(h => h === nom);

/* L'ordre des colonnes de libellé n'est pas indifférent : les formulaires du
   bureau Madagascar portent le français en premier, l'anglais en repli. On
   prend le premier libellé renseigné, pas le premier en-tête trouvé. */
const COLS_LABEL = [
  "label::Français (fr)", "label::French (fr)", "label::Francais (fr)",
  "label::English (en)", "label",
];

/* Les lignes de structure d'un XLSForm portent un `name` sans être des
   questions. Les empiler avec les autres fausse toute détection automatique du
   champ « site » ou « date » : le premier candidat d'un formulaire réel est un
   begin_group, pas une question. */
const TYPES_STRUCTURE = /^(begin[ _](group|repeat)|end[ _](group|repeat)|note|calculate)$/i;

export function lireClasseur(wb){
  const settingsWs = wb.getWorksheet("settings");
  const settings = {};
  if(settingsWs){
    const h = enTetes(settingsWs);
    const l2 = settingsWs.getRow(2);
    h.forEach((nom, c) => { if(nom) settings[nom] = valeurBrute(l2.getCell(c).value); });
  }

  const surveyWs = wb.getWorksheet("survey");
  if(!surveyWs) throw new Error('feuille « survey » introuvable : ce n\'est pas un XLSForm.');
  const h = enTetes(surveyWs);
  const cNom = colonne(h, "name"), cType = colonne(h, "type");
  if(cNom < 0) throw new Error('la feuille « survey » n\'a pas de colonne « name ».');
  const cLabels = COLS_LABEL.map(x => colonne(h, x)).filter(c => c > 0);

  const vars = [];
  const labels = {};
  surveyWs.eachRow((row, n) => {
    if(n === 1) return;
    const name = String(row.getCell(cNom).value ?? "").trim();
    if(!name) return;
    const type = cType > 0 ? String(row.getCell(cType).value ?? "").trim() : "";
    let label = "";
    for(const c of cLabels){ const v = row.getCell(c).value; if(v){ label = valeurBrute(v); break; } }
    if(label) labels[name] = label;
    vars.push({ name, type, label, structure: TYPES_STRUCTURE.test(type) });
  });

  /* Les listes de choix servent à savoir ce que contient réellement un champ
     `select_one` : sans elles, on ne peut pas dire si le champ « site » porte
     un p-code, un code métier ou du texte libre. */
  const choicesWs = wb.getWorksheet("choices");
  const choices = {};
  if(choicesWs){
    const hc = enTetes(choicesWs);
    const cListe = colonne(hc, "list_name") >= 0 ? colonne(hc, "list_name") : colonne(hc, "list name");
    const cVal = colonne(hc, "name");
    const cLab = COLS_LABEL.map(x => colonne(hc, x)).filter(c => c > 0);
    if(cListe > 0 && cVal > 0){
      choicesWs.eachRow((row, n) => {
        if(n === 1) return;
        const liste = String(row.getCell(cListe).value ?? "").trim();
        const val = String(row.getCell(cVal).value ?? "").trim();
        if(!liste || !val) return;
        let lab = "";
        for(const c of cLab){ const v = row.getCell(c).value; if(v){ lab = valeurBrute(v); break; } }
        (choices[liste] = choices[liste] || []).push({ value: val, label: lab });
      });
    }
  }

  return { settings, vars, labels, choices };
}

/* ExcelJS rend parfois un objet ({richText}, {text, hyperlink}, {formula, result}) */
function valeurBrute(v){
  if(v == null) return "";
  if(typeof v === "object"){
    if(Array.isArray(v.richText)) return v.richText.map(x => x.text).join("").trim();
    if(v.text != null) return String(v.text).trim();
    if(v.result != null) return String(v.result).trim();
    if(v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v).trim();
}

/* Point d'entrée depuis un fichier sur disque (script de ligne de commande). */
export async function lireXlsFormFichier(chemin){
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(chemin);
  return lireClasseur(wb);
}

/* Point d'entrée depuis un téléversement (route HTTP). */
export async function lireXlsFormBuffer(buffer){
  await verifierArchive(buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return lireClasseur(wb);
}
