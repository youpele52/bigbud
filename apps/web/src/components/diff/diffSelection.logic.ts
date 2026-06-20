import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";

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
}

const TEXT_NODE = 3;

export function parseDiffLineNumber(element: HTMLElement): number | null {
  const raw = element.getAttribute("data-line") ?? element.getAttribute("data-column-number");
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asElement(node: Node): HTMLElement | null {
  if (typeof node !== "object" || node === null) {
    return null;
  }
  if (!("hasAttribute" in node) || typeof node.hasAttribute !== "function") {
    return null;
  }
  return node as HTMLElement;
}

function asShadowRoot(node: Node): ShadowRoot | null {
  if (typeof node !== "object" || node === null || !("host" in node)) {
    return null;
  }
  return node as ShadowRoot;
}

function isDiffLineMarkerElement(element: HTMLElement): boolean {
  return element.hasAttribute("data-line") || element.hasAttribute("data-column-number");
}

function getParentNodeForTraversal(node: Node): Node | null {
  const parent = node.parentNode;
  if (parent) {
    return parent;
  }

  if (!("getRootNode" in node) || typeof node.getRootNode !== "function") {
    return null;
  }

  const root = node.getRootNode();
  if (root === node || root === document) {
    return null;
  }

  const shadowRoot = asShadowRoot(root);
  if (shadowRoot && node !== shadowRoot) {
    return shadowRoot.host;
  }

  return null;
}

function collectDiffLineElementsFromPath(path: readonly EventTarget[]): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const node of path) {
    const element = asElement(node as Node);
    if (element && isDiffLineMarkerElement(element)) {
      lines.push(element);
    }
  }
  return lines;
}

function resolveFilePathFromPath(
  path: readonly EventTarget[],
  fileDiffByPath?: ReadonlyMap<string, FileDiffMetadata>,
  filePathHint?: string,
): string | null {
  for (const node of path) {
    const element = asElement(node as Node);
    const filePath = element?.dataset.diffFilePath?.trim();
    if (filePath && (!fileDiffByPath || fileDiffByPath.has(filePath))) {
      return filePath;
    }

    if (element && "localName" in element && element.localName === "diffs-container") {
      const parentPath = element.parentElement?.dataset.diffFilePath?.trim();
      if (parentPath && (!fileDiffByPath || fileDiffByPath.has(parentPath))) {
        return parentPath;
      }
    }
  }

  const hintedPath = filePathHint?.trim();
  if (hintedPath && (!fileDiffByPath || fileDiffByPath.has(hintedPath))) {
    return hintedPath;
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
    if (element && isDiffLineMarkerElement(element)) {
      return element;
    }

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
    if (element?.dataset.diffFilePath) {
      return element;
    }

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
): { readonly startLine: HTMLElement; readonly endLine: HTMLElement } | null {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  let startLine = walkToDiffLineElement(range?.startContainer ?? selection.anchorNode);
  let endLine = walkToDiffLineElement(range?.endContainer ?? selection.focusNode);

  if ((!startLine || !endLine) && options?.event) {
    const linesInPath = collectDiffLineElementsFromPath(options.event.composedPath());
    if (!startLine && linesInPath[0]) {
      startLine = linesInPath[0];
    }
    if (!endLine && linesInPath.length > 0) {
      endLine = linesInPath.at(-1) ?? null;
    }
  }

  if (startLine && !endLine) {
    endLine = startLine;
  }
  if (endLine && !startLine) {
    startLine = endLine;
  }

  if (!startLine || !endLine) {
    return null;
  }

  return { startLine, endLine };
}

function resolveSelectedText(selection: Selection | null): string {
  return selection?.toString().trim() ?? "";
}

export function resolveDiffSelectionFromDom(
  selection: Selection | null,
  options?: ResolveDiffSelectionOptions,
): ResolvedDiffSelection | null {
  if (!selection || selection.isCollapsed) {
    return null;
  }

  const selectedText = resolveSelectedText(selection);
  if (selectedText.length < 2) {
    return null;
  }

  const lineElements = resolveLineElements(selection, options);
  if (!lineElements) {
    return null;
  }

  const anchorLineNumber = parseDiffLineNumber(lineElements.startLine);
  const focusLineNumber = parseDiffLineNumber(lineElements.endLine);
  if (anchorLineNumber === null || focusLineNumber === null) {
    return null;
  }

  const composedPath = options?.event?.composedPath() ?? [];
  const filePath =
    walkToDiffFileContainer(lineElements.startLine)?.dataset.diffFilePath?.trim() ??
    walkToDiffFileContainer(lineElements.endLine)?.dataset.diffFilePath?.trim() ??
    resolveFilePathFromPath(composedPath, undefined, options?.filePathHint);
  if (!filePath) {
    return null;
  }

  return {
    filePath,
    range: normalizeDiffLineRange(anchorLineNumber, focusLineNumber),
    selectedText,
  };
}

function resolveTextForPierreLineRange(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): string {
  if (fileDiff.isPartial) {
    return "";
  }

  const startLine = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  const lineSources = [fileDiff.additionLines, fileDiff.deletionLines];

  for (const lines of lineSources) {
    if (lines.length === 0) {
      continue;
    }

    const segments: string[] = [];
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
      const lineText = lines[lineNumber - 1];
      if (lineText !== undefined) {
        segments.push(lineText);
      }
    }
    if (segments.length > 0) {
      return segments.join("\n");
    }
  }

  return "";
}

function resolveDiffSelectionFromPierreLineRange(
  filePath: string,
  fileDiff: FileDiffMetadata,
  pierreRange: SelectedLineRange,
): ResolvedDiffSelection | null {
  const selectedText = resolveTextForPierreLineRange(fileDiff, pierreRange).trim();
  if (selectedText.length < 2) {
    return null;
  }

  return {
    filePath,
    range: normalizeDiffLineRange(pierreRange.start, pierreRange.end),
    selectedText,
  };
}

function resolveDiffSelectionFromFileContent(
  filePath: string,
  fileDiff: FileDiffMetadata,
  selectedText: string,
): ResolvedDiffSelection | null {
  for (const lines of [fileDiff.additionLines, fileDiff.deletionLines]) {
    if (lines.length === 0) {
      continue;
    }

    const content = lines.join("\n");
    const startIndex = content.indexOf(selectedText);
    if (startIndex === -1) {
      continue;
    }

    const endIndex = startIndex + selectedText.length;
    const startLine = content.slice(0, startIndex).split("\n").length;
    const endLine = content.slice(0, endIndex).split("\n").length;
    return {
      filePath,
      range: normalizeDiffLineRange(startLine, endLine),
      selectedText,
    };
  }

  return null;
}

export function resolveDiffSelectionFromContextMenu(input: {
  readonly event: MouseEvent;
  readonly selection: Selection | null;
  readonly fileDiffByPath: ReadonlyMap<string, FileDiffMetadata>;
  readonly pierreLineSelectionByPath?: ReadonlyMap<string, SelectedLineRange | null> | null;
}): ResolvedDiffSelection | null {
  const path = input.event.composedPath();
  const filePath = resolveFilePathFromPath(path, input.fileDiffByPath);
  if (!filePath) {
    return null;
  }

  const fileDiff = input.fileDiffByPath.get(filePath);
  const selectedText = resolveSelectedText(input.selection);

  if (selectedText.length >= 2) {
    const fromDom = resolveDiffSelectionFromDom(input.selection, {
      event: input.event,
      filePathHint: filePath,
    });
    if (fromDom) {
      return fromDom;
    }

    if (fileDiff) {
      const fromFileContent = resolveDiffSelectionFromFileContent(filePath, fileDiff, selectedText);
      if (fromFileContent) {
        return fromFileContent;
      }
    }
  }

  const pierreRange = input.pierreLineSelectionByPath?.get(filePath) ?? null;
  if (pierreRange && fileDiff) {
    return resolveDiffSelectionFromPierreLineRange(filePath, fileDiff, pierreRange);
  }

  return null;
}
