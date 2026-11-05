import type { ModelCapabilities } from "@bigbud/contracts/core/model";
import { formatEffortLabel } from "@bigbud/shared/model";

export const UNKNOWN_CLIPROXY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// Only expose levels the Claude harness can transmit, intersected with the live catalog.
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Excludes prompt-injected modes and levels the Claude transport cannot send. */
export function isCliProxyNativeEffort(value: string): boolean {
  return CLAUDE_EFFORT_LEVELS.has(value);
}

/** Reads native catalog metadata without inferring capabilities from model names. */
export function decodeCliProxyCapabilities(
  levels: unknown,
  defaultLevel: unknown,
): ModelCapabilities | undefined {
  if (!Array.isArray(levels)) return undefined;
  const values = new Set<string>();
  for (const level of levels) {
    if (!level || typeof level !== "object" || typeof level.effort !== "string") {
      return undefined;
    }
    if (isCliProxyNativeEffort(level.effort)) values.add(level.effort);
  }
  return {
    ...UNKNOWN_CLIPROXY_CAPABILITIES,
    reasoningEffortLevels: [...values].map((value) => {
      const option: { value: string; label: string; isDefault?: boolean } = {
        value,
        label: formatEffortLabel(value),
      };
      if (value === defaultLevel) option.isDefault = true;
      return option;
    }),
    effortMetadataStatus: values.size > 0 ? "verified-supported" : "verified-unsupported",
    effortMetadataOrigin: "live",
  };
}

/** Enables only advertised effort features for the selected custom wire model. */
export function cliProxyModelEnvironment(model: string, capabilities: ModelCapabilities) {
  const levels = capabilities.reasoningEffortLevels.map((option) => option.value);
  return {
    ANTHROPIC_CUSTOM_MODEL_OPTION: model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: [
      ...(levels.length > 0 ? ["effort"] : []),
      ...(levels.includes("xhigh") ? ["xhigh_effort"] : []),
      ...(levels.includes("max") ? ["max_effort"] : []),
    ].join(","),
  };
}
