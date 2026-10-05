/**
 * Genere fgp.json : un blob par region pour l'API, un par app pour sa sauvegarde.
 *
 * A lancer une fois, en local, avec le jeton de compte. C'est le seul moment ou
 * ce jeton est manipule : il part chiffre dans les blobs et n'a plus a exister
 * ensuite, ni dans le depot ni dans les secrets.
 *
 *   export SCALINGO_API_TOKEN=tk-us-xxxxxxxx
 *   export FGP_KEY='<la cle que tu choisis, 24 caracteres minimum>'
 *   node src/fgp-blobs.ts                        # ecrit fgp.json
 *   node src/fgp-blobs.ts --dry-run              # montre ce qui serait genere
 *   node src/fgp-blobs.ts --url https://fgp...   # pour un autre proxy
 *
 * Le proxy vise est --url, sinon FGP_URL, sinon celui du fgp.json existant,
 * sinon le proxy par defaut. Son adresse est ecrite dans fgp.json, ou le moteur
 * la relit.
 *
 * Relancer le script regenere tout : c'est ce qu'il faut faire pour changer de
 * cle, puisque la revocation consiste a rendre les anciens blobs inutilisables.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readManifest } from "./apply.ts";
import { DEFAULT_FGP_URL, flagValue, outFile, readFgpFile, resolvePaths, shown } from "./options.ts";

// Ce que le watcher fait, et rien de plus. Notamment aucun DELETE, aucune
// creation d'app, aucun changement de stack, aucun scale.
const API_SCOPES = [
  "GET:/v1/apps",
  "GET:/v1/apps/*",
  // Les stacks portent leur date de depreciation : c'est ce qui permet de voir
  // venir une echeance plutot que de la subir.
  "GET:/v1/features/stacks",
  "POST:/v1/apps/*/deployments",
  "POST:/v1/apps/*/variables",
  "PATCH:/v1/apps/*/variables/*",
];
const BACKUP_SCOPES = [
  "GET|POST:/api/databases/*/backups",
  "GET:/api/databases/*",
  // Montee de version, decidee par une pull request qui bump le manifeste. Le
  // scope reste borne a cette route : ni suppression, ni changement de plan.
  "POST:/api/databases/*/upgrade",
  "GET:/api/database_type_versions/*",
  "GET:/api/operations/*",
];

type App = { app: string; region: string };

const dryRun = process.argv.includes("--dry-run");
// La capture ne porte que sur le body des requetes, jamais sur les reponses :
// celles de /variables contiennent tout l'environnement d'une app en clair et ne
// sont donc jamais enregistrees. Le body est chiffre avec la cle avant d'etre
// mis en memoire, le serveur ne peut pas le lire.
const logs = !process.argv.includes("--no-logs");
const token = process.env.SCALINGO_API_TOKEN;
const key = process.env.FGP_KEY;

if (!token || !key) {
  console.error("SCALINGO_API_TOKEN et FGP_KEY sont requis.");
  console.error("La cle doit faire entre 24 et 256 caracteres ASCII imprimables, sans espace.");
  process.exit(1);
}
if (key.length < 24) {
  console.error(`FGP_KEY fait ${key.length} caracteres, il en faut au moins 24.`);
  process.exit(1);
}

async function scalingoBearer(): Promise<string> {
  const res = await fetch("https://auth.scalingo.com/v1/tokens/exchange", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`:${token}`).toString("base64")}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`echange de jeton refuse : ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function databaseAddonId(app: App, bearer: string): Promise<string | null> {
  const res = await fetch(`https://api.${app.region}.scalingo.com/v1/apps/${app.app}/addons`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const { addons } = (await res.json()) as {
    addons: Array<{ id: string; addon_provider: { id: string; name: string } }>;
  };
  const db = addons.find((a) =>
    /postgres|mysql|mongo|redis/i.test(a.addon_provider?.id ?? a.addon_provider?.name ?? ""),
  );
  return db?.id ?? null;
}

/**
 * Reprendre le proxy du fichier existant evite qu'un simple changement de cle
 * fasse basculer le parc sur un autre proxy sans qu'on l'ait demande.
 */
function proxyUrl(argv: readonly string[], fgpFile: string): string {
  const flag = flagValue(argv, "--url");

  let existing: string | undefined;
  try {
    existing = readFgpFile(fgpFile)?.url;
  } catch {
    // fichier illisible : il va etre regenere, rien a reprendre
  }
  const raw = flag ?? process.env.FGP_URL ?? existing ?? DEFAULT_FGP_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`adresse de proxy illisible : ${raw}`);
  }
  // Le jeton de compte part dans le corps de chaque demande de generation.
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error(`le proxy doit etre servi en https : ${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

/** Depot qui recoit le secret : celui du workflow en CI, sinon le remote origin. */
function targetRepo(): string | null {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function generate(proxy: string, target: string, auth: unknown, scopes: string[], name: string): Promise<string> {
  const res = await fetch(`${proxy}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // ttl 0 : sans expiration. Un blob qui expire casserait la chaine un matin
    // sans prevenir, et la revocation se fait en changeant la cle.
    body: JSON.stringify({
      token,
      target,
      auth,
      key,
      scopes,
      ttl: 0,
      name,
      logs: { enabled: logs, detailed: logs },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  return ((await res.json()) as { blob: string }).blob;
}

async function main() {
  const paths = resolvePaths(process.argv.slice(2));
  const proxy = proxyUrl(process.argv.slice(2), paths.fgp);
  // Region et nom d'app entrent dans des URL qui portent le jeton du compte :
  // un manifeste non valide pourrait l'envoyer vers un autre hote.
  const { manifest, errors } = readManifest(paths.manifest);
  if (errors.length > 0) throw new Error(`${shown(paths.manifest)} invalide :\n  ${errors.join("\n  ")}`);
  const regions = [...new Set(manifest.apps.map((a) => a.region))].sort();

  console.log(`${manifest.apps.length} app(s), ${regions.length} region(s)`);
  console.log(`proxy ${proxy}`);
  console.log(logs ? "capture des journaux activee (body de requete uniquement)\n" : "journaux desactives\n");

  const bearer = await scalingoBearer();
  const out = { url: proxy, api: {} as Record<string, string>, backup: {} as Record<string, string> };

  for (const region of regions) {
    const target = `https://api.${region}.scalingo.com`;
    out.api[region] = dryRun
      ? "<blob>"
      : await generate(proxy, target, "scalingo-exchange", API_SCOPES, `api ${region}`);
    console.log(`  api ${region.padEnd(16)} ${target}`);
  }

  console.log("");
  for (const app of manifest.apps) {
    const key2 = `${app.region}/${app.app}`;
    const addonId = await databaseAddonId(app, bearer);
    if (!addonId) {
      console.log(`  ${key2.padEnd(44)} aucune base, pas de blob de sauvegarde`);
      continue;
    }
    out.backup[key2] = dryRun
      ? "<blob>"
      : await generate(
          proxy,
          `https://db-api.${app.region}.scalingo.com`,
          // Sans apiUrl, le proxy cherche l'addon sur sa region par defaut,
          // osc-fr1 : les blobs des autres regions echouaient en
          // auth_addon_failed, l'application n'y existant pas.
          {
            type: "scalingo-addon",
            app: app.app,
            addonId,
            apiUrl: `https://api.${app.region}.scalingo.com`,
          },
          BACKUP_SCOPES,
          `sauvegarde ${app.app}`,
        );
    console.log(`  ${key2.padEnd(44)} ${addonId}`);
  }

  if (dryRun) {
    console.log("\n--dry-run : rien n'a ete genere ni ecrit.");
    return;
  }
  let previous: Buffer | null = null;
  try {
    previous = readFileSync(paths.fgp);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (previous) {
    const backup = outFile(paths, `${basename(paths.fgp)}.bak`);
    writeFileSync(backup, previous, { mode: 0o600 });
    console.log(`\n${shown(paths.fgp)} precedent sauvegarde en ${shown(backup)}`);
  }
  writeFileSync(paths.fgp, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n${shown(paths.fgp)} ecrit : ${Object.keys(out.api).length} blob(s) API, ${Object.keys(out.backup).length} de sauvegarde.`);
  // Les workflows lisent la cle dans l'environment qu'ils declarent, jamais
  // dans les secrets du depot.
  console.log("Pose la cle en secret de l'environment que declarent les workflows (production dans les exemples), puis verifie avec :");
  const repo = targetRepo();
  console.log(`  gh secret set FGP_KEY --env production ${repo ? `--repo ${repo}` : "--repo <owner>/<depot>"}`);
  console.log(`  node ${shown(join(import.meta.dirname, "apply.ts"))} --dry-run --fgp ${shown(paths.fgp)}`);
}

main().catch((e) => {
  console.error(`\nEchec: ${(e as Error).message}`);
  process.exit(1);
});
