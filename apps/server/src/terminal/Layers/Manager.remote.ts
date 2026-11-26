import { remoteShellStartup } from "./Manager.remote-identity.ts";
import { type ShellCandidate } from "./Manager.shell";

/**
 * Describes the remote login shell for a direct SSH pane. It is never spawned
 * locally: the Rust owner's PTY adapter (`sshOwnerProductionTerminal`) serves
 * every direct SSH target, and the generic PTY refuses an SSH target before any
 * process exists (`PtyShellExecutable`). There is no TypeScript `ssh` argv.
 */
export function buildRemoteTerminalShellCandidate(input: {
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly runtimeEnv: Record<string, string> | null;
  readonly runtimeGeneration: string;
}): ShellCandidate {
  return {
    shell: "sh",
    args: ["-lc", remoteShellStartup(input.runtimeGeneration)],
    dropPathMode: "posix",
  };
}
