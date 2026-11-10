import { ChatGreeting } from "../common/ChatGreeting";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AUTO_SCROLL_BOTTOM_THRESHOLD_PX } from "../../../utils/scroll";
import { deriveChatReaderPosition } from "../scroller/chatScroll.readerPosition.logic";
import { deriveChatScrollRowsFromTimeline } from "../scroller/chatScroll.timelineRows";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import { estimateMessagesTimelineRowHeight } from "./MessagesTimeline.estimate";
import {
  NonVirtualizedMessagesTimelineRows,
  VirtualizedMessagesTimelineRows,
} from "./MessagesTimeline.render";
import {
  clampVirtualizedRowCount,
  getMessagesTimelineRowMeasurementKey,
  resolveFirstUnvirtualizedRowIndex,
} from "./MessagesTimeline.virtualization";
import {
  measureVisibleTimelineElement,
  resetTimelineMeasurements,
  useTimelineWidth,
} from "./MessagesTimeline.measurement";
import { useTailRowMeasurements } from "./MessagesTimeline.tailMeasurements";
import { type MessagesTimelineProps } from "./MessagesTimeline.shared";
import { useTimelineCitationFocus } from "./MessagesTimeline.questionFocus.hook";
import { useOlderMessagePages } from "./MessagesTimeline.olderPages";
import { OlderMessagesStatusRow } from "./MessagesTimeline.olderPagesRow";
import { TimelineThreadIdContext } from "./MessagesTimeline.truncatedMessage";
import { CHAT_COLUMN_CLASS_NAME } from "../common/chatColumn";

export const MessagesTimeline = memo(function MessagesTimeline({
  emptyChatGreeting,
  shimmerEmptyChat = false,
  isWorking,
  activeTurnInProgress,
  activeTurnStartedAt,
  scrollContainer,
  timelineEntries,
  historicalAgents = [],
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  nowIso,
  expandedWorkGroups,
  onToggleWorkGroup,
  activityAccordionOpenById,
  onSetActivityAccordionOpen,
  changedFilesExpandedByTurnId,
  onSetChangedFilesExpanded,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  markdownCwd,
  preferredProvider,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  onMarkdownAnchorClick,
  workspaceExecutionTargetId,
  focusMessageId = null,
  onReplyToMessage = () => {},
  onOpenReplySource = () => {},
  onBranchThread,
  onVirtualizerSnapshot,
  onReaderPositionChange,
  serverThreadId = null,
}: MessagesTimelineProps) {
  const rows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnStartedAt,
        historicalAgents,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnStartedAt,
      historicalAgents,
    ],
  );
  const { timelineRootRef, timelineWidthPx } = useTimelineWidth(rows.length > 0 || isWorking);

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
  const { measurementsRef: tailMeasurementsRef, measurementScopeKey: virtualMeasurementScopeKey } =
    useTailRowMeasurements({
      timelineRootRef,
      timelineWidthPx,
      rows,
      virtualizedRowCount,
      expandedWorkGroups,
      activityAccordionOpenById,
      changedFilesExpandedByTurnId,
    });

  const rowVirtualizer = useVirtualizer({
    count: virtualizedRowCount,
    getScrollElement: () => scrollContainer,
    // Scope cached row measurements to width and expansion state so offscreen
    // rows do not keep stale heights after layout changes.
    getItemKey: (index: number) => {
      const row = rows[index];
      if (!row) return `${virtualMeasurementScopeKey}:${index}`;
      return `${virtualMeasurementScopeKey}:${getMessagesTimelineRowMeasurementKey(row)}`;
    },
    estimateSize: (index: number) => {
      const row = rows[index];
      if (!row) return 96;
      const measuredTailHeight = tailMeasurementsRef.current.get(
        `${virtualMeasurementScopeKey}:${getMessagesTimelineRowMeasurementKey(row)}`,
      );
      if (measuredTailHeight !== undefined) return measuredTailHeight;
      return estimateMessagesTimelineRowHeight(row, {
        expandedWorkGroups,
        activityAccordionOpenById,
        timelineWidthPx,
        turnDiffSummaryByAssistantMessageId,
      });
    },
    measureElement: measureVisibleTimelineElement,
    useAnimationFrameWithResizeObserver: true,
    overscan: 8,
  });
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const olderPages = useOlderMessagePages({
    threadId: serverThreadId,
    scrollContainer,
    rowIds,
    readRowExtents: () =>
      rowVirtualizer.measurementsCache.slice(0, virtualizedRowCount).flatMap((measurement) => {
        const row = rows[measurement.index];
        return row ? [{ id: row.id, start: measurement.start, end: measurement.end }] : [];
      }),
  });
  const focusedMessageId = useTimelineCitationFocus({
    focusMessageId,
    rows,
    virtualizedRowCount,
    rowVirtualizer,
    timelineRootRef,
    onSetActivityAccordionOpen,
  });
  useLayoutEffect(() => {
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
  useLayoutEffect(() => {
    if (timelineWidthPx === null) return;
    resetTimelineMeasurements(rowVirtualizer);
  }, [rowVirtualizer, timelineWidthPx, virtualMeasurementScopeKey]);
  const pendingMeasureFrameRef = useRef<number | null>(null);
  const onTimelineImageLoad = useCallback(() => {
    if (pendingMeasureFrameRef.current !== null) return;
    pendingMeasureFrameRef.current = window.requestAnimationFrame(() => {
      pendingMeasureFrameRef.current = null;
      resetTimelineMeasurements(rowVirtualizer);
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

  useLayoutEffect(() => {
    if (!onReaderPositionChange || !scrollContainer || virtualizedRowCount === 0) {
      return;
    }

    const publishReaderPosition = () => {
      const measurements = rowVirtualizer.measurementsCache
        .slice(0, virtualizedRowCount)
        .map((measurement) => ({
          index: measurement.index,
          start: measurement.start,
          end: measurement.end,
          size: measurement.size,
        }));
      const { anchorRows, messageRows } = deriveChatScrollRowsFromTimeline({
        rows,
        measurements,
        virtualizedRowCount,
        totalVirtualSize: rowVirtualizer.getTotalSize(),
        scrollContainer,
        estimateRowHeight: (row) =>
          estimateMessagesTimelineRowHeight(row, {
            expandedWorkGroups,
            activityAccordionOpenById,
            timelineWidthPx,
            turnDiffSummaryByAssistantMessageId,
          }),
      });
      onReaderPositionChange(
        deriveChatReaderPosition({
          anchorRows,
          messageRows,
          scrollTop: scrollContainer.scrollTop,
          viewportHeight: scrollContainer.clientHeight,
        }),
      );
    };

    publishReaderPosition();
    scrollContainer.addEventListener("scroll", publishReaderPosition, { passive: true });
    return () => {
      scrollContainer.removeEventListener("scroll", publishReaderPosition);
    };
  }, [
    activityAccordionOpenById,
    expandedWorkGroups,
    onReaderPositionChange,
    rowVirtualizer,
    rows,
    scrollContainer,
    timelineWidthPx,
    turnDiffSummaryByAssistantMessageId,
    virtualizedRowCount,
  ]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const nonVirtualizedRows = rows.slice(virtualizedRowCount);

  if (rows.length === 0 && !isWorking) {
    return <ChatGreeting greeting={emptyChatGreeting ?? null} shimmer={shimmerEmptyChat} />;
  }

  return (
    <TimelineThreadIdContext.Provider value={serverThreadId}>
      <div
        ref={timelineRootRef}
        data-timeline-root="true"
        className={`${CHAT_COLUMN_CLASS_NAME} overflow-x-hidden`}
      >
        <OlderMessagesStatusRow status={olderPages.status} onRetry={olderPages.retry} />
        {virtualizedRowCount > 0 && (
          <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            <VirtualizedMessagesTimelineRows
              rows={rows}
              virtualRows={virtualRows}
              measureElement={rowVirtualizer.measureElement}
              expandedWorkGroups={expandedWorkGroups}
              onToggleWorkGroup={onToggleWorkGroup}
              activityAccordionOpenById={activityAccordionOpenById}
              onSetActivityAccordionOpen={onSetActivityAccordionOpen}
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
              preferredProvider={preferredProvider}
              resolvedTheme={resolvedTheme}
              nowIso={nowIso}
              timestampFormat={timestampFormat}
              workspaceRoot={workspaceRoot}
              onMarkdownAnchorClick={onMarkdownAnchorClick}
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
          measurementScopeKey={virtualMeasurementScopeKey}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={onToggleWorkGroup}
          activityAccordionOpenById={activityAccordionOpenById}
          onSetActivityAccordionOpen={onSetActivityAccordionOpen}
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
          preferredProvider={preferredProvider}
          resolvedTheme={resolvedTheme}
          nowIso={nowIso}
          timestampFormat={timestampFormat}
          workspaceRoot={workspaceRoot}
          onMarkdownAnchorClick={onMarkdownAnchorClick}
          workspaceExecutionTargetId={workspaceExecutionTargetId}
          focusedMessageId={focusedMessageId}
          onReplyToMessage={onReplyToMessage}
          onOpenReplySource={onOpenReplySource}
          {...(onBranchThread ? { onBranchThread } : {})}
          isWorking={isWorking}
          onTimelineImageLoad={onTimelineImageLoad}
        />
      </div>
    </TimelineThreadIdContext.Provider>
  );
});
