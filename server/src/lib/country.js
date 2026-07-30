import { db } from "../db.js";
import { LEVELS } from "./geo.js";
import { ctxCountry } from "./ctx.js";

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

/* Le pays par défaut de l'instance. Ce n'est plus « le pays courant » : avec
   plusieurs pays servis, un drapeau global serait un état partagé que deux comptes
   de deux pays se disputeraient. C'est seulement le pays d'un compte qui n'en
   déclare aucun, et celui qu'un nouveau compte reçoit. */
export function defaultCountry(){
  const c = db.prepare("SELECT * FROM country WHERE is_current=1").get()
    || db.prepare("SELECT * FROM country WHERE active=1 ORDER BY name LIMIT 1").get();
  return c ? shape(c) : REPLI;
}

/* Le pays d'un compte — celui dont il voit les données et dont il lit le
   vocabulaire. Un compte sans pays n'est borné à aucun : c'est le cas d'un bureau
   régional, qui supervise plusieurs pays, et de l'administrateur de l'instance.
   Il travaille alors dans le pays par défaut, et peut en changer.

   `wanted` permet à un compte non borné de se placer dans un autre pays le temps
   d'une requête. Un compte borné ne peut pas en sortir : la demande est ignorée,
   silencieusement et volontairement — répondre 403 apprendrait à un utilisateur
   qu'un autre pays existe, ce qui n'est pas son affaire. */
export function countryFor(user, wanted = null){
  if(user?.country_code){
    const c = db.prepare("SELECT * FROM country WHERE code=?").get(user.country_code);
    if(c) return shape(c);
  }
  if(wanted){
    const c = db.prepare("SELECT * FROM country WHERE code=? AND active=1").get(String(wanted).toUpperCase());
    if(c) return shape(c);
  }
  return defaultCountry();
}

/* Le pays de la requête en cours, ou celui de l'instance hors requête. C'est ce
   que lisent les bibliothèques qui n'ont pas d'utilisateur sous la main. */
export function currentCountry(){
  return ctxCountry() || defaultCountry();
}

/* Le pays d'une entité qu'on CRÉE — bureau, prestataire, activité du plan MRE.

   L'ordre est volontaire. Le pays du compte passe en premier et ne se discute pas :
   sinon un compte borné écrirait chez le voisin en changeant un champ de formulaire,
   et le cloisonnement en lecture ne servirait à rien. Vient ensuite le pays demandé
   explicitement, puis celui dans lequel le compte travaille.

   Rend `{ code }` ou `{ error }` — jamais un pays deviné : rattacher au hasard une
   entité qu'on retrouverait des mois plus tard dans le mauvais pays est pire que
   refuser la création. */
export function writeCountry(user, wanted = null){
  if(user?.country_code) return { code: user.country_code };
  const code = String(wanted || ctxCountry()?.code || "").toUpperCase();
  if(!code) return { error:"aucun pays n'est configuré : configurez-en un avant de saisir" };
  const c = db.prepare("SELECT code, name, active FROM country WHERE code=?").get(code);
  if(!c) return { error:`le pays ${code} n'est pas configuré` };
  if(!c.active) return { error:`le pays ${c.name} est désactivé` };
  return { code:c.code };
}

export function allCountries(){
  return db.prepare("SELECT * FROM country ORDER BY name").all().map(c => ({
    ...shape(c),
    /* Combien de millésimes de découpage ce pays porte : c'est ce qui rend un
       pays exploitable ou non. */
    versions: db.prepare("SELECT COUNT(*) n FROM geo_version WHERE country=?").get(c.code).n,
  }));
}

/* Le libellé d'un niveau, au singulier ou au pluriel. La seule porte d'entrée. */
export function levelLabel(level, plural = false, user = null){
  const l = (user ? countryFor(user) : currentCountry()).levels[level];
  return l ? (plural ? l.many : l.one) : level;
}

/* La devise d'un montant local — contrat de prestataire, barème. Celle du pays de
   l'utilisateur, pas celle de l'instance : c'est tout l'intérêt du rattachement.
   Le plan MRE reste en dollars, il n'est pas local mais corporate. */
export const localCurrency = (user = null) =>
  (user ? countryFor(user) : currentCountry()).currency || "USD";

export { parseLevels, shape as shapeCountry };
