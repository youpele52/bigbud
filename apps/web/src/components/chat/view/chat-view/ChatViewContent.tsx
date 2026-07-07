import { type MessageId } from "@bigbud/contracts";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "~/logic/composer";

import { ContentPanelHeader } from "../../../layout/ContentPanelHeader";
import { ChatHeader } from "../../common/ChatHeader";
import { ExpandedImageOverlay } from "../../common/ExpandedImageOverlay";
import { ProviderSwitchBranchModal } from "./ProviderSwitchBranchModal";
import { ScrollToBottomPill } from "../../common/ScrollToBottomPill";
import { deriveUserTurnAnchorsFromThreadMessages } from "../../scroller/chatScroll.timelineRows";
import { ThreadReaderOutline } from "../../scroller/ThreadReaderOutline";
import { ThreadErrorBanner } from "../../common/ThreadErrorBanner";
import { WorkingIndicator } from "../../common/WorkingIndicator";
import { MessagesTimeline } from "../../messages/MessagesTimeline";
import { FloatingPlanCard } from "../../plan/FloatingPlanCard";
import { PullRequestThreadDialog } from "../../plan/PullRequestThreadDialog";
import { OrchestraDialog } from "../../orchestra/OrchestraDialog";
import { ProviderStatusBanner } from "../../provider/ProviderStatusBanner";
import { ContextWindowWarningBanner } from "../../common/ContextWindowWarningBanner";
import { PersistentThreadTerminalDrawer } from "../ChatView.terminalDrawer";
import BranchToolbar from "../../../git/BranchToolbar";
import { useSearchStore } from "../../../../stores/ui";
import { useRightPanelTabsStore } from "../../../../stores/rightPanel/rightPanelTabs.store";
import { useThreadActions } from "../../../../hooks/useThreadActions";
import { deriveDisplayedUserMessageState } from "../../../../lib/terminalContext";
import { resolveWorkspaceExecutionTargetId } from "../../../../lib/providerExecutionTargets";

import { ChatViewComposer } from "./ChatViewComposer";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { type ChatViewTimelineState } from "./chat-view-timeline.hooks";

const REPLY_PREVIEW_MAX_CHARS = 240;

function truncateReplyPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= REPLY_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, REPLY_PREVIEW_MAX_CHARS - 3).trimEnd()}...`;
}

interface ChatViewContentProps {
  base: ChatViewBaseState;
  thread: ChatViewThreadDerivedState;
  composer: ChatViewComposerDerivedState;
  timeline: ChatViewTimelineState;
  runtime: ChatViewRuntimeState;
  interactions: ChatViewInteractionsState;
}

export function ChatViewContent({
  base,
  thread,
  composer,
  timeline,
  runtime,
  interactions,
}: ChatViewContentProps) {
  const { branchThread } = useThreadActions();
  const searchFocusRequest = useSearchStore((state) => state.focusRequest);
  const clearSearchFocusRequest = useSearchStore((state) => state.clearFocusRequest);
  const rightPanelOpen = useRightPanelTabsStore((state) => state.rightPanelOpen);
  const [focusMessageId, setFocusMessageId] = useState<MessageId | null>(null);
  const [orchestraOpen, setOrchestraOpen] = useState(false);

  const handoffAvailable = base.isServerThread;
  const compactAvailable = composer.supportsCompact;

  const onUseHandoffFromBanner = useCallback(() => {
    const activeThread = base.activeThread;
    if (!activeThread) {
      return;
    }
    void interactions.onCreateHandoffBranch(
      activeThread.modelSelection,
      "Continue this work in a fresh branch with the generated handoff.",
    );
  }, [base.activeThread, interactions]);

  const onCompactFromBanner = useCallback(() => {
    const nextPrompt = "/compact";
    base.promptRef.current = nextPrompt;
    base.setPrompt(nextPrompt);
    base.setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    base.setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    interactions.onSend();
  }, [base, interactions]);
  const projectWorkspaceExecutionTargetId = base.activeProject
    ? resolveWorkspaceExecutionTargetId(base.activeProject)
    : undefined;

  // Prefer the active worktree path so proposed-plan saves land in the right
  // directory when a thread is running in a worktree rather than project root.
  const workspaceRoot = base.activeThread?.worktreePath ?? base.activeProject?.cwd ?? undefined;

  // Auto-open the floating plan card when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  const { planCardOpen, planCardDismissedForTurnRef, setPlanCardOpen, activeLatestTurn } = base;
  useEffect(() => {
    if (!thread.activePlan) return;
    if (planCardOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && thread.activePlan.turnId !== latestTurnId) return;
    const turnKey = thread.activePlan.turnId ?? thread.cardProposedPlan?.turnId ?? "__dismissed__";
    if (planCardDismissedForTurnRef.current === turnKey) return;
    setPlanCardOpen(true);
  }, [
    thread.activePlan,
    activeLatestTurn?.turnId,
    planCardOpen,
    thread.cardProposedPlan?.turnId,
    planCardDismissedForTurnRef,
    setPlanCardOpen,
  ]);

  const handleReplyToMessage = useCallback(
    (messageId: MessageId) => {
      const message = base.activeThread?.messages.find((entry) => entry.id === messageId);
      if (!message) {
        return;
      }
      base.setComposerReplyTarget(base.activeThread!.id, {
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        excerpt: truncateReplyPreview(
          message.role === "user"
            ? deriveDisplayedUserMessageState(message.text).copyText || "(empty message)"
            : message.text || "(empty message)",
        ),
      });
      runtime.scheduleComposerFocus();
    },
    [base, runtime],
  );

  const handleOpenReplySource = useCallback(
    (messageId: MessageId) => {
      runtime.scrollBehavior.scrollToMessage(messageId, {
        align: "center",
        behavior: "smooth",
      });
      setFocusMessageId(null);
      window.requestAnimationFrame(() => {
        setFocusMessageId(messageId);
      });
    },
    [runtime.scrollBehavior],
  );

  const userTurnAnchors = useMemo(
    () => deriveUserTurnAnchorsFromThreadMessages(base.activeThread?.messages ?? []),
    [base.activeThread?.messages],
  );

  const handleJumpToTurn = useCallback(
    (messageId: MessageId) => {
      const didScroll = runtime.scrollBehavior.scrollToMessage(messageId, {
        align: "start",
        behavior: "smooth",
      });
      if (!didScroll) {
        handleOpenReplySource(messageId);
      }
    },
    [handleOpenReplySource, runtime.scrollBehavior],
  );

  useEffect(() => {
    if (!searchFocusRequest) {
      return;
    }
    if (searchFocusRequest.threadId !== base.activeThread?.id) {
      return;
    }

    handleOpenReplySource(searchFocusRequest.messageId);
    clearSearchFocusRequest(searchFocusRequest.requestId);
  }, [base.activeThread?.id, clearSearchFocusRequest, handleOpenReplySource, searchFocusRequest]);

  const handleClosePlanCard = useCallback(() => {
    base.setPlanCardOpen(false);
    base.planCardDismissedForTurnRef.current =
      thread.activePlan?.turnId ?? thread.cardProposedPlan?.turnId ?? "__dismissed__";
  }, [base, thread.activePlan?.turnId, thread.cardProposedPlan?.turnId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <ContentPanelHeader>
        <ChatHeader
          activeThreadId={base.activeThread!.id}
          activeThreadTitle={base.activeThread!.title}
          activeProjectName={base.activeProject?.name}
          openInCwd={workspaceRoot ?? null}
          activeProjectScripts={base.activeProject?.scripts}
          preferredScriptId={interactions.preferredScriptId}
          keybindings={composer.keybindings}
          availableEditors={composer.availableEditors}
          executionTargetId={projectWorkspaceExecutionTargetId}
          sidebarToggleShortcutLabel={composer.sidebarToggleShortcutLabel}
          rightPanelToggleShortcutLabel={composer.rightPanelToggleShortcutLabel}
          rightPanelOpen={rightPanelOpen}
          onOpenOrchestra={() => setOrchestraOpen(true)}
          onRunProjectScript={(script) => {
            void runtime.terminalActions.runProjectScript(script);
          }}
          onAddProjectScript={runtime.projectScripts.saveProjectScript}
          onUpdateProjectScript={runtime.projectScripts.updateProjectScript}
          onDeleteProjectScript={runtime.projectScripts.deleteProjectScript}
          onToggleRightPanel={runtime.onToggleRightPanel}
        />
      </ContentPanelHeader>

      <ProviderStatusBanner status={composer.activeProviderStatus} />
      <ContextWindowWarningBanner
        usage={thread.activeContextWindow}
        handoffAvailable={handoffAvailable}
        compactAvailable={compactAvailable}
        onUseHandoff={onUseHandoffFromBanner}
        onCompact={onCompactFromBanner}
      />
      <ThreadErrorBanner
        error={base.activeThread!.error}
        onDismiss={() => runtime.setThreadError(base.activeThread!.id, null)}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1">
              <div
                ref={runtime.scrollBehavior.setMessagesScrollContainerRef}
                className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4 [scrollbar-gutter:stable]"
                onScroll={runtime.scrollBehavior.onMessagesScroll}
                onClickCapture={runtime.scrollBehavior.onMessagesClickCapture}
                onWheel={runtime.scrollBehavior.onMessagesWheel}
                onPointerDown={runtime.scrollBehavior.onMessagesPointerDown}
                onPointerUp={runtime.scrollBehavior.onMessagesPointerUp}
                onPointerCancel={runtime.scrollBehavior.onMessagesPointerCancel}
                onTouchStart={runtime.scrollBehavior.onMessagesTouchStart}
                onTouchMove={runtime.scrollBehavior.onMessagesTouchMove}
                onTouchEnd={runtime.scrollBehavior.onMessagesTouchEnd}
                onTouchCancel={runtime.scrollBehavior.onMessagesTouchEnd}
              >
                {base.activeThread?.parentThread ? (
                  <div className="mb-4 flex items-center gap-3">
                    <span className="h-px flex-1 bg-border" />
                    <Link
                      to="/$threadId"
                      params={{
                        threadId: base.activeThread.parentThread.threadId,
                      }}
                      className="rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80 outline-hidden transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Branched from {base.activeThread.parentThread.title}
                    </Link>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {base.activeThread && (base.activeThread.watchingThreads?.length ?? 0) > 0 ? (
                  <div className="mb-4 flex flex-wrap items-center justify-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                      Watching
                    </span>
                    {base.activeThread.watchingThreads!.map((watch) => (
                      <Link
                        key={watch.threadId}
                        to="/$threadId"
                        params={{ threadId: watch.threadId }}
                        className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground outline-hidden transition-colors hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {watch.title}
                      </Link>
                    ))}
                  </div>
                ) : null}
                <MessagesTimeline
                  key={base.activeThread!.id}
                  isWorking={thread.isWorking}
                  activeTurnInProgress={interactions.activeTurnInProgress}
                  activeTurnStartedAt={thread.activeWorkStartedAt}
                  scrollContainer={runtime.scrollBehavior.messagesScrollElement}
                  timelineEntries={timeline.timelineEntries}
                  completionDividerBeforeEntryId={timeline.completionDividerBeforeEntryId}
                  completionSummary={thread.completionSummary}
                  turnDiffSummaryByAssistantMessageId={timeline.turnDiffSummaryByAssistantMessageId}
                  nowIso={thread.nowIso}
                  expandedWorkGroups={base.expandedWorkGroups}
                  onToggleWorkGroup={interactions.onToggleWorkGroup}
                  changedFilesExpandedByTurnId={base.threadChangedFilesExpandedByTurnId}
                  onSetChangedFilesExpanded={(turnId, expanded) => {
                    if (!base.isServerThread) {
                      return;
                    }

                    base.setThreadChangedFilesExpanded(base.activeThread!.id, turnId, expanded);
                  }}
                  onOpenTurnDiff={interactions.onOpenTurnDiff}
                  revertTurnCountByUserMessageId={timeline.revertTurnCountByUserMessageId}
                  onRevertUserMessage={interactions.onRevertUserMessage}
                  isRevertingCheckpoint={base.isRevertingCheckpoint}
                  onImageExpand={base.setExpandedImage}
                  markdownCwd={composer.gitCwd ?? undefined}
                  resolvedTheme={base.resolvedTheme}
                  timestampFormat={base.timestampFormat}
                  workspaceRoot={workspaceRoot}
                  workspaceExecutionTargetId={projectWorkspaceExecutionTargetId}
                  focusMessageId={focusMessageId}
                  onReplyToMessage={handleReplyToMessage}
                  onOpenReplySource={handleOpenReplySource}
                  onBranchThread={(messageId) => {
                    void branchThread(base.activeThread!.id, {
                      upToMessageId: messageId,
                      navigateToBranch: true,
                    });
                  }}
                  onReaderPositionChange={runtime.scrollBehavior.updateReaderPosition}
                />
              </div>

              <div className="pointer-events-none absolute top-1/2 right-2 z-20 flex h-[75%] w-10 -translate-y-1/2 items-center justify-end sm:right-2 sm:w-10">
                <ThreadReaderOutline
                  anchors={userTurnAnchors}
                  currentAnchorMessageId={
                    runtime.scrollBehavior.readerPosition.currentAnchorMessageId
                  }
                  onJumpToMessage={handleJumpToTurn}
                />
              </div>
            </div>

            {interactions.pendingProviderSwitchConfirmation ? (
              <ProviderSwitchBranchModal
                targetLabel={interactions.pendingProviderSwitchConfirmation.targetLabel}
                selectedMode={interactions.branchMode}
                onSelectMode={interactions.setBranchMode}
                isGeneratingHandoff={interactions.isGeneratingHandoff}
                handoffError={interactions.handoffError}
                onCancel={interactions.onDismissPendingProviderSwitch}
                onConfirm={interactions.onConfirmPendingProviderSwitch}
              />
            ) : null}

            {base.planCardOpen ? (
              <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-auto">
                <div className="pointer-events-auto w-full sm:w-[22rem]">
                  <FloatingPlanCard
                    activePlan={thread.activePlan}
                    activeProposedPlan={thread.cardProposedPlan}
                    label={thread.planCardLabel}
                    markdownCwd={composer.gitCwd ?? undefined}
                    workspaceRoot={workspaceRoot}
                    workspaceExecutionTargetId={projectWorkspaceExecutionTargetId}
                    timestampFormat={base.timestampFormat}
                    onClose={handleClosePlanCard}
                  />
                </div>
              </div>
            ) : null}

            {runtime.scrollBehavior.showScrollToBottom ? (
              <ScrollToBottomPill
                onScrollToBottom={() => runtime.scrollBehavior.scrollMessagesToBottom("auto")}
              />
            ) : null}

            {/* Working indicator — absolute overlay pinned to the bottom of the messages area */}
            {thread.isWorking ? (
              <WorkingIndicator
                verb={thread.workingVerb}
                activeWorkStartedAt={thread.activeWorkStartedAt}
                nowIso={thread.nowIso}
              />
            ) : null}
          </div>

          <div className="px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">
            <ChatViewComposer
              base={base}
              composer={composer}
              thread={thread}
              runtime={runtime}
              interactions={interactions}
              onOpenOrchestra={() => setOrchestraOpen(true)}
              onOpenReplySource={handleOpenReplySource}
            />
          </div>

          <BranchToolbar
            threadId={base.activeThread!.id}
            envLocked={runtime.envLocked}
            isGitRepo={composer.isGitRepo}
            onComposerFocusRequest={runtime.scheduleComposerFocus}
            {...(base.canCheckoutPullRequestIntoThread
              ? {
                  onCheckoutPullRequestRequest: runtime.openPullRequestDialog,
                }
              : {})}
          />

          {base.pullRequestDialogState ? (
            <PullRequestThreadDialog
              key={base.pullRequestDialogState.key}
              open
              threadId={base.activeThread!.id}
              cwd={base.activeProject?.cwd ?? null}
              executionTargetId={projectWorkspaceExecutionTargetId}
              initialReference={base.pullRequestDialogState.initialReference}
              onOpenChange={(open) => {
                if (!open) {
                  runtime.closePullRequestDialog();
                }
              }}
              onPrepared={runtime.handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
      </div>

      {base.mountedTerminalThreadIds.map((mountedThreadId) => (
        <PersistentThreadTerminalDrawer
          key={mountedThreadId}
          threadId={mountedThreadId}
          visible={mountedThreadId === base.activeThreadId && base.terminalState.terminalOpen}
          launchContext={
            mountedThreadId === base.activeThreadId
              ? (base.activeTerminalLaunchContext ?? null)
              : null
          }
          focusRequestId={mountedThreadId === base.activeThreadId ? base.terminalFocusRequestId : 0}
          splitShortcutLabel={composer.splitTerminalShortcutLabel ?? undefined}
          newShortcutLabel={composer.newTerminalShortcutLabel ?? undefined}
          closeShortcutLabel={composer.closeTerminalShortcutLabel ?? undefined}
          keybindings={composer.keybindings}
          onAddTerminalContext={runtime.addTerminalContextToDraft}
        />
      ))}

      {base.expandedImage ? (
        <ExpandedImageOverlay
          expandedImage={base.expandedImage}
          onClose={interactions.closeExpandedImage}
          onNavigate={interactions.navigateExpandedImage}
        />
      ) : null}

      <OrchestraDialog
        activeProject={base.activeProject}
        activeThread={base.activeThread}
        defaultModelSelection={composer.selectedModelSelection}
        discoveredAgents={composer.discoveredAgents}
        discoveredSkills={composer.discoveredSkills}
        modelOptionsByProvider={composer.modelOptionsByProvider}
        open={orchestraOpen}
        providers={composer.providerStatuses}
        prompt={base.prompt}
        resolvedTheme={base.resolvedTheme}
        runtimeMode={base.runtimeMode}
        onOpenChange={setOrchestraOpen}
      />
    </div>
  );
}
