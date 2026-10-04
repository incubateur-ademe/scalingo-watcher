/**
 * Ou chaque outil publie ses versions, et comment les ranger en lignes.
 *
 * C'est le seul rapprochement que rien ne permet de deriver : le nom de la
 * variable de version dit quel buildpack la lit, pas ou l'outil publie ses
 * releases. La table se limite aux depots verifies : un mauvais rapprochement
 * produirait un "a jour" faux, ce qui est pire que "amont inconnu".
 * A confirmer avant ajout : clamav, geoserver, opensearch-dashboards, nginx.
 *
 * Le champ tool.upstream du manifeste complete ou surcharge cette table.
 */

export type Upstream = {
  /** Depot GitHub qui publie les releases, au format owner/name. */
  repo: string;
  /**
   * Nombre de composants de tete qui forment une ligne de versions. Une
   * version n'est comparee qu'aux releases de sa propre ligne.
   */
  line: number;
};

/** Cle : la variable de version lue par le buildpack, celle de tool.env. */
export const UPSTREAM: Record<string, Upstream & { name: string }> = {
  // Deux lignes publiees en parallele : v0.x pour l'edition OSS, v1.x pour
  // l'Enterprise. Le premier chiffre designe l'edition et non une version :
  // v1.52.2 date de 2024 quand v0.63.16 date de 2026.
  METABASE_VERSION: { name: "Metabase", repo: "metabase/metabase", line: 1 },
  GRAFANA_VERSION: { name: "Grafana", repo: "grafana/grafana", line: 1 },
  LOGSTASH_VERSION: { name: "Logstash", repo: "elastic/logstash", line: 1 },
  KIBANA_VERSION: { name: "Kibana", repo: "elastic/kibana", line: 1 },
  PROMETHEUS_VERSION: { name: "Prometheus", repo: "prometheus/prometheus", line: 1 },
  SONARQUBE_VERSION: { name: "SonarQube", repo: "SonarSource/sonarqube", line: 1 },
};

const DEFAULT_LINE = 1;

export type ToolDeclaration = { env: string; upstream?: { repo: string; line?: number } };

/** Amont d'un outil : celui que declare le manifeste, sinon celui de la table. */
export function upstreamOf(tool: ToolDeclaration): Upstream | null {
  const known = UPSTREAM[tool.env];
  if (tool.upstream) {
    return { repo: tool.upstream.repo, line: tool.upstream.line ?? known?.line ?? DEFAULT_LINE };
  }
  return known ? { repo: known.repo, line: known.line } : null;
}

/** Nom de l'outil dans le rapport : celui de la table, a defaut celui de sa variable. */
export function toolName(env: string): string {
  const known = UPSTREAM[env]?.name;
  if (known) return known;
  const base = env.replace(/_VERSION$/, "").toLowerCase().replace(/_/g, " ");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const head = (v: readonly number[], line: number) =>
  Array.from({ length: line }, (_, i) => v[i] ?? 0);

/** Compare les lignes de deux versions decoupees en composants numeriques. */
export function compareLines(a: readonly number[], b: readonly number[], line: number): number {
  const [x, y] = [head(a, line), head(b, line)];
  for (let i = 0; i < line; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Ligne d'une version telle qu'affichee : 0 pour v0.63.18 avec une ligne d'un composant. */
export const lineLabel = (v: readonly number[], line: number) => head(v, line).join(".");
