import type { MessageId } from "@bigbud/contracts";

import { isChatCitationAttachment } from "../../../../stores/composer/types.annotation.store";
import { ComposerAnnotationPreviews } from "../../composer/ComposerAnnotationPreviews";
import { ComposerFilePreviews } from "../../composer/ComposerFilePreviews";
import { ComposerImagePreviews } from "../../composer/ComposerImagePreviews";
import { ComposerReplyPreview } from "../../composer/ComposerReplyPreview";
import { clearComposerSurfaceAnnotations } from "./ChatViewComposer.annotations";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

export function ChatViewComposerPreviews({
  base,
  composer,
  thread,
  onOpenReplySource,
}: {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  onOpenReplySource: (messageId: MessageId) => void;
}) {
  if (thread.isComposerApprovalState) return null;
  const pendingAnswer = thread.isOpencodePendingUserInputMode;
  const replyTarget = base.composerDraft.replyTarget;
  return (
    <>
      {!pendingAnswer && (
        <>
          {replyTarget && !thread.showPlanFollowUpPrompt && !base.composerDraft.shellMode && (
            <ComposerReplyPreview
              replyTarget={replyTarget}
              onClear={() => base.setComposerReplyTarget(base.activeThread!.id, null)}
              onOpenSource={() => onOpenReplySource(replyTarget.messageId)}
            />
          )}
          <ComposerImagePreviews
            composerImages={base.composerImages}
            nonPersistedComposerImageIdSet={composer.nonPersistedComposerImageIdSet}
            onRemoveImage={base.removeComposerImageFromDraft}
            onExpandImage={base.setExpandedImage}
          />
        </>
      )}
      <ComposerAnnotationPreviews
        annotations={
          pendingAnswer
            ? base.composerAnnotations.filter(isChatCitationAttachment)
            : base.composerAnnotations
        }
        images={base.composerImages}
        onRemoveAnnotation={base.removeComposerAnnotationFromDraft}
        onClearAnnotations={() => clearComposerSurfaceAnnotations(base)}
      />
      {!pendingAnswer && (
        <ComposerFilePreviews
          composerFiles={base.composerFiles}
          resolvedTheme={base.resolvedTheme}
          onRemoveFile={base.removeComposerFileFromDraft}
          onToggleWatchForCompletion={base.toggleComposerFileWatchForCompletion}
        />
      )}
    </>
  );
}
