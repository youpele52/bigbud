import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";

import { makeCoalescedDiscoverySync, type DiscoverySyncKind } from "./DiscoveryRegistry.sync.ts";

const waitUntil = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep("5 millis");
    }
    assert.fail("condition was not reached");
  });

it.live("collapses a burst of requests into one running and one follow-up sync", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runs = yield* Ref.make<ReadonlyArray<DiscoverySyncKind>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const request = yield* makeCoalescedDiscoverySync(
        (kind) =>
          Effect.gen(function* () {
            const previous = yield* Ref.getAndUpdate(runs, (all) => [...all, kind]);
            if (previous.length === 0) {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
            }
          }),
        0,
      );

      yield* request("assemble");
      yield* Deferred.await(firstStarted);
      // A Pi session writing hundreds of times while the first sync runs.
      for (let burst = 0; burst < 200; burst += 1) yield* request("assemble");
      yield* request("rescan");
      yield* Deferred.succeed(releaseFirst, undefined);

      yield* waitUntil(Ref.get(runs).pipe(Effect.map((all) => all.length === 2)));
      yield* Effect.sleep("30 millis");
      assert.deepStrictEqual(yield* Ref.get(runs), ["assemble", "rescan"]);
    }),
  ),
);

it.live("keeps serving requests after a sync fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const request = yield* makeCoalescedDiscoverySync(
        () =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 1 ? Effect.die("scan crashed") : Effect.void)),
          ),
        0,
      );

      yield* request("rescan");
      yield* waitUntil(Ref.get(attempts).pipe(Effect.map((count) => count === 1)));
      yield* request("rescan");
      yield* waitUntil(Ref.get(attempts).pipe(Effect.map((count) => count === 2)));
    }),
  ),
);
