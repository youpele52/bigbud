import { buildSshCommandInvocation } from "../../ssh/sshCommand.ts";

export function buildRemoteTerminalShellCandidate(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly runtimeEnv: Record<string, string> | null;
}): { shell: string; args: string[] } {
  const invocation = buildSshCommandInvocation({
    executionTargetId: input.executionTargetId,
    cwd: input.cwd,
    command: "sh",
    args: ["-lc", 'exec "${SHELL:-/bin/sh}" -l'],
    allocateTty: true,
    ...(input.runtimeEnv ? { env: input.runtimeEnv } : {}),
  });

  return {
    shell: invocation.command,
    args: [...invocation.args],
  };
}
