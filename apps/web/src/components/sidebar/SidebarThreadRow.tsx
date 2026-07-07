import { GitPullRequestIcon, TerminalIcon, Trash2Icon } from "lucide-react";
import { useCallback, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  BIGBUD_THREAD_CONTEXT_DRAG_MIME,
  serializeThreadContextDragPayload,
} from "./threadPanel.dnd";

import {
  useIsThreadCompacting,
  useIsThreadRunning,
  useSidebarThreadSummaryById,
} from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { selectThreadTerminalState } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import { SIDEBAR_COMPACT_ICON_SIZE_CLASS } from "./Sidebar.iconSizes";
import { resolveThreadStatusPill, resolveThreadRowClassName } from "./Sidebar.logic";
import { formatRelativeTimeLabel } from "../../utils/timestamp";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/provider/ProviderModelPicker.models";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarThreadStatusLabel as ThreadStatusLabel } from "./SidebarThreadStatusLabel";
import { SidebarAutomationThreadIcon } from "./SidebarAutomationThreadIcon";
import { useSwipeRevealAction } from "./useSwipeRevealAction";
import { SidebarThreadRowActions } from "./SidebarThreadRow.actions";
import {
  mergeRunningTerminalIds,
  prStatusIndicator,
  terminalStatusFromRunningIds,
  type ThreadPr,
} from "./SidebarThreadRow.status";
import { type SidebarThreadRowProps } from "./SidebarThreadRow.types";

export type { ThreadPr } from "./SidebarThreadRow.status";

function normalizeElevatorSummaryText(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

export function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const effectiveThreadId = thread?.id ?? props.threadId;
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    useShallow((state) => {
      const drawerRunningTerminalIds = selectThreadTerminalState(
        state.terminalStateByThreadId,
        props.threadId,
      ).runningTerminalIds;
      const panelRunningTerminalIds = selectThreadTerminalState(
        state.panelTerminalStateByThreadId,
        props.threadId,
      ).runningTerminalIds;

      return mergeRunningTerminalIds(drawerRunningTerminalIds, panelRunningTerminalIds);
    }),
  );
  // Global selector: true when session.status === "running" with an active turn.
  // Matches the same signal used by the chat view spinner.
  const isThreadRunning = useIsThreadRunning(props.threadId);
  const isThreadCompacting = useIsThreadCompacting(props.threadId);

  const swipeReveal = useSwipeRevealAction<HTMLAnchorElement>({
    itemId: effectiveThreadId,
    disabled: props.renamingThreadId === effectiveThreadId,
  });
  const isActive = props.routeThreadId === effectiveThreadId;
  const isSelected = props.selectedThreadIds.has(effectiveThreadId);
  const isHighlighted = isActive || isSelected;
  const threadStatus = thread
    ? resolveThreadStatusPill({
        thread: {
          ...thread,
          lastVisitedAt,
        },
      })
    : null;
  const visibleThreadStatus =
    threadStatus?.label === "Working" ||
    threadStatus?.label === "Compacting" ||
    threadStatus?.label === "Completed"
      ? null
      : threadStatus;
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isFavorite = props.favoriteThreadIds.has(effectiveThreadId);
  const isAutomationThread = props.automationThreadIds?.has(effectiveThreadId) ?? false;
  const threadMetaClassName =
    "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0";

  const handleDeleteAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      swipeReveal.clearGestureClickSuppression();
      swipeReveal.resetReveal();
      void props.requestThreadDelete(effectiveThreadId);
    },
    [effectiveThreadId, props, swipeReveal],
  );

  const handleBranchAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void props.branchThread(effectiveThreadId);
    },
    [effectiveThreadId, props],
  );

  const handleFavoriteAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void props.toggleFavoriteThread(effectiveThreadId);
    },
    [effectiveThreadId, props],
  );

  if (!thread) {
    return null;
  }

  const isThreadCompleted = threadStatus?.label === "Completed";
  const providerIconColor =
    thread.session?.status === "error"
      ? "text-destructive"
      : isThreadCompacting
        ? "text-warning"
        : isThreadRunning
          ? "text-info-foreground"
          : isThreadCompleted
            ? "text-success"
            : "text-muted-foreground";
  const providerIconAnimationClass = isThreadRunning ? "animate-breathe" : "";
  const normalizedTitle = normalizeElevatorSummaryText(thread.title);
  const normalizedElevatorSummary = normalizeElevatorSummaryText(thread.elevatorSummary);
  const hoverSummary =
    normalizedElevatorSummary.length > 0 && normalizedElevatorSummary !== normalizedTitle
      ? normalizedElevatorSummary
      : null;

  const threadRowContent = (
    <SidebarMenuSubButton
      render={<div role="button" tabIndex={0} />}
      draggable
      size="sm"
      isActive={isActive}
      data-testid={`thread-row-${thread.id}`}
      className={`${resolveThreadRowClassName({
        isActive,
        isSelected,
      })} relative isolate touch-pan-y will-change-transform ${
        swipeReveal.isDragging
          ? "transition-none"
          : "transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
      }`}
      style={{ transform: `translateX(${swipeReveal.revealOffset}px)` }}
      onPointerDown={swipeReveal.handlePointerDown}
      onPointerMove={swipeReveal.handlePointerMove}
      onPointerUp={swipeReveal.handlePointerUp}
      onPointerCancel={swipeReveal.handlePointerCancel}
      onWheel={swipeReveal.handleWheel}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(
          BIGBUD_THREAD_CONTEXT_DRAG_MIME,
          serializeThreadContextDragPayload({
            threadId: thread.id,
            title: thread.title,
          }),
        );
        event.dataTransfer.setData("text/plain", thread.title);
      }}
      onClick={(event) => {
        if (swipeReveal.consumeGestureClickSuppression()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (swipeReveal.isRevealed) {
          event.preventDefault();
          event.stopPropagation();
          swipeReveal.resetReveal();
          return;
        }
        props.handleThreadClick(event, thread.id, props.orderedProjectThreadIds);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && swipeReveal.isRevealed) {
          event.preventDefault();
          swipeReveal.resetReveal();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.navigateToThread(thread.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        swipeReveal.resetReveal();
        if (props.selectedThreadIds.size > 0 && props.selectedThreadIds.has(thread.id)) {
          void props.handleMultiSelectContextMenu({
            x: event.clientX,
            y: event.clientY,
          });
        } else {
          if (props.selectedThreadIds.size > 0) {
            props.clearSelection();
          }
          void props.handleThreadContextMenu(thread.id, {
            x: event.clientX,
            y: event.clientY,
          });
        }
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {prStatus && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={prStatus.tooltip}
                  className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                  onClick={(event) => {
                    props.openPrLink(event, prStatus.url);
                  }}
                >
                  <GitPullRequestIcon className="size-3" />
                </button>
              }
            />
            <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
          </Tooltip>
        )}
        {thread.session?.provider &&
          (() => {
            const Icon = PROVIDER_ICON_BY_PROVIDER[thread.session.provider];
            return (
              <Icon
                className={`size-3 shrink-0 ${providerIconColor} ${providerIconAnimationClass}`.trim()}
              />
            );
          })()}
        {visibleThreadStatus && (
          <ThreadStatusLabel
            status={visibleThreadStatus}
            hideDot={visibleThreadStatus.label === "Completed"}
          />
        )}
        {isAutomationThread ? <SidebarAutomationThreadIcon /> : null}
        {props.renamingThreadId === thread.id ? (
          <input
            ref={props.onRenamingInputMount}
            className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none sm:text-xs"
            value={props.renamingTitle}
            onChange={(event) => props.setRenamingTitle(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                event.preventDefault();
                props.markRenameCommitted();
                void props.commitRename(thread.id, props.renamingTitle, thread.title);
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.markRenameCommitted();
                props.cancelRename();
              }
            }}
            onBlur={() => {
              if (!props.hasRenameCommitted()) {
                void props.commitRename(thread.id, props.renamingTitle, thread.title);
              }
            }}
            onClick={(event) => event.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs">{thread.title}</span>
        )}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {terminalStatus && (
          <span
            role="img"
            aria-label={terminalStatus.label}
            title={terminalStatus.label}
            className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
          >
            <TerminalIcon className={`size-3 ${terminalStatus.pulse ? "animate-pulse" : ""}`} />
          </span>
        )}
        <div className="flex min-w-12 justify-end">
          <SidebarThreadRowActions
            threadId={thread.id}
            threadTitle={thread.title}
            swipeRevealIsRevealed={swipeReveal.isRevealed}
            isFavorite={isFavorite}
            handleBranchAction={handleBranchAction}
            handleFavoriteAction={handleFavoriteAction}
          />
          <span className={threadMetaClassName}>
            {props.showThreadJumpHints && props.jumpLabel ? (
              <span
                className="inline-flex h-5 items-center rounded-full border border-border/80 bg-background/90 px-1.5 font-mono text-[10px] font-medium tracking-tight text-foreground shadow-sm"
                title={props.jumpLabel}
              >
                {props.jumpLabel}
              </span>
            ) : (
              <span
                className={`text-[10px] ${
                  isHighlighted
                    ? "text-foreground/80 dark:text-foreground/85"
                    : "text-muted-foreground/70"
                }`}
              >
                {formatRelativeTimeLabel(
                  thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                )}
              </span>
            )}
          </span>
        </div>
      </div>
    </SidebarMenuSubButton>
  );

  return (
    <SidebarMenuSubItem className="w-full" data-thread-item>
      <div
        ref={swipeReveal.registerBoundaryElement}
        className="relative overflow-hidden rounded-lg"
      >
        <div
          className={`absolute inset-y-0 right-0 flex w-11 items-center justify-center transition-opacity duration-150 ${
            swipeReveal.isActionVisible
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          <button
            type="button"
            data-thread-selection-safe
            aria-label={`Delete ${thread.title}`}
            aria-hidden={!swipeReveal.isActionVisible}
            tabIndex={swipeReveal.isActionVisible ? 0 : -1}
            className="inline-flex size-8 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={handleDeleteAction}
          >
            <Trash2Icon className={SIDEBAR_COMPACT_ICON_SIZE_CLASS} />
          </button>
        </div>
        {hoverSummary ? (
          <Tooltip>
            <TooltipTrigger render={<div className="w-full" />}>{threadRowContent}</TooltipTrigger>
            <TooltipPopup side="right" className="max-w-72 whitespace-normal text-xs leading-snug">
              {hoverSummary}
            </TooltipPopup>
          </Tooltip>
        ) : (
          threadRowContent
        )}
      </div>
    </SidebarMenuSubItem>
  );
}
