import {
  type ClaudeModelOptions,
  type CopilotModelOptions,
  type CodexModelOptions,
  type OpencodeModelOptions,
  type PiModelOptions,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProviderModel,
} from "@bigbud/contracts";
import {
  getDefaultContextWindow,
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
  if (provider === "codex") {
    return trimOrNull((modelOptions as CodexModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "copilot") {
    return trimOrNull((modelOptions as CopilotModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "opencode") {
    return trimOrNull((modelOptions as OpencodeModelOptions | undefined)?.reasoningEffort);
  }
  if (provider === "pi") {
    return null;
  }
  return trimOrNull((modelOptions as ClaudeModelOptions | undefined)?.effort);
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
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  if (provider === "copilot") {
    return {
      ...(modelOptions as CopilotModelOptions | undefined),
      ...patch,
    } as CopilotModelOptions;
  }
  if (provider === "opencode") {
    return {
      ...(modelOptions as OpencodeModelOptions | undefined),
      ...patch,
    } as OpencodeModelOptions;
  }
  if (provider === "pi") {
    return { ...(modelOptions as PiModelOptions | undefined), ...patch } as PiModelOptions;
  }
  return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
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
) {
  const caps = getProviderModelCapabilities(models, model, provider);
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
  const effort = resolveEffort(caps, rawEffort) ?? null;
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
  };
}

export type TraitsPickerProviderOptions = ProviderOptions;
