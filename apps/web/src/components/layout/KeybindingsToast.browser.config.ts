import { DEFAULT_SERVER_SETTINGS, type ServerConfig } from "@bigbud/contracts";

export function createBaseServerConfig(checkedAt: string): ServerConfig {
  return {
    cwd: "/repo/project",
    storage: { notesDir: "/repo/project/.t3/notes", kanbanDir: "/repo/project/.t3/kanban" },
    keybindingsConfigPath: "/repo/project/.bigbud-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    discovery: { agents: [], skills: [] },
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: false,
      defaultThreadEnvMode: "local",
      textGenerationModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      providers: {
        codex: { enabled: true, binaryPath: "", homePath: "", customModels: [] },
        claudeAgent: {
          ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
          enabled: true,
          binaryPath: "",
          customModels: [],
        },
        cliProxy: { enabled: true, configPath: "" },
        copilot: { enabled: true, binaryPath: "", customModels: [] },
        opencode: { enabled: true, binaryPath: "", customModels: [] },
        opencodeV2: { enabled: false, binaryPath: "", profileRoot: "" },
        kilocode: { enabled: true, binaryPath: "", customModels: [] },
        pi: { enabled: true, binaryPath: "", customModels: [] },
        cursor: { enabled: true, binaryPath: "agent", customModels: [], apiEndpoint: "" },
        devin: { enabled: true, binaryPath: "devin", customModels: [] },
      },
    },
  };
}
