import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";
import { DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY } from "./desktopSupervisorConfig.ts";

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: `replay-event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-replay",
    occurredAt: "2026-08-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.pinned",
    payload: { threadId: "thread-replay" },
  } as OrchestrationEvent;
}

async function takeBatch(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("delivery subscription closed before a batch");
    if (item.type === "batch") return item;
  }
}

describe("DesktopSupervisorDelivery replay", () => {
  it("pages replay until the retained range is complete", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const readReplay = vi.fn(async (fromSequenceExclusive: number, limit = 1_000) => {
      const remaining = Array.from({ length: 1_001 }, (_, index) => event(index + 1)).filter(
        (candidate) => candidate.sequence > fromSequenceExclusive,
      );
      const events = remaining.slice(0, limit);
      return {
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: 1_001,
        availability: "available" as const,
        complete: events.at(-1)?.sequence === 1_001,
        events,
      };
    });
    const subscription = await coordinator.open({
      consumerId: "consumer-replay",
      appliedSequence: 0,
      readReplay,
    });

    const batch = await takeBatch(subscription);

    expect(batch.events[0]?.sequence).toBe(1);
    expect(readReplay).toHaveBeenCalledTimes(2);
    expect(readReplay).toHaveBeenCalledWith(0, 1_000);
    expect(readReplay).toHaveBeenCalledWith(1_000, 1_000);
    await coordinator.close();
  });

  it("does not let live delivery bridge an unresolved gap", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await coordinator.open({
      consumerId: "consumer-gap",
      appliedSequence: 0,
      readReplay: async () => ({
        requestedFromSequenceExclusive: 0,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: null,
        latestSequence: 0,
        availability: "available" as const,
        complete: true,
        events: [],
      }),
    });

    await subscription.offer(event(2));
    const item = await subscription.take();

    expect(item?.type).not.toBe("batch");
    await coordinator.close();
  });

  it("fences replay that exceeds the explicit in-memory buffer bound", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const latestSequence = DESKTOP_SUPERVISOR_REPLAY_BUFFER_CAPACITY + 1;
    const subscription = await coordinator.open({
      consumerId: "consumer-bounded-replay",
      appliedSequence: 0,
      readReplay: async (fromSequenceExclusive, limit = 1_000) => {
        const events = Array.from(
          { length: Math.min(limit, latestSequence - fromSequenceExclusive) },
          (_, index) => event(fromSequenceExclusive + index + 1),
        );
        return {
          requestedFromSequenceExclusive: fromSequenceExclusive,
          retainedFromSequenceExclusive: 0,
          earliestAvailableSequence: 1,
          latestSequence,
          availability: "available" as const,
          complete: events.at(-1)?.sequence === latestSequence,
          events,
        };
      },
    });

    let sawReplayGapFallback = false;
    for (let index = 0; index < 4; index += 1) {
      const item = await subscription.take();
      if (
        item?.type === "lifecycle" &&
        item.state === "fallback" &&
        item.reasonCode === "replay_gap"
      ) {
        sawReplayGapFallback = true;
        break;
      }
    }

    expect(sawReplayGapFallback).toBe(true);
    await coordinator.close();
  });

  it("resumes fallback delivery after bounded recovery replaces a replay gap", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "fallback-fenced",
      reasonCode: "binary_missing",
    });
    const subscription = await coordinator.open({
      consumerId: "consumer-recovered-gap",
      appliedSequence: 0,
      readReplay: async () => ({
        requestedFromSequenceExclusive: 0,
        retainedFromSequenceExclusive: 5,
        earliestAvailableSequence: 6,
        latestSequence: 5,
        availability: "gap" as const,
        complete: false,
        events: [],
      }),
    });

    for (;;) {
      const item = await subscription.take();
      if (
        item?.type === "lifecycle" &&
        item.state === "fallback" &&
        item.reasonCode === "replay_gap"
      ) {
        break;
      }
    }

    await subscription.offer(event(6));
    const batch = await takeBatch(subscription);

    expect(batch.route).toBe("fallback-fenced");
    expect(batch.events[0]?.sequence).toBe(6);
    await expect(
      coordinator.acknowledge({
        batchId: batch.batchId,
        consumerId: batch.consumerId,
        consumerGeneration: batch.consumerGeneration,
        receivedThroughSequence: 6,
        appliedThroughSequence: 6,
        applicationDurationMs: 2,
      }),
    ).resolves.toEqual({ accepted: true, fenced: false, acknowledgedSequence: 6 });
    await coordinator.close();
  });
});
