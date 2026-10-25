import { cappedExponentialRetryDelay } from "./wsTransport.retry";
import { getWsReconnectBackoffCeilingMs } from "./wsReconnectPolicy";

export const WS_PROTOCOL_FAILURE_WINDOW_MS = 30_000;
/** Failures inside the window at or past this count back off on the full reconnect ladder. */
export const WS_PROTOCOL_FAILURE_ESCALATION = 3;

/**
 * Sliding window over protocol-level failures (RPC defects and write failures). Repeated
 * failures back off harder, but recovery never stops.
 */
export class WsProtocolFailureWindow {
  private failures: number[] = [];

  constructor(
    private readonly windowMs = WS_PROTOCOL_FAILURE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records one failure and returns how many fall inside the window, including this one. */
  record(): number {
    const at = this.now();
    this.failures = this.failures.filter((failedAt) => at - failedAt < this.windowMs);
    this.failures.push(at);
    return this.failures.length;
  }

  reset(): void {
    this.failures = [];
  }
}

export function resolveWsProtocolRecoveryDelayMs(
  failuresInWindow: number,
  random: () => number = Math.random,
): number {
  if (failuresInWindow < WS_PROTOCOL_FAILURE_ESCALATION) {
    return cappedExponentialRetryDelay({ attempt: failuresInWindow, baseMs: 250, maxMs: 8_000 });
  }
  // Escalated: the reconnect ladder's ceiling with half jitter, so it never collapses to zero.
  const ceiling = getWsReconnectBackoffCeilingMs(failuresInWindow - 1);
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(ceiling / 2 + (ceiling / 2) * sample);
}
