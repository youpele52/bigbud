import {
  expandSshKeyPath,
  formatSshDestination,
  parseSshExecutionTarget,
} from "./sshExecutionTarget.ts";

export interface SshCommandInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface BuildSshCommandInput {
  readonly executionTargetId: string | null | undefined;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly allocateTty?: boolean;
  readonly transportArgs?: ReadonlyArray<string>;
}

const SSH_COMMAND = "ssh";
const REMOTE_EXEC_SCRIPT =
  'if [ -n "$1" ]; then cd "$1" || exit 1; fi; shift; while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do export "$1"; shift; done; shift; exec "$@"';

function shellEscapePosix(argument: string): string {
  return `'${argument.replaceAll("'", `'\\''`)}'`;
}

export function buildSshTransportArgs(input: {
  readonly executionTargetId: string | null | undefined;
  readonly allocateTty?: boolean;
}): ReadonlyArray<string> {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId ?? "local"}'.`);
  }
  if (target.authMode === "password") {
    throw new Error("Password SSH authentication is not supported for remote execution yet.");
  }

  return [
    ...(input.allocateTty ? ["-tt"] : ["-T"]),
    "-o",
    "BatchMode=yes",
    ...(target.keyPath ? ["-o", "IdentitiesOnly=yes"] : []),
    ...(target.port ? ["-p", target.port] : []),
    ...(target.keyPath ? ["-i", expandSshKeyPath(target.keyPath)] : []),
  ];
}

export function buildSshCommandInvocation(input: BuildSshCommandInput): SshCommandInvocation {
  const target = parseSshExecutionTarget(input.executionTargetId);
  if (!target) {
    throw new Error(`Invalid SSH execution target '${input.executionTargetId ?? "local"}'.`);
  }
  if (target.authMode === "password") {
    throw new Error("Password SSH authentication is not supported for remote execution yet.");
  }

  const envAssignments = Object.entries(input.env ?? {})
    .filter(([key]) => key.trim().length > 0)
    .map(([key, value]) => `${key}=${value}`);
  const remoteCommand = [
    "sh",
    "-lc",
    REMOTE_EXEC_SCRIPT,
    "sh",
    input.cwd ?? "",
    ...envAssignments,
    "--",
    input.command,
    ...(input.args ?? []),
  ]
    .map(shellEscapePosix)
    .join(" ");

  return {
    command: SSH_COMMAND,
    args: [
      ...buildSshTransportArgs({
        executionTargetId: input.executionTargetId,
        ...(input.allocateTty !== undefined ? { allocateTty: input.allocateTty } : {}),
      }),
      ...(input.transportArgs ?? []),
      formatSshDestination(target),
      remoteCommand,
    ],
  };
}
