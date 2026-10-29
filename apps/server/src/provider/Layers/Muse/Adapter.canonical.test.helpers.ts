import type { ProviderRuntimeEvent } from "@bigbud/contracts";
import { Effect, Option, PubSub, Stream } from "effect";

import type { MuseAdapterShape } from "../../Services/Muse/Adapter.ts";
import type { ProviderTurnLivenessRepositoryShape } from "../../../persistence/Services/ProviderTurnLiveness.ts";
import { createHarness } from "../../../orchestration/Layers/ProviderRuntimeIngestion.test.helpers.ts";
import {
  monitorProviderRuntimeEvents,
  observeProviderRuntimeEvent,
} from "../ProviderService.turnLiveness.ts";
import {
  canonicalRuntimeStream,
  makeCanonicalRuntimePublisher,
  makeProcessProviderRuntimeEvent,
} from "../ProviderService.runtimeEvents.ts";

/** Real provider liveness/validation/publication -> canonical ingestion, without native traffic. */
export const connectMuseCanonicalHarness = Effect.fn("test.connectMuseCanonicalHarness")(function* (
  harness: Awaited<ReturnType<typeof createHarness>>,
  adapter: MuseAdapterShape,
  liveness: ProviderTurnLivenessRepositoryShape,
) {
  const events: Array<ProviderRuntimeEvent> = [];
  const waiters: Array<{
    predicate: (event: ProviderRuntimeEvent) => boolean;
    resolve: (event: ProviderRuntimeEvent) => void;
  }> = [];
  const publications = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  yield* Stream.runForEach(canonicalRuntimeStream(publications), (event) =>
    Effect.sync(() => {
      events.push(event);
      harness.emit(event);
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (!waiters[index]!.predicate(event)) continue;
        waiters.splice(index, 1)[0]!.resolve(event);
      }
    }),
  ).pipe(Effect.forkScoped({ startImmediately: true }));
  yield* monitorProviderRuntimeEvents({
    adapters: [adapter],
    liveness: Option.some(liveness),
    process: makeProcessProviderRuntimeEvent({
      observe: (event) => observeProviderRuntimeEvent(Option.some(liveness), event),
      publish: makeCanonicalRuntimePublisher(publications),
    }),
  });
  return {
    events,
    waitForEvent: (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.suspend(() => {
        const existing = events.find(predicate);
        return existing
          ? Effect.succeed(existing)
          : Effect.promise(
              () =>
                new Promise<ProviderRuntimeEvent>((resolve) => {
                  waiters.push({ predicate, resolve });
                }),
            );
      }),
  };
});
