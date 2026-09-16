import {
  DEFAULT_MODEL_BY_PROVIDER,
  PI_THINKING_LEVEL_OPTIONS,
  PROVIDER_KINDS,
  type CodexReasoningEffort,
  type CopilotModelOptions,
  type ModelSelection,
  type PiThinkingLevel,
  type ProviderKind,
  type ProviderModelOptions,
} from "@bigbud/contracts";
import { normalizeModelSlug, trimOrNull } from "@bigbud/shared/model";

import { cloneModelSelection, createModelSelection } from "../../models/provider";
import { type LegacyCodexFields } from "./types.store";

function normalizeOpaqueEffort(value: unknown): string | undefined {
  return typeof value === "string" ? (trimOrNull(value) ?? undefined) : undefined;
}

function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return typeof value === "string" ? (trimOrNull(value) ?? undefined) : undefined;
}

function normalizeProviderOptionsCandidate(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const options: Record<string, unknown> = {};
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const { id, value: optionValue } = entry as Record<string, unknown>;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        options[id] = optionValue;
      }
    }
    return Object.keys(options).length > 0 ? options : null;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate = normalizeProviderOptionsCandidate(candidate?.codex);
  const claudeCandidate = normalizeProviderOptionsCandidate(candidate?.claudeAgent);

  const codexReasoningEffort =
    normalizeCodexReasoningEffort(codexCandidate?.reasoningEffort) ??
    (provider === "codex" ? normalizeCodexReasoningEffort(legacy?.effort) : undefined);
  const codexFastMode =
    codexCandidate?.fastMode === true
      ? true
      : codexCandidate?.fastMode === false
        ? false
        : (provider === "codex" && legacy?.codexFastMode === true) ||
            (typeof legacy?.serviceTier === "string" && legacy.serviceTier === "fast")
          ? true
          : undefined;
  const codex =
    codexReasoningEffort !== undefined || codexFastMode !== undefined
      ? {
          ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
        }
      : undefined;

  const claudeThinking =
    claudeCandidate?.thinking === true
      ? true
      : claudeCandidate?.thinking === false
        ? false
        : undefined;
  const claudeEffort =
    typeof claudeCandidate?.effort === "string" && claudeCandidate.effort.trim().length > 0
      ? claudeCandidate.effort.trim()
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claudeUltracode =
    claudeCandidate?.ultracode === true
      ? true
      : claudeCandidate?.ultracode === false
        ? false
        : undefined;
  const claudeContextWindow =
    typeof claudeCandidate?.contextWindow === "string" && claudeCandidate.contextWindow.length > 0
      ? claudeCandidate.contextWindow
      : undefined;
  const claude =
    claudeThinking !== undefined ||
    claudeEffort !== undefined ||
    claudeUltracode !== undefined ||
    claudeFastMode !== undefined ||
    claudeContextWindow !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeUltracode !== undefined ? { ultracode: claudeUltracode } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(claudeContextWindow !== undefined ? { contextWindow: claudeContextWindow } : {}),
        }
      : undefined;

  const copilotCandidate = normalizeProviderOptionsCandidate(candidate?.copilot);
  const copilotReasoningEffort =
    copilotCandidate?.reasoningEffort === "low" ||
    copilotCandidate?.reasoningEffort === "medium" ||
    copilotCandidate?.reasoningEffort === "high" ||
    copilotCandidate?.reasoningEffort === "xhigh"
      ? copilotCandidate.reasoningEffort
      : undefined;
  const copilot =
    copilotReasoningEffort !== undefined
      ? { reasoningEffort: copilotReasoningEffort as CopilotModelOptions["reasoningEffort"] }
      : undefined;

  const opencodeCandidate = normalizeProviderOptionsCandidate(candidate?.opencode);
  const opencodeReasoningEffort = normalizeOpaqueEffort(opencodeCandidate?.reasoningEffort);
  const opencode =
    opencodeReasoningEffort !== undefined
      ? { reasoningEffort: opencodeReasoningEffort }
      : undefined;

  const kilocodeCandidate = normalizeProviderOptionsCandidate(candidate?.kilocode);
  const kilocodeReasoningEffort = normalizeOpaqueEffort(kilocodeCandidate?.reasoningEffort);
  const kilocode =
    kilocodeReasoningEffort !== undefined
      ? { reasoningEffort: kilocodeReasoningEffort }
      : undefined;

  const piCandidate = normalizeProviderOptionsCandidate(candidate?.pi);
  const piThinkingLevel: PiThinkingLevel | undefined =
    typeof piCandidate?.thinkingLevel === "string" &&
    PI_THINKING_LEVEL_OPTIONS.includes(piCandidate.thinkingLevel as PiThinkingLevel)
      ? (piCandidate.thinkingLevel as PiThinkingLevel)
      : undefined;
  const pi = piThinkingLevel !== undefined ? { thinkingLevel: piThinkingLevel } : undefined;

  const cursorCandidate = normalizeProviderOptionsCandidate(candidate?.cursor);
  const cursorReasoning =
    normalizeOpaqueEffort(cursorCandidate?.reasoning) ??
    normalizeOpaqueEffort(cursorCandidate?.reasoningEffort);
  const cursorContextWindow =
    typeof cursorCandidate?.contextWindow === "string" && cursorCandidate.contextWindow.length > 0
      ? cursorCandidate.contextWindow
      : undefined;
  const cursorFastMode =
    cursorCandidate?.fastMode === true
      ? true
      : cursorCandidate?.fastMode === false
        ? false
        : undefined;
  const cursorThinking =
    cursorCandidate?.thinking === true
      ? true
      : cursorCandidate?.thinking === false
        ? false
        : undefined;
  const cursor =
    cursorReasoning !== undefined ||
    cursorContextWindow !== undefined ||
    cursorFastMode !== undefined ||
    cursorThinking !== undefined
      ? {
          ...(cursorReasoning !== undefined ? { reasoning: cursorReasoning } : {}),
          ...(cursorContextWindow !== undefined ? { contextWindow: cursorContextWindow } : {}),
          ...(cursorFastMode !== undefined ? { fastMode: cursorFastMode } : {}),
          ...(cursorThinking !== undefined ? { thinking: cursorThinking } : {}),
        }
      : undefined;

  const devinCandidate = normalizeProviderOptionsCandidate(candidate?.devin);
  const devinReasoning =
    normalizeOpaqueEffort(devinCandidate?.reasoning) ??
    normalizeOpaqueEffort(devinCandidate?.reasoningEffort);
  const devinContextWindow =
    typeof devinCandidate?.contextWindow === "string" && devinCandidate.contextWindow.length > 0
      ? devinCandidate.contextWindow
      : undefined;
  const devinFastMode =
    devinCandidate?.fastMode === true
      ? true
      : devinCandidate?.fastMode === false
        ? false
        : undefined;
  const devinThinking =
    devinCandidate?.thinking === true
      ? true
      : devinCandidate?.thinking === false
        ? false
        : undefined;
  const devin =
    devinReasoning !== undefined ||
    devinContextWindow !== undefined ||
    devinFastMode !== undefined ||
    devinThinking !== undefined
      ? {
          ...(devinReasoning !== undefined ? { reasoning: devinReasoning } : {}),
          ...(devinContextWindow !== undefined ? { contextWindow: devinContextWindow } : {}),
          ...(devinFastMode !== undefined ? { fastMode: devinFastMode } : {}),
          ...(devinThinking !== undefined ? { thinking: devinThinking } : {}),
        }
      : undefined;

  if (!codex && !claude && !copilot && !opencode && !kilocode && !pi && !cursor && !devin) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(copilot ? { copilot } : {}),
    ...(opencode ? { opencode } : {}),
    ...(kilocode ? { kilocode } : {}),
    ...(pi ? { pi } : {}),
    ...(cursor ? { cursor } : {}),
    ...(devin ? { devin } : {}),
  };
}

export function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): ModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider =
    typeof (candidate?.provider ?? legacy?.provider) === "string" &&
    PROVIDER_KINDS.includes((candidate?.provider ?? legacy?.provider) as ProviderKind)
      ? ((candidate?.provider ?? legacy?.provider) as ProviderKind)
      : null;
  if (provider === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const model = normalizeModelSlug(rawModel, provider);
  if (!model) {
    return null;
  }
  const modelOptions = normalizeProviderModelOptions(
    candidate?.options ? { [provider]: candidate.options } : legacy?.modelOptions,
    provider,
    provider === "codex" ? legacy?.legacyCodex : undefined,
  );
  const options =
    provider === "codex"
      ? modelOptions?.codex
      : provider === "claudeAgent"
        ? modelOptions?.claudeAgent
        : provider === "opencode"
          ? modelOptions?.opencode
          : provider === "kilocode"
            ? modelOptions?.kilocode
            : provider === "pi"
              ? modelOptions?.pi
              : provider === "cursor"
                ? modelOptions?.cursor
                : provider === "devin"
                  ? modelOptions?.devin
                  : modelOptions?.copilot;
  const baseSelection = createModelSelection(provider, model, options);
  const rawSubProviderID = candidate?.subProviderID;
  return (provider === "opencode" || provider === "kilocode" || provider === "pi") &&
    typeof rawSubProviderID === "string" &&
    rawSubProviderID.length > 0
    ? ({ ...baseSelection, subProviderID: rawSubProviderID } as ModelSelection)
    : baseSelection;
}

export function legacySyncModelSelectionOptions(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): ModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const options = modelOptions?.[modelSelection.provider];
  if (options === undefined) {
    const { options: _discardedOptions, ...rest } = modelSelection;
    return rest as ModelSelection;
  }
  return cloneModelSelection(modelSelection, { options } as Partial<ModelSelection>);
}

export function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: ModelSelection | null,
  currentModelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | null {
  if (modelSelection?.options === undefined) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    modelSelection.provider,
    modelSelection.options,
  );
}

export function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderModelOptions | null | undefined,
  provider: ProviderKind,
  nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const normalizedNextProviderOptions = normalizeProviderModelOptions(
    { [provider]: nextProviderOptions },
    provider,
  );

  return normalizeProviderModelOptions({
    ...otherProviderModelOptions,
    ...(normalizedNextProviderOptions ? normalizedNextProviderOptions : {}),
  });
}

export function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  if (modelOptions) {
    for (const provider of PROVIDER_KINDS) {
      const options = modelOptions[provider];
      if (options && Object.keys(options).length > 0) {
        result[provider] = createModelSelection(
          provider,
          modelSelection?.provider === provider
            ? modelSelection.model
            : DEFAULT_MODEL_BY_PROVIDER[provider],
          options,
        );
      }
    }
  }
  if (modelSelection) {
    result[modelSelection.provider] = modelSelection;
  }
  return result;
}
