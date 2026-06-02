import { clamp } from "effect/Number";

import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  MIN_ALWAYS_UNVIRTUALIZED_TAIL_ROWS,
  RECENT_COMPLETED_TURNS_TO_KEEP_MOUNTED,
} from "./MessagesTimeline.shared";

function findTurnStartIndex(rows: ReadonlyArray<MessagesTimelineRow>, rowIndex: number): number {
  for (let index = rowIndex; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "user") {
      return index;
    }
  }

  return Math.max(rowIndex, 0);
}

function resolveRecentTurnsBoundaryIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  turnsToKeepMounted: number,
): number {
  if (turnsToKeepMounted <= 0 || rows.length === 0) {
    return rows.length;
  }

  let seenUserTurns = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === "message" && row.message.role === "user") {
      seenUserTurns += 1;
      if (seenUserTurns === turnsToKeepMounted) {
        return index;
      }
    }
  }

  return 0;
}

function resolveExpandedBoundaryIndex(input: {
  rows: ReadonlyArray<MessagesTimelineRow>;
  expandedWorkGroups?: Readonly<Record<string, boolean>>;
  changedFilesExpandedByTurnId?: Readonly<Record<string, boolean>>;
}): number {
  const { rows, expandedWorkGroups, changedFilesExpandedByTurnId } = input;
  let earliestExpandedRowIndex = rows.length;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }

    if (row.kind === "work" && expandedWorkGroups?.[row.id]) {
      earliestExpandedRowIndex = Math.min(
        earliestExpandedRowIndex,
        findTurnStartIndex(rows, index),
      );
      continue;
    }

    if (
      row.kind === "message" &&
      row.message.role === "assistant" &&
      row.message.turnId &&
      changedFilesExpandedByTurnId?.[row.message.turnId]
    ) {
      earliestExpandedRowIndex = Math.min(
        earliestExpandedRowIndex,
        findTurnStartIndex(rows, index),
      );
    }
  }

  return earliestExpandedRowIndex;
}

export function resolveFirstUnvirtualizedRowIndex(input: {
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  rows: ReadonlyArray<MessagesTimelineRow>;
  expandedWorkGroups?: Readonly<Record<string, boolean>>;
  changedFilesExpandedByTurnId?: Readonly<Record<string, boolean>>;
}): number {
  const {
    activeTurnInProgress,
    activeTurnStartedAt,
    rows,
    expandedWorkGroups,
    changedFilesExpandedByTurnId,
  } = input;
  const firstTailRowIndex = Math.max(rows.length - MIN_ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);

  let firstUnvirtualizedRowIndex = Math.min(
    firstTailRowIndex,
    resolveRecentTurnsBoundaryIndex(
      rows,
      RECENT_COMPLETED_TURNS_TO_KEEP_MOUNTED + (activeTurnInProgress ? 1 : 0),
    ),
    resolveExpandedBoundaryIndex({
      rows,
      ...(expandedWorkGroups ? { expandedWorkGroups } : {}),
      ...(changedFilesExpandedByTurnId ? { changedFilesExpandedByTurnId } : {}),
    }),
  );

  if (!activeTurnInProgress) return firstUnvirtualizedRowIndex;

  const turnStartedAtMs =
    typeof activeTurnStartedAt === "string" ? Date.parse(activeTurnStartedAt) : Number.NaN;
  let firstCurrentTurnRowIndex = -1;
  if (!Number.isNaN(turnStartedAtMs)) {
    firstCurrentTurnRowIndex = rows.findIndex((row) => {
      if (row.kind === "working") return true;
      if (!row.createdAt) return false;
      const rowCreatedAtMs = Date.parse(row.createdAt);
      return !Number.isNaN(rowCreatedAtMs) && rowCreatedAtMs >= turnStartedAtMs;
    });
  }

  if (firstCurrentTurnRowIndex < 0) {
    firstCurrentTurnRowIndex = rows.findIndex(
      (row) => row.kind === "message" && row.message.streaming,
    );
  }

  if (firstCurrentTurnRowIndex < 0) return firstUnvirtualizedRowIndex;

  for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
    const previousRow = rows[index];
    if (!previousRow || previousRow.kind !== "message") continue;
    if (previousRow.message.role === "user") {
      return Math.min(index, firstUnvirtualizedRowIndex);
    }
    if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
      break;
    }
  }

  return Math.min(firstCurrentTurnRowIndex, firstUnvirtualizedRowIndex);
}

export function clampVirtualizedRowCount(count: number, rowCount: number): number {
  return clamp(count, {
    minimum: 0,
    maximum: rowCount,
  });
}

export function getMessagesTimelineRowMeasurementKey(row: MessagesTimelineRow): string {
  if (row.kind !== "message") {
    return row.id;
  }

  if (row.message.role !== "user") {
    return row.id;
  }

  const attachmentCount = row.message.attachments?.length ?? 0;
  const replyKey = row.message.replyTo ? "reply" : "no-reply";
  return [row.id, row.message.text.length, attachmentCount, replyKey].join(":");
}
