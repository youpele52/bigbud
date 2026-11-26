import type { RemoteAgentTargetTriple } from "./remoteAgentArtifact.ts";
import { parseRemoteAgentCheckOutput, remoteAgentIdentityMatches } from "./remoteAgentIdentity.ts";
import { RemoteAgentStageDefinitiveError } from "./remoteAgentInstall.stage.ts";

export class RemoteAgentInstallManagerError extends Error {
  readonly _tag = "RemoteAgentInstallManagerError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentInstallManagerError";
  }
}

/**
 * The installed candidate's `--check` must name the signed build, Linux and the target's
 * architecture. Shared by the legacy and the production (U25) installers.
 */
export function assertInstalledRemoteAgentCheck(
  stdout: string,
  input: {
    readonly targetTriple: RemoteAgentTargetTriple;
    readonly version: string;
    readonly buildDigest: string;
    readonly protocolMajor: number;
    readonly protocolMinor: number;
  },
): void {
  try {
    const identity = parseRemoteAgentCheckOutput(stdout);
    const architecture = input.targetTriple.startsWith("aarch64") ? "aarch64" : "x86_64";
    if (
      !remoteAgentIdentityMatches(identity, input) ||
      identity.operatingSystem !== "linux" ||
      identity.architecture !== architecture
    ) {
      throw new RemoteAgentInstallManagerError(
        "Installed remote agent candidate returned an invalid handshake.",
      );
    }
  } catch (cause) {
    throw new RemoteAgentStageDefinitiveError(
      "Installed remote agent candidate returned an invalid check.",
      { cause },
    );
  }
}
