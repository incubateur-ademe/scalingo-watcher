/**
 * Tests du relais, hors ligne : l'API GitHub est un fetch simule, et le serveur
 * ecoute sur un port ephemere de la boucle locale.
 *
 *   node test/relay.test.ts
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  BODY_LIMIT,
  createRelay,
  dispatch,
  MAX_PENDING,
  readConfig,
  retain,
  retryAfterMs,
  retryAt,
  schedule,
  secretMatches,
  type Config,
  type Deps,
  type Fetch,
} from "../relay/relay.ts";

const RELAY = join(import.meta.dirname, "..", "relay", "relay.ts");

let failures = 0;
let passed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  ECHEC ${name}\n        obtenu  ${a}\n        attendu ${b}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await sleep(10);
}

const SECRET = "s3cret-du-relais-pour-les-tests-0123456789";
const TOKEN = "github_pat_jeton_factice_des_tests_0123456789";
const ENV = { RELAY_SECRET: SECRET, GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: "mon-org/mon-parc" };

function config(over: Partial<Config> = {}): Config {
  const { config: base } = readConfig(ENV);
  if (!base) throw new Error("configuration de test invalide");
  return { ...base, ...over };
}

type Call = { url: string; init: RequestInit; at: number };
type Reply = () => Response | Promise<Response>;

const runsOf =
  (...runs: object[]): Reply =>
  () =>
    Response.json({ total_count: runs.length, workflow_runs: runs });
const run = (path: string, status = "pending", workflow_id = 7) => ({ id: 1, status, path, workflow_id });
const status = (code: number, headers: Record<string, string> = {}): Reply => () => new Response(null, { status: code, headers });

/**
 * fetch simule. La lecture des runs en attente rend runs, aucun par defaut ;
 * chaque dispatch rend la reponse suivante, puis 204.
 */
function fakeGitHub(responses: Reply[] = [], runs: Reply = runsOf()) {
  const reads: Call[] = [];
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    if (init.method === "GET") {
      reads.push({ url, init, at: Date.now() });
      return runs();
    }
    calls.push({ url, init, at: Date.now() });
    const next = responses.shift();
    return next ? next() : new Response(null, { status: 204 });
  };
  return { calls, reads, fetch, responses };
}

function quietDeps(fetch: Fetch, lines: string[]): Deps {
  return { fetch, sleep: async () => {}, log: (l) => lines.push(l), now: () => Date.now() };
}

const deployment = (app: string, status: string) => ({
  id: "evt-1",
  created_at: "2026-11-19T10:00:00.000Z",
  type: "deployment",
  app_name: app,
  app_id: "app-1",
  user: { username: "quelqu-un" },
  type_data: { status, deployment_uuid: "dep-1" },
});
const backup = (app: string, type: string, method = "manual") => ({
  id: "evt-2",
  type,
  app_name: app,
  type_data: { backup_id: "bk-1", backup_status: type.endsWith("succeeded") ? "done" : "error", backup_method: method },
});

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "scalingo-watcher-relay",
};

// ---------------------------------------------------------------- planification

console.log("\nPlanification des dispatch");

check("un premier evenement part a son due", schedule([], 1000, null, 60), [1000]);
check("un dispatch prevu dans [due, due + ecart] l'absorbe", schedule([1000], 980, null, 60), [1000]);
check("la borne haute est incluse", schedule([1000], 940, null, 60), [1000]);
check("au-dela de due + ecart, un dispatch plus tot est ajoute", schedule([1000], 900, null, 60), [900, 1000]);
check("un dispatch prevu avant due ne le sert pas : jamais avant due", schedule([1000], 1010, null, 60), [1000, 1060]);
check("l'ecart court depuis le dernier dispatch parti", schedule([], 1000, 980, 60), [1040]);
check(
  "un dispatch prevu qui sert l'evenement l'absorbe quand l'ecart repoussait de toute facon le nouveau",
  schedule([1080], 1000, 1000, 60),
  [1080],
);
check(
  "un dispatch prevu avant le creneau qu'on ouvrirait absorbe l'evenement, meme au-dela de due + ecart",
  schedule([990, 1065], 1000, null, 60),
  [990, 1065],
);
check("un creneau libre entre deux dispatch se prend s'il garde l'ecart", schedule([1000, 1200], 1065, null, 60), [1000, 1065, 1200]);
check("un ecart nul n'absorbe que le meme instant", [schedule([1000], 1000, null, 0), schedule([1000], 1001, null, 0)], [[1000], [1000, 1001]]);
check("le plan rendu est trie, l'entree n'est pas modifiee", (() => {
  const input = [1300, 1000];
  return [schedule(input, 5000, null, 60), input];
})(), [[1000, 1300, 5000], [1300, 1000]]);

const full = Array.from({ length: MAX_PENDING }, (_, i) => 1000 + i * 100);
const capped = schedule(full, 10_000, null, 60);
check(
  "au plafond, le plus tardif est repousse jusqu'au due et l'absorbe",
  [capped.length, capped.at(-1), capped.slice(0, -1)],
  [MAX_PENDING, 10_000, full.slice(0, -1)],
);
check("au plafond, un evenement deja servi ne change rien", schedule(full, 1010, null, 60), full);

// Propriete sur des sequences pseudo-aleatoires reproductibles : apres chaque
// evenement, le plan reste trie, espace, plafonne, et chaque evenement encore
// en attente a un dispatch prevu a partir de son due.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const violations: string[] = [];
const MIN = 60;
for (let run = 0; run < 200; run++) {
  let plan: number[] = [];
  let last: number | null = null;
  let now = 0;
  let waiting: number[] = [];
  for (let step = 0; step < 60; step++) {
    now += Math.floor(random() * 50);
    while (plan.length > 0 && plan[0] <= now) {
      const fired = plan.shift() as number;
      last = fired;
      waiting = waiting.filter((due) => due > fired);
    }
    const due = now + (random() < 0.5 ? 150 : 0);
    plan = schedule(plan, due, last, MIN, random() < 0.2 ? 3 : MAX_PENDING);
    waiting.push(due);
    for (let i = 1; i < plan.length; i++) if (plan[i] - plan[i - 1] < MIN) violations.push(`ecart ${plan.join(",")}`);
    if (last !== null && plan.some((s) => s < (last as number) + MIN)) violations.push(`apres le dernier ${last} : ${plan.join(",")}`);
    if (plan.length > MAX_PENDING) violations.push(`plafond ${plan.length}`);
    for (const d of waiting) if (!plan.some((s) => s >= d)) violations.push(`due ${d} sans dispatch : ${plan.join(",")}`);
  }
}
check("12 000 evenements simules : ecart, plafond et due toujours tenus", violations.slice(0, 3), []);

console.log("\nReprogrammation d'un dispatch en echec");

{
  const series: Array<number | null> = [];
  let now = 0;
  for (let f = 1; f <= 10; f++) {
    const at = retryAt(0, f, now, null);
    series.push(at === null ? null : at / 1000);
    if (at === null) break;
    now = at;
  }
  check("30 s, puis le double, plafonne a 10 min, jusqu'a 30 min apres le premier echec", series, [30, 90, 210, 450, 930, 1530, null]);
}
check(
  "un Retry-After plus long que l'attente prevue l'emporte, un plus court non",
  [retryAt(0, 1, 0, 90_000), retryAt(0, 1, 0, 5_000), retryAt(0, 5, 0, 600_000)],
  [90_000, 30_000, 600_000],
);
check("un Retry-After au-dela de la fenetre abandonne", retryAt(0, 1, 0, 2 * 3600_000), null);
{
  const now = Date.parse("2026-11-19T10:00:00Z");
  check(
    "Retry-After en secondes ou en date HTTP, illisible ignore",
    ["120", " 5 ", "Thu, 19 Nov 2026 10:02:00 GMT", "Thu, 19 Nov 2026 09:00:00 GMT", "demain", null].map((h) => retryAfterMs(h, now)),
    [120_000, 5000, 120_000, 0, null, null],
  );
}

// ---------------------------------------------------------------- evenements

console.log("\nFiltrage des evenements");

const filter = { apps: null, delayMs: 150_000, relayPeriodicBackups: false };
check("deploiement reussi : retenu avec le retard", retain(deployment("mon-app", "success"), filter), {
  type: "deployment",
  status: "success",
  app: "mon-app",
  delayMs: 150_000,
});
check(
  "deploiement en echec : retenu sans retard",
  ["build-error", "crashed-error", "timeout-error", "hook-error", "aborted"].map((s) => retain(deployment("mon-app", s), filter)?.delayMs),
  [0, 0, 0, 0, 0],
);
check(
  "statut de deploiement inconnu ou absent : retard applique, un ping tot couterait le cron",
  [retain(deployment("mon-app", "image-error"), filter)?.delayMs, retain({ type: "deployment", app_name: "mon-app" }, filter)],
  [150_000, { type: "deployment", status: "inconnu", app: "mon-app", delayMs: 150_000 }],
);
check(
  "sauvegarde reussie ou en echec : retenue sans retard",
  [retain(backup("mon-app", "database_backup_succeeded"), filter), retain(backup("mon-app", "database_backup_failed"), filter)],
  [
    { type: "database_backup_succeeded", status: "done", app: "mon-app", delayMs: 0 },
    { type: "database_backup_failed", status: "error", app: "mon-app", delayMs: 0 },
  ],
);
check(
  "sauvegarde periodique ignoree par defaut, relayee avec RELAY_PERIODIC_BACKUPS=relay",
  [
    retain(backup("mon-app", "database_backup_succeeded", "periodic"), filter),
    retain(backup("mon-app", "database_backup_failed", "periodic"), filter),
    retain(backup("mon-app", "database_backup_succeeded", "periodic"), { ...filter, relayPeriodicBackups: true })?.type,
  ],
  [null, null, "database_backup_succeeded"],
);
check(
  "types non suivis ignores, y compris le nom d'API app_deployed",
  ["app_deployed", "app_restarted", "addon_created", "new_alert"].map((type) => retain({ type, app_name: "mon-app" }, filter)),
  [null, null, null, null],
);
check(
  "corps qui n'est pas un evenement ignore",
  [null, [], "deployment", 42, { type: "deployment" }, { app_name: "mon-app" }].map((e) => retain(e, filter)),
  [null, null, null, null, null, null],
);
const listed = { apps: new Set(["mon-app"]), delayMs: 0, relayPeriodicBackups: false };
check(
  "RELAY_APPS : une app hors liste est ignoree, une app listee retenue",
  [retain(deployment("autre-app", "success"), listed), retain(deployment("mon-app", "success"), listed)?.app],
  [null, "mon-app"],
);

// ---------------------------------------------------------------- secret

console.log("\nComparaison du secret");

check(
  "bon secret accepte, mauvais refuse, longueur differente refusee",
  [
    secretMatches(SECRET, SECRET),
    secretMatches(SECRET.replace(/.$/, "X"), SECRET),
    secretMatches(SECRET.slice(0, -1), SECRET),
    secretMatches(`${SECRET}x`, SECRET),
    secretMatches("", SECRET),
  ],
  [true, false, false, false, false],
);

// ---------------------------------------------------------------- dispatch

console.log("\nDispatch vers GitHub");

{
  const gh = fakeGitHub();
  const lines: string[] = [];
  const outcome = await dispatch(config(), quietDeps(gh.fetch, lines));
  const [call] = gh.calls;
  check("un 204 est un succes, en un seul appel", [outcome, gh.calls.length, lines], [{ kind: "sent", status: 204 }, 1, ["dispatch : 204"]]);
  check(
    "URL de l'API workflow_dispatch",
    call.url,
    "https://api.github.com/repos/mon-org/mon-parc/actions/workflows/reconcile.yml/dispatches",
  );
  check("methode et en-tetes exacts", [call.init.method, call.init.headers], ["POST", { ...HEADERS, "Content-Type": "application/json" }]);
  check("corps : la branche et l'input resume", JSON.parse(String(call.init.body)), { ref: "main", inputs: { resume: "true" } });
  check("chaque essai porte un delai d'abandon", call.init.signal instanceof AbortSignal, true);
  const [read] = gh.reads;
  check(
    "avant le dispatch, une lecture des runs en attente du depot, memes en-tetes",
    [gh.reads.length, read?.url, read?.init.method, read?.init.headers, read?.at <= call.at, read?.init.signal instanceof AbortSignal],
    [1, "https://api.github.com/repos/mon-org/mon-parc/actions/runs?status=pending&per_page=50", "GET", HEADERS, true, true],
  );
}
{
  const gh = fakeGitHub();
  await dispatch(config({ workflow: "1234", ref: "prod" }), quietDeps(gh.fetch, []));
  check(
    "RELAY_WORKFLOW et RELAY_REF passent dans l'URL et le corps",
    [gh.calls[0].url.endsWith("/actions/workflows/1234/dispatches"), JSON.parse(String(gh.calls[0].init.body)).ref],
    [true, "prod"],
  );
}
{
  const gh = fakeGitHub([() => new Response(JSON.stringify({ message: "ok" }), { status: 200 })]);
  check("un 200 est aussi un succes", (await dispatch(config(), quietDeps(gh.fetch, []))).kind, "sent");
}
{
  const results = [];
  for (const pending of [run(".github/workflows/reconcile.yml"), run(".github/workflows/apply.yml")]) {
    const gh = fakeGitHub([], runsOf(run(".github/workflows/propose-db.yml"), pending));
    const lines: string[] = [];
    const outcome = await dispatch(config(), quietDeps(gh.fetch, lines));
    results.push([outcome.kind, gh.calls.length, lines]);
  }
  check(
    "un run de reconcile.yml ou d'apply.yml deja en attente : aucun dispatch, une ligne au journal",
    results,
    Array(2).fill(["skipped", 0, ["run deja en attente, dispatch inutile"]]),
  );
}
{
  const gh = fakeGitHub(
    [],
    runsOf(run(".github/workflows/propose-db.yml"), run(".github/workflows/reconcile.yml", "queued"), run(".github/workflows/apply.yml", "in_progress")),
  );
  const outcome = await dispatch(config(), quietDeps(gh.fetch, []));
  check("un run en attente hors du groupe, ou un run du groupe qui n'attend pas : le dispatch part", [outcome.kind, gh.calls.length], ["sent", 1]);
}
{
  const kinds = [];
  for (const pending of [
    run(".github/workflows/deploy.yml"),
    run(".github/workflows/autre-nom.yml", "pending", 4242),
    run(".github/workflows/apply.yml"),
  ]) {
    const gh = fakeGitHub([], runsOf(pending));
    kinds.push((await dispatch(config({ groupWorkflows: new Set(["deploy.yml", "4242"]) }), quietDeps(gh.fetch, []))).kind);
  }
  check("RELAY_GROUP_WORKFLOWS : nom de fichier ou identifiant numerique du workflow", kinds, ["skipped", "skipped", "sent"]);
}
{
  const results = [];
  const unreadable: Array<[string, Reply]> = [
    ["500", status(500)],
    ["reponse illisible", () => new Response("<html>", { status: 200 })],
    ["reponse illisible", () => Response.json({ message: "inattendu" })],
    [
      "erreur reseau (TypeError)",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];
  for (const [, runs] of unreadable) {
    const gh = fakeGitHub([], runs);
    const lines: string[] = [];
    const outcome = await dispatch(config(), quietDeps(gh.fetch, lines));
    results.push([outcome.kind, gh.calls.length, lines]);
  }
  check(
    "lecture des runs en attente en echec : le dispatch part quand meme",
    results,
    unreadable.map(([reason]) => ["sent", 1, [`runs en attente illisibles : ${reason}, dispatch quand meme`, "dispatch : 204"]]),
  );
}
{
  const body = JSON.stringify({ message: `Unexpected inputs provided: ["resume"] pour ${TOKEN}`, documentation_url: "https://docs.github.com" });
  const gh = fakeGitHub([() => new Response(body, { status: 422 })]);
  const lines: string[] = [];
  const slept: number[] = [];
  const outcome = await dispatch(config(), { ...quietDeps(gh.fetch, lines), sleep: async (ms) => void slept.push(ms) });
  check("un 4xx ne se retente pas", [outcome, gh.calls.length, slept], [{ kind: "refused", status: 422 }, 1, []]);
  check("le refus est journalise avec le message de GitHub, sans le jeton", lines, [
    'dispatch refuse : 422 Unexpected inputs provided: ["resume"] pour <jeton>',
  ]);
}
{
  const gh = fakeGitHub([() => new Response(JSON.stringify({ message: "x".repeat(500) }), { status: 403 })]);
  const lines: string[] = [];
  await dispatch(config(), quietDeps(gh.fetch, lines));
  check("le message de GitHub est tronque a 200 caracteres", lines[0].length, "dispatch refuse : 403 ".length + 200);
}
{
  const gh = fakeGitHub([status(502), status(503)]);
  const lines: string[] = [];
  const slept: number[] = [];
  const outcome = await dispatch(config(), { ...quietDeps(gh.fetch, lines), sleep: async (ms) => void slept.push(ms) });
  check("un 5xx se retente, avec une attente croissante", [outcome.kind, gh.calls.length, slept, lines], ["sent", 3, [1000, 2000], ["dispatch : 204, au 3e essai"]]);
}
{
  const gh = fakeGitHub([status(500), status(502), status(503)]);
  const lines: string[] = [];
  const outcome = await dispatch(config(), quietDeps(gh.fetch, lines));
  check(
    "trois 5xx : echec, trois appels et pas un de plus",
    [outcome, gh.calls.length, lines],
    [{ kind: "failed", status: 503, retryAfterMs: null }, 3, ["dispatch en echec apres 3 essais : 503"]],
  );
}
{
  const gh = fakeGitHub([status(429), status(429), status(429)]);
  const lines: string[] = [];
  const outcome = await dispatch(config(), quietDeps(gh.fetch, lines));
  check(
    "un 429 n'est pas un refus definitif : il se retente comme un 5xx",
    [outcome, gh.calls.length, lines],
    [{ kind: "failed", status: 429, retryAfterMs: null }, 3, ["dispatch en echec apres 3 essais : 429"]],
  );
}
{
  const gh = fakeGitHub([status(429, { "Retry-After": "120" })]);
  const lines: string[] = [];
  const slept: number[] = [];
  const outcome = await dispatch(config(), { ...quietDeps(gh.fetch, lines), sleep: async (ms) => void slept.push(ms) });
  check(
    "un Retry-After arrete les essais courts et rend l'attente demandee",
    [outcome, gh.calls.length, slept, lines],
    [{ kind: "failed", status: 429, retryAfterMs: 120_000 }, 1, [], ["dispatch en echec apres 1 essai : 429"]],
  );
}
{
  const gh = fakeGitHub();
  const lines: string[] = [];
  const outcome = await dispatch(config(), quietDeps(async (url, init) => {
    if (init.method !== "GET") throw new TypeError("fetch failed");
    return gh.fetch(url, init);
  }, lines));
  check(
    "une erreur reseau se retente aussi",
    [outcome, lines],
    [{ kind: "failed", status: null, retryAfterMs: null }, ["dispatch en echec apres 3 essais : erreur reseau (TypeError)"]],
  );
}

// ---------------------------------------------------------------- configuration

console.log("\nValidation de la configuration");

{
  const { config: none, errors } = readConfig({});
  check("sans rien, les trois obligatoires sont reclames ensemble", [none, errors.map((e) => e.split(" ")[0])], [
    null,
    ["RELAY_SECRET", "GITHUB_TOKEN", "GITHUB_REPOSITORY"],
  ]);
}
{
  const { config: c } = readConfig(ENV);
  check(
    "les defauts",
    c && [c.workflow, c.ref, c.delayMs, c.minIntervalMs, c.apps, [...c.groupWorkflows], c.relayPeriodicBackups, c.port],
    ["reconcile.yml", "main", 150_000, 60_000, null, ["reconcile.yml", "apply.yml"], false, 3000],
  );
}
const errorsOf = (over: Record<string, string>) => readConfig({ ...ENV, ...over }).errors;
check("un secret de 31 caracteres est refuse, 32 acceptes", [errorsOf({ RELAY_SECRET: "a".repeat(31) }).length, errorsOf({ RELAY_SECRET: "a".repeat(32) })], [1, []]);
check(
  "un secret qui ne passe pas tel quel dans un chemin est refuse",
  ["a/".repeat(16), "a%".repeat(16), "a ".repeat(16), "a?".repeat(16)].map((s) => errorsOf({ RELAY_SECRET: s }).length),
  [1, 1, 1, 1],
);
check(
  "GITHUB_REPOSITORY doit etre proprietaire/depot",
  ["mon-org/mon-parc", "mon-org/mon.parc_2", "mon-org", "a/b/c", "https://github.com/a/b", "mon-org/..", "mon org/parc"].map(
    (r) => errorsOf({ GITHUB_REPOSITORY: r }).length,
  ),
  [0, 0, 1, 1, 1, 1, 1],
);
check(
  "RELAY_WORKFLOW : un fichier yml ou un identifiant numerique",
  ["deploy.yaml", "42", "../x.yml", "reconcile", "a/b.yml"].map((w) => errorsOf({ RELAY_WORKFLOW: w }).length),
  [0, 0, 1, 1, 1],
);
check(
  "les durees en secondes, decimales comprises, bornees a une journee",
  ["0", "0.25", "abc", "-1", "1e3", "86401"].map((d) => {
    const { config: c, errors } = readConfig({ ...ENV, RELAY_DELAY: d });
    return c ? c.delayMs : errors.length;
  }),
  [0, 250, 1, 1, 1, 1],
);
check("RELAY_MIN_INTERVAL est valide de meme", errorsOf({ RELAY_MIN_INTERVAL: "une minute" }), ["RELAY_MIN_INTERVAL attend un nombre de secondes entre 0 et 86400"]);
check(
  "RELAY_APPS : liste nettoyee, vide = toutes, virgules seules = erreur",
  [
    [...(readConfig({ ...ENV, RELAY_APPS: " mon-app , autre-app ,," }).config?.apps ?? [])],
    readConfig({ ...ENV, RELAY_APPS: "" }).config?.apps,
    errorsOf({ RELAY_APPS: " , " }).length,
  ],
  [["mon-app", "autre-app"], null, 1],
);
check(
  "RELAY_GROUP_WORKFLOWS : defaut sur RELAY_WORKFLOW, liste nettoyee, chaque nom valide",
  [
    [...(readConfig({ ...ENV, RELAY_WORKFLOW: "1234" }).config?.groupWorkflows ?? [])],
    [...(readConfig({ ...ENV, RELAY_GROUP_WORKFLOWS: " reconcile.yml , deploy.yml ,," }).config?.groupWorkflows ?? [])],
    errorsOf({ RELAY_GROUP_WORKFLOWS: "reconcile.yml,../x.yml" }).length,
    errorsOf({ RELAY_GROUP_WORKFLOWS: " , " }).length,
  ],
  [["1234", "apply.yml"], ["reconcile.yml", "deploy.yml"], 1, 1],
);
check(
  "RELAY_PERIODIC_BACKUPS : relay ou ignore, vide = ignore",
  [
    readConfig({ ...ENV, RELAY_PERIODIC_BACKUPS: "relay" }).config?.relayPeriodicBackups,
    readConfig({ ...ENV, RELAY_PERIODIC_BACKUPS: "ignore" }).config?.relayPeriodicBackups,
    readConfig({ ...ENV, RELAY_PERIODIC_BACKUPS: "" }).config?.relayPeriodicBackups,
    errorsOf({ RELAY_PERIODIC_BACKUPS: "oui" }),
  ],
  [true, false, false, ["RELAY_PERIODIC_BACKUPS attend relay ou ignore"]],
);
check("PORT hors bornes refuse", ["8080", "70000", "http"].map((p) => errorsOf({ PORT: p }).length), [0, 1, 1]);
check("une variable vide prend son defaut", readConfig({ ...ENV, RELAY_REF: "", RELAY_DELAY: "" }).config?.ref, "main");
{
  const swapped = readConfig({
    RELAY_SECRET: TOKEN.slice(0, 10),
    GITHUB_TOKEN: "deux mots",
    GITHUB_REPOSITORY: TOKEN,
    RELAY_DELAY: TOKEN,
    RELAY_GROUP_WORKFLOWS: TOKEN,
    RELAY_PERIODIC_BACKUPS: TOKEN,
  });
  check(
    "aucune erreur ne recopie une valeur recue",
    swapped.errors.filter((e) => e.includes(TOKEN) || e.includes(TOKEN.slice(0, 10)) || e.includes("deux mots")),
    [],
  );
}

// ---------------------------------------------------------------- serveur

console.log("\nServeur, de bout en bout");

async function listen(relay: ReturnType<typeof createRelay>): Promise<string> {
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  return `http://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
}
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const health = (base: string) => fetch(`${base}/healthz`).then(async (r) => [r.status, await r.text()]);

/** POST dont le corps n'arrive qu'a l'appel de finish. */
function slowPost(base: string, event: unknown) {
  const body = JSON.stringify(event);
  let finish = () => {};
  const status = new Promise<number | undefined>((resolve, reject) => {
    const req = request(
      `${base}/${SECRET}`,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.write(body.slice(0, 10));
    finish = () => req.end(body.slice(10));
  });
  return { status, finish: () => finish() };
}

{
  const gh = fakeGitHub();
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 400, minIntervalMs: 1000 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  try {
    check("GET /healthz rend 200 ok", await health(base), [200, "ok"]);

    const wrong = SECRET.replace(/^./, "X");
    const refusals = await Promise.all(
      [
        fetch(`${base}/${SECRET}`),
        post(`${base}/${wrong}`, deployment("mon-app", "success")),
        post(`${base}/${SECRET.slice(0, 10)}`, deployment("mon-app", "success")),
        post(`${base}/${SECRET}/`, deployment("mon-app", "success")),
        post(`${base}/`, deployment("mon-app", "success")),
        fetch(`${base}/inconnu`),
      ].map(async (r) => {
        const res = await r;
        return [res.status, await res.text()];
      }),
    );
    check("tout le reste rend 404 sans indice", refusals, Array(6).fill([404, ""]));

    const unreadable = await post(`${base}/${SECRET}`, "{pas du json");
    const ignored = await post(`${base}/${SECRET}`, { type: "app_restarted", app_name: "mon-app" });
    const periodic = await post(`${base}/${SECRET}`, backup("mon-app", "database_backup_succeeded", "periodic"));
    check(
      "JSON illisible : 400 ; evenement non suivi ou sauvegarde periodique : 204",
      [unreadable.status, ignored.status, periodic.status],
      [400, 204, 204],
    );

    const tooBig = await post(`${base}/${SECRET}`, JSON.stringify({ type: "deployment", pad: "x".repeat(BODY_LIMIT) }));
    check("corps au-dela de 64 Ko : 413", tooBig.status, 413);
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/${SECRET}`, { method: "POST" }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      for (let i = 0; i < 20; i++) req.write("x".repeat(8 * 1024));
      req.end();
    });
    check("corps envoye par morceaux, sans longueur annoncee, au-dela de 64 Ko : 413", chunked, 413);
    check("aucun de ces appels ne prevoit de dispatch", [relay.pending().length, lines], [0, []]);

    const t0 = Date.now();
    const first = await post(`${base}/${SECRET}`, deployment("mon-app", "success"));
    const second = await post(`${base}/${SECRET}`, deployment("autre-app", "crashed-error"));
    const third = await post(`${base}/${SECRET}`, backup("mon-app", "database_backup_succeeded"));
    check("evenements retenus : 202 tout de suite", [first.status, second.status, third.status, Date.now() - t0 < 300], [202, 202, 202, true]);
    check("les deux evenements suivants sont absorbes par le premier dispatch", relay.pending().length, 1);

    await sleep(250);
    check("rien ne part avant le retard", gh.calls.length, 0);

    await sleep(1050);
    check("un seul dispatch part, apres le retard", [gh.calls.length, gh.calls[0]?.at - t0 >= 400], [1, true]);
    check("une ligne par evenement retenu, une par dispatch", lines.map((l) => l.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, "<iso>")), [
      "deployment success sur mon-app : dispatch a <iso>",
      "deployment crashed-error sur autre-app : dispatch a <iso>, regroupe",
      "database_backup_succeeded done sur mon-app : dispatch a <iso>, regroupe",
      "dispatch : 204",
    ]);
    check("le journal ne porte ni le secret ni le jeton", lines.filter((l) => l.includes(SECRET) || l.includes(TOKEN)), []);
    const planned = Date.parse(lines[0].split(" a ")[1]);
    check("l'instant journalise est celui ou le dispatch part", gh.calls[0].at >= planned && gh.calls[0].at - planned < 100, true);
  } finally {
    await relay.shutdown();
  }
}

console.log("\nSonde et reprogrammation");

{
  const refusals = [401, 204, 403, 404, 422, 400];
  const gh = fakeGitHub(refusals.map((s) => (s === 204 ? status(204) : () => Response.json({ message: `refus pour ${TOKEN}` }, { status: s }))));
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 0, minIntervalMs: 0 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  try {
    const probes = [];
    for (let i = 0; i < refusals.length; i++) {
      await post(`${base}/${SECRET}`, deployment("mon-app", "build-error"));
      await until(() => lines.filter((l) => l.startsWith("dispatch")).length === i + 1);
      probes.push(await health(base));
    }
    check("/healthz suit le dernier dispatch : 503 et son seul code apres 401, 403, 404 ou 422, 200 sinon", probes, [
      [503, "dernier dispatch refuse : 401"],
      [200, "ok"],
      [503, "dernier dispatch refuse : 403"],
      [503, "dernier dispatch refuse : 404"],
      [503, "dernier dispatch refuse : 422"],
      [200, "ok"],
    ]);
    check("un refus definitif n'est pas reprogramme", relay.pending().length, 0);
  } finally {
    await relay.shutdown();
  }
}
{
  // L'horloge du relais avance a la main : une attente de 30 s se franchit
  // sans l'attendre, en reveillant le relais par un nouvel evenement.
  let offset = 0;
  const gh = fakeGitHub();
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 0, minIntervalMs: 0 }), { ...quietDeps(gh.fetch, lines), now: () => Date.now() + offset });
  const base = await listen(relay);
  const failThrice = () => gh.responses.push(status(502), status(502), status(502));
  const waits: number[] = [];
  const nextRetry = async () => {
    await until(() => lines.filter((l) => l.startsWith("dispatch reprogramme a ")).length === waits.length + 1);
    const line = lines.findLast((l) => l.startsWith("dispatch reprogramme a ")) ?? "";
    waits.push(Math.round((Date.parse(line.slice("dispatch reprogramme a ".length)) - (Date.now() + offset)) / 1000));
  };
  try {
    failThrice();
    await post(`${base}/${SECRET}`, deployment("mon-app", "build-error"));
    await nextRetry();
    check("trois 5xx : le dispatch est reprogramme 30 s plus tard, dans le plan", [gh.calls.length, relay.pending().length, waits], [3, 1, [30]]);

    failThrice();
    offset += 31_000;
    await post(`${base}/${SECRET}`, deployment("autre-app", "build-error"));
    await nextRetry();
    await until(() => lines.at(-1) === "dispatch : 204");
    check("un second echec d'affilee double l'attente, un succes remet la serie a zero", [gh.calls.length, waits], [7, [30, 60]]);

    failThrice();
    await post(`${base}/${SECRET}`, deployment("mon-app", "build-error"));
    await nextRetry();
    check("apres un succes, un nouvel echec repart de 30 s", waits, [30, 60, 30]);
  } finally {
    await relay.shutdown();
  }
}
{
  const gh = fakeGitHub([status(429, { "Retry-After": "120" })]);
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 0, minIntervalMs: 0 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  try {
    const t0 = Date.now();
    await post(`${base}/${SECRET}`, deployment("mon-app", "build-error"));
    await until(() => lines.some((l) => l.startsWith("dispatch reprogramme")));
    const wait = (relay.pending()[0] ?? 0) - t0;
    check("un 429 avec Retry-After est reprogramme a l'heure portee par l'en-tete", [gh.calls.length, wait >= 120_000 && wait < 121_000], [1, true]);
  } finally {
    await relay.shutdown();
  }
}
{
  const gh = fakeGitHub([status(429, { "Retry-After": "7200" })]);
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 0, minIntervalMs: 0 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  try {
    await post(`${base}/${SECRET}`, deployment("mon-app", "build-error"));
    await until(() => lines.length >= 3);
    check(
      "un essai qui tomberait au-dela de 30 min : abandon journalise, rien de reprogramme",
      [relay.pending().length, lines.at(-1)],
      [0, "dispatch abandonne : le prochain essai tomberait plus de 30 min apres le premier echec"],
    );
  } finally {
    await relay.shutdown();
  }
}

console.log("\nArret");

{
  const gh = fakeGitHub();
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 60_000 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  await post(`${base}/${SECRET}`, deployment("mon-app", "success"));
  await post(`${base}/${SECRET}`, deployment("mon-app", "success"));
  const t0 = Date.now();
  await relay.shutdown();
  check(
    "SIGTERM avec des dispatch prevus : un seul part tout de suite",
    [gh.calls.length, Date.now() - t0 < 500, lines.slice(-2)],
    [1, true, ["arret : le dispatch prevu part maintenant", "dispatch : 204"]],
  );
  check("le serveur n'ecoute plus", relay.server.listening, false);
}
{
  const gh = fakeGitHub();
  const lines: string[] = [];
  const relay = createRelay(config(), quietDeps(gh.fetch, lines));
  await listen(relay);
  await relay.shutdown();
  check("SIGTERM sans dispatch prevu : aucun appel", [gh.calls.length, lines], [0, ["arret : aucun dispatch prevu"]]);
}
{
  const gh = fakeGitHub([status(502), status(502), status(502)]);
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 60_000 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  await post(`${base}/${SECRET}`, deployment("mon-app", "success"));
  await relay.shutdown();
  check(
    "a l'arret, un dispatch en echec n'est pas reprogramme",
    [gh.calls.length, relay.pending(), lines.slice(-2)],
    [3, [], ["arret : le dispatch prevu part maintenant", "dispatch en echec apres 3 essais : 502"]],
  );
}
{
  // Sommeil reel : l'arret attend la requete en cours jusqu'a 2 s.
  const gh = fakeGitHub();
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 60_000 }), { ...quietDeps(gh.fetch, lines), sleep });
  const base = await listen(relay);
  const late = slowPost(base, deployment("mon-app", "success"));
  await sleep(50);
  const t0 = Date.now();
  const stopped = relay.shutdown();
  await sleep(100);
  late.finish();
  const code = await late.status;
  await stopped;
  check(
    "SIGTERM pendant une requete : l'arret l'attend, et son evenement part avec le dispatch d'arret",
    [code, gh.calls.length, Date.now() - t0 < 1500, lines],
    [202, 1, true, ["deployment success sur mon-app : arret en cours, dispatch immediat", "arret : le dispatch prevu part maintenant", "dispatch : 204"]],
  );
}
{
  let release = () => {};
  const held = new Promise<Response>((resolve) => (release = () => resolve(new Response(null, { status: 204 }))));
  const gh = fakeGitHub([() => held]);
  const lines: string[] = [];
  const relay = createRelay(config({ delayMs: 60_000 }), quietDeps(gh.fetch, lines));
  const base = await listen(relay);
  await post(`${base}/${SECRET}`, deployment("mon-app", "success"));
  const late = slowPost(base, deployment("autre-app", "success"));
  await sleep(50);
  const stopped = relay.shutdown();
  await until(() => gh.calls.length === 1);
  late.finish();
  const code = await late.status;
  release();
  await stopped;
  check(
    "un evenement arrive apres l'attente de l'arret declenche un dispatch, que l'arret attend",
    [code, gh.calls.length, lines.slice(-4)],
    [
      202,
      2,
      [
        "arret : le dispatch prevu part maintenant",
        "deployment success sur autre-app : arret en cours, dispatch immediat",
        "dispatch : 204",
        "dispatch : 204",
      ],
    ],
  );
}

console.log("\nProcessus");

function runRelay(env: Record<string, string>) {
  const child = spawn(process.execPath, [RELAY], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = once(child, "exit").then(([code]) => code as number | null);
  return { child, exited, output: () => out };
}

{
  const bad = runRelay({ GITHUB_TOKEN: TOKEN, RELAY_SECRET: "court" });
  const code = await bad.exited;
  check(
    "configuration invalide : code 1, message clair, aucune valeur recopiee",
    [code, /RELAY_SECRET fait 5 caracteres/.test(bad.output()), /GITHUB_REPOSITORY est requis/.test(bad.output()), bad.output().includes(TOKEN)],
    [1, true, true, false],
  );
}
{
  // Aucun evenement n'est poste a ce processus : sans dispatch prevu, il
  // n'appelle jamais GitHub, meme a l'arret.
  const run = runRelay({ ...ENV, PORT: "0" });
  const deadline = Date.now() + 5000;
  let port: string | undefined;
  while (!port && Date.now() < deadline) {
    port = /en ecoute sur le port (\d+)/.exec(run.output())?.[1];
    if (!port) await sleep(20);
  }
  const probe = port ? await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.status) : null;
  run.child.kill("SIGTERM");
  const code = await run.exited;
  check(
    "node relay/relay.ts demarre, repond sur /healthz, et sort en 0 sur SIGTERM",
    [probe, code, /arret : aucun dispatch prevu/.test(run.output())],
    [200, 0, true],
  );
  check("le journal de demarrage ne porte ni le secret ni le jeton", run.output().includes(SECRET) || run.output().includes(TOKEN), false);
}

console.log(`\n${passed} verification(s) passee(s), ${failures} echec(s).\n`);
process.exit(failures > 0 ? 1 : 0);
