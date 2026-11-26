import { SshOwnerRequiredError } from "../../ssh/sshOwnerRequired";
import { wslProbeArgs } from "./Manager.wsl.invocation";
import { wslExecutable } from "./Manager.wsl.process";
import type { ResolvedShellProfileLaunch } from "./ShellProfiles.launch";
import { remoteShellLaunchIntent } from "./ShellProfiles.launch.intent";
import { parseExecutionHostShellLaunch } from "./ShellProfiles.launch.metadata";
import { executionHostTerminalEnvironment } from "./ShellProfiles.remote.environment";
import type { RemoteShellDiscoveryInput } from "./ShellProfiles.remote.identity";

const WSL_EXEC = [
  'test "$(/usr/bin/id -un)" = "$1" && test "$(/usr/bin/id -u)" = "$2" || exit 79',
  'shift 2; cd "$1" 2>/dev/null || exit 77',
  'shift; exec "$@"',
].join("; ");

/**
 * Invocation planning only. Callers MUST reserve immutable durable ownership before
 * dispatch, retain it after uncertainty, and never turn transport spawn into actual
 * shell identity. Manager dispatches this plan only through its durable owner gate.
 */
export function directShellProfileInvocation(
  input: RemoteShellDiscoveryInput & {
    readonly cwd: string;
    readonly launch: ResolvedShellProfileLaunch;
    readonly runtimeEnv?: NodeJS.ProcessEnv;
    readonly runtimeGeneration?: string;
  },
) {
  const requestedProfile = remoteShellLaunchIntent(input);
  const launch = parseExecutionHostShellLaunch({
    version: 1,
    cwd: input.cwd,
    requestedProfile,
    executable: input.launch.shell,
    args: [...input.launch.args],
    platform: input.launch.platform,
    integration: "disabled",
  });
  const env = Object.fromEntries(
    executionHostTerminalEnvironment(input.runtimeEnv ?? {}).map(({ name, value }) => [
      name,
      value,
    ]),
  );
  if (requestedProfile.host.kind === "wsl") {
    const identity = input.wslIdentity!; // remoteShellLaunchIntent validated the pinned account.
    return {
      transport: "wsl" as const,
      launch,
      wslIdentity: { ...identity },
      invocation: {
        command: wslExecutable(),
        args: wslProbeArgs({
          distribution: identity.distribution,
          identity,
          env,
          script: WSL_EXEC,
          args: [
            identity.username,
            String(identity.uid),
            launch.cwd,
            launch.executable,
            ...launch.args,
          ],
        }),
      },
    };
  }
  // A direct SSH profile launch runs only through the Rust owner's PTY
  // (`ShellProfiles.sshOwner.ts`); there is no TypeScript `ssh` argv.
  throw new SshOwnerRequiredError();
}
