import { ComposerPendingApprovalPanel } from "../../composer/ComposerPendingApprovalPanel";
import { ComposerPlanFollowUpBanner } from "../../composer/ComposerPlanFollowUpBanner";
import { ComposerPromptQueue } from "../../composer/ComposerPromptQueue";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";

interface ChatViewComposerHeaderProps {
  thread: ChatViewThreadDerivedState;
  interactions: ChatViewInteractionsState;
}

export function ChatViewComposerHeader({ thread, interactions }: ChatViewComposerHeaderProps) {
  return (
    <>
      {thread.activePendingApproval ? (
        <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
          <ComposerPendingApprovalPanel
            approval={thread.activePendingApproval}
            pendingCount={thread.pendingApprovals.length}
          />
        </div>
      ) : thread.showPlanFollowUpPrompt && thread.activeProposedPlan ? (
        <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
          <ComposerPlanFollowUpBanner
            key={thread.activeProposedPlan.id}
            planTitle={interactions.planTitle}
          />
        </div>
      ) : null}
      <ComposerPromptQueue
        queuedPrompts={interactions.promptQueue.queuedPrompts}
        canSendNow={!thread.isComposerApprovalState && !thread.isOpencodePendingUserInputMode}
        onRemovePrompt={interactions.promptQueue.removeQueuedPrompt}
        onInterruptAndFlush={() => {
          void interactions.promptQueue.interruptAndFlushQueuedPrompts();
        }}
      />
    </>
  );
}
