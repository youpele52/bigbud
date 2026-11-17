/**
 * Staging for the runtime update operation (WP-4C): resolve the signed graph, durably name its
 * archive slot on the operation, then reserve → extract → verify → record in the WP-4B store, all
 * under the single-flight lock. Any failure releases the reservation; shutdown leaves the
 * operation in `staging` so the next start resumes it.
 */
import * as fs from "node:fs/promises";
import { Data, Effect } from "effect";
import type { RemoteRuntimeUpdateOperationsShape } from "../persistence/Services/RemoteRuntimeUpdateOperations.ts";
import { runtimeArchiveKeyForManifest, type RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import {
  readRuntimeArchiveEntry,
  recordRuntimeArchive,
  releaseRuntimeArchive,
  reserveRuntimeArchive,
  type RuntimeArchiveStore,
} from "./runtimeArchive.store.ts";
import type { RuntimeUpdateLock } from "./runtimeUpdate.lock.ts";
import {
  STAGING_RUNTIME_UPDATE_STATES,
  runtimeUpdateFailureText,
  toRuntimeUpdateView,
} from "./runtimeUpdate.states.ts";
import type {
  RemoteRuntimeUpdateDependencies,
  RuntimeUpdateGraph,
} from "./Services/RemoteRuntimeUpdate.ts";

/** Store-level staging; idempotent for an entry that a previous attempt already recorded. */
export async function stageRuntimeUpdateArchive(
  store: RuntimeArchiveStore,
  key: RuntimeArchiveKey,
  graph: RuntimeUpdateGraph,
  signal: AbortSignal,
): Promise<void> {
  const slot = await reserveRuntimeArchive(store, key);
  if (await readRuntimeArchiveEntry(store, key)) return;
  // A crash mid-extraction leaves a partial, unrecorded graph in our own reserved slot.
  await fs.rm(slot.graphRoot, { recursive: true, force: true });
  await store.checkpoint();
  signal.throwIfAborted();
  const token = await graph.extract(slot.graphRoot, signal);
  await recordRuntimeArchive(store, token, signal);
}

export interface RuntimeUpdateStagingContext {
  readonly repository: RemoteRuntimeUpdateOperationsShape;
  readonly deps: RemoteRuntimeUpdateDependencies;
  readonly lock: RuntimeUpdateLock;
  readonly now: () => string;
}

/** Why staging stopped; the message is persisted (bounded) as the operation's failure. */
export class RuntimeUpdateStagingFailure extends Data.TaggedError("RuntimeUpdateStagingFailure")<{
  readonly message: string;
}> {}
const stopped = (message: string) => new RuntimeUpdateStagingFailure({ message });
const step = <A>(run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => stopped(runtimeUpdateFailureText(cause)),
  });

/** Runs (or resumes) staging for one operation; never fails, the outcome is persisted. */
export const runRuntimeUpdateStaging = Effect.fn("RemoteRuntimeUpdate.stage")(function* (
  ctx: RuntimeUpdateStagingContext,
  operationId: string,
  cancel: AbortSignal,
) {
  const { repository, deps } = ctx;
  const staged = yield* ctx.lock.withLock((checkpoint) =>
    Effect.gen(function* () {
      const record = yield* repository.get(operationId).pipe(Effect.orElseSucceed(() => undefined));
      if (!record || !STAGING_RUNTIME_UPDATE_STATES.includes(record.state)) return undefined;
      let store: RuntimeArchiveStore | undefined;
      let key = record.archiveKey as RuntimeArchiveKey | null;
      const cas = (from: typeof STAGING_RUNTIME_UPDATE_STATES, patch: object) =>
        repository
          .compareAndSet(operationId, { states: from }, { ...patch, updatedAt: ctx.now() })
          .pipe(Effect.mapError(() => stopped("Update state is unavailable.")));
      const attempt = Effect.gen(function* () {
        const opened = yield* step(() => deps.openStore(checkpoint));
        store = opened;
        const graph = yield* step((signal) =>
          deps.graphSource.resolve(
            { version: record.version, source: record.source },
            AbortSignal.any([signal, cancel]),
          ),
        );
        const next = yield* Effect.try({
          try: () => runtimeArchiveKeyForManifest(graph.manifest),
          catch: () => stopped("The resolved backend graph manifest is invalid."),
        });
        if (!next.startsWith(`${record.version}@`))
          return yield* stopped("The resolved graph is not the requested version.");
        const previousKey = key;
        if (previousKey && previousKey !== next)
          yield* step(() => releaseRuntimeArchive(opened, previousKey));
        key = next;
        // Durably name the slot before reserving it, so a crash can always release it.
        if (!(yield* cas(STAGING_RUNTIME_UPDATE_STATES, { state: "staging", archiveKey: next })))
          return yield* stopped("The update was cancelled.");
        yield* step((signal) =>
          stageRuntimeUpdateArchive(opened, next, graph, AbortSignal.any([signal, cancel])),
        );
        const done = yield* cas(["staging"], { state: "staged" });
        if (!done) return yield* stopped("The update was cancelled.");
        return done;
      });
      return yield* attempt.pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const reserved = key;
            if (store && reserved) {
              const opened = store;
              yield* step(() => releaseRuntimeArchive(opened, reserved)).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Runtime update reservation release failed", error),
                ),
              );
            }
            // A no-op when cancel already settled the operation.
            yield* cas(STAGING_RUNTIME_UPDATE_STATES, {
              state: "failed",
              failure: cause.message,
            }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Runtime update failure was not persisted", error),
              ),
            );
            return undefined;
          }),
        ),
      );
    }),
  );
  if (staged && deps.activation) yield* deps.activation.onStaged(toRuntimeUpdateView(staged));
});
