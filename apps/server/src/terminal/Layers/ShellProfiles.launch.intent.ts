import type { ShellLaunchIntent } from "@bigbud/contracts/workspace/terminalShell.ts";
import { sameShellHost, type ResolvedShellProfileLaunch } from "./ShellProfiles.launch";
import { remoteShellHost, type RemoteShellDiscoveryInput } from "./ShellProfiles.remote.identity";

/** Configured target and freshly resolved selection must agree. This is intent, not exec proof. */
export function remoteShellLaunchIntent(
  input: RemoteShellDiscoveryInput & { readonly launch: ResolvedShellProfileLaunch },
): ShellLaunchIntent {
  const { launch } = input;
  const host = remoteShellHost(input);
  if (
    !sameShellHost(host, launch.identity.host) ||
    launch.identity.selection.kind !== "profile" ||
    launch.identity.selection.profileId !== launch.identity.profileId ||
    (launch.platform !== "linux" && launch.platform !== "darwin") ||
    (host.kind === "wsl" && launch.platform !== "linux")
  ) {
    throw new Error("Remote shell launch does not match the execution target and selection.");
  }
  return { host, profileId: launch.identity.selection.profileId, kind: launch.identity.kind };
}
