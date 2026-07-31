import { useEffect, useId } from "react";
import { Layers, X } from "lucide-react";
import { clsx, n } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Composants d'interface ══════════════════ */
const Card = ({ title, subtitle, right, children, className, flush }) => (
  <section className={clsx("bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm", className)}>
    {(title || right) && (
      <header className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
        <div className="min-w-0">
          {title && <h3 className="f13 font-semibold text-slate-800 truncate">{title}</h3>}
          {subtitle && <p className="f115 text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0 flex-wrap justify-end">{right}</div>
      </header>)}
    <div className={flush ? "" : "p-5"}>{children}</div>
  </section>
);
/* ══════════════════ La marque ══════════════════

   L'ancien signe était un arc surmonté de deux silhouettes, d'une tige et d'une cible,
   le tout en dégradés. Cinq éléments distincts, dessinés pour être regardés grands, et
   affichés à trente pixels dans l'en-tête : à cette taille l'arc devenait une bavure
   grise, les silhouettes disparaissaient, et il ne restait qu'une tache indistincte
   qu'on ne reconnaissait pas d'un écran à l'autre.

   Un signe se dessine pour sa PLUS PETITE utilisation. Ici, c'est vingt-huit pixels
   dans une barre bleu sombre. Ce qui survit à cette taille, c'est une silhouette pleine
   et une forme intérieure très contrastée — autrement dit une tuile et une lettre.

   D'où : une tuile aux angles arrondis, un M géométrique évidé en blanc, et le point
   ambre conservé de l'identité précédente — le seul élément qu'on reconnaissait
   vraiment. Il est posé en haut à droite, comme le relevé qu'on vient de prendre.

   Deux versions, parce qu'un fond sombre et un fond clair ne pardonnent pas les mêmes
   choses : sur le bleu de l'en-tête, la tuile devient blanche et la lettre bleue. La
   silhouette, elle, ne change pas — c'est elle qu'on reconnaît. */
const MARQUE_M = "M22 74 L22 26 L35 26 L50 49 L65 26 L78 26 L78 74 L66 74 L66 45 L50 68 L34 45 L34 74 Z";

const BrandMark = ({ size = 40, className, tone = "dark" }) => {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clair = tone === "light";
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"
      width={size} height={size} className={className} role="img" aria-label="MEMS">
      <defs>
        <linearGradient id={`tuile${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          {clair
            ? (<><stop offset="0%" stopColor="#FFFFFF" /><stop offset="100%" stopColor="#DCEEF8" /></>)
            : (<><stop offset="0%" stopColor="#0A6FA8" /><stop offset="55%" stopColor="#007DBC" />
                 <stop offset="100%" stopColor="#0FA37F" /></>)}
        </linearGradient>
      </defs>
      {/* La tuile porte tout : c'est elle qui reste lisible quand le reste ne l'est plus. */}
      <rect x="2" y="2" width="96" height="96" rx="26" fill={`url(#tuile${id})`} />
      <path d={MARQUE_M} fill={clair ? "#0A6FA8" : "#FFFFFF"} />
      {/* Le relevé. Détouré par un liseré de la couleur de la tuile pour rester net
          même lorsque deux pixels seulement le séparent du bord. */}
      <circle cx="76" cy="24" r="12" fill={clair ? "#FFFFFF" : "url(#tuile" + id + ")"} />
      <circle cx="76" cy="24" r="8.5" fill="#F59E0B" />
    </svg>
  );
};

/* Le logotype complet : le signe, le nom, et ce que le nom veut dire. Il sert là où
   l'on a la place de tout lire — écran de connexion, pied de page, en-tête de rapport —
   et jamais dans une barre de navigation, où seul le signe tient. */
const Logo = ({ size = 40, className, tone = "dark", sansTagline = false }) => {
  const clair = tone === "light";
  return (
    <div className={clsx("flex items-center gap-3", className)}>
      <BrandMark size={size} tone={tone} />
      <div className="leading-tight min-w-0">
        <div className={clsx("font-bold tracking-[0.18em]", clair ? "text-white" : "text-slate-900")}
          style={{ fontSize: Math.round(size * 0.44) }}>MEMS</div>
        {!sansTagline && (
          <div className={clsx("truncate", clair ? "text-white/70" : "text-slate-500")}
            style={{ fontSize: Math.max(9, Math.round(size * 0.235)) }}>
            Monitoring and Evaluation Management System</div>)}
      </div>
    </div>
  );
};
const Btn = ({ kind="primary", size="md", icon:Icon, children, className, ...p }) => {
  const k = { primary:"m-btn-primary", sec:"m-btn-sec", ghost:"m-btn-ghost", danger:"m-btn-danger" }[kind];
  const s = size==="sm" ? "px-2.5 py-1 f11" : "px-3.5 py-1.5 f13";
  return <button {...p} className={clsx("inline-flex items-center gap-1.5 border rounded font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed", k, s, className)}>
    {Icon && <Icon size={size==="sm"?13:15} />}{children}</button>;
};
const Field = ({ label, hint, children, className }) => (
  <label className={clsx("block mb-3", className)}>
    {label && <span className="block f11 font-semibold text-slate-600 mb-1">{label}</span>}
    {children}
    {hint && <span className="block f105 text-slate-400 mt-1">{hint}</span>}
  </label>
);
const inputCls = "m-input";
const Input = (p) => <input {...p} className={clsx(inputCls, p.className)} />;
const Select = ({ options=[], empty, ...p }) => (
  <select {...p} className={clsx(inputCls, p.className)}>
    {empty !== undefined && <option value="">{empty}</option>}
    {options.map((o,i) => { const [v,l] = Array.isArray(o)?o:[o,o];
      return <option key={String(v)+"__"+i} value={v}>{l}</option>; })}
  </select>
);
const Badge = ({ tone="n", children }) => {
  const t = { g:"bg-lime-50 text-lime-800 border-lime-200", y:"bg-amber-50 text-amber-800 border-amber-200",
    r:"bg-rose-50 text-rose-800 border-rose-200", b:"bg-sky-50 text-sky-800 border-sky-200",
    n:"bg-slate-50 text-slate-600 border-slate-200" }[tone];
  return <span className={clsx("inline-block px-2 py-0.5 rounded-full f11 font-semibold border whitespace-nowrap", t)}>{children}</span>;
};
const Stat = ({ label, value, sub, tone, icon:Icon }) => (
  <div className="bg-white p-4">
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="f105 font-bold uppercase tracking-wider text-slate-500">{label}</div>
        <div className={clsx("text-3xl font-light mt-1.5 tabular-nums leading-none",
          tone==="bad"?"text-rose-700":tone==="ok"?"text-lime-700":tone==="warn"?"text-amber-600":"text-slate-800")}>{value}</div>
        {sub && <div className="f11 text-slate-500 mt-1.5">{sub}</div>}
      </div>
      {Icon && <Icon size={17} className="text-slate-300 shrink-0" />}
    </div>
  </div>);
const StatRow = ({ children }) => (
  <div className="grid gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden mb-4"
    style={{gridTemplateColumns:"repeat(auto-fit,minmax(176px,1fr))"}}>{children}</div>);
const Bar2 = ({ value, tone }) => (
  <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden mnw52">
    <div className="h-full rounded-full" style={{ width:Math.min(100,Math.max(0,value))+"%",
      background: tone==="bad"?C.bad : tone==="warn"?C.warn : tone==="ok"?C.ok : C.brand }} /></div>);
const Tabs = ({ items, value, onChange, className }) => (
  <div className={clsx("flex gap-0.5 border-b border-slate-200 overflow-x-auto", className)}>
    {items.map(([v,l]) => (
      <button key={v} onClick={()=>onChange(v)}
        className={clsx("px-4 py-2 f13 font-semibold whitespace-nowrap -mb-px border-b-2 transition-colors",
          value===v ? "c-bd bd-brand" : "text-slate-500 border-transparent hover:text-slate-800")}>{l}</button>))}
  </div>);
const Modal = ({ open, title, subtitle, onClose, children, footer, wide }) => {
  /* La touche d'échappement ferme la fiche. Elle ne le faisait pas : il fallait
     viser la croix ou le fond, ce que personne ne fait après avoir rempli un
     formulaire au clavier. Le raccourci est attendu de tout dialogue. */
  useEffect(() => {
    if(!open) return;
    const h = (e) => { if(e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  if(!open) return null;
  return (
    <div className="fixed inset-0 z60 flex items-start justify-center overflow-auto py-8 px-4"
      style={{background:"rgba(3,28,45,.45)"}} onMouseDown={e=>e.target===e.currentTarget&&onClose()}>
      <div className={clsx("bg-white rounded shadow-2xl w-full", wide?"max-w-5xl":"max-w-2xl")}>
        <header className="flex items-start gap-3 px-5 py-4 border-b border-slate-200">
          <div className="min-w-0"><h3 className="f15 font-semibold text-slate-800">{title}</h3>
            {subtitle && <p className="f115 text-slate-500 mt-0.5">{subtitle}</p>}</div>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700 p-1"><X size={18} /></button>
        </header>
        {/* Une fiche large sert à éditer du tableau : la limiter à 68 % de la hauteur
            laissait le tableau sous la ligne de pliure, alors qu'il est la raison
            d'ouvrir la fiche. Les fiches étroites gardent leur hauteur. */}
        <div className={clsx("px-5 py-4 overflow-auto", wide ? "mh78" : "mh68")}>{children}</div>
        {footer && <footer className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">{footer}</footer>}
      </div>
    </div>);
};
const Empty = ({ icon:Icon=Layers, title, text, action }) => (
  <div className="py-12 text-center">
    <div className="w-11 h-11 rounded-full bg-slate-50 border border-slate-200 grid place-items-center mx-auto mb-3 text-slate-400"><Icon size={19} /></div>
    <h4 className="f15 font-semibold text-slate-800">{title}</h4>
    {text && <p className="f13 text-slate-500 max-w-md mx-auto mt-1.5 mb-4 leading-relaxed">{text}</p>}
    {action}
  </div>);
const Th = ({ children, num, className }) => (
  <th className={clsx("px-3 h-8 f105 font-bold uppercase tracking-wider text-slate-500 bg-slate-50 sticky top-0 z-10 border-b border-slate-200 whitespace-nowrap",
    num?"text-right":"text-left", className)}>{children}</th>);
const Td = ({ children, num, className, ...p }) => (
  <td {...p} className={clsx("px-3 h-9 border-b border-slate-100 whitespace-nowrap f125", num?"text-right tabular-nums":"", className)}>{children}</td>);
const TableWrap = ({ children, max="mh65" }) => (
  <div className={clsx("overflow-auto", max)}><table className="w-full border-collapse">{children}</table></div>);
const Note = ({ tone="info", children }) => {
  const t = { info:"bg-sky-50 bl3 bd-brand text-sky-900", warn:"bg-amber-50 bl3 bd-warn text-amber-900",
    ok:"bg-lime-50 bl3 border-lime-500 text-lime-900", err:"bg-rose-50 bl3 border-rose-500 text-rose-900" }[tone];
  return <div className={clsx("px-4 py-3 rounded f125 leading-relaxed mb-4", t)}>{children}</div>;
};
const Sw = ({ label, hint, on, onChange }) => (
  <div className="flex items-center gap-3 py-2.5 border-b border-slate-100 last:border-0">
    <div className="flex-1"><div className="f13 font-medium text-slate-800">{label}</div>
      {hint && <div className="f115 text-slate-500">{hint}</div>}</div>
    <button onClick={()=>onChange(!on)} className={clsx("relative w-10 h22 rounded-full transition-colors shrink-0", on?"bg-brand":"bg-slate-300")}>
      <span className={clsx("absolute top3 w-4 h-4 bg-white rounded-full transition-all", on?"lf21":"lf3")} /></button>
  </div>);
const Toast = ({ list }) => (
  <div className="fixed bottom-4 left-4 z60 flex flex-col gap-2 max-w-md">
    {list.map(t => (<div key={t.id} className={clsx("px-4 py-2.5 rounded f13 text-white shadow-lg bl3",
      t.kind==="err"?"border-rose-500":t.kind==="warn"?"bd-warn":t.kind==="ok"?"border-lime-500":"bd-brand")}
      style={{background:C.t1}}>{t.text}</div>))}
  </div>);
function download(name, content, type){
  const b = new Blob([content], { type: type || "text/plain;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click();
}
function toCSV(rows, cols){
  const q = v => { v = v===undefined||v===null?"":String(v); return /[",;\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  return "\ufeff" + [cols.join(","), ...rows.map(r => cols.map(c=>q(r[c])).join(","))].join("\n");
}
function parseCSV(txt){
  const rows=[]; let row=[],cur="",q=false; txt=String(txt).replace(/\r\n?/g,"\n");
  for(let i=0;i<txt.length;i++){ const ch=txt[i];
    if(q){ if(ch==='"'){ if(txt[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else if(ch==='"') q=true;
    else if(ch===","||ch===";"){row.push(cur);cur="";}
    else if(ch==="\n"){row.push(cur);rows.push(row);row=[];cur="";}
    else cur+=ch; }
  if(cur||row.length){row.push(cur);rows.push(row);}
  if(!rows.length) return [];
  const head = rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.some(c=>c!=="")).map(r=>Object.fromEntries(head.map((h,i)=>[h,(r[i]??"").trim()])));
}

export { Badge, Bar2, BrandMark, Btn, Card, Empty, Field, Input, Logo, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, Toast, download, inputCls, parseCSV, toCSV };
