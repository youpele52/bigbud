import { useRef } from "react";

import type { DraftThreadEnvMode } from "~/stores/composer";

import type { usePlanHandlers } from "../ChatView.planHandlers.logic";
import { usePromptQueue, type QueuePromptResult } from "../ChatView.promptQueue.logic";
import { useOnSend } from "../ChatView.sendTurn.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface UseChatViewPromptQueueInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
  envMode: DraftThreadEnvMode;
  planHandlers: Pick<ReturnType<typeof usePlanHandlers>, "onSubmitPlanFollowUp">;
}

export function shouldQueuePromptWhileWorking(input: {
  isWorking: boolean;
  forceSendQueuedPrompt: boolean;
}) {
  return input.isWorking && !input.forceSendQueuedPrompt;
}

export function isPromptQueueTurnInProgress(input: {
  activeSessionTurnRunning: boolean;
  isSendBusy: boolean;
  isRevertingCheckpoint: boolean;
  latestTurnSettled: boolean;
}) {
  return (
    input.activeSessionTurnRunning ||
    input.isSendBusy ||
    input.isRevertingCheckpoint ||
    !input.latestTurnSettled
  );
}

export function useChatViewPromptQueue({
  base,
  composer,
  thread,
  runtime,
  envMode,
  planHandlers,
}: UseChatViewPromptQueueInput) {
  const queueComposerPromptRef = useRef<(prompt: string) => QueuePromptResult>(() => "full");
  const forceSendQueuedPromptRef = useRef(false);
  const activeTurnInProgress = isPromptQueueTurnInProgress({
    activeSessionTurnRunning: thread.activeSessionTurnRunning,
    isSendBusy: thread.isSendBusy,
    isRevertingCheckpoint: base.isRevertingCheckpoint,
    latestTurnSettled: thread.latestTurnSettled,
  });
  const shouldQueuePrompts = shouldQueuePromptWhileWorking({
    isWorking: activeTurnInProgress,
    forceSendQueuedPrompt: forceSendQueuedPromptRef.current,
  });

  const onSend = useOnSend({
    activeThread: base.activeThread,
    activeProject: base.activeProject,
    activeThreadId: base.activeThreadId,
    isServerThread: base.isServerThread,
    isLocalDraftThread: base.isLocalDraftThread,
    isSendBusy: thread.isSendBusy,
    isConnecting: base.isConnecting,
    shouldQueuePrompt: () => shouldQueuePrompts && !forceSendQueuedPromptRef.current,
    isForceSend: () => forceSendQueuedPromptRef.current,
    sendInFlightRef: base.sendInFlightRef,
    promptRef: base.promptRef,
    composerImages: base.composerImages,
    composerImagesRef: base.composerImagesRef,
    composerFiles: base.composerFiles,
    composerFilesRef: base.composerFilesRef,
    composerAnnotations: base.composerAnnotations,
    composerAnnotationsRef: base.composerAnnotationsRef,
    composerTerminalContexts: base.composerTerminalContexts,
    composerTerminalContextsRef: base.composerTerminalContextsRef,
    selectedProvider: composer.selectedProvider,
    selectedModel: composer.selectedModel,
    selectedProviderModels: composer.selectedProviderModels,
    selectedPromptEffort: composer.selectedPromptEffort,
    selectedModelSelection: composer.selectedModelSelection,
    runtimeMode: base.runtimeMode,
    interactionMode: base.interactionMode,
    isComposerShellMode: base.composerDraft.shellMode,
    envMode,
    showPlanFollowUpPrompt: thread.showPlanFollowUpPrompt,
    activeProposedPlan: thread.activeProposedPlan,
    isOpencodePendingUserInputMode: thread.isOpencodePendingUserInputMode,
    activePendingUserInputRequestId: thread.activePendingUserInput?.requestId ?? null,
    activePendingUserInput: thread.activePendingUserInput,
    shouldAutoScrollRef: runtime.scrollBehavior.shouldAutoScrollRef,
    setOptimisticUserMessages: base.setOptimisticUserMessages,
    setPrompt: base.setPrompt,
    setComposerShellMode: base.setComposerShellMode,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    setComposerHighlightedItemId: base.setComposerHighlightedItemId,
    setThreadError: runtime.setThreadError,
    setStoreThreadError: base.setStoreThreadError,
    addComposerImagesToDraft: base.addComposerImagesToDraft,
    addComposerFilesToDraft: base.addComposerFilesToDraft,
    addComposerAnnotationsToDraft: base.addComposerAnnotationsToDraft,
    addComposerTerminalContextsToDraft: base.addComposerTerminalContextsToDraft,
    clearComposerDraftContent: base.clearComposerDraftContent,
    beginLocalDispatch: thread.beginLocalDispatch,
    resetLocalDispatch: thread.resetLocalDispatch,
    forceStickToBottom: runtime.scrollBehavior.forceStickToBottom,
    bootstrapSourceThreadId: base.composerDraft.bootstrapSourceThreadId,
    clearBootstrapSourceThreadId: (threadId) => base.setBootstrapSourceThreadId(threadId, null),
    replyTarget: base.composerDraft.replyTarget,
    setReplyTarget: base.setComposerReplyTarget,
    persistThreadSettingsForNextTurn: runtime.persistThreadSettingsForNextTurn,
    onSubmitPlanFollowUp: planHandlers.onSubmitPlanFollowUp,
    handleInteractionModeChange: runtime.handleInteractionModeChange,
    onRespondToUserInput: runtime.turnActions.onRespondToUserInput,
    queueComposerPrompt: (prompt) => queueComposerPromptRef.current(prompt),
  });

  const promptQueue = usePromptQueue({
    threadId: base.threadId,
    promptRef: base.promptRef,
    activeTurnInProgress,
    canAutoFlush: !thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode,
    setPrompt: base.setPrompt,
    setComposerShellMode: base.setComposerShellMode,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    collapseExpandedComposerCursor: base.collapseExpandedComposerCursor,
    detectComposerTrigger: base.detectComposerTrigger,
    onSend,
    onInterrupt: runtime.turnActions.onInterrupt,
    setForceSendQueuedPrompt: (force) => {
      forceSendQueuedPromptRef.current = force;
    },
    scheduleComposerFocus: runtime.scheduleComposerFocus,
    newId: base.randomUUID,
  });

  queueComposerPromptRef.current = promptQueue.queuePrompt;

  return {
    onSend,
    promptQueue,
    activeTurnInProgress,
  };
}
