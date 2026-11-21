/**
 * Test-only: runs the R1 Rust screen goldens (`crates/bigbud-remote-agent/src/terminal_screen/
 * tests/goldens/*.golden`) through `@xterm/headless`, following the harness contract in that
 * crate's `tests/goldens.rs` header. `reference` replays the fixture's steps; `restored` writes
 * the host snapshot at its own geometry. Both are compared cell by cell, and `restored` is also
 * compared with the model's own normalized grid (`expected`). Differences are allowed only in
 * rows the snapshot itself reports as excluded.
 *
 * Not compared, because xterm.js exposes no state for them: kitty keyboard flags (host state;
 * the web app does not enable `vtExtensions.kittyKeyboard`) and DECSCNM (not implemented).
 *
 * @module TerminalScreenFidelity.goldens
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Terminal, type IBuffer, type IBufferCell } from "@xterm/headless";
import { activateTerminalUnicodeProvider } from "@bigbud/shared/terminalUnicodeProvider";

import { Unicode11Addon } from "./TerminalRecoveryModel.addons.mjs";

/** `[text, width, fg, bg, flags]`; flags are bold, dim, italic, underline, inverse (bits 0–4). */
export type GoldenCell = readonly [string, number, string | number, string | number, number];
type GoldenRows = ReadonlyArray<ReadonlyArray<GoldenCell>>;

export interface ScreenGolden {
  readonly fixture: string;
  readonly geometry: { readonly cols: number; readonly rows: number; readonly scrollback: number };
  readonly steps: ReadonlyArray<
    { readonly feed: string } | { readonly resize: readonly [number, number] }
  >;
  readonly snapshot: {
    readonly cols: number;
    readonly rows: number;
    readonly alternateScreen: boolean;
    readonly fidelity: string;
    readonly exclusions: ReadonlyArray<{ readonly kind: string; readonly rows: number }>;
    readonly reflowRows: number;
    readonly excludedRows: ReadonlyArray<number>;
    readonly excludedAlternate: boolean;
    readonly ansi: string;
    readonly pendingEscapeTailHex: string;
  };
  readonly expected: {
    readonly cursor: readonly [number, number];
    readonly cursorHidden: boolean;
    readonly scrollback: GoldenRows;
    readonly screen: GoldenRows;
    readonly alternate: GoldenRows | null;
  };
}

export function loadScreenGoldens(directory: string): ScreenGolden[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".golden"))
    .toSorted()
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as ScreenGolden);
}

export interface NormalizedScreen {
  /** Normal-buffer scrollback followed by its visible screen (the snapshot's row indices). */
  readonly normal: GoldenRows;
  readonly alternate: GoldenRows | null;
  /** `[row, col]` of the active buffer. */
  readonly cursor: readonly [number, number];
  readonly cursorHidden: boolean;
  readonly modes: Readonly<Record<string, unknown>>;
}

function colour(isDefault: boolean, isRgb: boolean, value: number): string | number {
  if (isDefault) return "default";
  return isRgb ? `#${value.toString(16).padStart(6, "0")}` : value;
}

/** The crate's `DumpCell::normalized` in xterm.js terms. */
function normalizedCell(cell: IBufferCell | undefined): GoldenCell {
  if (!cell) return ["", 1, "default", "default", 0];
  if (cell.getWidth() === 0) return ["", 0, "default", "default", 0];
  const underline = cell.isUnderline() !== 0;
  const inverse = cell.isInverse() !== 0;
  const flags =
    (cell.isBold() ? 1 : 0) |
    (cell.isDim() ? 2 : 0) |
    (cell.isItalic() ? 4 : 0) |
    (underline ? 8 : 0) |
    (inverse ? 16 : 0);
  const bg = colour(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
  const text = cell.getChars();
  if (text === "" || (text === " " && !underline && !inverse)) return ["", 1, "default", bg, 0];
  const fg = colour(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor());
  return [text, cell.getWidth(), fg, bg, flags];
}

function rowsOf(buffer: IBuffer, cols: number, start: number, end: number): GoldenCell[][] {
  const rows: GoldenCell[][] = [];
  for (let y = start; y < end; y++) {
    const line = buffer.getLine(y);
    const row: GoldenCell[] = [];
    for (let x = 0; x < cols; x++) row.push(normalizedCell(line?.getCell(x)));
    rows.push(row);
  }
  return rows;
}

/** A terminal's state in golden terms (the soak harness compares live terminals with it). */
export function captureNormalizedScreen(terminal: Terminal): NormalizedScreen {
  const { active, normal } = terminal.buffer;
  const alternate = active.type === "alternate";
  const mouse = (
    terminal as unknown as { _core?: { mouseStateService?: { activeEncoding?: string } } }
  )._core?.mouseStateService?.activeEncoding;
  const { showCursor, ...modes } = terminal.modes;
  return {
    normal: rowsOf(normal, terminal.cols, 0, normal.baseY + terminal.rows),
    alternate: alternate ? rowsOf(active, terminal.cols, 0, terminal.rows) : null,
    cursor: [active.cursorY, active.cursorX],
    cursorHidden: !showCursor,
    modes: { ...modes, mouseEncoding: mouse ?? "unknown", alternateScreen: alternate },
  };
}

/** A headless terminal with the production unicode profile; the caller disposes it. */
export function makeFidelityTerminal(geometry: {
  cols: number;
  rows: number;
  scrollback: number;
}): Terminal {
  const terminal = new Terminal({
    cols: geometry.cols,
    rows: geometry.rows,
    scrollback: geometry.scrollback,
    allowProposedApi: true,
    logLevel: "off",
  });
  terminal.loadAddon(new Unicode11Addon());
  activateTerminalUnicodeProvider(terminal);
  return terminal;
}

async function render(
  geometry: { cols: number; rows: number; scrollback: number },
  write: (terminal: Terminal) => Promise<void>,
): Promise<NormalizedScreen> {
  const terminal = makeFidelityTerminal(geometry);
  try {
    await write(terminal);
    return captureNormalizedScreen(terminal);
  } finally {
    terminal.dispose();
  }
}

export const writeAsync = (terminal: Terminal, data: string | Uint8Array) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function compareRows(
  label: string,
  left: GoldenRows,
  right: GoldenRows,
  skip: (row: number) => boolean,
  diffs: string[],
): void {
  // Aligned at the newest row; indices are the restored side's (scrollback then screen).
  if (left.length !== right.length) diffs.push(`${label}: ${left.length} vs ${right.length} rows`);
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index++) {
    const row = right.length - count + index;
    if (skip(row)) continue;
    const a = JSON.stringify(left[left.length - count + index]);
    const b = JSON.stringify(right[row]);
    if (a !== b) diffs.push(`${label} row ${row}: ${a} != ${b}`);
  }
}

/** Every unexplained difference for one golden; empty means the fixture passes. */
export async function compareScreenGolden(golden: ScreenGolden): Promise<string[]> {
  const { snapshot, expected } = golden;
  const reference = await render(golden.geometry, async (terminal) => {
    for (const step of golden.steps)
      if ("feed" in step) await writeAsync(terminal, step.feed);
      else terminal.resize(step.resize[0], step.resize[1]);
  });
  const restored = await render(
    { cols: snapshot.cols, rows: snapshot.rows, scrollback: golden.geometry.scrollback },
    async (terminal) => {
      await writeAsync(terminal, snapshot.ansi);
      if (snapshot.pendingEscapeTailHex)
        await writeAsync(terminal, hexBytes(snapshot.pendingEscapeTailHex));
    },
  );
  const excluded = new Set(snapshot.excludedRows);
  const isExcluded = (row: number) => excluded.has(row);
  const diffs: string[] = [];

  compareRows(
    "reference/normal",
    reference.normal,
    restored.normal,
    (row) => row < snapshot.reflowRows || isExcluded(row),
    diffs,
  );
  const expectedNormal = [...expected.scrollback, ...expected.screen];
  compareRows("expected/normal", expectedNormal, restored.normal, isExcluded, diffs);
  if (!snapshot.excludedAlternate) {
    if ((reference.alternate === null) !== (restored.alternate === null))
      diffs.push("reference/alternate: active screen differs");
    else if (reference.alternate && restored.alternate)
      compareRows(
        "reference/alternate",
        reference.alternate,
        restored.alternate,
        () => false,
        diffs,
      );
    if (expected.alternate && restored.alternate)
      compareRows("expected/alternate", expected.alternate, restored.alternate, () => false, diffs);
  }
  for (const [label, capture] of [["reference", reference] as const]) {
    if (JSON.stringify(capture.cursor) !== JSON.stringify(restored.cursor))
      diffs.push(`${label}/cursor: ${capture.cursor} != ${restored.cursor}`);
    if (capture.cursorHidden !== restored.cursorHidden) diffs.push(`${label}/cursorHidden`);
    for (const [key, value] of Object.entries(capture.modes))
      if (restored.modes[key] !== value)
        diffs.push(`${label}/mode ${key}: ${String(value)} != ${String(restored.modes[key])}`);
  }
  if (JSON.stringify(expected.cursor) !== JSON.stringify(restored.cursor))
    diffs.push(`expected/cursor: ${expected.cursor} != ${restored.cursor}`);
  if (expected.cursorHidden !== restored.cursorHidden) diffs.push("expected/cursorHidden");
  return diffs;
}
