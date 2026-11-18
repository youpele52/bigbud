import type { RemoteAgentShellLaunch } from "./remoteAgentShellLaunch.ts";
import { executionHostTerminalEnvironment } from "../terminal/Layers/ShellProfiles.remote.environment.ts";

/** Host-owned account variables must never be overwritten by desktop/server environment. */
export function remoteAgentTerminalEnvironment(
  environment: NodeJS.ProcessEnv,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  return executionHostTerminalEnvironment(environment);
}

/** Shared compatibility launch for both terminal paths; not profile or identity evidence. */
export function remoteAgentLegacyTerminalLaunch(environment: NodeJS.ProcessEnv) {
  return {
    shell: "/bin/sh",
    args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
    environment: remoteAgentTerminalEnvironment(environment),
  };
}

/** Native profile preflight is required for this exact executable/argv, with suggestions off. */
export function remoteAgentTerminalLaunch(
  environment: NodeJS.ProcessEnv,
  launch?: RemoteAgentShellLaunch,
) {
  if (!launch) return remoteAgentLegacyTerminalLaunch(environment);
  return {
    shell: launch.executable,
    args: [...launch.args],
    profileLaunch: true,
    environment: remoteAgentTerminalEnvironment(environment),
  };
}
