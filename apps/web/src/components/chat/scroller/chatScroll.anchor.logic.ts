import { CHAT_SCROLL_MARGIN_PX, CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX } from "./chatScroll.constants";

export function resolveAnchorScrollTop(
  scrollContainer: HTMLElement,
  anchorElement: HTMLElement,
  options?: {
    marginPx?: number;
    peekPx?: number;
  },
): number {
  const marginPx = options?.marginPx ?? CHAT_SCROLL_MARGIN_PX;
  const peekPx = options?.peekPx ?? CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX;
  const containerRect = scrollContainer.getBoundingClientRect();
  const anchorRect = anchorElement.getBoundingClientRect();
  const anchorTopInContent = anchorRect.top - containerRect.top + scrollContainer.scrollTop;
  return Math.max(0, anchorTopInContent - marginPx - peekPx);
}

export function scrollContainerToAnchor(
  scrollContainer: HTMLElement,
  anchorElement: HTMLElement,
  behavior: ScrollBehavior = "auto",
): void {
  const targetScrollTop = resolveAnchorScrollTop(scrollContainer, anchorElement);
  if (Math.abs(scrollContainer.scrollTop - targetScrollTop) <= 0.5) {
    scrollContainer.scrollTop = targetScrollTop;
    return;
  }
  scrollContainer.scrollTo({ top: targetScrollTop, behavior });
}

export function scrollContainerToMessage(
  scrollContainer: HTMLElement,
  messageElement: HTMLElement,
  options?: {
    align?: "start" | "center" | "end";
    behavior?: ScrollBehavior;
    marginPx?: number;
    peekPx?: number;
  },
): void {
  const align = options?.align ?? "start";
  const behavior = options?.behavior ?? "auto";
  const marginPx = options?.marginPx ?? CHAT_SCROLL_MARGIN_PX;
  const peekPx = options?.peekPx ?? CHAT_SCROLL_PREVIOUS_ITEM_PEEK_PX;
  const containerRect = scrollContainer.getBoundingClientRect();
  const messageRect = messageElement.getBoundingClientRect();
  const messageTopInContent = messageRect.top - containerRect.top + scrollContainer.scrollTop;
  const messageHeight = messageRect.height;

  let targetScrollTop = messageTopInContent - marginPx - peekPx;
  if (align === "center") {
    targetScrollTop = messageTopInContent - (scrollContainer.clientHeight - messageHeight) / 2;
  } else if (align === "end") {
    targetScrollTop =
      messageTopInContent + messageHeight - scrollContainer.clientHeight + marginPx + peekPx;
  }

  scrollContainer.scrollTo({ top: Math.max(0, targetScrollTop), behavior });
}
