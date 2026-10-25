import { DevElectronLauncher } from "./dev-electron-launcher.ts";
import type { DevElectronLauncherHost, LauncherSignal } from "./dev-electron-launcher.model.ts";
import type { ProcessEntry } from "./dev-process-tree.ts";

export const RUNNER_PID = 50;
export const LAUNCHER_PID = 100;

interface FakeApp {
  readonly pid: number;
  exit: (code: number | null, signal: string | null) => void;
}

const noExitListener: FakeApp["exit"] = () => undefined;

const flush = async () => {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * Deterministic launcher host: a fake process table with parent links and start times, a manual
 * clock and recorded signals. `setOnSignal` decides how each process reacts; by default only
 * SIGKILL ends a process.
 */
export function fakeLauncherHost(
  options: { windows?: boolean; devRunnerPid?: number | undefined } = {},
) {
  let now = 0;
  let nextPid = 500;
  let nextTimer = 1;
  // dev-runner -> turbo -> dev-supervise -> launcher
  const parents = new Map<number, number>([
    [RUNNER_PID, 1],
    [70, RUNNER_PID],
    [80, 70],
    [LAUNCHER_PID, 80],
  ]);
  const started = new Map<number, string>([...parents.keys()].map((pid) => [pid, `t0-${pid}`]));
  const zombies = new Set<number>();
  const backends = new Set<number>();
  const timers = new Map<number, { at: number; run: () => void }>();
  const apps = new Map<number, FakeApp>();
  const signals: Array<[number, LauncherSignal]> = [];
  const killedTrees: number[] = [];
  const logs: string[] = [];
  const state = { exitCode: null as number | null, watchersClosed: false };

  const kill = (pid: number, code: number | null = null, signal: string | null = "SIGKILL") => {
    if (!started.delete(pid)) return;
    for (const [child, parent] of parents) if (parent === pid) parents.set(child, 1);
    apps.get(pid)?.exit(code, signal);
  };
  const spawnChild = (parent: number): number => {
    const pid = nextPid++;
    parents.set(pid, parent);
    started.set(pid, `t${now}-${pid}`);
    return pid;
  };
  let onSignal = (pid: number, signal: LauncherSignal) => {
    if (signal === "SIGKILL") kill(pid);
  };

  const host: DevElectronLauncherHost = {
    windows: options.windows ?? false,
    launcherPid: LAUNCHER_PID,
    devRunnerPid: "devRunnerPid" in options ? options.devRunnerPid : RUNNER_PID,
    spawnApp() {
      const pid = spawnChild(LAUNCHER_PID);
      let exitListener = noExitListener;
      apps.set(pid, { pid, exit: (code, signal) => exitListener(code, signal) });
      return {
        pid,
        onExit: (listener) => {
          exitListener = listener;
        },
        onError: () => undefined,
      };
    },
    listProcesses() {
      const table = new Map<number, ProcessEntry>();
      if (options.windows) return table;
      for (const [pid, start] of started)
        table.set(pid, { ppid: parents.get(pid)!, started: start, zombie: zombies.has(pid) });
      return table;
    },
    findBackend: (candidates) => candidates.find((pid) => backends.has(pid)),
    signal(pid, signal) {
      signals.push([pid, signal]);
      onSignal(pid, signal);
    },
    killTree(pid) {
      killedTrees.push(pid);
      const tree = [pid];
      for (let index = 0; index < tree.length; index += 1)
        for (const [child, parent] of parents)
          if (parent === tree[index] && started.has(child)) tree.push(child);
      for (const member of tree.toReversed()) kill(member, 1, null);
    },
    alive: (pid) => started.has(pid),
    now: () => now,
    setTimer(run, ms) {
      timers.set(nextTimer, { at: now + ms, run });
      return nextTimer++;
    },
    clearTimer: (id) => timers.delete(id as number),
    log: (message) => logs.push(message),
    closeWatchers: () => {
      state.watchersClosed = true;
    },
    exit: (code) => {
      state.exitCode = code;
    },
  };

  /** Run every timer due within `ms`, letting promise chains settle between them. */
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .toSorted((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = end;
    await flush();
  };

  return {
    host,
    signals,
    killedTrees,
    logs,
    state,
    advance,
    kill,
    spawnChild,
    appPids: () => [...apps.keys()],
    isAlive: (pid: number) => started.has(pid),
    /** The PID now names a different process (same PID, new start time). */
    reusePid: (pid: number) => {
      started.set(pid, `reused-${pid}`);
    },
    /** The process is the bigbud server (`server/dist/bin.mjs`). */
    markBackend: (pid: number) => {
      backends.add(pid);
    },
    /** The process exited but its parent has not reaped it (a blocked Electron). */
    zombify: (pid: number) => {
      zombies.add(pid);
    },
    /** The process double-forks away from its parent, as `tmux` or `nohup … &` do. */
    reparent: (pid: number) => {
      parents.set(pid, 1);
    },
    /** Schedule a process-side action on the fake clock (a server finishing its teardown). */
    later(ms: number, run: () => void) {
      host.setTimer(run, ms);
    },
    setOnSignal(handler: (pid: number, signal: LauncherSignal) => void) {
      const fallback = onSignal;
      onSignal = (pid, signal) => {
        handler(pid, signal);
        if (started.has(pid)) fallback(pid, signal);
      };
    },
  };
}

export type FakeLauncherHost = ReturnType<typeof fakeLauncherHost>;

/** Electron with a server child, which has a provider child (Cursor ACP agent or Kilo server). */
export function startWithTree(fake: FakeLauncherHost) {
  const launcher = new DevElectronLauncher(fake.host);
  launcher.start();
  const [app] = fake.appPids();
  const server = fake.spawnChild(app!);
  fake.markBackend(server);
  const provider = fake.spawnChild(server);
  return { launcher, app: app!, server, provider };
}

export const sent = (fake: FakeLauncherHost, signal: string) =>
  fake.signals.filter(([, current]) => current === signal).map(([pid]) => pid);
