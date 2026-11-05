import { runWithAbortableDeadline } from "../../RequestDeadline.ts";

/** One bounded discovery/recovery flight; invalidation fences late work before publication. */
export class V2GenerationCoordinator {
  private revision = 0;
  private closed = false;
  private flight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private retryAt = 0;
  private failures = 0;

  invalidate() {
    this.revision++;
    this.controller?.abort();
    this.retryAt = 0;
  }

  close() {
    this.closed = true;
    this.invalidate();
  }

  run(
    recover: (signal: AbortSignal, validate: () => void) => Promise<void>,
    assertAuthority: () => void,
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("V2 generation coordinator closed."));
    if (this.flight) return this.flight;
    if (Date.now() < this.retryAt)
      return Promise.reject(new Error("V2 generation reconnect backoff; no automatic resend."));
    const revision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const validate = () => {
      controller.signal.throwIfAborted();
      assertAuthority();
      if (this.closed || this.revision !== revision)
        throw new Error("V2 stale generation candidate rejected.");
    };
    const flight = runWithAbortableDeadline({
      operation: "V2 generation discovery and recovery",
      timeoutMs: 20000,
      signal: controller.signal,
      run: async (signal) => {
        const current = () => {
          signal.throwIfAborted();
          validate();
        };
        current();
        await recover(signal, current);
        current();
      },
    })
      .then(() => {
        validate();
        this.failures = 0;
      })
      .catch((error) => {
        if (this.revision === revision && !this.closed)
          this.retryAt = Date.now() + Math.min(15000, 1000 * 2 ** Math.min(this.failures++, 4));
        throw error;
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
      });
    this.flight = flight;
    return flight;
  }
}
