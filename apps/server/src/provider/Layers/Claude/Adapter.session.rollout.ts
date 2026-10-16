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

/** Alternate harnesses keep fixed rollout defaults; product sessions follow Claude settings. */
export function buildClaudeSessionRolloutOptions(
  harness: ClaudeHarnessConfig | undefined,
  settings: ClaudeRolloutSettings,
) {
  return {
    boundedHookProgress:
      harness?.boundedHookProgress ?? (harness ? false : settings.rollout.boundedHookProgress),
    forwardSubagentText:
      harness?.forwardSubagentText ?? (harness ? false : settings.rollout.forwardedSubagentText),
    ...(harness?.settingSources ? { settingSources: harness.settingSources } : {}),
    ...(harness?.environment ? { environment: harness.environment } : {}),
    ...(harness
      ? {}
      : {
          promptSuggestions: settings.promptSuggestions,
          subagentCaps: {
            maxSpawnDepth: settings.maxSubagentSpawnDepth ?? null,
            maxConcurrent: settings.maxConcurrentSubagents ?? null,
          },
        }),
  };
}
