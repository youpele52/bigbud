import { buildSshCommandInvocation } from "../../ssh/sshCommand";
import { parseSshExecutionTarget } from "../../ssh/sshExecutionTarget";
import { wslProbeArgs } from "./Manager.wsl.invocation";
import { wslExecutable } from "./Manager.wsl.process";
import { remoteShellPidPrefix } from "./Manager.remote-identity";
import type { ResolvedShellProfileLaunch } from "./ShellProfiles.launch";
import { remoteShellLaunchIntent } from "./ShellProfiles.launch.intent";
import { parseExecutionHostShellLaunch } from "./ShellProfiles.launch.metadata";
import { executionHostTerminalEnvironment } from "./ShellProfiles.remote.environment";
import { sshShellTarget, type RemoteShellDiscoveryInput } from "./ShellProfiles.remote.identity";

const SSH_EXEC = [
  'test "$(/usr/bin/id -un)" = "$1" || exit 79',
  'shift; cd "$1" 2>/dev/null || exit 77',
]; // The generation-scoped PID marker is process-inspection evidence, never exec identity.
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
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target || target.transport === "agent")
    throw new Error("An agent execution target cannot use a direct SSH profile launch.");
  const username = sshShellTarget(input).user;
  const generation = input.runtimeGeneration;
  if (generation !== undefined && !/^[a-f0-9-]{36}$/.test(generation))
    throw new Error("Invalid direct shell runtime generation.");
  const script = [
    ...SSH_EXEC,
    "shift",
    ...(generation ? ['printf \'%s%s\\007\' "$1" "$$"', "shift"] : []),
    'exec "$@"',
  ].join("; ");
  return {
    transport: "ssh" as const,
    launch,
    invocation: buildSshCommandInvocation({
      executionTargetId: input.executionTargetId,
      command: "/bin/sh",
      args: [
        "-c",
        script,
        "sh",
        username,
        launch.cwd,
        ...(generation ? [remoteShellPidPrefix(generation)] : []),
        launch.executable,
        ...launch.args,
      ],
      env,
      allocateTty: true,
      shellMode: "non-login-posix",
    }),
  };
}
