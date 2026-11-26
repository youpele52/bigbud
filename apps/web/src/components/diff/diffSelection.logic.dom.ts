import type { FileDiffMetadata } from "@pierre/diffs/react";

import { buildDiffAnnotation, type DiffSelectionRange } from "./diffSelection.logic.annotate";
import { buildSelectedDiffRows, parseDiffLineNumber } from "./diffSelection.logic.dom.rows";
import {
  resolveDiffShadowRootFromPath,
  resolveShadowSelectionLines,
} from "./diffSelection.logic.dom.shadow";
import { buildDiffVisualLines, type DiffVisualLine } from "./diffSelection.logic.lines";

export type { DiffSelectionRange };
export { parseDiffLineNumber };

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

const TEXT_NODE = 3;

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
  /** The selection text is authoritative when Range boundaries were retargeted. */
  readonly exactSelectionText: boolean;
} | null {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const selectedLines = range ? resolveTextBearingLines(range) : [];
  if (selectedLines.length > 0) {
    return {
      startLine: selectedLines[0]!,
      endLine: selectedLines.at(-1)!,
      selectedLines,
      range,
      exactSelectionText: false,
    };
  }

  // Chromium retargets selections inside shadow roots, so the range no longer
  // intersects the rendered diff rows. Recover them from the diff's shadow root.
  const shadowRoot = resolveDiffShadowRootFromPath(options?.event?.composedPath() ?? []);
  const shadowLines = shadowRoot ? resolveShadowSelectionLines(selection, shadowRoot) : [];
  if (shadowLines.length > 0) {
    return {
      startLine: shadowLines[0]!,
      endLine: shadowLines.at(-1)!,
      selectedLines: shadowLines,
      range: null,
      exactSelectionText: true,
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
    exactSelectionText: false,
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

function resolveHunkIndex(
  selectedLines: readonly HTMLElement[],
  fileDiff: FileDiffMetadata,
): number | null {
  let matchingHunks = fileDiff.hunks.map((_, index) => index);
  for (const line of selectedLines) {
    const lineNumber = parseDiffLineNumber(line);
    if (lineNumber === null) return null;
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
    if (matchingHunks.length === 0) return null;
  }
  return matchingHunks[0] ?? null;
}

function resolveRowIndex(rows: readonly DiffVisualLine[], line: HTMLElement): number {
  const lineNumber = parseDiffLineNumber(line);
  if (lineNumber === null) return -1;
  const lineType = line.getAttribute("data-line-type");
  if (lineType === "change-deletion") {
    return rows.findIndex(
      (row) => row.side === "deletions" && row.deletionLineNumber === lineNumber,
    );
  }
  if (lineType === "change-addition") {
    return rows.findIndex(
      (row) => row.side === "additions" && row.additionLineNumber === lineNumber,
    );
  }
  return rows.findIndex((row) => row.additionLineNumber === lineNumber);
}

function resolveSelectedRowIndices(
  rows: readonly DiffVisualLine[],
  selectedLines: readonly HTMLElement[],
): number[] {
  const indices: number[] = [];
  for (const line of selectedLines) {
    const index = resolveRowIndex(rows, line);
    if (index !== -1 && !indices.includes(index)) indices.push(index);
  }
  return indices;
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
  // Real drag selections inside open shadow roots report `isCollapsed === true`
  // even though `toString()` holds the selected text, so only reject empty ranges.
  if (!selection || selection.rangeCount === 0) return null;

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
    ) ||
    !lineElements.selectedLines.some((line) => parseDiffLineNumber(line) !== null)
  ) {
    return null;
  }

  const selectedLines = buildSelectedDiffRows(
    lineElements.selectedLines,
    lineElements.range,
    selectedText,
    lineElements.exactSelectionText,
  );
  if (selectedLines.length === 0) return null;

  const fileDiff = options?.fileDiff;
  const hasHunks = Boolean(fileDiff && Array.isArray(fileDiff.hunks));
  const hunkIndex =
    hasHunks && fileDiff ? resolveHunkIndex(lineElements.selectedLines, fileDiff) : null;
  if (hasHunks && hunkIndex === null) return null;

  const hunk = hunkIndex !== null && fileDiff ? fileDiff.hunks[hunkIndex] : undefined;
  const rows = fileDiff && hunk ? buildDiffVisualLines(fileDiff, hunk) : undefined;
  const selectedRowIndices =
    rows && rows.length > 0 ? resolveSelectedRowIndices(rows, lineElements.selectedLines) : [];

  const annotation = buildDiffAnnotation({
    filePath,
    ...(fileDiff ? { fileDiff } : {}),
    ...(hunk ? { hunk } : {}),
    ...(rows && rows.length > 0 ? { rows } : {}),
    selectedRowIndices,
    selectedLines,
  });
  if (!annotation) return null;

  return { filePath, range: annotation.range, selectedText: annotation.selectedText };
}
