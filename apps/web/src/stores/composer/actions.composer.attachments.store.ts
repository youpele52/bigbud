import { type ThreadId } from "@bigbud/contracts";
import type { StoreApi } from "zustand";
import {
  composerImageDedupKey,
  createEmptyThreadDraft,
  revokeObjectPreviewUrl,
  shouldRemoveDraft,
} from "./normalization.store";
import { verifyPersistedAttachments } from "./persistence.store";
import {
  type ComposerDraftStoreState,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type PersistedComposerImageAttachment,
} from "./types.store";
import { isBrowserAnnotationAttachment } from "./types.annotation.store";

type SetFn = StoreApi<ComposerDraftStoreState>["setState"];
type GetFn = StoreApi<ComposerDraftStoreState>["getState"];

export function createComposerAttachmentActions(
  set: SetFn,
  get: GetFn,
  composerDebouncedStorageFlush: () => void,
) {
  return {
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
          annotations: current.annotations.filter(
            (annotation) =>
              !isBrowserAnnotationAttachment(annotation) || annotation.imageId !== imageId,
          ),
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
        const existingIds = new Set(existing.files.map((file) => file.id));
        const existingPaths = new Set(existing.files.map((file) => file.filePath).filter(Boolean));
        const deduped: ComposerFileAttachment[] = [];
        for (const file of files) {
          if (existingIds.has(file.id)) continue;
          if (file.filePath && existingPaths.has(file.filePath)) continue;
          deduped.push(file);
          existingIds.add(file.id);
          if (file.filePath) {
            existingPaths.add(file.filePath);
          }
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
          files: current.files.filter((file) => file.id !== fileId),
          persistedFileAttachments: current.persistedFileAttachments.filter(
            (file) => file.id !== fileId,
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
      const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
      set((state) => {
        const current = state.draftsByThreadId[threadId];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
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
  };
}
