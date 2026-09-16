import {
  type ClaudeModelOptions,
  type PiModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
} from "@bigbud/contracts";
import {
  buildNextProviderOptions,
  getDefaultContextWindow,
  getRawProviderEffort,
  hasContextWindowOption,
  isClaudeUltrathinkPrompt,
  resolveEffort,
  trimOrNull,
} from "@bigbud/shared/model";
import { getProviderModelCapabilities } from "../../../models/provider";

type ProviderOptions = ProviderModelOptions[ProviderKind];

export const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

export function getRawEffort(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  return getRawProviderEffort(provider, modelOptions);
}

export function getRawContextWindow(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  if (provider === "claudeAgent") {
    return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.contextWindow);
  }
  return null;
}

export function getRawThinkingLevel(
  modelOptions: ProviderOptions | null | undefined,
): string | null {
  return trimOrNull((modelOptions as PiModelOptions | undefined)?.thinkingLevel);
}

export function buildNextOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  return buildNextProviderOptions(provider, modelOptions, patch);
}

export function buildNextPiThinkingOptions(
  modelOptions: ProviderOptions | null | undefined,
  thinkingLevel: PiModelOptions["thinkingLevel"] | undefined,
): PiModelOptions | undefined {
  const nextOptions = { ...(modelOptions as PiModelOptions | undefined) };
  if (thinkingLevel === undefined) {
    delete nextOptions.thinkingLevel;
  } else {
    nextOptions.thinkingLevel = thinkingLevel;
  }
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function getSelectedTraits(
  provider: ProviderKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  subProviderID?: string | null,
) {
  const caps = getProviderModelCapabilities(models, model, provider, subProviderID);
  const effortLevels = allowPromptInjectedEffort
    ? [
        ...caps.reasoningEffortLevels,
        ...caps.promptInjectedEffortLevels
          .filter((value) => !caps.reasoningEffortLevels.some((option) => option.value === value))
          .map((value) => ({
            value,
            label: value === "ultrathink" ? "Ultrathink" : value,
          })),
      ]
    : caps.reasoningEffortLevels.filter(
        (option) => !caps.promptInjectedEffortLevels.includes(option.value),
      );
  const rawEffort = getRawEffort(provider, modelOptions);
  const resolvedEffort = resolveEffort(caps, rawEffort) ?? null;
  const effort = effortLevels.length > 0 ? resolvedEffort : null;
  const thinkingLevel = provider === "pi" ? getRawThinkingLevel(modelOptions) : null;
  const thinkingLevels = provider === "pi" ? caps.reasoningEffortLevels : [];
  const workflowModes = provider === "claudeAgent" ? (caps.workflowModes ?? []) : [];
  const ultracodeEnabled =
    workflowModes.some((mode) => mode.value === "ultracode") &&
    (modelOptions as ClaudeModelOptions | undefined)?.ultracode === true;
  const thinkingEnabled = caps.supportsThinkingToggle
    ? ((modelOptions as ClaudeModelOptions | undefined)?.thinking ?? true)
    : null;
  const fastModeEnabled =
    caps.supportsFastMode &&
    (modelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const contextWindowOptions = caps.contextWindowOptions;
  const rawContextWindow = getRawContextWindow(provider, modelOptions);
  const defaultContextWindow = getDefaultContextWindow(caps);
  const contextWindow =
    rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
      ? rawContextWindow
      : defaultContextWindow;
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    caps.promptInjectedEffortLevels.length > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));

  return {
    caps,
    effort,
    thinkingLevel,
    thinkingLevels,
    workflowModes,
    ultracodeEnabled,
    effortLevels,
    thinkingEnabled,
    fastModeEnabled,
    contextWindowOptions,
    contextWindow,
    defaultContextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    hasEffortOptions: effortLevels.length > 0,
  };
}

export function hasConfigurableTraits(traits: ReturnType<typeof getSelectedTraits>): boolean {
  return (
    traits.hasEffortOptions ||
    traits.thinkingLevels.length > 0 ||
    traits.thinkingEnabled !== null ||
    traits.workflowModes.length > 0 ||
    traits.caps.supportsFastMode ||
    traits.contextWindowOptions.length > 1
  );
}

export type TraitsPickerProviderOptions = ProviderOptions;
