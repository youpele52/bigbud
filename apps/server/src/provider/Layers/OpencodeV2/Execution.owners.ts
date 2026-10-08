/** Exact session-owned executions: cancellation is synchronous and joins physical operation settlement outside queues. */
export class V2ActiveExecutions {
  private readonly active = new Map<
    AbortController,
    { operation: Promise<unknown>; dispatched: boolean }
  >();
  run<T>(controller: AbortController, run: () => Promise<T>): Promise<T> {
    if (this.active.size >= 32)
      return Promise.reject(new Error("V2 active execution owner capacity rejected."));
    const operation = Promise.resolve().then(run);
    this.active.set(controller, { operation, dispatched: false });
    return operation.finally(() => {
      this.active.delete(controller);
    });
  }
  dispatch<T>(controller: AbortController, run: () => Promise<T>): Promise<T> {
    controller.signal.throwIfAborted();
    const owned = this.active.get(controller);
    if (!owned) throw new Error("V2 active execution owner missing.");
    owned.dispatched = true;
    return run();
  }
  async cancel(): Promise<void> {
    const operations = [...this.active];
    for (const [controller] of operations) controller.abort();
    // A blocked approval publication has no physical process to join. Its aborted guard still forbids dispatch.
    await Promise.allSettled(
      operations.filter(([, owned]) => owned.dispatched).map(([, owned]) => owned.operation),
    );
  }
}
