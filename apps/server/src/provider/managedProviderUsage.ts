import type { ServerProvider } from "@bigbud/contracts/server/server.providers.ts";
import type { ServerProviderUsageLimits } from "@bigbud/contracts/server/usageLimits.ts";
import { Effect, PubSub, Ref } from "effect";
import { inheritProviderSnapshot } from "./providerSnapshot.authority.ts";
import { areProviderSnapshotsEqual } from "./providerSnapshot.equal.ts";

/** Gives quota its own revision without superseding model discovery or optional capabilities. */
export function makeManagedProviderUsagePublication(
  snapshotRef: Ref.Ref<ServerProvider>,
  changes: PubSub.PubSub<ServerProvider>,
) {
  let revision = 0;
  const preserve = (snapshot: ServerProvider, sourceRevision: number, current: ServerProvider) => {
    if (sourceRevision === revision) return snapshot;
    const { usageLimits: _usageLimits, ...rest } = snapshot;
    return inheritProviderSnapshot(snapshot, {
      ...rest,
      ...(current.usageLimits ? { usageLimits: current.usageLimits } : {}),
    });
  };
  return {
    get revision() {
      return revision;
    },
    didRefresh: () => {
      revision++;
    },
    preserve,
    publish: (snapshot: ServerProvider, sourceRevision: number) =>
      Ref.modify(snapshotRef, (current) => {
        const next = preserve(snapshot, sourceRevision, current);
        return areProviderSnapshotsEqual(current, next)
          ? ([undefined, current] as const)
          : ([next, next] as const);
      }).pipe(
        Effect.flatMap((next) =>
          next ? PubSub.publish(changes, next).pipe(Effect.as(next)) : Ref.get(snapshotRef),
        ),
      ),
  };
}

/** Publishes quota only, preserving health, catalog, recovery and active-session state. */
export function managedProviderUsageRefresh<Settings>(input: {
  readonly read: (settings: Settings) => Effect.Effect<ServerProviderUsageLimits>;
  readonly getSettings: Effect.Effect<Settings>;
  readonly settingsRef: Ref.Ref<Settings>;
  readonly snapshotRef: Ref.Ref<ServerProvider>;
  readonly generationRef: Ref.Ref<number>;
  readonly changes: PubSub.PubSub<ServerProvider>;
  readonly haveSettingsChanged: (a: Settings, b: Settings) => boolean;
  readonly didRefresh?: () => void;
}) {
  return Effect.gen(function* () {
    const settings = yield* input.getSettings;
    const generation = yield* Ref.get(input.generationRef);
    const snapshot = yield* Ref.get(input.snapshotRef);
    if (!snapshot.enabled || input.haveSettingsChanged(yield* Ref.get(input.settingsRef), settings))
      return snapshot;
    const usageLimits = yield* input.read(settings);
    const latestSettings = yield* input.getSettings;
    const current = yield* Ref.get(input.snapshotRef);
    if (
      generation !== (yield* Ref.get(input.generationRef)) ||
      input.haveSettingsChanged(settings, latestSettings) ||
      !current.enabled
    )
      return current;
    const next = yield* Ref.updateAndGet(input.snapshotRef, (latest) => {
      input.didRefresh?.();
      return inheritProviderSnapshot(latest, { ...latest, usageLimits });
    });
    yield* PubSub.publish(input.changes, next);
    return next;
  });
}
