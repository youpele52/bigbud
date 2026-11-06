import type { NativeApi, OrchestrationReadModel, ProjectId } from "@bigbud/contracts";

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

export function collectRemoteWorkspaceWorktreePaths(
  snapshot: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<string> {
  return Array.from(
    new Set(
      snapshot.threads
        .filter((thread) => thread.projectId === projectId && thread.deletedAt === null)
        .map((thread) => thread.worktreePath?.trim())
        .filter((worktreePath): worktreePath is string => Boolean(worktreePath)),
    ),
  );
}

async function verifyRemoteWorkspaceWorktrees(input: {
  readonly api: NativeApi;
  readonly projectId: ProjectId;
  readonly executionTargetId: string;
}): Promise<ReadonlyArray<string>> {
  const snapshot = await input.api.orchestration.getSnapshot();
  const paths = collectRemoteWorkspaceWorktreePaths(snapshot, input.projectId);
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
