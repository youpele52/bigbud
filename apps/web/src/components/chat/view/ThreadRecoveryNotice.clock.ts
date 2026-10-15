import type { ThreadId } from "@bigbud/contracts";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import { observeTurnStartRequest, type TurnStartRequestClock } from "./ThreadRecoveryNotice.logic";

/** Enough for every thread a user moves between; older observations are dropped first. */
export const MAX_TURN_START_OBSERVATIONS = 64;

/**
 * One browser-clock observation per thread, kept across remounts (switching threads). Bounded:
 * a cleared request removes its entry, and the least recently observed thread goes first.
 */
const observations = new Map<ThreadId, TurnStartRequestClock>();

export function observeThreadTurnStartRequest(
  threadId: ThreadId,
  request: ThreadTurnStartRequest | null | undefined,
  nowMs: number,
): TurnStartRequestClock | null {
  const next = observeTurnStartRequest(observations.get(threadId), request, nowMs);
  observations.delete(threadId);
  if (next === null) return null;
  observations.set(threadId, next);
  for (const oldest of observations.keys()) {
    if (observations.size <= MAX_TURN_START_OBSERVATIONS) break;
    observations.delete(oldest);
  }
  return next;
}

export function turnStartObservationCount(): number {
  return observations.size;
}
