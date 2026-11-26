import { SSH_OWNER_PRODUCTION_ACTIVATION } from "@bigbud/shared/SshOwnerActivation";

import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import type { RemoteAgentOwnerControlDependencies } from "./remoteAgentControl.owner.ts";

/**
 * U25: under production activation every remote-agent control, install and read-only probe
 * runs through the live SSH owner; otherwise the legacy SSH path is unchanged. There is no
 * fallback from one to the other.
 */
export function remoteAgentOwnerSelection(
  activation: boolean = SSH_OWNER_PRODUCTION_ACTIVATION,
): RemoteAgentOwnerControlDependencies | undefined {
  return activation ? { owner: readSshOwnerProductionOwner } : undefined;
}
