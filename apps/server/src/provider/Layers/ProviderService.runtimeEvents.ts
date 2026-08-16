import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect } from "effect";

import {
  claudeModernizationEventsTotal,
  claudeRuntimeMetricAttributes,
  increment,
  providerRuntimeEventsTotal,
} from "../../observability/Metrics.ts";

export function makeProcessProviderRuntimeEvent(input: {
  readonly observe: (event: ProviderRuntimeEvent) => Effect.Effect<boolean>;
  readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
}) {
  return (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    const claudeAttributes = claudeRuntimeMetricAttributes(event);
    return input.observe(event).pipe(
      Effect.flatMap((shouldPublish) =>
        Effect.all(
          [
            increment(providerRuntimeEventsTotal, {
              provider: event.provider,
              eventType: event.type,
            }),
            ...(claudeAttributes
              ? [increment(claudeModernizationEventsTotal, claudeAttributes)]
              : []),
          ],
          { discard: true },
        ).pipe(Effect.andThen(shouldPublish ? input.publish(event) : Effect.void)),
      ),
    );
  };
}
