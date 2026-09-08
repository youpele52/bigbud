import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import { app } from "electron";
import {
  backendChildEnv,
  captureBackendOutput,
  type LogSink,
  writeBackendLifecycleEvent,
  writeBackendSessionBoundary,
} from "../logging/logging";
import {
  ensureBackendModulesPath,
  resolveBackendCwd,
  resolveBackendEntry,
  resolveBackendLauncherPath,
  resolveBackendNodeExecutable,
  resolvePackagedBundledAgentsDir,
  resolvePackagedBundledSkillsDir,
  resolvePackagedOpencodeBinaryDir,
  resolvePackagedWorkspaceAgentBinary,
  resolvePackagedDesktopSupervisorBinary,
} from "../env/pathResolver";
import { readPersistedBackendObservabilitySettings } from "../logging/logging";
import { killBackendProcess } from "./backendProcess";
import { stopBackendChild, stopBackendChildAndWait } from "./backendShutdown";
import {
  beginBackendStartup,
  recordBackendStartupDevelopmentDiagnostics,
  recordBackendStartupFailure,
} from "./backendStartupState";
import { listenForBackendStartupStatus } from "./backendStartupStatusPipe";
import { withBackendNodeOptions } from "./backendEnv";
import {
  createBackendStartupDiagnostics,
  createDevelopmentBackendDiagnostics,
} from "./backendStartupDiagnostics";
import { resolveComputerUseRuntimeEnv } from "./backendRuntimeEnv";
import * as ProcessQuiescence from "./installedProcessQuiescence";
import { resolveBackendStartWhenAllowed } from "./backendStartGuard";
export let backendProcess: ChildProcess.ChildProcess | null = null;
export let backendPort = 0;
export let backendAuthToken = "";
export let backendWsUrl = "";
export let backendHost = "";
export let restartAttempt = 0;
export let restartTimer: ReturnType<typeof setTimeout> | null = null;
let backendStartPending = false;
const expectedBackendExitChildren = new WeakSet<ChildProcess.ChildProcess>();
const swallowPipeError = () => {};
interface BackendManagerDeps {
  readonly rootDir: string;
  readonly baseDir: string;
  readonly backendMaxOldSpaceMb: number | null;
  readonly cuaDriverHostBundleId: string;
  readonly serverSettingsPath: string;
  readonly getIsQuitting: () => boolean;
  readonly getBackendLogSink: () => LogSink | null;
  readonly isDevelopmentDiagnostics: boolean;
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
function logBackendBoundary(phase: "START" | "END", details: string): void {
  if (!_deps) return;
  writeBackendSessionBoundary(phase, details, _deps.getBackendLogSink(), _deps.runId);
}
function logBackendLifecycle(event: string, details: string): void {
  if (!_deps) return;
  writeBackendLifecycleEvent(event, details, _deps.getBackendLogSink(), _deps.runId);
}
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
  if (_deps.getIsQuitting() || ProcessQuiescence.isInstalledProcessQuiescing() || restartTimer)
    return;
  const delayMs = Math.min(500 * 2 ** restartAttempt, 10_000);
  restartAttempt += 1;
  logBackendLifecycle(
    "restart_scheduled",
    `attempt=${restartAttempt} delayMs=${delayMs} reason=${reason}`,
  );
  console.error(`[desktop] backend exited unexpectedly (${reason}); restarting in ${delayMs}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void startBackend();
  }, delayMs);
}
export async function startBackend(): Promise<void> {
  if (!_deps) return;
  if (
    _deps.getIsQuitting() ||
    ProcessQuiescence.isInstalledProcessQuiescing() ||
    backendProcess ||
    backendStartPending
  )
    return;
  backendStartPending = true;
  let computerUseRuntimeEnv: NodeJS.ProcessEnv | undefined;
  try {
    computerUseRuntimeEnv = await resolveBackendStartWhenAllowed(() =>
      resolveComputerUseRuntimeEnv(_deps!.baseDir, _deps!.cuaDriverHostBundleId),
    );
  } finally {
    backendStartPending = false;
  }
  if (
    !computerUseRuntimeEnv ||
    _deps.getIsQuitting() ||
    ProcessQuiescence.isInstalledProcessQuiescing() ||
    backendProcess
  )
    return;
  const startupGeneration = beginBackendStartup();
  logBackendLifecycle("startup_requested", `generation=${startupGeneration}`);

  const backendObservabilitySettings = readPersistedBackendObservabilitySettings(
    _deps.serverSettingsPath,
  );
  const backendEntry = resolveBackendEntry(_deps.rootDir);
  if (!FS.existsSync(backendEntry)) {
    logBackendLifecycle(
      "server_entry_missing",
      `generation=${startupGeneration} entry=${backendEntry}`,
    );
    recordBackendStartupFailure(
      startupGeneration,
      "server_entry_missing",
      createBackendStartupDiagnostics({ category: "bootstrap" }),
    );
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const backendLogSink = _deps.getBackendLogSink();
  const captureBackendLogs = backendLogSink !== null;
  const packagedOpencodeBinDir = resolvePackagedOpencodeBinaryDir();
  const packagedBundledSkillsDir = resolvePackagedBundledSkillsDir();
  const packagedBundledAgentsDir = resolvePackagedBundledAgentsDir();
  const packagedWorkspaceAgentBinary = resolvePackagedWorkspaceAgentBinary();
  const packagedDesktopSupervisorBinary = resolvePackagedDesktopSupervisorBinary();
  const backendLauncherPath = resolveBackendLauncherPath();
  const backendNodeExecutable = resolveBackendNodeExecutable(backendLauncherPath);
  ensureBackendModulesPath();
  let child: ChildProcess.ChildProcess;
  try {
    child = ChildProcess.spawn(backendLauncherPath, [backendEntry, "--bootstrap-fd", "3"], {
      cwd: resolveBackendCwd(_deps.rootDir),
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
          ...(packagedBundledAgentsDir
            ? { BIGBUD_BUNDLED_AGENTS_DIR: packagedBundledAgentsDir }
            : {}),
          ...(packagedWorkspaceAgentBinary
            ? { BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY: packagedWorkspaceAgentBinary }
            : {}),
          ...(packagedDesktopSupervisorBinary
            ? { BIGBUD_DESKTOP_SUPERVISOR_BINARY: packagedDesktopSupervisorBinary }
            : {}),
          ...computerUseRuntimeEnv,
          BIGBUD_NODE_EXECUTABLE: backendNodeExecutable,
          BIGBUD_DESKTOP_PACKAGED: app.isPackaged ? "1" : "0",
          ELECTRON_RUN_AS_NODE: "1",
          BIGBUD_STARTUP_STATUS_FD: "4",
        },
        _deps.backendMaxOldSpaceMb,
      ),
      stdio: captureBackendLogs
        ? ["ignore", "pipe", "pipe", "pipe", "pipe"]
        : ["ignore", "inherit", "pipe", "pipe", "pipe"],
    });
  } catch (error) {
    logBackendLifecycle(
      "child_spawn_threw",
      `generation=${startupGeneration} error=${String(error)}`,
    );
    recordBackendStartupFailure(
      startupGeneration,
      "child_spawn_failed",
      createBackendStartupDiagnostics({ category: "process", errorMessage: String(error) }),
    );
    scheduleBackendRestart("backend child spawn failed");
    return;
  }
  logBackendLifecycle(
    "child_spawned",
    `generation=${startupGeneration} pid=${child.pid ?? "unknown"} launcher=${backendLauncherPath} entry=${backendEntry}`,
  );
  if (child.stdout)
    child.stdout.on("error", (error) => {
      logBackendLifecycle("stdout_error", `generation=${startupGeneration} error=${error.message}`);
      swallowPipeError();
    });
  if (child.stderr)
    child.stderr.on("error", (error) => {
      logBackendLifecycle("stderr_error", `generation=${startupGeneration} error=${error.message}`);
      swallowPipeError();
    });
  const statusStream = child.stdio[4];
  if (statusStream && "on" in statusStream) {
    statusStream.on("error", (error) => {
      logBackendLifecycle("fd4_error", `generation=${startupGeneration} error=${error.message}`);
      swallowPipeError();
    });
    listenForBackendStartupStatus(
      statusStream as import("node:stream").Readable,
      startupGeneration,
      (detail) =>
        logBackendLifecycle("fd4_invalid_record", `generation=${startupGeneration} ${detail}`),
      () => {
        restartAttempt = 0;
      },
    );
  }

  let stderrTail = "";
  const MAX_STDERR_TAIL = 8_192;
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-MAX_STDERR_TAIL);
      if (_deps?.isDevelopmentDiagnostics) {
        recordBackendStartupDevelopmentDiagnostics(
          startupGeneration,
          createDevelopmentBackendDiagnostics({ stderrTail }),
        );
      }
    });
  }
  const bootstrapStream = child.stdio[3];
  if (bootstrapStream && "write" in bootstrapStream) {
    bootstrapStream.on("error", (error) => {
      logBackendLifecycle(
        "bootstrap_fd3_error",
        `generation=${startupGeneration} error=${error.message}`,
      );
      swallowPipeError();
    });
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
    logBackendLifecycle("bootstrap_pipe_missing", `generation=${startupGeneration}`);
    recordBackendStartupFailure(
      startupGeneration,
      "bootstrap_failed",
      createBackendStartupDiagnostics({ category: "bootstrap" }),
    );
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

  child.on("error", (error) => {
    logBackendLifecycle(
      "child_error",
      `generation=${startupGeneration} pid=${child.pid ?? "unknown"} error=${error.stack ?? error.message} stderr=${stderrTail}`,
    );
    recordBackendStartupFailure(
      startupGeneration,
      "child_spawn_failed",
      createBackendStartupDiagnostics({
        category: "process",
        errorMessage: error.message,
        stderrTail,
      }),
      _deps?.isDevelopmentDiagnostics
        ? createDevelopmentBackendDiagnostics({ error, stderrTail })
        : undefined,
    );
    if (_deps?.isDevelopmentDiagnostics) {
      recordBackendStartupDevelopmentDiagnostics(
        startupGeneration,
        createDevelopmentBackendDiagnostics({ error, stderrTail }),
      );
    }
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
    logBackendLifecycle(
      "child_exit",
      `generation=${startupGeneration} pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"} stderr=${stderrTail}`,
    );
    recordBackendStartupFailure(
      startupGeneration,
      "child_exit_before_ready",
      createBackendStartupDiagnostics({
        category: "process",
        exitCode: code,
        exitSignal: signal,
        stderrTail,
      }),
      _deps?.isDevelopmentDiagnostics
        ? createDevelopmentBackendDiagnostics({ exitCode: code, exitSignal: signal, stderrTail })
        : undefined,
    );
    if (_deps?.isDevelopmentDiagnostics) {
      recordBackendStartupDevelopmentDiagnostics(
        startupGeneration,
        createDevelopmentBackendDiagnostics({ exitCode: code, exitSignal: signal, stderrTail }),
      );
    }
    const wasExpected = expectedBackendExitChildren.has(child);
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(
      `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
    );
    if (_deps?.getIsQuitting() || wasExpected) return;
    const crashDetail = stderrTail.trim().slice(-512).replace(/\n/g, " ↵ ");
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
  stopBackendChild(child, expectedBackendExitChildren);
}

export async function stopBackendAndWaitForExit(timeoutMs = 5_000): Promise<void> {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  await ProcessQuiescence.waitForInstalledProcessStarts();
  const child = backendProcess;
  if (!child) return;
  await stopBackendChildAndWait(child, expectedBackendExitChildren, timeoutMs);
  if (backendProcess === child) backendProcess = null;
}
