import { Duration, Effect, Queue, Ref } from "effect";

/**
 * `rescan` walks the discovery roots and reads every file again. `assemble` rebuilds the
 * catalog from the last scan, for changes that cannot alter files (provider status).
 */
export type DiscoverySyncKind = "assemble" | "rescan";

/** Minimum pause between two catalog syncs, so bursts of triggers collapse into one. */
export const DISCOVERY_SYNC_MIN_GAP = Duration.seconds(1);

const mergeKinds = (
  current: DiscoverySyncKind | null,
  next: DiscoverySyncKind,
): DiscoverySyncKind => (current === "rescan" || next === "rescan" ? "rescan" : "assemble");

/**
 * Serializes catalog syncs on one fiber. Requests made while a sync runs are merged into a
 * single follow-up sync of the strongest requested kind, so any number of watcher, settings
 * and provider triggers costs at most one running and one pending sync.
 */
export const makeCoalescedDiscoverySync = Effect.fn("DiscoveryRegistry.makeCoalescedSync")(
  function* (
    run: (kind: DiscoverySyncKind) => Effect.Effect<void>,
    minGap: Duration.Input = DISCOVERY_SYNC_MIN_GAP,
  ) {
    const pending = yield* Ref.make<DiscoverySyncKind | null>(null);
    const wake = yield* Queue.sliding<void>(1);
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(wake);
        const kind = yield* Ref.getAndSet(pending, null);
        if (kind !== null) {
          yield* run(kind).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("DiscoveryRegistry: catalog sync failed", { cause }),
            ),
          );
        }
        yield* Effect.sleep(minGap);
      }),
    ).pipe(Effect.forkScoped);

    return (kind: DiscoverySyncKind) =>
      Ref.update(pending, (current) => mergeKinds(current, kind)).pipe(
        Effect.andThen(Queue.offer(wake, undefined)),
        Effect.asVoid,
      );
  },
);
