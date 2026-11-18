/**
 * Runtime activation, first half (M3 WP-4D): staged → awaiting-drain ⇄ deferred → activating →
 * restart of the backend unit. Every step after the deferral wait runs under the single-flight
 * lock (`withSingleFlight`) and changes state only through `advance`.
 *
 * Order, so that every refusal happens before any outage:
 *   1. downgrade refusal, staged receipt check, managed-unit check, disk budget (before drain)
 *   2. drain (closes admission; defers or interrupts per D9)
 *   3. disk budget again under the lock
 *   4. advance → activating, offline `VACUUM INTO` backup, journal `restarting`
 *   5. point the unit config at the staged graph, ask systemd to restart the backend unit
 * A failure in 4–5 before a restart could have been queued restores the previous config and
 * settles the operation as failed in this (still old) runtime; nothing was admitted because
 * admission stayed closed. Once a restart is requested, or may have been, nothing is restored
 * here: the next runtime's trial decides (`runtimeUpdate.restart.ts`).
 */
import { Duration, Effect } from "effect";

import type { RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import { readRuntimeArchiveEntry, type RuntimeArchiveStore } from "./runtimeArchive.store.ts";
import {
  promise,
  runtimeUpdateDowngradeRefusal,
  settleRuntimeUpdateFailed,
  stepError,
  type RuntimeUpdateActivationContext,
} from "./runtimeUpdate.activate.context.ts";
import { backupDatabaseOffline } from "./runtimeUpdate.backup.ts";
import { estimateRuntimeUpdateDiskBudget, runtimeUpdateDiskRefusal } from "./runtimeUpdate.disk.ts";
import { drainForRuntimeUpdate } from "./runtimeUpdate.drain.ts";
import {
  clearRuntimeUpdateJournal,
  ensureRuntimeUpdateDirectory,
  runtimeUpdateBackupPath,
  writeRuntimeUpdateJournal,
  type RuntimeUpdateJournal,
} from "./runtimeUpdate.journal.ts";
import { isTerminalRuntimeUpdateState } from "./runtimeUpdate.states.ts";
import { requestBackendRestart, superviseBackendRestart } from "./runtimeUpdate.restart.ts";
import { readStagedGraphPins } from "./runtimeUpdate.unit.ts";
import type { RemoteRuntimeUpdateShape } from "./Services/RemoteRuntimeUpdate.ts";

export type RuntimeUpdateAttempt = "deferred" | "restarting" | "settled";

const diskRefusal = (ctx: RuntimeUpdateActivationContext) =>
  promise(async () =>
    runtimeUpdateDiskRefusal(
      await estimateRuntimeUpdateDiskBudget({
        dbPath: ctx.dbPath,
        stateDir: ctx.stateDir,
        ...(ctx.diskProbe ? { probe: ctx.diskProbe } : {}),
      }),
    ),
  );

/** One activation attempt under the lock. Never fails: every outcome is persisted. */
export const attemptRuntimeActivation = Effect.fn("RuntimeUpdate.attemptActivation")(function* (
  ctx: RuntimeUpdateActivationContext,
  service: RemoteRuntimeUpdateShape,
  input: {
    readonly operationId: string;
    readonly store: RuntimeArchiveStore;
    readonly archiveKey: string | null;
    readonly interrupting: boolean;
  },
) {
  const { operationId, store, archiveKey } = input;
  const fail = (failure: string) =>
    settleRuntimeUpdateFailed(ctx, service, { operationId, store, archiveKey, failure }).pipe(
      Effect.as("settled" as RuntimeUpdateAttempt),
    );
  const prepared = yield* promise(async () => {
    const entry = archiveKey
      ? await readRuntimeArchiveEntry(store, archiveKey as RuntimeArchiveKey)
      : null;
    if (!entry) throw new Error("The staged runtime is missing from the archive store.");
    const downgrade = runtimeUpdateDowngradeRefusal(ctx.runningVersion, entry.version);
    if (downgrade) throw new Error(downgrade);
    const staged = await readStagedGraphPins(entry);
    await ctx.unit.assertManaged();
    return staged;
  }).pipe(Effect.result);
  if (prepared._tag === "Failure") return yield* fail(prepared.failure.message);
  const before = yield* diskRefusal(ctx).pipe(Effect.result);
  if (before._tag === "Failure") return yield* fail(before.failure.message);
  if (before.success) return yield* fail(before.success);

  const drained = yield* drainForRuntimeUpdate({
    gate: ctx.gate,
    probe: ctx.probe,
    interrupting: input.interrupting,
    consumeConsent: service.consumeInterruptionConsent(operationId),
    ...ctx.drain,
  }).pipe(Effect.result);
  // A stale or reused consent reopened admission; the user reviews the new work and confirms.
  if (drained._tag === "Failure" || drained.success.kind === "deferred")
    return "deferred" as RuntimeUpdateAttempt;
  const uncertain = drained.success.uncertain;

  const underLock = yield* diskRefusal(ctx).pipe(Effect.result);
  if (underLock._tag === "Failure") return yield* fail(underLock.failure.message);
  if (underLock.success) return yield* fail(underLock.success);
  const activating = yield* service.advance(operationId, "activating").pipe(Effect.result);
  // Cancelled while draining: nothing changed; reopen admission.
  if (activating._tag === "Failure") {
    yield* ctx.gate.open;
    return "settled" as RuntimeUpdateAttempt;
  }

  let journal: RuntimeUpdateJournal | undefined;
  let pointed = false;
  const restarted = yield* Effect.gen(function* () {
    const previous = yield* promise(() => ctx.unit.read());
    yield* promise(() => ensureRuntimeUpdateDirectory(ctx.stateDir));
    const backupPath = runtimeUpdateBackupPath(ctx.stateDir, operationId);
    yield* backupDatabaseOffline(ctx.sql, backupPath).pipe(
      Effect.mapError((cause) => stepError(`The offline database backup failed: ${String(cause)}`)),
    );
    journal = {
      revision: 1,
      operationId,
      archiveKey: archiveKey!,
      phase: "restarting",
      backupPath,
      previousConfig: previous.config,
      previousReceipt: previous.receipt,
      failure: null,
      uncertain,
    };
    yield* promise(() => writeRuntimeUpdateJournal(ctx.stateDir, journal!));
    pointed = true;
    yield* promise(() => ctx.unit.pointAt(prepared.success.raw, prepared.success.pins));
    yield* requestBackendRestart(ctx);
  }).pipe(Effect.result);
  if (restarted._tag === "Success") {
    if (uncertain.length)
      yield* Effect.logWarning("Runtime update interrupted turns whose outcome is uncertain", {
        threads: uncertain,
      });
    yield* superviseBackendRestart(ctx);
    return "restarting" as RuntimeUpdateAttempt;
  }
  // No restart was queued, so this is still the old runtime and nothing was admitted: undo the
  // switch, then report the failure.
  const undone = yield* promise(async () => {
    if (journal && pointed) await ctx.unit.restore(journal.previousConfig, journal.previousReceipt);
    if (journal) await clearRuntimeUpdateJournal(ctx.stateDir, journal);
  }).pipe(Effect.result);
  const reason = restarted.failure.message;
  return yield* fail(
    undone._tag === "Success"
      ? `Activation failed before the restart; the previous runtime keeps running. ${reason}`
      : `Activation failed and the previous service config could not be restored; repair is needed. ${reason}`,
  );
});

/**
 * Drives one operation from staged to a restart request, deferring while work blocks it.
 * Returns when the operation settles, is cancelled, or the restart was requested.
 */
export const runRuntimeActivation = Effect.fn("RuntimeUpdate.runActivation")(function* (
  ctx: RuntimeUpdateActivationContext,
  operationId: string,
) {
  const service = yield* ctx.service;
  while (true) {
    const status = yield* service.status({ operationId }).pipe(Effect.result);
    if (status._tag === "Failure") return;
    const view = status.success.operation;
    if (!view || isTerminalRuntimeUpdateState(view.state) || view.state === "activating") return;
    if (view.state !== "awaiting-drain") {
      const moved = yield* service.advance(operationId, "awaiting-drain").pipe(Effect.result);
      if (moved._tag === "Failure") return;
    }
    const attempt = yield* service
      .withSingleFlight(
        (store, archiveKey) =>
          attemptRuntimeActivation(ctx, service, {
            operationId,
            store,
            archiveKey,
            interrupting: view.consent === "recorded",
          }),
        operationId,
      )
      .pipe(Effect.orElseSucceed(() => "deferred" as RuntimeUpdateAttempt));
    if (attempt !== "deferred") return;
    const deferred = yield* service.advance(operationId, "deferred").pipe(Effect.result);
    if (deferred._tag === "Failure") return;
    yield* Effect.sleep(Duration.millis(ctx.deferRetryMs ?? 15_000));
  }
});
