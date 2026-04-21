import type {
  ModelSelection,
  ProviderKind,
  RuntimeMode,
  ServerProvider,
  ThreadId,
} from "@bigbud/contracts";
import { truncate } from "@bigbud/shared/String";
import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "../../../rpc/nativeApi";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
} from "../../../logic/proposed-plan";
import type { ChatMessage, Project, Thread } from "../../../models/types";
import { toastManager } from "../../ui/toast";
import { waitForStartedServerThread } from "./ChatView.logic";
import { formatOutgoingPrompt } from "./ChatView.logic";

export interface UsePlanHandlersInput {
  activeThread: Thread | undefined;
  activeProject: Project | null | undefined;
  activeProposedPlan: { id: string; planMarkdown: string } | null | undefined;
  isServerThread: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  sendInFlightRef: React.RefObject<boolean>;
  planSidebarDismissedForTurnRef: React.RefObject<string | null>;
  planSidebarOpenOnNextThreadRef: React.RefObject<boolean>;
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  shouldAutoScrollRef: React.RefObject<boolean>;
  setOptimisticUserMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPlanSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setThreadError: (threadId: ThreadId, error: string | null) => void;
  setComposerDraftInteractionMode: (threadId: ThreadId, mode: "default" | "plan") => void;
  beginLocalDispatch: (options?: { preparingWorktree?: boolean }) => void;
  resetLocalDispatch: () => void;
  forceStickToBottom: () => void;
  persistThreadSettingsForNextTurn: (input: {
    threadId: ThreadId;
    createdAt: string;
    modelSelection?: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: "default" | "plan";
  }) => Promise<void>;
}

export interface UsePlanHandlersResult {
  onSubmitPlanFollowUp: (params: {
    text: string;
    interactionMode: "default" | "plan";
  }) => Promise<void>;
  onImplementPlanInNewThread: () => Promise<void>;
}

/** Handles plan follow-up submission and new-thread plan implementation. */
export function usePlanHandlers({
  activeThread,
  activeProject,
  activeProposedPlan,
  isServerThread,
  isSendBusy,
  isConnecting,
  sendInFlightRef,
  planSidebarDismissedForTurnRef,
  planSidebarOpenOnNextThreadRef,
  selectedProvider,
  selectedModel,
  selectedProviderModels,
  selectedPromptEffort,
  selectedModelSelection,
  runtimeMode,
  shouldAutoScrollRef,
  setOptimisticUserMessages,
  setPlanSidebarOpen,
  setThreadError,
  setComposerDraftInteractionMode,
  beginLocalDispatch,
  resetLocalDispatch,
  forceStickToBottom,
  persistThreadSettingsForNextTurn,
}: UsePlanHandlersInput): UsePlanHandlersResult {
  const navigate = useNavigate();

  const onSubmitPlanFollowUp = useCallback(
    async ({
      text,
      interactionMode: nextInteractionMode,
    }: {
      text: string;
      interactionMode: "default" | "plan";
    }) => {
      const api = readNativeApi();
      if (
        !api ||
        !activeThread ||
        !isServerThread ||
        isSendBusy ||
        isConnecting ||
        sendInFlightRef.current
      ) {
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }

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
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          createdAt: messageCreatedAt,
          streaming: false,
        },
      ]);
      shouldAutoScrollRef.current = true;
      forceStickToBottom();

      try {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode: nextInteractionMode,
        });

        // Keep the mode toggle and plan-follow-up banner in sync immediately
        // while the same-thread implementation turn is starting.
        setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

        await api.orchestration.dispatchCommand({
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
                sourceProposedPlan: {
                  threadId: activeThread.id,
                  planId: activeProposedPlan.id,
                },
              }
            : {}),
          createdAt: messageCreatedAt,
        });
        // Optimistically open the plan sidebar when implementing (not refining).
        // "default" mode here means the agent is executing the plan, which produces
        // step-tracking activities that the sidebar will display.
        if (nextInteractionMode === "default") {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        sendInFlightRef.current = false;
      } catch (err) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== messageIdForSend),
        );
        setThreadError(
          threadIdForSend,
          err instanceof Error ? err.message : "Failed to send plan follow-up.",
        );
        sendInFlightRef.current = false;
        resetLocalDispatch();
      }
    },
    [
      activeThread,
      activeProposedPlan,
      beginLocalDispatch,
      forceStickToBottom,
      isConnecting,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      planSidebarDismissedForTurnRef,
      resetLocalDispatch,
      runtimeMode,
      selectedPromptEffort,
      selectedModelSelection,
      selectedProvider,
      selectedProviderModels,
      setOptimisticUserMessages,
      setComposerDraftInteractionMode,
      setThreadError,
      selectedModel,
      sendInFlightRef,
      shouldAutoScrollRef,
      setPlanSidebarOpen,
    ],
  );

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncate(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt,
      })
      .then(() => {
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          modelSelection: selectedModelSelection,
          titleSeed: nextThreadTitle,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: {
            threadId: activeThread.id,
            planId: activeProposedPlan.id,
          },
          createdAt,
        });
      })
      .then(() => {
        return waitForStartedServerThread(nextThreadId);
      })
      .then(() => {
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    activeProject,
    activeProposedPlan,
    activeThread,
    beginLocalDispatch,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    planSidebarOpenOnNextThreadRef,
    resetLocalDispatch,
    runtimeMode,
    selectedPromptEffort,
    selectedModelSelection,
    selectedProvider,
    selectedProviderModels,
    selectedModel,
    sendInFlightRef,
  ]);

  return { onSubmitPlanFollowUp, onImplementPlanInNewThread };
}
