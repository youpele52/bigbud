import type { ClaudeHarnessConfig } from "./Adapter.types.ts";

interface ClaudeRolloutSettings {
  readonly rollout: {
    readonly boundedHookProgress: boolean;
    readonly forwardedSubagentText: boolean;
  };
  readonly promptSuggestions: boolean;
  readonly maxSubagentSpawnDepth?: number | null | undefined;
  readonly maxConcurrentSubagents?: number | null | undefined;
}

/** Model connections share Claude Code rollout settings unless explicitly overridden. */
export function buildClaudeSessionRolloutOptions(
  harness: ClaudeHarnessConfig | undefined,
  settings: ClaudeRolloutSettings,
) {
  return {
    boundedHookProgress: harness?.boundedHookProgress ?? settings.rollout.boundedHookProgress,
    forwardSubagentText: harness?.forwardSubagentText ?? settings.rollout.forwardedSubagentText,
    ...(harness?.settingSources ? { settingSources: harness.settingSources } : {}),
    ...(harness?.environment ? { environment: harness.environment } : {}),
    ...(harness?.protectedSettingsEnvironment
      ? { protectedSettingsEnvironment: harness.protectedSettingsEnvironment }
      : {}),
    ...(harness?.modelCapabilities ? { modelCapabilities: harness.modelCapabilities } : {}),
    promptSuggestions: settings.promptSuggestions,
    subagentCaps: {
      maxSpawnDepth: settings.maxSubagentSpawnDepth ?? null,
      maxConcurrent: settings.maxConcurrentSubagents ?? null,
    },
  };
}
