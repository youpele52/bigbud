import { buildSshCommandInvocation } from "../../ssh/sshCommand.ts";
import { remoteShellStartup } from "./Manager.remote-identity.ts";
import { type ShellCandidate } from "./Manager.shell";

export function buildRemoteTerminalShellCandidate(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly runtimeEnv: Record<string, string> | null;
  readonly runtimeGeneration: string;
}): ShellCandidate {
  const invocation = buildSshCommandInvocation({
    executionTargetId: input.executionTargetId,
    cwd: input.cwd,
    command: "sh",
    args: ["-lc", remoteShellStartup(input.runtimeGeneration)],
    allocateTty: true,
    ...(input.runtimeEnv ? { env: input.runtimeEnv } : {}),
  });

  return {
    shell: invocation.command,
    args: [...invocation.args],
    dropPathMode: "posix",
  };
}
