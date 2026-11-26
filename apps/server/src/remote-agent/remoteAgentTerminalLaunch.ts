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

/** A server-built, non-shell command (Direct SSH's local `ssh` client, plan M7). */
export interface RemoteAgentCommandLaunch {
  readonly shell: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Native profile preflight is required for this exact executable/argv, with suggestions off.
 * `localEnvironment` (a `local_launch` create on a local terminal host) replaces the remote
 * presentation-only environment with the server's full spawn environment. A `command` without a
 * profile runs only as a `local_launch` create: a remote agent never receives one.
 */
export function remoteAgentTerminalLaunch(
  environment: NodeJS.ProcessEnv,
  launch?: RemoteAgentShellLaunch,
  localEnvironment?: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  command?: RemoteAgentCommandLaunch,
) {
  if (!launch && command && localEnvironment)
    return { shell: command.shell, args: [...command.args], environment: localEnvironment };
  if (!launch) return remoteAgentLegacyTerminalLaunch(environment);
  return {
    shell: launch.executable,
    args: [...launch.args],
    profileLaunch: true,
    environment: localEnvironment ?? remoteAgentTerminalEnvironment(environment),
  };
}
