import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { sameShellHost } from "../terminal/Layers/ShellProfiles.launch.ts";
import { remoteShellHost } from "../terminal/Layers/ShellProfiles.remote.identity.ts";
import type { RemoteAgentOwner } from "./remoteAgentOwners.ts";
import {
  parseRemoteAgentShellLaunch,
  remoteAgentPtyRequestDigest,
} from "./remoteAgentShellLaunch.ts";

/** Recovery uses stored intent, never a new default or a newly discovered executable. */
export function remoteAgentOwnedPtyLaunch(input: PtySpawnInput, owner?: RemoteAgentOwner) {
  if (!input.executionTargetId || !input.remoteCwd)
    throw new Error("Remote terminal execution target and cwd are required.");
  const retained = owner && owner.state !== "terminal" ? owner : undefined;
  const requested = input.shellLaunch && parseRemoteAgentShellLaunch(input.shellLaunch);
  const shellLaunch = retained ? retained.shellLaunch : requested;
  const digestFor = (launch: typeof shellLaunch) =>
    Buffer.from(
      remoteAgentPtyRequestDigest({
        target: input.executionTargetId!,
        cwd: input.remoteCwd!,
        ...(launch ? { shellLaunch: launch } : {}),
      }),
    ).toString("hex");
  if (shellLaunch) {
    const host = remoteShellHost({ executionTargetId: input.executionTargetId });
    if (host.kind !== "ssh" || !sameShellHost(host, shellLaunch.requestedProfile.host))
      throw new Error("Remote terminal profile belongs to another execution host.");
  }
  const digest = digestFor(shellLaunch);
  if (
    retained &&
    (retained.target !== input.executionTargetId ||
      retained.digest !== digest ||
      (requested && digestFor(requested) !== retained.digest))
  )
    throw new Error("Existing terminal launch intent conflicts; no replacement was started.");
  // Schema parsing alone does not detach argv from the caller's mutable array.
  return {
    digest,
    ...(shellLaunch
      ? {
          shellLaunch: {
            ...shellLaunch,
            args: [...shellLaunch.args],
            requestedProfile: {
              ...shellLaunch.requestedProfile,
              host: { ...shellLaunch.requestedProfile.host },
            },
          },
        }
      : {}),
  };
}
