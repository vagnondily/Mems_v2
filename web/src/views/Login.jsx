import React, { useState } from "react";
import { Lock, Eye, EyeOff } from "lucide-react";
import { C } from "../lib/constants.js";
import { clsx } from "../lib/calc.js";
import { Btn, Field, BrandMark, inputCls } from "../components/ui.jsx";
import { api, setToken } from "../lib/api.js";
/* Aucun identifiant n'apparaît sur cet écran : les comptes se créent côté serveur
   et le mot de passe initial n'est communiqué qu'au moment de l'amorçage.
   Un encadré « identifiants admin provisoires » figurait ici, avec un mot de passe
   figé en dur (« MemsAdmin2026 ») : il ne correspondait au compte réel que si
   BOOTSTRAP_PASSWORD avait été forcé à cette valeur précise — le comportement par
   défaut de `npm run seed` est de tirer un mot de passe aléatoire et de l'afficher
   une seule fois dans la console. Dans tout autre cas, l'encadré affichait un
   identifiant qui ne menait nulle part, ou pire : un identifiant qui fonctionnait
   par coïncidence si quelqu'un avait justement choisi cette valeur, sans que
   personne ne l'ait décidé consciemment. */
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
    /* Login CENTRÉ, sans panneau latéral : « enlève toute la partie gauche et
       mets bien au centre le login, avec les ombrages ». Fond institutionnel
       sobre — un halo bleu discret en haut, une trame de points très légère —
       qui met la carte en valeur sans bruit. */
    <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden"
      style={{ background:`radial-gradient(1100px 520px at 50% -12%, ${C.navy}18, transparent 60%), ${C.bg}` }}>
      <div className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{ backgroundImage:`radial-gradient(${C.brand} 1px, transparent 1px)`, backgroundSize:"22px 22px" }} />
      <div className="w-full max-w-md relative">
        <div className="bg-white border border-slate-200 rounded-3xl p-8 shadow-[0_30px_80px_-24px_rgba(15,23,42,0.30)]">
          <div className="flex flex-col items-center gap-2 mb-8 text-center">
            <BrandMark size={40} />
            <div>
              <div className="text-slate-900 f19 font-bold tr14">MEMS</div>
              <div className="f115 text-slate-500 mt-0.5">Monitoring and Evaluation Management System</div>
            </div>
          </div>
          {!mustChange ? (<>
            <h2 className="text-3xl font-semibold text-slate-900">Connexion</h2>
            <p className="f13 text-slate-500 mt-2 mb-6">Connectez-vous avec vos identifiants pour accéder au tableau de bord MEMS.</p>
            {err && <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">{err}</div>}
            <Field label="Adresse électronique ou identifiant">
              {/* `type="text"` et non `email` : le champ accepte aussi un identifiant,
                  qui n'a pas la forme d'un courriel (migration 023). */}
              <input type="text" value={email} autoComplete="username" className={clsx(inputCls, "bg-slate-50 border-slate-200")}
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
        <p className="text-center f11 text-slate-400 mt-6 leading-relaxed">
          MEMS · Monitoring and Evaluation Management System<br />
          Accès réservé aux équipes autorisées · chaque connexion est tracée et sécurisée.</p>
      </div>
    </div>
  );
}

export default Login;
