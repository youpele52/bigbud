import { describe, expect, it, vi } from "vitest";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReplayEventsResult } from "@bigbud/contracts/orchestration/orchestration.rpc.ts";

import {
  DesktopSupervisorDeliveryCoordinator,
  type DesktopSupervisorOwner,
} from "./desktopSupervisorDelivery.ts";
import { DESKTOP_SUPERVISOR_BASELINE_ACK_TIMEOUT_MS } from "./desktopSupervisorConfig.ts";
import { DesktopSupervisorProtocolError } from "./desktopSupervisorProtocol.ts";

function event(sequence: number): OrchestrationEvent {
  return { sequence } as OrchestrationEvent;
}

function replayReader(latestSequence: number) {
  return vi.fn(
    async (
      fromSequenceExclusive: number,
      limit = 1_000,
    ): Promise<OrchestrationReplayEventsResult> => {
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
  );
}

async function takeRecovery(
  subscription: Awaited<ReturnType<DesktopSupervisorDeliveryCoordinator["open"]>>,
) {
  for (;;) {
    const item = await subscription.take();
    if (!item) throw new Error("subscription closed before recovery");
    if (item.type === "recovery") return item;
  }
}

function owner(): DesktopSupervisorOwner {
  return {
    attach: vi.fn(async (input) => input.appliedSequence),
    detach: vi.fn(async () => undefined),
    enqueue: vi.fn(async (batch) => ({ type: "eventBatch" as const, value: batch })),
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

describe("DesktopSupervisorDelivery baseline reliability", () => {
  it("closes a recovery subscription when its baseline acknowledgement never arrives", async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new DesktopSupervisorDeliveryCoordinator({
        mode: "direct-unmanaged",
        reasonCode: "standalone",
      });
      const subscription = await coordinator.open({
        consumerId: "baseline-timeout",
        appliedSequence: 0,
        readReplay: replayReader(10_000),
      });
      await takeRecovery(subscription);

      await vi.advanceTimersByTimeAsync(DESKTOP_SUPERVISOR_BASELINE_ACK_TIMEOUT_MS);
      await expect(subscription.take()).resolves.toBeNull();
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a stale browser epoch before canonical inspection", async () => {
    const readReplay = replayReader(10_000);
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const recovery = await takeRecovery(
      await coordinator.open({ consumerId: "stale-epoch", appliedSequence: 0, readReplay }),
    );
    readReplay.mockClear();

    await expect(
      coordinator.acknowledgeBaseline({
        recoveryId: recovery.recoveryId,
        consumerId: recovery.consumerId,
        consumerGeneration: recovery.consumerGeneration,
        serverEpoch: "stale-epoch",
        appliedProjectionSequence: recovery.targetSequence,
        applicationDurationMs: 1,
      }),
    ).resolves.toEqual({ accepted: false, fenced: true, acknowledgedSequence: 0 });
    expect(readReplay).not.toHaveBeenCalled();
    await coordinator.close();
  });

  it("reports a zero cursor rejection before accepting a valid bounded suffix", async () => {
    const latestSequence = 10_000;
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const recovery = await takeRecovery(
      await coordinator.open({
        consumerId: "bounded-suffix",
        appliedSequence: 0,
        readReplay: replayReader(latestSequence),
      }),
    );
    const acknowledge = (appliedProjectionSequence: number) =>
      coordinator.acknowledgeBaseline({
        recoveryId: recovery.recoveryId,
        consumerId: recovery.consumerId,
        consumerGeneration: recovery.consumerGeneration,
        serverEpoch: recovery.serverEpoch,
        appliedProjectionSequence,
        applicationDurationMs: 1,
      });

    await expect(acknowledge(latestSequence - 4_001)).resolves.toEqual({
      accepted: false,
      fenced: false,
      acknowledgedSequence: 0,
    });
    await expect(acknowledge(latestSequence - 4_000)).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence - 4_000,
    });
    await coordinator.close();
  });

  it("rejects a baseline whose canonical suffix is unavailable", async () => {
    const readReplay = replayReader(10_000);
    readReplay.mockImplementation(async (fromSequenceExclusive, limit = 1_000) => {
      if (fromSequenceExclusive === 6_000) {
        return {
          requestedFromSequenceExclusive: 6_000,
          retainedFromSequenceExclusive: 6_001,
          earliestAvailableSequence: 6_002,
          latestSequence: 10_000,
          availability: "gap",
          complete: false,
          events: [],
        };
      }
      const events = Array.from(
        { length: Math.min(limit, 10_000 - fromSequenceExclusive) },
        (_, index) => event(fromSequenceExclusive + index + 1),
      );
      return {
        requestedFromSequenceExclusive: fromSequenceExclusive,
        retainedFromSequenceExclusive: 0,
        earliestAvailableSequence: 1,
        latestSequence: 10_000,
        availability: "available",
        complete: events.at(-1)?.sequence === 10_000,
        events,
      };
    });
    const coordinator = new DesktopSupervisorDeliveryCoordinator({
      mode: "direct-unmanaged",
      reasonCode: "standalone",
    });
    const recovery = await takeRecovery(
      await coordinator.open({ consumerId: "suffix-gap", appliedSequence: 0, readReplay }),
    );

    await expect(
      coordinator.acknowledgeBaseline({
        recoveryId: recovery.recoveryId,
        consumerId: recovery.consumerId,
        consumerGeneration: recovery.consumerGeneration,
        serverEpoch: recovery.serverEpoch,
        appliedProjectionSequence: 6_000,
        applicationDurationMs: 1,
      }),
    ).resolves.toEqual({ accepted: false, fenced: false, acknowledgedSequence: 0 });
    await coordinator.close();
  });

  it("retries an ambiguous supervised install with the same identity", async () => {
    const rust = owner();
    vi.mocked(rust.installBaseline)
      .mockRejectedValueOnce(new DesktopSupervisorProtocolError("response lost", "timeout"))
      .mockImplementation(async (baseline) => baseline.appliedProjectionSequence);
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      async () => rust,
    );
    const latestSequence = 4_530_348;
    const recovery = await takeRecovery(
      await coordinator.open({
        consumerId: "real-gap-supervised",
        appliedSequence: 496_663,
        readReplay: replayReader(latestSequence),
      }),
    );
    const input = {
      recoveryId: recovery.recoveryId,
      consumerId: recovery.consumerId,
      consumerGeneration: recovery.consumerGeneration,
      serverEpoch: recovery.serverEpoch,
      appliedProjectionSequence: latestSequence,
      applicationDurationMs: 1,
    };

    await expect(coordinator.acknowledgeBaseline(input)).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence,
    });
    expect(rust.installBaseline).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rust.installBaseline).mock.calls[0]?.[0]).toEqual(input);
    expect(vi.mocked(rust.installBaseline).mock.calls[1]?.[0]).toEqual(input);
    await coordinator.close();
  });

  it("reattaches before installing a baseline after supervisor replacement", async () => {
    const first = owner();
    const second = owner();
    const ownerFactory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const coordinator = new DesktopSupervisorDeliveryCoordinator(
      { mode: "supervisor", binaryPath: "/fixture/supervisor" },
      ownerFactory,
    );
    const latestSequence = 10_000;
    const recovery = await takeRecovery(
      await coordinator.open({
        consumerId: "replacement-during-baseline",
        appliedSequence: 0,
        readReplay: replayReader(latestSequence),
      }),
    );
    const failureListener = vi.mocked(first.onFailure).mock.calls[0]?.[0];
    expect(failureListener).toBeDefined();
    failureListener?.(new Error("supervisor exited"));

    await expect(
      coordinator.acknowledgeBaseline({
        recoveryId: recovery.recoveryId,
        consumerId: recovery.consumerId,
        consumerGeneration: recovery.consumerGeneration,
        serverEpoch: recovery.serverEpoch,
        appliedProjectionSequence: latestSequence,
        applicationDurationMs: 1,
      }),
    ).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: latestSequence,
    });
    expect(second.attach).toHaveBeenCalledWith({
      consumerId: recovery.consumerId,
      consumerGeneration: recovery.consumerGeneration,
      serverEpoch: recovery.serverEpoch,
      appliedSequence: recovery.acknowledgedSequence,
    });
    expect(second.installBaseline).toHaveBeenCalledOnce();
    await coordinator.close();
  });
});
