import {
  isBrowserAnnotationAttachment,
  isChatCitationAttachment,
} from "../../../../stores/composer/types.annotation.store";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

export function clearComposerSurfaceAnnotations(
  base: Pick<
    ChatViewBaseState,
    "composerAnnotations" | "removeComposerImageFromDraft" | "removeComposerAnnotationFromDraft"
  >,
) {
  for (const annotation of base.composerAnnotations) {
    if (isChatCitationAttachment(annotation)) continue;
    if (isBrowserAnnotationAttachment(annotation))
      base.removeComposerImageFromDraft(annotation.imageId);
    base.removeComposerAnnotationFromDraft(annotation.id);
  }
}
