import { TERMINAL_WRITE_MAX_CODE_UNITS } from "@bigbud/contracts/workspace/terminal.ts";

/** Orca's coalescing bound (`TERMINAL_INPUT_COALESCE_MAX_CODE_UNITS`). */
export const TERMINAL_INPUT_COALESCE_MAX_UNITS = 4096;

/**
 * Ordered terminal input for one view. One write is in flight at a time; everything typed or
 * scrolled meanwhile (key repeat, TUI wheel reports during trackpad momentum) is coalesced into
 * the next write, so a fast gesture reaches the PTY as a few writes instead of one round trip per
 * event that the TUI then replays one by one. Byte order is identical to sending each item.
 */
/** A queue position whose bytes arrive later (a pasted file's staged path). */
interface DeferredInput {
  data: string | null;
  ready: boolean;
}

export class TerminalInputQueue {
  private pending: Array<string | DeferredInput> = [];
  private inFlight = false;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly write: (data: string) => Promise<void>,
    private readonly onFailure: (error: unknown) => void,
    /** The server's write payload limit; larger items are split, never rejected. */
    private readonly maxWriteUnits = TERMINAL_WRITE_MAX_CODE_UNITS,
  ) {}

  get queued(): number {
    return this.pending.length;
  }

  enqueue(data: string): void {
    if (this.disposed || data.length === 0) return;
    this.pending.push(data);
    if (!this.inFlight) this.drain();
  }

  /**
   * Reserve the current position for input that is not known yet. Everything enqueued later
   * (typing during an upload) waits behind it. `null`, a rejection or the timeout releases the
   * position with nothing written; `clear` discards it, and a late resolution is ignored.
   */
  enqueueDeferred(data: Promise<string | null>, timeoutMs: number): void {
    if (this.disposed) return;
    const item: DeferredInput = { data: null, ready: false };
    this.pending.push(item);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (value: string | null) => {
      clearTimeout(timer);
      if (item.ready) return;
      item.ready = true;
      item.data = value;
      if (!this.pending.includes(item) || this.disposed) return;
      if (!this.inFlight) this.drain();
    };
    timer = setTimeout(() => settle(null), timeoutMs);
    data.then(settle, () => settle(null));
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

  /** Settles leading deferred positions; null while the head is still waiting. */
  private takeHead(): string | null {
    while (this.pending.length > 0) {
      const head = this.pending[0]!;
      if (!(typeof head === "string" || head.ready)) return null;
      this.pending.shift();
      const data = typeof head === "string" ? head : head.data;
      if (data) return data;
    }
    return null;
  }

  private take(): string | null {
    const first = this.takeHead();
    if (first === null) return null;
    // A paste larger than one write is sent in order, one surrogate-safe piece at a time.
    // At least two units, so a leading surrogate pair always fits and every piece makes progress.
    const maxWriteUnits = Math.max(2, this.maxWriteUnits);
    if (first.length > maxWriteUnits) {
      let end = maxWriteUnits;
      const last = first.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
      this.pending.unshift(first.slice(end));
      return first.slice(0, end);
    }
    const coalesceLimit = Math.min(TERMINAL_INPUT_COALESCE_MAX_UNITS, maxWriteUnits);
    // A single oversized item (a paste) is written as-is; coalescing only joins small items.
    if (first.length >= coalesceLimit) return first;
    const parts = [first];
    let length = first.length;
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      // A deferred position is an ordering barrier; it is never coalesced past.
      if (typeof next !== "string" || length + next.length > coalesceLimit) break;
      parts.push(next);
      length += next.length;
      this.pending.shift();
    }
    return parts.length === 1 ? first : parts.join("");
  }
}
