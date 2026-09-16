import type { OrchestrationReadModel } from "@bigbud/contracts";

import type { MobileDraftThread } from "../lib/mobileDraftThread";

export function resolveDraftWorkspaceRoot(
  snapshot: OrchestrationReadModel,
  draft: MobileDraftThread,
): string | undefined {
  const project = snapshot.projects.find((candidate) => candidate.id === draft.projectId);
  return draft.worktreePath ?? project?.workspaceRoot ?? undefined;
}
