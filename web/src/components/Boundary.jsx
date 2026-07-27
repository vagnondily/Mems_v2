import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { n } from "../lib/calc.js";
import { Btn } from "./ui.jsx";

/* ══════════════════ Frontière d'erreur ══════════════════ */
class Boundary extends React.Component {
  constructor(p){ super(p); this.state = { err:null }; }
  static getDerivedStateFromError(err){ return { err }; }
  componentDidCatch(err, info){ console.error("MEMS —", err, info); }
  componentDidUpdate(prev){ if(prev.reset !== this.props.reset && this.state.err) this.setState({ err:null }); }
  render(){
    if(!this.state.err) return this.props.children;
    return (
      <div className="p-6"><div className="max-w-2xl mx-auto bg-white border border-rose-200 rounded p-6">
        <div className="flex items-center gap-2 text-rose-700 mb-2">
          <AlertTriangle size={18} /><h3 className="f15 font-semibold">Cette section n'a pas pu s'afficher</h3></div>
        <p className="f13 text-slate-600 leading-relaxed mb-3">
          Le reste de l'application reste utilisable : changez d'onglet pour poursuivre.</p>
        <pre className="f11 bg-slate-50 border border-slate-200 rounded p-3 overflow-auto text-slate-600 mb-3">
          {String((this.state.err && this.state.err.message) || this.state.err)}</pre>
        <Btn kind="sec" icon={RefreshCw} onClick={()=>this.setState({ err:null })}>Réessayer</Btn>
      </div></div>);
  }
}

export { Boundary };
