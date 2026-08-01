/* ═══════════════════════════════════════════════════════════════════════
   Rattachement d'une soumission à un site — le résolveur.

   Demande du propriétaire du produit, mot pour mot : « Et si 01 sites existe
   sur les bases de données alors on note qu'il a été suivi, lier par site name,
   activité, date je crois. »

   Le rattachement par NOM DE SITE croisé avec l'ACTIVITÉ est donc explicitement
   demandé, et c'est la troisième passe ci-dessous. Il vient en troisième parce
   qu'un nom n'identifie rien à lui seul : le dépôt contient déjà des sites
   homonymes dans deux districts, et « deux communes portent le même nom » est
   un constat écrit dans lib/champs.js. Un code, quand il y en a un, tranche ;
   le nom ne fait que départager.

   ── Ce que ce fichier refuse de faire ────────────────────────────────
   Il ne devine jamais en silence. Trois conséquences, toutes assumées :

   1. Deux candidats égaux ne se départagent pas au hasard. Sept codes `DPName`
      de GD_PREVMA désignent deux points de distribution différents — le XLSForm
      l'autorise explicitement (`allow_choice_duplicates='yes'`). Tirer l'un des
      deux donnerait une base fausse et silencieuse ; on rend « non résolu », et
      la passe suivante a sa chance de trancher sur un autre critère.

   2. Une soumission non résolue reste une soumission. Elle entre en base avec
      `site_id` à NULL et le motif de son échec, elle ne disparaît pas.

   3. Chaque conclusion porte sa passe, son motif en français et un indice de
      confiance. L'indice ne sert pas à trier automatiquement : il sert à ce
      qu'un humain sache lesquelles relire d'abord.

   ── Pourquoi un index en mémoire plutôt que des requêtes ─────────────
   La comparaison de noms se fait sans accents, sans casse et sans ponctuation.
   SQLite ne sait pas normaliser les accents sans extension, et une collation
   maison serait une seconde règle de normalisation à maintenir à côté de
   celle-ci. Un tirage ODK verse jusqu'à 20 000 soumissions d'un coup : l'index
   est construit UNE fois pour tout le lot, et non par ligne.
   ═══════════════════════════════════════════════════════════════════════ */

import { db } from "../db.js";
import { TRANSFORMATIONS } from "./mapping.js";

/* La normalisation d'un code est déjà écrite, testée et documentée dans le jeu
   fermé des transformations : « mg 232 09050001 » et « MG23209050001 » y sont
   déjà le même code. La réécrire ici garantirait qu'un jour les deux versions
   diffèrent — et un code normalisé de deux façons ne se rapproche plus. */
export const normaliserCode = TRANSFORMATIONS.pcode.fn;

/* Un nom de site comparable : sans accents, sans casse, sans ponctuation.
   « EPP Ambovombe-Centre », « E.P.P. AMBOVOMBE CENTRE » et « Epp  Ambovombé
   centre » deviennent la même clé. La ponctuation devient une espace plutôt que
   rien : sinon « EPP-Centre » et « EPPCentre » se confondraient avec un nom
   réellement écrit en un mot. */
export function normaliserNom(v){
  if(v === null || v === undefined) return null;
  const s = String(v)
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return s === "" ? null : s;
}

/* L'activité est un code court (URT, SMP, NTA…) : casse et espaces de bord
   seulement. Pas de retrait de ponctuation — « URT_GD » et « URTGD » sont deux
   codes distincts dans le dépôt (voir seed.js), les confondre serait faux. */
export function normaliserActivite(v){
  if(v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase();
  return s === "" ? null : s;
}

/* En deçà de huit caractères, un préfixe de p-code ne désigne plus une localité
   mais une région entière : « MG23 » couvre l'Androy. Chercher aussi court
   rattacherait n'importe quelle soumission à n'importe quel site du Sud dès
   qu'un seul site y est enregistré. La borne est ici, pas dans le résolveur,
   pour qu'elle soit visible et modifiable en un seul endroit. */
export const PREFIXE_MIN = 8;

/* Les quatre passes et leur indice de confiance.

   Un code externe exact vaut 1 : c'est une égalité, pas une ressemblance.
   Un préfixe p-code vaut 0,7 : il dit « le seul site de ce fokontany », ce qui
   est vrai aujourd'hui et peut cesser de l'être au prochain site créé.
   Le nom croisé avec l'activité vaut 0,6 : deux critères concordants, mais tous
   deux saisis à la main, donc sujets à l'orthographe.
   Le même nom appuyé en plus par le fokontany vaut 0,8 : deux preuves
   indépendantes qui concordent valent mieux que la meilleure des deux.
   Le nom seul vaut 0,4 : c'est le minimum acceptable, et seulement quand la
   soumission ne porte AUCUNE activité — jamais pour passer outre une activité
   qui ne correspond pas. */
export const CONFIANCE = {
  code_externe: 1,
  pcode_adm4:   0.7,
  nom_activite: 0.6,
  nom_pcode:    0.8,
  nom_seul:     0.4,
};

/* La passe qu'aucune des quatre autres ne peut produire : celle d'un humain qui
   a désigné le site lui-même. Elle est nommée ici, à côté des passes
   automatiques, parce que c'est ici qu'on décide de ne jamais l'écraser — voir
   `rejouerRattachement` plus bas et l'upsert de lib/soumissions.js. Une
   constante partagée plutôt que la chaîne « manuel » recopiée en quatre
   endroits : le jour où l'un des quatre l'écrirait autrement, la protection
   sauterait sans que rien ne le signale. */
export const PASSE_MANUELLE = "manuel";

/* ── L'index ──────────────────────────────────────────────────────────
   Construit une fois par lot. `office_id` restreint le référentiel au bureau
   qui ingère : un bureau ne doit pas rattacher ses soumissions aux sites d'un
   autre, même par homonymie — c'est la même règle de cloisonnement que partout
   ailleurs (lib/scope.js), appliquée ici au rapprochement lui-même. */
export function construireIndex({ office_id = null } = {}){
  const sites = db.prepare(`SELECT id, code, external_code, name, geo_pcode, activity_tag, office_id
                            FROM sites ${office_id ? "WHERE office_id = ?" : ""}`)
    .all(...(office_id ? [office_id] : []));

  const parCode = new Map();
  const parPcode = new Map();
  const parNomActivite = new Map();
  const parNom = new Map();
  const parId = new Map();
  const pousser = (map, cle, id) => {
    if(!cle) return;
    const l = map.get(cle);
    if(l){ if(!l.includes(id)) l.push(id); } else map.set(cle, [id]);
  };

  /* D'où vient le code qui a permis le rapprochement, pour chaque paire
     (code, site). Un rattachement par alias et un rattachement par la colonne de
     la fiche se ressemblent dans la base — même passe, même confiance — et ne se
     ressemblent pas du tout pour qui doit les relire : le premier vient d'une
     table de correspondance importée, que quelqu'un peut avoir chargée de
     travers. Le motif doit donc pouvoir le nommer.
     La première origine notée l'emporte : l'ordre de remplissage ci-dessous est
     une décision, la fiche du site avant ses alias. */
  const origines = new Map();
  const noterOrigine = (code, siteId, libelle) => {
    if(!code) return;
    const c = `${code} ${siteId}`;
    if(!origines.has(c)) origines.set(c, libelle);
  };

  for(const s of sites){
    parId.set(s.id, s);
    /* Les deux codes entrent dans le même index : le code externe (celui des
       XLSForms) et le code métier MEMS. Ils ne peuvent pas se confondre — l'un
       est « L0001 », l'autre « MG23210070009001 » — et un formulaire qui
       porterait le code MEMS doit se rattacher aussi bien. */
    const externe = normaliserCode(s.external_code);
    pousser(parCode, externe, s.id);
    noterOrigine(externe, s.id, "code externe par défaut de la fiche du site");
    const interne = normaliserCode(s.code);
    pousser(parCode, interne, s.id);
    noterOrigine(interne, s.id, "code MEMS du site");
    pousser(parPcode, normaliserCode(s.geo_pcode), s.id);
    const nom = normaliserNom(s.name);
    pousser(parNom, nom, s.id);
    const act = normaliserActivite(s.activity_tag);
    if(nom && act) pousser(parNomActivite, `${nom} ${act}`, s.id);
  }
  /* ── Les alias, à égalité avec la colonne ──────────────────────────
     Un site porte autant de codes que de sources qui le désignent (migration
     018). Ils entrent dans le MÊME index que le code par défaut : une égalité de
     codes est une égalité de codes, quelle que soit la table où le code est
     écrit. Les traiter en seconde passe reviendrait à dire qu'un code SMP vaut
     moins qu'un code GD_PREVMA, ce qui n'a aucun sens sur le terrain.

     Deux sites portant le même code restent non résolus exactement comme avant :
     `pousser` empile les deux candidats, et la passe (a) refuse de trancher. */
  const alias = db.prepare(`SELECT a.site_id, a.code, a.source
                            FROM site_external_code a JOIN sites s ON s.id = a.site_id
                            ${office_id ? "WHERE s.office_id = ?" : ""}`)
    .all(...(office_id ? [office_id] : []));
  for(const a of alias){
    /* Le site peut être hors du référentiel indexé (autre bureau) : son alias
       n'a alors rien à désigner ici, et l'ajouter ferait entrer un candidat
       qu'aucune passe ne saurait ensuite nommer. */
    if(!parId.has(a.site_id)) continue;
    const c = normaliserCode(a.code);
    pousser(parCode, c, a.site_id);
    noterOrigine(c, a.site_id, a.source
      ? `correspondance déclarée pour la source « ${a.source} »`
      : "correspondance déclarée sans source");
  }

  return { parCode, parPcode, parNomActivite, parNom, parId, origines,
           taille: sites.length, alias: alias.length };
}

/* Le plus long préfixe du code qui désigne réellement une unité portée par au
   moins un site. On part du code entier et on raccourcit : le rattachement le
   plus précis l'emporte, et un code de 13 caractères qui EST un p-code de
   fokontany se rapproche donc directement, sans traitement particulier.

   Aucune longueur n'est écrite en dur — ni 13, ni 16. Les quatre XLSForms en
   utilisent quatre différentes, et un cinquième formulaire en apporterait une
   cinquième ; ce qui fait foi est ce que le référentiel de sites contient. */
function prefixePcode(code, pcodeDeclare, index){
  const direct = normaliserCode(pcodeDeclare);
  if(direct && index.parPcode.has(direct))
    return { pcode: direct, sites: index.parPcode.get(direct), declare: true };
  if(!code) return { pcode: null, sites: [], declare: false };
  for(let n = code.length; n >= PREFIXE_MIN; n--){
    const p = code.slice(0, n);
    const s = index.parPcode.get(p);
    if(s && s.length) return { pcode: p, sites: s, declare: false };
  }
  return { pcode: null, sites: [], declare: false };
}

const nommer = (ids, index) => ids
  .map(id => `« ${index.parId.get(id)?.name || id} » (${index.parId.get(id)?.code || id})`)
  .join(" et ");

/* ── Le résolveur ─────────────────────────────────────────────────────
   `entree` : { site_code_raw, site_name_raw, activity_tag, geo_pcode }.
   Rend { site_id, passe, confiance, motif, candidats }.

   `motif` n'est JAMAIS vide, y compris en cas de succès : une ligne rattachée
   sans dire comment est une ligne qu'on ne peut plus contester six mois plus
   tard, quand la personne qui a lancé l'ingestion n'est plus là.

   `sujet` nomme ce qui est rapproché. Le résolveur sert aussi le rapprochement
   d'un référentiel de codes (lib/codes.js), où l'opérateur regarde les lignes de
   son tableur : lui écrire « la soumission ne porte aucun nom de site » le
   renvoie à un objet qu'il n'a jamais manipulé. Un mot paramétré vaut mieux
   qu'une seconde rédaction des motifs, qui divergerait au premier ajout. */
export function resoudre(entree, index, { sujet = "la soumission" } = {}){
  const idx = index || construireIndex();
  const code = normaliserCode(entree?.site_code_raw);
  const nom  = normaliserNom(entree?.site_name_raw);
  const act  = normaliserActivite(entree?.activity_tag);
  const notes = [];
  const conclure = (id, passe, motif, confiance) =>
    ({ site_id: id, passe, confiance: confiance ?? CONFIANCE[passe], motif, candidats: [] });

  /* ── (a) Code externe exact ─────────────────────────────────────────
     Une égalité de codes est la seule preuve d'identité disponible. Quand elle
     désigne deux sites, elle ne prouve plus rien : les candidats sont retenus
     pour que les passes suivantes puissent trancher ENTRE EUX, et non ailleurs.
     C'est le seul cas où une passe restreint les suivantes — un même code, ce
     sont deux prétendants à la même identité ; un même fokontany, ce sont
     simplement des voisins. */
  const candidatsCode = code ? (idx.parCode.get(code) || []) : [];
  let restreint = null;
  if(!code) notes.push(`${sujet} ne porte aucun code de site`);
  else if(candidatsCode.length === 1){
    /* Par QUEL code le site a été reconnu : la colonne de sa fiche, son code
       MEMS, ou l'un de ses alias — et pour quelle source dans ce dernier cas.
       Sans cette mention, deux rattachements indiscernables dans la base
       auraient deux origines très différentes, dont une importée en masse. */
    const via = idx.origines?.get(`${code} ${candidatsCode[0]}`);
    return conclure(candidatsCode[0], "code_externe",
      `code externe « ${code} » rapproché à l'identique du site ${nommer(candidatsCode, idx)}`
      + (via ? ` — ${via}` : ""));
  }
  else if(candidatsCode.length === 0)
    notes.push(`aucun site ne porte le code externe « ${code} »`);
  else {
    restreint = candidatsCode;
    notes.push(`le code « ${code} » désigne ${candidatsCode.length} sites — ${nommer(candidatsCode, idx)} — `
      + "et ne peut donc pas identifier à lui seul");
  }

  const dansRestreint = (ids) => (restreint ? ids.filter(id => restreint.includes(id)) : ids);

  /* ── (b) Préfixe p-code adm4 ────────────────────────────────────────
     Le code des formulaires MDG est un p-code, éventuellement suivi d'un numéro
     d'ordre : son préfixe désigne le fokontany. Concluante seulement si ce
     fokontany ne porte qu'un site — sinon on sait où, pas lequel. */
  const pre = prefixePcode(code, entree?.geo_pcode, idx);
  const candidatsPcode = pre.pcode ? dansRestreint(pre.sites) : [];
  if(!pre.pcode)
    notes.push(code
      ? `aucun préfixe du code « ${code} » (au moins ${PREFIXE_MIN} caractères) ne correspond `
        + "au p-code d'un site connu"
      : `aucun p-code exploitable dans ${sujet}`);
  else if(candidatsPcode.length === 1)
    return conclure(candidatsPcode[0], "pcode_adm4",
      `p-code « ${pre.pcode} »${pre.declare ? ` déclaré dans ${sujet}` : " tiré du préfixe du code de site"}`
      + `, seul site rattaché à cette unité : ${nommer(candidatsPcode, idx)}`);
  else if(candidatsPcode.length === 0)
    notes.push(`le p-code « ${pre.pcode} » ne recoupe aucun des sites encore en lice`);
  else
    notes.push(`le p-code « ${pre.pcode} » porte ${candidatsPcode.length} sites : il situe ${sujet} `
      + "sans l'identifier");

  /* ── (c) Nom de site croisé avec l'activité ─────────────────────────
     La passe demandée explicitement. Quand elle rend plusieurs sites — des
     homonymes suivis pour la même activité dans deux districts — le p-code de
     la passe (b) les départage : deux preuves indépendantes qui concordent
     valent mieux que la meilleure des deux. */
  if(nom && act){
    const paire = dansRestreint(idx.parNomActivite.get(`${nom} ${act}`) || []);
    if(paire.length === 1)
      return conclure(paire[0], "nom_activite",
        `nom de site « ${entree.site_name_raw} » croisé avec l'activité « ${act} » : `
        + `un seul site correspond, ${nommer(paire, idx)}`);
    if(paire.length > 1){
      const croise = candidatsPcode.length ? paire.filter(id => candidatsPcode.includes(id)) : [];
      if(croise.length === 1)
        return conclure(croise[0], "nom_pcode",
          `nom « ${entree.site_name_raw} » et activité « ${act} » partagés par ${paire.length} sites, `
          + `départagés par le p-code « ${pre.pcode} » : ${nommer(croise, idx)}`,
          CONFIANCE.nom_pcode);
      notes.push(`${paire.length} sites portent le nom « ${entree.site_name_raw} » pour l'activité `
        + `« ${act} » — ${nommer(paire, idx)} — et rien ne les départage`);
    } else {
      /* Le nom existe, mais sous une autre activité. On ne passe PAS outre :
         c'est le cas typique d'une école suivie au titre des cantines et d'un
         point de distribution homonyme suivi au titre des transferts. Le dire
         est utile ; le rattacher quand même serait une erreur silencieuse. */
      const ailleurs = dansRestreint(idx.parNom.get(nom) || []);
      notes.push(ailleurs.length
        ? `le nom « ${entree.site_name_raw} » existe dans le référentiel mais sous une autre `
          + `activité que « ${act} » (${nommer(ailleurs, idx)}) : rattachement refusé`
        : `aucun site ne porte le nom « ${entree.site_name_raw} »`);
    }
  } else if(nom && !act){
    /* ── (c bis) Nom seul, faute d'activité dans la soumission ────────
       Toléré uniquement parce que la soumission n'en porte aucune : ce n'est
       pas un contournement du croisement, c'est le croisement amputé de son
       second terme. D'où l'indice de confiance le plus bas et une passe
       nommée à part, pour qu'un relecteur les distingue. */
    const seuls = dansRestreint(idx.parNom.get(nom) || []);
    if(seuls.length === 1)
      return conclure(seuls[0], "nom_seul",
        `nom de site « ${entree.site_name_raw} » rapproché sans croisement : ${sujet} ne porte `
        + `aucune activité. Un seul site correspond, ${nommer(seuls, idx)} — à vérifier`);
    notes.push(seuls.length
      ? `${seuls.length} sites portent le nom « ${entree.site_name_raw} » et ${sujet} ne porte `
        + "aucune activité pour les départager"
      : `aucun site ne porte le nom « ${entree.site_name_raw} »`);
  } else {
    notes.push(`${sujet} ne porte aucun nom de site`);
  }

  /* ── (d) Non résolu ─────────────────────────────────────────────── */
  return { site_id: null, passe: null, confiance: 0,
    motif: `non résolu — ${notes.join(" ; ")}`,
    candidats: restreint || [] };
}

/* Rejoue le rattachement sur des soumissions déjà en base. Utile après avoir
   renseigné un code externe, corrigé un nom ou créé un site : re-tirer depuis
   ODK Central ne servirait à rien puisque `submissions` garde tout, et le
   tirage est de toute façon plafonné à 20 000 lignes.

   `seulementNonResolues` par défaut : rejouer sur une soumission déjà rattachée
   peut la DÉrattacher si le référentiel a changé entre-temps, ce qui est un
   effet légitime mais qu'il faut demander.

   ── Ce que le rejeu ne touche jamais ─────────────────────────────────
   Une soumission rattachée À LA MAIN est exclue, sans exception et sans option
   pour passer outre. L'automatisme s'exécute sans témoin, sur des milliers de
   lignes, à chaque tirage ; la décision manuelle, elle, a été prise une fois par
   quelqu'un devant le cas précis que le résolveur n'a pas su trancher. Si le
   rejeu pouvait l'effacer, l'opérateur referait le même geste à chaque tirage
   sans jamais comprendre pourquoi il disparaît — et le seul recours serait de ne
   plus jamais rejouer.

   Défaire une décision manuelle reste possible, mais par un geste explicite et
   journalisé : POST /api/submissions/:id/detacher. C'est la différence entre
   « on ne peut pas revenir dessus » et « on ne revient pas dessus par accident ». */
export function rejouerRattachement({ ids = null, seulementNonResolues = true, office_id = null } = {}){
  const where = [];
  const args = [];
  if(seulementNonResolues) where.push("site_id IS NULL");
  if(ids?.length){
    where.push(`id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  where.push("(resolution_passe IS NULL OR resolution_passe <> ?)");
  args.push(PASSE_MANUELLE);

  const lignes = db.prepare(`SELECT id, site_code_raw, site_name_raw, activity_tag, geo_pcode, site_id
                             FROM submissions WHERE ${where.join(" AND ")}`)
    .all(...args);
  /* Combien de décisions humaines ont été laissées de côté. Le silence serait
     ici la pire réponse : un opérateur qui relance le rattachement et voit
     « 0 rattachée » doit pouvoir distinguer « rien à faire » de « tout ce qui
     restait était déjà tranché à la main ». */
  const protegees = db.prepare(`SELECT COUNT(*) c FROM submissions s
    LEFT JOIN sites si ON si.id = s.site_id
    WHERE s.resolution_passe = ?
      ${office_id ? "AND si.office_id = ?" : ""}
      ${ids?.length ? `AND s.id IN (${ids.map(() => "?").join(",")})` : ""}`)
    .get(PASSE_MANUELLE, ...(office_id ? [office_id] : []), ...(ids?.length ? ids : [])).c;
  if(!lignes.length)
    return { examinees: 0, rattachees: 0, detachees: 0, nonResolues: 0, protegees };

  const index = construireIndex({ office_id });
  const maj = db.prepare(`UPDATE submissions
                          SET site_id=?, resolution_passe=?, resolution_motif=?,
                              resolution_confiance=?, resolution_at=datetime('now'),
                              updated_at=datetime('now')
                          WHERE id=?`);
  let rattachees = 0, detachees = 0, nonResolues = 0;
  for(const l of lignes){
    const r = resoudre(l, index);
    if(r.site_id && !l.site_id) rattachees++;
    else if(!r.site_id && l.site_id) detachees++;
    if(!r.site_id) nonResolues++;
    maj.run(r.site_id, r.passe, r.motif, r.confiance, l.id);
  }
  return { examinees: lignes.length, rattachees, detachees, nonResolues, protegees };
}
