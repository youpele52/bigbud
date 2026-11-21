import type { ShellHostScope } from "@bigbud/contracts/workspace/terminalShell.ts";

import { parseRemoteAgentShellLaunch } from "../remote-agent/remoteAgentShellLaunch.ts";
import {
  LOCAL_SHELL_HOST,
  shellKind,
  shellProfileId,
} from "../terminal/Layers/ShellProfiles.identity.ts";
import type { PtySpawnInput } from "../terminal/Services/PTY.ts";
import { resolveCommandPath } from "../utils/commandPath.ts";
import { LOCAL_TERMINAL_HOST_TARGET_ID } from "./localTerminalHost.paths.ts";

export function localTerminalHostShellHost(target: string): ShellHostScope {
  if (target !== LOCAL_TERMINAL_HOST_TARGET_ID)
    throw new Error("A local terminal host shell must name the local terminal host.");
  return { kind: "agent", hostId: LOCAL_TERMINAL_HOST_TARGET_ID };
}

/**
 * Server-resolved local candidate as immutable Rust launch intent. Like the remote-backend
 * supervisor this uses the POSIX (`linux`) launch shape with integration disabled; full local
 * launch parity (login environment, integration) is S6.
 */
export function localTerminalHostShellLaunch(input: PtySpawnInput) {
  const host = localTerminalHostShellHost(LOCAL_TERMINAL_HOST_TARGET_ID);
  const args = [...(input.args ?? [])];
  const executable = input.shell.startsWith("/")
    ? input.shell
    : resolveCommandPath(input.shell, { platform: "linux", env: input.env });
  if (!executable) throw new Error("The requested terminal shell is unavailable on this computer.");
  const profile = input.shellProfile;
  if (profile?.selection.kind === "profile") {
    if (
      profile.host.kind !== "local" ||
      profile.host.hostId !== LOCAL_SHELL_HOST.hostId ||
      profile.profileId !== shellProfileId(LOCAL_SHELL_HOST, executable, args, "linux") ||
      profile.kind !== shellKind(executable, "linux")
    )
      throw new Error("The selected local shell profile does not match its resolved candidate.");
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
