import type { OrchestrationDeliveryBatch, OrchestrationDeliveryRecovery } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  recoverAndAcknowledgeDeliveryBaseline,
  routeOrchestrationDeliveryBatch,
} from "./-__root.delivery-routing";

function batch(): OrchestrationDeliveryBatch {
  return {
    type: "batch",
    route: "supervisor",
    consumerId: "consumer-1",
    consumerGeneration: 3,
    serverEpoch: "epoch-1",
    subscriptionGeneration: 3,
    batchId: "batch-1",
    events: [{ sequence: 11 } as never, { sequence: 12 } as never],
  };
}

describe("routeOrchestrationDeliveryBatch", () => {
  it("ACKs the projection baseline only after bounded recovery succeeds", async () => {
    const recovery = {
      type: "recovery",
      route: "direct-unmanaged",
      recoveryId: "recovery-1",
      consumerId: "consumer-1",
      consumerGeneration: 3,
      serverEpoch: "epoch-1",
      acknowledgedSequence: 496_663,
      targetSequence: 4_530_348,
      reasonCode: "replay_budget_exceeded",
    } satisfies OrchestrationDeliveryRecovery;
    const acknowledge = vi.fn(async () => ({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 4_530_348,
    }));

    await recoverAndAcknowledgeDeliveryBaseline({
      recovery,
      recover: vi.fn(async () => 4_530_348),
      acknowledge,
      now: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(15),
    });

    expect(acknowledge).toHaveBeenCalledWith({
      recoveryId: "recovery-1",
      consumerId: "consumer-1",
      consumerGeneration: 3,
      serverEpoch: "epoch-1",
      appliedProjectionSequence: 4_530_348,
      applicationDurationMs: 5,
    });
  });

  it("retries a lost baseline ACK response with the same identity", async () => {
    const recovery = {
      type: "recovery",
      route: "supervisor",
      recoveryId: "recovery-retry",
      consumerId: "consumer-1",
      consumerGeneration: 3,
      serverEpoch: "epoch-1",
      acknowledgedSequence: 4,
      targetSequence: 10,
      reasonCode: "replay_budget_exceeded",
    } satisfies OrchestrationDeliveryRecovery;
    const acknowledge = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ accepted: true, fenced: false, acknowledgedSequence: 10 });

    await recoverAndAcknowledgeDeliveryBaseline({
      recovery,
      recover: vi.fn(async () => 10),
      acknowledge,
      sleep: vi.fn(async () => undefined),
    });

    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect(acknowledge.mock.calls[0]?.[0]).toEqual(acknowledge.mock.calls[1]?.[0]);
  });

  it("runs one more bounded bootstrap when the canonical suffix is not authorized", async () => {
    const recovery = {
      type: "recovery",
      route: "direct-unmanaged",
      recoveryId: "recovery-refresh",
      consumerId: "consumer-1",
      consumerGeneration: 3,
      serverEpoch: "epoch-1",
      acknowledgedSequence: 4,
      targetSequence: 10,
      reasonCode: "replay_budget_exceeded",
    } satisfies OrchestrationDeliveryRecovery;
    const recover = vi.fn().mockResolvedValueOnce(5).mockResolvedValueOnce(10);
    const acknowledge = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, fenced: false, acknowledgedSequence: 4 })
      .mockResolvedValueOnce({ accepted: true, fenced: false, acknowledgedSequence: 10 });

    await recoverAndAcknowledgeDeliveryBaseline({ recovery, recover, acknowledge });

    expect(recover).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("stops after bounded non-replayable baseline attempts without reconnect looping", async () => {
    const rejected = { accepted: false, fenced: false, acknowledgedSequence: 4 } as const;
    const recover = vi.fn(async () => 5);
    const acknowledge = vi.fn(async () => rejected);

    await expect(
      recoverAndAcknowledgeDeliveryBaseline({
        recovery: {
          type: "recovery",
          route: "direct-unmanaged",
          recoveryId: "recovery-bounded",
          consumerId: "consumer-1",
          consumerGeneration: 3,
          serverEpoch: "epoch-1",
          acknowledgedSequence: 4,
          targetSequence: 10,
          reasonCode: "replay_unavailable",
        },
        recover,
        acknowledge,
      }),
    ).rejects.toThrow("Delivery baseline acknowledgement was rejected at sequence 4.");
    expect(recover).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledTimes(2);
  });

  it("cancels baseline retries after renderer disposal", async () => {
    let disposed = false;
    const acknowledge = vi.fn(async () => {
      disposed = true;
      throw new Error("response lost");
    });

    await expect(
      recoverAndAcknowledgeDeliveryBaseline({
        recovery: {
          type: "recovery",
          route: "direct-unmanaged",
          recoveryId: "recovery-cancel",
          consumerId: "consumer-1",
          consumerGeneration: 3,
          serverEpoch: "epoch-1",
          acknowledgedSequence: 4,
          targetSequence: 10,
          reasonCode: "replay_unavailable",
        },
        recover: vi.fn(async () => 10),
        acknowledge,
        shouldAbort: () => disposed,
        sleep: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("response lost");
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("cancels an in-flight baseline acknowledgement after renderer disposal", async () => {
    const controller = new AbortController();
    const acknowledge = vi.fn(() => new Promise<never>(() => undefined));
    const operation = recoverAndAcknowledgeDeliveryBaseline({
      recovery: {
        type: "recovery",
        route: "direct-unmanaged",
        recoveryId: "recovery-in-flight-cancel",
        consumerId: "consumer-1",
        consumerGeneration: 3,
        serverEpoch: "epoch-1",
        acknowledgedSequence: 4,
        targetSequence: 10,
        reasonCode: "replay_unavailable",
      },
      recover: vi.fn(async () => 10),
      acknowledge,
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toThrow("acknowledgement was cancelled");
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("bounds a baseline acknowledgement that never settles", async () => {
    const acknowledge = vi.fn(() => new Promise<never>(() => undefined));

    await expect(
      recoverAndAcknowledgeDeliveryBaseline({
        recovery: {
          type: "recovery",
          route: "direct-unmanaged",
          recoveryId: "recovery-timeout",
          consumerId: "consumer-1",
          consumerGeneration: 3,
          serverEpoch: "epoch-1",
          acknowledgedSequence: 4,
          targetSequence: 10,
          reasonCode: "replay_unavailable",
        },
        recover: vi.fn(async () => 10),
        acknowledge,
        acknowledgementTimeoutMs: 1,
        sleep: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("acknowledgement timed out");
    expect(acknowledge).toHaveBeenCalledTimes(3);
  });

  it("retains a background reply until recovery completes, then applies and ACKs it", async () => {
    let releaseRecovery: (() => void) | undefined;
    const recover = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRecovery = resolve;
        }),
    );
    const apply = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => ({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 12,
    }));

    const operation = routeOrchestrationDeliveryBatch({
      batch: batch(),
      classify: () => "defer",
      recover,
      apply,
      getAppliedSequence: () => 12,
      acknowledge,
    });
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
    expect(apply).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();

    releaseRecovery?.();
    await operation;

    expect(apply).toHaveBeenCalledWith(batch().events);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("still admits a duplicate-leading batch so later new events are not skipped", async () => {
    const apply = vi.fn(async () => undefined);

    await routeOrchestrationDeliveryBatch({
      batch: batch(),
      classify: () => "ignore",
      recover: vi.fn(),
      apply,
      getAppliedSequence: () => 12,
      acknowledge: vi.fn(async () => ({
        accepted: true,
        fenced: false,
        acknowledgedSequence: 12,
      })),
    });

    expect(apply).toHaveBeenCalledWith(batch().events);
  });

  it("ACKs only the delivered batch when recovery has already applied later events", async () => {
    const acknowledge = vi.fn(async () => ({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 12,
    }));

    await routeOrchestrationDeliveryBatch({
      batch: batch(),
      classify: () => "recover",
      recover: vi.fn(async () => undefined),
      apply: vi.fn(async () => undefined),
      getAppliedSequence: () => 14,
      acknowledge,
    });

    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        receivedThroughSequence: 12,
        appliedThroughSequence: 12,
      }),
    );
  });
});
