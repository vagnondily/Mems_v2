import { Router } from "express";
import { db, tx } from "../db.js";
import { requireCap } from "../lib/auth.js";
import { decrypt, newId } from "../lib/crypto.js";
import { log } from "../lib/logger.js";
import { pullSubmissions } from "../lib/odkClient.js";

const r = Router();
const J = (v, d) => { try{ return JSON.parse(v); }catch(e){ return d; } };

/* Tire les soumissions réelles d'une source ODK Central et les met en cache
   sur la source (odk_forms.raw) : « Créer un jeu de données depuis un
   formulaire » (Analyses → Jeux de données) en fige alors une copie
   indépendante, exactement comme avec les données de démonstration.

   Le jeton général du navigateur (Paramètres → ODK Central → Serveur)
   n'atteint jamais le serveur — voir routes/collections.js, `PUT /settings`.
   Seul le jeton propre à la source, chiffré dans `odk_forms.token_enc`,
   permet cet appel : sans lui, il n'y a rien à déchiffrer côté serveur. */
r.post("/odk-forms/:id/pull", requireCap("admin"), async (req, res, next) => {
  const f = db.prepare("SELECT * FROM odk_forms WHERE id=?").get(req.params.id);
  if(!f) return res.status(404).json({ error: "source ODK introuvable" });
  if(!f.token_enc) return res.status(422).json({ error:
    "cette source n'a pas de jeton propre. Le jeton général du navigateur n'est jamais transmis "
    + "au serveur : ouvrez la source dans Paramètres → ODK Central et renseignez-lui un jeton dédié." });
  const token = decrypt(f.token_enc);
  if(!token) return res.status(500).json({ error: "jeton illisible : ressaisissez-le pour cette source" });
  if(!f.project) return res.status(422).json({ error:
    "identifiant de projet ODK Central absent pour cette source (Paramètres → ODK Central)" });

  const odkBase = J(db.prepare("SELECT value FROM settings WHERE key='odkBase'").get()?.value, "");
  if(!odkBase) return res.status(422).json({ error:
    "adresse du serveur ODK Central absente (Paramètres → ODK Central → Serveur)" });

  try{
    const { rows, pages, truncated } = await pullSubmissions({
      baseUrl: odkBase, project: f.project, formId: f.form_id, token });

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
  }catch(e){
    if(e.code === "ODK_AUTH") return res.status(422).json({ error:
      "jeton refusé par ODK Central : vérifiez qu'il est valide et qu'il donne accès à ce formulaire." });
    if(e.code === "ODK_NOT_FOUND") return res.status(422).json({ error:
      "formulaire introuvable sur ODK Central : vérifiez le projet et l'identifiant du formulaire." });
    if(e.code === "ODK_NETWORK" || e.code === "ODK_HTTP"){
      log.warn("tirage ODK Central en échec", { source: f.id, code: e.code });
      return res.status(502).json({ error:
        "le serveur ODK Central n'a pas répondu correctement : vérifiez l'adresse et la connectivité." });
    }
    next(e);
  }
});

export default r;
