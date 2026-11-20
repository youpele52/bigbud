/**
 * Keyed drainable workers with idle eviction (F-B2).
 *
 * Orchestration reactors run one `DrainableWorker` per thread or aggregate so a slow item on one
 * key never blocks another key. Those workers used to live forever: every thread ever touched
 * kept a fiber and a queue. Here a worker is created on demand and closed once it has been idle
 * (nothing queued, nothing running) for {@link KEYED_WORKER_IDLE_TTL_MS}; the next item for that
 * key creates a fresh worker. A sweep runs every {@link KEYED_WORKER_SWEEP_INTERVAL}.
 *
 * Correctness under eviction:
 * - Only a worker with zero pending items is evicted, and the pending count is raised in the same
 *   synchronous step that looks the worker up, so an item can never be enqueued on a worker that
 *   is being closed. Per-key ordering holds: the old worker had finished everything before the
 *   new one receives anything.
 * - `drain` waits for every live worker; an evicted worker had nothing left to drain.
 *
 * @module keyedDrainableWorkers
 */
import { makeDrainableWorker, type DrainableWorker } from "@bigbud/shared/DrainableWorker";
import { Clock, Effect, Exit, Schedule, Scope, Semaphore } from "effect";

/** A worker idle for this long is closed; its key gets a fresh worker on the next item. */
export const KEYED_WORKER_IDLE_TTL_MS = 5 * 60_000;
/** How often idle workers are looked for. */
export const KEYED_WORKER_SWEEP_INTERVAL = "1 minute";

interface WorkerEntry<A> {
  readonly worker: DrainableWorker<A>;
  readonly scope: Scope.Closeable;
  pending: number;
  idleSinceMs: number;
}

export interface KeyedDrainableWorkers<A> {
  /** Enqueue `item` on the worker for `key`, creating the worker when needed. */
  readonly enqueue: (key: string, item: A) => Effect.Effect<void>;
  /** A handle whose `enqueue`/`drain` always route through the pool for `key`. */
  readonly forKey: (key: string) => DrainableWorker<A>;
  /** Waits until every live worker is idle. */
  readonly drain: Effect.Effect<void>;
  /** Closes every worker idle for at least the TTL; returns how many were closed. */
  readonly evictIdle: Effect.Effect<number>;
  /** Live worker count (for tests and diagnostics). */
  readonly size: () => number;
}

export const makeKeyedDrainableWorkers = Effect.fn("makeKeyedDrainableWorkers")(function* <A, E>(
  // `Scope` is the pool's own scope (as before), never a worker's: work forked by an item must
  // outlive the worker that ran it, since that worker can be evicted when idle.
  process: (item: A) => Effect.Effect<void, E, Scope.Scope>,
  options: { readonly idleTtlMs?: number; readonly sweep?: boolean } = {},
) {
  const idleTtlMs = options.idleTtlMs ?? KEYED_WORKER_IDLE_TTL_MS;
  const outerScope = yield* Effect.scope;
  const creation = yield* Semaphore.make(1);
  const entries = new Map<string, WorkerEntry<A>>();

  const settle = (entry: WorkerEntry<A>) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sync(() => {
        entry.pending -= 1;
        if (entry.pending === 0) entry.idleSinceMs = now;
      }),
    );

  const create = Effect.fn("KeyedDrainableWorkers.create")(function* (key: string) {
    const scope = yield* Scope.fork(outerScope, "sequential");
    // Created already reserved for the item that asked for it.
    const entry = { scope, pending: 1, idleSinceMs: 0 } as WorkerEntry<A> & {
      worker: DrainableWorker<A>;
    };
    entry.worker = yield* makeDrainableWorker((item: A) =>
      Effect.ensuring(Effect.provideService(process(item), Scope.Scope, outerScope), settle(entry)),
    ).pipe(Scope.provide(scope));
    entries.set(key, entry);
    return entry as WorkerEntry<A>;
  });

  /** Looks up (or creates) the worker and reserves it in one step, so eviction cannot race. */
  const reserve = (key: string) =>
    creation.withPermits(1)(
      Effect.suspend(() => {
        const existing = entries.get(key);
        if (existing) {
          existing.pending += 1;
          return Effect.succeed(existing);
        }
        return create(key);
      }),
    );

  const enqueue = (key: string, item: A) =>
    Effect.flatMap(reserve(key), (entry) => entry.worker.enqueue(item));

  const drain = Effect.suspend(() =>
    Effect.forEach(Array.from(entries.values()), (entry) => entry.worker.drain, {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  const evictIdle = Effect.flatMap(Clock.currentTimeMillis, (now) =>
    Effect.suspend(() => {
      const idle: Array<WorkerEntry<A>> = [];
      for (const [key, entry] of entries) {
        if (entry.pending === 0 && now - entry.idleSinceMs >= idleTtlMs) {
          entries.delete(key);
          idle.push(entry);
        }
      }
      return Effect.forEach(idle, (entry) => Scope.close(entry.scope, Exit.void), {
        discard: true,
      }).pipe(Effect.as(idle.length));
    }),
  );

  if (options.sweep !== false) {
    yield* evictIdle.pipe(
      Effect.repeat(Schedule.spaced(KEYED_WORKER_SWEEP_INTERVAL)),
      Effect.forkIn(outerScope),
    );
  }

  return {
    enqueue,
    forKey: (key) => ({
      enqueue: (item) => enqueue(key, item),
      drain: Effect.suspend(() => entries.get(key)?.worker.drain ?? Effect.void),
    }),
    drain,
    evictIdle,
    size: () => entries.size,
  } satisfies KeyedDrainableWorkers<A>;
});
