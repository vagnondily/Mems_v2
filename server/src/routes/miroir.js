import { Router } from "express";
import { requireSuper } from "../lib/auth.js";
import { newId } from "../lib/crypto.js";
import { db } from "../db.js";
import { etatMiroir, activerMiroir, desactiverMiroir } from "../lib/miroir.js";

/* ═══════════════════════════════════════════════════════════════════════
   Le MIROIR (mode test), côté API.

   Gérer le miroir — le créer, le rafraîchir, le fermer — est un geste
   d'administration de l'INSTALLATION, pas du contenu : il clone toute la
   production, il écrit du DDL. Réservé au super-utilisateur, comme la
   restauration d'une sauvegarde.

   Lire son ÉTAT, en revanche, est ouvert à tout compte : c'est ce qui permet à
   l'interface de savoir s'il faut proposer la bascule « mode test » et d'afficher
   la date de l'instantané. Ce routeur est monté SANS le middleware de routage
   vers le schéma test : l'administration du miroir se fait toujours sur la
   production (voir lib/miroir.js). ═══════════════════════════════════════════ */

const r = Router();

const audit = (req, action, text) =>
  db.prepare(`INSERT INTO audit (id,user_id,user_label,kind,entity,entity_id,action,text)
              VALUES (?,?,?,'admin','miroir','miroir',?,?)`)
    .run(newId("aud"), req.user.id, req.user.email || req.user.first_name, action, text);

r.get("/", async (req, res) => res.json(await etatMiroir()));

r.post("/activer", requireSuper, async (req, res) => {
  const etat = await activerMiroir({ par: req.user.email || req.user.first_name });
  await audit(req, "activer",
    `Mode test activé — instantané de la production cloné dans le schéma test `
    + `(${etat.tables} tables, ${etat.lignes?.sites ?? 0} sites)`);
  res.json(etat);
});

/* Rafraîchir = reprendre un instantané neuf : on rejette le bac à sable et on
   reclone. Le même geste que « activer », nommé pour ce qu'il fait quand un
   miroir existe déjà. */
r.post("/rafraichir", requireSuper, async (req, res) => {
  const etat = await activerMiroir({ par: req.user.email || req.user.first_name });
  await audit(req, "rafraichir",
    `Mode test rafraîchi — nouvel instantané de la production (${etat.tables} tables)`);
  res.json(etat);
});

r.post("/desactiver", requireSuper, async (req, res) => {
  const etat = await desactiverMiroir();
  await audit(req, "desactiver", "Mode test fermé — bac à sable supprimé, production intacte");
  res.json(etat);
});

export default r;
