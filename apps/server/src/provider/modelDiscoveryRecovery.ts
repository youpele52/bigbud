import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import { Effect, Fiber } from "effect";

const RETRY_DELAYS = [1_000, 3_000, 10_000] as const;

export function hasLiveModelCatalog(snapshot: ServerProvider): boolean {
  return snapshot.modelDiscovery?.status === "live" || snapshot.modelDiscovery?.status === "empty";
}

function shouldRetry(snapshot: ServerProvider): boolean {
  return (
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.auth.status !== "unauthenticated" &&
    snapshot.failure?.classification !== "user-action-required" &&
    snapshot.modelDiscovery !== undefined &&
    !hasLiveModelCatalog(snapshot)
  );
}

/** Owns a bounded model-only recovery cycle, cancelled before any replacement probe. */
export const makeModelDiscoveryRecovery = Effect.fn("makeModelDiscoveryRecovery")(function* () {
  const scope = yield* Effect.scope;
  let background: Fiber.Fiber<void> | undefined;
  let identity: string | undefined;
  let lastGood: ServerProvider["models"] | undefined;
  let cycle = 0;

  return Effect.fn("recoverModelDiscovery")(function* (input: {
    readonly identity: string;
    readonly generation: number;
    readonly probe: Effect.Effect<ServerProvider>;
    readonly isCurrent: Effect.Effect<boolean>;
    readonly publish: (snapshot: ServerProvider) => Effect.Effect<void>;
    readonly awaitPublished?: Effect.Effect<void>;
    readonly retryDelays?: readonly [number, number, number];
  }) {
    if (background) yield* Fiber.interrupt(background);
    background = undefined;
    const operation = ++cycle;
    if (identity !== input.identity) lastGood = undefined;
    identity = input.identity;
    const current = input.isCurrent.pipe(Effect.map((value) => value && operation === cycle));
    const remember = (snapshot: ServerProvider) => {
      if (hasLiveModelCatalog(snapshot)) lastGood = snapshot.models;
      return snapshot;
    };
    let snapshot = yield* input.probe;
    if (!(yield* current)) return snapshot;
    remember(snapshot);
    if (!shouldRetry(snapshot)) return snapshot;
    snapshot = yield* input.probe;
    if (!(yield* current)) return snapshot;
    remember(snapshot);
    if (!shouldRetry(snapshot)) return snapshot;

    const fallback = (value: ServerProvider): ServerProvider => ({
      ...value,
      ...(lastGood === undefined ? {} : { models: lastGood }),
    });
    const recovery = (
      value: ServerProvider,
      attempt: number,
      status: "retrying" | "recovered" | "exhausted",
    ): ServerProvider => ({
      ...value,
      modelRecovery: {
        operationId: `${value.provider}:models:${input.generation}:${operation}`,
        generation: input.generation,
        trigger: "background",
        attempt,
        maxAttempts: 3,
        status,
      },
    });
    const pending = recovery(fallback(snapshot), 0, "retrying");
    background = yield* Effect.gen(function* () {
      yield* input.awaitPublished ?? Effect.void;
      const delays = input.retryDelays ?? RETRY_DELAYS;
      for (let index = 0; index < delays.length; index++) {
        yield* Effect.sleep(delays[index]!);
        if (!(yield* current)) return;
        yield* Effect.logInfo("provider model discovery background retry", {
          provider: snapshot.provider,
          attempt: index + 1,
          maxAttempts: 3,
        });
        yield* input.publish(recovery(fallback(snapshot), index + 1, "retrying"));
        snapshot = yield* input.probe;
        if (!(yield* current)) return;
        remember(snapshot);
        if (hasLiveModelCatalog(snapshot)) {
          yield* Effect.logInfo("provider model discovery recovered", {
            provider: snapshot.provider,
            attempt: index + 1,
          });
          yield* input.publish(recovery(snapshot, index + 1, "recovered"));
          return;
        }
        if (!shouldRetry(snapshot) || index === delays.length - 1) {
          yield* Effect.logWarning("provider model discovery exhausted", {
            provider: snapshot.provider,
            attempt: index + 1,
            message: snapshot.message,
            discovery: snapshot.modelDiscovery,
          });
          yield* input.publish(recovery(fallback(snapshot), index + 1, "exhausted"));
          return;
        }
      }
    }).pipe(Effect.forkIn(scope));
    return pending;
  });
});
