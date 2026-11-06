import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";

import { organizationWithAge } from "./threadOrganization.aging.ts";
import { DEFAULT_THREAD_ORGANIZATION } from "@bigbud/contracts/orchestration/orchestration.organization.ts";
import { updateThread } from "./projectorHelpers.ts";

/** Applies a `thread.organization-updated` event's recorded organization to the thread. */
export function projectThreadOrganization(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): OrchestrationReadModel {
  if (event.type !== "thread.organization-updated") return model;
  const { threadId } = event.payload;
  const thread = model.threads.find((thread) => thread.id === threadId);
  if (!thread) return model;
  const organization = organizationWithAge(
    thread.organization ?? DEFAULT_THREAD_ORGANIZATION,
    event.payload,
  );
  return { ...model, threads: updateThread(model.threads, threadId, { organization }) };
}
