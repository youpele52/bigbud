/**
 * Runtime activation, second half (M3 WP-4D): what the runtime that starts next does.
 *
 * - Journal `restarting`: this runtime is on trial with admission still closed. It must be the
 *   staged graph and pass trial readiness; then the archive pointer commits (new active, old
 *   previous), the operation becomes `activated`, unreferenced versions are pruned (the running
 *   version passed as in-use) and admission opens.
 * - Trial failure while nothing was admitted: restore the previous config and receipt, mark the
 *   journal `restore-pending` and restart. The next start restores the offline backup before
 *   opening the database, so the old runtime sees exactly the acknowledged state it drained.
 * - Journal `restored`: the old runtime is back; it settles the operation as failed with the
 *   journal's reason and releases the staged archive.
 * - `activating` without a journal: the old runtime stopped before the switch; nothing changed.
 * Commands admitted after the trial opened admission are never rolled back automatically.
 */
import { Effect, Option, type Scope } from "effect";
import type { RemoteRuntimeUpdateOperation } from "@bigbud/contracts/server/remoteBackendUpdate.ts";

import type { RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import { pruneRuntimeArchives } from "./runtimeArchive.retention.ts";
import {
  activateRuntimeArchive,
  readRuntimeArchiveEntry,
  type RuntimeArchiveStore,
} from "./runtimeArchive.store.ts";
import { runRuntimeActivation } from "./runtimeUpdate.activate.ts";
import {
  promise,
  settleRuntimeUpdateFailed,
  stepError,
  type RuntimeUpdateActivationContext,
} from "./runtimeUpdate.activate.context.ts";
import {
  clearRuntimeUpdateJournal,
  readRuntimeUpdateJournal,
  writeRuntimeUpdateJournal,
  type RuntimeUpdateJournal,
} from "./runtimeUpdate.journal.ts";
import type {
  RemoteRuntimeUpdateShape,
  RuntimeUpdateActivationSeam,
} from "./Services/RemoteRuntimeUpdate.ts";

const TRIAL_TIMEOUT_MS = 120_000;

const trial = Effect.fn("RuntimeUpdate.trial")(function* (
  ctx: RuntimeUpdateActivationContext,
  store: RuntimeArchiveStore,
  journal: RuntimeUpdateJournal,
) {
  const entry = yield* promise(() =>
    readRuntimeArchiveEntry(store, journal.archiveKey as RuntimeArchiveKey),
  );
  if (!entry || !ctx.runningEntryPath().startsWith(`${entry.graphRoot}/`))
    return yield* stepError("The restarted backend is not running the staged runtime.");
  const ready = yield* ctx.trialReadiness.pipe(Effect.timeoutOption(TRIAL_TIMEOUT_MS));
  if (Option.isNone(ready))
    return yield* stepError("The new runtime did not become ready in time.");
});

/** Rollback before any admission: previous config back, restore on next start, restart. */
const rollBack = Effect.fn("RuntimeUpdate.rollBack")(function* (
  ctx: RuntimeUpdateActivationContext,
  journal: RuntimeUpdateJournal,
  failure: string,
) {
  const rolling = { ...journal, phase: "rollback" as const, failure };
  yield* promise(() => writeRuntimeUpdateJournal(ctx.stateDir, rolling));
  yield* promise(() => ctx.unit.restore(journal.previousConfig, journal.previousReceipt));
  yield* promise(() =>
    writeRuntimeUpdateJournal(ctx.stateDir, { ...rolling, phase: "restore-pending" }),
  );
  yield* promise(() => ctx.unit.restart());
});

const settleActivating = Effect.fn("RuntimeUpdate.settleActivating")(function* (
  ctx: RuntimeUpdateActivationContext,
  service: RemoteRuntimeUpdateShape,
  view: RemoteRuntimeUpdateOperation,
  store: RuntimeArchiveStore,
  archiveKey: string | null,
) {
  const journal = yield* promise(() => readRuntimeUpdateJournal(ctx.stateDir));
  const base = { operationId: view.operationId, store, archiveKey };
  if (!journal || journal.operationId !== view.operationId)
    return yield* settleRuntimeUpdateFailed(ctx, service, {
      ...base,
      failure: "Activation stopped before the runtime switched; the previous runtime is unchanged.",
    });
  if (journal.phase === "restored") {
    yield* settleRuntimeUpdateFailed(ctx, service, {
      ...base,
      failure: `${journal.failure ?? "The new runtime failed its trial."} Rolled back to the previous runtime and database backup; no acknowledged command was lost.`,
      keepClosed: true,
    });
    // A journal left behind is cleared by the next start's sweep (the operation is settled).
    yield* promise(() => clearRuntimeUpdateJournal(ctx.stateDir, journal)).pipe(
      Effect.catch((error) => Effect.logWarning("Runtime update journal not cleared", error)),
    );
    return yield* ctx.gate.open;
  }
  if (journal.phase !== "restarting")
    // A rollback was interrupted before its restart; finish it.
    return yield* rollBack(ctx, journal, journal.failure ?? "The new runtime failed its trial.");
  const outcome = yield* trial(ctx, store, journal).pipe(Effect.result);
  if (outcome._tag === "Failure") {
    if (ctx.gate.admitted() > 0)
      return yield* settleRuntimeUpdateFailed(ctx, service, {
        ...base,
        failure: `${outcome.failure.message} Commands were already admitted, so it was not rolled back automatically; restore the previous runtime explicitly.`,
      });
    return yield* rollBack(ctx, journal, outcome.failure.message);
  }
  const key = journal.archiveKey as RuntimeArchiveKey;
  yield* promise(() => activateRuntimeArchive(store, key));
  yield* service.advance(view.operationId, "activated");
  yield* promise(() => pruneRuntimeArchives(store, { inUse: [key] })).pipe(
    Effect.catch((error) => Effect.logWarning("Runtime archive pruning failed", error)),
  );
  yield* promise(() => clearRuntimeUpdateJournal(ctx.stateDir, journal)).pipe(
    Effect.catch((error) => Effect.logWarning("Runtime update journal not cleared", error)),
  );
  if (journal.uncertain.length)
    yield* Effect.logWarning("Runtime update finished with uncertain interrupted turns", {
      threads: journal.uncertain,
    });
  yield* ctx.gate.open;
});

const resumeOperation = Effect.fn("RuntimeUpdate.resume")(function* (
  ctx: RuntimeUpdateActivationContext,
  view: RemoteRuntimeUpdateOperation,
) {
  const service = yield* ctx.service;
  if (view.state !== "activating") return yield* runRuntimeActivation(ctx, view.operationId);
  yield* service
    .withSingleFlight(
      (store, archiveKey) =>
        settleActivating(ctx, service, view, store, archiveKey).pipe(
          Effect.catch((error) =>
            Effect.logError("Runtime update activation could not settle; repair is needed", error),
          ),
        ),
      view.operationId,
    )
    .pipe(Effect.catch((error) => Effect.logError("Runtime update resume failed", error)));
});

/** A journal no live `activating` operation owns (already settled): clear it and reopen. */
export const sweepRuntimeUpdateJournal = Effect.fn("RuntimeUpdate.sweepJournal")(function* (
  ctx: RuntimeUpdateActivationContext,
) {
  const service = yield* ctx.service;
  const journal = yield* promise(() => readRuntimeUpdateJournal(ctx.stateDir));
  const live = yield* service.status({}).pipe(Effect.map((status) => status.operation));
  if (journal && live?.state === "activating" && live.operationId === journal.operationId) return;
  if (journal) yield* promise(() => clearRuntimeUpdateJournal(ctx.stateDir, journal));
  if (!live || live.state !== "activating") yield* ctx.gate.open;
});

/** The WP-4C activation seam: every entry point forks into the given scope. */
export function makeRuntimeUpdateActivation(
  ctx: RuntimeUpdateActivationContext,
  scope: Scope.Scope,
): RuntimeUpdateActivationSeam {
  const fork = <E>(effect: Effect.Effect<void, E>) =>
    effect.pipe(
      Effect.catchCause((cause) => Effect.logError("Runtime update activation failed", cause)),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  return {
    onStaged: (view) => fork(runRuntimeActivation(ctx, view.operationId)),
    onResume: (view) => fork(resumeOperation(ctx, view)),
  };
}
