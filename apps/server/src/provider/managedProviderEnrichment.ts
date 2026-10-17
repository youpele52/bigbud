import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerSettingsError } from "@bigbud/contracts";
import { Duration, Effect, Fiber, Option } from "effect";
import * as Semaphore from "effect/Semaphore";

export type ProviderSnapshotEnrichment<Settings> = (opts: {
  readonly settings: Settings;
  readonly snapshot: ServerProvider;
  readonly generation: number;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}) => Effect.Effect<void, ServerSettingsError>;

/** Serial, scoped optional work: never holds the core probe permit or publication barrier. */
export const makeManagedProviderEnrichment = Effect.fn("makeManagedProviderEnrichment")(
  function* () {
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    let fiber: Fiber.Fiber<void> | undefined;
    let revision = 0;
    let closed = false;
    const stop = Effect.gen(function* () {
      revision++;
      if (fiber) yield* Fiber.interrupt(fiber);
      fiber = undefined;
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        closed = true;
        yield* stop;
      }),
    );
    return {
      cancel: lock.withPermits(1)(stop),
      start: (input: {
        readonly snapshot: ServerProvider;
        readonly generation: number;
        readonly timeout?: Duration.Input;
        readonly isCurrent: Effect.Effect<boolean>;
        readonly enrich: (
          publish: (snapshot: ServerProvider) => Effect.Effect<void>,
        ) => Effect.Effect<void, ServerSettingsError>;
        readonly publish: (snapshot: ServerProvider) => Effect.Effect<void>;
      }) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            if (closed || !(yield* input.isCurrent)) return;
            yield* stop;
            if (closed || !(yield* input.isCurrent)) return;
            const operation = revision;
            let active = true;
            const publish = (snapshot: ServerProvider) =>
              Effect.gen(function* () {
                if (!active || operation !== revision || !(yield* input.isCurrent)) return;
                yield* input.publish(snapshot);
              });
            fiber = yield* Effect.suspend(() => input.enrich(publish)).pipe(
              Effect.timeoutOption(input.timeout ?? "30 seconds"),
              Effect.flatMap((result) =>
                Option.isNone(result)
                  ? Effect.logWarning("provider optional enrichment timed out", {
                      provider: input.snapshot.provider,
                      generation: input.generation,
                    })
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider optional enrichment failed", {
                  provider: input.snapshot.provider,
                  generation: input.generation,
                  cause,
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  active = false;
                }),
              ),
              Effect.forkIn(scope, { startImmediately: false }),
            );
          }),
        ),
    };
  },
);
