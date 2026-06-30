import { type MessageId } from "@bigbud/contracts";

import { estimateMessagesTimelineRowHeight } from "../messages/MessagesTimeline.logic";
import { type MessagesTimelineRow } from "../messages/MessagesTimeline.logic";
import { type ChatScrollAnchorRow, type ChatScrollMessageRow } from "./chatScroll.constants";

interface VirtualizerMeasurement {
  index: number;
  start: number;
  end: number;
  size: number;
}

interface DeriveChatScrollRowsInput {
  rows: ReadonlyArray<MessagesTimelineRow>;
  measurements: ReadonlyArray<VirtualizerMeasurement>;
  virtualizedRowCount: number;
  totalVirtualSize: number;
  scrollContainer: HTMLDivElement | null;
  estimateRowHeight?: (row: MessagesTimelineRow, index: number) => number;
}

function resolveRowHeightFromDom(
  scrollContainer: HTMLDivElement,
  row: MessagesTimelineRow,
): number | null {
  const element = scrollContainer.querySelector<HTMLElement>(
    `[data-timeline-row-id="${CSS.escape(row.id)}"]`,
  );
  if (!element) {
    return null;
  }
  return element.getBoundingClientRect().height;
}

export function deriveChatScrollRowsFromTimeline(input: DeriveChatScrollRowsInput): {
  anchorRows: ReadonlyArray<ChatScrollAnchorRow>;
  messageRows: ReadonlyArray<ChatScrollMessageRow>;
} {
  const anchorRows: ChatScrollAnchorRow[] = [];
  const messageRows: ChatScrollMessageRow[] = [];
  const estimateRowHeight =
    input.estimateRowHeight ??
    ((row: MessagesTimelineRow) =>
      estimateMessagesTimelineRowHeight(row, {
        timelineWidthPx: null,
      }));

  for (const measurement of input.measurements) {
    if (measurement.index >= input.virtualizedRowCount) {
      continue;
    }
    appendTimelineRowMeasurement({
      row: input.rows[measurement.index],
      start: measurement.start,
      end: measurement.end,
      anchorRows,
      messageRows,
    });
  }

  let offset = input.totalVirtualSize;
  for (let index = input.virtualizedRowCount; index < input.rows.length; index += 1) {
    const row = input.rows[index];
    if (!row) {
      continue;
    }

    const measuredHeight =
      input.scrollContainer !== null ? resolveRowHeightFromDom(input.scrollContainer, row) : null;
    const size = measuredHeight ?? estimateRowHeight(row, index);
    const start = offset;
    const end = offset + size;
    offset = end;

    appendTimelineRowMeasurement({
      row,
      start,
      end,
      anchorRows,
      messageRows,
    });
  }

  return { anchorRows, messageRows };
}

function appendTimelineRowMeasurement(input: {
  row: MessagesTimelineRow | undefined;
  start: number;
  end: number;
  anchorRows: ChatScrollAnchorRow[];
  messageRows: ChatScrollMessageRow[];
}) {
  const { row, start, end, anchorRows, messageRows } = input;
  if (!row || row.kind !== "message") {
    return;
  }

  messageRows.push({
    messageId: row.message.id,
    start,
    end,
  });

  if (row.message.role === "user") {
    anchorRows.push({
      messageId: row.message.id,
      start,
      end,
    });
  }
}

export function deriveUserTurnAnchorsFromThreadMessages(
  messages: ReadonlyArray<{
    id: MessageId;
    role: string;
    text: string;
  }>,
): ReadonlyArray<{ messageId: MessageId; label: string }> {
  const anchors: Array<{ messageId: MessageId; label: string }> = [];

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const normalized = message.text.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) {
      continue;
    }
    anchors.push({
      messageId: message.id,
      label: normalized.length > 42 ? `${normalized.slice(0, 39).trimEnd()}...` : normalized,
    });
  }

  return anchors;
}
