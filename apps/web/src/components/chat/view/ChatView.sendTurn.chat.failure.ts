import type { MessageId, NativeApi, ThreadId } from "@bigbud/contracts";

import type { MaterializationAttempt } from "../../../stores/materialization/materializationLedger";
import { revokeUserMessagePreviewUrls } from "./ChatView.logic";
import { restoreMessageComposerDraftAfterFailure } from "./ChatView.sendTurn.helpers";
import { isCurrentComposerDraftEmpty } from "./ChatView.sendTurn.actions.shared";
import {
  classifyMaterializationFailure,
  reconcileAcceptedMaterializationFailure,
  repairRejectedMaterializationDraft,
} from "./ChatView.sendTurn.materialization";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

export async function handleChatSendFailure(input: {
  readonly api: Pick<NativeApi, "orchestration">;
  readonly sendInput: UseOnSendInput;
  readonly error: unknown;
  readonly materializationAttempt: MaterializationAttempt | null;
  readonly turnStartSucceeded: boolean;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly promptText: string;
  readonly images: UseOnSendInput["composerImages"];
  readonly files: UseOnSendInput["composerFiles"];
  readonly annotations: UseOnSendInput["composerAnnotations"];
  readonly terminalContexts: UseOnSendInput["composerTerminalContexts"];
}): Promise<boolean> {
  const { sendInput } = input;
  const materializationFailure = await classifyMaterializationFailure(
    input.api,
    input.materializationAttempt,
  );
  if (materializationFailure === "accepted" && input.materializationAttempt) {
    await reconcileAcceptedMaterializationFailure(
      {
        threadId: input.threadId,
        onThreadMaterialized: sendInput.onThreadMaterialized,
      },
      input.materializationAttempt,
      "message",
    );
    return true;
  }
  restoreMessageComposerDraftAfterFailure({
    currentDraftEmpty:
      !input.turnStartSucceeded &&
      isCurrentComposerDraftEmpty({
        promptRef: sendInput.promptRef,
        composerImagesRef: sendInput.composerImagesRef,
        composerFilesRef: sendInput.composerFilesRef,
        composerAnnotationsRef: sendInput.composerAnnotationsRef,
        composerTerminalContextsRef: sendInput.composerTerminalContextsRef,
      }),
    messageIdForSend: input.messageId,
    promptText: input.promptText,
    promptRef: sendInput.promptRef,
    replyTarget: sendInput.replyTarget,
    composerImages: input.images,
    composerFiles: input.files,
    composerAnnotations: input.annotations,
    composerTerminalContexts: input.terminalContexts,
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
  if (materializationFailure !== "ambiguous") {
    await repairRejectedMaterializationDraft({
      api: input.api,
      error: input.error,
      threadId: input.threadId,
      contentKind: "prompt",
    });
  }
  sendInput.setThreadError(
    input.threadId,
    materializationFailure === "ambiguous"
      ? "Your prompt is safe. Send again to recover the previous outcome without duplicating it."
      : input.error instanceof Error
        ? input.error.message
        : "Failed to send message.",
  );
  if (sendInput.bootstrapSourceThreadId) {
    sendInput.clearBootstrapSourceThreadId(input.threadId);
  }
  return input.turnStartSucceeded;
}
