import type { SshExecutionTarget } from "./sshExecutionTarget.ts";

export interface SshPasswordSessionRecord {
  readonly controlPath: string;
  readonly destination: string;
}

/** Arguments for an OpenSSH control command (`ssh -O <operation>`) on a password session socket. */
export function buildSshControlArgs(
  operation: "check" | "exit",
  target: Pick<SshExecutionTarget, "port">,
  session: SshPasswordSessionRecord,
): string[] {
  return [
    "-O",
    operation,
    "-o",
    `ControlPath=${session.controlPath}`,
    ...(target.port ? ["-p", target.port] : []),
    session.destination,
  ];
}
