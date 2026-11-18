import { EventId, ThreadId, type ThinkingActivityDeltaEvent } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, PubSub, Stream } from "effect";

import { THINKING_DELTA_GAP_MARKER, boundThinkingDeltaBacklog } from "./thinkingDeltaBacklog";

const delta = (activity: string, text: string): ThinkingActivityDeltaEvent => ({
  type: "delta",
  threadId: ThreadId.makeUnsafe("thread-1"),
  activityId: EventId.makeUnsafe(activity),
  turnId: null,
  provider: "codex",
  streamKind: "reasoning_text",
  delta: text,
  createdAt: "2026-11-18T00:00:00.000Z",
});

it.effect("a stalled client keeps a bounded backlog and marks the gap in the preview", () =>
  Effect.gen(function* () {
    const pubSub = yield* PubSub.unbounded<ThinkingActivityDeltaEvent>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const sawTail = yield* Deferred.make<void>();
    const capacity = 4;
    const received: Array<ThinkingActivityDeltaEvent> = [];
    const client = yield* boundThinkingDeltaBacklog(
      Stream.fromPubSub(pubSub).pipe(Stream.onStart(Deferred.succeed(subscribed, undefined))),
      capacity,
    ).pipe(
      // The first delta blocks the client, standing in for a slow WebSocket.
      Stream.runForEach((event) =>
        Effect.sync(() => received.push(event)).pipe(
          Effect.andThen(received.length === 1 ? Deferred.await(release) : Effect.void),
          Effect.andThen(
            event.delta.endsWith("tail") ? Deferred.succeed(sawTail, undefined) : Effect.void,
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(subscribed);

    for (let index = 0; index < 1_000; index += 1) {
      yield* PubSub.publish(pubSub, delta("activity-a", `a${index};`));
      yield* Effect.yieldNow;
    }
    // The shared PubSub is drained even though the client is stalled.
    assert.strictEqual(yield* PubSub.size(pubSub), 0);

    // The client catches up: it got the in-flight delta and the bounded backlog, nothing more.
    yield* Deferred.succeed(release, undefined);
    while (received.length < capacity + 1) yield* Effect.yieldNow;
    for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
    // In-flight delta, the bounded backlog and at most one chunk already pulled by the client.
    const caughtUp = received.length;
    assert.isAtMost(caughtUp, capacity + 2);

    yield* PubSub.publish(pubSub, delta("activity-a", "tail"));
    yield* Deferred.await(sawTail);
    yield* Fiber.interrupt(client);

    assert.strictEqual(received.length, caughtUp + 1);
    const tail = received.at(-1)!;
    assert.isTrue(tail.delta.startsWith(THINKING_DELTA_GAP_MARKER));
    assert.isTrue(tail.delta.endsWith("tail"));
    // Deltas before the gap are a contiguous, ordered, unmarked prefix of what was published.
    const prefix = received.slice(0, -1).map((event) => Number(event.delta.slice(1, -1)));
    prefix.forEach((value, index) => {
      if (index > 0) assert.strictEqual(value, prefix[index - 1]! + 1);
    });
  }),
);
