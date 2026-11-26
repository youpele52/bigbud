import { Effect } from "effect";

import { SshOwnerRequiredError } from "../../ssh/sshOwnerRequired.ts";

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

export function parseRemoteTerminalProcesses(output: string): ReadonlyArray<AgentProcess> {
  const start = output.indexOf(`${START}\n`);
  const end = output.lastIndexOf(`${END}\n`);
  if (start < 0 || end <= start) throw new Error("Incomplete remote process snapshot.");
  const processes = parsePosixAgentProcesses(output.slice(start + START.length + 1, end));
  if (processes.length === 0) throw new Error("Remote process snapshot is empty or unsupported.");
  return processes;
}

/**
 * Remote process snapshots need the owner's `terminal_inspect` verb on a native
 * lease (`Manager.process-drain.remote.ts`). This generic inspector has no
 * owner lease, so it reports a typed inspection failure and launches nothing.
 */
export const inspectRemoteTerminalProcesses: RemoteTerminalProcessInspector = () =>
  Effect.fail(
    new TerminalAgentInspectionError({
      message: "Remote terminal process inspection runs only through the SSH owner.",
      cause: new SshOwnerRequiredError(),
    }),
  );

/** Plan §8.5 shell set: a foreground leader with one of these names is a prompt, not a program. */
const OWNER_HINT_SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
  "pwsh",
  "xonsh",
]);

function commandName(command: string): string {
  const first = command.trim().split(/\s+/, 1)[0] ?? "";
  // A login shell shows as `-zsh`.
  return (first.split("/").pop() ?? "").replace(/^-/, "");
}

/**
 * The Direct SSH owner hint (plan §8.5, M7) for one remote shell: `busy` while a program owns
 * its terminal's foreground group, `idle` at a prompt (including a nested shell's prompt), and
 * `unknown` when the snapshot cannot tell (no shell, no terminal facts, an unreadable leader).
 * Background jobs never count. The host treats `unknown` as busy.
 */
export function remoteOwnerBusyHint(
  shellPid: number,
  processes: ReadonlyArray<AgentProcess>,
): "busy" | "idle" | "unknown" {
  const shell = processes.find((process) => process.pid === shellPid);
  const foreground = shell?.foregroundGroupId;
  if (!shell || shell.groupId === null || foreground === null || foreground === undefined)
    return "unknown";
  if (foreground <= 0) return "unknown";
  if (foreground === shell.groupId) return "idle";
  const leader = processes.find((process) => process.pid === foreground);
  if (!leader) return "busy";
  return OWNER_HINT_SHELLS.has(commandName(leader.command)) ? "idle" : "busy";
}
