import type { OrchestrationReadModel, OrchestrationThread, ThreadId } from "@bigbud/contracts";

export function getThreadFromOrchestrationSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | null {
  return snapshot.threads.find((thread) => thread.id === threadId) ?? null;
}
