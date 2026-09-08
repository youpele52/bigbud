import { Effect, Layer, Semaphore, ServiceMap, SynchronizedRef } from "effect";

type LockEntry = {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
};

export type BootstrapCommandLock = <A, E, R>(
  parentCommandId: string,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export class BootstrapCommandLockService extends ServiceMap.Service<
  BootstrapCommandLockService,
  BootstrapCommandLock
>()("bigbud/BootstrapCommandLock") {}

export const makeBootstrapCommandLock = Effect.fn("makeBootstrapCommandLock")(function* () {
  const locks = yield* SynchronizedRef.make(new Map<string, LockEntry>());

  const acquire = (parentCommandId: string) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(parentCommandId);
      if (existing) {
        const next = new Map(current);
        next.set(parentCommandId, { ...existing, users: existing.users + 1 });
        return Effect.succeed([existing.semaphore, next] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(parentCommandId, { semaphore, users: 1 });
          return [semaphore, next] as const;
        }),
      );
    });

  const release = (parentCommandId: string) =>
    SynchronizedRef.update(locks, (current) => {
      const existing = current.get(parentCommandId);
      if (!existing) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(parentCommandId);
      } else {
        next.set(parentCommandId, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  return (<A, E, R>(parentCommandId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      acquire(parentCommandId),
      (semaphore) => semaphore.withPermit(effect),
      () => release(parentCommandId),
    )) satisfies BootstrapCommandLock;
});

export const BootstrapCommandLockLive = Layer.effect(
  BootstrapCommandLockService,
  makeBootstrapCommandLock(),
);
