/* ═══════════════════════════════════════════════════════════════════════
   Les codes externes d'un site, côté API.

   Un site porte autant de codes que de sources qui le désignent (migration 018).
   Ces routes servent les trois gestes correspondants : lister les codes d'un
   site, en ajouter ou en retirer un, et AVALER D'UN COUP une table de
   correspondance — les 1 251 codes école que le bureau tient à part et sans
   lesquels le formulaire SMP ne se rattache à rien.

   ── Cette route reste, mais l'argument qui l'a fondée a cessé d'être vrai ──
   Ce paragraphe expliquait pourquoi une table de correspondance NE passait PAS
   par le cadre d'import Excel (lib/import.js). Il s'appuyait sur deux constats :
   ce cadre était construit autour d'une clé géographique à trois endroits non
   paramétrables (`analyse()` rejetait toute ligne sans p-code connu ou hors
   périmètre ; `GET /:kind/template` exigeait un millésime courant et des unités
   adm3 ; `seed()` pré-remplissait par unité administrative) — et il n'y avait
   qu'UN occupant à servir, ce qui ne valait pas de conditionner la validation
   commune à deux types d'import qui marchaient.

   Le lot B a changé les deux termes. Les trois hypothèses sont devenues une
   propriété déclarée du type, `portee: "geo" | "national"`, et le cadre accueille
   désormais un troisième type, `codes`, qui charge des RÉFÉRENTIELS de codes
   d'identification (migration 020, lib/codes.js) : les 1 251 codes école de SMP,
   puis les 247 codes ZAP, puis ceux des formulaires suivants. Deux occupants
   attendus, et un troisième annoncé, ne se traitent plus au cas par cas — c'est
   la raison même qui a fait naître lib/champs.js et lib/mapping.js.

   ── Ce qui subsiste, et pourquoi les deux chemins coexistent ─────────
   Les deux ne font pas la même chose, et aucun ne remplace l'autre :

     — `POST /site-aliases/import` (ici) déclare DIRECTEMENT des correspondances
       site ↔ code, en JSON, sous le droit « edit ». C'est le geste d'un
       opérateur de terrain qui possède déjà l'appariement ;
     — le type d'import `codes` charge la LISTE elle-même — code, libellé,
       géographie —, sous le droit « admin » parce qu'elle est nationale, puis
       `POST /api/code-referentiels/:referentiel/rapprocher` en déduit les
       correspondances et DIT ce qu'il n'a pas su rattacher.

   Le premier suppose qu'on sait déjà à quel site chaque code correspond ; le
   second est ce qu'on emploie quand justement on ne le sait pas. C'est aussi
   pourquoi le cadre d'import lui convient : il y a bien un état antérieur à
   prévisualiser — une liste se corrige, un libellé change, une géographie
   s'ajoute — là où une correspondance ne faisait que s'ajouter.

   Ce qui comptait vraiment dans ce pipeline — un compte rendu qui n'escamote
   rien — reste repris tel quel ici : sites introuvables listés ligne à ligne,
   codes devenus ambigus nommés, lignes invalides motivées.
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
async function siteAccessible(req, id){
  const s = await db.prepare("SELECT id, code, name, office_id, external_code FROM sites WHERE id=?").get(id);
  if(!s) return null;
  const bureau = await officeBound(req.user);
  if(bureau && s.office_id !== bureau) return null;
  return s;
}

/* ── Les codes d'un site ──────────────────────────────────────────────
   Le code par défaut y figure, sous la source réservée « fiche du site » : la
   liste servie est la liste COMPLÈTE, sans quoi l'écran devrait recoller deux
   provenances et finirait par en oublier une. */
r.get("/sites/:id/aliases", async (req, res) => {
  const s = await siteAccessible(req, req.params.id);
  if(!s) return res.status(404).json({ error: "site introuvable" });
  res.json({ site: { id: s.id, code: s.code, name: s.name },
    defaut: s.external_code || null, sourceDefaut: SOURCE_FICHE,
    rows: await listerAlias(s.id) });
});

r.post("/sites/:id/aliases", requireCap("edit"), async (req, res) => {
  const p = z.object({
    code: z.string().min(1).max(80),
    source: z.string().max(120).nullish(),
    note: z.string().max(300).nullish(),
  }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error: "code externe invalide" });
  const s = await siteAccessible(req, req.params.id);
  if(!s) return res.status(404).json({ error: "site introuvable" });
  /* La source réservée est refusée en saisie libre : elle appartient au miroir
     de la fiche, et une ligne posée à la main sous ce nom serait effacée à la
     première modification du code par défaut — sans que personne comprenne. */
  if((p.data.source || "").trim() === SOURCE_FICHE)
    return res.status(422).json({ error:
      `« ${SOURCE_FICHE} » désigne le code par défaut : modifiez-le sur la fiche du site.` });

  const { cree } = await ajouterAlias({ site_id: s.id, ...p.data });
  if(cree) await audit(req, "alias", s.id,
    `Code externe ajouté — ${s.name} : « ${p.data.code} »`
    + (p.data.source ? ` pour la source « ${p.data.source} »` : ""));
  res.status(cree ? 201 : 200).json({ cree, rows: await listerAlias(s.id) });
});

r.delete("/site-aliases/:aliasId", requireCap("edit"), async (req, res) => {
  const a = await db.prepare("SELECT * FROM site_external_code WHERE id=?").get(req.params.aliasId);
  if(!a) return res.status(404).json({ error: "code externe introuvable" });
  const s = await siteAccessible(req, a.site_id);
  if(!s) return res.status(404).json({ error: "code externe introuvable" });
  if(a.source === SOURCE_FICHE)
    return res.status(409).json({ error:
      "ce code est le code par défaut du site : videz-le sur la fiche du site, "
      + "pour que la fiche et la liste des codes ne se contredisent pas." });
  await supprimerAlias(a.id);
  await audit(req, "alias", s.id, `Code externe retiré — ${s.name} : « ${a.code} »`);
  res.json({ ok: true, rows: await listerAlias(s.id) });
});

/* ── Import d'une table de correspondance ─────────────────────────────
   Le droit exigé est « edit », le même que celui de la fiche de site qui porte
   le code par défaut : déclarer 1 251 codes d'un coup est le même acte que d'en
   déclarer un, fait en une fois. */
r.post("/site-aliases/import", requireCap("edit"), async (req, res) => {
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

  const bilan = await importerCorrespondances({ lignes,
    office_id: await officeBound(req.user), source: p.data.source });

  await audit(req, "import", null,
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
