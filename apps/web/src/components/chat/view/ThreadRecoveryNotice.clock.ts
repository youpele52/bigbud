import type { ThreadId } from "@bigbud/contracts";

import type { ThreadTurnStartRequest } from "../../../models/types/app.types";
import { observeTurnStartRequest, type TurnStartRequestClock } from "./ThreadRecoveryNotice.logic";

/** One browser-clock observation per thread, kept across remounts (switching threads). */
const observations = new Map<ThreadId, TurnStartRequestClock>();

export function observeThreadTurnStartRequest(
  threadId: ThreadId,
  request: ThreadTurnStartRequest | null | undefined,
  nowMs: number,
): TurnStartRequestClock | null {
  const next = observeTurnStartRequest(observations.get(threadId), request, nowMs);
  if (next === null) observations.delete(threadId);
  else observations.set(threadId, next);
  return next;
}
