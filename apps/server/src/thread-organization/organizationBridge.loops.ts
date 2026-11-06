import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { readOrganizationThreadIds } from "./organizationFacts.query.ts";
import { OrganizationResync } from "./organizationLifecycle.ts";
import type { OrganizationObservation } from "./organizationObservation.ts";
import type { OrganizationOwner } from "./organizationOwner.ts";
import type { OrganizationFrame } from "./organizationProtocol.ts";
import type { OrganizationPublisherState } from "./organizationBridge.publisher.ts";

/** Wall/monotonic bounds, all aligned with the Rust session contract. */
export const ORGANIZATION_BRIDGE_TIMING = {
  heartbeatMs: 1_000,
  observationMs: 200,
  /** Clock gap that invalidates owner observations (sleep/wake); routine resync only. */
  discontinuityMs: 75_000,
  nativeSilenceMs: 15_000,
  activationTotalMs: 60_000,
  activationProgressMs: 10_000,
  sweepMs: 15_000,
  sweepPage: 32,
  refreshBudget: 32,
  refreshBudgetMs: 200,
  /** Ledger retention cadence; housekeeping only, shared across bridge attempts. */
  ledgerPruneMs: 3_600_000,
} as const;

export interface OrganizationNativeLiveness {
  ready: boolean;
  launchedAt: number;
  /** Last snapshot frame written; Rust's progress clock starts from admission of frames. */
  progressAt: number;
  lastNativeAt: number;
}

/** Independent liveness fiber: never waits on fact observation or canonical commands, so a slow
 * DB read or proposal cannot starve heartbeats in either direction. A clock discontinuity is
 * reported once through `resync` and beating continues, so a resync deferred behind an
 * in-flight proposal never turns into a Rust owner timeout. Until that resync fences the
 * owner, `observedAtMs` stays frozen: acceptance refuses proposals against untrusted samples.
 */
export function makeOrganizationHeartbeat(input: {
  owner: OrganizationOwner;
  liveness: OrganizationNativeLiveness;
  state: OrganizationPublisherState;
  send: (frame: OrganizationFrame) => Effect.Effect<void, Error>;
  resync: (error: OrganizationResync) => void;
  now?: () => number;
}) {
  const T = ORGANIZATION_BRIDGE_TIMING;
  const now = input.now ?? Date.now;
  let previous = now();
  let discontinuous = false;
  return Effect.gen(function* () {
    const at = now();
    // Sleep/wake or a wall-clock correction makes owner samples untrustworthy: resample all.
    if (!discontinuous && (at < previous || at - previous > T.discontinuityMs)) {
      discontinuous = true;
      input.resync(new OrganizationResync("organisation clock discontinuity requires fresh facts"));
    }
    previous = at;
    const { liveness } = input;
    if (!liveness.ready) {
      const progress = Math.max(liveness.progressAt, liveness.lastNativeAt);
      if (at - liveness.launchedAt > T.activationTotalMs || at - progress > T.activationProgressMs)
        return yield* Effect.fail(new Error("organisation native activation timed out"));
      return;
    }
    if (!discontinuous && at - liveness.lastNativeAt > T.nativeSilenceMs)
      return yield* Effect.fail(new Error("organisation native heartbeat timed out"));
    if (!discontinuous) input.owner.observedAtMs = at;
    yield* input.send({
      backendNonce: input.owner.backendNonce,
      generation: input.owner.generation,
      type: "heartbeat",
      value: { sequence: input.state.sequence },
    });
  });
}

/** Bounded observation pass: cheap indexed membership sweep every 15s, then at most 32 dirty
 * threads or 200ms of refresh work. A single SQLite statement cannot be preempted; heartbeats
 * run on their own fiber so such a statement delays observations only.
 */
export function makeOrganizationObservationPass(input: {
  sql: SqlClient.SqlClient;
  liveness: OrganizationNativeLiveness;
  observations: OrganizationObservation;
  captureOverflowed: Effect.Effect<boolean>;
  refresh: (threadId: string) => Effect.Effect<void, Error>;
  /** Threads Rust currently holds. A finished sweep re-observes any it did not see, so a
   * deletion mark dropped by an overflowing set still ends in a tombstone (or a resync).
   */
  published?: () => Iterable<string>;
  now?: () => number;
}) {
  const T = ORGANIZATION_BRIDGE_TIMING;
  const now = input.now ?? Date.now;
  let scanning = false;
  let scanAfter: string | undefined;
  let seen = new Set<string>();
  let nextSweepAt = now() + T.sweepMs;
  return Effect.gen(function* () {
    if (yield* input.captureOverflowed)
      return yield* Effect.fail(new OrganizationResync("organisation capture overflow"));
    if (!input.liveness.ready) return;
    const { observations } = input;
    const at = now();
    if (!scanning && (observations.rescan || at >= nextSweepAt)) {
      scanning = true;
      observations.rescan = false;
      scanAfter = undefined;
      seen = new Set();
    }
    if (scanning) {
      const page = yield* readOrganizationThreadIds(input.sql, scanAfter, T.sweepPage);
      for (const row of page) {
        observations.mark(row.threadId);
        seen.add(row.threadId);
      }
      scanAfter = page.at(-1)?.threadId;
      if (page.length < T.sweepPage) {
        scanning = false;
        nextSweepAt = at + T.sweepMs;
        for (const id of input.published?.() ?? []) if (!seen.has(id)) observations.mark(id);
        seen = new Set();
      }
    }
    const started = now();
    for (let count = 0; count < T.refreshBudget && now() - started < T.refreshBudgetMs; count++) {
      const id = observations.take();
      if (id === undefined) break;
      yield* input.refresh(id);
    }
  });
}

/** Ledger retention at most once per interval across bridge attempts. A failure is logged and
 * retried at the next interval; it is never a scheduling fault, so it cannot pause automation.
 */
export function makeOrganizationLedgerPruner<E>(input: {
  prune: (nowMs: number) => Effect.Effect<number, E>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let lastAt: number | undefined;
  return Effect.suspend(() => {
    const at = now();
    if (lastAt !== undefined && at - lastAt < ORGANIZATION_BRIDGE_TIMING.ledgerPruneMs)
      return Effect.void;
    lastAt = at;
    return input.prune(at).pipe(
      Effect.tap((removed) =>
        removed > 0
          ? Effect.logInfo(`Pruned ${removed} settled thread organisation operations.`)
          : Effect.void,
      ),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread organisation ledger retention failed; retrying later.", cause),
      ),
    );
  });
}
