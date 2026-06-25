import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";

import {
  backendChildEnv,
  captureBackendOutput,
  writeBackendSessionBoundary,
} from "../logging/logging";
import {
  ensureBackendModulesPath,
  resolveBackendCwd,
  resolveBackendEntry,
  resolveBackendLauncherPath,
  resolvePackagedBundledSkillsDir,
  resolvePackagedOpencodeBinaryDir,
} from "../env/pathResolver";
import type { RotatingFileSink } from "@bigbud/shared/logging";
import { readPersistedBackendObservabilitySettings } from "../logging/logging";

// ---------------------------------------------------------------------------
// Windows-safe process termination
// ---------------------------------------------------------------------------

/**
 * Kills a child process in a platform-safe way.
 *
 * On Windows, `child.kill()` only terminates the top-level process — it does
 * NOT kill the process tree.  If the child was spawned with `shell: true` it
 * also leaves the real process running behind a `cmd.exe` wrapper.
 * `taskkill /T /F` terminates the entire tree reliably on all Windows versions.
 *
 * On POSIX we fall back to standard signal delivery.
 */
function killBackendProcess(
  child: ChildProcess.ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      ChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // taskkill unavailable — fall through to direct kill.
    }
  }
  child.kill(signal);
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

export let backendProcess: ChildProcess.ChildProcess | null = null;
export let backendPort = 0;
export let backendAuthToken = "";
export let backendWsUrl = "";
export let backendHost = "";
export let restartAttempt = 0;
export let restartTimer: ReturnType<typeof setTimeout> | null = null;

const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();

/** No-op handler for pipe errors from a dying backend child.
 *  Keeps these errors from becoming uncaught exceptions in the main process. */
const swallowPipeError = () => {};

// ---------------------------------------------------------------------------
// Dependencies (injected once via init)
// ---------------------------------------------------------------------------

interface BackendManagerDeps {
  readonly rootDir: string;
  readonly baseDir: string;
  readonly backendMaxOldSpaceMb: number | null;
  readonly serverSettingsPath: string;
  readonly getIsQuitting: () => boolean;
  readonly getBackendLogSink: () => RotatingFileSink | null;
  readonly runId: string;
}

let _deps: BackendManagerDeps | null = null;

export function initBackendManager(deps: BackendManagerDeps): void {
  _deps = deps;
  backendPort = 0;
  backendAuthToken = "";
  backendWsUrl = "";
  backendHost = "";
  restartAttempt = 0;
  restartTimer = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logBackendBoundary(phase: "START" | "END", details: string): void {
  if (!_deps) return;
  writeBackendSessionBoundary(phase, details, _deps.getBackendLogSink(), _deps.runId);
}

function withBackendNodeOptions(
  env: NodeJS.ProcessEnv,
  backendMaxOldSpaceMb: number | null,
): NodeJS.ProcessEnv {
  if (!backendMaxOldSpaceMb) {
    return env;
  }

  const nextFlag = `--max-old-space-size=${backendMaxOldSpaceMb}`;
  const existingNodeOptions = env.NODE_OPTIONS?.trim();

  if (existingNodeOptions?.includes("--max-old-space-size=")) {
    return env;
  }

  return {
    ...env,
    NODE_OPTIONS: existingNodeOptions ? `${existingNodeOptions} ${nextFlag}` : nextFlag,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Set the resolved port/auth/url (called from bootstrap after port reservation).
 */
export function setBackendConnectionInfo(opts: {
  port: number;
  authToken: string;
  wsUrl: string;
  host: string;
}): void {
  backendPort = opts.port;
  backendAuthToken = opts.authToken;
  backendWsUrl = opts.wsUrl;
  backendHost = opts.host;
}

export function scheduleBackendRestart(reason: string): void {
  if (!_deps) return;
  if (_deps.getIsQuitting() || restartTimer) return;

  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    startBackend();
  }, delayMs);
}

export function startBackend(): void {
  if (!_deps) return;
  if (_deps.getIsQuitting() || backendProcess) return;

  const backendObservabilitySettings = readPersistedBackendObservabilitySettings(
    _deps.serverSettingsPath,
  );
  const backendEntry = resolveBackendEntry(_deps.rootDir);
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const backendLogSink = _deps.getBackendLogSink();
  const captureBackendLogs = backendLogSink !== null;
  const packagedOpencodeBinDir = resolvePackagedOpencodeBinaryDir();
  const packagedBundledSkillsDir = resolvePackagedBundledSkillsDir();
  const backendLauncherPath = resolveBackendLauncherPath();

  // Ensure _modules → node_modules link exists for ESM resolution of
  // external native packages (e.g. @github/copilot-sdk, node-pty).
  ensureBackendModulesPath();

  // Always pipe stderr so we can capture crash output for diagnostics,
  // regardless of whether a log sink is configured.
  const child = ChildProcess.spawn(backendLauncherPath, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: resolveBackendCwd(_deps.rootDir),
    // In packaged Linux AppImages, process.execPath can point at the outer
    // AppImage launcher. Prefer the mounted in-image executable when available
    // so backend restarts do not re-enter the AppImage runtime.
    env: withBackendNodeOptions(
      {
        ...backendChildEnv(),
        ...(packagedOpencodeBinDir
          ? {
              PATH: [packagedOpencodeBinDir, process.env.PATH]
                .filter((entry): entry is string => Boolean(entry && entry.length > 0))
                .join(process.platform === "win32" ? ";" : ":"),
            }
          : {}),
        ...(packagedBundledSkillsDir
          ? { BIGBUD_BUNDLED_SKILLS_DIR: packagedBundledSkillsDir }
          : {}),
        ELECTRON_RUN_AS_NODE: "1",
      },
      _deps.backendMaxOldSpaceMb,
    ),
    stdio: captureBackendLogs
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "inherit", "pipe", "pipe"],
  });

  // Swallow pipe errors on stdio streams. When the backend child exits
  // abruptly (e.g. permission denied, immediate crash) the pipe endpoints
  // emit 'error' with ECONNRESET / EPIPE. Without handlers these become
  // uncaught exceptions in the main process. The 'exit' / 'error' handlers
  // on the child process capture the real reason and schedule a restart.
  if (child.stdout) {
    child.stdout.on("error", swallowPipeError);
  }
  if (child.stderr) {
    child.stderr.on("error", swallowPipeError);
  }

  // Buffer the last 2 KB of stderr for crash diagnostics.
  const stderrTail: string[] = [];
  const MAX_STDERR_TAIL = 2048;
  let stderrTailLength = 0;
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail.push(chunk);
      stderrTailLength += chunk.length;
      // Trim oldest chunks when buffer exceeds limit.
      while (stderrTailLength > MAX_STDERR_TAIL && stderrTail.length > 1) {
        const removed = stderrTail.shift();
        stderrTailLength -= removed?.length ?? 0;
      }
    });
  }
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.on("error", swallowPipeError);
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
        host: backendHost,
        t3Home: _deps.baseDir,
        authToken: backendAuthToken,
        ...(backendObservabilitySettings.otlpTracesUrl
          ? { otlpTracesUrl: backendObservabilitySettings.otlpTracesUrl }
          : {}),
        ...(backendObservabilitySettings.otlpMetricsUrl
          ? { otlpMetricsUrl: backendObservabilitySettings.otlpMetricsUrl }
          : {}),
      })}\n`,
    );
    bootstrapStream.end();
  } else {
    killBackendProcess(child);
    scheduleBackendRestart("missing desktop bootstrap pipe");
    return;
  }
  backendProcess = child;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    logBackendBoundary("END", details);
  };
  logBackendBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd(_deps.rootDir)} exec=${backendLauncherPath}`,
  );
  captureBackendOutput(child, backendLogSink);

  child.once("spawn", () => {
    restartAttempt = 0;
  });

  child.on("error", (error) => {
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    if (wasExpected) {
      return;
    }
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (_deps?.getIsQuitting() || wasExpected) return;
    const crashDetail = stderrTail.join("").trim().slice(-512).replace(/\n/g, " ↵ ");
    const reason = `code=${code ?? "null"} signal=${signal ?? "null"}${crashDetail ? ` stderr=${crashDetail}` : ""}`;
    scheduleBackendRestart(reason);
  });
}

export function stopBackend(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;

  if (child.exitCode === null && child.signalCode === null) {
    expectedBackendExitChildren.add(child);
    killBackendProcess(child);
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        killBackendProcess(child, "SIGKILL");
      }
    }, 2_000).unref();
  }
}

export async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;
  expectedBackendExitChildren.add(backendChild);

  await new Promise<void>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let exitTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

    function settle(): void {
      if (settled) return;
      settled = true;
      backendChild.off("exit", onExit);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (exitTimeoutTimer) {
        clearTimeout(exitTimeoutTimer);
      }
      resolve();
    }

    function onExit(): void {
      settle();
    }

    backendChild.once("exit", onExit);
    killBackendProcess(backendChild);

    forceKillTimer = setTimeout(() => {
      if (backendChild.exitCode === null && backendChild.signalCode === null) {
        killBackendProcess(backendChild, "SIGKILL");
      }
    }, 2_000);
    forceKillTimer.unref();

    exitTimeoutTimer = setTimeout(() => {
      settle();
    }, timeoutMs);
    exitTimeoutTimer.unref();
  });
}
