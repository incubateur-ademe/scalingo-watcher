import type { ToolModule } from "./types.ts";

export default {
  env: "LOGSTASH_VERSION",
  name: "Logstash",
  upstream: { repo: "elastic/logstash", line: 1, lifecycle: "logstash" },
} satisfies ToolModule;
