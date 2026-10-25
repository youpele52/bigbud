/** One retained ping per connection per this interval keeps latency visible in the trace. */
export const PING_TRACE_SAMPLE_INTERVAL_MS = 60_000;
/** Upper bound on tracked connections; the server never learns when a socket goes away. */
export const PING_TRACE_SAMPLER_MAX_CONNECTIONS = 256;

/**
 * Decides which successful pings are kept in production traces: the first
 * ping from each connection, then one per interval. Failed pings are kept
 * regardless by the trace policy's error rule. Memory is bounded by evicting
 * the connection sampled longest ago once the cap is reached.
 */
export class PingTraceSampler {
  private readonly lastSampledAt = new Map<number | string, number>();

  constructor(
    private readonly intervalMs = PING_TRACE_SAMPLE_INTERVAL_MS,
    private readonly maxConnections = PING_TRACE_SAMPLER_MAX_CONNECTIONS,
  ) {}

  shouldRetain(connection: number | string, nowMs: number): boolean {
    const previous = this.lastSampledAt.get(connection);
    if (previous !== undefined && nowMs - previous < this.intervalMs) return false;
    // Re-insert so iteration order stays oldest-sampled first.
    this.lastSampledAt.delete(connection);
    this.lastSampledAt.set(connection, nowMs);
    while (this.lastSampledAt.size > this.maxConnections) {
      const oldest = this.lastSampledAt.keys().next();
      if (oldest.done) break;
      this.lastSampledAt.delete(oldest.value);
    }
    return true;
  }

  get trackedConnections(): number {
    return this.lastSampledAt.size;
  }
}
