import { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.identity.ts";
import { REMOTE_AGENT_DEFAULT_BINARY } from "./remoteAgentControl.ops.ts";
import { makeRemoteAgentOwnerExec } from "./remoteAgentControl.owner.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";

/**
 * The installed-agent presence probe for the configured binary (U25): it runs the owner's fixed
 * template for that binary, and only the exact probe of that binary is accepted.
 */
export function makeRemoteAgentIdentityProbe(binaryPath: string) {
  return async (executionTargetId: string, command: string): Promise<string> => {
    if (command !== buildRemoteAgentIdentityProbeCommand(binaryPath))
      throw new Error("Unexpected remote agent identity probe.");
    const checked = await makeRemoteAgentOwnerExec(
      remoteAgentOwnerSelection(),
      executionTargetId,
    )({
      kind: "binaryCheck",
      binaryPath: binaryPath === REMOTE_AGENT_DEFAULT_BINARY ? null : binaryPath,
    });
    return checked.stdout;
  };
}
