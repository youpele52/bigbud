import type { ResolvedShellProfileLaunch } from "../terminal/Layers/ShellProfiles.launch.ts";
import { remoteShellLaunchIntent } from "../terminal/Layers/ShellProfiles.launch.intent.ts";
import { parseRemoteAgentShellLaunch } from "./remoteAgentShellLaunch.ts";

/**
 * Capture a freshly resolved profile as durable intent before dispatch. This does
 * not authorize a target, revalidate its filesystem, or attest successful exec.
 */
export function remoteAgentShellLaunchFromProfile(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly launch: ResolvedShellProfileLaunch;
}) {
  const { launch } = input;
  const requestedProfile = remoteShellLaunchIntent(input);
  return parseRemoteAgentShellLaunch({
    version: 1,
    cwd: input.cwd,
    requestedProfile,
    executable: launch.shell,
    args: [...launch.args],
    platform: launch.platform,
    integration: "disabled",
  });
}
