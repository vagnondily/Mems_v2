# MEMS — Revue de sécurité de l'application web

Revue menée sur l'ensemble serveur + client, du point de vue « fuite de données »
et « prise de contrôle ». Verdict global : **posture solide, aucune vulnérabilité
critique trouvée**. Les points ci-dessous distinguent ce qui est déjà en place, le
seul bug corrigé pendant la revue, et des durcissements recommandés (défense en
profondeur, non bloquants).

## 1. Ce qui est déjà bien en place

| Domaine | État | Où |
|---|---|---|
| **Mots de passe** | bcrypt (jamais en clair, jamais loggés) | `lib/auth.js` |
| **Anti-force brute** | verrouillage de compte après N échecs, fenêtre temporisée | `routes/auth.js` |
| **Session** | JWT en cookie **httpOnly + sameSite=lax + secure** (prod) → le token n'est pas lisible par du JavaScript, donc pas volable par XSS | `routes/auth.js`, `lib/auth.js` |
| **Secret JWT** | ≥ 32 caractères **exigés en production** (le serveur refuse de démarrer sinon) | `config.js` |
| **CSP** | `script-src 'self'` (ni `unsafe-eval` ni `unsafe-inline` pour les scripts), `object-src 'none'`, `base-uri 'self'`, images tierces limitées à une liste d'hôtes de tuiles | `index.js` (helmet) |
| **CORS** | liste blanche d'origines en production ; pas de joker | `index.js` |
| **Débit** | limiteur global sur `/api` | `index.js` |
| **Injection SQL** | requêtes **paramétrées** partout ; les noms de colonnes viennent d'un schéma fixe, jamais de l'entrée utilisateur | `db.js`, `routes/collections.js` |
| **Autorisation (rôles)** | tranchée **côté serveur** (`requireCap`, `requireSuper`) ; un écran ne protège rien | `lib/auth.js` |
| **Cloisonnement par bureau** | à la lecture ET à l'écriture : un compte cloisonné ne peut ni lire ni modifier/supprimer la ligne d'un autre bureau (renvoie 403) | `routes/collections.js`, `lib/scope.js` |
| **Évaluation de formules** | analyseur maison sans `eval`/`new Function`, liste blanche de variables et de fonctions, accès aux propriétés interdit — compatible CSP | `web/src/lib/calc.js` |
| **Erreurs** | aucun détail interne ne remonte au client | `index.js` |

## 2. Vérification vivante de la séparation des rôles

Test exécuté contre une instance réelle (création d'un compte par rôle, puis
appels d'API) :

| Rôle | `GET /state` | `PUT` (éditer) | `DELETE` |
|---|:--:|:--:|:--:|
| viewer | 200 | **403** | **403** |
| editor | 200 | 200 | **403** |
| validator | 200 | 200 | **403** |

Conforme à la matrice attendue : lecture ouverte, écriture réservée aux rôles
qui en portent la capacité, suppression au seul droit `del`. Pas d'élévation de
privilège. La suite `server/test/api.test.js` (287 tests) couvre en plus la
concurrence (verrouillage optimiste), le cloisonnement à l'écriture et les
refus de droits.

## 3. Bug corrigé pendant la revue

- **Indicateurs sans niveau de cadre de résultats** : les indicateurs amorcés
  n'avaient pas de `level`, donc n'apparaissaient sous aucun onglet de la
  masterlist (l'écran filtre par niveau). Sans impact de sécurité, mais c'était
  une donnée « invisible » côté gestion. Corrigé à l'amorçage (output pour les
  indicateurs de service/traitement, outcome pour le reste).
- **Écriture `null` sur colonne `NOT NULL`** (repéré et corrigé plus tôt dans la
  même session) : un champ optionnel absent devenait `null` et faisait échouer
  l'`UPDATE` en 500. Corrigé en n'écrivant le champ que s'il est non nul.

## 4. Durcissements recommandés (non bloquants, défense en profondeur)

1. **Limiteur dédié à la connexion** — en plus du verrouillage par compte, poser
   un `express-rate-limit` par IP spécifiquement sur `POST /api/auth/login`
   (p. ex. 10/min) freinerait le *credential stuffing* réparti sur plusieurs
   comptes. Non ajouté ici pour ne pas fausser la suite de tests (nombreuses
   connexions depuis la même IP) ; à activer en production avec un seuil adapté.
2. **En-tête HSTS** — si l'instance est servie derrière TLS (recommandé), activer
   `Strict-Transport-Security` (helmet `hsts`) pour interdire la rétrogradation
   HTTP.
3. **Rotation du secret JWT** — prévoir une procédure de rotation (le `jti`
   présent dans le token ouvre déjà la voie à une révocation ciblée).
4. **Journalisation d'audit des accès refusés** — les 403/423 pourraient être
   consignés au registre pour détecter une tentative d'intrusion, en plus des
   actions réussies déjà tracées.
5. **Politique de mot de passe** — la longueur minimale (12) est bonne ; on peut
   y ajouter un contrôle contre les mots de passe les plus courants.

Aucun de ces points n'est une faille : ce sont des couches supplémentaires.
