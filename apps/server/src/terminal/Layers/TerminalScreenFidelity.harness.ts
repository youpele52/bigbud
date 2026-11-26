/**
 * Test-only cross-engine fidelity harness. Renders ANSI in `@xterm/headless` at the snapshot's
 * own geometry (never the viewer's), then compares cells, cursor and xterm-visible modes.
 * Used by the history-tail tests and by the screen-engine (R1) and manual-matrix (Q1) suites.
 */
import { Terminal, type IBuffer, type IBufferCell } from "@xterm/headless";
import { activateTerminalUnicodeProvider } from "@bigbud/shared/terminalUnicodeProvider";
import { Unicode11Addon } from "./TerminalRecoveryModel.addons.mjs";

export interface ScreenGeometry {
  readonly cols: number;
  readonly rows: number;
  /** Scrollback rows the rendering terminal keeps. Defaults to 1000, the host screen budget. */
  readonly scrollback?: number;
}

export interface ScreenCell {
  readonly char: string;
  readonly width: number;
  readonly fg: string;
  readonly bg: string;
  readonly attributes: string;
}

export interface ScreenCapture {
  readonly cols: number;
  readonly rows: number;
  readonly alternateScreen: boolean;
  readonly cursor: { readonly x: number; readonly y: number };
  readonly modes: Readonly<Record<string, unknown>>;
  /** Normal-buffer scrollback rows, oldest first. */
  readonly scrollback: readonly (readonly ScreenCell[])[];
  /** Rows of the active buffer's viewport, top first. */
  readonly visible: readonly (readonly ScreenCell[])[];
}

export interface ScreenDiff {
  readonly area: "geometry" | "cursor" | "mode" | "visible" | "scrollback";
  readonly row?: number;
  readonly col?: number;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface ScreenDiffOptions {
  /**
   * `all` compares every scrollback row, including the count. `newest` compares only the newest
   * rows the candidate kept (a trimmed tail). `none` skips scrollback.
   */
  readonly scrollback?: "all" | "newest" | "none";
  /** Oldest reference scrollback rows to exclude, such as rows written before a width change. */
  readonly excludeOldestScrollbackRows?: number;
}

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

function color(isDefault: boolean, isRgb: boolean, value: number): string {
  if (isDefault) return "default";
  return isRgb ? `#${value.toString(16).padStart(6, "0")}` : `p${value}`;
}

function captureCell(cell: IBufferCell): ScreenCell {
  const attributes = [
    cell.isBold() ? "bold" : "",
    cell.isDim() ? "dim" : "",
    cell.isItalic() ? "italic" : "",
    cell.isUnderline() ? `underline${cell.getUnderlineStyle()}` : "",
    cell.isBlink() ? "blink" : "",
    cell.isInverse() ? "inverse" : "",
    cell.isInvisible() ? "invisible" : "",
    cell.isStrikethrough() ? "strike" : "",
    cell.isOverline() ? "overline" : "",
  ].filter((attribute) => attribute.length > 0);
  return {
    char: cell.getChars(),
    width: cell.getWidth(),
    fg: color(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()),
    bg: color(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor()),
    attributes: attributes.join(","),
  };
}

function captureRows(buffer: IBuffer, cols: number, start: number, end: number): ScreenCell[][] {
  const rows: ScreenCell[][] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    const row: ScreenCell[] = [];
    for (let x = 0; x < cols; x++) {
      const cell = line?.getCell(x);
      row.push(
        cell
          ? captureCell(cell)
          : { char: "", width: 1, fg: "default", bg: "default", attributes: "" },
      );
    }
    rows.push(row);
  }
  return rows;
}

/** Renders `ansi` on a fresh terminal with the production unicode profile, then captures it. */
export async function captureScreen(
  ansi: string,
  geometry: ScreenGeometry,
): Promise<ScreenCapture> {
  const terminal = new Terminal({
    cols: geometry.cols,
    rows: geometry.rows,
    scrollback: geometry.scrollback ?? 1000,
    allowProposedApi: true,
    logLevel: "off",
  });
  try {
    terminal.loadAddon(new Unicode11Addon());
    activateTerminalUnicodeProvider(terminal);
    await write(terminal, ansi);
    const active = terminal.buffer.active;
    const normal = terminal.buffer.normal;
    return {
      cols: terminal.cols,
      rows: terminal.rows,
      alternateScreen: active.type === "alternate",
      cursor: { x: active.cursorX, y: active.cursorY },
      modes: { ...terminal.modes },
      scrollback: captureRows(normal, terminal.cols, 0, normal.baseY),
      visible: captureRows(active, terminal.cols, active.baseY, active.baseY + terminal.rows),
    };
  } finally {
    terminal.dispose();
  }
}

function diffRows(
  area: "visible" | "scrollback",
  expected: readonly (readonly ScreenCell[])[],
  actual: readonly (readonly ScreenCell[])[],
  rowOffset: number,
  diffs: ScreenDiff[],
): void {
  for (let row = 0; row < Math.max(expected.length, actual.length); row++) {
    const left = expected[row];
    const right = actual[row];
    if (!left || !right) {
      diffs.push({ area, row: row + rowOffset, expected: left ?? null, actual: right ?? null });
      continue;
    }
    for (let col = 0; col < Math.max(left.length, right.length); col++) {
      const a = left[col];
      const b = right[col];
      if (JSON.stringify(a) !== JSON.stringify(b))
        diffs.push({ area, row: row + rowOffset, col, expected: a ?? null, actual: b ?? null });
    }
  }
}

/** Every difference between two captures. An empty list means the screens are identical. */
export function diffScreens(
  expected: ScreenCapture,
  actual: ScreenCapture,
  options: ScreenDiffOptions = {},
): ScreenDiff[] {
  const diffs: ScreenDiff[] = [];
  if (expected.cols !== actual.cols || expected.rows !== actual.rows)
    diffs.push({
      area: "geometry",
      expected: { cols: expected.cols, rows: expected.rows },
      actual: { cols: actual.cols, rows: actual.rows },
    });
  if (expected.cursor.x !== actual.cursor.x || expected.cursor.y !== actual.cursor.y)
    diffs.push({ area: "cursor", expected: expected.cursor, actual: actual.cursor });
  const modes = { ...expected.modes, alternateScreen: expected.alternateScreen };
  const actualModes: Record<string, unknown> = {
    ...actual.modes,
    alternateScreen: actual.alternateScreen,
  };
  for (const [key, value] of Object.entries(modes))
    if (actualModes[key] !== value)
      diffs.push({ area: "mode", expected: { [key]: value }, actual: { [key]: actualModes[key] } });
  diffRows("visible", expected.visible, actual.visible, 0, diffs);
  const scrollback = options.scrollback ?? "all";
  if (scrollback === "none") return diffs;
  const excluded = Math.max(0, options.excludeOldestScrollbackRows ?? 0);
  let left = expected.scrollback.slice(excluded);
  let right = actual.scrollback;
  const offset = excluded + Math.max(0, left.length - right.length);
  if (scrollback === "newest") {
    const kept = Math.min(left.length, right.length);
    left = left.slice(left.length - kept);
    right = right.slice(right.length - kept);
  }
  diffRows("scrollback", left, right, scrollback === "newest" ? offset : excluded, diffs);
  return diffs;
}

/** Renders both streams at `geometry` and lists every difference from the reference. */
export async function diffAnsiFidelity(
  reference: string,
  candidate: string,
  geometry: ScreenGeometry,
  options?: ScreenDiffOptions,
): Promise<ScreenDiff[]> {
  const [expected, actual] = await Promise.all([
    captureScreen(reference, geometry),
    captureScreen(candidate, geometry),
  ]);
  return diffScreens(expected, actual, options);
}

/** Plain text of captured rows with trailing blanks removed, for readable assertions. */
export function screenText(rows: readonly (readonly ScreenCell[])[]): string[] {
  return rows.map((row) =>
    row
      .map((cell) => cell.char || (cell.width === 0 ? "" : " "))
      .join("")
      .trimEnd(),
  );
}
