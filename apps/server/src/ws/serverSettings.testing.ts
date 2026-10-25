import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@bigbud/contracts";
import { deepMerge, type DeepPartial } from "@bigbud/shared/Struct";
import { Effect, Ref, Stream } from "effect";
import { ServerSettingsSnapshot } from "./serverSettings.snapshot.ts";
import type { ServerSettingsShape } from "./serverSettings.ts";

/** Test settings use the production synchronous authority, even without a change stream. */
export function makeTestSettings(overrides: DeepPartial<ServerSettings>) {
  return Effect.gen(function* () {
    const initial = deepMerge(DEFAULT_SERVER_SETTINGS, overrides);
    const current = yield* Ref.make(initial);
    const snapshot = new ServerSettingsSnapshot();
    snapshot.accept(initial);
    const accept = (next: ServerSettings) =>
      Effect.sync(() => snapshot.accept(next)).pipe(
        Effect.andThen(Ref.set(current, next)),
        Effect.as(next),
      );
    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(current),
      currentSnapshot: snapshot.read,
      onSnapshotChange: snapshot.subscribe,
      updateSettings: (patch) =>
        Ref.get(current).pipe(Effect.flatMap((value) => accept(deepMerge(value, patch)))),
      setThreadRetentionPolicy: (policy) =>
        Ref.get(current).pipe(
          Effect.flatMap((value) => accept({ ...value, threadRetentionPolicy: policy })),
        ),
      initializeThreadRetentionPolicy: (policy, _source) =>
        Ref.get(current).pipe(
          Effect.flatMap((value) => accept({ ...value, threadRetentionPolicy: policy })),
        ),
      streamChanges: Stream.empty,
    } satisfies ServerSettingsShape;
  });
}
