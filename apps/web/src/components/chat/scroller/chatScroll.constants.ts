import { type MessageId } from "@bigbud/contracts";

export const CHAT_SCROLL_EDGE_THRESHOLD_PX = 8;
export const CHAT_SCROLL_MARGIN_PX = 12;
export const CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX = 64;

export interface ChatReaderPosition {
  currentAnchorMessageId: MessageId | null;
  visibleMessageIds: ReadonlyArray<MessageId>;
}

export interface ChatScrollAnchorRow {
  messageId: MessageId;
  start: number;
  end: number;
}

export interface ChatScrollMessageRow {
  messageId: MessageId;
  start: number;
  end: number;
}
