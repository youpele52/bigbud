import { useCallback, useRef } from "react";
import { readNativeApi } from "../../../rpc/nativeApi";
import { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import { toastManager } from "../../ui/toast";
import {
  respondToPendingUserInput,
  sendChatTurn,
  sendShellCommand,
  submitPlanFollowUp,
} from "./ChatView.sendTurn.actions";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

/** Returns the `onSend` handler for the composer form. */
export function useOnSend(input: UseOnSendInput) {
  // Stable ref to avoid stale closure in the returned function
  const inputRef = useRef(input);
  inputRef.current = input;
  const { ensureRemoteExecutionTargetAccess } = useRemoteExecutionAccessGate();

  const onSend = useCallback(
    async (e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      const api = readNativeApi();
      const {
        activeThread: thread,
        isSendBusy: sendBusy,
        isConnecting: connecting,
        shouldQueuePrompt,
        isForceSend,
        sendInFlightRef: inFlightRef,
        promptRef: pRef,
        composerImages,
        composerFiles,
        composerAnnotations,
        composerTerminalContexts,
        isComposerShellMode,
        showPlanFollowUpPrompt: planFollowUp,
        activeProposedPlan: proposedPlan,
        isOpencodePendingUserInputMode,
        activePendingUserInputRequestId,
        activePendingUserInput,
      } = inputRef.current;

      if (!api || !thread) return;
      const resetComposerDraft = () => {
        pRef.current = "";
        inputRef.current.clearComposerDraftContent(thread.id);
        inputRef.current.setComposerHighlightedItemId(null);
        inputRef.current.setComposerCursor(0);
        inputRef.current.setComposerTrigger(null);
      };
      const trimmed = pRef.current.trim();
      if (isOpencodePendingUserInputMode && activePendingUserInputRequestId) {
        await respondToPendingUserInput({
          activePendingUserInput,
          activePendingUserInputRequestId,
          onRespondToUserInput: inputRef.current.onRespondToUserInput,
          resetComposerDraft,
          trimmed,
        });
        return;
      }
      if (shouldQueuePrompt()) {
        if (
          composerImages.length > 0 ||
          composerFiles.length > 0 ||
          composerAnnotations.length > 0 ||
          composerTerminalContexts.length > 0
        ) {
          toastManager.add({
            type: "warning",
            title: "Attachments cannot be queued",
            description: "Wait for the current turn to finish before sending attachments.",
          });
          return;
        }
        const queueResult = inputRef.current.queueComposerPrompt(trimmed);
        if (queueResult === "queued") {
          resetComposerDraft();
        } else if (queueResult === "full") {
          toastManager.add({
            type: "warning",
            title: "Prompt queue is full",
            description: "Send or remove a queued prompt before adding another.",
          });
        }
        return;
      }
      if ((sendBusy && !isForceSend()) || connecting || inFlightRef.current) return;
      if (planFollowUp && proposedPlan) {
        await submitPlanFollowUp({
          proposedPlan,
          onSubmitPlanFollowUp: inputRef.current.onSubmitPlanFollowUp,
          resetComposerDraft,
          trimmed,
        });
        return;
      }
      if (isComposerShellMode) {
        await sendShellCommand({
          api,
          input: inputRef.current,
          onSend: async () => onSend(),
          resetComposerDraft,
          ensureRemoteExecutionTargetAccess,
        });
        return;
      }
      await sendChatTurn({
        api,
        input: inputRef.current,
        onSend: async () => onSend(),
        resetComposerDraft,
        ensureRemoteExecutionTargetAccess,
      });
    },
    [ensureRemoteExecutionTargetAccess],
  );

  return onSend;
}
