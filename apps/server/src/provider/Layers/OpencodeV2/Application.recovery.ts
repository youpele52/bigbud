import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

/** Rotate bounded batches; keep physical flights and failure backoff local to each owner. */
export class V2OwnerRecovery<T extends object> {
  private last: T | undefined;
  private readonly pending = new WeakSet<T>();
  private readonly retries = new WeakMap<T, { failures: number; at: number; error: unknown }>();

  async run(
    owners: readonly T[],
    signal: AbortSignal,
    validate: () => void,
    needsRecovery: (owner: T) => boolean,
    reconnect: (owner: T, signal: AbortSignal) => Promise<void>,
    failed: (owner: T, error: unknown) => void,
  ) {
    const start = this.last ? owners.indexOf(this.last) + 1 : 0;
    let attempted = 0;
    for (let offset = 0; offset < owners.length; offset++) {
      validate();
      const owner = owners[(start + offset) % owners.length]!;
      if (!needsRecovery(owner)) {
        this.retries.delete(owner);
        continue;
      }
      const retry = this.retries.get(owner);
      if (this.pending.has(owner) || (retry && Date.now() < retry.at)) continue;
      if (attempted === 3) break;
      attempted++;
      // Advance before awaiting: even an outer deadline cannot restart at the same slow owner.
      this.last = owner;
      try {
        await runWithAbortableDeadline({
          operation: "V2 retained owner recovery",
          timeoutMs: 5000,
          signal,
          run: async (abort) => {
            this.pending.add(owner);
            try {
              await reconnect(owner, abort);
            } finally {
              this.pending.delete(owner);
            }
          },
        });
        validate();
        this.retries.delete(owner);
      } catch (error) {
        validate();
        const failures = (retry?.failures ?? 0) + 1;
        this.retries.set(owner, {
          failures,
          at: Date.now() + Math.min(15000, 1000 * 2 ** Math.min(failures - 1, 4)),
          error,
        });
        failed(owner, error);
      }
    }
    const errors = owners.filter(needsRecovery).flatMap((owner) => {
      const retry = this.retries.get(owner);
      return retry ? [retry.error] : [];
    });
    // Retained-owner failures are diagnostics, not transport failures: healthy owners must
    // remain callable. Authority/discovery failures still escape through validate().
    return errors;
  }
}
