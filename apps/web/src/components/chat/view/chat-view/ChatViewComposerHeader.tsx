import { cn } from "~/lib/utils";
import { ComposerPendingApprovalPanel } from "../../composer/ComposerPendingApprovalPanel";
import { ComposerPlanFollowUpBanner } from "../../composer/ComposerPlanFollowUpBanner";
import { ComposerPromptQueue } from "../../composer/ComposerPromptQueue";
import type { ChatViewInteractionsState } from "./chat-view-interactions.hooks";
import type { ChatViewThreadDerivedState } from "./chat-view-thread-derived.hooks";
import { PendingUserInputPanel } from "./PendingUserInputPanel";

interface ChatViewComposerHeaderProps {
  threadId: string;
  thread: ChatViewThreadDerivedState;
  interactions: ChatViewInteractionsState;
  /** The compact composer shows only a pending question, as before it showed no header at all. */
  compact?: boolean;
}

const SLOT_TOP = "rounded-t-[calc(var(--card-surface-radius)-1px)]";
const SLOT = "border-b border-border/65 bg-muted/20";

export function ChatViewComposerHeader({
  threadId,
  thread,
  interactions,
  compact = false,
}: ChatViewComposerHeaderProps) {
  const banner = !compact && (thread.activePendingApproval || thread.showPlanFollowUpPrompt);
  const pendingQuestion =
    thread.activePendingUserInput && thread.activePendingProgress ? (
      <div className={cn(SLOT, !banner && SLOT_TOP)}>
        <PendingUserInputPanel
          pendingUserInput={thread.activePendingUserInput}
          progress={thread.activePendingProgress}
          compact={compact}
          disabled={interactions.pendingAction?.isResponding ?? false}
          onToggleOption={
            interactions.pendingUserInputHandlers.onToggleActivePendingUserInputOption
          }
          onSelectQuestion={
            interactions.pendingUserInputHandlers.setActivePendingUserInputQuestionIndex
          }
        />
      </div>
    ) : null;
  if (compact) return pendingQuestion;
  return (
    <>
      {thread.activePendingApproval ? (
        <div className={cn(SLOT_TOP, SLOT)}>
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
      {pendingQuestion}
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
