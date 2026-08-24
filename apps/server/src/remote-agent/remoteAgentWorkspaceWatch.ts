import { isLocalExecutionTarget } from "../executionTargets.ts";
import {
  makeAgentWorkspaceWatch,
  type AgentWorkspaceWatchOptions,
  type AgentWorkspaceWatchResolver,
} from "./agentWorkspaceWatch.ts";

export type RemoteWorkspaceWatchResolver = AgentWorkspaceWatchResolver;
export type RemoteWorkspaceWatchOptions = AgentWorkspaceWatchOptions;

function remoteTargetId(executionTargetId: string | undefined): string {
  const target = executionTargetId ?? "local";
  if (isLocalExecutionTarget(target)) {
    throw new Error("The remote workspace watcher requires an SSH execution target.");
  }
  return target;
}

export function makeRemoteWorkspaceWatch(
  resolver: RemoteWorkspaceWatchResolver,
  options: RemoteWorkspaceWatchOptions = {},
) {
  return makeAgentWorkspaceWatch(
    resolver,
    { id: remoteTargetId, operation: "remoteWorkspace.watchDirectory" },
    options,
  );
}
