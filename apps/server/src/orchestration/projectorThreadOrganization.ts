import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { updateThread } from "./projectorHelpers.ts";

/** Applies a `thread.organization-updated` event's recorded organization to the thread. */
export function projectThreadOrganization(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  if (event.type !== "thread.organization-updated") return model;
  const { threadId, organization } = event.payload;
  if (!model.threads.some((thread) => thread.id === threadId)) return model;
  return { ...model, threads: updateThread(model.threads, threadId, { organization }) };
}
