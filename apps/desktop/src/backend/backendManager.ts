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
export let restartAttempt = 0;
export let restartTimer: ReturnType<typeof setTimeout> | null = null;

const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();

// ---------------------------------------------------------------------------
// Dependencies (injected once via init)
// ---------------------------------------------------------------------------

interface BackendManagerDeps {
  readonly rootDir: string;
  readonly baseDir: string;
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
}): void {
  backendPort = opts.port;
  backendAuthToken = opts.authToken;
  backendWsUrl = opts.wsUrl;
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

  // Ensure _modules → node_modules link exists for ESM resolution of
  // external native packages (e.g. @github/copilot-sdk, node-pty).
  ensureBackendModulesPath();

  // Always pipe stderr so we can capture crash output for diagnostics,
  // regardless of whether a log sink is configured.
  const child = ChildProcess.spawn(process.execPath, [backendEntry, "--bootstrap-fd", "3"], {
    cwd: resolveBackendCwd(_deps.rootDir),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendChildEnv(),
      ...(packagedOpencodeBinDir
        ? {
            PATH: [packagedOpencodeBinDir, process.env.PATH]
              .filter((entry): entry is string => Boolean(entry && entry.length > 0))
              .join(process.platform === "win32" ? ";" : ":"),
          }
        : {}),
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: captureBackendLogs
      ? ["ignore", "pipe", "pipe", "pipe"]
      : ["ignore", "inherit", "pipe", "pipe"],
  });

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
    bootstrapStream.write(
      `${JSON.stringify({
        mode: "desktop",
        noBrowser: true,
        port: backendPort,
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
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd(_deps.rootDir)}`,
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
