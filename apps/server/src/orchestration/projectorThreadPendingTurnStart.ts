import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { mayChangePendingTurnStart, nextPendingTurnStart } from "./PendingTurnStart.logic.ts";
import { updateThread } from "./projectorHelpers.ts";

/** Applies the durable pending-start gate after an event's own projection. */
export function projectThreadPendingTurnStart(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  if (!mayChangePendingTurnStart(event) || !("threadId" in event.payload)) return model;
  const threadId = event.payload.threadId;
  const thread = model.threads.find((entry) => entry.id === threadId);
  if (!thread) return model;
  const current = thread.pendingTurnStart ?? null;
  const next = nextPendingTurnStart(current, event);
  if (next === undefined || next === current) return model;
  return { ...model, threads: updateThread(model.threads, threadId, { pendingTurnStart: next }) };
}
