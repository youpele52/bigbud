import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalFontController, type TerminalTypographySettings } from "./TerminalFontController";
import {
  bundledTerminalFontFromSettings,
  SYSTEM_TERMINAL_FONT_FAMILY,
  terminalFontFamilyFromSettings,
  terminalLineHeightFromSettings,
} from "./terminalTypography";
import type { TerminalFontFamily } from "@bigbud/contracts/core/settings.ts";

function settings(font: TerminalFontFamily): TerminalTypographySettings {
  return {
    terminalFontFamily: terminalFontFamilyFromSettings(font),
    terminalFontSize: 12,
    terminalLineHeight: terminalLineHeightFromSettings(font),
    bundledTerminalFont: bundledTerminalFontFromSettings(font),
  };
}

function deferred() {
  let resolve!: (loaded: boolean) => void;
  const promise = new Promise<boolean>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TerminalFontController", () => {
  it("waits for the chosen font without assigning its family before it loads", async () => {
    const terminal = {
      options: { fontFamily: SYSTEM_TERMINAL_FONT_FAMILY, fontSize: 12, lineHeight: 1 },
    };
    const font = deferred();
    const load = vi.fn(() => font.promise);
    const controller = new TerminalFontController(terminal, load);
    const applied = vi.fn();
    controller.onApplied(applied);
    const ready = controller.update(settings("jetbrains-mono-nerd-font"));
    expect(terminal.options.fontFamily).toBe(SYSTEM_TERMINAL_FONT_FAMILY);
    expect(load).toHaveBeenCalledWith("JetBrainsMono Nerd Font Mono", 12);
    font.resolve(true);
    await ready;
    expect(terminal.options.fontFamily).toContain("JetBrainsMono Nerd Font Mono");
    expect(applied).toHaveBeenCalledOnce();
    await controller.update(settings("jetbrains-mono-nerd-font"));
    expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it("starts with fallback after timeout but applies and notifies when the font arrives late", async () => {
    const terminal = { options: { fontFamily: "previous-font", fontSize: 14, lineHeight: 1.2 } };
    const font = deferred();
    const controller = new TerminalFontController(terminal, () => font.promise);
    const applied = vi.fn();
    controller.onApplied(applied);
    const ready = controller.update(settings("jetbrains-mono-nerd-font"));
    await vi.advanceTimersByTimeAsync(1_000);
    await ready;
    expect(terminal.options).toEqual({
      fontFamily: SYSTEM_TERMINAL_FONT_FAMILY,
      fontSize: 12,
      lineHeight: 1,
    });
    font.resolve(true);
    await Promise.resolve();
    expect(terminal.options.fontFamily).toContain("JetBrainsMono Nerd Font Mono");
    expect(applied).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("ignores stale font loads and preserves the latest choice", async () => {
    const terminal = { options: {} };
    const oldFont = deferred();
    const newFont = deferred();
    const controller = new TerminalFontController(terminal, (family) =>
      family.startsWith("Meslo") ? oldFont.promise : newFont.promise,
    );
    const oldReady = controller.update(settings("meslo-nerd-font-mono"));
    const ready = controller.update(settings("jetbrains-mono-nerd-font"));
    oldFont.resolve(true);
    await Promise.resolve();
    expect(terminal.options).toEqual({});
    newFont.resolve(true);
    await Promise.all([oldReady, ready]);
    expect(terminal.options).toMatchObject({
      fontFamily: settings("jetbrains-mono-nerd-font").terminalFontFamily,
      lineHeight: 1,
    });
    controller.dispose();
  });

  it("cancels waits and ignores font completion after disposal", async () => {
    const terminal = { options: {} };
    const font = deferred();
    const controller = new TerminalFontController(terminal, () => font.promise);
    const ready = controller.update(settings("jetbrains-mono-nerd-font"));
    controller.dispose();
    await ready;
    font.resolve(true);
    await Promise.resolve();
    expect(terminal.options).toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back with a warning when the actual font loader fails", async () => {
    vi.stubGlobal("document", {
      fonts: { load: vi.fn().mockRejectedValue(new Error("asset missing")) },
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const terminal = { options: {} };
    const controller = new TerminalFontController(terminal);
    await controller.update(settings("jetbrains-mono-nerd-font"));
    expect(terminal.options).toMatchObject({
      fontFamily: SYSTEM_TERMINAL_FONT_FAMILY,
      lineHeight: 1,
    });
    expect(warning).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
});
