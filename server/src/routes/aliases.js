/* ═══════════════════════════════════════════════════════════════════════
   Les codes externes d'un site, côté API.

   Un site porte autant de codes que de sources qui le désignent (migration 018).
   Ces routes servent les trois gestes correspondants : lister les codes d'un
   site, en ajouter ou en retirer un, et AVALER D'UN COUP une table de
   correspondance — les 1 251 codes école que le bureau tient à part et sans
   lesquels le formulaire SMP ne se rattache à rien.

   ── Pourquoi une route dédiée plutôt qu'un troisième type d'import Excel ──
   Le pipeline modèle → téléversement → analyse → diff → confirmation
   (lib/import.js) a été lu avant d'écrire une ligne ici. Il ne convient pas, et
   pas pour une raison de commodité : il est construit autour d'UNE clé, le
   p-code géographique, à trois endroits qui ne sont pas paramétrables.

     1. `analyse()` rejette toute ligne dont le `geo_pcode` est absent de
        `geo_unit` ou hors du périmètre de l'utilisateur. Une correspondance ne
        porte AUCUN p-code : sa clé est un site et un code étranger au
        référentiel — le cas SMP est précisément un entier « 603140007 » qui
        n'est un p-code de rien. Les 1 251 lignes seraient rejetées une à une.
     2. `GET /:kind/template` refuse de produire un modèle sans millésime
        géographique courant et sans unités adm3 dans le périmètre. Une table de
        correspondance n'a rien de géographique : exiger un référentiel chargé
        pour l'importer serait une condition inventée.
     3. `seed()` pré-remplit le modèle par unité administrative. Ici il faudrait
        le pré-remplir par site — c'est-à-dire ne rien partager avec l'existant
        au-delà du nom de la fonction.

   Les rendre paramétrables supposerait de conditionner la validation commune à
   deux types d'import qui marchent, au bénéfice d'un troisième qui n'a rien de
   géographique. Le gain aurait été la cérémonie d'aperçu avant confirmation —
   or elle existe pour protéger d'un écrasement : un import de caseload REMPLACE
   des chiffres. Ici rien n'est jamais remplacé. Une correspondance s'ajoute ou
   existe déjà (index unique de la migration 018), donc rejouer le même fichier
   ne change rien et le dit. Il n'y a pas d'état antérieur à prévisualiser.

   Ce qui comptait vraiment dans ce pipeline — un compte rendu qui n'escamote
   rien — est repris tel quel : sites introuvables listés ligne à ligne, codes
   devenus ambigus nommés, lignes invalides motivées.
   ═══════════════════════════════════════════════════════════════════════ */

import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { requireCap } from "../lib/auth.js";
import { officeBound } from "../lib/scope.js";
import { newId } from "../lib/crypto.js";
import { listerAlias, ajouterAlias, supprimerAlias, importerCorrespondances,
         SOURCE_FICHE } from "../lib/alias.js";

const r = Router();

const audit = (req, action, id, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,office,kind,entity,entity_id,action,text)
              VALUES (?,?,?,?,'plan','site_external_code',?,?,?)`)
    .run(newId("aud"), req.user.id, `${req.user.first_name} ${req.user.last_name || ""}`.trim(),
         req.user.office_id || "", id, action, texte);

/* Le site, sous réserve qu'il relève du bureau de l'appelant. Un site d'un autre
   bureau est rendu « introuvable » plutôt qu'« interdit » : répondre 403
   confirmerait son existence à quelqu'un qui n'a pas à la connaître. */
function siteAccessible(req, id){
  const s = db.prepare("SELECT id, code, name, office_id, external_code FROM sites WHERE id=?").get(id);
  if(!s) return null;
  const bureau = officeBound(req.user);
  if(bureau && s.office_id !== bureau) return null;
  return s;
}

/* ── Les codes d'un site ──────────────────────────────────────────────
   Le code par défaut y figure, sous la source réservée « fiche du site » : la
   liste servie est la liste COMPLÈTE, sans quoi l'écran devrait recoller deux
   provenances et finirait par en oublier une. */
r.get("/sites/:id/aliases", (req, res) => {
  const s = siteAccessible(req, req.params.id);
  if(!s) return res.status(404).json({ error: "site introuvable" });
  res.json({ site: { id: s.id, code: s.code, name: s.name },
    defaut: s.external_code || null, sourceDefaut: SOURCE_FICHE,
    rows: listerAlias(s.id) });
});

r.post("/sites/:id/aliases", requireCap("edit"), (req, res) => {
  const p = z.object({
    code: z.string().min(1).max(80),
    source: z.string().max(120).nullish(),
    note: z.string().max(300).nullish(),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "code externe invalide" });
  const s = siteAccessible(req, req.params.id);
  if(!s) return res.status(404).json({ error: "site introuvable" });
  /* La source réservée est refusée en saisie libre : elle appartient au miroir
     de la fiche, et une ligne posée à la main sous ce nom serait effacée à la
     première modification du code par défaut — sans que personne comprenne. */
  if((p.data.source || "").trim() === SOURCE_FICHE)
    return res.status(422).json({ error:
      `« ${SOURCE_FICHE} » désigne le code par défaut : modifiez-le sur la fiche du site.` });

  const { cree } = ajouterAlias({ site_id: s.id, ...p.data });
  if(cree) audit(req, "alias", s.id,
    `Code externe ajouté — ${s.name} : « ${p.data.code} »`
    + (p.data.source ? ` pour la source « ${p.data.source} »` : ""));
  res.status(cree ? 201 : 200).json({ cree, rows: listerAlias(s.id) });
});

r.delete("/site-aliases/:aliasId", requireCap("edit"), (req, res) => {
  const a = db.prepare("SELECT * FROM site_external_code WHERE id=?").get(req.params.aliasId);
  if(!a) return res.status(404).json({ error: "code externe introuvable" });
  const s = siteAccessible(req, a.site_id);
  if(!s) return res.status(404).json({ error: "code externe introuvable" });
  if(a.source === SOURCE_FICHE)
    return res.status(409).json({ error:
      "ce code est le code par défaut du site : videz-le sur la fiche du site, "
      + "pour que la fiche et la liste des codes ne se contredisent pas." });
  supprimerAlias(a.id);
  audit(req, "alias", s.id, `Code externe retiré — ${s.name} : « ${a.code} »`);
  res.json({ ok: true, rows: listerAlias(s.id) });
});

/* ── Import d'une table de correspondance ─────────────────────────────
   Le droit exigé est « edit », le même que celui de la fiche de site qui porte
   le code par défaut : déclarer 1 251 codes d'un coup est le même acte que d'en
   déclarer un, fait en une fois. */
r.post("/site-aliases/import", requireCap("edit"), (req, res) => {
  const p = z.object({
    /* La source commune à tout le lot, quand le fichier ne la porte pas
       ligne à ligne : c'est le cas normal — un fichier, un formulaire. */
    source: z.string().max(120).nullish(),
    lignes: z.array(z.object({
      code: z.union([z.string().max(80), z.number()]).nullish(),
      site_code: z.string().max(40).nullish(),
      site_id: z.string().max(64).nullish(),
      source: z.string().max(120).nullish(),
      note: z.string().max(300).nullish(),
    })).min(1).max(20000),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "table de correspondance invalide",
    details: p.error.issues.slice(0, 10)
      .map(i => ({ champ: i.path.join("."), message: i.message })) });

  /* Les codes SMP sont des ENTIERS dans les fichiers du bureau (603140007). Un
     tableur les livre en nombre, et JSON les transporte en nombre : les refuser
     obligerait chaque appelant à les convertir, donc à se tromper une fois. */
  const lignes = p.data.lignes.map(l => ({ ...l,
    code: l.code === null || l.code === undefined ? null : String(l.code) }));

  const bilan = importerCorrespondances({ lignes,
    office_id: officeBound(req.user), source: p.data.source });

  audit(req, "import", null,
    `Table de correspondance importée${p.data.source ? ` — ${p.data.source}` : ""} : `
    + `${bilan.lues} ligne(s), ${bilan.crees} créée(s), ${bilan.dejaPresents} déjà présente(s), `
    + `${bilan.sitesIntrouvables.length} site(s) introuvable(s), `
    + `${bilan.codesAmbigus.length} code(s) ambigu(s)`);

  res.json({ ...bilan,
    /* Un import qui « réussit » en laissant 300 lignes au bord de la route n'a
       pas réussi. Le message le dit en toutes lettres, à côté des listes. */
    avertissement: bilan.sitesIntrouvables.length || bilan.invalides.length
      ? `${bilan.sitesIntrouvables.length} ligne(s) désignent un site absent du registre et `
        + `${bilan.invalides.length} ligne(s) sont inexploitables : elles n'ont PAS été importées, `
        + "elles sont listées ci-dessous. Créez les sites manquants puis rejouez le même "
        + "fichier — l'import est idempotent, les lignes déjà passées ne seront pas doublées."
      : null,
    remarque: bilan.codesAmbigus.length
      ? `${bilan.codesAmbigus.length} code(s) désignent désormais plusieurs sites. Le résolveur `
        + "refusera de trancher entre eux : ces soumissions resteront à rattacher à la main."
      : null });
});

export default r;
