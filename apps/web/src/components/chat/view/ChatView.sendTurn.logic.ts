import { useCallback, useEffect, useRef } from "react";
import { ownSendInput } from "./ChatView.sendTurn.lifetime";
import { useThreadSurfaceLifetime } from "./ChatView.threadLifetime";
import { providerAttachmentIssue } from "@bigbud/shared/providerAttachments";
import { readNativeApi } from "../../../rpc/nativeApi";
import { useRemoteExecutionAccessGate } from "../../../hooks/useRemoteExecutionAccessGate";
import {
  queueComposerTurn,
  sendChatTurn,
  sendShellCommand,
  submitPlanFollowUp,
} from "./ChatView.sendTurn.actions";
import { canQueueComposerPrompt } from "./ChatView.sendTurn.admission.logic";
import type { UseOnSendInput } from "./ChatView.sendTurn.types";

import {
  claimComposerSend,
  matchesComposerContent,
  type PendingComposerSend,
} from "./ChatView.sendTurn.pending";

/** Returns the `onSend` handler for the composer form. */
export function useOnSend(input: UseOnSendInput) {
  // Stable ref to avoid stale closure in the returned function
  const inputRef = useRef(input);
  inputRef.current = input;
  const { ensureRemoteExecutionTargetAccess } = useRemoteExecutionAccessGate();
  const pending = useRef(new Set<PendingComposerSend>());
  const captureSurface = useThreadSurfaceLifetime(input.activeThread?.id);
  useEffect(() => {
    // This ref is surface-local; the durable ledger still owns the old thread's send.
    input.sendInFlightRef.current = false;
  }, [input.activeThread?.id, input.sendInFlightRef]);

  const onSend = useCallback(
    async (e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      const api = readNativeApi();
      const rawInput = inputRef.current;
      const targetThread = rawInput.activeThread;
      if (!targetThread) return;
      if (!api) {
        rawInput.setThreadError(
          targetThread.id,
          "bigbud is not connected to the server. Your draft is safe.",
        );
        return;
      }
      const isCurrent = captureSurface();
      const submittedInput = ownSendInput(rawInput, isCurrent);
      const queued = canQueueComposerPrompt({
        ...submittedInput,
        shouldQueuePrompt: submittedInput.shouldQueuePrompt(),
        planFollowUp: submittedInput.showPlanFollowUpPrompt,
      });
      const claim = claimComposerSend(pending.current, submittedInput, queued);
      if (!claim) return;
      try {
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
        } = submittedInput;

        if (!api || !thread) return;
        const attachmentIssue = providerAttachmentIssue(submittedInput.selectedProvider, [
          ...submittedInput.composerImages,
          ...submittedInput.composerFiles,
        ]);
        if (attachmentIssue) {
          submittedInput.setThreadError(thread.id, attachmentIssue);
          return;
        }
        const resetComposerDraft = () => {
          claim.consume();
          // Acknowledgements must not erase edits made while a preflight was pending.
          if (!matchesComposerContent(submittedInput, claim.content)) return;
          submittedInput.clearComposerDraftContent(thread.id);
          if (!isCurrent()) return;
          pRef.current = "";
          submittedInput.setComposerHighlightedItemId(null);
          submittedInput.setComposerCursor(0);
          submittedInput.setComposerTrigger(null);
        };
        const trimmed = pRef.current.trim();
        if (connecting) {
          submittedInput.setThreadError(
            thread.id,
            "bigbud is reconnecting. Your draft is safe; retry after it connects.",
          );
          return;
        }
        if (queued) {
          await queueComposerTurn({ api, sendInput: submittedInput, resetComposerDraft });
          return;
        }
        if (submittedInput.hasPendingProviderRequest) {
          submittedInput.setThreadError(
            thread.id,
            "Resolve the pending request before sending this draft.",
          );
          return;
        }
        if ((sendBusy && !isForceSend() && !shouldQueuePrompt()) || inFlightRef.current) {
          submittedInput.setThreadError(
            thread.id,
            "A send is already in progress. Your draft is safe.",
          );
          return;
        }
        if (planFollowUp && proposedPlan) {
          await submitPlanFollowUp({
            proposedPlan,
            onSubmitPlanFollowUp: submittedInput.onSubmitPlanFollowUp,
            resetComposerDraft,
            trimmed,
          });
          return;
        }
        if (isComposerShellMode) {
          await sendShellCommand({
            api,
            input: submittedInput,
            onSend: async () => {
              if (isCurrent()) await onSend();
            },
            resetComposerDraft,
            ensureRemoteExecutionTargetAccess,
          });
          return;
        }
        await sendChatTurn({
          api,
          input: submittedInput,
          onSend: async () => {
            if (isCurrent()) await onSend();
          },
          resetComposerDraft,
          ensureRemoteExecutionTargetAccess,
        });
      } finally {
        claim.release();
      }
    },
    [captureSurface, ensureRemoteExecutionTargetAccess],
  );

  return onSend;
}
