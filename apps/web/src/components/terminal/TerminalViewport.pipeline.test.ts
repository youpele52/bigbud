import { describe, expect, it, vi } from "vitest";
import { createTerminalOutputPipeline, isNativeWindowsConpty } from "./TerminalViewport.pipeline";

function fakeTerminal() {
  return {
    rows: 24,
    refresh: vi.fn(),
    buffer: { active: { type: "normal", cursorY: 0, baseY: 0, viewportY: 0 } },
  };
}

describe("terminal output pipeline", () => {
  it("treats only local PTYs on Windows clients as native ConPTY", () => {
    expect(isNativeWindowsConpty("Win32")).toBe(true);
    expect(isNativeWindowsConpty("Win32", "local")).toBe(true);
    expect(isNativeWindowsConpty("Win32", "ssh-devbox")).toBe(false);
    expect(isNativeWindowsConpty("MacIntel")).toBe(false);
  });

  it("strips transient cursor shows only for native ConPTY and always repairs rewrites", () => {
    const base = { isWebgl: () => false, lastInputAt: () => -Infinity };
    const mac = createTerminalOutputPipeline({
      ...base,
      terminal: fakeTerminal() as never,
      platform: "MacIntel",
    });
    expect(mac.batcherOptions.transformWrite).toBeUndefined();
    expect(mac.batcherOptions.immediateForeground).toBe(true);
    expect(mac.batcherOptions.prepareWrite?.("\r\x1b[2Kprogress")).toBeTypeOf("function");
    const windows = createTerminalOutputPipeline({
      ...base,
      terminal: fakeTerminal() as never,
      platform: "Win32",
    });
    expect(windows.batcherOptions.transformWrite?.("\x1b[?25h\x1b[5;1Hx\x1b[?25l")).not.toContain(
      "\x1b[?25h",
    );
    mac.dispose();
    windows.dispose();
  });
});
