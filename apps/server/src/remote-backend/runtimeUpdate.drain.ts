/**
 * Runtime update drain (M3 WP-4D, D9).
 *
 * Automatic (no recorded consent): any affected work, including a pending approval or user-input
 * request, defers without closing anything. When idle, public admission and the scheduler close,
 * in-flight public commands and the engine's command barrier settle, and the work is checked
 * again; anything that slipped in reopens admission and defers.
 *
 * Interrupting (consent recorded): admission closes, consent is consumed against the work as it
 * stands now (a changed list is stale and reopens admission), each affected thread's turn is
 * interrupted once through the ordinary `thread.turn.interrupt` command (never replayed), and the
 * drain waits a bounded time. Work still running is reported as uncertain; the next runtime's
 * startup recovery marks it interrupted. Independent Rust terminals are never part of the work.
 */
import { Duration, Effect } from "effect";
import type { RemoteRuntimeUpdateAffectedWork } from "@bigbud/contracts/server/remoteBackendUpdate.ts";

import type { RuntimeMaintenanceGateShape } from "../command-admission/RuntimeMaintenanceGate.ts";

export interface RuntimeUpdateDrainProbe {
  /** Live work an activation would stop. Never independent Rust terminals. */
  readonly affectedWork: Effect.Effect<ReadonlyArray<RemoteRuntimeUpdateAffectedWork>>;
  /** Resolves once no engine command is mid-processing. */
  readonly settleCommands: Effect.Effect<void>;
  /** Interrupts the thread's current turn once; never replays it. */
  readonly interruptThread: (threadId: string) => Effect.Effect<void>;
}

export type RuntimeUpdateDrainOutcome =
  | {
      readonly kind: "drained";
      readonly interrupted: ReadonlyArray<string>;
      readonly uncertain: ReadonlyArray<string>;
    }
  | {
      readonly kind: "deferred";
      readonly blocking: ReadonlyArray<RemoteRuntimeUpdateAffectedWork>;
    };

export interface RuntimeUpdateDrainInput<E> {
  readonly gate: RuntimeMaintenanceGateShape;
  readonly probe: RuntimeUpdateDrainProbe;
  /** Consent was recorded for this operation (D9); otherwise the update is automatic. */
  readonly interrupting: boolean;
  /** Consumes the consent right before interrupting; fails stale/reused/required. */
  readonly consumeConsent: Effect.Effect<void, E>;
  readonly inFlightTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
  readonly pollMs?: number;
}

/** Affected work ids are `<threadId>#<what>`, so each item names its owning thread. */
export const affectedWorkThread = (item: RemoteRuntimeUpdateAffectedWork) =>
  item.id.slice(0, Math.max(0, item.id.indexOf("#"))) || item.id;

const waitUntil = (done: Effect.Effect<boolean>, timeoutMs: number, pollMs: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!(yield* done)) {
      if (Date.now() >= deadline) return false;
      yield* Effect.sleep(Duration.millis(pollMs));
    }
    return true;
  });

export const drainForRuntimeUpdate = Effect.fn("RuntimeUpdate.drain")(function* <E>(
  input: RuntimeUpdateDrainInput<E>,
) {
  const { gate, probe } = input;
  const pollMs = input.pollMs ?? 250;
  const deferred = (blocking: ReadonlyArray<RemoteRuntimeUpdateAffectedWork>) =>
    gate.open.pipe(Effect.as({ kind: "deferred", blocking } as RuntimeUpdateDrainOutcome));
  const before = yield* probe.affectedWork;
  if (before.length > 0 && !input.interrupting)
    return { kind: "deferred", blocking: before } as RuntimeUpdateDrainOutcome;

  yield* gate.close;
  const quiet = yield* waitUntil(
    Effect.sync(() => gate.inFlight() === 0),
    input.inFlightTimeoutMs ?? 60_000,
    pollMs,
  );
  if (!quiet) return yield* deferred(yield* probe.affectedWork);
  yield* probe.settleCommands;
  const work = yield* probe.affectedWork;
  if (work.length === 0)
    return { kind: "drained", interrupted: [], uncertain: [] } as RuntimeUpdateDrainOutcome;
  if (!input.interrupting) return yield* deferred(work);

  yield* input.consumeConsent.pipe(Effect.tapError(() => gate.open));
  const threads = [...new Set(work.map(affectedWorkThread))].toSorted();
  yield* Effect.forEach(threads, probe.interruptThread, { discard: true });
  const remaining = () =>
    probe.affectedWork.pipe(
      Effect.map(
        (items) => new Set(items.map(affectedWorkThread).filter((t) => threads.includes(t))),
      ),
    );
  yield* waitUntil(
    remaining().pipe(Effect.map((left) => left.size === 0)),
    input.settleTimeoutMs ?? 30_000,
    pollMs,
  );
  yield* probe.settleCommands;
  const uncertain = [...(yield* remaining())].toSorted();
  return {
    kind: "drained",
    interrupted: threads.filter((thread) => !uncertain.includes(thread)),
    uncertain,
  } as RuntimeUpdateDrainOutcome;
});
