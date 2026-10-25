import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import { Effect, Option } from "effect";

import {
  LIFECYCLE_STALL_SNAPSHOT_TTL_MS,
  ServerLifecycleEvents,
  ServerLifecycleEventsLive,
} from "./serverLifecycleEvents.ts";

it.effect(
  "publishes lifecycle events without subscribers and snapshots the latest welcome/ready",
  () =>
    Effect.gen(function* () {
      const lifecycleEvents = yield* ServerLifecycleEvents;

      const welcome = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "welcome",
          payload: {
            cwd: "/tmp/project",
            projectName: "project",
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(welcome));
      assert.equal(welcome.value.sequence, 1);

      const ready = yield* lifecycleEvents
        .publish({
          version: 1,
          type: "ready",
          payload: {
            at: new Date().toISOString(),
          },
        })
        .pipe(Effect.timeoutOption("50 millis"));
      assertTrue(Option.isSome(ready));
      assert.equal(ready.value.sequence, 2);

      const snapshot = yield* lifecycleEvents.snapshot;
      assert.equal(snapshot.sequence, 2);
      assert.deepEqual(snapshot.events.map((event) => event.type).toSorted(), ["ready", "welcome"]);
    }).pipe(Effect.provide(ServerLifecycleEventsLive)),
);

const stalledInput = (endedAt: string) =>
  ({
    version: 1,
    type: "stalled",
    payload: { startedAt: endedAt, endedAt, durationMs: 1_500, spans: [], inFlightRpcMethods: [] },
  }) as const;

it.effect("keeps ready in the snapshot after a stall and drops stale stalls", () =>
  Effect.gen(function* () {
    const lifecycleEvents = yield* ServerLifecycleEvents;
    yield* lifecycleEvents.publish({
      version: 1,
      type: "ready",
      payload: { at: new Date().toISOString() },
    });
    const stale = new Date(Date.now() - LIFECYCLE_STALL_SNAPSHOT_TTL_MS - 1_000).toISOString();
    yield* lifecycleEvents.publish(stalledInput(stale));

    const afterStale = yield* lifecycleEvents.snapshot;
    assert.equal(afterStale.sequence, 2);
    assert.deepEqual(
      afterStale.events.map((event) => event.type),
      ["ready"],
    );

    const recent = yield* lifecycleEvents.publish(stalledInput(new Date().toISOString()));
    const afterRecent = yield* lifecycleEvents.snapshot;
    assert.deepEqual(afterRecent.events.map((event) => event.type).toSorted(), [
      "ready",
      "stalled",
    ]);
    assert.equal(
      afterRecent.events.find((event) => event.type === "stalled")?.sequence,
      recent.sequence,
    );
  }).pipe(Effect.provide(ServerLifecycleEventsLive)),
);
