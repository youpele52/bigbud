import { useCallback, useRef } from "react";
import { readNativeApi } from "../../../rpc/nativeApi";
import { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
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
        sendInFlightRef: inFlightRef,
        promptRef: pRef,
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
      if (sendBusy || connecting || inFlightRef.current) return;
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
