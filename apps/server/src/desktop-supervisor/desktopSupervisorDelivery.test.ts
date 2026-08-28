import { describe, expect, it, vi } from "vitest";
import type { OrchestrationApplicationAckInput } from "@bigbud/contracts/orchestration/orchestration.delivery.ts";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import {
  DesktopSupervisorDeliveryCoordinator,
  type DesktopSupervisorOwner,
} from "./desktopSupervisorDelivery.ts";
import type { DesktopSupervisorEventBatch } from "./desktopSupervisorProtocol.ts";
import { DesktopSupervisorProtocolError } from "./desktopSupervisorProtocol.ts";

function event(sequence: number): OrchestrationEvent {
  return {
    sequence,
    eventId: `event-${sequence}`,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    occurredAt: "2026-08-27T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.pinned",
    payload: { threadId: "thread-1" },
  } as OrchestrationEvent;
}

function replay(events: ReadonlyArray<OrchestrationEvent>) {
  return {
    requestedFromSequenceExclusive: 0,
    retainedFromSequenceExclusive: 0,
    earliestAvailableSequence: events[0]?.sequence ?? null,
    latestSequence: events.at(-1)?.sequence ?? 0,
    availability: "available" as const,
    complete: true,
    events,
  };
}

function ackFor(
  batch: { batchId: string; consumerId: string; consumerGeneration: number },
  overrides: Partial<OrchestrationApplicationAckInput> = {},
): OrchestrationApplicationAckInput {
  return {
    batchId: batch.batchId,
    consumerId: batch.consumerId,
    consumerGeneration: batch.consumerGeneration,
    receivedThroughSequence: 1,
    appliedThroughSequence: 1,
    applicationDurationMs: 1,
    ...overrides,
  };
}

function owner(options: { readonly failDelivery?: boolean } = {}) {
  const failures = new Set<(error: Error) => void>();
  const value: DesktopSupervisorOwner = {
    attach: vi.fn(async (input) => input.appliedSequence),
    detach: vi.fn(async () => undefined),
    enqueue: vi.fn(async (batch: DesktopSupervisorEventBatch) => {
      if (options.failDelivery) throw new Error("injected process failure");
      return { type: "eventBatch" as const, value: batch };
    }),
    acknowledge: vi.fn(async (ack) => ack.appliedThroughSequence),
    heartbeat: vi.fn(async (monotonicMillis) => ({
      type: "heartbeat" as const,
      value: { monotonicMillis },
    })),
    onFailure: vi.fn((listener) => {
      failures.add(listener);
      return () => failures.delete(listener);
    }),
    onFrame: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
  return value;
}

async function waitForLive(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const lifecycle = await takeLifecycle(subscription);
    if (lifecycle.state === "live") return lifecycle;
  }
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

async function takeLifecycle(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("delivery subscription closed before a lifecycle event");
    if (item.type === "lifecycle") return item;
  }
}

describe("DesktopSupervisorDeliveryCoordinator", () => {
  it("keeps standalone delivery direct and application-acknowledged", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });
    const batch = await takeBatch(subscription);
    expect(batch.route).toBe("direct-unmanaged");
    expect(batch.events.map((entry) => entry.sequence)).toEqual([1]);
    await expect(
      coordinator.acknowledge({
        batchId: batch.batchId,
        consumerId: batch.consumerId,
        consumerGeneration: batch.consumerGeneration,
        receivedThroughSequence: 1,
        appliedThroughSequence: 1,
        applicationDurationMs: 2,
      }),
    ).resolves.toEqual({ accepted: true, fenced: false, acknowledgedSequence: 1 });
    await expect(
      coordinator.acknowledge({
        batchId: "unknown-batch",
        consumerId: batch.consumerId,
        consumerGeneration: batch.consumerGeneration,
        receivedThroughSequence: 1,
        appliedThroughSequence: 1,
        applicationDurationMs: 2,
      }),
    ).resolves.toEqual({ accepted: false, fenced: true, acknowledgedSequence: 1 });
    await coordinator.close();
  });

  it.each([
    ["direct-unmanaged", { mode: "direct-unmanaged" as const, reasonCode: "standalone" as const }],
    [
      "fallback-fenced",
      { mode: "fallback-fenced" as const, reasonCode: "binary_missing" as const },
    ],
  ])("rejects bad ACKs without advancing the %s cursor", async (_name, config) => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(config);
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });
    const batch = await takeBatch(subscription);
    const badAcks = [
      ackFor(batch, { batchId: "future-batch" }),
      ackFor(batch, { consumerId: "other-consumer" }),
      ackFor(batch, { consumerGeneration: batch.consumerGeneration + 1 }),
      ackFor(batch, { receivedThroughSequence: 2 }),
      ackFor(batch, { appliedThroughSequence: 2 }),
      ackFor(batch, { receivedThroughSequence: 0, appliedThroughSequence: 0 }),
      ackFor(batch, { receivedThroughSequence: 1, appliedThroughSequence: 0 }),
      {
        ...ackFor(batch),
        appliedThroughSequence: undefined,
      } as unknown as OrchestrationApplicationAckInput,
    ];

    for (const badAck of badAcks) {
      await expect(coordinator.acknowledge(badAck)).resolves.toEqual({
        accepted: false,
        fenced: true,
        acknowledgedSequence: 0,
      });
    }
    await expect(coordinator.acknowledge(ackFor(batch))).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 1,
    });
    await coordinator.close();
  });

  it.each([
    ["direct-unmanaged", { mode: "direct-unmanaged" as const, reasonCode: "standalone" as const }],
    [
      "fallback-fenced",
      { mode: "fallback-fenced" as const, reasonCode: "binary_missing" as const },
    ],
  ])("accepts exact duplicate ACKs idempotently on the %s route", async (_name, config) => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(config);
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1), event(2)]),
    });
    const firstBatch = await takeBatch(subscription);
    const firstAck = await coordinator.acknowledge(ackFor(firstBatch));
    await expect(coordinator.acknowledge(ackFor(firstBatch))).resolves.toEqual(firstAck);

    const secondBatch = await takeBatch(subscription);
    expect(secondBatch.route).toBe(firstBatch.route);
    expect(secondBatch.events[0]?.sequence).toBe(2);
    await coordinator.close();
  });

  it("does not switch back to supervisor delivery or advance on a fenced fallback ACK", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => {
        throw new Error("injected startup failure");
      },
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1), event(2)]),
    });
    const firstBatch = await takeBatch(subscription);
    expect(firstBatch.route).toBe("fallback-fenced");
    await expect(
      coordinator.acknowledge(ackFor(firstBatch, { appliedThroughSequence: 2 })),
    ).resolves.toEqual({ accepted: false, fenced: true, acknowledgedSequence: 0 });
    await expect(coordinator.acknowledge(ackFor(firstBatch))).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 1,
    });
    const secondBatch = await takeBatch(subscription);
    expect(secondBatch.route).toBe("fallback-fenced");
    expect(secondBatch.events[0]?.sequence).toBe(2);
    await coordinator.close();
  });

  it("publishes only the batch returned by the Rust owner", async () => {
    const rust = owner();
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });
    const batch = await takeBatch(subscription);
    expect(batch.route).toBe("supervisor");
    expect(rust.enqueue).toHaveBeenCalledOnce();
    await coordinator.acknowledge({
      batchId: batch.batchId,
      consumerId: batch.consumerId,
      consumerGeneration: batch.consumerGeneration,
      receivedThroughSequence: 1,
      appliedThroughSequence: 1,
      applicationDurationMs: 2,
    });
    expect(rust.acknowledge).toHaveBeenCalledOnce();
    await coordinator.close();
  });

  it("detaches the exact attached generation and preserves its replacement", async () => {
    const attached = new Map<string, number>();
    const rust = owner();
    vi.mocked(rust.attach).mockImplementation(async (input) => {
      attached.set(input.consumerId, input.consumerGeneration);
      return input.appliedSequence;
    });
    vi.mocked(rust.detach).mockImplementation(async (input) => {
      if (attached.get(input.consumerId) === input.consumerGeneration) {
        attached.delete(input.consumerId);
      }
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const first = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([]),
    });
    await waitForLive(first);
    const replacement = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([]),
    });
    await waitForLive(replacement);

    first.close();
    await vi.waitFor(() =>
      expect(rust.detach).toHaveBeenCalledWith({
        consumerId: "consumer-1",
        consumerGeneration: 1,
        reason: "subscription_superseded",
      }),
    );
    expect(attached.get("consumer-1")).toBe(2);

    replacement.close();
    await vi.waitFor(() => expect(attached.has("consumer-1")).toBe(false));
    await coordinator.close();
  });

  it("reattaches at a higher generation after a delivery failure", async () => {
    const first = owner({ failDelivery: true });
    const second = owner();
    const owners = [first, second];
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => owners.shift() ?? second,
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });
    const batch = await takeBatch(subscription);
    expect(batch.route).toBe("supervisor");
    expect(batch.consumerGeneration).toBe(2);
    expect(second.attach).toHaveBeenCalledWith(
      expect.objectContaining({ consumerGeneration: 2, appliedSequence: 0 }),
    );
    await coordinator.close();
  });

  it("fences exhausted Rust recovery and never switches the session back", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => {
        throw new Error("injected startup failure");
      },
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });
    const lifecycleStates: string[] = [];
    for (;;) {
      const lifecycle = await takeLifecycle(subscription);
      lifecycleStates.push(lifecycle.state);
      if (lifecycle.state === "degraded") break;
    }
    expect(lifecycleStates).toContain("connecting");
    expect(lifecycleStates).toContain("degraded");
    expect(lifecycleStates).not.toContain("incompatible");
    const batch = await takeBatch(subscription);
    expect(batch.route).toBe("fallback-fenced");
    await coordinator.acknowledge({
      batchId: batch.batchId,
      consumerId: batch.consumerId,
      consumerGeneration: batch.consumerGeneration,
      receivedThroughSequence: 1,
      appliedThroughSequence: 1,
      applicationDurationMs: 1,
    });
    await subscription.offer(event(2));
    expect((await takeBatch(subscription)).route).toBe("fallback-fenced");
    await coordinator.close();
  });

  it("reports incompatible supervisor protocol without falling back", async () => {
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => {
        throw new DesktopSupervisorProtocolError(
          "Desktop supervisor protocol is incompatible",
          "incompatible_protocol",
        );
      },
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => replay([event(1)]),
    });

    const lifecycle = await takeLifecycle(subscription);
    expect(lifecycle.state).toBe("connecting");
    expect((await takeLifecycle(subscription)).state).toBe("connecting");
    const incompatible = await takeLifecycle(subscription);
    expect(incompatible).toMatchObject({
      route: "supervisor",
      state: "incompatible",
      reasonCode: "incompatible_protocol",
    });
    await expect(subscription.take()).resolves.toBeNull();
    await coordinator.close();
  });
});
