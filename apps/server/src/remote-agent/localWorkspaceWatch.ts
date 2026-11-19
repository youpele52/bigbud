import { realpath } from "node:fs/promises";

import { isLocalExecutionTarget } from "../executionTargets.ts";
import type { LocalWorkspaceAgentShape } from "../workspace-runtime/Services/LocalWorkspaceAgent.ts";
import type { WorkspaceWatchShape } from "../workspace-runtime/Services/WorkspaceWatch.ts";
import { makeAgentWorkspaceWatch, type AgentWorkspaceWatchOptions } from "./agentWorkspaceWatch.ts";

function localTargetId(executionTargetId: string | undefined): string {
  if (!isLocalExecutionTarget(executionTargetId)) {
    throw new Error("The local workspace watcher requires a local execution target.");
  }
  return "local";
}

export function makeLocalWorkspaceWatch(
  agent: Pick<LocalWorkspaceAgentShape, "getWorkspaceClient">,
  options: AgentWorkspaceWatchOptions = {},
): WorkspaceWatchShape {
  return makeAgentWorkspaceWatch(
    { resolve: () => agent.getWorkspaceClient() },
    {
      id: localTargetId,
      workspaceIdentity: realpath,
      operation: "localWorkspace.watchDirectory",
    },
    options,
  );
}
