/**
 * The sequence clock: server-clock samples of the event-log head (migration 159).
 *
 * The 24-hour hot window used to be found from `occurred_at` alone, assuming it rises with
 * sequence. It often comes from a command's `createdAt` (a client's clock), so a client with a
 * slow clock made recent events look old and shortened the window. A sample says "every event
 * at or below `head_sequence` existed at `observed_at_ms`" by the server's own clock, so the
 * head of the newest sample at least 24 hours old bounds the window from below, whatever
 * `occurred_at` says. Until such a sample exists (a new install, or the first day after the
 * upgrade) the floor falls back to `occurred_at`.
 *
 * Maintenance records a sample whenever it reads the floor and the newest one is at least
 * 5 minutes old, and drops every sample older than the newest one still needed: about 300 rows.
 *
 * @module EventLogMaintenance.sequenceClock
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

export const SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS = 5 * 60_000;

/**
 * Head of the newest sample observed at least `windowMs` ago: every event at or below it is
 * older than the window by the server's clock. Null when no sample is that old. One probe of
 * the primary key.
 */
export const readSequenceClockFloor = (
  sql: SqlClient.SqlClient,
  input: { readonly nowMs: number; readonly windowMs: number },
) =>
  sql<{ readonly head: number }>`
    SELECT head_sequence AS "head" FROM event_log_sequence_clock
    WHERE observed_at_ms <= ${input.nowMs - input.windowMs}
    ORDER BY observed_at_ms DESC LIMIT 1
  `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : Number(rows[0].head))));

/** Records `head` at `nowMs` if the newest sample is old enough, then drops unneeded ones. */
export const recordSequenceClock = Effect.fn("EventLogMaintenance.recordSequenceClock")(
  function* (
    sql: SqlClient.SqlClient,
    input: { readonly nowMs: number; readonly head: number; readonly windowMs: number },
  ) {
    const [newest] = yield* sql<{ readonly at: number | null }>`
      SELECT MAX(observed_at_ms) AS "at" FROM event_log_sequence_clock
    `;
    let newestAt = newest?.at ?? null;
    // Samples dated more than one interval ahead were taken by a clock that jumped forward and
    // was corrected. They would block new samples until the clock caught up with them, silently
    // stalling cleanup, so they are dropped. Dropping samples only makes the window keep more.
    if (newestAt !== null && newestAt > input.nowMs + SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS) {
      yield* sql`DELETE FROM event_log_sequence_clock WHERE observed_at_ms > ${input.nowMs}`;
      const [remaining] = yield* sql<{ readonly at: number | null }>`
        SELECT MAX(observed_at_ms) AS "at" FROM event_log_sequence_clock
      `;
      newestAt = remaining?.at ?? null;
    }
    // A clock that moved back by less than an interval waits until it passes the newest sample.
    if (newestAt !== null && input.nowMs - newestAt < SEQUENCE_CLOCK_SAMPLE_INTERVAL_MS) {
      return false;
    }
    yield* sql`
      INSERT OR IGNORE INTO event_log_sequence_clock (observed_at_ms, head_sequence)
      VALUES (${input.nowMs}, ${Math.max(0, Math.floor(input.head))})
    `;
    // Keep the newest sample at least a window old (it is the boundary) and everything newer.
    yield* sql`
      DELETE FROM event_log_sequence_clock WHERE observed_at_ms < (
        SELECT observed_at_ms FROM event_log_sequence_clock
        WHERE observed_at_ms <= ${input.nowMs - input.windowMs}
        ORDER BY observed_at_ms DESC LIMIT 1
      )
    `;
    return true;
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.recordSequenceClock")),
);
