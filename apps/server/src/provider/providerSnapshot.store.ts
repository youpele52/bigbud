import type { ServerProvider } from "@bigbud/contracts";
import { Effect, PubSub, Stream } from "effect";

import { areProviderSnapshotsEqual } from "./providerSnapshot.equal.ts";
import {
  currentProviderSnapshot,
  guardProviderSnapshot,
  invalidatedProviderSnapshot,
} from "./providerSnapshot.authority.ts";

/** Snapshot reads never probe or publish: registry change listeners read them again. */
export const makeProviderSnapshotStore = Effect.fn("makeProviderSnapshotStore")(function* (
  initialSnapshot: ServerProvider,
  invalidate?: () => ServerProvider,
) {
  let current = initialSnapshot;
  const changes = yield* Effect.acquireRelease(PubSub.sliding<ServerProvider>(8), PubSub.shutdown);
  return {
    getSnapshot: Effect.sync(() => currentProviderSnapshot(current)),
    publish: Effect.fn("publishProviderSnapshot")(function* (
      snapshot: ServerProvider,
      validate?: () => void,
    ) {
      yield* Effect.sync(() => {
        validate?.();
        guardProviderSnapshot(
          snapshot,
          validate,
          invalidate ?? (() => invalidatedProviderSnapshot(initialSnapshot)),
        );
        const previous = current;
        current = snapshot;
        if (!areProviderSnapshotsEqual(previous, snapshot)) PubSub.publishUnsafe(changes, snapshot);
      });
    }),
    streamChanges: Stream.fromPubSub(changes).pipe(
      Stream.rechunk(1),
      Stream.map(currentProviderSnapshot),
    ),
  };
});
