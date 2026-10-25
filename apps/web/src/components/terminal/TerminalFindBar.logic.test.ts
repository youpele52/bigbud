import { describe, expect, it, vi } from "vitest";
import {
  formatTerminalFindResults,
  safeTerminalFind,
  terminalFindOptions,
} from "./TerminalFindBar.logic";

function fakeSearch(implementation: () => boolean) {
  return { findNext: vi.fn(implementation), findPrevious: vi.fn(implementation) } as never as {
    findNext: ReturnType<typeof vi.fn>;
    findPrevious: ReturnType<typeof vi.fn>;
  };
}

describe("terminal find", () => {
  it("navigates in both directions and ignores an empty query", () => {
    const search = fakeSearch(() => true);
    const options = terminalFindOptions({ caseSensitive: true, regex: false });
    expect(safeTerminalFind(search as never, "next", "foo", options)).toBe(true);
    expect(safeTerminalFind(search as never, "previous", "foo", options)).toBe(true);
    expect(safeTerminalFind(search as never, "next", "", options)).toBe(false);
    expect(search.findNext).toHaveBeenCalledOnce();
    expect(search.findPrevious).toHaveBeenCalledWith("foo", options);
    expect(options.decorations?.activeMatchBackground).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("swallows decoration width and invalid regex errors but rethrows others", () => {
    const options = terminalFindOptions({ caseSensitive: false, regex: true });
    const decoration = fakeSearch(() => {
      throw new Error("This API only accepts positive integers");
    });
    expect(safeTerminalFind(decoration as never, "next", "x", options)).toBe(false);
    const regex = fakeSearch(() => {
      throw new SyntaxError("Invalid regular expression");
    });
    expect(safeTerminalFind(regex as never, "next", "(", options)).toBe(false);
    const broken = fakeSearch(() => {
      throw new Error("boom");
    });
    expect(() => safeTerminalFind(broken as never, "next", "x", options)).toThrow("boom");
  });

  it("formats result counts, including xterm's over-limit index", () => {
    expect(formatTerminalFindResults("", { resultIndex: -1, resultCount: 0 })).toBe("");
    expect(formatTerminalFindResults("a", { resultIndex: -1, resultCount: 0 })).toBe("No results");
    expect(formatTerminalFindResults("a", { resultIndex: 2, resultCount: 9 })).toBe("3 of 9");
    expect(formatTerminalFindResults("a", { resultIndex: -1, resultCount: 1000 })).toBe(
      "1000+ matches",
    );
  });
});
