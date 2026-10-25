import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import {
  BEGIN_SYNCHRONIZED_UPDATE as BSU,
  END_SYNCHRONIZED_UPDATE as ESU,
} from "@bigbud/shared/terminalSynchronizedOutput";
import { readTerminalDiagnostics } from "./TerminalDiagnostics";
import {
  attachTerminalViewportInstrumentation,
  INTERACTIVE_INPUT_WINDOW_MS,
} from "./TerminalViewport.instrumentation";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const noop = () => undefined;

function fakeTerminal() {
  const listeners = new Map<string, () => void>();
  let render: () => void = noop;
  const textarea = {
    ownerDocument: { activeElement: null },
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const terminal = {
    textarea,
    onRender: (listener: () => void) => {
      render = listener;
      return { dispose: () => (render = noop) };
    },
  } as unknown as Terminal;
  return { terminal, listeners, render: () => render() };
}

describe("attachTerminalViewportInstrumentation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("tracks input latency sensitivity within the interactive window", () => {
    let time = 1000;
    const { terminal } = fakeTerminal();
    const view = attachTerminalViewportInstrumentation({
      terminal,
      threadId: "t",
      terminalId: "a",
      now: () => time,
    });
    expect(view.isLatencySensitive()).toBe(false);
    view.markInput();
    time += INTERACTIVE_INPUT_WINDOW_MS - 1;
    expect(view.isLatencySensitive()).toBe(true);
    time += 1;
    expect(view.isLatencySensitive()).toBe(false);
    view.dispose();
  });

  it("carries focus into every bound lane and reports a read-only snapshot", () => {
    vi.stubGlobal("window", {});
    let time = 0;
    const { terminal, listeners, render } = fakeTerminal();
    const view = attachTerminalViewportInstrumentation({
      terminal,
      threadId: "thread",
      terminalId: "term",
      now: () => time,
    });
    const first = new TerminalWriteBatcher();
    const firstFocus = vi.spyOn(first, "setFocused");
    view.bindWriteBatcher(first);
    listeners.get("focus")?.();
    expect(firstFocus).toHaveBeenLastCalledWith(true);
    const second = new TerminalWriteBatcher();
    const secondFocus = vi.spyOn(second, "setFocused");
    view.bindWriteBatcher(second);
    expect(secondFocus).toHaveBeenCalledWith(true);

    view.setRenderer({ mode: "webgl", reason: null });
    view.observeOutput(`${BSU}x${ESU}`);
    time += 4;
    render();
    const [snapshot] = readTerminalDiagnostics();
    expect(snapshot).toMatchObject({
      threadId: "thread",
      terminalId: "term",
      focused: true,
      renderer: { mode: "webgl" },
      delivery: { stopped: false, queuedBytes: 0, inFlightWrites: 0 },
      frames: { frames: 1, latencyP50Ms: 4 },
      stream: null,
    });
    expect(Object.getOwnPropertyDescriptor(window, "__bigbudTerminalDiagnostics")?.writable).toBe(
      false,
    );
    view.dispose();
    expect(readTerminalDiagnostics()).toHaveLength(0);
    expect(listeners.size).toBe(0);
    first.dispose();
    second.dispose();
  });

  it("applies visibility pacing to every bound lane and reports it in diagnostics", () => {
    const { terminal } = fakeTerminal();
    const view = attachTerminalViewportInstrumentation({
      terminal,
      threadId: "t",
      terminalId: "f",
    });
    const first = new TerminalWriteBatcher();
    const setForeground = vi.spyOn(first, "setForeground");
    view.bindWriteBatcher(first);
    expect(setForeground).toHaveBeenLastCalledWith(true);
    view.setForeground(false);
    expect(setForeground).toHaveBeenLastCalledWith(false);
    const replacement = new TerminalWriteBatcher();
    const replacementForeground = vi.spyOn(replacement, "setForeground");
    view.bindWriteBatcher(replacement);
    expect(replacementForeground).toHaveBeenLastCalledWith(false);
    expect(readTerminalDiagnostics().find((entry) => entry.terminalId === "f")?.foreground).toBe(
      false,
    );
    expect(view.isWebgl()).toBe(false);
    view.setRenderer({ mode: "webgl", reason: null });
    expect(view.isWebgl()).toBe(true);
    first.dispose();
    replacement.dispose();
    view.dispose();
  });
});
