import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import {
  LOCAL_SHELL_HOST,
  shellKind,
  shellProfileId,
} from "../terminal/Layers/ShellProfiles.identity.ts";
import { parseRemoteAgentShellLaunch } from "../remote-agent/remoteAgentShellLaunch.ts";
import { resolveCommandPath } from "../utils/commandPath.ts";
import { localSupervisorShellHost } from "./localSupervisorIdentity.ts";

/** Translate a server-resolved local candidate into immutable, authority-scoped Rust intent. */
export function localSupervisorLaunch(input: PtySpawnInput, target: string) {
  const host = localSupervisorShellHost(target);
  const args = [...(input.args ?? [])];
  const executable = input.shell.startsWith("/")
    ? input.shell
    : resolveCommandPath(input.shell, { platform: "linux", env: input.env });
  if (!executable) throw new Error("The requested terminal shell is unavailable on this backend.");
  const profile = input.shellProfile;
  if (profile?.selection.kind === "profile") {
    if (
      profile.host.kind !== "local" ||
      profile.host.hostId !== LOCAL_SHELL_HOST.hostId ||
      profile.profileId !== shellProfileId(LOCAL_SHELL_HOST, executable, args, "linux") ||
      profile.kind !== shellKind(executable, "linux")
    )
      throw new Error(
        "The selected local shell profile does not match its server-resolved candidate.",
      );
  }
  return parseRemoteAgentShellLaunch({
    version: 1,
    cwd: input.cwd,
    executable,
    args,
    platform: "linux",
    integration: "disabled",
    requestedProfile: {
      host,
      profileId: shellProfileId(host, executable, args, "linux"),
      kind: shellKind(executable, "linux"),
    },
  });
}
