import { type ThreadId } from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import {
  ensureInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../../lib/terminalContext";
import {
  composerImageDedupKey,
  createEmptyThreadDraft,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  revokeObjectPreviewUrl,
  shouldRemoveDraft,
  terminalContextDedupKey,
} from "./normalization.store";
import { verifyPersistedAttachments } from "./persistence.store";
import {
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerImageAttachment,
} from "./types.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

/** Composer content actions: prompt, terminal contexts, images, and attachment persistence. */
export function createComposerContentActions(
  set: SetFn,
  get: GetFn,
  composerDebouncedStorageFlush: () => void,
) {
  return {
    setPrompt: (threadId: ThreadId, prompt: string) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    insertTerminalContext: (
      threadId: ThreadId,
      prompt: string,
      context: TerminalContextDraft,
      index: number,
    ) => {
      if (threadId.length === 0) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => {
      if (threadId.length === 0) {
        return;
      }
      get().addTerminalContexts(threadId, [context]);
    },
    addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => {
      if (threadId.length === 0 || contexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadId: ThreadId, contextId: string) => {
      if (threadId.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearTerminalContexts: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addImage: (threadId: ThreadId, image: ComposerImageAttachment) => {
      if (threadId.length === 0) {
        return;
      }
      get().addImages(threadId, [image]);
    },
    addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => {
      if (threadId.length === 0 || images.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.images.map((image) => image.id));
        const existingDedupKeys = new Set(
          existing.images.map((image) => composerImageDedupKey(image)),
        );
        const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
        const dedupedIncoming: ComposerImageAttachment[] = [];
        for (const image of images) {
          const dedupKey = composerImageDedupKey(image);
          if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
            // Avoid revoking a blob URL that's still referenced by an accepted image.
            if (!acceptedPreviewUrls.has(image.previewUrl)) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
            continue;
          }
          dedupedIncoming.push(image);
          existingIds.add(image.id);
          existingDedupKeys.add(dedupKey);
          acceptedPreviewUrls.add(image.previewUrl);
        }
        if (dedupedIncoming.length === 0) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: {
              ...existing,
              images: [...existing.images, ...dedupedIncoming],
            },
          },
        };
      });
    },
    removeImage: (threadId: ThreadId, imageId: string) => {
      if (threadId.length === 0) {
        return;
      }
      const existing = get().draftsByThreadId[threadId];
      if (!existing) {
        return;
      }
      const removedImage = existing.images.find((image) => image.id === imageId);
      if (removedImage) {
        revokeObjectPreviewUrl(removedImage.previewUrl);
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          images: current.images.filter((image) => image.id !== imageId),
          nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
          persistedAttachments: current.persistedAttachments.filter(
            (attachment) => attachment.id !== imageId,
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    addFile: (threadId: ThreadId, file: ComposerFileAttachment) => {
      if (threadId.length === 0) {
        return;
      }
      get().addFiles(threadId, [file]);
    },
    addFiles: (threadId: ThreadId, files: ComposerFileAttachment[]) => {
      if (threadId.length === 0 || files.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
        const existingIds = new Set(existing.files.map((f) => f.id));
        const existingPaths = new Set(existing.files.map((f) => f.filePath).filter(Boolean));
        const deduped: ComposerFileAttachment[] = [];
        for (const file of files) {
          if (existingIds.has(file.id)) continue;
          if (file.filePath && existingPaths.has(file.filePath)) continue;
          deduped.push(file);
          existingIds.add(file.id);
          if (file.filePath) existingPaths.add(file.filePath);
        }
        if (deduped.length === 0) return state;
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...existing, files: [...existing.files, ...deduped] },
          },
        };
      });
    },
    removeFile: (threadId: ThreadId, fileId: string) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) return state;
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          files: current.files.filter((f) => f.id !== fileId),
          persistedFileAttachments: current.persistedFileAttachments.filter((f) => f.id !== fileId),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    clearPersistedAttachments: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          persistedAttachments: [],
          nonPersistedImageIds: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    syncPersistedAttachments: (
      threadId: ThreadId,
      attachments: PersistedComposerImageAttachment[],
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const attachmentIdSet = new Set(
        attachments.map((attachment: PersistedComposerImageAttachment) => attachment.id),
      );
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          // Stage attempted attachments so persist middleware can try writing them.
          persistedAttachments: attachments,
          nonPersistedImageIds: current.nonPersistedImageIds.filter(
            (id) => !attachmentIdSet.has(id),
          ),
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
      Promise.resolve().then(() => {
        verifyPersistedAttachments(threadId, attachments, composerDebouncedStorageFlush, set);
      });
    },
    clearComposerContent: (threadId: ThreadId) => {
      if (threadId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: "",
          images: [],
          files: [],
          nonPersistedImageIds: [],
          persistedAttachments: [],
          persistedFileAttachments: [],
          terminalContexts: [],
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
    setBootstrapSourceThreadId: (
      threadId: ThreadId,
      sourceThreadId: ThreadId | null | undefined,
    ) => {
      if (threadId.length === 0) {
        return;
      }
      const normalizedSourceThreadId = sourceThreadId ?? null;
      set((state) => {
        const existing = state.draftsByThreadId[threadId];
        if (!existing && normalizedSourceThreadId === null) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...(existing ?? createEmptyThreadDraft()),
          bootstrapSourceThreadId: normalizedSourceThreadId,
        };
        const nextDraftsByThreadId = { ...state.draftsByThreadId };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadId[threadId];
        } else {
          nextDraftsByThreadId[threadId] = nextDraft;
        }
        return { draftsByThreadId: nextDraftsByThreadId };
      });
    },
  };
}
