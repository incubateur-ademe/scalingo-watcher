import type { ToolModule } from "./types.ts";

export default {
  env: "GRAFANA_VERSION",
  name: "Grafana",
  upstream: { repo: "grafana/grafana", line: 1, lifecycle: "grafana" },
} satisfies ToolModule;
