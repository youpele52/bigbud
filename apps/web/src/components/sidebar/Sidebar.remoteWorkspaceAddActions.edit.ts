import type { NativeApi, ProjectId } from "@bigbud/contracts";
import {
  PROJECT_WORKTREE_PATHS_MAX,
  type GetProjectWorktreePathsResult,
} from "@bigbud/contracts/orchestration/orchestration.detail.paging.ts";

import { buildExplicitExecutionTargets } from "../../lib/providerExecutionTargets";
import { dispatchCommandWithOutcomeRecovery } from "../../lib/orchestrationCommandRecovery";
import { newCommandId } from "../../lib/utils";
import { readNativeApi } from "../../rpc/nativeApi";
import { useRemoteAccessStore } from "../../stores/remoteAccess/remoteAccess.store";
import { connectExecutionTargetForSetup } from "../../stores/remoteAccess/remoteAccess.connect";
import {
  createRemoteWorkspaceExecutionTargetId,
  type RemoteWorkspaceDraft,
} from "./Sidebar.remoteWorkspaces.logic";

/** Unique, non-blank worktree paths from the bounded per-project read. */
export function collectRemoteWorkspaceWorktreePaths(
  result: Pick<GetProjectWorktreePathsResult, "worktreePaths">,
): ReadonlyArray<string> {
  return Array.from(
    new Set(
      result.worktreePaths
        .map((worktreePath) => worktreePath.trim())
        .filter((worktreePath) => worktreePath.length > 0),
    ),
  );
}

async function verifyRemoteWorkspaceWorktrees(input: {
  readonly api: NativeApi;
  readonly projectId: ProjectId;
  readonly executionTargetId: string;
}): Promise<ReadonlyArray<string>> {
  const result = await input.api.orchestration.getProjectWorktreePaths({
    projectId: input.projectId,
  });
  if (result.truncated) {
    // Every worktree must be verified before the server accepts the edit; never verify a subset.
    throw new Error(
      `This project has more than ${PROJECT_WORKTREE_PATHS_MAX} worktrees, too many to verify on the new SSH target.`,
    );
  }
  const paths = collectRemoteWorkspaceWorktreePaths(result);
  const results = await Promise.allSettled(
    paths.map((cwd) =>
      input.api.server.verifyExecutionTarget({ executionTargetId: input.executionTargetId, cwd }),
    ),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${paths[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        ]
      : [],
  );
  if (failures.length > 0) {
    throw new Error(`The new SSH target cannot access these worktrees:\n${failures.join("\n")}`);
  }
  return paths;
}

export async function reconfigureRemoteWorkspace(input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly draft: RemoteWorkspaceDraft;
  readonly expectedUpdatedAt: string;
}): Promise<string | null> {
  const api = readNativeApi();
  if (!api) {
    return "Native API not found.";
  }

  return reconfigureRemoteWorkspaceWithApi({ ...input, api });
}

export async function reconfigureRemoteWorkspaceWithApi(input: {
  readonly api: NativeApi;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly draft: RemoteWorkspaceDraft;
  readonly expectedUpdatedAt: string;
}): Promise<string | null> {
  const { api } = input;

  try {
    const executionTargets = buildExplicitExecutionTargets({
      workspaceExecutionTargetId: createRemoteWorkspaceExecutionTargetId(input.draft),
      providerRuntimeLocation: input.draft.providerRuntimeLocation,
    });
    await connectExecutionTargetForSetup(api, executionTargets.workspaceExecutionTargetId);
    const verifiedWorktreePaths = await verifyRemoteWorkspaceWorktrees({
      api,
      projectId: input.projectId,
      executionTargetId: executionTargets.workspaceExecutionTargetId,
    });
    await dispatchCommandWithOutcomeRecovery(api, {
      type: "project.reconfigure",
      commandId: newCommandId(),
      projectId: input.projectId,
      title: input.title,
      ...executionTargets,
      workspaceRoot: input.draft.workspaceRoot.trim(),
      expectedUpdatedAt: input.expectedUpdatedAt,
      verifiedWorktreePaths,
    });
    useRemoteAccessStore
      .getState()
      .markExecutionTargetVerified(executionTargets.workspaceExecutionTargetId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Failed to update the remote workspace.";
  }
}
