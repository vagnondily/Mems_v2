import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, HelpCircle, Info, Layers, X } from "lucide-react";
import { clsx, n } from "../lib/calc.js";
import { C } from "../lib/constants.js";

/* ══════════════════ Notes explicatives : un interrupteur global ══════════════════
   « Pour toutes les petites notes dans chaque view, mettre en show and hide. »
   Les notes explicatives (tons « info » et « tool ») disent à quoi sert un écran ;
   utiles la première fois, elles encombrent ensuite. Plutôt qu'un pliage par note
   — vite fastidieux sur des dizaines d'écrans —, un seul interrupteur, dans la
   barre du haut, les masque toutes d'un coup et les rappelle de même. Les notes de
   VÉRIFICATION (warn, err, ok) ne sont jamais masquées : ce sont des états réels de
   la donnée — « cette correspondance ne passera pas » —, pas du commentaire.

   Un magasin externe minuscule plutôt qu'un contexte : `Note` est importée partout
   et n'a pas de fournisseur commun ; `useSyncExternalStore` lui donne l'état sans
   envelopper toute l'application. L'état survit au rechargement (localStorage). */
const NOTES_KEY = "mems.notes.masquees";
let notesMasquees = (() => { try{ return localStorage.getItem(NOTES_KEY) === "1"; }catch{ return false; } })();
const notesAbonnes = new Set();
function setNotesMasquees(v){
  notesMasquees = !!v;
  try{ localStorage.setItem(NOTES_KEY, notesMasquees ? "1" : "0"); }catch{}
  notesAbonnes.forEach(f => f());
}
function useNotesMasquees(){
  return useSyncExternalStore(
    cb => { notesAbonnes.add(cb); return () => notesAbonnes.delete(cb); },
    () => notesMasquees, () => notesMasquees);
}

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
const Logo = ({ width="100%", height="100%", className }) => {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 160" width={width} height={height} className={className}>
      <defs>
        <linearGradient id={`humGrad${id}`} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#0284C7" />
          <stop offset="60%" stopColor="#059669" />
          <stop offset="100%" stopColor="#10B981" />
        </linearGradient>
        <linearGradient id={`targetGrad${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#F59E0B" />
          <stop offset="100%" stopColor="#D97706" />
        </linearGradient>
      </defs>
      <g transform="translate(15, 10)">
        <path d="M 25 95 A 50 50 0 1 1 115 95" fill="none" stroke={`url(#humGrad${id})`} strokeWidth="9" strokeLinecap="round" />
        <path d="M 52 90 Q 52 65 62 55 Q 62 80 52 90 Z" fill="#0284C7" />
        <path d="M 88 90 Q 88 55 78 45 Q 78 75 88 90 Z" fill="#059669" />
        <rect x="67" y="35" width="6" height="55" rx="3" fill={`url(#humGrad${id})`} />
        <circle cx="70" cy="20" r="10" fill={`url(#targetGrad${id})`} />
        <circle cx="70" cy="20" r="4" fill="#FFFFFF" />
      </g>
      <text x="165" y="84" fontFamily="System-UI, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" fontSize="58" fontWeight="800" letterSpacing="2" fill="#0F172A">MEMS</text>
      <circle cx="370" cy="74" r="6" fill="#D97706" />
      <text x="167" y="112" fontFamily="System-UI, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" fontSize="11.5" fontWeight="700" letterSpacing="1.5" fill="#475569">Monitoring Evaluation Management System</text>
    </svg>
  );
};
/* Le signe, avec sa version inversée.
   Le dégradé bleu-vert d'origine est fait pour un fond clair ; posé sur le bleu
   sombre de l'en-tête, il s'y confondait et le signe disparaissait à moitié.
   Un logotype a besoin d'une version pour fond sombre — ici l'arc et les
   silhouettes en blanc, la cible ambre conservée comme unique accent. */
const BrandMark = ({ size = 40, className, tone = "dark" }) => {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clair = tone === "light";
  /* Sur fond sombre (l'en-tête bleu), la tuile s'inverse : carré blanc et M
     bleu. Sans cela le signe se confondrait avec son support et disparaîtrait
     à moitié — le défaut qu'avait déjà l'ancien logotype. */
  const fondTuile = clair ? "#FFFFFF" : `url(#tuile${id})`;
  const traitM    = clair ? "#0B77C2" : "#FFFFFF";
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 140" width={size} height={size}
         className={className} role="img" aria-label="MEMS">
      <defs>
        <linearGradient id={`tuile${id}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#38BDF8" />
          <stop offset="55%" stopColor="#0B77C2" />
          <stop offset="100%" stopColor="#075E93" />
        </linearGradient>
      </defs>
      {/* La tuile : rayon volontairement large, pour tenir aussi bien en
          favicon de 16 px qu'en signe de 96 px sur l'écran de connexion. */}
      <rect x="6" y="6" width="128" height="128" rx="34" fill={fondTuile} />
      {/* Le M en un seul tracé : une lettre dessinée ne dépend d'aucune fonte
          installée, là où un <text> se rendrait différemment d'un poste à
          l'autre — et sur une marque, ce n'est pas acceptable. */}
      <path d="M 40 101 L 40 45 L 70 82 L 100 45 L 100 101"
            fill="none" stroke={traitM} strokeWidth="15"
            strokeLinecap="round" strokeLinejoin="round" />
      {/* Le point : le seul accent de la marque. Il tient la place du suivi —
          le relevé qu'on pose sur la carte. */}
      <circle cx="104" cy="40" r="13" fill={clair ? "#FFFFFF" : "#84CC16"}
              stroke={clair ? "#84CC16" : "#FFFFFF"} strokeWidth={clair ? 5 : 4} />
    </svg>
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
/* Le conteneur d'un tableau. `overflow-auto` fait défiler DANS le cadre — vers
   le bas quand il y a trop de lignes (l'en-tête collant reste alors visible), et
   vers la droite quand le tableau est plus large que l'écran, sans jamais pousser
   la page entière de côté. `max` borne la hauteur : sans borne, rien ne défile à
   l'intérieur et l'en-tête collant n'a pas de cadre où se coller. */
const TableWrap = ({ children, max="mh65", className }) => (
  <div className={clsx("tbl-wrap", max, className)}><table className="w-full border-collapse">{children}</table></div>);
const Note = ({ tone="info", children }) => {
  /* Les tons explicatifs se masquent avec l'interrupteur global ; les tons d'état
     (warn, err, ok) restent, quoi qu'il arrive — masquer « cette correspondance ne
     passera pas » serait cacher un fait, pas alléger un commentaire. */
  const explicatif = tone === "info" || tone === "tool";
  const masquees = useNotesMasquees();
  if(explicatif && masquees) return null;
  const t = { info:"bg-sky-50 bl3 bd-brand text-sky-900", warn:"bg-amber-50 bl3 bd-warn text-amber-900",
    ok:"bg-lime-50 bl3 border-lime-500 text-lime-900", err:"bg-rose-50 bl3 border-rose-500 text-rose-900",
    tool:"bg-slate-50 bl3 border-slate-300 text-slate-700" }[tone] || "bg-sky-50 bl3 bd-brand text-sky-900";
  return <div className={clsx("px-4 py-3 rounded f125 leading-relaxed mb-4", t)}>{children}</div>;
};
/* L'interrupteur lui-même : posé dans la barre du haut. Il ne s'affiche que s'il y
   a des notes explicatives à gouverner — inutile ailleurs. */
const NotesToggle = ({ className }) => {
  const masquees = useNotesMasquees();
  return (
    <button onClick={()=>setNotesMasquees(!masquees)}
      title={masquees ? "Afficher les notes explicatives" : "Masquer les notes explicatives"}
      className={clsx("flex items-center gap-1.5 px-2 h-8 rounded-full f115 transition-colors",
        masquees ? "bg-white/10 text-white/60 hover:bg-white/20" : "bg-white/15 text-white/90 hover:bg-white/25",
        className)}>
      <Info size={15} />
      <span className="hidden md:inline">{masquees ? "Notes masquées" : "Notes"}</span>
    </button>);
};
/* Aide repliable — « cache les commentaires en hide/show, ils occupent trop de
   place ». Une longue note explicative ne s'impose plus à l'écran : elle se
   dévoile d'un clic pour qui la veut, et reste repliée par défaut. */
const Aide = ({ children, titre = "À quoi sert cet écran ?", tone, ouvert = false }) => {
  const [open, setOpen] = useState(ouvert);
  /* L'aide est explicative par nature : l'interrupteur global la masque aussi,
     déclencheur compris — sinon un « À quoi sert cet écran ? » resterait accroché
     au-dessus de notes que l'on vient justement de faire taire. */
  if(useNotesMasquees()) return null;
  return (
    <div className="mb-3">
      <button onClick={()=>setOpen(o=>!o)}
        className="inline-flex items-center gap-1.5 f11 font-semibold text-slate-500 hover:text-slate-800">
        <HelpCircle size={13}/> {titre} {open ? <ChevronUp size={12}/> : <ChevronDown size={12}/>}
      </button>
      {open && <div className="mt-2"><Note tone={tone}>{children}</Note></div>}
    </div>);
};
/* Sous-navigation d'écran EN HAUT — le rail des catégories reste seul à gauche ;
   la sous-navigation propre à un écran passe en barre horizontale de pastilles,
   et la configuration vient juste en dessous, à bords égaux. Une seule
   implémentation, réutilisée par tous les écrans de paramètres. */
const SideRail = ({ groups, active, onPick, right }) => {
  /* La barre de pastilles ne se dessine que si elle a quelque chose à porter :
     un écran encore vide (aucune source, aucun modèle) ne montre pas une barre
     blanche fantôme, seulement sa zone de configuration. */
  const hasItems = (groups || []).some(g => (g.items || []).length);
  return (
  <div className="space-y-4">
    {hasItems && <div className="bg-white border border-slate-200 rounded-2xl shadow-sm px-3 py-2.5
                    flex items-center gap-x-5 gap-y-2 flex-wrap">
      {groups.map((g, gi) => (
        <div key={g.label || gi} className="flex items-center gap-2 flex-wrap">
          {g.label && <span className="f10 font-bold uppercase tracking-wider text-slate-400 shrink-0">{g.label}</span>}
          {g.items.map(it => (
            <button key={it.value} onClick={()=>onPick(it.value)}
              className={clsx("px-3 py-1.5 rounded-full f125 font-semibold transition-colors flex items-center gap-1.5",
                active===it.value ? "bg-brand text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}>
              <span>{it.label}</span>
              {it.count != null && <span className={clsx("f10 tabular-nums px-1.5 rounded-full",
                active===it.value ? "bg-white/25" : "bg-white text-slate-500")}>{it.count}</span>}
            </button>))}
        </div>))}
    </div>}
    <div className="min-w-0 space-y-4">{right}</div>
  </div>);
};
/* `disabled` sert quand le serveur refusera le geste de toute façon — une visite
   issue d'un formulaire ne se décoche pas depuis le plan. Proposer l'interrupteur
   pour le voir revenir en 409 apprendrait à l'utilisateur que l'écran ment. */
const Sw = ({ label, hint, on, onChange, disabled }) => (
  <div className="flex items-center gap-3 py-2.5 border-b border-slate-100 last:border-0">
    <div className="flex-1"><div className={clsx("f13 font-medium", disabled?"text-slate-400":"text-slate-800")}>{label}</div>
      {hint && <div className="f115 text-slate-500">{hint}</div>}</div>
    <button disabled={disabled} onClick={()=>onChange(!on)}
      className={clsx("relative w-10 h22 rounded-full transition-colors shrink-0",
        on?"bg-brand":"bg-slate-300", disabled?"opacity-40 cursor-not-allowed":"")}>
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

export { Aide, Badge, Bar2, BrandMark, Btn, Card, Empty, Field, Input, Logo, Modal, Note, NotesToggle, Select, SideRail, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, Toast, download, inputCls, parseCSV, toCSV, useNotesMasquees };
