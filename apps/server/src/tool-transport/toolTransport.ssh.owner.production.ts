import {
  readSshOwnerProductionOwner,
  type SshOwnerProductionRegistration,
} from "../ssh/sshOwnerProductionRegistry.ts";
import { withProductionWorkspaceOwner } from "../ws/wsSshOwnerProduction.workspace.ts";
import type { TypedSshToolCapability } from "./toolTransport.ssh.owner.ts";

/**
 * W2 T-files production typed tool transport: the closed `TypedSshToolCommand`
 * set over the live owner's client for the exact target and the caller's own
 * root. The generic SSH command runner stays refused under activation
 * (`assertSelectedSshToolTransportAvailable`); this capability is the only path.
 *
 * @module toolTransport.ssh.owner.production
 */
export function makeProductionTypedSshToolCapability(
  targetId: string,
  workspaceRoot: string,
  read: () => SshOwnerProductionRegistration | undefined = readSshOwnerProductionOwner,
): TypedSshToolCapability {
  if (!targetId.startsWith("ssh:") || !workspaceRoot.startsWith("/") || workspaceRoot === "/")
    throw new Error("A production typed SSH tool needs an SSH target and an absolute root.");
  return {
    targetId,
    workspaceRoot,
    withOwner: (id, use, signal) => withProductionWorkspaceOwner(read, id, use, signal),
  };
}
