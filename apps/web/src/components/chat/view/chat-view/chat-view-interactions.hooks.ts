import type { MessageId, TurnId } from "@bigbud/contracts";
import { useCallback, useRef } from "react";

import type { DraftThreadEnvMode } from "~/stores/composer";
import { proposedPlanTitle } from "~/logic/proposed-plan";
import { openDiffRouteSearch } from "~/utils/diff";
import {
  closeBrowserPanel,
  requestRightPanel,
} from "../../../../stores/browser/browserPanel.coordinator";
import { isElectron } from "~/config/env/env.config";

import {
  useAddComposerImages,
  useAddComposerFiles,
  useApplyPromptReplacement,
  usePendingUserInputHandlers,
} from "../ChatView.composerHandlers.logic";
import { useComposerCommandHandlers } from "../ChatView.composerCommandHandlers.logic";
import { useChatKeybindings } from "../ChatView.keybindings.logic";
import { usePlanHandlers } from "../ChatView.planHandlers.logic";
import { useOnSend } from "../ChatView.sendTurn.logic";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "../../provider/composerProviderRegistry";
import { resolveEffectiveEnvMode } from "~/components/git/BranchToolbar.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import type { ChatViewTimelineState } from "./chat-view-timeline.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { useChatViewExpandedImage } from "./chat-view-expanded-image.hooks";
import { useChatViewProviderSwitch } from "./chat-view-provider-switch.hooks";

interface ChatViewInteractionsInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  timeline: ChatViewTimelineState;
  runtime: ChatViewRuntimeState;
}

export function useChatViewInteractions({
  base,
  composer,
  thread,
  timeline,
  runtime,
}: ChatViewInteractionsInput) {
  const { closeExpandedImage, navigateExpandedImage } = useChatViewExpandedImage(base);

  const envMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath: base.activeThread?.worktreePath ?? null,
    hasServerThread: base.isServerThread,
    draftThreadEnvMode: base.isLocalDraftThread ? base.draftThread?.envMode : undefined,
  });

  const {
    pendingProviderSwitchConfirmation,
    onProviderModelSelect,
    onConfirmPendingProviderSwitch,
    onDismissPendingProviderSwitch,
  } = useChatViewProviderSwitch({
    base,
    composer,
    runtime,
  });

  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = base.promptRef.current;
      if (nextPrompt === currentPrompt) {
        runtime.scheduleComposerFocus();
        return;
      }
      base.promptRef.current = nextPrompt;
      base.setPrompt(nextPrompt);
      const nextCursor = base.collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      base.setComposerCursor(nextCursor);
      base.setComposerTrigger(base.detectComposerTrigger(nextPrompt, nextPrompt.length));
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: composer.selectedProvider,
    threadId: base.threadId,
    model: composer.selectedModel,
    models: composer.selectedProviderModels,
    modelOptions: composer.composerModelOptions?.[composer.selectedProvider],
    prompt: base.prompt,
    onPromptChange: setPromptFromTraits,
  });

  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: composer.selectedProvider,
    threadId: base.threadId,
    model: composer.selectedModel,
    models: composer.selectedProviderModels,
    modelOptions: composer.composerModelOptions?.[composer.selectedProvider],
    prompt: base.prompt,
    onPromptChange: setPromptFromTraits,
  });

  const applyPromptReplacement = useApplyPromptReplacement({
    promptRef: base.promptRef,
    setPrompt: base.setPrompt,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    activePendingProgress: thread.activePendingProgress,
    activePendingUserInput: thread.activePendingUserInput,
    isOpencodePendingUserInputMode: thread.isOpencodePendingUserInputMode,
    setPendingUserInputAnswersByRequestId: base.setPendingUserInputAnswersByRequestId,
    composerEditorRef: base.composerEditorRef,
  });

  const pendingUserInputHandlers = usePendingUserInputHandlers({
    activePendingUserInput: thread.activePendingUserInput,
    activePendingProgress: thread.activePendingProgress,
    activePendingResolvedAnswers: thread.activePendingResolvedAnswers,
    promptRef: base.promptRef,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    setPendingUserInputAnswersByRequestId: base.setPendingUserInputAnswersByRequestId,
    setPendingUserInputQuestionIndexByRequestId: base.setPendingUserInputQuestionIndexByRequestId,
    onRespondToUserInput: runtime.turnActions.onRespondToUserInput,
  });

  const planHandlers = usePlanHandlers({
    activeThread: base.activeThread,
    activeProject: base.activeProject,
    activeProposedPlan: thread.activeProposedPlan,
    isServerThread: base.isServerThread,
    isSendBusy: thread.isSendBusy,
    isConnecting: base.isConnecting,
    sendInFlightRef: base.sendInFlightRef,
    planSidebarDismissedForTurnRef: base.planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef: base.planSidebarOpenOnNextThreadRef,
    selectedProvider: composer.selectedProvider,
    selectedModel: composer.selectedModel,
    selectedProviderModels: composer.selectedProviderModels,
    selectedPromptEffort: composer.selectedPromptEffort,
    selectedModelSelection: composer.selectedModelSelection,
    runtimeMode: base.runtimeMode,
    shouldAutoScrollRef: runtime.scrollBehavior.shouldAutoScrollRef,
    setOptimisticUserMessages: base.setOptimisticUserMessages,
    setPlanSidebarOpen: base.setPlanSidebarOpen,
    setThreadError: (threadId, error) => runtime.setThreadError(threadId, error),
    setComposerDraftInteractionMode: base.setComposerDraftInteractionMode,
    beginLocalDispatch: thread.beginLocalDispatch,
    resetLocalDispatch: thread.resetLocalDispatch,
    forceStickToBottom: runtime.scrollBehavior.forceStickToBottom,
    persistThreadSettingsForNextTurn: runtime.persistThreadSettingsForNextTurn,
  });

  const onSend = useOnSend({
    activeThread: base.activeThread,
    activeProject: base.activeProject,
    activeThreadId: base.activeThreadId,
    isServerThread: base.isServerThread,
    isLocalDraftThread: base.isLocalDraftThread,
    isSendBusy: thread.isSendBusy,
    isConnecting: base.isConnecting,
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
    persistThreadSettingsForNextTurn: runtime.persistThreadSettingsForNextTurn,
    onSubmitPlanFollowUp: planHandlers.onSubmitPlanFollowUp,
    handleInteractionModeChange: runtime.handleInteractionModeChange,
    onRespondToUserInput: runtime.turnActions.onRespondToUserInput,
  });

  const addComposerImages = useAddComposerImages({
    activeThreadId: base.activeThreadId,
    composerImagesRef: base.composerImagesRef,
    pendingUserInputsLength: thread.pendingUserInputs.length,
    addComposerImage: base.addComposerImage,
    addComposerImagesToDraft: base.addComposerImagesToDraft,
    setThreadError: runtime.setThreadError,
  });

  const addComposerFiles = useAddComposerFiles({
    activeThreadId: base.activeThreadId,
    composerFilesRef: base.composerFilesRef,
    composerImagesLength: base.composerImages.length,
    pendingUserInputsLength: thread.pendingUserInputs.length,
    addComposerFile: base.addComposerFile,
    addComposerFilesToDraft: base.addComposerFilesToDraft,
    setThreadError: runtime.setThreadError,
    isElectron,
  });
  const onComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLElement>) => {
      const allFiles = Array.from(event.clipboardData.files);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) {
        event.preventDefault();
        addComposerImages(imageFiles);
      }
      if (nonImageFiles.length > 0) {
        event.preventDefault();
        addComposerFiles(nonImageFiles);
      }
    },
    [addComposerImages, addComposerFiles],
  );

  const onComposerDragEnter = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      base.dragDepthRef.current += 1;
      base.setIsDragOverComposer(true);
    },
    [base],
  );

  const onComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      base.setIsDragOverComposer(true);
    },
    [base],
  );

  const onComposerDragLeave = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
      base.dragDepthRef.current = Math.max(0, base.dragDepthRef.current - 1);
      if (base.dragDepthRef.current === 0) {
        base.setIsDragOverComposer(false);
      }
    },
    [base],
  );

  const onComposerDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      base.dragDepthRef.current = 0;
      base.setIsDragOverComposer(false);
      const allFiles = Array.from(event.dataTransfer.files);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) addComposerImages(imageFiles);
      if (nonImageFiles.length > 0) addComposerFiles(nonImageFiles);
      runtime.focusComposer();
    },
    [addComposerImages, addComposerFiles, base, runtime],
  );

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const onAttachFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const allFiles = Array.from(event.target.files ?? []);
      const imageFiles = allFiles.filter((file) => file.type.startsWith("image/"));
      const nonImageFiles = allFiles.filter((file) => !file.type.startsWith("image/"));
      if (imageFiles.length > 0) addComposerImages(imageFiles);
      if (nonImageFiles.length > 0) addComposerFiles(nonImageFiles);
      // Reset input so the same file can be selected again
      event.target.value = "";
      runtime.focusComposer();
    },
    [addComposerImages, addComposerFiles, runtime],
  );

  const composerCommandHandlers = useComposerCommandHandlers({
    composerMenuOpenRef: base.composerMenuOpenRef,
    composerMenuItemsRef: base.composerMenuItemsRef,
    activeComposerMenuItemRef: base.activeComposerMenuItemRef,
    composerSelectLockRef: base.composerSelectLockRef,
    composerEditorRef: base.composerEditorRef,
    promptRef: base.promptRef,
    composerCursor: base.composerCursor,
    composerTerminalContexts: base.composerTerminalContexts,
    composerMenuItems: composer.composerMenuItems,
    composerHighlightedItemId: base.composerHighlightedItemId,
    isComposerShellMode: base.composerDraft.shellMode,
    interactionMode: base.interactionMode,
    activePendingProgress: thread.activePendingProgress,
    activePendingUserInput: thread.activePendingUserInput,
    isOpencodePendingUserInputMode: thread.isOpencodePendingUserInputMode,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    setComposerHighlightedItemId: base.setComposerHighlightedItemId,
    setComposerShellMode: base.setComposerShellMode,
    setComposerDraftTerminalContexts: base.setComposerDraftTerminalContexts,
    threadId: base.threadId,
    setPrompt: base.setPrompt,
    setPendingUserInputAnswersByRequestId: base.setPendingUserInputAnswersByRequestId,
    applyPromptReplacement,
    onProviderModelSelect,
    handleInteractionModeChange: runtime.handleInteractionModeChange,
    toggleInteractionMode: runtime.toggleInteractionMode,
    onSend,
    onChangeActivePendingUserInputCustomAnswer:
      pendingUserInputHandlers.onChangeActivePendingUserInputCustomAnswer,
  });

  useChatKeybindings({
    activeThreadId: base.activeThreadId,
    activeProject: base.activeProject,
    terminalState: base.terminalState,
    keybindings: composer.keybindings,
    toggleTerminalVisibility: runtime.terminalActions.toggleTerminalVisibility,
    setTerminalOpen: runtime.terminalActions.setTerminalOpen,
    splitTerminal: runtime.terminalActions.splitTerminal,
    closeTerminal: runtime.terminalActions.closeTerminal,
    createNewTerminal: runtime.terminalActions.createNewTerminal,
    onToggleDiff: runtime.onToggleDiff,
    onToggleSearch: runtime.onToggleSearch,
    runProjectScript: runtime.terminalActions.runProjectScript,
  });

  const isComposerMenuLoading =
    composer.composerTriggerKind === "path" &&
    ((composer.pathTriggerQuery.length > 0 &&
      composer.composerPathQueryDebouncer.state.isPending) ||
      composer.workspaceEntriesQuery.isLoading ||
      composer.workspaceEntriesQuery.isFetching);

  const pendingAction =
    !thread.isOpencodePendingUserInputMode && thread.activePendingProgress
      ? {
          questionIndex: thread.activePendingProgress.questionIndex,
          isLastQuestion: thread.activePendingProgress.isLastQuestion,
          canAdvance: thread.activePendingProgress.canAdvance,
          isResponding: runtime.activePendingIsResponding,
          isComplete: Boolean(thread.activePendingResolvedAnswers),
        }
      : null;

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      requestRightPanel("diff");
      closeBrowserPanel();

      void base.navigate({
        to: "/$threadId",
        params: { threadId: base.threadId },
        search: (previous) => openDiffRouteSearch(previous, { turnId, filePath }),
      });
    },
    [base],
  );

  const onToggleWorkGroup = useCallback(
    (groupId: string) => {
      base.setExpandedWorkGroups((existing) => ({
        ...existing,
        [groupId]: !existing[groupId],
      }));
    },
    [base],
  );

  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = timeline.revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") return;
      void runtime.turnActions.onRevertToTurnCount(targetTurnCount);
    },
    [runtime.turnActions, timeline.revertTurnCountByUserMessageId],
  );

  return {
    envMode,
    providerTraitsMenuContent,
    providerTraitsPicker,
    pendingProviderSwitchConfirmation,
    onConfirmPendingProviderSwitch,
    onDismissPendingProviderSwitch,
    planHandlers,
    pendingUserInputHandlers,
    composerCommandHandlers,
    onSend,
    onProviderModelSelect,
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
    onAttachFiles,
    fileInputRef,
    onFileInputChange,
    isComposerMenuLoading,
    pendingAction,
    closeExpandedImage,
    navigateExpandedImage,
    onOpenTurnDiff,
    onToggleWorkGroup,
    onRevertUserMessage,
    onEnvModeChange: (mode: DraftThreadEnvMode) => {
      if (base.isLocalDraftThread) {
        base.setDraftThreadContext(base.threadId, {
          envMode: mode,
          ...(mode === "worktree" && base.draftThread?.worktreePath ? { worktreePath: null } : {}),
        });
      }
      runtime.scheduleComposerFocus();
    },
    expandedImageItem: base.expandedImage
      ? base.expandedImage.images[base.expandedImage.index]
      : null,
    activeProjectName: base.activeProject?.name,
    preferredScriptId: base.activeProject
      ? (base.lastInvokedScriptByProjectId[base.activeProject.id] ?? null)
      : null,
    activeTurnInProgress: thread.isWorking || !thread.latestTurnSettled,
    planTitle: thread.activeProposedPlan
      ? (proposedPlanTitle(thread.activeProposedPlan.planMarkdown) ?? null)
      : null,
  };
}

export type ChatViewInteractionsState = ReturnType<typeof useChatViewInteractions>;
