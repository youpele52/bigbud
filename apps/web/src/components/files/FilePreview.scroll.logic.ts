export type MarkdownFileViewMode = "raw" | "preview";
export type ReadingBoundary = "top" | "bottom" | null;

export interface SourceBlockMeasurement {
  readonly startLine: number;
  readonly endLine: number;
  /** Top relative to the scroll container's visible top. */
  readonly top: number;
  readonly height: number;
  readonly depth: number;
}

export interface ReadingAnchor {
  readonly sourceAvailable?: boolean;
  readonly sourceLine: number;
  readonly sourceStartLine: number;
  readonly sourceEndLine: number;
  readonly sourceProgress: number;
  /** The anchor point's offset from the scroll container's visible top. */
  readonly viewportOffset: number;
  readonly scrollFraction: number;
  readonly boundary: ReadingBoundary;
}

export interface ScrollMetrics {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

const BOUNDARY_EPSILON = 0.5;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampUnit(value: number): number {
  return clamp(finiteOr(value, 0), 0, 1);
}

export function getScrollMax(metrics: ScrollMetrics): number {
  return Math.max(0, finiteOr(metrics.scrollHeight, 0) - finiteOr(metrics.clientHeight, 0));
}

export function clampScrollTop(scrollTop: number, metrics: ScrollMetrics): number {
  return clamp(finiteOr(scrollTop, 0), 0, getScrollMax(metrics));
}

function resolveBoundary(metrics: ScrollMetrics): ReadingBoundary {
  const scrollTop = clampScrollTop(metrics.scrollTop, metrics);
  const max = getScrollMax(metrics);
  if (scrollTop <= BOUNDARY_EPSILON) return "top";
  if (max > 0 && scrollTop >= max - BOUNDARY_EPSILON) return "bottom";
  return null;
}

function createAnchor(input: {
  sourceAvailable?: boolean;
  sourceLine: number;
  sourceStartLine: number;
  sourceEndLine: number;
  sourceProgress: number;
  viewportOffset: number;
  metrics: ScrollMetrics;
}): ReadingAnchor {
  const max = getScrollMax(input.metrics);
  const scrollTop = clampScrollTop(input.metrics.scrollTop, input.metrics);
  return {
    sourceAvailable: input.sourceAvailable ?? true,
    sourceLine: Math.max(1, finiteOr(input.sourceLine, 1)),
    sourceStartLine: Math.max(1, Math.floor(finiteOr(input.sourceStartLine, 1))),
    sourceEndLine: Math.max(
      Math.max(1, Math.floor(finiteOr(input.sourceStartLine, 1))),
      Math.floor(finiteOr(input.sourceEndLine, input.sourceStartLine)),
    ),
    sourceProgress: clampUnit(input.sourceProgress),
    viewportOffset: finiteOr(input.viewportOffset, 0),
    scrollFraction: max > 0 ? clampUnit(scrollTop / max) : 0,
    boundary: resolveBoundary(input.metrics),
  };
}

export function captureRawReadingAnchor(input: {
  readonly metrics: ScrollMetrics;
  readonly linesTop: number;
  readonly lineHeight: number;
  readonly totalLines: number;
}): ReadingAnchor {
  const totalLines = Math.max(0, Math.floor(finiteOr(input.totalLines, 0)));
  const lineHeight = finiteOr(input.lineHeight, 0);
  const scrollTop = clampScrollTop(input.metrics.scrollTop, input.metrics);
  if (totalLines === 0 || lineHeight <= 0) {
    return createAnchor({
      sourceLine: 1,
      sourceStartLine: 1,
      sourceEndLine: 1,
      sourceProgress: 0,
      viewportOffset: 0,
      metrics: input.metrics,
    });
  }

  const firstLineTop = finiteOr(input.linesTop, 0) + scrollTop;
  const sourceLine = 1 + (scrollTop - firstLineTop) / lineHeight;
  if (sourceLine < 1) {
    return createAnchor({
      sourceLine: 1,
      sourceStartLine: 1,
      sourceEndLine: 1,
      sourceProgress: 0,
      viewportOffset: firstLineTop - scrollTop,
      metrics: input.metrics,
    });
  }
  if (sourceLine > totalLines) {
    const lastLineTop = firstLineTop + (totalLines - 1) * lineHeight;
    return createAnchor({
      sourceLine: totalLines,
      sourceStartLine: totalLines,
      sourceEndLine: totalLines,
      sourceProgress: 0,
      viewportOffset: lastLineTop - scrollTop,
      metrics: input.metrics,
    });
  }

  const line = Math.floor(sourceLine);
  return createAnchor({
    sourceLine,
    sourceStartLine: line,
    sourceEndLine: line,
    sourceProgress: sourceLine - line,
    viewportOffset: 0,
    metrics: input.metrics,
  });
}

function compareSpecificity(left: SourceBlockMeasurement, right: SourceBlockMeasurement): number {
  const leftRange = left.endLine - left.startLine;
  const rightRange = right.endLine - right.startLine;
  if (leftRange !== rightRange) return leftRange - rightRange;
  return right.depth - left.depth;
}

function isUsableBlock(block: SourceBlockMeasurement): boolean {
  return (
    Number.isFinite(block.startLine) &&
    Number.isFinite(block.endLine) &&
    Number.isFinite(block.top) &&
    Number.isFinite(block.height) &&
    block.height > 0 &&
    block.startLine >= 1 &&
    block.endLine >= block.startLine
  );
}

function sourceLineExtent(block: SourceBlockMeasurement): number {
  return block.endLine - block.startLine + 1;
}

function chooseCrossingBlock(blocks: ReadonlyArray<SourceBlockMeasurement>) {
  return blocks
    .filter((block) => block.top <= 0 && block.top + block.height > 0 && isUsableBlock(block))
    .toSorted(compareSpecificity)[0];
}

function chooseFollowingBlock(blocks: ReadonlyArray<SourceBlockMeasurement>) {
  return blocks
    .filter((block) => block.top > 0 && isUsableBlock(block))
    .toSorted((left, right) => left.top - right.top || compareSpecificity(left, right))[0];
}

function choosePreviousBlock(blocks: ReadonlyArray<SourceBlockMeasurement>) {
  return blocks
    .filter((block) => block.top + block.height <= 0 && isUsableBlock(block))
    .toSorted(
      (left, right) =>
        right.top + right.height - (left.top + left.height) || compareSpecificity(left, right),
    )[0];
}

export function captureMarkdownReadingAnchor(input: {
  readonly metrics: ScrollMetrics;
  readonly blocks: ReadonlyArray<SourceBlockMeasurement>;
}): ReadingAnchor {
  const blocks = input.blocks.filter(isUsableBlock);
  const crossing = chooseCrossingBlock(blocks);
  if (crossing) {
    const progress = clampUnit(-crossing.top / crossing.height);
    return createAnchor({
      sourceLine: crossing.startLine + sourceLineExtent(crossing) * progress,
      sourceStartLine: crossing.startLine,
      sourceEndLine: crossing.endLine,
      sourceProgress: progress,
      viewportOffset: 0,
      metrics: input.metrics,
    });
  }

  const following = chooseFollowingBlock(blocks);
  if (following) {
    return createAnchor({
      sourceLine: following.startLine,
      sourceStartLine: following.startLine,
      sourceEndLine: following.endLine,
      sourceProgress: 0,
      viewportOffset: following.top,
      metrics: input.metrics,
    });
  }

  const previous = choosePreviousBlock(blocks);
  if (previous) {
    return createAnchor({
      sourceLine: previous.endLine + 1,
      sourceStartLine: previous.startLine,
      sourceEndLine: previous.endLine,
      sourceProgress: 1,
      viewportOffset: previous.top + previous.height,
      metrics: input.metrics,
    });
  }

  return createAnchor({
    sourceAvailable: false,
    sourceLine: 1,
    sourceStartLine: 1,
    sourceEndLine: 1,
    sourceProgress: 0,
    viewportOffset: 0,
    metrics: input.metrics,
  });
}

function chooseDestinationBlock(
  anchor: ReadingAnchor,
  blocks: ReadonlyArray<SourceBlockMeasurement>,
): SourceBlockMeasurement | undefined {
  const usable = blocks.filter(isUsableBlock);
  const exact = usable
    .filter(
      (block) =>
        block.startLine === anchor.sourceStartLine && block.endLine === anchor.sourceEndLine,
    )
    .toSorted(compareSpecificity)[0];
  if (exact) return exact;

  const containing = usable
    .filter(
      (block) =>
        block.startLine <= anchor.sourceLine && block.endLine >= Math.floor(anchor.sourceLine),
    )
    .toSorted(compareSpecificity)[0];
  if (containing) return containing;

  const following = usable
    .filter((block) => block.startLine > anchor.sourceLine)
    .toSorted(
      (left, right) => left.startLine - right.startLine || compareSpecificity(left, right),
    )[0];
  if (following) return following;

  return usable
    .filter((block) => block.endLine < anchor.sourceLine)
    .toSorted((left, right) => right.endLine - left.endLine || compareSpecificity(left, right))[0];
}

export function resolveRawScrollTop(
  anchor: ReadingAnchor,
  metrics: ScrollMetrics,
  linesTop: number,
  lineHeight: number,
): number {
  const max = getScrollMax(metrics);
  if (anchor.boundary === "top" || max === 0) return 0;
  if (anchor.boundary === "bottom") return max;
  if (anchor.sourceAvailable === false) return max * anchor.scrollFraction;
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return max * anchor.scrollFraction;
  const lineTop = finiteOr(linesTop, 0) + metrics.scrollTop + (anchor.sourceLine - 1) * lineHeight;
  return clampScrollTop(lineTop - anchor.viewportOffset, metrics);
}

export function resolveMarkdownScrollTop(
  anchor: ReadingAnchor,
  metrics: ScrollMetrics,
  blocks: ReadonlyArray<SourceBlockMeasurement>,
): number {
  const max = getScrollMax(metrics);
  if (anchor.boundary === "top" || max === 0) return 0;
  if (anchor.boundary === "bottom") return max;
  if (anchor.sourceAvailable === false) return max * anchor.scrollFraction;

  const block = chooseDestinationBlock(anchor, blocks);
  if (!block) return max * anchor.scrollFraction;

  const progress =
    block.startLine === anchor.sourceStartLine && block.endLine === anchor.sourceEndLine
      ? anchor.sourceProgress
      : clampUnit((anchor.sourceLine - block.startLine) / sourceLineExtent(block));
  const pointInContent = block.top + metrics.scrollTop + block.height * progress;
  return clampScrollTop(pointInContent - anchor.viewportOffset, metrics);
}
