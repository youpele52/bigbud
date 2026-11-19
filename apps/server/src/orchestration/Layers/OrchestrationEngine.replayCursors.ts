/**
 * In-process registry of open domain-event replay cursors: every `streamDomainEvents`
 * subscriber in this process (reactors, read-model waiters, client streams). A subscriber's
 * stream dies when its next replay page is a gap, so canonical pruning of a deleted entity must
 * not remove any event above the oldest cursor here. Event-log maintenance holds its floor at the
 * engine's own cursors (`EventLogMaintenance.floor`); deletion pruning checks this registry inside
 * its proof transaction (`EntityPurge.proof`), which every pruning path shares.
 *
 * Process-wide like `backgroundSqlActivity`: the cursors are in-memory state of this process, and
 * pruning paths run from many layers (the deletion pipeline, retention upkeep, cleanup recovery,
 * permanent purge) that cannot all depend on the engine. A process with no open stream (the CLI)
 * reports none, so its pruning is not held.
 *
 * @module OrchestrationEngine.replayCursors
 */
import { Duration, Effect } from "effect";

/** A replay cursor: the last sequence the subscriber has read. Only ever advances. */
export interface ReplayCursor {
  readonly sequence: number;
}

const openCursors = new Set<ReplayCursor>();

export const registerReplayCursor = (cursor: ReplayCursor): void => {
  openCursors.add(cursor);
};

export const unregisterReplayCursor = (cursor: ReplayCursor): void => {
  openCursors.delete(cursor);
};

/** Lowest cursor of an open domain-event stream in this process; null while none is open. */
export const oldestOpenReplayCursor = (): number | null => {
  let oldest: number | null = null;
  for (const cursor of openCursors) {
    oldest = oldest === null ? cursor.sequence : Math.min(oldest, cursor.sequence);
  }
  return oldest;
};

/**
 * The oldest open cursor when it has not read through `sequence` yet (pruning events up to
 * `sequence` would put a gap in front of it); null when pruning through `sequence` is safe.
 */
export const replayCursorBehind = (sequence: number): number | null => {
  const oldest = oldestOpenReplayCursor();
  return oldest !== null && oldest < sequence ? oldest : null;
};

export const REPLAY_CURSOR_CATCH_UP_TIMEOUT = Duration.seconds(2);
const REPLAY_CURSOR_POLL_INTERVAL = Duration.millis(20);

/**
 * Waits until every open stream has read through `sequence`, at most `timeout`. Returns whether
 * they did. Healthy subscribers read a new event within milliseconds, so the deletion pipeline
 * waits here before pruning instead of deferring to recovery on a routine race; a subscriber
 * still behind afterwards makes the proof fail and the pruning is retried later.
 */
export const awaitReplayCursorsThrough = Effect.fn("awaitReplayCursorsThrough")(function* (
  sequence: number,
  timeout: Duration.Input = REPLAY_CURSOR_CATCH_UP_TIMEOUT,
) {
  const deadline = Date.now() + Duration.toMillis(Duration.fromInputUnsafe(timeout));
  while (replayCursorBehind(sequence) !== null) {
    if (Date.now() >= deadline) return false;
    yield* Effect.sleep(REPLAY_CURSOR_POLL_INTERVAL);
  }
  return true;
});
