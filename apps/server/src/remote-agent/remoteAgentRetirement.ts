export class RemoteAgentRetirementError extends Error {
  readonly _tag = "RemoteAgentRetirementError";
}

type Waiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** Process-local half of the cross-controller retirement fence. */
export class RemoteAgentRetirementFence {
  private readonly blocked = new Set<string>();
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Set<Waiter>>();

  isRetiring(generation: string): boolean {
    return this.blocked.has(generation);
  }

  acquire(generation: string): () => void {
    if (this.blocked.has(generation))
      throw new RemoteAgentRetirementError("Remote runtime retirement is fenced.");
    this.active.set(generation, (this.active.get(generation) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.active.get(generation) ?? 1) - 1;
      if (remaining > 0) this.active.set(generation, remaining);
      else {
        this.active.delete(generation);
        for (const waiter of this.waiters.get(generation) ?? []) {
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
        this.waiters.delete(generation);
      }
    };
  }

  async begin(
    generation: string,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<() => void> {
    if (this.blocked.has(generation))
      throw new RemoteAgentRetirementError("Remote runtime retirement is already fenced.");
    this.blocked.add(generation);
    if ((this.active.get(generation) ?? 0) === 0) return () => this.end(generation);
    const timeoutMs = options.timeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.waiters.get(generation) ?? new Set<Waiter>();
      let waiter!: Waiter;
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        this.blocked.delete(generation);
        reject(new RemoteAgentRetirementError("Remote runtime acquisition did not drain."));
      }, timeoutMs);
      waiter = { resolve, reject, timer };
      waiters.add(waiter);
      this.waiters.set(generation, waiters);
    });
    return () => this.end(generation);
  }

  cancel(generation: string): void {
    this.blocked.delete(generation);
    for (const waiter of this.waiters.get(generation) ?? []) {
      clearTimeout(waiter.timer);
      waiter.reject(new RemoteAgentRetirementError("Retirement was cancelled."));
    }
    this.waiters.delete(generation);
  }

  private end(generation: string): void {
    this.blocked.delete(generation);
  }
}
