/** Orca's coalescing bound (`TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS`). */
export const TERMINAL_INPUT_COALESCE_MAX_UNITS = 4096;

/**
 * Ordered terminal input for one view. One write is in flight at a time; everything typed or
 * scrolled meanwhile (key repeat, TUI wheel reports during trackpad momentum) is coalesced into
 * the next write, so a fast gesture reaches the PTY as a few writes instead of one round trip per
 * event that the TUI then replays one by one. Byte order is identical to sending each item.
 */
export class TerminalInputQueue {
  private pending: string[] = [];
  private inFlight = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly write: (data: string) => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
  ) {}

  get queued(): number {
    return this.pending.length;
  }

  enqueue(data: string): void {
    if (this.disposed || data.length === 0) return;
    this.pending.push(data);
    if (!this.inFlight) this.drain();
  }

  /** Drop queued input (the delivery lane was replaced or the view failed). */
  clear(): void {
    this.generation++;
    this.pending = [];
    this.inFlight = false;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private drain(): void {
    const payload = this.take();
    if (payload === null) return;
    const generation = this.generation;
    this.inFlight = true;
    let settled: Promise<void>;
    try {
      settled = this.write(payload);
    } catch (error) {
      settled = Promise.reject(error);
    }
    settled.then(
      () => {
        if (generation !== this.generation || this.disposed) return;
        this.inFlight = false;
        this.drain();
      },
      (error: unknown) => {
        if (generation !== this.generation || this.disposed) return;
        // Later input assumed the failed bytes reached the PTY; sending it out of context is worse.
        this.clear();
        this.onFailure(error);
      },
    );
  }

  private take(): string | null {
    const first = this.pending.shift();
    if (first === undefined) return null;
    // A single oversized item (a paste) is written as-is; coalescing only joins small items.
    if (first.length >= TERMINAL_INPUT_COALESCE_MAX_UNITS) return first;
    const parts = [first];
    let length = first.length;
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      if (length + next.length > TERMINAL_INPUT_COALESCE_MAX_UNITS) break;
      parts.push(next);
      length += next.length;
      this.pending.shift();
    }
    return parts.length === 1 ? first : parts.join("");
  }
}
