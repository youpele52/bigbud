import type { OrchestrationReadModel, OrchestrationThread } from "@bigbud/contracts";
import { resolveThreadWorkspaceRoot } from "../lib/mobileModels";

import type { MobileDraftThread } from "../lib/mobileDraftThread";

export function resolveDraftWorkspaceRoot(
  snapshot: OrchestrationReadModel,
  draft: MobileDraftThread,
): string | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === draft.projectId);
  return draft.worktreePath ?? project?.workspaceRoot ?? undefined;
}

/** Resolve the transcript workspace without treating a historical provider as a runtime. */
export function resolveMobileThreadWorkspaceRoot(
  snapshot: OrchestrationReadModel | undefined,
  thread: OrchestrationThread | null,
  draft: MobileDraftThread | null,
): string | undefined {
  if (thread)
    return snapshot
      ? resolveThreadWorkspaceRoot(snapshot, thread)
      : (thread.worktreePath ?? undefined);
  if (draft)
    return snapshot
      ? resolveDraftWorkspaceRoot(snapshot, draft)
      : (draft.worktreePath ?? undefined);
  return undefined;
}
