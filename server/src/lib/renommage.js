import { createHash } from "node:crypto";
import { db, tx } from "../db.js";
import { parCle, ligne, ligneParCode, forme } from "./listes.js";

/* ═══════════════════════════════════════════════════════════════════════
   RENOMMAGE DE CODE EN CASCADE  (chantier S8, points 3 et 4)

   « Si le super user change un code d'identification, tout ce qui lui est
   relié devrait aussi changer avec. »

   Le point 2 du chantier a rendu le code IMMUABLE pour l'usage courant :
   c'est la clé de jointure, et dix colonnes la portent en texte sans
   qu'aucune contrainte ne les retienne. Ce fichier est l'exception
   raisonnée à cette règle — la seule façon sûre de changer un code.

   ── Ce n'est PAS un supprimer-recréer ────────────────────────────────
   Supprimer l'item puis le recréer sous un autre code laisserait, entre
   les deux, toutes les lignes filles orphelines — et si la seconde moitié
   échouait, elles le resteraient. Ici, TOUT se fait dans UNE transaction :
   la table maîtresse et chaque table fille sont réécrites ensemble, ou
   rien ne l'est.

   ── Deux modes, parce que la donnée réelle en a deux ─────────────────
     RENOMMER   le nouveau code est libre : l'item change de code, les
                lignes filles suivent.
     FUSIONNER  le nouveau code est DÉJÀ pris : les lignes filles sont
                reportées sur l'item existant, et l'item d'origine
                disparaît. C'est le cas « deux codes désignaient la même
                chose », qui n'a pas de solution propre sans cascade.

   Un renommage ne touche pas les colonnes qui recopient le LIBELLÉ (`nom`) :
   le libellé n'a pas changé. Une fusion, si — les lignes changent d'item,
   donc de nom.
   ═══════════════════════════════════════════════════════════════════════ */

/* Le plan : ce que l'opération FERA, chiffré ligne à ligne, avant toute
   écriture. Il est rendu à l'écran de correspondance (point 4) et sert de
   base au jeton de validation. */
export async function planRenommage(cle, id, nouveauBrut){
  const def = parCle(cle);
  if(!def) return { erreur:"type de liste inconnu", statut:404 };
  const item = await ligne(def, id);
  if(!item) return { erreur:"item introuvable", statut:404 };

  const ancien = item[def.cols.code] || "";
  const nouveau = String(nouveauBrut ?? "").trim();
  if(!nouveau) return { erreur:"le nouveau code est vide", statut:422 };
  if(nouveau.length > 80) return { erreur:"le nouveau code dépasse 80 caractères", statut:422 };
  if(nouveau === ancien) return { erreur:"le nouveau code est identique à l'ancien", statut:422 };

  /* Le code existe-t-il déjà dans CETTE liste ? Alors ce n'est pas un
     renommage, c'est une fusion — et elle ne se devine pas : l'écran doit
     la nommer, et l'utilisateur la valider en connaissance de cause. */
  const collision = await ligneParCode(def, nouveau);
  const fusion = !!collision && collision.id !== item.id;

  /* Ce qui sera réécrit. Un renommage touche les colonnes qui portent le
     CODE ; une fusion touche en plus les clés étrangères (les lignes
     changent d'item) et les colonnes qui recopient le libellé. */
  const lignesTouchees = [];
  for(const l of def.liens || []){
    if(l.par === "code"){
      const c = (await db.prepare(`SELECT COUNT(*) c FROM ${l.table} WHERE ${l.colonne}=?`).get(ancien)).c;
      if(c) lignesTouchees.push({ ...detailLien(l), lignes:c, de:ancien, vers:nouveau });
    } else if(fusion && l.par === "id"){
      const c = (await db.prepare(`SELECT COUNT(*) c FROM ${l.table} WHERE ${l.colonne}=?`).get(item.id)).c;
      if(c) lignesTouchees.push({ ...detailLien(l), lignes:c, de:item.id, vers:collision.id });
    } else if(fusion && l.par === "nom"){
      const de = item[def.cols.label], vers = collision[def.cols.label];
      if(de && de !== vers){
        const c = (await db.prepare(`SELECT COUNT(*) c FROM ${l.table} WHERE ${l.colonne}=?`).get(de)).c;
        if(c) lignesTouchees.push({ ...detailLien(l), lignes:c, de, vers });
      }
    }
  }

  const avertissements = [];
  if(fusion) avertissements.push(
    `« ${item[def.cols.label]} » (${ancien}) sera SUPPRIMÉ de la liste, et tout ce qui le désignait `
    + `sera reporté sur « ${collision[def.cols.label]} » (${nouveau}). L'opération n'est pas réversible.`);
  if(!lignesTouchees.length) avertissements.push(
    "Aucune ligne ne porte ce code aujourd'hui : seul l'item lui-même changera.");

  const plan = {
    cle: def.cle, listeLabel: def.label,
    item: await forme(def, item),
    mode: fusion ? "fusionner" : "renommer",
    ancien, nouveau,
    cible: fusion ? { id:collision.id, code:collision[def.cols.code],
                      label:collision[def.cols.label] } : null,
    /* La correspondance ancien → nouveau, table par table : c'est
       exactement l'écran de mappage demandé au point 4. */
    correspondances: lignesTouchees,
    total: lignesTouchees.reduce((a, x) => a + x.lignes, 0),
    avertissements,
  };
  plan.jeton = jetonDe(plan);
  return plan;
}

const detailLien = (l) => ({ table:l.table, colonne:l.colonne, par:l.par, label:l.label });

/* ── Le jeton du plan  (chantier S8, point 4) ─────────────────────────
   « Si je fais une mise à jour d'un paramètre interconnecté, toujours
   procéder à un mappage puis validation pour ne pas perdre des données. »

   Le jeton est l'EMPREINTE de ce qui a été montré : le mode, les deux
   codes, et le nombre de lignes touchées dans chaque table. Il repart avec
   la validation, et la route recalcule le plan avant d'écrire : si quoi que
   ce soit a bougé entre l'affichage et le clic — une ligne ajoutée dans une
   table fille, un item créé qui transforme le renommage en fusion —, les
   deux empreintes diffèrent et l'écriture est refusée.

   Ce n'est pas un secret et il n'a pas à en être un : il ne protège de rien
   qu'on veuille cacher, il prouve que la validation porte bien sur ce que
   l'écran a montré. D'où une empreinte lisible, vérifiable par recalcul,
   sans état stocké nulle part — un plan mémorisé côté serveur aurait
   introduit une durée de vie, donc une expiration à gérer et un plan à
   nettoyer. */
export function jetonDe(plan){
  const canon = JSON.stringify([plan.cle, plan.item?.id, plan.ancien, plan.nouveau, plan.mode,
    plan.cible?.id || null,
    plan.correspondances.map(c => [c.table, c.colonne, c.par, c.lignes, c.de, c.vers])]);
  return createHash("sha256").update(canon).digest("hex").slice(0, 32);
}

/* L'application. Une transaction : la table maîtresse et toutes ses filles,
   ou rien. La route recalcule le plan juste avant d'appeler cette fonction,
   pour vérifier qu'il n'a pas bougé entre l'affichage et la validation. */
export async function appliquerRenommage(cle, id, nouveau){
  const def = parCle(cle);
  const item = await ligne(def, id);
  const ancien = item[def.cols.code];
  const cible = await ligneParCode(def, nouveau);
  const fusion = !!cible && cible.id !== item.id;

  const ecrites = [];
  await tx(async (db) => {
    for(const l of def.liens || []){
      let stmt = null, args = null;
      if(l.par === "code"){
        stmt = db.prepare(`UPDATE ${l.table} SET ${l.colonne}=? WHERE ${l.colonne}=?`);
        args = [nouveau, ancien];
      } else if(fusion && l.par === "id"){
        stmt = db.prepare(`UPDATE ${l.table} SET ${l.colonne}=? WHERE ${l.colonne}=?`);
        args = [cible.id, item.id];
      } else if(fusion && l.par === "nom"){
        const de = item[def.cols.label], vers = cible[def.cols.label];
        if(de && de !== vers){
          stmt = db.prepare(`UPDATE ${l.table} SET ${l.colonne}=? WHERE ${l.colonne}=?`);
          args = [vers, de];
        }
      }
      if(!stmt) continue;
      const n = (await stmt.run(...args)).changes;
      if(n) ecrites.push({ ...detailLien(l), lignes:n });
    }

    if(fusion){
      /* L'item d'origine n'a plus rien qui le désigne — la boucle vient de
         tout reporter. Le supprimer maintenant est sûr, et c'est le sens
         même de la fusion : deux codes n'en font plus qu'un. */
      await db.prepare(`DELETE FROM ${def.table} WHERE id=?`).run(item.id);
    } else {
      await db.prepare(`UPDATE ${def.table} SET ${def.cols.code}=?, ${def.cols.rev}=${def.cols.rev}+1
                  WHERE id=?`).run(nouveau, item.id);
    }
  });

  const restant = fusion ? await ligne(def, cible.id) : await ligne(def, item.id);
  let reliquat = 0;
  for(const l of (def.liens || []).filter(l => l.par === "code"))
    reliquat += (await db.prepare(`SELECT COUNT(*) c FROM ${l.table} WHERE ${l.colonne}=?`).get(ancien)).c;

  return {
    mode: fusion ? "fusionner" : "renommer", ancien, nouveau,
    tables: ecrites, total: ecrites.reduce((a, x) => a + x.lignes, 0),
    item: restant ? await forme(def, restant) : null,
    /* Contrôle d'après-coup, rendu au client : plus aucune ligne ne doit
       porter l'ancien code. C'est la vérification que l'appelant ne peut pas
       faire lui-même, et la seule preuve que la cascade a été complète. */
    reliquat,
  };
}
