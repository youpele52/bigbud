import { describe, expect, it, vi } from "vitest";
import type { OrchestrationDeliveryBatch } from "@bigbud/contracts";

import { applyAndAcknowledgeDeliveryBatch } from "./-__root.delivery-ack";

function batch(): OrchestrationDeliveryBatch {
  return {
    type: "batch",
    route: "supervisor",
    consumerId: "consumer-1",
    consumerGeneration: 3,
    serverEpoch: "epoch-1",
    subscriptionGeneration: 3,
    batchId: "batch-1",
    events: [{ sequence: 11 } as never],
  };
}

function multiEventBatch(): OrchestrationDeliveryBatch {
  return {
    ...batch(),
    events: [{ sequence: 11 } as never, { sequence: 12 } as never],
  };
}

describe("applyAndAcknowledgeDeliveryBatch", () => {
  it("ACKs only after serialized application and ownership reconciliation settle", async () => {
    let resolveApplication:
      | ((value: { readonly appliedThroughSequence: number }) => void)
      | undefined;
    const apply = vi.fn(
      () =>
        new Promise<{ readonly appliedThroughSequence: number }>((resolve) => {
          resolveApplication = resolve;
        }),
    );
    const acknowledge = vi.fn(async () => ({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 11,
    }));
    const operation = applyAndAcknowledgeDeliveryBatch({
      batch: batch(),
      apply,
      acknowledge,
      now: vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(107),
    });
    await Promise.resolve();
    expect(acknowledge).not.toHaveBeenCalled();
    resolveApplication?.({ appliedThroughSequence: 11 });
    await expect(operation).resolves.toEqual({
      accepted: true,
      fenced: false,
      acknowledgedSequence: 11,
    });
    expect(acknowledge).toHaveBeenCalledWith(
      expect.objectContaining({ appliedThroughSequence: 11, applicationDurationMs: 7 }),
    );
  });

  it("does not ACK failed application", async () => {
    const acknowledge = vi.fn();
    await expect(
      applyAndAcknowledgeDeliveryBatch({
        batch: batch(),
        apply: async () => {
          throw new Error("ownership reconciliation failed");
        },
        acknowledge,
      }),
    ).rejects.toThrow("ownership reconciliation failed");
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does not ACK when only part of a delivered batch was applied", async () => {
    const acknowledge = vi.fn();

    await expect(
      applyAndAcknowledgeDeliveryBatch({
        batch: multiEventBatch(),
        apply: async () => ({ appliedThroughSequence: 11 }),
        acknowledge,
      }),
    ).rejects.toThrow("application stopped at sequence 11; expected 12");

    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("rejects a fenced application acknowledgement", async () => {
    await expect(
      applyAndAcknowledgeDeliveryBatch({
        batch: batch(),
        apply: async () => ({ appliedThroughSequence: 11 }),
        acknowledge: async () => ({
          accepted: false,
          fenced: true,
          acknowledgedSequence: 10,
        }),
      }),
    ).rejects.toThrow("Delivery acknowledgement was fenced");
  });
});
