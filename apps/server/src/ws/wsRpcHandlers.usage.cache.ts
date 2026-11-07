import { Deferred, Effect, Exit } from "effect";
import type {
  ServerUsageError,
  ServerUsageRange,
  ServerUsageSummaryResult,
} from "@bigbud/contracts/server/usage.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

export type UsageSummaryLookup = (
  query: ProjectionSnapshotQueryShape,
  range: ServerUsageRange,
) => Effect.Effect<ServerUsageSummaryResult, ServerUsageError>;

interface SummaryEntry {
  readonly result: Deferred.Deferred<ServerUsageSummaryResult, ServerUsageError>;
  /** Null while the lookup runs; then when the resolved summary stops being reused. */
  expiresAtMs: number | null;
}

/**
 * One entry per range (four ranges at most) per database. Entries hold only the lookup's
 * outcome, never a caller's fiber, services or connection closure.
 */
const caches = new WeakMap<ProjectionSnapshotQueryShape, Map<ServerUsageRange, SummaryEntry>>();

/**
 * Short-lived, bounded summaries only: never retain the lifetime contribution rows. Do not carry
 * yesterday's streak past midnight.
 */
function summaryTimeToLiveMs(nowMs: number) {
  const tomorrow = new Date(nowMs);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.min(5_000, tomorrow.getTime() - nowMs);
}

/**
 * Share in-flight reads and brief reopen results across RPC connections to the same database.
 *
 * The lookup runs in a detached fiber that no caller owns, so a caller that goes away (its
 * window closed) interrupts only its own wait: the others still get the summary. Failures are
 * not kept, so the next request retries at once. `lookup` must not capture a connection; it
 * receives the query it reads from.
 */
export function cachedUsageSummary(
  query: ProjectionSnapshotQueryShape,
  lookup: UsageSummaryLookup,
) {
  let entries = caches.get(query);
  if (!entries) {
    entries = new Map();
    caches.set(query, entries);
  }
  const cache = entries;
  return (range: ServerUsageRange) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const existing = cache.get(range);
        if (
          existing !== undefined &&
          (existing.expiresAtMs === null || Date.now() < existing.expiresAtMs)
        ) {
          return restore(Deferred.await(existing.result));
        }
        const entry: SummaryEntry = {
          result: Deferred.makeUnsafe<ServerUsageSummaryResult, ServerUsageError>(),
          expiresAtMs: null,
        };
        cache.set(range, entry);
        const settle = (exit: Exit.Exit<ServerUsageSummaryResult, ServerUsageError>) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(entry.result, exit);
            if (cache.get(range) !== entry) return;
            if (Exit.isFailure(exit)) cache.delete(range);
            else entry.expiresAtMs = Date.now() + summaryTimeToLiveMs(Date.now());
          });
        return Effect.forkDetach(lookup(query, range).pipe(Effect.onExit(settle))).pipe(
          Effect.andThen(restore(Deferred.await(entry.result))),
        );
      }),
    );
}
