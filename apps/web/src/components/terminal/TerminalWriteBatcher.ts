import { type Terminal } from "@xterm/xterm";
import { openSynchronizedFrameStart } from "@bigbud/shared/terminalSynchronizedOutput";
import {
  cancelTerminalOutput,
  scheduleTerminalOutput,
  setTerminalOutputPriority,
} from "./TerminalOutputScheduler";
import { reserveTerminalOutput, releaseTerminalOutput } from "./TerminalOutputBudget";
import {
  BACKGROUND_DRAIN_INTERVAL_MS,
  BACKGROUND_FLUSH_DELAY_MS,
  BACKGROUND_IN_FLIGHT_WRITES,
  BACKGROUND_LARGE_BACKLOG_BYTES,
  ForegroundImmediateBudget,
} from "./TerminalWriteBatcher.pacing";
import { TerminalPipelineStalledError, TerminalWriteWatchdog } from "./TerminalWriteWatchdog";

// writeUnits keeps one parser write within 32 KiB encoded (<=3 bytes per UTF-16 unit). The
// in-flight window lets xterm's own write buffer pipeline parsing (Orca drains up to 8 x 16 KiB per
// turn) instead of paying a full callback round trip per write, which strands TUIs mid-frame.
const WRITE_UNITS = Math.floor((32 * 1024) / 3);
export const TERMINAL_WRITE_LIMITS = {
  bytes: 1024 * 1024,
  items: 4096,
  writeUnits: WRITE_UNITS,
  inFlightWrites: 8,
  inFlightUnits: 8 * WRITE_UNITS,
};
/** Orca's values: hold an open frame briefly, and much more briefly right after user input. */
export const FRAME_HOLD_SAFETY_MS = 250;
export const LATENCY_SENSITIVE_FRAME_HOLD_SAFETY_MS = 32;

type Operation =
  | { data: string; bytes: number; credit: number }
  | { barrier: () => void; reject?: (error: Error) => void };

export interface TerminalWriteBatcherOptions {
  /** True shortly after user input; shortens the open-frame hold so echo is never delayed. */
  readonly isLatencySensitive?: () => boolean;
  /** Parser completion of credited units (see `write`); never called for discarded output. */
  readonly onParsed?: (credit: number) => void;
  /** Visible writes only: called before the write, the returned step runs once it parsed. */
  readonly prepareWrite?: (data: string) => (() => void) | undefined;
  /** Visible writes only: rewrite the bytes handed to xterm (accounting uses the original). */
  readonly transformWrite?: (data: string) => string;
  /** Echo-sized output of a visible, idle view skips the scheduler hop (Orca's fast path). */
  readonly immediateForeground?: boolean;
  /** Enables the write-pipeline watchdog: called once a silent parser is certified dead. */
  readonly onStalled?: () => void;
  readonly now?: () => number;
}

const cost = (data: string) => data.length * 3;

/** Ordered view lane. Failure detaches the view, never acknowledges discarded data. */
export class TerminalWriteBatcher {
  private queue: Operation[] = [];
  private terminal: Terminal | null = null;
  private inFlightWrites = 0;
  private inFlightUnits = 0;
  private stopped = false;
  private failure: Error | undefined;
  private bytes = 0;
  private generation = 0;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdExpired = false;
  private heldFrameCount = 0;
  private outstanding = 0;
  private foreground = true;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBackgroundDrainAt = -Infinity;
  private watchdog: TerminalWriteWatchdog | null = null;
  private readonly immediate: ForegroundImmediateBudget;
  private readonly now: () => number;
  private readonly run = () => this.drain();

  constructor(
    private readonly onFailure: (error: Error) => void = () => undefined,
    private readonly options: TerminalWriteBatcherOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.immediate = new ForegroundImmediateBudget(this.now);
  }

  get queuedBytes(): number {
    return this.bytes;
  }
  get isStopped(): boolean {
    return this.stopped;
  }
  get inFlight(): number {
    return this.inFlightWrites;
  }
  get heldFrames(): number {
    return this.heldFrameCount;
  }
  /** Credited units queued or in flight; zero after the lane stops (discarded output is consumed). */
  get outstandingCredit(): number {
    return this.outstanding;
  }

  /** The focused terminal's lane is served first in every scheduler turn. */
  setFocused(focused: boolean): void {
    if (!this.stopped) setTerminalOutputPriority(this.run, focused);
  }

  /** Visible views write immediately when idle; hidden views are paced (Orca's background lane). */
  setForeground(foreground: boolean): void {
    if (this.stopped || this.foreground === foreground) return;
    this.foreground = foreground;
    this.clearBackgroundTimer();
    this.flush();
  }

  /**
   * `credit` (at most `data.length`) is the flow-control credit this output carries; it is
   * released through `onParsed` once xterm has parsed the last character it covers.
   */
  write(terminal: Terminal, data: string, credit = 0): void {
    if (this.stopped || !data) return;
    if (this.terminal && this.terminal !== terminal) {
      this.pause(new Error("Terminal view identity changed during output delivery."));
      return;
    }
    const onStalled = this.options.onStalled;
    if (this.terminal === null && onStalled)
      this.watchdog = new TerminalWriteWatchdog(terminal, () => {
        this.pause(new TerminalPipelineStalledError());
        onStalled();
      });
    this.terminal = terminal;
    const idle = this.queue.length === 0 && this.inFlightWrites === 0 && this.holdTimer === null;
    // Bound both UTF-8 payload and retained UTF-16 storage, including in-flight work.
    const bytes = cost(data);
    const count = Math.ceil(data.length / (TERMINAL_WRITE_LIMITS.writeUnits - 1));
    if (
      bytes + this.bytes > TERMINAL_WRITE_LIMITS.bytes ||
      this.queue.length + count + this.inFlightWrites > TERMINAL_WRITE_LIMITS.items
    ) {
      this.pause(
        new Error(
          "Terminal output exceeded the view budget. Delivery and input are paused; exact recovery is unavailable for this legacy session.",
        ),
      );
      return;
    }
    if (!reserveTerminalOutput(bytes)) {
      this.pause(
        new Error("Terminal window output budget exceeded. Delivery and input are paused."),
      );
      return;
    }
    const chunks: Array<{ data: string; bytes: number; credit: number }> = [];
    for (let start = 0; start < data.length; ) {
      let end = Math.min(start + TERMINAL_WRITE_LIMITS.writeUnits, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = data.slice(start, end);
      chunks.push({ data: chunk, bytes: cost(chunk), credit: 0 });
      start = end;
    }
    // Credit sits on the latest characters so it is never released before they are parsed.
    let remaining = Math.max(0, Math.min(credit, data.length));
    this.outstanding += remaining;
    for (let index = chunks.length - 1; index >= 0 && remaining > 0; index--) {
      const chunk = chunks[index]!;
      chunk.credit = Math.min(remaining, chunk.data.length);
      remaining -= chunk.credit;
    }
    this.queue.push(...chunks);
    this.bytes += bytes;
    // Echo-sized visible output skips the scheduler hop (Orca's foreground immediate write).
    if (
      this.options.immediateForeground === true &&
      this.foreground &&
      idle &&
      this.immediate.admit(data, this.options.isLatencySensitive?.() ?? false)
    ) {
      this.drain();
      return;
    }
    this.flush();
  }

  /** Flush requests progress; barriers still wait for every in-flight parser callback. */
  flush(): void {
    if (this.stopped || this.queue.length === 0) return;
    if (this.foreground) {
      scheduleTerminalOutput(this.run);
      return;
    }
    if (this.backgroundTimer !== null) return;
    const delay =
      this.bytes > BACKGROUND_LARGE_BACKLOG_BYTES
        ? 0
        : this.now() - this.lastBackgroundDrainAt < BACKGROUND_FLUSH_DELAY_MS
          ? BACKGROUND_DRAIN_INTERVAL_MS
          : BACKGROUND_FLUSH_DELAY_MS;
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (!this.stopped) scheduleTerminalOutput(this.run);
    }, delay);
  }

  private clearBackgroundTimer(): void {
    if (this.backgroundTimer !== null) clearTimeout(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  barrier(action: () => void): void {
    if (this.stopped) return;
    if (this.queue.length + this.inFlightWrites >= TERMINAL_WRITE_LIMITS.items) {
      this.pause(new Error("Terminal operation budget exceeded. Delivery is paused."));
      return;
    }
    this.queue.push({ barrier: action });
    this.flush();
  }

  whenIdle(): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error("Terminal view disposed."));
    return new Promise((resolve, reject) => {
      if (this.queue.length + this.inFlightWrites >= TERMINAL_WRITE_LIMITS.items) {
        this.pause(new Error("Terminal operation budget exceeded. Delivery is paused."));
        reject(this.failure);
        return;
      }
      this.queue.push({ barrier: resolve, reject });
      this.flush();
    });
  }

  private drain(): void {
    if (this.stopped) return;
    // A barrier orders after all earlier output is parsed, so it waits for the in-flight window.
    while (this.queue[0] && "barrier" in this.queue[0]) {
      if (this.inFlightWrites > 0) return;
      const operation = this.queue.shift() as Extract<Operation, { barrier: () => void }>;
      try {
        operation.barrier();
      } catch (error) {
        this.pause(error);
      }
      if (this.stopped) return;
    }
    const terminal = this.terminal;
    if (!terminal || this.queue.length === 0) return;
    const maxWrites = this.foreground
      ? TERMINAL_WRITE_LIMITS.inFlightWrites
      : BACKGROUND_IN_FLIGHT_WRITES;
    if (
      this.inFlightWrites >= maxWrites ||
      this.inFlightUnits >= TERMINAL_WRITE_LIMITS.inFlightUnits
    )
      return;
    if (!this.foreground) this.lastBackgroundDrainAt = this.now();
    // Coalesce only adjacent output, never across a reset/install/exit barrier.
    let data = "";
    let credit = 0;
    let count = 0;
    for (const operation of this.queue) {
      if (!("data" in operation)) break;
      if (count > 0 && data.length + operation.data.length > TERMINAL_WRITE_LIMITS.writeUnits)
        break;
      data += operation.data;
      credit += operation.credit;
      count++;
    }
    const writable = this.writablePrefix(data, count === this.queue.length);
    if (writable === 0) return;
    this.queue.splice(0, count);
    let writtenCredit = credit;
    if (writable < data.length) {
      const held = data.slice(writable);
      const heldCredit = Math.min(credit, held.length);
      writtenCredit -= heldCredit;
      this.queue.unshift({ data: held, bytes: cost(held), credit: heldCredit });
    }
    this.dispatch(terminal, data.slice(0, writable), writtenCredit);
    if (this.queue.length === 0) return;
    // A paced hidden tick fills its small in-flight window; visible lanes yield per turn.
    if (!this.foreground && this.inFlightWrites < BACKGROUND_IN_FLIGHT_WRITES) this.drain();
    else this.flush();
  }

  /** How much of `data` may be written now; an open frame at the tail waits for its end marker. */
  private writablePrefix(data: string, consumesQueuedOutput: boolean): number {
    const openFrame = consumesQueuedOutput ? openSynchronizedFrameStart(data) : -1;
    if (openFrame === -1 || this.holdExpired) {
      this.clearHold();
      return data.length;
    }
    if (this.holdTimer === null) {
      this.heldFrameCount++;
      const delay = this.options.isLatencySensitive?.()
        ? LATENCY_SENSITIVE_FRAME_HOLD_SAFETY_MS
        : FRAME_HOLD_SAFETY_MS;
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null;
        this.holdExpired = true;
        this.flush();
      }, delay);
    }
    return openFrame;
  }

  private clearHold(): void {
    this.holdExpired = false;
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private dispatch(terminal: Terminal, data: string, credit: number): void {
    const generation = this.generation;
    const units = data.length;
    this.inFlightWrites++;
    this.inFlightUnits += units;
    let completed = false;
    try {
      const written =
        this.foreground && this.options.transformWrite ? this.options.transformWrite(data) : data;
      const repaired = this.foreground ? this.options.prepareWrite?.(written) : undefined;
      this.watchdog?.arm();
      terminal.write(written, () => {
        if (completed || this.stopped || generation !== this.generation) return;
        completed = true;
        this.watchdog?.settle();
        try {
          repaired?.();
        } catch {
          /* A failed repaint must never wedge xterm's write loop. */
        }
        this.inFlightWrites--;
        this.inFlightUnits -= units;
        this.bytes -= cost(data);
        releaseTerminalOutput(cost(data));
        this.outstanding -= credit;
        if (credit > 0) {
          try {
            this.options.onParsed?.(credit);
          } catch {
            /* Contain application credit callbacks. */
          }
        }
        this.flush();
      });
    } catch (error) {
      this.pause(error);
    }
  }

  pause(error: unknown): void {
    if (this.stopped) return;
    this.failure = error instanceof Error ? error : new Error("Terminal parser write failed.");
    this.stop();
    try {
      this.onFailure(this.failure);
    } catch {
      /* Contain application callbacks. */
    }
  }

  private stop(): void {
    this.stopped = true;
    this.generation++;
    cancelTerminalOutput(this.run);
    this.clearHold();
    this.clearBackgroundTimer();
    this.watchdog?.dispose();
    this.watchdog = null;
    releaseTerminalOutput(this.bytes);
    this.bytes = 0;
    this.inFlightWrites = 0;
    this.inFlightUnits = 0;
    this.outstanding = 0;
    for (const op of this.queue)
      if ("barrier" in op) op.reject?.(this.failure ?? new Error("Terminal view disposed."));
    this.queue = [];
    this.terminal = null;
  }

  dispose(): void {
    if (!this.stopped) this.stop();
  }
}
