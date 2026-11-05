import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalLifecycleDiagnostics,
  readTerminalLifecycleDiagnostics,
  setTerminalLifecycleDiagnosticsEnabled,
  terminalLifecycleDiagnostics,
  TERMINAL_LIFECYCLE_TRACE_LIMIT,
} from "./TerminalLifecycleDiagnostics";

const fixture = () => ({
  terminal: {} as Terminal,
  threadId: "thread",
  terminalId: "terminal",
  now: () => 12,
});

afterEach(() => {
  setTerminalLifecycleDiagnosticsEnabled(false);
  vi.unstubAllGlobals();
});

describe("terminal lifecycle diagnostics", () => {
  it("is opt-in and clears retained identifiers on disable", () => {
    const input = fixture();
    const observer = attachTerminalLifecycleDiagnostics(input);
    expect(readTerminalLifecycleDiagnostics()).toEqual([]);
    setTerminalLifecycleDiagnosticsEnabled(true);
    observer.record({ type: "visibility", foreground: false });
    expect(readTerminalLifecycleDiagnostics()).toHaveLength(1);
    setTerminalLifecycleDiagnosticsEnabled(false);
    observer.record({ type: "visibility", foreground: true });
    expect(readTerminalLifecycleDiagnostics()).toEqual([]);
    observer.dispose();
    expect(terminalLifecycleDiagnostics(input.terminal)).toBeUndefined();
  });

  it("keeps emulator identity across renderer changes and records disposal once", () => {
    setTerminalLifecycleDiagnosticsEnabled(true);
    const input = fixture();
    const observer = attachTerminalLifecycleDiagnostics(input);
    observer.record({ type: "renderer", mode: "webgl" });
    observer.record({ type: "renderer", mode: "dom" });
    observer.dispose();
    observer.dispose();
    observer.record({ type: "resync" });
    const replacement = attachTerminalLifecycleDiagnostics(input);
    const traces = readTerminalLifecycleDiagnostics();
    expect(traces.slice(0, 4).map((trace) => trace.viewId)).toEqual(Array(4).fill(observer.viewId));
    expect(traces.map((trace) => trace.event.type)).toEqual([
      "mounted",
      "renderer",
      "renderer",
      "disposed",
      "mounted",
    ]);
    expect(replacement.viewId).not.toBe(observer.viewId);
    replacement.dispose();
  });

  it("stores only a bounded projection, never history, environment, paths or error text", () => {
    setTerminalLifecycleDiagnosticsEnabled(true);
    const observer = attachTerminalLifecycleDiagnostics({
      ...fixture(),
      threadId: "t".repeat(1000),
    });
    observer.snapshot({
      threadId: "private-thread",
      terminalId: "private-terminal",
      cwd: "private-directory",
      worktreePath: "private-worktree",
      runtimeEnv: { SECRET: "private-environment" },
      dropPathMode: "posix",
      status: "running",
      pid: 7,
      runtimeGeneration: "generation",
      history: "private-output",
      historyTruncated: true,
      exitCode: null,
      exitSignal: null,
      updatedAt: "timestamp",
    });
    const traces = readTerminalLifecycleDiagnostics();
    expect(JSON.stringify(traces)).not.toContain("private-");
    expect(traces[1]?.threadId).toHaveLength(128);
    expect(traces[1]?.event).toEqual({
      type: "snapshot",
      pid: 7,
      generation: "generation",
      status: "running",
      historyChars: 14,
      truncated: true,
      unavailable: false,
    });
    expect(Object.isFrozen(traces[1])).toBe(true);
    expect(Object.isFrozen(traces[1]?.event)).toBe(true);
    for (let i = 0; i < TERMINAL_LIFECYCLE_TRACE_LIMIT + 10; i++)
      observer.record({ type: "resync" });
    const bounded = readTerminalLifecycleDiagnostics();
    expect(bounded).toHaveLength(TERMINAL_LIFECYCLE_TRACE_LIMIT);
    expect(bounded.at(-1)!.sequence - bounded[0]!.sequence).toBe(
      TERMINAL_LIFECYCLE_TRACE_LIMIT - 1,
    );
    bounded.slice().pop();
    expect(readTerminalLifecycleDiagnostics()).toHaveLength(TERMINAL_LIFECYCLE_TRACE_LIMIT);
    observer.dispose();
  });

  it("exposes a non-writable console control without logging or transmitting data", () => {
    vi.stubGlobal("window", {});
    const observer = attachTerminalLifecycleDiagnostics(fixture());
    const control = window.__bigbudTerminalLifecycleDiagnostics!;
    expect(Object.isFrozen(control)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(window, "__bigbudTerminalLifecycleDiagnostics")?.writable,
    ).toBe(false);
    control.setEnabled(true);
    observer.record({ type: "input", enabled: false });
    expect(control.read()[0]?.event).toEqual({ type: "input", enabled: false });
    observer.dispose();
  });
});
