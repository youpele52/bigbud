import {
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@bigbud/contracts";
import { useCallback, useMemo } from "react";

import { readNativeApi } from "../../../../rpc/nativeApi";
import { modelSelectionsEqual } from "../ChatView.modelSelection.logic";
import { newCommandId, newThreadId, randomUUID } from "~/lib/utils";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
} from "../../../../logic/composer";
import { useTurnActions } from "../ChatView.turnActions.logic";
import { useTerminalActions } from "../ChatView.terminalActions.logic";
import { useProjectScripts } from "../ChatView.projectScripts.logic";
import { useScrollBehavior } from "../ChatView.scrollBehavior.logic";
import {
  shouldUseCompactComposerFooter,
  shouldUseCompactComposerPrimaryActions,
} from "../composerFooterLayout";
import { closeDiffRouteSearch, openDiffRouteSearch } from "../../../../utils/diff";
import { useSearchStore } from "../../../../stores/ui";
import {
  insertInlineTerminalContextPlaceholder,
  type TerminalContextSelection,
} from "../../../../lib/terminalContext";
import {
  closeBrowserPanel,
  requestRightPanel,
  toggleBrowserPanel,
} from "../../../../stores/browser/browserPanel.coordinator";

import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { type ChatViewTimelineState } from "./chat-view-timeline.hooks";

interface ChatViewRuntimeInput {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
  composer: ChatViewComposerDerivedState;
  timeline: ChatViewTimelineState;
}

export function useChatViewRuntime({ base, thread, composer, timeline }: ChatViewRuntimeInput) {
  const { setPullRequestDialogState } = base;

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!base.canCheckoutPullRequestIntoThread) {
        return;
      }
      base.setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      base.setComposerHighlightedItemId(null);
    },
    [base],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, [setPullRequestDialogState]);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      envMode: "local" | "worktree";
    }) => {
      if (!base.activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const storedDraftThread = base.getDraftThreadByProjectId(base.activeProject.id);
      if (storedDraftThread) {
        base.setDraftThreadContext(storedDraftThread.threadId, input);
        base.setProjectDraftThreadId(base.activeProject.id, storedDraftThread.threadId, input);
        if (storedDraftThread.threadId !== base.threadId) {
          await base.navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return storedDraftThread.threadId;
      }

      const activeDraftThread = base.getDraftThread(base.threadId);
      if (!base.isServerThread && activeDraftThread?.projectId === base.activeProject.id) {
        base.setDraftThreadContext(base.threadId, input);
        base.setProjectDraftThreadId(base.activeProject.id, base.threadId, input);
        return base.threadId;
      }

      base.clearProjectDraftThreadId(base.activeProject.id);
      const nextThreadId = newThreadId();
      base.setProjectDraftThreadId(base.activeProject.id, nextThreadId, {
        createdAt: new Date().toISOString(),
        runtimeMode: "approval-required",
        interactionMode: "default",
        ...input,
      });
      await base.navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
      return nextThreadId;
    },
    [base],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  const onToggleDiff = useCallback(() => {
    if (!base.diffOpen) {
      requestRightPanel("diff");
      closeBrowserPanel();
    } else {
      requestRightPanel(null);
    }

    void base.navigate({
      to: "/$threadId",
      params: { threadId: base.threadId },
      replace: true,
      search: (previous) =>
        base.diffOpen ? closeDiffRouteSearch(previous) : openDiffRouteSearch(previous),
    });
  }, [base]);

  const onToggleBrowser = useCallback(() => {
    toggleBrowserPanel();
  }, []);

  const toggleSearchOpen = useSearchStore((state) => state.toggleSearchOpen);
  const onToggleSearch = useCallback(() => {
    toggleSearchOpen();
  }, [toggleSearchOpen]);

  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (base.threads.some((threadItem) => threadItem.id === targetThreadId)) {
        base.setStoreThreadError(targetThreadId, error);
        return;
      }
      base.setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [base],
  );

  const turnActions = useTurnActions({
    activeThread: base.activeThread,
    activeThreadId: base.activeThreadId,
    phase: thread.phase,
    isSendBusy: thread.isSendBusy,
    isConnecting: base.isConnecting,
    isRevertingCheckpoint: base.isRevertingCheckpoint,
    setIsRevertingCheckpoint: base.setIsRevertingCheckpoint,
    setThreadError,
    setStoreThreadError: base.setStoreThreadError,
  });

  const activePendingIsResponding = thread.activePendingUserInput
    ? turnActions.respondingUserInputRequestIds.includes(thread.activePendingUserInput.requestId)
    : false;

  const composerFooterActionLayoutKey = useMemo(() => {
    if (thread.activePendingProgress && !thread.isOpencodePendingUserInputMode) {
      return `pending:${thread.activePendingProgress.questionIndex}:${thread.activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (thread.phase === "running") {
      return "running";
    }
    if (thread.showPlanFollowUpPrompt) {
      return base.prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${base.composerSendState.hasSendableContent}:${thread.isSendBusy}:${base.isConnecting}:${thread.isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    base.composerSendState.hasSendableContent,
    base.isConnecting,
    base.prompt,
    thread.activePendingProgress,
    thread.isOpencodePendingUserInputMode,
    thread.isPreparingWorktree,
    thread.isSendBusy,
    thread.phase,
    thread.showPlanFollowUpPrompt,
  ]);

  const focusComposer = useCallback(() => {
    base.composerEditorRef.current?.focusAtEnd();
  }, [base.composerEditorRef]);

  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);

  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!base.activeThread) {
        return;
      }
      const snapshot = base.composerEditorRef.current?.readSnapshot() ?? {
        value: base.promptRef.current,
        cursor: base.composerCursor,
        expandedCursor: expandCollapsedComposerCursor(base.promptRef.current, base.composerCursor),
        terminalContextIds: base.composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = base.insertComposerDraftTerminalContext(
        base.activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: base.activeThread.id,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      base.promptRef.current = insertion.prompt;
      base.setComposerCursor(nextCollapsedCursor);
      base.setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        base.composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [base],
  );

  const terminalActions = useTerminalActions({
    activeThread: base.activeThread,
    activeThreadId: base.activeThreadId,
    activeProject: base.activeProject,
    gitCwd: composer.gitCwd,
    terminalState: base.terminalState,
    storeSetTerminalOpen: base.storeSetTerminalOpen,
    storeSplitTerminal: base.storeSplitTerminal,
    storeNewTerminal: base.storeNewTerminal,
    storeSetActiveTerminal: base.storeSetActiveTerminal,
    storeCloseTerminal: base.storeCloseTerminal,
    setTerminalFocusRequestId: base.setTerminalFocusRequestId,
    setTerminalLaunchContext: base.setTerminalLaunchContext,
    setLastInvokedScriptByProjectId: base.setLastInvokedScriptByProjectId,
    setThreadError,
  });

  const projectScripts = useProjectScripts({ activeProject: base.activeProject });

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === base.runtimeMode) return;
      base.setComposerDraftRuntimeMode(base.threadId, mode);
      if (base.isLocalDraftThread) {
        base.setDraftThreadContext(base.threadId, { runtimeMode: mode });
      }
      scheduleComposerFocus();
    },
    [base, scheduleComposerFocus],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === base.interactionMode) return;
      base.setComposerDraftInteractionMode(base.threadId, mode);
      if (base.isLocalDraftThread) {
        base.setDraftThreadContext(base.threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [base, scheduleComposerFocus],
  );

  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(base.interactionMode === "plan" ? "default" : "plan");
  }, [base.interactionMode, handleInteractionModeChange]);

  const togglePlanSidebar = useCallback(() => {
    base.setPlanSidebarOpen((open) => {
      if (open) {
        base.planSidebarDismissedForTurnRef.current =
          thread.activePlan?.turnId ?? thread.sidebarProposedPlan?.turnId ?? "__dismissed__";
      } else {
        base.planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [base, thread.activePlan?.turnId, thread.sidebarProposedPlan?.turnId]);

  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!base.serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        !modelSelectionsEqual(input.modelSelection, base.serverThread.modelSelection)
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== base.serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== base.serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [base.serverThread],
  );

  const scrollBehavior = useScrollBehavior({
    activeThreadId: base.activeThreadId,
    composerFooterActionLayoutKey,
    composerFooterHasWideActions: thread.composerFooterHasWideActions,
    messageCount: timeline.timelineEntries.length,
    phase: thread.phase,
    composerFormRef: base.composerFormRef,
    shouldUseCompactComposerFooter,
    shouldUseCompactComposerPrimaryActions,
  });

  const envLocked = Boolean(
    base.activeThread &&
    (base.activeThread.messages.length > 0 ||
      (base.activeThread.session !== null && base.activeThread.session.status !== "closed")),
  );

  return {
    openPullRequestDialog,
    closePullRequestDialog,
    handlePreparedPullRequestThread,
    onToggleDiff,
    onToggleBrowser,
    onToggleSearch,
    setThreadError,
    turnActions,
    activePendingIsResponding,
    composerFooterActionLayoutKey,
    focusComposer,
    scheduleComposerFocus,
    addTerminalContextToDraft,
    terminalActions,
    projectScripts,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    togglePlanSidebar,
    persistThreadSettingsForNextTurn,
    scrollBehavior,
    envLocked,
  };
}

export type ChatViewRuntimeState = ReturnType<typeof useChatViewRuntime>;
