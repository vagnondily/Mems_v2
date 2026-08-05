import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { newId } from "../lib/crypto.js";
import { can, requireSuper } from "../lib/auth.js";
import { TYPES, parCle, forme, ligne, ligneParCode, lignes, usage, totalUsage,
         validation, invalider } from "../lib/listes.js";
import { planRenommage, appliquerRenommage } from "../lib/renommage.js";

/* ═══════════════════════════════════════════════════════════════════════
   Gestionnaire de LISTES TYPÉES — maître-détail  (chantier S8, point 1)

   Une seule route pour onze listes. Le registre (`lib/listes.js`) dit où
   vit chacune et ce qui la référence ; cette route n'en connaît aucune en
   propre. C'est ce qui permet d'ajouter un type de liste sans écrire une
   ligne de serveur, et ce qui garantit que les onze se comportent pareil.

   Le patron est celui déjà livré pour les bureaux (`routes/offices.js`) et
   les activités (`routes/activities.js`), et il est repris tel quel :

     la LECTURE est ouverte à tout compte — l'application a besoin des
     libellés pour afficher un site, une distribution, un indicateur ;
     l'ÉCRITURE demande le droit d'administration ;
     la SUPPRESSION est refusée si l'item est référencé (409), avec le
     détail de ce qui le retient et la désactivation pour issue.
   ═══════════════════════════════════════════════════════════════════════ */

const r = Router();

const S = (max) => z.string().trim().max(max).optional().nullable()
  .transform(v => (v === "" ? null : v ?? null));

const corps = z.object({
  code:   z.string().trim().min(1).max(80),
  label:  z.string().trim().min(1).max(200),
  note:   S(600),
  ordre:  z.coerce.number().int().min(0).max(9999).default(0),
  active: z.boolean().default(true),
  champs: z.record(z.string().trim().max(200)).default({}),
  rev:    z.coerce.number().int().min(1).optional(),
});

/* Le droit exigé est DÉCLARÉ par le type, pas écrit dans la route : c'est le
   registre qui dit qu'une liste s'administre, et l'écran lit la même valeur
   pour montrer ou cacher ses boutons. Les deux ne peuvent donc pas diverger. */
const garde = (req, res, next) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  if(!can(req.user, def.cap)) return res.status(403).json({ error:`droit « ${def.cap} » requis` });
  next();
};

const audit = (req, cle, action, id, texte) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'plan',?,?,?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name,
         `listes:${cle}`, id, action, texte);

/* Les champs propres à un type (le domaine programme d'une activité, le type
   de partenariat d'un partenaire) sont eux-mêmes des CODES d'une autre
   liste. Les accepter sans contrôle rendrait le gestionnaire capable de
   fabriquer les orphelins qu'il est censé empêcher : un partenaire rattaché
   à un type de partenariat qui n'existe pas. */
async function champsValides(def, champs){
  const out = {}; const erreurs = [];
  for(const c of def.champs || []){
    const v = (champs[c.cle] ?? "").trim();
    if(!v){ out[c.colonne] = null; continue; }
    if(v.length > (c.max || 200)){
      erreurs.push({ champ:c.cle, message:`${c.label} : ${c.max || 200} caractères au plus` }); continue; }
    if(c.liste){
      const autre = parCle(c.liste);
      if(autre && !(await ligneParCode(autre, v)))
        erreurs.push({ champ:c.cle, message:`${c.label} : « ${v} » n'existe pas dans la liste « ${autre.label} »` });
    }
    out[c.colonne] = v;
  }
  return { colonnes:out, erreurs };
}

/* ── Le rail de gauche : les TYPES ───────────────────────────────────
   Ce que l'écran affiche avant d'avoir choisi une liste — son nom, ce
   qu'elle sert, combien d'items, et si elle a été relue. */
r.get("/", async (req, res) => {
  const types = [];
  for(const def of TYPES.filter(def => !def.hidden)){
    const rows = await lignes(def);
    types.push({
      cle: def.cle, label: def.label, description: def.description || "",
      items: rows.length,
      actifs: rows.filter(x => x[def.cols.active]).length,
      native: !def.type,
      validation: await validation(def),
    });
  }
  res.json({ types });
});

/* ── Le volet de droite : une liste ──────────────────────────────────
   Les items avec leur usage, et la DÉCLARATION du type : ses champs
   propres, et les tables qui le référencent. L'écran ne recopie donc
   aucune de ces deux listes — il les lit. */
r.get("/:cle", async (req, res) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  const rows = await lignes(def);
  const items = [];
  for(const x of rows) items.push(await forme(def, x));
  res.json({
    type: { cle:def.cle, label:def.label, description:def.description || "",
      native: !def.type, cap: def.cap,
      champs: (def.champs || []).map(c => ({ cle:c.cle, label:c.label, liste:c.liste || null })),
      liens: (def.liens || []).map(l => ({ table:l.table, colonne:l.colonne, par:l.par, label:l.label })) },
    validation: await validation(def),
    items,
  });
});

r.post("/:cle", garde, async (req, res, next) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  const p = corps.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"item invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;

  if(await ligneParCode(def, b.code))
    return res.status(409).json({ error:`le code « ${b.code} » est déjà pris dans cette liste` });
  if((await lignes(def)).some(x => (x[def.cols.label] || "").toLowerCase() === b.label.toLowerCase()))
    return res.status(409).json({ error:`le libellé « ${b.label} » est déjà pris dans cette liste` });

  const { colonnes, erreurs } = await champsValides(def, b.champs);
  if(erreurs.length) return res.status(422).json({ error:"champ invalide", details:erreurs });

  const cols = { ...colonnes,
    [def.cols.code]: b.code, [def.cols.label]: b.label, [def.cols.active]: b.active ? 1 : 0 };
  if(def.type) cols.type = def.type;
  if(def.cols.note)  cols[def.cols.note]  = b.note;
  if(def.cols.ordre) cols[def.cols.ordre] = b.ordre;

  const id = newId(def.prefixeId || "li");
  const keys = Object.keys(cols);
  try{
    await db.prepare(`INSERT INTO ${def.table} (id,${keys.join(",")})
                VALUES (?,${keys.map(() => "?").join(",")})`).run(id, ...keys.map(k => cols[k]));
  }catch(e){
    if(/unique|duplicate key/i.test(e.message)) return res.status(409).json({ error:"doublon : cet item existe déjà" });
    return next(e);
  }
  await invalider(def);
  await audit(req, def.cle, "create", id, `${def.label} — item créé : ${b.label} (${b.code})`);
  res.status(201).json({ item: await forme(def, await ligne(def, id)) });
});

r.put("/:cle/:id", garde, (req, res, next) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  const cur = ligne(def, req.params.id);
  if(!cur) return res.status(404).json({ error:"item introuvable" });
  const p = corps.safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"item invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const b = p.data;

  /* Verrouillage optimiste — même règle que les bureaux et les activités :
     on rend la valeur courante pour que l'écran montre ce qui a changé. */
  if(b.rev && b.rev !== (cur[def.cols.rev] || 1))
    return res.status(409).json({ error:"cet item a été modifié entre-temps", courant: forme(def, cur) });

  /* ── LE CODE D'IDENTIFICATION EST PRÉSERVÉ ────────────────────────
     « Possibilité de mettre à jour mais le code d'identification reste
     pour ne pas perdre les données. » Le code est la clé de jointure :
     `pdd.commodity`, `sites.activity_tag`, `sites.site_type` le portent en
     texte, sans contrainte de clé étrangère pour les retenir. Le changer
     ici laisserait toutes ces lignes désigner un code qui n'existe plus —
     silencieusement, et sans qu'aucune requête n'échoue.

     Le REFUS vaut mieux que l'ignorance polie : accepter la requête en
     écrivant tout SAUF le code laisserait croire au renommage. La réponse
     nomme donc la seule voie qui rende le geste sûr — le renommage en
     cascade, réservé au super-utilisateur. */
  if(b.code !== cur[def.cols.code]) return res.status(409).json({
    error: `le code d'identification ne se modifie pas ici : « ${cur[def.cols.code]} » est la clé `
      + "de jointure des données déjà saisies. Un super-utilisateur peut le renommer en cascade, "
      + "ce qui réécrit du même coup toutes les lignes qui le portent.",
    code: cur[def.cols.code], voie: `POST /api/listes/${def.cle}/${cur.id}/renommer-code` });

  if(lignes(def).some(x => x.id !== cur.id
      && (x[def.cols.label] || "").toLowerCase() === b.label.toLowerCase()))
    return res.status(409).json({ error:`le libellé « ${b.label} » est déjà pris dans cette liste` });

  const { colonnes, erreurs } = champsValides(def, b.champs);
  if(erreurs.length) return res.status(422).json({ error:"champ invalide", details:erreurs });

  const cols = { ...colonnes,
    [def.cols.label]: b.label, [def.cols.active]: b.active ? 1 : 0 };
  if(def.cols.note)    cols[def.cols.note]    = b.note;
  if(def.cols.ordre)   cols[def.cols.ordre]   = b.ordre;
  if(def.cols.updated) cols[def.cols.updated] = new Date().toISOString().slice(0, 19).replace("T", " ");

  const keys = Object.keys(cols);
  try{
    db.prepare(`UPDATE ${def.table} SET ${keys.map(k => k + "=?").join(",")},
                ${def.cols.rev}=${def.cols.rev}+1 WHERE id=?`).run(...keys.map(k => cols[k]), cur.id);
  }catch(e){
    if(/unique|duplicate key/i.test(e.message)) return res.status(409).json({ error:"doublon : cet item existe déjà" });
    return next(e);
  }

  const chg = [];
  if(b.label !== cur[def.cols.label]) chg.push(`renommé « ${cur[def.cols.label]} » → « ${b.label} »`);
  if(b.active !== !!cur[def.cols.active]) chg.push(b.active ? "réactivé" : "désactivé");
  invalider(def);
  audit(req, def.cle, "update", cur.id,
    `${def.label} — ${b.label}${chg.length ? ` : ${chg.join(", ")}` : " modifié"}`);
  res.json({ item: forme(def, ligne(def, cur.id)) });
});

/* ── Désactiver, l'issue que le refus de suppression propose ─────────
   Un geste à part, et non un PUT complet : l'écran qui reçoit un 409 n'a
   qu'une chose à faire — retirer l'item des choix sans toucher au reste.
   Lui faire renvoyer l'item entier pour cela, c'est lui donner l'occasion
   d'écraser un libellé ou un champ que quelqu'un vient de corriger. */
r.put("/:cle/:id/actif", garde, (req, res) => {
  const def = parCle(req.params.cle);
  const cur = ligne(def, req.params.id);
  if(!cur) return res.status(404).json({ error:"item introuvable" });
  const p = z.object({ active: z.boolean(),
                       rev: z.coerce.number().int().min(1).optional() }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"état invalide" });
  if(p.data.rev && p.data.rev !== (cur[def.cols.rev] || 1))
    return res.status(409).json({ error:"cet item a été modifié entre-temps", courant: forme(def, cur) });

  db.prepare(`UPDATE ${def.table} SET ${def.cols.active}=?, ${def.cols.rev}=${def.cols.rev}+1
              WHERE id=?`).run(p.data.active ? 1 : 0, cur.id);
  invalider(def);
  audit(req, def.cle, p.data.active ? "enable" : "disable", cur.id,
    `${def.label} — ${cur[def.cols.label]} ${p.data.active ? "réactivé" : "désactivé"}`);
  res.json({ item: forme(def, ligne(def, cur.id)) });
});

r.delete("/:cle/:id", garde, (req, res, next) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  const cur = ligne(def, req.params.id);
  if(!cur) return res.status(404).json({ error:"item introuvable" });

  /* « Si une liste est enregistrée et a été déjà utilisée, impossible de
     l'effacer (possibilité de mettre à jour mais le code d'identification
     reste pour ne pas perdre les données). » Le refus n'est pas une
     précaution générale : il énumère ce qui retient l'item, table par
     table, pour que la réponse soit une information et non un mur. */
  const u = usage(def, cur);
  if(totalUsage(u)) return res.status(409).json({
    error: `« ${cur[def.cols.label]} » est encore référencé ; désactivez-le plutôt que de le supprimer`,
    usage: u, usageTotal: totalUsage(u) });

  try{
    db.prepare(`DELETE FROM ${def.table} WHERE id=?`).run(cur.id);
  }catch(e){
    if(/foreign key/i.test(e.message)) return res.status(409).json({
      error:"cet item est référencé par une clé étrangère ; désactivez-le plutôt que de le supprimer" });
    return next(e);
  }
  invalider(def);
  audit(req, def.cle, "delete", cur.id, `${def.label} — item supprimé : ${cur[def.cols.label]}`);
  res.json({ ok:true });
});

/* ── Renommage de code EN CASCADE, réservé au super ──────────────────
   « Si le super user change un code d'identification, tout ce qui lui est
   relié devrait aussi changer avec. »

   C'est l'exception raisonnée à la règle du point 2 (le code ne bouge pas),
   et la seule façon sûre de le faire bouger : une transaction qui réécrit
   la table maîtresse ET toutes ses filles. Réservée au super-utilisateur,
   parce qu'elle touche en un geste des milliers de lignes de tables qu'il
   n'a pas sous les yeux — ce n'est pas de l'administration de contenu.

   `mode` est CONFIRMÉ par l'appelant, jamais deviné : demander « renommer »
   quand le code visé est déjà pris ne doit pas fusionner deux référentiels
   en silence. */
/* ① LE MAPPAGE — ce que l'opération fera, avant qu'elle ne fasse rien.
   « Si je fais une mise à jour d'un paramètre interconnecté, toujours
   procéder à un mappage puis validation pour ne pas perdre des données. »
   Cette route n'écrit RIEN : elle rend la correspondance ancien → nouveau,
   table par table, avec le nombre de lignes touchées et son empreinte. */
r.post("/:cle/:id/renommer-code/plan", requireSuper, (req, res) => {
  const p = z.object({ nouveau: z.string().trim().min(1).max(80) }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"nouveau code invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });
  const plan = planRenommage(req.params.cle, req.params.id, p.data.nouveau);
  if(plan.erreur) return res.status(plan.statut || 422).json({ error:plan.erreur });
  res.json({ plan });
});

/* ② LA VALIDATION — l'écriture, et elle exige le jeton du plan affiché.
   Le plan est RECALCULÉ ici : si la base a bougé entre l'affichage et le
   clic — une ligne de plus dans une table fille, un item créé qui
   transforme le renommage en fusion —, les deux empreintes diffèrent et
   rien ne s'écrit. Sans jeton, la réponse est le plan lui-même : le geste
   ne se refuse pas, il se demande deux fois. */
r.post("/:cle/:id/renommer-code", requireSuper, (req, res, next) => {
  const p = z.object({
    nouveau: z.string().trim().min(1).max(80),
    mode: z.enum(["renommer", "fusionner"]).optional(),
    jeton: z.string().trim().max(64).optional(),
  }).safeParse(req.body);
  if(!p.success) return res.status(422).json({ error:"renommage invalide",
    details: p.error.issues.map(i => ({ champ:i.path.join("."), message:i.message })) });

  const plan = planRenommage(req.params.cle, req.params.id, p.data.nouveau);
  if(plan.erreur) return res.status(plan.statut || 422).json({ error:plan.erreur });
  if(p.data.mode && p.data.mode !== plan.mode) return res.status(409).json({
    error: plan.mode === "fusionner"
      ? `le code « ${plan.nouveau} » est déjà porté par « ${plan.cible.label} » : ce serait une `
        + "FUSION, pas un renommage. Confirmez le mode « fusionner » — l'item d'origine "
        + "disparaîtra et tout ce qui le désignait sera reporté."
      : `le code « ${plan.nouveau} » n'existe pas dans cette liste : il n'y a rien à fusionner.`,
    plan });

  if(!p.data.jeton) return res.status(409).json({
    error: "un renommage de code se valide sur son plan : demandez la correspondance "
      + "(…/renommer-code/plan), examinez-la, puis renvoyez son jeton pour l'appliquer.",
    plan });
  if(p.data.jeton !== plan.jeton) return res.status(409).json({
    error: "la base a changé depuis le calcul de la correspondance : le plan que vous avez validé "
      + "n'est plus celui qui s'appliquerait. Rien n'a été écrit ; voici le plan à jour.",
    plan });

  try{
    const bilan = appliquerRenommage(req.params.cle, req.params.id, plan.nouveau);
    const def = parCle(req.params.cle);
    invalider(def);
    audit(req, def.cle, bilan.mode, req.params.id,
      `${def.label} — code ${bilan.mode === "fusionner" ? "fusionné" : "renommé"} `
      + `« ${bilan.ancien} » → « ${bilan.nouveau} » : ${bilan.total} ligne(s) réécrite(s) dans `
      + `${bilan.tables.length} table(s)`);
    res.json({ ok:true, ...bilan });
  }catch(e){
    if(/unique|duplicate key/i.test(e.message)) return res.status(409).json({
      error:"le nouveau code heurte une contrainte d'unicité ; rien n'a été écrit" });
    return next(e);
  }
});

/* ── Validation de la LISTE ──────────────────────────────────────────
   Le quatrième geste demandé. Il ne valide pas un formulaire — Zod le fait
   à chaque écriture — mais la liste elle-même : elle a été relue, elle est
   bonne, et cela se voit à l'écran. Toute écriture ultérieure sur un item
   efface la marque (`invalider`), sinon le badge survivrait à ce qu'il
   certifie. */
r.post("/:cle/valider", garde, (req, res) => {
  const def = parCle(req.params.cle);
  if(!def) return res.status(404).json({ error:"type de liste inconnu" });
  const p = z.object({ note: S(400) }).safeParse(req.body || {});
  if(!p.success) return res.status(422).json({ error:"note invalide" });
  const n = lignes(def).length;
  db.prepare(`INSERT INTO list_validation (type,validated_at,validated_by,user_label,items,note)
              VALUES (?,datetime('now'),?,?,?,?)
              ON CONFLICT(type) DO UPDATE SET validated_at=excluded.validated_at,
                validated_by=excluded.validated_by, user_label=excluded.user_label,
                items=excluded.items, note=excluded.note`)
    .run(def.cle, req.user.id, req.user.email || req.user.first_name, n, p.data.note);
  audit(req, def.cle, "validate", null, `${def.label} — liste validée (${n} item(s))`);
  res.json({ ok:true, validation: validation(def) });
});

export default r;
