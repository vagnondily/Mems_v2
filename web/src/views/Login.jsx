import React, { useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { C } from "../lib/constants.js";
import { clsx } from "../lib/calc.js";
import { Btn, BrandMark, Field, inputCls } from "../components/ui.jsx";
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

  /* Le verrouillage des majuscules est la première cause de « mot de passe incorrect »
     sur un écran de connexion, et personne ne le voit tant qu'on ne le dit pas. */
  const [majuscules, setMajuscules] = useState(false);
  const guetterMaj = (e) => {
    try{ setMajuscules(e.getModifierState && e.getModifierState("CapsLock")); }catch(_){}
  };

  const champ = clsx(inputCls, "bg-white border-slate-300 py-2.5");

  /* ── Le fond ──────────────────────────────────────────────────
     Une ombre ne se voit que par ce qui l'entoure : posée sur un aplat gris, elle
     forme un halo sale ; posée sur une surface qui varie doucement, elle donne de la
     profondeur. D'où ce très léger dégradé radial teinté de la couleur de marque,
     plus clair derrière la carte et s'éteignant vers les bords. Il ne se remarque
     pas — c'est exactement ce qu'on lui demande. */
  const fond = {
    background: `radial-gradient(1100px 620px at 50% -8%, rgba(0,125,188,0.10), rgba(0,125,188,0) 62%),
                 radial-gradient(760px 520px at 50% 112%, rgba(15,163,127,0.07), rgba(15,163,127,0) 60%),
                 ${C.bg}`,
  };
  /* Trois couches plutôt qu'une : un liseré très serré qui détache la carte du fond,
     une ombre moyenne qui la soulève, une très large et très diffuse qui l'ancre.
     Une ombre unique et forte donnerait l'aspect d'un autocollant. */
  const ombre = {
    boxShadow: `0 1px 2px rgba(15,23,42,0.05),
                0 12px 28px -10px rgba(15,23,42,0.14),
                0 44px 80px -30px rgba(15,23,42,0.30)`,
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-5 py-12" style={fond}>
      {/* La marque au-dessus de la carte, et non dedans : elle nomme l'application,
          elle n'appartient pas au formulaire. */}
      <div className="flex flex-col items-center gap-3 mb-8">
        <BrandMark size={56} />
        <div className="text-center">
          <div className="text-slate-900 font-bold tracking-[0.2em]" style={{ fontSize:22 }}>MEMS</div>
          <div className="f115 text-slate-500 mt-1">Monitoring and Evaluation Management System</div>
        </div>
      </div>

      <div className="w-full max-w-[26.5rem] bg-white rounded-3xl border border-slate-200/70
                      px-9 py-8 sm:px-10" style={ombre}>
        {!mustChange ? (<>
          <h2 className="text-[22px] font-semibold text-slate-900 tracking-tight">Connexion</h2>
          <p className="f13 text-slate-500 mt-1.5 mb-6">
            Avec l'adresse professionnelle déclarée pour vous.</p>

          {err && <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 f13 text-rose-800"
            role="alert">{err}</div>}

          <Field label="Adresse électronique">
            <input type="email" value={email} autoComplete="username" autoFocus className={champ}
              onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} /></Field>

          <Field label="Mot de passe">
            <div className="relative">
              <input type={show?"text":"password"} value={pw} autoComplete="current-password"
                onChange={e=>setPw(e.target.value)}
                onKeyUp={guetterMaj} onKeyDown={e=>{ guetterMaj(e); if(e.key==="Enter") submit(); }}
                className={clsx(champ, "pr-11")} />
              <button type="button" onClick={()=>setShow(s=>!s)} tabIndex={-1}
                aria-label={show ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700">
                {show ? <EyeOff size={16}/> : <Eye size={16}/>}</button>
            </div></Field>

          {majuscules && <div className="f115 text-amber-700 -mt-1 mb-3">
            Le verrouillage des majuscules est actif.</div>}

          <Btn onClick={submit} disabled={busy || !pw || !email}
            className="w-full justify-center py-2.5 mt-2" icon={Lock}>
            {busy ? "Connexion en cours…" : "Se connecter"}</Btn>

          {DEV_ADMIN_INFO && (
            <div className="mt-7 rounded-xl border border-dashed border-slate-300 bg-slate-50/80 px-4 py-3">
              <div className="f10 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                Développement — compte de démonstration</div>
              <div className="f115 text-slate-600 font-mono">{DEV_ADMIN_INFO.email}</div>
              <div className="f115 text-slate-600 font-mono">{DEV_ADMIN_INFO.password}</div>
            </div>)}
        </>) : (<>
          <h2 className="text-[22px] font-semibold text-slate-900 tracking-tight">Nouveau mot de passe</h2>
          <p className="f13 text-slate-500 mt-1.5 mb-7">
            Ce compte utilise encore le mot de passe qui lui a été attribué.
            Choisissez-en un avant de continuer.</p>

          {err && <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 f13 text-rose-800"
            role="alert">{err}</div>}

          <Field label="Nouveau mot de passe">
            <input type="password" value={next1} autoComplete="new-password" autoFocus className={champ}
              onChange={e=>setNext1(e.target.value)} /></Field>

          {/* Les exigences se cochent à mesure : les énoncer dans une note sous le
              champ oblige à deviner laquelle manque. */}
          <ul className="f115 -mt-1 mb-4 space-y-0.5">
            {[[next1.length >= 12, "au moins 12 caractères"],
              [/[a-z]/.test(next1), "une minuscule"],
              [/[A-Z]/.test(next1), "une majuscule"],
              [/[0-9]/.test(next1), "un chiffre"]].map(([ok, texte], i) => (
              <li key={i} className={ok ? "text-lime-700" : "text-slate-400"}>
                {ok ? "✓" : "○"} {texte}</li>))}
          </ul>

          <Field label="Confirmation">
            <input type="password" value={next2} autoComplete="new-password" className={champ}
              onChange={e=>setNext2(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&changeAndEnter()} /></Field>
          {next2 && next1 !== next2 && <div className="f115 text-amber-700 -mt-1 mb-3">
            Les deux saisies ne correspondent pas.</div>}

          <Btn onClick={changeAndEnter} className="w-full justify-center py-2.5 mt-2" icon={Lock}
            disabled={busy || next1.length < 12 || next1 !== next2}>
            {busy ? "Enregistrement…" : "Enregistrer et entrer"}</Btn>
        </>)}
      </div>

      {/* Hors de la carte, en petit : ce qui se dit une fois et ne se relit jamais.
          Quatre lignes de grise, c'etait trop long pour etre lu et trop present pour
          etre ignore. Le verrouillage se dit au moment ou il arrive, dans le message
          d'erreur ; il n'a pas a occuper l'ecran par avance. */
      }
      <p className="f105 text-slate-400 text-center mt-7 max-w-[24rem] leading-relaxed">
        Accès réservé aux personnes autorisées ; chaque connexion est enregistrée.
        Il n'existe pas de récupération par courriel.
      </p>
    </div>
  );
}

export default Login;
