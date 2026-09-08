export interface FilePreviewTextSelection {
  readonly startLine: number;
  readonly endLine: number;
  readonly selectedText: string;
}

function containsNode(container: HTMLElement, node: Node): boolean {
  return node === container || container.contains(node);
}

export function resolveFilePreviewTextSelection(
  selection: Selection | null,
  codeContainer: HTMLElement | null,
): FilePreviewTextSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !codeContainer) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (
    !containsNode(codeContainer, range.startContainer) ||
    !containsNode(codeContainer, range.endContainer)
  ) {
    return null;
  }

  const rawSelectedText = selection.toString();
  const selectedText = rawSelectedText.trim();
  if (selectedText.length < 2) return null;

  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(codeContainer);
  prefixRange.setEnd(range.startContainer, range.startOffset);
  const leadingWhitespaceLength = rawSelectedText.length - rawSelectedText.trimStart().length;
  const selectionStart = `${prefixRange.toString()}${rawSelectedText.slice(0, leadingWhitespaceLength)}`;

  return {
    startLine: selectionStart.split("\n").length,
    endLine: `${selectionStart}${selectedText}`.split("\n").length,
    selectedText,
  };
}
