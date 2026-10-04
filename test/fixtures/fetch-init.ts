/**
 * Fetch simule pour init, charge par `node --import`.
 *
 * Repond pour le parc fictif PARC, en direct (hote api.<region>.scalingo.com) ou
 * par le proxy (region lue dans le blob d'API, blob-api-<region>). Chaque appel
 * est note dans le fichier TRACE. Tout autre appel repond 500.
 * OUTAGE=1 fait echouer la liste des apps, comme un proxy injoignable.
 */

import { appendFileSync } from "node:fs";

type SimulatedApp = {
  variables: Record<string, string>;
  deployment?: { git_ref: string | null; status: string };
  link?: { owner: string; repo: string; branch: string; scm_type: string };
  addons?: string[];
  database?: string;
};

const github = (repo: string, branch: string) => ({ owner: "exemple", repo, branch, scm_type: "github" });
const deployed = (c: string, status = "success") => ({ git_ref: c.repeat(40), status });

const SECRET = "valeur-secrete-qui-ne-doit-sortir-nulle-part";

const PARC: Record<string, Record<string, SimulatedApp>> = {
  "osc-fr1": {
    "alpha-metabase": {
      variables: { METABASE_VERSION: "v0.63.18", MB_ENCRYPTION_SECRET_KEY: SECRET },
      deployment: deployed("a"),
      link: github("metabase-scalingo", "main"),
      addons: ["postgresql"],
      database: "16.15.0-1",
    },
    "beta-metabase": {
      variables: { METABASE_VERSION: "v0.63.15" },
      deployment: deployed("b", "build-error"),
      link: github("metabase-scalingo", "oauth2"),
      addons: ["postgresql", "redis"],
    },
    "delta-metabase": {
      variables: { METABASE_VERSION: "v0.63.18" },
      deployment: deployed("d"),
      addons: ["postgresql"],
      database: "16.15.0-1",
    },
    "gamma-metabase": {
      variables: { METABASE_VERSION: "latest" },
      deployment: deployed("c"),
      link: github("metabase-scalingo", "main"),
    },
    "grafana-interne": {
      variables: { GRAFANA_VERSION: "11.2.0" },
      deployment: deployed("e"),
      link: github("grafana-scalingo", "main"),
      addons: [],
    },
    "site-vitrine": {
      variables: { NODE_VERSION: "22", DATABASE_URL: SECRET },
      deployment: deployed("1"),
      link: github("site", "main"),
    },
  },
  "osc-secnum-fr1": {
    "epsilon-metabase": {
      variables: { METABASE_VERSION: "v0.63.18" },
      deployment: { git_ref: "master", status: "success" },
      link: github("metabase-scalingo", "main"),
    },
    "zeta-metabase": {
      variables: { METABASE_VERSION: "v0.63.18" },
      deployment: deployed("f"),
      link: github("metabase-scalingo", "main"),
      addons: ["postgresql"],
      database: "17.11.0-1",
    },
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
  const u = new URL(String(url));
  const m = init.method ?? "GET";
  appendFileSync(process.env.TRACE!, `${m} ${u.href}\n`);
  const blob = new Headers(init.headers).get("X-FGP-Blob") ?? "";
  const region = /^api\.([^.]+)\.scalingo\.com$/.exec(u.host)?.[1] ?? /^blob-api-(.+)$/.exec(blob)?.[1];
  let r: RegExpExecArray | null;

  if (m === "POST" && u.href === "https://auth.scalingo.com/v1/tokens/exchange") return json({ token: "porteur" });

  if (m === "HEAD" && u.host === "raw.githubusercontent.com") {
    return new Response(null, { status: process.env.SCHEMA_TAG_MISSING ? 404 : 200 });
  }

  if (m === "GET" && (r = /^\/api\/databases\/([^~]+)~([^~]+)~(\w+)$/.exec(u.pathname))) {
    const version = PARC[r[1]]?.[r[2]]?.database;
    return version ? json({ database: { readable_version: version, next_version_id: null } }) : json({ error: "inconnue" }, 404);
  }

  if (!region || !PARC[region]) return json({ error: "appel imprevu" }, 500);
  const fleet = PARC[region];

  if (m === "GET" && u.pathname === "/v1/apps") {
    if (process.env.OUTAGE) return json({ error: "injoignable" }, 503);
    return json({ apps: Object.keys(fleet).map((name) => ({ id: `id-${name}`, name, status: "running" })) });
  }
  if (!(r = /^\/v1\/apps\/([^/]+)\/(.+)$/.exec(u.pathname)) || !fleet[r[1]]) return json({ error: "appel imprevu" }, 500);
  const [name, route] = [r[1], r[2]];
  const app = fleet[name];

  if (m === "GET" && route === "variables") {
    return json({ variables: Object.entries(app.variables).map(([n, value]) => ({ id: `var-${n}`, name: n, value })) });
  }
  if (m === "GET" && route === "deployments") {
    const d = app.deployment;
    return json({ deployments: d ? [{ id: `dep-${name}`, created_at: "2026-09-01T00:00:00Z", ...d }] : [] });
  }
  if (m === "GET" && route === "scm_repo_link") {
    return app.link ? json({ scm_repo_link: app.link }) : json({ error: "not found" }, 404);
  }
  if (m === "GET" && route === "addons") {
    return json({
      addons: (app.addons ?? []).map((provider) => ({ id: `${region}~${name}~${provider}`, addon_provider: { id: provider, name: provider } })),
    });
  }
  if (m === "POST" && /^addons\/[^/]+\/token$/.test(route)) return json({ addon: { token: "addon" } });
  return json({ error: "appel imprevu" }, 500);
}) as typeof fetch;
