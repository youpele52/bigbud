import type { FileDiffMetadata } from "@pierre/diffs/react";

export interface DiffSelectionRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface ResolvedDiffSelection {
  readonly filePath: string;
  readonly range: DiffSelectionRange;
  readonly selectedText: string;
}

export interface ResolveDiffSelectionOptions {
  readonly event?: MouseEvent;
  readonly filePathHint?: string;
  readonly fileDiff?: FileDiffMetadata;
}

export interface ResolvedDiffContextMenuTarget {
  readonly filePath: string;
  readonly fileContainer: HTMLElement;
}

export const DIFF_ANNOTATION_HEADER = [
  'Diff legend: "-" deleted, "+" added, " " unchanged.',
  "--- before",
  "+++ after",
] as const;

const TEXT_NODE = 3;

export function parseDiffLineNumber(element: HTMLElement): number | null {
  const raw = element.getAttribute("data-line") ?? element.getAttribute("data-column-number");
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asElement(node: Node): HTMLElement | null {
  if (typeof node !== "object" || node === null) return null;
  if (!("hasAttribute" in node) || typeof node.hasAttribute !== "function") return null;
  return node as HTMLElement;
}

function asShadowRoot(node: Node): ShadowRoot | null {
  if (typeof node !== "object" || node === null || !("host" in node)) return null;
  return node as ShadowRoot;
}

function isDiffLineMarkerElement(element: HTMLElement): boolean {
  return element.hasAttribute("data-line") || element.hasAttribute("data-column-number");
}

function getParentNodeForTraversal(node: Node): Node | null {
  const parent = node.parentNode;
  if (parent) return parent;

  if (!("getRootNode" in node) || typeof node.getRootNode !== "function") return null;

  const root = node.getRootNode();
  if (root === node || root === document) return null;

  const shadowRoot = asShadowRoot(root);
  if (shadowRoot && node !== shadowRoot) return shadowRoot.host;

  return null;
}

function collectDiffLineElementsFromPath(path: readonly EventTarget[]): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const node of path) {
    const element = asElement(node as Node);
    if (element && isDiffLineMarkerElement(element)) lines.push(element);
  }
  return lines;
}

export function resolveFilePathFromPath(
  path: readonly EventTarget[],
  fileDiffByPath?: ReadonlyMap<string, FileDiffMetadata>,
  filePathHint?: string,
): string | null {
  for (const node of path) {
    const element = asElement(node as Node);
    const filePath = element?.dataset.diffFilePath?.trim();
    if (filePath && (!fileDiffByPath || fileDiffByPath.has(filePath))) return filePath;

    if (element && "localName" in element && element.localName === "diffs-container") {
      const parentPath = element.parentElement?.dataset.diffFilePath?.trim();
      if (parentPath && (!fileDiffByPath || fileDiffByPath.has(parentPath))) return parentPath;
    }
  }

  const hintedPath = filePathHint?.trim();
  if (hintedPath && (!fileDiffByPath || fileDiffByPath.has(hintedPath))) return hintedPath;

  return null;
}

export function resolveDiffContextMenuTarget(
  event: MouseEvent,
  fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>,
): ResolvedDiffContextMenuTarget | null {
  const filePath = resolveFilePathFromPath(event.composedPath(), fileDiffByPath);
  if (!filePath) return null;

  for (const node of event.composedPath()) {
    const element = asElement(node as Node);
    if (element?.dataset.diffFilePath === filePath) return { filePath, fileContainer: element };
  }

  return null;
}

export function walkToDiffLineElement(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === TEXT_NODE) {
      current = current.parentNode;
      continue;
    }

    const element = asElement(current);
    if (element && isDiffLineMarkerElement(element)) return element;

    const shadowRoot = asShadowRoot(current);
    if (shadowRoot) {
      current = shadowRoot.host;
      continue;
    }

    current = getParentNodeForTraversal(current);
  }
  return null;
}

export function walkToDiffFileContainer(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current) {
    const element = asElement(current);
    if (element?.dataset.diffFilePath) return element;

    const shadowRoot = asShadowRoot(current);
    if (shadowRoot) {
      current = shadowRoot.host;
      continue;
    }

    current = getParentNodeForTraversal(current);
  }
  return null;
}

export function normalizeDiffLineRange(startLine: number, endLine: number): DiffSelectionRange {
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  };
}

function resolveLineElements(
  selection: Selection,
  options?: ResolveDiffSelectionOptions,
): {
  readonly startLine: HTMLElement;
  readonly endLine: HTMLElement;
  readonly selectedLines: readonly HTMLElement[];
  readonly range: Range | null;
} | null {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const selectedLines = range ? resolveTextBearingLines(range) : [];
  if (selectedLines.length > 0) {
    return {
      startLine: selectedLines[0]!,
      endLine: selectedLines.at(-1)!,
      selectedLines,
      range,
    };
  }

  let startLine = walkToDiffLineElement(range?.startContainer ?? selection.anchorNode);
  let endLine = walkToDiffLineElement(range?.endContainer ?? selection.focusNode);

  if ((!startLine || !endLine) && options?.event) {
    const linesInPath = collectDiffLineElementsFromPath(options.event.composedPath());
    if (!startLine && linesInPath[0]) startLine = linesInPath[0];
    if (!endLine && linesInPath.length > 0) endLine = linesInPath.at(-1) ?? null;
  }

  if (startLine && !endLine) endLine = startLine;
  if (endLine && !startLine) startLine = endLine;
  if (!startLine || !endLine) return null;

  return {
    startLine,
    endLine,
    selectedLines: [...new Set([startLine, endLine])],
    range,
  };
}

function resolveTextBearingLines(range: Range): HTMLElement[] {
  if (typeof Range === "undefined" || !(range instanceof Range)) return [];

  const root = range.startContainer.getRootNode();
  if (root !== range.endContainer.getRootNode() || !("querySelectorAll" in root)) return [];

  const lines = (root as ParentNode).querySelectorAll<HTMLElement>("[data-content] [data-line]");
  return Array.from(lines).filter((line) => rangeSelectsTextWithinLine(range, line));
}

function rangeSelectsTextWithinLine(range: Range, line: HTMLElement): boolean {
  if (!range.intersectsNode(line)) return false;

  const lineRange = document.createRange();
  lineRange.selectNodeContents(line);
  const intersection = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) < 0) {
    intersection.setStart(lineRange.startContainer, lineRange.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) > 0) {
    intersection.setEnd(lineRange.endContainer, lineRange.endOffset);
  }
  return !intersection.collapsed;
}

function resolveSelectedText(selection: Selection | null): string {
  return selection?.toString() ?? "";
}

function removeStructuralLineEnding(text: string): string {
  return text.endsWith("\n") ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;
}

function formatSelectedDiffText(
  selectedLines: readonly HTMLElement[],
  range: Range | null,
  fallbackText: string,
): string {
  const rows = selectedLines.map((line) => {
    const lineType = line.getAttribute("data-line-type");
    const prefix =
      lineType === "change-deletion" ? "-" : lineType === "change-addition" ? "+" : " ";
    let text = line.textContent ?? (selectedLines.length === 1 ? fallbackText : "");
    if (range && typeof Range !== "undefined" && range instanceof Range) {
      const lineRange = document.createRange();
      lineRange.selectNodeContents(line);
      const intersection = range.cloneRange();
      if (range.compareBoundaryPoints(Range.START_TO_START, lineRange) < 0) {
        intersection.setStart(lineRange.startContainer, lineRange.startOffset);
      }
      if (range.compareBoundaryPoints(Range.END_TO_END, lineRange) > 0) {
        intersection.setEnd(lineRange.endContainer, lineRange.endOffset);
      }
      text = intersection.toString();
    }
    return `${prefix}${removeStructuralLineEnding(text)}`;
  });
  return [...DIFF_ANNOTATION_HEADER, ...rows].join("\n");
}

function selectionFitsSingleHunk(
  selectedLines: readonly HTMLElement[],
  fileDiff: FileDiffMetadata,
): boolean {
  let matchingHunks = fileDiff.hunks.map((_, index) => index);
  for (const line of selectedLines) {
    const lineNumber = parseDiffLineNumber(line);
    if (lineNumber === null) return false;
    const lineType = line.getAttribute("data-line-type");
    matchingHunks = matchingHunks.filter((index) => {
      const hunk = fileDiff.hunks[index]!;
      const inAdditions =
        lineNumber >= hunk.additionStart && lineNumber < hunk.additionStart + hunk.additionCount;
      const inDeletions =
        lineNumber >= hunk.deletionStart && lineNumber < hunk.deletionStart + hunk.deletionCount;
      if (lineType === "change-addition") return inAdditions;
      if (lineType === "change-deletion") return inDeletions;
      return inAdditions || inDeletions;
    });
    if (matchingHunks.length === 0) return false;
  }
  return matchingHunks.length > 0;
}

export function selectionSpansDiffFiles(selection: Selection | null, filePath: string): boolean {
  if (!selection) return false;
  const lineElements = resolveLineElements(selection);
  if (!lineElements) return false;

  for (const lineElement of lineElements.selectedLines) {
    const selectedFilePath = walkToDiffFileContainer(lineElement)?.dataset.diffFilePath?.trim();
    if (selectedFilePath && selectedFilePath !== filePath) return true;
  }

  return false;
}

export function resolveDiffSelectionFromDom(
  selection: Selection | null,
  options?: ResolveDiffSelectionOptions,
): ResolvedDiffSelection | null {
  if (!selection || selection.isCollapsed) return null;

  const selectedText = resolveSelectedText(selection);
  if (selectedText.length === 0) return null;

  const lineElements = resolveLineElements(selection, options);
  if (!lineElements) return null;

  const composedPath = options?.event?.composedPath() ?? [];
  const filePath =
    walkToDiffFileContainer(lineElements.startLine)?.dataset.diffFilePath?.trim() ??
    walkToDiffFileContainer(lineElements.endLine)?.dataset.diffFilePath?.trim() ??
    resolveFilePathFromPath(composedPath, undefined, options?.filePathHint);
  if (
    !filePath ||
    !lineElements.selectedLines.every(
      (line) => walkToDiffFileContainer(line)?.dataset.diffFilePath?.trim() === filePath,
    )
  ) {
    return null;
  }

  const lineNumbers = lineElements.selectedLines
    .map(parseDiffLineNumber)
    .filter((lineNumber): lineNumber is number => lineNumber !== null);
  if (lineNumbers.length === 0) return null;
  if (
    options?.fileDiff &&
    Array.isArray(options.fileDiff.hunks) &&
    !selectionFitsSingleHunk(lineElements.selectedLines, options.fileDiff)
  ) {
    return null;
  }

  return {
    filePath,
    range: {
      startLine: Math.min(...lineNumbers),
      endLine: Math.max(...lineNumbers),
    },
    selectedText: formatSelectedDiffText(
      lineElements.selectedLines,
      lineElements.range,
      selectedText,
    ),
  };
}
