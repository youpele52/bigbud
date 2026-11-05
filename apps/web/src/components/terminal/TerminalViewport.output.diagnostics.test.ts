import type { Terminal } from "@xterm/xterm";
import { afterEach, expect, it, vi } from "vitest";
import {
  attachTerminalLifecycleDiagnostics,
  readTerminalLifecycleDiagnostics,
  setTerminalLifecycleDiagnosticsEnabled,
} from "./TerminalLifecycleDiagnostics";
import { createTerminalViewportOutput } from "./TerminalViewport.output";
import type { TerminalOutputSubscriber } from "./TerminalOutputStream";

const mocks = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  subscribe: vi.fn((_thread: string, _terminal: string, _subscriber: TerminalOutputSubscriber) => ({
    ready: Promise.resolve(),
    unsubscribe: () => mocks.unsubscribe(),
    parsed: () => undefined,
    diagnostics: () => null,
  })),
}));
vi.mock("./TerminalOutputStream", () => ({ subscribeTerminalOutput: mocks.subscribe }));

afterEach(() => setTerminalLifecycleDiagnosticsEnabled(false));

it("records subscription requests, resync and release once without changing stream ownership", async () => {
  setTerminalLifecycleDiagnosticsEnabled(true);
  const lifecycle = attachTerminalLifecycleDiagnostics({
    terminal: {} as Terminal,
    threadId: "t",
    terminalId: "a",
    now: () => 0,
  });
  const resync = vi.fn();
  const output = createTerminalViewportOutput({
    threadId: "t",
    terminalId: "a",
    lifecycle,
    receive: () => undefined,
    outstanding: () => 0,
    onResync: resync,
  });
  try {
    await output.subscribe();
    await output.subscribe();
    mocks.subscribe.mock.calls[0]![2].onResync?.();
    output.unsubscribe();
    output.unsubscribe();
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(resync).toHaveBeenCalledOnce();
    expect(readTerminalLifecycleDiagnostics().map((trace) => trace.event.type)).toEqual([
      "mounted",
      "subscribeRequested",
      "resync",
      "unsubscribed",
    ]);
  } finally {
    output.unsubscribe();
    lifecycle.dispose();
  }
});
