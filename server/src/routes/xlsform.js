import { Router } from "express";
import multer from "multer";
import { requireCap } from "../lib/auth.js";
import { lireXlsFormBuffer } from "../lib/xlsform.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

const r = Router();

/* Le fichier n'est jamais écrit sur disque : on le lit, on en extrait la
   structure du formulaire, et le tampon est libéré. Il n'y a donc rien à
   nettoyer et aucune trace en cas d'incident — même choix que pour l'import
   des modèles Excel. La borne est plus basse que celle des imports : un
   XLSForm est un fichier de structure, pas un fichier de données. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(config.maxBodyMb, 8) * 1024 * 1024, files: 1 },
});

/* Lecture d'un XLSForm téléversé — ODK Central comme KoboToolbox, le format
   est le même.
 *
 * Cette route existe pour que le navigateur cesse de le faire lui-même : il
 * chargeait SheetJS (`xlsx`), qui porte deux failles connues sans correctif au
 * registre npm. Le serveur a déjà exceljs, dont MEMS se sert pour les modèles
 * d'import ; il n'y avait aucune raison d'embarquer un second lecteur de
 * classeurs dans le navigateur de chaque utilisateur. */
r.post("/xlsform/parse", requireCap("admin"), (req, res, next) => {
  upload.single("file")(req, res, async (err) => {
    if(err) return res.status(422).json({ error: err.message });
    if(!req.file) return res.status(422).json({ error: "aucun fichier reçu" });
    try{
      const { settings, vars, labels, choices } = await lireXlsFormBuffer(req.file.buffer);
      /* On ne renvoie pas les listes de choix en entier : un formulaire du
         bureau Madagascar en porte plus de mille par liste, ce qui ferait une
         réponse de plusieurs mégaoctets pour une fenêtre de configuration.
         Un échantillon suffit à montrer la FORME des identifiants, qui est la
         seule chose que l'écran a besoin de montrer. */
      const apercuChoix = {};
      for(const [liste, valeurs] of Object.entries(choices)){
        apercuChoix[liste] = { total: valeurs.length, exemples: valeurs.slice(0, 5) };
      }
      log.info("XLSForm lu", { fichier: req.file.originalname, variables: vars.length,
        libelles: Object.keys(labels).length, par: req.user.id });
      res.json({
        fichier: req.file.originalname,
        settings,
        /* Les lignes de structure sont marquées et non retirées : l'écran de
           correspondance peut vouloir les montrer grisées, mais aucune
           détection automatique ne doit les prendre pour des questions. */
        vars, labels, choices: apercuChoix,
      });
    }catch(e){
      res.status(422).json({ error: e.message });
    }
  });
});

export default r;
