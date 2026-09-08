import { Link } from "@tanstack/react-router";
import { useCallback } from "react";

import { useThreadActions } from "~/hooks/useThreadActions";
import BranchToolbar from "~/components/git/BranchToolbar";
import { ContextWindowWarningBanner } from "../../common/ContextWindowWarningBanner";
import { ProviderSwitchBranchModal } from "./ProviderSwitchBranchModal";
import { ProviderStatusBanner } from "../../provider/ProviderStatusBanner";
import { ThreadErrorBanner } from "../../common/ThreadErrorBanner";
import { MessagesTimeline } from "../../messages/MessagesTimeline";
import { ThreadReaderOutline } from "../../scroller/ThreadReaderOutline";
import { FloatingPlanCard } from "../../plan/FloatingPlanCard";
import { PullRequestThreadDialog } from "../../plan/PullRequestThreadDialog";
import { ScrollToBottomPill } from "../../common/ScrollToBottomPill";
import { WorkingIndicator } from "../../common/WorkingIndicator";
import { ChatViewMainComposer } from "./ChatViewMainComposer";
import { useChatViewContentHandlers } from "./ChatViewContent.handlers";
import type { ChatViewBaseState } from "./chat-view-base-state.hooks";
import type { ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import type { ChatViewTimelineState } from "./chat-view-timeline.hooks";

interface ChatViewChatBodyProps {
  readonly base: ChatViewBaseState;
  readonly composer: ChatViewComposerDerivedState;
  readonly interactions: ChatViewInteractionsState;
  readonly projectWorkspaceExecutionTargetId: string | undefined;
  readonly runtime: ChatViewRuntimeState;
  readonly thread: ChatViewThreadDerivedState;
  readonly timeline: ChatViewTimelineState;
  readonly workspaceRoot: string | undefined;
  readonly onOpenOrchestra: () => void;
}

export function ChatViewChatBody({
  base,
  composer,
  interactions,
  projectWorkspaceExecutionTargetId,
  runtime,
  thread,
  timeline,
  workspaceRoot,
  onOpenOrchestra,
}: ChatViewChatBodyProps) {
  const { branchThread } = useThreadActions();
  const {
    focusMessageId,
    handleClosePlanCard,
    handleJumpToTurn,
    handleOpenReplySource,
    handleReplyToMessage,
    userTurnAnchors,
  } = useChatViewContentHandlers({ base, runtime, thread });
  const onUseHandoffFromBanner = useCallback(() => {
    if (!base.activeThread) return;
    void interactions.onCreateHandoffBranch(
      base.activeThread.modelSelection,
      "Continue this work in a fresh branch with the generated handoff.",
    );
  }, [base.activeThread, interactions]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-chat-body>
      <ProviderStatusBanner status={composer.activeProviderStatus} />
      <ContextWindowWarningBanner
        threadId={base.activeThread!.id}
        usage={thread.activeContextWindow}
        handoffAvailable={base.isServerThread}
        onUseHandoff={onUseHandoffFromBanner}
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
                      params={{ threadId: base.activeThread.parentThread.threadId }}
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
                    if (base.isServerThread) {
                      base.setThreadChangedFilesExpanded(base.activeThread!.id, turnId, expanded);
                    }
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
            {thread.isWorking ? (
              <WorkingIndicator
                verb={thread.workingVerb}
                activeWorkStartedAt={thread.activeWorkStartedAt}
                nowIso={thread.nowIso}
              />
            ) : null}
          </div>

          <ChatViewMainComposer
            base={base}
            composer={composer}
            thread={thread}
            runtime={runtime}
            interactions={interactions}
            onOpenOrchestra={onOpenOrchestra}
            onOpenReplySource={handleOpenReplySource}
          />

          <BranchToolbar
            threadId={base.activeThread!.id}
            envLocked={runtime.envLocked}
            isGitRepo={composer.isGitRepo}
            onComposerFocusRequest={runtime.scheduleComposerFocus}
            {...(base.canCheckoutPullRequestIntoThread
              ? { onCheckoutPullRequestRequest: runtime.openPullRequestDialog }
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
                if (!open) runtime.closePullRequestDialog();
              }}
              onPrepared={runtime.handlePreparedPullRequestThread}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
