/**
 * Stop/restart state machine for the dev Electron launcher (`apps/desktop/scripts/dev-electron.mjs`).
 * The script only wires a real host; everything here is testable with a fake one, mirroring
 * `DevSupervisor` in `scripts/dev-supervise.lib.ts`. Budgets and the host contract live in
 * `dev-electron-launcher.model.ts`; tree termination in `dev-electron-launcher.terminate.ts`.
 */
import {
  DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE,
  DEV_APP_FATAL_EXIT_CODE,
  DEV_APP_RESTART_EXIT_CODE,
} from "@bigbud/shared/DevLauncher";

import { childrenByParent, collectDescendants } from "./dev-process-tree.ts";
import {
  DEV_ELECTRON_CHILD_GRACE_MS,
  DEV_ELECTRON_RESTART_DEBOUNCE_MS,
  DEV_ELECTRON_SNAPSHOT_INTERVAL_MS,
  type DevElectronLauncherHost,
  type RunningApp,
} from "./dev-electron-launcher.model.ts";
import {
  captureSnapshot,
  quietly,
  signalQuietly,
  terminateAppTree,
  waitFor,
} from "./dev-electron-launcher.terminate.ts";

export class DevElectronLauncher {
  private readonly host: DevElectronLauncherHost;
  private current: RunningApp | null = null;
  private restartTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor(host: DevElectronLauncherHost) {
    this.host = host;
  }

  start(): void {
    this.startApp();
  }

  /** A watched build output changed. Also relaunches an app that is idle after a fatal exit. */
  onBuildOutputChanged(): void {
    if (this.shuttingDown) return;
    if (this.restartTimer !== null) this.host.clearTimer(this.restartTimer);
    this.restartTimer = this.host.setTimer(() => {
      this.restartTimer = null;
      this.enqueue(async () => {
        await this.stopApp();
        this.startApp();
      });
    }, DEV_ELECTRON_RESTART_DEBOUNCE_MS);
  }

  /** Idempotent: stop or reap the app tree, then the launcher's own leftovers, then exit. */
  async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.restartTimer !== null) {
      this.host.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.host.closeWatchers();
    this.enqueue(() => this.stopApp());
    // Joins an in-flight restart and any reap queued while waiting.
    for (;;) {
      const pending = this.queue;
      await pending;
      if (pending === this.queue) break;
    }
    await this.stopLauncherChildren();
    this.host.exit(exitCode);
  }

  private enqueue(task: () => Promise<void> | void): void {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      this.host.log(`[dev-electron] launcher task failed: ${String(error)}`);
    });
  }

  private startApp(): void {
    if (this.shuttingDown || this.current !== null) return;
    const entry: RunningApp = {
      app: this.host.spawnApp(),
      exited: false,
      exitSignal: null,
      expected: false,
      snapshot: new Map(),
      directChildren: [],
      pollTimer: null,
    };
    this.current = entry;
    entry.app.onError((error) => {
      this.host.log(`[dev-electron] failed to start Electron: ${error.message}`);
      this.onAppGone(entry, null, null);
    });
    entry.app.onExit((code, signal) => this.onAppGone(entry, code, signal));
    if (!this.host.windows) this.schedulePoll(entry);
  }

  private schedulePoll(entry: RunningApp): void {
    entry.pollTimer = this.host.setTimer(() => {
      entry.pollTimer = null;
      if (entry.exited || entry.expected) return;
      captureSnapshot(entry, this.host.listProcesses());
      this.schedulePoll(entry);
    }, DEV_ELECTRON_SNAPSHOT_INTERVAL_MS);
  }

  private onAppGone(entry: RunningApp, code: number | null, signal: string | null): void {
    if (entry.exited) return;
    entry.exited = true;
    entry.exitSignal = signal;
    this.clearPoll(entry);
    if (this.current === entry) this.current = null;
    if (entry.expected) return;
    const reap = () => terminateAppTree(this.host, entry, "reap");
    if (this.shuttingDown) {
      this.enqueue(reap);
      return;
    }
    if (signal === null && code === DEV_APP_DUPLICATE_INSTANCE_EXIT_CODE) {
      this.host.log(
        "[dev-electron] another dev instance holds the app lock; idle until next rebuild",
      );
      return;
    }
    this.enqueue(reap);
    if (signal === null && code === DEV_APP_RESTART_EXIT_CODE) {
      this.host.log("[dev-electron] app requested a restart; relaunching under supervision");
      this.enqueue(() => this.startApp());
    } else if (signal === null && code === DEV_APP_FATAL_EXIT_CODE) {
      this.host.log("[dev-electron] app hit a fatal error; idle until next rebuild");
    } else if (signal === null && code === 0) {
      this.host.log("[dev-electron] app quit; ending the dev session");
      this.enqueue(() => {
        this.endDevSession();
        void this.shutdown(0);
      });
    } else {
      this.host.log(
        `[dev-electron] app exited with ${signal ?? `code ${String(code)}`}; restarting`,
      );
      this.enqueue(() => this.startApp());
    }
  }

  /** D1: a user quit ends the whole `bun dev:desktop` session through dev-runner's Ctrl+C path. */
  private endDevSession(): void {
    const runner = this.host.devRunnerPid;
    if (runner === undefined) {
      this.host.log("[dev-electron] no dev runner to stop; stopping only the Electron launcher");
      return;
    }
    if (this.host.windows) {
      // No SIGINT on Windows: process.kill() would terminate dev-runner alone and strand turbo.
      quietly(() => this.host.killTree(runner));
      return;
    }
    if (!this.isAncestor(runner)) {
      this.host.log(
        `[dev-electron] dev runner pid ${runner} is not an ancestor; not signalling it`,
      );
      return;
    }
    signalQuietly(this.host, runner, "SIGINT");
  }

  private isAncestor(pid: number): boolean {
    const table = this.host.listProcesses();
    let cursor = table.get(this.host.launcherPid)?.ppid;
    for (let depth = 0; cursor !== undefined && cursor > 1 && depth < 64; depth += 1) {
      if (cursor === pid) return true;
      cursor = table.get(cursor)?.ppid;
    }
    return false;
  }

  private async stopApp(): Promise<void> {
    const entry = this.current;
    if (!entry) return;
    this.current = null;
    entry.expected = true;
    this.clearPoll(entry);
    if (!entry.exited) await terminateAppTree(this.host, entry, "stop");
  }

  /** Final fallback for anything else the launcher spawned. */
  private async stopLauncherChildren(): Promise<void> {
    if (this.host.windows) return;
    const self = this.host.launcherPid;
    const leftovers = collectDescendants(childrenByParent(this.host.listProcesses()), [
      self,
    ]).filter((pid) => pid !== self);
    if (leftovers.length === 0) return;
    for (const pid of leftovers) signalQuietly(this.host, pid, "SIGTERM");
    const gone = () => leftovers.every((pid) => !this.aliveQuietly(pid));
    if (await waitFor(this.host, gone, DEV_ELECTRON_CHILD_GRACE_MS)) return;
    for (const pid of leftovers)
      if (this.aliveQuietly(pid)) signalQuietly(this.host, pid, "SIGKILL");
  }

  private clearPoll(entry: RunningApp): void {
    if (entry.pollTimer === null) return;
    this.host.clearTimer(entry.pollTimer);
    entry.pollTimer = null;
  }

  private aliveQuietly(pid: number): boolean {
    try {
      return this.host.alive(pid);
    } catch {
      return false;
    }
  }
}
