import type { ToolModule } from "./types.ts";

/**
 * Le depot publie aujourd'hui la Community Build, numerotee 26.x, et non la
 * SonarQube Server numerotee par annee : ce sont deux produits distincts chez
 * endoflife.date, et les confondre daterait la fin de vie de l'autre.
 */
export default {
  env: "SONARQUBE_VERSION",
  name: "SonarQube",
  upstream: { repo: "SonarSource/sonarqube", line: 1, lifecycle: "sonarqube-community" },
} satisfies ToolModule;
