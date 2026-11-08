/**
 * Background upkeep that lets thread retention see only real work, started with the retention
 * scheduler. Every loop is bounded per tick, logs and continues on failure, and is safe to stop
 * at any point because each step is one short transaction that the next tick resumes from.
 *
 * - Lease heartbeat, every minute: renews the expiry of the leases this process holds.
 * - Lease sweep, every 5 minutes: removes at most 100 leases whose holder is gone.
 * - Deferred canonical cleanup, every minute after a 2-minute startup delay: retries at most 10 deletions whose canonical
 *   history cleanup was deferred, with exponential backoff per deletion.
 * - Soft-deleted rows, every minute after the same delay: finishes 25 deletions an older build left soft-deleted.
 *
 * `BIGBUD_DISABLE_THREAD_RETENTION=1` stops the two deletion loops; lease upkeep still runs.
 *
 * @module ThreadRetention.maintenance
 */
import { Cause, type Duration, Effect, Option, Schedule } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runDeferredCanonicalCleanupRetryTick } from "../../deletion/Layers/CanonicalThreadCleanup.retry.ts";
import { runSoftDeletedThreadPurgeTick } from "../../deletion/Layers/SoftDeletedThreadPurge.ts";
import { withBackgroundSqlActivity } from "../../persistence/backgroundSqlActivity.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { renewHeldThreadLeases, THREAD_LEASE_HEARTBEAT_INTERVAL } from "../threadLeaseHeartbeat.ts";
import { sweepThreadLeases, THREAD_LEASE_SWEEP_INTERVAL } from "../threadLeaseSweep.ts";

const DELETION_CLEANUP_INTERVAL: Duration.Input = "1 minute";
/** Startup is the busiest time for the SQLite worker; deletion upkeep waits it out. */
const DELETION_CLEANUP_START_DELAY: Duration.Input = "2 minutes";

const loop = <A, E>(name: string, tick: Effect.Effect<A, E>, interval: Duration.Input) =>
  withBackgroundSqlActivity(tick).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("thread retention maintenance tick failed", {
            task: name,
            cause: Cause.pretty(cause),
          }),
    ),
    Effect.repeat(Schedule.spaced(interval)),
    Effect.asVoid,
  );

/**
 * Resolved when the retention layer is built; `run` runs every loop forever and is forked
 * from `ThreadRetention.start`. Without a SQL client (some tests) it does nothing.
 */
export const makeThreadRetentionMaintenance = Effect.gen(function* () {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const threads = yield* Effect.serviceOption(ProjectionThreadRepository);
  if (Option.isNone(sql)) return { run: Effect.void };
  const client = sql.value;
  // Lease upkeep always runs; disabling retention also stops the background deletion loops.
  const deletionEnabled = process.env.BIGBUD_DISABLE_THREAD_RETENTION !== "1";
  const loops = [
    loop("lease-heartbeat", renewHeldThreadLeases(client), THREAD_LEASE_HEARTBEAT_INTERVAL),
    loop(
      "lease-sweep",
      sweepThreadLeases(client).pipe(
        Effect.tap((swept) =>
          swept.provider + swept.runtime + swept.activity + swept.learning > 0
            ? Effect.logInfo("thread retention swept stale leases", swept)
            : Effect.void,
        ),
      ),
      THREAD_LEASE_SWEEP_INTERVAL,
    ),
    ...(deletionEnabled
      ? deletionLoops(client, threads).map((run) => Effect.delay(run, DELETION_CLEANUP_START_DELAY))
      : []),
  ];
  return { run: Effect.all(loops, { concurrency: "unbounded", discard: true }) };
});

function deletionLoops(
  client: SqlClient.SqlClient,
  threads: Option.Option<typeof ProjectionThreadRepository.Service>,
) {
  return [
    loop(
      "deferred-canonical-cleanup",
      runDeferredCanonicalCleanupRetryTick(client).pipe(
        Effect.tap((result) =>
          result.cleaned + result.failed > 0
            ? Effect.logInfo("deferred canonical thread cleanup retried", result)
            : Effect.void,
        ),
      ),
      DELETION_CLEANUP_INTERVAL,
    ),
    ...(Option.isSome(threads)
      ? [
          loop(
            "soft-deleted-threads",
            runSoftDeletedThreadPurgeTick({ sql: client, threads: threads.value }).pipe(
              Effect.tap((result) =>
                result.purged + result.failed > 0
                  ? Effect.logInfo("soft-deleted threads purged", result)
                  : Effect.void,
              ),
            ),
            DELETION_CLEANUP_INTERVAL,
          ),
        ]
      : []),
  ];
}
