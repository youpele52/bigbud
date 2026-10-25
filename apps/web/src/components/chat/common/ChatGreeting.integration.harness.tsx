import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useParams } from "@tanstack/react-router";

import { useChatViewBaseState } from "../view/chat-view/chat-view-base-state.hooks";
import { useChatViewThreadDerivedState } from "../view/chat-view/chat-view-thread-derived.hooks";
import { useChatViewTimelineState } from "../view/chat-view/chat-view-timeline.hooks";
import { MessagesTimeline } from "../messages/MessagesTimeline";

/** Exercise the production draft, thread, and timeline hooks under the real app registry. */
export function ChatGreetingIntegrationHarness() {
  const threadId = useParams({
    strict: false,
    select: (params) => ThreadId.makeUnsafe(params.threadId!),
  });
  const base = useChatViewBaseState({ threadId });
  const thread = useChatViewThreadDerivedState(base);
  const timeline = useChatViewTimelineState({ base, thread });

  return (
    <div
      className="h-[400px]"
      data-testid="integration-chat"
      data-local-draft={base.isLocalDraftThread}
      data-working={thread.isWorking}
      data-entry-count={timeline.timelineEntries.length}
    >
      <MessagesTimeline
        emptyChatGreeting={timeline.emptyChatGreeting}
        shimmerEmptyChat={timeline.shimmerEmptyChat}
        isWorking={thread.isWorking}
        activeTurnInProgress={false}
        activeTurnStartedAt={thread.activeWorkStartedAt}
        scrollContainer={null}
        timelineEntries={timeline.timelineEntries}
        completionDividerBeforeEntryId={timeline.completionDividerBeforeEntryId}
        completionSummary={thread.completionSummary}
        turnDiffSummaryByAssistantMessageId={timeline.turnDiffSummaryByAssistantMessageId}
        nowIso={thread.nowIso}
        expandedWorkGroups={base.expandedWorkGroups}
        onToggleWorkGroup={() => {}}
        activityAccordionOpenById={base.activityAccordionOpenById}
        onSetActivityAccordionOpen={() => {}}
        changedFilesExpandedByTurnId={base.threadChangedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={timeline.revertTurnCountByUserMessageId}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={base.isRevertingCheckpoint}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme={base.resolvedTheme}
        timestampFormat={base.timestampFormat}
        workspaceRoot={undefined}
      />
    </div>
  );
}
