import type { ThreadId } from "@bigbud/contracts";
import { DeepMutable } from "effect/Types";
import { getLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerDraftStoreState,
  type PersistedComposerFileAttachment,
  type PersistedComposerImageAttachment,
  type PersistedComposerThreadDraftState,
  PersistedComposerDraftStoreStorage,
} from "./types.store";
import { normalizeProviderKind, shouldRemoveDraft } from "./normalization.store";

// ── Storage helpers ───────────────────────────────────────────────────

export function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

export function verifyPersistedAttachments(
  threadId: ThreadId,
  attachments: PersistedComposerImageAttachment[],
  composerDebouncedStorageFlush: () => void,
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorageFlush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadId[threadId];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds = current.images
      .map((image) => image.id)
      .filter((imageId) => !persistedIdSet.has(imageId));
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadId = { ...state.draftsByThreadId };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadId[threadId];
    } else {
      nextDraftsByThreadId[threadId] = nextDraft;
    }
    return { draftsByThreadId: nextDraftsByThreadId };
  });
}

// ── Partialize (state → persisted shape) ─────────────────────────────

export function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadId"]
  > = {};
  for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.annotations.length === 0 &&
      draft.terminalContexts.length === 0 &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null &&
      (draft.bootstrapSourceThreadId ?? null) === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.persistedFileAttachments.length > 0
        ? { fileAttachments: draft.persistedFileAttachments }
        : {}),
      ...(draft.annotations.length > 0 ? { annotations: draft.annotations } : {}),
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: draft.modelSelectionByProvider,
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
      ...(draft.bootstrapSourceThreadId !== null
        ? { bootstrapSourceThreadId: draft.bootstrapSourceThreadId }
        : {}),
    };
    persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
  }
  return {
    draftsByThreadId: persistedDraftsByThreadId,
    draftThreadsByThreadId: state.draftThreadsByThreadId,
    projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

// ── Hydration helpers ─────────────────────────────────────────────────

export function hydratePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

export function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydratePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

export function toHydratedThreadDraft(
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider = persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderKind(persistedDraft.activeProvider) ?? null;
  const persistedFileAttachments: PersistedComposerFileAttachment[] = persistedDraft.fileAttachments
    ? [...persistedDraft.fileAttachments]
    : [];

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files: hydrateFilesFromPersisted(persistedFileAttachments),
    annotations: persistedDraft.annotations ? [...persistedDraft.annotations] : [],
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    persistedFileAttachments,
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
    bootstrapSourceThreadId: persistedDraft.bootstrapSourceThreadId ?? null,
  };
}

/** Hydrate persisted file attachments back into ComposerFileAttachment objects. */
export function hydrateFilesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerFileAttachment>,
): ComposerFileAttachment[] {
  return attachments.map((attachment) => ({
    type: "file" as const,
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    filePath: attachment.filePath,
    file: null,
  }));
}
