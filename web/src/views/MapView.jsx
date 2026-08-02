import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { MapPin, Search, RefreshCw, Download, Users, Target, Activity, AlertTriangle, Phone, Clock, Layers } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { C, MONTHS_L, D_SECURITY } from "../lib/constants.js";
import { fmt, pct, n, r2, clsx } from "../lib/calc.js";
import { download, toCSV } from "../components/ui.jsx";
import { Card, Btn, Select, Stat, StatRow, Empty, Note, Bar2, TableWrap, Th, Td, inputCls } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { useGeoCascade, names } from "../lib/geo.js";
import { niveau, niveaux } from "../lib/levels.js";

/* ── Fond de carte ────────────────────────────────────────────────────
   Tuiles OpenStreetMap : libres, sans clé d'API et sans facturation. Le
   choix est délibéré — un fond commercial impose une clé, un compte de
   facturation et un quota, pour un rendu qui n'apprend rien de plus sur
   un pays d'intervention.

   Le fond est *optionnel* : si les tuiles ne se chargent pas (bureau hors
   ligne, pare-feu), Leaflet laisse simplement le fond vide et continue de
   dessiner les contours et les points. C'est ce qui préserve la propriété
   qu'avait le rendu précédent — une carte utilisable sans réseau — sans
   avoir à maintenir deux moteurs de rendu.

   L'URL est surchargeable dans les réglages (`settings.tileUrl`) pour
   pointer vers un serveur de tuiles interne, ce qui est la bonne réponse
   dès que l'usage dépasse la politique d'usage d'OSM. */
/* Plusieurs fonds, tous libres et sans clé, parce qu'un seul ne suffit pas.
   OpenStreetMap applique une politique d'usage qui limite — et parfois refuse —
   le trafic venant d'un centre de données : une instance hébergée dans le nuage
   (un Codespace, par exemple) reçoit alors une grille vide sans la moindre
   explication. Proposer d'autres fournisseurs est la seule réponse qui ne
   dépende pas de l'hébergement, et le premier de la liste est celui qui tient
   le mieux dans ce cas. */
const FONDS = [
  ["carto",  "Carto (clair)",   "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png",
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'],
  ["osm",    "OpenStreetMap",   "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'],
  ["osmfr",  "OSM France",      "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png",
   '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> France'],
  ["esri",   "Esri — routier",  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
   "Esri, HERE, Garmin, &copy; OpenStreetMap contributors"],
  ["sat",    "Esri — satellite","https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
   "Esri, Maxar, Earthstar Geographics"],
  ["aucun",  "Aucun fond",      "", ""],
];

const COLOR_MODES = [
  ["coverage", "Couverture des visites"],
  ["security", "Situation sécuritaire"],
  ["activity", "Catégorie d'activité"],
  ["status", "Statut du site"],
];

/* Aplats du fond administratif. « Contours seuls » laisse le fond de carte
   visible : c'est ce qu'il faut quand on regarde les points. Les trois autres
   répondent à des questions qu'un tableau ne sait pas montrer — où sont les
   vides. */
const FILL_MODES = [
  ["none",     "Contours seuls"],
  ["presence", "Présence de sites"],
  ["coverage", "Couverture du suivi"],
  ["benef",    "Bénéficiaires"],
];

/* Échelle séquentielle, du plus clair au plus foncé de la teinte de marque.
   Cinq classes : au-delà l'œil ne distingue plus, en dessous on perd
   l'information. Le zéro n'est pas peint du tout — sur un fond de carte, un
   aplat blanc masquerait le fond au lieu de signaler un vide. */
const RAMP = ["#e8f2f8", "#bcdcec", "#8ac2dd", "#4e9ec7", "#0b6d9e"];
function classify(v, max){
  if(v == null || max <= 0 || v <= 0) return null;
  const k = Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length));
  return RAMP[k];
}

/* Les libellés de site viennent de la base et finissent dans le HTML d'un
   popup Leaflet, qui pose de l'innerHTML. Sans échappement, un nom de site
   contenant du balisage s'exécuterait dans la session de qui ouvre la carte. */
const esc = (v) => String(v ?? "").replace(/[&<>"']/g,
  c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));

/* Même précaution que lib/taches.js : `localStorage` n'est pas une variable
   globale sous le DOM simulé des tests (il ne vit que sur `window`), et la
   navigation privée le refuse. On passe toujours par cette porte. */
const stockageLocal = () => {
  try{ return typeof window !== "undefined" ? window.localStorage : null; }
  catch(e){ return null; }
};

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
  const [fillMode, setFillMode] = useState("presence");
  /* Les contours peuvent s'escamoter entièrement — bordures comprises, pas
     seulement le remplissage que `fillMode` sait déjà éteindre. Demandé par le
     propriétaire : le découpage de démonstration dessine des rectangles qui
     bouchent la vue. Le choix survit au rechargement, comme le fond de carte :
     l'utilisateur qui les a fermés ne veut pas les rouvrir à chaque visite. */
  const [contours, setContours] = useState(() => stockageLocal()?.getItem("carte.contours") !== "0");
  const basculerContours = (on) => { setContours(on);
    if(!on) setSelShape(null);     /* une unité invisible ne reste pas « sélectionnée » */
    try{ stockageLocal()?.setItem("carte.contours", on ? "1" : "0"); }catch(e){ /* stockage privé */ } };
  const [geoLevel, setGeoLevel] = useState("adm2");
  const [shapes, setShapes] = useState({ features:[], extent:null, tronque:false, loading:false });
  const [selShape, setSelShape] = useState(null);
  /* Le fond retenu est mémorisé dans les réglages : le choix est propre à
     l'instance (selon d'où elle est hébergée), pas à la session de chacun. */
  const [fond, setFond] = useState(() => db.settings?.tileProvider || "carto");
  /* État de chargement des tuiles, pour pouvoir DIRE que le fond n'arrive pas
     au lieu d'afficher un damier vide. C'est le défaut qu'avait la première
     version : silencieuse, elle laissait croire à un bogue de l'application. */
  const [tuiles, setTuiles] = useState({ ok:0, ko:0 });
  /* Relevés GPS des collectes. Ce ne sont PAS les sites : un geopoint enregistre
     l'endroit où se tenait l'agent au moment du formulaire, ce qui peut différer
     de la position officielle du site de plusieurs centaines de mètres. On les
     pose donc en couche distincte, jamais à la place des sites, et on n'écrit
     rien dans le registre — la question « position déclarée contre position
     observée » n'est pas tranchée. */
  const [gps, setGps] = useState(false);
  const [releves, setReleves] = useState({ points:[], count:0, loading:false, error:"" });
  /* Les niveaux de breakdown, et ce que le millésime porte réellement à chacun
     (chantier S8, point 6 : un shapefile par maille). Un niveau sans contour
     reste PROPOSÉ mais le dit — le choisir n'affiche rien, et un menu qui ne
     l'annonce pas laisse croire à une carte vide plutôt qu'à un fichier
     manquant. */
  const contoursParNiveau = Object.fromEntries(
    (db.geoVersion?.geom?.parNiveau || []).map(x => [x.level, x.units]));
  const GEO_LEVELS = niveaux(db, { from:"adm1", to:"adm4" })
    .map(([code, libelle]) => [code,
      contoursParNiveau[code] ? `${libelle} (${fmt(contoursParNiveau[code])})`
                              : `${libelle} — aucun contour`]);

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

  const cadre = useMemo(() => {
    const e = shapes.extent;
    if(!e) return bounds;
    const g = { minLat:e.south, maxLat:e.north, minLon:e.west, maxLon:e.east };
    if(!bounds) return g;
    return { minLat:Math.min(bounds.minLat, g.minLat), maxLat:Math.max(bounds.maxLat, g.maxLat),
             minLon:Math.min(bounds.minLon, g.minLon), maxLon:Math.max(bounds.maxLon, g.maxLon) };
  }, [bounds, shapes.extent]);

  const tags = useMemo(() => [...new Set(rows.map(s => s.activity_tag).filter(Boolean))].sort(), [rows]);
  const geo = useGeoCascade({ adm1: f.adm1 });

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

  /* Les relevés ne sont chargés qu'à la demande : c'est une couche d'enquête,
     pas l'affichage courant, et elle peut peser lourd sur un pays entier. */
  useEffect(() => {
    let vivant = true;
    if(!gps){ setReleves({ points:[], count:0, loading:false, error:"" }); return; }
    setReleves(r => ({ ...r, loading:true, error:"" }));
    api.get("/submissions/positions?limit=2000")
      .then(r => { if(vivant) setReleves({ points:r.points||[], count:r.count||0, loading:false, error:"" }); })
      .catch(e => { if(vivant) setReleves({ points:[], count:0, loading:false, error:e.message }); });
    return () => { vivant = false; };
  }, [gps]);

  const adm1s = useMemo(() => names(geo.adm1), [geo.adm1]);
  const adm2s = useMemo(() => names(geo.adm2), [geo.adm2]);

  const palette = useMemo(() => {
    const t = {}; tags.forEach((x,i) => { t[x] = [C.brand, C.ok, C.warn, C.orange, C.aqua, C.magenta, C.navy][i % 7]; });
    return t;
  }, [tags]);

  const colorOf = useCallback((s) => {
    if(colorMode === "security")
      return s.security === 0 ? C.ok : s.security === 1 ? C.warn : s.security === 3 ? C.bad : "#7c8792";
    if(colorMode === "activity") return palette[s.activity_tag] || "#94a3b8";
    if(colorMode === "status") return s.status === "Active" ? C.ok : "#94a3b8";
    const c = s.planned ? pct(s.done, s.planned) : (s.done ? 100 : 0);
    return s.planned === 0 && s.done === 0 ? "#c3cdd6" : c >= 80 ? C.ok : c >= 40 ? C.warn : C.bad;
  }, [colorMode, palette]);

  const radiusOf = useCallback((s) => {
    if(!sizeByBenef) return 6;
    return 5 + Math.min(13, Math.sqrt(n(s.beneficiaries)) / 16);
  }, [sizeByBenef]);

  const stats = useMemo(() => {
    const active = filtered.filter(s => s.status === "Active");
    const visited = filtered.filter(s => s.done > 0);
    const never = filtered.filter(s => !s.last_visit);
    return { total: filtered.length, active: active.length, visited: visited.length,
      never: never.length, benef: filtered.reduce((t,s) => t + n(s.beneficiaries), 0),
      coverage: pct(visited.length, active.length) };
  }, [filtered]);

  /* Valeurs thématiques par unité, agrégées depuis les sites chargés. Le
     rattachement se fait par p-code et non par nom : deux communes homonymes
     dans deux districts différents existent, et les confondre colorerait la
     mauvaise. Les valeurs remontent d'un niveau à l'autre par la propriété
     `parent` que le serveur joint à chaque contour. */
  const themeValues = useMemo(() => {
    if(fillMode === "none" || !shapes.features.length) return { par:{}, max:0, absent:0 };
    const parentDe = {};
    shapes.features.forEach(f => { parentDe[f.properties.pcode] = f.properties.parent; });
    const cible = new Set(shapes.features.map(f => f.properties.pcode));
    const par = {}; let absent = 0;
    for(const st of filtered){
      let p = st.geo_pcode, sauts = 0;
      while(p && !cible.has(p) && sauts++ < 10) p = parentDe[p];
      if(!p || !cible.has(p)){ absent++; continue; }
      const a = par[p] = par[p] || { sites:0, actifs:0, planifies:0, visites:0, benef:0 };
      a.sites++;
      if(st.status === "Active") a.actifs++;
      a.planifies += n(st.planned); a.visites += n(st.done); a.benef += n(st.beneficiaries);
    }
    const val = (a) => fillMode === "presence" ? a.sites
      : fillMode === "benef" ? a.benef
      : (a.planifies ? Math.round((a.visites / a.planifies) * 100) : (a.visites ? 100 : 0));
    const max = fillMode === "coverage" ? 100 : Math.max(0, ...Object.values(par).map(val));
    return { par, val, max, absent };
  }, [fillMode, shapes.features, filtered]);

  /* ── Synthèse affichée quand rien n'est sélectionné ────────────────
     Un panneau vide n'apprend rien. Tant qu'aucun site n'est choisi, la place
     sert à ce que la carte ne sait pas dire : les volumes du programme sur le
     périmètre affiché. Tout est calculé sur `filtered`, donc sur les filtres
     actifs — la synthèse suit la carte au lieu de parler d'autre chose. */
  const global = useMemo(() => {
    const an = db.year;
    const pdd = (db.pdd || []).filter(p => !an || String(p.year) === String(an));
    const nb = (v) => n(v ?? 0);
    /* Le plan de distribution nomme ses champs différemment selon qu'il vient
       du serveur ou d'une saisie encore locale : on accepte les deux plutôt que
       d'afficher zéro sur une différence de casse. */
    const benefPdd = pdd.reduce((t,p) => t + nb(p.benefPlanned ?? p.benef_planned), 0);
    const recu     = pdd.reduce((t,p) => t + nb(p.benefActual ?? p.benef_actual), 0);
    const tonnage  = pdd.reduce((t,p) => t + nb(p.tonnage), 0);
    const tonnageR = pdd.reduce((t,p) => t + nb(p.tonnageActual ?? p.tonnage_actual), 0);

    /* Ciblés par activité : le plan de distribution porte l'activité, la carte
       porte les sites. On croise les deux pour que la ligne « URT » dise à la
       fois combien de personnes et combien de sites. */
    const parAct = {};
    for(const p of pdd){
      const k = p.activity || p.activity_tag || "—";
      (parAct[k] = parAct[k] || { act:k, benef:0, tonnage:0, lignes:0 });
      parAct[k].benef += nb(p.benefPlanned ?? p.benef_planned);
      parAct[k].tonnage += nb(p.tonnage);
      parAct[k].lignes++;
    }
    for(const s of filtered){
      const k = s.activity_tag || "—";
      (parAct[k] = parAct[k] || { act:k, benef:0, tonnage:0, lignes:0 });
      parAct[k].sites = (parAct[k].sites || 0) + 1;
      parAct[k].planifies = (parAct[k].planifies || 0) + nb(s.planned);
      parAct[k].visites = (parAct[k].visites || 0) + nb(s.done);
    }
    const activites = Object.values(parAct)
      .sort((a,b) => (b.benef || 0) - (a.benef || 0)).slice(0, 8);

    /* Performance du suivi de processus : la part des visites prévues qui ont
       réellement eu lieu. C'est la question que pose l'écran de couverture,
       posée ici sur le périmètre cartographié. */
    const planifies = filtered.reduce((t,s) => t + nb(s.planned), 0);
    const visites   = filtered.reduce((t,s) => t + nb(s.done), 0);

    return { benefPdd, recu, tonnage, tonnageR, lignes: pdd.length, activites,
             planifies, visites, perf: pct(visites, planifies), an };
  }, [db.pdd, db.year, filtered]);

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

  /* ── Carte Leaflet ──────────────────────────────────────────────────
     Le conteneur est piloté à la main plutôt que par un composant React :
     Leaflet gère lui-même son DOM, et le laisser faire évite de recréer des
     milliers de couches à chaque rendu de React. */
  const boxRef = useRef(null);
  const mapRef = useRef(null);
  const tuilesRef = useRef(null);
  const ptsRef = useRef(null);
  const gpsRef = useRef(null);
  const shpRef = useRef(null);
  const marqueurs = useRef(new Map());
  const cadreVu = useRef("");
  /* Compteur de cycles de vie de la carte. React monte, démonte puis remonte les
     effets en mode strict ; sans ce compteur, les effets qui peuplent la carte
     ne se relanceraient pas après le remontage et l'écran resterait vide. Il
     sert aussi de garde : tant qu'il vaut 0, aucune couche n'est posée. */
  const [pret, setPret] = useState(0);

  useEffect(() => {
    if(mapRef.current || !boxRef.current) return;
    /* Leaflet dessine contours et points avec un moteur vectoriel, et c'est le
       SVG qu'il utilise par défaut. Là où il est absent, lui ajouter la moindre
       couche échoue au fond de la bibliothèque avec une erreur qui ne dit rien
       de la cause (`_leaflet_id` sur null) — on préfère ne pas créer la carte
       du tout : le répertoire des sites et la fiche de droite, eux, fonctionnent
       partout.

       On teste le SVG et lui seul. Leaflet annonce `Browser.canvas` vrai dès que
       la classe HTMLCanvasElement existe, ce qui est le cas sous jsdom où
       getContext n'est pourtant pas implémenté : s'y fier ferait échouer le
       rendu plus tard, et plus obscurément. Tout navigateur réel a le SVG.

       Le jour où la volumétrie l'exigera, c'est un regroupement des points en
       grappes qu'il faudra, pas un changement de moteur. */
    if(!L.Browser.svg) return;
    let map;
    try{
      /* Zoom à la molette, au double clic et au pincement : ce sont les valeurs
         par défaut de Leaflet, écrites ici noir sur blanc parce que le
         propriétaire du produit a demandé expressément le zoom à la souris —
         personne ne doit pouvoir les retirer par accident sans que la ligne
         le dise. */
      map = L.map(boxRef.current, { zoomControl:true, attributionControl:true,
        scrollWheelZoom:true, doubleClickZoom:true, touchZoom:true,
        worldCopyJump:false });
    }catch(e){ return; }           /* conteneur absent : on n'affiche pas de carte */
    map.setView([-18.9, 47.5], 5); /* repli avant tout cadrage réel */
    mapRef.current = map;
    shpRef.current = L.layerGroup().addTo(map);
    ptsRef.current = L.layerGroup().addTo(map);
    gpsRef.current = L.layerGroup().addTo(map);
    map.on("click", () => { setSel(null); setSelShape(null); });
    setPret(v => v + 1);
    return () => {
      /* Tout est remis à zéro, pas seulement la carte : garder un groupe de
         couches rattaché à une carte détruite fait échouer le prochain ajout
         de couche, et l'erreur est illisible. */
      try{ map.remove(); }catch(e){ /* déjà détruite */ }
      mapRef.current = null; shpRef.current = null; ptsRef.current = null; gpsRef.current = null;
      tuilesRef.current = null; marqueurs.current.clear(); cadreVu.current = "";
    };
  }, []);

  /* Fond de tuiles, ajouté et retiré à la demande. Le retirer est utile hors
     ligne : sans réseau, Leaflet réessaie chaque tuile et le journal se
     remplit d'erreurs pour un fond qui n'arrivera pas. */
  useEffect(() => {
    const map = mapRef.current;
    if(!map) return;
    if(tuilesRef.current){ map.removeLayer(tuilesRef.current); tuilesRef.current = null; }
    setTuiles({ ok:0, ko:0 });
    if(fond === "aucun") return;
    /* Une URL posée dans les réglages l'emporte sur la liste : c'est ainsi
       qu'une instance pointe un serveur de tuiles interne. */
    const perso = db.settings?.tileUrl;
    const choix = FONDS.find(f => f[0] === fond) || FONDS[0];
    const url = perso || choix[2];
    const couche = L.tileLayer(url, {
      attribution: perso ? "Fond de carte interne" : choix[3],
      maxZoom: 19, crossOrigin: true,
      /* Les fournisseurs qui ne répartissent pas par sous-domaine ignorent
         simplement cette liste ; ceux qui le font en ont besoin. */
      subdomains: /\{s\}/.test(url) ? ["a","b","c"] : [""],
    });
    couche.on("tileload",  () => setTuiles(t => ({ ...t, ok: t.ok + 1 })));
    couche.on("tileerror", () => setTuiles(t => ({ ...t, ko: t.ko + 1 })));
    couche.addTo(map);
    couche.bringToBack();
    tuilesRef.current = couche;
  }, [fond, db.settings?.tileUrl, pret]);

  /* Cadrage : seulement quand le périmètre change réellement, sinon chaque
     rafraîchissement des points ramènerait l'utilisateur à son point de
     départ au milieu de sa navigation. */
  useEffect(() => {
    const map = mapRef.current;
    if(!map || !cadre) return;
    const cle = [cadre.minLat, cadre.maxLat, cadre.minLon, cadre.maxLon].map(v => r2(v)).join(",");
    if(cle === cadreVu.current) return;
    cadreVu.current = cle;
    try{
      map.fitBounds([[cadre.minLat, cadre.minLon], [cadre.maxLat, cadre.maxLon]], { padding:[24,24] });
    }catch(e){ /* emprise dégénérée : on garde la vue courante */ }
  }, [cadre, pret]);

  /* Contours administratifs. L'opacité est volontairement basse : le fond de
     carte doit rester lisible dessous, c'est précisément ce qu'on lui demande.
     L'unité sans donnée n'est pas peinte du tout. */
  useEffect(() => {
    const g = shpRef.current;
    if(!g) return;
    g.clearLayers();
    if(!contours) return;          /* escamotés : rien à dessiner, la vue est libre */
    for(const feat of shapes.features){
      const pc = feat.properties.pcode;
      const a = themeValues.par?.[pc];
      const teinte = fillMode === "none" || !a ? null
        : classify(themeValues.val(a), themeValues.max);
      const actif = selShape === pc;
      const couche = L.geoJSON(feat, { style: {
        color: actif ? C.brandD : "#5f7183",
        weight: actif ? 2.5 : 0.8,
        opacity: actif ? 1 : 0.75,
        fillColor: teinte || "#000000",
        fillOpacity: teinte ? 0.45 : 0,
      }});
      couche.on("click", (e) => { L.DomEvent.stop(e); setSelShape(p => p === pc ? null : pc); });
      couche.bindTooltip(esc(feat.properties.name), { sticky:true });
      g.addLayer(couche);
    }
  }, [shapes.features, fillMode, themeValues, selShape, pret, contours]);

  /* Points de site. Un cercle plutôt qu'une épingle : le rayon porte le nombre
     de bénéficiaires et la couleur porte le mode thématique choisi — deux
     informations qu'une épingle uniforme ne sait pas rendre. */
  /* Le nombre de points est PLAFONNÉ, et la troncature se dit. Sans plafond, un
     jeu national géolocalisé fabriquait un marqueur et un corps de bulle par site —
     des milliers de couches vectorielles reconstruites à chaque changement de
     filtre ou de thème —, ce qui figeait le déplacement de la carte. Le plafond est
     bien plus haut que celui de la liste latérale (400) : une carte vit de sa
     densité, une liste se lit. Les sites retenus sont les mêmes que ceux du haut de
     la liste — les plus grands bénéficiaires d'abord —, pour que ce qui disparaît
     soit toujours le plus petit, et non un site au hasard. */
  const PLAFOND_POINTS = 3000;
  const pointsCarte = useMemo(() => {
    const avecGps = filtered.filter(s => s.lat != null && s.lon != null);
    if(avecGps.length <= PLAFOND_POINTS) return avecGps;
    return [...avecGps].sort((a,b) => (b.benef || 0) - (a.benef || 0)).slice(0, PLAFOND_POINTS);
  }, [filtered]);
  const pointsTronques = filtered.filter(s => s.lat != null && s.lon != null).length
    - pointsCarte.length;

  useEffect(() => {
    const g = ptsRef.current;
    if(!g) return;
    g.clearLayers();
    marqueurs.current.clear();
    for(const s of pointsCarte){
      const m = L.circleMarker([s.lat, s.lon], {
        radius: radiusOf(s), color:"#ffffff", weight:1.5,
        fillColor: colorOf(s), fillOpacity:0.9,
      });
      m.bindPopup(popupHtml(s, db), { maxWidth:280, className:"mems-popup" });
      m.on("click", (e) => { L.DomEvent.stop(e); setSel(s); });
      g.addLayer(m);
      marqueurs.current.set(s.id, m);
    }
  }, [pointsCarte, colorOf, radiusOf, db, pret]);

  /* Couche des relevés GPS. Volontairement différente à l'œil des points de
     site — losange creux, teinte violette — pour qu'on ne puisse pas la
     confondre avec le registre. Un relevé non rattaché à un site est ambré :
     c'est celui sur lequel il y a du travail. */
  useEffect(() => {
    const g = gpsRef.current;
    if(!g) return;
    g.clearLayers();
    if(!gps) return;
    for(const p of releves.points){
      if(p.lat == null || p.lon == null) continue;
      const orphelin = !p.site_id;
      const m = L.circleMarker([p.lat, p.lon], {
        radius: 4.5, color: orphelin ? "#b45309" : "#7c3aed", weight: 2,
        fillColor: "#ffffff", fillOpacity: 0.9,
      });
      m.bindPopup(popupReleve(p), { maxWidth:280, className:"mems-popup" });
      g.addLayer(m);
      /* Le trait ne se dessine qu'au-delà d'un écart notable : en deçà, il
         encombrerait la carte sans rien montrer. C'est ce trait qui rend
         visible la dérive entre position déclarée et position observée — la
         mesure qui permettra de trancher, plus tard, laquelle fait foi. */
      if(p.site_lat != null && p.site_lon != null && n(p.ecart_m) > 250){
        g.addLayer(L.polyline([[p.lat, p.lon], [p.site_lat, p.site_lon]], {
          color:"#7c3aed", weight:1, opacity:0.5, dashArray:"3 4" }));
      }
    }
  }, [gps, releves.points, pret]);

  /* Sélection depuis la liste : on recentre et on ouvre le popup, comme le
     ferait un clic sur le point lui-même. */
  const choisir = (s) => {
    setSel(s);
    const map = mapRef.current, m = marqueurs.current.get(s.id);
    if(map && s.lat != null && s.lon != null){
      map.setView([s.lat, s.lon], Math.max(map.getZoom(), 11), { animate:true });
      if(m) m.openPopup();
    }
  };

  const recentrer = () => {
    const map = mapRef.current;
    if(!map || !cadre) return;
    try{ map.fitBounds([[cadre.minLat, cadre.minLon], [cadre.maxLat, cadre.maxLon]], { padding:[24,24] }); }
    catch(e){ /* rien à recentrer */ }
  };

  const sansCoord = rows.length && !rows.some(s => s.lat != null && s.lon != null);

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
        subtitle={busy ? "Chargement des points…" : `${fmt(filtered.length)} points affichés · fond OpenStreetMap`}
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
            <label className="flex items-center gap-1.5 f115 text-slate-600"
              title="Afficher ou masquer les limites administratives — bordures et remplissage">
              <input type="checkbox" checked={contours} onChange={e=>basculerContours(e.target.checked)} />
              contours</label>
            {contours && (<>
              <Select value={geoLevel} onChange={e=>setGeoLevel(e.target.value)}
                options={GEO_LEVELS} className="mi-py1 mi-xs mi-wauto" />
              <Select value={fillMode} onChange={e=>setFillMode(e.target.value)}
                options={FILL_MODES} className="mi-py1 mi-xs mi-wauto" />
            </>)}
            <span className="w-px h-6 bg-slate-300 mx-1" />
          </>)}
          <Select value={colorMode} onChange={e=>setColorMode(e.target.value)}
            options={COLOR_MODES} className="mi-py1 mi-xs mi-wauto" />
          <label className="flex items-center gap-1.5 f115 text-slate-600">
            <input type="checkbox" checked={sizeByBenef} onChange={e=>setSizeByBenef(e.target.checked)} />
            taille selon les bénéficiaires</label>
          <Select value={fond} onChange={e=>setFond(e.target.value)}
            options={FONDS.map(f => [f[0], f[1]])} className="mi-py1 mi-xs mi-wauto" />
          <label className="flex items-center gap-1.5 f115 text-slate-600"
            title="Positions relevées au GPS par les formulaires de collecte, distinctes de la position déclarée du site">
            <input type="checkbox" checked={gps} onChange={e=>setGps(e.target.checked)} />
            relevés GPS{releves.count ? ` (${fmt(releves.count)})` : ""}</label>
          <div className="ml-auto">
            <Btn size="sm" kind="ghost" onClick={recentrer}>Recentrer</Btn>
          </div>
        </div>

        {error ? <Note tone="err">{error}</Note> : null}
        {/* Un fond qui n'arrive pas ne doit pas se traduire par un damier vide
            sans explication : c'est ce qui fait croire à un défaut de
            l'application alors que le refus vient du fournisseur de tuiles.
            OpenStreetMap, en particulier, limite le trafic venant d'un centre
            de données — donc de toute instance hébergée dans le nuage. */}
        {fond !== "aucun" && tuiles.ko >= 4 && tuiles.ok === 0 ? (
          <Note tone="warn">
            Le fond de carte « {(FONDS.find(f=>f[0]===fond)||[])[1]} » n'a pas pu être chargé
            ({tuiles.ko} tuiles refusées). Les contours et les points, eux, s'affichent
            normalement. Essayez un autre fond dans la liste ci-dessus — leurs conditions
            d'accès diffèrent, et OpenStreetMap refuse le trafic venant d'un hébergement en
            nuage. Pour une instance sans accès à l'internet, choisissez « Aucun fond », ou
            renseignez l'adresse d'un serveur de tuiles interne dans les réglages.
          </Note>) : null}
        {sansCoord ? (
          <Note tone="warn">Aucun des {fmt(rows.length)} sites de cette sélection ne porte de
            coordonnées. Renseignez la latitude et la longitude dans le registre des sites, ou
            laissez-les remonter des relevés GPS des formulaires de collecte.</Note>) : null}

        <div className="flex">
          {/* ── Répertoire des sites ──────────────────────────────────
              La liste et la carte désignent le même objet : cliquer dans l'une
              recentre l'autre. C'est ce qui permet de trouver un site par son
              nom sans le chercher à l'œil sur le fond de carte. */}
          <div className="w-64 shrink-0 border-r border-slate-200 mh68 overflow-auto bg-slate-50">
            <div className="px-3 py-2 f11 font-bold uppercase tracking-wide text-slate-500 sticky top-0 bg-slate-50 border-b border-slate-200">
              {fmt(filtered.length)} site{filtered.length > 1 ? "s" : ""}
            </div>
            {!filtered.length ? (
              <p className="p-3 f115 text-slate-500">{busy ? "Chargement…" : "Aucun site pour ces filtres."}</p>
            ) : filtered.slice(0, 400).map(s => {
              const actif = sel && sel.id === s.id;
              return (
                <button key={s.id} type="button" onClick={()=>choisir(s)}
                  data-site-item={s.code}
                  className={clsx("w-full text-left px-3 py-2 border-b border-slate-200 transition-colors",
                    actif ? "bg-sky-700 text-white" : "hover:bg-sky-50")}>
                  <div className="flex items-start gap-2">
                    <i className="w-2.5 h-2.5 rounded-full mt-1 shrink-0 border border-white/70"
                       style={{ background: colorOf(s) }} />
                    <div className="min-w-0">
                      <div className={clsx("f13 font-semibold truncate", actif ? "text-white" : "text-slate-800")}>
                        {s.name}</div>
                      <div className={clsx("f11 truncate", actif ? "text-sky-100" : "text-slate-500")}>
                        {[s.adm3, s.adm2].filter(Boolean).join(", ") || s.code}</div>
                      <div className={clsx("f105 truncate", actif ? "text-sky-200" : "text-slate-400")}>
                        {fmt(s.beneficiaries)} bénéf. · {s.done}/{s.planned || "—"} visites</div>
                    </div>
                  </div>
                </button>);
            })}
            {filtered.length > 400 && (
              <p className="p-3 f105 text-amber-700">
                Liste tronquée à 400 entrées sur {fmt(filtered.length)} : affinez la recherche ou
                les filtres.{" "}
                {/* La carte a désormais son propre plafond : l'annoncer, plutôt que
                    de promettre « tous les points » comme avant. Une troncature tue
                    est pire qu'une troncature dite. */}
                {pointsTronques > 0
                  ? <>La carte en affiche {fmt(PLAFOND_POINTS)} — les {fmt(pointsTronques)} sites
                      aux effectifs les plus faibles n'y sont pas dessinés.</>
                  : <>Tous les points géolocalisés restent affichés sur la carte.</>}</p>)}
          </div>

          {/* Le conteneur Leaflet. La hauteur doit être posée en dur : sans
              hauteur explicite, Leaflet calcule une carte de zéro pixel. */}
          <div className="flex-1 min-w-0 relative">
            <div ref={boxRef} className="mh68" style={{ minHeight:520, background:"#eef3f7" }} />
          </div>

          <aside className="w-72 shrink-0 border-l border-slate-200 p-4 mh68 overflow-auto">
            {contours && fillMode !== "none" && !!shapes.features.length && (
              <div className="mb-4">
                <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                  {(FILL_MODES.find(m=>m[0]===fillMode)||[])[1]}
                  <span className="font-normal normal-case tracking-normal text-slate-400">
                    {" "}· {(GEO_LEVELS.find(g=>g[0]===geoLevel)||[])[1].toLowerCase()}</span></div>
                <div className="flex h-3 rounded overflow-hidden border border-slate-200">
                  <i className="flex-1 bg-white" title="aucun" />
                  {RAMP.map(c => <i key={c} className="flex-1" style={{ background:c }} />)}
                </div>
                <div className="flex justify-between f105 text-slate-400 mt-1">
                  <span>aucun</span>
                  <span>{fillMode === "coverage" ? "100 %" : fmt(themeValues.max)}</span></div>
                {!!themeValues.absent && (
                  <div className="f105 text-amber-700 mt-1">
                    {fmt(themeValues.absent)} site(s) sans rattachement au découpage :
                    visibles en points, comptés dans aucune unité.</div>)}
                {shapes.tronque && (
                  <div className="f105 text-amber-700 mt-1">
                    Affichage tronqué : filtrez par région ou district pour voir ce niveau en entier.</div>)}
              </div>)}

            {!db.geoVersion?.geom?.units ? (
              <Note tone="warn">Aucun contour chargé : les limites administratives n'apparaissent
                pas. Paramètres → Pays → Contours par niveau.</Note>
            ) : !contoursParNiveau[geoLevel] && (
              /* Le millésime porte des contours, mais pas à CETTE maille. Le dire
                 ici, au moment où la carte est vide, est la seule façon de ne pas
                 laisser croire à une panne. */
              <Note tone="warn">Ce niveau de breakdown n'a pas de contours dans le millésime
                courant. Déposez son shapefile — Paramètres → Pays → <b>Contours par niveau</b> —
                ou choisissez un niveau qui en porte.</Note>)}

            {selShape && (() => {
              const feat = shapes.features.find(x => x.properties.pcode === selShape);
              const a = themeValues.par?.[selShape];
              return feat && (
                <div className="mb-4">
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                    Unité sélectionnée</div>
                  <div className="border border-slate-200 rounded p-3">
                    <div className="f13 font-semibold text-slate-800">{feat.properties.name}</div>
                    <div className="f11 text-slate-500 mb-2">{feat.properties.level} · {selShape}</div>
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

            {gps && (() => {
              const pts = releves.points;
              const orphelins = pts.filter(p => !p.site_id).length;
              const ecarts = pts.map(p => n(p.ecart_m)).filter(v => v > 0).sort((a,b) => a-b);
              const median = ecarts.length ? ecarts[Math.floor(ecarts.length/2)] : 0;
              return (
                <div className="mb-4">
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                    Relevés GPS des collectes</div>
                  {releves.error ? <Note tone="err">{releves.error}</Note> : releves.loading ? (
                    <p className="f115 text-slate-500">Chargement des relevés…</p>
                  ) : !pts.length ? (
                    <p className="f115 text-slate-500 leading-relaxed">
                      Aucun relevé. Ils apparaissent après un tirage ODK Central puis un versement
                      des soumissions (Programme → Soumissions).</p>
                  ) : (
                    <div className="border border-slate-200 rounded p-3">
                      <dl className="space-y-1 f115">
                        {[["Relevés affichés", fmt(pts.length)],
                          ["Non rattachés", fmt(orphelins)],
                          ["Écart médian au site", median ? `${Math.round(median)} m` : "—"]].map(([k,v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <dt className="text-slate-500">{k}</dt>
                            <dd className="font-medium tabular-nums">{v}</dd></div>))}
                      </dl>
                      <div className="flex items-center gap-2 f105 text-slate-500 mt-2">
                        <i className="w-2.5 h-2.5 rounded-full border-2 shrink-0" style={{ borderColor:"#7c3aed" }} />
                        rattaché
                        <i className="w-2.5 h-2.5 rounded-full border-2 shrink-0 ml-2" style={{ borderColor:"#b45309" }} />
                        non rattaché
                      </div>
                      <p className="f105 text-slate-400 mt-2 leading-relaxed">
                        Un relevé marque où se tenait l'agent, pas la position officielle du site.
                        Le trait pointillé signale un écart de plus de 250 m. Le registre n'est
                        jamais modifié automatiquement.</p>
                    </div>)}
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
                      ["Coordonnées", sel.lat == null ? "non renseignées" : `${r2(sel.lat)}, ${r2(sel.lon)}`],
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
              <>
                <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                  Vue d'ensemble{global.an ? ` · ${global.an}` : ""}</div>
                <div className="border border-slate-200 rounded p-3 mb-3">
                  <dl className="space-y-1 f115">
                    {[["Population couverte", fmt(stats.benef)],
                      ["Ciblés au plan", fmt(global.benefPdd)],
                      ["Atteints", global.recu ? fmt(global.recu) : "non renseigné"],
                      ["Lignes de distribution", fmt(global.lignes)],
                      ["Tonnage prévu", global.tonnage ? `${fmt(r2(global.tonnage))} t` : "—"],
                      ["Tonnage reçu", global.tonnageR ? `${fmt(r2(global.tonnageR))} t` : "non renseigné"],
                    ].map(([k,v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-slate-500">{k}</dt>
                        <dd className="font-medium tabular-nums">{v}</dd></div>))}
                  </dl>
                </div>

                <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                  Suivi de processus</div>
                <div className="border border-slate-200 rounded p-3 mb-3">
                  <div className="flex justify-between f115 text-slate-600 mb-1">
                    <span>Visites réalisées</span>
                    <b className="tabular-nums">{fmt(global.visites)} / {fmt(global.planifies)}</b></div>
                  <Bar2 value={global.perf} tone={global.perf >= 80 ? "ok" : global.perf >= 40 ? "warn" : "bad"} />
                  <div className="f105 text-slate-500 mt-1">
                    {global.perf} % du plan · {fmt(stats.never)} site(s) jamais visité(s)</div>
                </div>

                {!!global.activites.length && (<>
                  <div className="f11 font-bold uppercase tracking-wide text-slate-500 mb-2">
                    Performance par activité</div>
                  <ul className="space-y-2 mb-3">
                    {global.activites.map(a => {
                      const p = pct(a.visites || 0, a.planifies || 0);
                      return (
                        <li key={a.act} className="border border-slate-200 rounded p-2">
                          <div className="flex justify-between gap-2 f115">
                            <b className="text-slate-800 truncate" title={a.act}>{a.act}</b>
                            <span className="text-slate-500 tabular-nums shrink-0">
                              {a.sites ? `${fmt(a.sites)} site(s)` : "—"}</span></div>
                          <div className="f105 text-slate-500 tabular-nums">
                            {a.benef ? `${fmt(a.benef)} ciblés` : "aucun plan"}
                            {a.tonnage ? ` · ${fmt(r2(a.tonnage))} t` : ""}</div>
                          {!!a.planifies && (<>
                            <Bar2 value={p} tone={p >= 80 ? "ok" : p >= 40 ? "warn" : "bad"} />
                            <div className="f105 text-slate-400 tabular-nums">
                              {fmt(a.visites || 0)} / {fmt(a.planifies)} visites · {p} %</div>
                          </>)}
                        </li>);
                    })}
                  </ul>
                </>)}

                <p className="f105 text-slate-500 leading-relaxed">
                  Choisissez un site dans la liste de gauche ou cliquez un point sur la carte
                  pour ouvrir sa fiche détaillée.</p>
              </>
            )}
          </aside>
        </div>
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

/* Le popup reprend la forme d'une fiche d'adresse : le nom en tête, puis les
   quelques lignes qu'on veut lire sans ouvrir la fiche complète. Tout ce qui
   vient de la base est échappé. */
function popupHtml(s, db){
  const ligne = (label, valeur) => valeur
    ? `<div class="mp-l"><span class="mp-k">${esc(label)}</span><span class="mp-v">${esc(valeur)}</span></div>`
    : "";
  const lieu = [s.adm3, s.adm2, s.adm1].filter(Boolean).join(", ");
  return `<div class="mp">
    <div class="mp-t">${esc(s.name)}</div>
    <div class="mp-s">${esc(s.code)}${s.office ? " · " + esc(s.office) : ""}</div>
    ${ligne("Emplacement", lieu)}
    ${ligne(niveau(db, "adm4"), s.adm4)}
    ${ligne("Activité", s.activity_tag)}
    ${ligne("Bénéficiaires", fmt(s.beneficiaries))}
    ${ligne("Visites", `${s.done} / ${s.planned || "—"}`)}
    ${ligne("Dernière visite", s.last_visit || "jamais")}
  </div>`;
}

/* Fiche d'un relevé GPS. Elle dit d'abord ce que le relevé est — une position
   observée lors d'une collecte — puis à quel site il se rattache et de combien
   il s'en écarte. L'écart est l'information utile : c'est lui qui dira si la
   position déclarée du site mérite d'être corrigée. */
function popupReleve(p){
  const ligne = (label, valeur) => valeur
    ? `<div class="mp-l"><span class="mp-k">${esc(label)}</span><span class="mp-v">${esc(valeur)}</span></div>`
    : "";
  const rattache = p.site_id
    ? `${p.site_name || "site"}${p.site_code ? " · " + p.site_code : ""}`
    : "";
  return `<div class="mp">
    <div class="mp-t">Relevé GPS</div>
    <div class="mp-s">${esc(p.form_id || "collecte")}${p.svy_date ? " · " + esc(p.svy_date) : ""}</div>
    ${rattache
      ? ligne("Site", rattache)
      : '<div class="mp-l"><span class="mp-k">Site</span><span class="mp-v" style="color:#b45309">non rattaché</span></div>'}
    ${p.ecart_m != null ? ligne("Écart au site", `${Math.round(p.ecart_m)} m`) : ""}
    ${p.gps_accuracy != null ? ligne("Précision", `${Math.round(p.gps_accuracy)} m`) : ""}
    ${ligne("Coordonnées", `${r2(p.lat)}, ${r2(p.lon)}`)}
  </div>`;
}
