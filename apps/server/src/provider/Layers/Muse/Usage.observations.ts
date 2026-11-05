/**
 * Latest Muse subscription-usage observation pushed by session hosts.
 *
 * MSP `usage/read` only returns what a host has observed in Meta's responses,
 * so a short-lived discovery host is usually empty. Session hosts receive the
 * same payload as `usage/changed` during turns; the adapter records it here and
 * the usage-limits reader consults it before falling back to the CLI. Only the
 * newest observation (by the host's `observedAtMs`) is kept; nothing persists.
 */
export class MuseUsageObservations {
  #latest: { readonly observedAtMs: number; readonly payload: unknown } | undefined;

  /** Record a `usage/changed` payload; older or unstamped observations are ignored. */
  record(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const observedAtMs = (payload as { observedAtMs?: unknown }).observedAtMs;
    if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs)) return;
    if (this.#latest && this.#latest.observedAtMs >= observedAtMs) return;
    this.#latest = { observedAtMs, payload };
  }

  /** The newest observation no older than `maxAgeMs`, or undefined. */
  latest(nowMs: number, maxAgeMs: number): unknown {
    if (!this.#latest || nowMs - this.#latest.observedAtMs > maxAgeMs) return undefined;
    return this.#latest.payload;
  }
}

/** Process-wide store shared by the Muse adapter and provider (one Muse home per server). */
export const museUsageObservations = new MuseUsageObservations();
