const v2NoAbort = (): void => {};

/** Physical SDK promises outlive a timed RPC observer; joining never manufactures idle by cancellation. */
export class V2EnrollmentControls {
  private readonly physical = new Set<Promise<unknown>>();
  assertCapacity() {
    if (this.physical.size >= 32)
      throw new Error("V2 physical enrollment-control capacity reached; evidence retained.");
  }
  observe(operation: Promise<unknown>) {
    this.physical.add(operation);
    void operation.then(
      () => {
        this.physical.delete(operation);
      },
      () => {
        this.physical.delete(operation);
      },
    );
  }
  count() {
    return this.physical.size;
  }
  async join(signal: AbortSignal, logical?: Promise<unknown>) {
    signal.throwIfAborted();
    const pending = Promise.allSettled([...this.physical, ...(logical ? [logical] : [])]);
    let abort: () => void = v2NoAbort;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () =>
        reject(new Error("V2 control join deadline reached; physical control remains owned."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      await Promise.race([pending, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
