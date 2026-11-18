/**
 * Shared context and settlement helpers for runtime activation (M3 WP-4D).
 */
import { Data, Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { RuntimeMaintenanceGateShape } from "../command-admission/RuntimeMaintenanceGate.ts";
import type { RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import { releaseRuntimeArchive, type RuntimeArchiveStore } from "./runtimeArchive.store.ts";
import type { RuntimeUpdateDiskProbe } from "./runtimeUpdate.disk.ts";
import type { RuntimeUpdateDrainProbe } from "./runtimeUpdate.drain.ts";
import { runtimeUpdateFailureText } from "./runtimeUpdate.states.ts";
import type { RuntimeUpdateServiceUnit } from "./runtimeUpdate.unit.ts";
import type { RemoteRuntimeUpdateShape } from "./Services/RemoteRuntimeUpdate.ts";

export interface RuntimeUpdateActivationContext {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly sql: SqlClient.SqlClient;
  readonly gate: RuntimeMaintenanceGateShape;
  readonly probe: RuntimeUpdateDrainProbe;
  readonly unit: RuntimeUpdateServiceUnit;
  /** The operation service; resolves once it is constructed (activation is one of its deps). */
  readonly service: Effect.Effect<RemoteRuntimeUpdateShape>;
  /** Readiness of the runtime under trial (startup command readiness, database check). */
  readonly trialReadiness: Effect.Effect<void, RuntimeUpdateStepError>;
  /** The Node entry this process runs, to prove the restart reached the staged graph. */
  readonly runningEntryPath: () => string;
  /** This runtime's version; an older target is refused before any outage. */
  readonly runningVersion: string;
  readonly diskProbe?: RuntimeUpdateDiskProbe;
  readonly deferRetryMs?: number;
  readonly drain?: {
    readonly inFlightTimeoutMs?: number;
    readonly settleTimeoutMs?: number;
    readonly pollMs?: number;
  };
}

/** A failed activation step; its message is bounded and persisted as the operation failure. */
export class RuntimeUpdateStepError extends Data.TaggedError("RuntimeUpdateStepError")<{
  readonly message: string;
}> {}
export const stepError = (cause: unknown) =>
  new RuntimeUpdateStepError({
    message: typeof cause === "string" ? cause.slice(0, 1024) : runtimeUpdateFailureText(cause),
  });

export const promise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: stepError });

/**
 * Settles an operation as failed under the single-flight lock: persists the reason, releases the
 * staged archive reservation (WP-4C contract) and reopens admission. Never fails.
 */
export const settleRuntimeUpdateFailed = Effect.fn("RuntimeUpdate.settleFailed")(function* (
  ctx: RuntimeUpdateActivationContext,
  service: RemoteRuntimeUpdateShape,
  input: {
    readonly operationId: string;
    readonly store: RuntimeArchiveStore;
    readonly archiveKey: string | null;
    readonly failure: string;
    /** Settle a journal first; the caller reopens admission afterwards. */
    readonly keepClosed?: boolean;
  },
) {
  yield* service
    .advance(input.operationId, "failed", input.failure.slice(0, 1024))
    .pipe(
      Effect.catch((error) => Effect.logWarning("Runtime update failure not persisted", error)),
    );
  if (input.archiveKey) {
    const key = input.archiveKey as RuntimeArchiveKey;
    yield* promise(() => releaseRuntimeArchive(input.store, key)).pipe(
      Effect.catch((error) => Effect.logWarning("Runtime update release failed", error)),
    );
  }
  if (!input.keepClosed) yield* ctx.gate.open;
});

const release = (version: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);

/**
 * An older runtime would refuse the newer database schema at startup, before it could run its
 * trial or roll back, so a downgrade is refused while the current runtime still serves.
 */
export function runtimeUpdateDowngradeRefusal(running: string, target: string): string | null {
  const [from, to] = [release(running), release(target)];
  if (!from || !to) return null;
  for (let index = 0; index < 3; index++) {
    if (to[index]! > from[index]!) return null;
    if (to[index]! < from[index]!)
      return `Downgrading from ${running} to ${target} is refused: an older runtime cannot open this database. Nothing was stopped.`;
  }
  return null;
}
