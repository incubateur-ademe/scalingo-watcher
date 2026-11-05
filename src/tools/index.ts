/**
 * Les outils que le moteur connait, un module par outil.
 *
 * Ajouter un outil : un fichier ici, et renovate/<outil>.json s'il doit
 * profiter de la politique de fusion du manifeste. Le README decrit la recette.
 * A confirmer avant ajout : clamav, geoserver, opensearch-dashboards, nginx.
 */
import grafana from "./grafana.ts";
import kibana from "./kibana.ts";
import logstash from "./logstash.ts";
import metabase from "./metabase.ts";
import prometheus from "./prometheus.ts";
import sonarqube from "./sonarqube.ts";
import type { ToolModule } from "./types.ts";

export type { ToolModule } from "./types.ts";

export const TOOLS: readonly ToolModule[] = [metabase, grafana, logstash, kibana, prometheus, sonarqube];

export const toolOf = (env: string): ToolModule | undefined => TOOLS.find((t) => t.env === env);
