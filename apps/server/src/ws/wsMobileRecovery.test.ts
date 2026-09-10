import type { MobileRecoveryFrame } from "@bigbud/contracts/server/mobile.recovery";
import { EventId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeOrchestrationDeliveryHub } from "../orchestration/Layers/OrchestrationEngine.deliveryHub.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine";
import { makeMobileRecoveryFrameStream } from "./wsMobileRecovery";

const threadId = ThreadId.makeUnsafe("mobile-recovery-test-thread");
const serverEpoch = "mobile-recovery-test-server";

function event(sequence: number, eventSuffix = String(sequence)): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`mobile-recovery-event-${eventSuffix}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-09T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: { threadId, turnCount: sequence },
  };
}

function oversizedEvent(sequence: number): OrchestrationEvent {
  return sizedEvent(sequence, 300_000);
}

function sizedEvent(sequence: number, size: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`mobile-recovery-oversized-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-09-09T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.makeUnsafe(`mobile-recovery-oversized-message-${sequence}`),
      role: "user",
      text: "x".repeat(size),
      turnId: null,
      streaming: false,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
  };
}

function replayPage(
  requestedFromSequenceExclusive: number,
  latestSequence: number,
  events: ReadonlyArray<OrchestrationEvent>,
  availability: "available" | "gap" = "available",
): OrchestrationReplayEventsResult {
  return {
    requestedFromSequenceExclusive,
    retainedFromSequenceExclusive: 0,
    earliestAvailableSequence: latestSequence === 0 ? null : 1,
    latestSequence,
    availability,
    complete: events.at(-1)?.sequence === latestSequence,
    events,
  };
}

function makeEngine(input: {
  readonly readReplay: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Effect.Effect<OrchestrationReplayEventsResult>;
  readonly liveEvents?: ReadonlyArray<OrchestrationEvent>;
  readonly onCaptureOpened?: () => void;
}) {
  return {
    serverEpoch,
    readReplay: input.readReplay,
    openDeliveryLiveCapture: () => {
      input.onCaptureOpened?.();
      return Effect.succeed({
        stream: Stream.fromIterable(input.liveEvents ?? []),
        isOverflowed: Effect.succeed(false),
        close: Effect.void,
      });
    },
  } as unknown as OrchestrationEngineShape;
}

async function collectFrames(input: {
  readonly engine: OrchestrationEngineShape;
  readonly baselineSequence: number;
}) {
  return Effect.runPromise(
    Effect.scoped(
      makeMobileRecoveryFrameStream({
        recoveryAttemptId: "attempt-1",
        baselineSequence: input.baselineSequence,
        clientServerEpoch: serverEpoch,
        serverEpoch,
        orchestrationEngine: input.engine,
      }).pipe(Effect.flatMap((stream) => Stream.runCollect(stream))),
    ),
  );
}

function asArray(frames: ReadonlyArray<MobileRecoveryFrame> | Iterable<MobileRecoveryFrame>) {
  return Array.from(frames);
}

describe("makeMobileRecoveryFrameStream", () => {
  it("opens capture before reading replay and emits caught-up for zero events", async () => {
    const calls: number[] = [];
    const engine = makeEngine({
      onCaptureOpened: () => calls.push(-1),
      readReplay: (cursor) => {
        calls.push(cursor);
        return Effect.succeed(replayPage(cursor, 7, []));
      },
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 7 }));

    expect(calls).toEqual([-1, 7]);
    expect(frames).toEqual([
      {
        version: 1,
        type: "caught-up",
        route: "direct-unmanaged",
        recoveryAttemptId: "attempt-1",
        serverEpoch,
        throughSequence: 7,
      },
    ]);
  });

  it("paginates beyond the event store default limit to a fixed watermark", async () => {
    const persisted = Array.from({ length: 1_001 }, (_, index) => event(index + 1));
    const cursors: number[] = [];
    const engine = makeEngine({
      readReplay: (cursor, limit = 0) => {
        cursors.push(cursor);
        const pageEvents = persisted.filter((entry) => entry.sequence > cursor).slice(0, limit);
        return Effect.succeed(replayPage(cursor, 1_001, pageEvents));
      },
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));
    const batches = frames.filter((frame) => frame.type === "batch");
    const replayed = batches.flatMap((frame) => (frame.type === "batch" ? frame.events : []));

    expect(cursors).toEqual([0, 500, 1_000]);
    expect(replayed.map((entry) => entry.sequence)).toEqual(
      persisted.map((entry) => entry.sequence),
    );
    expect(frames.at(-1)).toMatchObject({ type: "caught-up", throughSequence: 1_001 });
  });

  it("checks an actual capture overflow before publishing caught-up", async () => {
    const deliveryHub = await Effect.runPromise(makeOrchestrationDeliveryHub);
    let published = false;
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) =>
        Effect.gen(function* () {
          if (!published) {
            published = true;
            yield* Effect.forEach(
              Array.from({ length: 2_001 }, (_, index) => event(index + 1)),
              deliveryHub.publish,
              { discard: true },
            );
          }
          return replayPage(cursor, 0, []);
        }),
    } as unknown as OrchestrationEngineShape;

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));

    expect(frames).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "overflow" }),
    ]);
    expect(frames.some((frame) => frame.type === "caught-up")).toBe(false);
  });

  it("checks actual capture overflow after the final replay batch is consumed", async () => {
    const deliveryHub = await Effect.runPromise(makeOrchestrationDeliveryHub);
    const frames: MobileRecoveryFrame[] = [];
    const engine = {
      serverEpoch,
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (cursor: number) => Effect.succeed(replayPage(cursor, 1, [event(1)])),
    } as unknown as OrchestrationEngineShape;

    await Effect.runPromise(
      Effect.scoped(
        makeMobileRecoveryFrameStream({
          recoveryAttemptId: "attempt-1",
          baselineSequence: 0,
          clientServerEpoch: serverEpoch,
          serverEpoch,
          orchestrationEngine: engine,
        }).pipe(
          Effect.flatMap((stream) =>
            Stream.runForEach(stream, (frame) =>
              Effect.gen(function* () {
                frames.push(frame);
                if (frame.type === "batch") {
                  yield* Effect.forEach(
                    Array.from({ length: 2_001 }, (_, index) => event(index + 2)),
                    deliveryHub.publish,
                    { discard: true },
                  );
                }
              }),
            ),
          ),
        ),
      ),
    );

    expect(frames.map((frame) => frame.type)).toEqual(["batch", "resync-required"]);
    expect(frames.at(-1)).toMatchObject({ type: "resync-required", reason: "overflow" });
  });

  it("returns a bounded gap failure instead of waiting for another live event", async () => {
    const engine = makeEngine({
      readReplay: (cursor) => Effect.succeed(replayPage(cursor, 5, [event(2)])),
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));

    expect(frames).toEqual([
      {
        version: 1,
        type: "resync-required",
        route: "direct-unmanaged",
        recoveryAttemptId: "attempt-1",
        serverEpoch,
        reason: "gap",
      },
    ]);
  });

  it("rejects a cursor beyond the replay watermark", async () => {
    const engine = makeEngine({
      readReplay: (cursor) => Effect.succeed(replayPage(cursor, 7, [])),
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 8 }));

    expect(frames).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "invalid-cursor" }),
    ]);
  });

  it("rejects a single event that exceeds the serialized frame budget", async () => {
    const engine = makeEngine({
      readReplay: (cursor) => Effect.succeed(replayPage(cursor, 1, [oversizedEvent(1)])),
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));

    expect(frames).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "overflow" }),
    ]);
  });

  it("replays a one-event live discontinuity canonically", async () => {
    const cursors: number[] = [];
    const engine = makeEngine({
      liveEvents: [event(9, "canonical-9")],
      readReplay: (cursor) => {
        cursors.push(cursor);
        if (cursors.length === 1) return Effect.succeed(replayPage(cursor, 7, []));
        return Effect.succeed(replayPage(cursor, 9, [event(8), event(9, "canonical-9")]));
      },
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 7 }));
    const batches = frames.filter((frame) => frame.type === "batch");
    const replayed = batches.flatMap((frame) => (frame.type === "batch" ? frame.events : []));

    expect(cursors).toEqual([7, 7]);
    expect(replayed.map((entry) => entry.sequence)).toEqual([8, 9]);
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "caught-up", throughSequence: 7 }),
    );
  });

  it("rejects a live gap whose trigger identity differs from canonical replay", async () => {
    let readCount = 0;
    const engine = makeEngine({
      liveEvents: [event(9, "live-9")],
      readReplay: (cursor) => {
        readCount += 1;
        return readCount === 1
          ? Effect.succeed(replayPage(cursor, 7, []))
          : Effect.succeed(replayPage(cursor, 9, [event(8), event(9, "canonical-9")]));
      },
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 7 }));

    expect(frames.filter((frame) => frame.type === "batch")).toHaveLength(0);
    expect(frames.at(-1)).toMatchObject({ type: "resync-required", reason: "gap" });
  });

  it("bounds total replay bytes across otherwise valid pages", async () => {
    const persisted = Array.from({ length: 501 }, (_, index) => sizedEvent(index + 1, 21_000));
    const engine = makeEngine({
      readReplay: (cursor) => {
        const pageEvents = persisted.filter((entry) => entry.sequence > cursor).slice(0, 40);
        return Effect.succeed(replayPage(cursor, persisted.length, pageEvents));
      },
    });

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));

    expect(frames.at(-1)).toMatchObject({ type: "resync-required", reason: "overflow" });
    expect(frames.some((frame) => frame.type === "caught-up")).toBe(false);
  });

  it("marks an actual capture overflow when its byte backlog is full", async () => {
    const deliveryHub = await Effect.runPromise(makeOrchestrationDeliveryHub);
    const overflowed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const capture = yield* deliveryHub.openCapture(2_000, 128);
          yield* deliveryHub.publish(event(1));
          return yield* capture.isOverflowed;
        }),
      ),
    );

    expect(overflowed).toBe(true);
  });

  it("fails explicitly when engine capture is unavailable", async () => {
    const engine = {
      readReplay: () => Effect.succeed(replayPage(0, 0, [])),
    } as unknown as OrchestrationEngineShape;

    const frames = asArray(await collectFrames({ engine, baselineSequence: 0 }));

    expect(frames[0]).toMatchObject({ type: "resync-required", reason: "unavailable" });
  });

  it("rejects a baseline from a different server epoch before opening capture", async () => {
    let captureOpened = false;
    const engine = makeEngine({
      onCaptureOpened: () => {
        captureOpened = true;
      },
      readReplay: () => Effect.succeed(replayPage(0, 0, [])),
    });

    const frames = asArray(
      await Effect.runPromise(
        Effect.scoped(
          makeMobileRecoveryFrameStream({
            recoveryAttemptId: "attempt-1",
            baselineSequence: 0,
            clientServerEpoch: "old-server",
            serverEpoch,
            orchestrationEngine: engine,
          }).pipe(Effect.flatMap((stream) => Stream.runCollect(stream))),
        ),
      ),
    );

    expect(captureOpened).toBe(false);
    expect(frames).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "invalid-cursor", serverEpoch }),
    ]);
  });
});
