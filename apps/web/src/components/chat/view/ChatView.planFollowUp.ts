import { useCallback, useRef } from "react";
import { readNativeApi } from "../../../rpc/nativeApi";
import { newCommandId, newMessageId } from "../../../lib/utils";
import { formatOutgoingPrompt } from "./ChatView.logic";
import { dispatchPlanFollowUp } from "./ChatView.planFollowUp.dispatch";
import { useThreadSurfaceLifetime } from "./ChatView.threadLifetime";
import type { UsePlanHandlersInput, UsePlanHandlersResult } from "./ChatView.planHandlers.logic";

export function usePlanFollowUp(
  input: UsePlanHandlersInput,
): UsePlanHandlersResult["onSubmitPlanFollowUp"] {
  const latest = useRef(input);
  latest.current = input;
  const captureSurface = useThreadSurfaceLifetime(input.activeThread?.id);
  return useCallback(
    async ({ text, interactionMode: nextInteractionMode }) => {
      const {
        activeThread,
        activeProposedPlan,
        isServerThread,
        isConnecting,
        sendInFlightRef,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
        selectedPromptEffort,
        selectedModelSelection,
        runtimeMode,
        beginLocalDispatch,
        setThreadError,
        setOptimisticUserMessages,
        shouldAutoScrollRef,
        forceStickToBottom,
        persistThreadSettingsForNextTurn,
        setComposerDraftInteractionMode,
        resetLocalDispatch,
        planCardDismissedForTurnRef,
        setPlanCardOpen,
      } = latest.current;
      const api = readNativeApi();
      if (!api || !activeThread || !isServerThread || isConnecting || sendInFlightRef.current)
        return false;
      const trimmed = text.trim();
      if (!trimmed) return false;
      const isCurrent = captureSurface();
      const threadIdForSend = activeThread.id;
      const messageIdForSend = newMessageId();
      const messageCreatedAt = new Date().toISOString();
      const outgoingMessageText = formatOutgoingPrompt({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        effort: selectedPromptEffort,
        text: trimmed,
      });
      sendInFlightRef.current = true;
      beginLocalDispatch({ preparingWorktree: false });
      setThreadError(threadIdForSend, null);
      let optimisticMessageId = messageIdForSend;
      const removeOptimistic = () => {
        if (isCurrent())
          setOptimisticUserMessages((existing) =>
            existing.filter((message) => message.id !== optimisticMessageId),
          );
      };
      try {
        const accepted = await dispatchPlanFollowUp({
          api,
          projectId: activeThread.projectId,
          setThreadError,
          beforeDispatch: async (messageId) => {
            optimisticMessageId = messageId;
            if (isCurrent()) {
              setOptimisticUserMessages((existing) => [
                ...existing,
                {
                  id: messageId,
                  role: "user",
                  text: outgoingMessageText,
                  createdAt: messageCreatedAt,
                  streaming: false,
                },
              ]);
              shouldAutoScrollRef.current = true;
              forceStickToBottom();
            }
            await persistThreadSettingsForNextTurn({
              threadId: threadIdForSend,
              createdAt: messageCreatedAt,
              modelSelection: selectedModelSelection,
              runtimeMode,
              interactionMode: nextInteractionMode,
            });
            setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);
          },
          command: {
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: [],
            },
            modelSelection: selectedModelSelection,
            titleSeed: activeThread.title,
            runtimeMode,
            interactionMode: nextInteractionMode,
            ...(nextInteractionMode === "default" && activeProposedPlan
              ? {
                  sourceProposedPlan: { threadId: activeThread.id, planId: activeProposedPlan.id },
                }
              : {}),
            createdAt: messageCreatedAt,
          },
        });
        if (!accepted) {
          removeOptimistic();
          if (isCurrent()) resetLocalDispatch();
          return false;
        }
        if (isCurrent() && nextInteractionMode === "default") {
          planCardDismissedForTurnRef.current = null;
          setPlanCardOpen(true);
        }
        return true;
      } catch (error) {
        removeOptimistic();
        setThreadError(
          threadIdForSend,
          error instanceof Error ? error.message : "Failed to send plan follow-up.",
        );
        if (isCurrent()) resetLocalDispatch();
        return false;
      } finally {
        if (isCurrent()) sendInFlightRef.current = false;
      }
    },
    [captureSurface],
  );
}
