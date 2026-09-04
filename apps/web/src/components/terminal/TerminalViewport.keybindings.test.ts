import type { NativeApi } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";
import { createTerminalKeyEventHandler } from "./TerminalViewport.keybindings";

function makeKeyboardEvent(
  type: string,
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent & {
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
} {
  return {
    type,
    key: "Enter",
    keyCode: 13,
    metaKey: false,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
    stopPropagation: ReturnType<typeof vi.fn>;
  };
}

function makeHandler() {
  const input = vi.fn();
  const write = vi.fn().mockResolvedValue(undefined);
  const terminal = { input } as never;
  const handler = createTerminalKeyEventHandler({
    terminal,
    terminalRef: { current: terminal },
    threadId: "thread-1",
    terminalId: "terminal-1",
    keybindingsRef: { current: DEFAULT_BINDINGS },
    api: { terminal: { write } } as unknown as NativeApi,
  });
  return { handler, input, write };
}

function setPlatform(platform: string) {
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TerminalViewport keybindings", () => {
  it("sends exactly one LF for an exact Shift+Enter keydown", () => {
    const { handler, input } = makeHandler();
    const event = makeKeyboardEvent("keydown");

    expect(handler(event)).toBe(false);
    expect(input).toHaveBeenCalledWith("\u000a", true);
    expect(input).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("suppresses Shift+Enter keypress and keyup without sending input", () => {
    const { handler, input } = makeHandler();
    const keypress = makeKeyboardEvent("keypress");
    const keyup = makeKeyboardEvent("keyup");

    expect(handler(keypress)).toBe(false);
    expect(handler(keyup)).toBe(false);
    expect(input).not.toHaveBeenCalled();
    expect(keypress.preventDefault).toHaveBeenCalledTimes(1);
    expect(keypress.stopPropagation).toHaveBeenCalledTimes(1);
    expect(keyup.preventDefault).toHaveBeenCalledTimes(1);
    expect(keyup.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("sends one LF for each repeated Shift+Enter keydown", () => {
    const { handler, input } = makeHandler();

    expect(handler(makeKeyboardEvent("keydown"))).toBe(false);
    expect(handler(makeKeyboardEvent("keydown"))).toBe(false);

    expect(input).toHaveBeenCalledTimes(2);
    expect(input).toHaveBeenNthCalledWith(1, "\u000a", true);
    expect(input).toHaveBeenNthCalledWith(2, "\u000a", true);
  });

  it("defers composing and IME keyCode 229 events", () => {
    const { handler, input } = makeHandler();
    const composing = makeKeyboardEvent("keydown", { isComposing: true });
    const ime = makeKeyboardEvent("keydown", { keyCode: 229 });

    expect(handler(composing)).toBe(true);
    expect(handler(ime)).toBe(true);
    expect(input).not.toHaveBeenCalled();
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(ime.preventDefault).not.toHaveBeenCalled();
  });

  it("defers plain Enter and modified Shift+Enter", () => {
    const { handler, input } = makeHandler();

    expect(handler(makeKeyboardEvent("keydown", { shiftKey: false }))).toBe(true);
    expect(handler(makeKeyboardEvent("keydown", { ctrlKey: true }))).toBe(true);
    expect(handler(makeKeyboardEvent("keydown", { metaKey: true }))).toBe(true);
    expect(handler(makeKeyboardEvent("keydown", { altKey: true }))).toBe(true);
    expect(input).not.toHaveBeenCalled();
  });

  it("preserves existing terminal navigation, clear, and app shortcut handling", async () => {
    setPlatform("Linux");
    const { handler, write } = makeHandler();

    expect(
      handler(makeKeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: false, ctrlKey: true })),
    ).toBe(false);
    expect(
      handler(makeKeyboardEvent("keydown", { key: "l", shiftKey: false, ctrlKey: true })),
    ).toBe(false);
    expect(
      handler(makeKeyboardEvent("keydown", { key: "j", shiftKey: false, ctrlKey: true })),
    ).toBe(false);

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenNthCalledWith(1, {
      threadId: "thread-1",
      terminalId: "terminal-1",
      data: "\u001bb",
    });
    expect(write).toHaveBeenNthCalledWith(2, {
      threadId: "thread-1",
      terminalId: "terminal-1",
      data: "\u000c",
    });
  });
});
