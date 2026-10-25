// Adapted from Orca (stablyai/orca, MIT) pane-scroll.ts (capture/restore) and
// terminal-reflow-scroll-anchor.ts at be4e0719. The deferred rAF/timeout restores are omitted:
// bigbud fits synchronously inside its own frame, so one restore after the fit is authoritative.
import type { IMarker, Terminal } from "@xterm/xterm";

export type TerminalScrollTarget = Pick<
  Terminal,
  "buffer" | "cols" | "options" | "scrollToBottom" | "scrollToLine"
> & {
  registerMarker?: Terminal["registerMarker"];
  element?: HTMLElement | undefined;
};

export interface TerminalScrollState {
  readonly bufferType: string;
  readonly wasAtBottom: boolean;
  readonly viewportY: number;
  lineMarker: IMarker | undefined;
  logicalMarker: IMarker | undefined;
  readonly logicalCellOffset: number | undefined;
}

interface LineReader {
  isWrapped(lineY: number): boolean;
  cell(lineY: number, column: number): { code: number; width: number } | undefined;
}

type InternalLines = {
  get(lineY: number):
    | {
        getCodePoint(column: number): number;
        getWidth(column: number): number;
        isWrapped: boolean;
        length: number;
      }
    | undefined;
};

function lineReader(terminal: TerminalScrollTarget): LineReader {
  // Public getLine/getCell allocate wrappers per cell; the core lines avoid resize-path garbage.
  const lines = (
    terminal as { _core?: { _bufferService?: { buffer?: { lines?: InternalLines } } } }
  )._core?._bufferService?.buffer?.lines;
  if (lines && typeof lines.get === "function") {
    return {
      isWrapped: (lineY) => lines.get(lineY)?.isWrapped ?? false,
      cell: (lineY, column) => {
        const line = lines.get(lineY);
        if (!line || column < 0 || column >= line.length) return undefined;
        return { code: line.getCodePoint(column), width: line.getWidth(column) };
      },
    };
  }
  const buffer = terminal.buffer.active;
  return {
    isWrapped: (lineY) => buffer.getLine(lineY)?.isWrapped ?? false,
    cell: (lineY, column) => {
      const cell = buffer.getLine(lineY)?.getCell(column);
      return cell ? { code: cell.getCode(), width: cell.getWidth() } : undefined;
    },
  };
}

/** xterm wraps a wide glyph one cell early when only the last column remains. */
function rowCells(terminal: TerminalScrollTarget, lines: LineReader, lineY: number): number {
  const cols = Math.max(terminal.cols, 1);
  const last = lines.cell(lineY, cols - 1);
  const next = lines.cell(lineY + 1, 0);
  return last?.code === 0 && last.width === 1 && next?.width === 2 ? cols - 1 : cols;
}

function keepsPhysicalAnchor(terminal: TerminalScrollTarget): boolean {
  const pty = terminal.options?.windowsPty;
  // xterm disables reflow only for an explicit legacy Windows backend/build.
  return Boolean(pty?.buildNumber) && (pty?.backend !== "conpty" || pty.buildNumber! < 21376);
}

function captureLogicalAnchor(terminal: TerminalScrollTarget, viewportY: number) {
  const buffer = terminal.buffer.active;
  if (typeof buffer.getLine !== "function" || keepsPhysicalAnchor(terminal)) return undefined;
  const lines = lineReader(terminal);
  let lineY = viewportY;
  while (lineY > 0 && lines.isWrapped(lineY)) lineY--;
  const cursorLineY = buffer.baseY + buffer.cursorY;
  if (terminal.options?.reflowCursorLine !== true && cursorLineY >= lineY) {
    let sameLogicalLine = true;
    for (let y = lineY + 1; y <= cursorLineY && sameLogicalLine; y++)
      sameLogicalLine = lines.isWrapped(y);
    if (sameLogicalLine) return undefined;
  }
  let cellOffset = 0;
  for (let y = lineY; y < viewportY; y++) cellOffset += rowCells(terminal, lines, y);
  return { lineY, cellOffset };
}

function resolveLogicalLine(terminal: TerminalScrollTarget, startY: number, offset: number) {
  const buffer = terminal.buffer.active;
  const lines = lineReader(terminal);
  let lineY = startY;
  let remaining = offset;
  while (lineY < buffer.baseY && lines.isWrapped(lineY + 1)) {
    const cells = rowCells(terminal, lines, lineY);
    if (remaining < cells) break;
    remaining -= cells;
    lineY++;
  }
  return lineY;
}

/** Remember the first visible line so a reflow (fit, font change) keeps the reader's place. */
export function captureTerminalScrollState(terminal: TerminalScrollTarget): TerminalScrollState {
  const buffer = terminal.buffer.active;
  const viewportY = buffer.viewportY;
  const wasAtBottom = viewportY >= buffer.baseY;
  const anchored = !wasAtBottom && buffer.type === "normal";
  const anchor = anchored ? captureLogicalAnchor(terminal, viewportY) : undefined;
  const cursorLine = buffer.baseY + buffer.cursorY;
  const lineMarker = anchored ? terminal.registerMarker?.(viewportY - cursorLine) : undefined;
  return {
    bufferType: buffer.type,
    wasAtBottom,
    viewportY,
    // Continuation-row markers can drift during reflow; the logical line's first row is stable.
    lineMarker,
    logicalMarker:
      anchor?.lineY === viewportY
        ? lineMarker
        : anchor
          ? terminal.registerMarker?.(anchor.lineY - cursorLine)
          : undefined,
    logicalCellOffset: anchor?.cellOffset,
  };
}

function scrollSafely(action: () => void): void {
  try {
    action();
  } catch (error) {
    // A renderer mid-teardown has no dimensions; the next fit restores again.
    if (!(error instanceof TypeError && /dimensions/.test(error.message))) throw error;
  }
}

export function releaseTerminalScrollState(state: TerminalScrollState): void {
  state.lineMarker?.dispose();
  if (state.logicalMarker !== state.lineMarker) state.logicalMarker?.dispose();
  state.lineMarker = state.logicalMarker = undefined;
}

const liveLine = (marker: IMarker | undefined) =>
  marker && !marker.isDisposed && marker.line >= 0 ? marker.line : -1;

/** Follow output when the view was at the bottom, otherwise return to the anchored line. */
export function restoreTerminalScrollState(
  terminal: TerminalScrollTarget,
  state: TerminalScrollState,
): void {
  try {
    const buffer = terminal.buffer.active;
    if (state.bufferType === "alternate" || buffer.type !== state.bufferType) return;
    if (state.wasAtBottom) {
      scrollSafely(() => terminal.scrollToBottom());
      return;
    }
    const logicalLine = liveLine(state.logicalMarker);
    const line = liveLine(state.lineMarker);
    const target =
      logicalLine >= 0 && state.logicalCellOffset !== undefined
        ? resolveLogicalLine(terminal, logicalLine, state.logicalCellOffset)
        : line >= 0
          ? line
          : state.viewportY;
    const clamped = Math.min(target, buffer.baseY);
    if (clamped !== buffer.viewportY) scrollSafely(() => terminal.scrollToLine(clamped));
  } finally {
    releaseTerminalScrollState(state);
  }
}

/** Run a reflowing operation (fit) without losing the reader's scroll position. */
export function preserveTerminalScroll<T>(terminal: TerminalScrollTarget, reflow: () => T): T {
  const state = captureTerminalScrollState(terminal);
  let result: T;
  try {
    result = reflow();
  } catch (error) {
    releaseTerminalScrollState(state);
    throw error;
  }
  restoreTerminalScrollState(terminal, state);
  return result;
}
