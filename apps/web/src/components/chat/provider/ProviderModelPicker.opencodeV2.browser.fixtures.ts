import type { ServerProvider } from "@bigbud/contracts";

/** A ready shared OpenCode v2 snapshot with one native model, capable of remote workspaces. */
export function opencodeV2SnapshotFixture(): ServerProvider {
  return {
    provider: "opencodeV2",
    enabled: true,
    installed: true,
    version: "2.0.26",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-30T00:00:00.000Z",
    models: [
      {
        slug: "synthetic",
        name: "Synthetic V2 model",
        subProviderID: "synthetic",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [],
          supportsFastMode: false,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
      },
    ],
    slashCommands: [],
    skills: [],
    supportsLocalRuntimeRemoteWorkspace: true,
  };
}
