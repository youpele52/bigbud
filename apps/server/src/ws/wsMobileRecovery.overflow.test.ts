import { EventId, MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";
import type { MobileRecoveryFrame } from "@bigbud/contracts/server/mobile.recovery";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeMobileRecoveryFrameStream } from "./wsMobileRecovery.ts";
import { MOBILE_RECOVERY_MAX_BATCH_BYTES } from "./wsMobileRecovery.frames.ts";

const threadId = ThreadId.makeUnsafe("mobile-overflow-thread");
const messageId = MessageId.makeUnsafe("mobile-overflow-message");
const serverEpoch = "mobile-overflow-server";
const KB = 1024;

/** An assistant `thread.message-sent` event, as the decider emits for deltas and completion. */
function messageEvent(
  sequence: number,
  text: string,
  options: { readonly streaming: boolean; readonly replace: boolean },
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`mobile-overflow-event-${sequence}`),
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
      messageId,
      role: "assistant",
      text,
      turnId: null,
      replace: options.replace,
      streaming: options.streaming,
      createdAt: "2026-09-09T00:00:00.000Z",
      updatedAt: "2026-09-09T00:00:00.000Z",
    },
  };
}

const delta = (sequence: number, size: number) =>
  messageEvent(sequence, "d".repeat(size), { streaming: true, replace: false });
const oversized = (sequence: number) =>
  messageEvent(sequence, "x".repeat(300 * KB), { streaming: false, replace: true });

function replayPage(
  cursor: number,
  latestSequence: number,
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationReplayEventsResult {
  return {
    requestedFromSequenceExclusive: cursor,
    retainedFromSequenceExclusive: 0,
    earliestAvailableSequence: latestSequence === 0 ? null : 1,
    latestSequence,
    availability: "available",
    complete: events.at(-1)?.sequence === latestSequence,
    events,
  };
}

/** Replays nothing past `baselineSequence`, then serves `gapEvents` to a live-gap recovery. */
async function collectFrames(input: {
  readonly baselineSequence: number;
  readonly liveEvents: ReadonlyArray<OrchestrationEvent>;
  readonly gapEvents?: ReadonlyArray<OrchestrationEvent>;
}): Promise<ReadonlyArray<MobileRecoveryFrame>> {
  let reads = 0;
  const engine = {
    serverEpoch,
    readReplay: (cursor: number) => {
      reads += 1;
      const events = reads === 1 ? [] : (input.gapEvents ?? []);
      return Effect.succeed(
        replayPage(cursor, events.at(-1)?.sequence ?? input.baselineSequence, events),
      );
    },
    openDeliveryLiveCapture: () =>
      Effect.succeed({
        stream: Stream.fromIterable(input.liveEvents),
        isOverflowed: Effect.succeed(false),
        close: Effect.void,
      }),
  } as unknown as OrchestrationEngineShape;
  const frames = await Effect.runPromise(
    Effect.scoped(
      makeMobileRecoveryFrameStream({
        recoveryAttemptId: "overflow-attempt",
        baselineSequence: input.baselineSequence,
        clientServerEpoch: serverEpoch,
        serverEpoch,
        orchestrationEngine: engine,
      }).pipe(Effect.flatMap((stream) => Stream.runCollect(stream))),
    ),
  );
  return Array.from(frames);
}

const ofType = (frames: ReadonlyArray<MobileRecoveryFrame>, type: MobileRecoveryFrame["type"]) =>
  frames.filter((frame) => frame.type === type);

describe("mobile recovery stream overflow", () => {
  it("answers one oversized live event with one overflow resync and no batch", async () => {
    const frames = await collectFrames({ baselineSequence: 7, liveEvents: [oversized(8)] });

    expect(ofType(frames, "batch")).toEqual([]);
    expect(ofType(frames, "resync-required")).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "overflow" }),
    ]);
  });

  it("answers one oversized recovered event with one overflow resync and no batch", async () => {
    const frames = await collectFrames({
      baselineSequence: 7,
      liveEvents: [oversized(9)],
      gapEvents: [delta(8, 10), oversized(9)],
    });

    expect(ofType(frames, "batch")).toEqual([]);
    expect(ofType(frames, "resync-required")).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "overflow" }),
    ]);
  });

  it("streams a message past the frame budget as small deltas without a resync", async () => {
    const deltas = [8, 9, 10, 11].map((sequence) => delta(sequence, 100 * KB));

    const frames = await collectFrames({ baselineSequence: 7, liveEvents: deltas });
    const delivered = ofType(frames, "batch").flatMap((frame) =>
      frame.type === "batch" ? frame.events : [],
    );

    expect(4 * 100 * KB).toBeGreaterThan(MOBILE_RECOVERY_MAX_BATCH_BYTES);
    expect(ofType(frames, "resync-required")).toEqual([]);
    expect(delivered.map((event) => event.sequence)).toEqual([8, 9, 10, 11]);
  });

  it("answers an oversized full-text completion after deltas with one overflow resync", async () => {
    const frames = await collectFrames({
      baselineSequence: 7,
      liveEvents: [delta(8, 100 * KB), delta(9, 100 * KB), oversized(10)],
    });
    const delivered = ofType(frames, "batch").flatMap((frame) =>
      frame.type === "batch" ? frame.events : [],
    );

    expect(delivered.map((event) => event.sequence)).toEqual([8, 9]);
    expect(ofType(frames, "resync-required")).toEqual([
      expect.objectContaining({ type: "resync-required", reason: "overflow" }),
    ]);
    expect(frames.at(-1)?.type).toBe("resync-required");
  });
});
