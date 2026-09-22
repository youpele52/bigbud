/** Serialize preparation and its durable bookkeeping, including explicit setup callers. */
export function makeRemoteAgentPreparationQueue() {
  const active = new Map<string, Promise<void>>();
  return async (key: string, run: () => Promise<void>): Promise<void> => {
    const previous = active.get(key);
    const task = (async () => {
      // A later explicit retry may reconcile a failed attempt; it must wait for its bookkeeping.
      await previous?.catch(() => undefined);
      await run();
    })();
    active.set(key, task);
    try {
      await task;
    } finally {
      if (active.get(key) === task) active.delete(key);
    }
  };
}
