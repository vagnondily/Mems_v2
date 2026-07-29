import React, { useState } from "react";
import { Lock, Eye, EyeOff, Target, CalendarRange, Activity, Database } from "lucide-react";
import { C } from "../lib/constants.js";
import { clsx } from "../lib/calc.js";
import { Btn, Field, BrandMark, inputCls } from "../components/ui.jsx";
import { api, setToken } from "../lib/api.js";
const DEV_ADMIN_INFO = import.meta.env?.DEV ? {
  email: "admin@mems.local",
  password: "MemsAdmin2026",
} : null;
/* Aucun identifiant n'apparaît sur cet écran : les comptes se créent côté serveur
   et le mot de passe initial n'est communiqué qu'au moment de l'amorçage. */
export function Login({ onLogin, notify }){
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mustChange, setMustChange] = useState(null);
  const [next1, setNext1] = useState("");
  const [next2, setNext2] = useState("");

  const submit = async () => {
    if(busy) return;
    setErr(""); setBusy(true);
    try{
      const r = await api.login(email.trim(), pw);
      if(r.user.must_change_pw){ setMustChange(r); setBusy(false); return; }
      await onLogin(r.user, r.token);
    }catch(e){
      setErr(e.status === 401
        ? "identifiants incorrects"
        : e.status === 423
        ? "Ce compte est temporairement verrouillé après plusieurs tentatives. Réessayez dans quelques minutes."
        : e.status === 429
        ? "Trop de tentatives. Patientez quelques minutes avant de réessayer."
        : e.message);
      setBusy(false);
    }
  };

  const changeAndEnter = async () => {
    setErr("");
    if(next1 !== next2){ setErr("Les deux saisies ne correspondent pas."); return; }
    setBusy(true);
    try{
      setToken(mustChange.token);
      await api.changePassword(pw, next1);
      notify?.("Mot de passe mis à jour", "ok");
      const r = await api.login(email.trim(), next1);
      await onLogin(r.user, r.token);
    }catch(e){ setErr(e.message); setBusy(false); }
  };

  return (
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background:C.bg }}>
      <div className="hidden lg:flex flex-col justify-between w-2/5 p-12 text-white"
        style={{ background:`linear-gradient(160deg, ${C.brandD} 0%, ${C.navy} 55%, #02243a 100%)` }}>
        <div>
          <div className="flex items-center gap-4 mb-8">
            <div className="w-14 h-14 rounded-3xl bg-white/10 border border-white/15 grid place-items-center">
              <BrandMark size={40} />
            </div>
            <div>
              <div className="text-sm uppercase tracking-[0.35em] opacity-80">MEMS</div>
              <div className="f11 font-light opacity-80">Monitoring Evaluation Management System</div>
            </div>
          </div>
          <h1 className="text-4xl xl:text-5xl font-semibold leading-tight mb-6">
            Une plateforme moderne pour piloter le suivi et l’évaluation terrain.</h1>
          <p className="f13 text-slate-100 opacity-85 max-w-lg leading-relaxed mb-8">
            Planifiez vos visites, suivez les sites et visualisez les performances avec une interface pensée pour les équipes M&E.</p>
          <ul className="space-y-4 f13 opacity-90">
            {[["Indicateurs opérationnels", Target],
              ["Planification des visites", CalendarRange],
              ["Tableaux de bord visuels", Activity],
              ["Connexion aux formulaires ODK", Database]].map(([t, I], i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 text-slate-200"><I size={18} /></span>
                <span>{t}</span>
              </li>))}
          </ul>
        </div>
        <p className="f11 text-slate-200 opacity-75 leading-relaxed">
          Accès réservé aux équipes autorisées. Chaque connexion est tracée et sécurisée pour garantir vos données terrain.</p>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white border border-slate-200 shadow-[0_25px_75px_rgba(15,23,42,0.08)] rounded-[2rem] p-8">
          <div className="flex flex-col items-center gap-3 mb-8 text-center">
            <div className="w-14 h-14 rounded-3xl bg-slate-100 grid place-items-center">
              <BrandMark size={32} />
            </div>
            <div>
              <div className="text-slate-900 text-2xl font-semibold">MEMS</div>
              <div className="f12 text-slate-500">Monitoring Evaluation Management System</div>
            </div>
          </div>
          {!mustChange ? (<>
            <h2 className="text-3xl font-semibold text-slate-900">Connexion</h2>
            <p className="f13 text-slate-500 mt-2 mb-6">Connectez-vous avec vos identifiants pour accéder au tableau de bord MEMS.</p>
            {err && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">{err}</div>}
            <Field label="Adresse électronique">
              <input type="email" value={email} autoComplete="username" className={clsx(inputCls, "bg-slate-50 border-slate-200")}
                onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} /></Field>
            <Field label="Mot de passe">
              <div className="relative">
                <input type={show?"text":"password"} value={pw} autoComplete="current-password"
                  onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
                  className={clsx(inputCls, "pr-11 bg-slate-50 border-slate-200")} />
                <button type="button" onClick={()=>setShow(s=>!s)}
                  aria-label={show ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                  {show ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
              </div></Field>
            <Btn onClick={submit} disabled={busy || !pw || !email}
              className="w-full justify-center mt-4" icon={Lock}>
              {busy ? "Connexion en cours…" : "Se connecter"}</Btn>
            <p className="f11 text-slate-500 mt-6 leading-relaxed">
              Après plusieurs tentatives infructueuses, le compte est temporairement verrouillé.
              Contactez l'administrateur si vous avez besoin d'une réinitialisation.</p>
            {DEV_ADMIN_INFO && (
              <div className="mt-6 rounded-3xl border border-slate-200 bg-slate-50 p-4 text-slate-700">
                <div className="f11 font-semibold text-slate-800 mb-2">Identifiants admin provisoires</div>
                <div className="grid gap-2 text-sm">
                  <div><span className="font-semibold">Email :</span> {DEV_ADMIN_INFO.email}</div>
                  <div><span className="font-semibold">Mot de passe :</span> {DEV_ADMIN_INFO.password}</div>
                </div>
              </div>)}
          </>) : (<>
            <h2 className="text-3xl font-semibold text-slate-900">Nouveau mot de passe</h2>
            <p className="f13 text-slate-500 mt-2 mb-6">
              Vous devez définir un nouveau mot de passe pour continuer.</p>
            {err && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">{err}</div>}
            <Field label="Nouveau mot de passe" hint="Au moins 12 caractères, une majuscule, une minuscule et un chiffre.">
              <input type="password" value={next1} autoComplete="new-password" className={inputCls}
                onChange={e=>setNext1(e.target.value)} /></Field>
            <Field label="Confirmation">
              <input type="password" value={next2} autoComplete="new-password" className={inputCls}
                onChange={e=>setNext2(e.target.value)} onKeyDown={e=>e.key==="Enter"&&changeAndEnter()} /></Field>
            <Btn onClick={changeAndEnter} disabled={busy || next1.length < 12}
              className="w-full justify-center mt-4" icon={Lock}>
              {busy ? "Enregistrement…" : "Enregistrer et entrer"}</Btn>
          </>)}
        </div>
      </div>
    </div>
  );
}

export default Login;
