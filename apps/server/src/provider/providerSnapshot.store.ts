import type { ServerProvider } from "@bigbud/contracts";
import { Effect, PubSub, Ref, Stream } from "effect";

import { areProviderSnapshotsEqual } from "./providerSnapshot.equal.ts";

/** Snapshot reads never probe or publish: registry change listeners read them again. */
export const makeProviderSnapshotStore = Effect.fn("makeProviderSnapshotStore")(function* (
  initialSnapshot: ServerProvider,
) {
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const changes = yield* Effect.acquireRelease(PubSub.sliding<ServerProvider>(8), PubSub.shutdown);
  return {
    getSnapshot: Ref.get(snapshotRef),
    publish: Effect.fn("publishProviderSnapshot")(function* (snapshot: ServerProvider) {
      const previous = yield* Ref.get(snapshotRef);
      yield* Ref.set(snapshotRef, snapshot);
      if (!areProviderSnapshotsEqual(previous, snapshot)) {
        yield* PubSub.publish(changes, snapshot);
      }
    }),
    streamChanges: Stream.fromPubSub(changes),
  };
});
