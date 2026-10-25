/**
 * Budgets and host contract for the dev Electron launcher (`scripts/lib/dev-electron-launcher.ts`).
 *
 * Budget ordering, longest first (each outer budget must exceed everything nested in it):
 * - `DEV_SUPERVISOR_GRACE_MS` (8 s, `scripts/dev-supervise.lib.ts`) > `DEV_ELECTRON_MAX_SHUTDOWN_MS`.
 * - `DEV_ELECTRON_MAX_SHUTDOWN_MS` (5.7 s) = graceful stop (4 s) + forced settle (0.5 s) + launcher
 *   child grace (1.2 s).
 * - `DEV_ELECTRON_GRACEFUL_STOP_MS` (4 s) > the server's per-adapter stop-all timeout
 *   (`PROVIDER_STOP_ALL_ADAPTER_TIMEOUT`, 3 s, `apps/server/.../ProviderService.stopAll.ts`). That
 *   timeout bounds how long stop-all waits, not one session stop: an ACP session stop can take
 *   3 × 500 ms of capped cleanup, a 2 s SIGTERM window and a 1 s SIGKILL wait (about 4.5 s; see
 *   `apps/server/src/provider/acp/AcpSessionStop.ts`). The adapter finalizer's 4 s wait bounds
 *   that; whatever is still running when this graceful budget ends is SIGKILLed here.
 * - Unchanged: dev-runner's turbo `forceKillAfter` (1.5 s, `scripts/dev-runner.ts`); each
 *   dev-supervise detects its own orphaning, so it does not depend on turbo's budget.
 */
import type { ProcessTable } from "./dev-process-tree.ts";

export const DEV_ELECTRON_GRACEFUL_STOP_MS = 4_000;
/**
 * Extra time Electron gets once its backend subtree has drained. In dev a signal-driven quit can
 * leave Electron's main thread blocked for seconds after its backend exits; past this grace the
 * launcher stops waiting for it (the pre-change launcher SIGKILLed Electron after 1.5 s anyway).
 */
export const DEV_ELECTRON_APP_QUIT_GRACE_MS = 500;
export const DEV_ELECTRON_FORCE_SETTLE_MS = 500;
export const DEV_ELECTRON_CHILD_GRACE_MS = 1_200;
/** Longer than two build-output polls (300 ms each), so one rebuild yields one restart. */
export const DEV_ELECTRON_RESTART_DEBOUNCE_MS = 750;
/** Each poll lists processes once (`ps`), so zombies and reused PIDs count as gone. */
export const DEV_ELECTRON_STOP_POLL_MS = 200;
/** How often the app tree is re-snapshotted while the app runs (one `ps` call). */
export const DEV_ELECTRON_SNAPSHOT_INTERVAL_MS = 1_500;
/** Worst case from a shutdown signal to the launcher's exit. */
export const DEV_ELECTRON_MAX_SHUTDOWN_MS =
  DEV_ELECTRON_GRACEFUL_STOP_MS + DEV_ELECTRON_FORCE_SETTLE_MS + DEV_ELECTRON_CHILD_GRACE_MS;

export type LauncherSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface DevElectronApp {
  readonly pid: number | undefined;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface DevElectronLauncherHost {
  readonly windows: boolean;
  readonly launcherPid: number;
  /** `BIGBUD_DEV_RUNNER_PID`, when the launcher runs under `scripts/dev-runner.ts dev:desktop`. */
  readonly devRunnerPid: number | undefined;
  spawnApp(): DevElectronApp;
  /** The whole process table with start times; empty where unavailable (Windows). */
  listProcesses(): ProcessTable;
  /** Which of Electron's direct children is the bigbud server (`server/dist/bin.mjs`), if any. */
  findBackend(candidates: readonly number[]): number | undefined;
  signal(pid: number, signal: LauncherSignal): void;
  /** Windows only: `taskkill /pid <pid> /T /F`. */
  killTree(pid: number): void;
  alive(pid: number): boolean;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  log(message: string): void;
  closeWatchers(): void;
  exit(code: number): void;
}

export interface RunningApp {
  readonly app: DevElectronApp;
  exited: boolean;
  exitSignal: string | null;
  /** The launcher asked it to stop, so its exit is not a user action. */
  expected: boolean;
  /** Last snapshot of the app tree: PID to start time. */
  snapshot: Map<number, string>;
  /** Electron's direct children in that snapshot (server, cua-driver). */
  directChildren: readonly number[];
  pollTimer: unknown;
}

/**
 * `stop`: the launcher ends a running app. `reap`: the app already exited on its own (user quit,
 * dev Restart, fatal error or crash) and may have left its backend tearing down outside any tree.
 */
export type TerminateMode = "stop" | "reap";
