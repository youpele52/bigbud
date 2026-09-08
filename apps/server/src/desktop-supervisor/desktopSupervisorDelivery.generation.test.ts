import { describe, expect, it, vi } from "vitest";
import { EventId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";

import {
  DesktopSupervisorDeliveryCoordinator,
  type DesktopSupervisorOwner,
} from "./desktopSupervisorDelivery.ts";
import type {
  DesktopSupervisorEventBatch,
  DesktopSupervisorFrame,
} from "./desktopSupervisorProtocol.ts";

const event = {
  sequence: 1,
  eventId: "event-1",
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

const ignoreFrame = (_frame: DesktopSupervisorFrame): boolean => false;

function owner(failDelivery = false) {
  let frameListener: (frame: DesktopSupervisorFrame) => boolean = ignoreFrame;
  const value: DesktopSupervisorOwner = {
    attach: vi.fn(async (input) => input.appliedSequence),
    detach: vi.fn(async () => undefined),
    enqueue: vi.fn(async (batch: DesktopSupervisorEventBatch) => {
      if (failDelivery) throw new Error("injected process failure");
      return { type: "eventBatch" as const, value: batch };
    }),
    acknowledge: vi.fn(async (ack) => ack.appliedThroughSequence),
    installBaseline: vi.fn(async (baseline) => baseline.appliedProjectionSequence),
    heartbeat: vi.fn(async (monotonicMillis) => ({
      type: "heartbeat" as const,
      value: { monotonicMillis },
    })),
    onFailure: vi.fn(() => () => undefined),
    onFrame: vi.fn((listener) => {
      frameListener = listener;
      return () => undefined;
    }),
    close: vi.fn(async () => undefined),
  };
  return { value, emitFrame: (frame: DesktopSupervisorFrame) => frameListener(frame) };
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

describe("DesktopSupervisorDeliveryCoordinator generation routing", () => {
  it("fences a supervised ACK response that arrives after session supersession", async () => {
    const rust = owner();
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => (releaseAck = resolve));
    vi.mocked(rust.value.acknowledge).mockImplementation(async (ack) => {
      await ackGate;
      return ack.appliedThroughSequence;
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust.value,
    );
    const readReplay = async () => ({
      requestedFromSequenceExclusive: 0,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: 1,
      availability: "available" as const,
      complete: true,
      events: [event],
    });
    const first = await coordinator.open({
      consumerId: "superseded-ack",
      appliedSequence: 0,
      readReplay,
    });
    const batch = await takeBatch(first);
    const acknowledgement = coordinator.acknowledge({
      batchId: batch.batchId,
      consumerId: batch.consumerId,
      consumerGeneration: batch.consumerGeneration,
      receivedThroughSequence: 1,
      appliedThroughSequence: 1,
      applicationDurationMs: 1,
    });
    await vi.waitFor(() => expect(rust.value.acknowledge).toHaveBeenCalledOnce());
    await coordinator.open({
      consumerId: "superseded-ack",
      appliedSequence: 0,
      readReplay,
    });
    releaseAck();

    await expect(acknowledgement).resolves.toEqual({
      accepted: false,
      fenced: true,
      acknowledgedSequence: 0,
    });
    await coordinator.close();
  });

  it("ignores a stale recovery frame after replacing a failed generation", async () => {
    const failed = owner(true);
    const replacement = owner();
    const owners = [failed.value, replacement.value];
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => owners.shift() ?? replacement.value,
    );
    const subscription = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay: async () => ({
        requestedFromSequenceExclusive: 0,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: 1,
        availability: "available",
        complete: true,
        events: [event],
      }),
    });
    let batch;
    for (;;) {
      const item = await subscription.take();
      if (item?.type === "batch") {
        batch = item;
        break;
      }
    }
    expect(batch.consumerGeneration).toBe(2);
    replacement.emitFrame({
      type: "recoveryRequired",
      value: {
        consumerId: "consumer-1",
        consumerGeneration: 1,
        kind: 1,
        fromSequenceExclusive: 0,
        reasonCode: "stale_generation",
      },
    });

    await expect(
      coordinator.acknowledge({
        batchId: batch.batchId,
        consumerId: batch.consumerId,
        consumerGeneration: batch.consumerGeneration,
        receivedThroughSequence: 1,
        appliedThroughSequence: 1,
        applicationDurationMs: 1,
      }),
    ).resolves.toMatchObject({ accepted: true, fenced: false });
    await coordinator.close();
  });

  it("supersedes an overlapping owner without allowing stale recovery to fence it", async () => {
    let attachedGeneration: number | null = null;
    let highestGeneration = 0;
    let releaseOldDetach!: () => void;
    const oldDetachGate = new Promise<void>((resolve) => {
      releaseOldDetach = resolve;
    });
    const rust = owner().value;
    vi.mocked(rust.attach).mockImplementation(async (input) => {
      if (input.consumerGeneration <= highestGeneration) {
        throw new Error("stale consumer generation");
      }
      highestGeneration = input.consumerGeneration;
      attachedGeneration = input.consumerGeneration;
      return input.appliedSequence;
    });
    vi.mocked(rust.detach).mockImplementation(async (input) => {
      await oldDetachGate;
      if (attachedGeneration === input.consumerGeneration) attachedGeneration = null;
    });
    vi.mocked(rust.enqueue).mockImplementation(async (batch) => {
      if (batch.consumerGeneration !== attachedGeneration) {
        throw new Error("stale consumer generation");
      }
      return { type: "eventBatch", value: batch };
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const readReplay = async () => ({
      requestedFromSequenceExclusive: 0,
      retainedFromSequenceExclusive: 0,
      earliestAvailableSequence: 1,
      latestSequence: 1,
      availability: "available" as const,
      complete: true,
      events: [event],
    });
    const first = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    expect((await takeBatch(first)).consumerGeneration).toBe(1);

    const replacement = await coordinator.open({
      consumerId: "consumer-1",
      appliedSequence: 0,
      readReplay,
    });
    const replacementBatch = await takeBatch(replacement);
    expect(replacementBatch.consumerGeneration).toBe(2);
    await expect(first.take()).resolves.toBeNull();
    await expect(
      first.offer({ ...event, sequence: 2, eventId: EventId.makeUnsafe("event-2") }),
    ).resolves.toBe(false);
    await vi.waitFor(() => expect(rust.attach).toHaveBeenCalledTimes(2));
    expect(attachedGeneration).toBe(2);
    expect(rust.close).not.toHaveBeenCalled();
    releaseOldDetach();
    await vi.waitFor(() => expect(rust.detach).toHaveBeenCalled());
    expect(attachedGeneration).toBe(2);

    await expect(
      coordinator.acknowledge({
        batchId: replacementBatch.batchId,
        consumerId: replacementBatch.consumerId,
        consumerGeneration: replacementBatch.consumerGeneration,
        receivedThroughSequence: 1,
        appliedThroughSequence: 1,
        applicationDurationMs: 1,
      }),
    ).resolves.toMatchObject({ accepted: true, fenced: false });
    const nextEvent = {
      ...event,
      sequence: 2,
      eventId: EventId.makeUnsafe("event-2"),
    };
    await expect(first.offer(nextEvent)).resolves.toBe(false);
    await expect(replacement.offer(nextEvent)).resolves.toBe(true);
    const nextBatch = await takeBatch(replacement);
    expect(nextBatch.consumerGeneration).toBe(2);
    expect(nextBatch.events.map((entry) => entry.sequence)).toEqual([2]);
    expect(rust.attach).toHaveBeenCalledTimes(2);
    expect(rust.close).not.toHaveBeenCalled();
    await coordinator.close();
  });
});
