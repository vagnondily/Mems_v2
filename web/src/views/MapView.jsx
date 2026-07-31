import React, { useState, useEffect, useMemo, useRef } from "react";
import { MapPin, Search, RefreshCw, Download, Users, Target, Activity, AlertTriangle, Layers } from "lucide-react";
import { C, MONTHS_L, D_SECURITY } from "../lib/constants.js";
import { fmt, pct, n, r2, r5, clsx } from "../lib/calc.js";
import { download, toCSV } from "../components/ui.jsx";
import { Badge, Card, Btn, Select, Stat, StatRow, Empty, Note, Bar2, TableWrap, Th, Td, inputCls } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { useGeoCascade, names } from "../lib/geo.js";
import { niveau, niveaux } from "../lib/levels.js";

/* ── Projection ───────────────────────────────────────────────────────
   Mercator sphérique (EPSG:3857), la projection des tuiles web.

   C'était une équirectangulaire, corrigée de la convergence des méridiens à la
   latitude moyenne. Suffisant tant que la carte ne portait que des points et des
   contours dessinés par nous ; faux dès qu'on pose un fond de carte dessous, car les
   tuiles sont en Mercator et l'écart se voit — les contours glissent par rapport aux
   routes, de plus en plus vers les latitudes hautes.

   Le monde Mercator est un carré de côté 1 en unités normalisées ; `scale` est le
   nombre de pixels de ce carré. Tout le reste — placement des tuiles, échelle,
   rectangle de zoom — en découle. */
const MERC = {
  x: (lon) => (lon + 180) / 360,
  y: (lat) => {
    const f = Math.min(85.05112878, Math.max(-85.05112878, lat)) * Math.PI / 180;
    return (1 - Math.log(Math.tan(f) + 1 / Math.cos(f)) / Math.PI) / 2;
  },
  lon: (x) => x * 360 - 180,
  lat: (y) => {
    const n2 = Math.PI * (1 - 2 * y);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));
  },
};

function makeProjection(bounds, width, height, pad = 26){
  if(!bounds) return null;
  const x0 = MERC.x(bounds.minLon), x1 = MERC.x(bounds.maxLon);
  const y0 = MERC.y(bounds.maxLat), y1 = MERC.y(bounds.minLat);   /* y croît vers le sud */
  const dx = Math.max(1e-6, x1 - x0), dy = Math.max(1e-6, y1 - y0);
  const scale = Math.min((width - 2*pad) / dx, (height - 2*pad) / dy);
  const ox = width/2 - (x0 + x1) / 2 * scale;
  const oy = height/2 - (y0 + y1) / 2 * scale;
  return {
    scale, ox, oy,
    x: (lon) => MERC.x(lon) * scale + ox,
    y: (lat) => MERC.y(lat) * scale + oy,
    /* Les inverses servent au rectangle de zoom et au calcul des tuiles visibles. */
    lonOf: (px) => MERC.lon((px - ox) / scale),
    latOf: (py) => MERC.lat((py - oy) / scale),
  };
}

/* ── Tuiles ───────────────────────────────────────────────────────────
   Le fond de carte distant est la seule ressource externe de l'application, et il
   est facultatif : sans lui, les contours administratifs restent le fond et tout
   fonctionne hors ligne. Il ne se charge que si l'exploitant l'a autorisé côté
   serveur (politique de sécurité du contenu) ET que l'utilisateur l'a demandé.

   Aucune donnée du programme ne part avec : une requête de tuile ne porte que des
   coordonnées de tuile, les mêmes pour tout le monde.

   Le niveau de tuile est choisi pour que 256 px de tuile fassent à peu près 256 px à
   l'écran — au-delà, on télécharge des détails invisibles ; en deçà, l'image est
   floue. Le nombre de tuiles est plafonné : un cadrage mal fichu ne doit pas lancer
   mille requêtes. */
const TILE = 256, MAX_TUILES = 240;
function tuilesVisibles(proj, k, dx, dy, W, H, url){
  if(!proj || !url) return [];
  const echelle = proj.scale * k;
  const z = Math.max(0, Math.min(18, Math.round(Math.log2(echelle / TILE))));
  const n2 = 2 ** z;
  const taille = echelle / n2;                       /* côté d'une tuile, en pixels écran */
  /* Coin haut-gauche du viewport en unités normalisées, en défaisant la translation. */
  const u0 = (-dx / k - proj.ox) / proj.scale, v0 = (-dy / k - proj.oy) / proj.scale;
  const u1 = ((W - dx) / k - proj.ox) / proj.scale, v1 = ((H - dy) / k - proj.oy) / proj.scale;
  const i0 = Math.max(0, Math.floor(u0 * n2)), i1 = Math.min(n2 - 1, Math.ceil(u1 * n2));
  const j0 = Math.max(0, Math.floor(v0 * n2)), j1 = Math.min(n2 - 1, Math.ceil(v1 * n2));
  const out = [];
  for(let j = j0; j <= j1; j++) for(let i = i0; i <= i1; i++){
    if(out.length >= MAX_TUILES) return out;
    out.push({
      key: `${z}/${i}/${j}`,
      href: url.replace("{z}", z).replace("{x}", i).replace("{y}", j),
      /* Placées dans le repère non transformé du groupe : le zoom et le
         déplacement s'appliquent au groupe entier, comme aux contours. */
      x: (i / n2) * proj.scale + proj.ox,
      y: (j / n2) * proj.scale + proj.oy,
      w: proj.scale / n2,
    });
  }
  return out;
}

const COLOR_MODES = [
  ["coverage", "Couverture des visites"],
  ["security", "Situation sécuritaire"],
  ["activity", "Catégorie d'activité"],
  ["status", "Statut du site"],
];

/* Aplats du fond de carte. « Aucun » laisse les contours en simple trait : c'est
   ce qu'il faut quand on regarde les points. Les trois autres répondent à des
   questions que le module de ciblage posait déjà en tableau, et qu'un tableau ne
   sait pas montrer — où sont les vides. */
const FILL_MODES = [
  ["none",     "Contours seuls"],
  ["presence", "Présence de sites"],
  ["coverage", "Couverture du suivi"],
  ["benef",    "Bénéficiaires"],
];
/* Les niveaux proposés viennent de la configuration du pays : « Régions,
   Districts, Communes, Fokontany » est le vocabulaire de Madagascar, pas celui du
   logiciel. Le pays n'est pas proposé — on ne colore pas un aplat sur une seule
   forme. */

/* Une géométrie GeoJSON vers un chemin SVG, projeté.

   L'arrondi à 0,1 pixel n'est pas une coquetterie : un contour de commune compte
   des centaines de sommets, et écrire « 412.7382910384 » plutôt que « 412.7 »
   multiplie par trois la taille du DOM pour une différence invisible. Sur un
   millier de contours, cela se voit à l'affichage. */
function pathOf(geometry, proj){
  if(!geometry || !proj) return "";
  const r1 = (v) => Math.round(v * 10) / 10;
  const anneau = (r) => {
    let d = "";
    for(let i = 0; i < r.length; i++){
      const x = r1(proj.x(r[i][0])), y = r1(proj.y(r[i][1]));
      d += (i ? "L" : "M") + x + " " + y;
    }
    return d + "Z";
  };
  if(geometry.type === "Polygon") return geometry.coordinates.map(anneau).join("");
  if(geometry.type === "MultiPolygon")
    return geometry.coordinates.map(p => p.map(anneau).join("")).join("");
  return "";
}

/* Échelle d'aplat séquentielle, du plus clair au plus foncé de la teinte de
   marque. Cinq classes : au-delà, l'œil ne distingue plus, et en dessous on perd
   l'information. Le blanc est réservé au zéro — un vide doit se voir comme un vide,
   pas comme la première classe. */
const RAMP = ["#e8f2f8", "#bcdcec", "#8ac2dd", "#4e9ec7", "#0b6d9e"];
function classify(v, max){
  if(v == null || max <= 0) return null;
  if(v <= 0) return null;
  const k = Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length));
  return RAMP[k];
}

export default function MapView({ db, me, notify, go }){
  const [rows, setRows] = useState([]);
  const [bounds, setBounds] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState("");
  const [colorMode, setColorMode] = useState("coverage");
  const [sizeByBenef, setSizeByBenef] = useState(true);
  const [f, setF] = useState({ office_id:"", adm1:"", adm2:"", activity_tag:"", status:"Active" });
  const [view, setView] = useState({ k:1, dx:0, dy:0 });
  /* Fond de carte : contours administratifs et mode d'aplat. */
  const [fillMode, setFillMode] = useState("presence");
  const [geoLevel, setGeoLevel] = useState("adm2");
  const [shapes, setShapes] = useState({ features:[], extent:null, tronque:false, loading:false });
  const [selShape, setSelShape] = useState(null);
  /* Fond de carte distant : proposé seulement si le serveur l'autorise, et retenu
     dans le navigateur — c'est une préférence d'affichage, pas une configuration
     partagée : un poste sans connexion l'éteint sans l'éteindre pour les autres. */
  const fondAutorise = !!db.basemap?.autorise && !!db.basemap?.url;
  const [fond, setFond] = useState(() => {
    try{ return localStorage.getItem("mems.fond") ?? "osm"; }catch(e){ return "osm"; }
  });
  const setFondPersistant = (v) => { setFond(v); try{ localStorage.setItem("mems.fond", v); }catch(e){} };
  /* Coordonnées affichées à côté des points : ce qu'on lit sur un GPS de terrain. */
  const [coords, setCoords] = useState(false);
  /* Une tuile qui n'arrive pas laisse un trou gris, et l'utilisateur croit à une
     panne de l'application. Sur un poste sans accès sortant — le cas d'un bureau de
     terrain — c'est la situation NORMALE, et il faut le dire une fois, calmement. */
  const [fondMuet, setFondMuet] = useState(false);
  useEffect(()=>{ setFondMuet(false); }, [fond, view.k]);
  /* Outil « zoom sur une zone » : on trace un rectangle, la carte s'y cadre. */
  const [outil, setOutil] = useState("main");
  const [rect, setRect] = useState(null);
  /* Panneau de rattachement par les coordonnées, ouvert depuis l'avertissement. */
  const [rattacher, setRattacher] = useState(false);
  const GEO_LEVELS = niveaux(db, { from:"adm1", to:"adm4" });
  const W = 900, H = 560;

  const load = async () => {
    setBusy(true); setError("");
    try{
      const params = new URLSearchParams();
      Object.entries(f).forEach(([k,v]) => { if(v) params.set(k, v); });
      const r = await api.mapPoints("?" + params.toString());
      setRows(r.sites); setBounds(r.bounds);
    }catch(e){ setError(e.message); setRows([]); setBounds(null); }
    setBusy(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [f.office_id, f.adm1, f.adm2, f.activity_tag, f.status]);

  const filtered = useMemo(() => !q ? rows : rows.filter(s =>
    [s.code, s.name, s.adm3, s.adm4, s.office].join(" ").toLowerCase().includes(q.toLowerCase())), [rows, q]);

  /* ── Cadrage ──────────────────────────────────────────────────────
     Le cadre par défaut est le PAYS, pas le nuage de points.

     Il était calculé sur l'emprise des sites, éventuellement élargie aux contours.
     Quand les sites sont regroupés — ce qui est le cas ordinaire d'un programme
     concentré sur quelques districts — la carte s'ouvrait sur ces quelques districts.
     Sans fond de carte, cela ne se voyait pas : on regardait des cercles sur du vide.
     Avec un fond, on tombe sur un fragment de territoire qu'on ne reconnaît pas, et
     l'on se demande où est passé le pays.

     L'emprise du pays vient, dans l'ordre : des contours administratifs chargés, du
     centre déclaré dans la configuration du pays à défaut. Un pays sans découpage ni
     centre retombe sur les points — c'est mieux que rien à afficher. */
  const paysCadre = useMemo(() => {
    const e = shapes.extent;
    if(e) return { minLat:e.south, maxLat:e.north, minLon:e.west, maxLon:e.east };
    const c = db.country;
    if(c?.lat != null && c?.lon != null){
      /* Sept degrés de part et d'autre : de quoi tenir un pays de taille moyenne
         entier à l'écran. C'est une approximation, et elle ne sert qu'au premier
         affichage — dès qu'un découpage est chargé, l'emprise réelle la remplace. */
      const d = 7;
      return { minLat:c.lat - d, maxLat:c.lat + d, minLon:c.lon - d, maxLon:c.lon + d };
    }
    return null;
  }, [shapes.extent, db.country]);

  const pointsCadre = bounds;
  const cadre = useMemo(() => {
    if(!paysCadre) return pointsCadre;
    if(!pointsCadre) return paysCadre;
    /* L'union des deux : un site hors du découpage — cela arrive, c'est même ce que
       le rattachement par coordonnées sert à corriger — ne doit pas sortir du cadre
       sans qu'on le voie. */
    return { minLat:Math.min(pointsCadre.minLat, paysCadre.minLat),
             maxLat:Math.max(pointsCadre.maxLat, paysCadre.maxLat),
             minLon:Math.min(pointsCadre.minLon, paysCadre.minLon),
             maxLon:Math.max(pointsCadre.maxLon, paysCadre.maxLon) };
  }, [pointsCadre, paysCadre]);
  const proj = useMemo(() => makeProjection(cadre, W, H), [cadre]);
  /* Les tuiles se recalculent au déplacement et au zoom : c'est le prix d'un fond
     qui reste net, et cela ne coûte que quelques dizaines d'éléments. */
  const tuiles = useMemo(
    () => (fondAutorise && fond === "osm")
      ? tuilesVisibles(proj, view.k, view.dx, view.dy, W, H, db.basemap.url) : [],
    [proj, view.k, view.dx, view.dy, fond, fondAutorise, db.basemap?.url]);
  const tags = useMemo(() => [...new Set(rows.map(s => s.activity_tag).filter(Boolean))].sort(), [rows]);
  /* Le référentiel vient du serveur, niveau par niveau : le navigateur ne
     charge jamais les 18 000 fokontany pour alimenter deux listes déroulantes. */
  const geo = useGeoCascade({ adm1: f.adm1 });
  /* Repères de fond : centroïdes des communes du périmètre affiché. Bornés à 1 000,
     qui est la limite du serveur — on demandait 1 200, la requête repartait en 422,
     et le `catch` du client vidait la liste sans rien dire : ces repères ne se sont
     jamais affichés. Au-delà de ce nombre ils forment de toute façon une tache
     grise sans rien apprendre. */
  const [geoMarks, setGeoMarks] = useState([]);
  useEffect(() => {
    let alive = true;
    const qs = new URLSearchParams({ level:"adm3", limit:"1000" });
    if(geo.codes.adm2) qs.set("parent", geo.codes.adm2);
    else if(geo.codes.adm1) qs.set("parent", geo.codes.adm1);
    api.geo("?"+qs)
      .then(r => { if(alive) setGeoMarks((r.rows||[]).filter(g => g.lat != null && g.lon != null)); })
      .catch(() => { if(alive) setGeoMarks([]); });
    return () => { alive = false; };
  }, [geo.codes.adm1, geo.codes.adm2]);

  /* ── Contours administratifs ───────────────────────────────────────
     Chargés par niveau et bornés au parent affiché. La version servie est la
     version simplifiée : c'est celle dont un écran de 900 pixels a besoin, et
     demander la pleine résolution d'un pays entier n'afficherait rien de plus
     tout en pesant cent fois plus lourd. */
  useEffect(() => {
    let alive = true;
    if(!db.geoVersion?.geom?.units){ setShapes({ features:[], extent:null, tronque:false, loading:false }); return; }
    setShapes(s => ({ ...s, loading:true }));
    const qs = new URLSearchParams({ level:geoLevel, limit:"1500" });
    const parent = geo.codes.adm2 || geo.codes.adm1;
    if(parent) qs.set("parent", parent);
    api.geoGeometry("?"+qs)
      .then(r => { if(alive) setShapes({ features:r.features||[], extent:r.extent,
        tronque:!!r.tronque, loading:false }); })
      .catch(() => { if(alive) setShapes({ features:[], extent:null, tronque:false, loading:false }); });
    return () => { alive = false; };
  }, [geoLevel, geo.codes.adm1, geo.codes.adm2, db.geoVersion?.geom?.units]);

  const adm1s = useMemo(() => names(geo.adm1), [geo.adm1]);
  const adm2s = useMemo(() => names(geo.adm2), [geo.adm2]);

  const palette = useMemo(() => {
    const t = {}; tags.forEach((x,i) => { t[x] = [C.brand, C.ok, C.warn, C.orange, C.aqua, C.magenta, C.navy][i % 7]; });
    return t;
  }, [tags]);

  const colorOf = (s) => {
    if(colorMode === "security")
      return s.security === 0 ? C.ok : s.security === 1 ? C.warn : s.security === 3 ? C.bad : "#7c8792";
    if(colorMode === "activity") return palette[s.activity_tag] || "#94a3b8";
    if(colorMode === "status") return s.status === "Active" ? C.ok : "#94a3b8";
    const c = s.planned ? pct(s.done, s.planned) : (s.done ? 100 : 0);
    return s.planned === 0 && s.done === 0 ? "#c3cdd6" : c >= 80 ? C.ok : c >= 40 ? C.warn : C.bad;
  };
  const radiusOf = (s) => {
    if(!sizeByBenef) return 4.2;
    const b = n(s.beneficiaries);
    return 3 + Math.min(9, Math.sqrt(b) / 22);
  };

  const stats = useMemo(() => {
    const active = filtered.filter(s => s.status === "Active");
    const visited = filtered.filter(s => s.done > 0);
    const never = filtered.filter(s => !s.last_visit);
    return { total: filtered.length, active: active.length, visited: visited.length,
      never: never.length, benef: filtered.reduce((t,s) => t + n(s.beneficiaries), 0),
      coverage: pct(visited.length, active.length) };
  }, [filtered]);

  /* ── Valeurs thématiques par unité ─────────────────────────────────
     Agrégées depuis les sites déjà chargés, par p-code. Le rattachement se fait
     par code et non par nom : deux communes homonymes dans deux districts
     différents existent, et les confondre colorerait la mauvaise. Un site dont le
     p-code manque ne compte pour aucune unité — il est visible en point, ce qui
     est la bonne façon de signaler qu'il n'est pas rattaché.

     Les valeurs remontent d'un niveau à l'autre par la propriété `parent` que le
     serveur joint à chaque contour : les sites sont à la commune, la carte peut
     être au district. */
  const themeValues = useMemo(() => {
    if(fillMode === "none" || !shapes.features.length) return { par:{}, max:0, absent:0 };
    const cible = new Set(shapes.features.map(f => f.properties.pcode));

    /* Le rattachement se lit dans le CHEMIN de l'unité du site, qui porte tous ses
       ancêtres. La version précédente remontait la parenté des contours AFFICHÉS :
       un site rattaché à son fokontany ne s'y retrouvait pas quand la carte montrait
       les districts, et l'écran annonçait « 309 sites sans rattachement » alors que
       les 309 étaient rattachés. */
    const par = {}; let absent = 0;
    for(const st of filtered){
      const chemin = (st.geo_path || st.geo_pcode || "").split("/").filter(Boolean);
      /* Du plus fin au plus large : on s'arrête au premier ancêtre affiché. */
      let p = null;
      for(let i = chemin.length - 1; i >= 0; i--) if(cible.has(chemin[i])){ p = chemin[i]; break; }
      if(!p){ absent++; continue; }
      const a = par[p] = par[p] || { sites:0, actifs:0, planifies:0, visites:0, benef:0 };
      a.sites++;
      if(st.status === "Active") a.actifs++;
      a.planifies += n(st.planned); a.visites += n(st.done); a.benef += n(st.beneficiaries);
    }
    const val = (a) => fillMode === "presence" ? a.sites
      : fillMode === "benef" ? a.benef
      : (a.planifies ? Math.round((a.visites / a.planifies) * 100) : (a.visites ? 100 : 0));
    const max = fillMode === "coverage" ? 100
      : Math.max(0, ...Object.values(par).map(val));
    return { par, val, max, absent };
  }, [fillMode, shapes.features, filtered]);

  const byRegion = useMemo(() => {
    const m = {};
    filtered.forEach(s => { const k = s.adm1 || "—";
      m[k] = m[k] || { region:k, sites:0, visites:0, benef:0 };
      m[k].sites++; m[k].visites += s.done; m[k].benef += n(s.beneficiaries); });
    return Object.values(m).sort((a,b) => b.sites - a.sites);
  }, [filtered]);

  const legend = colorMode === "security"
    ? D_SECURITY.map(([v,l]) => [v === 0 ? C.ok : v === 1 ? C.warn : v === 3 ? C.bad : "#7c8792", l])
    : colorMode === "activity" ? tags.map(t => [palette[t], t])
    : colorMode === "status" ? [[C.ok,"Actif"], ["#94a3b8","Inactif"]]
    : [[C.ok,"80 % et plus des visites prévues"], [C.warn,"40 à 79 %"], [C.bad,"moins de 40 %"], ["#c3cdd6","aucune visite prévue"]];

  const exportPoints = () => {
    download("cartographie_sites.csv", toCSV(filtered,
      ["code","name","office","category","activity_tag","adm1","adm2","adm3","adm4",
       "lat","lon","beneficiaries","security","status","planned","done","last_visit"]), "text/csv");
    notify("Points exportés","ok");
  };

  const zoom = (factor) => setView(v => ({ ...v, k: Math.max(1, Math.min(64, v.k * factor)) }));
  const drag = useRef(null);
  const svgRef = useRef(null);

  /* Coordonnées du pointeur dans le repère du dessin (viewBox), et non en pixels
     d'écran : la carte est mise à l'échelle par la largeur disponible, et confondre
     les deux décalait le rectangle de tracé de plusieurs dizaines de pixels. */
  const pointeur = (e) => {
    const r = svgRef.current?.getBoundingClientRect();
    if(!r) return { x:0, y:0 };
    return { x:(e.clientX - r.left) * W / r.width, y:(e.clientY - r.top) * H / r.height };
  };

  /* Cadrer la carte sur une emprise géographique : c'est ce que font le rectangle
     de zoom et le clic sur « cadrer » d'une unité administrative. On calcule le
     facteur et la translation plutôt que de changer la projection — la projection
     reste celle du pays, donc revenir en arrière est exact. */
  const cadrerSur = (b, marge = 0.06) => {
    if(!proj || !b) return;
    const px0 = proj.x(b.west), px1 = proj.x(b.east);
    const py0 = proj.y(b.north), py1 = proj.y(b.south);
    const largeur = Math.max(1, Math.abs(px1 - px0)), hauteur = Math.max(1, Math.abs(py1 - py0));
    const k = Math.max(1, Math.min(64, Math.min(W / largeur, H / hauteur) * (1 - marge)));
    const cx = (px0 + px1) / 2, cy = (py0 + py1) / 2;
    setView({ k, dx: W/2 - cx * k, dy: H/2 - cy * k });
  };

  const onDown = (e) => {
    const p = pointeur(e);
    if(outil === "zone"){ setRect({ x0:p.x, y0:p.y, x1:p.x, y1:p.y }); return; }
    drag.current = { x:e.clientX, y:e.clientY, dx:view.dx, dy:view.dy };
  };
  const onMove = (e) => {
    if(rect){ const p = pointeur(e); setRect(r => ({ ...r, x1:p.x, y1:p.y })); return; }
    if(!drag.current) return;
    setView(v => ({ ...v, dx: drag.current.dx + (e.clientX - drag.current.x),
                          dy: drag.current.dy + (e.clientY - drag.current.y) }));
  };
  const onUp = () => {
    if(rect){
      const { x0, y0, x1, y1 } = rect;
      setRect(null);
      /* Un rectangle minuscule est un clic manqué, pas une intention de zoom. */
      if(Math.abs(x1-x0) > 8 && Math.abs(y1-y0) > 8){
        const inv = (px, py) => ({ lon: proj.lonOf((px - view.dx) / view.k),
                                   lat: proj.latOf((py - view.dy) / view.k) });
        const a = inv(Math.min(x0,x1), Math.min(y0,y1));
        const b = inv(Math.max(x0,x1), Math.max(y0,y1));
        cadrerSur({ west:a.lon, east:b.lon, north:a.lat, south:b.lat });
        setOutil("main");
      }
      return;
    }
    drag.current = null;
  };

  /* Cadrer sur l'unité administrative choisie : « faire une zone » au sens propre —
     on désigne un district et la carte s'y installe. */
  /* ── Aller à un site ──────────────────────────────────────────
     Une carte de points ne se parcourt pas : trois cents sites se superposent en
     quelques amas, et l'on ne peut cliquer que ce qu'on voit déjà. C'est le défaut
     que corrigent tous les localisateurs d'agences — une LISTE à côté de la carte,
     liée dans les deux sens. On y cherche par le nom, on clique, la carte y va.

     Le facteur 0,08° cadre environ dix kilomètres autour du point : assez pour voir
     le voisinage, assez serré pour que le site cherché soit sans ambiguïté. */
  const allerA = (s2) => {
    if(!s2 || s2.lat == null || s2.lon == null) return;
    setSel(s2);
    const d = 0.08;
    cadrerSur({ west:s2.lon - d, east:s2.lon + d, north:s2.lat + d, south:s2.lat - d }, 0.2);
  };

  /* Les sites de l'unité retenue sur la carte. Le rattachement fait foi quand il
     existe ; à défaut, on retombe sur les libellés, qui sont ce dont disposent les
     sites non rattachés — c'est moins sûr, mais c'est mieux que de n'afficher rien. */
  const uniteRetenue = selShape
    ? shapes.features.find(x => x.properties.pcode === selShape) : null;
  const listeSites = uniteRetenue
    ? filtered.filter(s2 => s2.geo_pcode === selShape
        || (s2.geo_path || "").split("/").includes(selShape)
        || [s2.adm1, s2.adm2, s2.adm3, s2.adm4].includes(uniteRetenue.properties.name))
    : filtered;

  const cadrerUnite = (f2) => {
    const g = f2?.geometry; if(!g) return;
    let w = 180, e2 = -180, n2 = 90, s2 = -90;
    const parcours = (r) => r.forEach(([lon,lat]) => {
      if(lon < w) w = lon; if(lon > e2) e2 = lon;
      if(lat < n2) n2 = lat; if(lat > s2) s2 = lat; });
    if(g.type === "Polygon") g.coordinates.forEach(parcours);
    if(g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(parcours));
    cadrerSur({ west:w, east:e2, north:s2, south:n2 });
  };

  return (
    <div className="space-y-4">
      <StatRow>
        <Stat label="Sites cartographiés" value={fmt(stats.total)} sub={`${fmt(rows.length)} ramenés du serveur`} icon={MapPin} />
        <Stat label="Sites actifs" value={fmt(stats.active)} icon={Activity} />
        <Stat label="Sites visités" value={fmt(stats.visited)} tone={stats.coverage >= 60 ? "ok" : "warn"}
          sub={`${stats.coverage} % des actifs`} icon={Target} />
        <Stat label="Jamais visités" value={fmt(stats.never)} tone={stats.never ? "bad" : "ok"} icon={AlertTriangle} />
        <Stat label="Bénéficiaires couverts" value={fmt(stats.benef)} icon={Users} />
      </StatRow>

      <Card flush title="Cartographie des sites"
        subtitle={busy ? "Chargement des points…" : `${fmt(filtered.length)} points affichés · projection WGS 84`}
        right={<>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Site, commune, fokontany…"
              className={clsx(inputCls, "pl-7 mi-py1 w-52")} />
          </div>
          <Btn size="sm" kind="sec" icon={RefreshCw} onClick={load}>Actualiser</Btn>
          <Btn size="sm" kind="sec" icon={Download} disabled={!filtered.length} onClick={exportPoints}>Exporter</Btn>
        </>}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
          <Select value={f.office_id} onChange={e=>setF(x=>({...x, office_id:e.target.value}))}
            empty="Tous les bureaux" options={(db.offices||[]).map(o=>[o.id,o.name])} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.adm1} onChange={e=>setF(x=>({...x, adm1:e.target.value, adm2:""}))}
            empty="Toutes les régions" options={adm1s} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.adm2} onChange={e=>setF(x=>({...x, adm2:e.target.value}))}
            empty="Tous les districts" options={adm2s} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.activity_tag} onChange={e=>setF(x=>({...x, activity_tag:e.target.value}))}
            empty="Toutes les activités" options={tags} className="mi-py1 mi-xs mi-wauto" />
          <Select value={f.status} onChange={e=>setF(x=>({...x, status:e.target.value}))}
            empty="Tous les statuts" options={[["Active","Actifs"],["Inactive","Inactifs"]]} className="mi-py1 mi-xs mi-wauto" />
          <span className="w-px h-6 bg-slate-300 mx-1" />
          {db.geoVersion?.geom?.units > 0 && (<>
            <Select value={geoLevel} onChange={e=>setGeoLevel(e.target.value)}
              options={GEO_LEVELS} className="mi-py1 mi-xs mi-wauto" />
            <Select value={fillMode} onChange={e=>setFillMode(e.target.value)}
              options={FILL_MODES} className="mi-py1 mi-xs mi-wauto" />
            <span className="w-px h-6 bg-slate-300 mx-1" />
          </>)}
          <Select value={colorMode} onChange={e=>setColorMode(e.target.value)}
            options={COLOR_MODES} className="mi-py1 mi-xs mi-wauto" />
          <label className="flex items-center gap-1.5 f115 text-slate-600">
            <input type="checkbox" checked={sizeByBenef} onChange={e=>setSizeByBenef(e.target.checked)} />
            taille selon les bénéficiaires</label>
          {/* Fond de carte distant : le choix est offert seulement s'il est permis
              côté serveur. Quand il ne l'est pas, on le DIT au lieu de laisser
              croire à une panne. */}
          {fondAutorise ? (
            <Select value={fond} onChange={e=>setFondPersistant(e.target.value)}
              options={[["osm","Fond OpenStreetMap"],["none","Sans fond distant"]]}
              className="mi-py1 mi-xs mi-wauto" />
          ) : (
            <span className="f11 text-slate-400" title="Aucun serveur de tuiles n'est autorisé par la configuration (TILE_HOSTS)">
              fond distant désactivé</span>)}
          {/* Au-delà d'une centaine de points, les étiquettes se chevauchent et ne
              se lisent plus : on le dit plutôt que de laisser croire à une panne. */}
          <label className="flex items-center gap-1.5 f115 text-slate-600"
            title={filtered.length > 120
              ? `Trop de points (${filtered.length}) pour afficher les coordonnées lisiblement : filtrez ou zoomez sur une zone`
              : "Afficher la latitude et la longitude à côté de chaque point"}>
            <input type="checkbox" checked={coords} onChange={e=>setCoords(e.target.checked)} />
            coordonnées
            {coords && filtered.length > 120 &&
              <span className="text-amber-700">({filtered.length} points : filtrez pour les voir)</span>}
          </label>
          <div className="ml-auto flex items-center gap-1">
            {/* Deux outils, deux gestes : la main déplace, le rectangle cadre. */}
            <Btn size="sm" kind={outil==="zone" ? "primary" : "sec"}
              onClick={()=>{ setOutil(o => o==="zone" ? "main" : "zone"); setRect(null); }}>
              {outil==="zone" ? "Tracez la zone…" : "Zoom sur une zone"}</Btn>
            <Btn size="sm" kind="sec" onClick={()=>zoom(1/1.4)}>−</Btn>
            <span className="f115 text-slate-500 tabular-nums px-1">×{r2(view.k)}</span>
            <Btn size="sm" kind="sec" onClick={()=>zoom(1.4)}>+</Btn>
            {/* Deux cadrages, parce que ce sont deux questions : « où est le pays »
                et « où sont mes sites ». Le second est utile dès que le programme
                couvre une petite partie du territoire. */}
            {!!pointsCadre && <Btn size="sm" kind="ghost"
              onClick={()=>cadrerSur({ west:pointsCadre.minLon, east:pointsCadre.maxLon,
                                       north:pointsCadre.maxLat, south:pointsCadre.minLat }, 0.12)}>
              Cadrer sur les sites</Btn>}
            <Btn size="sm" kind="ghost" onClick={()=>{ setView({ k:1, dx:0, dy:0 }); setOutil("main"); }}>
              Voir tout le pays</Btn>
          </div>
        </div>

        {rattacher && <Rattachement notify={notify} onClose={()=>{ setRattacher(false); load(); }} />}

      {error ? <Note tone="err">{error}</Note> : null}
        {fondMuet && (
          <Note tone="warn">Le fond de carte distant n'a pas pu être chargé — poste hors ligne, ou accès
            au serveur de tuiles filtré. <b>Les contours administratifs et les points restent affichés</b> :
            la carte fonctionne sans fond. Choisissez « Sans fond distant » pour ne plus le demander.</Note>)}

        {/* Un fond de carte sans point reste utile : il montre les unités où le
            programme n'a aucune présence, ce qui est précisément l'information
            qu'une carte de points ne peut pas donner. */}
        {!proj || (!filtered.length && !shapes.features.length) ? (
          <Empty icon={MapPin} title={busy ? "Chargement…" : "Aucun site à afficher"}
            text={busy ? "" : "Aucun site ne porte de coordonnées pour ces filtres. Renseignez la latitude et la longitude dans le registre des sites."} />
        ) : (
          <div className="flex">
            {/* ── La liste ──────────────────────────────────────────
                Elle porte ce que la carte ne peut pas porter : un nom qu'on lit, un
                ordre qu'on parcourt, et la possibilité d'atteindre un site que six
                autres recouvrent. Sélection commune avec la carte — cliquer ici
                déplace la carte, cliquer là-bas surligne ici. */}
            <aside className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col"
              style={{ height:H }}>
              <div className="px-3 py-2 border-b border-slate-100 f105 text-slate-500">
                {fmt(listeSites.length)} site(s){q ? " pour cette recherche" : ""}
                {/* Le choroplèthe colorait sans jamais servir à naviguer : on voyait
                    qu'un district portait cent sites et l'on ne pouvait pas les
                    atteindre. Cliquer l'unité restreint la liste — la carte devient
                    un moyen de chercher, pas seulement de constater. */}
                {uniteRetenue && (<>
                  {" · "}<button onClick={()=>setSelShape(null)}
                    className="text-sky-700 hover:underline font-semibold">
                    dans {uniteRetenue.properties.name} ✕</button></>)}
              </div>
              <div className="flex-1 overflow-auto">
                {listeSites.slice(0, 400).map(s2 => {
                  const actif = sel?.id === s2.id;
                  return (
                    <button key={s2.id} onClick={()=>allerA(s2)}
                      /* `scrollIntoView` n'existe pas partout — jsdom ne l'implémente
                         pas, et un rendu qui lève ici emporte l'écran entier. On le
                         demande sans l'exiger : faire défiler la liste est un confort,
                         pas une condition d'affichage. */
                      ref={actif ? (el => el?.scrollIntoView?.({ block:"nearest" })) : null}
                      className={clsx("w-full text-left px-3 py-2 border-b border-slate-50 transition-colors",
                        actif ? "bg-sky-50 bd-l-brand" : "hover:bg-slate-50")}
                      style={actif ? { boxShadow:"inset 3px 0 0 " + C.brand } : undefined}>
                      <div className="flex items-center gap-1.5">
                        <i className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ background: colorOf(s2) }} />
                        <span className={clsx("f115 truncate",
                          actif ? "font-semibold text-sky-900" : "text-slate-800")}>{s2.name}</span>
                      </div>
                      <div className="f10 text-slate-500 truncate pl-4">
                        {[s2.adm3 || s2.adm2, s2.office].filter(Boolean).join(" · ")}</div>
                    </button>);
                })}
                {listeSites.length > 400 && (
                  <div className="px-3 py-3 f105 text-slate-400">
                    400 premiers affichés — affinez la recherche ou les filtres.</div>)}
                {!listeSites.length && (
                  <div className="px-3 py-4 f105 text-slate-400">
                    {uniteRetenue ? "Aucun site dans cette unité." : "Aucun site pour ces filtres."}</div>)}
              </div>
            </aside>

            <div className="flex-1 min-w-0 relative" style={{ background:"#f7fafc" }}
                 onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
              <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full"
                   style={{ cursor: outil==="zone" ? "crosshair" : drag.current ? "grabbing" : "grab" }}
                   onMouseDown={onDown}>
                {/* Le quadrillage de fond est retiré. Il datait de l'époque sans fond
                    de carte, où il donnait au vide un air de papier millimétré ; il se
                    lit comme un repère de coordonnées, ce qu'il n'est pas — ses
                    carreaux valent 40 pixels, pas un degré ni un kilomètre. Sous des
                    tuiles, il ajoutait en plus une trame sur le relief. */}
                <rect width={W} height={H} fill="#f2f6f9" />
                <g transform={`translate(${view.dx},${view.dy}) scale(${view.k})`}>
                  {/* ── Fond de carte distant ─────────────────────────────
                      Les tuiles sont dans le même groupe que le reste : elles
                      subissent le même déplacement et le même zoom, donc rien ne
                      peut glisser entre le fond et les contours. Une tuile qui
                      n'arrive pas laisse simplement un trou : la carte reste
                      lisible, ce qui est le comportement voulu hors ligne.
                      Le débord d'un demi-pixel efface les liserés blancs entre
                      tuiles voisines dus à l'arrondi du rendu. */}
                  {tuiles.map(t => (
                    <image key={t.key} href={t.href} x={t.x} y={t.y}
                           width={t.w + 0.5/view.k} height={t.w + 0.5/view.k}
                           preserveAspectRatio="none" opacity={0.92}
                           onError={()=>setFondMuet(true)} />))}
                  {/* ── Fond de carte administratif ──────────────────────
                      Les contours passent en premier : tout le reste se dessine
                      par-dessus. Le trait s'affine avec le zoom pour rester d'une
                      épaisseur constante à l'écran — sans quoi un zoom ×8
                      transformerait les frontières en gros traits opaques. */}
                  {shapes.features.map(f => {
                    const a = themeValues.par?.[f.properties.pcode];
                    const fill = fillMode === "none" || !a ? "#ffffff"
                      : classify(themeValues.val(a), themeValues.max) || "#ffffff";
                    const actif = selShape === f.properties.pcode;
                    return (
                      <path key={f.properties.pcode} d={pathOf(f.geometry, proj)}
                        data-unit={f.properties.pcode} fill={fill}
                        /* Avec un fond de carte dessous, un aplat opaque le
                           masquerait : les contours se font transparents pour
                           laisser voir les routes et les localités. */
                        fillOpacity={fillMode === "none" ? (tuiles.length ? 0.06 : 0.55)
                                                         : (tuiles.length ? 0.55 : 0.9)}
                        stroke={actif ? C.brandD : (tuiles.length ? "#4a6a80" : "#9fb2c0")}
                        strokeWidth={(actif ? 2 : 0.7) / view.k}
                        onClick={()=>setSelShape(actif ? null : f.properties.pcode)}
                        onDoubleClick={()=>cadrerUnite(f)}
                        style={{ cursor:"pointer" }}>
                        <title>{`${f.properties.name}${a ? `\n${a.sites} site(s), ${a.actifs} actif(s)\n${a.visites}/${a.planifies} visites\n${fmt(a.benef)} bénéficiaires` : "\naucun site"}`}</title>
                      </path>);
                  })}
                  {/* Repères de communes : centroïdes du référentiel, chargés à la demande.
                      Inutiles dès que les contours sont là — ils disaient « il y a une
                      commune ici », ce que le contour dit mieux. */}
                  {!shapes.features.length && geoMarks.map((g,i) => (
                    <circle key={"g"+i} data-geo="1" cx={proj.x(+g.lon)} cy={proj.y(+g.lat)} r={1.2/view.k}
                            fill="#b9c6d1" opacity={0.7} />
                  ))}
                  {filtered.map(s => (
                    <circle key={s.id} data-site={s.code} data-name={s.name}
                      cx={proj.x(s.lon)} cy={proj.y(s.lat)} r={radiusOf(s)/Math.sqrt(view.k)}
                      fill={colorOf(s)} fillOpacity={0.82} stroke="#fff" strokeWidth={0.8/view.k}
                      onClick={()=>setSel(s)} style={{ cursor:"pointer" }}
                      /* Le point sélectionné se distingue : sans cela, avec trois cents
                         cercles superposés, on ne sait pas lequel on vient de choisir. */
                      {...(sel?.id === s.id ? { stroke:C.t1, strokeWidth:2/view.k } : {})}>
                      <title>{`${s.name}\n${s.adm3 || ""} · ${s.office || ""}\n${fmt(s.beneficiaries)} bénéficiaires\n${s.done}/${s.planned} visites`}</title>
                    </circle>
                  ))}
                  {/* Les coordonnées à côté du point : c'est ce qu'un agent lit sur
                      son GPS, et ce qui permet de vérifier qu'un site est là où on
                      croit. Affichées à la demande et seulement si les points sont
                      assez peu nombreux pour rester lisibles. */}
                  {coords && filtered.length <= 120 && filtered.map(s2 => (
                    <text key={"c"+s2.id} x={proj.x(s2.lon) + 5/view.k} y={proj.y(s2.lat) - 4/view.k}
                          fontSize={7/view.k} fill="#334155" style={{ paintOrder:"stroke" }}
                          stroke="#fff" strokeWidth={2/view.k}>
                      {r5(s2.lat)}, {r5(s2.lon)}</text>))}
                  {sel && (
                    <circle cx={proj.x(sel.lon)} cy={proj.y(sel.lat)} r={(radiusOf(sel)+5)/Math.sqrt(view.k)}
                            fill="none" stroke={C.brandD} strokeWidth={2/view.k} />
                  )}
                </g>
                {/* Rectangle de zoom, hors du groupe transformé : il se trace en
                    pixels d'écran, pas en coordonnées géographiques. */}
                {rect && (
                  <rect x={Math.min(rect.x0,rect.x1)} y={Math.min(rect.y0,rect.y1)}
                        width={Math.abs(rect.x1-rect.x0)} height={Math.abs(rect.y1-rect.y0)}
                        fill={C.brand} fillOpacity={0.12} stroke={C.brandD} strokeWidth={1.2}
                        strokeDasharray="4 3" />)}
                <g>
                  {/* L'attribution n'est pas décorative : la licence des tuiles
                      l'exige, et elle dit d'où vient ce qu'on regarde. */}
                  {!!tuiles.length && (
                    <text x={W-8} y={H-8} fontSize="9.5" textAnchor="end" fill="#475569"
                          style={{ paintOrder:"stroke" }} stroke="#fff" strokeWidth="2.5">
                      {db.basemap?.attribution || "© OpenStreetMap"}</text>)}
                  <rect x={12} y={H-46} width={188} height={34} fill="#fff" fillOpacity={0.92}
                        stroke="#e2e8ec" rx={3} />
                  <text x={22} y={H-30} fontSize="10" fill={C.t2}>Échelle approximative</text>
                  <line x1={22} y1={H-22} x2={22 + 100} y2={H-22} stroke={C.t1} strokeWidth="2" />
                  {/* En Mercator, `scale` est la largeur du MONDE en pixels : cent
                      pixels valent donc 100 × 40 075 × cos(latitude) / échelle
                      kilomètres. L'ancienne formule — cent degrés de latitude sur
                      l'échelle, fois 111 — appartenait à l'équirectangulaire et
                      rendait « 0 km » depuis le changement de projection.
                      Le cosinus est pris au centre de l'écran : en Mercator, un
                      pixel ne vaut pas la même distance en haut et en bas. */}
                  <text x={128} y={H-19} fontSize="10" fill={C.t2}>
                    {(() => {
                      const latCentre = proj.latOf((H/2 - view.dy) / view.k);
                      const km = 100 * 40075 * Math.cos(latCentre * Math.PI / 180)
                                 / (proj.scale * view.k);
                      return km >= 10 ? `${Math.round(km)} km`
                           : km >= 1  ? `${Math.round(km * 10) / 10} km`
                                      : `${Math.round(km * 1000)} m`;
                    })()}</text>
                </g>
              </svg>
            </div>

            <aside className="w-72 shrink-0 border-l border-slate-200 p-4 mh68 overflow-auto">
              {/* L'échelle d'aplat en premier : c'est ce qui couvre la surface de la
                  carte, donc ce que l'œil interroge en premier. */}
              {fillMode !== "none" && !!shapes.features.length && (
                <div className="mb-4">
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                    {(FILL_MODES.find(m=>m[0]===fillMode)||[])[1]}
                    <span className="font-normal normal-case tracking-normal text-slate-400">
                      {" "}· {(GEO_LEVELS.find(g=>g[0]===geoLevel)||[])[1].toLowerCase()}</span></div>
                  <div className="flex h-3 rounded overflow-hidden border border-slate-200">
                    <i className="flex-1" style={{ background:"#ffffff" }} title="aucun" />
                    {RAMP.map(c => <i key={c} className="flex-1" style={{ background:c }} />)}
                  </div>
                  <div className="flex justify-between f105 text-slate-400 mt-1">
                    <span>aucun</span>
                    <span>{fillMode === "coverage" ? "100 %" : fmt(themeValues.max)}</span></div>
                  {/* Un site non rattaché est visible ici et compté nulle part. Le
                      signaler ne suffisait pas : la réponse est dans ses propres
                      coordonnées, et l'écran propose donc de la chercher. */}
                  {!!themeValues.absent && (
                    <div className="mt-1.5">
                      <div className="f105 text-amber-700">
                        {fmt(themeValues.absent)} site(s) sans rattachement au découpage :
                        visibles en points, comptés dans aucune unité.</div>
                      <Btn size="sm" kind="sec" className="mt-1.5" onClick={()=>setRattacher(true)}>
                        Rattacher par les coordonnées</Btn>
                    </div>)}
                  {shapes.tronque && (
                    <div className="f105 text-amber-700 mt-1">
                      Affichage tronqué : filtrez par région ou district pour voir ce niveau en entier.</div>)}
                </div>)}

              {!db.geoVersion?.geom?.units && (
                <Note tone="warn">Aucun contour chargé : la carte n'a pas de fond, et une
                  unité sans site reste invisible. Paramètres → Localités → Contours
                  administratifs.</Note>)}

              {selShape && (() => {
                const f = shapes.features.find(x => x.properties.pcode === selShape);
                const a = themeValues.par?.[selShape];
                return f && (
                  <div className="mb-4">
                    <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                      Unité sélectionnée</div>
                    <div className="border border-slate-200 rounded p-3">
                      <div className="f13 font-semibold text-slate-800">{f.properties.name}</div>
                      <div className="f11 text-slate-500 mb-2">{f.properties.level} · {selShape}</div>
                      <dl className="space-y-1 f115">
                        {[["Sites", a ? fmt(a.sites) : "0"],
                          ["dont actifs", a ? fmt(a.actifs) : "0"],
                          ["Visites", a ? `${fmt(a.visites)} / ${fmt(a.planifies)}` : "—"],
                          ["Bénéficiaires", a ? fmt(a.benef) : "—"]].map(([k,v])=>(
                          <div key={k} className="flex justify-between gap-2">
                            <dt className="text-slate-500">{k}</dt>
                            <dd className="font-medium tabular-nums">{v}</dd></div>))}
                      </dl>
                      {!a && <div className="f105 text-amber-700 mt-2">
                        Aucune présence enregistrée dans cette unité.</div>}
                    </div>
                  </div>);
              })()}

              <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Légende des points</div>
              <ul className="space-y-1.5 mb-4">
                {legend.map(([col,label]) => (
                  <li key={label} className="flex items-center gap-2 f115 text-slate-600">
                    <i className="w-3 h-3 rounded-full inline-block shrink-0" style={{ background:col }} />
                    <span className="truncate" title={label}>{label}</span></li>))}
              </ul>
              {sel ? (
                <>
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">Site sélectionné</div>
                  <div className="border border-slate-200 rounded p-3">
                    <div className="f13 font-semibold text-slate-800">{sel.name}</div>
                    <div className="f11 text-slate-500 mb-2">{sel.code} · {sel.office}</div>
                    <dl className="space-y-1 f115">
                      {[["Emplacement", [sel.adm1, sel.adm2, sel.adm3].filter(Boolean).join(", ")],
                        [niveau(db, "adm4"), sel.adm4 || "—"],
                        ["Catégorie", sel.category || "—"],
                        ["Activité", sel.activity_tag || "—"],
                        ["Bénéficiaires", fmt(sel.beneficiaries)],
                        ["Sécurité", (D_SECURITY.find(x=>x[0]===sel.security)||[])[1] || sel.security],
                        ["Coordonnées", `${r2(sel.lat)}, ${r2(sel.lon)}`],
                        ["Dernière visite", sel.last_visit || "jamais"]].map(([k,v]) => (
                        <div key={k} className="flex gap-2">
                          <dt className="text-slate-500 w-28 shrink-0">{k}</dt>
                          <dd className="text-slate-800 min-w-0 break-words">{v}</dd></div>))}
                    </dl>
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <div className="flex justify-between f115 text-slate-600 mb-1">
                        <span>Visites réalisées</span><b>{sel.done} / {sel.planned || "—"}</b></div>
                      <Bar2 value={sel.planned ? pct(sel.done, sel.planned) : 0}
                        tone={pct(sel.done, sel.planned) >= 80 ? "ok" : "warn"} />
                    </div>
                    <Btn size="sm" kind="sec" className="mt-3 w-full justify-center"
                      onClick={()=>go("settings","sites")}>Ouvrir dans le registre</Btn>
                  </div>
                </>
              ) : (
                <p className="f115 text-slate-500 leading-relaxed">
                  Cliquez sur un point pour afficher la fiche du site. Faites glisser la carte pour la déplacer
                  et utilisez les commandes de zoom.</p>
              )}
            </aside>
          </div>
        )}
      </Card>

      <Card flush title="Répartition géographique" subtitle="Sites, visites réalisées et bénéficiaires par région">
        <TableWrap max="mh340">
          <thead><tr><Th>Région</Th><Th num>Sites</Th><Th num>Visites réalisées</Th>
            <Th num>Bénéficiaires</Th><Th>Part des sites</Th></tr></thead>
          <tbody>{byRegion.map(r => (
            <tr key={r.region} className="hover:bg-sky-50">
              <Td className="font-medium text-slate-800">{r.region}</Td>
              <Td num>{fmt(r.sites)}</Td><Td num>{fmt(r.visites)}</Td><Td num>{fmt(r.benef)}</Td>
              <Td><div className="flex items-center gap-2">
                <Bar2 value={pct(r.sites, stats.total)} />
                <span className="tabular-nums f115">{pct(r.sites, stats.total)} %</span></div></Td>
            </tr>))}</tbody>
        </TableWrap>
      </Card>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Rattachement des sites par leurs coordonnées.

   Un site relevé au GPS mais non rattaché au découpage apparaît sur la carte et
   n'entre dans aucun total : ni la couverture de son district, ni le ciblage de sa
   commune, ni l'exigence minimale de suivi. C'est le cas ordinaire d'un registre
   repris d'un tableur, où le nom de commune a été saisi autrement — ou pas du tout.

   La réponse est dans les données : le découpage sait où tombe ce point.

   Deux temps, volontairement. On PROPOSE, puis on applique ce qui a été vu. Écrire
   trois cents rattachements sans les montrer serait une opération dont personne ne
   peut vérifier le résultat — et un rattachement faux est plus nuisible qu'une
   absence de rattachement, parce qu'il se fond dans les totaux au lieu de s'y
   signaler.

   D'où aussi la distinction, tenue jusqu'à l'écran, entre le point tombé DANS un
   contour — une certitude géométrique — et celui rattaché au centre le plus proche.
   Seul le premier s'applique en masse ; le second se coche à la main.
   ═══════════════════════════════════════════════════════════════════════ */
function Rattachement({ notify, onClose }){
  const [data, setData] = useState(null);
  const [choix, setChoix] = useState(null);      /* identifiants retenus */
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.geoOrphans().then(r => {
      setData(r);
      /* Les certitudes sont cochées d'emblée, les proximités non : c'est la
         proposition raisonnable, et elle reste modifiable. */
      setChoix(r.rows.filter(x => x.propose?.confiance === "certaine").map(x => x.id));
    }).catch(e => { notify(e.message, "err"); setData({ rows:[] }); });
  }, []);

  if(!data) return <Note>Recherche des sites non rattachés…</Note>;

  const proposables = data.rows.filter(x => x.propose);
  const sansReponse = data.rows.length - proposables.length;
  const bascule = (id) => setChoix(c => c.includes(id) ? c.filter(x=>x!==id) : [...c, id]);

  const appliquer = async () => {
    setBusy(true);
    try{
      /* Le seuil suit ce qui est coché : dès qu'une proximité est retenue, il faut
         l'autoriser côté serveur, qui refuse les approximations par défaut. */
      const min = proposables.some(x => choix.includes(x.id) && x.propose.confiance !== "certaine")
        ? "incertaine" : "certaine";
      const r = await api.geoAttach({ ids:choix, minConfiance:min });
      notify(`${r.rattaches} site(s) rattachés${r.ecartes ? `, ${r.ecartes} écarté(s)` : ""}`, "ok");
      onClose();
    }catch(e){ notify(e.message, "err"); }
    setBusy(false);
  };

  return (
    <Card flush title="Rattacher les sites par leurs coordonnées"
      subtitle={`${data.total} site(s) sans rattachement · ${proposables.length} localisable(s) par leur point GPS`}
      right={<>
        <Btn size="sm" kind="sec" onClick={onClose}>Fermer</Btn>
        <Btn size="sm" disabled={busy || !choix.length} onClick={appliquer}>
          {busy ? "Rattachement…" : `Rattacher ${choix.length} site(s)`}</Btn>
      </>}>
      {!data.contours && (
        <Note tone="warn">Aucun contour n'est chargé pour ce pays : le rattachement ne peut se faire
          que par <b>proximité du centre</b> de l'unité, ce qui est une approximation. Chargez les
          contours administratifs (Paramètres → Pays et découpage) pour obtenir des rattachements
          certains.</Note>)}
      {!!data.sansCoordonnees && (
        <Note>{data.sansCoordonnees} site(s) n'ont ni rattachement ni coordonnées : aucun calcul ne
          peut les situer, il faut relever leur position sur le terrain.</Note>)}
      {!!sansReponse && (
        <Note tone="warn">{sansReponse} site(s) portent des coordonnées qu'aucune unité ne
          reconnaît : point en mer, hors du pays, ou longitude et latitude inversées.</Note>)}

      {!proposables.length ? (
        <Empty icon={MapPin} title="Rien à rattacher"
          text="Tous les sites qui portent des coordonnées sont déjà rattachés au découpage." />
      ) : (
        <TableWrap max="mh420">
          <thead><tr><Th /><Th>Site</Th><Th>Coordonnées</Th><Th>Unité proposée</Th>
            <Th>Méthode</Th><Th>Saisi dans le registre</Th></tr></thead>
          <tbody>{proposables.map(x=>{
            const p = x.propose;
            const certain = p.confiance === "certaine";
            return (
              <tr key={x.id} className={clsx("hover:bg-sky-50", choix.includes(x.id) && "bg-sky-50/60")}>
                <Td><input type="checkbox" checked={choix.includes(x.id)}
                  onChange={()=>bascule(x.id)} /></Td>
                <Td className="font-medium text-slate-800">{x.name}
                  <div className="f105 text-slate-400">{x.code}</div></Td>
                <Td className="f11 text-slate-500 tabular-nums">{x.lat}, {x.lon}</Td>
                <Td className="f115">
                  <b className="text-slate-800">{p.name}</b>
                  <div className="f105 text-slate-500">
                    {[p.adm1, p.adm2, p.adm3].filter(Boolean).join(" · ")}</div></Td>
                <Td>{certain
                  ? <Badge tone="g">dans le contour</Badge>
                  : <Badge tone={p.confiance === "probable" ? "y" : "r"}>
                      à {p.distance} km du centre</Badge>}</Td>
                {/* Ce que le registre disait : c'est ce qui permet de repérer une
                    proposition absurde d'un coup d'œil. */}
                <Td className="f105 text-slate-500">
                  {[x.saisi.adm2, x.saisi.adm3].filter(Boolean).join(" · ") || "—"}</Td>
              </tr>);
          })}</tbody>
        </TableWrap>)}
    </Card>);
}
