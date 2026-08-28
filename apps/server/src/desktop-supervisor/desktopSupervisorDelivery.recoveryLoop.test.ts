import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import {
  DesktopSupervisorDeliveryCoordinator,
  type DesktopSupervisorOwner,
} from "./desktopSupervisorDelivery.ts";
import type { DesktopSupervisorEventBatch } from "./desktopSupervisorProtocol.ts";

const event = {
  sequence: 1,
  eventId: "event-recovery-loop",
  aggregateKind: "thread",
  aggregateId: "thread-recovery-loop",
  occurredAt: "2026-08-27T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.pinned",
  payload: { threadId: "thread-recovery-loop" },
} as OrchestrationEvent;

function failingOwner(): DesktopSupervisorOwner {
  return {
    attach: vi.fn(async (input) => input.appliedSequence),
    detach: vi.fn(async () => undefined),
    enqueue: vi.fn(async (_batch: DesktopSupervisorEventBatch) => {
      throw new Error("injected repeated delivery failure");
    }),
    acknowledge: vi.fn(async (ack) => ack.appliedThroughSequence),
    installBaseline: vi.fn(async (baseline) => baseline.appliedProjectionSequence),
    heartbeat: vi.fn(async (monotonicMillis) => ({
      type: "heartbeat" as const,
      value: { monotonicMillis },
    })),
    onFailure: vi.fn(() => () => undefined),
    onFrame: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("DesktopSupervisorDelivery repeated failure recovery", () => {
  it("enters fenced fallback when reattach succeeds but delivery repeatedly fails", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => failingOwner(),
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-recovery-loop",
      appliedSequence: 0,
      readReplay: async () => ({
        requestedFromSequenceExclusive: 0,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: 1,
        availability: "available" as const,
        complete: true,
        events: [event],
      }),
    });

    const states: string[] = [];
    for (let index = 0; index < 12 && !states.includes("fallback"); index += 1) {
      const item = await subscription.take();
      if (!item) break;
      if (item.type === "lifecycle") states.push(item.state);
    }

    expect(states).toContain("fallback");
    await coordinator.close();
  });
});
