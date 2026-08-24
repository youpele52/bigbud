import { isRemoteExecutionTargetId } from "@bigbud/contracts/core/baseSchemas";
import type { ServerConfig } from "@bigbud/contracts/server/server";

export function supportsWorkspaceDirectoryWatch(
  executionTargetId: string | undefined,
  workspaceCapabilities: ServerConfig["workspaceCapabilities"],
): boolean {
  if (!isRemoteExecutionTargetId(executionTargetId)) {
    return true;
  }

  return workspaceCapabilities?.remoteAgent.supportsDirectoryWatch === true;
}
