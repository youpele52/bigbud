import {
  EventId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReplayEventsResult,
} from "@bigbud/contracts";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import { makeOrchestrationDeliveryHub } from "../orchestration/Layers/OrchestrationEngine.deliveryHub.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { MobileRecoveryFrame } from "@bigbud/contracts/server/mobile.recovery";
import { makeMobileRecoveryFrameStream } from "./wsMobileRecovery.ts";

const threadId = ThreadId.makeUnsafe("mobile-recovery-lifecycle-thread");
const serverEpoch = "mobile-recovery-lifecycle-server";

function event(sequence: number, suffix = String(sequence)): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`mobile-recovery-lifecycle-event-${suffix}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-10T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: { threadId, turnCount: sequence },
  };
}

function replayPage(
  requestedFromSequenceExclusive: number,
  latestSequence: number,
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationReplayEventsResult {
  return {
    requestedFromSequenceExclusive,
    retainedFromSequenceExclusive: 0,
    earliestAvailableSequence: latestSequence === 0 ? null : 1,
    latestSequence,
    availability: "available",
    complete: events.at(-1)?.sequence === latestSequence,
    events,
  };
}

function consume(
  engine: OrchestrationEngineShape,
  baselineSequence: number,
  onFrame: (frame: MobileRecoveryFrame) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const stream = yield* makeMobileRecoveryFrameStream({
      recoveryAttemptId: "lifecycle-attempt",
      baselineSequence,
      clientServerEpoch: serverEpoch,
      serverEpoch,
      orchestrationEngine: engine,
    });
    return yield* Effect.forkScoped(Stream.runForEach(stream, onFrame));
  });
}

function waitForSignal(signal: Deferred.Deferred<void>) {
  return Effect.race(
    Deferred.await(signal).pipe(Effect.as(true)),
    Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), 500);
        }),
    ),
  );
}

it.effect("ignores a delayed capture event already covered by the baseline", () =>
  Effect.gen(function* () {
    const deliveryHub = yield* makeOrchestrationDeliveryHub;
    const delivered = yield* Deferred.make<void>();
    const frames: MobileRecoveryFrame[] = [];
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) => Effect.succeed(replayPage(cursor, 7, [])),
    } as unknown as OrchestrationEngineShape;

    const consumer = yield* consume(engine, 7, (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (frame.type === "caught-up") {
          yield* deliveryHub.publish(event(7));
          yield* deliveryHub.publish(event(8));
        } else if (frame.type === "batch" && frame.events[0]?.sequence === 8) {
          yield* Deferred.succeed(delivered, undefined);
        }
      }),
    );
    const received = yield* waitForSignal(delivered);
    yield* Fiber.interrupt(consumer);

    assert.isTrue(received);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["caught-up", "batch"],
    );
    const batch = frames[1];
    assert.equal(batch?.type, "batch");
    if (batch?.type === "batch")
      assert.deepEqual(
        batch.events.map((item) => item.sequence),
        [8],
      );
  }),
);

it.effect("keeps canonical identity checks for overlap above the baseline", () =>
  Effect.gen(function* () {
    const deliveryHub = yield* makeOrchestrationDeliveryHub;
    const frames: MobileRecoveryFrame[] = [];
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) => Effect.succeed(replayPage(cursor, 8, [event(8)])),
    } as unknown as OrchestrationEngineShape;

    const consumer = yield* consume(engine, 7, (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (frame.type === "caught-up") yield* deliveryHub.publish(event(8, "mismatch-8"));
      }),
    );
    yield* Fiber.join(consumer);

    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["batch", "caught-up", "resync-required"],
    );
    const last = frames.at(-1);
    assert.equal(last?.type, "resync-required");
    if (last?.type === "resync-required") assert.equal(last.reason, "gap");
  }),
);

it.effect("releases an actual capture when the final batch consumer stalls past the deadline", () =>
  Effect.gen(function* () {
    const deliveryHub = yield* makeOrchestrationDeliveryHub;
    const batchStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const frames: MobileRecoveryFrame[] = [];
    let captureClosed = false;
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: (...args: Parameters<typeof deliveryHub.openCapture>) =>
        deliveryHub.openCapture(...args).pipe(
          Effect.map((capture) => ({
            ...capture,
            close: capture.close.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  captureClosed = true;
                }),
              ),
            ),
          })),
        ),
      readReplay: (cursor: number) => Effect.succeed(replayPage(cursor, 1, [event(1)])),
    } as unknown as OrchestrationEngineShape;

    const consumer = yield* consume(engine, 0, (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (frame.type === "batch") {
          yield* Deferred.succeed(batchStarted, undefined);
          yield* Deferred.await(release);
        }
      }),
    );
    assert.isTrue(yield* waitForSignal(batchStarted));
    yield* TestClock.adjust("15 seconds");
    yield* Effect.yieldNow;
    assert.isTrue(captureClosed);

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(consumer);
    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["batch", "resync-required"],
    );
    const last = frames.at(-1);
    assert.equal(last?.type, "resync-required");
    if (last?.type === "resync-required") assert.equal(last.reason, "timeout");
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps an actual capture live after caught-up beyond the initial deadline", () =>
  Effect.gen(function* () {
    const deliveryHub = yield* makeOrchestrationDeliveryHub;
    const caughtUp = yield* Deferred.make<void>();
    const liveDelivered = yield* Deferred.make<void>();
    const frames: MobileRecoveryFrame[] = [];
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) => Effect.succeed(replayPage(cursor, 7, [])),
    } as unknown as OrchestrationEngineShape;

    const consumer = yield* consume(engine, 7, (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (frame.type === "caught-up") yield* Deferred.succeed(caughtUp, undefined);
        if (frame.type === "batch" && frame.events[0]?.sequence === 8) {
          yield* Deferred.succeed(liveDelivered, undefined);
        }
      }),
    );
    yield* Deferred.await(caughtUp);
    yield* TestClock.adjust("16 seconds");
    yield* deliveryHub.publish(event(8));
    assert.isTrue(yield* waitForSignal(liveDelivered));
    yield* Fiber.interrupt(consumer);

    assert.deepEqual(
      frames.map((frame) => frame.type),
      ["caught-up", "batch"],
    );
    assert.equal(
      frames.some((frame) => frame.type === "resync-required"),
      false,
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("gives a post-caught-up live gap its own bounded repair deadline", () =>
  Effect.gen(function* () {
    const deliveryHub = yield* makeOrchestrationDeliveryHub;
    const caughtUp = yield* Deferred.make<void>();
    const repaired = yield* Deferred.make<void>();
    const frames: MobileRecoveryFrame[] = [];
    const cursors: number[] = [];
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) => {
        cursors.push(cursor);
        return Effect.succeed(
          cursors.length === 1
            ? replayPage(cursor, 7, [])
            : replayPage(cursor, 9, [event(8), event(9, "canonical-9")]),
        );
      },
    } as unknown as OrchestrationEngineShape;

    const consumer = yield* consume(engine, 7, (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (frame.type === "caught-up") yield* Deferred.succeed(caughtUp, undefined);
        if (frame.type === "batch" && frame.events.at(-1)?.sequence === 9) {
          yield* Deferred.succeed(repaired, undefined);
        }
      }),
    );
    yield* Deferred.await(caughtUp);
    yield* TestClock.adjust("16 seconds");
    yield* deliveryHub.publish(event(9, "canonical-9"));
    assert.isTrue(yield* waitForSignal(repaired));
    yield* Fiber.interrupt(consumer);

    assert.deepEqual(cursors, [7, 7]);
    const batches = frames.filter((frame) => frame.type === "batch");
    assert.deepEqual(
      batches
        .flatMap((frame) => (frame.type === "batch" ? frame.events : []))
        .map((item) => item.sequence),
      [8, 9],
    );
    assert.equal(
      frames.some((frame) => frame.type === "resync-required"),
      false,
    );
  }).pipe(Effect.provide(TestClock.layer())),
);
