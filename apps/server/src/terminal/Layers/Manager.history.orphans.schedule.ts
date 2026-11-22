/**
 * Runs the orphaned terminal-history sweep (`Manager.history.orphans`) shortly after startup and
 * then hourly. The first run waits a minute so host adoption has reported lost PTYs; the sweep
 * only removes files of threads with no projection row, and a projection read failure removes
 * nothing.
 *
 * @module Manager.history.orphans.schedule
 */
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import type { TerminalManagerShape } from "../Services/Manager";
import type { MissingThreadIds } from "./Manager.history.orphans";

const QUERY_CHUNK = 500;
export const ORPHANED_HISTORY_SWEEP_DELAY = "1 minute";
export const ORPHANED_HISTORY_SWEEP_INTERVAL = "1 hour";

/** Thread ids with no `projection_threads` row; none when the projection cannot be read. */
export function projectionMissingThreadIds(sql: SqlClient.SqlClient): MissingThreadIds {
  return (threadIds) =>
    Effect.gen(function* () {
      const present = new Set<string>();
      for (let start = 0; start < threadIds.length; start += QUERY_CHUNK) {
        const chunk = threadIds.slice(start, start + QUERY_CHUNK);
        const rows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM projection_threads
          WHERE thread_id IN ${sql.in(chunk)}
        `;
        for (const row of rows) present.add(row.threadId);
      }
      return new Set(threadIds.filter((threadId) => !present.has(threadId))) as ReadonlySet<string>;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("orphaned terminal history sweep skipped: projection unreadable", {
          cause,
        }).pipe(Effect.as(new Set<string>() as ReadonlySet<string>)),
      ),
    );
}

/** One sweep, logged when it removed or kept anything. */
export const runOrphanedHistorySweep = Effect.fn("terminal.runOrphanedHistorySweep")(function* (
  manager: Pick<TerminalManagerShape, "sweepOrphanedHistory">,
  missingThreadIds: MissingThreadIds,
) {
  if (!manager.sweepOrphanedHistory) return;
  const result = yield* manager.sweepOrphanedHistory(missingThreadIds);
  if (result.removed > 0 || result.kept > 0)
    yield* Effect.logInfo("swept orphaned terminal history", result);
});

/** Forks the delayed startup sweep and the hourly repeat into the current scope. */
export const scheduleOrphanedHistorySweep = Effect.fn("terminal.scheduleOrphanedHistorySweep")(
  function* (
    manager: Pick<TerminalManagerShape, "sweepOrphanedHistory">,
    missingThreadIds: MissingThreadIds,
  ) {
    yield* runOrphanedHistorySweep(manager, missingThreadIds).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced(ORPHANED_HISTORY_SWEEP_INTERVAL)),
      Effect.delay(ORPHANED_HISTORY_SWEEP_DELAY),
      Effect.forkScoped,
    );
  },
);
