/**
 * Event-log maintenance's own baseline checkpoints. Deletion paths verify a new projection
 * baseline whenever they delete; without deletions the newest verified baseline stops moving
 * and holds the floor, so the log stops draining and Settings reports "waiting for a saved
 * database checkpoint". When the `baseline` component holds the floor well below every other
 * holder, maintenance asks the projection pipeline to capture and verify one itself, through
 * the same single-flight coordinator the deletion paths use.
 *
 * Capture reads every projection table and verification replays the events since the previous
 * baseline, so a refresh only runs on a full-mode tick (the app is idle), when the gap is at
 * least `BASELINE_REFRESH_MIN_GAP` sequences, and at most once per `BASELINE_REFRESH_INTERVAL_MS`
 * whatever its outcome. A failed refresh is logged and the tick continues on the old floor.
 *
 * @module EventLogMaintenance.baselineRefresh
 */
import type { EventLogFloorHolder } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Cause, Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";
import type { EventLogMaintenanceTickMode } from "../Services/EventLogMaintenance.ts";
import { type EventLogFloor, resolveEventLogFloor } from "./EventLogMaintenance.floor.ts";

/** Sequences the baseline must hold the floor back by before maintenance captures one. */
export const BASELINE_REFRESH_MIN_GAP = 10_000;
/** Shortest time between two refresh attempts, successful or not. */
export const BASELINE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The sequence a fresh baseline must cover for the floor to move: the floor every other holder
 * allows. `null` when the baseline does not hold the floor, or holds it back by too little.
 */
export function baselineRefreshTarget(
  floor: Pick<EventLogFloor, "heldBy" | "floor" | "head" | "components">,
): number | null {
  if (floor.heldBy !== "baseline") return null;
  const others: Record<EventLogFloorHolder, number | null> = {
    ...floor.components,
    baseline: null,
  };
  const unblocked = resolveEventLogFloor(others, floor.head).floor;
  return unblocked - floor.floor >= BASELINE_REFRESH_MIN_GAP ? unblocked : null;
}

export interface BaselineRefreshInput {
  readonly floor: EventLogFloor;
  readonly mode: EventLogMaintenanceTickMode;
  readonly nowMs: number;
  /** When the last refresh was attempted; null when never in this process. */
  readonly lastAttemptAtMs: number | null;
  readonly refresh:
    | ((throughSequence: number) => Effect.Effect<void, ProjectionRepositoryError>)
    | undefined;
}

/**
 * Runs one refresh when due. Returns the attempt time when one ran (so the caller records it
 * and re-reads the floor), or `null` when nothing ran. Never fails; interruption propagates.
 */
export const maybeRefreshBaseline = Effect.fn("EventLogMaintenance.refreshBaseline")(function* (
  input: BaselineRefreshInput,
) {
  if (input.refresh === undefined || input.mode !== "full") return null;
  if (
    input.lastAttemptAtMs !== null &&
    input.nowMs - input.lastAttemptAtMs < BASELINE_REFRESH_INTERVAL_MS
  ) {
    return null;
  }
  const target = baselineRefreshTarget(input.floor);
  if (target === null) return null;
  yield* input.refresh(target).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("event log maintenance could not verify a new baseline", {
            floorSequence: input.floor.floor,
            targetSequence: target,
            cause: Cause.pretty(cause),
          }),
    ),
  );
  return input.nowMs;
});
