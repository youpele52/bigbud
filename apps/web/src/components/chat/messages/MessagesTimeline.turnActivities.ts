import type { NativeApi, ThreadId, TurnId } from "@bigbud/contracts";
import { TURN_ACTIVITIES_DEFAULT_LIMIT } from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";

type TurnActivitiesApi = Pick<NativeApi["orchestration"], "getTurnActivities">;
type MergeTurnActivities = (
  threadId: ThreadId,
  activities: Awaited<ReturnType<TurnActivitiesApi["getTurnActivities"]>>["activities"],
) => void;

const inFlight = new Map<string, Promise<void>>();
const emptyTurnKeys = new Set<string>();
const turnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}\u0000${turnId}`;

/** A turn the server reported no activities for; its work-log control stays hidden. */
export function isKnownEmptyTurn(threadId: ThreadId, turnId: TurnId): boolean {
  return emptyTurnKeys.has(turnKey(threadId, turnId));
}

/**
 * Loads an older turn's newest bounded activities (`getTurnActivities`, served by the
 * thread/turn/sequence index) and merges them into the store. One request per turn at a time.
 */
export function loadTurnActivities(input: {
  readonly api: TurnActivitiesApi;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly merge: MergeTurnActivities;
}): Promise<void> {
  const key = turnKey(input.threadId, input.turnId);
  const running = inFlight.get(key);
  if (running) return running;
  const operation = input.api
    .getTurnActivities({
      threadId: input.threadId,
      turnId: input.turnId,
      limit: TURN_ACTIVITIES_DEFAULT_LIMIT,
    })
    .then((result) => {
      if (result.activities.length === 0) emptyTurnKeys.add(key);
      else input.merge(input.threadId, result.activities);
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, operation);
  return operation;
}
