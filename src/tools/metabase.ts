import type { ToolModule } from "./types.ts";

/**
 * Deux lignes publiees en parallele : v0.x pour l'edition OSS, v1.x pour
 * l'Enterprise. Le premier chiffre designe l'edition et non une version :
 * v1.52.2 date de 2024 quand v0.63.16 date de 2026. D'ou une ligne d'un seul
 * composant, et le `x` d'edition des avis de securite.
 *
 * Le prefixe `v` fait partie de la valeur de METABASE_VERSION : le buildpack la
 * concatene telle quelle dans l'URL de telechargement.
 */
export default {
  env: "METABASE_VERSION",
  name: "Metabase",
  upstream: { repo: "metabase/metabase", line: 1, lifecycle: "metabase" },
  editionWildcard: true,
  renovatePreset: "metabase",
} satisfies ToolModule;
