import React, { useState } from "react";
import { Lock, Eye, EyeOff, Target, CalendarRange, Activity, Database } from "lucide-react";
import { C } from "../lib/constants.js";
import { clsx } from "../lib/calc.js";
import { Btn, Field, Logo, inputCls } from "../components/ui.jsx";
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

  return (
    <div className="min-h-screen flex flex-col lg:flex-row" style={{ background:C.bg }}>
      {/* ── Le panneau de gauche ──────────────────────────────────────
          Il portait un argumentaire — « une plateforme moderne pour piloter le suivi »,
          quatre puces vantant des fonctionnalités. C'est du texte de brochure, et il
          s'adresse à quelqu'un qui hésiterait à acheter. Or personne n'arrive ici par
          hasard : on y arrive parce qu'on travaille dans cette unité et qu'on a un mot
          de passe. Ce qu'il faut à ce moment-là, ce n'est pas d'être convaincu, c'est
          de reconnaître l'outil, de savoir à quoi il sert et de savoir que l'accès est
          tracé. Le reste est du bruit devant une porte. */}
      <div className="hidden lg:flex flex-col justify-between w-[38%] xl:w-[34%] p-12 text-white"
        style={{ background:`linear-gradient(155deg, ${C.brandD} 0%, ${C.navy} 58%, #06253a 100%)` }}>
        <Logo size={44} tone="light" />

        <div className="max-w-md">
          {/* `text-balance` répartit les lignes plutôt que de laisser un mot orphelin
              sur la dernière — le titre change de largeur selon la fenêtre. */}
          <h1 className="text-3xl xl:text-4xl font-semibold leading-snug text-balance max-w-[20ch]">
            Suivi et évaluation des opérations de terrain.</h1>
          <p className="f13 text-white/70 mt-5 leading-relaxed">
            Registre des sites, plan de visites fondé sur le risque, plan de distribution
            par commune, couverture et indicateurs — sur un seul référentiel géographique.
          </p>

          <dl className="mt-8 grid grid-cols-2 gap-y-5 gap-x-4">
            {[[Target, "Sites suivis", "priorité calculée, visites planifiées"],
              [CalendarRange, "Exercices", "l'année en cours, et celles d'avant"],
              [Activity, "Couverture", "réalisé rapporté au requis"],
              [Database, "Un seul découpage", "du pays au fokontany"]].map(([I, titre, texte], i) => (
              <div key={i}>
                <dt className="flex items-center gap-2 f125 font-semibold text-white/90">
                  <I size={15} className="text-white/60 shrink-0" />{titre}</dt>
                <dd className="f105 text-white/55 mt-0.5 leading-snug">{texte}</dd>
              </div>))}
          </dl>
        </div>

        <p className="f105 text-white/45 leading-relaxed max-w-md">
          Accès réservé aux personnes autorisées. Chaque connexion, chaque modification et
          chaque tentative infructueuse sont enregistrées dans le journal d'audit.</p>
      </div>

      {/* ── Le formulaire ───────────────────────────────────────────── */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-[26rem]">
          {/* Sur petit écran, le panneau de gauche disparaît : la marque revient ici,
              sinon l'écran s'ouvrirait sur un formulaire sans nom. */}
          <div className="lg:hidden mb-8 flex justify-center"><Logo size={44} /></div>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-[0_20px_60px_rgba(15,23,42,0.07)] p-8">
            {!mustChange ? (<>
              <h2 className="text-2xl font-semibold text-slate-900">Connexion</h2>
              <p className="f13 text-slate-500 mt-1.5 mb-6">
                Avec l'adresse professionnelle qui vous a été déclarée.</p>

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
                className="w-full justify-center py-2.5 mt-1" icon={Lock}>
                {busy ? "Connexion en cours…" : "Se connecter"}</Btn>

              <p className="f105 text-slate-400 mt-6 leading-relaxed">
                Après plusieurs tentatives infructueuses, le compte est verrouillé quelques
                minutes. Il n'existe pas de récupération par courriel — demandez à un
                administrateur de réinitialiser votre accès.</p>

              {DEV_ADMIN_INFO && (
                <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3">
                  <div className="f10 font-bold uppercase tracking-wide text-slate-500 mb-1.5">
                    Développement — compte de démonstration</div>
                  <div className="f115 text-slate-600 font-mono">{DEV_ADMIN_INFO.email}</div>
                  <div className="f115 text-slate-600 font-mono">{DEV_ADMIN_INFO.password}</div>
                </div>)}
            </>) : (<>
              <h2 className="text-2xl font-semibold text-slate-900">Nouveau mot de passe</h2>
              <p className="f13 text-slate-500 mt-1.5 mb-6">
                Ce compte utilise encore le mot de passe qui lui a été attribué. Choisissez-en
                un avant de continuer.</p>

              {err && <div className="mb-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 f13 text-rose-800"
                role="alert">{err}</div>}

              <Field label="Nouveau mot de passe">
                <input type="password" value={next1} autoComplete="new-password" autoFocus className={champ}
                  onChange={e=>setNext1(e.target.value)} /></Field>

              {/* Les exigences sont montrées et cochées à mesure : les énoncer dans une
                  note sous le champ oblige à deviner laquelle manque. */}
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

              <Btn onClick={changeAndEnter} className="w-full justify-center py-2.5 mt-1" icon={Lock}
                disabled={busy || next1.length < 12 || next1 !== next2}>
                {busy ? "Enregistrement…" : "Enregistrer et entrer"}</Btn>
            </>)}
          </div>

          <p className="lg:hidden f105 text-slate-400 text-center mt-6 leading-relaxed">
            Accès réservé aux personnes autorisées. Chaque connexion est enregistrée.</p>
        </div>
      </div>
    </div>
  );
}

export default Login;
