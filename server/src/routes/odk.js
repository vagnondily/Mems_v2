import { Router } from "express";
import { db } from "../db.js";
import { decrypt, newId } from "../lib/crypto.js";
import { requireCap } from "../lib/auth.js";

/* Lecture des soumissions.

   Le carnet supposait l'API OData d'ODK Central (`/v1/projects/{p}/forms/{f}.svc/
   Submissions`, `$top`/`$skip`/`$filter`, champs `__id`/`__system`). Un lien de test
   réel fourni pendant la session (`https://moda.wfp.org/api/v1/data/340943`, jeton
   hexadécimal à 40 caractères) ne correspond pas à cette forme : c'est celle de l'API
   REST KoBoCAT/Ona, dont MODA (la plateforme ODK de WFP) hérite — `/api/v1/data/{id}`,
   authentification `Authorization: Token <jeton>` (DRF TokenAuthentication, pas un
   Bearer JWT), soumissions plates avec des champs `_id`/`_uuid`/`_submission_time`.

   Cette hypothèse n'a PAS pu être vérifiée contre une vraie réponse : la politique
   réseau de l'environnement de développement refuse la sortie vers moda.wfp.org
   (403 côté proxy). Elle repose sur la forme de l'URL et du jeton, pas sur un appel
   réussi. Voir docs/A_FAIRE.md, chantier 1, pour ce qui reste à confirmer. */

const r = Router();

const PAGE = 500;         // taille d'une page
const MAX_PAGES = 10;     // plafond par appel : une extraction longue se relance depuis l'écran

function formOr404(req, res){
  const f = db.prepare("SELECT * FROM odk_forms WHERE id=?").get(req.params.id);
  if(!f){ res.status(404).json({ error:"formulaire introuvable" }); return null; }
  return f;
}

function baseUrl(){
  const row = db.prepare("SELECT value FROM settings WHERE key='odkBase'").get();
  if(!row) return null;
  try{ return JSON.parse(row.value); }catch{ return row.value; }
}

/* Le jeton ne doit jamais ressortir de l'API, même déchiffré : il ne sert qu'ici,
   à composer l'en-tête d'autorisation de l'appel sortant. */
function tokenFor(f){ return f.token_enc ? decrypt(f.token_enc) : null; }

function buildUrl(base, f, { limit, start, query } = {}){
  const u = new URL(`${base.replace(/\/+$/,"")}/api/v1/data/${encodeURIComponent(f.form_id)}`);
  if(limit) u.searchParams.set("limit", String(limit));
  if(start) u.searchParams.set("start", String(start));
  if(query) u.searchParams.set("query", JSON.stringify(query));
  return u.toString();
}

async function callOdk(url, token){
  let resp;
  try{
    resp = await fetch(url, { headers: token ? { Authorization: `Token ${token}` } : {} });
  }catch(e){
    const err = new Error("serveur ODK injoignable : "+e.message); err.status = 502; throw err;
  }
  const text = await resp.text();
  let body; try{ body = text ? JSON.parse(text) : null; }catch{ body = null; }
  if(!resp.ok){
    const msg = body?.detail || body?.message || `réponse ${resp.status} du serveur ODK`;
    /* Jamais 401 : le client MEMS déconnecte la session entière sur tout 401, quelle
       que soit la route — un jeton ODK externe refusé éjecterait l'administrateur de
       toute l'application, pour une cause qui n'a rien à voir avec sa propre session. */
    const err = new Error(msg); err.status = (resp.status === 401 || resp.status === 403) ? 409 : 502;
    throw err;
  }
  /* KoBoCAT/Ona rend un tableau JSON brut ; certaines variantes (KPI) l'enveloppent
     dans { results:[...] }. On accepte les deux plutôt que de deviner laquelle. */
  if(Array.isArray(body)) return body;
  if(Array.isArray(body?.results)) return body.results;
  return [];
}

/* GET /odk/forms/:id/champs — les clés rencontrées dans les 200 dernières soumissions
   déjà lues, avec leur type deviné et jusqu'à trois valeurs d'exemple. C'est ce que
   l'écran d'appariement (chantier 2) affichera à gauche. */
r.get("/forms/:id/champs", requireCap("edit"), (req, res) => {
  const f = formOr404(req, res); if(!f) return;
  const rows = db.prepare(
    `SELECT payload FROM odk_submission WHERE form_id=? ORDER BY submitted_at DESC LIMIT 200`)
    .all(f.id);
  const champs = new Map();
  for(const row of rows){
    let payload; try{ payload = JSON.parse(row.payload); }catch{ continue; }
    for(const [champ, valeur] of Object.entries(payload)){
      /* Les métadonnées KoBoCAT/Ona sont préfixées d'un unique tiret bas
         (`_id`, `_uuid`, `_submission_time`, `_geolocation`, `_tags`…) ; `meta/`
         porte l'UUID d'instance ODK. Aucune des deux n'est une variable du
         formulaire. */
      if(champ.startsWith("_") || champ.startsWith("meta/") || champ === "formhub/uuid") continue;
      if(!champs.has(champ)) champs.set(champ, { type:null, exemples:[] });
      const c = champs.get(champ);
      if(valeur === null || valeur === undefined || valeur === "") continue;
      const devine = typeof valeur === "number" ? "number"
        : typeof valeur === "boolean" ? "boolean"
        : /^-?\d+(\.\d+)?$/.test(String(valeur)) ? "number"
        : "text";
      if(!c.type) c.type = devine;
      if(c.exemples.length < 3 && !c.exemples.includes(valeur)) c.exemples.push(valeur);
    }
  }
  res.json({ rows: [...champs.entries()].map(([champ, c]) =>
    ({ champ, type: c.type || "text", exemples: c.exemples })) });
});

/* POST /odk/forms/:id/test — un appel `limit=1` qui dit seulement si le serveur
   répond et si le jeton est accepté. C'est le vrai « Tester la connexion », celui
   qui manquait : l'ancien bouton affichait un succès sans avoir rien appelé. */
r.post("/forms/:id/test", requireCap("edit"), async (req, res) => {
  const f = formOr404(req, res); if(!f) return;
  const base = baseUrl();
  if(!base) return res.status(409).json({ error:"aucune adresse de serveur ODK configurée (Paramètres → ODK Central)" });
  const token = tokenFor(f);
  if(!token) return res.status(409).json({ error:"aucun jeton enregistré pour cette source" });
  try{
    const value = await callOdk(buildUrl(base, f, { limit:1 }), token);
    res.json({ ok:true, repond:true, exemple: value.length });
  }catch(e){
    res.status(e.status || 502).json({ ok:false, error:e.message });
  }
});

/* POST /odk/forms/:id/pull — extraction paginée depuis le curseur enregistré.
   INSERT OR IGNORE sur l'identifiant de la soumission : rejouer l'appel n'introduit
   aucun doublon, c'est ce qui rend l'extraction sans risque à relancer. */
r.post("/forms/:id/pull", requireCap("edit"), async (req, res) => {
  const f = formOr404(req, res); if(!f) return;
  const base = baseUrl();
  if(!base) return res.status(409).json({ error:"aucune adresse de serveur ODK configurée (Paramètres → ODK Central)" });
  const token = tokenFor(f);
  if(!token) return res.status(409).json({ error:"aucun jeton enregistré pour cette source" });

  const insert = db.prepare(`INSERT OR IGNORE INTO odk_submission
    (id, form_id, submitted_at, site_id, site_key, periode, payload) VALUES (?,?,?,?,?,?,?)`);
  const parCode = db.prepare("SELECT id FROM sites WHERE code=?");
  const parNom  = db.prepare("SELECT id FROM sites WHERE name=?");

  let lues = 0, nouvelles = 0, ignorees = 0, sansSite = 0;
  let cursor = f.last_cursor || null;

  try{
    let start = 0, page = 0, pagePleine = true;
    while(page < MAX_PAGES && pagePleine){
      const query = cursor ? { _submission_time: { "$gt": cursor } } : undefined;
      const value = await callOdk(buildUrl(base, f, { limit:PAGE, start, query }), token);
      lues += value.length;

      const appliquer = db.transaction((soumissions) => {
        for(const sub of soumissions){
          const id = sub._uuid ? String(sub._uuid) : (sub._id !== undefined && sub._id !== null ? String(sub._id) : null);
          if(!id) continue;
          const submittedAt = sub._submission_time || null;
          const siteKeyBrut = f.site_field ? sub[f.site_field] : null;
          const siteKey = (siteKeyBrut === undefined || siteKeyBrut === null || siteKeyBrut === "")
            ? null : String(siteKeyBrut);
          let siteId = null;
          if(siteKey) siteId = parCode.get(siteKey)?.id || parNom.get(siteKey)?.id || null;
          if(siteKey && !siteId) sansSite++;
          const dateVal = (f.date_field ? sub[f.date_field] : null) || submittedAt;
          const periode = dateVal ? String(dateVal).slice(0,7) : null;
          const info = insert.run(id, f.id, submittedAt, siteId, siteKey, periode, JSON.stringify(sub));
          if(info.changes) nouvelles++; else ignorees++;
          if(submittedAt && (!cursor || submittedAt > cursor)) cursor = submittedAt;
        }
      });
      appliquer(value);

      pagePleine = value.length === PAGE;
      start += PAGE;
      page++;
    }

    const records = db.prepare("SELECT COUNT(*) c FROM odk_submission WHERE form_id=?").get(f.id).c;
    db.prepare(`UPDATE odk_forms SET last_cursor=?, last_pull=datetime('now'), last_error=NULL, records=? WHERE id=?`)
      .run(cursor, records, f.id);

    db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
                VALUES (?,?,?,'odk','odk_forms',?,'pull',?)`)
      .run(newId("aud"), req.user.id, req.user.first_name || req.user.email, f.id,
        `Extraction ODK — ${f.name} : ${nouvelles} nouvelle(s), ${ignorees} déjà lue(s)`
        + (sansSite ? `, ${sansSite} sans site résolu` : ""));

    res.json({ lues, nouvelles, ignorees, sansSite, cursor });
  }catch(e){
    db.prepare("UPDATE odk_forms SET last_error=? WHERE id=?").run(String(e.message).slice(0,500), f.id);
    res.status(e.status || 502).json({ error:e.message });
  }
});

export default r;
