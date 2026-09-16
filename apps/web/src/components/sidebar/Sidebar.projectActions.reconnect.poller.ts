// One status request per operation, with bounded backoff during backend outages.
export function createReconnectPoller<Request extends { requestId: string }>(
  check: (request: Request) => Promise<boolean>,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const failures = new Map<string, number>();
  let generation = 0;
  let enabled = true;

  const reconcile = async (request: Request): Promise<void> => {
    const id = request.requestId;
    if (!enabled || running.has(id)) return;
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    running.add(id);
    const currentGeneration = generation;
    let retry = false;
    let delay = 1_000;
    try {
      retry = await check(request);
      failures.delete(id);
    } catch {
      retry = true;
      const count = Math.min((failures.get(id) ?? 0) + 1, 5);
      failures.set(id, count);
      delay = Math.min(1_000 * 2 ** count, 30_000);
    } finally {
      if (currentGeneration === generation) running.delete(id);
    }
    if (enabled && currentGeneration === generation && retry) {
      timers.set(
        id,
        setTimeout(() => void reconcile(request), delay),
      );
    }
  };

  return {
    reconcile,
    resume() {
      enabled = true;
    },
    stop() {
      enabled = false;
      generation += 1;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      running.clear();
      failures.clear();
    },
  };
}
