import type { FilePreviewTextSelection } from "./FilePreview.selection";

function codeSourceLine(text: Text, offset: number, root: HTMLElement): number | null {
  const block = text.parentElement?.closest<HTMLElement>("[data-source-code-lines]");
  const code = text.parentElement?.closest("pre code");
  if (!block || !root.contains(block) || !code) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(code);
  prefix.setEnd(text, offset);
  try {
    const lines: unknown = JSON.parse(block.dataset.sourceCodeLines ?? "null");
    const line: unknown = Array.isArray(lines)
      ? lines[prefix.toString().split("\n").length - 1]
      : null;
    return typeof line === "number" && Number.isInteger(line) && line > 0 ? line : null;
  } catch {
    return null;
  }
}

function textSourceLine(text: Text, offset: number, root: HTMLElement): number | null {
  if (text.parentElement?.closest("button, [aria-hidden='true']")) return null;
  const span = text.parentElement?.closest<HTMLElement>("[data-source-text-line]");
  if (span && root.contains(span)) {
    const line = Number(span.dataset.sourceTextLine);
    return Number.isInteger(line) && line > 0 ? line : null;
  }
  return codeSourceLine(text, offset, root);
}

/** Resolve selected visible text from preview metadata, never by searching Markdown. */
export function resolveMarkdownPreviewTextSelection(
  selection: Selection | null,
  contentRoot: HTMLElement | null,
): FilePreviewTextSelection | null {
  const result = resolveMarkdownPreviewAnnotationSelection(selection, contentRoot);
  if (!result) return null;
  const { renderedRange: _renderedRange, ...sourceSelection } = result;
  return sourceSelection;
}

/** Capture text endpoints before a context menu or composer changes the browser selection. */
export function resolveMarkdownPreviewAnnotationSelection(
  selection: Selection | null,
  contentRoot: HTMLElement | null,
): (FilePreviewTextSelection & { renderedRange: Range }) | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !contentRoot)
    return null;
  const range = selection.getRangeAt(0);
  if (!contentRoot.contains(range.startContainer) || !contentRoot.contains(range.endContainer)) {
    return null;
  }
  const selectedText = selection.toString().trim();
  if (selectedText.length < 2) return null;

  const walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT);
  let startLine: number | null = null;
  let endLine: number | null = null;
  const renderedRange = document.createRange();
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node)) continue;
    const text = node as Text;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : text.length;
    const value = text.data.slice(start, end);
    if (!value.trim()) continue;
    const first = start + value.length - value.trimStart().length;
    const last = start + value.trimEnd().length - 1;
    const firstLine = textSourceLine(text, first, contentRoot);
    const lastLine = textSourceLine(text, last, contentRoot);
    if (firstLine !== null && startLine === null) {
      startLine = firstLine;
      renderedRange.setStart(text, first);
    }
    if (lastLine !== null) {
      endLine = lastLine;
      renderedRange.setEnd(text, last + 1);
    }
  }
  return startLine !== null && endLine !== null
    ? { startLine, endLine, selectedText, renderedRange }
    : null;
}
