import type { BuildpackModule } from "./types.ts";

/**
 * Le JDK que Scalingo/buildpack-jvm-common installe.
 *
 * La majeure vient de `java.runtime.version` dans le system.properties de
 * l'app, et de rien d'autre : aucune variable d'environnement n'y touche. Le
 * buildpack la resout en version complete par une table d'alias versionnee
 * avec lui, inventory.json, sans appeler l'editeur, et retelecharge le JDK a
 * chaque build, sans cache. Un rebuild installe donc l'alias du moment : c'est
 * ce qui rend la prevision possible, et le rebuild suffisant.
 *
 * Depuis le 2025-02-26, la ligne du journal donne la version resolue,
 * `-----> Installing Azul Zulu OpenJDK 25.0.5.1`. Avant, elle donnait le
 * selecteur demande suivi de `... done`, `Installing OpenJDK 17... done` : cette
 * forme est lue, mais elle ne designe aucun JDK precis.
 */
export const JVM_COMMON = "Scalingo/buildpack-jvm-common";

/**
 * Le depot dont Scalingo/buildpack-jvm-common est le fork. Un robot y met
 * l'inventaire a jour un a trois jours apres chaque correctif, puis Scalingo
 * fusionne a la main, avec un retard qui n'est pas borne : la ligne 17 a saute
 * toute la mise a jour d'avril 2025, 108 jours sans que rien ne le signale.
 */
export const JVM_UPSTREAM = "heroku/heroku-buildpack-jvm-common";

const LINE = /^-----> Installing ((?:Azul Zulu |Heroku )?OpenJDK) (\d[\w.+-]*?)(\.\.\.)?(?: done)?$/;

export default {
  repo: JVM_COMMON,
  component: "jdk",
  read: (line) => {
    const m = LINE.exec(line);
    if (!m) return null;
    return m[3] ? { name: m[1], version: m[2], exact: false } : { name: m[1], version: m[2] };
  },
} satisfies BuildpackModule;

/** Composants numeriques d'une version de JDK, quelle qu'en soit la forme : 25.0.5.0.3, 1.8.0_514. */
const parts = (v: string): number[] =>
  v
    .split(/\D+/)
    .filter((p) => p.length > 0)
    .map(Number);

export function cmpJdk(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Valeur de `java.runtime.version`, lue comme le fait java_properties::get du
 * buildpack, ou null quand l'app n'en declare pas.
 */
export function readSelector(properties: string): string | null {
  for (const line of properties.split(/\r?\n/)) {
    const m = /^java\.runtime\.version(?:[ \t]*=[ \t]*|[ \t]+)([_A-Za-z0-9.-]*)/.exec(line);
    if (m) return m[1] || null;
  }
  return null;
}

/**
 * Fichier d'inventaire et pile au sens d'Heroku, comme inventory::query les
 * deduit de la pile Scalingo. scalingo-20 lit un inventaire a part, fige par
 * choix de Scalingo.
 */
export function inventoryTarget(stack: string): { file: string; stack: string } {
  const heroku = stack.replace("scalingo", "heroku").replace("-minimal", "");
  return { file: heroku === "heroku-20" ? "inventory-20.json" : "inventory.json", stack: heroku };
}

export type Inventory = {
  version_aliases: Record<string, string>;
  artifacts: Array<{
    version?: string;
    os?: string;
    arch?: string;
    metadata?: { distribution?: string; cedar_stacks?: string[] };
  }>;
};

/**
 * Version qu'installerait un build, comme la rend inventory::query, ou null
 * quand l'inventaire n'a aucun artefact pour ce selecteur sur cette pile : le
 * build echouerait alors au lieu d'installer quoi que ce soit.
 *
 * L'alias n'est resolu qu'une fois, comme dans la requete jq, et rendu quand il
 * a servi : un selecteur qui nomme deja une version complete est un epinglage,
 * que rien ne fera avancer.
 */
export function resolveJdk(
  inventory: Inventory,
  selector: string,
  herokuStack: string,
): { version: string; alias: string | null } | null {
  const m = /^(?:([^-]*?)-)?(.*)$/.exec(selector)!;
  const distribution = m[1] ?? "zulu";
  const aliased = inventory.version_aliases[m[2]];
  const version = aliased ?? m[2];
  const found = inventory.artifacts.some(
    (a) =>
      a.version === version &&
      a.metadata?.distribution === distribution &&
      a.arch === "amd64" &&
      a.os === "linux" &&
      (a.metadata?.cedar_stacks ?? []).includes(herokuStack),
  );
  return found ? { version, alias: aliased ? m[2] : null } : null;
}

export type Fetched = { status: number; body: string } | null;
export type GetText = (url: string) => Promise<Fetched>;

const RAW = "https://raw.githubusercontent.com";

/**
 * Inventaire lu a cette adresse, ou null quand il est illisible ou hors forme.
 *
 * Les alias qui ne sont pas du texte et les artefacts qui ne sont pas des
 * objets sont ecartes ici : un seul `null` dans la liste faisait lever la
 * resolution, et l'exception emportait l'ecriture du rapport de tout le passage.
 */
async function readInventory(url: string, get: GetText): Promise<Inventory | null> {
  const res = await get(url);
  if (!res || res.status !== 200) return null;
  let body: { version_aliases?: unknown; artifacts?: unknown };
  try {
    body = JSON.parse(res.body) as typeof body;
  } catch {
    return null;
  }
  const aliases = body?.version_aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases) || !Array.isArray(body.artifacts)) return null;
  return {
    version_aliases: Object.fromEntries(
      Object.entries(aliases as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
    artifacts: body.artifacts.filter((a): a is Inventory["artifacts"][number] => typeof a === "object" && a !== null),
  };
}

/**
 * Ce qu'un rebuild installerait, ou la raison pour laquelle on ne le sait pas.
 * `failed` dit qu'une source n'a pas repondu, ce qui n'est pas un constat : le
 * passage doit le signaler plutot que de se taire.
 */
export type JdkForecast = { version: string; alias: string | null } | { none: string; failed: boolean };

/**
 * Prevoit le JDK d'un rebuild : le selecteur du system.properties du commit
 * deploye, resolu par l'inventaire du buildpack a la reference qu'il suit, sur
 * la pile de l'app.
 *
 * Une app sans system.properties recoit le defaut du buildpack, qui change
 * d'une version a l'autre et que seul son code dit : on ne le devine pas, la
 * prevision se tait.
 */
export async function forecastJdk(
  build: { ref: string | null; stack: string; source: { repo: string; sha: string } },
  get: GetText,
): Promise<JdkForecast> {
  const props = await get(`${RAW}/${build.source.repo}/${build.source.sha}/system.properties`);
  if (!props || (props.status !== 200 && props.status !== 404)) {
    return { none: "system.properties illisible", failed: true };
  }
  const selector = props.status === 200 ? readSelector(props.body) : null;
  if (!selector) return { none: "majeure non fixée par system.properties", failed: false };
  const target = inventoryTarget(build.stack);
  const inventory = await readInventory(`${RAW}/${JVM_COMMON}/${build.ref ?? "HEAD"}/${target.file}`, get);
  if (!inventory) return { none: "inventaire illisible", failed: true };
  return resolveJdk(inventory, selector, target.stack) ?? {
    none: `${selector} absent de l'inventaire pour ${build.stack}`,
    failed: false,
  };
}

export type Lag = {
  alias: string;
  /** Version que l'alias designe chez Scalingo. */
  scalingo: string;
  /** Version que l'alias designe chez Heroku, plus recente. */
  upstream: string;
  /** Date ou Heroku a pose cette version, ou null quand on ne sait pas la dater. */
  since: string | null;
  /** La date est une borne : l'historique lu s'arrete avant le changement. */
  atLeast: boolean;
};

// Le robot d'Heroku ne touche l'inventaire qu'une fois par mois environ : dix
// commits remontent pres d'un an.
const HISTORY = 10;

/**
 * Retard de Scalingo sur Heroku pour un alias, ou null quand il n'y en a pas.
 *
 * La date est celle du premier commit d'Heroku qui porte la version, trouvee en
 * remontant l'historique d'inventory.json tant que l'alias la designe. Ce n'est
 * qu'en cas de retard que l'historique est lu : d'ordinaire, deux lectures
 * d'inventaire suffisent.
 *
 * Quand l'historique se lit, c'est son commit le plus recent qui fait foi, et
 * non la tete brute : le cache de raw.githubusercontent.com peut servir une tete
 * en retard d'un commit sur l'API, et la version comparee doit venir de la meme
 * source que sa date.
 */
export async function upstreamLag(
  alias: string,
  scalingo: string,
  get: GetText,
  ghJson: <T>(path: string) => Promise<T | null>,
): Promise<{ lag: Lag | null } | { unreadable: string }> {
  const head = await readInventory(`${RAW}/${JVM_UPSTREAM}/HEAD/inventory.json`, get);
  if (!head) return { unreadable: `inventaire de ${JVM_UPSTREAM} illisible` };
  const atHead = head.version_aliases[alias];
  if (!atHead || cmpJdk(atHead, scalingo) <= 0) return { lag: null };

  const commits = await ghJson<Array<{ sha?: string; commit?: { committer?: { date?: string } } }>>(
    `/repos/${JVM_UPSTREAM}/commits?path=inventory.json&per_page=${HISTORY}`,
  );
  let upstream: string | null = null;
  let since: string | null = null;
  let atLeast = false;
  for (const [i, c] of (Array.isArray(commits) ? commits : []).entries()) {
    const then = typeof c?.sha === "string" && /^[0-9a-f]{40}$/.test(c.sha)
      ? await readInventory(`${RAW}/${JVM_UPSTREAM}/${c.sha}/inventory.json`, get)
      : null;
    if (!then) {
      atLeast = since !== null;
      break;
    }
    const value = then.version_aliases[alias];
    if (i === 0) {
      if (!value || cmpJdk(value, scalingo) <= 0) return { lag: null };
      upstream = value;
    }
    if (value !== upstream) break;
    since = c.commit?.committer?.date ?? null;
    atLeast = i === commits!.length - 1;
  }
  return { lag: { alias, scalingo, upstream: upstream ?? atHead, since, atLeast } };
}
