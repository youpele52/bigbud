import { type ProjectId } from "@bigbud/contracts";

import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import type { Project } from "../../models/types";
import { isRemoteExecutionTargetId } from "./Sidebar.remoteWorkspaces.logic";
import type { SidebarProjectSnapshot } from "./Sidebar.types";

interface BuildSidebarProjectSnapshotsInput {
  readonly orderedProjects: readonly Project[];
  readonly projectExpandedById: Record<string, boolean>;
  readonly verifiedExecutionTargetIds: Record<string, true>;
}

export function buildSidebarProjectSnapshots(
  input: BuildSidebarProjectSnapshotsInput,
): SidebarProjectSnapshot[] {
  return input.orderedProjects.map((project) => {
    const executionTargetId = resolveWorkspaceExecutionTargetId(project);
    const isDisconnectedRemoteWorkspace =
      isRemoteExecutionTargetId(executionTargetId) &&
      !input.verifiedExecutionTargetIds[executionTargetId];

    return {
      ...project,
      expanded: isDisconnectedRemoteWorkspace
        ? false
        : (input.projectExpandedById[project.id as ProjectId] ?? true),
    };
  });
}
