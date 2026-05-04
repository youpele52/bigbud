import { GitPullRequestIcon, TerminalIcon, Trash2Icon } from "lucide-react";
import {
  useCallback,
  type Dispatch,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";

import { type ThreadId, type GitStatusResult } from "@bigbud/contracts";
import { useIsThreadRunning, useSidebarThreadSummaryById } from "../../stores/main";
import { useUiStateStore } from "../../stores/ui";
import { selectThreadTerminalState } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import { resolveThreadStatusPill, resolveThreadRowClassName } from "./Sidebar.logic";
import { formatRelativeTimeLabel } from "../../utils/timestamp";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarThreadStatusLabel as ThreadStatusLabel } from "./SidebarThreadStatusLabel";
import { useSwipeRevealAction } from "./useSwipeRevealAction";
import { SidebarThreadRowActions } from "./SidebarThreadRow.actions";

export type ThreadPr = GitStatusResult["pr"];

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  tooltip: string;
  url: string;
}

export type SidebarProjectSnapshot = {
  expanded: boolean;
};

export function terminalStatusFromRunningIds(
  runningTerminalIds: string[],
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-info-foreground",
    pulse: true,
  };
}

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      colorClass: "text-success-foreground",
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-muted-foreground",
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-primary",
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export interface SidebarThreadRowProps {
  threadId: ThreadId;
  orderedProjectThreadIds: readonly ThreadId[];
  routeThreadId: ThreadId | null;
  selectedThreadIds: ReadonlySet<ThreadId>;
  showThreadJumpHints: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadId: ThreadId | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  /** Callback ref for the rename input — handles focus/select on mount. */
  onRenamingInputMount: (element: HTMLInputElement | null) => void;
  /** Returns whether the rename has already been committed. */
  hasRenameCommitted: () => boolean;
  /** Marks the rename as committed to prevent double-commit on blur. */
  markRenameCommitted: () => void;
  confirmingArchiveThreadId: ThreadId | null;
  setConfirmingArchiveThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  confirmArchiveButtonRefs: MutableRefObject<Map<ThreadId, HTMLButtonElement>>;
  handleThreadClick: (
    event: MouseEvent,
    threadId: ThreadId,
    orderedProjectThreadIds: readonly ThreadId[],
  ) => void;
  navigateToThread: (threadId: ThreadId) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadId: ThreadId,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (threadId: ThreadId, newTitle: string, originalTitle: string) => Promise<void>;
  cancelRename: () => void;
  attemptArchiveThread: (threadId: ThreadId) => Promise<void>;
  forkThread: (threadId: ThreadId) => Promise<void>;
  requestThreadDelete: (threadId: ThreadId) => Promise<void>;
  openPrLink: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  pr: ThreadPr | null;
  /** Optional render slot for extra status icons (e.g. compact ThreadStatusLabel for hidden threads). */
  hiddenThreadStatusSlot?: ReactNode;
}

export function SidebarThreadRow(props: SidebarThreadRowProps) {
  const thread = useSidebarThreadSummaryById(props.threadId);
  const effectiveThreadId = thread?.id ?? props.threadId;
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[props.threadId]);
  const runningTerminalIds = useTerminalStateStore(
    (state) =>
      selectThreadTerminalState(state.terminalStateByThreadId, props.threadId).runningTerminalIds,
  );
  // Global selector: true when session.status === "running" with an active turn.
  // Matches the same signal used by the chat view spinner.
  const isThreadRunning = useIsThreadRunning(props.threadId);

  const swipeReveal = useSwipeRevealAction<HTMLAnchorElement>({
    itemId: effectiveThreadId,
    disabled: props.renamingThreadId === effectiveThreadId,
  });
  const isActive = props.routeThreadId === effectiveThreadId;
  const isSelected = props.selectedThreadIds.has(effectiveThreadId);
  const isHighlighted = isActive || isSelected;
  const isAgentWorking = isThreadRunning;
  const threadStatus = thread
    ? resolveThreadStatusPill({
        thread: {
          ...thread,
          lastVisitedAt,
        },
      })
    : null;
  const visibleThreadStatus = threadStatus?.label === "Working" ? null : threadStatus;
  const prStatus = prStatusIndicator(props.pr);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const isConfirmingArchive =
    thread !== null && thread !== undefined
      ? props.confirmingArchiveThreadId === thread.id && !isThreadRunning
      : false;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : !isThreadRunning
      ? "pointer-events-none transition-opacity duration-150 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0"
      : "pointer-events-none";

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

  const handleForkAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void props.forkThread(effectiveThreadId);
    },
    [effectiveThreadId, props],
  );

  const handleArchiveAction = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void props.attemptArchiveThread(effectiveThreadId);
    },
    [effectiveThreadId, props],
  );

  if (!thread) {
    return null;
  }

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={() => {
        props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
      }}
      onBlurCapture={(event) => {
        const currentTarget = event.currentTarget;
        requestAnimationFrame(() => {
          if (currentTarget.contains(document.activeElement)) {
            return;
          }
          props.setConfirmingArchiveThreadId((current) => (current === thread.id ? null : current));
        });
      }}
    >
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
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
        <SidebarMenuSubButton
          render={<div role="button" tabIndex={0} />}
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
          onPointerMove={(event) => {
            props.setConfirmingArchiveThreadId((current) =>
              current === effectiveThreadId ? null : current,
            );
            swipeReveal.handlePointerMove(event);
          }}
          onPointerUp={swipeReveal.handlePointerUp}
          onPointerCancel={swipeReveal.handlePointerCancel}
          onWheel={swipeReveal.handleWheel}
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
            {visibleThreadStatus && <ThreadStatusLabel status={visibleThreadStatus} />}
            {isAgentWorking && (
              <span
                aria-hidden="true"
                title="Agent is working"
                className="inline-flex shrink-0 items-center justify-center"
              >
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info-foreground" />
              </span>
            )}
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
              <Tooltip>
                <TooltipTrigger
                  render={<span className="min-w-0 flex-1 truncate text-xs" title={thread.title} />}
                >
                  {thread.title}
                </TooltipTrigger>
                <TooltipPopup side="top">{thread.title}</TooltipPopup>
              </Tooltip>
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
              {isConfirmingArchive ? (
                <button
                  ref={(element) => {
                    if (element) {
                      props.confirmArchiveButtonRefs.current.set(thread.id, element);
                    } else {
                      props.confirmArchiveButtonRefs.current.delete(thread.id);
                    }
                  }}
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-archive-confirm-${thread.id}`}
                  aria-label={`Confirm archive ${thread.title}`}
                  className="absolute top-1/2 right-1 inline-flex h-5 -translate-y-1/2 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-[10px] font-medium text-destructive transition-colors hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.setConfirmingArchiveThreadId((current) =>
                      current === thread.id ? null : current,
                    );
                    void props.attemptArchiveThread(thread.id);
                  }}
                >
                  Confirm
                </button>
              ) : !isThreadRunning ? (
                <SidebarThreadRowActions
                  threadId={thread.id}
                  threadTitle={thread.title}
                  appSettingsConfirmThreadArchive={props.appSettingsConfirmThreadArchive}
                  confirmArchiveButtonRefs={props.confirmArchiveButtonRefs}
                  swipeRevealIsRevealed={swipeReveal.isRevealed}
                  handleForkAction={handleForkAction}
                  handleArchiveAction={handleArchiveAction}
                  setConfirmingArchiveThreadId={props.setConfirmingArchiveThreadId}
                />
              ) : null}
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
      </div>
    </SidebarMenuSubItem>
  );
}
