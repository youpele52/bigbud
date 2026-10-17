import { Schema } from "effect";
import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";

export const USER_TURN_BOUND = "text-generation.user-turn-bound";
export const MODEL_SUCCEEDED = "text-generation.model-succeeded";

interface Activity {
  readonly kind: string;
  readonly turnId: string | null;
  readonly payload: unknown;
}

/** Only distinct persisted user submissions with verified completion count; metadata jobs never bind. */
export function successfulUserTurns(activities: ReadonlyArray<Activity>) {
  const bindings = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind !== USER_TURN_BOUND || !activity.turnId) continue;
    const payload = activity.payload as { messageId?: unknown } | null;
    if (typeof payload?.messageId === "string") bindings.set(activity.turnId, payload.messageId);
  }
  const seen = new Set<string>();
  const turns: Array<{ messageId: string; turnId: string; model: ModelSelection }> = [];
  for (const activity of activities) {
    if (
      activity.kind !== MODEL_SUCCEEDED ||
      !activity.turnId ||
      !Schema.is(ModelSelection)(activity.payload)
    )
      continue;
    const messageId = bindings.get(activity.turnId);
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    turns.push({ messageId, turnId: activity.turnId, model: activity.payload });
  }
  return turns;
}
