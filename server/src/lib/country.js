import { db } from "../db.js";
import { LEVELS } from "./geo.js";

/* ═══════════════════════════════════════════════════════════════════════
   Le pays courant, et le vocabulaire de son découpage.

   « Régions / Districts / Communes / Fokontany » est le vocabulaire de
   Madagascar, pas celui d'un système de suivi. Il figurait en dur dans huit
   endroits de l'interface, et le premier autre pays aurait obligé à les
   retrouver un par un — en en oubliant, comme toujours.

   Une seule fonction les rend désormais, et l'interface ne connaît plus que
   `adm0` à `adm4`, ce que le schéma a toujours utilisé.
   ═══════════════════════════════════════════════════════════════════════ */

/* Repli quand aucun pays n'est configuré — base neuve, ou migration non
   appliquée. On rend les codes eux-mêmes plutôt qu'un vocabulaire inventé : un
   écran qui affiche « adm3 » indique qu'il manque une configuration, un écran qui
   affiche « Commune » sur un pays qui n'en a pas ment. */
const REPLI = {
  code:"", name:"", currency:"USD", lat:null, lon:null,
  levels: Object.fromEntries(LEVELS.map(l => [l, { one:l, many:l }])),
};

function parseLevels(json){
  let l;
  try{ l = JSON.parse(json || "{}"); }catch(e){ l = {}; }
  /* Chaque niveau doit avoir ses deux formes : un libellé manquant retombe sur le
     code du niveau, jamais sur le libellé d'un autre pays. */
  return Object.fromEntries(LEVELS.map(k => {
    const v = l[k];
    if(typeof v === "string") return [k, { one:v, many:v }];
    return [k, { one: v?.one || k, many: v?.many || v?.one || k }];
  }));
}

const shape = (c) => ({
  code:c.code, name:c.name, currency:c.currency, lat:c.lat, lon:c.lon,
  levels: parseLevels(c.levels), active:!!c.active, current:!!c.is_current,
  note:c.note || "", rev:c.rev,
});

export async function currentCountry(){
  const c = await db.prepare("SELECT * FROM country WHERE is_current=1").get();
  return c ? shape(c) : REPLI;
}

export async function allCountries(){
  const rows = await db.prepare("SELECT * FROM country ORDER BY name").all();
  const out = [];
  for(const c of rows){
    /* Combien de millésimes de découpage ce pays porte : c'est ce qui rend un
       pays exploitable ou non. */
    const versions = (await db.prepare("SELECT COUNT(*) n FROM geo_version WHERE country=?").get(c.code)).n;
    out.push({ ...shape(c), versions });
  }
  return out;
}

/* Le libellé d'un niveau, au singulier ou au pluriel. La seule porte d'entrée. */
export async function levelLabel(level, plural = false){
  const l = (await currentCountry()).levels[level];
  return l ? (plural ? l.many : l.one) : level;
}

/* La devise par défaut d'un montant local — contrat de prestataire, barème.
   Le plan MRE reste en dollars : il n'est pas local, il est corporate. */
export const localCurrency = async () => (await currentCountry()).currency || "USD";

export { parseLevels, shape as shapeCountry };
