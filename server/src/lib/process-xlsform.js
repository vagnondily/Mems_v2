/* ══════════════════ Extraction des indicateurs de suivi de processus ══════════════════
   Lit un XLSForm (onglets survey / choices / settings) et en tire le SQUELETTE
   des variables de suivi : une entrée par question réelle, avec son libellé, son
   type, le module thématique (groupe) qui la porte, et ses choix éventuels.

   « Extrais les variables name et label. » On ne garde donc que ce que l'œil
   lit : on saute les lignes de structure (begin/end group/repeat), les métadonnées
   ODK (start, end, deviceid…), les notes et les calculs sans libellé. Le module
   d'une question est le libellé du groupe le PLUS EXTERNE qui en porte un — la
   section, non la sous-question — pour un regroupement lisible sur le tableau
   de bord. */

/* Une cellule Excel n'est pas toujours une chaîne : texte enrichi, formule, lien.
   On ne veut que le texte affiché. */
const txt = (v) => {
  if(v == null) return "";
  if(typeof v === "object"){
    if(Array.isArray(v.richText)) return v.richText.map(t => t.text).join("");
    if(v.text != null) return String(v.text);
    if(v.result != null) return String(v.result);
    if(v.hyperlink && v.text != null) return String(v.text);
    return "";
  }
  return String(v);
};
const propre = (v) => txt(v).replace(/\s+/g, " ").trim();

/* Colonnes de libellé, par ordre de préférence — le français d'abord. */
const COLS_LABEL = ["label::Français (fr)", "label::French (fr)", "label::Francais (fr)",
  "label::fr", "label:French", "label", "label::English (en)", "label::en", "label:English"];

/* Types de STRUCTURE : ouvrent/ferment un groupe ou une répétition. */
const RE_DEBUT = /^begin[ _](group|repeat)/i;
const RE_FIN   = /^end[ _](group|repeat)/i;
/* Types/nom de MÉTADONNÉES à ignorer — ni questions ni indicateurs. */
const TYPES_META = /^(note|calculate|start|end|today|deviceid|subscriberid|simserial|phonenumber|username|audit|hidden|acknowledge|image|audio|video|file|background-audio)$/i;
const NOMS_META  = /^(start|end|today|deviceid|subscriberid|simserial|phonenumber|username|instanceID|instanceName|__version__|meta|audit)$/i;

/* Repère la colonne d'un en-tête (insensible à la casse / aux espaces). */
function indexColonne(entetes, candidats){
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const H = entetes.map(norm);
  for(const c of candidats){ const i = H.indexOf(norm(c)); if(i >= 0) return i; }
  return -1;
}

/* Le premier segment du type XLSForm : « select_one Yesno » → « select_one ». */
const typeBase = (t) => String(t || "").trim().split(/\s+/)[0].toLowerCase();
/* La liste de choix référencée : « select_one Yesno » → « Yesno ». */
const typeListe = (t) => { const m = String(t || "").trim().match(/^select_(one|multiple)(?:_from_file)?\s+(\S+)/i); return m ? m[2] : ""; };

/* Lit l'onglet choices en dictionnaire liste → [{value,label}]. */
function lireChoix(ws){
  const out = {};
  if(!ws) return out;
  const entetes = (ws.getRow(1).values || []).slice(1).map(v => propre(v));
  const cListe = indexColonne(entetes, ["list_name", "list name", "listname"]);
  const cVal   = indexColonne(entetes, ["name", "value"]);
  const cLab   = (() => { for(const c of COLS_LABEL){ const i = indexColonne(entetes, [c]); if(i >= 0) return i; } return -1; })();
  if(cListe < 0 || cVal < 0) return out;
  ws.eachRow((row, rn) => {
    if(rn === 1) return;
    const vals = (row.values || []).slice(1);
    const liste = propre(vals[cListe]); if(!liste) return;
    const value = propre(vals[cVal]);
    const label = cLab >= 0 ? propre(vals[cLab]) : value;
    (out[liste] ||= []).push({ value, label: label || value });
  });
  return out;
}

/* Extrait les indicateurs d'un classeur XLSForm déjà chargé (ExcelJS.Workbook). */
export function extraireIndicateursProcessus(wb, { maxChoix = 30 } = {}){
  const survey = wb.getWorksheet("survey");
  if(!survey) return { formTitle: "", rows: [] };

  const settings = wb.getWorksheet("settings");
  let formTitle = "";
  if(settings){
    const sh = (settings.getRow(1).values || []).slice(1).map(v => propre(v));
    const sv = (settings.getRow(2).values || []).slice(1).map(v => propre(v));
    const iT = indexColonne(sh, ["form_title", "form title"]);
    const iI = indexColonne(sh, ["form_id", "form id"]);
    formTitle = (iT >= 0 && sv[iT]) || (iI >= 0 && sv[iI]) || "";
  }

  const entetes = (survey.getRow(1).values || []).slice(1).map(v => propre(v));
  const cType = indexColonne(entetes, ["type"]);
  const cName = indexColonne(entetes, ["name"]);
  const cLabel = (() => { for(const c of COLS_LABEL){ const i = indexColonne(entetes, [c]); if(i >= 0) return i; } return -1; })();
  if(cType < 0 || cName < 0) return { formTitle, rows: [] };

  const choix = lireChoix(wb.getWorksheet("choices"));
  const pile = [];              /* groupes ouverts : [{code,label}] */
  const rows = [];
  let ord = 0;

  survey.eachRow((row, rn) => {
    if(rn === 1) return;
    const vals = (row.values || []).slice(1);
    const type = propre(vals[cType]);
    const name = propre(vals[cName]);
    const label = cLabel >= 0 ? propre(vals[cLabel]) : "";
    if(!type) return;

    if(RE_DEBUT.test(type)){ pile.push({ code: name, label }); return; }
    if(RE_FIN.test(type)){ pile.pop(); return; }

    const base = typeBase(type);
    if(TYPES_META.test(base) || NOMS_META.test(name)) return;
    if(!name) return;

    /* Module = libellé du groupe le plus EXTERNE qui en porte un (la section). */
    const section = pile.find(g => g.label) || pile[0] || null;
    const liste = typeListe(type);
    const ch = liste && choix[liste] ? choix[liste].slice(0, maxChoix) : null;

    rows.push({
      name, type: base, typeComplet: type, label,
      module: section?.label || "", moduleCode: section?.code || "",
      choices: ch, ord: ord++,
    });
  });

  return { formTitle, rows };
}

export { txt as texteCellule };
