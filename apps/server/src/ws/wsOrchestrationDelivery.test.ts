import { Effect, PubSub, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import type {
  DesktopSupervisorDeliveryShape,
  DesktopSupervisorSubscription,
} from "../desktop-supervisor/desktopSupervisorDelivery.types.ts";
import { makeOrchestrationDeliveryHub } from "../orchestration/Layers/OrchestrationEngine.deliveryHub.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeOrchestrationDeliveryStream } from "./wsOrchestrationDelivery.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-delivery-handoff");

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-delivery-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-08-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: { threadId: THREAD_ID, turnCount: sequence },
  };
}

function outputSubscription(input: {
  readonly accept?: (event: OrchestrationEvent) => boolean;
  readonly onClose?: () => void;
}): DesktopSupervisorSubscription {
  const output: OrchestrationDeliveryStreamItem[] = [];
  const takers: Array<(item: OrchestrationDeliveryStreamItem | null) => void> = [];
  let closed = false;
  return {
    consumerId: "consumer-delivery",
    offer: async (entry: OrchestrationEvent) => {
      if (closed || input.accept?.(entry) === false) return false;
      const item: OrchestrationDeliveryStreamItem = {
        type: "batch",
        route: "direct-unmanaged",
        consumerId: "consumer-delivery",
        consumerGeneration: 1,
        serverEpoch: "server-delivery-test",
        subscriptionGeneration: 1,
        batchId: `batch-${entry.sequence}`,
        events: [entry],
      };
      const taker = takers.shift();
      if (taker) taker(item);
      else output.push(item);
      return true;
    },
    take: async () => {
      const item = output.shift();
      if (item) return item;
      if (closed) return null;
      return await new Promise<OrchestrationDeliveryStreamItem | null>((resolve) =>
        takers.push(resolve),
      );
    },
    close: () => {
      if (closed) return;
      closed = true;
      input.onClose?.();
      for (const take of takers.splice(0)) take(null);
    },
  };
}

function engine(liveEvents: PubSub.PubSub<OrchestrationEvent>, snapshotSequence: () => number) {
  return {
    getReadModel: () => Effect.succeed({ snapshotSequence: snapshotSequence() }),
    readEvents: () => Stream.empty,
    readReplay: (fromSequenceExclusive: number) =>
      Effect.succeed({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: fromSequenceExclusive,
        earliestAvailableSequence: null,
        latestSequence: fromSequenceExclusive,
        availability: "available" as const,
        complete: true,
        events: [],
      }),
    streamDomainEvents: Stream.fromPubSub(liveEvents),
  } as unknown as OrchestrationEngineShape;
}

describe("makeOrchestrationDeliveryStream", () => {
  it("captures an event committed at the replay/live handoff exactly once", async () => {
    const liveEvents = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
    let snapshotSequence = 0;
    const offered: number[] = [];
    const subscription = outputSubscription({
      accept: (entry) => {
        offered.push(entry.sequence);
        return true;
      },
    });
    const delivery = {
      open: async (input: Parameters<DesktopSupervisorDeliveryShape["open"]>[0]) => {
        await input.readReplay(0);
        snapshotSequence = 1;
        await Effect.runPromise(PubSub.publish(liveEvents, event(1)));
        return subscription;
      },
    } as never;

    const received = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* makeOrchestrationDeliveryStream({
            consumerId: "consumer-delivery",
            appliedSequence: 0,
            orchestrationEngine: engine(liveEvents, () => snapshotSequence),
            delivery,
          });
          return yield* Stream.take(stream, 1).pipe(Stream.runCollect);
        }),
      ),
    );

    expect(
      Array.from(received).flatMap((item) =>
        item.type === "batch" ? item.events.map((entry) => entry.sequence) : [],
      ),
    ).toEqual([1]);
    expect(offered).toEqual([1]);
  });

  it("fences a bounded live capture instead of retaining an unbounded stalled backlog", async () => {
    const liveEvents = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
    const deliveryHub = await Effect.runPromise(makeOrchestrationDeliveryHub);
    const persisted = [event(1), event(2), event(3), event(4)];
    const orchestrationEngine = {
      ...engine(liveEvents, () => 4),
      openDeliveryLiveCapture: deliveryHub.openCapture,
      readReplay: (fromSequenceExclusive: number) =>
        Effect.succeed({
          requestedFromSequenceExclusive: fromSequenceExclusive,
          retainedFromSequenceExclusive: 0,
          earliestAvailableSequence: 1,
          latestSequence: 4,
          availability: "available" as const,
          complete: true,
          events: persisted.filter((entry) => entry.sequence > fromSequenceExclusive),
        }),
    } satisfies OrchestrationEngineShape;
    let releaseOpen!: (subscription: ReturnType<typeof outputSubscription>) => void;
    const openGate = new Promise<ReturnType<typeof outputSubscription>>((resolve) => {
      releaseOpen = resolve;
    });
    const closed = vi.fn();
    const openCalled = vi.fn();
    const subscription = outputSubscription({ onClose: closed });
    const delivery: Pick<DesktopSupervisorDeliveryShape, "open"> = {
      open: () => {
        openCalled();
        return openGate;
      },
    };

    const running = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* makeOrchestrationDeliveryStream({
            consumerId: "consumer-delivery",
            appliedSequence: 0,
            orchestrationEngine,
            delivery: delivery as DesktopSupervisorDeliveryShape,
            liveCapacity: 2,
          });
          return yield* Stream.runDrain(stream);
        }),
      ),
    );

    await vi.waitFor(() => expect(openCalled).toHaveBeenCalled());
    await Effect.runPromise(Effect.forEach(persisted, deliveryHub.publish));
    releaseOpen(subscription);

    await expect(running).rejects.toThrow(
      "orchestration delivery live handoff requires resubscription",
    );
    expect(closed).toHaveBeenCalled();

    const replayedSubscription = outputSubscription({});
    const replayDelivery: Pick<DesktopSupervisorDeliveryShape, "open"> = {
      open: async (input) => {
        const replay = await input.readReplay(input.appliedSequence);
        for (const entry of replay.events) await replayedSubscription.offer(entry);
        return replayedSubscription;
      },
    };
    const replayed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const stream = yield* makeOrchestrationDeliveryStream({
            consumerId: "consumer-delivery",
            appliedSequence: 0,
            orchestrationEngine,
            delivery: replayDelivery as DesktopSupervisorDeliveryShape,
            liveCapacity: 2,
          });
          return yield* Stream.take(stream, 4).pipe(Stream.runCollect);
        }),
      ),
    );
    const replayedSequences = Array.from(replayed).flatMap((item) =>
      item.type === "batch" ? item.events.map((entry) => entry.sequence) : [],
    );
    expect(replayedSequences).toEqual([1, 2, 3, 4]);
    expect(new Set(replayedSequences).size).toBe(replayedSequences.length);
  });
});
