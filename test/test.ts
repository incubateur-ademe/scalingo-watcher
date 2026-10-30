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
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse, parseDocument } from "yaml";
import {
  backupAddon,
  describeProposal,
  describeTools,
  loadLock,
  pinnedVersion,
  policyReadByRenovate,
  readManifest,
  RENAMED_FIELDS,
  resolveAliases,
  targetGoesBack,
  targetReached,
  writeOptions,
} from "../src/apply.ts";
import { upstreamKey, upstreamsDeclared } from "../src/audit.ts";
import { renderManifest } from "../src/init.ts";
import { compose, matrixPayload, slackPayload, teamsPayload } from "../src/notify.ts";
import { apiScopes, backupScopes, deniedByProxy } from "../src/fgp-scopes.ts";
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
check("req expose le corps d'un refus", /\{ status: res\.status, body\b/.test(apply), true);

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
  const notify = join(SRC, "notify.ts");
  await new Promise<void>((done, fail) =>
    execFile(process.execPath, [notify], {
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

{
  const read = (text: string) => () => text;
  const env = { REPO_URL: "https://github.com/o/r", RUN_URL: "https://github.com/o/r/actions/runs/1", ISSUE: "4" };
  check(
    "un suivi ouvert sur un parc sain le dit",
    compose({ ...env, STATE: "opened", REPORT: "x" }, read("## Metabase\n\n<!-- etat: sain -->\n")).detail,
    "Rien a signaler sur le parc.",
  );
  check(
    "un retour a la normale le dit sans lire le rapport",
    compose({ ...env, STATE: "resolved" }, () => { throw new Error("rapport lu"); }).detail,
    "Plus rien a signaler sur le parc.",
  );
  check("sans numero d'issue, seul le lien d'execution reste", compose({ ...env, ISSUE: "", STATE: "resolved" }, read("")).links.map((l) => l.label), ["Execution"]);
  const m = compose({ ...env, STATE: "changed", REPORT: "x" }, read("<!-- etat: intervention -->\n- **a** : <b>echec</b> & \"x\""));
  check("la carte Teams est une carte adaptative avec ses liens", [teamsPayload(m).attachments[0].contentType, teamsPayload(m).attachments[0].content.actions.length], ["application/vnd.microsoft.card.adaptive", 2]);
  check("le message Matrix echappe le HTML du rapport", matrixPayload(m).formatted_body.includes("&lt;b&gt;echec&lt;/b&gt; &amp; &quot;x&quot;"), true);
  check("le message Slack porte le titre et les URL nues", slackPayload(m).text.split("\n").filter((l) => l.startsWith("*") || l.includes(" : https://")).length, 3);
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

console.log("\nPresets Renovate");

// Renovate relit le manifeste et la documentation par les expressions des
// presets, sans rien signaler quand elles ne trouvent rien. Les tests les
// rejouent : `recursive` applique chaque expression aux correspondances de la
// precedente et cumule les groupes nommes, que les templates peuvent citer.
type CustomManager = { managerFilePatterns?: string[]; matchStrings?: string[]; matchStringsStrategy?: string; depTypeTemplate?: string };
type PackageRule = Record<string, unknown>;
const preset = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "..", "renovate", `${name}.json`), "utf8")) as {
    customManagers?: CustomManager[];
    packageRules?: PackageRule[];
  };
const regexOf = (pattern: string) => new RegExp(pattern.replace(/^\/|\/$/g, ""));
function extract(manager: CustomManager | undefined, src: string): Record<string, string>[] {
  if (!manager) return [];
  const matches = (pattern: string, text: string) =>
    [...text.matchAll(new RegExp(pattern, "g"))].map((m) => ({
      text: m[0],
      groups: Object.fromEntries(Object.entries(m.groups ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>,
    }));
  const patterns = manager.matchStrings ?? [];
  const found =
    manager.matchStringsStrategy === "recursive"
      ? patterns.reduce(
          (layer, pattern) => layer.flatMap((f) => matches(pattern, f.text).map((m) => ({ text: m.text, groups: { ...f.groups, ...m.groups } }))),
          [{ text: src, groups: {} as Record<string, string> }],
        )
      : patterns.flatMap((pattern) => matches(pattern, src));
  const template = manager.depTypeTemplate;
  return found.map(({ groups }) => (template ? { ...groups, depType: template.replace(/\{\{\{(\w+)\}\}\}/g, (_, k: string) => groups[k] ?? "") } : groups));
}
// Les packageRules s'appliquent dans l'ordre et la derniere qui correspond
// l'emporte. Un critere que cette emulation ne connait pas la ferait mentir.
const MATCHERS: Record<string, string> = {
  matchManagers: "manager",
  matchPackageNames: "packageName",
  matchDatasources: "datasource",
  matchUpdateTypes: "updateType",
  matchDepTypes: "depType",
};
function ruleValue(rules: readonly PackageRule[], dep: Record<string, string>, key: string): unknown {
  let value: unknown;
  for (const rule of rules) {
    const unknown = Object.keys(rule).filter((k) => k.startsWith("match") && !(k in MATCHERS));
    if (unknown.length) throw new Error(`critere de packageRule non emule : ${unknown.join(", ")}`);
    const fits = Object.entries(MATCHERS).every(([k, field]) => {
      const patterns = rule[k] as string[] | undefined;
      return !patterns || patterns.some((p) => (p.startsWith("/") ? regexOf(p).test(dep[field]) : p === dep[field]));
    });
    if (fits && key in rule) value = rule[key];
  }
  return value;
}
const RULES = ["base", "metabase", "watcher"].flatMap((name) => preset(name).packageRules ?? []);
const TOOL_VERSIONS = preset("base").customManagers?.find((m) => m.matchStringsStrategy === "recursive");
const CITED_VERSIONS = preset("watcher").customManagers?.find((m) => m.depTypeTemplate === "documentation");
{
  const src = readFileSync(join(FIXTURES, "manifest.yaml"), "utf8");
  const block = "  policy:\n    minor: auto\n    major: pr\n";
  const depTypes = (manifest: string) => [extract(TOOL_VERSIONS, manifest).length, [...new Set(extract(TOOL_VERSIONS, manifest).map((g) => g.depType))]];
  check("Renovate porte la politique du manifeste dans le depType de chaque version d'outil", depTypes(src), [4, ["outil minor=auto major=pr"]]);
  check(
    "la politique se relit dans n'importe quel ordre, quotee et commentee",
    depTypes(src.replace(block, "  policy: # relue par Renovate\n    # montees fonctionnelles\n    major: \"auto\"  # a surveiller\n\n    minor: 'pr'\n")),
    [4, ["outil minor=pr major=auto"]],
  );
  check("sans politique, les versions restent suivies et le depType le dit", depTypes(src.replace(block, "")), [4, ["outil minor= major="]]);
  check(
    "la politique se relit aussi en fins de ligne CRLF",
    [depTypes(src.replace(/\n/g, "\r\n")), policyReadByRenovate(src.replace(/\n/g, "\r\n"))],
    [[4, ["outil minor=auto major=pr"]], { minor: "auto", major: "pr" }],
  );
  check(
    "database.major n'est pas pris pour la politique",
    depTypes(src.replace("    major: pr\n", "").replace("      version: 16.15.0-1\n", "      version: 16.15.0-1\n      major: allowed\n")),
    [4, ["outil minor=auto major="]],
  );
  check(
    "une politique en style flow n'est pas relue, --validate le signale",
    [depTypes(src.replace(block, "  policy: { minor: pr, major: auto }\n")), policyReadByRenovate(src.replace(block, "  policy: { minor: pr, major: auto }\n"))],
    [[4, ["outil minor= major="]], { minor: undefined, major: undefined }],
  );

  const metabaseVia = (policy: string, datasource: string) =>
    ["patch", "minor", "major"].map((updateType) =>
      ruleValue(RULES, { manager: "custom.regex", packageName: "metabase/metabase", datasource, depType: `outil ${policy}`, updateType }, "automerge"),
    );
  const metabase = (policy: string) => metabaseVia(policy, "github-tags");
  check(
    "la politique decide de l'automerge des versions de Metabase, correctifs seuls par defaut",
    ["minor= major=", "minor=auto major=pr", "minor=pr major=pr", "minor=auto major=auto", "minor=pr major=auto"].map((p) => [p, metabase(p)]),
    [
      ["minor= major=", [true, true, false]],
      ["minor=auto major=pr", [true, true, false]],
      ["minor=pr major=pr", [false, false, false]],
      ["minor=auto major=auto", [true, true, true]],
      ["minor=pr major=auto", [false, false, true]],
    ],
  );

  // Les regles de Metabase ne filtrent plus la datasource : un parc dont le
  // manifeste porte encore `github-releases` garde sa politique apres la bascule.
  check(
    "la politique de Metabase ne depend pas de la source des versions",
    ["github-tags", "github-releases"].map((d) => metabaseVia("minor=auto major=pr", d)),
    [
      [true, true, false],
      [true, true, false],
    ],
  );

  const watcher = (manager: string, datasource: string, depType: string) =>
    ["minor", "major"].map((updateType) =>
      ["automerge", "groupName"].map((key) =>
        ruleValue(RULES, { manager, packageName: "incubateur-ademe/scalingo-watcher", datasource, depType, updateType }, key),
      ),
    );
  check(
    "une version de scalingo-watcher arrive dans la PR de l'outil, jamais fusionnee seule",
    [watcher("github-actions", "github-tags", "action"), watcher("renovate-config", "github-tags", ""), watcher("custom.regex", "github-tags", "documentation")],
    Array(3).fill(Array(2).fill([false, "scalingo-watcher"])),
  );
  check(
    "Renovate suit les versions de l'outil citees hors des workflows et des presets",
    [
      "git clone --depth 1 --branch v1.2.3 https://github.com/incubateur-ademe/scalingo-watcher .scalingo-watcher",
      "  dans [fgp.md](https://github.com/incubateur-ademe/scalingo-watcher/blob/v1.2.3/fgp.md).",
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/incubateur-ademe/scalingo-watcher/v1.2.3/schema/manifest.schema.json",
    ].map((line) => extract(CITED_VERSIONS, line).map((g) => g.currentValue)),
    [["v1.2.3"], ["v1.2.3"], ["v1.2.3"]],
  );
  check(
    "dans la documentation et le manifeste, pas ailleurs",
    ["README.md", "docs/installation.md", "manifest.yaml", "lock.json"].map((f) => (CITED_VERSIONS?.managerFilePatterns ?? []).some((p) => regexOf(p).test(f))),
    [true, true, true, false],
  );
}

console.log("\nStarter : appelants, versions citees, managers");

// Le job appele ne lit la valeur d'un secret de l'environment que si
// l'appelant lui passe ce secret : non mappe, FGP_KEY arrivait vide et le parc
// tournait sans acces, en vert. Le starter vit dans son propre depot, tenu a
// jour par Renovate : la CI le recupere dans STARTER_DIR. Chaque appelant est
// confronte au workflow de la version qu'il epingle. Les secrets que la version
// en cours ajoute ne sont qu'annonces : le starter ne pourra les mapper qu'une
// fois cette version publiee.
{
  const ROOT_DIR = join(import.meta.dirname, "..");
  const starter = process.env.STARTER_DIR ?? join(ROOT_DIR, ".starter");
  const callersDir = join(starter, ".github", "workflows");
  type Workflow = { on?: { workflow_call?: { secrets?: Record<string, unknown> } }; jobs: Record<string, { uses?: string; secrets?: unknown }> };
  const declaredAt = (ref: string, name: string) => {
    const src = execFileSync("git", ["show", `${ref}:.github/workflows/${name}`], { cwd: ROOT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return Object.keys((parse(src) as Workflow).on?.workflow_call?.secrets ?? {});
  };
  if (!existsSync(callersDir)) {
    if (process.env.CI) check("le starter est recupere pour controler ses appelants", callersDir, "present");
    else console.log(`  (starter absent de ${callersDir} : cloner incubateur-ademe/scalingo-parc-template dans .starter pour ce controle)`);
  } else {
    const gaps: string[] = [];
    const upcoming: string[] = [];
    let callers = 0;
    for (const file of readdirSync(callersDir).filter((f) => f.endsWith(".yml"))) {
      const caller = parse(readFileSync(join(callersDir, file), "utf8")) as Workflow;
      for (const job of Object.values(caller.jobs)) {
        const m = /^incubateur-ademe\/scalingo-watcher\/\.github\/workflows\/([^@]+)@(\S+)$/.exec(job.uses ?? "");
        if (!m) continue;
        callers++;
        const [, name, ref] = m;
        const mapped = job.secrets === "inherit" ? null : job.secrets && typeof job.secrets === "object" ? Object.keys(job.secrets) : [];
        const missing = (secrets: string[]) => (mapped === null ? [] : secrets.filter((x) => !mapped.includes(x)));
        try {
          gaps.push(...missing(declaredAt(ref, name)).map((x) => `${file} (${ref.slice(0, 12)}) : ${x}`));
        } catch {
          gaps.push(`${file} : ${ref} introuvable dans ce depot, faire git fetch --tags`);
        }
        upcoming.push(...missing(declaredAt("HEAD", name)).map((x) => `${file} : ${x}`));
      }
    }
    check("le starter appelle les workflows de l'outil", callers, 4);
    // Hors des appelants et de renovate.json, une version de l'outil n'avance
    // que par le manager de watcher.json : sans lui, le README faisait cloner
    // une version plus ancienne que celle de la CI du parc.
    const unfollowed = (readdirSync(starter, { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => !/^(\.git|\.github[/\\]workflows)([/\\]|$)/.test(f) && f !== "renovate.json" && statSync(join(starter, f)).isFile())
      .flatMap((f) => {
        const followed = (CITED_VERSIONS?.managerFilePatterns ?? []).some((p) => regexOf(p).test(f));
        return readFileSync(join(starter, f), "utf8")
          .split("\n")
          .flatMap((line, i) => {
            if (!line.includes("scalingo-watcher")) return [];
            const cited = line.match(/\bv\d+\.\d+\.\d+\b/g)?.length ?? 0;
            return cited > (followed ? extract(CITED_VERSIONS, line).length : 0) ? [`${f}:${i + 1}`] : [];
          });
      });
    check("chaque version de l'outil citee par le starter est suivie par Renovate", unfollowed, []);

    // Un manager recopie dans le starter pour devancer une release fait
    // extraire chaque version deux fois une fois le preset monte a cette
    // release : il doit partir dans la PR de montee.
    const starterConfig = join(starter, "renovate.json");
    if (existsSync(starterConfig)) {
      const config = JSON.parse(readFileSync(starterConfig, "utf8")) as { extends?: string[]; customManagers?: CustomManager[] };
      const local = (config.customManagers ?? []).flatMap((m) => m.matchStrings ?? []);
      const watcherRef = (config.extends ?? []).map((e) => /^github>incubateur-ademe\/scalingo-watcher\/\/renovate\/watcher#(\S+)$/.exec(e)?.[1]).find(Boolean);
      const carriedAt = (ref: string) => {
        const src = execFileSync("git", ["show", `${ref}:renovate/watcher.json`], { cwd: ROOT_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        const carried = new Set(((JSON.parse(src) as { customManagers?: CustomManager[] }).customManagers ?? []).flatMap((m) => m.matchStrings ?? []));
        return local.filter((s) => carried.has(s));
      };
      let doubled: string[];
      try {
        doubled = watcherRef ? carriedAt(watcherRef).map((s) => `renovate.json (watcher#${watcherRef}) : ${s}`) : [];
      } catch {
        doubled = [`renovate.json : watcher#${watcherRef} introuvable dans ce depot, faire git fetch --tags`];
      }
      check("le starter ne recopie aucun manager deja porte par le preset watcher qu'il epingle", doubled, []);
      if (!doubled.length && carriedAt("HEAD").length) {
        console.log("::warning::manager recopie dans le renovate.json du starter : a retirer, avec sa packageRule, a la montee vers la prochaine release");
      }
    }
    check("chaque appelant du starter mappe les secrets du workflow qu'il epingle", gaps, []);
    for (const u of upcoming) console.log(`::warning::secret a mapper dans le starter a la prochaine release : ${u}`);
  }
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

const branchOk = template();
(branchOk.apps[0].source as { branch: string }).branch = "feature/oauth2-proxy_v2";
check("une branche a slash, tiret, point et souligne est acceptee", validate(branchOk), true);
for (const bad of ["../../user", "a..b", "x?y=1", "x#y", "/x", "x/"]) {
  const badBranch = template();
  (badBranch.apps[0].source as { branch: string }).branch = bad;
  check(`la branche ${JSON.stringify(bad)}, qui sortirait du chemin d'API, est refusee`, validate(badBranch), false);
}

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

// Le gabarit ne declare aucune fenetre : le champ est facultatif, et c'est le
// moteur, non le schema, qui porte le defaut. Ajv ne compile pas `useDefaults`,
// donc le mot-cle `default` du schema n'est que de la documentation.
check("un manifeste sans fenetre de garde reste valide", validate(fixture), true);

const settleOff = template();
settleOff.apps[0].settle = { window: 0 };
check("une fenetre nulle est acceptee, c'est l'extinction", validate(settleOff), true);

const settleEmpty = template();
settleEmpty.apps[0].settle = {};
check("une fenetre sans duree est refusee", validate(settleEmpty), false);

// Une valeur donnee en millisecondes figerait la vague des heures sous le
// verrou que la reconciliation suivante attend.
const settleMs = template();
settleMs.apps[0].settle = { window: 180000 };
check("une duree donnee en millisecondes est refusee", validate(settleMs), false);

const settleUnknownField = template();
settleUnknownField.apps[0].settle = { window: 180, marker: "COMPLETE" };
check("un champ inconnu dans settle est refuse", validate(settleUnknownField), false);

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
check("une version epinglee se compare aux failles", pinnedVersion("v0.63.16.7"), [0, 63, 16, 7]);
check("un alias .x ne se lit pas comme x.y.0", pinnedVersion("v0.63.x"), null);
check("un alias X majuscule non plus", pinnedVersion("v1.X"), null);
check("un alias * non plus", pinnedVersion("0.63.*"), null);
check("v0.63 et v1.52 sont sur deux lignes", compareLines([0, 63, 18], [1, 52, 2], 1) < 0, true);
check("v0.63 et v0.64 sont sur la meme ligne", compareLines([0, 63, 18], [0, 64, 0], 1), 0);
check("une ligne de deux composants separe 0.63 de 0.64", compareLines([0, 63, 18], [0, 64, 0], 2) < 0, true);

console.log("\nCible atteinte");

// Le couple version-commit correspond aussi apres un echec : la variable porte
// deja la nouvelle valeur, que l'outil ne remet pas, et le deploiement rate a
// pour git_ref le commit de la cible. Sans la preuve d'un deploiement reussi,
// le releve levait la quarantaine et la cible repartait toutes les heures.
{
  const CIBLE = { sha: "a".repeat(40), version: "v0.63.18" };
  const releve = (status: string | null) => ({
    source: { repo: "exemple/metabase-scalingo", sha: CIBLE.sha },
    tool: { env: "METABASE_VERSION", version: CIBLE.version },
    deployment: status ? { id: "dep-1", status, at: "2026-10-30T10:00:00.000Z" } : null,
  });
  check("un deploiement reussi sur la cible l'atteint", targetReached(releve("success"), CIBLE), true);
  check("un deploiement rate ne l'atteint pas", targetReached(releve("build-error"), CIBLE), false);
  check("aucun deploiement connu ne l'atteint pas", targetReached(releve(null), CIBLE), false);
  check(
    "un deploiement reussi sur une autre version ne l'atteint pas",
    targetReached(releve("success"), { ...CIBLE, version: "v0.64.4.2" }),
    false,
  );
}

console.log("\nSens de l'ecart avec le manifeste");

{
  check("une cible anterieure recule", targetGoesBack("v0.64.4.2", "v0.63.18"), true);
  check("une cible posterieure non", targetGoesBack("v0.63.18", "v0.64.4.2"), false);
  check("une cible identique non", targetGoesBack("v0.63.18", "v0.63.18"), false);
  check("un correctif anterieur recule", targetGoesBack("v0.63.18", "v0.63.15"), true);
  // Lue comme 0.63.0, une version glissante passerait pour une descente face a
  // n'importe quel correctif de sa ligne.
  check("une cible glissante ne tranche pas", targetGoesBack("v0.63.18", "v0.63.x"), false);
  check("une version servie glissante non plus", targetGoesBack("v0.63.x", "v0.63.18"), false);
  check("une app sans variable de version ne tranche pas", targetGoesBack(null, "v0.63.18"), false);
  // Ecarter les lignes entre elles inversait les risques : la descente de
  // majeure, la plus destructrice, passait quand un correctif anterieur etait
  // refuse. Chez Metabase, la ligne est l'edition, et en descendre merite la
  // meme decision explicite.
  check("une descente de majeure recule", targetGoesBack("12.1.0", "11.6.3"), true);
  check("une montee de majeure non", targetGoesBack("1.27.4", "2.0.0"), false);
  check("l'Enterprise vers l'OSS recule", targetGoesBack("v1.52.2", "v0.64.4.2"), true);
  // Rien n'est compare au-dela des composants numeriques de tete : le filet a
  // ce trou, et la docstring le dit plutot que de le laisser surprendre.
  check("un suffixe non numerique n'est pas vu", targetGoesBack("1.27.4-2", "1.27.4-1"), false);
}

console.log("\nScopes des blobs du proxy");

{
  const scopes = apiScopes([{ app: "beta" }, { app: "alpha", paused: true }]);
  const methodsOf = (s: string) => s.slice(0, s.indexOf(":")).split("|");
  const pathOf = (s: string) => s.slice(s.indexOf(":") + 1);
  const about = (app: string) => scopes.filter((s) => pathOf(s).startsWith(`/v1/apps/${app}`));
  const writes = (list: string[]) => list.filter((s) => methodsOf(s).some((m) => m !== "GET"));

  check("une app normale peut deployer et poser ses variables", writes(about("beta")), [
    "GET|POST:/v1/apps/beta/variables",
    "PATCH:/v1/apps/beta/variables/*",
    "GET|POST:/v1/apps/beta/deployments",
  ]);
  check("une app en pause n'a que des GET", [about("alpha").length > 0, writes(about("alpha"))], [true, []]);
  check(
    "chaque route d'app nomme son app, aucun joker a la place du nom",
    scopes.filter((s) => pathOf(s).startsWith("/v1/apps/") && !/^\/v1\/apps\/(alpha|beta)(\/|$)/.test(pathOf(s))),
    [],
  );
  check("hors des apps, seules deux lectures globales", scopes.filter((s) => !pathOf(s).startsWith("/v1/apps/")), [
    "GET:/v1/apps",
    "GET:/v1/features/stacks",
  ]);
  check("aucun DELETE", scopes.filter((s) => methodsOf(s).includes("DELETE")), []);
  check(
    "les scopes ne dependent pas de l'ordre du manifeste",
    apiScopes([{ app: "alpha", paused: true }, { app: "beta" }]),
    scopes,
  );
  check("une base en pause est en lecture seule", writes(backupScopes(true)), []);
  check("une base active garde sauvegarde et montee de version", writes(backupScopes(false)), [
    "GET|POST:/api/databases/*/backups",
    "POST:/api/databases/*/upgrade",
  ]);

  const answer = (status: number, source: string | null, body: unknown) =>
    deniedByProxy(new Response(null, { status, headers: source ? { "X-FGP-Source": source } : {} }), JSON.stringify(body));
  check("un scope_denied du proxy est reconnu", answer(403, "proxy", { error: "scope_denied" }), true);
  check("un 403 de Scalingo n'est pas un refus du proxy", answer(403, "upstream", { error: "scope_denied" }), false);
  check("un autre refus du proxy non plus", answer(403, "proxy", { error: "target_forbidden" }), false);
}

console.log("\nChemins des donnees et des sorties");

check("par defaut, le parc se lit dans le repertoire courant", resolvePaths([], {}, "/parc"), {
  manifest: "/parc/manifest.yaml",
  lock: "/parc/lock.json",
  fgp: "/parc/fgp.json",
  outDir: "",
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
{
  // Un nom fixe sous /tmp laissait un autre compte de la machine y poser un lien
  // et detourner les ecritures.
  const paths = resolvePaths([], {}, "/parc");
  const printed: string[] = [];
  const consoleLog = console.log;
  console.log = (...a: unknown[]) => void printed.push(a.join(" "));
  let first: string, second: string;
  try {
    first = outFile(paths, "incident.md");
    second = outFile(paths, "pr-body.md");
  } finally {
    console.log = consoleLog;
  }
  const dir = paths.outDir;
  check("le repertoire prive est affiche une fois, a sa creation", printed, [`Sorties de ce passage dans ${dir}`]);
  check(
    "sans --out-dir ni RUNNER_TEMP, les sorties vont dans un repertoire prive cree une fois",
    [dir.startsWith(join(tmpdir(), "scalingo-watcher-")), dir !== join(tmpdir(), "scalingo-watcher"), statSync(dir).mode & 0o077, [first, second].map((f) => join(dir, basename(f)) === f)],
    [true, true, 0, [true, true]],
  );
  rmSync(dir, { recursive: true, force: true });
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
  // Renovate ne relit la politique qu'ecrite en bloc : en flow, l'automerge
  // retombait sur son defaut sans que rien ne le dise.
  check(
    "une politique que Renovate ne relit pas est refusee",
    validateVariant("flow", fixtureSrc.replace("  policy:\n    minor: auto\n    major: pr\n", "  policy: { minor: pr, major: pr }\n")),
    [
      "flow",
      1,
      [
        "defaults.policy.minor vaut pr, Renovate lit rien : l'ecrire en bloc, une cle par ligne sous policy:",
        "defaults.policy.major vaut pr, Renovate lit rien : l'ecrire en bloc, une cle par ligne sous policy:",
      ],
    ],
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

  const scoped = sandbox();
  const requests = join(scoped.root, "generate.jsonl");
  const scopedRun = run(scoped, "fgp-blobs.ts", ["--manifest", "../parc/manifest.yaml", "--fgp", "../parc/fgp.json", "--out-dir", "../sortie"], {
    ...BLOBS_ENV,
    GENERATED: requests,
  });
  const sent = new Map(
    readFileSync(requests, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { name: string; scopes: string[] })
      .map((r) => [r.name, r.scopes]),
  );
  const appsNamed = (scopes: string[] = []) =>
    [...new Set(scopes.flatMap((s) => /:\/v1\/apps\/([^/]+)/.exec(s)?.slice(1) ?? []))].sort();
  check(
    "fgp-blobs ne nomme dans chaque blob d'API que les apps du manifeste de sa region",
    [scopedRun.status, appsNamed(sent.get("api osc-fr1")), appsNamed(sent.get("api osc-secnum-fr1"))],
    [0, ["alpha-metabase", "beta-metabase"], ["delta-metabase", "gamma-metabase"]],
  );
  check(
    "l'app en pause du manifeste n'a que des lectures, son blob de base aussi",
    [
      (sent.get("api osc-fr1") ?? []).filter((s) => s.includes("/beta-metabase") && !s.startsWith("GET:")),
      sent.has("sauvegarde beta-metabase"),
      (sent.get("sauvegarde beta-metabase") ?? []).filter((s) => !s.startsWith("GET:")),
    ],
    [[], true, []],
  );
  check(
    "les autres apps gardent l'ecriture sur leur nom seul",
    (sent.get("api osc-fr1") ?? []).filter((s) => !s.startsWith("GET:")),
    ["GET|POST:/v1/apps/alpha-metabase/variables", "PATCH:/v1/apps/alpha-metabase/variables/*", "GET|POST:/v1/apps/alpha-metabase/deployments"],
  );

  const denied = sandbox();
  const deniedEnv = { FGP_KEY: "cle-factice-des-tests", DENIED: "1" };
  const deniedPlan = run(denied, "apply.ts", ["--dry-run", ...FLEET, "--fgp", join(FIXTURES, "fgp.json"), "--out-dir", "../sortie"], deniedEnv);
  check(
    "un refus de scope du proxy pointe la regeneration de fgp.json",
    /refus du proxy sur GET \S+\/v1\/apps\/alpha-metabase : appel hors des scopes de fgp\.json, a regenerer avec fgp-blobs\.ts/.test(deniedPlan.output),
    true,
  );
  const deniedAudit = run(denied, "audit.ts", ["--fgp", join(FIXTURES, "fgp.json"), "--manifest", "../parc/manifest.yaml"], deniedEnv);
  check(
    "l'audit ignore les apps hors manifeste que le proxy refuse, et signale celles du manifeste",
    [
      deniedAudit.status,
      deniedAudit.output.includes("3 app(s) hors du manifeste"),
      /alpha-metabase.*hors des scopes de fgp\.json/.test(deniedAudit.output),
    ],
    [0, true, true],
  );

  console.log("\nApp en pause : lue, jamais ecrite, contre un fetch simule");

  // beta-metabase est en pause dans le parc de test, et son lock la dit conforme.
  // Sur Scalingo, elle tourne autre chose : son proprietaire l'a deployee.
  const PAUSED = "osc-fr1/beta-metabase";
  const REAL_STATE = ["v0.63.20", "c".repeat(40)];
  const WITH_ACCESS = { SCALINGO_API_TOKEN: "faux", REAL: JSON.stringify({ [PAUSED]: { version: REAL_STATE[0], sha: REAL_STATE[1] } }) };
  // L'echange du jeton de compte et le jeton d'addon qui ouvre la lecture
  // d'une base passent par un POST, sans rien ecrire.
  const readOnlyCalls = [
    /^(GET|HEAD) /,
    /^POST https:\/\/auth\.scalingo\.com\/v1\/tokens\/exchange$/,
    /^POST https:\/\/api\.[^/]+\/v1\/apps\/[^/]+\/addons\/[^/]+\/token$/,
  ];
  const writeCalls = (calls: string[]) => calls.filter((l) => !readOnlyCalls.some((re) => re.test(l)));
  const pausedEntry = (b: Sandbox) => {
    const e = loadLock(join(b.fleet, "lock.json")).apps[PAUSED];
    return [e.tool.version, e.source.sha];
  };
  const othersOf = (lockSrc: string) => {
    const { apps } = JSON.parse(lockSrc) as { apps: Record<string, unknown> };
    delete apps[PAUSED];
    return apps;
  };
  const BETA = "https://api.osc-fr1.scalingo.com/v1/apps/beta-metabase";

  const applied = sandbox();
  const applyRun = run(applied, "apply.ts", [...FLEET, "--out-dir", "../sortie"], WITH_ACCESS);
  if (applyRun.status !== 0) console.log(applyRun.output);
  check(
    "une app en pause est relevee : variable, deploiement et base",
    [
      applyRun.status,
      applyRun.calls.includes(`GET ${BETA}/variables`),
      applyRun.calls.includes(`GET ${BETA}/deployments?per_page=1`),
      applyRun.calls.includes("GET https://db-api.osc-fr1.scalingo.com/api/databases/osc-fr1~beta-metabase"),
    ],
    [0, true, true, true],
  );
  check("son entree de lock suit le reel", pausedEntry(applied), REAL_STATE);
  check("aucun appel d'ecriture, ni vers Scalingo ni vers les bases", writeCalls(applyRun.calls), []);
  check("les autres entrees du lock ne bougent pas", othersOf(readFileSync(join(applied.fleet, "lock.json"), "utf8")), othersOf(lockFixture));
  check(
    "l'ecart avec le manifeste est signale, sans action",
    /beta-metabase : en pause, lue sans rien ecrire, etat "running", v0\.63\.20 @ ccccccc\n {4}ecart avec le manifeste \(v0\.63\.18 @ aaaaaaa\), aucune action\n/.test(applyRun.output),
    true,
  );
  check("le decompte la garde en pause", / en pause 1 /.test(applyRun.output), true);
  const dashboard = readFileSync(join(applied.outDir, "incident.md"), "utf8");
  check(
    "le tableau de bord porte la version reelle, en ecart",
    [
      /^\| \[beta-metabase\]\S+ \| \[v0\.63\.20\]\S+ .*\| en pause, en écart \|$/m.test(dashboard),
      /^\| \[beta-metabase\]\S+ \| \[16\.9\.0-1\]\S+ .*\| en pause, relevée \|$/m.test(dashboard),
    ],
    [true, true],
  );
  check("une base en pause ne fait pas d'echeance", /beta-metabase : base en/.test(applyRun.output), false);

  const plannedPaused = sandbox();
  const planRun = run(plannedPaused, "apply.ts", ["--dry-run", ...FLEET], WITH_ACCESS);
  check(
    "en plan, elle est lue et l'ecart annonce, sans rien ecrire",
    [planRun.status, /ecart avec le manifeste/.test(planRun.output), writeCalls(planRun.calls), readFileSync(join(plannedPaused.fleet, "lock.json"), "utf8") === lockFixture],
    [0, true, [], true],
  );
  const offlinePlan = run(sandbox(), "apply.ts", ["--dry-run", ...FLEET]);
  check(
    "sans acces, le plan le dit et ne l'appelle pas",
    [offlinePlan.status, /beta-metabase : en pause, non relevee faute d'acces/.test(offlinePlan.output), offlinePlan.calls.filter((l) => l.includes("beta-metabase"))],
    [0, true, []],
  );

  const reconciled = sandbox();
  const reconcileRun = run(reconciled, "apply.ts", ["--reconcile", ...FLEET, "--out-dir", "../sortie"], WITH_ACCESS);
  check(
    "--reconcile la releve une seule fois, sans rien ecrire",
    [
      reconcileRun.status,
      pausedEntry(reconciled),
      reconcileRun.calls.filter((l) => l === `GET ${BETA}/variables`).length,
      /a bouge hors du watcher, le lock disait v0\.63\.18 @ aaaaaaa/.test(reconcileRun.output),
      /Aucune derive\./.test(reconcileRun.output),
      /Aucune derive hors des apps en pause\. 1 app\(s\) en pause, relevee\(s\) dans l'application\./.test(reconcileRun.output),
      writeCalls(reconcileRun.calls),
    ],
    [0, REAL_STATE, 1, true, false, true, []],
  );

  // Le meme ecart, sans la pause, part dans l'application : c'est bien elle qui
  // retient. Il s'y fait refuser, le reel etant plus recent que le manifeste,
  // ce qui est l'objet du controle de descente de version teste plus bas.
  const unpaused = sandbox();
  writeFileSync(join(unpaused.fleet, "manifest.yaml"), fixtureSrc.replace("    paused: true\n", ""));
  const unpausedPlan = run(unpaused, "apply.ts", ["--reconcile", "--dry-run", ...FLEET], WITH_ACCESS);
  check(
    "sans la pause, le meme ecart part dans l'application",
    [
      unpausedPlan.status,
      /beta-metabase : outil v0\.63\.20 -> v0\.63\.18, source main ccccccc -> aaaaaaa/.test(unpausedPlan.output),
      /beta-metabase : en pause/.test(unpausedPlan.output),
    ],
    [0, true, false],
  );

  const adopted = sandbox();
  const adoptRun = run(adopted, "apply.ts", ["--adopt", ...FLEET, "--app", "beta"], WITH_ACCESS);
  check("--adopt la releve comme les autres", [adoptRun.status, pausedEntry(adopted), writeCalls(adoptRun.calls)], [0, REAL_STATE, []]);

  const pruned = sandbox();
  const pruneRun = run(pruned, "apply.ts", ["--prune", ...FLEET]);
  check(
    "--prune garde son entree, l'app restant declaree",
    [pruneRun.status, readFileSync(join(pruned.fleet, "lock.json"), "utf8") === lockFixture, pruneRun.calls],
    [0, true, []],
  );

  console.log("\nDescente de version refusee, contre un fetch simule");

  // Le 2026-10-30 : une app pilote montee a la main en v0.64 avant que le
  // manifeste ne suive. La reconciliation suivante l'aurait redescendue en
  // v0.63 sur une base portant deja les migrations de la 064, que l'ancien
  // binaire refuse de demarrer. Seule une fusion dans la fenetre l'a evite.
  const AHEAD = "osc-fr1/alpha-metabase";
  const descente = (args: string[], status = "success") => {
    const b = sandbox();
    const out = run(b, "apply.ts", ["--reconcile", ...args, ...FLEET, "--out-dir", "../sortie"], {
      SCALINGO_API_TOKEN: "faux",
      REAL: JSON.stringify({ [AHEAD]: { version: "v0.64.4.2", sha: "a".repeat(40), status } }),
    });
    if (out.status !== 0) console.log(out.output);
    return {
      status: out.status,
      refusee: /DESCENTE DE VERSION : METABASE_VERSION porte v0\.64\.4\.2, le manifeste demande v0\.63\.18/.test(out.output),
      ecrit: writeCalls(out.calls),
    };
  };

  check("une cible anterieure a ce qui tourne est refusee", descente([]), { status: 0, refusee: true, ecrit: [] });
  check("le plan la refuse aussi, au lieu de l'annoncer", descente(["--dry-run"]), { status: 0, refusee: true, ecrit: [] });
  // Apres un deploiement rate, la variable porte la nouvelle version sans que le
  // binaire ait change : refuser le retour en arriere serait refuser la seule
  // reaction sensee.
  check(
    "apres un deploiement rate, le retour en arriere reste possible",
    descente(["--dry-run"], "build-error"),
    { status: 0, refusee: false, ecrit: [] },
  );
  check(
    "--force l'assume, la base restant a restaurer a la main",
    descente(["--dry-run", "--force", "--app", "alpha"]),
    { status: 0, refusee: false, ecrit: [] },
  );

  console.log("\nQuarantaine levee sur preuve, contre un fetch simule");

  // Le job de reconciliation du parc tourne a l'heure. Sur echec, le releve
  // lisait la cible comme atteinte, effacait la quarantaine, et la meme cible
  // repartait au passage suivant avec une sauvegarde fraiche, indefiniment.
  const QUARANTINED = "osc-fr1/alpha-metabase";
  const CIBLE = { sha: "a".repeat(40), version: "v0.63.18" };
  const lockEnQuarantaine = (sha = CIBLE.sha) => {
    const l = JSON.parse(lockFixture) as { apps: Record<string, Record<string, unknown>> };
    l.apps[QUARANTINED].source = { repo: "exemple/metabase-scalingo", sha };
    l.apps[QUARANTINED].backup = { id: "bkp-42", at: "2026-10-29T09:00:00.000Z" };
    l.apps[QUARANTINED].quarantine = {
      target: CIBLE,
      reason: "build-error",
      at: "2026-10-29T10:00:00.000Z",
      deploymentId: "dep-alpha-metabase",
    };
    return JSON.stringify(l, null, 2) + "\n";
  };
  const apresReleve = (status: string, sha = CIBLE.sha, lockSha?: string) => {
    const b = sandbox();
    writeFileSync(join(b.fleet, "lock.json"), lockEnQuarantaine(lockSha));
    const out = run(b, "apply.ts", ["--reconcile", ...FLEET, "--out-dir", "../sortie"], {
      SCALINGO_API_TOKEN: "faux",
      REAL: JSON.stringify({ [QUARANTINED]: { version: CIBLE.version, sha, status } }),
    });
    if (out.status !== 0) console.log(out.output);
    const entry = loadLock(join(b.fleet, "lock.json")).apps[QUARANTINED];
    return {
      status: out.status,
      quarantaine: Boolean(entry.quarantine),
      ignoree: /alpha-metabase : en quarantaine sur cette cible/.test(out.output),
      deploiement: out.calls.some((l) => /^POST \S+\/deployments$/.test(l)),
      sauvegarde: entry.backup?.id ?? null,
    };
  };

  check("un deploiement rate sur la cible ne leve pas la quarantaine", apresReleve("build-error"), {
    status: 0,
    quarantaine: true,
    ignoree: true,
    deploiement: false,
    sauvegarde: "bkp-42",
  });
  // Elle doit tomber des que la cible est atteinte, quel qu'en soit le moyen :
  // sinon une app montee a la main resterait gelee pour toujours. La preuve
  // reste le statut rendu par Scalingo, que la fenetre de garde ne rejoue pas au
  // releve : un deploiement fait hors du watcher est cru sur sa parole.
  check("un deploiement reussi sur la cible la leve", apresReleve("success"), {
    status: 0,
    quarantaine: false,
    ignoree: false,
    deploiement: false,
    sauvegarde: "bkp-42",
  });
  // git_ref qui n'est pas un sha, ce que rend un deploiement declenche depuis le
  // dashboard : le repli prenait le sha du manifeste, donc l'egalite cherchee,
  // et levait la quarantaine sans avoir rien constate.
  check("un git_ref illisible ne fabrique plus l'egalite de sha", apresReleve("success", "main", "c".repeat(40)), {
    status: 0,
    quarantaine: true,
    ignoree: true,
    deploiement: false,
    sauvegarde: "bkp-42",
  });

  console.log("\nFenetre de garde apres deploiement, contre un fetch simule");

  // Le 2026-10-30 : Scalingo a conclu reussi un deploiement dont Metabase
  // migrait encore sa base, et le succes n'a pu etre etabli qu'en lisant les
  // journaux applicatifs. La fenetre existe pour que le feu vert de l'eclaireur
  // dise quelque chose.
  const DELTA = "osc-secnum-fr1/delta-metabase";
  // delta-metabase est la derniere app du gabarit, et la seule sans base ni
  // sauvegarde : son deploiement se joue en quelques appels.
  const bumped = (() => {
    const was = "version: v0.63.18";
    const at = fixtureSrc.lastIndexOf(was);
    return `${fixtureSrc.slice(0, at)}version: v0.63.19${fixtureSrc.slice(at + was.length)}`;
  })();
  const withSettle = bumped.replace("    backup: not-available\n", "    backup: not-available\n    settle:\n      window: 1\n");

  const deploiement = (manifestSrc: string, env: Record<string, string> = {}) => {
    const b = sandbox();
    writeFileSync(join(b.fleet, "manifest.yaml"), manifestSrc);
    const out = run(b, "apply.ts", [...FLEET, "--app", "delta", "--out-dir", "../sortie"], {
      SCALINGO_API_TOKEN: "faux",
      REAL: JSON.stringify({ [DELTA]: { version: "v0.63.18", sha: "a".repeat(40) } }),
      ...env,
    });
    const entry = loadLock(join(b.fleet, "lock.json")).apps[DELTA];
    return {
      status: out.status,
      version: entry.tool.version,
      quarantaine: entry.quarantine?.reason ?? null,
      releves: out.calls.filter((l) => l.endsWith("/events?from=1")).length,
      vague: /Echec sur l'eclaireur/.test(out.output),
    };
  };

  check("sans fenetre declaree, rien n'est relu et le statut conclut seul", deploiement(bumped), {
    status: 0,
    version: "v0.63.19",
    quarantaine: null,
    releves: 0,
    vague: false,
  });
  check("une fenetre que rien ne trouble conclut au succes", deploiement(withSettle), {
    status: 0,
    version: "v0.63.19",
    quarantaine: null,
    releves: 2,
    vague: false,
  });
  // Le lock ne doit pas porter la nouvelle version, et la vague doit s'arreter
  // la : c'est tout l'objet du defaut.
  check("un redemarrage en erreur pendant la fenetre met en quarantaine", deploiement(withSettle, { CRASH: "1" }), {
    status: 1,
    version: "v0.63.18",
    quarantaine: "redemarrage en erreur pendant la fenetre de garde (restart)",
    releves: 2,
    vague: true,
  });
  // La relecture du statut en fin de fenetre attrape ce que les evenements ont
  // pu rater, mais seulement sur un statut qui dit quelque chose.
  check("une app eteinte au bout de la fenetre aussi", deploiement(withSettle, { STOPPED: "1" }), {
    status: 1,
    version: "v0.63.18",
    quarantaine: 'app "stopped" au bout de la fenetre de garde',
    releves: 2,
    vague: true,
  });

  console.log("\nPremier manifeste par init, contre un fetch simule");

  // Le parc simule de fetch-init.ts : quatre apps decrites entierement, quatre a
  // ecarter pour une raison chacune, une sans outil connu.
  const INIT_FETCH = pathToFileURL(join(FIXTURES, "fetch-init.ts")).href;
  const SECRET = "valeur-secrete-qui-ne-doit-sortir-nulle-part";
  const REGIONS = ["--region", "osc-fr1", "--region", "osc-secnum-fr1"];
  const NEW_FLEET = ["--manifest", "../neuf/manifest.yaml", "--lock", "../neuf/lock.json"];
  const TOKEN = { SCALINGO_API_TOKEN: "faux" };
  type GeneratedApp = {
    app: string;
    region: string;
    paused?: boolean;
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
  check("un depot lie sans branche est ecarte", /eta-metabase : depot lie sans branche/.test(init.output), true);
  check("un git_ref qui n'est pas un sha est ecarte",/epsilon-metabase : git_ref "master"/.test(init.output), true);
  check("une app sans outil connu n'est pas citee", init.output.includes("site-vitrine"), false);
  check("aucun secret ne sort, ni a l'ecran ni dans le manifeste", [init.output.includes(SECRET), generated.src.includes(SECRET)], [false, false]);

  const pausedApps = (m: { apps: GeneratedApp[] } | null) => (m?.apps ?? []).filter((a) => a.paused).map((a) => a.app);
  check("une app hors du compte de l'acces est ecrite en pause, et elle seule", pausedApps(generated.manifest), ["zeta-metabase"]);
  check(
    "la pause dit pourquoi, au-dessus du champ",
    /\n {4}# proprietaire autre-equipe, hors compte : lue, jamais ecrite\n {4}paused: true\n/.test(generated.src),
    true,
  );
  const accountUnread = sandbox();
  const accountUnreadRun = run(accountUnread, "init.ts", [...REGIONS, ...NEW_FLEET], { ...TOKEN, ACCOUNT_UNREADABLE: "1" }, INIT_FETCH);
  check(
    "compte illisible : init le dit une fois et ne deduit aucune pause",
    [
      accountUnreadRun.status,
      accountUnreadRun.output.split("Compte de l'acces illisible").length - 1,
      pausedApps(readGenerated(accountUnread).manifest),
      readGenerated(accountUnread).manifest?.apps.length,
    ],
    [0, 1, [], 4],
  );
  const ownerUnread = sandbox();
  const ownerUnreadRun = run(
    ownerUnread,
    "init.ts",
    [...REGIONS, ...NEW_FLEET],
    { ...TOKEN, OWNER_UNREADABLE: "alpha-metabase", OWNER_MISSING: "zeta-metabase" },
    INIT_FETCH,
  );
  check(
    "proprietaire illisible : l'app est gardee, sans pause deduite, et init le note",
    [
      ownerUnreadRun.status,
      readGenerated(ownerUnread).manifest?.apps.map(appKey),
      pausedApps(readGenerated(ownerUnread).manifest),
      ownerUnreadRun.output.split("proprietaire illisible").length - 1,
      /Releve impossible/.test(ownerUnreadRun.output),
    ],
    [0, generatedApps.map(appKey), [], 2, false],
  );

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
  const managers = ["renovate/base.json", "renovate.json"]
    .map((f) => join(import.meta.dirname, "..", f))
    .filter((f) => existsSync(f))
    .flatMap((f) => (JSON.parse(readFileSync(f, "utf8")).customManagers ?? []) as CustomManager[])
    .filter((m) => m.matchStrings?.some((s) => s.startsWith("- app: ")));
  const shaManager = managers.find((m) => m.matchStrings?.some((p) => p.includes("currentDigest")));
  const versionManager = managers.find((m) => m !== shaManager);
  check("la configuration Renovate lit le sha et la version", [Boolean(shaManager), Boolean(versionManager)], [true, true]);
  check(
    "chaque sha genere est lu par Renovate",
    extract(shaManager, generated.src).map((g) => [g.depName, g.datasource, g.repo, g.currentValue, g.currentDigest]),
    generatedApps.map((a) => [a.app, "git-refs", a.source.repo, a.source.branch, a.source.sha]),
  );
  check(
    "chaque version generee est lue par Renovate, avec l'amont de l'outil",
    extract(versionManager, generated.src).map((g) => [g.depName, g.datasource, g.packageName, g.currentValue]),
    generatedApps.map((a) => [a.app, "github-tags", upstreamOf(a.tool)?.repo, a.tool.version]),
  );
  check(
    "la politique et le $schema generes sont relus par Renovate",
    [[...new Set(extract(versionManager, generated.src).map((g) => g.depType))], extract(CITED_VERSIONS, generated.src).map((g) => g.currentValue)],
    [["outil minor=auto major=pr"], [`v${JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version}`]],
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
  const quotedGroups = (manager: CustomManager | undefined) => extract(manager, numericSrc).map((g) => g.currentValue);
  check(
    "Renovate lit la version et la branche quotees sans leurs guillemets",
    [quotedGroups(shaManager), quotedGroups(versionManager)],
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
  check(
    "derriere le proxy, le compte est illisible : dit une fois, aucune pause deduite",
    [proxied.output.split("Compte de l'acces illisible").length - 1, pausedApps(readGenerated(viaProxy).manifest)],
    [1, []],
  );
} finally {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
}

console.log(
  `\n${passed} verification(s) passee(s), ${failures} echec(s).\n`,
);
process.exit(failures > 0 ? 1 : 0);
