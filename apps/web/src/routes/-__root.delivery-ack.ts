import type {
  OrchestrationApplicationAckResult,
  OrchestrationDeliveryBatch,
} from "@bigbud/contracts";

export async function applyAndAcknowledgeDeliveryBatch(input: {
  readonly batch: OrchestrationDeliveryBatch;
  readonly apply: () => Promise<{ readonly appliedThroughSequence: number }>;
  readonly acknowledge: (input: {
    readonly batchId: string;
    readonly consumerId: string;
    readonly consumerGeneration: number;
    readonly receivedThroughSequence: number;
    readonly appliedThroughSequence: number;
    readonly applicationDurationMs: number;
  }) => Promise<OrchestrationApplicationAckResult>;
  readonly now?: () => number;
}): Promise<OrchestrationApplicationAckResult | null> {
  const lastEvent = input.batch.events.at(-1);
  if (!lastEvent) return null;
  const now = input.now ?? (() => performance.now());
  const startedAt = now();
  const { appliedThroughSequence } = await input.apply();
  if (appliedThroughSequence !== lastEvent.sequence) {
    throw new Error(
      `Delivery batch application stopped at sequence ${appliedThroughSequence}; expected ${lastEvent.sequence}.`,
    );
  }
  const result = await input.acknowledge({
    batchId: input.batch.batchId,
    consumerId: input.batch.consumerId,
    consumerGeneration: input.batch.consumerGeneration,
    receivedThroughSequence: lastEvent.sequence,
    appliedThroughSequence,
    applicationDurationMs: Math.max(0, Math.round(now() - startedAt)),
  });
  if (!result.accepted || result.fenced) {
    throw new Error("Delivery acknowledgement was fenced; resubscription is required.");
  }
  return result;
}
