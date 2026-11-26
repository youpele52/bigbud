import { readSshOwnerProductionOwner } from "../ssh/sshOwnerProductionRegistry.ts";
import type { RemoteAgentOwnerControlDependencies } from "./remoteAgentControl.owner.ts";

/**
 * U25: every remote-agent control, install and read-only probe runs through the live SSH
 * owner. There is no TypeScript SSH path.
 */
export function remoteAgentOwnerSelection(): RemoteAgentOwnerControlDependencies {
  return { owner: readSshOwnerProductionOwner };
}
