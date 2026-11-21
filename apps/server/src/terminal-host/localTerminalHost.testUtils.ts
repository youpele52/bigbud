import { mkdtemp, rm } from "node:fs/promises";

import { findWorkspaceAgentTarget } from "../../../../scripts/lib/workspace-agent-target.ts";
import type { RemoteAgentOwner, RemoteAgentOwnerStore } from "../remote-agent/remoteAgentOwners.ts";
import type { LocalTerminalHostAdoptionDeps } from "./localTerminalHost.adopt.ts";
import { localTerminalHostPaths, type LocalTerminalHostPaths } from "./localTerminalHost.paths.ts";
import type { LocalTerminalHostProbe } from "./localTerminalHost.probe.ts";
import type {
  LocalTerminalHostPidStatus,
  LocalTerminalHostProcesses,
} from "./localTerminalHost.process.ts";
import { makeLocalTerminalHostRegistry } from "./localTerminalHost.registry.ts";
import type { LocalTerminalHostHello } from "./localTerminalHost.transport.ts";

/** Short `/tmp` roots keep socket paths far below the 100-byte limit (plan §7.3 item 2). */
export async function makeShortTerminalHostRoot(): Promise<{
  readonly stateDir: string;
  readonly paths: LocalTerminalHostPaths;
  readonly cleanup: () => Promise<void>;
}> {
  const stateDir = await mkdtemp("/tmp/bbth-");
  return {
    stateDir,
    paths: localTerminalHostPaths(stateDir),
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

const platformTarget = findWorkspaceAgentTarget(process.platform, process.arch);

export function fakeHostHello(
  overrides: Partial<LocalTerminalHostHello> & {
    readonly capabilityNames?: ReadonlyArray<string>;
  } = {},
): LocalTerminalHostHello {
  const { capabilityNames, ...rest } = overrides;
  return {
    protocolMajor: 1,
    protocolMinor: 8,
    agentVersion: "0.4.0",
    buildDigest: "digest-a",
    os: platformTarget?.rustOs ?? "linux",
    architecture: platformTarget?.rustArch ?? "x86_64",
    agentInstanceId: "instance-1",
    agentEpoch: "epoch-1",
    capabilities: (
      capabilityNames ?? ["terminal.pty", "terminal.pty-inventory", "workspace.files"]
    ).map((name) => ({ name, major: 1, minor: 0 })),
    maxFrameBytes: 1024 * 1024,
    maxOperationOutputBytes: 1024 * 1024,
    maxJournalBytes: 1024 * 1024,
    ...rest,
  };
}

export interface FakeProcesses extends LocalTerminalHostProcesses {
  readonly signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals }>;
}

/** `pids` maps a PID to its verification status and whether it has children. */
export function fakeProcesses(
  pids: Record<
    number,
    { status: LocalTerminalHostPidStatus; children?: boolean; start?: number }
  > = {},
): FakeProcesses {
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const alive = new Set(Object.keys(pids).map(Number));
  return {
    signals,
    startTime: async (pid) => pids[pid]?.start ?? (alive.has(pid) ? 1_000 : "not-running"),
    verify: async (pid) => (pid === undefined ? "unknown" : (pids[pid]?.status ?? "not-running")),
    hasChildren: async (pid) => pids[pid]?.children,
    isAlive: (pid) => alive.has(pid),
    signal: (pid, signal) => {
      signals.push({ pid, signal });
      alive.delete(pid);
      return true;
    },
    waitForExit: async (pid) => !alive.has(pid),
  };
}

/** In-memory owner rows for `listTerminalOwners` scans. */
export function fakeOwnerRows(
  rows: ReadonlyArray<Pick<RemoteAgentOwner, "connectionId" | "epoch" | "state">>,
): Pick<RemoteAgentOwnerStore, "listTerminalOwners"> {
  return {
    listTerminalOwners: async () => ({
      owners: rows.map(
        (row, index) => ({ ...row, ownerKey: `terminal:${index}` }) as RemoteAgentOwner,
      ),
      nextCursor: "",
    }),
  };
}

export function adoptionDeps(
  paths: LocalTerminalHostPaths,
  input: {
    readonly probes: Record<number, LocalTerminalHostProbe>;
    readonly processes?: FakeProcesses;
    readonly owners?: Record<string, boolean | undefined>;
    readonly requiredCapabilities?: ReadonlyArray<string>;
  },
): LocalTerminalHostAdoptionDeps & {
  readonly logs: Array<string>;
  readonly processes: FakeProcesses;
} {
  const logs: Array<string> = [];
  return {
    paths,
    registry: makeLocalTerminalHostRegistry(paths),
    probe: async (generation) => input.probes[generation.generation] ?? { kind: "gone" },
    generationHasOwners: async (connectionId) =>
      input.owners && connectionId in input.owners ? input.owners[connectionId] : false,
    processes: input.processes ?? fakeProcesses(),
    requiredCapabilities: input.requiredCapabilities ?? [
      "terminal.pty",
      "terminal.pty-inventory",
      "workspace.files",
    ],
    binaryPathFor: (digest) => `${paths.runtimesDir}/${digest}/bigbud-remote-agent`,
    log: (message) => logs.push(message),
    logs,
  };
}
