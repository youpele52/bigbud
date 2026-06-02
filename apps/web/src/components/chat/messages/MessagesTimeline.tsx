import { type MessageId } from "@bigbud/contracts";
import { BigbudLogo } from "../../sidebar/SidebarProjectItem";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { measureElement as measureVirtualElement, useVirtualizer } from "@tanstack/react-virtual";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../../utils/scroll";
import {
  deriveMessagesTimelineRows,
  estimateMessagesTimelineRowHeight,
} from "./MessagesTimeline.logic";
import {
  NonVirtualizedMessagesTimelineRows,
  VirtualizedMessagesTimelineRows,
} from "./MessagesTimeline.render";
import {
  clampVirtualizedRowCount,
  getMessagesTimelineRowMeasurementKey,
  resolveFirstUnvirtualizedRowIndex,
} from "./MessagesTimeline.virtualization";
import { type MessagesTimelineProps } from "./MessagesTimeline.shared";

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  workspaceExecutionTargetId,
  focusMessageId = null,
  onReplyToMessage = () => {},
  onOpenReplySource = () => {},
  onBranchThread,
  onVirtualizerSnapshot,
}: MessagesTimelineProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState<number | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<MessageId | null>(null);
  const lastProcessedFocusMessageIdRef = useRef<MessageId | null>(null);

  useLayoutEffect(() => {
    const timelineRoot = timelineRootRef.current;
    if (!timelineRoot) return;

    const updateWidth = (nextWidth: number) => {
      setTimelineWidthPx((previousWidth) => {
        if (previousWidth !== null && Math.abs(previousWidth - nextWidth) < 0.5) {
          return previousWidth;
        }
        return nextWidth;
      });
    };

    updateWidth(timelineRoot.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      updateWidth(timelineRoot.getBoundingClientRect().width);
    });
    observer.observe(timelineRoot);
    return () => {
      observer.disconnect();
    };
  }, []);

  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
      }),
    [timelineEntries, completionDividerBeforeEntryId, isWorking, activeTurnStartedAt],
  );

  const firstUnvirtualizedRowIndex = useMemo(() => {
    return resolveFirstUnvirtualizedRowIndex({
      activeTurnInProgress,
      activeTurnStartedAt,
      rows,
      expandedWorkGroups,
      changedFilesExpandedByTurnId,
    });
  }, [
    activeTurnInProgress,
    activeTurnStartedAt,
    changedFilesExpandedByTurnId,
    expandedWorkGroups,
    rows,
  ]);

  const virtualizedRowCount = clampVirtualizedRowCount(firstUnvirtualizedRowIndex, rows.length);

  // Snap to the bottom when the first rows appear after an initially empty render.
  // This handles the case where the thread loads with no messages but then receives
  // streaming content — without this, the scroll position stays at the top.
  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [scrollContainer, rows.length]);
  const virtualMeasurementScopeKey =
    timelineWidthPx === null ? "width:unknown" : `width:${Math.round(timelineWidthPx)}`;

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Scope cached row measurements to the current timeline width so offscreen
    // rows do not keep stale heights after wrapping changes.
    getItemKey: (index: number) => {
      const row = rows[index];
      if (!row) return `${virtualMeasurementScopeKey}:${index}`;
      return `${virtualMeasurementScopeKey}:${getMessagesTimelineRowMeasurementKey(row)}`;
    },
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      return estimateMessagesTimelineRowHeight(row, {
        expandedWorkGroups,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
      });
    },
    measureElement: measureVirtualElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  useEffect(() => {
    if (timelineWidthPx === null) return;
    rowVirtualizer.measure();
  }, [rowVirtualizer, timelineWidthPx]);
  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      const scrollOffset = instance.scrollOffset ?? 0;
      const itemIntersectsViewport =
        item.end > scrollOffset && item.start < scrollOffset + viewportHeight;
      if (itemIntersectsViewport) {
        return false;
      }
      const remainingDistance = instance.getTotalSize() - (scrollOffset + viewportHeight);
      return remainingDistance > AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };
    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      rowVirtualizer.measure();
    });
  }, [rowVirtualizer]);
  useEffect(() => {
    return () => {
      const frame = pendingMeasureFrameRef.current;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);
  useEffect(() => {
    if (!focusMessageId) {
      lastProcessedFocusMessageIdRef.current = null;
      return;
    }
    if (lastProcessedFocusMessageIdRef.current === focusMessageId) {
      return;
    }

    const rowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.id === focusMessageId,
    );
    if (rowIndex < 0) {
      return;
    }

    lastProcessedFocusMessageIdRef.current = focusMessageId;

    if (rowIndex < virtualizedRowCount) {
      rowVirtualizer.scrollToIndex(rowIndex, { align: "center" });
    }

    const frameId = window.requestAnimationFrame(() => {
      const element = timelineRootRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(focusMessageId)}"]`,
      );
      element?.scrollIntoView({ block: "center", behavior: "smooth" });
      setFocusedMessageId(focusMessageId);
    });
    const timeoutId = window.setTimeout(() => {
      setFocusedMessageId((current: MessageId | null) =>
        current === focusMessageId ? null : current,
      );
    }, 2_000);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, [focusMessageId, rowVirtualizer, rows, virtualizedRowCount]);
  useLayoutEffect(() => {
    if (!onVirtualizerSnapshot) {
      return;
    }
    onVirtualizerSnapshot({
      totalSize: rowVirtualizer.getTotalSize(),
      measurements: rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .flatMap((measurement) => {
          const row = rows[measurement.index];
          if (!row) {
            return [];
          }
          return [
            {
              id: row.id,
              kind: row.kind,
              index: measurement.index,
              size: measurement.size,
              start: measurement.start,
              end: measurement.end,
            },
          ];
        }),
    });
  }, [onVirtualizerSnapshot, rowVirtualizer, rows, virtualizedRowCount]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <BigbudLogo className="h-8 opacity-70" />
      </div>
    );
  }

  return (
    <div
      ref={timelineRootRef}
      data-timeline-root="true"
      className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden"
    >
      {virtualizedRowCount > 0 && (
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          <VirtualizedMessagesTimelineRows
            rows={rows}
            virtualRows={virtualRows}
            measureElement={rowVirtualizer.measureElement}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
            completionSummary={completionSummary}
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
            onSetChangedFilesExpanded={onSetChangedFilesExpanded}
            onOpenTurnDiff={onOpenTurnDiff}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={onRevertUserMessage}
            isRevertingCheckpoint={isRevertingCheckpoint}
            onImageExpand={onImageExpand}
            markdownCwd={markdownCwd}
            resolvedTheme={resolvedTheme}
            nowIso={nowIso}
            timestampFormat={timestampFormat}
            workspaceRoot={workspaceRoot}
            workspaceExecutionTargetId={workspaceExecutionTargetId}
            focusedMessageId={focusedMessageId}
            onReplyToMessage={onReplyToMessage}
            onOpenReplySource={onOpenReplySource}
            {...(onBranchThread ? { onBranchThread } : {})}
            isWorking={isWorking}
            onTimelineImageLoad={onTimelineImageLoad}
          />
        </div>
      )}

      <NonVirtualizedMessagesTimelineRows
        rows={nonVirtualizedRows}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={onToggleWorkGroup}
        completionSummary={completionSummary}
        turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
        changedFilesExpandedByTurnId={changedFilesExpandedByTurnId}
        onSetChangedFilesExpanded={onSetChangedFilesExpanded}
        onOpenTurnDiff={onOpenTurnDiff}
        revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
        onRevertUserMessage={onRevertUserMessage}
        isRevertingCheckpoint={isRevertingCheckpoint}
        onImageExpand={onImageExpand}
        markdownCwd={markdownCwd}
        resolvedTheme={resolvedTheme}
        nowIso={nowIso}
        timestampFormat={timestampFormat}
        workspaceRoot={workspaceRoot}
        workspaceExecutionTargetId={workspaceExecutionTargetId}
        focusedMessageId={focusedMessageId}
        onReplyToMessage={onReplyToMessage}
        onOpenReplySource={onOpenReplySource}
        {...(onBranchThread ? { onBranchThread } : {})}
        isWorking={isWorking}
        onTimelineImageLoad={onTimelineImageLoad}
      />
    </div>
  );
});
