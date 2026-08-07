import { useEffect, useRef, useState } from "react";
import { CalendarRange, Check } from "lucide-react";
import { Tabs } from "../components/ui.jsx";
import { clsx } from "../lib/calc.js";
import { PageHead } from "./Shell.jsx";
import { CoveragePlan, DistributionActual, DistributionPlan, OutcomePlan, Overreaching,
         ProcessPlan } from "./Planning.jsx";
import { ActualSummary, ImportView, OutcomeData, OutputData, ProcessData,
         Sources } from "./ActualData.jsx";
import { SitesModule } from "./Settings.jsx";
import MreView from "./Mre.jsx";
import Soumissions from "./Soumissions.jsx";
import TpmView from "./Tpm.jsx";

/* ═══════════════════════════════════════════════════════════════════════
   Suivi-évaluation et Programme — deux métiers, un sujet par destination.

   La navigation était organisée par nature de donnée : le prévu dans « Planning »,
   le réalisé dans « Actual Data ». Chaque sujet existait donc en double, et rien
   n'indiquait lequel des deux menus ouvrir pour saisir la distribution de mars.
   Le code lui-même écrivait les chemins en toutes lettres dans les tâches
   urgentes — le symptôme d'une navigation qui ne se devine pas.

   Le prévu et le réalisé sont deux vues du même sujet. Chaque sujet est donc une
   destination, avec une bascule. Le premier niveau suit les deux métiers
   réellement distincts : le suivi-évaluation et le programme.
   ═══════════════════════════════════════════════════════════════════════ */

/* Bascule entre le prévu et le réalisé. Elle ne cache pas la moitié de
   l'information : les deux côtés portent les mêmes lignes, vues sous l'angle
   de ce qui était attendu ou de ce qui a eu lieu. */
function Volet({ value, onChange, gauche, droite }){
  const opts = [["plan", gauche, CalendarRange], ["reel", droite, Check]];
  return (
    <div className="flex items-center gap-1 p-1 rounded bg-slate-100 border border-slate-200 w-max mb-4">
      {opts.map(([id, label, Icon]) => (
        <button key={id} onClick={()=>onChange(id)}
          className={clsx("flex items-center gap-1.5 px-3 py-1.5 rounded f125 font-semibold transition-colors",
            value===id ? "bg-white text-slate-800 shadow-sm border border-slate-200"
                       : "text-slate-500 hover:text-slate-700")}>
          <Icon size={13} />{label}</button>))}
    </div>);
}

/* Mémoire du volet par sujet : passer de « Distributions » à « Résultats » et
   revenir ne doit pas ramener au prévu si l'on travaillait sur le réalisé.

   `demande` est le volet porté par une NAVIGATION — une tâche de la cloche, un
   encart du cockpit. Il compte parce que ces raccourcis mènent presque tous à un
   geste de RÉALISATION (saisir une quantité distribuée, valider une visite,
   relever une valeur mesurée) qui vit dans le volet « réalisé », alors que le
   volet s'ouvrait invariablement sur « plan ». L'utilisateur atterrissait donc
   sur l'écran de planification et devait encore cliquer pour arriver là où le
   travail se fait — sans que rien ne le lui dise.

   Il n'est appliqué qu'au CHANGEMENT : une fois arrivé, l'utilisateur reste maître
   de la bascule, et un nouveau rendu ne vient pas lui reprendre son choix. */
function useVolet(initial = "plan", demande = null){
  const [v, setV] = useState(demande || initial);
  const vu = useRef(demande);
  useEffect(() => {
    if(demande && demande !== vu.current){ vu.current = demande; setV(demande); }
  }, [demande]);
  return [v, setV];
}

/* ── Suivi-évaluation ─────────────────────────────────────────────────
   Le travail de l'unité de suivi : où va-t-on, y est-on allé, avec quelle
   couverture, et sur quels paramètres cette couverture est calculée. */
export function Suivi({ db, set, me, sub, setSub, notify, can, go, onglets, volet:voletDemande }){
  const [volet, setVolet] = useVolet("plan", voletDemande);
  /* Le tableau de bord est mis EN TÊTE, juste avant le résumé global (l'aperçu) :
     c'est la lecture de synthèse la plus consultée, elle doit ressortir en
     premier plutôt que d'être un onglet parmi d'autres. */
  const items = [["summary","Résumé global"],
    ["monitoring","Suivi des sites"],
    ["mre","Plan MRE et budget"],["tpm","Suivi tiers"],
    ["coverage","Couverture et MMR"],
    ["sites","Registre des sites"],["params","Paramètres de couverture"]];
  return (
    <div className="space-y-4">
      <PageHead title="Suivi-évaluation"
        text="Plan MRE et budget, planification des visites fondée sur le risque, réalisation du suivi de processus et couverture géographique." />
      <Tabs items={items} value={sub} onChange={setSub} />

      {sub==="summary" && <ActualSummary db={db} />}

      {sub==="monitoring" && (<>
        <Volet value={volet} onChange={setVolet}
          gauche="Plan de suivi" droite="Visites réalisées" />
        {volet==="plan"
          ? <ProcessPlan db={db} set={set} me={me} notify={notify} can={can} />
          : <ProcessData db={db} set={set} notify={notify} can={can} go={go} />}
      </>)}

      {/* Le plan MRE porte sa propre bascule budget prévu / dépense constatée. */}
      {sub==="mre" && <MreView db={db} me={me} notify={notify} can={can} />}

      {/* Le suivi tiers a son propre circuit de validation : il ne se ramène pas à
          une bascule prévu/réalisé, et porte donc ses propres onglets internes. */}
      {sub==="tpm" && <TpmView db={db} me={me} notify={notify} can={can} />}

      {/* La couverture rapproche par nature le prévu et le réalisé : elle n'a pas
          de volet, les deux colonnes sont côte à côte. */}
      {sub==="coverage" && <CoveragePlan db={db} set={set} me={me} notify={notify} can={can} />}
      {sub==="sites"    && <SitesModule db={db} set={set} me={me} notify={notify} can={can} context="actual" />}
      {sub==="params"   && <Overreaching db={db} set={set} notify={notify} can={can} />}
    </div>);
}

/* ── Programme ────────────────────────────────────────────────────────
   Ce que le programme distribue et obtient : plan de distribution et
   réalisations, population ciblée, indicateurs de résultat, et les entrées
   de données qui les alimentent. */
export function Programme({ db, set, me, sub, setSub, notify, can, go, volet:voletDemande }){
  const [voletD, setVoletD] = useVolet("plan", voletDemande);
  const [voletR, setVoletR] = useVolet("plan", voletDemande);
  const items = [["distribution","Distributions"],["population","Population et outputs"],
    ["results","Résultats"],["import","Import Excel"],["sources","Sources de données"],
    ["soumissions","Soumissions ODK"]];
  return (
    <div className="space-y-4">
      <PageHead title="Programme"
        text="Plan de distribution et réalisations, population ciblée, indicateurs de résultat, sources de données et soumissions collectées." />
      <Tabs items={items} value={sub} onChange={setSub} />

      {sub==="distribution" && (<>
        <Volet value={voletD} onChange={setVoletD}
          gauche="Plan de distribution" droite="Réalisations" />
        {voletD==="plan"
          ? <DistributionPlan db={db} set={set} me={me} notify={notify} can={can} />
          : <DistributionActual db={db} set={set} notify={notify} can={can} />}
      </>)}

      {sub==="population" && <OutputData db={db} set={set} notify={notify} can={can} />}

      {sub==="results" && (<>
        <Volet value={voletR} onChange={setVoletR}
          gauche="Calendrier de collecte" droite="Valeurs mesurées" />
        {voletR==="plan"
          ? <OutcomePlan db={db} set={set} notify={notify} can={can} />
          : <OutcomeData db={db} set={set} notify={notify} can={can} go={go} />}
      </>)}

      {sub==="import"  && <ImportView db={db} notify={notify} can={can} />}
      {sub==="sources" && <Sources db={db} set={set} notify={notify} can={can} />}

      {/* « Sources de données » dit d'où les soumissions viennent ; celui-ci dit
          ce qu'elles sont devenues une fois versées. Les deux sont voisins parce
          qu'on passe de l'un à l'autre : on tire, puis on regarde ce qui s'est
          rattaché — et surtout ce qui ne s'est pas rattaché. */}
      {sub==="soumissions" && <Soumissions db={db} notify={notify} can={can} />}
    </div>);
}
