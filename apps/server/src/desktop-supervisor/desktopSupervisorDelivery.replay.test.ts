import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import { DesktopSupervisorDeliveryCoordinator } from "./desktopSupervisorDelivery.ts";

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

  it("requests and persists a projection baseline when replay exceeds the buffer bound", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const appliedSequence = 496_663;
    const latestSequence = 4_530_348;
    const subscription = await coordinator.open({
      consumerId: "consumer-bounded-replay",
      appliedSequence,
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
          complete:
            fromSequenceExclusive >= latestSequence || events.at(-1)?.sequence === latestSequence,
          events,
        };
      },
    });

    let recovery: Extract<
      Awaited<ReturnType<typeof subscription.take>>,
      { type: "recovery" }
    > | null = null;
    let sawFallback = false;
    for (let index = 0; index < 8; index += 1) {
      const item = await subscription.take();
      if (item?.type === "lifecycle" && item.state === "fallback") sawFallback = true;
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }

    expect(recovery?.reasonCode).toBe("replay_budget_exceeded");
    expect(sawFallback).toBe(false);
    const result = await coordinator.acknowledgeBaseline({
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: latestSequence,
      applicationDurationMs: 10,
    });
    expect(result).toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence,
    });
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "lifecycle" && item.state === "live") break;
    }

    const replacement = await coordinator.open({
      consumerId: "consumer-bounded-replay",
      appliedSequence: result.acknowledgedSequence,
      readReplay: async (fromSequenceExclusive) => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence,
        availability: "available" as const,
        complete: true,
        events: [],
      }),
    });
    for (;;) {
      const item = await replacement.take();
      expect(item?.type).not.toBe("recovery");
      if (item?.type === "lifecycle" && item.state === "live") break;
    }
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
      readReplay: async (fromSequenceExclusive) => ({
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 5,
        earliestAvailableSequence: fromSequenceExclusive < 5 ? 6 : null,
        latestSequence: 5,
        availability: fromSequenceExclusive < 5 ? ("gap" as const) : ("available" as const),
        complete: fromSequenceExclusive >= 5,
        events: [],
      }),
    });

    let recovery: Extract<Awaited<ReturnType<typeof subscription.take>>, { type: "recovery" }>;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "recovery") {
        recovery = item;
        break;
      }
    }

    await coordinator.acknowledgeBaseline({
      recoveryId: recovery!.recoveryId,
      consumerId: recovery!.consumerId,
      consumerGeneration: recovery!.consumerGeneration,
      serverEpoch: recovery!.serverEpoch,
      appliedProjectionSequence: 5,
      applicationDurationMs: 1,
    });

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
