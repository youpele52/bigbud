import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type { ServerConfig } from "@bigbud/contracts/server/server";
import { ProjectDirectoryWatchError } from "@bigbud/contracts/workspace/project";
import { Schema } from "effect";

export function supportsWorkspaceDirectoryWatch(
  executionTargetId: string | undefined,
  workspaceCapabilities: ServerConfig["workspaceCapabilities"],
): boolean {
  if (!isRemoteExecutionTargetId(executionTargetId)) {
    return true;
  }

  return workspaceCapabilities?.remoteAgent.supportsDirectoryWatch === true;
}

export function shouldRetryWorkspaceDirectoryWatch(error: unknown): boolean {
  return !Schema.is(ProjectDirectoryWatchError)(error) || error.retryable;
}
