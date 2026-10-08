import { Effect } from "effect";
import type { ProviderKind } from "@bigbud/contracts";
import type { ProviderServiceShape } from "../Services/ProviderService.ts";
import { supportsScheduledLearning } from "../providerWorkloadSupport.ts";

/** Scheduling and processing use the same fail-closed, explicitly composed durable-hook gate. */
export const canScheduleProviderLearning = Effect.fn("canScheduleProviderLearning")(function* (
  service: Pick<ProviderServiceShape, "getCapabilities">,
  provider: ProviderKind,
) {
  const durable =
    provider === "opencodeV2"
      ? yield* service.getCapabilities(provider).pipe(
          Effect.map((capabilities) => capabilities.durableLearningReview === true),
          Effect.orElseSucceed(() => false),
        )
      : false;
  return supportsScheduledLearning(provider, durable);
});
