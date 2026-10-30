function parentElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

/** Native whole-line selections can put either endpoint outside the content wrapper. */
export function normalizeChatCitationRange(
  original: Range,
  scope: HTMLElement,
): { content: HTMLElement; range: Range } | null {
  const startContent = parentElement(original.startContainer)?.closest<HTMLElement>(
    "[data-chat-cite-content]",
  );
  const endContent = parentElement(original.endContainer)?.closest<HTMLElement>(
    "[data-chat-cite-content]",
  );
  if (startContent && endContent && startContent !== endContent) return null;
  const knownContent = startContent ?? endContent;
  const candidates = knownContent
    ? [knownContent]
    : scope.querySelectorAll<HTMLElement>("[data-chat-cite-content]");
  let result: { content: HTMLElement; range: Range } | null = null;
  for (const content of candidates) {
    if (!scope.contains(content) || !original.intersectsNode(content)) continue;
    if (result) return null;
    const bounds = document.createRange();
    bounds.selectNodeContents(content);
    const range = original.cloneRange();
    if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) {
      range.setStart(bounds.startContainer, bounds.startOffset);
    }
    if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) {
      range.setEnd(bounds.endContainer, bounds.endOffset);
    }
    if (range.collapsed || !range.toString().trim()) continue;
    // Only structural whitespace may sit outside the source. Never discard other message text.
    const before = original.cloneRange();
    before.setEnd(range.startContainer, range.startOffset);
    const after = original.cloneRange();
    after.setStart(range.endContainer, range.endOffset);
    if (before.toString().trim() || after.toString().trim()) return null;
    result = { content, range };
  }
  return result;
}
