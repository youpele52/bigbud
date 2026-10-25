import { useRef } from "react";
import type { MessageId, ThreadId } from "@bigbud/contracts";

import { isSessionHealthUnconfirmed } from "~/logic/session";
import type { DraftThreadEnvMode } from "~/stores/composer";

import type { usePlanHandlers } from "../ChatView.planHandlers.logic";
import {
  usePromptQueue,
  type QueuedPromptSubmission,
  type QueuePromptResult,
} from "../ChatView.promptQueue.logic";
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
  onOptimisticUserMessage?: ((messageId: MessageId) => void) | undefined;
  onThreadMaterialized?: ((threadId: ThreadId) => Promise<void> | void) | undefined;
  planHandlers: Pick<ReturnType<typeof usePlanHandlers>, "onSubmitPlanFollowUp">;
  transformPromptForSend?: ((prompt: string) => string) | undefined;
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
  sessionHealthUnconfirmed?: boolean;
}) {
  if (input.sessionHealthUnconfirmed) {
    return true;
  }
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
  onOptimisticUserMessage,
  onThreadMaterialized,
  planHandlers,
  transformPromptForSend,
}: UseChatViewPromptQueueInput) {
  const submitQueuedPromptRef = useRef<
    (submission: QueuedPromptSubmission) => Promise<QueuePromptResult>
  >(async () => "full");
  const activeTurnInProgress = isPromptQueueTurnInProgress({
    activeSessionTurnRunning: thread.activeSessionTurnRunning,
    isSendBusy: thread.isSendBusy,
    isRevertingCheckpoint: base.isRevertingCheckpoint,
    latestTurnSettled: thread.latestTurnSettled,
    sessionHealthUnconfirmed: isSessionHealthUnconfirmed(base.activeThread?.session ?? null),
  });
  const nativeSteer = composer.activeProviderStatus?.turnControl?.nativeSteer === true;
  const shouldQueuePrompts = shouldQueuePromptWhileWorking({
    isWorking: activeTurnInProgress,
    forceSendQueuedPrompt: false,
  });

  const onSend = useOnSend({
    activeThread: base.activeThread,
    activeProject: base.activeProject,
    activeThreadId: base.activeThreadId,
    isServerThread: base.isServerThread,
    isLocalDraftThread: base.isLocalDraftThread,
    isSendBusy: thread.isSendBusy,
    isConnecting: base.isConnecting,
    shouldQueuePrompt: () => shouldQueuePrompts,
    isForceSend: () => false,
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
    scrollToUserTurnAnchor: runtime.scrollBehavior.scrollToUserTurnAnchor,
    bootstrapSourceThreadId: base.composerDraft.bootstrapSourceThreadId,
    clearBootstrapSourceThreadId: (threadId) => base.setBootstrapSourceThreadId(threadId, null),
    replyTarget: base.composerDraft.replyTarget,
    setReplyTarget: base.setComposerReplyTarget,
    persistThreadSettingsForNextTurn: runtime.persistThreadSettingsForNextTurn,
    onSubmitPlanFollowUp: planHandlers.onSubmitPlanFollowUp,
    handleInteractionModeChange: runtime.handleInteractionModeChange,
    onRespondToUserInput: runtime.turnActions.onRespondToUserInput,
    onOptimisticUserMessage,
    onThreadMaterialized,
    submitQueuedComposerPrompt: (submission) => submitQueuedPromptRef.current(submission),
    transformPromptForSend,
  });

  const promptQueue = usePromptQueue({
    threadId: base.threadId,
    projectedPrompts: base.activeThread?.queuedPrompts ?? [],
    activeTurnInProgress,
    activeTurnId: base.activeThread?.session?.activeTurnId,
    sessionEpoch: base.activeThread?.session?.sessionEpoch,
    controlOperation: base.activeThread?.pendingTurnControlOperation,
    // Steer never interrupts, so it exists only where the provider steers natively. An
    // already-sent redelivery at the head is never steered; Send now still covers it.
    canSteer: nativeSteer && base.activeThread?.queuedPrompts?.[0]?.alreadySent !== true,
    nativeSteer,
    onInterrupt: runtime.turnActions.onInterrupt,
    onError: (message) => runtime.setThreadError(base.threadId, message),
    newId: base.randomUUID,
    // Same settings a composer send persists, so "Send now" runs on the picker's choice.
    persistSettingsBeforeRelease: base.isServerThread
      ? () =>
          runtime.persistThreadSettingsForNextTurn({
            threadId: base.threadId,
            createdAt: new Date().toISOString(),
            ...(composer.selectedModel ? { modelSelection: composer.selectedModelSelection } : {}),
            runtimeMode: base.runtimeMode,
            interactionMode: base.interactionMode,
          })
      : undefined,
  });

  submitQueuedPromptRef.current = promptQueue.submitQueuedPrompt;

  return {
    onSend,
    promptQueue,
    activeTurnInProgress,
  };
}
