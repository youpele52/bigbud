import {
  PROVIDER_KINDS,
  type ModelSelection,
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
import {
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacyReplaceProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderModelOptions,
} from "./normalization.store.models";
import {
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type EffectiveComposerModelState,
} from "./types.store";

// ── Empty draft factory ───────────────────────────────────────────────

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    shellMode: false,
    images: [],
    files: [],
    annotations: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    persistedFileAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    bootstrapSourceThreadId: null,
    replyTarget: null,
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
    !draft.shellMode &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.annotations.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null &&
    (draft.bootstrapSourceThreadId ?? null) === null &&
    draft.replyTarget === null
  );
}

// ── Provider / model option normalization ─────────────────────────────

export function normalizeProviderKind(value: unknown): ProviderKind | null {
  return typeof value === "string" && PROVIDER_KINDS.includes(value as ProviderKind)
    ? (value as ProviderKind)
    : null;
}

export {
  legacyMergeModelSelectionIntoProviderModelOptions,
  legacyReplaceProviderModelOptions,
  legacySyncModelSelectionOptions,
  legacyToModelSelectionByProvider,
  normalizeModelSelection,
  normalizeProviderModelOptions,
};

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
