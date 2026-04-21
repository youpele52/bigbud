import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "~/config/env";
import { cn } from "~/lib/utils";

import { ChatHeader } from "../../common/ChatHeader";
import { ConfirmationPanel } from "../../../common/ConfirmationPanel";
import { ExpandedImageOverlay } from "../../common/ExpandedImageOverlay";
import { PendingApprovalDialog } from "../../composer/PendingApprovalDialog";
import { ScrollToBottomPill } from "../../common/ScrollToBottomPill";
import { ThreadErrorBanner } from "../../common/ThreadErrorBanner";
import { MessagesTimeline } from "../../messages/MessagesTimeline";
import { formatWorkingTimer } from "../../messages/MessagesTimeline.assistantMessage";
import { PullRequestThreadDialog } from "../../plan/PullRequestThreadDialog";
import PlanSidebar from "../../plan/PlanSidebar";
import { ProviderStatusBanner } from "../../provider/ProviderStatusBanner";
import { PersistentThreadTerminalDrawer } from "../ChatView.terminalDrawer";
import BranchToolbar from "../../../git/BranchToolbar";
import { Card } from "../../../ui/card";

import { ChatViewComposer } from "./ChatViewComposer";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";
import { type ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import { type ChatViewRuntimeState } from "./chat-view-runtime.hooks";
import { type ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { type ChatViewTimelineState } from "./chat-view-timeline.hooks";

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
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false);
  const lastApprovalRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    const requestId = thread.activePendingApproval?.requestId ?? null;
    if (!requestId) {
      setApprovalDialogOpen(false);
      lastApprovalRequestIdRef.current = null;
      return;
    }
    if (lastApprovalRequestIdRef.current !== requestId) {
      lastApprovalRequestIdRef.current = requestId;
      setApprovalDialogOpen(true);
    }
  }, [thread.activePendingApproval]);

  const activeApprovalRequestId = thread.activePendingApproval?.requestId ?? null;
  const isRespondingToActiveApproval =
    activeApprovalRequestId !== null &&
    runtime.turnActions.respondingRequestIds.includes(activeApprovalRequestId);

  // Prefer the active worktree path so proposed-plan saves land in the right
  // directory when a thread is running in a worktree rather than project root.
  const workspaceRoot = base.activeThread?.worktreePath ?? base.activeProject?.cwd ?? undefined;

  // Auto-open the plan sidebar when plan/todo steps arrive for the current turn.
  // Don't auto-open for plans carried over from a previous turn (the user can open manually).
  const { planSidebarOpen, planSidebarDismissedForTurnRef, setPlanSidebarOpen, activeLatestTurn } =
    base;
  useEffect(() => {
    if (!thread.activePlan) return;
    if (planSidebarOpen) return;
    const latestTurnId = activeLatestTurn?.turnId ?? null;
    if (latestTurnId && thread.activePlan.turnId !== latestTurnId) return;
    const turnKey =
      thread.activePlan.turnId ?? thread.sidebarProposedPlan?.turnId ?? "__dismissed__";
    if (planSidebarDismissedForTurnRef.current === turnKey) return;
    setPlanSidebarOpen(true);
  }, [
    thread.activePlan,
    activeLatestTurn?.turnId,
    planSidebarOpen,
    thread.sidebarProposedPlan?.turnId,
    planSidebarDismissedForTurnRef,
    setPlanSidebarOpen,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
        )}
      >
        <ChatHeader
          activeThreadId={base.activeThread!.id}
          activeThreadTitle={base.activeThread!.title}
          activeProjectName={base.activeProject?.name}
          isGitRepo={composer.isGitRepo}
          openInCwd={composer.gitCwd}
          activeProjectScripts={base.activeProject?.scripts}
          preferredScriptId={interactions.preferredScriptId}
          keybindings={composer.keybindings}
          availableEditors={composer.availableEditors}
          terminalAvailable={base.activeProject !== undefined}
          terminalOpen={base.terminalState.terminalOpen}
          terminalToggleShortcutLabel={composer.terminalToggleShortcutLabel}
          diffToggleShortcutLabel={composer.diffPanelShortcutLabel}
          sidebarToggleShortcutLabel={composer.sidebarToggleShortcutLabel}
          searchToggleShortcutLabel={composer.searchToggleShortcutLabel}
          gitCwd={composer.gitCwd}
          diffOpen={base.diffOpen}
          onRunProjectScript={(script) => {
            void runtime.terminalActions.runProjectScript(script);
          }}
          onAddProjectScript={runtime.projectScripts.saveProjectScript}
          onUpdateProjectScript={runtime.projectScripts.updateProjectScript}
          onDeleteProjectScript={runtime.projectScripts.deleteProjectScript}
          onToggleTerminal={runtime.terminalActions.toggleTerminalVisibility}
          onToggleDiff={runtime.onToggleDiff}
          onToggleSearch={runtime.onToggleSearch}
        />
      </header>

      <ProviderStatusBanner status={composer.activeProviderStatus} />
      <ThreadErrorBanner
        error={base.activeThread!.error}
        onDismiss={() => runtime.setThreadError(base.activeThread!.id, null)}
      />

      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              ref={runtime.scrollBehavior.setMessagesScrollContainerRef}
              className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
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
              />
            </div>

            {interactions.pendingProviderSwitchConfirmation ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center px-4 py-6">
                <button
                  type="button"
                  aria-label="Dismiss provider switch confirmation"
                  className="absolute inset-0 bg-background/60 backdrop-blur-[1px]"
                  onClick={interactions.onDismissPendingProviderSwitch}
                />
                <Card className="relative w-full max-w-sm border-border/80 bg-background/96 shadow-lg/10">
                  <ConfirmationPanel
                    title={`Start a new ${interactions.pendingProviderSwitchConfirmation.targetLabel} branch?`}
                    description="Switching providers after a thread has started creates a branch so the current conversation stays on its existing provider."
                    cancelLabel="Cancel"
                    confirmLabel="Create branch"
                    onCancel={interactions.onDismissPendingProviderSwitch}
                    onConfirm={interactions.onConfirmPendingProviderSwitch}
                  />
                </Card>
              </div>
            ) : null}

            {runtime.scrollBehavior.showScrollToBottom ? (
              <ScrollToBottomPill
                onScrollToBottom={() => runtime.scrollBehavior.scrollMessagesToBottom("smooth")}
              />
            ) : null}

            {/* Working indicator — absolute overlay pinned to the bottom of the messages area */}
            {thread.isWorking ? (
              <div className="pointer-events-none absolute bottom-1 left-0 right-0 flex justify-center px-5">
                <div className="mx-auto w-full max-w-3xl px-1 py-0.5">
                  <div className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground/70 px-7 ">
                    <span className="leading-none">{thread.workingVerb}</span>
                    <span className="inline-flex items-center gap-[3px] leading-none">
                      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30" />
                      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
                      <span className="h-1 w-1 animate-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
                    </span>
                    <span className="flex-1" />
                    {thread.activeWorkStartedAt ? (
                      <span className="leading-none">
                        {formatWorkingTimer(thread.activeWorkStartedAt, thread.nowIso) ?? "0s"}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="px-3 pt-1.5 pb-1 sm:px-5 sm:pt-2">
            <ChatViewComposer
              base={base}
              composer={composer}
              thread={thread}
              runtime={runtime}
              interactions={interactions}
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

        {base.planSidebarOpen ? (
          <PlanSidebar
            activePlan={thread.activePlan}
            activeProposedPlan={thread.sidebarProposedPlan}
            label={thread.planSidebarLabel}
            markdownCwd={composer.gitCwd ?? undefined}
            workspaceRoot={workspaceRoot}
            timestampFormat={base.timestampFormat}
            onClose={() => {
              base.setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              base.planSidebarDismissedForTurnRef.current =
                thread.activePlan?.turnId ?? thread.sidebarProposedPlan?.turnId ?? "__dismissed__";
            }}
          />
        ) : null}
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

      {thread.activePendingApproval ? (
        <PendingApprovalDialog
          approval={thread.activePendingApproval}
          pendingCount={thread.pendingApprovals.length}
          open={approvalDialogOpen}
          isResponding={isRespondingToActiveApproval}
          onOpenChange={setApprovalDialogOpen}
          onRespondToApproval={runtime.turnActions.onRespondToApproval}
        />
      ) : null}
    </div>
  );
}
