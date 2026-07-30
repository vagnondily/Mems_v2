import { useEffect, useState } from "react";
import { api } from "./api.js";

/* Le référentiel ne transite plus par /state : à ~18 000 fokontany il pesait plus
   que tout le reste réuni, et se retrouvait tronqué. L'interface demande au serveur
   les enfants de ce qu'elle affiche, niveau par niveau.

   Les sites et le plan de distribution portent leurs niveaux administratifs sous
   forme de noms, pas de codes. La cascade navigue donc par code en interne, mais
   s'utilise avec des noms — ce qui évite de migrer les données existantes. */

const LEVELS = ["adm1","adm2","adm3","adm4"];
const EMPTY = { adm1:[], adm2:[], adm3:[], adm4:[] };

/* Un même millésime est demandé par toutes les vues : on garde les réponses.
   Le cache est vidé après un import, via resetGeoCache(). */
const cache = new Map();
async function levels(parent){
  const key = parent || "__top__";
  if(cache.has(key)) return cache.get(key);
  const p = api.geoLevels(parent ? `?parent=${encodeURIComponent(parent)}` : "")
    .then(r => r.rows || []).catch(() => []);
  cache.set(key, p);
  return p;
}
export function resetGeoCache(){ cache.clear(); }

/* `sel` porte les noms choisis : { adm1, adm2, adm3 }.
   Retourne les options de chaque niveau, et les codes correspondants. */
export function useGeoCascade(sel = {}){
  const [state, setState] = useState({ ...EMPTY, codes:{}, pcode:null, loading:true });
  const { adm1, adm2, adm3, adm4 } = sel;

  useEffect(() => {
    let alive = true;
    (async () => {
      const out = { ...EMPTY }, codes = {};
      out.adm1 = await levels(null);
      /* On descend tant que le niveau courant est choisi et reconnu. */
      const chosen = [adm1, adm2, adm3, adm4];
      for(let i = 0; i < LEVELS.length; i++){
        const hit = chosen[i] ? out[LEVELS[i]].find(x => x.name === chosen[i]) : null;
        if(!hit) break;
        codes[LEVELS[i]] = hit.pcode;
        if(i + 1 < LEVELS.length) out[LEVELS[i+1]] = await levels(hit.pcode);
      }
      /* Le rattachement retenu est le niveau le plus profond effectivement choisi. */
      const pcode = codes.adm4 || codes.adm3 || codes.adm2 || codes.adm1 || null;
      if(alive) setState({ ...out, codes, pcode, loading:false });
    })();
    return () => { alive = false; };
  }, [adm1, adm2, adm3, adm4]);

  return state;
}

/* Options prêtes pour <Select> : la liste des noms d'un niveau. */
export const names = (rows) => rows.map(r => r.name);
