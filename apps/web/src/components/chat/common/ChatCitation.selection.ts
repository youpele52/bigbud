import { MessageId } from "@bigbud/contracts/core/baseSchemas";

import type { ComposerChatCitationAttachment } from "../../../stores/composer/types.annotation.store";
import { normalizeChatCitationRange } from "./ChatCitation.selection.range";

export interface ChatCitationSelection {
  source: Omit<ComposerChatCitationAttachment["source"], "threadId">;
  selection: ComposerChatCitationAttachment["selection"];
  rect: DOMRect;
}

export function readChatCitationSelection(
  selection: Selection | null,
  scope: HTMLElement,
): ChatCitationSelection | null {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const normalized = normalizeChatCitationRange(selection.getRangeAt(0), scope);
  if (!normalized) return null;
  const { content, range } = normalized;
  if (!content.closest("[data-chat-cite-scope]")) return null;
  const row = content.closest<HTMLElement>("[data-message-id][data-message-role]");
  const role = row?.dataset.messageRole;
  const messageId = row?.dataset.messageId;
  if (!messageId || (role !== "user" && role !== "assistant")) return null;
  for (const excluded of content.querySelectorAll(
    "button,input,textarea,[contenteditable=true],[data-chat-cite-exclude]",
  )) {
    if (range.intersectsNode(excluded) && excluded.getClientRects().length > 0) return null;
  }
  const text = selection.toString();
  if (!text.trim()) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(content);
  prefix.setEnd(range.startContainer, range.startOffset);
  const startOffset = prefix.toString().length;
  const anchorText = range.toString();
  return {
    source: { messageId: MessageId.makeUnsafe(messageId), role },
    selection: { text, anchorText, startOffset, endOffset: startOffset + anchorText.length },
    rect: range.getBoundingClientRect(),
  };
}

/** Offset anchoring disambiguates repeated phrases; snapshot checks reject changed source text. */
export function resolveChatCitationRange(
  content: HTMLElement,
  selection: ComposerChatCitationAttachment["selection"],
): Range | null {
  if (selection.startOffset < 0 || selection.endOffset <= selection.startOffset) return null;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!started && selection.startOffset < offset + length) {
      range.setStart(node, selection.startOffset - offset);
      started = true;
    }
    if (started && selection.endOffset <= offset + length) {
      range.setEnd(node, selection.endOffset - offset);
      return range.toString() === (selection.anchorText ?? selection.text) ? range : null;
    }
    offset += length;
  }
  return null;
}
