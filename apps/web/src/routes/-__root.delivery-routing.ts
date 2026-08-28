import type { OrchestrationDeliveryBatch, OrchestrationEvent } from "@bigbud/contracts";

import { applyAndAcknowledgeDeliveryBatch } from "./-__root.delivery-ack";

type DeliveryAction = "ignore" | "defer" | "recover" | "apply";

export function routeOrchestrationDeliveryBatch(input: {
  readonly batch: OrchestrationDeliveryBatch;
  readonly classify: (sequence: number) => DeliveryAction;
  readonly recover: () => Promise<void>;
  readonly apply: (events: ReadonlyArray<OrchestrationEvent>) => Promise<void>;
  readonly getAppliedSequence: () => number;
  readonly acknowledge: Parameters<typeof applyAndAcknowledgeDeliveryBatch>[0]["acknowledge"];
}) {
  const firstEvent = input.batch.events[0];
  if (!firstEvent) return Promise.resolve(null);

  const action = input.classify(firstEvent.sequence);
  return applyAndAcknowledgeDeliveryBatch({
    batch: input.batch,
    apply: async () => {
      if (action === "defer" || action === "recover") {
        await input.recover();
      }
      // Admission removes duplicates while retaining any later contiguous events in the batch.
      await input.apply(input.batch.events);
      return {
        appliedThroughSequence: Math.min(
          input.getAppliedSequence(),
          input.batch.events.at(-1)!.sequence,
        ),
      };
    },
    acknowledge: input.acknowledge,
  });
}
