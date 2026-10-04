/**
 * Fetch simule pour les commandes lancees par les tests, charge par
 * `node --import`.
 *
 * Chaque appel est note dans le fichier TRACE. Les bases repondent depuis
 * VERSIONS (region/app -> version), toujours conformes au manifeste et avec une
 * version suivante dans la meme majeure. Le proxy rend un blob factice a chaque
 * generation. Tout autre appel repond 500.
 * OUTAGE=1 fait echouer la liste des addons, comme un proxy injoignable.
 */

import { appendFileSync } from "node:fs";

const versions = JSON.parse(process.env.VERSIONS!) as Record<string, string>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
  const u = String(url);
  const m = init.method ?? "GET";
  appendFileSync(process.env.TRACE!, `${m} ${u}\n`);
  let r: RegExpExecArray | null;

  if (m === "POST" && u === "https://auth.scalingo.com/v1/tokens/exchange") return json({ token: "porteur" });
  if (m === "POST" && u.endsWith("/api/generate")) return json({ blob: "blob-factice" });
  if (m === "GET" && (r = /^https:\/\/api\.([^/]+)\.scalingo\.com\/v1\/apps\/([^/]+)\/addons$/.exec(u))) {
    if (process.env.OUTAGE) return json({ error: "injoignable" }, 503);
    return json({ addons: [{ id: `${r[1]}~${r[2]}`, addon_provider: { id: "postgresql" } }] });
  }
  if (m === "POST" && /\/v1\/apps\/[^/]+\/addons\/[^/]+\/token$/.test(u)) return json({ addon: { token: "addon" } });
  if (m === "GET" && (r = /\/api\/databases\/([^/~]+)~([^/]+)$/.exec(u))) {
    const v = versions[`${r[1]}/${r[2]}`];
    return json({ database: { readable_version: v, next_version_id: v.split(".")[0] } });
  }
  if (m === "GET" && (r = /\/api\/database_type_versions\/(\d+)$/.exec(u))) {
    return json({ database_type_version: { major: Number(r[1]), minor: 99, patch: 0, build: 1 } });
  }
  return json({ error: "appel imprevu" }, 500);
}) as typeof fetch;
