import React, { useState } from "react";
import { Lock, Eye, EyeOff, Target, CalendarRange, Activity, Database } from "lucide-react";
import { C } from "../lib/constants.js";
import { clsx } from "../lib/calc.js";
import { Btn, Field, inputCls } from "../components/ui.jsx";
import { api, setToken } from "../lib/api.js";

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
      setErr(e.status === 423
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
    <div className="min-h-screen flex" style={{ background:C.bg }}>
      <div className="hidden lg:flex flex-col justify-between w46 p-12 text-white"
        style={{ background:`linear-gradient(160deg, ${C.brandD} 0%, ${C.navy} 55%, #02243a 100%)` }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded grid place-items-center f11 font-extrabold"
               style={{ background:C.aqua, color:"#03293d" }}>ME</div>
          <div><div className="text-xl font-bold tracking-wide">MEMS</div>
            <div className="f11 font-light opacity-80">Monitoring &amp; Evaluation Management System</div></div>
        </div>
        <div>
          <h1 className="text-3xl font-light leading-snug mb-5">
            Planifier, suivre et démontrer<br />les résultats sur le terrain.</h1>
          <ul className="space-y-3 f13 opacity-90">
            {[["Exigences minimales de suivi calculées en continu", Target],
              ["Planification des visites fondée sur le risque", CalendarRange],
              ["Suivi de processus, produits et résultats réunis", Activity],
              ["Données ODK Central apurées et analysées", Database]].map(([t, I], i) => (
              <li key={i} className="flex items-start gap-3">
                <I size={16} className="mt-0.5 shrink-0 opacity-80" />{t}</li>))}
          </ul>
        </div>
        <p className="f11 opacity-55 leading-relaxed">
          Accès réservé aux comptes autorisés. Les connexions et les modifications sont journalisées.</p>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          {!mustChange ? (<>
            <h2 className="text-2xl font-semibold text-slate-800">Connexion</h2>
            <p className="f13 text-slate-500 mt-1 mb-6">Identifiez-vous pour accéder à l'application.</p>
            {err && <div className="mb-4 px-3 py-2 rounded f125 bg-rose-50 bl3 border-rose-500 text-rose-800">{err}</div>}
            <Field label="Adresse électronique">
              <input type="email" value={email} autoComplete="username" className={inputCls}
                onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} /></Field>
            <Field label="Mot de passe">
              <div className="relative">
                <input type={show?"text":"password"} value={pw} autoComplete="current-password"
                  onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}
                  className={clsx(inputCls, "pr-9")} />
                <button type="button" onClick={()=>setShow(s=>!s)}
                  aria-label={show ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                  {show ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
              </div></Field>
            <Btn onClick={submit} disabled={busy || !pw || !email}
              className="w-full justify-center mt-2" icon={Lock}>
              {busy ? "Vérification…" : "Se connecter"}</Btn>
            <p className="f11 text-slate-400 mt-6 leading-relaxed">
              Vous n'avez pas de compte ? Demandez-en la création à l'administrateur de l'application.
              Après plusieurs tentatives infructueuses, l'accès est suspendu quelques minutes.</p>
          </>) : (<>
            <h2 className="text-2xl font-semibold text-slate-800">Nouveau mot de passe</h2>
            <p className="f13 text-slate-500 mt-1 mb-6">
              Ce compte utilise encore son mot de passe initial. Choisissez-en un nouveau pour continuer.</p>
            {err && <div className="mb-4 px-3 py-2 rounded f125 bg-rose-50 bl3 border-rose-500 text-rose-800">{err}</div>}
            <Field label="Nouveau mot de passe" hint="Au moins 12 caractères, avec majuscule, minuscule et chiffre">
              <input type="password" value={next1} autoComplete="new-password" className={inputCls}
                onChange={e=>setNext1(e.target.value)} /></Field>
            <Field label="Confirmation">
              <input type="password" value={next2} autoComplete="new-password" className={inputCls}
                onChange={e=>setNext2(e.target.value)} onKeyDown={e=>e.key==="Enter"&&changeAndEnter()} /></Field>
            <Btn onClick={changeAndEnter} disabled={busy || next1.length < 12}
              className="w-full justify-center mt-2" icon={Lock}>
              {busy ? "Enregistrement…" : "Enregistrer et entrer"}</Btn>
          </>)}
        </div>
      </div>
    </div>
  );
}

export default Login;
