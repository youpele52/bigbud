import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import type { ServerConfig } from "@bigbud/contracts/server/server";

export const serverConfigFixture: ServerConfig = {
  cwd: "/fixture/workspace",
  storage: { notesDir: "/fixture/notes", kanbanDir: "/fixture/kanban" },
  keybindingsConfigPath: "/fixture/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  discovery: { agents: [], skills: [] },
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/fixture/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};
