import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";
import { V2ActivationPhysicalOperations } from "./PluginSetup.activation.physical.ts";

/** Short gate observation is separate from physical lifetime. Its expiry cannot release the
 * job's permit/connection while any already-issued operation still needs settlement. */
export class V2ActivationWindow extends V2ActivationPhysicalOperations {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly deadline: number,
    jobSignal: AbortSignal,
    releaseGate: () => void,
  ) {
    super();
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
}
