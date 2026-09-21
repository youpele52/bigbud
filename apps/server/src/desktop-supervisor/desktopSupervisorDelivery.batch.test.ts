import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { describe, expect, it } from "vitest";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-09-17T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.pinned",
    payload: { threadId: "thread-1" },
  } as OrchestrationEvent;
}

function largeEvent(sequence: number): OrchestrationEvent {
  return Object.assign(event(sequence), {
    metadata: { padding: "x".repeat(300 * 1024) },
  }) as unknown as OrchestrationEvent;
}

async function takeBatch(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("delivery closed before a batch");
    if (item.type === "batch") return item;
  }
}

describe("DesktopSupervisorDeliveryCoordinator batching", () => {
  it("drains a contiguous replay burst into one application acknowledgement", async () => {
    const events = Array.from({ length: 256 }, (_, index) => event(index + 1));
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await coordinator.open({
      consumerId: "batched-consumer",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive) => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: fromSequenceExclusive,
        earliestAvailableSequence: 1,
        latestSequence: events.length,
        availability: "available",
        complete: true,
        events,
      }),
    });

    const batch = await takeBatch(subscription);
    expect(batch.events).toHaveLength(256);
    expect(batch.events[0]?.sequence).toBe(1);
    expect(batch.events.at(-1)?.sequence).toBe(256);
    await expect(
      coordinator.acknowledge({
        batchId: batch.batchId,
        consumerId: batch.consumerId,
        consumerGeneration: batch.consumerGeneration,
        receivedThroughSequence: 256,
        appliedThroughSequence: 256,
        applicationDurationMs: 3,
      }),
    ).resolves.toEqual({ accepted: true, fenced: false, acknowledgedSequence: 256 });

    subscription.close();
    await coordinator.close();
  });

  it("splits a burst before the supervisor frame budget", async () => {
    const events = [largeEvent(1), largeEvent(2)];
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await coordinator.open({
      consumerId: "byte-bounded-consumer",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive) => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: fromSequenceExclusive,
        earliestAvailableSequence: 1,
        latestSequence: 2,
        availability: "available",
        complete: true,
        events,
      }),
    });

    const first = await takeBatch(subscription);
    expect(first.events.map((value) => value.sequence)).toEqual([1]);
    await coordinator.acknowledge({
      batchId: first.batchId,
      consumerId: first.consumerId,
      consumerGeneration: first.consumerGeneration,
      receivedThroughSequence: 1,
      appliedThroughSequence: 1,
      applicationDurationMs: 1,
    });
    const second = await takeBatch(subscription);
    expect(second.events.map((value) => value.sequence)).toEqual([2]);

    subscription.close();
    await coordinator.close();
  });
});
