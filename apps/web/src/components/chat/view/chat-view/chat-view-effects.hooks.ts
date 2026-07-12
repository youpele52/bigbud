import { useEffect, useRef } from "react";

import { revokeUserMessagePreviewUrls } from "../ChatView.logic";

import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { usePersistComposerImageAttachments } from "./chat-view-effects.attachments.hooks";

interface ChatViewEffectsInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  embedded?: boolean | undefined;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
}

export function useChatViewEffects({
  base,
  composer,
  embedded = false,
  thread,
  runtime,
}: ChatViewEffectsInput) {
  const {
    activeProjectCwd,
    activeThread,
    activeThreadId,
    activeThreadWorktreePath,
    clampCollapsedComposerCursor,
    collapseExpandedComposerCursor,
    composerImages,
    composerImagesRef,
    composerAnnotations,
    composerAnnotationsRef,
    composerFiles,
    composerFilesRef,
    composerTerminalContexts,
    composerTerminalContextsRef,
    detectComposerTrigger,
    dragDepthRef,
    planCardDismissedForTurnRef,
    planCardOpenOnNextThreadRef,
    prompt,
    promptRef,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
    setExpandedImage,
    setExpandedWorkGroups,
    setIsDragOverComposer,
    setIsRevertingCheckpoint,
    setNowTick,
    setOptimisticUserMessages,
    setPlanCardOpen,
    setProviderUnlocked,
    setTerminalFocusRequestId,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
    terminalOpenByThreadRef,
    terminalState,
    threadId,
  } = base;
  const { composerMenuItems, composerMenuOpen, gitCwd } = composer;
  const composerMenuItemsRef = useRef(composerMenuItems);
  composerMenuItemsRef.current = composerMenuItems;
  const composerMenuItemIds = composerMenuItems.map((item) => item.id).join("|");
  const {
    activePendingProgress,
    activePendingUserInput,
    isOpencodePendingUserInputMode,
    resetLocalDispatch,
  } = thread;
  const { closePullRequestDialog, focusComposer } = runtime;
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  usePersistComposerImageAttachments(base);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (isOpencodePendingUserInputMode || typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(detectComposerTrigger(nextCustomAnswer, nextCustomAnswer.length));
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.activeQuestion?.id,
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    isOpencodePendingUserInputMode,
    collapseExpandedComposerCursor,
    detectComposerTrigger,
    promptRef,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
  ]);

  useEffect(() => {
    setExpandedWorkGroups({});
    closePullRequestDialog();
    setProviderUnlocked(false);
    if (planCardOpenOnNextThreadRef.current) {
      planCardOpenOnNextThreadRef.current = false;
      setPlanCardOpen(true);
    } else {
      setPlanCardOpen(false);
    }
    planCardDismissedForTurnRef.current = null;
  }, [
    activeThread?.id,
    closePullRequestDialog,
    planCardDismissedForTurnRef,
    planCardOpenOnNextThreadRef,
    setExpandedWorkGroups,
    setPlanCardOpen,
    setProviderUnlocked,
  ]);
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    const currentComposerMenuItems = composerMenuItemsRef.current;
    setComposerHighlightedItemId((existing) =>
      existing && currentComposerMenuItems.some((item) => item.id === existing)
        ? existing
        : (currentComposerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItemIds, composerMenuOpen, setComposerHighlightedItemId]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id, setIsRevertingCheckpoint]);

  useEffect(() => {
    if (embedded) return;
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, embedded, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerFilesRef.current = composerFiles;
  }, [composerFiles, composerFilesRef]);

  useEffect(() => {
    composerAnnotationsRef.current = composerAnnotations;
  }, [composerAnnotations, composerAnnotationsRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [clampCollapsedComposerCursor, prompt, promptRef, setComposerCursor]);

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    resetLocalDispatch();
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [
    collapseExpandedComposerCursor,
    detectComposerTrigger,
    dragDepthRef,
    promptRef,
    resetLocalDispatch,
    setComposerCursor,
    setComposerHighlightedItemId,
    setComposerTrigger,
    setExpandedImage,
    setIsDragOverComposer,
    setOptimisticUserMessages,
    threadId,
  ]);

  useEffect(() => {
    if (embedded) return;
    if (!activeThreadId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(threadId);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      return current.threadId === activeThreadId ? current : null;
    });
  }, [
    activeThreadId,
    embedded,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    threadId,
  ]);

  useEffect(() => {
    if (embedded) return;
    if (!activeThreadId || !activeProjectCwd) return;
    setTerminalLaunchContext((current) => {
      if (!current || current.threadId !== activeThreadId) {
        return current;
      }
      if (gitCwd === current.cwd && (activeThreadWorktreePath ?? null) === current.worktreePath) {
        storeClearTerminalLaunchContext(activeThreadId);
        return null;
      }
      return current;
    });
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadWorktreePath,
    embedded,
    gitCwd,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (embedded) return;
    if (!activeThreadId || !activeProjectCwd || !storeServerTerminalLaunchContext) {
      return;
    }
    if (
      gitCwd === storeServerTerminalLaunchContext.cwd &&
      (activeThreadWorktreePath ?? null) === storeServerTerminalLaunchContext.worktreePath
    ) {
      storeClearTerminalLaunchContext(activeThreadId);
    }
  }, [
    activeProjectCwd,
    activeThreadId,
    activeThreadWorktreePath,
    embedded,
    gitCwd,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (embedded) return;
    if (terminalState.terminalOpen) return;
    if (activeThreadId) {
      storeClearTerminalLaunchContext(activeThreadId);
    }
    setTerminalLaunchContext((current) => (current?.threadId === activeThreadId ? null : current));
  }, [
    activeThreadId,
    embedded,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!thread.isWorking) return;
    const timer = window.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [thread.isWorking, setNowTick]);

  useEffect(() => {
    if (embedded) return;
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.isConnected) {
        const isTerminalElement =
          activeElement.classList.contains("xterm-helper-textarea") ||
          activeElement.closest(".thread-terminal-drawer .xterm") !== null;
        if (!isTerminalElement) {
          activeElement.blur();
        }
      }
      setTerminalFocusRequestId((value) => value + 1);
      return;
    }
    if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [
    activeThreadId,
    embedded,
    focusComposer,
    setTerminalFocusRequestId,
    terminalOpenByThreadRef,
    terminalState.terminalOpen,
  ]);
}
