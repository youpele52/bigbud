import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalRendererState } from "./TerminalRendererController";

export const TERMINAL_LIFECYCLE_TRACE_LIMIT = 256;

type LifecycleEvent =
  | { type: "mounted" | "disposed" | "subscribeRequested" | "unsubscribed" | "resync" }
  | { type: "visibility"; foreground: boolean }
  | { type: "renderer"; mode: TerminalRendererState["mode"] }
  | { type: "input"; enabled: boolean }
  | { type: "hydration"; state: "started" | "ready" | "reattached" | "refused" | "paused" }
  | {
      type: "snapshot";
      pid: number | null;
      generation: string | null;
      status: TerminalSessionSnapshot["status"];
      historyChars: number;
      truncated: boolean;
      unavailable: boolean;
    };

export type TerminalLifecycleTrace = Readonly<{
  sequence: number;
  at: number;
  viewId: number;
  threadId: string;
  terminalId: string;
  event: Readonly<LifecycleEvent>;
}>;

let enabled = false;
let nextViewId = 0;
let sequence = 0;
const traces: TerminalLifecycleTrace[] = [];
const observers = new WeakMap<Terminal, TerminalLifecycleObserver>();

/** Opt-in, bounded, in-memory evidence; disabling also removes retained identifiers. */
export function setTerminalLifecycleDiagnosticsEnabled(value: boolean): void {
  enabled = value;
  traces.length = 0;
}

export function readTerminalLifecycleDiagnostics(): readonly TerminalLifecycleTrace[] {
  return traces.slice();
}

declare global {
  interface Window {
    readonly __bigbudTerminalLifecycleDiagnostics?: {
      readonly setEnabled: typeof setTerminalLifecycleDiagnosticsEnabled;
      readonly read: typeof readTerminalLifecycleDiagnostics;
    };
  }
}

/** Registers emulator identity separately from its replaceable renderer and delivery lanes. */
export function attachTerminalLifecycleDiagnostics(input: {
  terminal: Terminal;
  threadId: string;
  terminalId: string;
  now: () => number;
}) {
  if (
    typeof window !== "undefined" &&
    !Object.hasOwn(window, "__bigbudTerminalLifecycleDiagnostics")
  ) {
    Object.defineProperty(window, "__bigbudTerminalLifecycleDiagnostics", {
      value: Object.freeze({
        setEnabled: setTerminalLifecycleDiagnosticsEnabled,
        read: readTerminalLifecycleDiagnostics,
      }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
  }
  const viewId = ++nextViewId;
  // Bound identifiers independently of the ring; never retain a snapshot, error or output chunk.
  const threadId = input.threadId.slice(0, 128);
  const terminalId = input.terminalId.slice(0, 128);
  let disposed = false;
  const record = (event: LifecycleEvent) => {
    if (!enabled || disposed) return;
    if (traces.length === TERMINAL_LIFECYCLE_TRACE_LIMIT) traces.shift();
    traces.push(
      Object.freeze({
        sequence: ++sequence,
        at: input.now(),
        viewId,
        threadId,
        terminalId,
        event: Object.freeze(event),
      }),
    );
  };
  const observer = {
    viewId,
    record,
    snapshot(snapshot: TerminalSessionSnapshot) {
      record({
        type: "snapshot",
        pid: snapshot.pid,
        generation: snapshot.runtimeGeneration?.slice(0, 128) ?? null,
        status: snapshot.status,
        historyChars: snapshot.history.length,
        truncated: Boolean(snapshot.historyTruncated),
        unavailable: Boolean(snapshot.historyUnavailable),
      });
    },
    dispose() {
      if (disposed) return;
      record({ type: "disposed" });
      disposed = true;
      if (observers.get(input.terminal) === observer) observers.delete(input.terminal);
    },
  };
  observers.set(input.terminal, observer);
  record({ type: "mounted" });
  return observer;
}

export type TerminalLifecycleObserver = ReturnType<typeof attachTerminalLifecycleDiagnostics>;

export function terminalLifecycleDiagnostics(terminal: Terminal) {
  return observers.get(terminal);
}
