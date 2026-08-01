import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, DownloadCloud, Inbox, Link2, RefreshCw, SearchX, Unlink } from "lucide-react";
import { Badge, Btn, Card, Empty, Note, Select, Stat, StatRow, TableWrap, Td, Th, inputCls }
  from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { clsx, fmt, pct } from "../lib/calc.js";

/* ═══════════════════════════════════════════════════════════════════════
   Les soumissions ODK, et ce que le rattachement en a fait.

   La chaîne existait entièrement côté serveur — tirage, versement, résolution —
   sans qu'aucun écran n'en montre le résultat. On versait donc des milliers de
   soumissions sans jamais savoir combien s'étaient rattachées à un site, ni
   pourquoi les autres non. Cet écran est bâti autour d'UN chiffre — les non
   résolues — et d'UNE colonne — le motif : ensemble, ils disent quoi corriger.
   Le reste n'est là que pour cadrer ces deux-là.

   Rien n'est recalculé ici. La passe retenue, son motif et son indice de
   confiance sont ceux que le serveur a écrits au moment de la résolution
   (server/src/lib/rattachement.js). Les redériver dans le navigateur produirait
   un second verdict, qui divergerait du premier dès la première correction de
   règle — et l'écran censé expliquer la base se mettrait à la contredire.
   ═══════════════════════════════════════════════════════════════════════ */

/* Les passes du résolveur, de la preuve la plus forte à la plus faible.
   L'ordre n'est pas décoratif : il se lit comme une qualité de rattachement
   décroissante, ce qui est exactement la question qu'on se pose devant le
   bandeau — « sur quoi repose ce qui est rattaché ? ». Les indices de confiance
   cités en note sont ceux de CONFIANCE, côté serveur ; ils ne sont pas recopiés
   en valeur, seulement en intention, pour qu'un ajustement là-bas n'ait pas à
   être répercuté ici sous peine d'afficher un chiffre faux. */
const PASSES = [
  { cle:"code_externe", label:"Code externe",   note:"égalité de codes",              ton:"ok",   pastille:"g" },
  { cle:"nom_pcode",    label:"Nom + p-code",   note:"nom confirmé par le fokontany", ton:"ok",   pastille:"g" },
  { cle:"pcode_adm4",   label:"Préfixe p-code", note:"seul site de ce fokontany",     ton:null,   pastille:"b" },
  { cle:"nom_activite", label:"Nom + activité", note:"les deux concordent",           ton:null,   pastille:"b" },
  { cle:"nom_seul",     label:"Nom seul",       note:"aucune activité pour croiser",  ton:"warn", pastille:"y" },
  { cle:"non_resolu",   label:"Non résolu",     note:"aucun site désigné",            ton:"bad",  pastille:"r" },
];
const PASSE = Object.fromEntries(PASSES.map(p => [p.cle, p]));
const passeDe = (r) => PASSE[r.resolution_passe || "non_resolu"] || PASSE.non_resolu;

const ETATS = [
  ["non_resolues", "À traiter — non résolues"],
  ["toutes",       "Toutes les soumissions"],
  ["resolues",     "Rattachées seulement"],
];

/* Le tableau est une file de travail qu'on traite ligne à ligne, pas un export :
   au-delà de trois cents lignes on ne relit plus, on filtre. La répartition par
   passe, elle, décrit un ensemble et supporte un échantillon plus large — mais
   elle dit alors sur combien de lignes elle porte. */
const PLAFOND_TABLEAU = 300;
const PLAFOND_PASSES = 2000;

/* Les dates arrivent en ISO et repartent en ISO. Les faire passer par `Date`
   pour les afficher les décalerait d'un jour dès que le poste n'est pas à
   l'heure UTC — le défaut que lib/periode.js documente déjà. On lit donc le
   texte quand il en a la forme. */
const jour = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

const qs = (o) => {
  const p = new URLSearchParams();
  for(const [k, v] of Object.entries(o)) if(v !== "" && v !== null && v !== undefined) p.set(k, String(v));
  return p.toString();
};

export default function Soumissions({ db, notify, can }){
  const [f, setF] = useState({ form_id:"", resolution:"non_resolues", debut:"", fin:"" });
  const [vue, setVue] = useState({ total:0, nonResolues:0, parPasse:{}, echantillon:0 });
  const [rows, setRows] = useState([]);
  const [affiches, setAffiches] = useState(0);
  const [busy, setBusy] = useState(true);
  const [erreur, setErreur] = useState("");
  /* Le total toutes sources et toutes dates confondues, relevé chaque fois que
     l'écran est consulté sans filtre. Il sépare les deux vides qu'un utilisateur
     ne doit surtout pas confondre : « la chaîne n'a jamais rien reçu » et « cette
     sélection ne rend rien ». Le second se corrige en changeant de filtre, le
     premier en versant. `null` tant qu'on ne l'a pas encore observé. */
  const [totalGlobal, setTotalGlobal] = useState(null);
  const [vues, setVues] = useState([]);       /* form_id déjà rencontrés, cumulés */
  const [source, setSource] = useState("");   /* source ODK choisie pour le versement */
  const [bilan, setBilan] = useState(null);   /* compte rendu de la dernière action */
  const [enCours, setEnCours] = useState("");

  const charger = useCallback(async () => {
    setBusy(true); setErreur("");
    const base = { form_id:f.form_id, debut:f.debut, fin:f.fin };
    try{
      /* Trois lectures, une par chiffre exact, plutôt qu'une seule dont on
         déduirait les autres. Le bandeau annonce des comptes : les tirer d'un
         échantillon plafonné les rendrait faux dès le premier gros versement, et
         un écran de diagnostic qui se trompe sur ses propres chiffres ne sert
         plus à rien. Seule la répartition par passe travaille sur un échantillon,
         et elle le dit. */
      const [ensemble, nonRes, liste] = await Promise.all([
        api.submissions("?" + qs({ ...base, resolution:"toutes", limit:PLAFOND_PASSES })),
        api.submissions("?" + qs({ ...base, resolution:"non_resolues", limit:1 })),
        api.submissions("?" + qs({ ...base, resolution:f.resolution, limit:PLAFOND_TABLEAU })),
      ]);

      const parPasse = {};
      for(const r of ensemble.rows){
        const c = r.resolution_passe || "non_resolu";
        parPasse[c] = (parPasse[c] || 0) + 1;
      }
      setVue({ total:ensemble.total, nonResolues:nonRes.total, parPasse,
               echantillon:ensemble.rows.length });
      setRows(liste.rows); setAffiches(liste.total);
      if(!f.form_id && !f.debut && !f.fin) setTotalGlobal(ensemble.total);

      /* Les sources rencontrées sont CUMULÉES, jamais remplacées : filtrer sur
         l'une d'elles ne doit pas faire disparaître les autres du sélecteur,
         sinon on ne peut plus en changer sans repasser par « toutes ». */
      setVues(prev => {
        const connues = new Set(prev); let neuf = false;
        for(const r of ensemble.rows)
          if(r.form_id && !connues.has(r.form_id)){ connues.add(r.form_id); neuf = true; }
        return neuf ? [...connues].sort() : prev;
      });
    }catch(e){
      setErreur(e.message); setRows([]); setAffiches(0);
      setVue({ total:0, nonResolues:0, parPasse:{}, echantillon:0 });
    }
    setBusy(false);
  }, [f.form_id, f.resolution, f.debut, f.fin]);

  useEffect(() => { charger(); }, [charger]);

  const sources = useMemo(() => {
    /* Les sources déclarées dans Paramètres et celles réellement rencontrées en
       base ne se recouvrent pas forcément : une source peut être déclarée sans
       avoir jamais rien versé, et des soumissions peuvent venir d'un connecteur
       ou d'un rattrapage qui n'a pas de fiche ODK. Les deux listes sont donc
       réunies — masquer les secondes rendrait leurs lignes infiltrables. */
    const libelles = new Map((db.odkForms || [])
      .filter(o => o.formId).map(o => [o.formId, `${o.name} — ${o.formId}`]));
    const tous = new Set([...vues, ...libelles.keys()]);
    return [...tous].sort().map(id => [id, libelles.get(id) || id]);
  }, [db.odkForms, vues]);

  const agir = async (genre, appel) => {
    setEnCours(genre); setBilan(null);
    try{
      const r = await appel();
      setBilan({ genre, ...r });
      const reste = r.nonResolues || 0;
      notify(genre === "ingest"
        ? `${fmt(r.crees)} soumission(s) créée(s), ${fmt(reste)} non rattachée(s)`
        : `${fmt(r.rattachees)} rattachement(s), ${fmt(reste)} non résolue(s) restante(s)`,
        reste ? "warn" : "ok");
      await charger();
    }catch(e){
      setBilan({ genre, erreur:e.message });
      notify(e.message, "err");
    }
    setEnCours("");
  };

  const verser = () => {
    const nom = (db.odkForms || []).find(o => o.id === source)?.name || source;
    return agir("ingest", async () => ({ nom, ...(await api.ingestSubmissions({ odk_form_id:source })) }));
  };
  const rejouer = () => agir("rattacher", () => api.rattacherSubmissions({ toutes:true }));

  const filtre = !!(f.form_id || f.debut || f.fin);
  const rattachees = Math.max(0, vue.total - vue.nonResolues);
  const tronquee = vue.echantillon < vue.total;
  const vide = totalGlobal === 0;

  return (
    <div className="space-y-4">
      {!vide && (<>
        <StatRow>
          <Stat label="Soumissions" value={fmt(vue.total)} icon={Inbox}
            sub={filtre ? "dans la sélection" : "toutes sources et dates"} />
          <Stat label="Rattachées à un site" value={fmt(rattachees)} tone="ok" icon={Link2}
            sub={`${pct(rattachees, vue.total)} % de la sélection`} />
          {/* Le chiffre autour duquel l'écran est construit : c'est le seul qui
              appelle une action, et il porte donc le ton d'alerte même à zéro —
              un « 0 » vert se lit d'un coup d'œil comme « rien à faire ». */}
          <Stat label="Non résolues" value={fmt(vue.nonResolues)} icon={Unlink}
            tone={vue.nonResolues ? "bad" : "ok"}
            sub={vue.nonResolues ? "à traiter — voir le motif" : "aucune soumission orpheline"} />
        </StatRow>

        <div className="f105 font-bold uppercase tracking-wider text-slate-500 mb-1.5">
          Répartition par passe de rattachement
          {tronquee && <span className="normal-case tracking-normal font-normal text-slate-400">
            {" "}— sur les {fmt(vue.echantillon)} soumissions les plus récentes de {fmt(vue.total)}</span>}
        </div>
        <StatRow>
          {PASSES.map(p => (
            <Stat key={p.cle} label={p.label} value={fmt(vue.parPasse[p.cle] || 0)}
              tone={(vue.parPasse[p.cle] || 0) ? p.ton : null} sub={p.note} />))}
        </StatRow>
      </>)}

      {can("admin") && (
        <Card title="Alimenter la chaîne"
          subtitle="Le versement relit le cache du dernier tirage ODK ; le rattachement ne relit que la base"
          right={<>
            <Select value={source} onChange={e=>setSource(e.target.value)} empty="Source à verser…"
              options={(db.odkForms || []).map(o => [o.id, o.name])}
              className="mi-py1 mi-xs mi-wauto" />
            <Btn size="sm" icon={DownloadCloud} disabled={!source || !!enCours} onClick={verser}>
              {enCours === "ingest" ? "Versement…" : "Verser les soumissions"}</Btn>
            <Btn size="sm" kind="sec" icon={Link2} disabled={!!enCours} onClick={rejouer}>
              {enCours === "rattacher" ? "Rattachement…" : "Rejouer le rattachement"}</Btn>
          </>}>
          <p className="f125 text-slate-600 leading-relaxed">
            <b>Verser</b> reprend les soumissions déjà tirées d'ODK Central et les fait entrer en base,
            chacune avec le site qu'elle désigne — ou avec le motif de son échec. Le tirage lui-même se
            lance dans <b>Paramètres → ODK Central</b> ; verser ne rappelle jamais le serveur ODK, ce qui
            permet de re-verser un même cache après correction sans dépendre du réseau.
            {" "}<b>Rejouer le rattachement</b> ne lit que la base : c'est le geste d'après une correction
            du registre des sites.
          </p>
          {bilan && <CompteRendu bilan={bilan} onFermer={()=>setBilan(null)} />}
        </Card>)}

      {/* L'encadré qui manque partout ailleurs : que faire de la ligne qu'on a
          sous les yeux. Sans lui, le motif se lit comme un reproche plutôt que
          comme une consigne. */}
      <Note tone="info">
        <b>Une ligne reste non résolue ?</b> Le motif dit quelle passe a échoué et pourquoi :
        code absent du référentiel, code partagé par deux sites, nom inconnu, ou nom connu sous
        une autre activité. Le remède est presque toujours le même — ouvrir la fiche du site dans
        le <b>registre des sites</b>, y renseigner le <b>code externe</b>, c'est-à-dire le code que
        le formulaire porte, celui de la colonne « code brut » ci-dessous, puis revenir ici et
        <b> rejouer le rattachement</b>. Aucun nouveau tirage n'est nécessaire : les soumissions
        sont déjà en base, seule leur résolution est recalculée.
      </Note>

      <Card flush title="Soumissions et résolution"
        subtitle={busy ? "Chargement…"
          : rows.length < affiches
            ? `${fmt(affiches)} soumission(s) dans cet état — les ${fmt(rows.length)} plus récentes sont affichées`
            : `${fmt(affiches)} soumission(s) dans cet état`}
        right={<Btn size="sm" kind="ghost" icon={RefreshCw} onClick={charger}>Actualiser</Btn>}>

        {!vide && (
          <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50">
            <Select value={f.form_id} onChange={e=>setF(x=>({...x, form_id:e.target.value}))}
              empty="Toutes les sources" options={sources} className="mi-py1 mi-xs mi-wauto" />
            {/* L'état s'ouvre sur « non résolues » : cet écran est une file de
                travail avant d'être un inventaire. La liste complète reste à un
                clic, mais elle n'est pas ce qu'on vient chercher. */}
            <Select value={f.resolution} onChange={e=>setF(x=>({...x, resolution:e.target.value}))}
              options={ETATS} className="mi-py1 mi-xs mi-wauto" />
            <span className="w-px h-6 bg-slate-300 mx-1" />
            <label className="flex items-center gap-1.5 f115 text-slate-500">Collecte du
              <input type="date" value={f.debut} onChange={e=>setF(x=>({...x, debut:e.target.value}))}
                className={clsx(inputCls, "mi-py1 mi-xs mi-wauto")} /></label>
            <label className="flex items-center gap-1.5 f115 text-slate-500">au
              <input type="date" value={f.fin} onChange={e=>setF(x=>({...x, fin:e.target.value}))}
                className={clsx(inputCls, "mi-py1 mi-xs mi-wauto")} /></label>
            {(filtre || f.resolution !== "non_resolues") && (
              <Btn size="sm" kind="ghost"
                onClick={()=>setF({ form_id:"", resolution:"non_resolues", debut:"", fin:"" })}>
                Revenir à la file de travail</Btn>)}
          </div>)}

        {erreur && <div className="p-5 pb-0"><Note tone="err">{erreur}</Note></div>}

        {vide ? (
          <Empty icon={Inbox} title="Aucune soumission n'a encore été versée"
            text={"Les soumissions viennent d'ODK Central en deux temps. D'abord le tirage : "
              + "dans Paramètres → ODK Central, une source déclare son projet, son formulaire et "
              + "son jeton, et le bouton de tirage en rapatrie les soumissions dans un cache. "
              + "Ensuite le versement, ici même : il fait entrer ce cache en base et rattache "
              + "chaque soumission à son site. Tant que la première étape n'a pas eu lieu, cet "
              + "écran n'a rien à montrer."} />
        ) : !rows.length ? (
          <Empty icon={f.resolution === "non_resolues" ? Link2 : SearchX}
            title={f.resolution === "non_resolues" && !filtre
              ? "Aucune soumission non résolue"
              : "Aucune soumission pour ces filtres"}
            text={f.resolution === "non_resolues"
              ? "Toutes les soumissions de cette sélection sont rattachées à un site. La file de "
                + "travail est vide : il n'y a rien à corriger."
              : "Élargissez la période, changez de source, ou revenez à la file de travail."} />
        ) : (
          <TableWrap max="mh65">
            <thead><tr>
              <Th>Collecte</Th><Th>Source</Th><Th>Code brut</Th><Th>Nom brut</Th><Th>Activité</Th>
              <Th>Site rattaché</Th><Th>Passe</Th><Th num>Confiance</Th><Th>Motif de résolution</Th>
            </tr></thead>
            <tbody>{rows.map(r => {
              const p = passeDe(r);
              const c = Number(r.resolution_confiance) || 0;
              return (
                <tr key={r.id} className="hover:bg-sky-50" data-soumission={r.id}>
                  <Td className="font-medium">{jour(r.svy_date) || <span className="text-slate-300">—</span>}
                    {r.submitted_at && <div className="f105 text-slate-400 font-normal">
                      déposée le {jour(r.submitted_at) || "?"}</div>}</Td>
                  <Td className="f115 text-slate-500">{r.form_id || "—"}</Td>
                  <Td className="f115">{r.site_code_raw || <span className="text-slate-300">absent</span>}</Td>
                  <Td className="text-slate-700">{r.site_name_raw || <span className="text-slate-300">absent</span>}</Td>
                  <Td>{r.activity_tag ? <Badge>{r.activity_tag}</Badge> : <span className="text-slate-300">—</span>}</Td>
                  {/* L'absence de rattachement est ce qu'on vient chercher : elle
                      est dite en toutes lettres et en rouge, jamais par une case
                      vide qu'on prendrait pour une donnée manquante. */}
                  <Td>{r.site_id
                    ? <><span className="font-medium text-slate-800">{r.site_name}</span>
                        <span className="f11 text-slate-400 ml-1.5">{r.site_code}</span></>
                    : <Badge tone="r">non rattachée</Badge>}</Td>
                  <Td><Badge tone={p.pastille}>{p.label}</Badge></Td>
                  <Td num>{r.site_id
                    ? <span className={clsx("tabular-nums font-semibold",
                        c >= 0.8 ? "text-lime-700" : c >= 0.6 ? "text-slate-700" : "text-amber-700")}>
                        {Math.round(c * 100)} %</span>
                    : <span className="text-slate-300">—</span>}</Td>
                  <Td>
                    {/* `white-space` s'hérite : la cellule est en `nowrap`, ce bloc
                        y échappe pour lui seul. Le motif est une phrase, parfois
                        longue — la tronquer supprimerait justement la partie qui
                        nomme les sites en conflit. */}
                    <div className="whitespace-normal mw420 f115 leading-snug text-slate-600">
                      {r.resolution_motif || "—"}</div></Td>
                </tr>);
            })}</tbody>
          </TableWrap>)}
      </Card>
    </div>);
}

/* ── Compte rendu d'une action ────────────────────────────────────────
   Un versement sans compte rendu ne se vérifie pas : on ne saurait ni combien de
   lignes sont entrées, ni sur quelles variables du formulaire la détection s'est
   appuyée. Les correspondances retenues sont donc affichées telles que le
   serveur les a renvoyées — c'est ce qui rend la détection par défaut
   contestable, et donc utilisable. */
function CompteRendu({ bilan, onFermer }){
  if(bilan.erreur) return (
    <Note tone="err">
      <div className="flex items-start gap-2">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <div><b>{bilan.genre === "ingest" ? "Versement impossible" : "Rattachement impossible"}.</b>
          {" "}{bilan.erreur}</div>
      </div>
    </Note>);

  const reste = bilan.nonResolues || 0;
  const chiffres = bilan.genre === "ingest"
    ? [["Lues", bilan.lues], ["Créées", bilan.crees], ["Mises à jour", bilan.misAJour],
       ["Rattachées", bilan.resolues], ["Non résolues", reste]]
    : [["Examinées", bilan.examinees], ["Nouvellement rattachées", bilan.rattachees],
       ["Détachées", bilan.detachees], ["Non résolues", reste]];

  return (
    <div className="mt-4 border border-slate-200 rounded overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-slate-50 border-b border-slate-200">
        <span className="f13 font-semibold text-slate-800">
          {bilan.genre === "ingest"
            ? `Versement${bilan.nom ? ` — ${bilan.nom}` : ""}`
            : "Rattachement rejoué sur toutes les soumissions"}</span>
        <button onClick={onFermer} className="ml-auto f115 text-slate-400 hover:text-slate-700">Fermer</button>
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-2 px-4 py-3">
        {chiffres.map(([label, v]) => (
          <div key={label}>
            <div className="f105 font-bold uppercase tracking-wider text-slate-500">{label}</div>
            <div className={clsx("text-xl font-light tabular-nums leading-tight",
              label === "Non résolues" && v ? "text-rose-700" : "text-slate-800")}>{fmt(v || 0)}</div>
          </div>))}
      </div>

      {bilan.genre === "ingest" && (
        <div className="px-4 pb-3 flex flex-wrap gap-1.5">
          {PASSES.filter(p => bilan.parPasse?.[p.cle]).map(p => (
            <Badge key={p.cle} tone={p.pastille}>{p.label} · {fmt(bilan.parPasse[p.cle])}</Badge>))}
        </div>)}

      {bilan.avertissement && (
        <div className="px-4 pb-3"><Note tone="warn">{bilan.avertissement}</Note></div>)}

      {/* Une soumission incomplète entre quand même en base — le serveur ne la
          refuse pas — mais elle explique souvent l'échec de la résolution qui
          suit : autant le dire ici plutôt que de laisser chercher. */}
      {bilan.incompletes?.length > 0 && (
        <div className="px-4 pb-3">
          <Note tone="warn">
            {fmt(bilan.incompletes.length)} soumission(s) versées sans tous les champs
            indispensables ({[...new Set(bilan.incompletes.flatMap(i => i.manquants))].join(", ")}).
            Elles sont en base, mais leur rattachement part avec moins d'indices.
          </Note>
        </div>)}

      {bilan.genre === "ingest" && bilan.correspondances?.length > 0 && (
        <div className="border-t border-slate-200">
          <div className="px-4 py-2 f105 font-bold uppercase tracking-wider text-slate-500 bg-slate-50">
            Variables retenues dans le formulaire
          </div>
          <p className="px-4 pt-2.5 f115 text-slate-500 leading-relaxed">
            Sans connecteur déclaré, le serveur choisit lui-même la variable qui alimente chaque
            champ MEMS. Le détail est affiché pour qu'il soit vérifiable : si le code de site est
            lu dans la mauvaise colonne, tout ce qui suit est faux, et rien d'autre ne le dirait.
          </p>
          <TableWrap max="mh240">
            <thead><tr><Th>Champ MEMS</Th><Th>Variable de la source</Th><Th>Transformation</Th></tr></thead>
            <tbody>{bilan.correspondances.map((c, i) => (
              <tr key={`${c.mems_field}-${i}`}>
                <Td className="font-medium f115">{c.mems_field}</Td>
                <Td className="f115 text-slate-600">{c.source_path}</Td>
                <Td className="f115 text-slate-500">{c.transform || "—"}</Td>
              </tr>))}</tbody>
          </TableWrap>
        </div>)}
    </div>);
}
