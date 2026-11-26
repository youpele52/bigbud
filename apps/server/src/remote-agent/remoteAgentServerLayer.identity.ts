import { runSshCommand } from "../ssh/sshProcess.ts";
import { buildRemoteAgentIdentityProbeCommand } from "./remoteAgentConnection.identity.ts";
import { REMOTE_AGENT_DEFAULT_BINARY } from "./remoteAgentControl.ops.ts";
import { makeRemoteAgentOwnerExec } from "./remoteAgentControl.owner.ts";
import { remoteAgentOwnerSelection } from "./remoteAgentControl.selection.ts";
import { runRemoteAgentDiagnosedCommand } from "./remoteAgentDiagnostics.ts";

/**
 * The installed-agent presence probe for the configured binary. Under production activation
 * (U25) it runs the owner's fixed template for that binary, and only the exact legacy probe of
 * that binary is accepted; otherwise the legacy SSH command runs unchanged.
 */
export function makeRemoteAgentIdentityProbe(binaryPath: string) {
  return async (executionTargetId: string, command: string): Promise<string> => {
    const owner = remoteAgentOwnerSelection();
    if (owner) {
      if (command !== buildRemoteAgentIdentityProbeCommand(binaryPath))
        throw new Error("Unexpected remote agent identity probe.");
      const checked = await makeRemoteAgentOwnerExec(
        owner,
        executionTargetId,
      )({
        kind: "binaryCheck",
        binaryPath: binaryPath === REMOTE_AGENT_DEFAULT_BINARY ? null : binaryPath,
      });
      return checked.stdout;
    }
    const presence = await runRemoteAgentDiagnosedCommand(runSshCommand, "check", {
      executionTargetId,
      command: "sh",
      args: ["-lc", command],
      timeoutMs: 30_000,
      maxBufferBytes: 1024,
    });
    return presence.stdout;
  };
}
