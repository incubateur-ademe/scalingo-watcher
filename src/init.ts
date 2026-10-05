/**
 * Ecrit un premier manifeste depuis l'etat reel de Scalingo, sans rien y modifier.
 *
 *   pnpm run init --region osc-fr1 --region osc-secnum-fr1
 *   node src/init.ts --region osc-fr1 --app metabase      # apps dont le nom contient metabase
 *   node src/init.ts --region osc-fr1 --manifest parc/manifest.yaml --force
 *
 * `pnpm init`, sans `run`, est la commande de pnpm qui cree un package.json :
 * elle ne lance pas ce script.
 *
 * Retient chaque app dont une variable d'environnement designe un outil de la
 * table UPSTREAM, et la decrit telle qu'elle tourne : version de l'outil, depot
 * et branche lies a l'app, sha du deploiement le plus recent, version de sa base
 * PostgreSQL. Un manifeste existant n'est ecrase qu'avec --force.
 *
 * Le lock n'est pas touche. La commande d'amorcage (apply.ts --adopt) est
 * affichee, a lancer apres relecture de l'ordre des apps.
 *
 * Acces : SCALINGO_API_TOKEN, ou FGP_KEY et le fichier de --fgp. Derriere le
 * proxy, la version d'une base ne se lit qu'avec le blob de sauvegarde de son
 * app : sans lui, la base reste hors du manifeste, surveillee sans etre pilotee.
 *
 * SECRETS : /variables rend tout l'environnement de l'app en clair. Seule la
 * variable de l'outil en est retenue.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  apiHost,
  checkFleetData,
  deployedSha,
  findDatabaseAddons,
  lastDeployment,
  openAccess,
  pool,
  proxyUrl,
  readDatabaseVersion,
  reqApi,
  schemaErrors,
  type AppRef,
} from "./apply.ts";
import { FLOATING, REGION_NAME } from "./audit.ts";
import { accessModes, flagValue, flagValues, resolvePaths, shown, type Paths } from "./options.ts";
import { toolName, UPSTREAM } from "./upstream.ts";

export type InitEntry = AppRef & {
  backup?: "not-available";
  database?: string;
  source: { repo: string; branch: string; sha: string };
  tool: { env: string; version: string; upstream: string };
};

type Described = InitEntry & { notes: string[] };
type Outcome = { found: Described } | { skipped: string } | { failed: string } | null;
type RepoLink = { owner: string; repo: string; branch: string; scm_type: string };

const CONCURRENCY = 5;
const log = (...a: unknown[]) => console.log(...a);

function fail(message: string, details: string[] = []): never {
  log(message);
  for (const line of details) log(line);
  process.exit(1);
}

/**
 * Le manifeste vit dans un autre depot que le moteur : il pointe le schema de
 * la version qui l'a genere, au tag de sa release. Avant la premiere release,
 * ou depuis un clone pris entre deux releases, ce tag n'existe pas : l'URL
 * serait un 404 que l'editeur ignore sans rien dire.
 */
async function schemaUrl(): Promise<string> {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string;
    repository?: string | { url?: string };
  };
  const repository = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "");
  const slug = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(repository)?.[1];
  if (!slug) throw new Error("package.json ne designe aucun depot GitHub : l'URL du schema ne peut pas etre construite");
  const base = `https://raw.githubusercontent.com/${slug}`;
  const tagged = `${base}/v${pkg.version}/schema/manifest.schema.json`;
  try {
    if ((await fetch(tagged, { method: "HEAD" })).ok) return tagged;
  } catch {
    // injoignable : traite comme absent
  }
  log(`(aucun schema publie au tag v${pkg.version} : $schema pointe la branche main, a epingler sur un tag de release)`);
  return `${base}/main/schema/manifest.schema.json`;
}

/** Valeur YAML lue a l'identique, guillemets compris quand elle se lirait comme un nombre. */
const scalar = (value: string) => stringify(value, { lineWidth: 0 }).trimEnd();

/**
 * Texte du manifeste. Les annotations `# renovate:` suivent a la lettre la forme
 * que lisent les customManagers : une ligne de plus entre `branch:` et la sienne
 * suffit a couper la veille du sha.
 */
export function renderManifest(entries: readonly InitEntry[], schema: string): string {
  const lines = [
    `# yaml-language-server: $schema=${schema}`,
    "# Intention : ce qu'on veut voir tourner sur le parc.",
    "# Ce que le parc fait reellement vit dans le lock, ecrit par le job d'apply.",
    "#",
    "# Genere par init depuis l'etat reel de Scalingo, apps rangees par region puis",
    "# par nom. L'ordre des entrees de `apps` EST l'ordre de deploiement, du moins",
    "# critique au plus critique : la premiere sert d'eclaireur, et si elle echoue",
    "# la vague s'arrete. A reordonner avant le premier apply.",
    "#",
    "# Les lignes d'annotation qui precedent `sha:` et `version:` ne sont pas",
    "# decoratives : elles portent la datasource et le depName que Renovate lit via",
    "# ses customManagers. Les supprimer coupe la veille sur la ligne qui suit.",
    "",
    "defaults:",
    "  policy:",
    "    minor: auto",
    "    major: pr",
    "  backup: required",
    "",
    "apps:",
  ];
  entries.forEach((e, i) => {
    if (i > 0) lines.push("");
    lines.push(`  - app: ${scalar(e.app)}`, `    region: ${scalar(e.region)}`);
    if (e.backup) {
      lines.push("    # aucun addon de base releve par init : deploiement sans sauvegarde, a confirmer", `    backup: ${e.backup}`);
    }
    if (e.database) lines.push("    database:", `      version: ${scalar(e.database)}`);
    lines.push(
      "    source:",
      `      repo: ${scalar(e.source.repo)}`,
      `      branch: ${scalar(e.source.branch)}`,
      `      # renovate: datasource=git-refs depName=${e.source.repo}`,
      `      sha: ${e.source.sha}`,
      "    tool:",
      `      env: ${e.tool.env}`,
      `      # renovate: datasource=github-releases depName=${e.tool.upstream}`,
      `      version: ${scalar(e.tool.version)}`,
    );
  });
  return lines.join("\n") + "\n";
}

/** Depot lie a l'app sur Scalingo, ou null si elle n'en a pas. */
async function repoLink(ref: AppRef): Promise<RepoLink | null> {
  try {
    const { scm_repo_link } = await reqApi<{ scm_repo_link: RepoLink | null }>(
      `${apiHost(ref.region)}/v1/apps/${ref.app}/scm_repo_link`,
      ref.region,
    );
    return scm_repo_link ?? null;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

/**
 * Le deploiement ne dit que le commit : le depot et la branche viennent du lien
 * de l'app a son depot. Le sha est celui que --adopt relevera, pour que le plan
 * qui suit l'amorcage ne voie aucun ecart.
 */
async function describeApp(ref: AppRef): Promise<Outcome> {
  const { variables } = await reqApi<{ variables: Array<{ name: string; value: string }> }>(
    `${apiHost(ref.region)}/v1/apps/${ref.app}/variables`,
    ref.region,
  );
  const tools = Object.keys(UPSTREAM).flatMap((env) => {
    const version = variables.find((v) => v.name === env)?.value;
    return version === undefined ? [] : [{ env, version }];
  });
  if (tools.length === 0) return null;
  const [tool, ...others] = tools;
  const notes =
    others.length > 0 ? [`${others.map((t) => t.env).join(", ")} ignoree(s) : le manifeste ne porte qu'un outil par app`] : [];
  if (FLOATING.has(tool.version.trim())) {
    return { skipped: `${tool.env}="${tool.version}" n'est pas une version epinglee, a poser avant de relancer` };
  }

  const last = await lastDeployment(ref);
  const sha = deployedSha(last);
  if (!last) return { skipped: "jamais deployee" };
  if (!sha) return { skipped: `git_ref "${last.git_ref ?? "absent"}" du dernier deploiement, pas un sha complet` };
  if (last.status !== "success") notes.push(`dernier deploiement en ${last.status} : son sha est retenu, comme le fera --adopt`);

  const link = await repoLink(ref);
  if (!link) return { skipped: "aucun depot lie a l'app (scm_repo_link) : source a declarer a la main" };
  if (link.scm_type !== "github") return { skipped: `depot lie sur ${link.scm_type} : le moteur ne deploie que depuis GitHub` };

  return {
    found: {
      ...ref,
      source: { repo: `${link.owner}/${link.repo}`, branch: link.branch, sha },
      tool: { ...tool, upstream: UPSTREAM[tool.env].repo },
      notes,
    },
  };
}

/** Base pilotee si l'app en a une seule, PostgreSQL, et lisible. */
async function describeDatabase(entry: Described): Promise<void> {
  const addons = await findDatabaseAddons(entry);
  if (addons.length === 0) {
    entry.backup = "not-available";
    entry.notes.push("aucun addon de base : backup not-available, a confirmer");
    return;
  }
  if (addons.length > 1) {
    entry.notes.push(`${addons.length} bases sur l'app : aucune n'est pilotee, le manifeste n'en designe qu'une`);
    return;
  }
  const provider = addons[0].addon_provider?.id ?? addons[0].addon_provider?.name ?? "";
  if (!/postgres/i.test(provider)) {
    entry.notes.push(`base ${provider} : init ne pilote que PostgreSQL, elle reste surveillee`);
    return;
  }
  const read = await readDatabaseVersion(entry, addons[0].id);
  if (!read) {
    entry.notes.push(
      proxyUrl()
        ? "version de base illisible, sans doute faute de blob de sauvegarde pour l'app : elle reste surveillee"
        : "version de base illisible : elle reste surveillee",
    );
    return;
  }
  entry.database = read.version;
}

function adoptCommand(paths: Paths): string {
  const defaults = resolvePaths([]);
  const flags = (["manifest", "lock", "fgp"] as const)
    .filter((k) => paths[k] !== defaults[k])
    .map((k) => ` --${k} ${shown(paths[k])}`);
  return `node ${shown(join(import.meta.dirname, "apply.ts"))} --adopt${flags.join("")}`;
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = resolvePaths(argv);
  const regions = [...new Set(flagValues(argv, "--region"))];
  const fragment = flagValue(argv, "--app");

  if (regions.length === 0) fail("Preciser les regions a parcourir : --region osc-fr1, option repetable.");
  const invalid = regions.filter((r) => !REGION_NAME.test(r));
  if (invalid.length > 0) fail(`Region invalide : ${invalid.join(", ")}. Attendu : minuscules, chiffres et tirets.`);
  if (existsSync(paths.manifest) && !argv.includes("--force")) {
    fail(`${shown(paths.manifest)} existe deja : init ne l'ecrase qu'avec --force.`);
  }
  if (!openAccess(paths)) fail("Aucun acces configure.", accessModes(paths.fgp));
  const proxy = proxyUrl();
  if (proxy) log(`Acces par le proxy ${proxy}`);

  const outcomes: Array<{ ref: AppRef; outcome: Outcome }> = [];
  for (const region of regions) {
    // Une region illisible ferait un manifeste qui l'omet sans le dire.
    const { apps } = await reqApi<{ apps: Array<{ name: string }> }>(`${apiHost(region)}/v1/apps`, region);
    const refs = apps
      .filter((a) => !fragment || a.name.includes(fragment))
      .map((a) => ({ app: a.name, region }))
      .sort((a, b) => a.app.localeCompare(b.app));
    log(`${region} : ${apps.length} app(s)${fragment ? `, ${refs.length} contenant "${fragment}"` : ""}`);
    outcomes.push(
      ...(await pool(refs, CONCURRENCY, async (ref) => ({
        ref,
        outcome: await describeApp(ref).catch((e: Error): Outcome => ({ failed: e.message.slice(0, 160) })),
      }))),
    );
  }

  const failed = outcomes.flatMap(({ ref, outcome }) =>
    outcome && "failed" in outcome ? [{ ref, reason: outcome.failed }] : [],
  );
  const found: Described[] = [];
  // Comme dans l'audit : menees de front, les lectures de base portaient la
  // charge du proxy a une vingtaine de requetes simultanees, et Scalingo
  // repondait 504.
  for (const { ref, outcome } of outcomes) {
    if (!outcome || !("found" in outcome)) continue;
    try {
      await describeDatabase(outcome.found);
      found.push(outcome.found);
    } catch (e) {
      failed.push({ ref, reason: `bases illisibles : ${(e as Error).message.slice(0, 140)}` });
    }
  }
  const skipped = outcomes.flatMap(({ ref, outcome }) =>
    outcome && "skipped" in outcome ? [{ ref, reason: outcome.skipped }] : [],
  );
  const withoutTool = outcomes.filter(({ outcome }) => outcome === null).length;

  const key = (ref: AppRef) => `${ref.region}/${ref.app}`;
  log(`\nRetenues : ${found.length}`);
  for (const e of found) {
    log(
      `  ${key(e)} : ${toolName(e.tool.env)} ${e.tool.version} @ ${e.source.sha.slice(0, 7)} (${e.source.repo}, ${e.source.branch})` +
        (e.database ? `, base ${e.database}` : ""),
    );
    for (const note of e.notes) log(`    ${note}`);
  }
  if (skipped.length > 0) {
    log(`\nEcartees : ${skipped.length}`);
    for (const { ref, reason } of skipped) log(`  ${key(ref)} : ${reason}`);
  }
  if (failed.length > 0) {
    log(`\nReleve impossible : ${failed.length}`);
    for (const { ref, reason } of failed) log(`  ${key(ref)} : ${reason}`);
  }
  if (withoutTool > 0) log(`\n${withoutTool} app(s) sans variable d'outil connu, ignoree(s).`);

  if (found.length === 0) fail(`\nAucune app a decrire : ${shown(paths.manifest)} n'est pas ecrit.`);

  const source = renderManifest(found, await schemaUrl());
  const manifest = parse(source);
  const problems = [
    ...schemaErrors(manifest),
    ...checkFleetData(source, manifest, { version: 1, generatedAt: null, apps: {} }),
  ];
  if (problems.length > 0) {
    fail(`\nManifeste genere incoherent, ${shown(paths.manifest)} n'est pas ecrit :`, problems.map((p) => `  ${p}`));
  }
  mkdirSync(dirname(paths.manifest), { recursive: true });
  // Le controle du debut evite les appels inutiles ; celui-ci ferme la fenetre
  // ou un manifeste serait apparu entre-temps.
  try {
    writeFileSync(paths.manifest, source, { flag: argv.includes("--force") ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    fail(`${shown(paths.manifest)} est apparu pendant le releve : init ne l'ecrase qu'avec --force.`);
  }

  log(`\n${shown(paths.manifest)} ecrit : ${found.length} app(s), rangees par region puis par nom.`);
  log("Relire leur ordre, qui est celui du deploiement, puis amorcer le lock depuis l'etat reel, sans rien deployer :");
  log(`  ${adoptCommand(paths)}`);

  if (failed.length > 0) {
    log(`\n${failed.length} app(s) manquent au manifeste faute de releve : relancer avec --force une fois l'acces retabli.`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    log(`\nEchec: ${(e as Error).message}`);
    process.exit(1);
  });
}
