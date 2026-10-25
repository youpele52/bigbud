import { describe, expect, it, vi } from "vitest";
import {
  revealTerminalFindSeed,
  terminalLogicalLineAt,
  TERMINAL_FIND_REVEAL_MAX_STEPS,
  terminalFindOptions,
} from "./TerminalFindBar.logic";

/** Rows of a fake buffer; `wrapped` rows continue the previous row's logical line. */
function fakeTerminal(rows: Array<{ text: string; wrapped?: boolean }>) {
  let selected: { y: number; x: number } | undefined;
  const terminal = {
    buffer: {
      active: {
        getLine: (y: number) =>
          rows[y]
            ? { isWrapped: rows[y]!.wrapped === true, translateToString: () => rows[y]!.text }
            : undefined,
      },
    },
    getSelectionPosition: () =>
      selected ? { start: selected, end: { x: selected.x + 1, y: selected.y } } : undefined,
  };
  /** findPrevious over the given match rows, newest first, wrapping around like xterm. */
  const searchOver = (matchRows: number[]) => {
    let index = -1;
    return {
      findPrevious: vi.fn(() => {
        if (matchRows.length === 0) return false;
        index = (index + 1) % matchRows.length;
        selected = { y: matchRows[index]!, x: 0 };
        return true;
      }),
      findNext: vi.fn(() => false),
    };
  };
  return { terminal, searchOver };
}

const options = terminalFindOptions({ caseSensitive: false, regex: false });

describe("terminal find reveal", () => {
  it("joins wrapped rows into the logical line", () => {
    const { terminal } = fakeTerminal([
      { text: "first" },
      { text: "error: a very long" },
      { text: " wrapped line", wrapped: true },
    ]);
    expect(terminalLogicalLineAt(terminal as never, 2)).toBe("error: a very long wrapped line");
    expect(terminalLogicalLineAt(terminal as never, 1)).toBe("error: a very long wrapped line");
  });

  it("steps back from the newest match to the hit's line, even when it is clipped", () => {
    const { terminal, searchOver } = fakeTerminal([
      { text: "error: one" },
      { text: "error: two is the hit" },
      { text: "error: three" },
    ]);
    const search = searchOver([2, 1, 0]);
    expect(
      revealTerminalFindSeed(terminal as never, search as never, "error", options, "…two is the…"),
    ).toBe(true);
    expect(search.findPrevious).toHaveBeenCalledTimes(2);
    expect(terminal.getSelectionPosition()?.start.y).toBe(1);
  });

  it("falls back to the newest match when the line is no longer in scrollback", () => {
    const { terminal, searchOver } = fakeTerminal([{ text: "error: a" }, { text: "error: b" }]);
    const search = searchOver([1, 0]);
    expect(
      revealTerminalFindSeed(terminal as never, search as never, "error", options, "error: gone"),
    ).toBe(false);
    expect(terminal.getSelectionPosition()?.start.y).toBe(1);
  });

  it("stops after a bounded number of steps and when nothing matches", () => {
    const rows = Array.from({ length: TERMINAL_FIND_REVEAL_MAX_STEPS + 50 }, (_, y) => ({
      text: `error ${y}`,
    }));
    const { terminal, searchOver } = fakeTerminal(rows);
    const search = searchOver(rows.map((_, y) => rows.length - 1 - y));
    expect(
      revealTerminalFindSeed(terminal as never, search as never, "error", options, "missing"),
    ).toBe(false);
    expect(search.findPrevious).toHaveBeenCalledTimes(TERMINAL_FIND_REVEAL_MAX_STEPS);
    const empty = fakeTerminal([]);
    expect(
      revealTerminalFindSeed(
        empty.terminal as never,
        empty.searchOver([]) as never,
        "x",
        options,
        "x",
      ),
    ).toBe(false);
  });
});
