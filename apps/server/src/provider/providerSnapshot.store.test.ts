import { Effect, Stream } from "effect";
import { expect, it } from "vitest";

import { buildServerProvider } from "./providerSnapshot.ts";
import { makeProviderSnapshotStore } from "./providerSnapshot.store.ts";

it("caches fresh timestamps without publishing unchanged provider state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const initial = buildServerProvider({
          provider: "opencodeV2",
          enabled: false,
          checkedAt: "2026-10-08T11:00:00.000Z",
          models: [],
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
          },
        });
        const snapshots = yield* makeProviderSnapshotStore(initial);
        const updates: unknown[] = [];
        yield* snapshots.streamChanges.pipe(
          Stream.take(3),
          Stream.runForEach((value) => Effect.sync(() => updates.push(value))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("10 millis");
        const timestampOnly = { ...initial, checkedAt: "2026-10-08T11:01:00.000Z" };
        yield* snapshots.publish(timestampOnly);
        expect(yield* snapshots.getSnapshot).toBe(timestampOnly);
        const changed = { ...timestampOnly, message: "Configuration is required." };
        yield* snapshots.publish(changed);
        yield* snapshots.publish({ ...changed, checkedAt: "2026-10-08T11:02:00.000Z" });
        yield* Effect.sleep("10 millis");
        expect(updates).toEqual([changed]);
      }),
    ),
  );
});
