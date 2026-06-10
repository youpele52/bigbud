import type { DevinModelOptions, ModelCapabilities, ServerProviderModel } from "@bigbud/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  type DevinAcpDiscoveredModel,
  type DevinSessionSelectOption,
  EMPTY_CAPABILITIES,
} from "./Provider.shared.ts";

export function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<DevinSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() } satisfies DevinSessionSelectOption]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies DevinSessionSelectOption,
        ),
  );
}

function normalizeDevinReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

export function findDevinModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function getDevinConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isDevinEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findDevinEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isDevinEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getDevinConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getDevinConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isDevinContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isDevinFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isDevinThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

export function buildDevinCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findDevinEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeDevinReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeDevinReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return { value: entry.value, label: entry.name, isDefault: true };
          }
          return { value: entry.value, label: entry.name };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinThinkingConfigOption(option),
  );

  return {
    reasoningEffortLevels,
    supportsFastMode: fastOption ? isBooleanLikeConfigOption(fastOption) : false,
    supportsThinkingToggle: thinkingOption ? isBooleanLikeConfigOption(thinkingOption) : false,
    contextWindowOptions,
    promptInjectedEffortLevels: [],
  };
}

export function buildDevinDiscoveredModels(
  discoveredModels: ReadonlyArray<DevinAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

export function hasDevinModelCapabilities(
  model: Pick<ServerProviderModel, "capabilities">,
): boolean {
  return (
    (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
    model.capabilities?.supportsFastMode === true ||
    model.capabilities?.supportsThinkingToggle === true ||
    (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
    (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0
  );
}

export function buildDevinDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelOption = findDevinModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }

  const currentModelValue =
    modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
  const currentModelCapabilities = buildDevinCapabilitiesFromConfigOptions(configOptions);

  return buildDevinDiscoveredModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

function normalizeDevinConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findDevinSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: DevinSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findDevinBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findDevinSelectOptionValue(
    configOption,
    (option) => normalizeDevinConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "default";
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveDevinAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelOptions: DevinModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];

  const reasoningOption = findDevinEffortConfigOption(configOptions);
  const requestedReasoning = normalizeDevinReasoningValue(modelOptions?.reasoning);
  if (reasoningOption && requestedReasoning) {
    const value = findDevinSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeDevinReasoningValue(option.value);
      const normalizedName = normalizeDevinReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinContextConfigOption(option),
  );
  if (contextOption && modelOptions?.contextWindow) {
    const value = findDevinSelectOptionValue(
      contextOption,
      (option) =>
        normalizeDevinConfigOptionToken(option.value) ===
          normalizeDevinConfigOptionToken(modelOptions.contextWindow) ||
        normalizeDevinConfigOptionToken(option.name) ===
          normalizeDevinConfigOptionToken(modelOptions.contextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinFastConfigOption(option),
  );
  if (fastOption && typeof modelOptions?.fastMode === "boolean") {
    const value = findDevinBooleanConfigValue(fastOption, modelOptions.fastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isDevinThinkingConfigOption(option),
  );
  if (thinkingOption && typeof modelOptions?.thinking === "boolean") {
    const value = findDevinBooleanConfigValue(thinkingOption, modelOptions.thinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}
