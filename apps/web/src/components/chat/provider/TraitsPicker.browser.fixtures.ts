import { type ServerProvider, ThreadId } from "@bigbud/contracts";

export const CLAUDE_THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");

export const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "xhigh", label: "Extra High" },
            { value: "high", label: "High", isDefault: true },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
  {
    provider: "claudeAgent",
    enabled: true,
    installed: true,
    version: "0.1.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: "opus",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "default",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: ["ultrathink"],
        },
      },
      {
        slug: "haiku",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: true,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  },
];
