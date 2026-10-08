import type { NativeApi } from "@bigbud/contracts";
import type { ILink, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";

import { makeTerminalLinkProvider } from "./TerminalViewport.links";

function fixture(rows: Array<{ text: string; isWrapped: boolean }>, circular = false) {
  const getLine = vi.fn((index: number) => {
    // Fail immediately rather than allow the old scan to exhaust the test process's heap.
    if (getLine.mock.calls.length > rows.length * 4 + 4) {
      throw new Error("Link scanner repeatedly traversed the circular buffer.");
    }
    const row = circular ? rows[index % rows.length] : rows[index];
    return row ? { isWrapped: row.isWrapped, translateToString: () => row.text } : undefined;
  });
  const terminalRef: { current: Terminal | null } = {
    current: { buffer: { active: { length: rows.length, getLine } } } as unknown as Terminal,
  };
  const provider = makeTerminalLinkProvider({
    terminalRef,
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    api: {} as NativeApi,
  });
  const callback = vi.fn<(links: ILink[] | undefined) => void>();
  return { provider, callback, getLine, terminalRef };
}

describe("terminal link buffer traversal", () => {
  it("terminates on an all-wrapped alternate screen even when out-of-range reads alias live rows", () => {
    const { provider, callback, getLine } = fixture(
      Array.from({ length: 19 }, () => ({ text: "TUI screen ", isWrapped: true })),
      true,
    );
    for (let hover = 0; hover < 100; hover++) {
      getLine.mockClear();
      provider.provideLinks(16, callback);
      expect(getLine.mock.calls.every(([index]) => index >= 0 && index < 19)).toBe(true);
      expect(getLine.mock.calls.length).toBeLessThanOrEqual(19 * 3);
    }
    expect(callback).toHaveBeenCalledTimes(100);
    expect(callback).toHaveBeenLastCalledWith(undefined);
  });

  it("includes the unwrapped first row of a URL when hovering its continuation", () => {
    const { provider, callback } = fixture([
      { text: "https://example.", isWrapped: false },
      { text: "com/docs", isWrapped: true },
      { text: "next prompt", isWrapped: false },
    ]);
    provider.provideLinks(2, callback);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "https://example.com/docs",
        range: { start: { x: 1, y: 2 }, end: { x: 8, y: 2 } },
      }),
    ]);
  });

  it("does not join a new hard line to a preceding wrapped path", () => {
    const { provider, callback } = fixture([
      { text: "./src/", isWrapped: false },
      { text: "first.ts", isWrapped: true },
      { text: "./second.ts", isWrapped: false },
    ]);
    provider.provideLinks(3, callback);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({
        text: "./second.ts",
        range: { start: { x: 1, y: 3 }, end: { x: 11, y: 3 } },
      }),
    ]);
  });

  it.each([0, -1, 20, 1.5, NaN, Infinity])("rejects invalid buffer row %s before lookup", (row) => {
    const { provider, callback, getLine } = fixture(
      [{ text: "./file.ts", isWrapped: false }],
      true,
    );
    provider.provideLinks(row, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(getLine).not.toHaveBeenCalled();
  });

  it("handles a disposed terminal without reading its buffer", () => {
    const { provider, callback, getLine, terminalRef } = fixture([]);
    terminalRef.current = null;
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(getLine).not.toHaveBeenCalled();
  });
});
