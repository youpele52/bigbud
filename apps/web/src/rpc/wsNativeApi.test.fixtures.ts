import { DEFAULT_SERVER_SETTINGS, type ServerConfig, type ServerProvider } from "@bigbud/contracts";

export const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

export const baseServerConfig: ServerConfig = {
  cwd: "/tmp/workspace",
  storage: {
    notesDir: "/tmp/workspace/.config/notes",
    kanbanDir: "/tmp/workspace/.config/kanban",
  },
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  discovery: { agents: [], skills: [] },
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};
