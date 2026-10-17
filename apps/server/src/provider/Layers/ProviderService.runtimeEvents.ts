import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, PubSub, Stream } from "effect";
import { validProviderPublication } from "../providerPublication.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

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
  return (rawEvent: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.suspend(() =>
      validProviderPublication(rawEvent) ? Effect.succeed(rawEvent) : Effect.succeed(undefined),
    ).pipe(
      Effect.flatMap((event) => {
        if (!event) return Effect.void;
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
            ).pipe(
              Effect.andThen(
                Effect.suspend(() =>
                  shouldPublish && validProviderPublication(event)
                    ? input.publish(event)
                    : Effect.void,
                ),
              ),
            ),
          ),
        );
      }),
    );
}

/** Revalidate after logging at the actual canonical enqueue; logging is not publication authority. */
export function makeCanonicalRuntimePublisher(
  events: PubSub.PubSub<ProviderRuntimeEvent>,
  logger?: EventNdjsonLogger,
) {
  return (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (!validProviderPublication(event)) return;
      if (logger) yield* logger.write(event, null);
      yield* Effect.sync(() => {
        if (validProviderPublication(event)) PubSub.publishUnsafe(events, event);
      });
    });
}

/** Single-record demand prevents a buffered batch from passing its guard before consumer awaits. */
export function canonicalRuntimeStream(events: PubSub.PubSub<ProviderRuntimeEvent>) {
  return Stream.fromPubSub(events).pipe(Stream.rechunk(1), Stream.filter(validProviderPublication));
}
