import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  bindFloatingAssistantAlwaysOnTop,
  reassertFloatingAssistantAlwaysOnTop,
  resolveFloatingAssistantAlwaysOnTopPolicy,
} from "./floatingAssistantWindows.alwaysOnTop";

interface MockAlwaysOnTopWindow {
  readonly focus: ReturnType<typeof vi.fn>;
  readonly handlers: Map<string, Array<() => void>>;
  readonly isDestroyed: ReturnType<typeof vi.fn>;
  readonly moveTop: ReturnType<typeof vi.fn>;
  readonly setAlwaysOnTop: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
  on(event: string, handler: () => void): void;
}

function createWindow(): MockAlwaysOnTopWindow {
  return {
    focus: vi.fn(),
    handlers: new Map(),
    isDestroyed: vi.fn(() => false),
    moveTop: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(),
    on(event, handler) {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
  };
}

function emit(window: MockAlwaysOnTopWindow, event: string): void {
  for (const handler of window.handlers.get(event) ?? []) handler();
}

describe("floating assistant always-on-top policy", () => {
  it.each([
    ["darwin", { level: "floating" }],
    ["win32", { level: "screen-saver" }],
    ["linux", { level: null }],
    ["aix", { level: null }],
  ])("uses the expected policy on %s", (platform, expected) => {
    expect(resolveFloatingAssistantAlwaysOnTopPolicy(platform)).toEqual(expected);
  });

  it.each([
    ["darwin", [true, "floating"]],
    ["win32", [true, "screen-saver"]],
    ["linux", [true]],
  ] as const)("applies the expected native request on %s", (platform, expected) => {
    const window = createWindow();

    reassertFloatingAssistantAlwaysOnTop(window as unknown as BrowserWindow, platform);

    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(...expected);
  });
});

describe("floating assistant always-on-top lifecycle", () => {
  it("applies immediately and reasserts at each display lifecycle boundary", () => {
    const window = createWindow();

    bindFloatingAssistantAlwaysOnTop(window as unknown as BrowserWindow, "win32");

    expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    for (const event of ["ready-to-show", "show", "restore", "focus"]) emit(window, event);
    expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(5);
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(true, "screen-saver");
  });

  it("does not call native APIs after the window is destroyed", () => {
    const window = createWindow();
    bindFloatingAssistantAlwaysOnTop(window as unknown as BrowserWindow, "darwin");
    window.setAlwaysOnTop.mockClear();
    window.isDestroyed.mockReturnValue(true);

    emit(window, "show");
    reassertFloatingAssistantAlwaysOnTop(window as unknown as BrowserWindow, "darwin");

    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
  });

  it("does not show, focus, or move the window while enforcing topmost state", () => {
    const window = createWindow();

    bindFloatingAssistantAlwaysOnTop(window as unknown as BrowserWindow, "linux");
    emit(window, "ready-to-show");

    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.moveTop).not.toHaveBeenCalled();
  });
});
