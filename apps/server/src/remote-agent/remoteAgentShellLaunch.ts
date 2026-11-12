import {
  ExecutionHostShellLaunch,
  parseExecutionHostShellLaunch,
} from "../terminal/Layers/ShellProfiles.launch.metadata.ts";
import { remoteAgentRequestDigest } from "./remoteAgentRequestDigest.ts";

/** Versioned immutable intent only. Neither reservation nor dispatch proves actual identity. */
export const RemoteAgentShellLaunch = ExecutionHostShellLaunch;
export type RemoteAgentShellLaunch = typeof RemoteAgentShellLaunch.Type;

export function parseRemoteAgentShellLaunch(input: unknown): RemoteAgentShellLaunch {
  return parseExecutionHostShellLaunch(input);
}

/** Legacy target/cwd digests remain byte-for-byte unchanged; never hash accepted wire digests. */
export function remoteAgentPtyRequestDigest(input: {
  readonly target: string;
  readonly cwd: string;
  readonly shellLaunch?: RemoteAgentShellLaunch;
}): Uint8Array {
  if (!input.shellLaunch) return remoteAgentRequestDigest({ target: input.target, cwd: input.cwd });
  const launch = parseRemoteAgentShellLaunch(input.shellLaunch);
  if (launch.cwd !== input.cwd) throw new Error("Remote shell launch cwd does not match.");
  const { host, profileId, kind } = launch.requestedProfile;
  // Explicit field order makes equivalent parsed/reserialized owner records stable.
  return remoteAgentRequestDigest({
    version: 1,
    target: input.target,
    cwd: input.cwd,
    profile: {
      host: {
        kind: host.kind,
        hostId: host.hostId,
        ...(host.kind === "wsl"
          ? { distribution: host.distribution, username: host.username }
          : {}),
      },
      profileId,
      kind,
      executable: launch.executable,
      args: launch.args,
      platform: launch.platform,
      integration: "disabled",
    },
  });
}
