/** Observation deadlines do not release ownership of already-issued native or filesystem work. */
export class V2ActivationPhysicalOperations {
  private readonly pending = new Set<Promise<unknown>>();
  observe = (operation: Promise<unknown>) => {
    if (this.pending.has(operation)) return;
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
  };
  hasPending() {
    return this.pending.size > 0;
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled(this.pending);
  }
}
