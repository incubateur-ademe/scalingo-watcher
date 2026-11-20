/**
 * Fetch simule pour les commandes lancees par les tests, charge par
 * `node --import`.
 *
 * Chaque appel est note dans le fichier TRACE. Les bases repondent depuis
 * VERSIONS (region/app -> version), toujours conformes au manifeste et avec une
 * version suivante dans la meme majeure. Le proxy rend un blob factice a chaque
 * generation, et note sa demande dans le fichier GENERATED s'il est donne.
 * Tout autre appel repond 500.
 * OUTAGE=1 fait echouer la liste des addons, comme un proxy injoignable.
 *
 * Chaque app repond "running" sur un stack sans echeance. REAL (region/app ->
 * { version, sha, status }) donne l'etat reel des apps qu'on veut pouvoir
 * relever : leur variable d'outil et leur dernier deploiement, dont le statut
 * vaut "success" a defaut.
 * DENIED=1 fait refuser par le proxy tout appel qui passe par lui, faute de scope,
 * hormis la liste des apps.
 * ADVISORIES, liste d'avis de depot, repond a l'API des avis de securite ; sans
 * elle, l'amont n'en publie aucun.
 * LIFECYCLE, liste de lignes de versions, repond a la source de fin de vie ;
 * sans elle, la ligne en service est de support long et loin de sa fin, soit
 * le cas ou cette veille n'a rien a dire.
 * EOL_OUTAGE=1 fait echouer cette source, comme un editeur injoignable.
 *
 * BUILDPACKS (sha -> liste d'URL) repond au .buildpacks du depot applicatif a
 * ce commit ; un sha absent de la table rend 404, comme un depot sans ce
 * fichier, et sans la table l'API GitHub repond 500, comme une panne.
 * BUILT, liste d'URL separees par des virgules, donne les buildpacks que le
 * journal du build annonce ; a defaut il n'en annonce qu'un, celui du lock du
 * gabarit, et la chaine vide simule un journal qui n'en nomme aucun.
 *
 * Un deploiement est accepte et conclu du premier coup, au statut de REAL, et
 * fini a DONE, bien avant le passage : sa fenetre de garde est donc ecoulee.
 * CRASH=1 fait apparaitre un redemarrage en erreur dans les evenements de l'app
 * a la fin du deploiement, soit dans la fenetre de garde, ce qui est le
 * scenario que la fenetre existe pour attraper. CRASH_LATE=1 le date d'un jour
 * plus tard, hors de la fenetre et du delai de demarrage.
 * DEPLOY_STATUS remplace ce statut a la relecture du deploiement lance, pour
 * un build qui n'est pas encore conclu.
 * Une sauvegarde demandee prend l'identifiant bkp-neuve, que la liste des
 * sauvegardes rend toujours, au statut BACKUP_STATUS, `done` a defaut : un
 * statut en vol fait se rattacher au lieu de demander.
 * FINISHED_AGO donne en minutes la fin du deploiement relu, comptee depuis
 * maintenant, au lieu de DONE. EVENTS_FAIL=1 fait rendre 502 aux evenements,
 * comme une lecture passagere ratee.
 * DEPLOY_POST_FAIL=1 fait rendre 504 a la demande de deploiement, comme une
 * reponse perdue dont on ne sait pas si la plateforme l'a prise en compte.
 * STOPPED=1 eteint l'app une fois son deploiement declenche.
 * PS_DENIED=1 fait refuser la lecture des conteneurs, comme un fgp.json qui
 * precede cette route.
 * CONTAINER donne l'etat du conteneur web apres le deploiement, `running` a
 * defaut. Une console one-off et deux conteneurs de la version d'avant,
 * l'un supprime, l'autre seulement cree avant le deploiement, l'accompagnent
 * toujours, dans un etat qui ferait echouer le controle s'il les comptait.
 *
 * Le dernier deploiement releve date d'une heure, DEPLOYED_AT a defaut.
 * JDK fait annoncer au journal le buildpack jvm-common et le JDK installe,
 * JDK_AFTER celui du build que le passage declenche. LOG_OUTAGE=1 rend le
 * journal illisible. STACK_IMAGE donne l'image de pile du deploiement releve,
 * STACK_IMAGE_AFTER celle du build declenche, STACK_CURRENT l'image courante de
 * la pile. SYSTEM_PROPERTIES est le system.properties du depot applicatif, 404
 * sans lui. INVENTORY est l'inventaire de jvm-common, 404 sans lui.
 * UPSTREAM_INVENTORY est celui d'Heroku a sa tete, UPSTREAM_HISTORY
 * (liste de { sha, date, inventory }, du plus recent au plus ancien) son
 * historique, que l'API des commits rend en 503 sans lui. RAW_OUTAGE=1 fait
 * echouer tous les fichiers bruts de GitHub.
 *
 * NOW fige l'horloge du moteur, pour la plage horaire des rebuilds.
 * AFTER_STATUS (app -> statut) donne le statut d'un deploiement que le passage
 * declenche, celui de REAL a defaut. TRIGGERED, liste d'apps separees par des
 * virgules, dit que leur deploiement relu est celui qu'un passage precedent a
 * lance : son journal et son statut sont ceux d'apres. DEPLOYMENTS
 * (region/app -> liste de { id, status, git_ref?, created_at? }, du plus recent
 * au plus ancien) remplace la liste des deploiements de l'app. JVM_DOWNLOAD remplace l'URL de jvm-common
 * dans le journal, JVM_BRANCH y ajoute un `Using branch:`, JDK_LINE remplace la
 * ligne d'installation du JDK, et la vide la retire. STACK_NAME nomme la pile
 * de chaque app, scalingo-24 a defaut ; INVENTORY_20 est l'inventaire de
 * jvm-common pour scalingo-20.
 */

import { appendFileSync } from "node:fs";

if (process.env.NOW) {
  const fixed = Date.parse(process.env.NOW);
  Date.now = () => fixed;
}

const versions = JSON.parse(process.env.VERSIONS!) as Record<string, string>;
const real = JSON.parse(process.env.REAL ?? "{}") as Record<
  string,
  { version: string; sha: string; status?: string }
>;
const advisories = JSON.parse(process.env.ADVISORIES ?? "[]") as unknown[];
const lifecycle = JSON.parse(
  process.env.LIFECYCLE ?? '[{"name":"0.63","isLts":true,"isEol":false,"eolFrom":"2099-01-01"}]',
) as unknown[];

const buildpacks = JSON.parse(process.env.BUILDPACKS ?? "null") as Record<string, string[]> | null;
// Sans cette table, l'API rendait 500 sur la comparaison, donc shaIsOnBranch
// rendait null, donc les deux gardes de branche ne pouvaient refuser dans aucun
// passage de test.
const compared = JSON.parse(process.env.COMPARE ?? "null") as Record<string, string> | null;
const built = (process.env.BUILT ?? "https://github.com/Scalingo/metabase-buildpack")
  .split(",")
  .filter((u) => u.length > 0);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AT = "2026-10-01T00:00:00Z";
// Le dernier deploiement releve date d'une heure : un build plus vieux que la
// regle d'age serait refait par toute reconciliation, et chaque test qui
// releve le parc deploierait. DEPLOYED_AT le vieillit.
const RECENT = new Date(Date.now() - 3_600_000).toISOString();
const JVM_URL = "https://github.com/Scalingo/buildpack-jvm-common.git";
const BEFORE = "2026-09-01T00:00:00Z";
const LATER = "2026-10-01T00:05:00Z";
const DONE = "2026-10-01T00:01:00Z";
const NEXT_DAY = "2026-10-02T00:01:00Z";
let deployTriggered = false;
const triggered = new Set<string>();
const afterStatus = JSON.parse(process.env.AFTER_STATUS ?? "{}") as Record<string, string>;
const deploymentLists = JSON.parse(process.env.DEPLOYMENTS ?? "{}") as Record<
  string,
  Array<{ id: string; status: string; git_ref?: string | null; created_at?: string }>
>;
// Un build lance par un passage precedent, conclu par celui-ci : le journal et
// le statut relus sont deja ceux du build lance.
const launchedBefore = new Set((process.env.TRIGGERED ?? "").split(",").filter((a) => a.length > 0));
const launched = (app: string): boolean => triggered.has(app) || launchedBefore.has(app);

globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
  const u = String(url);
  const m = init.method ?? "GET";
  appendFileSync(process.env.TRACE!, `${m} ${u}\n`);
  let r: RegExpExecArray | null;

  if (m === "POST" && u === "https://auth.scalingo.com/v1/tokens/exchange") return json({ token: "porteur" });
  // Tout vient de la premiere page, les suivantes sont vides.
  if (m === "GET" && /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/security-advisories\?/.test(u)) {
    return json(u.includes("page=1") ? advisories : []);
  }
  if (compared && m === "GET" && (r = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/compare\/.+\.\.\.([0-9a-f]{40})$/.exec(u))) {
    const status = compared[r[1]];
    return status ? json({ status }) : json({ message: "Not Found" }, 404);
  }
  if (buildpacks && m === "GET" && (r = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/contents\/\.buildpacks\?ref=(\w+)$/.exec(u))) {
    const lines = buildpacks[r[1]];
    if (!lines) return json({ message: "Not Found" }, 404);
    return json({ encoding: "base64", content: Buffer.from(lines.join("\n")).toString("base64") });
  }
  if (m === "GET" && (r = /^https:\/\/endoflife\.date\/api\/v1\/products\/([^/?]+)$/.exec(u))) {
    if (process.env.EOL_OUTAGE) return json({ error: "injoignable" }, 503);
    return json({ result: { name: r[1], releases: lifecycle } });
  }
  if (m === "POST" && u.endsWith("/api/generate")) {
    if (process.env.GENERATED) appendFileSync(process.env.GENERATED, `${String(init.body)}\n`);
    return json({ blob: "blob-factice" });
  }
  if (process.env.DENIED && u === "https://fgp.exemple.test/v1/apps") {
    return json({ apps: [{ id: "a1", name: "alpha-metabase" }, { id: "a2", name: "hors-manifeste" }] });
  }
  if (process.env.DENIED && u.startsWith("https://fgp.exemple.test/")) {
    return new Response(JSON.stringify({ error: "scope_denied", message: "Insufficient permissions for this action" }), {
      status: 403,
      headers: { "Content-Type": "application/json", "X-FGP-Source": "proxy" },
    });
  }
  if (m === "GET" && (r = /^https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps\/([^/]+)\/addons$/.exec(u))) {
    if (process.env.OUTAGE) return json({ error: "injoignable" }, 503);
    return json({ addons: [{ id: `${r[1]}~${r[2]}`, addon_provider: { id: "postgresql" } }] });
  }
  if (m === "POST" && /\/v1\/apps\/[^/]+\/addons\/[^/]+\/token$/.test(u)) return json({ addon: { token: "addon" } });
  if (m === "GET" && /^https:\/\/api\.[^/]+\.scalingo\.com\/v1\/features\/stacks$/.test(u)) {
    const image = process.env.STACK_CURRENT ? { base_image: process.env.STACK_CURRENT } : {};
    return json({ stacks: [{ id: "st-24", name: process.env.STACK_NAME ?? "scalingo-24", deprecated_at: null, ...image }] });
  }
  // Fichiers bruts de GitHub : system.properties du depot applicatif, et
  // inventaires du buildpack jvm-common et de son amont, a la tete ou a un
  // commit de l'historique.
  if (m === "GET" && (r = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(u))) {
    const [, repo, ref, file] = r;
    if (process.env.RAW_OUTAGE) return json({ error: "injoignable" }, 503);
    if (file === "system.properties") {
      return process.env.SYSTEM_PROPERTIES ? new Response(process.env.SYSTEM_PROPERTIES) : new Response("404: Not Found", { status: 404 });
    }
    if (file === "inventory.json" && repo === "Scalingo/buildpack-jvm-common" && process.env.INVENTORY) {
      return new Response(process.env.INVENTORY);
    }
    if (file === "inventory-20.json" && repo === "Scalingo/buildpack-jvm-common" && process.env.INVENTORY_20) {
      return new Response(process.env.INVENTORY_20);
    }
    if (file === "inventory.json" && repo === "heroku/heroku-buildpack-jvm-common") {
      if (ref === "HEAD" && process.env.UPSTREAM_INVENTORY) return new Response(process.env.UPSTREAM_INVENTORY);
      const then = (JSON.parse(process.env.UPSTREAM_HISTORY ?? "[]") as Array<{ sha: string; inventory: unknown }>).find((c) => c.sha === ref);
      if (then) return new Response(JSON.stringify(then.inventory));
    }
    return new Response("404: Not Found", { status: 404 });
  }
  if (m === "GET" && /^https:\/\/api\.github\.com\/repos\/heroku\/heroku-buildpack-jvm-common\/commits\?path=inventory\.json/.test(u)) {
    const history = JSON.parse(process.env.UPSTREAM_HISTORY ?? "null") as Array<{ sha: string; date: string }> | null;
    if (!history) return json({ message: "injoignable" }, 503);
    return json(history.map((c) => ({ sha: c.sha, commit: { committer: { date: c.date } } })));
  }
  if (m === "GET" && (r = /^https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps\/([^/?]+)(\/.*)?$/.exec(u))) {
    const [, region, app, route = ""] = r;
    if (route === "") {
      // STOPPED=1 : l'app s'eteint apres son deploiement, et pas avant, sinon
      // le garde-fou des etats non deployables l'ecarterait en amont.
      const status = process.env.STOPPED && deployTriggered ? "stopped" : "running";
      return json({ app: { name: app, status, stack_id: "st-24" } });
    }
    const state = real[`${region}/${app}`];
    if (!state) return json({ error: "appel imprevu" }, 500);
    if (route === "/variables") return json({ variables: [{ id: "var-1", name: "METABASE_VERSION", value: state.version }] });
    if ((r = /^\/deployments\?per_page=(\d+)$/.exec(route))) {
      const listed = deploymentLists[`${region}/${app}`];
      if (listed) {
        return json({
          deployments: listed.slice(0, Number(r[1])).map((d) => ({
            created_at: process.env.DEPLOYED_AT ?? RECENT,
            git_ref: state.sha,
            ...(process.env.STACK_IMAGE ? { stack_base_image: process.env.STACK_IMAGE } : {}),
            ...d,
          })),
        });
      }
      return json({
        deployments: [
          {
            id: `dep-${app}`,
            status: state.status ?? "success",
            created_at: process.env.DEPLOYED_AT ?? RECENT,
            git_ref: state.sha,
            ...(process.env.STACK_IMAGE ? { stack_base_image: process.env.STACK_IMAGE } : {}),
          },
        ],
      });
    }
    if (route === `/deployments/dep-${app}`) {
      const status = process.env.DEPLOY_STATUS ?? (launched(app) ? afterStatus[app] : undefined) ?? state.status ?? "success";
      const finished = process.env.FINISHED_AGO ? new Date(Date.now() - Number(process.env.FINISHED_AGO) * 60_000).toISOString() : DONE;
      return json({
        deployment: {
          id: `dep-${app}`,
          status,
          created_at: AT,
          finished_at: finished,
          ...(process.env.STACK_IMAGE_AFTER ? { stack_base_image: process.env.STACK_IMAGE_AFTER } : {}),
        },
      });
    }
    if (route === `/deployments/dep-${app}/output`) {
      if (process.env.LOG_OUTAGE) return json({ error: "injoignable" }, 503);
      const jdk = launched(app) && process.env.JDK_AFTER ? process.env.JDK_AFTER : process.env.JDK;
      const jvm = jdk
        ? [
            `-----> Downloading Buildpack: ${process.env.JVM_DOWNLOAD ?? JVM_URL}`,
            ...(process.env.JVM_BRANCH ? [`-----> Using branch: ${process.env.JVM_BRANCH}`] : []),
            process.env.JDK_LINE ?? `-----> Installing Azul Zulu OpenJDK ${jdk}`,
          ].filter((l) => l.length > 0)
        : [];
      const lines = [...jvm, ...built.map((b) => `-----> Downloading Buildpack: ${b}`)];
      return new Response(lines.map((l) => `${l}\n`).join(""), { status: 200 });
    }
    if (route === "/ps") {
      if (process.env.PS_DENIED) return json({ error: "scope_denied" }, 403);
      return json({
        containers: [
          { id: "ct-web", type: "web", type_index: 1, state: process.env.CONTAINER ?? "running", created_at: LATER, deleted_at: null },
          { id: "ct-console", type: "one-off", type_index: 1, state: "booting", created_at: LATER, deleted_at: null },
          { id: "ct-supprime", type: "web", type_index: 1, state: "crashed", created_at: BEFORE, deleted_at: AT },
          { id: "ct-ancien", type: "web", type_index: 2, state: "crashed", created_at: BEFORE, deleted_at: null },
        ],
      });
    }
    if (route.startsWith("/events?")) {
      if (process.env.EVENTS_FAIL) return json({ error: "bad gateway" }, 502);
      const crashAt = process.env.CRASH_LATE ? NEXT_DAY : DONE;
      const fallen = (deployTriggered || launchedBefore.has(app)) && (process.env.CRASH || process.env.CRASH_LATE);
      return json({
        events: [
          ...(fallen ? [{ id: "ev-crash", type: "restart", created_at: crashAt, type_data: { reason: "unexpected_failure" } }] : []),
          // Deja la avant la fenetre : un releve qui le compterait refuserait
          // tous les deploiements.
          { id: "ev-deploiement", type: "deployment", created_at: AT },
        ],
      });
    }
  }

  // Ecritures sur une app : variable de version et declenchement du deploiement.
  if ((m === "POST" || m === "PATCH") && (r = /^https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps\/([^/?]+)(\/.+)$/.exec(u))) {
    const [, region, app, route] = r;
    if (!real[`${region}/${app}`]) return json({ error: "appel imprevu" }, 500);
    if (route === "/deployments") {
      if (process.env.DEPLOY_POST_FAIL) return json({ error: "gateway timeout" }, 504);
      deployTriggered = true;
      triggered.add(app);
      return json({ deployment: { id: `dep-${app}` } });
    }
    if (/^\/variables(\/.+)?$/.test(route)) return json({ variable: { id: "var-1" } });
  }
  if (/\/api\/databases\/[^/]+\/backups$/.test(u)) {
    if (m === "POST") return json({ database_backup: { id: "bkp-neuve", status: "scheduled", created_at: AT } });
    return json({ database_backups: [{ id: "bkp-neuve", status: process.env.BACKUP_STATUS ?? "done", created_at: AT }] });
  }
  if (m === "GET" && (r = /\/api\/databases\/([^/~]+)~([^/]+)$/.exec(u))) {
    const v = versions[`${r[1]}/${r[2]}`];
    return json({ database: { readable_version: v, next_version_id: v.split(".")[0] } });
  }
  if (m === "GET" && (r = /\/api\/database_type_versions\/(\d+)$/.exec(u))) {
    return json({ database_type_version: { major: Number(r[1]), minor: 99, patch: 0, build: 1 } });
  }
  return json({ error: "appel imprevu" }, 500);
}) as typeof fetch;
