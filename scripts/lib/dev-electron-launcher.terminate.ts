/**
 * Tree termination for the dev Electron launcher: snapshots, the graceful wait and the forced kill.
 *
 * Provider processes (Cursor ACP agents, Kilo/OpenCode servers) are grandchildren of Electron and
 * some lead their own process group. When Electron exits first, the server is reparented to init,
 * outside the launcher's and dev-supervise's trees, and can die mid-teardown (a broken stderr pipe
 * to Electron, or a second SIGTERM: Effect's `runMain` handles only the first one). So the launcher
 * keeps a rolling snapshot of the app tree and, on every exit, requested or not, waits for that
 * tree to drain and then SIGKILLs what is left. A stop signals only Electron, which forwards exactly
 * one SIGTERM to its backend.
 */
import { childrenByParent, collectDescendants, type ProcessTable } from "./dev-process-tree.ts";
import {
  DEV_ELECTRON_APP_QUIT_GRACE_MS,
  DEV_ELECTRON_FORCE_SETTLE_MS,
  DEV_ELECTRON_GRACEFUL_STOP_MS,
  DEV_ELECTRON_STOP_POLL_MS,
  type DevElectronLauncherHost,
  type LauncherSignal,
  type RunningApp,
  type TerminateMode,
} from "./dev-electron-launcher.model.ts";

const formatPids = (pids: readonly number[]) => (pids.length > 0 ? pids.join(",") : "none");

export function quietly(action: () => void): void {
  try {
    action();
  } catch {
    /* Already gone. */
  }
}

export function signalQuietly(
  host: DevElectronLauncherHost,
  pid: number,
  signal: LauncherSignal,
): void {
  quietly(() => host.signal(pid, signal));
}

export async function waitFor(
  host: DevElectronLauncherHost,
  done: () => boolean,
  budgetMs: number,
): Promise<boolean> {
  const deadline = host.now() + budgetMs;
  while (!done()) {
    const remaining = deadline - host.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      host.setTimer(resolve, Math.min(DEV_ELECTRON_STOP_POLL_MS, remaining));
    });
  }
  return true;
}

export function captureSnapshot(entry: RunningApp, table: ProcessTable): void {
  const pid = entry.app.pid;
  if (pid === undefined || !table.has(pid)) return;
  const children = childrenByParent(table);
  entry.snapshot = new Map(
    collectDescendants(children, [pid]).map((member) => [member, table.get(member)!.started]),
  );
  entry.directChildren = children.get(pid) ?? [];
}

export async function terminateAppTree(
  host: DevElectronLauncherHost,
  entry: RunningApp,
  mode: TerminateMode,
): Promise<void> {
  const pid = entry.app.pid;
  if (pid === undefined) return;
  const startedAt = host.now();
  const elapsed = () => host.now() - startedAt;

  if (host.windows) {
    // Electron's own quit runs `taskkill /T /F` on its backend; only a launcher stop needs one.
    if (mode === "reap") return;
    quietly(() => host.killTree(pid));
    const exited = await waitFor(host, () => entry.exited, DEV_ELECTRON_GRACEFUL_STOP_MS);
    host.log(
      `[dev-electron] stop forced (taskkill /T /F) elapsed=${elapsed()}ms survivors=${exited ? "none" : String(pid)}`,
    );
    return;
  }

  const table = host.listProcesses();
  if (!entry.exited) captureSnapshot(entry, table);
  // Only PIDs that still name the snapshotted process (same start time) are ours.
  const tracked = new Map(
    [...entry.snapshot].filter(([member, started]) => table.get(member)?.started === started),
  );
  if (tracked.size === 0) return;
  /** Tracked members still running. A zombie has exited (Electron may not have reaped it yet). */
  const running = (current: ProcessTable) =>
    [...tracked].filter(([member, started]) => {
      if (member === pid && entry.exited) return false;
      const found = current.get(member);
      return found !== undefined && found.started === started && !found.zombie;
    });
  const backend = mode === "stop" ? host.findBackend(entry.directChildren) : undefined;
  const backendTree = new Set(
    backend === undefined ? [] : collectDescendants(childrenByParent(table), [backend]),
  );

  if (mode === "stop") {
    // Electron forwards one SIGTERM to its backend. Signalling the server too would be a second
    // SIGTERM, which kills it mid-teardown.
    signalQuietly(host, pid, "SIGTERM");
  } else if (entry.exitSignal !== null) {
    // Electron died without stopping its children.
    for (const child of entry.directChildren)
      if (tracked.has(child)) signalQuietly(host, child, "SIGTERM");
  }

  let backendDrainedAt: number | undefined;
  const settled = () => {
    const left = running(host.listProcesses());
    if (left.length === 0) return true;
    if (backendTree.size === 0 || left.some(([member]) => backendTree.has(member))) return false;
    backendDrainedAt ??= host.now();
    return host.now() - backendDrainedAt >= DEV_ELECTRON_APP_QUIT_GRACE_MS;
  };
  await waitFor(host, settled, DEV_ELECTRON_GRACEFUL_STOP_MS);

  // Survivors may have spawned since the snapshot; their children are still parented.
  const latest = host.listProcesses();
  const survivors = running(latest).map(([member]) => member);
  if (survivors.length === 0) {
    host.log(`[dev-electron] ${mode} graceful elapsed=${elapsed()}ms`);
    return;
  }
  const killed = collectDescendants(childrenByParent(latest), survivors).filter((member) => {
    const found = latest.get(member);
    const known = tracked.get(member);
    return found !== undefined && !found.zombie && (known === undefined || known === found.started);
  });
  for (const member of killed) signalQuietly(host, member, "SIGKILL");
  const remaining = () => {
    const current = host.listProcesses();
    return killed.filter((member) => {
      const found = current.get(member);
      return found !== undefined && !found.zombie && !(member === pid && entry.exited);
    });
  };
  await waitFor(host, () => remaining().length === 0, DEV_ELECTRON_FORCE_SETTLE_MS);
  const reason = backendDrainedAt === undefined ? "" : " after backend drained";
  host.log(
    `[dev-electron] ${mode} forced${reason} elapsed=${elapsed()}ms killed=${formatPids(killed)} survivors=${formatPids(remaining())}`,
  );
}
