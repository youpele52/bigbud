import { clamp } from "effect/Number";

import { type MessagesTimelineRow } from "./MessagesTimeline.logic";
import { ALWAYS_UNVIRTUALIZED_TAIL_ROWS } from "./MessagesTimeline.shared";

export function resolveFirstUnvirtualizedRowIndex(input: {
  activeTurnInProgress: boolean;
  activeTurnStartedAt: string | null;
  rows: ReadonlyArray<MessagesTimelineRow>;
}): number {
  const { activeTurnInProgress, activeTurnStartedAt, rows } = input;
  const firstTailRowIndex = Math.max(rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS, 0);
  if (!activeTurnInProgress) return firstTailRowIndex;

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

  if (firstCurrentTurnRowIndex < 0) return firstTailRowIndex;

  for (let index = firstCurrentTurnRowIndex - 1; index >= 0; index -= 1) {
    const previousRow = rows[index];
    if (!previousRow || previousRow.kind !== "message") continue;
    if (previousRow.message.role === "user") {
      return Math.min(index, firstTailRowIndex);
    }
    if (previousRow.message.role === "assistant" && !previousRow.message.streaming) {
      break;
    }
  }

  return Math.min(firstCurrentTurnRowIndex, firstTailRowIndex);
}

export function clampVirtualizedRowCount(count: number, rowCount: number): number {
  return clamp(count, {
    minimum: 0,
    maximum: rowCount,
  });
}
