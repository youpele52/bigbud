import type { NativeApi } from "@bigbud/contracts";
import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalStreamDiagnostics } from "./TerminalDiagnostics";

/** Acknowledge once this much parsed output is unacknowledged, else after `ACK_DELAY_MS`. */
export const TERMINAL_OUTPUT_ACK_THRESHOLD_CHARS = 32 * 1024;
export const TERMINAL_OUTPUT_ACK_DELAY_MS = 50;
/** Open proceeds without the stream after this long; a later resubscription resynchronizes. */
export const TERMINAL_SESSION_READY_TIMEOUT_MS = 5000;

type TerminalStreamApi = Pick<NativeApi["terminal"], "subscribeSession" | "ackOutput">;

export interface TerminalSessionStreamHandlers {
  readonly deliver: (event: TerminalEvent) => void;
  /** Credited output still queued or being parsed by the view(s) fed by this stream. */
  readonly outstanding: () => number;
  /** Events may have been missed (reconnect or server overflow); views must replay a snapshot. */
  readonly resync: () => void;
}

/**
 * One terminal-scoped server stream. Acknowledges `received - outstanding`: output that reached
 * a view lane counts only once parsed, and output a view dropped counts immediately, so the
 * server's credit window can never leak.
 */
export class TerminalSessionStream {
  readonly ready: Promise<void>;
  private resolveReady: () => void = () => undefined;
  private subscriptionId: string | null = null;
  private received = 0;
  private acknowledged = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly api: TerminalStreamApi,
    input: { readonly threadId: string; readonly terminalId: string },
    private readonly handlers: TerminalSessionStreamHandlers,
  ) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    if (!api.subscribeSession) {
      this.unsubscribe = () => undefined;
      this.markReady();
      return;
    }
    this.readyTimer = setTimeout(() => this.markReady(), TERMINAL_SESSION_READY_TIMEOUT_MS);
    this.unsubscribe = api.subscribeSession(input, (item) => this.receive(item), {
      onError: () => this.markReady(),
    });
  }

  get diagnostics(): TerminalStreamDiagnostics {
    return {
      scoped: this.api.subscribeSession !== undefined,
      subscriptionId: this.subscriptionId,
      receivedChars: this.received,
      acknowledgedChars: this.acknowledged,
    };
  }

  /** Views call this when parsed output released credit. */
  readonly parsed = (): void => this.scheduleAck();

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAckTimer();
    this.markReady();
    this.unsubscribe();
  }

  private receive(item: TerminalSessionStreamItem): void {
    if (this.closed) return;
    if (item.type === "subscribed") {
      const resubscribed = this.subscriptionId !== null;
      this.subscriptionId = item.subscriptionId;
      this.received = 0;
      this.acknowledged = 0;
      this.clearAckTimer();
      this.markReady();
      if (resubscribed) this.handlers.resync();
      return;
    }
    if (item.type === "output") this.received += item.data.length;
    this.handlers.deliver(item);
    if (item.type === "output") this.scheduleAck();
  }

  private scheduleAck(): void {
    if (this.closed || this.subscriptionId === null) return;
    const processed = this.processed();
    if (processed - this.acknowledged >= TERMINAL_OUTPUT_ACK_THRESHOLD_CHARS) {
      this.sendAck();
      return;
    }
    if (processed > this.acknowledged && this.ackTimer === null)
      this.ackTimer = setTimeout(() => {
        this.ackTimer = null;
        this.sendAck();
      }, TERMINAL_OUTPUT_ACK_DELAY_MS);
  }

  private processed(): number {
    return Math.max(0, this.received - this.handlers.outstanding());
  }

  private sendAck(): void {
    this.clearAckTimer();
    const subscriptionId = this.subscriptionId;
    if (this.closed || subscriptionId === null || !this.api.ackOutput) return;
    const processed = this.processed();
    if (processed <= this.acknowledged) return;
    const previous = this.acknowledged;
    this.acknowledged = processed;
    // Cumulative: a failed acknowledgement rolls back and retries, so the window cannot strand.
    void this.api.ackOutput({ subscriptionId, processedChars: processed }).catch(() => {
      if (this.closed || this.subscriptionId !== subscriptionId) return;
      this.acknowledged = Math.min(this.acknowledged, previous);
      this.scheduleAck();
    });
  }

  private clearAckTimer(): void {
    if (this.ackTimer !== null) clearTimeout(this.ackTimer);
    this.ackTimer = null;
  }

  private markReady(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.resolveReady();
  }
}
