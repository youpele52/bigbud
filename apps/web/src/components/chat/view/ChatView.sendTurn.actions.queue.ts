import type { readNativeApi } from "../../../rpc/nativeApi";
import { toastManager } from "../../ui/toast";

import { revokeUserMessagePreviewUrls } from "./ChatView.logic";
import { isCurrentComposerDraftEmpty } from "./ChatView.sendTurn.actions.shared";
import { changedQueuedPromptSettings } from "./ChatView.sendTurn.admission.logic";
import {
  buildTurnAttachments,
  restoreMessageComposerDraftAfterFailure,
} from "./ChatView.sendTurn.helpers";
import {
  notifyOmittedTerminalContexts,
  prepareComposerPrompt,
  type PreparedComposerPrompt,
} from "./ChatView.sendTurn.prepare";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

function restoreQueuedDraft(input: {
  readonly sendInput: UseOnSendInput;
  readonly prepared: PreparedComposerPrompt;
  readonly replyTarget: UseOnSendInput["replyTarget"];
  readonly threadId: NonNullable<UseOnSendInput["activeThread"]>["id"];
}) {
  const { sendInput, prepared } = input;
  restoreMessageComposerDraftAfterFailure({
    currentDraftEmpty: isCurrentComposerDraftEmpty({
      promptRef: sendInput.promptRef,
      composerImagesRef: sendInput.composerImagesRef,
      composerFilesRef: sendInput.composerFilesRef,
      composerAnnotationsRef: sendInput.composerAnnotationsRef,
      composerTerminalContextsRef: sendInput.composerTerminalContextsRef,
    }),
    messageIdForSend: null,
    promptText: prepared.promptText,
    promptRef: sendInput.promptRef,
    replyTarget: input.replyTarget,
    composerImages: prepared.images,
    composerFiles: prepared.files,
    composerAnnotations: prepared.annotations,
    composerTerminalContexts: prepared.terminalContexts,
    setOptimisticUserMessages: sendInput.setOptimisticUserMessages,
    revokeUserMessagePreviewUrls,
    setPrompt: sendInput.setPrompt,
    setComposerCursor: sendInput.setComposerCursor,
    addComposerImagesToDraft: sendInput.addComposerImagesToDraft,
    addComposerFilesToDraft: sendInput.addComposerFilesToDraft,
    addComposerAnnotationsToDraft: sendInput.addComposerAnnotationsToDraft,
    addComposerTerminalContextsToDraft: sendInput.addComposerTerminalContextsToDraft,
    setReplyTarget: (replyTarget) => sendInput.setReplyTarget(input.threadId, replyTarget),
    setComposerTrigger: sendInput.setComposerTrigger,
  });
}

/**
 * Queues a composer send while a turn runs. The queue panel shows it, so there is no optimistic
 * bubble and the thread's settings are left alone; the draft comes back if the queue refuses it.
 */
export async function queueComposerTurn(input: {
  readonly api: NonNullable<ReturnType<typeof readNativeApi>>;
  readonly sendInput: UseOnSendInput;
  readonly resetComposerDraft: () => void;
}) {
  const { sendInput } = input;
  const thread = sendInput.activeThread;
  if (!thread) return;
  const prepared = await prepareComposerPrompt(input);
  if (!prepared) return;
  const replyTarget = sendInput.replyTarget;
  input.resetComposerDraft();
  notifyOmittedTerminalContexts(prepared.expiredTerminalContextCount);
  try {
    const attachments = await buildTurnAttachments(prepared.images, prepared.files);
    const result = await sendInput.submitQueuedComposerPrompt({
      text: prepared.outgoingMessageText,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
      ...changedQueuedPromptSettings(sendInput, thread),
    });
    if (result === "queued") return;
    if (result === "full") {
      toastManager.add({
        type: "warning",
        title: "Prompt queue is full",
        description: "Send or remove a queued prompt before adding another.",
      });
    }
    restoreQueuedDraft({ sendInput, prepared, replyTarget, threadId: thread.id });
  } catch (error) {
    restoreQueuedDraft({ sendInput, prepared, replyTarget, threadId: thread.id });
    sendInput.setThreadError(
      thread.id,
      error instanceof Error ? error.message : "Failed to queue the prompt.",
    );
  }
}
