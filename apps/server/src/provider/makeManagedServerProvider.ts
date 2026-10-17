import type { ServerProvider } from "@bigbud/contracts";
import { Deferred, Duration, Effect, Option, PubSub, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderRecoveryOptions, ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@bigbud/contracts";
import { areProviderSnapshotsEqual } from "./providerSnapshot.equal";
import { runCoordinatedProviderProbe } from "./providerProbeCoordinator.ts";
import { DEFAULT_PERIODIC_HEALTH_INTERVAL, withProviderRecovery } from "./managedProviderRecovery";
import { preserveEnrichedProviderSnapshot } from "./managedProviderSnapshot";
import { runManagedProviderStartupRecovery } from "./makeManagedServerProvider.startup.ts";
import { makeModelDiscoveryRecovery } from "./modelDiscoveryRecovery.ts";
import {
  makeManagedProviderEnrichment,
  type ProviderSnapshotEnrichment,
} from "./managedProviderEnrichment.ts";
export { PROVIDER_PROBE_CONCURRENCY } from "./providerProbeCoordinator.ts";

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly checkProviderAtStartup?: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly initialSnapshot: ServerProvider | ((settings: Settings) => ServerProvider);
  readonly probeTimeout?: Duration.Input;
  readonly refreshInterval?: Duration.Input;
  /** Required source discovery, included in each bounded model recovery attempt. */
  readonly discoverSnapshot?: ProviderSnapshotEnrichment<Settings>;
  /** Optional capabilities, published after the core catalog without delaying readiness. */
  readonly enrichSnapshot?: ProviderSnapshotEnrichment<Settings>;
  readonly enrichmentTimeout?: Duration.Input;
  readonly decorateSnapshot?: (opts: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly generation: number;
  }) => Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly preserveEnrichedSnapshot?: boolean;
  readonly recoverModelDiscovery?: boolean;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  const recoverModels = yield* makeModelDiscoveryRecovery();
  const enrichment = yield* makeManagedProviderEnrichment();
  const generationRef = yield* Ref.make(0);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot =
    typeof input.initialSnapshot === "function"
      ? input.initialSnapshot(initialSettings)
      : input.initialSnapshot;
  const snapshotRef = yield* Ref.make<ServerProvider>({
    ...initialSnapshot,
    ...(input.recoverModelDiscovery && initialSnapshot.enabled ? { models: [] } : {}),
    initialProbeComplete: !initialSnapshot.enabled,
  });
  const settingsRef = yield* Ref.make(initialSettings);

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: {
      readonly forceRefresh?: boolean;
      readonly recovery?: ServerProviderRecoveryOptions;
      readonly generation?: number;
      readonly probeMode?: "startup" | "full";
    },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    const generation = options?.generation ?? (yield* Ref.get(generationRef));
    if (generation !== (yield* Ref.get(generationRef))) return yield* Ref.get(snapshotRef);
    yield* enrichment.cancel;
    const isCurrent = Ref.get(generationRef).pipe(Effect.map((value) => value === generation));
    const enrich = (snapshot: ServerProvider) => {
      if (
        !input.enrichSnapshot ||
        !snapshot.enabled ||
        snapshot.status !== "ready" ||
        (input.recoverModelDiscovery && snapshot.modelDiscovery?.status !== "live")
      ) {
        return Effect.void;
      }
      return enrichment.start({
        snapshot,
        generation,
        isCurrent,
        ...(input.enrichmentTimeout === undefined ? {} : { timeout: input.enrichmentTimeout }),
        enrich: (publishSnapshot) =>
          input.enrichSnapshot!({
            settings: nextSettings,
            snapshot,
            generation,
            publishSnapshot,
          }),
        publish: (enriched) =>
          Effect.gen(function* () {
            if (!(yield* isCurrent)) return;
            if (areProviderSnapshotsEqual(yield* Ref.get(snapshotRef), enriched)) return;
            yield* Ref.set(snapshotRef, enriched);
            yield* PubSub.publish(changesPubSub, enriched);
          }),
      });
    };
    yield* Effect.logDebug("provider probe attempt", {
      provider: initialSnapshot.provider,
      generation,
      trigger: options?.recovery?.trigger ?? "periodic",
      attempt: options?.recovery?.attempt ?? 1,
    });
    const probe =
      options?.probeMode === "startup" && input.checkProviderAtStartup
        ? input.checkProviderAtStartup
        : input.checkProvider;
    const currentSnapshot = yield* Ref.get(snapshotRef);
    const fallbackSnapshot =
      typeof input.initialSnapshot === "function"
        ? input.initialSnapshot(nextSettings)
        : input.initialSnapshot;
    const foregroundPublished = yield* Deferred.make<void>();
    const probeOnce = Effect.gen(function* () {
      const sourceProbe = probe.pipe(
        Effect.flatMap((base) =>
          Effect.gen(function* () {
            let snapshot = base;
            if (input.discoverSnapshot) {
              yield* input.discoverSnapshot({
                settings: nextSettings,
                snapshot,
                generation,
                publishSnapshot: (discovered) =>
                  Effect.sync(() => {
                    snapshot = discovered;
                  }),
              });
            }
            return snapshot;
          }),
        ),
      );
      const probeResult = yield* runCoordinatedProviderProbe(sourceProbe, input.probeTimeout);
      let snapshot: ServerProvider = Option.match(probeResult, {
        onNone: () => {
          const {
            failure: _failure,
            recovery: _recovery,
            ...base
          } = input.recoverModelDiscovery ? fallbackSnapshot : currentSnapshot;
          return {
            ...base,
            status: "error" as const,
            checkedAt: new Date().toISOString(),
            initialProbeComplete: true,
            failure: { classification: "retryable" as const, reason: "startup-timeout" as const },
            message: `${initialSnapshot.provider} provider check timed out.`,
          };
        },
        onSome: (snapshot) => ({ ...snapshot, initialProbeComplete: true }),
      });
      if (input.recoverModelDiscovery && (Option.isNone(probeResult) || !snapshot.modelDiscovery)) {
        snapshot = {
          ...snapshot,
          modelDiscovery: { status: "unavailable", source: "fallback", durationMs: 0 },
        };
      }
      return snapshot;
    });
    const probedSnapshot = input.recoverModelDiscovery
      ? yield* recoverModels({
          identity: JSON.stringify(nextSettings),
          generation,
          probe: probeOnce.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider model discovery probe failed", {
                provider: initialSnapshot.provider,
                cause,
              }).pipe(
                Effect.as({
                  ...fallbackSnapshot,
                  initialProbeComplete: true,
                  modelDiscovery: {
                    status: "unavailable" as const,
                    source: "fallback",
                    durationMs: 0,
                  },
                }),
              ),
            ),
          ),
          awaitPublished: Deferred.await(foregroundPublished),
          isCurrent: Ref.get(generationRef).pipe(Effect.map((value) => value === generation)),
          publish: (snapshot) =>
            Effect.gen(function* () {
              const decorated = input.decorateSnapshot
                ? yield* input.decorateSnapshot({ settings: nextSettings, snapshot, generation })
                : snapshot;
              if (generation !== (yield* Ref.get(generationRef))) return;
              if (!areProviderSnapshotsEqual(yield* Ref.get(snapshotRef), decorated)) {
                yield* Ref.set(snapshotRef, decorated);
                yield* PubSub.publish(changesPubSub, decorated);
              }
              yield* enrich(decorated);
            }).pipe(Effect.ignoreCause({ log: true })),
        })
      : yield* probeOnce;
    if (generation !== (yield* Ref.get(generationRef))) {
      yield* Effect.logInfo("provider probe superseded", {
        provider: initialSnapshot.provider,
        generation,
      });
      return yield* Ref.get(snapshotRef);
    }
    const decoratedSnapshot = input.decorateSnapshot
      ? yield* input
          .decorateSnapshot({ settings: nextSettings, snapshot: probedSnapshot, generation })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider snapshot decoration failed", {
                provider: initialSnapshot.provider,
                cause,
              }).pipe(Effect.as(probedSnapshot)),
            ),
          )
      : probedSnapshot;
    if (generation !== (yield* Ref.get(generationRef))) {
      return yield* Ref.get(snapshotRef);
    }
    const checkedSnapshot = preserveEnrichedProviderSnapshot(
      decoratedSnapshot,
      currentSnapshot,
      input.preserveEnrichedSnapshot === true && !input.recoverModelDiscovery,
    );
    const nextSnapshot =
      options?.recovery === undefined
        ? checkedSnapshot
        : withProviderRecovery(checkedSnapshot, options.recovery, generation);
    const previousSnapshot = yield* Ref.get(snapshotRef);
    const snapshotChanged = !areProviderSnapshotsEqual(previousSnapshot, nextSnapshot);
    yield* Ref.set(settingsRef, nextSettings);
    if (snapshotChanged) yield* Ref.set(snapshotRef, nextSnapshot);

    yield* Effect.logDebug("provider probe result", {
      provider: nextSnapshot.provider,
      generation,
      classification: nextSnapshot.failure?.classification ?? "none",
      reason: nextSnapshot.failure?.reason ?? "none",
    });

    if (snapshotChanged) {
      if (generation === (yield* Ref.get(generationRef))) {
        yield* PubSub.publish(changesPubSub, nextSnapshot);
      }
    }

    yield* enrich(nextSnapshot);
    yield* Deferred.succeed(foregroundPublished, undefined);
    return yield* Ref.get(snapshotRef);
  });
  const applySnapshot = (
    nextSettings: Settings,
    options?: {
      readonly forceRefresh?: boolean;
      readonly recovery?: ServerProviderRecoveryOptions;
      readonly generation?: number;
      readonly probeMode?: "startup" | "full";
    },
  ) => refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* (options?: {
    readonly recovery?: ServerProviderRecoveryOptions;
    readonly generation?: number;
    readonly probeMode?: "startup" | "full";
  }) {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true, ...options });
  });

  const startupGeneration = yield* Ref.updateAndGet(generationRef, (generation) => generation + 1);
  yield* runManagedProviderStartupRecovery({
    enabled: initialSnapshot.enabled,
    provider: initialSnapshot.provider,
    startupGeneration,
    generationRef,
    hasStartupProbe: input.checkProviderAtStartup !== undefined,
    hasEnrichment: input.enrichSnapshot !== undefined || input.discoverSnapshot !== undefined,
    refreshSnapshot,
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  // Ignore the settings stream's initial replay when superseding launch recovery.
  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.gen(function* () {
      const previousSettings = yield* Ref.get(settingsRef);
      if (!input.haveSettingsChanged(previousSettings, nextSettings)) {
        yield* Ref.set(settingsRef, nextSettings);
        return;
      }

      const generation = yield* Ref.updateAndGet(
        generationRef,
        (currentGeneration) => currentGeneration + 1,
      );
      yield* enrichment.cancel;
      yield* applySnapshot(nextSettings, { generation }).pipe(Effect.ignoreCause({ log: true }));
    }),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? DEFAULT_PERIODIC_HEALTH_INTERVAL).pipe(
      Effect.flatMap(() =>
        Ref.get(snapshotRef).pipe(
          Effect.flatMap((snapshot) => {
            if (!snapshot.enabled || snapshot.failure?.classification === "user-action-required") {
              return Effect.void;
            }
            return refreshSnapshot().pipe(Effect.asVoid);
          }),
        ),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  return {
    getSnapshot: Effect.gen(function* () {
      const nextSettings = yield* input.getSettings;
      const previousSettings = yield* Ref.get(settingsRef);
      if (!input.haveSettingsChanged(previousSettings, nextSettings)) {
        yield* Ref.set(settingsRef, nextSettings);
        return yield* Ref.get(snapshotRef);
      }

      const generation = yield* Ref.updateAndGet(generationRef, (value) => value + 1);
      yield* enrichment.cancel;
      return yield* applySnapshot(nextSettings, { generation });
    }).pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refresh: Ref.updateAndGet(generationRef, (value) => value + 1).pipe(
      Effect.tap(() => enrichment.cancel),
      Effect.flatMap((generation) => refreshSnapshot({ generation })),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    refreshWithRecovery: (options) =>
      Ref.updateAndGet(generationRef, (generation) => generation + 1).pipe(
        Effect.tap(() => enrichment.cancel),
        Effect.tap((generation) =>
          Effect.logInfo("provider recovery operation started", {
            provider: initialSnapshot.provider,
            trigger: options.trigger,
            generation,
            operationId:
              options.operationId ?? `${initialSnapshot.provider}:${options.trigger}:${generation}`,
            maxAttempts: options.maxAttempts,
          }),
        ),
        Effect.flatMap((generation) => refreshSnapshot({ recovery: options, generation })),
        Effect.tapError(Effect.logError),
        Effect.orDie,
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
