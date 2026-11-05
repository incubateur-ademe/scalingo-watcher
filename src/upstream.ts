/**
 * L'amont d'un outil : ou il publie ses versions, comment les ranger en lignes,
 * et ce qu'il dit des failles de celles-ci.
 *
 * Ce que le moteur sait de chaque outil vit dans son module, sous src/tools.
 * Le champ tool.upstream du manifeste le complete ou le surcharge.
 */

import { toolOf } from "./tools/index.ts";

export type Upstream = {
  /** Depot GitHub qui publie les releases, au format owner/name. */
  repo: string;
  /**
   * Nombre de composants de tete qui forment une ligne de versions. Une
   * version n'est comparee qu'aux releases de sa propre ligne.
   */
  line: number;
  /**
   * Nom de l'outil chez endoflife.date, qui dit la fin de support de chaque
   * ligne et laquelle est de support long. Absent quand le rapprochement n'est
   * pas verifie : la veille se tait alors, comme elle se tait sur un amont
   * inconnu.
   */
  lifecycle?: string;
  /** Vrai quand les avis ecrivent l'edition en `x` litteral, voir ToolModule. */
  editionWildcard?: boolean;
};

const DEFAULT_LINE = 1;

export type ToolDeclaration = {
  env: string;
  upstream?: { repo: string; line?: number; lifecycle?: string };
};

/**
 * Amont d'un outil : celui que declare le manifeste, sinon celui de son module.
 *
 * La forme des avis suit l'outil et non le depot : un manifeste qui designe un
 * autre depot pour Metabase garde la lecture du `x` d'edition.
 */
export function upstreamOf(tool: ToolDeclaration): Upstream | null {
  const known = toolOf(tool.env);
  const edition = known?.editionWildcard ? { editionWildcard: true } : {};
  if (tool.upstream) {
    return {
      repo: tool.upstream.repo,
      line: tool.upstream.line ?? known?.upstream.line ?? DEFAULT_LINE,
      lifecycle: tool.upstream.lifecycle ?? known?.upstream.lifecycle,
      ...edition,
    };
  }
  return known ? { ...known.upstream, ...edition } : null;
}

/** Nom de l'outil dans le rapport : celui de son module, a defaut celui de sa variable. */
export function toolName(env: string): string {
  const known = toolOf(env)?.name;
  if (known) return known;
  const base = env.replace(/_VERSION$/, "").toLowerCase().replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const head = (v: readonly number[], line: number) =>
  Array.from({ length: line }, (_, i) => v[i] ?? 0);

/** Compare les lignes de deux versions decoupees en composants numeriques. */
export function compareLines(a: readonly number[], b: readonly number[], line: number): number {
  const [x, y] = [head(a, line), head(b, line)];
  for (let i = 0; i < line; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Ligne d'une version telle qu'affichee : 0 pour v0.63.18 avec une ligne d'un composant. */
export const lineLabel = (v: readonly number[], line: number) => head(v, line).join(".");

// ---------------------------------------------------------------- versions

export type Version = number[];

export function parseSemver(raw: string): Version | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(raw.trim());
  return m ? m[1].split(".").map(Number) : null;
}

/**
 * Version a comparer aux plages des failles et des avis, ou null si elle n'en
 * designe pas une seule. Un alias glissant comme v0.63.x se lirait 0.63, donc
 * 0.63.0, et tomberait dans toute plage ouverte en x.63.0 quelle que soit la
 * version servie.
 */
export function pinnedVersion(raw: string): Version | null {
  if (/(^|\.)[x*](\.|$)/i.test(raw.trim())) return null;
  return parseSemver(raw);
}

export function cmpVersion(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Plage de versions, bornes comprises ou exclues.
 *
 * `startExcl` ne sert qu'aux avis de depot : les plages du NVD n'ont jamais de
 * borne basse exclue. La declarer permet de lire `> x.y.z` au lieu de le
 * declarer illisible, ce qui serait un constat de forme sur une plage dont le
 * sens est clair.
 */
export type Range = { startIncl?: string; startExcl?: string; endExcl?: string; endIncl?: string };

export function versionInRange(v: Version, r: Range): boolean {
  const at = (bound: string | undefined) => (bound ? parseSemver(bound) : null);
  const [startI, startE, endE, endI] = [at(r.startIncl), at(r.startExcl), at(r.endExcl), at(r.endIncl)];
  if (!startI && !startE && !endE && !endI) return false;
  if (startI && cmpVersion(v, startI) < 0) return false;
  if (startE && cmpVersion(v, startE) <= 0) return false;
  if (endE && cmpVersion(v, endE) >= 0) return false;
  if (endI && cmpVersion(v, endI) > 0) return false;
  return true;
}

// ---------------------------------------------------- avis de securite amont

/**
 * Un avis publie par le depot amont, tel que l'API des avis de depot le rend
 * (GET /repos/{owner}/{repo}/security-advisories).
 *
 * C'est la seule source qui porte l'information pour un outil hors ecosysteme
 * de paquets, et c'est pourquoi le watcher la releve lui-meme. Une alerte
 * Dependabot exige un avis revu, rattache a l'un des ecosystemes supportes, et
 * une dependance visible dans le graphe de dependances : manifest.yaml n'est pas
 * un manifeste reconnu. Les alertes OSV de Renovate ne couvrent que des
 * datasources de paquets.
 *
 * Ni le CVE ni le score CVSS ne peuvent servir de cle : sur les 45 avis du
 * depot Metabase au 2026-10-30, 17 n'ont aucun CVE et 29 aucun score. Le plus
 * recent, GHSA-v44v-x8x4-mvcw, critique, n'a ni l'un ni l'autre et est absent de
 * la base globale GitHub comme d'OSV. Seules `vulnerable_version_range` et
 * `patched_versions` sont donc lues.
 *
 * Aucun filtre sur le paquet declare : les avis d'un depot concernent l'outil
 * qu'il publie. Un depot qui en publierait plusieurs ferait signaler l'un sur
 * l'autre, ce qui sur-signale au lieu de taire.
 */
export type Advisory = {
  ghsa_id: string;
  cve_id: string | null;
  severity: string | null;
  summary: string;
  html_url: string;
  published_at: string | null;
  withdrawn_at: string | null;
  vulnerabilities: Array<{
    vulnerable_version_range: string | null;
    patched_versions: string | null;
  }> | null;
};


/**
 * Un texte d'avis dont l'edition est substituee par celle de la version jugee,
 * chez un outil dont le module le demande.
 *
 * Metabase ecrit l'edition en `x` litteral, `>= x.64.0, < x.64.3.4` par exemple,
 * pour couvrir d'un seul avis la ligne OSS et la ligne Enterprise. Ce n'est pas
 * du semver : sans cette substitution aucune plage ne correspond jamais et tout
 * le parc passe pour indemne. Elle maintient de surcroit la comparaison dans la
 * ligne de la version jugee, les deux editions n'etant jamais comparables.
 *
 * Un `x` qui ne precede pas un chiffre reste tel quel : dans `0.54.x` c'est un
 * joker sur le reste de la version, que ce releve ne sait pas lire.
 */
const substituteEdition = (raw: string, judged: Version, edition: boolean) =>
  edition ? raw.replace(/(^|[^\w.])x(?=\.\d)/g, (_, before: string) => `${before}${judged[0] ?? 0}`) : raw;

/** Les versions qu'un texte d'avis nomme, quelle que soit sa forme. */
const versionsNamed = (raw: string, judged: Version, edition: boolean): Version[] =>
  [...substituteEdition(raw, judged, edition).matchAll(/\d+(?:\.\d+)*/g)].map((m) => m[0].split(".").map(Number));

/** Une borne ramenee a une suite de chiffres, ou null si ce n'en est pas une. */
const readBound = (raw: string): string | null => {
  const bare = raw.trim().replace(/^v/, "");
  return /^\d+(?:\.\d+)*$/.test(bare) ? bare : null;
};

/**
 * Plage de versions affectees par un avis, ou null quand sa forme n'est pas
 * celle qu'on sait lire.
 *
 * Une forme inattendue rend null plutot qu'une plage amputee d'une borne : une
 * borne ignoree en silence ferait passer une version affectee pour indemne.
 * L'amont en ecrit beaucoup, et de plusieurs sortes : des disjonctions de lignes
 * `<x.44.5,<x.43.7,<x.42.6`, des bornes basses sans operateur
 * `1.55.0, < 1.55.23`, de la prose `All enterprise versions < 1.59.x`. Aucune ne
 * se devine : c'est judgeAdvisories qui tranche ensuite, par le correctif que
 * l'avis annonce lui-meme.
 */
export function readRange(raw: string, judged: Version, edition: boolean): Range | null {
  const parts = substituteEdition(raw, judged, edition)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const range: Range = {};
  const set = (key: keyof Range, value: string) => {
    if (range[key] !== undefined) return false;
    range[key] = value;
    return true;
  };
  for (const part of parts) {
    const m = /^(>=|<=|=|>|<)\s*(\S+)$/.exec(part);
    if (!m) return null;
    const bound = readBound(m[2]);
    if (!bound) return null;
    const placed =
      m[1] === ">="
        ? set("startIncl", bound)
        : m[1] === ">"
          ? set("startExcl", bound)
          : m[1] === "<"
            ? set("endExcl", bound)
            : m[1] === "<="
              ? set("endIncl", bound)
              : parts.length === 1 && set("startIncl", bound) && set("endIncl", bound);
    if (!placed) return null;
  }
  // Une plage dont la borne basse depasse la borne haute ne designe aucune
  // version. La lire comme vide rendrait "indemne" sur une forme mal comprise.
  const low = range.startIncl ?? range.startExcl;
  const high = range.endExcl ?? range.endIncl;
  if (low && high && cmpVersion(parseSemver(low)!, parseSemver(high)!) > 0) return null;
  return range;
}

export type AdvisoryHit = {
  ghsa: string;
  cve: string | null;
  severity: string | null;
  summary: string;
  url: string;
  published: string | null;
  /** Version qui sort de cet avis seul, null quand il n'en nomme aucune. */
  fix: string | null;
};

export type AdvisoryVerdict = {
  /** Avis qui couvrent la version jugee, dans l'ordre de l'amont. */
  hits: AdvisoryHit[];
  /**
   * Version la plus basse qui sort de tous les avis, dans la ligne de la version
   * jugee, ou null quand aucune n'est atteignable.
   */
  fix: string | null;
  /**
   * Plages dont la forme n'a pas permis de conclure, et que le correctif annonce
   * par l'avis ne tranche pas non plus : ni retenues, ni ecartees.
   */
  unreadable: Array<{ ghsa: string; range: string }>;
};

// Chaque pas monte strictement : huit suffisent largement, et bornent une
// chaine d'avis qui se recouvriraient a l'infini.
const MAX_FIX_STEPS = 8;

/**
 * Version rendue dans la forme de celle qu'elle remplace. Le prefixe `v` fait
 * partie de la valeur chez Metabase, le buildpack la concatenant telle quelle
 * dans l'URL de telechargement : proposer `0.63.10` ferait echouer le build.
 */
const formatLike = (model: string, v: Version) => (model.trim().startsWith("v") ? "v" : "") + v.join(".");

/**
 * Confronte une version aux avis de son amont.
 *
 * Rendu par couple depot-version et non par application : le parc n'etant pas
 * homogene, six instances en v0.64.4.2 et une en v0.63.16 sont deux situations
 * de securite distinctes, mais les six premieres n'en sont qu'une.
 *
 * Rend null quand la version n'est pas lisible, une version flottante par
 * exemple : il n'y a alors rien a juger.
 */
export function judgeAdvisories(
  advisories: readonly Advisory[],
  version: string,
  { line, editionWildcard = false }: Pick<Upstream, "line" | "editionWildcard">,
): AdvisoryVerdict | null {
  const judged = pinnedVersion(version);
  if (!judged) return null;

  const inLine = (v: Version, of: Version) => compareLines(v, of, line) === 0;
  const top = (list: Version[]) =>
    list.reduce<Version | null>((best, v) => (!best || cmpVersion(v, best) > 0 ? v : best), null);

  /**
   * Ce qu'un avis dit d'une version, ou null quand il ne la concerne pas.
   *
   * Un avis qui ne nomme aucune version de la ligne jugee ne la concerne pas.
   * Les avis qui portent sur les deux editions sont ecrits en `x` litteral,
   * substitue plus haut : un avis dont tous les numeros sont d'une autre edition
   * est donc un avis de cette autre edition. Limite connue, quelques vieux avis
   * ecrivent leurs numeros sans edition, `<55.13` pour `<0.55.13`, et passent
   * ainsi pour etrangers a la ligne ; ils portent sur des versions corrigees
   * depuis des annees.
   *
   * Une plage qu'on ne sait pas lire ne vaut ni affectation ni innocence : elle
   * est tranchee par le correctif que l'avis annonce lui-meme, l'amont disant a
   * partir de quelle version la faille est corrigee. Au-dela du plus haut
   * correctif qu'il nomme dans la ligne, la faille y est corrigee quelle que
   * soit la forme de ses plages. En dessous, l'avis est signale comme non
   * concluant plutot que tenu pour indemne. C'est ce qui garde le releve muet :
   * sur les 104 plages des 45 avis du depot Metabase, 30 ne se lisent pas, et le
   * premier jet les signalait toutes a chaque passage sur un parc dont aucune
   * version n'etait affectee. Ce recours en ecarte 18, la garde de ligne
   * ci-dessus les 12 autres.
   */
  const judgeOne = (advisory: Advisory, v: Version) => {
    const entries = (advisory.vulnerabilities ?? []).filter((e) => e.vulnerable_version_range);
    const patchedIn = (raw: string | null) => versionsNamed(raw ?? "", v, editionWildcard).filter((x) => inLine(x, v));
    const announced = top(entries.flatMap((e) => patchedIn(e.patched_versions)));
    const named = entries.flatMap((e) => versionsNamed(e.vulnerable_version_range!, v, editionWildcard)).filter((x) => inLine(x, v));
    if (named.length === 0 && !announced) return null;

    let affected = false;
    let fix: Version | null = null;
    let unknownFix = false;
    const blind: string[] = [];
    for (const entry of entries) {
      const raw = entry.vulnerable_version_range!;
      const range = readRange(raw, v, editionWildcard);
      if (!range) {
        blind.push(raw);
        continue;
      }
      if (!versionInRange(v, range)) continue;
      affected = true;
      const patched = top(patchedIn(entry.patched_versions));
      if (!patched) unknownFix = true;
      else if (!fix || cmpVersion(patched, fix) > 0) fix = patched;
    }

    if (affected) return { affected: true, fix: unknownFix ? null : fix, blind: [] as string[] };
    if (blind.length === 0) return null;
    if (announced && cmpVersion(v, announced) >= 0) return null;
    return { affected: false, fix: null, blind };
  };

  const unreadable: Array<{ ghsa: string; range: string }> = [];

  /**
   * Avis qui couvrent une version, et le correctif que chacun exige. Les plages
   * non concluantes ne sont relevees que pour la version en service : celles des
   * versions visees par la recherche du correctif ne sont pas un constat.
   */
  const hitsFor = (v: Version, report = false) => {
    const out: Array<{ advisory: Advisory; fix: Version | null }> = [];
    for (const advisory of advisories) {
      if (advisory.withdrawn_at) continue;
      const seen = judgeOne(advisory, v);
      if (!seen) continue;
      if (seen.affected) out.push({ advisory, fix: seen.fix });
      else if (report) for (const range of seen.blind) unreadable.push({ ghsa: advisory.ghsa_id, range });
    }
    return out;
  };

  /** Le plus haut correctif exige, null des qu'un avis n'en nomme aucun. */
  const highest = (found: Array<{ fix: Version | null }>): Version | null => {
    let best: Version | null = null;
    for (const { fix } of found) {
      if (!fix) return null;
      if (!best || cmpVersion(fix, best) > 0) best = fix;
    }
    return best;
  };

  const hits = hitsFor(judged, true);

  // Le correctif doit sortir de tous les avis, et pas seulement de ceux qui
  // couvrent la version en service : une faille apparue apres elle rattrape la
  // version visee, et la pull request proposerait alors une montee vers un etat
  // encore vulnerable. On remonte donc jusqu'a une version qu'aucun avis ne
  // couvre, ou on conclut qu'il n'y en a pas.
  let target = highest(hits);
  let settled = false;
  for (let step = 0; target !== null && step < MAX_FIX_STEPS; step++) {
    const reached = hitsFor(target);
    if (reached.length === 0) {
      settled = true;
      break;
    }
    const higher = highest(reached);
    target = higher && cmpVersion(higher, target) > 0 ? higher : null;
  }
  if (!settled) target = null;

  // Un correctif qui quitte la ligne de la version en service n'est pas un
  // correctif mais un changement d'edition, qui ne se decide pas ici. Un
  // correctif qui ne la depasse pas ne corrige rien.
  if (target && (!inLine(target, judged) || cmpVersion(target, judged) <= 0)) target = null;

  return {
    hits: hits.map(({ advisory, fix }) => ({
      ghsa: advisory.ghsa_id,
      cve: advisory.cve_id ?? null,
      severity: advisory.severity ?? null,
      summary: advisory.summary ?? "",
      url: advisory.html_url,
      published: advisory.published_at ?? null,
      fix: fix ? formatLike(version, fix) : null,
    })),
    fix: target ? formatLike(version, target) : null,
    unreadable,
  };
}


const ADVISORY_PAGE_SIZE = 100;
// Comme les releases dans l'audit : de quoi couvrir un depot bien fourni, le
// depot Metabase en comptant 45.
const ADVISORY_PAGES = 5;

const advisoryCache = new Map<string, Advisory[] | null>();

/**
 * Avis publies par un depot amont, ou null quand la liste n'a pas pu etre lue.
 *
 * Un appel par depot, et non par application : sept instances du meme outil
 * donneraient sept fois la meme requete. Le lecteur est fourni par l'appelant,
 * qui porte deja son client GitHub et son jeton.
 *
 * Un echec est memorise comme le reste : le relever a nouveau pour chaque
 * application repeterait le meme echec et dirait la meme chose.
 *
 * Une liste tronquee rend null plutot que ce qui a ete lu : un avis perdu dans
 * une troncature serait indiscernable d'une absence d'avis.
 */
export async function advisoriesFor(
  repo: string,
  get: <T>(path: string) => Promise<T | null>,
): Promise<Advisory[] | null> {
  const cached = advisoryCache.get(repo);
  if (cached !== undefined) return cached;
  const all: Advisory[] = [];
  let read: Advisory[] | null = null;
  for (let page = 1; page <= ADVISORY_PAGES; page++) {
    const batch = await get<Advisory[]>(
      `/repos/${repo}/security-advisories?state=published&per_page=${ADVISORY_PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(batch)) break;
    all.push(...batch);
    if (batch.length < ADVISORY_PAGE_SIZE) {
      read = all;
      break;
    }
  }
  advisoryCache.set(repo, read);
  return read;
}

// ------------------------------------------------ fin de vie d'une ligne

/**
 * Une ligne de versions telle que l'API d'endoflife.date la rend
 * (GET /api/v1/products/{nom}, champ result.releases).
 *
 * La v1 est preferee a la v0 pour une raison de forme : la v0 ecrit `eol` et
 * `lts` tantot en booleen tantot en date, `"lts":"2026-10-28"` chez nodejs,
 * `"eol":true` sur une ligne deja morte. Lire cette union demanderait de
 * trancher a chaque champ ce qu'une valeur veut dire, et une erreur de lecture
 * y rendrait "supportee" une ligne qui ne l'est plus. La v1 separe le drapeau
 * de la date, `isEol` et `eolFrom`, `isLts` et `ltsFrom`, et porte un
 * `schema_version`.
 *
 * `eolFrom` est la fin du support de securite, le dernier jour ou un correctif
 * arrive. Il vaut null chez les outils dont l'editeur n'annonce aucune date,
 * Kibana et Logstash par exemple : une ligne sans date n'est pas une ligne sans
 * fin, c'est une fin qu'on ne sait pas dater.
 */
export type Line = {
  name: string;
  isLts: boolean;
  isEol: boolean;
  eolFrom: string | null;
};

export type LifecycleVerdict = {
  /** Ligne de la version jugee, telle que la source la nomme. */
  cycle: string;
  /** Cette ligne est-elle de support long. */
  lts: boolean;
  /** Fin du support de securite, ou null quand la source n'en date aucune. */
  eol: string | null;
  /**
   * Ce que la source annonce comme fin de support quand ce n'est pas une date,
   * ou null quand elle n'annonce rien.
   *
   * Une absence de date et une date hors forme ne demandent pas la meme chose :
   * la premiere est un fait de l'editeur, Elastic n'en publie aucune, la seconde
   * dit que la source a change de forme et se corrige ici. Les confondre
   * perdrait le seul signal de ce changement. C'est la distinction que le releve
   * des avis fait deja entre une plage absente et une plage illisible.
   */
  unreadableEol: string | null;
  /** Jours jusqu'a cette fin, negatif quand elle est passee. */
  days: number | null;
  /** La source declare la ligne en fin de support, datee ou non. */
  ended: boolean;
  /**
   * Ligne de support long plus recente et encore supportee, dans la ligne de la
   * version jugee, ou null.
   */
  nextLts: { cycle: string; eol: string | null } | null;
};

const DAY_MS = 86400000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date d'une borne, ou null quand ce n'en est pas une.
 *
 * Une valeur hors forme rend null plutot que NaN : `NaN <= seuil` est faux, donc
 * un NaN laisse passer la ligne pour supportee sans que rien ne le dise.
 *
 * La forme ne suffit pas, le calendrier est verifie avec. `2026-13-01` et
 * `2026-11-32` la passent et rendent pourtant NaN a la lecture, ce qui est
 * exactement le NaN ci-dessus ; `2026-02-31` ne rend pas NaN mais roule au 3
 * mars, et compter les jours depuis une date que personne n'a annoncee est un
 * autre faux. Le detour par toISOString attrape les deux : une date impossible
 * n'en revient jamais a l'identique.
 */
const dayOf = (raw: string | null): string | null => {
  if (!raw || !ISO_DAY.test(raw)) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 10) === raw ? raw : null;
};

/**
 * Confronte une version a la fin de vie de sa ligne.
 *
 * Rend null quand rien ne se rapproche : version flottante, ou aucune ligne de
 * la source qui porte la version en service. C'est la regle que les modules
 * d'outil s'imposent deja : un outil que la source ne connait pas reste muet, un
 * faux "supporte" etant pire qu'un "fin de vie inconnue".
 *
 * La ligne en service est celle dont les composants prefixent la version jugee,
 * la plus longue quand plusieurs le font. La comparaison est numerique et non
 * textuelle : `0.6` ne prefixe pas `0.65.3`, la ou la chaine le ferait croire.
 *
 * Les lignes retenues sont celles que `line` rend comparables a la version
 * jugee. Chez Metabase le premier chiffre designe l'edition : sans ce filtre,
 * une ligne 1.x de l'Enterprise passerait pour un support long plus recent que
 * la 0.64 de l'OSS, quand c'est un changement d'edition. Limite assumee, chez un
 * outil ou `line` designe bien la majeure, un support long de la majeure
 * suivante n'est pas signale ; c'est la fin de support de la ligne en service
 * qui l'est, et elle seule force la decision.
 */
export function judgeLifecycle(
  lines: readonly Line[],
  version: string,
  line: number,
  today: number,
): LifecycleVerdict | null {
  const judged = pinnedVersion(version);
  if (!judged) return null;

  const comparable = lines
    .map((r) => ({ release: r, v: r && typeof r.name === "string" ? parseSemver(r.name) : null }))
    .filter((c): c is { release: Line; v: Version } => c.v !== null && compareLines(c.v, judged, line) === 0);

  const prefixes = (c: Version) => c.every((n, i) => judged[i] === n);
  const current = comparable
    .filter((c) => prefixes(c.v))
    .reduce<{ release: Line; v: Version } | null>((best, c) => (!best || c.v.length > best.v.length ? c : best), null);
  if (!current) return null;

  // Lu tel quel et non par le type declare : si la source revenait a la forme de
  // sa version 0, cette borne porterait un booleen, et c'est la seule chose qui
  // le dirait.
  const announced = current.release.eolFrom;
  const eol = dayOf(announced);

  /**
   * Une ligne de support long deja morte ne resout rien, et une ligne qui meurt
   * avant celle en service non plus : la nommer serait precisement se laisser
   * attirer par un numero plus recent dont le support s'arrete plus tot, ce que
   * cette veille existe pour eviter. Les dates etant validees, l'ordre des
   * chaines est l'ordre des jours. Quand l'une des deux n'est pas datee, rien ne
   * se compare : la ligne est nommee avec sa date, et c'est au lecteur de juger.
   */
  const outlives = (c: { release: Line }) => {
    const until = dayOf(c.release.eolFrom);
    return !eol || !until || until >= eol;
  };
  const next = comparable
    .filter(
      (c) => Boolean(c.release.isLts) && !c.release.isEol && cmpVersion(c.v, current.v) > 0 && outlives(c),
    )
    .reduce<{ release: Line; v: Version } | null>((best, c) => (!best || cmpVersion(c.v, best.v) > 0 ? c : best), null);
  const written = announced === null || announced === undefined ? "" : String(announced).trim();
  return {
    cycle: current.release.name,
    lts: Boolean(current.release.isLts),
    eol,
    unreadableEol: eol === null && written !== "" ? written : null,
    // Arrondi au jour superieur et non au plus proche : la borne vaut minuit
    // UTC, donc une passe de l'apres-midi voyait 91 jours pleins comme 90 et
    // declenchait le seuil un jour trop tot, selon son heure.
    days: eol ? Math.ceil((Date.parse(eol) - today) / DAY_MS) : null,
    ended: Boolean(current.release.isEol),
    nextLts: next ? { cycle: next.release.name, eol: dayOf(next.release.eolFrom) } : null,
  };
}

/**
 * Seuil a partir duquel la fin de support d'une ligne devient une echeance.
 *
 * La politique de Metabase garantit au moins soixante jours a une ligne
 * ordinaire : un seuil cale dessus ne laisserait aucune marge sur une ligne
 * courte. Un trimestre laisse le temps d'instruire la montee en pull request
 * puis de la derouler sur le parc, ce qui est le delai reel entre le signal et
 * le dernier deploiement.
 */
export const EOL_WARNING_DAYS = 90;

/** Vrai quand la fin de support de cette ligne demande une decision maintenant. */
export const lifecycleDue = (v: LifecycleVerdict): boolean =>
  v.ended || (v.days !== null && v.days <= EOL_WARNING_DAYS);

const LIFECYCLE_URL = "https://endoflife.date/api/v1/products";

const lifecycleCache = new Map<string, Line[] | null>();

/**
 * Lignes publiees pour un outil, ou null quand la source ne les a pas rendues.
 *
 * Un appel par outil et non par application, comme pour les avis : sept
 * instances du meme outil donneraient sept fois la meme requete. Un echec est
 * memorise avec le reste, le relever a nouveau repeterait le meme echec.
 *
 * Un nom que la source ne connait pas rend une page d'erreur et non du JSON :
 * c'est le lecteur, fourni par l'appelant, qui ecarte les reponses en erreur.
 */
export async function lifecycleFor(
  product: string,
  get: <T>(url: string) => Promise<T | null>,
): Promise<Line[] | null> {
  const cached = lifecycleCache.get(product);
  if (cached !== undefined) return cached;
  const body = await get<{ result?: { releases?: Line[] } }>(
    `${LIFECYCLE_URL}/${encodeURIComponent(product)}`,
  );
  const releases = Array.isArray(body?.result?.releases) ? body.result.releases : null;
  lifecycleCache.set(product, releases);
  return releases;
}
