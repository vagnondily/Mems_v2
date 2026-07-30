import { AsyncLocalStorage } from "node:async_hooks";

/* ═══════════════════════════════════════════════════════════════════════
   Contexte de la requête en cours.

   Une instance sert plusieurs pays. Le référentiel géographique, le vocabulaire
   des niveaux et la devise locale dépendent donc du pays de l'appelant — et
   `currentVersion()` est appelé depuis dix-huit endroits, dont plusieurs
   bibliothèques qui n'ont aucune raison de connaître une requête HTTP.

   La tentation est une variable de module : « le pays courant », posée par un
   middleware et lue partout. Elle serait FAUSSE, et de la pire manière — celle
   qui ne se voit qu'en production. Les gestionnaires de route ne sont pas tous
   synchrones : dès qu'il y a un `await` (le hachage d'un mot de passe, la lecture
   d'un fichier téléversé), Node reprend une autre requête entre-temps. Une
   variable de module partagée renverrait alors le pays du voisin, et l'utilisateur
   verrait la géographie d'un autre pays sans que rien ne le signale.

   `AsyncLocalStorage` est l'outil fait pour cela : le contexte suit la chaîne
   asynchrone d'une requête et n'est jamais visible d'une autre. C'est un module
   du cœur de Node — aucune dépendance ajoutée.
   ═══════════════════════════════════════════════════════════════════════ */

const store = new AsyncLocalStorage();

export const runWithCtx = (value, fn) => store.run(value, fn);

/* Hors requête — script en ligne de commande, amorçage, tâche de fond — le
   contexte est vide, et les appelants retombent sur le pays par défaut de
   l'instance. C'est le comportement voulu : un script n'a pas d'utilisateur. */
export const ctx = () => store.getStore() || {};

export const ctxCountry = () => ctx().country || null;
export const ctxUser = () => ctx().user || null;

/* Le pays qui filtre les données de la requête, ou null pour « tous les pays ».
   Distinct de `ctxCountry`, qui est toujours renseigné parce qu'il fournit le
   vocabulaire : un administrateur d'instance lit les libellés de Madagascar tout en
   voyant les bureaux des trois pays. Voir la mise en place dans index.js. */
export const ctxCountryFilter = () => ctx().countryFilter || null;
