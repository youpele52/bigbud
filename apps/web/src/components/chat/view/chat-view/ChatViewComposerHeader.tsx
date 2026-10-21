import { ComposerPendingApprovalPanel } from "../../composer/ComposerPendingApprovalPanel";
import { ComposerPlanFollowUpBanner } from "../../composer/ComposerPlanFollowUpBanner";
import { ComposerPromptQueue } from "../../composer/ComposerPromptQueue";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewComposerHeaderProps {
  threadId: string;
  thread: ChatViewThreadDerivedState;
  interactions: ChatViewInteractionsState;
}

export function ChatViewComposerHeader({
  threadId,
  thread,
  interactions,
}: ChatViewComposerHeaderProps) {
  return (
    <>
      {thread.activePendingApproval ? (
        <div className="rounded-t-[calc(var(--card-surface-radius)-1px)] border-b border-border/65 bg-muted/20">
          <ComposerPendingApprovalPanel
            approval={thread.activePendingApproval}
            pendingCount={thread.pendingApprovals.length}
          />
        </div>
      ) : thread.showPlanFollowUpPrompt && thread.activeProposedPlan ? (
        <ComposerPlanFollowUpBanner
          key={thread.activeProposedPlan.id}
          planTitle={interactions.planTitle}
          planId={thread.activeProposedPlan.id}
          threadId={threadId}
        />
      ) : null}
      <ComposerPromptQueue
        queuedPrompts={interactions.promptQueue.queuedPrompts}
        canSendNow={!thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode}
        onRemovePrompt={interactions.promptQueue.removeQueuedPrompt}
        onInterruptAndFlush={() => {
          void interactions.promptQueue.interruptAndFlushQueuedPrompts();
        }}
        canSteer={thread.activeSessionTurnRunning && interactions.promptQueue.canSteer}
        controlOperation={interactions.promptQueue.controlOperation}
        onSteer={() => {
          void interactions.promptQueue.steerQueuedPrompts();
        }}
      />
    </>
  );
}
