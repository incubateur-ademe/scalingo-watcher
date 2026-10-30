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
 *
 * Un deploiement est accepte et conclu du premier coup, au statut de REAL.
 * CRASH=1 fait apparaitre un redemarrage en erreur dans les evenements de l'app
 * a partir du deuxieme releve, soit pendant la fenetre de garde et non avant,
 * ce qui est le scenario que la fenetre existe pour attraper.
 * STOPPED=1 eteint l'app une fois son deploiement declenche.
 */

import { appendFileSync } from "node:fs";

const versions = JSON.parse(process.env.VERSIONS!) as Record<string, string>;
const real = JSON.parse(process.env.REAL ?? "{}") as Record<
  string,
  { version: string; sha: string; status?: string }
>;
const advisories = JSON.parse(process.env.ADVISORIES ?? "[]") as unknown[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const AT = "2026-10-01T00:00:00Z";
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
      return new Response("-----> Downloading Buildpack: https://github.com/Scalingo/metabase-buildpack\n", { status: 200 });
    }
    if (route === "/events?from=1") {
      eventReads++;
      const fallen = process.env.CRASH && eventReads > 1;
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
