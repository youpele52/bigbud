import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";

/** Short gate observation is separate from physical lifetime. Its expiry cannot release the
 * job's permit/connection while any already-issued operation still needs settlement. */
export class V2ActivationWindow {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly deadline: number,
    jobSignal: AbortSignal,
    releaseGate: () => void,
  ) {
    this.signal = AbortSignal.any([jobSignal, this.controller.signal]);
    this.timer = setTimeout(
      () => {
        this.controller.abort();
        releaseGate();
      },
      Math.max(0, deadline - Date.now()),
    );
    this.timer.unref();
  }
  assertCurrent = () => {
    this.signal.throwIfAborted();
    if (Date.now() >= this.deadline) throw new Error("V2 short activation gate deadline expired.");
  };
  observe = (operation: Promise<unknown>) => {
    if (this.pending.has(operation)) return;
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
  };
  async run<T>(run: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    const context = currentV2RequestContext();
    const operation = context
      ? runV2RequestContext(
          {
            ...context,
            operationSignal: this.signal,
            operationGuard: this.assertCurrent,
            observeOperation: this.observe,
          },
          run,
        )
      : run();
    this.observe(operation);
    return runWithAbortableDeadline({
      operation: "V2 short activation closure",
      timeoutMs: Math.max(1, this.deadline - Date.now()),
      signal: this.signal,
      run: () => operation,
    });
  }
  release() {
    clearTimeout(this.timer);
  }
  hasPending() {
    return this.pending.size > 0;
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled(this.pending);
  }
}
