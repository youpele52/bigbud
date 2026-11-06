import { Effect } from "effect";

import { runProcess } from "../../utils/processRunner.ts";
import { buildSshTransportArgs } from "../../ssh/sshCommand.ts";
import { buildPasswordSessionControlPath } from "../../ssh/sshSession.ts";
import { formatSshDestination, parseSshExecutionTarget } from "../../ssh/sshExecutionTarget.ts";
import { validSshMonitorTarget } from "../../ssh/sshMonitor.target.ts";
import { assertSshTargetConnected } from "../../ssh/sshTargetDisconnects.ts";
import {
  parsePosixAgentProcesses,
  TerminalAgentInspectionError,
  type AgentProcess,
} from "./Manager.agentDetection.ts";

const START = "bigbud-process-snapshot-start";
const END = "bigbud-process-snapshot-end";

export type RemoteTerminalProcessInspector = (
  executionTargetId: string,
) => Effect.Effect<ReadonlyArray<AgentProcess>, TerminalAgentInspectionError>;

/** No readiness, unlock, agent admission or reconnect: inspection must never start a service. */
export function remoteInspectionInvocation(executionTargetId: string) {
  return remoteReadOnlyInvocation(
    executionTargetId,
    `sh -c 'printf "${START}\\n"; LC_ALL=C ps -e -ww -o pid=,ppid=,pgid=,tpgid=,command= && printf "${END}\\n"'`,
  );
}

/** Noninteractive SSH transport shared by read-only inspections; never triggers agent admission. */
export function remoteReadOnlyInvocation(executionTargetId: string, command: string) {
  // The password branch bypasses `buildSshTransportArgs`, so it needs its own guard.
  assertSshTargetConnected(executionTargetId);
  if (!validSshMonitorTarget(executionTargetId)) throw new Error("Invalid SSH inspection target.");
  const target = parseSshExecutionTarget(executionTargetId);
  if (!target) throw new Error("Remote process inspection requires an SSH target.");
  const transport =
    target.authMode === "password"
      ? [
          "-T",
          "-o",
          "BatchMode=yes",
          "-o",
          "ControlMaster=no",
          "-o",
          `ControlPath=${buildPasswordSessionControlPath(target.executionTargetId)}`,
          ...(target.port ? ["-p", target.port] : []),
        ]
      : buildSshTransportArgs({ executionTargetId });
  return {
    command: "ssh",
    args: [
      ...transport,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=2",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=2",
      "-o",
      "ServerAliveCountMax=1",
      formatSshDestination(target),
      command,
    ],
  };
}

export function parseRemoteTerminalProcesses(output: string): ReadonlyArray<AgentProcess> {
  const start = output.indexOf(`${START}\n`);
  const end = output.lastIndexOf(`${END}\n`);
  if (start < 0 || end <= start) throw new Error("Incomplete remote process snapshot.");
  const processes = parsePosixAgentProcesses(output.slice(start + START.length + 1, end));
  if (processes.length === 0) throw new Error("Remote process snapshot is empty or unsupported.");
  return processes;
}

/** One bounded SSH command per target, not per pane. Windows remote ps is unsupported. */
export const inspectRemoteTerminalProcesses: RemoteTerminalProcessInspector = (executionTargetId) =>
  Effect.tryPromise({
    try: async (signal) => {
      const invocation = remoteInspectionInvocation(executionTargetId);
      const result = await runProcess(invocation.command, invocation.args, {
        signal,
        shell: false,
        timeoutMs: 3_000,
        settleOnTimeout: true,
        maxBufferBytes: 2 * 1024 * 1024,
        outputMode: "error",
      });
      return parseRemoteTerminalProcesses(result.stdout);
    },
    catch: (cause) =>
      new TerminalAgentInspectionError({
        message: "Failed to inspect remote terminal processes",
        cause,
      }),
  });
