import { useId } from "react";
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
      <text x="167" y="112" fontFamily="System-UI, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" fontSize="11.5" fontWeight="700" letterSpacing="1.5" fill="#475569">HUMANITARIAN MONITORING &amp; EVALUATION SYSTEM</text>
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
        <div className="px-5 py-4 mh68 overflow-auto">{children}</div>
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

export { Badge, Bar2, Btn, Card, Empty, Field, Input, Logo, Modal, Note, Select, Stat, StatRow, Sw, TableWrap, Tabs, Td, Th, Toast, download, inputCls, parseCSV, toCSV };
