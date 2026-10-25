import { type ProviderKind } from "@bigbud/contracts/orchestration/orchestration.provider";
import { Data, Effect } from "effect";

import { runProcess } from "../../utils/processRunner";
import {
  TERMINAL_AGENTS,
  terminalAgentForProvider,
  type TerminalAgentDescriptor,
} from "../terminalAgents.ts";
import type { TerminalAgentIdentity } from "@bigbud/contracts/workspace/terminal.agentIdentity.ts";

export interface AgentProcess {
  pid: number;
  parentPid: number;
  groupId: number | null;
  foregroundGroupId: number | null;
  command: string;
}

export interface TerminalAgentDetection {
  readonly agent: TerminalAgentIdentity;
  readonly provider: ProviderKind | null;
}

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

/** Compile reviewed executable/script metadata without requiring a native provider mapping. */
export function createTerminalAgentProcessMatcher(
  agents: ReadonlyArray<TerminalAgentDescriptor> = TERMINAL_AGENTS,
) {
  const executables = new Map<string, TerminalAgentDetection>();
  const scripts: Array<{ path: string; detection: TerminalAgentDetection }> = [];
  for (const descriptor of agents) {
    if (!descriptor.id.trim() || !descriptor.names.some((name) => name.trim())) continue;
    const detection = {
      agent: { id: descriptor.id, names: descriptor.names },
      provider: descriptor.provider ?? null,
    };
    for (const executable of descriptor.executables ?? []) {
      if (executable.trim()) executables.set(executable.toLowerCase(), detection);
    }
    for (const path of descriptor.scriptPaths ?? []) {
      if (path.trim()) scripts.push({ path: path.toLowerCase(), detection });
    }
  }
  return (command: string): TerminalAgentDetection | null => {
    const executable = commandExecutable(command);
    const direct = executables.get(executable);
    if (direct) return direct;
    if (!/^(?:node|bun|deno|python\d*(?:\.\d+)?)$/.test(executable)) return null;
    const normalized = command.replaceAll("\\", "/").toLowerCase();
    return scripts.find((script) => normalized.includes(script.path))?.detection ?? null;
  };
}

const matchDefaultAgent = createTerminalAgentProcessMatcher();

/** Compatibility projection for consumers that still need only native provider identity. */
export function agentFromProcessCommand(command: string): ProviderKind | null {
  return matchDefaultAgent(command)?.provider ?? null;
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

function uniqueAgent(candidates: Iterable<TerminalAgentDetection>): TerminalAgentDetection | null {
  const agents = new Map(Array.from(candidates, (candidate) => [candidate.agent.id, candidate]));
  return agents.size === 1 ? (agents.values().next().value ?? null) : null;
}

export function detectTerminalAgentForShell(
  shellPid: number,
  processes: ReadonlyArray<AgentProcess>,
  platform: "windows" | "posix",
  matchAgent = matchDefaultAgent,
): TerminalAgentDetection | null {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const shell = byPid.get(shellPid);
  if (!shell) return null;
  const shellAgent = matchAgent(shell.command);
  if (shellAgent) return shellAgent;

  if (platform === "posix") {
    const foregroundGroupId = shell.foregroundGroupId;
    if (!foregroundGroupId || foregroundGroupId <= 0 || foregroundGroupId === shell.groupId) {
      return null;
    }
    const agents: TerminalAgentDetection[] = [];
    for (const process of processes) {
      if (process.groupId !== foregroundGroupId) continue;
      const chain = descendantChain(process, shellPid, byPid);
      if (!chain) continue;
      const agent = chain.map((item) => matchAgent(item.command)).find(Boolean);
      if (agent) agents.push(agent);
    }
    return uniqueAgent(agents);
  }

  // Windows exposes the ConPTY process tree but no portable foreground process group.
  // An ambiguous tree stays unlabeled rather than choosing an arbitrary agent.
  const agents: TerminalAgentDetection[] = [];
  for (const process of processes) {
    if (!descendantChain(process, shellPid, byPid)) continue;
    const agent = matchAgent(process.command);
    if (agent) agents.push(agent);
  }
  return uniqueAgent(agents);
}

/** Keep native-provider consumers compatible while the scan itself uses generic identities. */
export function detectAgentForShell(
  shellPid: number,
  processes: ReadonlyArray<AgentProcess>,
  platform: "windows" | "posix",
): ProviderKind | null {
  return detectTerminalAgentForShell(shellPid, processes, platform)?.provider ?? null;
}

export type TerminalAgentDetector = (
  shellPids: ReadonlyArray<number>,
) => Effect.Effect<
  ReadonlyMap<number, TerminalAgentDetection | ProviderKind | null>,
  TerminalAgentInspectionError
>;

/** Compatibility for existing injected provider-only detectors; never inspect processes again. */
export function normalizeTerminalAgentDetection(
  value: TerminalAgentDetection | ProviderKind | null,
): TerminalAgentDetection | null {
  return typeof value === "string"
    ? { agent: terminalAgentForProvider(value), provider: value }
    : value;
}

export class TerminalAgentInspectionError extends Data.TaggedError("TerminalAgentInspectionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TerminalAgentProcessSnapshot {
  readonly processes: ReadonlyArray<AgentProcess>;
  readonly platform: "windows" | "posix";
}

const inspectTerminalAgentProcesses = (): Effect.Effect<
  TerminalAgentProcessSnapshot,
  TerminalAgentInspectionError
> =>
  Effect.tryPromise({
    try: async () => {
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
      return { processes, platform };
    },
    catch: (cause) =>
      new TerminalAgentInspectionError({
        message: "Failed to inspect terminal agent processes",
        cause,
      }),
  });

/** One shared process inspection per poll, regardless of pane count or output volume. */
export function createTerminalAgentDetector(
  options: {
    readonly agents?: ReadonlyArray<TerminalAgentDescriptor>;
    readonly inspect?: () => Effect.Effect<
      TerminalAgentProcessSnapshot,
      TerminalAgentInspectionError
    >;
  } = {},
) {
  const matchAgent = options.agents
    ? createTerminalAgentProcessMatcher(options.agents)
    : matchDefaultAgent;
  const inspect = options.inspect ?? inspectTerminalAgentProcesses;
  return (
    shellPids: ReadonlyArray<number>,
  ): Effect.Effect<
    ReadonlyMap<number, TerminalAgentDetection | null>,
    TerminalAgentInspectionError
  > =>
    Effect.gen(function* () {
      if (shellPids.length === 0) return new Map<number, TerminalAgentDetection | null>();
      const snapshot = yield* inspect();
      return new Map(
        shellPids.map((pid) => [
          pid,
          detectTerminalAgentForShell(pid, snapshot.processes, snapshot.platform, matchAgent),
        ]),
      );
    });
}

export const defaultTerminalAgentDetector: TerminalAgentDetector = createTerminalAgentDetector();
