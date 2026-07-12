import { useEffect } from "react";

import { type PersistedComposerImageAttachment, useComposerDraftStore } from "~/stores/composer";

import { readFileAsDataUrl } from "../ChatView.logic";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";

export function usePersistComposerImageAttachments(base: ChatViewBaseState) {
  const {
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  } = base;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];

      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(threadId, Array.from(stagedAttachmentById.values()));
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(
          threadId,
          fallbackPersistedAttachments.filter((attachment) => currentImageIds.has(attachment.id)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);
}
