import type { ToolModule } from "./types.ts";

export default {
  env: "KIBANA_VERSION",
  name: "Kibana",
  upstream: { repo: "elastic/kibana", line: 1, lifecycle: "kibana" },
} satisfies ToolModule;
