/**
 * Relais entre les notifiers webhook de Scalingo et le run de reprise du parc.
 *
 * Un deploiement asynchrone se termine sans attendre Scalingo : quelqu'un doit
 * relancer la reprise quand le deploiement ou la sauvegarde aboutit, sans quoi
 * elle attend le cron. Chaque app porte un notifier qui poste ici ses fins de
 * deploiement et de sauvegarde, et le relais en tire un workflow_dispatch du
 * depot du parc, avec l'input resume.
 *
 *   POST /<RELAY_SECRET>   evenement Scalingo
 *   GET  /healthz          sonde de disponibilite, 503 si le dernier dispatch a ete refuse
 *
 *   RELAY_SECRET            obligatoire, 32 caracteres au moins
 *   GITHUB_TOKEN            obligatoire, seule permission Actions: write sur le depot du parc
 *   GITHUB_REPOSITORY       obligatoire, proprietaire/depot
 *   RELAY_WORKFLOW          defaut reconcile.yml
 *   RELAY_REF               defaut main
 *   RELAY_DELAY             secondes, defaut 150, retard d'une fin de deploiement reussie
 *   RELAY_MIN_INTERVAL      secondes, defaut 60, ecart minimal entre deux dispatch
 *   RELAY_APPS              facultatif, apps suivies, separees par des virgules
 *   RELAY_GROUP_WORKFLOWS   defaut <RELAY_WORKFLOW>,apply.yml, workflows du groupe scalingo-apply
 *   RELAY_PERIODIC_BACKUPS  defaut ignore, relay pour relayer aussi les sauvegardes periodiques
 *   PORT                    defaut 3000
 *
 * RELAY_DELAY se regle sur la plus grande fenetre de garde du parc, plus une
 * marge : la reprise ne conclut un deploiement reussi qu'une fois sa fenetre
 * ecoulee.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Config = {
  secret: string;
  token: string;
  repository: string;
  workflow: string;
  ref: string;
  delayMs: number;
  minIntervalMs: number;
  apps: ReadonlySet<string> | null;
  groupWorkflows: ReadonlySet<string>;
  relayPeriodicBackups: boolean;
  port: number;
};

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Deps = {
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  now: () => number;
};

const defaultDeps: Deps = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  now: () => Date.now(),
};

// Vingt dispatch espaces d'une journee tiennent encore sous les 2^31 ms
// au-dela desquelles setTimeout part aussitot.
const MAX_SECONDS = 86_400;
export const MAX_PENDING = 20;
export const BODY_LIMIT = 64 * 1024;
const ATTEMPTS = 3;
const RETRY_BASE_MS = 1_000;
// Scalingo laisse 30 s entre SIGTERM et SIGKILL. L'arret y fait tenir 27 s :
// l'attente des requetes en cours, la lecture des runs en attente, puis trois
// essais de dispatch et leurs deux attentes.
const CLOSE_WAIT_MS = 2_000;
const READ_TIMEOUT_MS = 4_000;
const ATTEMPT_TIMEOUT_MS = 6_000;
const RESCHEDULE_FIRST_MS = 30_000;
const RESCHEDULE_CAP_MS = 10 * 60_000;
const RESCHEDULE_WINDOW_MS = 30 * 60_000;
// Refus qui se reproduiront a chaque dispatch : jeton expire ou sans droit,
// depot ou workflow introuvable, input resume non declare, branche absente.
const BROKEN_STATUSES = new Set([401, 403, 404, 422]);

// Une fin en echec se conclut aussitot. Un statut inconnu est traite comme un
// succes : un ping trop tot coute un run qui ne conclut rien puis l'attente du
// cron, un ping en retard ne coute que le retard.
const FAILED_DEPLOYMENTS = new Set(["build-error", "crashed-error", "timeout-error", "hook-error", "aborted"]);
const BACKUP_EVENTS = new Set(["database_backup_succeeded", "database_backup_failed"]);

const WORKFLOW_PATTERN = /^(?:[A-Za-z0-9._-]+\.ya?ml|\d+)$/;

type Env = Record<string, string | undefined>;

/**
 * Configuration lue dans l'environnement. Les erreurs ne citent jamais la
 * valeur recue : une variable mal renseignee porte parfois le jeton d'une autre.
 */
export function readConfig(env: Env): { config: Config | null; errors: string[] } {
  const errors: string[] = [];
  // Un fichier .env ou un compose posent volontiers une variable vide pour dire
  // qu'elle prend son defaut.
  const value = (name: string) => (env[name] === "" ? undefined : env[name]);

  const secret = value("RELAY_SECRET");
  if (!secret) errors.push("RELAY_SECRET est requis");
  else if (secret.length < 32) errors.push(`RELAY_SECRET fait ${secret.length} caracteres, il en faut au moins 32`);
  else if (!/^[A-Za-z0-9._~-]+$/.test(secret)) {
    errors.push("RELAY_SECRET entre tel quel dans l'adresse du webhook : lettres, chiffres et . _ ~ - seulement");
  }

  const token = value("GITHUB_TOKEN");
  if (!token) errors.push("GITHUB_TOKEN est requis : jeton a la seule permission Actions: write sur le depot du parc");
  else if (/\s/.test(token)) errors.push("GITHUB_TOKEN contient un espace ou un retour a la ligne");

  const repository = value("GITHUB_REPOSITORY");
  if (!repository) errors.push("GITHUB_REPOSITORY est requis, sous la forme proprietaire/depot");
  else if (!/^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/.test(repository)) {
    errors.push("GITHUB_REPOSITORY attend la forme proprietaire/depot, par exemple mon-org/mon-parc");
  }

  const workflow = value("RELAY_WORKFLOW") ?? "reconcile.yml";
  if (!WORKFLOW_PATTERN.test(workflow)) {
    errors.push("RELAY_WORKFLOW attend un nom de fichier de .github/workflows/, comme reconcile.yml, ou l'identifiant numerique du workflow");
  }

  const ref = value("RELAY_REF") ?? "main";
  if (/\s/.test(ref)) errors.push("RELAY_REF attend un nom de branche, sans espace");

  const seconds = (name: string, fallback: number): number => {
    const raw = value(name);
    if (raw === undefined) return fallback * 1000;
    if (/^\d+(?:\.\d+)?$/.test(raw) && Number(raw) <= MAX_SECONDS) return Math.round(Number(raw) * 1000);
    errors.push(`${name} attend un nombre de secondes entre 0 et ${MAX_SECONDS}`);
    return 0;
  };
  const delayMs = seconds("RELAY_DELAY", 150);
  const minIntervalMs = seconds("RELAY_MIN_INTERVAL", 60);

  const list = (name: string): string[] | null => {
    const raw = value(name)?.trim();
    if (!raw) return null;
    const items = raw.split(",").map((a) => a.trim()).filter(Boolean);
    if (items.length === 0) errors.push(`${name} ne nomme rien`);
    return items;
  };

  const listed = list("RELAY_APPS") ?? [];

  const declaredGroup = list("RELAY_GROUP_WORKFLOWS");
  if (declaredGroup?.some((w) => !WORKFLOW_PATTERN.test(w))) {
    errors.push("RELAY_GROUP_WORKFLOWS attend des noms de fichier de .github/workflows/ ou des identifiants numeriques, separes par des virgules");
  }
  const group = declaredGroup ?? [workflow, "apply.yml"];

  const periodic = value("RELAY_PERIODIC_BACKUPS") ?? "ignore";
  if (periodic !== "ignore" && periodic !== "relay") errors.push("RELAY_PERIODIC_BACKUPS attend relay ou ignore");

  const rawPort = value("PORT");
  const port = rawPort === undefined ? 3000 : /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 0 && port <= 65535)) errors.push("PORT attend un numero de port entre 0 et 65535");

  if (errors.length > 0 || !secret || !token || !repository) return { config: null, errors };
  return {
    config: {
      secret,
      token,
      repository,
      workflow,
      ref,
      delayMs,
      minIntervalMs,
      apps: listed.length > 0 ? new Set(listed) : null,
      groupWorkflows: new Set(group),
      relayPeriodicBackups: periodic === "relay",
      port,
    },
    errors,
  };
}

export type Retained = { type: string; status: string; app: string; delayMs: number };

/** L'evenement s'il demande une reprise, null s'il est a ignorer. */
export function retain(event: unknown, config: Pick<Config, "apps" | "delayMs" | "relayPeriodicBackups">): Retained | null {
  if (typeof event !== "object" || event === null) return null;
  const { type, app_name: app, type_data: data } = event as { type?: unknown; app_name?: unknown; type_data?: unknown };
  if (typeof type !== "string" || typeof app !== "string") return null;
  if (config.apps && !config.apps.has(app)) return null;
  const details = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const text = (v: unknown) => (typeof v === "string" ? v : "inconnu");
  if (type === "deployment") {
    const status = text(details.status);
    return { type, status, app, delayMs: FAILED_DEPLOYMENTS.has(status) ? 0 : config.delayMs };
  }
  if (BACKUP_EVENTS.has(type)) {
    // Chaque app en recoit une par nuit, qui ne sert la reprise que dans le cas
    // rare ou le moteur s'y est rattache faute de pouvoir en lancer une. Ce cas
    // attend alors le cron, plutot qu'un run inutile par app et par nuit.
    if (details.backup_method === "periodic" && !config.relayPeriodicBackups) return null;
    return { type, status: text(details.backup_status), app, delayMs: 0 };
  }
  return null;
}

export function secretMatches(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Plan des dispatch apres un evenement qui en demande un a l'instant due.
 *
 * Aucun dispatch ne part avant le due des evenements qu'il sert : la reprise
 * trouverait sinon la fenetre de garde pas encore ecoulee, ne conclurait rien,
 * et rien ne la relancerait avant le cron. Deux dispatch restent separes d'au
 * moins minIntervalMs, pour qu'une rafale de fins de deploiement donne peu de
 * runs.
 *
 * Un dispatch deja prevu a partir de due sert l'evenement s'il part avant le
 * creneau qu'on lui ouvrirait, ou au plus minIntervalMs apres le plus tot
 * possible : un creneau de plus ferait un run de plus pour au mieux un
 * intervalle gagne. Au plafond, le plus tardif est repousse au besoin, ce qui
 * ne fait partir que plus tard les evenements qu'il servait deja.
 */
export function schedule(
  pending: readonly number[],
  due: number,
  lastDispatch: number | null,
  minIntervalMs: number,
  max = MAX_PENDING,
): number[] {
  const plan = [...pending].sort((a, b) => a - b);
  const earliest = lastDispatch === null ? due : Math.max(due, lastDispatch + minIntervalMs);
  let slot = earliest;
  for (const s of plan) if (Math.abs(s - slot) < minIntervalMs) slot = s + minIntervalMs;
  const serving = plan.find((s) => s >= due);
  if (serving !== undefined && serving <= Math.max(earliest + minIntervalMs, slot)) return plan;
  if (plan.length >= max) {
    plan[plan.length - 1] = Math.max(plan[plan.length - 1], earliest);
    return plan;
  }
  return [...plan, slot].sort((a, b) => a - b);
}

/**
 * Instant du prochain essai d'un dispatch en echec, null s'il tomberait plus de
 * 30 min apres le premier echec de la serie. failures compte celui-ci.
 */
export function retryAt(firstFailure: number, failures: number, now: number, retryAfterMs: number | null): number | null {
  const backoff = Math.min(RESCHEDULE_FIRST_MS * 2 ** (failures - 1), RESCHEDULE_CAP_MS);
  const at = now + Math.max(backoff, retryAfterMs ?? 0);
  return at > firstFailure + RESCHEDULE_WINDOW_MS ? null : at;
}

/** Attente demandee par un en-tete Retry-After, en secondes ou en date HTTP. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function githubHeaders(config: Config): Record<string, string> {
  return {
    Authorization: `Bearer ${config.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "scalingo-watcher-relay",
  };
}

export function dispatchRequest(config: Config): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${config.repository}/actions/workflows/${config.workflow}/dispatches`,
    init: {
      method: "POST",
      headers: { ...githubHeaders(config), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: config.ref, inputs: { resume: "true" } }),
    },
  };
}

export function pendingRunsRequest(config: Config): { url: string; init: RequestInit } {
  return {
    url: `https://api.github.com/repos/${config.repository}/actions/runs?status=pending&per_page=50`,
    init: { method: "GET", headers: githubHeaders(config) },
  };
}

/**
 * Vrai si un run d'un workflow du groupe scalingo-apply attend deja, faux sinon
 * ou si la liste est illisible.
 *
 * Le groupe ne garde qu'un run en attente : un nouveau run annule celui qui
 * attendait. Un dispatch de reprise annulerait ainsi un passage ordinaire en
 * attente, seul a pouvoir ouvrir un deploiement, alors qu'un run en attente
 * fera de toute facon avancer tout ce qui est en vol. Une liste illisible
 * laisse partir le dispatch : un run de trop coute moins qu'un ping perdu.
 */
async function groupRunPending(config: Config, deps: Pick<Deps, "fetch" | "log">): Promise<boolean> {
  const unreadable = (reason: string) => {
    deps.log(`runs en attente illisibles : ${reason}, dispatch quand meme`);
    return false;
  };
  const { url, init } = pendingRunsRequest(config);
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch (e) {
    return unreadable(`erreur reseau (${(e as Error).name})`);
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    return unreadable(String(res.status));
  }
  let runs: unknown;
  try {
    runs = ((await res.json()) as { workflow_runs?: unknown }).workflow_runs;
  } catch {
    return unreadable("reponse illisible");
  }
  if (!Array.isArray(runs)) return unreadable("reponse illisible");
  return runs.some((run) => {
    if (typeof run !== "object" || run === null) return false;
    const { status, path, workflow_id: id } = run as { status?: unknown; path?: unknown; workflow_id?: unknown };
    if (status !== "pending") return false;
    const file = typeof path === "string" ? path.slice(path.lastIndexOf("/") + 1) : "";
    return config.groupWorkflows.has(file) || (typeof id === "number" && config.groupWorkflows.has(String(id)));
  });
}

async function githubMessage(res: Response, token: string): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const parsed = (JSON.parse(text) as { message?: unknown }).message;
    if (typeof parsed === "string") message = parsed;
  } catch {
    // corps qui n'est pas du JSON : on le garde tel quel
  }
  return message.replaceAll(token, "<jeton>").replace(/\s+/g, " ").trim().slice(0, 200);
}

export type Outcome =
  | { kind: "sent"; status: number }
  | { kind: "refused"; status: number }
  | { kind: "failed"; status: number | null; retryAfterMs: number | null }
  | { kind: "skipped" };

/**
 * Un workflow_dispatch, sauf si un run du groupe attend deja. Retente sur
 * erreur reseau, 5xx ou 429 ; les autres 4xx sont definitifs.
 */
export async function dispatch(config: Config, deps: Pick<Deps, "fetch" | "sleep" | "log" | "now">): Promise<Outcome> {
  if (await groupRunPending(config, deps)) {
    deps.log("run deja en attente, dispatch inutile");
    return { kind: "skipped" };
  }
  const { url, init } = dispatchRequest(config);
  let failure = "";
  let status: number | null = null;
  let retryAfter: number | null = null;
  let attempt = 0;
  while (attempt < ATTEMPTS) {
    if (attempt > 0) await deps.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    attempt++;
    let res: Response;
    try {
      res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    } catch (e) {
      failure = `erreur reseau (${(e as Error).name})`;
      status = null;
      retryAfter = null;
      continue;
    }
    if (res.ok) {
      await res.text().catch(() => "");
      deps.log(`dispatch : ${res.status}${attempt > 1 ? `, au ${attempt}e essai` : ""}`);
      return { kind: "sent", status: res.status };
    }
    if (res.status < 500 && res.status !== 429) {
      const message = await githubMessage(res, config.token);
      deps.log(`dispatch refuse : ${res.status}${message ? ` ${message}` : ""}`);
      return { kind: "refused", status: res.status };
    }
    await res.text().catch(() => "");
    failure = String(res.status);
    status = res.status;
    retryAfter = retryAfterMs(res.headers.get("retry-after"), deps.now());
    // Les essais courts suivants partiraient avant l'heure portee par Retry-After.
    if (retryAfter !== null) break;
  }
  deps.log(`dispatch en echec apres ${attempt} essai${attempt > 1 ? "s" : ""} : ${failure}`);
  return { kind: "failed", status, retryAfterMs: retryAfter };
}

// Statut et nom d'app viennent du corps recu : une ligne de journal ne doit
// pas pouvoir en devenir plusieurs.
const printable = (s: string) => s.replace(/[^\x21-\x7e]/g, "?").slice(0, 64);

function reply(res: ServerResponse, status: number, text = "", close = false): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...(close ? { Connection: "close" } : {}) });
  res.end(text);
}

/** Corps de la requete, ou null au-dela de BODY_LIMIT. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > BODY_LIMIT) return resolve(null);
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        req.off("data", onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export type Relay = {
  server: Server;
  pending: () => readonly number[];
  /**
   * Ferme le serveur, attend au plus CLOSE_WAIT_MS les requetes en cours, puis
   * envoie tout de suite un dispatch s'il en reste un de du, et rend la main.
   */
  shutdown: () => Promise<void>;
};

export function createRelay(config: Config, deps: Deps = defaultDeps): Relay {
  let pending: number[] = [];
  let lastDispatch: number | null = null;
  let lastStatus: number | null = null;
  let firstFailure: number | null = null;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let draining = false;
  let owed = false;
  let stopping: Promise<void> | null = null;

  const iso = (t: number) => new Date(t).toISOString();

  const attempt = async () => {
    const outcome = await dispatch(config, deps);
    if (outcome.kind !== "skipped") lastStatus = outcome.status;
    if (outcome.kind !== "failed") {
      firstFailure = null;
      failures = 0;
      return;
    }
    // A l'arret, le temps laisse avant SIGKILL est deja pris.
    if (closed) return;
    const now = deps.now();
    firstFailure ??= now;
    failures++;
    const due = retryAt(firstFailure, failures, now, outcome.retryAfterMs);
    if (due === null) {
      deps.log("dispatch abandonne : le prochain essai tomberait plus de 30 min apres le premier echec");
      firstFailure = null;
      failures = 0;
      return;
    }
    pending = schedule(pending, due, lastDispatch, config.minIntervalMs);
    arm();
    deps.log(`dispatch reprogramme a ${iso(pending.find((s) => s >= due) ?? due)}`);
  };

  // Une tache qui rejetterait laisserait la file rejetee, et aucun dispatch
  // suivant ne partirait plus.
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((e) => deps.log(`dispatch : erreur inattendue (${(e as Error).name})`));
  };

  const flush = () =>
    enqueue(async () => {
      if (!owed) return;
      owed = false;
      await attempt();
    });

  const arm = () => {
    clearTimeout(timer);
    if (closed || pending.length === 0) return;
    timer = setTimeout(fire, Math.max(0, pending[0] - deps.now()));
  };

  const fire = () => {
    const [next, ...rest] = pending;
    if (next === undefined) return;
    // setTimeout peut partir une milliseconde avant l'horloge murale.
    if (deps.now() < next) return arm();
    pending = rest;
    lastDispatch = next;
    enqueue(attempt);
    arm();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const answer = (status: number, text = "", close = false) => reply(res, status, text, close || closed);
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      // La sonde repond sans secret : le message de GitHub n'y figure jamais.
      if (lastStatus !== null && BROKEN_STATUSES.has(lastStatus)) return answer(503, `dernier dispatch refuse : ${lastStatus}`);
      return answer(200, "ok");
    }
    if (req.method !== "POST" || !path.startsWith("/") || !secretMatches(path.slice(1), config.secret)) {
      return answer(404, "", true);
    }
    const body = await readBody(req);
    if (body === null) return answer(413, "", true);
    let event: unknown;
    try {
      event = JSON.parse(body.toString("utf8"));
    } catch {
      return answer(400);
    }
    const retained = retain(event, config);
    if (!retained) return answer(204);
    const what = `${retained.type} ${printable(retained.status)} sur ${printable(retained.app)}`;
    if (closed) {
      // Planifie, il serait perdu a la sortie du processus.
      owed = true;
      if (draining) flush();
      deps.log(`${what} : arret en cours, dispatch immediat`);
      return answer(202);
    }
    const due = deps.now() + retained.delayMs;
    const before = pending.length;
    pending = schedule(pending, due, lastDispatch, config.minIntervalMs);
    arm();
    const at = pending.find((s) => s >= due) ?? due;
    deps.log(`${what} : dispatch a ${iso(at)}${pending.length === before ? ", regroupe" : ""}`);
    answer(202);
  };

  // Un client lent garderait sinon sa connexion ouverte jusqu'a cinq minutes.
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else reply(res, 500, "", true);
    });
  });

  const shutdown = () => {
    stopping ??= (async () => {
      closed = true;
      clearTimeout(timer);
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      // Une requete en cours peut encore apporter un evenement : ce qui reste du
      // se compte une fois ses reponses rendues.
      await Promise.race([serverClosed, deps.sleep(CLOSE_WAIT_MS)]);
      draining = true;
      if (pending.length > 0) owed = true;
      pending = [];
      // Un ping trop tot ne fait qu'un run qui ne conclut rien. Un ping perdu
      // laisse la reprise attendre le cron, des heures durant.
      deps.log(owed ? "arret : le dispatch prevu part maintenant" : "arret : aucun dispatch prevu");
      flush();
      for (let seen = queue; ; seen = queue) {
        await seen;
        if (seen === queue) break;
      }
    })();
    return stopping;
  };

  return { server, pending: () => pending, shutdown };
}

function main(): void {
  const { config, errors } = readConfig(process.env);
  if (!config) {
    console.error(`Configuration du relais invalide :\n  ${errors.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  const relay = createRelay(config);
  relay.server.on("error", (e) => {
    console.error(`Le relais ne peut pas ecouter sur le port ${config.port} : ${e.message}`);
    process.exit(1);
  });
  relay.server.listen(config.port, () => {
    const { port } = relay.server.address() as AddressInfo;
    const apps = config.apps ? `${config.apps.size} app(s) suivie(s)` : "toutes les apps";
    const periodic = config.relayPeriodicBackups ? "relayees" : "ignorees";
    console.log(
      `relais en ecoute sur le port ${port} : ${config.repository}, workflow ${config.workflow} sur ${config.ref}, retard ${config.delayMs / 1000} s, ecart minimal ${config.minIntervalMs / 1000} s, ${apps}, groupe ${[...config.groupWorkflows].join(",")}, sauvegardes periodiques ${periodic}`,
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      relay.shutdown().then(() => process.exit(0));
    });
  }
}

if (import.meta.main) main();
