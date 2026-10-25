import type { TerminalFrameMetricsSnapshot } from "./TerminalFrameMetrics";
import type { TerminalRendererState } from "./TerminalRendererController";

export interface TerminalStreamDiagnostics {
  readonly scoped: boolean;
  readonly subscriptionId: string | null;
  readonly receivedChars: number;
  readonly acknowledgedChars: number;
}

export interface TerminalViewDiagnostics {
  readonly threadId: string;
  readonly terminalId: string;
  readonly renderer: TerminalRendererState;
  readonly focused: boolean;
  /** On screen; hidden views use paced background delivery. */
  readonly foreground: boolean;
  readonly delivery: {
    readonly stopped: boolean;
    readonly queuedBytes: number;
    readonly inFlightWrites: number;
    readonly heldFrames: number;
  };
  readonly frames: TerminalFrameMetricsSnapshot;
  readonly stream: TerminalStreamDiagnostics | null;
}

const views = new Set<() => TerminalViewDiagnostics>();

declare global {
  interface Window {
    /** Read-only snapshot of every mounted terminal view; contains no terminal output. */
    readonly __bigbudTerminalDiagnostics?: () => ReadonlyArray<TerminalViewDiagnostics>;
  }
}

export function readTerminalDiagnostics(): ReadonlyArray<TerminalViewDiagnostics> {
  return [...views].map((read) => read());
}

function installGlobal(): void {
  if (typeof window === "undefined" || Object.hasOwn(window, "__bigbudTerminalDiagnostics")) return;
  Object.defineProperty(window, "__bigbudTerminalDiagnostics", {
    value: readTerminalDiagnostics,
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/** Registers one mounted view; the returned function unregisters it. */
export function registerTerminalDiagnostics(read: () => TerminalViewDiagnostics): () => void {
  installGlobal();
  views.add(read);
  return () => {
    views.delete(read);
  };
}
