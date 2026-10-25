import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import type { ServerConfig } from "@bigbud/contracts/server/server";

export function createGreetingServerConfig(): ServerConfig {
  return {
    cwd: "/greeting-test",
    storage: { notesDir: "/greeting-test/notes", kanbanDir: "/greeting-test/kanban" },
    keybindingsConfigPath: "/greeting-test/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    discovery: { agents: [], skills: [] },
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/greeting-test/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, greetingName: "Youpele" },
  };
}
