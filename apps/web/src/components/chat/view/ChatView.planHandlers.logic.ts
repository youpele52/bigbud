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
import { dispatchCommandWithOutcomeRecovery } from "~/lib/orchestrationCommandRecovery";
import { readNativeApi } from "../../../rpc/nativeApi";
import { buildExplicitExecutionTargets } from "../../../lib/providerExecutionTargets";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
} from "../../../logic/proposed-plan";
import type { ChatMessage, Project, Thread } from "../../../models/types";
import { toastManager } from "../../ui/toast";
import { waitForStartedServerThread } from "./ChatView.logic";
import { formatOutgoingPrompt } from "./ChatView.logic";
import { usePlanFollowUp } from "./ChatView.planFollowUp";

export interface UsePlanHandlersInput {
  activeThread: Thread | undefined;
  activeProject: Project | null | undefined;
  activeProposedPlan: { id: string; planMarkdown: string } | null | undefined;
  isServerThread: boolean;
  isSendBusy: boolean;
  isConnecting: boolean;
  sendInFlightRef: React.RefObject<boolean>;
  planCardDismissedForTurnRef: React.RefObject<string | null>;
  planCardOpenOnNextThreadRef: React.RefObject<boolean>;
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  selectedPromptEffort: string | null;
  selectedModelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  shouldAutoScrollRef: React.RefObject<boolean>;
  setOptimisticUserMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setPlanCardOpen: React.Dispatch<React.SetStateAction<boolean>>;
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
  }) => Promise<boolean>;
  onImplementPlanInNewThread: () => Promise<void>;
}

/** Handles plan follow-up submission and new-thread plan implementation. */
export function usePlanHandlers(input: UsePlanHandlersInput): UsePlanHandlersResult {
  const {
    activeThread,
    activeProject,
    activeProposedPlan,
    isServerThread,
    isSendBusy,
    isConnecting,
    sendInFlightRef,
    planCardOpenOnNextThreadRef,
    selectedProvider,
    selectedModel,
    selectedProviderModels,
    selectedPromptEffort,
    selectedModelSelection,
    runtimeMode,
    beginLocalDispatch,
    resetLocalDispatch,
  } = input;
  const navigate = useNavigate();

  const onSubmitPlanFollowUp = usePlanFollowUp(input);

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
    const executionTargets = buildExplicitExecutionTargets({
      providerRuntimeExecutionTargetId:
        activeThread.providerRuntimeExecutionTargetId ??
        activeProject.providerRuntimeExecutionTargetId,
      workspaceExecutionTargetId:
        activeThread.workspaceExecutionTargetId ?? activeProject.workspaceExecutionTargetId,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: false });
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await dispatchCommandWithOutcomeRecovery(api, {
      type: "thread.create",
      commandId: newCommandId(),
      threadId: nextThreadId,
      projectId: activeProject.id,
      title: nextThreadTitle,
      ...executionTargets,
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
        // Signal that the floating plan card should open on the new thread.
        planCardOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        await dispatchCommandWithOutcomeRecovery(api, {
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: nextThreadId,
        }).catch(() => undefined);
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
    planCardOpenOnNextThreadRef,
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
