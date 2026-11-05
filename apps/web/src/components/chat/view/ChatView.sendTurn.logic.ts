import { useCallback, useRef } from "react";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
import { readNativeApi } from "../../../rpc/nativeApi";
import { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import {
  queueComposerTurn,
  respondToPendingUserInput,
  sendChatTurn,
  sendShellCommand,
  submitPlanFollowUp,
} from "./ChatView.sendTurn.actions";
import { canQueueComposerPrompt } from "./ChatView.sendTurn.admission.logic";
import { isChatCitationAttachment } from "../../../stores/composer/types.annotation.store";
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
      const submittedInput = inputRef.current;
      const {
        activeThread: thread,
        isSendBusy: sendBusy,
        isConnecting: connecting,
        shouldQueuePrompt,
        isForceSend,
        sendInFlightRef: inFlightRef,
        promptRef: pRef,
        isComposerShellMode,
        showPlanFollowUpPrompt: planFollowUp,
        activeProposedPlan: proposedPlan,
        isOpencodePendingUserInputMode,
        activePendingUserInputRequestId,
        activePendingUserInput,
      } = submittedInput;

      if (!api || !thread) return;
      const attachmentIssue = providerAttachmentIssue(inputRef.current.selectedProvider, [
        ...inputRef.current.composerImages,
        ...inputRef.current.composerFiles,
      ]);
      if (attachmentIssue) {
        inputRef.current.setThreadError(thread.id, attachmentIssue);
        return;
      }
      const resetComposerDraft = (preserveCitations = false) => {
        // Structured answers cannot carry attachments. Keep quotes for a later chat turn.
        const citations = preserveCitations
          ? submittedInput.composerAnnotations.filter(isChatCitationAttachment)
          : [];
        submittedInput.clearComposerDraftContent(thread.id);
        if (citations.length > 0) submittedInput.addComposerAnnotationsToDraft(citations);
        if (inputRef.current.activeThread?.id !== thread.id) return;
        pRef.current = "";
        submittedInput.setComposerHighlightedItemId(null);
        submittedInput.setComposerCursor(0);
        submittedInput.setComposerTrigger(null);
      };
      const trimmed = pRef.current.trim();
      if (isOpencodePendingUserInputMode && activePendingUserInputRequestId) {
        await respondToPendingUserInput({
          activePendingUserInput,
          activePendingUserInputRequestId,
          onRespondToUserInput: inputRef.current.onRespondToUserInput,
          resetComposerDraft: () => resetComposerDraft(true),
          trimmed,
        });
        return;
      }
      if (
        canQueueComposerPrompt({
          ...inputRef.current,
          shouldQueuePrompt: shouldQueuePrompt(),
          planFollowUp,
        })
      ) {
        await queueComposerTurn({ api, sendInput: inputRef.current, resetComposerDraft });
        return;
      }
      if ((sendBusy && !isForceSend() && !shouldQueuePrompt()) || connecting || inFlightRef.current)
        return;
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
