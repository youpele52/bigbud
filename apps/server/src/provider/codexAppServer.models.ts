import type { ModelCapabilities } from "@bigbud/contracts/core/model.ts";
import type { ServerProviderModel } from "@bigbud/contracts/server/server.providers.ts";
import { withEffortProvenance } from "@bigbud/shared/model";

import { providerModelsFromSettings } from "./providerSnapshot";
import { nonEmptyTrimmed, readArray, readObject } from "./codexAppServer.parse";

export const UNVERIFIED_CODEX_MODEL_CAPABILITIES: ModelCapabilities = withEffortProvenance(
  {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
  "unknown",
  "unknown",
);

function titleCaseReasoningEffort(value: string): string {
  if (value === "xhigh") {
    return "Extra High";
  }
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function parseCodexReasoningEffortLevels(
  model: Record<string, unknown>,
): ModelCapabilities["reasoningEffortLevels"] {
  const effortEntries = readArray(model.supportedReasoningEfforts) ?? [];
  const defaultEffort = nonEmptyTrimmed(model.defaultReasoningEffort);
  const seen = new Set<string>();

  return effortEntries.flatMap((entry) => {
    const effort = nonEmptyTrimmed(readObject(entry)?.reasoningEffort) ?? nonEmptyTrimmed(entry);
    if (!effort || seen.has(effort)) {
      return [];
    }
    seen.add(effort);

    return [
      {
        value: effort,
        label: titleCaseReasoningEffort(effort),
        ...(effort === defaultEffort ? { isDefault: true } : {}),
      },
    ];
  });
}

export function parseCodexModelCapabilities(model: Record<string, unknown>): ModelCapabilities {
  const additionalSpeedTiers = readArray(model.additionalSpeedTiers) ?? [];
  const serviceTiers = readArray(model.serviceTiers) ?? [];
  const reasoningEffortLevels = parseCodexReasoningEffortLevels(model);
  const advertised = readArray(model.supportedReasoningEfforts);
  return withEffortProvenance(
    {
      ...UNVERIFIED_CODEX_MODEL_CAPABILITIES,
      reasoningEffortLevels,
      supportsFastMode:
        additionalSpeedTiers.some((entry) => nonEmptyTrimmed(entry) === "fast") ||
        serviceTiers.length > 0,
    },
    advertised === undefined
      ? "unknown"
      : reasoningEffortLevels.length > 0
        ? "verified-supported"
        : "verified-unsupported",
    advertised === undefined ? "unknown" : "live",
  );
}

export function includeConfiguredCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    models,
    "codex",
    customModels,
    UNVERIFIED_CODEX_MODEL_CAPABILITIES,
  );
}

export function parseCodexModelsResult(
  result: unknown,
): ReadonlyArray<ServerProviderModel> | undefined {
  const rawModels = readArray(readObject(result)?.data);
  if (!rawModels) {
    return undefined;
  }

  return rawModels.flatMap((value) => {
    const model = readObject(value);
    if (!model || model.hidden === true) {
      return [];
    }

    const slug = nonEmptyTrimmed(model.model) ?? nonEmptyTrimmed(model.id);
    if (!slug) {
      return [];
    }

    return [
      {
        slug,
        name: nonEmptyTrimmed(model.displayName) ?? slug,
        isCustom: false,
        capabilities: parseCodexModelCapabilities(model),
      } satisfies ServerProviderModel,
    ];
  });
}
