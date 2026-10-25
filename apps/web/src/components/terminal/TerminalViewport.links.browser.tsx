import type { NativeApi } from "@bigbud/contracts";
import { Terminal, type ILink } from "@xterm/xterm";
import { expect, it, vi } from "vitest";

import { makeTerminalLinkProvider } from "./TerminalViewport.links";

it("keeps real xterm alternate-screen link hovers bounded through TUI redraws and resizes", async () => {
  const mount = document.createElement("div");
  document.body.append(mount);
  const terminal = new Terminal({ cols: 117, rows: 19 });
  terminal.open(mount);
  const provider = makeTerminalLinkProvider({
    terminalRef: { current: terminal },
    cwd: "/workspace",
    workspaceRoot: "/workspace",
    api: {} as NativeApi,
  });
  const callback = vi.fn<(links: ILink[] | undefined) => void>();
  const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
  try {
    await write("\u001b[?1049h");
    const buffer = terminal.buffer.active;
    const originalGetLine = buffer.getLine.bind(buffer);
    const getLine = vi.spyOn(buffer, "getLine").mockImplementation((index) => {
      if (index < 0 || index >= buffer.length) {
        throw new Error("Link hover read past the real xterm buffer boundary.");
      }
      return originalGetLine(index);
    });
    for (let redraw = 0; redraw < 20; redraw++) {
      terminal.resize(117 - (redraw % 3), 19 + (redraw % 2));
      await write("\u001b[2J\u001b[H" + "x".repeat(terminal.cols * (terminal.rows + 1)));
      expect(buffer.type).toBe("alternate");
      expect(buffer.length).toBe(terminal.rows);
      expect(Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.isWrapped)).toEqual(
        Array.from({ length: buffer.length }, () => true),
      );
      for (let row = 1; row <= buffer.length; row++) {
        getLine.mockClear();
        callback.mockClear();
        provider.provideLinks(row, callback);
        expect(callback).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(getLine.mock.calls.length).toBeLessThanOrEqual(buffer.length * 3);
      }
      // Parsing and hovering must release the renderer so animation/input can proceed.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    await write("\u001b[?1049l\u001b[2J\u001b[Hhttps://example.com/wrapped-terminal-link");
    provider.provideLinks(1, callback);
    expect(callback).toHaveBeenLastCalledWith([
      expect.objectContaining({ text: "https://example.com/wrapped-terminal-link" }),
    ]);
  } finally {
    terminal.dispose();
    mount.remove();
  }
});
