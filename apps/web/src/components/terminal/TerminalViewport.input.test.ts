import type { NativeApi } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";
import { attachTerminalViewportInput } from "./TerminalViewport.input";
import { useTerminalStateStore } from "../../stores/terminal/terminal.store";
import { selectThreadTerminalProvider } from "../../stores/terminal/terminal.store.recentAgent";
import {
  makeTerminalEvent,
  resetTerminalStore,
  THREAD_ID,
} from "../../stores/terminal/terminal.store.test.helpers";

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: "keydown",
    key: "a",
    keyCode: 65,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function fixture(acceptsInput = () => true) {
  let onData: ((data: string) => void) | undefined;
  let onKey: ((event: KeyboardEvent) => boolean) | undefined;
  const wheel = vi.fn();
  const terminal = {
    onData: vi.fn((listener: (data: string) => void) => {
      onData = listener;
      return { dispose: () => (onData = undefined) };
    }),
    attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
      onKey = handler;
    },
    attachCustomWheelEventHandler: wheel,
    input: vi.fn(),
    modes: { mouseTrackingMode: "none" },
    rows: 24,
    element: undefined,
  };
  const pending: Array<() => void> = [];
  const write = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  const markInput = vi.fn();
  const onFind = vi.fn();
  const attached = attachTerminalViewportInput({
    terminal: terminal as never,
    terminalRef: { current: terminal as never },
    threadId: "thread-1",
    terminalId: "terminal-1",
    keybindingsRef: { current: DEFAULT_BINDINGS },
    api: { terminal: { write } } as unknown as NativeApi,
    acceptsInput,
    markInput,
    writeNotice: vi.fn(),
    tuiWheelMultiplier: () => 1,
    onFind,
  });
  const settle = async () => {
    pending.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    attached,
    write,
    markInput,
    onFind,
    wheel,
    settle,
    type: (data: string) => onData?.(data),
    key: (event: KeyboardEvent) => onKey?.(event),
  };
}

const sent = (write: ReturnType<typeof vi.fn>) =>
  write.mock.calls.map((call) => (call[0] as { data: string }).data);

afterEach(() => {
  resetTerminalStore();
  Object.defineProperty(navigator, "platform", { configurable: true, value: "" });
});

describe("attachTerminalViewportInput", () => {
  it("promotes the pane receiving input, but not when input is disabled", () => {
    const store = useTerminalStateStore.getState();
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", { terminalId: "terminal-1", provider: "pi" }),
    );
    store.applyTerminalEvent(
      makeTerminalEvent("agentIdentity", {
        terminalId: "other",
        provider: "claudeAgent",
        createdAt: "2026-04-02T20:00:01.000Z",
      }),
    );
    let accepts = false;
    const f = fixture(() => accepts);
    f.type("ignored");
    expect(selectThreadTerminalProvider(useTerminalStateStore.getState(), THREAD_ID)).toBe(
      "claudeAgent",
    );
    accepts = true;
    f.type("prompt");
    expect(selectThreadTerminalProvider(useTerminalStateStore.getState(), THREAD_ID)).toBe("pi");
    f.attached.dispose();
  });

  it("sends typing and shortcut sequences through one ordered, coalescing queue", async () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux" });
    const f = fixture();
    f.type("a");
    f.type("b");
    expect(f.key(keyEvent({ key: "ArrowLeft", ctrlKey: true }))).toBe(false);
    f.type("c");
    expect(sent(f.write)).toEqual(["a"]);
    expect(f.markInput).toHaveBeenCalledTimes(4);
    await f.settle();
    expect(sent(f.write)).toEqual(["a", "b\u001bbc"]);
    f.attached.dispose();
  });

  it("drops input while the view does not accept it and stops after dispose", async () => {
    let accepts = false;
    const f = fixture(() => accepts);
    f.type("ignored");
    expect(f.write).not.toHaveBeenCalled();
    accepts = true;
    f.attached.dispose();
    f.type("late");
    expect(f.write).not.toHaveBeenCalled();
  });

  it("opens find on the terminal find shortcut and attaches the TUI wheel handler", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux" });
    const f = fixture();
    expect(f.key(keyEvent({ key: "f", ctrlKey: true }))).toBe(false);
    expect(f.onFind).toHaveBeenCalledOnce();
    expect(f.key(keyEvent({ type: "keyup", key: "f", ctrlKey: true }))).toBe(false);
    expect(f.onFind).toHaveBeenCalledOnce();
    expect(f.write).not.toHaveBeenCalled();
    expect(f.wheel).toHaveBeenCalledOnce();
    f.attached.dispose();
  });
});
