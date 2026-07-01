import { type MessageId } from "@bigbud/contracts";

import {
  CHAT_SCROLL_MARGIN_PX,
  CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX,
  type ChatReaderPosition,
  type ChatScrollAnchorRow,
  type ChatScrollMessageRow,
} from "./chatScroll.constants";

export function resolveReadingLineScrollOffset(
  scrollTop: number,
  options?: {
    marginPx?: number;
    peekPx?: number;
  },
): number {
  const marginPx = options?.marginPx ?? CHAT_SCROLL_MARGIN_PX;
  const peekPx = options?.peekPx ?? CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX;
  return scrollTop + marginPx + peekPx;
}

export function deriveCurrentAnchorMessageId(
  anchorRows: ReadonlyArray<ChatScrollAnchorRow>,
  scrollTop: number,
  options?: {
    marginPx?: number;
    peekPx?: number;
  },
): MessageId | null {
  const readingLine = resolveReadingLineScrollOffset(scrollTop, options);
  let currentAnchorMessageId: MessageId | null = null;

  for (const anchorRow of anchorRows) {
    if (anchorRow.start <= readingLine + 0.5) {
      currentAnchorMessageId = anchorRow.messageId;
    } else {
      break;
    }
  }

  return currentAnchorMessageId;
}

export function deriveVisibleMessageIds(
  messageRows: ReadonlyArray<ChatScrollMessageRow>,
  scrollTop: number,
  viewportHeight: number,
): ReadonlyArray<MessageId> {
  if (viewportHeight <= 0) {
    return [];
  }

  const viewportStart = scrollTop;
  const viewportEnd = scrollTop + viewportHeight;

  return messageRows
    .filter((row) => row.end > viewportStart && row.start < viewportEnd)
    .map((row) => row.messageId);
}

export function deriveChatReaderPosition(input: {
  anchorRows: ReadonlyArray<ChatScrollAnchorRow>;
  messageRows: ReadonlyArray<ChatScrollMessageRow>;
  scrollTop: number;
  viewportHeight: number;
}): ChatReaderPosition {
  return {
    currentAnchorMessageId: deriveCurrentAnchorMessageId(input.anchorRows, input.scrollTop),
    visibleMessageIds: deriveVisibleMessageIds(
      input.messageRows,
      input.scrollTop,
      input.viewportHeight,
    ),
  };
}

export function readerPositionEquals(
  previous: ChatReaderPosition,
  next: ChatReaderPosition,
): boolean {
  if (previous.currentAnchorMessageId !== next.currentAnchorMessageId) {
    return false;
  }
  if (previous.visibleMessageIds.length !== next.visibleMessageIds.length) {
    return false;
  }
  return previous.visibleMessageIds.every(
    (messageId, index) => messageId === next.visibleMessageIds[index],
  );
}
