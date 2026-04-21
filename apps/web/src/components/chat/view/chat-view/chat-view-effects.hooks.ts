import { useEffect, useRef } from "react";

import { type PersistedComposerImageAttachment } from "~/stores/composer";
import { useComposerDraftStore } from "~/stores/composer";

import { readFileAsDataUrl, revokeUserMessagePreviewUrls } from "../ChatView.logic";

import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewEffectsInput {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  thread: ChatViewThreadDerivedState;
  runtime: ChatViewRuntimeState;
}

export function useChatViewEffects({ base, composer, thread, runtime }: ChatViewEffectsInput) {
  const {
    activeProjectCwd,
    activeThread,
    activeThreadId,
    activeThreadWorktreePath,
    clampCollapsedComposerCursor,
    clearComposerDraftPersistedAttachments,
    collapseExpandedComposerCursor,
    composerImages,
    composerImagesRef,
    composerTerminalContexts,
    composerTerminalContextsRef,
    detectComposerTrigger,
    dragDepthRef,
    planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef,
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
    setPlanSidebarOpen,
    setProviderUnlocked,
    setTerminalFocusRequestId,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
    syncComposerDraftPersistedAttachments,
    terminalOpenByThreadRef,
    terminalState,
    threadId,
  } = base;
  const { composerMenuItems, composerMenuOpen, gitCwd } = composer;
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
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [
    activeThread?.id,
    closePullRequestDialog,
    planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef,
    setExpandedWorkGroups,
    setPlanSidebarOpen,
    setProviderUnlocked,
  ]);
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [composerMenuItems, composerMenuOpen, setComposerHighlightedItemId]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id, setIsRevertingCheckpoint]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

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
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];

      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(threadId, Array.from(stagedAttachmentById.values()));
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(
          threadId,
          fallbackPersistedAttachments.filter((attachment) => currentImageIds.has(attachment.id)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  useEffect(() => {
    if (!activeThreadId) {
      setTerminalLaunchContext(null);
      storeClearTerminalLaunchContext(threadId);
      return;
    }
    setTerminalLaunchContext((current) => {
      if (!current) return current;
      return current.threadId === activeThreadId ? current : null;
    });
  }, [activeThreadId, setTerminalLaunchContext, storeClearTerminalLaunchContext, threadId]);

  useEffect(() => {
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
    gitCwd,
    setTerminalLaunchContext,
    storeClearTerminalLaunchContext,
  ]);

  useEffect(() => {
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
    gitCwd,
    storeClearTerminalLaunchContext,
    storeServerTerminalLaunchContext,
  ]);

  useEffect(() => {
    if (terminalState.terminalOpen) return;
    if (activeThreadId) {
      storeClearTerminalLaunchContext(activeThreadId);
    }
    setTerminalLaunchContext((current) => (current?.threadId === activeThreadId ? null : current));
  }, [
    activeThreadId,
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
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
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
    focusComposer,
    setTerminalFocusRequestId,
    terminalOpenByThreadRef,
    terminalState.terminalOpen,
  ]);
}
