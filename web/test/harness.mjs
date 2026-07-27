import { JSDOM } from "jsdom";

/* Environnement de rendu minimal, proche d'un navigateur, pour éprouver
   l'application complète contre un vrai serveur. */
export function makeDom(apiBase){
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
    { url: apiBase.replace(/\/api$/, "/"), pretendToBeVisual:true });
  const w = dom.window;
  global.window = w; global.document = w.document;
  /* Node 22 expose « navigator » en lecture seule : on le redéfinit explicitement. */
  Object.defineProperty(globalThis, "navigator", { value: w.navigator, configurable:true, writable:true });
  global.HTMLElement = w.HTMLElement;
  global.HTMLInputElement = w.HTMLInputElement; global.HTMLSelectElement = w.HTMLSelectElement;
  global.Node = w.Node; global.getComputedStyle = w.getComputedStyle;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.IS_REACT_ACT_ENVIRONMENT = true; w.IS_REACT_ACT_ENVIRONMENT = true;
  w.URL.createObjectURL = () => "blob:test";
  w.confirm = () => true;

  /* jsdom n'implémente pas ResizeObserver, dont les graphiques ont besoin
     pour se dimensionner. Les navigateurs le fournissent depuis 2020. */
  class RO { constructor(cb){ this.cb = cb; } observe(){ this.cb([{ contentRect:{ width:900, height:420 } }]); }
    unobserve(){} disconnect(){} }
  global.ResizeObserver = RO; w.ResizeObserver = RO;
  Object.defineProperty(w.HTMLElement.prototype, "offsetWidth", { configurable:true, get(){ return 900; } });
  Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { configurable:true, get(){ return 420; } });

  /* Les appels relatifs sont réécrits vers le serveur réellement démarré. */
  const jar = [];
  const nativeFetch = globalThis.fetch;
  global.fetch = async (input, init = {}) => {
    const url = String(input).startsWith("/") ? apiBase.replace(/\/api$/, "") + String(input) : String(input);
    const headers = { ...(init.headers || {}) };
    if(jar.length) headers.cookie = jar.join("; ");
    const res = await nativeFetch(url, { ...init, headers, redirect:"manual" });
    const sc = res.headers.getSetCookie?.() || [];
    for(const c of sc){ const kv = c.split(";")[0];
      const k = kv.split("=")[0];
      const i = jar.findIndex(x => x.startsWith(k + "="));
      if(i >= 0) jar[i] = kv; else jar.push(kv); }
    return res;
  };

  const errors = [];
  const origError = console.error;
  console.error = (...a) => {
    const s = a.map(x => (x && x.stack) || String(x)).join(" ");
    if(/not wrapped in act|Warning: An update|ReactDOM.render/.test(s)) return;
    errors.push(s); origError("  ⚠", s.split("\n")[0].slice(0, 240));
  };
  process.on("unhandledRejection", (r) => errors.push("promesse rejetée : " + (r && r.message || r)));
  return { dom, window: w, errors, clearCookies: () => { jar.length = 0; } };
}
