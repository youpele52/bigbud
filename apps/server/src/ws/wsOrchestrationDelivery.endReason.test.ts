import { Cause, Effect, Exit, PubSub, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { EventId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { OrchestrationDeliveryStreamItem } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationDeliverySessionEndReason } from "@bigbud/contracts/server/connectionDiagnostics.ts";

import type { DeliverySessionEndedInput } from "../connection-diagnostics/Services/ConnectionDiagnostics.ts";
import { DesktopSupervisorDeliveryCoordinator } from "../desktop-supervisor/desktopSupervisorDelivery.ts";
import type {
  DesktopSupervisorDeliveryShape,
  DesktopSupervisorSubscription,
} from "../desktop-supervisor/desktopSupervisorDelivery.types.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeOrchestrationDeliveryStream } from "./wsOrchestrationDelivery.ts";
import {
  classifyHandoffExit,
  makeDeliveryEndReasonTracker,
} from "./wsOrchestrationDelivery.endReason.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-delivery-end-reason");

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.makeUnsafe(`event-end-reason-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: "2026-10-21T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.reverted",
    payload: { threadId: THREAD_ID, turnCount: sequence },
  };
}

const emptyReplay = (fromSequenceExclusive: number) => ({
  requestedFromSequenceExclusive: fromSequenceExclusive,
  retainedFromSequenceExclusive: fromSequenceExclusive,
  earliestAvailableSequence: null,
  latestSequence: fromSequenceExclusive,
  availability: "available" as const,
  complete: true,
  events: [],
});

function engine(liveEvents: PubSub.PubSub<OrchestrationEvent>) {
  return {
    getReadModel: () => Effect.succeed({ snapshotSequence: 0 }),
    readEvents: () => Stream.empty,
    readReplay: (fromSequenceExclusive: number) =>
      Effect.succeed(emptyReplay(fromSequenceExclusive)),
    streamDomainEvents: Stream.fromPubSub(liveEvents),
  } as unknown as OrchestrationEngineShape;
}

function fakeSubscription(input: {
  readonly accept?: (entry: OrchestrationEvent) => boolean;
  readonly endReason?: () => OrchestrationDeliverySessionEndReason | null;
}): DesktopSupervisorSubscription {
  const queued: OrchestrationDeliveryStreamItem[] = [];
  const takers: Array<(item: OrchestrationDeliveryStreamItem | null) => void> = [];
  return {
    consumerId: "consumer-end-reason",
    offer: async (entry) => {
      if (input.accept?.(entry) === false) return false;
      const item: OrchestrationDeliveryStreamItem = {
        type: "batch",
        route: "direct-unmanaged",
        consumerId: "consumer-end-reason",
        consumerGeneration: 1,
        serverEpoch: "server-end-reason",
        subscriptionGeneration: 1,
        batchId: `batch-${entry.sequence}`,
        events: [entry],
      };
      const taker = takers.shift();
      if (taker) taker(item);
      else queued.push(item);
      return true;
    },
    take: async () =>
      queued.shift() ??
      (await new Promise<OrchestrationDeliveryStreamItem | null>((resolve) =>
        takers.push(resolve),
      )),
    close: () => {
      for (const take of takers.splice(0)) take(null);
    },
    ...(input.endReason ? { endReason: input.endReason } : {}),
  };
}

async function runDelivery(
  subscription: DesktopSupervisorSubscription,
  consume: (stream: Stream.Stream<OrchestrationDeliveryStreamItem>) => Effect.Effect<unknown>,
  publish: ReadonlyArray<OrchestrationEvent>,
): Promise<DeliverySessionEndedInput[]> {
  const ended: DeliverySessionEndedInput[] = [];
  const liveEvents = await Effect.runPromise(PubSub.unbounded<OrchestrationEvent>());
  const delivery = { open: async () => subscription } as unknown as DesktopSupervisorDeliveryShape;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* makeOrchestrationDeliveryStream({
          consumerId: "consumer-end-reason",
          appliedSequence: 0,
          orchestrationEngine: engine(liveEvents),
          delivery,
          onSessionEnded: (input) => Effect.sync(() => ended.push(input)),
        });
        yield* Effect.forEach(publish, (entry) => PubSub.publish(liveEvents, entry));
        return yield* Effect.exit(consume(stream));
      }),
    ),
  );
  return ended;
}

describe("orchestration delivery end reasons", () => {
  it("records a client close when the subscriber stops consuming", async () => {
    const ended = await runDelivery(
      fakeSubscription({}),
      (stream) => Stream.take(stream, 1).pipe(Stream.runDrain),
      [event(1)],
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ consumerId: "consumer-end-reason", reason: "client-close" });
    expect(ended[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records an overflow when the session refuses a live event", async () => {
    const ended = await runDelivery(
      fakeSubscription({ accept: (entry) => entry.sequence < 2 }),
      (stream) => Stream.runDrain(stream),
      [event(1), event(2)],
    );
    expect(ended.map((entry) => entry.reason)).toEqual(["overflow"]);
  });

  it("prefers the reason the session recorded about itself", async () => {
    const ended = await runDelivery(
      fakeSubscription({ accept: () => false, endReason: () => "server-shutdown" }),
      (stream) => Stream.runDrain(stream),
      [event(1)],
    );
    expect(ended.map((entry) => entry.reason)).toEqual(["server-shutdown"]);
  });

  it("attributes ends seen during server shutdown to the shutdown", () => {
    let shuttingDown = false;
    const beforeShutdown = makeDeliveryEndReasonTracker(() => shuttingDown);
    beforeShutdown.mark("overflow");
    const duringShutdown = makeDeliveryEndReasonTracker(() => shuttingDown);
    shuttingDown = true;
    duringShutdown.mark("handoff-ended");

    expect(beforeShutdown.resolve({})).toBe("overflow");
    expect(duringShutdown.resolve({})).toBe("server-shutdown");
    expect(duringShutdown.resolve({ endReason: () => "superseded" })).toBe("superseded");
    expect(makeDeliveryEndReasonTracker().resolve({})).toBe("client-close");
  });

  it("classifies how the canonical handoff ended", () => {
    expect(classifyHandoffExit(Exit.void)).toBe("handoff-ended");
    expect(classifyHandoffExit(Exit.interrupt(1))).toBeNull();
    expect(
      classifyHandoffExit(
        Exit.failCause(Cause.die(new Error("orchestration delivery live capture overflowed"))),
      ),
    ).toBe("overflow");
    expect(classifyHandoffExit(Exit.failCause(Cause.die(new Error("event store closed"))))).toBe(
      "handoff-ended",
    );
  });
});

describe("delivery session end reasons in the coordinator", () => {
  const open = (coordinator: DesktopSupervisorDeliveryCoordinator) =>
    coordinator.open({
      consumerId: "consumer-coordinator",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive) => emptyReplay(fromSequenceExclusive),
    });

  it("marks a replaced subscription as superseded and leaves the new one open", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const first = await open(coordinator);
    const second = await open(coordinator);

    expect(first.endReason?.()).toBe("superseded");
    expect(second.endReason?.()).toBeNull();
    await coordinator.close();
    expect(second.endReason?.()).toBe("server-shutdown");
  });

  it("does not label a client close as a session-side end", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await open(coordinator);
    subscription.close();

    await vi.waitFor(() => expect(subscription.endReason?.()).toBeNull());
    await coordinator.close();
    expect(subscription.endReason?.()).toBeNull();
  });
});
