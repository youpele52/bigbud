import type { ThreadId } from "@bigbud/contracts";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import { observeTurnStartRequest, type TurnStartRequestClock } from "./ThreadRecoveryNotice.logic";

/** Enough for every thread a user moves between; older observations are dropped first. */
export const MAX_TURN_START_OBSERVATIONS = 64;

/** Re-inserts `key` as the most recent entry and drops the least recently observed first. */
function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_TURN_START_OBSERVATIONS) break;
    map.delete(oldest);
  }
}

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
  if (next === null) {
    observations.delete(threadId);
    return null;
  }
  remember(observations, threadId, next);
  return next;
}

export function turnStartObservationCount(): number {
  return observations.size;
}

/**
 * When this browser first saw a delegated model choice, keyed by `choiceId`, so the tributary
 * notice and the trunk card count down the same hold across remounts.
 */
const modelChoiceObservations = new Map<string, number>();

export function observeModelChoice(choiceId: string, nowMs: number): number {
  const observedAtMs = modelChoiceObservations.get(choiceId) ?? nowMs;
  remember(modelChoiceObservations, choiceId, observedAtMs);
  return observedAtMs;
}

export function modelChoiceObservationCount(): number {
  return modelChoiceObservations.size;
}

/**
 * When this browser first saw a thread's sleep recovery state, keyed by thread and
 * `sleepRecoveryStateKey`, so the 3 s hide and the 6 s notice survive remounts.
 */
const sleepRecoveryObservations = new Map<string, number>();

export function observeSleepRecoveryState(threadId: ThreadId, stateKey: string, nowMs: number) {
  const key = `${threadId}\0${stateKey}`;
  const observedAtMs = sleepRecoveryObservations.get(key) ?? nowMs;
  remember(sleepRecoveryObservations, key, observedAtMs);
  return observedAtMs;
}
