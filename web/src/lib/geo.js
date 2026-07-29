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
  const [state, setState] = useState({ ...EMPTY, codes:{}, loading:true });
  const { adm1, adm2, adm3 } = sel;

  useEffect(() => {
    let alive = true;
    (async () => {
      const out = { ...EMPTY }, codes = {};
      out.adm1 = await levels(null);
      /* On descend tant que le niveau courant est choisi et reconnu. */
      let parent = null;
      for(let i = 0; i < LEVELS.length - 1; i++){
        const name = [adm1, adm2, adm3][i];
        const hit = name ? out[LEVELS[i]].find(x => x.name === name) : null;
        if(!hit) break;
        codes[LEVELS[i]] = hit.pcode;
        parent = hit.pcode;
        out[LEVELS[i+1]] = await levels(parent);
      }
      if(alive) setState({ ...out, codes, loading:false });
    })();
    return () => { alive = false; };
  }, [adm1, adm2, adm3]);

  return state;
}

/* Options prêtes pour <Select> : la liste des noms d'un niveau. */
export const names = (rows) => rows.map(r => r.name);
