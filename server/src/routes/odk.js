import { Router } from "express";
import { db, tx } from "../db.js";
import { requireCap } from "../lib/auth.js";
import { decrypt, newId } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { pullSubmissions, verifierBaseOdk } from "../lib/odkClient.js";
import { porteurAuth, sonder, indicesSecret, SCHEMAS_AUTH, CHEMIN_SESSION_ODK_DEFAUT,
         CHEMIN_EPREUVE_ODK_DEFAUT } from "../lib/authSortante.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

const reglage = (cle, defaut) =>
  J(db.prepare("SELECT value FROM settings WHERE key=?").get(cle)?.value, defaut) || defaut;

/* Le porteur d'authentification d'une source ODK, construit à un seul endroit
   pour que le tirage et l'épreuve de connexion ne puissent pas diverger.

   `token_enc` porte le JUSTIFICATIF DURABLE, dont la nature dépend du schéma :
   un jeton de session collé à la main sous « porteur », un mot de passe sous
   « session ODK ». C'est la même colonne, chiffrée de la même façon (AES-256-GCM,
   lib/crypto.js) — ce qui change est ce que MEMS en fait, et c'est le schéma
   déclaré sur la source qui le dit, plus le code. */
function porteurDeSource(f, odkBase){
  return porteurAuth({
    nature: "odk_forms", id: f.id,
    schema: f.auth_schema || "porteur",
    identifiant: f.auth_identifiant || "",
    secret: f.token_enc ? decrypt(f.token_enc) : "",
    /* Enregistré mais indéchiffrable n'est pas absent : `decrypt` rend null quand
       la clé de chiffrement de l'instance n'est plus celle qui a chiffré la ligne.
       Le porteur le dit alors avec le bon remède — restaurer la clé — au lieu
       d'envoyer ressaisir un secret qui est déjà là. */
    secretPresent: !!f.token_enc,
    baseUrl: odkBase,
    cheminSession: reglage("odkCheminSession", CHEMIN_SESSION_ODK_DEFAUT),
    verifierBase: verifierBaseOdk,
    codeErreur: "ODK_AUTH",
    quoi: `la source « ${f.name} »`,
  });
}

/* L'adresse du serveur, et le refus explicite quand elle manque. Elle vient d'un
   réglage, donc de l'extérieur : elle est vérifiée avant tout appel sortant par
   `verifierBaseOdk` (lib/odkClient.js), qui impose https, refuse les adresses
   privées et honore la liste blanche ODK_ALLOWED_HOSTS. */
function adresseOdk(res){
  const odkBase = reglage("odkBase", "");
  if(!odkBase){ res.status(422).json({ error:
    "adresse du serveur ODK Central absente (Paramètres → ODK Central → Serveur)" }); return null; }
  return odkBase;
}

function charger(req, res){
  const f = db.prepare("SELECT * FROM odk_forms WHERE id=?").get(req.params.id);
  if(!f){ res.status(404).json({ error: "source ODK introuvable" }); return null; }
  return f;
}

/* Traduit une erreur du chemin sortant en réponse. Les cinq causes nommées
   arrivent ici avec leur message déjà exact (lib/authSortante.js) : la route ne
   le réécrit pas, elle choisit seulement le code HTTP. Elle rendait auparavant
   un texte unique — « vérifiez qu'il est valide » — pour 401 comme pour 403,
   c'est-à-dire qu'elle accusait le jeton y compris quand le jeton était bon. */
function repondreEchec(res, next, e, f){
  if(e.code === "ODK_URL") return res.status(422).json({ error: e.message, cause: "AUTH_HOTE" });
  if(e.code === "ODK_AUTH") return res.status(422).json({ error: e.message, cause: e.causeAuth || null });
  if(e.code === "ODK_NOT_FOUND") return res.status(422).json({ error:
    "formulaire introuvable sur ODK Central : vérifiez le projet et l'identifiant du formulaire." });
  if(e.code === "ODK_NETWORK" || e.code === "ODK_HTTP"){
    log.warn("tirage ODK Central en échec", { source: f.id, code: e.code });
    return res.status(502).json({ error:
      "le serveur ODK Central n'a pas répondu correctement : vérifiez l'adresse et la connectivité." });
  }
  return next(e);
}

/* Tire les soumissions réelles d'une source ODK Central et les met en cache
   sur la source (odk_forms.raw) : « Créer un jeu de données depuis un
   formulaire » (Analyses → Jeux de données) en fige alors une copie
   indépendante, exactement comme avec les données de démonstration.

   Seul le justificatif propre à la source, chiffré dans `odk_forms.token_enc`,
   permet cet appel : le jeton général du navigateur (Paramètres → ODK Central →
   Serveur) n'est ni conservé ni employé par le serveur — `PUT /settings`
   (routes/collections.js) le rejette au lieu de l'écrire. */
r.post("/odk-forms/:id/pull", requireCap("admin"), async (req, res, next) => {
  const f = charger(req, res); if(!f) return;
  /* Ce qu'exige une source, c'est SON schéma qui le dit — et lui seul. Le refus
     posé ici exigeait un justificatif durable de toutes les sources, en affirmant
     que « tous les schémas » en réclament un : c'est faux du schéma « Aucune
     (source publique) », que l'écran propose et que la fiche accepte. Le tirage
     réclamait alors un jeton pour une source déclarée sans, tandis que l'épreuve
     de connexion, sur la même ligne, rendait un diagnostic honnête. Deux routes,
     deux verdicts : c'est `porteurAuth` qui tranche désormais, pour les deux. */
  if(!f.project) return res.status(422).json({ error:
    "identifiant de projet ODK Central absent pour cette source (Paramètres → ODK Central)" });

  const odkBase = adresseOdk(res); if(!odkBase) return;

  let porteur;
  try{ porteur = porteurDeSource(f, odkBase); }
  catch(e){ return res.status(422).json({ error: e.message, cause: e.causeAuth || null }); }

  try{
    const { rows, pages, truncated } = await pullSubmissions({
      baseUrl: odkBase, project: f.project, formId: f.form_id, porteur });

    tx(() => {
      db.prepare("UPDATE odk_forms SET raw=?, records=?, last_pull=datetime('now'), rev=rev+1 WHERE id=?")
        .run(JSON.stringify(rows), rows.length, f.id);
    })();

    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'odk','odk_forms',?,'pull',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name, f.id,
        `Tirage ODK Central — ${f.name} : ${rows.length} soumission(s)${truncated ? " (plafond atteint)" : ""}`);

    res.json({ ok: true, records: rows.length, pages, truncated,
      avertissement: truncated
        ? "Le plafond de récupération a été atteint : certaines soumissions n'ont pas été tirées. "
          + "Affinez la période ou contactez l'équipe technique pour relever la limite."
        : null });
  }catch(e){ repondreEchec(res, next, e, f); }
});

/* ── Épreuve de connexion ─────────────────────────────────────────────
   « Tester cette source », en deux étapes qui ne disent pas la même chose, et
   c'est tout l'intérêt :

     1. le JUSTIFICATIF — MEMS ouvre la session si le schéma en dérive une, puis
        interroge un point d'entrée qui ne touche à aucune donnée. Un refus ici
        met en cause le justificatif, pas les droits sur le formulaire.
     2. le FORMULAIRE — une soumission demandée sur CE formulaire. Un refus ici,
        après une étape 1 réussie, dit exactement l'inverse : le compte est bon,
        il n'a pas les droits sur ce projet.

   Aucun secret ne ressort : au plus sa présence et sa longueur, jamais sa valeur
   ni ses derniers caractères. Réservée à l'administration comme le tirage, et
   pour la même raison : elle déchiffre un secret et sort sur le réseau. */
r.post("/odk-forms/:id/test", requireCap("admin"), async (req, res, next) => {
  const f = charger(req, res); if(!f) return;
  const odkBase = adresseOdk(res); if(!odkBase) return;

  /* La forme d'une étape que le réseau n'a pas produite : elle porte les mêmes
     clés que celles de `sonder`, sinon l'écran afficherait des blancs là où il
     attend un diagnostic. */
  const etapeSansAppel = (etape, cause, message) => ({
    etape, ok:false, verdict:"indetermine", hote_verifie:false, joignable:false, code_http:null,
    schema_employe: f.auth_schema || "porteur",
    schema_libelle: SCHEMAS_AUTH[f.auth_schema || "porteur"]?.libelle || "",
    mot_cle: SCHEMAS_AUTH[f.auth_schema || "porteur"]?.motCle || "",
    cause, message, indices: indicesSecret("", !!f.token_enc), session: null });

  let porteur;
  try{ porteur = porteurDeSource(f, odkBase); }
  catch(e){
    return res.json({ ok:false, source:{ id:f.id, name:f.name },
      etapes: [etapeSansAppel("justificatif", e.causeAuth || "AUTH_ABSENT", e.message)] });
  }

  const cheminEpreuve = reglage("odkCheminEpreuve", CHEMIN_EPREUVE_ODK_DEFAUT);
  const etapes = [];
  try{
    etapes.push(await sonder({ porteur, etape: "justificatif", chemin: cheminEpreuve,
      /* `/v1/users/current` exige une authentification : un 2xx y prouve que le
         justificatif a été accepté. Un chemin réglé par l'exploitant, non — on ne
         sait pas ce qu'il y a au bout, et `sonder` s'en assure lui-même. */
      exigeAuth: cheminEpreuve === CHEMIN_EPREUVE_ODK_DEFAUT }));

    /* La seconde étape ne se tente que si la première a réussi : la lancer après
       un refus d'authentification ne produirait qu'un second refus identique, et
       laisserait croire à deux problèmes là où il n'y en a qu'un.

       Faute de projet ou d'identifiant de formulaire, elle ne peut pas se tenter
       — et son absence ne doit pas passer pour une réussite. `etapes.every` sur
       la seule étape restante rendait « ok », donc un bandeau vert, à une source
       dont le tirage refuse en 422 la seconde d'après. Une épreuve annoncée en
       deux étapes qui en escamote une n'éprouve pas ce qu'elle dit éprouver. */
    if(etapes[0].ok){
      if(f.project && f.form_id)
        etapes.push(await sonder({ porteur, etape: "formulaire", forcer: false, exigeAuth: true,
          chemin: `/v1/projects/${encodeURIComponent(f.project)}/forms/`
            + `${encodeURIComponent(f.form_id)}.svc/Submissions?$top=1` }));
      else
        etapes.push(etapeSansAppel("formulaire", null,
          `l'accès au formulaire n'a pas pu être éprouvé : ${!f.project ? "l'identifiant de projet"
            : "l'identifiant du formulaire"} manque sur cette source. Le justificatif, lui, est `
          + "accepté. Renseignez le champ manquant dans la fiche de la source : sans lui, le tirage "
          + "sera refusé."));
    }
  }catch(e){ return next(e); }

  const ok = etapes.every(x => x.ok);
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'odk','odk_forms',?,'test',?)`)
    .run(newId("aud"), req.user.id, req.user.first_name, f.id,
      `Épreuve de connexion ODK Central — ${f.name} : ${ok ? "réussie" : "échouée"}`
      + `${ok ? "" : ` (${etapes.find(x => !x.ok)?.cause || "cause non déterminée"})`}`);

  res.json({ ok, source: { id: f.id, name: f.name }, etapes });
});

export default r;
