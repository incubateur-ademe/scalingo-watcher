/**
 * Tests des fonctions pures et de la coherence interne.
 *
 * Le reste du projet ne peut pas etre teste sans toucher Scalingo : ces tests
 * couvrent ce qui se verifie hors ligne, c'est-a-dire la comparaison de
 * versions, la reconnaissance des depots amont, et les invariants qui ont deja
 * lache en silence.
 *
 *   node test/test.ts
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse, parseDocument } from "yaml";
import {
  backupAddon,
  describeProposal,
  describeTools,
  loadLock,
  readManifest,
  RENAMED_FIELDS,
  resolveAliases,
  writeOptions,
} from "../src/apply.ts";
import { upstreamKey, upstreamsDeclared } from "../src/audit.ts";
import { renderManifest } from "../src/init.ts";
import { DEFAULT_FGP_URL, flagValue, flagValues, outFile, resolvePaths } from "../src/options.ts";
import { compareLines, toolName, upstreamOf } from "../src/upstream.ts";

const SRC = join(import.meta.dirname, "..", "src");
const FIXTURES = join(import.meta.dirname, "fixtures");

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

console.log("\nCoherence des constats de l'audit");

const audit = readFileSync(join(SRC, "audit.ts"), "utf8");

// La table etant desormais unique, ces controles verifient qu'aucun constat
// n'est emis sous un nom absent de cette table, seule erreur encore possible.
const tableSrc = audit.slice(audit.indexOf("const FINDINGS = ["), audit.indexOf("] as const;"));
const declaredKinds = new Set([...tableSrc.matchAll(/\["([a-z-]+)",/g)].map((m) => m[1]));
const emittedKinds = new Set([...audit.matchAll(/push\("([a-z-]+)"/g)].map((m) => m[1]));

check("aucun constat emis hors de la table", [...emittedKinds].filter((k) => !declaredKinds.has(k)), []);
check("aucun doublon dans la table", declaredKinds.size, [...tableSrc.matchAll(/\["([a-z-]+)",/g)].length);
check("la table n'a pas de constat vide", [...tableSrc.matchAll(/\["([a-z-]+)",\s*(?:"[^"]*"|`[^`]*`)/g)].length, declaredKinds.size);

console.log("\nGardes d'acces");

// La validation des pull requests tourne sans acces a Scalingo : toute etape
// qui interroge la plateforme doit se taire plutot que d'echouer.
const apply = readFileSync(join(SRC, "apply.ts"), "utf8");
const hasGuard = (name: string) => {
  const i = apply.indexOf(`async function ${name}(`);
  return i >= 0 && /!token && !fgp/.test(apply.slice(i, i + 900));
};
for (const name of ["applyDatabases", "checkDatabases", "proposeDatabaseUpgrades"]) {
  check(`${name} refuse de travailler sans acces`, hasGuard(name), true);
}

// bearerToken() rend une chaine vide tant qu'apiTokenRaw n'est pas posee. Posee
// apres la branche --adopt, l'amorcage partait sans entete d'authentification,
// se faisait refuser chaque app, et annoncait quand meme un lock amorce.
const tokenSetAt = apply.indexOf("apiTokenRaw = apiToken");
const adoptBranchAt = apply.indexOf("if (OPT.adopt) {");
check("le jeton est pose avant la branche --adopt", tokenSetAt > 0 && tokenSetAt < adoptBranchAt, true);

// L'amorcage passe par reqApi, qui s'authentifie seul par le proxy ou par le
// jeton de compte. Echanger le jeton sur ce chemin exigeait un jeton de compte
// que la configuration par proxy n'a pas, et faisait echouer l'amorcage.
const adoptBody = apply.slice(adoptBranchAt, apply.indexOf("// Le plan n'ecrit rien"));
check("l'amorcage n'echange pas de jeton lui-meme", /exchangeToken\(/.test(adoptBody), false);
check("l'amorcage compte ce qu'il a releve", /adoptedCount === 0/.test(adoptBody), true);

console.log("\nChamps lus sur les objets du lock");

// `q.since` a ete lu pendant des mois sur un objet dont le champ s'appelle
// `at` : ce chemin ne s'emprunte qu'avec une app en quarantaine, et rien ne
// verifiait les types. Les noms sont relus dans la declaration plutot que
// recopies ici, pour qu'ajouter un champ au lock n'oblige pas a toucher ce test.
const lockEntry = apply.slice(apply.indexOf("type LockEntry = {"), apply.indexOf("type Lock = {"));

const literalFields = (decl: string, pattern: RegExp, source: string): Set<string> => {
  const line = pattern.exec(source)?.[1];
  const literal = line && /\{(.+)\}/.exec(line);
  if (!literal) throw new Error(`declaration de ${decl} introuvable ou non litterale`);
  return new Set([...literal[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]));
};

const FIELDS: Record<string, Set<string>> = {
  quarantine: literalFields("quarantine", /^ {2}quarantine: (.+);$/m, lockEntry),
  backup: literalFields("backup", /^ {2}backup: (.+);$/m, lockEntry),
  deployment: literalFields("deployment", /^ {2}deployment: (.+);$/m, lockEntry),
  target: literalFields("Target", /^type Target = (.+);$/m, apply),
};

// Deux formes a couvrir : l'acces direct `entry.quarantine.at`, et l'alias
// `const q = entry!.quarantine!` suivi de `q.at`, qui est celle par laquelle le
// defaut est passe.
const unknownFields: string[] = [];
for (const [file, src] of [["apply.ts", apply], ["audit.ts", audit]] as const) {
  for (const [objectName, fields] of Object.entries(FIELDS)) {
    for (const m of src.matchAll(new RegExp(`\\.${objectName}[!?]*\\.(\\w+)`, "g"))) {
      if (!fields.has(m[1])) unknownFields.push(`${file} : .${objectName}.${m[1]}`);
    }
    for (const [, alias] of src.matchAll(new RegExp(`const (\\w+) = [^;\\n]*\\.${objectName}[!?]*;`, "g"))) {
      for (const m of src.matchAll(new RegExp(`\\b${alias}[!?]*\\.(\\w+)`, "g"))) {
        if (!fields.has(m[1])) unknownFields.push(`${file} : ${alias}.${m[1]}, alias de ${objectName}`);
      }
    }
  }
}
check("aucun champ inconnu lu sur les objets du lock", unknownFields, []);

// Le bloc du rapport d'incident nomme explicitement, parce que c'est le seul
// qui ne s'execute qu'en presence d'une app en quarantaine : une erreur y reste
// invisible tant que le parc va bien, et se declare le jour ou il va mal.
const quarantineBlock = apply.slice(
  apply.indexOf("for (const [key, entry] of quarantined) {"),
  apply.indexOf("Une application en quarantaine est laissee telle quelle"),
);
const readByReport = [...quarantineBlock.matchAll(/\bq\.(\w+)/g)].map((m) => m[1]);
check(
  "le rapport d'incident ne lit que des champs declares",
  [...new Set(readByReport)].filter((c) => !FIELDS.quarantine.has(c)),
  [],
);
check("le rapport d'incident date la mise en quarantaine", readByReport.includes("at"), true);

console.log("\nSauvegarde");

const srcBackupAddon = apply.slice(
  apply.indexOf("async function backupAddon("),
  apply.indexOf("// ---------------------------------------------------------------- deploiement"),
);

// Demander une sauvegarde sans regarder s'il en tourne deja une a fige le parc
// entier le 2026-09-23 : db-api refuse la seconde, le watcher n'a aucune memoire
// de la premiere, et chaque passage reconduisait le blocage.
check(
  "la sauvegarde n'est demandee qu'a defaut d'une sauvegarde en cours",
  /\?\?\s*\(await requestBackup\(\)\)/.test(srcBackupAddon),
  true,
);
check("le refus de sauvegarde concurrente est rattrape", /a backup is running/i.test(srcBackupAddon), true);

// Ce rattrapage lit le corps de la reponse, que req() ecrasait dans son message.
check("req expose le corps d'un refus", /\{ status: res\.status, body \}/.test(apply), true);

console.log("\nEclaireur");

const wave = apply.slice(apply.indexOf("let scoutDone = false;"), apply.indexOf("const rest = stopped"));

// Une interruption ne dit rien de la cible, contrairement a un echec. Les
// confondre laissait une base lente sur la premiere app bloquer tout le parc.
check(
  "un echec sur l'eclaireur arrete la vague",
  /if \(outcome === "failed"\) \{[^}]*stopped = true;/s.test(wave),
  true,
);
check(
  "une interruption isolee ne l'arrete pas",
  /interruptedScouts >= MAX_INTERRUPTED_SCOUTS/.test(wave),
  true,
);
check("le plafond d'interruptions vaut deux", /MAX_INTERRUPTED_SCOUTS = 2;/.test(apply), true);
check("le compteur retombe hors interruption", /interruptedScouts = 0;/.test(wave), true);

console.log("\nMarqueur d'etat du tableau de bord");

// Le workflow decide de prevenir l'equipe a partir de ce marqueur. S'il
// disparaissait du rapport, l'action retomberait silencieusement sur "sain".
const markers = [...apply.matchAll(/<!-- etat: \$\{[^}]+\} -->/g)].length;
check("le rapport pose un marqueur d'etat", markers, 1);
const action = readFileSync(join(import.meta.dirname, "..", "actions", "signaler", "action.yml"), "utf8");
check("l'action lit ce marqueur", /<!-- etat: sain -->/.test(action), true);

// Le pied est reecrit a chaque passage et retire avant de comparer. Renommer
// une de ses lignes d'un cote seulement ne casse rien de visible : le tableau
// parait simplement changer a chaque passage, et sa date de dernier changement
// se remet a jour sans que le parc ait bouge.
const writtenFooter = [...action.matchAll(/\\n(Dernier [a-z]+) : /g)].map((m) => m[1]).sort();
const ignoredFooter = [...action.matchAll(/\/\^(Dernier [a-z]+) : \/d/g)].map((m) => m[1]).sort();
check("le pied ecrit est celui que la comparaison ignore", writtenFooter, ignoredFooter);
check("le pied porte le changement et le passage", writtenFooter, ["Dernier changement", "Dernier passage"]);

console.log("\nNotification des changements d'etat");

// Le rapport commence par les tableaux du parc : envoyer son debut faisait
// porter a la notification un morceau de tableau, jamais ce qui demande une
// intervention.
{
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end("{}");
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const dir = mkdtempSync(join(tmpdir(), "scalingo-watcher-notify-"));
  const report = join(dir, "incident.md");
  writeFileSync(
    report,
    ["## Metabase", "", "| App | Version |", "| --- | --- |", ...Array.from({ length: 80 }, (_, i) => `| app-${i} | v0.63.18 |`), "",
      "<!-- etat: intervention -->", "", "## Ce qui demande une intervention", "", "- **osc-fr1/app-7** : deploiement en echec", ""].join("\n"),
  );
  const notify = join(import.meta.dirname, "..", "actions", "signaler", "notify.py");
  await new Promise<void>((done, fail) =>
    execFile("python3", [notify], {
      env: { ...process.env, STATE: "changed", ISSUE: "3", REPORT: report, REPO_URL: "https://github.com/o/r", RUN_URL: "https://github.com/o/r/actions/runs/1", SLACK_WEBHOOK: `http://127.0.0.1:${port}/` },
    }, (e) => (e ? fail(e) : done())),
  );
  server.close();
  rmSync(dir, { recursive: true, force: true });
  const text = (received[0] as { text?: string } | undefined)?.text ?? "";
  check(
    "la notification porte ce qui suit le marqueur, et pas les tableaux",
    [received.length, text.includes("osc-fr1/app-7 : deploiement en echec") || text.includes("**osc-fr1/app-7** : deploiement en echec"), text.includes("| app-0 |"), text.includes("<!--")],
    [1, true, false, false],
  );
}

console.log("\nConsignation du lock");

// git diff ignore un fichier non suivi : un lock cree par le passage etait
// annonce inchange et jamais commite.
{
  const step = (parse(readFileSync(join(import.meta.dirname, "..", "actions", "commit-lock", "action.yml"), "utf8")) as {
    runs: { steps: Array<{ run: string }> };
  }).runs.steps[0].run;
  const dir = mkdtempSync(join(tmpdir(), "scalingo-watcher-lock-"));
  // Isole de la configuration git de la machine : une signature imposee par
  // elle ferait echouer le test pour une raison etrangere a l'action.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
  git(dir, "clone", "-q", join(dir, "remote.git"), "work");
  const work = join(dir, "work");
  git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(work, "push", "-q", "origin", "HEAD:main");
  writeFileSync(join(work, "lock.json"), "{}\n");
  const result = spawnSync("bash", ["-c", step], {
    cwd: work,
    encoding: "utf8",
    env: { ...gitEnv, LOCK_PATH: "lock.json", MESSAGE: "chore(lock): premier lock", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
  });
  const pushed = git(join(dir, "remote.git"), "ls-tree", "--name-only", "main").trim().split("\n");
  check("un lock cree par le passage est commite et pousse", [result.status, pushed], [0, ["lock.json"]]);
  const again = spawnSync("bash", ["-c", step], {
    cwd: work,
    encoding: "utf8",
    env: { ...gitEnv, LOCK_PATH: "lock.json", MESSAGE: "x", GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" },
  });
  check("un lock deja commite et inchange n'est pas recommite", [again.status, /lock inchange/.test(again.stdout)], [0, true]);
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nSecrets des appelants du template");

// Le job appele ne lit la valeur d'un secret de l'environment que si
// l'appelant lui passe ce secret : non mappe, FGP_KEY arrivait vide et le parc
// tournait sans acces, en vert.
{
  const ROOT_DIR = join(import.meta.dirname, "..");
  type Workflow = { on?: { workflow_call?: { secrets?: Record<string, unknown> } }; jobs: Record<string, { uses?: string; secrets?: unknown }> };
  const readWorkflow = (file: string) => parse(readFileSync(file, "utf8")) as Workflow;
  const gaps = readdirSync(join(ROOT_DIR, "template", ".github", "workflows")).flatMap((name) => {
    const caller = readWorkflow(join(ROOT_DIR, "template", ".github", "workflows", name));
    return Object.values(caller.jobs).flatMap((job) => {
      const called = /\/\.github\/workflows\/([^@]+)@/.exec(job.uses ?? "")?.[1];
      if (!called) return [];
      const declared = Object.keys(readWorkflow(join(ROOT_DIR, ".github", "workflows", called)).on?.workflow_call?.secrets ?? {});
      const mapped = job.secrets && typeof job.secrets === "object" ? Object.keys(job.secrets) : [];
      return declared.filter((secret) => !mapped.includes(secret)).map((secret) => `${name} : ${secret}`);
    });
  });
  check("chaque appelant du template mappe tous les secrets du workflow appele", gaps, []);
}

console.log("\nAmont declare par l'audit");

// Indexe par variable seule, l'amont de la derniere app ecrasait celui des
// autres apps qui lisent la meme variable.
{
  const declared = upstreamsDeclared([
    { app: "a", region: "osc-fr1", tool: { env: "APP_VERSION", upstream: { repo: "exemple/a" } } },
    { app: "b", region: "osc-fr1", tool: { env: "APP_VERSION", upstream: { repo: "exemple/b" } } },
  ]);
  check(
    "deux apps qui lisent la meme variable gardent chacune leur amont",
    [declared.get(upstreamKey("osc-fr1", "a", "APP_VERSION"))?.repo, declared.get(upstreamKey("osc-fr1", "b", "APP_VERSION"))?.repo],
    ["exemple/a", "exemple/b"],
  );
}

console.log("\nSchema du manifeste");

const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schema", "manifest.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// Chaque cas part d'un manifeste complet, valide en premier, plutot que d'un
// gabarit ecrit a la main : un gabarit invente derive du schema sans qu'on s'en
// apercoive, et le test se met alors a mesurer autre chose que ce qu'il annonce.
const fixtureSrc = readFileSync(join(FIXTURES, "manifest.yaml"), "utf8");
const fixture = parse(fixtureSrc) as { apps: Array<Record<string, unknown>> };
const template = () => JSON.parse(JSON.stringify(fixture)) as typeof fixture;

check("le manifeste de test est valide", validate(fixture), true);
check("les exemples du schema sont valides", (schema.examples as unknown[]).map((e) => validate(e)), [true]);

// Les identifiants du parc sont relus dans son manifeste, quand le depot en
// porte un. Les ecrire ici les publierait avec l'outil.
const ROOT = join(import.meta.dirname, "..");
type FleetEntry = { app?: string; source?: { repo?: string; sha?: string } };
const fleetFile = join(ROOT, "manifest.yaml");
const fleetIds = existsSync(fleetFile)
  ? ((parse(readFileSync(fleetFile, "utf8")) as { apps?: FleetEntry[] }).apps ?? [])
      .flatMap((a) => [a.app, a.source?.repo, a.source?.sha?.slice(0, 7)])
      .filter((id): id is string => Boolean(id))
  : [];
const TOOL_FILES = [
  "README.md",
  "FEATURES.md",
  "fgp.md",
  "publiccode.yml",
  "schema/**",
  "src/**",
  "test/**",
  "actions/**",
  "renovate/**",
  "template/**",
  "template/.github/workflows/*.yml",
  ".github/workflows/*.yml",
];
const leaks = globSync(TOOL_FILES, { cwd: ROOT })
  .filter((f) => !/(^|\/)parc-[^/]*\.yml$/.test(f) && statSync(join(ROOT, f)).isFile())
  .flatMap((f) => {
    const text = readFileSync(join(ROOT, f), "utf8");
    return fleetIds.filter((id) => text.includes(id)).map((id) => `${f} : ${id}`);
  });
check(
  "les fichiers de l'outil ne citent aucun identifiant du parc",
  [existsSync(fleetFile) === fleetIds.length > 0, [...new Set(leaks)].sort()],
  [true, []],
);

const otherRegion = template();
otherRegion.apps[0].region = "osc-th1";
check("une region hors des deux connues est acceptee", validate(otherRegion), true);

const badRegion = template();
badRegion.apps[0].region = "exemple.test/osc";
check("une region qui sortirait du nom d'hote est refusee", validate(badRegion), false);

const withDatabase = template();
withDatabase.apps[0].database = { version: "16.13.0-2" };
check("une version de base declaree est acceptee", validate(withDatabase), true);

const emptyDatabase = template();
emptyDatabase.apps[0].database = {};
check("une base sans version est refusee", validate(emptyDatabase), false);

const unknownDatabaseField = template();
unknownDatabaseField.apps[0].database = { version: "16.13.0-2", plan: "starter" };
check("un champ inconnu dans database est refuse", validate(unknownDatabaseField), false);

const majorAllowed = template();
majorAllowed.apps[0].database = { version: "16.15.0-2", major: "allowed" };
check("database.major accepte allowed", validate(majorAllowed), true);

const majorInvalid = template();
majorInvalid.apps[0].database = { version: "16.15.0-2", major: "oui" };
check("database.major refuse une valeur libre", validate(majorInvalid), false);

const withUpstream = template();
(withUpstream.apps[0].tool as Record<string, unknown>).upstream = { repo: "exemple/outil", line: 2 };
check("tool.upstream est accepte", validate(withUpstream), true);

const upstreamWithoutRepo = template();
(upstreamWithoutRepo.apps[0].tool as Record<string, unknown>).upstream = { line: 1 };
check("tool.upstream sans depot est refuse", validate(upstreamWithoutRepo), false);

const upstreamUnknownField = template();
(upstreamUnknownField.apps[0].tool as Record<string, unknown>).upstream = { repo: "exemple/outil", datasource: "github-tags" };
check("un champ inconnu dans tool.upstream est refuse", validate(upstreamUnknownField), false);

console.log("\nAnciens noms de champs");

// La table du moteur est vide tant que rien n'a ete renomme : le mecanisme est
// exerce sur une table de test, qui renomme un champ d'app et un champ racine.
const RENAMES = [
  { from: "apps[].tool.variable", to: "apps[].tool.env" },
  { from: "defaults.sauvegarde", to: "defaults.backup" },
];
const legacy = () => {
  const m = template() as { defaults: Record<string, unknown>; apps: Array<Record<string, unknown>> };
  const tool = m.apps[0].tool as Record<string, unknown>;
  tool.variable = tool.env;
  delete tool.env;
  m.defaults.sauvegarde = m.defaults.backup;
  delete m.defaults.backup;
  return m;
};

check("aucun renommage n'est en vigueur a ce jour", RENAMED_FIELDS, []);
const renamed = legacy();
const aliasReport = resolveAliases(renamed, RENAMES);
check("un ancien nom est ramene au nom courant", [isDeepStrictEqual(renamed, fixture), validate(renamed)], [true, true]);
check("et il est signale, app par app", aliasReport, {
  warnings: [
    "apps[0] (alpha-metabase) : tool.variable est l'ancien nom de tool.env : toujours accepte, a renommer",
    "defaults.sauvegarde est l'ancien nom de defaults.backup : toujours accepte, a renommer",
  ],
  errors: [],
});
const redundant = legacy();
(redundant.apps[0].tool as Record<string, unknown>).env = "METABASE_VERSION";
check("les deux noms d'accord passent, avec l'avertissement", resolveAliases(redundant, RENAMES).errors, []);
const contradiction = legacy();
(contradiction.apps[0].tool as Record<string, unknown>).env = "GRAFANA_VERSION";
check(
  "les deux noms en desaccord sont refuses",
  resolveAliases(contradiction, RENAMES).errors,
  ["apps[0] (alpha-metabase) : tool.variable et tool.env se contredisent : retirer tool.variable, ancien nom de tool.env"],
);
check("sans table, le manifeste n'est pas touche", [resolveAliases(template()), template()], [{ warnings: [], errors: [] }, fixture]);

// Renovate, --validate et --propose-db relisent ces champs dans le texte brut,
// ou l'alias resolu n'existe pas.
const renameRejection = (rename: { from: string; to: string }) => {
  try {
    resolveAliases(template(), [rename]);
    return "accepte";
  } catch (e) {
    return (e as Error).message;
  }
};
check(
  "un champ lu dans le texte brut, ou son parent, ne se renomme pas",
  [
    renameRejection({ from: "apps[].origin", to: "apps[].source" }),
    renameRejection({ from: "apps[].tool.version", to: "apps[].tool.release" }),
    renameRejection({ from: "apps[].tool.variable", to: "apps[].tool.env" }),
  ],
  [
    "renommage apps[].origin -> apps[].source : apps[].source.branch est lu dans le texte du manifeste, ou un alias ne serait pas vu",
    "renommage apps[].tool.version -> apps[].tool.release : apps[].tool.version est lu dans le texte du manifeste, ou un alias ne serait pas vu",
    "accepte",
  ],
);

const aliasSandbox = mkdtempSync(join(tmpdir(), "scalingo-watcher-test-"));
try {
  const file = join(aliasSandbox, "manifest.yaml");
  writeFileSync(file, JSON.stringify(legacy()));
  const read = readManifest(file, RENAMES);
  check("le manifeste lu avec un ancien nom reste valide", [read.errors, read.warnings.length], [[], 2]);
  check("sans l'alias, le meme manifeste est refuse par le schema", readManifest(file).errors.length > 0, true);
} finally {
  rmSync(aliasSandbox, { recursive: true, force: true });
}
// --validate et le plan lisent le manifeste par le meme chemin, qui affiche
// les avertissements avant toute autre sortie.
check(
  "--validate et le plan passent par loadManifest",
  apply.indexOf("const manifest = loadManifest();") > 0 &&
    apply.indexOf("const manifest = loadManifest();") < apply.indexOf("if (OPT.validateOnly) {"),
  true,
);

console.log("\nOutils et depots amont");

check("Metabase est connu de la table", upstreamOf({ env: "METABASE_VERSION" }), { repo: "metabase/metabase", line: 1 });
check("un outil hors table n'a pas d'amont", upstreamOf({ env: "NGINX_VERSION" }), null);
check(
  "le manifeste surcharge la table, en gardant sa ligne",
  upstreamOf({ env: "METABASE_VERSION", upstream: { repo: "exemple/metabase" } }),
  { repo: "exemple/metabase", line: 1 },
);
check(
  "le manifeste complete la table",
  upstreamOf({ env: "NGINX_VERSION", upstream: { repo: "nginx/nginx", line: 2 } }),
  { repo: "nginx/nginx", line: 2 },
);
check("le nom vient de la table", toolName("METABASE_VERSION"), "Metabase");
check("a defaut, de la variable", toolName("OPENSEARCH_DASHBOARDS_VERSION"), "Opensearch dashboards");
// Chez Metabase, v0 et v1 sont deux editions publiees en parallele : v1.52.2
// n'est pas une montee pour une instance en v0.63.
check("v0.63 et v1.52 sont sur deux lignes", compareLines([0, 63, 18], [1, 52, 2], 1) < 0, true);
check("v0.63 et v0.64 sont sur la meme ligne", compareLines([0, 63, 18], [0, 64, 0], 1), 0);
check("une ligne de deux composants separe 0.63 de 0.64", compareLines([0, 63, 18], [0, 64, 0], 2) < 0, true);

console.log("\nChemins des donnees et des sorties");

check("par defaut, le parc se lit dans le repertoire courant", resolvePaths([], {}, "/parc"), {
  manifest: "/parc/manifest.yaml",
  lock: "/parc/lock.json",
  fgp: "/parc/fgp.json",
  outDir: join(tmpdir(), "scalingo-watcher"),
});
check(
  "en CI, les sorties vont sous RUNNER_TEMP",
  resolvePaths([], { RUNNER_TEMP: "/runner" }, "/parc").outDir,
  "/runner/scalingo-watcher",
);
check(
  "un chemin relatif part du repertoire courant",
  resolvePaths(["--manifest", "donnees/parc.yaml", "--lock=donnees/etat.json", "--out-dir", "sortie"], {}, "/parc"),
  { manifest: "/parc/donnees/parc.yaml", lock: "/parc/donnees/etat.json", fgp: "/parc/fgp.json", outDir: "/parc/sortie" },
);
check("un chemin absolu est garde tel quel", resolvePaths(["--fgp", "/ailleurs/fgp.json"], {}, "/parc").fgp, "/ailleurs/fgp.json");

const rejection = (argv: string[]) => {
  try {
    resolvePaths(argv, {}, "/parc");
    return "accepte";
  } catch (e) {
    return (e as Error).message;
  }
};
check("une option sans valeur est refusee", rejection(["--lock"]), "--lock attend une valeur");
check("une option suivie d'une autre est refusee", rejection(["--manifest", "--dry-run"]), "--manifest attend une valeur");
check("la forme --option=valeur est lue", resolvePaths(["--lock=etat.json"], {}, "/parc").lock, "/parc/etat.json");
check("une option repetable garde chaque valeur, sous ses deux formes", flagValues(["--region", "a", "--region=b"], "--region"), ["a", "b"]);
check("une option a valeur unique garde la derniere", flagValue(["--app", "a", "--app=b"], "--app"), "b");
check("--option= vide est refusee", (() => { try { flagValues(["--region="], "--region"); return null; } catch (e) { return (e as Error).message; } })(), "--region attend une valeur");

const outSandbox = mkdtempSync(join(tmpdir(), "scalingo-watcher-test-"));
try {
  const deep = join(outSandbox, "a", "b");
  const file = outFile({ ...resolvePaths([], {}, outSandbox), outDir: deep }, "incident.md");
  check("le repertoire de sortie est cree au besoin", [file, existsSync(deep)], [join(deep, "incident.md"), true]);
} finally {
  rmSync(outSandbox, { recursive: true, force: true });
}

console.log("\nVersion du lock");

const lockSandbox = mkdtempSync(join(tmpdir(), "scalingo-watcher-test-"));
const readLockVersion = (content: unknown) => {
  const f = join(lockSandbox, "lock.json");
  writeFileSync(f, JSON.stringify(content));
  try {
    return loadLock(f).version;
  } catch (e) {
    return (e as Error).message;
  }
};
try {
  check(
    "le lock de test se lit",
    Object.keys(loadLock(join(FIXTURES, "lock.json")).apps).length,
    fixture.apps.length,
  );
  check("un lock absent part vide", loadLock(join(lockSandbox, "absent.json")), { version: 1, generatedAt: null, apps: {} });
  check("un lock en version 1 est accepte", readLockVersion({ version: 1, generatedAt: null, apps: {} }), 1);
  check(
    "un lock d'une version superieure est refuse",
    /version 2.*jusqu'a la version 1/.test(String(readLockVersion({ version: 2, generatedAt: null, apps: {} }))),
    true,
  );
  check("un lock sans version est refuse", /version illisible/.test(String(readLockVersion({ apps: {} }))), true);
} finally {
  rmSync(lockSandbox, { recursive: true, force: true });
}

console.log("\nPull request de montee de base");

const upgrade = (app: string, to: string) => ({ app, from: "16.15.0-1", to });
check(
  "une seule base : son nom et sa cible",
  describeProposal([upgrade("alpha-metabase", "16.16.0-1")]).title,
  "Monter la base de alpha-metabase en 16.16.0-1",
);
check(
  "une cible commune est nommee une fois",
  describeProposal([upgrade("alpha-metabase", "16.16.0-1"), upgrade("gamma-metabase", "16.16.0-1")]).title,
  "Monter 2 bases en 16.16.0-1 : alpha-metabase, gamma-metabase",
);
const longNames = ["a", "b", "c", "d", "e"].map((x, i) => upgrade(`${x.repeat(20)}-metabase`, `16.1${6 + i}.0-1`));
check("un titre de plus de 100 caracteres ne garde que le compte", describeProposal(longNames).title, "Monter 5 bases d'un cran");

console.log("\nEcriture du manifeste");

// Variantes de forme du manifeste de test : la proposition de montee doit les
// traverser sans rien changer d'autre que les versions.
const indented4 = parseDocument(fixtureSrc).toString({ indent: 4 });
const flatList = parseDocument(fixtureSrc).toString({ indentSeq: false });
const annotated = fixtureSrc.replace("      version: 16.15.0-1\n", '      version: "16.15.0-1" # cran courant\n');
check("la forme du manifeste de test est reproduite", writeOptions(fixtureSrc), { indent: 2, indentSeq: true, lineWidth: 0 });
check("une indentation a quatre espaces est reconnue", writeOptions(indented4)?.indent, 4);
check("une liste non indentee est reconnue", writeOptions(flatList)?.indentSeq, false);

console.log("\nSauvegarde, contre un fetch simule");

// Les controles ci-dessus lisent le source ; ceux-ci exercent la fonction. Le
// defaut du 2026-09-23 etait un ordre d'appels, ce qu'une regex ne voit pas.
const URL_BACKUPS = "https://db-api.osc-fr1.scalingo.com/api/databases/ad-1/backups";
const URL_TOKEN = "https://api.osc-fr1.scalingo.com/v1/apps/alpha-metabase/addons/ad-1/token";
const app = { app: "alpha-metabase", region: "osc-fr1" } as never;
const done = (id: string) => ({ id, status: "done", created_at: "2026-09-23T05:04:00Z" });
const running = (id: string) => ({ id, status: "running", created_at: "2026-09-23T05:04:00Z" });

/** Repond aux appels attendus dans l'ordre, et note ce qui a ete demande. */
function simulate(responses: Record<string, Array<{ body: unknown; status?: number }>>) {
  const trace: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const key = `${init.method ?? "GET"} ${String(url)}`;
    trace.push(key.includes("/token") ? "jeton" : key.startsWith("POST") ? "demande" : "releve");
    const queue = responses[key];
    if (!queue?.length) throw new Error(`appel imprevu : ${key}`);
    const r = queue.shift()!;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as never;
  return trace;
}

let trace = simulate({
  [`POST ${URL_TOKEN}`]: [{ body: { addon: { token: "tok" } } }],
  [`GET ${URL_BACKUPS}`]: [
    { body: { database_backups: [done("vieille")] } },
    { body: { database_backups: [done("vieille"), done("neuve")] } },
  ],
  [`POST ${URL_BACKUPS}`]: [{ body: { database_backup: { id: "neuve" } } }],
});
check("rien en vol : la sauvegarde est demandee", await backupAddon(app, "ad-1"), {
  id: "neuve",
  at: "2026-09-23T05:04:00Z",
});
check("l'ordre est releve puis demande", trace, ["jeton", "releve", "demande", "releve"]);

// Le cas exact du blocage : une orpheline tournait encore, et le passage suivant
// en redemandait une plutot que de l'attendre.
const announced: string[] = [];
trace = simulate({
  [`POST ${URL_TOKEN}`]: [{ body: { addon: { token: "tok" } } }],
  [`GET ${URL_BACKUPS}`]: [
    { body: { database_backups: [done("vieille"), running("orpheline")] } },
    { body: { database_backups: [done("vieille"), done("orpheline")] } },
  ],
});
check(
  "une sauvegarde en cours est adoptee",
  await backupAddon(app, "ad-1", (l) => announced.push(l.trim())),
  { id: "orpheline", at: "2026-09-23T05:04:00Z" },
);
check("aucune seconde sauvegarde n'est demandee", trace.includes("demande"), false);
check("le rattachement est annonce", announced, ["sauvegarde orpheline deja en cours, rattachement"]);

// Une sauvegarde peut demarrer entre le releve et la demande, la plateforme en
// lancant elle-meme periodiquement.
simulate({
  [`POST ${URL_TOKEN}`]: [{ body: { addon: { token: "tok" } } }],
  [`GET ${URL_BACKUPS}`]: [
    { body: { database_backups: [] } },
    { body: { database_backups: [running("surgie")] } },
    { body: { database_backups: [done("surgie")] } },
  ],
  [`POST ${URL_BACKUPS}`]: [{ body: { error: "A backup is running" }, status: 400 }],
});
check("un 400 de sauvegarde concurrente est rattrape", await backupAddon(app, "ad-1"), {
  id: "surgie",
  at: "2026-09-23T05:04:00Z",
});

// Le rattrapage ne doit pas rejouer la liste blanche : db-api vient d'affirmer
// qu'une sauvegarde tourne, un statut imprevu ne doit pas le contredire.
simulate({
  [`POST ${URL_TOKEN}`]: [{ body: { addon: { token: "tok" } } }],
  [`GET ${URL_BACKUPS}`]: [
    { body: { database_backups: [] } },
    { body: { database_backups: [{ ...running("inattendue"), status: "uploading" }] } },
    { body: { database_backups: [done("inattendue")] } },
  ],
  [`POST ${URL_BACKUPS}`]: [{ body: { error: "A backup is running" }, status: 400 }],
});
// Rendu plutot que jete, pour que la regression sorte en ECHEC lisible au lieu
// d'interrompre le fichier.
let adopted: unknown;
try {
  adopted = await backupAddon(app, "ad-1");
} catch (e) {
  adopted = `leve : ${(e as Error).message.slice(0, 80)}`;
}
check("un statut hors de la liste blanche est quand meme adopte", adopted, {
  id: "inattendue",
  at: "2026-09-23T05:04:00Z",
});

simulate({
  [`POST ${URL_TOKEN}`]: [{ body: { addon: { token: "tok" } } }],
  [`GET ${URL_BACKUPS}`]: [{ body: { database_backups: [] } }],
  [`POST ${URL_BACKUPS}`]: [{ body: { error: "plan does not allow backups" }, status: 400 }],
});
let thrown = "";
try {
  await backupAddon(app, "ad-1");
} catch (e) {
  thrown = (e as Error).message;
}
check("tout autre refus remonte", /plan does not allow backups/.test(thrown), true);

console.log("\nSections du rapport, contre un fetch simule");

const releases = (...tags: string[]) => ({ body: tags.map((tag_name) => ({ tag_name, draft: false, prerelease: false })) });
simulate({
  // v1.64.2 est plus haute mais d'une autre edition : seule v0.63.20 compte.
  "GET https://api.github.com/repos/metabase/metabase/releases?per_page=100": [releases("v1.64.2", "v0.63.20", "v0.63.18")],
  "GET https://api.github.com/repos/exemple/outil/releases?per_page=100": [releases("2.1.0", "2.0.0")],
  [`GET https://api.github.com/repos/exemple/metabase-scalingo/branches/main`]: [{ body: { commit: { sha: "a".repeat(40) } } }],
});
const reportApp = (app: string, tool: Record<string, unknown>) =>
  ({ ...fixture.apps[0], app, tool }) as never;
const sections = await describeTools(
  [
    fixture.apps[0] as never,
    reportApp("nginx-maison", { env: "NGINX_VERSION", version: "1.27.4" }),
    reportApp("outil-maison", { env: "OUTIL_MAISON_VERSION", version: "2.0.0", upstream: { repo: "exemple/outil" } }),
  ],
  loadLock(join(FIXTURES, "lock.json")),
);
check(
  "une section par outil, titree d'apres lui",
  sections.filter((l) => l.startsWith("## ")),
  ["## Metabase", "## Nginx", "## Outil maison"],
);
const rowOf = (app: string) => sections.find((l) => l.startsWith(`| [${app}]`)) ?? "";
check(
  "la version disponible reste dans la ligne de l'edition",
  rowOf("alpha-metabase").includes(
    "| [v0.63.18](https://github.com/metabase/metabase/releases/tag/v0.63.18) | [v0.63.20](https://github.com/metabase/metabase/releases/tag/v0.63.20) |",
  ),
  true,
);
check("un outil sans amont connu le dit", rowOf("nginx-maison").includes("| 1.27.4 | amont inconnu |"), true);
check(
  "les liens de release suivent tool.upstream",
  rowOf("outil-maison").includes("| [2.0.0](https://github.com/exemple/outil/releases/tag/2.0.0) | [2.1.0](https://github.com/exemple/outil/releases/tag/2.1.0) |"),
  true,
);

console.log("\nCommandes lancees hors du depot, contre un fetch simule");

// Le moteur tourne depuis la racine du depot consommateur sans y etre installe.
// Chaque passage part donc d'un repertoire courant vide, le parc a cote et les
// sorties ailleurs, et chaque appel reseau est releve.
const FAKE_FETCH = pathToFileURL(join(FIXTURES, "fetch-mock.ts")).href;
const lockFixture = readFileSync(join(FIXTURES, "lock.json"), "utf8");

const appKey = (a: Record<string, unknown>) => `${a.region}/${a.app}`;
const versionOf = (a: Record<string, unknown>) => (a.database as { version: string }).version;
const versions = Object.fromEntries(fixture.apps.filter((a) => a.database).map((a) => [appKey(a), versionOf(a)]));
const managed = fixture.apps.filter((a) => a.database && !a.paused).map(appKey).sort();

// Les acces du poste ou de la CI n'atteignent jamais un passage de test, meme
// contre un fetch simule.
const envWithoutAccess = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !["FGP_KEY", "SCALINGO_API_TOKEN", "RUNNER_TEMP", "GITHUB_REPOSITORY", "FGP_URL"].includes(k)),
);

type Sandbox = { root: string; cwd: string; fleet: string; outDir: string };
const sandboxes: string[] = [];

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "scalingo-watcher-test-"));
  sandboxes.push(root);
  const b = { root, cwd: join(root, "ici"), fleet: join(root, "parc"), outDir: join(root, "sortie") };
  mkdirSync(b.cwd);
  mkdirSync(b.fleet);
  for (const f of ["manifest.yaml", "lock.json"]) copyFileSync(join(FIXTURES, f), join(b.fleet, f));
  return b;
}

function run(b: Sandbox, script: string, args: string[], env: Record<string, string> = {}, fakeFetch = FAKE_FETCH) {
  const trace = join(b.root, "trace.txt");
  rmSync(trace, { force: true });
  const child = spawnSync(process.execPath, ["--import", fakeFetch, join(SRC, script), ...args], {
    cwd: b.cwd,
    encoding: "utf8",
    // Une regression qui relancerait la vague attendrait sinon les delais de
    // deploiement et de sauvegarde, soit des dizaines de minutes.
    timeout: 60_000,
    env: { ...envWithoutAccess, TRACE: trace, VERSIONS: JSON.stringify(versions), ...env },
  });
  return {
    status: child.status,
    output: `${child.stdout}${child.stderr}`,
    calls: existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
  };
}

const listDir = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : null);
const FLEET = ["--manifest", "../parc/manifest.yaml", "--lock", "../parc/lock.json"];

try {
  const b = sandbox();
  const validation = run(b, "apply.ts", ["--validate", "--manifest", "../parc/manifest.yaml"]);
  check(
    "--validate lit le manifeste designe, avec le schema du moteur",
    [validation.status, /valide : 4 app\(s\)/.test(validation.output)],
    [0, true],
  );

  // Les controles de donnees du parc, qui lisaient autrefois le parc reel ici
  // meme, tournent desormais dans --validate.
  const validateVariant = (label: string, manifestSrc: string, lockSrc = lockFixture) => {
    const v = sandbox();
    writeFileSync(join(v.fleet, "manifest.yaml"), manifestSrc);
    writeFileSync(join(v.fleet, "lock.json"), lockSrc);
    const out = run(v, "apply.ts", ["--validate", ...FLEET]);
    return [label, out.status, out.output.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim())];
  };
  check(
    "le parc de test passe les controles de donnees",
    validateVariant("gabarit", fixtureSrc),
    ["gabarit", 0, []],
  );
  check(
    "les controles ne dependent pas de l'indentation",
    validateVariant("quatre espaces", indented4),
    ["quatre espaces", 0, []],
  );
  // Arrive en alignant une app sur le depot des autres : Renovate cherchait
  // une branche qui n'existe pas.
  check(
    "une annotation git-refs qui designe un autre depot est refusee",
    validateVariant("depot", fixtureSrc.replace("depName=exemple/metabase-scalingo", "depName=exemple/ancien-depot")),
    ["depot", 1, ["osc-fr1/alpha-metabase : l'annotation de sha designe exemple/ancien-depot, le depot declare est exemple/metabase-scalingo"]],
  );
  check(
    "un sha sans annotation est refuse",
    validateVariant("sha", fixtureSrc.replace("      # renovate: datasource=git-refs depName=exemple/metabase-scalingo\n", "")),
    [
      "sha",
      1,
      ["osc-fr1/alpha-metabase : sha n'est pas precede de son annotation # renovate: datasource=git-refs depName=exemple/metabase-scalingo, Renovate ne le suit pas"],
    ],
  );
  check(
    "une version sans annotation est refusee",
    validateVariant("version", fixtureSrc.replace("      # renovate: datasource=github-releases depName=metabase/metabase\n", "")),
    ["version", 1, ["osc-fr1/alpha-metabase : tool.version n'est pas precedee de son annotation # renovate:, Renovate ne la suit pas"]],
  );
  const orphanLock = JSON.parse(lockFixture) as { apps: Record<string, unknown> };
  orphanLock.apps["osc-fr1/disparue-metabase"] = orphanLock.apps["osc-fr1/alpha-metabase"];
  check(
    "une entree de lock orpheline est refusee",
    validateVariant("orpheline", fixtureSrc, JSON.stringify(orphanLock, null, 2)),
    ["orpheline", 1, ["osc-fr1/disparue-metabase : entree de lock sans app dans le manifeste, a retirer par --prune si l'abandon est definitif"]],
  );

  const plan = run(b, "apply.ts", ["--dry-run", ...FLEET, "--out-dir", "../sortie"]);
  check("le plan lit le parc designe", [plan.status, (plan.output.match(/ : deja conforme$/gm) ?? []).length], [0, 3]);
  check("le plan n'ecrit rien, ni ici ni en sortie", [listDir(b.cwd), listDir(b.outDir)], [[], null]);
  check("le plan laisse le lock en l'etat", readFileSync(join(b.fleet, "lock.json"), "utf8"), lockFixture);

  const missingValue = run(b, "apply.ts", ["--dry-run", "--lock"]);
  check("une option sans valeur arrete la commande", [missingValue.status, /--lock attend une valeur/.test(missingValue.output)], [1, true]);

  writeFileSync(join(b.root, "lock-v2.json"), JSON.stringify({ version: 2, generatedAt: null, apps: {} }));
  const v2 = run(b, "apply.ts", ["--dry-run", "--manifest", "../parc/manifest.yaml", "--lock", "../lock-v2.json"]);
  check(
    "un lock trop recent arrete le plan avant tout appel",
    [v2.status, /version 2/.test(v2.output), v2.calls],
    [1, true, []],
  );

  const dryProposal = run(b, "apply.ts", ["--propose-db", "--dry-run", ...FLEET, "--out-dir", "../sortie"], {
    SCALINGO_API_TOKEN: "faux",
  });
  check(
    "--propose-db en plan annonce les montees sans rien ecrire",
    [
      dryProposal.status,
      /alpha-metabase : 16\.15\.0-1 -> 16\.99\.0-1/.test(dryProposal.output),
      /2 montee\(s\) de base a proposer \(plan/.test(dryProposal.output),
      readFileSync(join(b.fleet, "manifest.yaml"), "utf8") === fixtureSrc,
      listDir(b.outDir),
    ],
    [0, true, true, true, null],
  );

  // --propose-db tourne chaque jour avec un acces reel, hors du verrou de la
  // convergence, et seul le manifeste en est commite.
  const nominal = run(b, "apply.ts", ["--propose-db", ...FLEET, "--out-dir", "../sortie"], { SCALINGO_API_TOKEN: "faux" });
  check("le passage reussit", nominal.status, 0);
  if (nominal.status !== 0) console.log(nominal.output);

  const allowedCalls = [
    /^POST https:\/\/auth\.scalingo\.com\/v1\/tokens\/exchange$/,
    /^GET https:\/\/api\.[^/]+\/v1\/apps\/[^/]+\/addons$/,
    /^POST https:\/\/api\.[^/]+\/v1\/apps\/[^/]+\/addons\/[^/]+\/token$/,
    /^GET https:\/\/db-api\.[^/]+\/api\/(databases|database_type_versions)\/[^/]+$/,
  ];
  check("seules les bases sont interrogees", nominal.calls.filter((l) => !allowedCalls.some((re) => re.test(l))), []);

  const queried = nominal.calls.flatMap((l) => {
    const m = /^GET https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps\/([^/]+)\/addons$/.exec(l);
    return m ? [`${m[1]}/${m[2]}`] : [];
  });
  check("chaque base pilotee est relevee, et elle seule", queried.sort(), managed);

  check("le lock n'est pas reecrit", readFileSync(join(b.fleet, "lock.json"), "utf8"), lockFixture);
  check("rien n'est ecrit dans le repertoire courant", listDir(b.cwd), []);
  check("le parc ne gagne aucun fichier", listDir(b.fleet), ["lock.json", "manifest.yaml"]);
  check("la proposition est deposee dans --out-dir", listDir(b.outDir), ["db-proposal.json", "pr-body.md", "pr-title.txt"]);
  check(
    "le titre de la pull request nomme les apps entieres",
    readFileSync(join(b.outDir, "pr-title.txt"), "utf8"),
    "Monter 2 bases d'un cran : alpha-metabase, gamma-metabase\n",
  );
  check(
    "le corps liste chaque montee",
    readFileSync(join(b.outDir, "pr-body.md"), "utf8").split("\n").filter((l) => l.startsWith("- `")),
    ["- `alpha-metabase` : 16.15.0-1 vers 16.99.0-1", "- `gamma-metabase` : 17.11.0-1 vers 17.99.0-1"],
  );

  const expectedVersions = Object.fromEntries(
    fixture.apps
      .filter((a) => a.database)
      .map((a) => [appKey(a), a.paused ? versionOf(a) : `${versionOf(a).split(".")[0]}.99.0-1`]),
  );
  // Le remplacement textuel d'autrefois ne reconnaissait que l'indentation du
  // parc d'origine. L'ecriture passe desormais par le document YAML, qui
  // reecrit tout le fichier : seules les versions doivent en sortir changees.
  const changedLines = (before: string, after: string) => {
    const [x, y] = [before.split("\n"), after.split("\n")];
    if (x.length !== y.length) return `${x.length} lignes avant, ${y.length} apres`;
    return x.flatMap((l, i) => (l === y[i] ? [] : [`${l.trim()} => ${y[i].trim()}`]));
  };
  const BUMPS = ["version: 16.15.0-1 => version: 16.99.0-1", "version: 17.11.0-1 => version: 17.99.0-1"];
  check("seules les versions des bases changent", changedLines(fixtureSrc, readFileSync(join(b.fleet, "manifest.yaml"), "utf8")), BUMPS);

  for (const [label, variant, bumps] of [
    ["indente a quatre espaces", indented4, BUMPS],
    ["en liste non indentee", flatList, BUMPS],
    [
      "entre guillemets et commente",
      annotated,
      ['version: "16.15.0-1" # cran courant => version: "16.99.0-1" # cran courant', BUMPS[1]],
    ],
  ] as const) {
    const v = sandbox();
    writeFileSync(join(v.fleet, "manifest.yaml"), variant);
    const out = run(v, "apply.ts", ["--propose-db", ...FLEET, "--out-dir", "../sortie"], { SCALINGO_API_TOKEN: "faux" });
    check(
      `un manifeste ${label} ne change qu'aux versions`,
      [out.status, changedLines(variant, readFileSync(join(v.fleet, "manifest.yaml"), "utf8"))],
      [0, bumps],
    );
  }

  const proposed = parse(readFileSync(join(b.fleet, "manifest.yaml"), "utf8")) as typeof fixture;
  const actualVersions = Object.fromEntries(proposed.apps.filter((a) => a.database).map((a) => [appKey(a), versionOf(a)]));
  check("le manifeste porte la montee des bases actives", actualVersions, expectedVersions);

  // Le manifeste etant desormais en avance sur les bases simulees, ce second
  // passage n'a rien a proposer.
  const nothing = run(b, "apply.ts", ["--propose-db", ...FLEET, "--out-dir", "../sortie"], { SCALINGO_API_TOKEN: "faux" });
  check("une proposition perimee est retiree de --out-dir", [nothing.status, listDir(b.outDir)], [0, []]);

  const inCi = sandbox();
  const defaultOut = run(inCi, "apply.ts", ["--propose-db", ...FLEET], { SCALINGO_API_TOKEN: "faux", RUNNER_TEMP: inCi.outDir });
  check(
    "sans --out-dir, les sorties vont sous $RUNNER_TEMP/scalingo-watcher",
    [defaultOut.status, listDir(join(inCi.outDir, "scalingo-watcher"))],
    [0, ["db-proposal.json", "pr-body.md", "pr-title.txt"]],
  );

  // Un acces casse doit faire echouer le passage, et non se lire comme un parc a
  // jour : le workflow annoncerait alors qu'il n'y a rien a proposer.
  const brokenSandbox = sandbox();
  const outage = run(brokenSandbox, "apply.ts", ["--propose-db", ...FLEET, "--out-dir", "../sortie"], {
    SCALINGO_API_TOKEN: "faux",
    OUTAGE: "1",
  });
  check("une panne d'acces fait echouer le passage", outage.status, 1);
  check("une panne d'acces ne touche pas le manifeste", readFileSync(join(brokenSandbox.fleet, "manifest.yaml"), "utf8"), fixtureSrc);

  const proxy = sandbox();
  const allCallsTo = (calls: string[], host: string) => calls.length > 0 && calls.every((l) => l.split(" ")[1].startsWith(`${host}/`));
  const viaFgp = run(proxy, "apply.ts", ["--propose-db", ...FLEET, "--fgp", join(FIXTURES, "fgp.json")], {
    FGP_KEY: "cle-factice-des-tests",
  });
  check("--fgp est lu : chaque appel part vers le proxy qu'il declare", allCallsTo(viaFgp.calls, "https://fgp.exemple.test"), true);

  const { url: _url, ...withoutUrl } = JSON.parse(readFileSync(join(FIXTURES, "fgp.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(proxy.root, "fgp-sans-url.json"), JSON.stringify(withoutUrl));
  const defaultFgp = run(proxy, "apply.ts", ["--propose-db", ...FLEET, "--fgp", "../fgp-sans-url.json"], {
    FGP_KEY: "cle-factice-des-tests",
  });
  check("sans url dans fgp.json, le proxy par defaut est vise", allCallsTo(defaultFgp.calls, DEFAULT_FGP_URL), true);

  const audit = run(proxy, "audit.ts", ["--fgp", join(FIXTURES, "fgp.json"), "--manifest", "../parc/manifest.yaml"], {
    FGP_KEY: "cle-factice-des-tests",
  });
  check(
    "l'audit lit --fgp",
    [audit.status, audit.output.includes("Acces par le proxy https://fgp.exemple.test")],
    [0, true],
  );

  const listedRegions = (calls: string[]) =>
    calls.flatMap((l) => /^GET https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps$/.exec(l)?.slice(1) ?? []);
  const fromManifest = run(proxy, "audit.ts", ["--manifest", "../parc/manifest.yaml"], { SCALINGO_API_TOKEN: "faux" });
  check(
    "l'audit parcourt les regions du manifeste",
    [fromManifest.status, listedRegions(fromManifest.calls)],
    [0, ["osc-fr1", "osc-secnum-fr1"]],
  );
  const fromFlag = run(proxy, "audit.ts", ["--region", "osc-th1", "--region", "osc-fr1"], { SCALINGO_API_TOKEN: "faux" });
  check("--region s'en passe, et se repete", [fromFlag.status, listedRegions(fromFlag.calls)], [0, ["osc-th1", "osc-fr1"]]);
  const inlineRegion = run(proxy, "audit.ts", ["--region=osc-th1"], { SCALINGO_API_TOKEN: "faux" });
  check("--region=valeur est lue comme --region valeur", [inlineRegion.status, listedRegions(inlineRegion.calls)], [0, ["osc-th1"]]);
  const noRegion = run(proxy, "audit.ts", [], { SCALINGO_API_TOKEN: "faux" });
  check(
    "sans manifeste ni --region, l'audit s'arrete avant tout appel",
    [noRegion.status, /preciser --region/.test(noRegion.output), noRegion.calls],
    [1, true, []],
  );
  const hostile = run(proxy, "audit.ts", ["--region", "exemple.test/x"], { SCALINGO_API_TOKEN: "faux" });
  check("une region mal formee est refusee avant tout appel", [hostile.status, hostile.calls], [1, []]);

  const blobs = sandbox();
  copyFileSync(join(FIXTURES, "fgp.json"), join(blobs.fleet, "fgp.json"));
  const BLOBS = ["--manifest", "../parc/manifest.yaml", "--fgp", "../parc/fgp.json", "--out-dir", "../sortie"];
  const BLOBS_ENV = { SCALINGO_API_TOKEN: "faux", FGP_KEY: "cle-factice-des-tests-de-24-caracteres" };
  const generatedOn = (calls: string[]) =>
    [...new Set(calls.flatMap((l) => /^POST (.+)\/api\/generate$/.exec(l)?.slice(1) ?? []))];
  const readFgp = () => JSON.parse(readFileSync(join(blobs.fleet, "fgp.json"), "utf8")) as { url: string; api: Record<string, string> };

  const generation = run(blobs, "fgp-blobs.ts", [...BLOBS, "--url", "https://autre.exemple.test/"], {
    ...BLOBS_ENV,
    GITHUB_REPOSITORY: "exemple/parc",
  });
  check(
    "fgp-blobs genere aupres du proxy de --url et l'ecrit dans le fichier de --fgp",
    [generation.status, generatedOn(generation.calls), readFgp().url, Object.keys(readFgp().api).sort()],
    [0, ["https://autre.exemple.test"], "https://autre.exemple.test", ["osc-fr1", "osc-secnum-fr1"]],
  );
  check(
    "et sauvegarde le precedent dans --out-dir",
    readFileSync(join(blobs.outDir, "fgp.json.bak"), "utf8"),
    readFileSync(join(FIXTURES, "fgp.json"), "utf8"),
  );
  check("fgp-blobs n'ecrit rien dans le repertoire courant", listDir(blobs.cwd), []);
  check(
    "la commande de pose du secret vise $GITHUB_REPOSITORY",
    generation.output.includes("gh secret set FGP_KEY --env production --repo exemple/parc\n"),
    true,
  );

  const regeneration = run(blobs, "fgp-blobs.ts", BLOBS, BLOBS_ENV);
  check(
    "sans --url, le proxy du fgp.json existant est repris",
    [regeneration.status, generatedOn(regeneration.calls), readFgp().url],
    [0, ["https://autre.exemple.test"], "https://autre.exemple.test"],
  );
  check(
    "hors CI et hors depot, la commande laisse le depot a preciser",
    regeneration.output.includes("gh secret set FGP_KEY --env production --repo <owner>/<depot>\n"),
    true,
  );

  const hostileFleet = sandbox();
  writeFileSync(
    join(hostileFleet.fleet, "manifest.yaml"),
    readFileSync(join(FIXTURES, "manifest.yaml"), "utf8").replace(/region: osc-fr1/, "region: exemple.test/x#"),
  );
  const hostileBlobs = run(hostileFleet, "fgp-blobs.ts", ["--manifest", "../parc/manifest.yaml", "--fgp", "../parc/fgp.json", "--out-dir", "../sortie"], BLOBS_ENV);
  check(
    "fgp-blobs refuse un manifeste invalide avant d'envoyer le jeton",
    [hostileBlobs.status, /invalide/.test(hostileBlobs.output), hostileBlobs.calls],
    [1, true, []],
  );

  const cleartext = run(blobs, "fgp-blobs.ts", [...BLOBS, "--url", "http://fgp.exemple.test"], BLOBS_ENV);
  check("un proxy hors https est refuse avant tout appel", [cleartext.status, cleartext.calls], [1, []]);

  const cloned = sandbox();
  execFileSync("git", ["init", "-q"], { cwd: cloned.cwd });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:exemple/depuis-git.git"], { cwd: cloned.cwd });
  const fromRemote = run(cloned, "fgp-blobs.ts", ["--manifest", "../parc/manifest.yaml", "--fgp", "../parc/fgp.json"], BLOBS_ENV);
  check(
    "dans un clone, le depot vient du remote origin",
    [fromRemote.status, fromRemote.output.includes("--repo exemple/depuis-git")],
    [0, true],
  );

  console.log("\nPremier manifeste par init, contre un fetch simule");

  // Le parc simule de fetch-init.ts : quatre apps decrites entierement, trois a
  // ecarter pour une raison chacune, une sans outil connu.
  const INIT_FETCH = pathToFileURL(join(FIXTURES, "fetch-init.ts")).href;
  const SECRET = "valeur-secrete-qui-ne-doit-sortir-nulle-part";
  const REGIONS = ["--region", "osc-fr1", "--region", "osc-secnum-fr1"];
  const NEW_FLEET = ["--manifest", "../neuf/manifest.yaml", "--lock", "../neuf/lock.json"];
  const TOKEN = { SCALINGO_API_TOKEN: "faux" };
  type GeneratedApp = {
    app: string;
    region: string;
    backup?: string;
    database?: { version: string };
    source: { repo: string; branch: string; sha: string };
    tool: { env: string; version: string };
  };
  const readGenerated = (b: Sandbox) => {
    const file = join(b.root, "neuf", "manifest.yaml");
    const src = existsSync(file) ? readFileSync(file, "utf8") : "";
    return { file, src, manifest: parse(src) as { defaults: unknown; apps: GeneratedApp[] } | null };
  };

  const fresh = sandbox();
  const init = run(fresh, "init.ts", [...REGIONS, ...NEW_FLEET], TOKEN, INIT_FETCH);
  if (init.status !== 0) console.log(init.output);
  const generated = readGenerated(fresh);
  const generatedApps = generated.manifest?.apps ?? [];

  check("init ecrit le manifeste designe, repertoire compris", [init.status, existsSync(generated.file)], [0, true]);
  check("le manifeste genere est valide contre le schema", validate(generated.manifest), true);
  check("les reglages par defaut sont ceux du parc", generated.manifest?.defaults, {
    policy: { minor: "auto", major: "pr" },
    backup: "required",
  });
  check(
    "seules les apps decrites entierement sont retenues, par region puis par nom",
    generatedApps.map(appKey),
    ["osc-fr1/alpha-metabase", "osc-fr1/beta-metabase", "osc-fr1/grafana-interne", "osc-secnum-fr1/zeta-metabase"],
  );
  check("une app est decrite telle qu'elle tourne", generatedApps[0], {
    app: "alpha-metabase",
    region: "osc-fr1",
    database: { version: "16.15.0-1" },
    source: { repo: "exemple/metabase-scalingo", branch: "main", sha: "a".repeat(40) },
    tool: { env: "METABASE_VERSION", version: "v0.63.18" },
  });
  check("la branche suivie vient du lien de l'app a son depot", generatedApps[1]?.source.branch, "oauth2");
  check("le sha est celui du dernier deploiement, meme en echec", generatedApps[1]?.source.sha, "b".repeat(40));
  check("deux bases sur l'app : aucune n'est pilotee", generatedApps[1]?.database, undefined);
  check("sans addon de base, la sauvegarde est declaree impossible", generatedApps[2]?.backup, "not-available");
  check("un outil hors Metabase est retenu par sa variable", generatedApps[2]?.tool, { env: "GRAFANA_VERSION", version: "11.2.0" });

  const schemaLine = new RegExp(
    `^# yaml-language-server: \\$schema=https://raw\\.githubusercontent\\.com/[^/]+/[^/]+/v${JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version.replace(/\./g, "\\.")}/(.+)$`,
  ).exec(generated.src.split("\n")[0]);
  check(
    "la ligne $schema vise le schema du moteur, au tag de sa version",
    [Boolean(schemaLine), schemaLine ? existsSync(join(import.meta.dirname, "..", schemaLine[1])) : false],
    [true, true],
  );

  check("une version flottante est ecartee", /gamma-metabase : METABASE_VERSION="latest"/.test(init.output), true);
  check("une app sans depot lie est ecartee", /delta-metabase : aucun depot lie/.test(init.output), true);
  check("un git_ref qui n'est pas un sha est ecarte", /epsilon-metabase : git_ref "master"/.test(init.output), true);
  check("une app sans outil connu n'est pas citee", init.output.includes("site-vitrine"), false);
  check("aucun secret ne sort, ni a l'ecran ni dans le manifeste", [init.output.includes(SECRET), generated.src.includes(SECRET)], [false, false]);

  const readOnly = [
    /^(GET|HEAD) /,
    /^POST https:\/\/auth\.scalingo\.com\/v1\/tokens\/exchange$/,
    /^POST https:\/\/api\.[^/]+\/v1\/apps\/[^/]+\/addons\/[^/]+\/token$/,
  ];
  check("init ne fait que lire", init.calls.filter((l) => !readOnly.some((re) => re.test(l))), []);
  check("init n'ecrit que le manifeste", [listDir(fresh.cwd), listDir(join(fresh.root, "neuf"))], [[], ["manifest.yaml"]]);
  check(
    "la commande suivante amorce le lock du manifeste ecrit, sans la lancer",
    /\n {2}node \S+\/src\/apply\.ts --adopt --manifest \S+\/neuf\/manifest\.yaml --lock \S+\/neuf\/lock\.json\n/.test(init.output),
    true,
  );

  // Les annotations sont relues par les expressions memes de la configuration
  // Renovate : une annotation de forme approchante passerait le schema et
  // --validate, et Renovate ne la verrait pas.
  type CustomManager = { managerFilePatterns?: string[]; matchStrings?: string[] };
  const managers = ["renovate/base.json", "renovate.json"]
    .map((f) => join(import.meta.dirname, "..", f))
    .filter((f) => existsSync(f))
    .flatMap((f) => (JSON.parse(readFileSync(f, "utf8")).customManagers ?? []) as CustomManager[])
    .filter((m) => m.matchStrings?.some((s) => s.startsWith("- app: ")));
  const patterns = [...new Set(managers.flatMap((m) => m.matchStrings ?? []))];
  const shaPattern = patterns.find((s) => s.includes("currentDigest"));
  const versionPattern = patterns.find((s) => !s.includes("currentDigest"));
  const groupsOf = (pattern: string | undefined) =>
    pattern ? [...generated.src.matchAll(new RegExp(pattern, "g"))].map((m) => m.groups ?? {}) : [];
  check("la configuration Renovate lit le sha et la version", [Boolean(shaPattern), Boolean(versionPattern)], [true, true]);
  check(
    "chaque sha genere est lu par Renovate",
    groupsOf(shaPattern).map((g) => [g.depName, g.datasource, g.repo, g.currentValue, g.currentDigest]),
    generatedApps.map((a) => [a.app, "git-refs", a.source.repo, a.source.branch, a.source.sha]),
  );
  check(
    "chaque version generee est lue par Renovate, avec l'amont de l'outil",
    groupsOf(versionPattern).map((g) => [g.depName, g.datasource, g.packageName, g.currentValue]),
    generatedApps.map((a) => [a.app, "github-releases", upstreamOf(a.tool)?.repo, a.tool.version]),
  );
  const filePatterns = managers.flatMap((m) => m.managerFilePatterns ?? []);
  check(
    "le nom de fichier par defaut est celui que Renovate lit",
    filePatterns.length > 0 && filePatterns.every((p) => new RegExp(p.replace(/^\/|\/$/g, "")).test("manifest.yaml")),
    true,
  );

  const numericSrc = renderManifest(
    [
      {
        app: "grafana-interne",
        region: "osc-fr1",
        source: { repo: "exemple/grafana-scalingo", branch: "2024", sha: "e".repeat(40) },
        tool: { env: "GRAFANA_VERSION", version: "11.2", upstream: "grafana/grafana" },
      },
    ],
    "x",
  );
  const numeric = parse(numericSrc) as { apps: GeneratedApp[] };
  check(
    "une version ou une branche qui se lirait comme un nombre reste une chaine",
    [numeric.apps[0].tool.version, numeric.apps[0].source.branch, validate(numeric)],
    ["11.2", "2024", true],
  );
  const quotedGroups = (pattern: string | undefined) =>
    pattern ? [...numericSrc.matchAll(new RegExp(pattern, "g"))].map((m) => m.groups?.currentValue) : [];
  check(
    "Renovate lit la version et la branche quotees sans leurs guillemets",
    [quotedGroups(shaPattern), quotedGroups(versionPattern)],
    [["2024"], ["11.2"]],
  );

  const validated = run(fresh, "apply.ts", ["--validate", ...NEW_FLEET]);
  check("--validate accepte le manifeste genere, annotations comprises", [validated.status, /valide : 4 app\(s\)/.test(validated.output)], [0, true]);

  const schemaOf = (src: string) => /^# yaml-language-server: \$schema=(\S+)$/m.exec(src)?.[1];
  const untagged = sandbox();
  const untaggedRun = run(untagged, "init.ts", [...REGIONS, ...NEW_FLEET], { ...TOKEN, SCHEMA_TAG_MISSING: "1" }, INIT_FETCH);
  check(
    "sans tag publie, le $schema retombe sur main et init le dit",
    [untaggedRun.status, /\/main\/schema\/manifest\.schema\.json$/.test(schemaOf(readGenerated(untagged).src) ?? ""), /a epingler sur un tag/.test(untaggedRun.output)],
    [0, true, true],
  );

  const again = run(fresh, "init.ts", [...REGIONS, ...NEW_FLEET], TOKEN, INIT_FETCH);
  check(
    "un manifeste existant n'est pas ecrase, et rien n'est appele",
    [again.status, readGenerated(fresh).src === generated.src, again.calls],
    [1, true, []],
  );
  const filtered = run(fresh, "init.ts", [...REGIONS, ...NEW_FLEET, "--app", "alpha", "--force"], TOKEN, INIT_FETCH);
  check(
    "--force l'ecrase, --app filtre les apps sur leur nom",
    [filtered.status, readGenerated(fresh).manifest?.apps.map(appKey)],
    [0, ["osc-fr1/alpha-metabase"]],
  );

  const noRegionInit = run(sandbox(), "init.ts", NEW_FLEET, TOKEN, INIT_FETCH);
  check("sans --region, init s'arrete avant tout appel", [noRegionInit.status, /--region/.test(noRegionInit.output), noRegionInit.calls], [1, true, []]);
  const noAccess = run(sandbox(), "init.ts", [...REGIONS, ...NEW_FLEET], {}, INIT_FETCH);
  check("sans acces, init s'arrete avant tout appel", [noAccess.status, /Aucun acces configure/.test(noAccess.output), noAccess.calls], [1, true, []]);
  const down = sandbox();
  const downRun = run(down, "init.ts", [...REGIONS, ...NEW_FLEET], { ...TOKEN, OUTAGE: "1" }, INIT_FETCH);
  check("une region illisible fait echouer init sans rien ecrire", [downRun.status, listDir(join(down.root, "neuf"))], [1, null]);

  const viaProxy = sandbox();
  const proxied = run(viaProxy, "init.ts", [...REGIONS, ...NEW_FLEET, "--fgp", join(FIXTURES, "fgp.json")], { FGP_KEY: "cle-factice-des-tests" }, INIT_FETCH);
  const scalingoCalls = (calls: string[]) => calls.filter((l) => !l.includes("://raw.githubusercontent.com/"));
  check("derriere le proxy, chaque appel a Scalingo part vers lui", [proxied.status, allCallsTo(scalingoCalls(proxied.calls), "https://fgp.exemple.test")], [0, true]);
  check(
    "derriere le proxy, une base ne se lit qu'avec le blob de sauvegarde de son app",
    (readGenerated(viaProxy).manifest?.apps ?? []).map((a) => [a.app, a.database?.version ?? null]),
    [["alpha-metabase", "16.15.0-1"], ["beta-metabase", null], ["grafana-interne", null], ["zeta-metabase", null]],
  );
  check("et la commande suivante reprend --fgp", /--adopt .* --fgp \S+fgp\.json\n/.test(proxied.output), true);
} finally {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
}

console.log(
  `\n${passed} verification(s) passee(s), ${failures} echec(s).\n`,
);
process.exit(failures > 0 ? 1 : 0);
