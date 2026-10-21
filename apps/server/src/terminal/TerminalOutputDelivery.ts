import type { TerminalEvent } from "@bigbud/contracts";
import { TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { synchronizedOutputSafeSplit } from "@bigbud/shared/terminalSynchronizedOutput";

/** Orca-derived delivery limits, in UTF-16 units. */
export const TERMINAL_OUTPUT_DELIVERY_LIMITS = {
  /** Unacknowledged output a subscriber may have in flight. */
  creditWindow: TERMINAL_OUTPUT_CREDIT_WINDOW_CHARS,
  /** Largest output item; a synchronized frame is kept whole up to `frameHardLimit`. */
  chunk: 16 * 1024,
  frameHardLimit: 64 * 1024,
  /** Unsent output that holds the PTY (producer flow control), and the level that releases it. */
  holdHighWater: 1024 * 1024,
  holdLowWater: 512 * 1024,
  /** Unsent output that ends the subscription when the producer cannot be paused. */
  overflow: 4 * 1024 * 1024,
} as const;

/** The view ignores activity and identity events; the global subscription carries them. */
const isViewEvent = (event: TerminalEvent) =>
  event.type !== "activity" && event.type !== "agentIdentity";

export interface TerminalOutputDeliveryDiagnostics {
  readonly sentChars: number;
  readonly acknowledgedChars: number;
  readonly pendingChars: number;
  readonly held: boolean;
}

/**
 * One subscriber's ordered, credit-windowed view of a terminal's events. Never drops output:
 * when the subscriber falls behind it holds the producer; if the producer cannot be held and the
 * backlog passes `overflow`, the subscription ends and the client resynchronizes from a snapshot.
 */
export class TerminalOutputDelivery {
  private readonly pending: TerminalEvent[] = [];
  private pendingChars = 0;
  private sentChars = 0;
  private acknowledgedChars = 0;
  private started = false;
  private closed = false;
  private held = false;

  constructor(
    private readonly sink: {
      readonly emit: (event: TerminalEvent) => void;
      /** Hold or release the producer; restarts re-apply an existing hold to the new process. */
      readonly setHeld: (held: boolean) => void;
      readonly overflow: () => void;
    },
    private readonly limits: typeof TERMINAL_OUTPUT_DELIVERY_LIMITS = TERMINAL_OUTPUT_DELIVERY_LIMITS,
  ) {}

  get diagnostics(): TerminalOutputDeliveryDiagnostics {
    return {
      sentChars: this.sentChars,
      acknowledgedChars: this.acknowledgedChars,
      pendingChars: this.pendingChars,
      held: this.held,
    };
  }

  /** Events received before `start` (between registration and the `subscribed` item) wait. */
  start(): void {
    this.started = true;
    this.flush();
  }

  push(event: TerminalEvent): void {
    if (this.closed || !isViewEvent(event)) return;
    if (event.type === "output") {
      if (event.data.length === 0) return;
      this.pendingChars += event.data.length;
    }
    this.pending.push(event);
    if (this.held && (event.type === "started" || event.type === "restarted"))
      this.sink.setHeld(true);
    this.flush();
  }

  /** Cumulative; stale or out-of-range values are clamped, never trusted to grow credit. */
  acknowledge(processedChars: number): void {
    if (this.closed) return;
    this.acknowledgedChars = Math.max(
      this.acknowledgedChars,
      Math.min(processedChars, this.sentChars),
    );
    this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.length = 0;
    this.pendingChars = 0;
    if (this.held) {
      this.held = false;
      this.sink.setHeld(false);
    }
  }

  private flush(): void {
    if (!this.started || this.closed) return;
    while (this.pending.length > 0) {
      const event = this.pending[0]!;
      if (event.type !== "output") {
        this.pending.shift();
        this.sink.emit(event);
        continue;
      }
      const credit = this.limits.creditWindow - (this.sentChars - this.acknowledgedChars);
      if (credit <= 0) break;
      const length = synchronizedOutputSafeSplit(
        event.data,
        Math.min(this.limits.chunk, credit),
        this.limits.frameHardLimit,
      );
      // A tiny remaining credit at a surrogate pair waits for the next acknowledgement.
      if (length <= 0) break;
      if (length >= event.data.length) this.pending.shift();
      else this.pending[0] = { ...event, data: event.data.slice(length) };
      this.pendingChars -= length;
      this.sentChars += length;
      this.sink.emit(
        length >= event.data.length ? event : { ...event, data: event.data.slice(0, length) },
      );
    }
    this.updateHold();
  }

  private updateHold(): void {
    if (this.closed) return;
    if (!this.held && this.pendingChars > this.limits.holdHighWater) {
      this.held = true;
      this.sink.setHeld(true);
    } else if (this.held && this.pendingChars < this.limits.holdLowWater) {
      this.held = false;
      this.sink.setHeld(false);
    }
    if (this.pendingChars > this.limits.overflow) {
      this.close();
      this.sink.overflow();
    }
  }
}
