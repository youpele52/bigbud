import type {
  ClaudeModelOptions,
  CopilotModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  DevinModelOptions,
  KilocodeModelOptions,
  ModelCapabilities,
  OpencodeModelOptions,
  PiModelOptions,
} from "@bigbud/contracts";

import { resolveContextWindow } from "./model.context";
import { hasEffortLevel, resolveEffort } from "./model.effort";
import { trimOrNull } from "./model.strings";

export function normalizeCodexModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CodexModelOptions | null | undefined,
): CodexModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const nextOptions: CodexModelOptions = {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeClaudeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: ClaudeModelOptions | null | undefined,
): ClaudeModelOptions | undefined {
  const rawEffort = trimOrNull(modelOptions?.effort);
  const effort =
    rawEffort && caps.promptInjectedEffortLevels.includes(rawEffort)
      ? rawEffort
      : resolveEffort(caps, rawEffort);
  const ultracode = caps.workflowModes?.some((mode) => mode.value === "ultracode")
    ? modelOptions?.ultracode
    : undefined;
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: ClaudeModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(effort ? { effort: effort as ClaudeModelOptions["effort"] } : {}),
    ...(ultracode !== undefined ? { ultracode } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeCopilotModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CopilotModelOptions | null | undefined,
): CopilotModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  return reasoningEffort
    ? {
        reasoningEffort: reasoningEffort as CopilotModelOptions["reasoningEffort"],
      }
    : undefined;
}

export function normalizeOpencodeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: OpencodeModelOptions | null | undefined,
): OpencodeModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  return reasoningEffort ? { reasoningEffort } : undefined;
}

export function normalizeKilocodeModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: KilocodeModelOptions | null | undefined,
): KilocodeModelOptions | undefined {
  const reasoningEffort = resolveEffort(caps, modelOptions?.reasoningEffort);
  return reasoningEffort ? { reasoningEffort } : undefined;
}

export function normalizeCursorModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: CursorModelOptions | null | undefined,
): CursorModelOptions | undefined {
  const reasoning = resolveEffort(
    caps,
    modelOptions?.reasoning ??
      (modelOptions as CursorModelOptions & { reasoningEffort?: string })?.reasoningEffort,
  );
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: CursorModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizeDevinModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: DevinModelOptions | null | undefined,
): DevinModelOptions | undefined {
  const reasoning = resolveEffort(
    caps,
    modelOptions?.reasoning ??
      (modelOptions as DevinModelOptions & { reasoningEffort?: string })?.reasoningEffort,
  );
  const thinking = caps.supportsThinkingToggle ? modelOptions?.thinking : undefined;
  const fastMode = caps.supportsFastMode ? modelOptions?.fastMode : undefined;
  const contextWindow = resolveContextWindow(caps, modelOptions?.contextWindow);
  const nextOptions: DevinModelOptions = {
    ...(thinking !== undefined ? { thinking } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(fastMode !== undefined ? { fastMode } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
}

export function normalizePiModelOptionsWithCapabilities(
  caps: ModelCapabilities,
  modelOptions: PiModelOptions | null | undefined,
): PiModelOptions | undefined {
  const thinkingLevel = trimOrNull(modelOptions?.thinkingLevel);
  return thinkingLevel && hasEffortLevel(caps, thinkingLevel)
    ? { thinkingLevel: thinkingLevel as PiModelOptions["thinkingLevel"] }
    : undefined;
}
