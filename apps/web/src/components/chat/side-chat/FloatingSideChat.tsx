import { type ThreadId } from "@bigbud/contracts";
import { MessageCirclePlus, MinusIcon, XIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { MessagesTimeline } from "~/components/chat/messages/MessagesTimeline";
import { WorkingIndicator } from "~/components/chat/common/WorkingIndicator";
import {
  ThreadActivityDots,
  threadActivityLabel,
} from "~/components/chat/common/threadActivityIndicator";
import { ChatViewComposer } from "~/components/chat/view/chat-view/ChatViewComposer";
import {
  ThreadComposerSurface,
  type ThreadComposerSurfaceContext,
} from "~/components/chat/view/ThreadComposerSurface";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { resolveWorkspaceExecutionTargetId } from "~/lib/providerExecutionTargets";
import { useSideChatStore } from "~/stores/sideChat";

import { attachSidecarToComposer, closeSideChat } from "./sideChat.actions";
import { useSideChatAutoScroll } from "./sideChat.scroll.hooks";

function SidecarHeaderAction(props: {
  disabled?: boolean | undefined;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      size="icon-xs"
      variant="ghost"
      className="text-muted-foreground/50 hover:text-foreground/70"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{button}</TooltipTrigger>
      <TooltipPopup side="top">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function SideChatConversation({
  workspaceRoot,
  ...context
}: ThreadComposerSurfaceContext & { workspaceRoot: string | undefined }) {
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);
  const [timelineContent, setTimelineContent] = useState<HTMLDivElement | null>(null);
  const { onScroll } = useSideChatAutoScroll({
    contentElement: timelineContent,
    contentVersion: context.timeline.timelineEntries,
    isWorking: context.thread.isWorking,
    scrollContainer,
  });
  const workspaceExecutionTargetId = context.base.activeThread
    ? resolveWorkspaceExecutionTargetId(context.base.activeThread)
    : undefined;

  return (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={setScrollContainer}
          onScroll={onScroll}
          className="h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-3 [scrollbar-gutter:stable]"
        >
          <div ref={setTimelineContent} className="h-full">
            <MessagesTimeline
              isWorking={context.thread.isWorking}
              activeTurnInProgress={context.interactions.activeTurnInProgress}
              activeTurnStartedAt={context.thread.activeWorkStartedAt}
              scrollContainer={scrollContainer}
              timelineEntries={context.timeline.timelineEntries}
              completionDividerBeforeEntryId={context.timeline.completionDividerBeforeEntryId}
              completionSummary={context.thread.completionSummary}
              turnDiffSummaryByAssistantMessageId={
                context.timeline.turnDiffSummaryByAssistantMessageId
              }
              nowIso={context.thread.nowIso}
              expandedWorkGroups={context.base.expandedWorkGroups}
              onToggleWorkGroup={context.interactions.onToggleWorkGroup}
              changedFilesExpandedByTurnId={context.base.threadChangedFilesExpandedByTurnId}
              onSetChangedFilesExpanded={(turnId, expanded) => {
                if (!context.base.activeThread) return;
                context.base.setThreadChangedFilesExpanded(
                  context.base.activeThread.id,
                  turnId,
                  expanded,
                );
              }}
              onOpenTurnDiff={() => undefined}
              revertTurnCountByUserMessageId={context.timeline.revertTurnCountByUserMessageId}
              onRevertUserMessage={context.interactions.onRevertUserMessage}
              isRevertingCheckpoint={context.base.isRevertingCheckpoint}
              onImageExpand={context.base.setExpandedImage}
              markdownCwd={workspaceRoot}
              resolvedTheme={context.base.resolvedTheme}
              timestampFormat={context.base.timestampFormat}
              workspaceRoot={workspaceRoot}
              workspaceExecutionTargetId={workspaceExecutionTargetId}
            />
          </div>
        </div>
        {context.thread.isWorking ? (
          <WorkingIndicator
            verb={context.thread.workingVerb}
            activeWorkStartedAt={context.thread.activeWorkStartedAt}
            nowIso={context.thread.nowIso}
          />
        ) : null}
      </div>
      <div className="px-3 py-2">
        <ChatViewComposer
          base={context.base}
          className="max-w-none"
          compact
          composer={context.composer}
          thread={context.thread}
          runtime={context.runtime}
          interactions={context.interactions}
          onOpenOrchestra={() => undefined}
          onOpenReplySource={() => undefined}
        />
      </div>
    </>
  );
}

function SidecarContent(props: {
  context: ThreadComposerSurfaceContext;
  mainThreadId: ThreadId;
  messageCount: number;
  onFocusMainComposer: () => void;
  onMinimize: () => void;
  threadId: ThreadId;
  workspaceRoot: string | undefined;
}) {
  const { context } = props;
  const activityTone = context.thread.isCompacting ? "compacting" : "running";

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium text-sm text-foreground/92">Sidecar</span>
          {context.thread.isWorking ? (
            <span
              role="status"
              title={threadActivityLabel(activityTone)}
              className="inline-flex items-center text-info-foreground"
            >
              <span aria-hidden="true" className="inline-flex items-center gap-[3px] pr-1">
                <ThreadActivityDots tone={activityTone} dotClassName="h-1 w-1" />
              </span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <SidecarHeaderAction
            label="Add chat as context"
            disabled={props.messageCount === 0}
            icon={<MessageCirclePlus className="size-3.5" />}
            onClick={() => {
              const attached = attachSidecarToComposer({
                mainThreadId: props.mainThreadId,
                sidecarThreadId: props.threadId,
              });
              if (attached) {
                props.onFocusMainComposer();
              }
            }}
          />
          <SidecarHeaderAction
            label="Minimize"
            icon={<MinusIcon className="size-3.5" />}
            onClick={props.onMinimize}
          />
          <SidecarHeaderAction
            label="Close"
            icon={<XIcon className="size-3.5" />}
            onClick={() => void closeSideChat(props.threadId)}
          />
        </div>
      </div>
      <SideChatConversation {...context} workspaceRoot={props.workspaceRoot} />
    </>
  );
}

export function FloatingSideChat({
  mainThreadId,
  messageCount,
  onFocusMainComposer,
  threadId,
  workspaceRoot,
}: {
  mainThreadId: ThreadId;
  messageCount: number;
  onFocusMainComposer: () => void;
  threadId: ThreadId;
  workspaceRoot: string | undefined;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const minimize = useSideChatStore((state) => state.minimize);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const root = panel?.closest<HTMLElement>("[data-chat-view-root]");
    const composer = root?.querySelector<HTMLElement>("[data-chat-composer-form]");
    if (!root || !composer) return;

    const updateComposerHeight = () => {
      const composerHeight = composer.offsetHeight;
      root.style.setProperty("--side-chat-composer-height", `${composerHeight}px`);
      root.style.setProperty(
        "--side-chat-available-height",
        `${Math.max(0, root.clientHeight - composerHeight - 24)}px`,
      );
    };
    updateComposerHeight();
    const clearLayoutVariables = () => {
      root.style.removeProperty("--side-chat-composer-height");
      root.style.removeProperty("--side-chat-available-height");
    };
    if (typeof ResizeObserver === "undefined") {
      return clearLayoutVariables;
    }
    const observer = new ResizeObserver(updateComposerHeight);
    observer.observe(composer);
    observer.observe(root);
    return () => {
      observer.disconnect();
      clearLayoutVariables();
    };
  }, []);

  return (
    <div
      ref={panelRef}
      className="absolute right-3 z-30 flex h-[min(66dvh,var(--side-chat-available-height,66dvh))] min-h-0 max-h-[var(--side-chat-available-height,calc(100dvh-1.5rem))] w-[min(32rem,calc(50%-0.75rem))] resize-y flex-col overflow-hidden rounded-[24px] border border-border/80 bg-background/92 text-card-foreground shadow-[0_18px_54px_rgba(0,0,0,0.24)] supports-[backdrop-filter]:bg-background/80 supports-[backdrop-filter]:backdrop-blur-md"
      style={{ bottom: "calc(var(--side-chat-composer-height, 7rem) + 0.75rem)" }}
    >
      <ThreadComposerSurface threadId={threadId}>
        {(context) => (
          <SidecarContent
            context={context}
            mainThreadId={mainThreadId}
            messageCount={messageCount}
            onFocusMainComposer={onFocusMainComposer}
            onMinimize={minimize}
            threadId={threadId}
            workspaceRoot={workspaceRoot}
          />
        )}
      </ThreadComposerSurface>
    </div>
  );
}
