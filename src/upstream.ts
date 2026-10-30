/**
 * L'amont d'un outil : ou il publie ses versions, comment les ranger en lignes,
 * et ce qu'il dit des failles de celles-ci.
 *
 * Le rapprochement outil - depot est le seul que rien ne permet de deriver : le
 * nom de la variable de version dit quel buildpack la lit, pas ou l'outil publie
 * ses releases. La table se limite aux depots verifies : un mauvais
 * rapprochement produirait un "a jour" faux, ce qui est pire que
 * "amont inconnu".
 * A confirmer avant ajout : clamav, geoserver, opensearch-dashboards, nginx.
 *
 * Le champ tool.upstream du manifeste complete ou surcharge cette table.
 */

export type Upstream = {
  /** Depot GitHub qui publie les releases, au format owner/name. */
  repo: string;
  /**
   * Nombre de composants de tete qui forment une ligne de versions. Une
   * version n'est comparee qu'aux releases de sa propre ligne.
   */
  line: number;
};

/** Cle : la variable de version lue par le buildpack, celle de tool.env. */
export const UPSTREAM: Record<string, Upstream & { name: string }> = {
  // Deux lignes publiees en parallele : v0.x pour l'edition OSS, v1.x pour
  // l'Enterprise. Le premier chiffre designe l'edition et non une version :
  // v1.52.2 date de 2024 quand v0.63.16 date de 2026.
  METABASE_VERSION: { name: "Metabase", repo: "metabase/metabase", line: 1 },
  GRAFANA_VERSION: { name: "Grafana", repo: "grafana/grafana", line: 1 },
  LOGSTASH_VERSION: { name: "Logstash", repo: "elastic/logstash", line: 1 },
  KIBANA_VERSION: { name: "Kibana", repo: "elastic/kibana", line: 1 },
  PROMETHEUS_VERSION: { name: "Prometheus", repo: "prometheus/prometheus", line: 1 },
  SONARQUBE_VERSION: { name: "SonarQube", repo: "SonarSource/sonarqube", line: 1 },
};

const DEFAULT_LINE = 1;

export type ToolDeclaration = { env: string; upstream?: { repo: string; line?: number } };

/** Amont d'un outil : celui que declare le manifeste, sinon celui de la table. */
export function upstreamOf(tool: ToolDeclaration): Upstream | null {
  const known = UPSTREAM[tool.env];
  if (tool.upstream) {
    return { repo: tool.upstream.repo, line: tool.upstream.line ?? known?.line ?? DEFAULT_LINE };
  }
  return known ? { repo: known.repo, line: known.line } : null;
}

/** Nom de l'outil dans le rapport : celui de la table, a defaut celui de sa variable. */
export function toolName(env: string): string {
  const known = UPSTREAM[env]?.name;
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
 * Un texte d'avis dont l'edition est substituee par celle de la version jugee.
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
const substituteEdition = (raw: string, judged: Version) =>
  raw.replace(/(^|[^\w.])x(?=\.\d)/g, (_, before: string) => `${before}${judged[0] ?? 0}`);

/** Les versions qu'un texte d'avis nomme, quelle que soit sa forme. */
const versionsNamed = (raw: string, judged: Version): Version[] =>
  [...substituteEdition(raw, judged).matchAll(/\d+(?:\.\d+)*/g)].map((m) => m[0].split(".").map(Number));

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
export function readRange(raw: string, judged: Version): Range | null {
  const parts = substituteEdition(raw, judged)
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
  line: number,
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
    const patchedIn = (raw: string | null) => versionsNamed(raw ?? "", v).filter((x) => inLine(x, v));
    const announced = top(entries.flatMap((e) => patchedIn(e.patched_versions)));
    const named = entries.flatMap((e) => versionsNamed(e.vulnerable_version_range!, v)).filter((x) => inLine(x, v));
    if (named.length === 0 && !announced) return null;

    let affected = false;
    let fix: Version | null = null;
    let unknownFix = false;
    const blind: string[] = [];
    for (const entry of entries) {
      const raw = entry.vulnerable_version_range!;
      const range = readRange(raw, v);
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
