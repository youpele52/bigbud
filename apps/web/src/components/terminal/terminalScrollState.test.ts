import { describe, expect, it, vi } from "vitest";
import {
  captureTerminalScrollState,
  preserveTerminalScroll,
  restoreTerminalScrollState,
} from "./terminalScrollState";

interface FakeLine {
  isWrapped: boolean;
}

/** Physical rows with wrap flags; markers follow the row they were registered on. */
function fakeTerminal(input: {
  rows: FakeLine[];
  viewportY: number;
  baseY: number;
  cols?: number;
}) {
  const markers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = [];
  const active = {
    type: "normal",
    viewportY: input.viewportY,
    baseY: input.baseY,
    cursorY: 0,
    getLine: (y: number) => {
      const row = terminal.lines[y];
      return row
        ? { isWrapped: row.isWrapped, getCell: () => ({ getCode: () => 65, getWidth: () => 1 }) }
        : undefined;
    },
  };
  const terminal = {
    lines: input.rows,
    cols: input.cols ?? 10,
    options: {},
    buffer: { active },
    markers,
    scrollToBottom: vi.fn(() => {
      active.viewportY = active.baseY;
    }),
    scrollToLine: vi.fn((line: number) => {
      active.viewportY = line;
    }),
    registerMarker: vi.fn((offset: number) => {
      const marker = {
        line: active.baseY + active.cursorY + offset,
        isDisposed: false,
        dispose: () => {
          marker.isDisposed = true;
        },
      };
      markers.push(marker);
      return marker;
    }),
  };
  active.cursorY = input.rows.length - 1 - input.baseY;
  return { terminal, active };
}

const plain = (count: number): FakeLine[] =>
  Array.from({ length: count }, () => ({ isWrapped: false }));

describe("terminal scroll state", () => {
  it("keeps following output when the view was at the bottom", () => {
    const { terminal, active } = fakeTerminal({ rows: plain(40), viewportY: 20, baseY: 20 });
    preserveTerminalScroll(terminal as never, () => {
      active.baseY = 25;
    });
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
    expect(active.viewportY).toBe(25);
    expect(terminal.registerMarker).not.toHaveBeenCalled();
  });

  it("returns a scrolled-up reader to the same line after rows were trimmed above it", () => {
    const { terminal, active } = fakeTerminal({ rows: plain(40), viewportY: 10, baseY: 20 });
    preserveTerminalScroll(terminal as never, () => {
      // A reflow removed three physical rows above the anchor.
      for (const marker of terminal.markers) marker.line -= 3;
      active.viewportY = 0;
    });
    expect(terminal.scrollToLine).toHaveBeenCalledWith(7);
    expect(terminal.markers.every((marker) => marker.isDisposed)).toBe(true);
  });

  it("anchors a continuation row by its logical line and cell offset", () => {
    const rows = plain(40);
    rows[11]!.isWrapped = true;
    rows[12]!.isWrapped = true;
    const { terminal, active } = fakeTerminal({ rows, viewportY: 12, baseY: 20 });
    const state = captureTerminalScrollState(terminal as never);
    expect(state.logicalCellOffset).toBe(20);
    expect(state.logicalMarker?.line).toBe(10);
    // Widen to 20 columns: the logical line now spans two rows, the offset lands on its second.
    terminal.cols = 20;
    rows.splice(12, 1);
    active.viewportY = 0;
    restoreTerminalScrollState(terminal as never, state);
    expect(active.viewportY).toBe(11);
  });

  it("never restores into the alternate screen and never scrolls past the bottom", () => {
    const alt = fakeTerminal({ rows: plain(30), viewportY: 2, baseY: 10 });
    alt.active.type = "alternate";
    preserveTerminalScroll(alt.terminal as never, () => undefined);
    expect(alt.terminal.scrollToLine).not.toHaveBeenCalled();
    const { terminal, active } = fakeTerminal({ rows: plain(30), viewportY: 8, baseY: 10 });
    const state = captureTerminalScrollState(terminal as never);
    active.baseY = 4;
    active.viewportY = 0;
    restoreTerminalScrollState(terminal as never, state);
    expect(active.viewportY).toBe(4);
  });

  it("releases markers when the reflow throws", () => {
    const { terminal } = fakeTerminal({ rows: plain(30), viewportY: 2, baseY: 10 });
    expect(() =>
      preserveTerminalScroll(terminal as never, () => {
        throw new Error("fit failed");
      }),
    ).toThrow("fit failed");
    expect(terminal.markers.every((marker) => marker.isDisposed)).toBe(true);
  });
});
