/* ═══════════════════════════════════════════════════════════════════════
   DISSOLUTION — dériver les contours d'un niveau depuis celui du dessous

   Le propriétaire n'a qu'un fichier : le découpage aux COMMUNES
   (`mdg_bnd_adm3_com_pam_2025`). Or sa table attributaire porte déjà
   l'arbre complet — ADM0..3_EN et ADM0..3_PCODE —, si bien que chaque
   commune SAIT à quel district et à quelle région elle appartient. Les
   contours des niveaux supérieurs ne sont donc pas une donnée manquante :
   ce sont les mêmes polygones, réunis par parent. « Tu peux utiliser le
   dbf de adm3 ou adm4 pour les dériver. »

   ── Réunir, et non empiler ───────────────────────────────────────────
   La solution paresseuse serait de rendre, pour chaque district, un
   MultiPolygon de ses communes. Le remplissage serait juste, mais le TRAIT
   dessinerait toutes les limites communales sous l'étiquette « districts » :
   la carte afficherait un découpage aux communes en prétendant montrer les
   districts. Ce serait faux là où ça compte — le trait EST l'information
   d'une carte de découpage.

   On dissout donc pour de bon, par ANNULATION D'ARÊTES : une frontière
   entre deux communes du même district est parcourue deux fois, une fois
   dans chaque sens, par les deux polygones qui la partagent. Ces deux
   parcours s'annulent ; ne survivent que les arêtes parcourues une seule
   fois, c'est-à-dire la frontière extérieure du district. Les arêtes
   restantes sont ensuite recousues en anneaux.

   Cette méthode ne demande aucune bibliothèque géométrique et n'a aucun
   cas dégénéré silencieux — soit les anneaux se referment, soit ils ne se
   referment pas, et on le sait. Elle suppose en revanche que deux communes
   voisines partagent EXACTEMENT les mêmes sommets. C'est vrai d'un fichier
   COD-AB, découpé depuis une topologie unique ; ce ne l'est pas de deux
   fichiers d'origines différentes recollés. D'où le repli explicite : quand
   la couture échoue, on rend l'assemblage des polygones enfants et on le
   DIT (`approximatif`), plutôt que de rendre un contour faux sans le dire.
   ═══════════════════════════════════════════════════════════════════════ */

/* Quantification des sommets : au dix-millionième de degré, soit environ un
   centimètre. Deux sommets « identiques » d'un même fichier le sont au bit
   près ; l'arrondi protège des écritures décimales qui diffèrent d'un ULP
   sans changer le point. */
const Q = 1e7;
const cle = (p) => `${Math.round(p[0] * Q)}:${Math.round(p[1] * Q)}`;

/* Aire signée d'un anneau. Négative = extérieur, positive = trou : c'est la
   convention que porte déjà `lib/shapefile.js` en lisant les .shp, et la
   dissolution la préserve puisqu'elle ne fait que retirer des arêtes. */
function aireSignee(r){
  let a = 0;
  for(let i = 0, j = r.length - 1; i < r.length; j = i++)
    a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

/* Après annulation, les extrémités de la frontière disparue restent souvent
   comme sommets ALIGNÉS au milieu d'un segment droit : réunir deux carrés
   mitoyens donne un rectangle décrit par six sommets au lieu de quatre. Ces
   points ne portent aucune information — les retirer allège le contour sans
   le changer d'un iota.

   Le test d'alignement est EXACT, mené sur les coordonnées quantifiées, qui
   sont des entiers : pas de tolérance choisie au jugé, donc pas de sommet
   supprimé « presque » à tort. Il est abandonné sur les très longs segments,
   dont le produit sortirait du domaine où un double représente les entiers
   exactement — on garde alors le sommet, ce qui est le repli sûr. */
const SUR = 1e8;                                  /* ≈ 10 degrés en unités quantifiées */
function nettoyerAnneau(r){
  if(r.length < 5) return r;
  const q = r.map(p => [Math.round(p[0] * Q), Math.round(p[1] * Q)]);
  const garde = new Array(r.length).fill(true);
  /* Le dernier point répète le premier : on ne juge que les sommets internes,
     puis le premier lui-même en refermant. */
  for(let i = 1; i < r.length - 1; i++){
    let p = i - 1;
    while(p > 0 && !garde[p]) p--;
    const dx1 = q[i][0] - q[p][0], dy1 = q[i][1] - q[p][1];
    const dx2 = q[i + 1][0] - q[i][0], dy2 = q[i + 1][1] - q[i][1];
    if(Math.abs(dx1) > SUR || Math.abs(dy1) > SUR
       || Math.abs(dx2) > SUR || Math.abs(dy2) > SUR) continue;
    if(dx1 * dy2 - dy1 * dx2 === 0) garde[i] = false;
  }
  const out = r.filter((_, i) => garde[i]);
  return out.length >= 4 ? out : r;
}

const anneauxDe = (g) => !g ? []
  : g.type === "Polygon" ? g.coordinates
  : g.type === "MultiPolygon" ? g.coordinates.flat()
  : [];

/* Point dans anneau — lancer de rayon. Sert à rattacher un trou à l'anneau
   extérieur qui le contient. */
function dedans(pt, anneau){
  let ok = false;
  for(let i = 0, j = anneau.length - 1; i < anneau.length; j = i++){
    const [xi, yi] = anneau[i], [xj, yj] = anneau[j];
    if((yi > pt[1]) !== (yj > pt[1])
       && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}

/* Assemblage des anneaux en polygones : chaque extérieur avec les trous
   qu'il contient. Les extérieurs sont classés du plus grand au plus petit
   pour qu'un trou tombe dans le plus petit qui le contienne — le cas de
   l'enclave dans l'enclave, rare mais réel. */
function assembler(anneaux){
  const ext = [], trous = [];
  for(const r of anneaux){
    const a = aireSignee(r);
    if(Math.abs(a) < 1e-14) continue;              /* anneau dégénéré */
    (a < 0 ? ext : trous).push({ r, a: Math.abs(a) });
  }
  if(!ext.length) return null;
  ext.sort((x, y) => x.a - y.a);                   /* du plus petit au plus grand */
  const polys = ext.map(e => [e.r]);
  for(const t of trous){
    const i = ext.findIndex(e => e.a > t.a && dedans(t.r[0], e.r));
    if(i >= 0) polys[i].push(t.r);
    /* Un trou que rien ne contient n'est pas un trou : c'est un anneau dont
       l'orientation ment. On le garde comme polygone plein plutôt que de le
       perdre — une île rendue à l'envers vaut mieux qu'une île absente. */
    else polys.push([[...t.r].reverse()]);
  }
  polys.sort((a, b) => Math.abs(aireSignee(b[0])) - Math.abs(aireSignee(a[0])));
  return polys.length === 1
    ? { type:"Polygon", coordinates: polys[0] }
    : { type:"MultiPolygon", coordinates: polys };
}

/* L'assemblage sans dissolution : le FILET. Tous les polygones enfants dans
   un MultiPolygon. Le remplissage est juste, le trait montre les limites
   intérieures — c'est pourquoi l'appelant est prévenu (`approximatif`).

   Il ne sert quasiment jamais : des anneaux fermés en entrée donnent des
   anneaux fermés après annulation, quel que soit leur agencement. Deux
   communes qui ne partagent pas leurs sommets ne font pas ÉCHOUER la
   couture — elles ne fusionnent simplement pas, et le contour rendu porte
   la couture visible. Ce filet couvre les topologies pathologiques (arête
   parcourue trois fois, anneau qui se recoupe) : il vaut mieux un contour
   grossier et annoncé qu'une exception au milieu de cent vingt districts. */
function empiler(geometries){
  const polys = [];
  for(const g of geometries){
    if(!g) continue;
    if(g.type === "Polygon") polys.push(g.coordinates);
    else if(g.type === "MultiPolygon") polys.push(...g.coordinates);
  }
  if(!polys.length) return null;
  return polys.length === 1
    ? { type:"Polygon", coordinates: polys[0] }
    : { type:"MultiPolygon", coordinates: polys };
}

/* ── La dissolution ──────────────────────────────────────────────────
   Rend { geometry, approximatif, motif } : `approximatif` dit que la
   couture a échoué et que le contour rendu est l'empilement des enfants.
   Jamais d'exception : un district biscornu ne doit pas faire échouer la
   dérivation des cent dix-huit autres. */
export function dissoudre(geometries){
  const anneaux = [];
  for(const g of geometries) anneaux.push(...anneauxDe(g));
  if(!anneaux.length) return { geometry:null, approximatif:false, motif:"aucun contour enfant" };

  /* ① Annulation : une arête parcourue dans les deux sens est intérieure. */
  const aretes = new Map();
  for(const r of anneaux){
    for(let i = 0; i + 1 < r.length; i++){
      const ka = cle(r[i]), kb = cle(r[i + 1]);
      if(ka === kb) continue;                      /* sommet répété */
      const inverse = `${kb}|${ka}`;
      if(aretes.has(inverse)) aretes.delete(inverse);
      else aretes.set(`${ka}|${kb}`, [r[i], r[i + 1]]);
    }
  }
  if(!aretes.size)
    return { geometry:null, approximatif:false, motif:"toutes les arêtes se sont annulées" };

  /* ② Couture : suivre les arêtes bout à bout jusqu'à revenir au départ. */
  const depuis = new Map();
  for(const [k, ab] of aretes){
    const kd = k.slice(0, k.indexOf("|"));
    const file = depuis.get(kd);
    if(file) file.push(ab); else depuis.set(kd, [ab]);
  }
  const rings = [];
  let restant = aretes.size;
  let echec = "";
  while(restant > 0 && !echec){
    let depart = null;
    for(const file of depuis.values()) if(file.length){ depart = file.pop(); restant--; break; }
    if(!depart) break;
    const ring = [depart[0], depart[1]];
    const debut = cle(depart[0]);
    let courant = cle(depart[1]);
    while(courant !== debut){
      const file = depuis.get(courant);
      if(!file || !file.length){ echec = "anneau ouvert : les contours enfants ne partagent pas leurs sommets"; break; }
      const suivante = file.pop(); restant--;
      ring.push(suivante[1]);
      courant = cle(suivante[1]);
      /* Garde-fou : une topologie pathologique ne doit pas boucler sans fin. */
      if(ring.length > 500000){ echec = "anneau démesuré : couture abandonnée"; break; }
    }
    if(!echec && ring.length >= 4) rings.push(nettoyerAnneau(ring));
  }

  if(!echec){
    const geometry = assembler(rings);
    if(geometry) return { geometry, approximatif:false, motif:"" };
    echec = "aucun anneau extérieur après couture";
  }
  return { geometry: empiler(geometries), approximatif:true, motif:echec };
}

/* Le nombre de sommets d'une géométrie — ce qui permet de MONTRER ce que la
   dissolution a supprimé : sur un vrai fichier, réunir mille sept cents
   communes en cent dix-neuf districts divise le nombre de points par plus
   de dix, et c'est la preuve que les frontières intérieures sont bien
   tombées. */
export function sommets(g){
  return anneauxDe(g).reduce((n, r) => n + r.length, 0);
}
