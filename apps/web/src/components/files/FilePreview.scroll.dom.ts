import { isMarkdownSourceBlock } from "../common/BaseMarkdown.sourcePositions";

import {
  captureMarkdownReadingAnchor,
  captureRawReadingAnchor,
  type MarkdownFileViewMode,
  type ReadingAnchor,
  resolveMarkdownScrollTop,
  resolveRawScrollTop,
  type ScrollMetrics,
  type SourceBlockMeasurement,
} from "./FilePreview.scroll.logic";

function scrollMetrics(container: HTMLDivElement): ScrollMetrics {
  return {
    scrollTop: container.scrollTop,
    clientHeight: container.clientHeight,
    scrollHeight: container.scrollHeight,
  };
}

function numericDataAttribute(element: HTMLElement, name: string): number | null {
  const value = Number(element.dataset[name]);
  return Number.isFinite(value) ? value : null;
}

function elementDepth(
  element: HTMLElement,
  root: HTMLElement,
  sourceAncestors: Set<HTMLElement>,
): number {
  let depth = 0;
  let current = element.parentElement;
  while (current && current !== root) {
    sourceAncestors.add(current);
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function isBlockElement(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && isMarkdownSourceBlock(node.localName);
}

function inlineRanges(element: HTMLElement): ReadonlyArray<Range> {
  const ranges: Range[] = [];
  let first: ChildNode | null = null;
  let last: ChildNode | null = null;
  const finishRange = () => {
    if (first && last) {
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      ranges.push(range);
    }
    first = null;
    last = null;
  };
  for (const child of element.childNodes) {
    if (isBlockElement(child)) {
      finishRange();
    } else if (child.nodeType !== Node.TEXT_NODE || child.textContent?.trim()) {
      first ??= child;
      last = child;
    }
  }
  finishRange();
  return ranges;
}

function measureOwnText(
  element: HTMLElement,
  viewportTop: number,
  depth: number,
): ReadonlyArray<SourceBlockMeasurement> {
  const serialized = element.dataset.sourceTextSegments;
  if (!serialized) return [];
  let segments: unknown;
  try {
    segments = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(segments)) return [];
  const ranges = inlineRanges(element);
  return segments.flatMap((segment: unknown, index) => {
    if (
      !Array.isArray(segment) ||
      segment.length !== 2 ||
      !segment.every(
        (line: unknown) => typeof line === "number" && Number.isInteger(line) && line > 0,
      )
    ) {
      return [];
    }
    const rect = ranges[index]?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return [];
    return [
      {
        startLine: segment[0],
        endLine: segment[1],
        top: rect.top - viewportTop,
        height: rect.height,
        depth,
      },
    ];
  });
}

export function measureMarkdownSourceBlocks(
  container: HTMLDivElement,
  contentRoot: HTMLDivElement,
): ReadonlyArray<SourceBlockMeasurement> {
  const viewportTop = container.getBoundingClientRect().top;
  const elements = Array.from(
    contentRoot.querySelectorAll<HTMLElement>("[data-source-start-line][data-source-end-line]"),
  );
  const sourceAncestors = new Set<HTMLElement>();
  const depths = elements.map((element) => elementDepth(element, contentRoot, sourceAncestors));
  return elements.flatMap((element, index) => {
    const startLine = numericDataAttribute(element, "sourceStartLine");
    const endLine = numericDataAttribute(element, "sourceEndLine");
    if (startLine === null || endLine === null) return [];
    const depth = depths[index]!;
    // A row is one source line even when cells have different wrapped heights.
    if (
      (element.localName === "td" || element.localName === "th") &&
      element.closest("tr[data-source-start-line]")
    )
      return [];
    if (
      element.localName !== "tr" &&
      sourceAncestors.has(element) &&
      Array.from(element.childNodes).some(isBlockElement)
    ) {
      return measureOwnText(element, viewportTop, depth);
    }
    const rect = element.getBoundingClientRect();
    return [
      {
        startLine,
        endLine,
        top: rect.top - viewportTop,
        height: rect.height,
        depth,
      },
    ];
  });
}

export function captureFilePreviewAnchor(input: {
  readonly mode: MarkdownFileViewMode;
  readonly container: HTMLDivElement;
  readonly linesContainer: HTMLDivElement | null;
  readonly markdownContent: HTMLDivElement | null;
  readonly lineHeight: number;
  readonly totalLines: number;
}): ReadingAnchor {
  const metrics = scrollMetrics(input.container);
  if (input.mode === "raw" && input.linesContainer) {
    const containerRect = input.container.getBoundingClientRect();
    const linesRect = input.linesContainer.getBoundingClientRect();
    return captureRawReadingAnchor({
      metrics,
      linesTop: linesRect.top - containerRect.top,
      lineHeight: input.lineHeight,
      totalLines: input.totalLines,
    });
  }

  const blocks = input.markdownContent
    ? measureMarkdownSourceBlocks(input.container, input.markdownContent)
    : [];
  return captureMarkdownReadingAnchor({ metrics, blocks });
}

export function resolveFilePreviewScrollTop(input: {
  readonly mode: MarkdownFileViewMode;
  readonly anchor: ReadingAnchor;
  readonly container: HTMLDivElement;
  readonly linesContainer: HTMLDivElement | null;
  readonly markdownContent: HTMLDivElement | null;
  readonly lineHeight: number;
}): number | null {
  const metrics = scrollMetrics(input.container);
  if (input.mode === "raw" && input.linesContainer) {
    const containerRect = input.container.getBoundingClientRect();
    const linesRect = input.linesContainer.getBoundingClientRect();
    return resolveRawScrollTop(
      input.anchor,
      metrics,
      linesRect.top - containerRect.top,
      input.lineHeight,
    );
  }
  if (input.mode === "preview" && input.markdownContent) {
    return resolveMarkdownScrollTop(
      input.anchor,
      metrics,
      measureMarkdownSourceBlocks(input.container, input.markdownContent),
    );
  }
  return null;
}

export function resolveRelativeFilePreviewScrollTop(input: {
  readonly mode: MarkdownFileViewMode;
  readonly anchor: ReadingAnchor;
  readonly container: HTMLDivElement;
}): number {
  const metrics = scrollMetrics(input.container);
  return input.mode === "preview"
    ? resolveMarkdownScrollTop(input.anchor, metrics, [])
    : resolveRawScrollTop(input.anchor, metrics, 0, 0);
}
