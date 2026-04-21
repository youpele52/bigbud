import type { ServerProvider } from "@bigbud/contracts";
import { Duration, Effect, PubSub, Ref, Scope, Stream } from "effect";
import * as Semaphore from "effect/Semaphore";

import type { ServerProviderShape } from "./Services/ServerProvider";
import { ServerSettingsError } from "@bigbud/contracts";

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly getSettings: Effect.Effect<Settings>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly initialSnapshot?: ServerProvider | ((settings: Settings) => ServerProvider);
  readonly refreshInterval?: Duration.Input;
  readonly enrichSnapshot?: (opts: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
}): Effect.fn.Return<ServerProviderShape, ServerSettingsError, Scope.Scope> {
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  let initialSnapshot: ServerProvider;
  if (input.initialSnapshot !== undefined) {
    initialSnapshot =
      typeof input.initialSnapshot === "function"
        ? input.initialSnapshot(initialSettings)
        : input.initialSnapshot;
  } else {
    initialSnapshot = yield* input.checkProvider;
  }
  const snapshotRef = yield* Ref.make(initialSnapshot);
  const settingsRef = yield* Ref.make(initialSettings);

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotRef);
    }

    const nextSnapshot = yield* input.checkProvider;
    yield* Ref.set(settingsRef, nextSettings);
    yield* Ref.set(snapshotRef, nextSnapshot);
    yield* PubSub.publish(changesPubSub, nextSnapshot);

    if (input.enrichSnapshot !== undefined) {
      const publishSnapshot = (enriched: ServerProvider) =>
        Ref.set(snapshotRef, enriched).pipe(
          Effect.flatMap(() => PubSub.publish(changesPubSub, enriched)),
          Effect.asVoid,
        );
      yield* input
        .enrichSnapshot({ settings: nextSettings, snapshot: nextSnapshot, publishSnapshot })
        .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
    }

    return nextSnapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  // Seeded providers start with a cheap placeholder snapshot so construction
  // never blocks on optional external binaries. Kick off the real probe in the
  // background and publish once it completes.
  if (input.initialSnapshot !== undefined) {
    yield* refreshSnapshot().pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.sleep(input.refreshInterval ?? "60 seconds").pipe(
      Effect.flatMap(() => refreshSnapshot()),
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
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
