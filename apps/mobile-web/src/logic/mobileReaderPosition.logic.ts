import { type MessageId } from "@bigbud/contracts";

import {
  deriveChatReaderPosition,
  readerPositionEquals,
} from "~/components/chat/scroller/chatScroll.readerPosition.logic";
import { deriveUserTurnAnchorsFromThreadMessages } from "~/components/chat/scroller/chatScroll.timelineRows";
import { type ChatReaderPosition } from "~/components/chat/scroller/chatScroll.constants";

export { deriveUserTurnAnchorsFromThreadMessages, readerPositionEquals };
export type { ChatReaderPosition };

export function deriveMobileReaderPosition(scrollContainer: HTMLDivElement): ChatReaderPosition {
  const containerRect = scrollContainer.getBoundingClientRect();
  const rows = Array.from(
    scrollContainer.querySelectorAll<HTMLElement>("[data-message-id][data-message-role]"),
  ).flatMap((element) => {
    const rawMessageId = element.dataset.messageId;
    const role = element.dataset.messageRole;
    if (!rawMessageId || !role) {
      return [];
    }
    const rect = element.getBoundingClientRect();
    return [
      {
        messageId: rawMessageId as MessageId,
        role,
        start: rect.top - containerRect.top + scrollContainer.scrollTop,
        end: rect.bottom - containerRect.top + scrollContainer.scrollTop,
      },
    ];
  });

  return deriveChatReaderPosition({
    anchorRows: rows
      .filter((row) => row.role === "user")
      .map((row) => ({
        messageId: row.messageId,
        start: row.start,
        end: row.end,
      })),
    messageRows: rows.map((row) => ({
      messageId: row.messageId,
      start: row.start,
      end: row.end,
    })),
    scrollTop: scrollContainer.scrollTop,
    viewportHeight: scrollContainer.clientHeight,
  });
}
