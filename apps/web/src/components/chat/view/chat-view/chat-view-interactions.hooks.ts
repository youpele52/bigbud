import type { MessageId, ModelSelection, ProviderKind, TurnId } from "@bigbud/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import type { DraftThreadEnvMode } from "~/stores/composer";
import { useComposerDraftStore } from "~/stores/composer";
import { resolveAppModelSelection, resolveSelectableProvider } from "~/models/provider";
import { proposedPlanTitle } from "~/logic/proposed-plan";
import { stripDiffSearchParams } from "~/utils/diff";
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
import { waitForThreadToExist } from "../ChatView.logic";
import { providerSupportsSubProviderID } from "../ChatView.modelSelection.logic";
import {
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "../../provider/composerProviderRegistry";
import { newCommandId, newMessageId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/rpc/nativeApi";
import { toastManager } from "../../../ui/toast";
import { resolveEffectiveEnvMode } from "~/components/git/BranchToolbar.logic";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import type { ChatViewTimelineState } from "./chat-view-timeline.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";

interface ChatViewInteractionsInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  timeline: ChatViewTimelineState;
  runtime: ChatViewRuntimeState;
}

interface PendingProviderSwitchConfirmation {
  targetLabel: string;
  nextModelSelection: ModelSelection;
}

function providerSwitchTargetLabel(provider: ProviderKind): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "copilot":
      return "Copilot";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    default:
      return "Codex";
  }
}

export function useChatViewInteractions({
  base,
  composer,
  thread,
  timeline,
  runtime,
}: ChatViewInteractionsInput) {
  const [pendingProviderSwitchConfirmation, setPendingProviderSwitchConfirmation] =
    useState<PendingProviderSwitchConfirmation | null>(null);

  const closeExpandedImage = useCallback(() => {
    base.setExpandedImage(null);
  }, [base]);

  const navigateExpandedImage = useCallback(
    (direction: -1 | 1) => {
      base.setExpandedImage((existing) => {
        if (!existing || existing.images.length <= 1) {
          return existing;
        }
        const nextIndex =
          (existing.index + direction + existing.images.length) % existing.images.length;
        return nextIndex === existing.index ? existing : { ...existing, index: nextIndex };
      });
    },
    [base],
  );

  useEffect(() => {
    if (!base.expandedImage) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const expandedImage = base.expandedImage;
      if (!expandedImage) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [base.expandedImage, closeExpandedImage, navigateExpandedImage]);

  const envMode: DraftThreadEnvMode = resolveEffectiveEnvMode({
    activeWorktreePath: base.activeThread?.worktreePath ?? null,
    hasServerThread: base.isServerThread,
    draftThreadEnvMode: base.isLocalDraftThread ? base.draftThread?.envMode : undefined,
  });

  const branchThreadForProviderChange = useCallback(
    async (nextModelSelection: ModelSelection) => {
      const api = readNativeApi();
      if (!api || !base.activeProject || !base.activeThread || !base.isServerThread) {
        runtime.scheduleComposerFocus();
        return;
      }

      const nextThreadId = newThreadId();
      const createdAt = new Date().toISOString();
      const sourceThreadId = base.activeThread.id;
      const sourceDraft = base.composerDraft;
      const sourceDraftContexts = sourceDraft.terminalContexts.map((context) => ({
        ...context,
        threadId: nextThreadId,
      }));

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId: nextThreadId,
          projectId: base.activeProject.id,
          title: base.activeThread.title,
          modelSelection: nextModelSelection,
          runtimeMode: base.runtimeMode,
          interactionMode: base.interactionMode,
          branch: base.activeThread.branch,
          worktreePath: base.activeThread.worktreePath,
          parentThread: {
            threadId: sourceThreadId,
            title: base.activeThread.title,
          },
          seedMessages: base.activeThread.messages
            .filter((message) => !message.streaming)
            .map((message) =>
              Object.assign(
                {
                  id: newMessageId(),
                  role: message.role,
                  text: message.text,
                },
                message.attachments
                  ? {
                      attachments: message.attachments.map((attachment) => ({
                        type: attachment.type,
                        id: attachment.id,
                        name: attachment.name,
                        mimeType: attachment.mimeType,
                        sizeBytes: attachment.sizeBytes,
                      })),
                    }
                  : {},
                {
                  turnId: null,
                  streaming: false,
                  createdAt: message.createdAt,
                  updatedAt: message.completedAt ?? message.createdAt,
                },
              ),
            ),
          createdAt,
        });
      } catch (err) {
        toastManager.add({
          type: "error",
          title: "Failed to create branch",
          description: err instanceof Error ? err.message : "Could not start a new branch thread.",
        });
        runtime.scheduleComposerFocus();
        return;
      }

      base.setComposerDraftPrompt(nextThreadId, sourceDraft.prompt);
      for (const selection of Object.values(sourceDraft.modelSelectionByProvider)) {
        if (selection) {
          base.setComposerDraftModelSelection(nextThreadId, selection);
        }
      }
      base.setComposerDraftModelSelection(nextThreadId, nextModelSelection);
      base.setComposerDraftRuntimeMode(nextThreadId, base.runtimeMode);
      base.setComposerDraftInteractionMode(nextThreadId, base.interactionMode);
      if (sourceDraft.images.length > 0) {
        useComposerDraftStore.getState().addImages(
          nextThreadId,
          sourceDraft.images.map((image) => image),
        );
      }
      if (sourceDraftContexts.length > 0) {
        base.setComposerDraftTerminalContexts(nextThreadId, sourceDraftContexts);
      }
      base.setBootstrapSourceThreadId(nextThreadId, sourceThreadId);

      const threadExists = await waitForThreadToExist(nextThreadId);
      if (!threadExists) {
        runtime.scheduleComposerFocus();
        return;
      }
      await base.navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  const onProviderModelSelect = useCallback(
    async (provider: ProviderKind, model: string, subProviderID?: string) => {
      if (!base.activeThread) return;
      const resolvedProvider = resolveSelectableProvider(composer.providerStatuses, provider);
      const resolvedModel = resolveAppModelSelection(
        resolvedProvider,
        base.settings,
        composer.providerStatuses,
        model,
      );
      const matchedServerModel = composer.modelOptionsByProvider[resolvedProvider]?.find(
        (entry) =>
          entry.slug === resolvedModel &&
          (!providerSupportsSubProviderID(resolvedProvider) ||
            entry.subProviderID === subProviderID),
      );
      const nextModelSelection: ModelSelection = {
        provider: resolvedProvider,
        model: resolvedModel,
        ...(providerSupportsSubProviderID(resolvedProvider) && matchedServerModel?.subProviderID
          ? { subProviderID: matchedServerModel.subProviderID }
          : {}),
      };
      const boundProvider = composer.sessionProvider ?? composer.threadProvider;
      const shouldBranchOnProviderChange =
        composer.hasThreadStarted && boundProvider !== null && resolvedProvider !== boundProvider;

      if (shouldBranchOnProviderChange) {
        setPendingProviderSwitchConfirmation({
          targetLabel: providerSwitchTargetLabel(resolvedProvider),
          nextModelSelection,
        });
        return;
      }

      setPendingProviderSwitchConfirmation(null);
      base.setComposerDraftModelSelection(base.activeThread.id, nextModelSelection);
      base.setStickyComposerModelSelection(nextModelSelection);
      runtime.scheduleComposerFocus();
    },
    [base, composer, runtime],
  );

  const onConfirmPendingProviderSwitch = useCallback(() => {
    if (!pendingProviderSwitchConfirmation) {
      return;
    }

    const nextModelSelection = pendingProviderSwitchConfirmation.nextModelSelection;
    setPendingProviderSwitchConfirmation(null);
    void branchThreadForProviderChange(nextModelSelection);
  }, [branchThreadForProviderChange, pendingProviderSwitchConfirmation]);

  const onDismissPendingProviderSwitch = useCallback(() => {
    setPendingProviderSwitchConfirmation(null);
    runtime.scheduleComposerFocus();
  }, [runtime]);

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
    composerTerminalContexts: base.composerTerminalContexts,
    composerTerminalContextsRef: base.composerTerminalContextsRef,
    selectedProvider: composer.selectedProvider,
    selectedModel: composer.selectedModel,
    selectedProviderModels: composer.selectedProviderModels,
    selectedPromptEffort: composer.selectedPromptEffort,
    selectedModelSelection: composer.selectedModelSelection,
    runtimeMode: base.runtimeMode,
    interactionMode: base.interactionMode,
    envMode,
    showPlanFollowUpPrompt: thread.showPlanFollowUpPrompt,
    activeProposedPlan: thread.activeProposedPlan,
    isOpencodePendingUserInputMode: thread.isOpencodePendingUserInputMode,
    activePendingUserInputRequestId: thread.activePendingUserInput?.requestId ?? null,
    activePendingUserInput: thread.activePendingUserInput,
    shouldAutoScrollRef: runtime.scrollBehavior.shouldAutoScrollRef,
    setOptimisticUserMessages: base.setOptimisticUserMessages,
    setPrompt: base.setPrompt,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    setComposerHighlightedItemId: base.setComposerHighlightedItemId,
    setThreadError: runtime.setThreadError,
    setStoreThreadError: base.setStoreThreadError,
    addComposerImagesToDraft: base.addComposerImagesToDraft,
    addComposerFilesToDraft: base.addComposerFilesToDraft,
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
    interactionMode: base.interactionMode,
    activePendingProgress: thread.activePendingProgress,
    activePendingUserInput: thread.activePendingUserInput,
    isOpencodePendingUserInputMode: thread.isOpencodePendingUserInputMode,
    setComposerCursor: base.setComposerCursor,
    setComposerTrigger: base.setComposerTrigger,
    setComposerHighlightedItemId: base.setComposerHighlightedItemId,
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
      void base.navigate({
        to: "/$threadId",
        params: { threadId: base.threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath }
            : { ...rest, diff: "1", diffTurnId: turnId };
        },
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
