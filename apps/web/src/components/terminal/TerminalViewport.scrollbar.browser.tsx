import "../../index.css";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";

it("styles xterm's overlay scrollbar like the app scrollbar (6px, rounded, theme thumb colour)", async () => {
  const mount = document.createElement("div");
  mount.style.cssText = "width: 600px; height: 200px";
  document.body.append(mount);
  const terminal = new Terminal({
    rows: 10,
    theme: { scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)" },
  });
  terminal.open(mount);
  try {
    await new Promise<void>((resolve) =>
      terminal.write(
        Array.from({ length: 200 }, (_, line) => `line ${line}`).join("\r\n"),
        resolve,
      ),
    );
    // Fails loudly if xterm renames its scrollbar classes again (6.0 -> 6.1 did).
    const scrollbar = mount.querySelector<HTMLElement>(".xterm-scrollbar.xterm-vertical");
    const slider = scrollbar?.querySelector<HTMLElement>(".xterm-slider");
    expect(scrollbar).not.toBeNull();
    expect(slider).not.toBeNull();
    await expect.poll(() => slider!.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(getComputedStyle(scrollbar!).width).toBe("6px");
    expect(getComputedStyle(slider!).width).toBe("6px");
    expect(getComputedStyle(slider!).borderRadius).toBe("3px");
    expect(getComputedStyle(slider!).backgroundColor).toBe("rgba(255, 255, 255, 0.1)");
  } finally {
    terminal.dispose();
    mount.remove();
  }
});
