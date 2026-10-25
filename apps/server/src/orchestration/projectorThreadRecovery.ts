import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { updateThread } from "./projectorHelpers.ts";

/** Applies a `thread.recovery-updated` event to the thread's visible recovery state. */
export function projectThreadRecovery(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  if (event.type !== "thread.recovery-updated") return model;
  const { threadId, recovery } = event.payload;
  if (!model.threads.some((thread) => thread.id === threadId)) return model;
  return { ...model, threads: updateThread(model.threads, threadId, { recovery }) };
}
