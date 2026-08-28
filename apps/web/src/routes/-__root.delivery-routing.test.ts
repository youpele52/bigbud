import type { OrchestrationDeliveryBatch } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import { routeOrchestrationDeliveryBatch } from "./-__root.delivery-routing";

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
