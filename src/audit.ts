import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { resolveAliases } from "./apply.ts";
import { accessModes, flagValue, flagValues, readFgpFile, resolvePaths, shown, type Fgp } from "./options.ts";
import { compareLines, lineLabel, upstreamOf, type ToolDeclaration, type Upstream } from "./upstream.ts";

/**
 * Audit du parc Scalingo : état des buildpacks et des versions applicatives.
 *
 * STRICTEMENT EN LECTURE. Le seul POST est l'échange de token d'auth, qui ne
 * modifie rien. Aucune variable, aucun déploiement, aucune app n'est touché.
 *
 * Usage :
 *   export SCALINGO_API_TOKEN=tk-us-xxxxxxxx
 *   node src/audit.ts                              # tout le parc, rendu lisible
 *   node src/audit.ts --app metabase               # filtre sur le nom d'app
 *   node src/audit.ts --region osc-fr1              # region hors manifeste, option repetable
 *   node src/audit.ts --json > inventory.json      # inventaire machine sur stdout
 *   node src/audit.ts --no-build-log               # skip le parsing des logs de build (plus rapide)
 *
 * Les regions auditees sont celles passees par --region, a defaut celles du
 * manifeste (--manifest).
 *
 * Optionnel : GITHUB_TOKEN pour éviter le rate-limit de l'API GitHub
 * (60 req/h en anonyme, largement suffisant sauf gros parc).
 *
 * SECRETS : GET /v1/apps/:app/variables renvoie TOUTES les variables en clair,
 * secrets compris. Ce script applique une whitelist stricte a la lecture
 * (voir keepVariable) : seuls BUILDPACK_URL et les cles *_VERSION sont
 * conserves en memoire et dans la sortie JSON. Ne pas assouplir sans réfléchir
 * a ou finit la sortie.
 */

/**
 * Comme apply.ts : par le proxy si fgp.json et FGP_KEY sont la, en direct sinon.
 * L'audit ne lit que des routes GET, couvertes par les scopes du blob d'API.
 */
let fgp: Fgp | null = null;
let fgpKey = "";

function loadFgp(file: string): void {
  fgpKey = process.env.FGP_KEY ?? "";
  if (fgpKey) fgp = readFgpFile(file);
}

function scalingoHeaders(region: string, token: string): Record<string, string> {
  if (fgp) {
    return { "X-FGP-Key": fgpKey, "X-FGP-Blob": fgp.api[region], Accept: "application/json" };
  }
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

const hostFor = (region: Region) => (fgp ? fgp.url : region.api);

type Region = { name: string; api: string };

// Le nom de region finit dans un nom d'hote : rien d'autre n'y entre.
export const REGION_NAME = /^[a-z0-9-]+$/;
const regionOf = (name: string): Region => ({ name, api: `https://api.${name}.scalingo.com` });

/**
 * Depot amont d'une variable de version : celui que le manifeste declare pour
 * cette app, sinon celui de la table UPSTREAM. Le nom du depot buildpack donne
 * la variable (<name>-buildpack -> <NAME>_VERSION), mais rien ne dit ou l'outil
 * publie ses versions. Resolu app par app, comme le fait apply : deux apps
 * peuvent lire la meme variable et publier ailleurs.
 */
let declaredUpstreams = new Map<string, Upstream>();
export const upstreamKey = (region: string, app: string, env: string) => `${region}/${app}/${env}`;
const upstreamFor = (region: string, app: string, envName: string) =>
  declaredUpstreams.get(upstreamKey(region, app, envName)) ?? upstreamOf({ env: envName });

type FleetApp = { app?: unknown; region?: unknown; tool?: ToolDeclaration };

/** Ce que le manifeste du parc apprend a l'audit. Absent, l'audit s'en passe. */
function readFleet(file: string): { apps: FleetApp[] } | null {
  if (!existsSync(file)) return null;
  const manifest = parse(readFileSync(file, "utf8")) as { apps?: FleetApp[] } | null;
  resolveAliases(manifest);
  return { apps: Array.isArray(manifest?.apps) ? manifest.apps : [] };
}

const regionsDeclared = (apps: FleetApp[]) =>
  [...new Set(apps.map((a) => a.region).filter((r): r is string => typeof r === "string"))].sort();

export function upstreamsDeclared(apps: FleetApp[]): Map<string, Upstream> {
  const out = new Map<string, Upstream>();
  for (const { app, region, tool } of apps) {
    const declared = tool?.upstream ? upstreamOf(tool) : null;
    if (declared && typeof app === "string" && typeof region === "string") {
      out.set(upstreamKey(region, app, tool!.env), declared);
    }
  }
  return out;
}

const CONCURRENCY = 5;
const BUILD_LOG_MAX_BYTES = 512 * 1024;
const RELEASE_PAGES = 5;
const DORMANT_DAYS = 180;

/**
 * Constats possibles, dans l'ordre ou ils sont rendus.
 *
 * Une seule table plutot que trois declarations separees : le type, le libelle
 * et l'ordre d'affichage. Un constat ajoute au type mais oublie dans l'ordre
 * etait collecte puis jamais affiche, ce qui est arrive et ne se voyait pas.
 */
const FINDINGS = [
  ["missing-version-env", "Variable de version absente (la version est resolue au build)"],
  ["floating-version-env", "Variable de version flottante (* ou latest)"],
  ["unpinned-buildpack", "Buildpack non pinne (suit la branche par defaut)"],
  ["outdated", "Version en retard dans sa ligne majeure"],
  ["outdated-major-line", "Ligne majeure en retard (a arbitrer, pas forcement un bug)"],
  ["major-line-not-published", "Ligne majeure absente des releases upstream (retard non calculable)"],
  ["database-upgradable", "Base de donnees : une version plus recente existe (aucune echeance connue)"],
  ["last-deploy-failed", "Dernier deploiement en echec"],
  ["never-deployed", "Jamais deployee"],
  ["not-running", "Application arretee ou en echec (hors perimetre de deploiement)"],
  ["dormant", `Aucun deploiement depuis plus de ${DORMANT_DAYS} jours`],
  ["unknown-upstream", "Source de releases inconnue (mapping a completer)"],
  ["collect-error", "Erreurs de collecte"],
] as const;

type FindingKind = (typeof FINDINGS)[number][0];

type Finding = { kind: FindingKind; app: string; region: string; detail: string };

type BuildpackUse = { url: string; owner: string | null; repo: string | null; ref: string | null };

type AppReport = {
  name: string;
  region: string;
  id: string;
  status: string | null;
  buildpackUrl: string | null;
  buildpacks: BuildpackUse[];
  buildpackSource: "build-log" | "buildpack-url" | "none";
  versionEnv: Record<string, string>;
  products: ProductReport[];
  lastDeployment: { id: string; status: string; createdAt: string; gitRef: string | null } | null;
  databases: Array<{ version: string; upgradable: boolean }>;
  errors: string[];
};

type ProductReport = {
  product: string;
  envName: string;
  declared: string | null;
  upstreamRepo: string | null;
  latestSameMajor: string | null;
  latestOverall: string | null;
  behind: boolean;
  floating: boolean;
};

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const hasFlag = (f: string) => argv.includes(f);

// Les options a valeur sont lues en tete de main() : le module est aussi
// importe par init, dont les options ne le concernent pas.
const OPT = {
  json: hasFlag("--json"),
  appFilter: null as string | null,
  regions: [] as string[],
  buildLog: !hasFlag("--no-build-log"),
};

const log = (...a: unknown[]) => console.error(...a);

// ---------------------------------------------------------------- http

async function httpJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} on ${url}${body ? ` :: ${body.slice(0, 300)}` : ""}`);
  }
  return (await res.json()) as T;
}

function bearer(token: string, region = ""): RequestInit {
  return { headers: scalingoHeaders(region, token) };
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- scalingo auth

async function exchangeToken(apiToken: string): Promise<string> {
  const basic = Buffer.from(`:${apiToken}`).toString("base64");
  const res = await fetch("https://auth.scalingo.com/v1/tokens/exchange", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status} ${res.statusText}. Verifie SCALINGO_API_TOKEN (format tk-us-...).`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("token exchange: reponse sans champ 'token'");
  return body.token;
}

// ---------------------------------------------------------------- github

async function githubJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "scalingo-watcher-audit",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return httpJson<T>(`https://api.github.com${path}`, { headers });
}

/** Repos *-buildpack de l'org Scalingo. Sert a reconnaitre un buildpack officiel. */
async function fetchScalingoBuildpacks(): Promise<Set<string>> {
  const names = new Set<string>();
  for (let page = 1; page <= 4; page++) {
    const repos = await githubJson<Array<{ name: string; archived: boolean }>>(
      `/orgs/Scalingo/repos?per_page=100&page=${page}`,
    );
    for (const r of repos) if (r.name.endsWith("-buildpack")) names.add(r.name);
    if (repos.length < 100) break;
  }
  return names;
}

const releaseCache = new Map<string, Array<{ tag: string; at: string }>>();

async function fetchReleaseTags(repo: string): Promise<Array<{ tag: string; at: string }>> {
  const cached = releaseCache.get(repo);
  if (cached) return cached;
  // Sans pagination, une app restee sur une ligne majeure ancienne ne trouve
  // aucune release de sa ligne et passe pour non publiee en amont.
  const tags: Array<{ tag: string; at: string }> = [];
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const releases = await githubJson<
      Array<{ tag_name: string; draft: boolean; prerelease: boolean; published_at: string }>
    >(`/repos/${repo}/releases?per_page=100&page=${page}`);
    tags.push(
      ...releases
        .filter((r) => !r.draft && !r.prerelease)
        .map((r) => ({ tag: r.tag_name, at: r.published_at })),
    );
    if (releases.length < 100) break;
  }
  releaseCache.set(repo, tags);
  return tags;
}

// ---------------------------------------------------------------- versions

type Semver = { major: number; minor: number; patch: number };

function parseVersion(raw: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

function compareVersion(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

const parts = (v: Semver) => [v.major, v.minor, v.patch];

/**
 * Un outil peut publier plusieurs lignes en parallele, comme Metabase avec
 * v0.x pour l'OSS et v1.x pour l'EE. Comparer une v0 a une v1 n'a aucun sens,
 * d'ou le "latest dans la meme ligne" en plus du latest absolu.
 */
function resolveLatest(tags: Array<{ tag: string; at: string }>, current: Semver | null, line: number) {
  let latestOverall: { raw: string; v: Semver; at: string } | null = null;
  let latestSameMajor: { raw: string; v: Semver; at: string } | null = null;
  for (const { tag: raw, at } of tags) {
    const v = parseVersion(raw);
    if (!v) continue;
    if (!latestOverall || compareVersion(v, latestOverall.v) > 0) latestOverall = { raw, v, at };
    if (current && compareLines(parts(v), parts(current), line) === 0) {
      if (!latestSameMajor || compareVersion(v, latestSameMajor.v) > 0) latestSameMajor = { raw, v, at };
    }
  }
  return { latestOverall, latestSameMajor };
}

// ---------------------------------------------------------------- collecte

export const FLOATING = new Set(["*", "latest", ""]);

function keepVariable(name: string): boolean {
  return name === "BUILDPACK_URL" || /^[A-Z0-9_]+_VERSION$/.test(name);
}

function envToProduct(envName: string): string {
  return envName.replace(/_VERSION$/, "");
}

function productToBuildpackRepo(product: string): string {
  return `${product.toLowerCase().replace(/_/g, "-")}-buildpack`;
}

/** Les deux conventions de nommage rencontrees : x-buildpack et buildpack-x. */
function buildpackVersionPrefix(repo: string): string | null {
  let base: string | null = null;
  if (repo.endsWith("-buildpack")) base = repo.slice(0, -"-buildpack".length);
  else if (repo.startsWith("buildpack-")) base = repo.slice("buildpack-".length);
  if (!base || base === "multi") return null;
  return base.toUpperCase().replace(/-/g, "_");
}

const probeCache = new Map<string, string | null>();

/**
 * Tous les buildpacks n'exposent pas une variable de version, et le nom du depot
 * ne permet pas de le deviner : nodejs lit engines.node dans package.json,
 * python lit .python-version, apt n'a pas de version du tout (son APT_VERSION
 * est une variable interne au script, pas une entree de configuration).
 * Seuls les buildpacks qui installent un binaire tiers versionne exposent
 * l'expansion `${X_VERSION:-defaut}`. On lit donc le bin/compile du buildpack
 * plutot que de maintenir une liste : ca couvre aussi les buildpacks custom.
 */
async function probeVersionEnv(owner: string, repo: string, ref: string | null): Promise<string | null> {
  const prefix = buildpackVersionPrefix(repo);
  if (!prefix) return null;
  const key = `${owner}/${repo}@${ref ?? "default"}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;

  const envName = `${prefix}_VERSION`;
  let found: string | null = null;
  let read = false;
  for (const branch of ref ? [ref] : ["master", "main"]) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/bin/compile`);
      if (!res.ok) continue;
      const src = await res.text();
      read = true;
      if (new RegExp(`\\$\\{${envName}:-`).test(src)) found = envName;
      break;
    } catch {
      // reseau indisponible : distinct d'un buildpack sans variable de version
    }
  }
  // Ne memoriser que ce qu'on a reellement lu. Cacher l'echec ferait disparaitre
  // silencieusement de l'inventaire toutes les apps utilisant ce buildpack.
  if (read) probeCache.set(key, found);
  return found;
}

function parseBuildpackUrl(url: string): BuildpackUse {
  const [bare, ref] = url.split("#");
  const m = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?$/.exec(bare);
  return {
    url,
    owner: m ? m[1] : null,
    repo: m ? m[2] : null,
    ref: ref && ref.length > 0 ? ref : null,
  };
}

/**
 * multi-buildpack log un "Downloading Buildpack: <url>" par entree du .buildpacks,
 * suivi d'un "Using branch: <ref>" UNIQUEMENT si un ref est specifie. L'absence
 * de cette ligne est donc la detection fiable d'un buildpack non pinne, et c'est
 * la seule facon de voir le contenu du .buildpacks depuis l'API (il n'est pas
 * expose autrement).
 */
function parseBuildpacksFromLog(output: string): BuildpackUse[] {
  const found: BuildpackUse[] = [];
  for (const line of output.split("\n")) {
    const dl = /Downloading Buildpack:\s*(\S+)/.exec(line);
    if (dl) {
      found.push(parseBuildpackUrl(dl[1]));
      continue;
    }
    const br = /Using branch:\s*(\S+)/.exec(line);
    if (br && found.length > 0) found[found.length - 1].ref = br[1];
  }
  return found;
}

type ScalingoApp = { id: string; name: string; status?: string };

async function listApps(region: Region, token: string): Promise<ScalingoApp[]> {
  const body = await httpJson<{ apps: ScalingoApp[] }>(
    `${hostFor(region)}/v1/apps`,
    bearer(token, region.name),
  );
  return body.apps ?? [];
}

/**
 * Releve la version des bases, en serie et apres la collecte.
 *
 * Chaque appel a db-api coute deux requetes Scalingo au proxy : l'echange du
 * jeton de compte, puis l'obtention du jeton d'addon. Mene dans la collecte
 * parallele, cela portait la charge a une vingtaine de requetes simultanees et
 * Scalingo repondait 504. Il y a au plus huit bases a relever : les enchainer
 * ne coute que quelques secondes.
 */
async function collectDatabases(reports: AppReport[], token: string): Promise<void> {
  if (!fgp?.backup) return;
  for (const r of reports) {
    const blob = fgp.backup[`${r.region}/${r.name}`];
    if (!blob) continue;
    try {
      const { addons } = await httpJson<{
        addons: Array<{ id: string; addon_provider: { id: string; name: string } }>;
      }>(`${fgp.url}/v1/apps/${r.name}/addons`, bearer(token, r.region));
      for (const a of addons) {
        const type = a.addon_provider?.id ?? a.addon_provider?.name ?? "";
        if (!/postgres|mysql|mongo|redis/i.test(type)) continue;
        const db = await httpJson<{
          database: { readable_version: string; next_version_id: string | null };
        }>(`${fgp.url}/api/databases/${a.id}`, {
          headers: { "X-FGP-Key": fgpKey, "X-FGP-Blob": blob, Accept: "application/json" },
        });
        r.databases.push({
          version: db.database.readable_version,
          upgradable: Boolean(db.database.next_version_id),
        });
      }
    } catch (e) {
      r.errors.push(`bases illisibles : ${(e as Error).message.slice(0, 120)}`);
    }
  }
}

async function collectApp(app: ScalingoApp, region: Region, token: string): Promise<AppReport> {
  const report: AppReport = {
    name: app.name,
    region: region.name,
    id: app.id,
    status: app.status ?? null,
    buildpackUrl: null,
    buildpacks: [],
    buildpackSource: "none",
    versionEnv: {},
    products: [],
    lastDeployment: null,
    databases: [],
    errors: [],
  };

  try {
    const vars = await httpJson<{ variables: Array<{ name: string; value: string }> }>(
      `${hostFor(region)}/v1/apps/${app.name}/variables`,
      bearer(token, region.name),
    );
    for (const v of vars.variables ?? []) {
      if (!keepVariable(v.name)) continue;
      if (v.name === "BUILDPACK_URL") report.buildpackUrl = v.value;
      else report.versionEnv[v.name] = v.value;
    }
  } catch (e) {
    report.errors.push(`variables: ${(e as Error).message}`);
  }

  try {
    const deps = await httpJson<{
      deployments: Array<{ id: string; status: string; created_at: string; git_ref: string | null }>;
    }>(`${hostFor(region)}/v1/apps/${app.name}/deployments?per_page=1`, bearer(token, region.name));
    const last = (deps.deployments ?? [])[0];
    if (last) {
      report.lastDeployment = {
        id: last.id,
        status: last.status,
        createdAt: last.created_at,
        gitRef: last.git_ref ?? null,
      };
    }
  } catch (e) {
    report.errors.push(`deployments: ${(e as Error).message}`);
  }

  if (OPT.buildLog && report.lastDeployment) {
    try {
      const res = await fetch(
        `${hostFor(region)}/v1/apps/${app.name}/deployments/${report.lastDeployment.id}/output`,
        bearer(token, region.name),
      );
      if (res.ok) {
        const text = (await res.text()).slice(0, BUILD_LOG_MAX_BYTES);
        const fromLog = parseBuildpacksFromLog(text);
        if (fromLog.length > 0) {
          report.buildpacks = fromLog;
          report.buildpackSource = "build-log";
        }
      }
    } catch (e) {
      report.errors.push(`build log: ${(e as Error).message}`);
    }
  }

  if (report.buildpacks.length === 0 && report.buildpackUrl) {
    report.buildpacks = [parseBuildpackUrl(report.buildpackUrl)];
    report.buildpackSource = "buildpack-url";
  }

  return report;
}

// ---------------------------------------------------------------- analyse

async function analyse(report: AppReport, officialBuildpacks: Set<string>, findings: Finding[]) {
  const push = (kind: FindingKind, detail: string) =>
    findings.push({ kind, app: report.name, region: report.region, detail });

  for (const err of report.errors) push("collect-error", err);

  if (report.status && /^(stopped|crashed)$/.test(report.status)) {
    push("not-running", `etat "${report.status}" : le watcher ne la deploiera pas`);
  }

  if (!report.lastDeployment) push("never-deployed", "aucun deploiement trouve");
  else {
    if (!/success|done/i.test(report.lastDeployment.status)) {
      push(
        "last-deploy-failed",
        `dernier deploiement ${report.lastDeployment.status} le ${report.lastDeployment.createdAt.slice(0, 10)}`,
      );
    }
    const days = (Date.now() - Date.parse(report.lastDeployment.createdAt)) / 86_400_000;
    if (Number.isFinite(days) && days > DORMANT_DAYS) {
      push("dormant", `aucun deploiement depuis ${Math.round(days)} jours`);
    }
  }

  // Un produit n'est retenu que si le buildpack qui le porte expose reellement
  // une variable de version. Une variable *_VERSION applicative (JAVA_VERSION,
  // PONDERATION_VERSION...) qui ne correspond a aucun buildpack est ignoree.
  const expected = new Set<string>();
  for (const bp of report.buildpacks) {
    if (!bp.owner || !bp.repo) continue;
    const envName = await probeVersionEnv(bp.owner, bp.repo, bp.ref);
    if (envName) expected.add(envToProduct(envName));
    if (bp.repo !== "multi-buildpack" && bp.ref === null) {
      push("unpinned-buildpack", `${bp.owner}/${bp.repo}`);
    }
  }

  for (const db of report.databases) {
    if (db.upgradable) {
      push("database-upgradable", `base en ${db.version}, une version plus recente existe`);
    }
  }

  // Sans log de build exploitable, on retombe sur les variables declarees et on
  // verifie aupres du buildpack officiel correspondant qu'elles sont pertinentes.
  if (report.buildpacks.length === 0) {
    for (const envName of Object.keys(report.versionEnv)) {
      const repo = productToBuildpackRepo(envToProduct(envName));
      if (!officialBuildpacks.has(repo)) continue;
      if (await probeVersionEnv("Scalingo", repo, null)) expected.add(envToProduct(envName));
    }
  }

  for (const product of [...expected].sort()) {
    const envName = `${product}_VERSION`;
    const declared = report.versionEnv[envName] ?? null;
    const upstream = upstreamFor(report.region, report.name, envName);
    const upstreamRepo = upstream?.repo ?? null;

    const entry: ProductReport = {
      product,
      envName,
      declared,
      upstreamRepo,
      latestSameMajor: null,
      latestOverall: null,
      behind: false,
      floating: declared !== null && FLOATING.has(declared.trim()),
    };

    if (declared === null) {
      push(
        "missing-version-env",
        `${envName} absente alors que ${productToBuildpackRepo(product)} est utilise (version resolue au build)`,
      );
    } else if (FLOATING.has(declared.trim())) {
      push("floating-version-env", `${envName}="${declared}" : version resolue au build, non deterministe`);
    }

    if (!upstream) {
      push("unknown-upstream", `${product} : source de releases inconnue, retard non calculable`);
    } else {
      try {
        const tags = await fetchReleaseTags(upstream.repo);
        const current = declared && !FLOATING.has(declared.trim()) ? parseVersion(declared) : null;
        const { latestOverall, latestSameMajor } = resolveLatest(tags, current, upstream.line);
        entry.latestOverall = latestOverall?.raw ?? null;
        entry.latestSameMajor = latestSameMajor?.raw ?? null;

        if (current && latestSameMajor && compareVersion(current, latestSameMajor.v) < 0) {
          entry.behind = true;
          push("outdated", `${product} ${declared} -> ${latestSameMajor.raw} disponible`);
        }
        if (current && !latestSameMajor) {
          push(
            "major-line-not-published",
            `${product} ${declared} : aucune release ${lineLabel(parts(current), upstream.line)}.x publiee sur ${upstream.repo}, retard non calculable`,
          );
        }
        // Une ligne superieure ne signifie pas une version plus recente : chez
        // Metabase le premier composant designe l'edition, 0 pour l'OSS et 1
        // pour l'Enterprise, deux lignes publiees en parallele. v1.52.2 date de
        // 2024 quand v0.63.16 date de 2026. On ne signale donc l'ecart que si la
        // ligne superieure est aussi plus recente dans le temps.
        if (
          current &&
          latestOverall &&
          latestSameMajor &&
          compareLines(parts(latestOverall.v), parts(current), upstream.line) > 0 &&
          Date.parse(latestOverall.at) > Date.parse(latestSameMajor.at)
        ) {
          push(
            "outdated-major-line",
            `${product} est en ligne majeure ${lineLabel(parts(current), upstream.line)}.x, ${latestOverall.raw} existe en amont et est plus recente`,
          );
        }
      } catch (e) {
        push("collect-error", `releases ${upstream.repo}: ${(e as Error).message}`);
      }
    }

    report.products.push(entry);
  }
}

// ---------------------------------------------------------------- rendu

function render(reports: AppReport[], findings: Finding[]) {
  log("");
  log("=".repeat(72));
  log(`INVENTAIRE  (${reports.length} app${reports.length > 1 ? "s" : ""} concernee${reports.length > 1 ? "s" : ""})`);
  log("=".repeat(72));

  for (const r of reports) {
    log("");
    log(`${r.region}/${r.name}${r.status && r.status !== "running" ? `   [${r.status}]` : ""}`);
    const dep = r.lastDeployment;
    log(
      `  dernier deploiement : ${dep ? `${dep.status} le ${dep.createdAt.slice(0, 10)}${dep.gitRef ? ` (${dep.gitRef})` : ""}` : "aucun"}`,
    );
    if (r.buildpacks.length === 0) log("  buildpacks          : non determines");
    else {
      log(`  buildpacks          : (source: ${r.buildpackSource})`);
      for (const bp of r.buildpacks) {
        const label = bp.owner && bp.repo ? `${bp.owner}/${bp.repo}` : bp.url;
        log(`    - ${label} ${bp.ref ? `@ ${bp.ref}` : "@ <non pinne>"}`);
      }
    }
    for (const db of r.databases) {
      log(`  base                : ${db.version}${db.upgradable ? "  =>  une version plus recente est disponible" : "  (a jour)"}`);
    }
    if (r.products.length === 0) log("  versions            : aucune");
    for (const p of r.products) {
      const cur = p.declared ?? "<absente>";
      let target = "";
      if (p.declared === null) target = "  (version resolue au build)";
      else if (p.floating) target = "  (flottante : version resolue au build)";
      else if (!p.upstreamRepo) target = "  (upstream inconnu)";
      else if (p.latestOverall === null) target = "  (aucune release lisible en amont)";
      else if (p.latestSameMajor === null) target = `  (ligne majeure non publiee en amont, derniere vue: ${p.latestOverall})`;
      else if (p.behind) target = `  =>  ${p.latestSameMajor}`;
      else target = "  (a jour)";
      log(`  ${p.envName.padEnd(28)} ${cur}${target}`);
    }
  }

  const byKind = new Map<FindingKind, Finding[]>();
  for (const f of findings) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }



  log("");
  log("=".repeat(72));
  log("CONSTATS");
  log("=".repeat(72));
  let total = 0;
  for (const [kind, title] of FINDINGS) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    total += list.length;
    log("");
    log(`${title}  [${list.length}]`);
    if (kind === "unpinned-buildpack") {
      const byBuildpack = new Map<string, string[]>();
      for (const f of list) {
        const apps = byBuildpack.get(f.detail) ?? [];
        apps.push(`${f.region}/${f.app}`);
        byBuildpack.set(f.detail, apps);
      }
      for (const [bp, apps] of [...byBuildpack].sort((a, b) => b[1].length - a[1].length)) {
        log(`  - ${bp}  (${apps.length} app${apps.length > 1 ? "s" : ""})`);
      }
    } else {
      for (const f of list) log(`  - ${f.region}/${f.app} : ${f.detail}`);
    }
  }
  if (total === 0) log("\nAucun constat. Le parc est deja conforme.");
  log("");
}

// ---------------------------------------------------------------- main

async function main() {
  const paths = resolvePaths(argv);
  OPT.appFilter = flagValue(argv, "--app");
  OPT.regions = flagValues(argv, "--region");
  loadFgp(paths.fgp);
  const apiToken = process.env.SCALINGO_API_TOKEN;
  if (!fgp && !apiToken) {
    log("Aucun acces configure.");
    for (const line of accessModes(paths.fgp)) log(line);
    process.exit(1);
  }
  if (fgp) log(`Acces par le proxy ${fgp.url}`);

  const fleet = readFleet(paths.manifest);
  declaredUpstreams = upstreamsDeclared(fleet?.apps ?? []);

  const regionNames = OPT.regions.length > 0 ? [...new Set(OPT.regions)] : regionsDeclared(fleet?.apps ?? []);
  if (regionNames.length === 0) {
    log(
      fleet
        ? `Aucune region declaree dans ${shown(paths.manifest)}. Preciser --region.`
        : `${shown(paths.manifest)} introuvable : preciser --region, ou --manifest.`,
    );
    process.exit(1);
  }
  const invalid = regionNames.filter((r) => !REGION_NAME.test(r));
  if (invalid.length > 0) {
    log(`Region invalide : ${invalid.join(", ")}. Attendu : minuscules, chiffres et tirets.`);
    process.exit(1);
  }
  const regions = regionNames.map(regionOf);

  const token = fgp ? "" : (log("Echange du token..."), await exchangeToken(apiToken!));

  log("Recuperation des buildpacks officiels Scalingo...");
  let officialBuildpacks = new Set<string>();
  try {
    officialBuildpacks = await fetchScalingoBuildpacks();
    log(`  ${officialBuildpacks.size} buildpacks reconnus`);
  } catch (e) {
    log(`  echec (${(e as Error).message})`);
    log("  la detection par buildpack est desactivee, seules les env *_VERSION seront utilisees");
    log("  (definis GITHUB_TOKEN si c'est un rate-limit)");
  }

  const targets: Array<{ app: ScalingoApp; region: Region }> = [];
  for (const region of regions) {
    log(`Listing des apps sur ${region.name}...`);
    let apps: ScalingoApp[];
    try {
      apps = await listApps(region, token);
    } catch (e) {
      log(`  echec sur ${region.name}: ${(e as Error).message}`);
      continue;
    }
    const kept = OPT.appFilter ? apps.filter((a) => a.name.includes(OPT.appFilter!)) : apps;
    log(`  ${apps.length} app(s), ${kept.length} retenue(s)`);
    for (const app of kept) targets.push({ app, region });
  }

  if (targets.length === 0) {
    log("Aucune app a auditer.");
    process.exit(0);
  }

  log(`Collecte sur ${targets.length} app(s)...`);
  const all = await pool(targets, CONCURRENCY, (t) => collectApp(t.app, t.region, token));
  await collectDatabases(all, token);

  log("Croisement buildpacks / variables de version...");
  const allFindings: Finding[] = [];
  for (const r of all) await analyse(r, officialBuildpacks, allFindings);

  const relevant = all.filter((r) => r.products.length > 0);
  const kept = new Set(relevant.map((r) => `${r.region}/${r.name}`));
  const findings = allFindings.filter(
    (f) => f.kind === "collect-error" || kept.has(`${f.region}/${f.app}`),
  );
  log(`  ${relevant.length} app(s) portent un buildpack a version pilotable`);

  if (OPT.json) {
    process.stdout.write(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          regions: regions.map((r) => r.name),
          appsScanned: all.length,
          apps: relevant,
          findings,
        },
        null,
        2,
      ) + "\n",
    );
  }

  render(relevant, findings);
}

// Le module est aussi importe pour ses regles de lecture : sans ce garde,
// l'import lancerait un audit.
if (import.meta.main) {
  main().catch((e) => {
    log(`\nEchec: ${(e as Error).message}`);
    process.exit(1);
  });
}
