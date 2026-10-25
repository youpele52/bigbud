import type { Terminal } from "@xterm/xterm";
import { registerTerminalDiagnostics, type TerminalStreamDiagnostics } from "./TerminalDiagnostics";
import { TerminalFrameMetrics } from "./TerminalFrameMetrics";
import type { TerminalRendererState } from "./TerminalRendererController";
import type { TerminalWriteBatcher } from "./TerminalWriteBatcher";

/** Output within this window after a keystroke is treated as an interactive echo (orca: 100 ms). */
export const INTERACTIVE_INPUT_WINDOW_MS = 100;

/**
 * Per-view delivery instrumentation: focus priority for the scheduler, the input-latency signal
 * that shortens synchronized-frame holds, and the read-only diagnostics snapshot.
 */
export function attachTerminalViewportInstrumentation(input: {
  readonly terminal: Terminal;
  readonly threadId: string;
  readonly terminalId: string;
  readonly now?: () => number;
}) {
  const now = input.now ?? (() => performance.now());
  const metrics = new TerminalFrameMetrics(now);
  let renderer: TerminalRendererState = { mode: "dom", reason: null };
  let batcher: TerminalWriteBatcher | null = null;
  let stream: (() => TerminalStreamDiagnostics | null) | null = null;
  let lastInputAt = -Infinity;
  let foreground = true;
  const textarea = input.terminal.textarea;
  let focused = textarea !== undefined && textarea.ownerDocument.activeElement === textarea;
  const setFocused = (next: boolean) => {
    focused = next;
    batcher?.setFocused(next);
  };
  const onFocus = () => setFocused(true);
  const onBlur = () => setFocused(false);
  textarea?.addEventListener("focus", onFocus);
  textarea?.addEventListener("blur", onBlur);
  const renderDisposable = input.terminal.onRender(() => metrics.rendered());
  const unregister = registerTerminalDiagnostics(() => ({
    threadId: input.threadId,
    terminalId: input.terminalId,
    renderer,
    focused,
    foreground,
    delivery: {
      stopped: batcher?.isStopped ?? true,
      queuedBytes: batcher?.queuedBytes ?? 0,
      inFlightWrites: batcher?.inFlight ?? 0,
      heldFrames: batcher?.heldFrames ?? 0,
    },
    frames: metrics.snapshot(),
    stream: stream?.() ?? null,
  }));

  return {
    observeOutput: (data: string) => metrics.observe(data),
    markInput: () => {
      lastInputAt = now();
    },
    isLatencySensitive: () => now() - lastInputAt < INTERACTIVE_INPUT_WINDOW_MS,
    lastInputAt: () => lastInputAt,
    isWebgl: () => renderer.mode === "webgl",
    setRenderer: (state: TerminalRendererState) => {
      renderer = state;
    },
    /** Painted on screen: visible output is written immediately, hidden output is paced. */
    setForeground: (next: boolean) => {
      foreground = next;
      batcher?.setForeground(next);
    },
    /** Called for every (re)created delivery lane so focus and pacing survive lane replacement. */
    bindWriteBatcher: (next: TerminalWriteBatcher) => {
      batcher = next;
      next.setFocused(focused);
      next.setForeground(foreground);
    },
    bindStream: (read: () => TerminalStreamDiagnostics | null) => {
      stream = read;
    },
    dispose: () => {
      textarea?.removeEventListener("focus", onFocus);
      textarea?.removeEventListener("blur", onBlur);
      renderDisposable.dispose();
      unregister();
      batcher = null;
      stream = null;
    },
  };
}

export type TerminalViewportInstrumentation = ReturnType<
  typeof attachTerminalViewportInstrumentation
>;
