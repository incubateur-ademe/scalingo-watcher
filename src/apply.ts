/**
 * Fait converger le parc Scalingo vers manifest.yaml, et consigne dans lock.json
 * ce qui s'est reellement passe.
 *
 *   node src/apply.ts --dry-run     plan, aucune ecriture
 *   node src/apply.ts --propose-db  avance d'un cran les bases pilotees, dans le manifeste
 *   node src/apply.ts               applique
 *   node src/apply.ts --app alpha   restreint aux apps dont le nom contient alpha
 *
 * Requiert SCALINGO_API_TOKEN.
 *
 * Deroulement pour chaque app ayant un ecart avec le manifest :
 *   sauvegarde de la base -> ecriture de la variable de version -> deploiement
 *   -> attente du statut final -> ecriture du lock.
 *
 * La premiere app effectivement deployee sert d'eclaireur : si elle echoue, la
 * vague s'arrete. Si elle est seulement interrompue, la suivante reprend le
 * role, et deux interruptions consecutives arretent la vague. Un echec
 * ulterieur met seulement l'app en quarantaine.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parse, parseDocument, type Document, type ToStringOptions } from "yaml";
import { Ajv2020 } from "ajv/dist/2020.js";
import { accessModes, flagValue, outFile, readFgpFile, resolvePaths, shown, type Fgp, type Paths } from "./options.ts";
import { compareLines, toolName, upstreamOf, type ToolDeclaration, type Upstream } from "./upstream.ts";

type Policy = { minor?: "auto" | "pr"; major?: "auto" | "pr" };
type Backup = "required" | "not-available";

type AppEntry = {
  app: string;
  region: string;
  paused?: boolean;
  database?: { version: string; major?: "hold" | "allowed" };
  backup?: Backup;
  source: { repo: string; branch: string; sha: string };
  tool: ToolDeclaration & { version: string };
};

/** Ce qui designe une app sur Scalingo, avant meme qu'elle figure au manifeste. */
export type AppRef = Pick<AppEntry, "app" | "region">;

type Manifest = { defaults: { policy?: Policy; backup?: Backup }; apps: AppEntry[] };

type Target = { sha: string; version: string };

type LockEntry = {
  // Pas de branche ici : ce qui est deploye est un commit. La branche est une
  // intention, elle appartient au manifeste. Le depot reste, lui, parce qu'un
  // sha seul est ambigu entre deux depots et que le parc en a deux.
  source: { repo: string; sha: string };
  // version null = l'app n'a pas la variable, donc sa version est resolue au
  // build. Y ecrire la cible du manifeste la ferait passer pour conforme.
  tool: { env: string; version: string | null };
  buildpacks: Array<{ repo: string; ref: string | null }>;
  deployment: { id: string; status: string; at: string } | null;
  backup: { id: string; at: string } | null;
  quarantine: { target: Target; reason: string; at: string; deploymentId: string | null } | null;
};

// generatedAt date le dernier changement d'etat, pas la derniere verification :
// une reconciliation qui ne constate rien ne doit pas produire de diff. Sinon le
// cron bidouillait un horodatage toutes les deux heures et le depot se
// remplissait de commits vides de sens.
type Lock = { version: number; generatedAt: string | null; apps: Record<string, LockEntry> };

const DEPLOY_TIMEOUT_MS = 20 * 60 * 1000;
const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 10_000;
// Passe deux interruptions, ce n'est plus une app qui est en cause mais l'acces
// a Scalingo. Continuer brulerait le delai d'attente de chacune des suivantes
// pour le redecouvrir, sous un verrou que la reconciliation suivante attend.
const MAX_INTERRUPTED_SCOUTS = 2;
// Au-dela, on empile les builds et les sauvegardes simultanees sur une infra
// qu'on ne maitrise pas. Trois suffit a diviser le temps d'une vague par trois.
const DEPLOY_CONCURRENCY = 3;
const INCIDENT_FILE = "incident.md";
const PROPOSAL_FILE = "db-proposal.json";
const PR_TITLE_FILE = "pr-title.txt";
const PR_BODY_FILE = "pr-body.md";
// Une montee de base est plus lente qu'un deploiement et depend de sa taille.
const DB_UPGRADE_TIMEOUT_MS = 30 * 60_000;

// Un rapport qui se contente de compter les echecs oblige a ouvrir les
// journaux pour savoir lesquels. On retient la raison au passage.
const problems: Array<{ key: string; detail: string }> = [];
const note = (key: string, detail: string) => problems.push({ key, detail });

// Une echeance n'est pas une panne : elle doit remonter sans faire echouer la
// convergence, sinon le parc resterait rouge des mois durant sans rien qui
// cloche aujourd'hui.
const warnings: Array<{ key: string; detail: string }> = [];
const warn = (key: string, detail: string) => warnings.push({ key, detail });

// Une faille exploitee passe avant le reste dans le rapport, mais ne fait pas
// echouer l'execution : il n'existe pas toujours de version corrigee le jour ou
// on l'apprend, et un parc rouge en permanence cesse d'etre lu.
const security: Array<{ key: string; detail: string }> = [];
const observedDatabases = new Map<string, { version: string; nextVersion: string | null; engine: string | null }>();
const alert = (key: string, detail: string) => security.push({ key, detail });

/**
 * Deux transports possibles vers Scalingo.
 *
 * Par le proxy fine-grained : le depot ne detient qu'une cle, et chaque blob
 * borne ce qu'elle autorise a une methode et un chemin. Le proxy renouvelle
 * lui-meme le jeton porteur et, pour les sauvegardes, obtient le jeton d'addon
 * qui ne vit qu'une heure. C'est le chemin normal.
 *
 * En direct avec un jeton de compte : tout le pouvoir du compte, sans borne.
 * Garde comme depannage et pour un usage local sans proxy.
 */
let fgp: Fgp | null = null;
let fgpKey = "";

function loadFgp(file: string): void {
  fgpKey = process.env.FGP_KEY ?? "";
  if (fgpKey) fgp = readFgpFile(file);
}

export const apiHost = (region: string) => (fgp ? fgp.url : `https://api.${region}.scalingo.com`);
const dbApiHost = (region: string) => (fgp ? fgp.url : `https://db-api.${region}.scalingo.com`);

function fgpHeaders(blob: string | undefined): Record<string, string> {
  if (!fgp || !blob) return {};
  return { "X-FGP-Key": fgpKey, "X-FGP-Blob": blob };
}

const argv = process.argv.slice(2);
const OPT = {
  dryRun: argv.includes("--dry-run"),
  adopt: argv.includes("--adopt"),
  reconcile: argv.includes("--reconcile"),
  prune: argv.includes("--prune"),
  force: argv.includes("--force"),
  proposeDb: argv.includes("--propose-db"),
  validateOnly: argv.includes("--validate"),
  // Lu en tete de main(), comme les chemins : le module est aussi importe par
  // d'autres commandes, dont les options ne le concernent pas.
  appFilter: null as string | null,
};

// Resolus en tete de main() : une option mal formee y devient un message
// d'erreur, la ou au chargement du module elle sortirait en trace de pile.
let paths: Paths;

const log = (...a: unknown[]) => console.log(...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- http

async function req<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  if (fgp && url.startsWith(fgp.url) && !("X-FGP-Key" in (init.headers ?? {}))) {
    throw new Error(
      `appel au proxy sans sa cle sur ${url} : passer par reqApi(), ou joindre fgpHeaders() au besoin`,
    );
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      // Derriere le proxy, c'est lui qui pose l'entete d'authentification vers
      // Scalingo ; celle du client est de toute facon retiree avant transmission.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Le message reste la seule chose que la plupart des appelants lisent, mais
    // un refus se distingue parfois d'un autre par son corps seul : Scalingo ne
    // rend aucun code d'erreur sur les sauvegardes concurrentes.
    throw Object.assign(
      new Error(`${res.status} ${res.statusText} sur ${init.method ?? "GET"} ${url}${body ? ` :: ${body.slice(0, 300)}` : ""}`),
      { status: res.status, body },
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Le jeton porteur rendu par l'echange vaut une heure. Une vague qui depasse
 * cette duree voyait ses derniers appels rejetes en 401, alors meme que le
 * deploiement avait reussi cote Scalingo. On reechange avant l'echeance plutot
 * que de reagir au refus.
 */
const BEARER_TTL_MS = 50 * 60 * 1000;
let apiTokenRaw = "";
let bearerCache: { value: string; at: number } | null = null;

async function bearerToken(): Promise<string> {
  if (!apiTokenRaw) return "";
  if (bearerCache && Date.now() - bearerCache.at < BEARER_TTL_MS) return bearerCache.value;
  const value = await exchangeToken(apiTokenRaw);
  bearerCache = { value, at: Date.now() };
  return value;
}

/** Appel a l'API Scalingo, avec un jeton toujours frais. */
export async function reqApi<T>(url: string, region: string, init: RequestInit = {}): Promise<T> {
  if (fgp) {
    return req<T>(url, "", { ...init, headers: { ...(init.headers ?? {}), ...fgpHeaders(fgp.api[region]) } });
  }
  return req<T>(url, await bearerToken(), init);
}

/**
 * Ouvre l'acces a Scalingo pour une commande qui ne passe pas par main(), avec
 * les memes regles : le proxy si FGP_KEY et le fichier de blobs sont la, le
 * jeton de compte sinon. Faux si ni l'un ni l'autre.
 */
export function openAccess(resolved: Paths): boolean {
  paths = resolved;
  loadFgp(paths.fgp);
  apiTokenRaw = process.env.SCALINGO_API_TOKEN ?? "";
  return Boolean(fgp || apiTokenRaw);
}

/** URL du proxy quand l'acces passe par lui, null en direct. */
export const proxyUrl = () => fgp?.url ?? null;

async function exchangeToken(apiToken: string): Promise<string> {
  const basic = Buffer.from(`:${apiToken}`).toString("base64");
  const res = await fetch("https://auth.scalingo.com/v1/tokens/exchange", {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`echange de token refuse : ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error("echange de token : reponse sans champ 'token'");
  return body.token;
}

// ---------------------------------------------------------------- variables

/**
 * L'API ne redemarre pas l'app quand une variable change, contrairement au
 * dashboard et a la CLI. On peut donc poser la valeur puis declencher le build
 * sans cycle de redemarrage intermediaire.
 *
 * Volontairement en creation/modification unitaire plutot qu'en mise a jour
 * groupee : le bulk remplace le jeu de variables, ce qui effacerait tout le
 * reste de l'environnement de l'app.
 */
async function setVariable(
  entry: AppEntry,
  name: string,
  value: string,
): Promise<"created" | "updated" | "unchanged"> {
  const base = `${apiHost(entry.region)}/v1/apps/${entry.app}/variables`;
  const { variables } = await reqApi<{
    variables: Array<{ id: string; name: string; value: string }>;
  }>(base, entry.region);
  const existing = variables.find((v) => v.name === name);

  if (existing && existing.value === value) return "unchanged";

  if (existing) {
    await reqApi(`${base}/${existing.id}`, entry.region, {
      method: "PATCH",
      body: JSON.stringify({ variable: { name, value } }),
    });
    return "updated";
  }
  await reqApi(base, entry.region, {
    method: "POST",
    body: JSON.stringify({ variable: { name, value } }),
  });
  return "created";
}

// ---------------------------------------------------------------- sauvegarde

/**
 * Identifiants d'acces a db-api. Le jeton d'addon ne vit qu'une heure : derriere
 * le proxy, le mode scalingo-addon l'obtient et le renouvelle lui-meme, donc le
 * watcher ne le voit jamais. En direct, il faut le demander avant chaque usage.
 */
async function dbAuthFor(
  entry: AppRef,
  addonId: string,
): Promise<{ token: string; headers: Record<string, string> }> {
  if (fgp) {
    const blob = fgp.backup[keyOf(entry)];
    if (!blob) throw new Error(`aucun blob de sauvegarde declare pour ${keyOf(entry)} dans ${shown(paths.fgp)}`);
    return { token: "", headers: fgpHeaders(blob) };
  }
  const { addon } = await reqApi<{ addon: { token: string } }>(
    `${apiHost(entry.region)}/v1/apps/${entry.app}/addons/${addonId}/token`,
    entry.region,
    { method: "POST" },
  );
  return { token: addon.token, headers: {} };
}

export async function findDatabaseAddons(entry: AppRef) {
  const { addons } = await reqApi<{
    addons: Array<{ id: string; addon_provider: { id: string; name: string } }>;
  }>(`${apiHost(entry.region)}/v1/apps/${entry.app}/addons`, entry.region);
  return addons.filter((a) =>
    /postgres|mysql|mongo|redis/i.test(a.addon_provider?.id ?? a.addon_provider?.name ?? ""),
  );
}

async function runBackup(
  entry: AppEntry,
  emit: (line: string) => void = () => {},
): Promise<{ id: string; at: string }> {
  const addons = await findDatabaseAddons(entry);
  if (addons.length === 0) throw new Error("aucun addon de base de donnees trouve alors que backup=required");

  // Une app peut avoir plusieurs bases ; n'en sauvegarder qu'une donnerait un
  // filet partiel tout en affichant un succes.
  const done: Array<{ id: string; at: string }> = [];
  for (const addon of addons) done.push(await backupAddon(entry, addon.id, emit));
  return done[0];
}

/**
 * Signale qu'une version plus recente de la base existe, sans jamais l'appliquer.
 *
 * Contrairement aux stacks, Scalingo n'expose aucune date de fin de vie pour les
 * versions de bases : `next_version_id` dit seulement qu'une montee est
 * disponible. Le constat est donc « il existe plus recent », pas « celle-ci
 * expire le tant », et il n'appelle aucune urgence.
 *
 * Une montee de base est de toute facon une operation a part : elle coupe le
 * service, ne se retourne pas, et se decide avec l'equipe qui exploite la base.
 * Le watcher la signale, il ne la declenche pas.
 */
export async function readDatabaseVersion(
  entry: AppRef,
  addonId: string,
): Promise<{ version: string; upgradable: boolean } | null> {
  try {
    const auth = await dbAuthFor(entry, addonId);
    const db = await req<{
      database: { readable_version: string; next_version_id: string | null; status: string };
    }>(`${dbApiHost(entry.region)}/api/databases/${addonId}`, auth.token, { headers: auth.headers });
    return {
      version: db.database.readable_version,
      upgradable: Boolean(db.database.next_version_id),
    };
  } catch {
    return null;
  }
}

/** Statuts qu'une sauvegarde traverse avant d'etre conclue. */
const BACKUP_IN_FLIGHT = /^(scheduled|queued|pending|creating|running)$/;

export async function backupAddon(
  entry: AppEntry,
  addonId: string,
  emit: (line: string) => void = () => {},
): Promise<{ id: string; at: string }> {
  const backupsUrl = `${dbApiHost(entry.region)}/api/databases/${addonId}/backups`;

  const dbAuth = await dbAuthFor(entry, addonId);
  const dbToken = dbAuth.token;

  const listBackups = async () => {
    const { database_backups } = await req<{
      database_backups: Array<{ id: string; status: string; created_at: string }>;
    }>(backupsUrl, dbToken, { headers: dbAuth.headers });
    return database_backups;
  };
  const inFlight = (backups: Array<{ id: string; status: string }>) =>
    backups.find((b) => BACKUP_IN_FLIGHT.test(b.status))?.id ?? null;

  // Se rattacher a une sauvegarde deja lancee plutot que d'en demander une
  // seconde, que db-api refuserait de toute facon.
  //
  // Le watcher ne garde aucune memoire d'un passage a l'autre : une sauvegarde
  // qui deborde du delai devient orpheline, et le passage suivant en redemande
  // une, prend un 400, et echoue en quelques secondes. Le blocage se
  // reconduisait ainsi a chaque passage. Le 2026-09-23, une sauvegarde de
  // 40 Mo a mis plus d'une heure cote Scalingo et a fige le parc entier.
  const requestBackup = async (): Promise<string> => {
    try {
      const created = await req<{ database_backup: { id: string } }>(backupsUrl, dbToken, {
        method: "POST",
        headers: dbAuth.headers,
      });
      return created.database_backup.id;
    } catch (e) {
      // Une sauvegarde a pu demarrer entre le releve et la demande, la
      // plateforme en lancant elle-meme periodiquement. Le refus ne porte aucun
      // code, seul son corps le distingue d'un autre 400.
      const refusal = e as Error & { status?: number; body?: string };
      if (refusal.status !== 400 || !/a backup is running/i.test(refusal.body ?? "")) throw e;
      // Pas BACKUP_IN_FLIGHT ici : db-api vient d'affirmer qu'une sauvegarde
      // tourne, un statut qu'on n'aurait pas prevu ne doit pas le contredire.
      // La selection s'aligne sur la boucle d'attente, qui raisonne a l'envers.
      const concurrent = (await listBackups()).find((b) => b.status !== "done" && b.status !== "error")?.id;
      if (!concurrent) throw e;
      emit(`    sauvegarde ${concurrent} deja en cours, rattachement`);
      return concurrent;
    }
  };

  const existing = inFlight(await listBackups());
  if (existing) emit(`    sauvegarde ${existing} deja en cours, rattachement`);
  const id = existing ?? (await requestBackup());

  const deadline = Date.now() + BACKUP_TIMEOUT_MS;
  for (;;) {
    const b = (await listBackups()).find((x) => x.id === id);
    if (b?.status === "done") return { id, at: b.created_at };
    if (b?.status === "error") throw new Error(`sauvegarde ${id} en erreur`);
    if (Date.now() > deadline) {
      throw new Error(`sauvegarde ${id} toujours en cours apres ${BACKUP_TIMEOUT_MS / 60000} min`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------- deploiement

const TERMINAL = /^(success|build-error|crashed-error|timeout-error|hook-error|aborted)$/;

async function deploy(entry: AppEntry, target: Target) {
  const sourceUrl = `https://github.com/${entry.source.repo}/archive/${target.sha}.tar.gz`;
  const created = await reqApi<{ deployment: { id: string } }>(
    `${apiHost(entry.region)}/v1/apps/${entry.app}/deployments`,
    entry.region,
    {
      method: "POST",
      body: JSON.stringify({
        deployment: { git_ref: target.sha, source_url: sourceUrl },
      }),
    },
  );
  const id = created.deployment.id;

  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  for (;;) {
    const { deployment } = await reqApi<{
      deployment: { id: string; status: string; created_at: string };
    }>(`${apiHost(entry.region)}/v1/apps/${entry.app}/deployments/${id}`, entry.region);
    if (TERMINAL.test(deployment.status)) {
      return { id, status: deployment.status, at: deployment.created_at };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `deploiement ${id} toujours en cours apres ${DEPLOY_TIMEOUT_MS / 60000} min, statut non conclu`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Les buildpacks reellement utilises ne sont lisibles que dans les logs du build. */
async function readBuildpacks(entry: AppEntry, deploymentId: string) {
  // Cette route rend du texte brut, pas du JSON : elle ne passe pas par req().
  const auth = fgp
    ? fgpHeaders(fgp.api[entry.region])
    : { Authorization: `Bearer ${await bearerToken()}` };
  const res = await fetch(
    `${apiHost(entry.region)}/v1/apps/${entry.app}/deployments/${deploymentId}/output`,
    { headers: auth },
  );
  if (!res.ok) return [];
  const text = (await res.text()).slice(0, 512 * 1024);
  const out: Array<{ repo: string; ref: string | null }> = [];
  for (const line of text.split("\n")) {
    const dl = /Downloading Buildpack:\s*(\S+)/.exec(line);
    if (dl) {
      const [bare, ref] = dl[1].split("#");
      const m = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/.exec(bare);
      out.push({ repo: m ? m[1] : bare, ref: ref || null });
      continue;
    }
    const br = /Using branch:\s*(\S+)/.exec(line);
    if (br && out.length > 0) out[out.length - 1].ref = br[1];
  }
  return out;
}

type Deployment = { id: string; status: string; created_at: string; git_ref: string | null };

/** Deploiement le plus recent d'une app, quel qu'en soit le statut, ou null. */
export async function lastDeployment(entry: AppRef): Promise<Deployment | null> {
  const { deployments } = await reqApi<{ deployments: Deployment[] }>(
    `${apiHost(entry.region)}/v1/apps/${entry.app}/deployments?per_page=1`,
    entry.region,
  );
  return deployments[0] ?? null;
}

/** Commit deploye, quand le git_ref en est un sha complet. */
export const deployedSha = (deployment: Deployment | null): string | null =>
  deployment?.git_ref && /^[0-9a-f]{40}$/.test(deployment.git_ref) ? deployment.git_ref : null;

/**
 * Releve l'etat reel d'une app et en fait une entree de lock, sans rien deployer.
 * Sert a amorcer le lock sur un parc existant : sans ca, le premier apply
 * considererait tout comme inconnu et redeploierait le parc entier pour rien.
 */
async function adoptApp(entry: AppEntry): Promise<LockEntry> {
  const base = `${apiHost(entry.region)}/v1/apps/${entry.app}`;
  const { variables } = await reqApi<{ variables: Array<{ name: string; value: string }> }>(
    `${base}/variables`,
    entry.region,
  );
  const declared = variables.find((v) => v.name === entry.tool.env)?.value ?? null;

  const last = await lastDeployment(entry);
  const deployed = deployedSha(last);
  const sha = deployed ?? entry.source.sha;
  if (!deployed) log(`    (git_ref "${last?.git_ref || "absent"}" illisible, sha du manifeste retenu par defaut)`);

  return {
    source: { repo: entry.source.repo, sha },
    tool: { env: entry.tool.env, version: declared },
    buildpacks: last ? await readBuildpacks(entry, last.id) : [],
    deployment: last ? { id: last.id, status: last.status, at: last.created_at } : null,
    backup: null,
    quarantine: null,
  };
}

const refCache = new Map<string, boolean>();

/**
 * Un sha epingle doit appartenir a la branche declaree.
 *
 * Sans ce controle, une app deployee depuis une branche specifique peut etre
 * redeployee depuis une autre et perdre en silence ce que sa branche apportait.
 * Cas concret : une branche dont le .buildpacks ajoute un oauth2-proxy devant
 * l'outil. Deployer l'app depuis la branche principale exposerait l'instance
 * sans authentification, et rien dans le statut du deploiement ne le
 * signalerait.
 *
 * Retourne null quand GitHub est injoignable : on ne bloque pas sur une panne.
 */
async function shaIsOnBranch(repo: string, branch: string, sha: string): Promise<boolean | null> {
  const key = `${repo}@${branch}...${sha}`;
  const cached = refCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "scalingo-watcher",
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${branch}...${sha}`, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string };
    // identical : le sha est la tete de branche. behind : c'est un ancetre, donc
    // un epinglage volontaire sur un commit plus ancien. Les deux sont legitimes.
    const ok = body.status === "identical" || body.status === "behind";
    refCache.set(key, ok);
    return ok;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- application

const keyOf = (e: AppRef) => `${e.region}/${e.app}`;
const sameTarget = (a: Target, b: Target) => a.sha === b.sha && a.version === b.version;

/**
 * `failed` = Scalingo a rendu un statut terminal non reussi. La cible est en
 * cause, on met en quarantaine.
 * `error` = on n'a pas pu mener l'operation a son terme (reseau, API, sauvegarde
 * impossible, attente trop longue). Rien ne dit que la cible est mauvaise, donc
 * pas de quarantaine : geler l'app sur un 502 passager la bloquerait jusqu'a la
 * prochaine version publiee. Sur l'eclaireur, un `failed` arrete la vague et un
 * `error` laisse l'app suivante reprendre le role, jusqu'a deux interruptions
 * consecutives.
 */
type Outcome =
  | "up-to-date"
  | "quarantined-skip"
  | "deployed"
  | "failed"
  | "error"
  | "planned"
  // Ecarte avant toute tentative : le manifeste ou l'etat de l'app s'y oppose.
  // Distinct de "error", qui signale une operation entamee puis interrompue, et
  // qui seule justifie d'arreter la vague.
  | "rejected"
  | "paused"
  | "skipped-state";

/**
 * Statuts Scalingo sur lesquels on ne deploie pas.
 *
 * `stopped` : l'app est eteinte, sans doute volontairement. La redemarrer par un
 * deploiement serait une decision qui n'appartient pas au watcher.
 * `crashed` : elle est deja cassee, un deploiement rendrait indistinguables
 * l'echec du deploiement et la panne preexistante.
 * `restarting` / `scaling` / `booting` : etats transitoires, on repassera.
 */
const NOT_DEPLOYABLE = new Set(["stopped", "crashed", "restarting", "scaling", "booting"]);

/**
 * Rend le statut de l'application, ou la raison pour laquelle il est illisible.
 *
 * L'ancienne version avalait l'erreur et rendait null, ce qui faisait passer
 * l'application pour deployable : le garde-fou qui refuse de deployer une app
 * arretee se desactivait donc des que la lecture echouait. Une tentative a ete
 * faite sur une app arretee pour cette raison exacte.
 */
async function readAppStatus(
  entry: AppEntry,
): Promise<{ status: string; stack: string | null } | { unreadable: string }> {
  try {
    const { app } = await reqApi<{ app: { status: string; stack_base_image?: string; stack_id?: string } }>(
      `${apiHost(entry.region)}/v1/apps/${entry.app}`,
      entry.region,
    );
    return { status: app.status, stack: app.stack_id ?? null };
  } catch (e) {
    return { unreadable: (e as Error).message };
  }
}

/**
 * Stacks proposes par la region, avec leur date de depreciation.
 *
 * Un stack qui arrive en fin de vie ne casse rien le jour meme : il cesse
 * d'abord de recevoir des correctifs, puis les builds finissent par echouer.
 * C'est exactement le genre d'echeance qu'on ne voit pas venir sans la
 * surveiller, d'ou sa place ici plutot que dans une note quelque part.
 */
const stackCache = new Map<string, Map<string, { name: string; deprecatedAt: string | null }>>();

async function readStacks(region: string): Promise<Map<string, { name: string; deprecatedAt: string | null }>> {
  const cached = stackCache.get(region);
  if (cached) return cached;
  const out = new Map<string, { name: string; deprecatedAt: string | null }>();
  try {
    const { stacks } = await reqApi<{
      stacks: Array<{ id: string; name: string; deprecated_at: string | null }>;
    }>(`${apiHost(region)}/v1/features/stacks`, region);
    for (const s of stacks) out.set(s.id, { name: s.name, deprecatedAt: s.deprecated_at });
  } catch (e) {
    // Une echeance qu'on n'a pas pu lire ne doit pas empecher de deployer, mais
    // elle ne doit pas non plus passer pour une absence d'echeance : sans ce
    // signalement, une surveillance muette serait indiscernable d'un parc sain.
    warn(region, `liste des stacks illisible, aucune echeance n'a pu etre verifiee : ${(e as Error).message.slice(0, 200)}`);
  }
  stackCache.set(region, out);
  return out;
}

async function applyApp(
  entry: AppEntry,
  manifest: Manifest,
  lock: Lock,
  token: string,
  emit: (line: string) => void,
): Promise<Outcome> {
  const key = keyOf(entry);
  const current = lock.apps[key];
  const sameRepo = current?.source.repo === entry.source.repo;
  const target: Target = { sha: entry.source.sha, version: entry.tool.version };

  // La pause est une decision, pas un constat : elle vaut meme si l'app tourne.
  if (entry.paused) {
    emit(`  ${key} : en pause dans le manifeste, ignoree`);
    return "paused";
  }

  // Avant tout le reste : une app qu'on ne doit pas reveiller reste tranquille.
  // Ce n'est pas un echec, donc pas de quarantaine et pas de code de sortie.
  // `token` est vide quand le proxy porte l'authentification : le tester
  // revenait a desactiver ce controle pour tout le monde depuis la bascule.
  if (token || fgp) {
    const state = await readAppStatus(entry);
    if ("unreadable" in state) {
      // Dans le doute on ne deploie pas : c'est le sens de tout le reste ici.
      emit(`  ${key} : etat illisible, rien n'est tente`);
      emit(`    ${state.unreadable.slice(0, 240)}`);
      note(key, `etat illisible : ${state.unreadable.slice(0, 240)}`);
      return "rejected";
    }
    if (state.stack) {
      const stack = (await readStacks(entry.region)).get(state.stack);
      if (stack?.deprecatedAt) {
        const days = Math.round((Date.parse(stack.deprecatedAt) - Date.now()) / 86400000);
        warn(
          key,
          days > 0
            ? `tourne sur le stack ${stack.name}, deprecie dans ${days} jour(s), le ${stack.deprecatedAt.slice(0, 10)}`
            : `tourne sur le stack ${stack.name}, deprecie depuis le ${stack.deprecatedAt.slice(0, 10)}`,
        );
      }
    }

    if (NOT_DEPLOYABLE.has(state.status)) {
      emit(`  ${key} : etat "${state.status}", non deployable, laissee en l'etat`);
      return "skipped-state";
    }
  }

  // Une entree sans deploiement reussi ne vaut pas conformite : elle peut avoir
  // ete creee par un echec, auquel cas elle ne decrit aucun etat reellement atteint.
  const everDeployed = current?.deployment?.status === "success";
  if (
    !OPT.force &&
    current &&
    everDeployed &&
    current.source.sha === target.sha &&
    current.tool.version === target.version &&
    !current.quarantine
  ) {
    emit(`  ${key} : deja conforme`);
    return "up-to-date";
  }

  // La quarantaine memorise la cible qui a echoue. Elle se libere d'elle-meme
  // des que le manifest pointe ailleurs, sans intervention.
  if (!OPT.force && current?.quarantine && sameTarget(current.quarantine.target, target)) {
    emit(`  ${key} : en quarantaine sur cette cible depuis ${current.quarantine.at.slice(0, 10)} (${current.quarantine.reason}), ignoree`);
    return "quarantined-skip";
  }

  // Deux axes bougent independamment : la version de l'outil, portee par une
  // variable, et le commit du depot applicatif. Les afficher separement evite de
  // lire "v0.63.15 @ 3f2c1a8 -> v0.63.15 @ 4b7c2f1" pour comprendre que seul le
  // second a change.
  if (current && !sameRepo) {
    emit(`  ${key} : changement de depot, ${current.source.repo} -> ${entry.source.repo}`);
  }

  const changes: string[] = [];
  if (OPT.force && everDeployed && current!.source.sha === target.sha && current!.tool.version === target.version) {
    changes.push(`redeploiement force a l'identique, ${target.version} @ ${target.sha.slice(0, 7)}`);
  } else if (!everDeployed) {
    changes.push(`premiere prise en charge, cible ${target.version} @ ${target.sha.slice(0, 7)}`);
  } else {
    if (current!.tool.version !== target.version) {
      changes.push(`outil ${current!.tool.version ?? "non epinglee"} -> ${target.version}`);
    }
    if (current!.source.sha !== target.sha) {
      const was = current!.source.sha.slice(0, 7) || "?";
      changes.push(`source ${entry.source.branch} ${was} -> ${target.sha.slice(0, 7)}`);
    }
    if (current!.quarantine) changes.push("sortie de quarantaine");
  }
  emit(`  ${key} : ${changes.join(", ")}`);

  // Deux controles distincts, et c'est le second qui compte le plus.
  //
  // Le premier verifie que le manifeste est coherent avec lui-meme : un sha
  // epingle doit appartenir a la branche qu'il declare suivre.
  if ((await shaIsOnBranch(entry.source.repo, entry.source.branch, target.sha)) === false) {
    emit(`    INCOHERENCE : ${target.sha.slice(0, 7)} n'est pas sur la branche ${entry.source.branch} de ${entry.source.repo}`);
    emit(`    le manifeste se contredit, rien n'est tente`);
    note(key, `le manifeste se contredit : ${target.sha.slice(0, 7)} n'est pas sur la branche ${entry.source.branch} de ${entry.source.repo}. Rien n'a ete tente.`);
    return "rejected";
  }

  // Le second verifie que le manifeste dit vrai sur ce qui tourne. Si le commit
  // deploye n'appartient pas a la branche declaree, alors ou bien la branche du
  // manifeste est fausse, ou bien on s'appreterait a changer l'app de branche.
  // Les deux mettent en jeu ce que la branche d'origine apportait, et aucun ne
  // doit se produire sans decision explicite.
  // Ce controle attrape une app qui tourne un commit etranger a la branche
  // declaree, signe d'un manifeste faux ou d'un deploiement hors watcher. Il ne
  // vaut qu'a depot constant : quand le manifeste change de depot, le commit en
  // place lui est forcement etranger, et ce n'est pas une anomalie mais la
  // consequence du changement voulu.
  if (sameRepo && current?.source.sha && current.source.sha !== target.sha) {
    if ((await shaIsOnBranch(entry.source.repo, entry.source.branch, current.source.sha)) === false) {
      emit(`    CHANGEMENT DE BRANCHE : l'app tourne ${current.source.sha.slice(0, 7)}, absent de ${entry.source.branch}`);
      emit(`    corrige la branche du manifeste, ou assume le changement en mettant a jour le lock`);
      note(key, `changement de branche : l'app tourne ${current.source.sha.slice(0, 7)}, absent de ${entry.source.branch}. Corriger la branche du manifeste, ou assumer le changement en mettant a jour le lock.`);
      return "rejected";
    }
  }

  if (OPT.dryRun) return "planned";

  const backupMode: Backup = entry.backup ?? manifest.defaults.backup ?? "required";
  let backup: LockEntry["backup"] = current?.backup ?? null;

  try {
    if (backupMode === "required") {
      emit(`    sauvegarde de la base...`);
      backup = await runBackup(entry, emit);
      emit(`    sauvegarde ${backup.id} disponible`);
    } else {
      emit(`    sauvegarde non disponible sur cette app, deploiement sans filet`);
    }

    const varState = await setVariable(entry, entry.tool.env, target.version);
    if (varState !== "unchanged") emit(`    ${entry.tool.env} ${varState === "created" ? "creee" : "mise a jour"}`);

    emit(`    deploiement...`);
    const dep = await deploy(entry, target);

    if (dep.status !== "success") {
      lock.apps[key] = {
        ...(current ?? {
          source: { repo: entry.source.repo, sha: "" },
          tool: { env: entry.tool.env, version: null },
          buildpacks: [],
          deployment: null,
          backup: null,
          quarantine: null,
        }),
        backup,
        quarantine: { target, reason: dep.status, at: new Date().toISOString(), deploymentId: dep.id },
      };
      emit(`    ECHEC (${dep.status}), mise en quarantaine`);
      note(key, `deploiement en echec (${dep.status}), mise en quarantaine.`);
      return "failed";
    }

    lock.apps[key] = {
      source: { repo: entry.source.repo, sha: target.sha },
      tool: { env: entry.tool.env, version: entry.tool.version },
      buildpacks: await readBuildpacks(entry, dep.id),
      deployment: { id: dep.id, status: dep.status, at: dep.at },
      backup,
      quarantine: null,
    };
    emit(`    succes`);
    return "deployed";
  } catch (e) {
    // Volontairement sans quarantaine ni ecriture de version : on ne sait pas ou
    // l'operation s'est arretee, donc le lock reste sur ce qu'il savait.
    if (current) lock.apps[key] = { ...current, backup };
    emit(`    INTERROMPU : ${(e as Error).message}`);
    note(key, `interrompu : ${(e as Error).message.slice(0, 240)}`);
    return "error";
  }
}

/**
 * Rend compte de ce qui va mal, pour que le workflow en fasse une issue.
 *
 * La chaine tourne desormais seule, la nuit : un echec ou une quarantaine
 * n'etait connu de personne avant que quelqu'un pense a ouvrir les executions.
 * Le fichier n'est ecrit que s'il y a matiere, son absence valant "tout va
 * bien" et servant au workflow a refermer une issue devenue sans objet.
 */
/**
 * Ce que le tableau de bord doit savoir en plus du lock : ce qui est disponible
 * en amont. Renovate le sait aussi, mais il ne le dit que pour ce qu'il suit et
 * sous forme de pull requests ; le tableau de bord doit l'afficher meme quand
 * aucune montee n'est en cours.
 */
const ghHeaders = () => {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
};

async function ghJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders() });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const releasesCache = new Map<string, string[]>();

/** Derniere release publiee dans la ligne de la version donnee, si elle est plus recente. */
async function latestInLine(upstream: Upstream, version: string | null): Promise<string | null> {
  if (!version) return null;
  let tags = releasesCache.get(upstream.repo);
  if (!tags) {
    const rel = await ghJson<Array<{ tag_name: string; draft: boolean; prerelease: boolean }>>(
      `/repos/${upstream.repo}/releases?per_page=100`,
    );
    tags = (rel ?? []).filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name);
    releasesCache.set(upstream.repo, tags);
  }
  const current = parseSemver(version);
  if (!current) return null;
  let best: { tag: string; v: number[] } | null = null;
  for (const tag of tags) {
    const v = parseSemver(tag);
    if (!v || compareLines(v, current, upstream.line) !== 0) continue;
    if (!best || cmpVersion(v, best.v) > 0) best = { tag, v };
  }
  if (!best) return null;
  return cmpVersion(best.v, current) > 0 ? best.tag : null;
}

const headCache = new Map<string, string | null>();

/** Sha de tete d'une branche, ou null si la branche est introuvable. */
async function branchHead(repo: string, branch: string): Promise<string | null> {
  const key = `${repo}#${branch}`;
  if (headCache.has(key)) return headCache.get(key)!;
  const b = await ghJson<{ commit: { sha: string } }>(`/repos/${repo}/branches/${branch}`);
  const sha = b?.commit?.sha ?? null;
  headCache.set(key, sha);
  return sha;
}

const movedSinceCache = new Map<string, string | null>();

/**
 * Sha de tete d'un buildpack s'il a bouge depuis la date donnee.
 *
 * Les buildpacks ne sont pas epingles : chaque build reprend la tete de leur
 * branche par defaut. Savoir qu'ils ont bouge depuis le dernier deploiement est
 * la seule facon de voir qu'un redeploiement changerait quelque chose.
 */
async function buildpackMovedSince(repo: string, since: string | null): Promise<string | null> {
  if (!since) return null;
  const key = `${repo}#${since}`;
  if (movedSinceCache.has(key)) return movedSinceCache.get(key)!;
  const commits = await ghJson<Array<{ sha: string }>>(
    `/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=1`,
  );
  const sha = commits && commits.length > 0 ? commits[0].sha : null;
  movedSinceCache.set(key, sha);
  return sha;
}

const appUrl = (e: AppEntry) => `https://dashboard.scalingo.com/apps/${e.region}/${e.app}`;

/**
 * Lien vers l'annonce Scalingo de cette version precise.
 *
 * Le changelog expose une ancre par version, de la forme
 * `#changelog-databases-postgresql-16-15-0-1`. Elle n'existe que pour les
 * versions annoncees : pour une version plus ancienne, le lien ouvre le
 * changelog sans se positionner, ce qui reste utilisable. Le moteur de la base
 * est celui de l'addon releve. Sans releve (app en pause, acces refuse), on
 * suppose PostgreSQL, seul moteur que init pilote.
 */
const databaseLink = (v: string, engine: string | null | undefined) =>
  `[${v}](https://doc.scalingo.com/changelog#changelog-databases-${engine ?? "postgresql"}-${v.replace(/\./g, "-")})`;

const stateOf = (e: AppEntry, known: LockEntry | undefined) =>
  e.paused
    ? "en pause"
    : known?.quarantine
      ? "quarantaine"
      : known?.tool.version === e.tool.version && known?.source.sha === e.source.sha
        ? "conforme"
        : "en écart";

/**
 * Une section par outil, dans l'ordre ou il apparait dans le manifeste : les
 * versions et leurs releases n'ont de sens qu'entre instances du meme outil.
 */
export async function describeTools(targets: AppEntry[], lock: Lock): Promise<string[]> {
  const lines: string[] = [];
  for (const env of new Set(targets.map((e) => e.tool.env))) {
    lines.push(`## ${toolName(env)}`, "");
    lines.push("| App | Version | Mise à jour ? | Dépôt | Mise à jour ? | État |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const entry of targets.filter((e) => e.tool.env === env)) {
      const key = keyOf(entry);
      const known = lock.apps[key];
      const version = known?.tool.version ?? entry.tool.version;
      const upstream = upstreamOf(entry.tool);
      const release = (v: string) => (upstream ? `[${v}](https://github.com/${upstream.repo}/releases/tag/${v})` : v);
      const available = upstream ? await latestInLine(upstream, version) : null;
      const head = await branchHead(entry.source.repo, entry.source.branch);
      const sha = known?.source.sha ?? entry.source.sha;
      const repoUrl = `https://github.com/${entry.source.repo}`;

      let sourceUpdate = "non";
      if (head === null) {
        sourceUpdate = `branche \`${entry.source.branch}\` introuvable`;
      } else if (known && known.source.repo !== entry.source.repo) {
        sourceUpdate = `dépôt changé, ${known.source.repo} déployé`;
      } else if (head !== sha) {
        sourceUpdate = `[\`${head.slice(0, 7)}\`](${repoUrl}/commit/${head})`;
      }

      lines.push(
        `| [${entry.app}](${appUrl(entry)}) ` +
          `| ${version ? release(version) : "non epinglee"} ` +
          `| ${!upstream ? "amont inconnu" : available ? release(available) : "non"} ` +
          `| [${entry.source.repo}@${entry.source.branch}](${repoUrl}/tree/${entry.source.branch}) ([\`${sha.slice(0, 7)}\`](${repoUrl}/commit/${sha})) ` +
          `| ${sourceUpdate} | ${stateOf(entry, known)} |`,
      );
    }
    lines.push("");
  }
  return lines;
}

async function writeIncident(lock: Lock, targets: AppEntry[]): Promise<void> {
  const quarantined = targets
    .map((e) => [keyOf(e), lock.apps[keyOf(e)]] as const)
    .filter(([, v]) => v?.quarantine);

  const broken = problems.length;
  const nothingToReport =
    broken === 0 && quarantined.length === 0 && warnings.length === 0 && security.length === 0;

  const lines: string[] = await describeTools(targets, lock);
  lines.push(
    "**État** : `conforme`, ce qui tourne correspond au manifeste. `en écart`, le",
    "manifeste demande autre chose et la convergence le rattrapera. `quarantaine`,",
    "une tentative a échoué sur cette cible et elle ne sera pas retentée tant que le",
    "manifeste ne change pas. `en pause`, sortie du périmètre par le manifeste.",
    "",
  );

  lines.push("## Bases de données", "");
  lines.push("| App | Version | Mise à jour ? | État |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of targets) {
    const key = keyOf(entry);
    const observed = observedDatabases.get(key);
    const declared = entry.database?.version;
    if (!observed && !declared) {
      lines.push(`| [${entry.app}](${appUrl(entry)}) | non pilotée | | |`);
      continue;
    }
    const v = observed?.version ?? declared!;
    const nextVersion = observed?.nextVersion ?? null;
    const heldBack =
      nextVersion && crossesMajor(v, nextVersion) && entry.database?.major !== "allowed";
    lines.push(
      `| [${entry.app}](${appUrl(entry)}/resources) ` +
        `| ${databaseLink(v, observed?.engine)}${observed ? "" : " (déclarée, non relevée)"} ` +
        `| ${nextVersion ? `${databaseLink(nextVersion, observed?.engine)}${heldBack ? " (majeure retenue)" : ""}` : "non"} ` +
        `| ${entry.paused ? "en pause" : observed ? "relevée" : "non relevée"} |`,
    );
  }
  lines.push("");
  lines.push(
    "**État** : `relevée`, la version a été lue sur Scalingo. `non relevée`, la",
    "valeur affichée vient du manifeste et non d'un constat. `en pause`,",
    "l'application est hors périmètre et sa base n'est pas interrogée.",
    "",
  );

  lines.push("## Buildpacks", "");
  lines.push("| App | Buildpack | Mise à jour ? | État |");
  lines.push("| --- | --- | --- | --- |");
  for (const entry of targets) {
    const known = lock.apps[keyOf(entry)];
    if (!known || known.buildpacks.length === 0) {
      lines.push(`| [${entry.app}](${appUrl(entry)}) | inconnus | | pas de build relevé |`);
      continue;
    }
    for (const bp of known.buildpacks) {
      const moved = await buildpackMovedSince(bp.repo, known.deployment?.at ?? null);
      lines.push(
        `| [${entry.app}](${appUrl(entry)}) ` +
          `| [${bp.repo}](https://github.com/${bp.repo})${bp.ref ? `@${bp.ref}` : ""} ` +
          `| ${moved ? `[\`${moved.slice(0, 7)}\`](https://github.com/${bp.repo}/commit/${moved})` : "non"} ` +
          `| ${bp.ref ? "épinglé" : "suit sa branche"} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "**État** : `suit sa branche`, le buildpack n'est pas épinglé et chaque build",
    "reprend la tête de sa branche par défaut, donc la colonne de mise à jour",
    "compare cette tête à la date du dernier déploiement. `épinglé`, une référence",
    "fixe est déclarée et le build ne bougera pas sans qu'on la change.",
    "",
  );

  // Marqueur lu par le workflow pour decider s'il previent l'equipe. Se fonder
  // sur le texte rendu ne tient pas : les tableaux bougent des qu'une version
  // parait en amont, ce qui n'est pas un changement d'etat. Tout ce qui le suit
  // demande une intervention, et c'est ce que porte la notification.
  lines.push(`<!-- etat: ${nothingToReport ? "sain" : "intervention"} -->`, "");
  if (!nothingToReport) lines.push("## Ce qui demande une intervention", "");

  if (security.length > 0) {
    lines.push(`### Faille activement exploitee`, "");
    for (const { key, detail } of security) lines.push(`- **${key}** : ${detail}`);
    lines.push(
      "",
      "Ces failles figurent au catalogue KEV de la CISA, qui ne retient que ce",
      "qui est exploite dans la nature. Monter la version prime sur le delai de",
      "decantation habituel.",
      "",
    );
  }
  if (broken > 0) {
    lines.push(`${broken} application(s) n'ont pas abouti :`, "");
    for (const { key, detail } of problems) lines.push(`- **${key}** : ${detail}`);
    lines.push("");
  }
  if (quarantined.length > 0) {
    lines.push(`${quarantined.length} application(s) en quarantaine :`, "");
    for (const [key, entry] of quarantined) {
      const q = entry!.quarantine!;
      lines.push(
        `- **${key}** depuis le ${q.at.slice(0, 10)}, cible ` +
          `${q.target.version ?? "non epinglee"} @ ${q.target.sha.slice(0, 7)}`,
        `  > ${q.reason.split("\n")[0].slice(0, 300)}`,
      );
    }
    lines.push(
      "",
      "Une application en quarantaine est laissee telle quelle tant que la cible",
      "ne change pas. Corriger le manifeste, ou relancer avec `--force` une fois",
      "la cause levee.",
      "",
    );
  }

  if (warnings.length > 0) {
    lines.push(`${warnings.length} echeance(s) a prevoir :`, "");
    for (const { key, detail } of warnings) lines.push(`- **${key}** : ${detail}`);
    lines.push(
      "",
      "Rien ne casse aujourd'hui. Ces lignes signalent ce qui cessera de",
      "fonctionner si personne n'agit d'ici la.",
      "",
    );
  }
  writeFileSync(outFile(paths, INCIDENT_FILE), lines.join("\n") + "\n");
}

/**
 * Confronte les versions en service aux failles activement exploitees.
 *
 * On ne regarde que le catalogue KEV de la CISA, qui ne retient que ce qui est
 * exploite dans la nature, et non l'ensemble des CVE d'un produit. C'est
 * volontaire : une faille theorique ne justifie pas de court-circuiter le delai
 * de decantation, une faille exploitee si. Deux entrees concernent Metabase
 * aujourd'hui, la ou le produit en compte des centaines : le signal reste rare,
 * donc il veut dire quelque chose quand il se declenche.
 *
 * Les deux sources sont publiques et sans authentification.
 */
const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const NVD_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0";

type Version = number[];

function parseSemver(raw: string): Version | null {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(raw.trim());
  return m ? m[1].split(".").map(Number) : null;
}

function cmpVersion(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

type Range = { startIncl?: string; endExcl?: string; endIncl?: string };

function versionInRange(v: Version, r: Range): boolean {
  const start = r.startIncl ? parseSemver(r.startIncl) : null;
  const endE = r.endExcl ? parseSemver(r.endExcl) : null;
  const endI = r.endIncl ? parseSemver(r.endIncl) : null;
  if (!start && !endE && !endI) return false;
  if (start && cmpVersion(v, start) < 0) return false;
  if (endE && cmpVersion(v, endE) >= 0) return false;
  if (endI && cmpVersion(v, endI) > 0) return false;
  return true;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function exploitedRangesFor(product: string): Promise<
  Array<{ cve: string; name: string; since: string; ranges: Range[] }>
> {
  // La cle est declaree optionnelle parce que rien ne garantit sa presence :
  // fetchJson n'ecarte que les reponses en erreur, et un 200 sans elle faisait
  // lever .filter. L'exception remontait jusqu'a main() et emportait l'ecriture
  // du rapport, apres que la vague avait deja deploye. La reponse du NVD juste
  // en dessous est gardee de bout en bout, celle-ci ne l'etait pas.
  const kev = await fetchJson<{
    vulnerabilities?: Array<{ cveID: string; vendorProject: string; product: string; vulnerabilityName: string; dateAdded: string }>;
  }>(KEV_URL);
  if (!kev?.vulnerabilities) return [];

  const needle = product.toLowerCase();
  const matching = kev.vulnerabilities.filter(
    (v) => `${v.vendorProject} ${v.product}`.toLowerCase().includes(needle),
  );

  const out: Array<{ cve: string; name: string; since: string; ranges: Range[] }> = [];
  for (const v of matching) {
    const nvd = await fetchJson<{
      vulnerabilities: Array<{ cve: { configurations?: Array<{ nodes: Array<{ cpeMatch: Array<Record<string, string>> }> }> } }>;
    }>(`${NVD_URL}?cveId=${encodeURIComponent(v.cveID)}`);
    const ranges: Range[] = [];
    for (const cfg of nvd?.vulnerabilities?.[0]?.cve?.configurations ?? []) {
      for (const node of cfg.nodes ?? []) {
        for (const cp of node.cpeMatch ?? []) {
          if (!String(cp.criteria ?? "").toLowerCase().includes(needle)) continue;
          ranges.push({
            startIncl: cp.versionStartIncluding,
            endExcl: cp.versionEndExcluding,
            endIncl: cp.versionEndIncluding,
          });
        }
      }
    }
    out.push({ cve: v.cveID, name: v.vulnerabilityName, since: v.dateAdded, ranges });
  }
  return out;
}

/**
 * Fait franchir a une base le cran declare dans le manifeste.
 *
 * L'API ne sait monter que vers la version immediatement suivante : on refuse
 * donc toute cible qui n'est pas celle-la, plutot que d'enchainer des montees
 * que personne n'a decidees. Un retard de plusieurs versions se rattrape en
 * autant de pull requests, ce qui est le but.
 *
 * Une montee coupe le service et ne se retourne pas : la sauvegarde la precede
 * et son echec l'annule, exactement comme pour un deploiement.
 */
/**
 * Applique les montees de base declarees. En serie et jamais de front : une
 * montee coupe le service, les mener ensemble multiplierait l'indisponibilite
 * au lieu de l'etaler.
 */
/**
 * Fait avancer d'un cran les versions de base declarees, dans le manifeste
 * seulement, pour qu'une pull request porte la decision.
 *
 * Renovate ne peut pas s'en charger : une version de base Scalingo n'est pas
 * une dependance publiee quelque part, c'est un etat de la plateforme, et
 * aucune datasource ne l'expose. Le watcher tient donc ce role lui-meme.
 *
 * Seules les bases deja pilotees sont proposees : ajouter le champ une premiere
 * fois reste une decision humaine, sans quoi le watcher s'attribuerait des
 * bases que personne ne lui a confiees.
 */
async function proposeDatabaseUpgrades(targets: AppEntry[], token: string): Promise<void> {
  if (!token && !fgp) {
    log("Aucun acces a Scalingo : aucune montee ne peut etre relevee.");
    return;
  }

  const source = readFileSync(paths.manifest, "utf8");
  const document = parseDocument(source);
  const proposals: Array<{ app: string; from: string; to: string }> = [];
  const managed = targets.filter((e) => e.database && !e.paused);
  let failures = 0;

  for (const entry of managed) {
    const key = keyOf(entry);
    const expected = entry.database!.version;
    try {
      const addons = await findDatabaseAddons(entry);
      if (addons.length !== 1) continue;
      const auth = await dbAuthFor(entry, addons[0].id);
      const { database } = await req<{
        database: { readable_version: string; next_version_id: string | null };
      }>(`${dbApiHost(entry.region)}/api/databases/${addons[0].id}`, auth.token, { headers: auth.headers });

      // On ne propose que depuis un etat conforme : si le manifeste est deja en
      // avance sur le reel, c'est une montee en attente, pas une a proposer.
      if (database.readable_version !== expected) {
        log(`  ${key} : manifeste ${expected}, base ${database.readable_version}, montee deja en attente`);
        continue;
      }
      if (!database.next_version_id) {
        log(`  ${key} : base en ${expected}, deja au dernier cran`);
        continue;
      }
      const { database_type_version: v } = await req<{
        database_type_version: { major: number; minor: number; patch: number; build: number };
      }>(`${dbApiHost(entry.region)}/api/database_type_versions/${database.next_version_id}`, auth.token, {
        headers: auth.headers,
      });
      const nextVersion = `${v.major}.${v.minor}.${v.patch}-${v.build}`;

      if (crossesMajor(expected, nextVersion) && entry.database!.major !== "allowed") {
        log(`  ${key} : ${expected} -> ${nextVersion} franchit une majeure, non proposee (database.major: hold)`);
        continue;
      }

      const path = ["apps", appIndex(document, entry.app), "database", "version"];
      if (path[1] === -1 || document.getIn(path) !== expected) {
        log(`  ${key} : version ${expected} introuvable dans le manifeste, rien n'est modifie`);
        continue;
      }
      document.setIn(path, nextVersion);
      proposals.push({ app: entry.app, from: expected, to: nextVersion });
      log(`  ${key} : ${expected} -> ${nextVersion}`);
    } catch (e) {
      failures++;
      log(`  ${key} : releve impossible (${(e as Error).message.slice(0, 160)})`);
    }
  }

  // Sans ce garde, un acces casse se lisait comme un parc deja a jour : le
  // passage sortait en succes et le workflow annoncait qu'il n'y avait rien a
  // proposer.
  if (managed.length > 0 && failures === managed.length) {
    throw new Error(`aucune des ${failures} base(s) pilotee(s) n'a pu etre relevee`);
  }

  if (proposals.length === 0) {
    log(`\nAucune montee de base a proposer.`);
    if (OPT.dryRun) return;
    // Un repertoire de sortie encore a creer ne contient rien de perime.
    for (const name of paths.outDir ? [PROPOSAL_FILE, PR_TITLE_FILE, PR_BODY_FILE] : []) {
      const stale = join(paths.outDir, name);
      if (existsSync(stale)) unlinkSync(stale);
    }
    return;
  }
  if (OPT.dryRun) {
    log(`\n${proposals.length} montee(s) de base a proposer (plan : manifeste et sorties laisses en l'etat).`);
    return;
  }

  let options = writeOptions(source);
  if (!options) {
    log(`\nMise en forme de ${shown(paths.manifest)} non reproductible : il est reecrit dans la forme par defaut.`);
    options = { lineWidth: 0 };
  }
  writeFileSync(paths.manifest, document.toString(options));
  log(`\n${proposals.length} montee(s) de base proposee(s) dans le manifeste.`);

  writeFileSync(
    outFile(paths, PROPOSAL_FILE),
    JSON.stringify({ apps: proposals }, null, 2) + "\n",
  );
  const pr = describeProposal(proposals);
  writeFileSync(outFile(paths, PR_TITLE_FILE), pr.title + "\n");
  writeFileSync(outFile(paths, PR_BODY_FILE), pr.body + "\n");
}

/**
 * Titre et corps de la pull request de montee de base.
 *
 * La branche etant reutilisee d'un passage a l'autre, une pull request deja
 * relue peut se retrouver a porter autre chose. Son libelle doit donc decrire
 * ce qu'elle contient maintenant, et non ce qui avait ete propose la fois
 * precedente.
 */
export function describeProposal(proposals: Array<{ app: string; from: string; to: string }>): {
  title: string;
  body: string;
} {
  const names = proposals.map((r) => r.app).join(", ");
  const targets = new Set(proposals.map((r) => r.to));
  let title =
    proposals.length === 1
      ? `Monter la base de ${proposals[0].app} en ${proposals[0].to}`
      : targets.size === 1
        ? `Monter ${proposals.length} bases en ${[...targets][0]} : ${names}`
        : `Monter ${proposals.length} bases d'un cran : ${names}`;
  if (title.length > 100) title = `Monter ${proposals.length} bases d'un cran`;

  const body = [
    "Chaque base ne peut franchir qu'un cran a la fois : l'API Scalingo ne sait",
    "monter que vers la version immediatement suivante. Un retard de plusieurs",
    "versions demande donc autant de pull requests que de crans.",
    "",
    "**Fusionner autorise la montee, sans la declencher.** La reconciliation",
    "l'appliquera a son passage suivant, precedee d'une sauvegarde dont l'echec",
    "annule l'operation.",
    "",
    "Une montee de base coupe le service le temps de l'operation et ne se retourne",
    "pas : le retour arriere passe par la restauration de la sauvegarde. A fusionner",
    "quand l'equipe qui exploite la base est disponible.",
    "",
    `### ${proposals.length} base(s) concernee(s)`,
    "",
    ...proposals.map((r) => `- \`${r.app}\` : ${r.from} vers ${r.to}`),
    "",
    "Les montees sont enchainees en serie et jamais menees de front : chacune",
    "coupe le service de son application, les mener ensemble multiplierait",
    "l'indisponibilite au lieu de l'etaler.",
    "",
    "Pour n'en faire qu'une partie, retirer les lignes correspondantes avant de",
    "fusionner : les autres reviendront au passage suivant.",
  ];
  return { title, body: body.join("\n") };
}

/** Vrai si passer de l'une a l'autre franchit une majeure du moteur. */
const crossesMajor = (current: string, target: string) =>
  current.split(".")[0] !== target.split(".")[0];

/** Rang d'une app dans le document du manifeste, ou -1. */
function appIndex(document: Document, app: string): number {
  const apps = document.get("apps");
  if (!isSeq(apps)) return -1;
  return apps.items.findIndex((item) => isMap(item) && item.get("app") === app);
}

/**
 * Options d'ecriture qui reproduisent le manifeste a l'identique, ou null.
 *
 * La lib reecrit le document entier. Avec ses reglages par defaut, un manifeste
 * indente a quatre espaces, ou aux listes non indentees, ressortait reformate,
 * et la pull request de montee portait un diff de tout le fichier.
 */
export function writeOptions(source: string): ToStringOptions | null {
  for (const indent of [2, 4, 3]) {
    for (const indentSeq of [true, false]) {
      const options: ToStringOptions = { indent, indentSeq, lineWidth: 0 };
      if (parseDocument(source).toString(options) === source) return options;
    }
  }
  return null;
}

async function applyDatabases(targets: AppEntry[], token: string): Promise<void> {
  const managed = targets.filter((e) => e.database && !e.paused);
  if (managed.length === 0) return;

  // La validation des pull requests tourne volontairement sans acces a
  // Scalingo, pour ne pas exposer la cle du proxy a une branche quelconque.
  // Elle doit donc pouvoir annoncer les cibles sans les verifier.
  if (!token && !fgp) {
    log(`\nBases pilotees : ${managed.length}, non relevees faute d'acces`);
    for (const entry of managed) log(`  ${keyOf(entry)} : cible ${entry.database!.version}`);
    return;
  }

  log(`\nBases pilotees : ${managed.length}`);
  for (const entry of managed) {
    const key = keyOf(entry);
    const expected = entry.database!.version;
    try {
      const addons = await findDatabaseAddons(entry);
      if (addons.length === 0) {
        log(`  ${key} : aucune base trouvee alors que le manifeste en declare une`);
        note(key, `le manifeste declare une version de base mais aucun addon de base n'existe`);
        continue;
      }
      if (addons.length > 1) {
        log(`  ${key} : ${addons.length} bases, le manifeste n'en designe qu'une, rien n'est tente`);
        note(key, `${addons.length} bases sur cette app : le manifeste ne sait pas laquelle piloter`);
        continue;
      }
      if (OPT.dryRun) {
        log(`  ${key} : cible ${expected} (plan, aucune montee)`);
        continue;
      }
      const result = await upgradeDatabase(entry, addons[0].id, expected, log);
      if (result === "up-to-date") log(`  ${key} : base deja en ${expected}`);
    } catch (e) {
      log(`  ${key} : INTERROMPU : ${(e as Error).message}`);
      note(key, `montee de base interrompue : ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

async function upgradeDatabase(
  entry: AppEntry,
  addonId: string,
  expected: string,
  emit: (l: string) => void,
): Promise<"upgraded" | "up-to-date" | "rejected" | "error"> {
  const key = keyOf(entry);
  const auth = await dbAuthFor(entry, addonId);
  const base = `${dbApiHost(entry.region)}/api/databases/${addonId}`;

  const { database } = await req<{
    database: { readable_version: string; next_version_id: string | null };
  }>(base, auth.token, { headers: auth.headers });

  if (database.readable_version === expected) return "up-to-date";

  if (!database.next_version_id) {
    emit(`    la base est en ${database.readable_version}, aucune montee n'est proposee`);
    note(key, `base en ${database.readable_version}, le manifeste attend ${expected} mais aucune montee n'est proposee`);
    return "rejected";
  }

  const { database_type_version: nextVersion } = await req<{
    database_type_version: { major: number; minor: number; patch: number; build: number };
  }>(`${dbApiHost(entry.region)}/api/database_type_versions/${database.next_version_id}`, auth.token, {
    headers: auth.headers,
  });
  const nextName = `${nextVersion.major}.${nextVersion.minor}.${nextVersion.patch}-${nextVersion.build}`;

  if (nextName !== expected) {
    emit(`    la base est en ${database.readable_version}, la suivante est ${nextName}, le manifeste attend ${expected}`);
    note(key, `cible de base inatteignable : depuis ${database.readable_version}, seule ${nextName} est accessible, le manifeste attend ${expected}`);
    return "rejected";
  }

  if (crossesMajor(database.readable_version, expected) && entry.database!.major !== "allowed") {
    emit(`    ${database.readable_version} -> ${expected} franchit une majeure du moteur, refuse`);
    emit(`    poser database.major: allowed dans le manifeste pour l'autoriser`);
    note(key, `montee de ${database.readable_version} vers ${expected} refusee : elle franchit une majeure du moteur et database.major vaut hold`);
    return "rejected";
  }

  emit(`    sauvegarde avant montee de base...`);
  const backup = await backupAddon(entry, addonId, emit);
  emit(`    sauvegarde ${backup.id} disponible`);

  emit(`    montee de la base ${database.readable_version} -> ${nextName}...`);
  // L'URL de suivi est celle que Scalingo renvoie en en-tete Location, et non
  // une URL reconstruite : la reconstruire a produit un 404 alors que la montee
  // s'etait bien lancee, et le suivi rapportait un echec sur une operation
  // reussie. Seul le chemin est conserve, l'hote devant rester le proxy.
  const launched = await fetch(`${base}/upgrade`, {
    method: "POST",
    headers: {
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      Accept: "application/json",
      ...auth.headers,
    },
  });
  if (!launched.ok) {
    const body = await launched.text().catch(() => "");
    throw new Error(`${launched.status} sur POST ${base}/upgrade${body ? ` :: ${body.slice(0, 200)}` : ""}`);
  }
  const location = launched.headers.get("location");
  const payload = (await launched.json().catch(() => ({}))) as {
    operation_id?: string;
    operation?: { id: string };
  };
  const operationId = payload.operation_id ?? payload.operation?.id;
  const trackingUrl = location
    ? `${dbApiHost(entry.region)}${new URL(location, dbApiHost(entry.region)).pathname}`
    : operationId
      ? `${dbApiHost(entry.region)}/api/operations/${operationId}`
      : null;

  if (!trackingUrl) {
    emit(`    montee lancee, aucune adresse de suivi rendue, etat non verifiable`);
    note(key, `montee de base lancee sans adresse de suivi : verifier son aboutissement a la main`);
    return "error";
  }

  // La base fait foi, pas l'operation : un suivi devenu introuvable ne dit rien
  // de l'aboutissement, alors que la version en place le dit exactement.
  const reachedTarget = async (): Promise<boolean> => {
    try {
      const { database: d } = await req<{ database: { readable_version: string } }>(base, auth.token, {
        headers: auth.headers,
      });
      return d.readable_version === expected;
    } catch {
      return false;
    }
  };

  const deadline = Date.now() + DB_UPGRADE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let operation: { status: string; error?: string };
    try {
      ({ operation } = await req<{ operation: { status: string; error?: string } }>(trackingUrl, auth.token, {
        headers: auth.headers,
      }));
    } catch (e) {
      if (await reachedTarget()) {
        emit(`    succes (suivi indisponible, la base est en ${expected})`);
        return "upgraded";
      }
      throw e;
    }
    if (operation.status === "done") {
      emit(`    succes`);
      return "upgraded";
    }
    if (operation.status === "pending" || operation.status === "running") continue;
    if (/error|fail/i.test(operation.status)) {
      emit(`    ECHEC de la montee (${operation.status})`);
      note(key, `montee de base en echec (${operation.status}${operation.error ? ` : ${operation.error.slice(0, 160)}` : ""}). La sauvegarde ${backup.id} precede la tentative.`);
      return "error";
    }
  }
  emit(`    montee toujours en cours au bout de ${Math.round(DB_UPGRADE_TIMEOUT_MS / 60000)} minutes, abandon du suivi`);
  note(key, `montee de base toujours en cours apres ${Math.round(DB_UPGRADE_TIMEOUT_MS / 60000)} minutes : elle se poursuit cote Scalingo, verifier son aboutissement`);
  return "error";
}

/** Nom de la version que Scalingo propose ensuite, ou null s'il n'en propose pas. */
async function nextVersionName(
  entry: AppEntry,
  addonId: string,
): Promise<string | null> {
  try {
    const auth = await dbAuthFor(entry, addonId);
    const { database } = await req<{ database: { next_version_id: string | null } }>(
      `${dbApiHost(entry.region)}/api/databases/${addonId}`,
      auth.token,
      { headers: auth.headers },
    );
    if (!database.next_version_id) return null;
    const { database_type_version: v } = await req<{
      database_type_version: { major: number; minor: number; patch: number; build: number };
    }>(`${dbApiHost(entry.region)}/api/database_type_versions/${database.next_version_id}`, auth.token, {
      headers: auth.headers,
    });
    return `${v.major}.${v.minor}.${v.patch}-${v.build}`;
  } catch {
    return null;
  }
}

async function checkDatabases(targets: AppEntry[], token: string): Promise<void> {
  if (!token && !fgp) return;
  let readCount = 0;
  for (const entry of targets) {
    if (entry.paused) continue;
    let addons: Array<{ id: string; addon_provider: { id: string; name: string } }>;
    try {
      addons = await findDatabaseAddons(entry);
    } catch {
      continue;
    }
    for (const addon of addons) {
      const db = await readDatabaseVersion(entry, addon.id);
      if (!db) continue;
      readCount++;
      const nextVersion = db.upgradable ? await nextVersionName(entry, addon.id) : null;
      observedDatabases.set(keyOf(entry), { version: db.version, nextVersion, engine: addon.addon_provider?.id ?? null });
      if (!db.upgradable) continue;

      // Une montee qu'on a decide de retenir n'est pas une echeance : la
      // signaler a chaque passage rendrait l'alerte permanente, donc ignoree.
      if (nextVersion && crossesMajor(db.version, nextVersion) && entry.database?.major !== "allowed") {
        continue;
      }
      warn(
        keyOf(entry),
        `base en ${db.version}, ${nextVersion ?? "une version plus recente"} est disponible`,
      );
    }
  }
  if (readCount > 0) dbChecked = readCount;
}

let dbChecked = 0;

async function checkExploited(targets: AppEntry[], lock: Lock): Promise<void> {
  // Une version par produit suffit a interroger les sources : les instances
  // partagent la meme, et le reste n'est qu'une comparaison locale.
  const products = new Map<string, string>();
  for (const e of targets) products.set(envToProduct(e.tool.env), e.tool.env);

  for (const [product] of products) {
    const exploits = await exploitedRangesFor(product);
    if (exploits.length === 0) continue;
    for (const e of targets) {
      if (envToProduct(e.tool.env) !== product) continue;
      const raw = lock.apps[keyOf(e)]?.tool.version ?? e.tool.version;
      const v = raw ? parseSemver(raw) : null;
      if (!v) continue;
      for (const f of exploits) {
        if (!f.ranges.some((r) => versionInRange(v, r))) continue;
        alert(
          keyOf(e),
          `${raw} est affectee par ${f.cve} (${f.name}), exploitee depuis le ${f.since}`,
        );
      }
    }
  }
}

const envToProduct = (envName: string) => envName.replace(/_VERSION$/, "").toLowerCase();

// ---------------------------------------------------------------- main

// Le schema appartient au moteur : il voyage avec lui, pas avec le parc.
const SCHEMA_FILE = join(import.meta.dirname, "..", "schema", "manifest.schema.json");

/**
 * Champs du manifeste renommes depuis leur introduction. L'ancien nom reste
 * accepte, avec un avertissement : une montee de l'outil ne doit casser aucun
 * parc, le renommage se faisant ensuite a son rythme. Un chemin qui commence
 * par apps[]. vaut pour chaque app.
 */
export type Rename = { from: string; to: string };
export const RENAMED_FIELDS: readonly Rename[] = [];

/**
 * Champs cherches sous leur nom dans le texte brut du manifeste : par les
 * expressions des presets Renovate, par les controles d'annotations de
 * --validate et par l'edition de --propose-db. Un alias n'y serait pas vu, donc
 * ni eux ni leurs parents ne passent par RENAMED_FIELDS. Les renommer demande de
 * faire evoluer ces lecteurs avec.
 */
export const RAW_FIELDS: readonly string[] = [
  "apps",
  "apps[].app",
  "apps[].source.branch",
  "apps[].source.sha",
  "apps[].tool.version",
  "apps[].database.version",
];

const PER_APP = "apps[].";
type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === "object" && v !== null && !Array.isArray(v);

function parentOf(holder: Fields, keys: string[], create: boolean): Fields | null {
  let node: Fields = holder;
  for (const key of keys.slice(0, -1)) {
    if (create && node[key] === undefined) node[key] = {};
    const next = node[key];
    if (!isFields(next)) return null;
    node = next;
  }
  return node;
}

/** Ramene chaque ancien nom a son nom courant, en place. */
export function resolveAliases(
  manifest: unknown,
  renames: readonly Rename[] = RENAMED_FIELDS,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!isFields(manifest)) return { warnings, errors };
  for (const { from, to } of renames) {
    const perApp = from.startsWith(PER_APP);
    if (perApp !== to.startsWith(PER_APP)) throw new Error(`renommage ${from} -> ${to} : portees differentes`);
    const raw = RAW_FIELDS.find((field) => [from, to].some((path) => field === path || field.startsWith(`${path}.`)));
    if (raw) throw new Error(`renommage ${from} -> ${to} : ${raw} est lu dans le texte du manifeste, ou un alias ne serait pas vu`);
    const fromKeys = (perApp ? from.slice(PER_APP.length) : from).split(".");
    const toKeys = (perApp ? to.slice(PER_APP.length) : to).split(".");
    const [oldName, newName] = [fromKeys.join("."), toKeys.join(".")];
    const holders: Array<[string, Fields]> = perApp
      ? (Array.isArray(manifest.apps) ? manifest.apps : []).flatMap((app, i) =>
          isFields(app) ? [[`apps[${i}]${typeof app.app === "string" ? ` (${app.app})` : ""} : `, app] as [string, Fields]] : [],
        )
      : [["", manifest]];

    for (const [where, holder] of holders) {
      const oldParent = parentOf(holder, fromKeys, false);
      const oldKey = fromKeys.at(-1)!;
      if (!oldParent || !(oldKey in oldParent)) continue;
      const value = oldParent[oldKey];
      const newParent = parentOf(holder, toKeys, false);
      const current = newParent?.[toKeys.at(-1)!];
      // Garder l'un des deux en silence deploierait peut-etre l'autre valeur
      // que celle qu'on croit avoir ecrite.
      if (current !== undefined && !isDeepStrictEqual(current, value)) {
        errors.push(`${where}${oldName} et ${newName} se contredisent : retirer ${oldName}, ancien nom de ${newName}`);
        continue;
      }
      const target = parentOf(holder, toKeys, true);
      if (!target) {
        errors.push(`${where}${oldName} ne peut pas devenir ${newName}, dont un parent n'est pas un objet`);
        continue;
      }
      delete oldParent[oldKey];
      target[toKeys.at(-1)!] = value;
      warnings.push(`${where}${oldName} est l'ancien nom de ${newName} : toujours accepte, a renommer`);
    }
  }
  return { warnings, errors };
}

/** Ecarts d'un manifeste deja lu au schema du moteur, vide s'il est conforme. */
export function schemaErrors(manifest: unknown): string[] {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (validate(manifest)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/** Manifeste lu, ses anciens noms ramenes aux noms courants, puis confronte au schema. */
export function readManifest(
  file: string,
  renames: readonly Rename[] = RENAMED_FIELDS,
): { manifest: Manifest; warnings: string[]; errors: string[] } {
  const manifest = parse(readFileSync(file, "utf8")) as Manifest;
  const { warnings, errors } = resolveAliases(manifest, renames);
  if (errors.length === 0) errors.push(...schemaErrors(manifest));
  return { manifest, warnings, errors };
}

function loadManifest(): Manifest {
  const { manifest, warnings, errors } = readManifest(paths.manifest);
  for (const w of warnings) log(`avertissement : ${w}`);
  if (errors.length > 0) {
    log(`${shown(paths.manifest)} invalide :`);
    for (const e of errors) log(`  ${e}`);
    process.exit(1);
  }
  if (warnings.length > 0) log("");
  return manifest;
}

/** Ligne qui precede celle ou commence la cle `field` d'une map YAML, ou null. */
function lineBeforeKey(source: string, map: unknown, field: string): string | null {
  if (!isMap(map)) return null;
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === field);
  const offset = isScalar(pair?.key) ? pair.key.range?.[0] : undefined;
  if (offset === undefined) return null;
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  if (lineStart === 0) return null;
  return source.slice(source.lastIndexOf("\n", lineStart - 2) + 1, lineStart - 1).trim();
}

/**
 * Controles sur les donnees du parc que le schema ne peut pas exprimer, faute
 * de voir les commentaires et le lock.
 *
 * Une annotation # renovate: deplacee ou supprimee coupe la veille de la ligne
 * qui suit, sans aucune erreur visible. Une annotation git-refs qui designe un
 * autre depot que source.repo fait chercher a Renovate une branche qui n'existe
 * pas. Une entree de lock sans app n'est plus suivie et decrit un parc qui
 * n'existe pas.
 */
export function checkFleetData(source: string, manifest: Manifest, lock: Lock): string[] {
  const issues: string[] = [];
  const document = parseDocument(source);
  manifest.apps.forEach((entry, i) => {
    const key = keyOf(entry);
    const shaNote = lineBeforeKey(source, document.getIn(["apps", i, "source"], true), "sha") ?? "";
    const annotated = /^#\s*renovate:\s*datasource=git-refs\s+depName=(\S+)/.exec(shaNote)?.[1];
    if (!annotated) {
      issues.push(`${key} : sha n'est pas precede de son annotation # renovate: datasource=git-refs depName=${entry.source.repo}, Renovate ne le suit pas`);
    } else if (annotated !== entry.source.repo) {
      issues.push(`${key} : l'annotation de sha designe ${annotated}, le depot declare est ${entry.source.repo}`);
    }
    const versionNote = lineBeforeKey(source, document.getIn(["apps", i, "tool"], true), "version") ?? "";
    if (!/^#\s*renovate:\s*datasource=\S+\s+depName=\S+/.test(versionNote)) {
      issues.push(`${key} : tool.version n'est pas precedee de son annotation # renovate:, Renovate ne la suit pas`);
    }
  });
  const declared = new Set(manifest.apps.map(keyOf));
  for (const orphan of Object.keys(lock.apps).filter((k) => !declared.has(k))) {
    issues.push(`${orphan} : entree de lock sans app dans le manifeste, a retirer par --prune si l'abandon est definitif`);
  }
  return issues;
}

/** Version du format de lock que ce moteur sait lire et reecrire. */
const LOCK_VERSION = 1;

export function loadLock(file: string): Lock {
  if (!existsSync(file)) return { version: LOCK_VERSION, generatedAt: null, apps: {} };
  const lock = JSON.parse(readFileSync(file, "utf8")) as Lock;
  if (!Number.isInteger(lock.version) || lock.version < 1) {
    throw new Error(`${shown(file)} : version illisible (${JSON.stringify(lock.version)})`);
  }
  // Un moteur plus ancien reecrirait le lock sans les champs qu'il ne connait
  // pas, et les perdrait : c'est ce qui arrive au retour sur une version
  // anterieure de l'outil apres qu'une plus recente a ecrit le lock.
  if (lock.version > LOCK_VERSION) {
    throw new Error(
      `${shown(file)} est en version ${lock.version}, ce moteur ne lit que jusqu'a la version ${LOCK_VERSION} : mettre a jour scalingo-watcher`,
    );
  }
  return lock;
}

function saveLock(lock: Lock, before: string): boolean {
  if (JSON.stringify(lock.apps) === before) return false;
  lock.generatedAt = new Date().toISOString();
  writeFileSync(paths.lock, JSON.stringify(lock, null, 2) + "\n");
  return true;
}

async function main() {
  paths = resolvePaths(argv);
  OPT.appFilter = flagValue(argv, "--app");
  const apiToken = process.env.SCALINGO_API_TOKEN;
  loadFgp(paths.fgp);

  const manifest = loadManifest();
  if (OPT.validateOnly) {
    const issues = checkFleetData(readFileSync(paths.manifest, "utf8"), manifest, loadLock(paths.lock));
    if (issues.length > 0) {
      log(`${shown(paths.manifest)} incoherent :`);
      for (const issue of issues) log(`  ${issue}`);
      process.exit(1);
    }
    log(`${shown(paths.manifest)} valide : ${manifest.apps.length} app(s)`);
    return;
  }

  // --validate, --prune et --dry-run n'ecrivent que des fichiers locaux.
  const offline = OPT.dryRun || OPT.prune || OPT.validateOnly;
  // Le proxy porte l'authentification a lui seul : reclamer en plus un jeton de
  // compte reviendrait a exiger ce qu'on vient justement de retirer du depot.
  if (!apiToken && !fgp && !offline) {
    log("Aucun acces configure.");
    for (const line of accessModes(paths.fgp)) log(line);
    process.exit(1);
  }

  // bearerToken() lit cette variable et rend une chaine vide tant qu'elle
  // n'est pas posee. L'affecter plus bas, apres la branche --adopt, laissait
  // l'amorcage partir sans entete d'authentification et echouer en 401 sur
  // chaque app, sans que rien ne le signale.
  apiTokenRaw = apiToken ?? "";

  const targets = OPT.appFilter ? manifest.apps.filter((a) => a.app.includes(OPT.appFilter!)) : manifest.apps;

  // La proposition ne lit que les bases et n'ecrit que le manifeste. Elle ne
  // tourne pas sous le verrou de la convergence et seul le manifeste en est
  // commite : elle sort donc avant le lock, quelles que soient les autres options.
  if (OPT.proposeDb) {
    if (targets.length === 0) {
      log("aucune app ne correspond au filtre.");
      return;
    }
    log("PROPOSITION DE MONTEES DE BASE\n");
    await proposeDatabaseUpgrades(targets, apiToken ? await bearerToken() : "");
    return;
  }

  const lock = loadLock(paths.lock);
  const lockBefore = JSON.stringify(lock.apps);

  // Retirer une entree n'est pas anodin : on perd l'historique de deploiement,
  // la derniere sauvegarde et l'eventuelle quarantaine de l'app. Une app sortie
  // du manifeste le temps d'une investigation reviendrait en "premiere prise en
  // charge" et serait redeployee pour rien. D'ou une commande explicite plutot
  // qu'un nettoyage silencieux a chaque passage.
  if (OPT.prune) {
    const declared = new Set(manifest.apps.map(keyOf));
    const orphans = Object.keys(lock.apps).filter((k) => !declared.has(k));
    if (orphans.length === 0) {
      log("Aucune entree orpheline dans le lock.");
      return;
    }
    log(`${orphans.length} entree(s) retiree(s) du lock :`);
    for (const k of orphans) {
      const e = lock.apps[k];
      log(`  ${k} : ${e.tool.version ?? "non epinglee"} @ ${e.source.sha.slice(0, 7) || "?"}`);
      delete lock.apps[k];
    }
    saveLock(lock, lockBefore);
    log(`\n${shown(paths.lock)} mis a jour, ${Object.keys(lock.apps).length} app(s) restantes.`);
    return;
  }

  if (OPT.force && !OPT.appFilter) {
    log("--force redeploierait tout le parc. Restreins la cible avec --app.");
    process.exit(1);
  }

  if (targets.length === 0) {
    log("aucune app ne correspond au filtre.");
    return;
  }

  if (OPT.adopt) {
    // Pas d'echange de jeton ici : reqApi s'authentifie seul, par le proxy ou
    // par bearerToken(). L'echanger de force exigeait un jeton de compte que la
    // configuration par proxy n'a justement pas.
    log(`AMORCAGE DU LOCK depuis l'etat reel (${targets.length} app(s), aucun deploiement)\n`);
    let adoptedCount = 0;
    for (const entry of targets) {
      try {
        const e = await adoptApp(entry);
        lock.apps[keyOf(entry)] = e;
        adoptedCount++;
        const drift = e.tool.version !== entry.tool.version || e.source.sha !== entry.source.sha;
        const shownVersion = e.tool.version ?? `<${entry.tool.env} absente>`;
        log(`  ${keyOf(entry)} : ${shownVersion} @ ${e.source.sha.slice(0, 7)}${drift ? "   <- differe du manifest" : ""}`);
      } catch (err) {
        log(`  ${keyOf(entry)} : releve impossible (${(err as Error).message})`);
      }
    }
    // Un amorcage qui ne releve rien laissait le lock vide en annoncant le
    // contraire, et sortait en 0.
    if (adoptedCount === 0) {
      log(`\nAucune app relevee, ${shown(paths.lock)} laisse en l'etat.`);
      process.exit(1);
    }
    saveLock(lock, lockBefore);
    log(`\n${shown(paths.lock)} amorce, ${adoptedCount}/${targets.length} app(s) relevee(s).`);
    log(`Relance \`node src/apply.ts --dry-run\` pour voir le vrai ecart.`);
    return;
  }


  // Le plan n'ecrit rien mais lit les statuts quand un token est fourni, sinon il
  // annoncerait des deploiements sur des apps eteintes.
  const token = apiToken ? await bearerToken() : "";
  if (OPT.dryRun && !token) log("(sans SCALINGO_API_TOKEN, le plan ignore l'etat reel des apps)\n");

  // Renovate fusionne le manifeste puis s'arrete : il ne repasse jamais sur une
  // app restee en arriere. Et rien ne garantit que le lock decrive encore le
  // parc, puisqu'une variable peut avoir ete changee a la main. La
  // reconciliation traite les deux : elle releve le reel, signale ce qui a
  // bouge hors du watcher, puis laisse l'application converger.
  if (OPT.reconcile && (token || fgp)) {
    log("RELEVE DE L'ETAT REEL\n");
    let drifts = 0;
    for (const entry of targets) {
      const key = keyOf(entry);
      const known = lock.apps[key];
      let real: LockEntry;
      try {
        real = await adoptApp(entry);
      } catch (e) {
        log(`  ${key} : releve impossible (${(e as Error).message})`);
        continue;
      }
      if (known && (known.tool.version !== real.tool.version || known.source.sha !== real.source.sha)) {
        drifts++;
        const was = `${known.tool.version ?? "non epinglee"} @ ${known.source.sha.slice(0, 7) || "?"}`;
        const now = `${real.tool.version ?? "non epinglee"} @ ${real.source.sha.slice(0, 7)}`;
        log(`  ${key} : DERIVE, le lock disait ${was}, le parc dit ${now}`);
      }
      // La quarantaine survit au releve, sinon chaque passage la leverait et on
      // retenterait indefiniment une cible qui echoue. Elle tombe en revanche si
      // l'app a atteint la cible entre-temps, quel qu'en soit le moyen.
      const reached =
        real.source.sha === entry.source.sha && real.tool.version === entry.tool.version;
      lock.apps[key] = { ...real, quarantine: reached ? null : (known?.quarantine ?? null) };
    }
    log(drifts === 0 ? "\nAucune derive.\n" : `\n${drifts} derive(s) relevee(s).\n`);
  }

  log(OPT.dryRun ? "PLAN (aucune ecriture)" : "APPLICATION");
  log(`${targets.length} app(s), dans l'ordre du manifest\n`);

  const tally: Record<Outcome, number> = {
    "up-to-date": 0,
    "quarantined-skip": 0,
    deployed: 0,
    failed: 0,
    error: 0,
    planned: 0,
    rejected: 0,
    paused: 0,
    "skipped-state": 0,
  };

  // L'eclaireur est la premiere app REELLEMENT deployee, pas la premiere du
  // manifest : si les trois premieres sont deja conformes, c'est la quatrieme
  // qui essuie les platres et dont l'echec doit arreter la vague.
  // L'eclaireur passe seul et bloque la suite en cas d'echec : rien ne sert de
  // mener six deploiements de front si la cible elle-meme est mauvaise. Une fois
  // qu'une app est passee, les autres sont independantes et peuvent avancer
  // ensemble, leurs bases etant separees et leur ordre sans importance.
  let scoutDone = false;
  let stopped = false;
  let interruptedScouts = 0;
  let i = 0;

  for (; i < targets.length && !scoutDone && !stopped; i++) {
    const outcome = await applyApp(targets[i], manifest, lock, token, log);
    tally[outcome]++;
    // en plan, une app retenue joue le meme role pour que la structure de la
    // vague soit visible sans rien deployer
    if (outcome === "deployed" || (OPT.dryRun && outcome === "planned")) scoutDone = true;
    if (outcome === "failed") {
      log(`\nEchec sur l'eclaireur. La cible est probablement en cause, la vague s'arrete ici.`);
      stopped = true;
    } else if (outcome !== "error" && outcome !== "paused") {
      // Une app menee a son terme prouve que Scalingo repond, et rompt la serie.
      // `paused` ne prouve rien : il se decide a la lecture du manifeste.
      interruptedScouts = 0;
    } else if (outcome === "error") {
      // Une interruption ne dit rien de la cible, le type Outcome le pose deja.
      // L'eclaireur s'arretait pourtant dessus comme sur un echec : une base
      // lente sur la premiere app du manifeste figeait tout le parc, alors que
      // les bases des suivantes n'ont rien a voir avec elle. L'app suivante
      // reprend donc le role.
      interruptedScouts++;
      if (interruptedScouts >= MAX_INTERRUPTED_SCOUTS) {
        log(
          `\n${interruptedScouts} eclaireurs interrompus. C'est l'acces a Scalingo qui est en cause, pas une app, la vague s'arrete ici.`,
        );
        stopped = true;
      } else {
        log(
          `\nOperation interrompue sur ${keyOf(targets[i])}, rien ne dit que la cible est en cause. L'app suivante prend le role d'eclaireur.`,
        );
      }
    }
  }

  const rest = stopped ? [] : targets.slice(i);
  if (stopped) {
    const remaining = targets.length - i;
    if (remaining > 0) log(`Les ${remaining} app(s) suivantes n'ont pas ete touchees.`);
  } else if (rest.length > 0) {
    if (scoutDone) log(`\n${rest.length} app(s) restantes, menees ${DEPLOY_CONCURRENCY} de front.\n`);
    const outcomes = await pool(rest, DEPLOY_CONCURRENCY, async (entry) => {
      // La sortie est accumulee puis rendue d'un bloc : entrelacee, elle
      // deviendrait illisible des deux apps.
      const lines: string[] = [];
      const outcome = await applyApp(entry, manifest, lock, token, (l) => lines.push(l));
      log(lines.join("\n"));
      return outcome;
    });
    for (const o of outcomes) tally[o]++;
  }

  if (!OPT.dryRun) {
    log(saveLock(lock, lockBefore) ? `\n${shown(paths.lock)} mis a jour` : `\n${shown(paths.lock)} inchange`);
  }

  log("");
  log(
    `conformes ${tally["up-to-date"]}  deployees ${tally.deployed}  echecs ${tally.failed}  ` +
      `interrompues ${tally.error}  quarantaine ${tally["quarantined-skip"]}  ` +
      `rejetees ${tally.rejected}  en pause ${tally.paused}  ` +
      `non deployables ${tally["skipped-state"]}  planifiees ${tally.planned}`,
  );

  await applyDatabases(targets, token);

  await checkExploited(targets, lock);
  await checkDatabases(targets, token);

  // Une surveillance silencieuse doit dire qu'elle a regarde, sinon son silence
  // se confond avec son absence.
  const stacksSeen = [...stackCache.values()].reduce((n, m) => n + m.size, 0);
  if (warnings.length === 0) {
    log(
      stacksSeen > 0
        ? `\nAucune echeance. ${stacksSeen} stack(s) confrontes sur ${stackCache.size} region(s), ${dbChecked} base(s) relevee(s).`
        : `\nAucune echeance verifiee : aucun stack n'a pu etre lu.`,
    );
  }


  if (security.length > 0) {
    log(`\n${security.length} faille(s) activement exploitee(s) :`);
    for (const { key, detail } of security) log(`  ${key} : ${detail}`);
    log(`Monter la version prime sur le delai de decantation habituel.`);
  }

  if (warnings.length > 0) {
    log(`\n${warnings.length} echeance(s) a prevoir :`);
    for (const { key, detail } of warnings) log(`  ${key} : ${detail}`);
    log(`Rien ne casse aujourd'hui, mais personne ne le verra venir sans cela.`);
  }

  const wanted = new Map(targets.map((e) => [keyOf(e), { sha: e.source.sha, version: e.tool.version }]));
  const declared = new Set(manifest.apps.map(keyOf));
  const orphans = Object.keys(lock.apps).filter((k) => !declared.has(k));
  if (orphans.length > 0) {
    log("");
    log(`${orphans.length} entree(s) de lock sans app correspondante dans le manifeste :`);
    for (const k of orphans) log(`  ${k}`);
    log(`Elles ne sont plus suivies. Les retirer du lock si l'abandon est definitif.`);
  }

  const stuck = Object.entries(lock.apps).filter(([k, v]) => {
    if (!v.quarantine) return false;
    const t = wanted.get(k);
    return t ? sameTarget(v.quarantine.target, t) : true;
  });
  if (stuck.length > 0) {
    log(`\n${stuck.length} app(s) en quarantaine :`);
    for (const [k, v] of stuck) log(`  ${k} : ${v.quarantine!.reason} (cible ${v.quarantine!.target.version})`);
    log(`Elles repartiront d'elles-memes des que le manifest pointera une autre cible.`);
  }

  if (!OPT.dryRun) await writeIncident(lock, targets);

  if (tally.failed > 0 || tally.error > 0) process.exit(1);
}

// Le fichier est aussi importe par test/test.ts, qui exerce backupAddon contre un
// fetch simule. Sans ce garde, l'import lancerait une convergence sur le parc.
if (import.meta.main) {
  main().catch((e) => {
    log(`\nEchec: ${(e as Error).message}`);
    process.exit(1);
  });
}
