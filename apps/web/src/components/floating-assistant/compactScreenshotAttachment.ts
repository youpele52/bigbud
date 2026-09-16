import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { CompactChatScreenshot } from "@bigbud/contracts/server/ipc.desktopScreenshot.ts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@bigbud/contracts/orchestration/orchestration.provider";

import {
  flushComposerDraftPersistence,
  useComposerDraftStore,
} from "~/stores/composer/composer.store";
import { hydrateImagesFromPersisted } from "~/stores/composer/persistence.store";

/** Append through the same draft representation used by pasted and restored images. */
export function attachCompactScreenshot(screenshot: CompactChatScreenshot, threadId: ThreadId) {
  if (screenshot.threadId !== threadId) {
    throw new Error(
      "This screenshot belongs to another floating chat. Reopen that chat or discard it.",
    );
  }
  const store = useComposerDraftStore.getState();
  const draft = store.draftsByThreadId[threadId];
  if (draft?.images.some((image) => image.id === screenshot.id)) return;
  if (
    (draft?.images.length ?? 0) + (draft?.files.length ?? 0) >=
    PROVIDER_SEND_TURN_MAX_ATTACHMENTS
  ) {
    throw new Error(
      `Remove an attachment before adding this screenshot (limit: ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}).`,
    );
  }
  if (
    screenshot.sizeBytes <= 0 ||
    screenshot.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
    !screenshot.dataUrl.startsWith("data:image/jpeg;base64,")
  ) {
    throw new Error("The captured screenshot is invalid or exceeds the image attachment limit.");
  }
  const [image] = hydrateImagesFromPersisted([screenshot]);
  if (!image || image.file.size !== screenshot.sizeBytes) {
    throw new Error("The captured screenshot could not be read. Discard it and try again.");
  }
  store.addImage(threadId, image);
  store.syncPersistedAttachments(threadId, [
    ...(useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? []),
    {
      id: screenshot.id,
      name: screenshot.name,
      mimeType: screenshot.mimeType,
      sizeBytes: screenshot.sizeBytes,
      dataUrl: screenshot.dataUrl,
    },
  ]);
  try {
    flushComposerDraftPersistence();
  } catch {
    // The existing persistence verifier marks images that cannot survive a reload.
    // They remain usable in the current draft, with the normal composer warning.
  }
}
