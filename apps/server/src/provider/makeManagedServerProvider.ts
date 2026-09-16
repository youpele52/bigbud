import type { ServerProvider } from "@bigbud/contracts";
import { Duration, Effect, Option, PubSub, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderRecoveryOptions, ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@bigbud/contracts";
import { areProviderSnapshotsEqual } from "./providerSnapshot.equal";
import { runCoordinatedProviderProbe } from "./providerProbeCoordinator.ts";
import { DEFAULT_PERIODIC_HEALTH_INTERVAL, withProviderRecovery } from "./managedProviderRecovery";
import { preserveEnrichedProviderSnapshot } from "./managedProviderSnapshot";
import { runManagedProviderStartupRecovery } from "./makeManagedServerProvider.startup.ts";
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
  readonly enrichSnapshot?: (opts: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly generation: number;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void, ServerSettingsError>;
  readonly decorateSnapshot?: (opts: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly generation: number;
  }) => Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly preserveEnrichedSnapshot?: boolean;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
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
    const probeResult = yield* runCoordinatedProviderProbe(probe, input.probeTimeout);
    const currentSnapshot = yield* Ref.get(snapshotRef);
    const probedSnapshot = Option.match(probeResult, {
      onNone: () => {
        const { failure: _failure, recovery: _recovery, ...base } = currentSnapshot;
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
    const checkedSnapshot = preserveEnrichedProviderSnapshot(
      decoratedSnapshot,
      currentSnapshot,
      input.preserveEnrichedSnapshot === true,
    );
    const nextSnapshot =
      options?.recovery === undefined
        ? checkedSnapshot
        : withProviderRecovery(checkedSnapshot, options.recovery, generation);
    const previousSnapshot = yield* Ref.get(snapshotRef);
    const snapshotChanged = !areProviderSnapshotsEqual(previousSnapshot, nextSnapshot);
    const deferCorePublish =
      input.enrichSnapshot !== undefined && options?.recovery?.trigger === "manual";
    yield* Ref.set(settingsRef, nextSettings);
    if (snapshotChanged && !deferCorePublish) yield* Ref.set(snapshotRef, nextSnapshot);

    const publishProviderSnapshot = Effect.fn("publishProviderSnapshot")(function* (
      snapshot: ServerProvider,
    ) {
      if (generation !== (yield* Ref.get(generationRef))) {
        yield* Effect.logInfo("provider enrichment superseded", {
          provider: initialSnapshot.provider,
          generation,
        });
        return false;
      }
      const previous = yield* Ref.get(snapshotRef);
      if (areProviderSnapshotsEqual(previous, snapshot)) return false;
      yield* Ref.set(snapshotRef, snapshot);
      yield* PubSub.publish(changesPubSub, snapshot);
      return true;
    });

    yield* Effect.logDebug("provider probe result", {
      provider: nextSnapshot.provider,
      generation,
      classification: nextSnapshot.failure?.classification ?? "none",
      reason: nextSnapshot.failure?.reason ?? "none",
    });

    if (snapshotChanged && !deferCorePublish) {
      yield* PubSub.publish(changesPubSub, nextSnapshot);
    }

    if (input.enrichSnapshot !== undefined) {
      let enrichmentPublished = false;
      const publishSnapshot = (enriched: ServerProvider) => {
        const resolved =
          options?.recovery === undefined
            ? enriched
            : withProviderRecovery(enriched, options.recovery, generation);
        return publishProviderSnapshot(resolved).pipe(
          Effect.tap((published) => Effect.sync(() => (enrichmentPublished ||= published))),
          Effect.asVoid,
        );
      };
      const enrichment = input
        .enrichSnapshot({
          settings: nextSettings,
          snapshot: nextSnapshot,
          generation,
          publishSnapshot,
        })
        .pipe(Effect.ignoreCause({ log: true }));
      if (deferCorePublish) {
        yield* enrichment;
        if (
          snapshotChanged &&
          !enrichmentPublished &&
          generation === (yield* Ref.get(generationRef))
        ) {
          yield* Ref.set(snapshotRef, nextSnapshot);
          yield* PubSub.publish(changesPubSub, nextSnapshot);
        }
      } else {
        yield* enrichment;
      }
    }

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
    hasEnrichment: input.enrichSnapshot !== undefined,
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

      return yield* applySnapshot(nextSettings);
    }).pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    refreshWithRecovery: (options) =>
      Ref.updateAndGet(generationRef, (generation) => generation + 1).pipe(
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
