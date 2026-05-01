import {
  DEFAULT_MODEL_BY_PROVIDER,
  PI_THINKING_LEVEL_OPTIONS,
  PROVIDER_KINDS,
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  type ModelSelection,
  type PiThinkingLevel,
  type ProviderKind,
  type ProviderModelOptions,
  type ServerProvider,
  type ThreadId,
} from "@bigbud/contracts";
import { normalizeModelSlug } from "@bigbud/shared/model";
import { resolveAppModelSelection } from "../../models/provider";
import { type TerminalContextDraft, normalizeTerminalContextText } from "../../lib/terminalContext";
import { getDefaultServerModel } from "../../models/provider";
import { UnifiedSettings } from "@bigbud/contracts/settings";
import { cloneModelSelection, createModelSelection } from "../../models/provider";
import {
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type EffectiveComposerModelState,
  type LegacyCodexFields,
} from "./types.store";

// ── Empty draft factory ───────────────────────────────────────────────

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    persistedFileAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    bootstrapSourceThreadId: null,
  };
}

// ── Dedup key helpers ─────────────────────────────────────────────────

export function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

export function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

// ── Terminal context normalization ────────────────────────────────────

export function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

export function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

// ── Draft sentinel helpers ────────────────────────────────────────────

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null &&
    (draft.bootstrapSourceThreadId ?? null) === null
  );
}

// ── Provider / model option normalization ─────────────────────────────

export function normalizeProviderKind(value: unknown): ProviderKind | null {
  return typeof value === "string" && PROVIDER_KINDS.includes(value as ProviderKind)
    ? (value as ProviderKind)
    : null;
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

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
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
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claudeContextWindow =
    typeof claudeCandidate?.contextWindow === "string" && claudeCandidate.contextWindow.length > 0
      ? claudeCandidate.contextWindow
      : undefined;
  const claude =
    claudeThinking !== undefined ||
    claudeEffort !== undefined ||
    claudeFastMode !== undefined ||
    claudeContextWindow !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(claudeContextWindow !== undefined ? { contextWindow: claudeContextWindow } : {}),
        }
      : undefined;

  const copilotCandidate = normalizeProviderOptionsCandidate(candidate?.copilot);
  const copilotReasoningEffort: CodexReasoningEffort | undefined =
    copilotCandidate?.reasoningEffort === "low" ||
    copilotCandidate?.reasoningEffort === "medium" ||
    copilotCandidate?.reasoningEffort === "high" ||
    copilotCandidate?.reasoningEffort === "xhigh"
      ? copilotCandidate.reasoningEffort
      : undefined;
  const copilot =
    copilotReasoningEffort !== undefined ? { reasoningEffort: copilotReasoningEffort } : undefined;

  const opencodeCandidate = normalizeProviderOptionsCandidate(candidate?.opencode);
  const opencodeReasoningEffort: CodexReasoningEffort | undefined =
    opencodeCandidate?.reasoningEffort === "low" ||
    opencodeCandidate?.reasoningEffort === "medium" ||
    opencodeCandidate?.reasoningEffort === "high" ||
    opencodeCandidate?.reasoningEffort === "xhigh"
      ? opencodeCandidate.reasoningEffort
      : undefined;
  const opencode =
    opencodeReasoningEffort !== undefined
      ? { reasoningEffort: opencodeReasoningEffort }
      : undefined;

  const piCandidate = normalizeProviderOptionsCandidate(candidate?.pi);
  const piThinkingLevel: PiThinkingLevel | undefined =
    typeof piCandidate?.thinkingLevel === "string" &&
    PI_THINKING_LEVEL_OPTIONS.includes(piCandidate.thinkingLevel as PiThinkingLevel)
      ? (piCandidate.thinkingLevel as PiThinkingLevel)
      : undefined;
  const pi = piThinkingLevel !== undefined ? { thinkingLevel: piThinkingLevel } : undefined;

  const cursorCandidate = normalizeProviderOptionsCandidate(candidate?.cursor);
  const cursorReasoning: CodexReasoningEffort | undefined =
    cursorCandidate?.reasoning === "low" ||
    cursorCandidate?.reasoning === "medium" ||
    cursorCandidate?.reasoning === "high" ||
    cursorCandidate?.reasoning === "xhigh"
      ? cursorCandidate.reasoning
      : undefined;
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

  if (!codex && !claude && !copilot && !opencode && !pi && !cursor) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(copilot ? { copilot } : {}),
    ...(opencode ? { opencode } : {}),
    ...(pi ? { pi } : {}),
    ...(cursor ? { cursor } : {}),
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
  const provider = normalizeProviderKind(candidate?.provider ?? legacy?.provider);
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
          : provider === "pi"
            ? modelOptions?.pi
            : provider === "cursor"
              ? modelOptions?.cursor
              : modelOptions?.copilot;
  const baseSelection = createModelSelection(provider, model, options);
  const rawSubProviderID = candidate?.subProviderID;
  return (provider === "opencode" || provider === "pi") &&
    typeof rawSubProviderID === "string" &&
    rawSubProviderID.length > 0
    ? ({ ...baseSelection, subProviderID: rawSubProviderID } as ModelSelection)
    : baseSelection;
}

// ── Legacy sync helpers (used only during migration from v2 storage) ──

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

// ── New helpers for the consolidated representation ────────────────────

export function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  // Add entries from the options bag (for non-active providers)
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
  // Add/overwrite the active selection (it's authoritative for its provider)
  if (modelSelection) {
    result[modelSelection.provider] = modelSelection;
  }
  return result;
}

// ── Derived model state helper ────────────────────────────────────────

export function modelSelectionByProviderToOptions(
  map: Partial<Record<ProviderKind, ModelSelection>> | null | undefined,
): ProviderModelOptions | null {
  if (!map) return null;
  const result: Record<string, unknown> = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

export function providerModelOptionsFromSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderModelOptions | null {
  if (!modelSelection?.options) {
    return null;
  }

  return {
    [modelSelection.provider]: modelSelection.options,
  };
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModel =
    normalizeModelSlug(
      input.threadModelSelection?.model ?? input.projectModelSelection?.model,
      input.selectedProvider,
    ) ?? getDefaultServerModel(input.providers, input.selectedProvider);
  const activeSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const selectedModel = activeSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      )
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerModelOptionsFromSelection(input.threadModelSelection) ??
    providerModelOptionsFromSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

// ── Blob URL helper ───────────────────────────────────────────────────

export function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

// NOTE: persisted-value normalizers (normalizePersistedAttachment,
// normalizePersistedTerminalContextDraft, normalizeDraftThreadEnvMode,
// normalizePersistedDraftThreads, normalizePersistedDraftsByThreadId)
// live in composerDraftStore.normalizers.ts
