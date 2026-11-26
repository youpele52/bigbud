import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import type { WorkspaceTarget } from "../workspace-target/workspaceTarget.ts";
import {
  type ProductionOwnerRead,
  withProductionWorkspaceOwner,
} from "../ws/wsSshOwnerProduction.workspace.ts";
import {
  makeSelectedOwnerReadinessProbe,
  type RemoteWorkspaceReadiness,
} from "./remoteWorkspaceReadiness.ts";

/**
 * Readiness for a direct SSH workspace through the live production owner's typed
 * workspace readiness verb on the exact target and the session's own root. It is the
 * same capability the session-FS and ACP bridges bind; nothing runs a shell probe.
 *
 * @module remoteWorkspaceReadiness.production
 */
export function probeProductionWorkspaceReadiness(
  workspaceTarget: WorkspaceTarget,
  read: ProductionOwnerRead = readSshOwnerProductionOwner,
): Promise<RemoteWorkspaceReadiness> {
  if (workspaceTarget.location !== "remote") {
    return Promise.reject(new Error("Remote workspace readiness requires a remote workspace."));
  }
  if (!workspaceTarget.cwd) {
    return Promise.reject(
      new Error("Remote workspace readiness requires an explicit workspace root."),
    );
  }
  const targetId = workspaceTarget.executionTargetId;
  return makeSelectedOwnerReadinessProbe({
    targetId,
    workspaceRoot: workspaceTarget.cwd,
    withOwner: (id, use) => withProductionWorkspaceOwner(read, id, use),
  })(workspaceTarget);
}
