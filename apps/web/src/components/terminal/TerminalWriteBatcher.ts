import { type Terminal } from "@xterm/xterm";
import { cancelTerminalOutput, scheduleTerminalOutput } from "./TerminalOutputScheduler";
import { reserveTerminalOutput, releaseTerminalOutput } from "./TerminalOutputBudget";

export const TERMINAL_WRITE_LIMITS = { bytes: 1024 * 1024, items: 4096, writeUnits: 8192 };

type Operation =
  | { data: string; bytes: number }
  | { barrier: () => void; reject?: (error: Error) => void };

/** Ordered legacy view lane. Failure detaches the view, never acknowledges discarded data. */
export class TerminalWriteBatcher {
  private queue: Operation[] = [];
  private terminal: Terminal | null = null;
  private writing = false;
  private stopped = false;
  private failure: Error | undefined;
  private bytes = 0;
  private generation = 0;
  private readonly run = () => this.drain();

  constructor(private readonly onFailure: (error: Error) => void = () => undefined) {}

  get queuedBytes(): number {
    return this.bytes;
  }
  get isStopped(): boolean {
    return this.stopped;
  }

  write(terminal: Terminal, data: string): void {
    if (this.stopped || !data) return;
    if (this.terminal && this.terminal !== terminal) {
      this.pause(new Error("Terminal view identity changed during output delivery."));
      return;
    }
    this.terminal = terminal;
    // Bound both UTF-8 payload and retained UTF-16 storage, including in-flight work.
    const bytes = data.length * 3;
    const count = Math.ceil(data.length / (TERMINAL_WRITE_LIMITS.writeUnits - 1));
    if (
      bytes + this.bytes > TERMINAL_WRITE_LIMITS.bytes ||
      this.queue.length + count + Number(this.writing) > TERMINAL_WRITE_LIMITS.items
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
    let added = 0;
    for (let start = 0; start < data.length; ) {
      let end = Math.min(start + TERMINAL_WRITE_LIMITS.writeUnits, data.length);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      const chunk = data.slice(start, end);
      const cost = chunk.length * 3;
      this.queue.push({ data: chunk, bytes: cost });
      added += cost;
      start = end;
    }
    this.bytes += added;
    this.flush();
  }

  /** Flush requests progress; it never bypasses an outstanding parser callback. */
  flush(): void {
    if (!this.stopped && !this.writing) scheduleTerminalOutput(this.run);
  }

  barrier(action: () => void): void {
    if (this.stopped) return;
    if (this.queue.length + Number(this.writing) >= TERMINAL_WRITE_LIMITS.items) {
      this.pause(new Error("Terminal operation budget exceeded. Delivery is paused."));
      return;
    }
    this.queue.push({ barrier: action });
    this.flush();
  }

  whenIdle(): Promise<void> {
    if (this.stopped) return Promise.reject(this.failure ?? new Error("Terminal view disposed."));
    return new Promise((resolve, reject) => {
      if (this.queue.length + Number(this.writing) >= TERMINAL_WRITE_LIMITS.items) {
        this.pause(new Error("Terminal operation budget exceeded. Delivery is paused."));
        reject(this.failure);
        return;
      }
      this.queue.push({ barrier: resolve, reject });
      this.flush();
    });
  }

  private drain(): void {
    if (this.stopped || this.writing) return;
    let operation = this.queue.shift();
    // Fences do not require a separate timer each. Keep the one-write-per-turn
    // fairness rule, but retire adjacent fences before dispatching that write.
    while (operation && "barrier" in operation) {
      try {
        operation.barrier();
      } catch (error) {
        this.pause(error);
      }
      if (this.stopped) return;
      operation = this.queue.shift();
    }
    if (!operation) return;
    const terminal = this.terminal;
    if (!terminal) return;
    // Coalesce only adjacent output, never across a reset/install/exit barrier.
    // The concatenated write stays below 32 KiB encoded and bounded JS storage.
    while (
      this.queue[0] &&
      "data" in this.queue[0] &&
      operation.data.length + this.queue[0].data.length <= TERMINAL_WRITE_LIMITS.writeUnits
    ) {
      const next = this.queue.shift() as Extract<Operation, { data: string }>;
      operation.data += next.data;
      operation.bytes += next.bytes;
    }
    this.writing = true;
    const generation = this.generation;
    let completed = false;
    try {
      terminal.write(operation.data, () => {
        if (completed || this.stopped || generation !== this.generation) return;
        completed = true;
        this.writing = false;
        this.bytes -= operation.bytes;
        releaseTerminalOutput(operation.bytes);
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
    releaseTerminalOutput(this.bytes);
    this.bytes = 0;
    this.writing = false;
    for (const op of this.queue)
      if ("barrier" in op) op.reject?.(this.failure ?? new Error("Terminal view disposed."));
    this.queue = [];
    this.terminal = null;
  }

  dispose(): void {
    if (!this.stopped) this.stop();
  }
}
