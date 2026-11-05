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
 * Un deploiement est accepte et conclu du premier coup, au statut de REAL.
 * CRASH=1 fait apparaitre un redemarrage en erreur dans les evenements de l'app
 * a partir du deuxieme releve suivant le deploiement, soit pendant la fenetre
 * de garde et non avant, ce qui est le scenario que la fenetre existe pour
 * attraper. CRASH_AFTER le fait apparaitre a partir d'un autre releve.
 * STOPPED=1 eteint l'app une fois son deploiement declenche.
 * PS_DENIED=1 fait refuser la lecture des conteneurs, comme un fgp.json qui
 * precede cette route.
 * CONTAINER donne l'etat du conteneur web apres le deploiement, `running` a
 * defaut. Une console one-off et deux conteneurs de la version d'avant,
 * l'un supprime, l'autre seulement cree avant le deploiement, l'accompagnent
 * toujours, dans un etat qui ferait echouer le controle s'il les comptait.
 */

import { appendFileSync } from "node:fs";

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
const built = (process.env.BUILT ?? "https://github.com/Scalingo/metabase-buildpack")
  .split(",")
  .filter((u) => u.length > 0);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AT = "2026-10-01T00:00:00Z";
const BEFORE = "2026-09-01T00:00:00Z";
const LATER = "2026-10-01T00:05:00Z";
let eventReads = 0;
let deployTriggered = false;

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
    return json({ stacks: [{ id: "st-24", name: "scalingo-24", deprecated_at: null }] });
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
    if (route === "/deployments?per_page=1") {
      return json({
        deployments: [
          { id: `dep-${app}`, status: state.status ?? "success", created_at: "2026-10-01T00:00:00Z", git_ref: state.sha },
        ],
      });
    }
    if (route === `/deployments/dep-${app}`) {
      return json({ deployment: { id: `dep-${app}`, status: state.status ?? "success", created_at: AT } });
    }
    if (route === `/deployments/dep-${app}/output`) {
      return new Response(built.map((b) => `-----> Downloading Buildpack: ${b}\n`).join(""), { status: 200 });
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
    if (route === "/events?from=1") {
      if (deployTriggered) eventReads++;
      const fallen = (process.env.CRASH || process.env.CRASH_AFTER) && eventReads > Number(process.env.CRASH_AFTER ?? 1);
      return json({
        events: [
          ...(fallen ? [{ id: "ev-crash", type: "restart", created_at: AT, type_data: { reason: "unexpected_failure" } }] : []),
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
      deployTriggered = true;
      return json({ deployment: { id: `dep-${app}` } });
    }
    if (/^\/variables(\/.+)?$/.test(route)) return json({ variable: { id: "var-1" } });
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
