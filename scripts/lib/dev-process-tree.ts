/**
 * Process-table helpers shared by the dev supervisors (`scripts/dev-supervise.ts` and the Electron
 * launcher in `apps/desktop/scripts/dev-electron.mjs`). Node runs these files with strip-only type
 * removal, so keep to erasable TypeScript syntax.
 *
 * A PID can be reused after its process exits. The listing carries each process's start time so
 * callers that hold a snapshot for a while can check a PID still names the same process.
 */
import { spawnSync } from "node:child_process";

export interface ProcessEntry {
  readonly ppid: number;
  /** `ps` `lstart`: the process start time, used as its identity together with the PID. */
  readonly started: string;
  /** Exited but not yet reaped by its parent (`stat` Z). It holds no resources but its PID. */
  readonly zombie: boolean;
}

/** PID to parent and start time. Empty where unavailable (Windows) or when `ps` fails. */
export type ProcessTable = ReadonlyMap<number, ProcessEntry>;

/** Parse `ps -A -o pid=,ppid=,stat=,lstart=` output. */
export function parseProcessListing(listing: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid <= 0) continue;
    table.set(pid, {
      ppid: Number(match[2]),
      started: match[4]!.trim(),
      zombie: match[3]!.startsWith("Z"),
    });
  }
  return table;
}

/** Parent PID to child PIDs. */
export function childrenByParent(table: ProcessTable): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  return children;
}

/** Every root plus all of its descendants in `children`, each PID once, roots first. */
export function collectDescendants(
  children: ReadonlyMap<number, readonly number[]>,
  roots: readonly number[],
): number[] {
  const tree: number[] = [];
  const seen = new Set<number>();
  const pending = [...roots].toReversed();
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/** The whole process table. Windows has no cheap parent listing; callers use `taskkill /T`. */
export function listProcesses(platform: NodeJS.Platform = process.platform): ProcessTable {
  if (platform === "win32") return new Map();
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,lstart="], {
    encoding: "utf8",
  });
  if (listing.status !== 0 || typeof listing.stdout !== "string") return new Map();
  return parseProcessListing(listing.stdout);
}

/** Parent PID to child PIDs for the whole machine; empty on Windows. */
export function listProcessChildren(
  platform: NodeJS.Platform = process.platform,
): Map<number, number[]> {
  return childrenByParent(listProcesses(platform));
}

/** The roots and all their current descendants; only the roots on Windows. */
export function processForest(
  roots: readonly number[],
  platform: NodeJS.Platform = process.platform,
): number[] {
  if (platform === "win32" || roots.length === 0) return [...roots];
  return collectDescendants(listProcessChildren(platform), roots);
}

/** `root` and all its current descendants. */
export function processTree(root: number, platform: NodeJS.Platform = process.platform): number[] {
  return processForest([root], platform);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: the PID was reused by another user's process; not ours to wait on.
    return false;
  }
}

/** Windows has no POSIX signals or process groups: end the whole tree. */
export function killTreeWindows(pid: number): void {
  spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
