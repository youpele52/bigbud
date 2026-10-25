import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { attachTerminalAddons } from "./TerminalViewport.addons";

it("loads Unicode 11, search, ligatures and inline images into a real emulator", async () => {
  const mount = document.createElement("div");
  mount.style.cssText = "width: 600px; height: 300px";
  document.body.append(mount);
  const terminal = new Terminal({ allowProposedApi: true });
  terminal.open(mount);
  const loadAddon = vi.spyOn(terminal, "loadAddon");
  const onGlyphShapingChanged = vi.fn();
  const addons = attachTerminalAddons(terminal, { onGlyphShapingChanged });
  try {
    expect(terminal.unicode.activeVersion).toBe("bigbud-11-zwj");
    addons.update(
      {
        terminalScrollSensitivity: 1.15,
        terminalFastScrollSensitivity: 5,
        terminalTuiScrollSensitivity: 1,
        terminalLigatures: "on",
        terminalInlineImages: true,
      },
      "monospace",
    );
    await expect.poll(() => loadAddon.mock.calls.length, { timeout: 15_000 }).toBe(4);
    expect(onGlyphShapingChanged).toHaveBeenCalledOnce();
    // A ZWJ family emoji occupies one wide cell pair, as CLIs budget it.
    await new Promise<void>((resolve) => terminal.write("\u{1F468}‍\u{1F469}|", resolve));
    expect(terminal.buffer.active.cursorX).toBe(3);
    terminal.write("needle in the haystack\r\n");
    await new Promise<void>((resolve) => terminal.write("", resolve));
    expect(addons.search.findNext("needle")).toBe(true);
  } finally {
    addons.dispose();
    terminal.dispose();
    mount.remove();
  }
});
