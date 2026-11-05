/**
 * Serial queue for Cua driver work with an emergency halt. `halt()` makes every call queued
 * before it reject when its turn comes (it never reaches the driver) and settles the awaits of
 * the call in flight right away, so the queue drains even when the killed proxy never answers.
 * Work enqueued after the halt runs normally. `survivesHalt` work (the Stop's own daemon reset)
 * still runs when a later halt arrives before its turn.
 */
export interface CuaDriverCallQueue {
  readonly enqueue: <T>(
    work: (isCurrent: () => boolean) => Promise<T>,
    options?: { readonly survivesHalt?: boolean },
  ) => Promise<T>;
  /** Settles early with the halt error when `halt()` runs before `promise` settles. */
  readonly abortable: <T>(promise: Promise<T>) => Promise<T>;
  readonly halt: (error: Error) => void;
}

export function makeCuaDriverCallQueue(): CuaDriverCallQueue {
  let queue: Promise<void> = Promise.resolve();
  let generation = 0;
  let haltError: Error | null = null;
  const pendingAborts = new Set<(error: Error) => void>();

  return {
    enqueue: (work, options) => {
      const enqueuedAt = generation;
      const isCurrent = () => options?.survivesHalt === true || generation === enqueuedAt;
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      return previous
        .catch(() => undefined)
        .then(() => {
          if (!isCurrent()) throw haltError ?? new Error("Cua driver work was halted.");
          return work(isCurrent);
        })
        .finally(() => release());
    },
    abortable: (promise) =>
      new Promise((resolve, reject) => {
        pendingAborts.add(reject);
        promise.then(resolve, reject).finally(() => pendingAborts.delete(reject));
      }),
    halt: (error) => {
      generation += 1;
      haltError = error;
      const aborts = [...pendingAborts];
      pendingAborts.clear();
      for (const abort of aborts) abort(error);
    },
  };
}
