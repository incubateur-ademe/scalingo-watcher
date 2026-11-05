import type { ToolModule } from "./types.ts";

export default {
  env: "PROMETHEUS_VERSION",
  name: "Prometheus",
  upstream: { repo: "prometheus/prometheus", line: 1, lifecycle: "prometheus" },
} satisfies ToolModule;
