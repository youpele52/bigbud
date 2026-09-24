import { type ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import { Data, Effect } from "effect";

import { runProcess } from "../../utils/processRunner";

interface AgentProcess {
  pid: number;
  parentPid: number;
  groupId: number | null;
  foregroundGroupId: number | null;
  command: string;
}

const AGENT_EXECUTABLES: Readonly<Record<string, ProviderKind>> = {
  pi: "pi",
  opencode: "opencode",
  opencode2: "opencode",
  codex: "codex",
  claude: "claudeAgent",
  copilot: "copilot",
  "cursor-agent": "cursor",
  agent: "cursor",
  devin: "devin",
  "devin-cli": "devin",
  kilo: "kilocode",
  kilocode: "kilocode",
} as const;

function commandExecutable(command: string): string {
  const first = command
    .trimStart()
    .match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
    ?.slice(1)
    .find(Boolean);
  return (first ?? "")
    .split(/[/\\]/)
    .at(-1)!
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

export function agentFromProcessCommand(command: string): ProviderKind | null {
  const executable = commandExecutable(command);
  const direct = AGENT_EXECUTABLES[executable];
  if (direct) return direct;

  if (!/^(?:node|bun|deno|python\d*(?:\.\d+)?)$/.test(executable)) return null;
  const normalized = command.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/pi-coding-agent/")) return "pi";
  if (normalized.includes("/cursor-agent/")) return "cursor";
  if (normalized.includes("/@anthropic-ai/claude-code/")) return "claudeAgent";
  if (normalized.includes("/@opencode-ai/opencode/")) return "opencode";
  if (normalized.includes("/@openai/codex/")) return "codex";
  return null;
}

export function parsePosixAgentProcesses(output: string): ReadonlyArray<AgentProcess> {
  const processes: AgentProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+)$/);
    if (!match) continue;
    processes.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      groupId: Number(match[3]),
      foregroundGroupId: Number(match[4]),
      command: match[5] ?? "",
    });
  }
  return processes;
}

export function parseWindowsAgentProcesses(output: string): ReadonlyArray<AgentProcess> {
  const parsed: unknown = JSON.parse(output.trim().replace(/^\uFEFF/, ""));
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  return entries.flatMap((entry): AgentProcess[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    const parentPid = Number(value.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid)) return [];
    return [
      {
        pid,
        parentPid,
        groupId: null,
        foregroundGroupId: null,
        command:
          typeof value.CommandLine === "string"
            ? value.CommandLine
            : typeof value.Name === "string"
              ? value.Name
              : "",
      },
    ];
  });
}

function descendantChain(
  process: AgentProcess,
  rootPid: number,
  byPid: ReadonlyMap<number, AgentProcess>,
): ReadonlyArray<AgentProcess> | null {
  const chain: AgentProcess[] = [];
  const visited = new Set<number>();
  let current: AgentProcess | undefined = process;
  while (current && !visited.has(current.pid)) {
    if (current.pid === rootPid) return chain;
    visited.add(current.pid);
    chain.push(current);
    current = byPid.get(current.parentPid);
  }
  return null;
}

function uniqueAgent(candidates: Iterable<ProviderKind>): ProviderKind | null {
  const kinds = new Set(candidates);
  return kinds.size === 1 ? (kinds.values().next().value ?? null) : null;
}

export function detectAgentForShell(
  shellPid: number,
  processes: ReadonlyArray<AgentProcess>,
  platform: "windows" | "posix",
): ProviderKind | null {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const shell = byPid.get(shellPid);
  if (!shell) return null;
  const shellAgent = agentFromProcessCommand(shell.command);
  if (shellAgent) return shellAgent;

  if (platform === "posix") {
    const foregroundGroupId = shell.foregroundGroupId;
    if (!foregroundGroupId || foregroundGroupId <= 0 || foregroundGroupId === shell.groupId) {
      return null;
    }
    const agents: ProviderKind[] = [];
    for (const process of processes) {
      if (process.groupId !== foregroundGroupId) continue;
      const chain = descendantChain(process, shellPid, byPid);
      if (!chain) continue;
      const agent = chain.map((item) => agentFromProcessCommand(item.command)).find(Boolean);
      if (agent) agents.push(agent);
    }
    return uniqueAgent(agents);
  }

  // Windows exposes the ConPTY process tree but no portable foreground process group.
  // An ambiguous tree stays unlabeled rather than choosing an arbitrary agent.
  const agents: ProviderKind[] = [];
  for (const process of processes) {
    if (!descendantChain(process, shellPid, byPid)) continue;
    const agent = agentFromProcessCommand(process.command);
    if (agent) agents.push(agent);
  }
  return uniqueAgent(agents);
}

export type TerminalAgentDetector = (
  shellPids: ReadonlyArray<number>,
) => Effect.Effect<ReadonlyMap<number, ProviderKind | null>, TerminalAgentInspectionError>;

export class TerminalAgentInspectionError extends Data.TaggedError("TerminalAgentInspectionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const defaultTerminalAgentDetector: TerminalAgentDetector = (shellPids) =>
  Effect.tryPromise({
    try: async () => {
      if (shellPids.length === 0) return new Map<number, ProviderKind | null>();
      const windows = process.platform === "win32";
      const result = windows
        ? await runProcess(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 2",
            ],
            { timeoutMs: 3_000 },
          )
        : await runProcess("ps", ["-e", "-ww", "-o", "pid=,ppid=,pgid=,tpgid=,command="], {
            timeoutMs: 2_000,
          });
      const processes = windows
        ? parseWindowsAgentProcesses(result.stdout)
        : parsePosixAgentProcesses(result.stdout);
      const platform = windows ? "windows" : "posix";
      return new Map(shellPids.map((pid) => [pid, detectAgentForShell(pid, processes, platform)]));
    },
    catch: (cause) =>
      new TerminalAgentInspectionError({
        message: "Failed to inspect terminal agent processes",
        cause,
      }),
  });
