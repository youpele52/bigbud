import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";

import {
  cuaDriverStateEnvironment,
  makeCuaDriverChildEnvironment,
} from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverServeArguments,
} from "@bigbud/shared/cua-driver/invocation";

import { prepareCuaCursorTheme } from "./cuaDriver.cursorTheme";
import { inspectCuaDriverCompatibility } from "./cuaDriver.compatibility";
import { validateCuaDriverPolicyEnforcement } from "./cuaDriver.policyProbe";
import { cuaDriverRuntimeKey, setCuaDriverStartupFailure } from "./cuaDriver.startupFailure";
import { resolveComputerUseRuntime } from "./cuaDriver.runtime";
import { stopChildProcessTreeAndWait } from "./backendShutdown";
import { removeStaleDaemonSocket } from "./cuaDriver.daemon.endpoint";
import { resolvePrivateEndpoint } from "./cuaDriver.daemon.paths";
import { parseCuaDriverHealthReport, type CuaDriverHealthReport } from "./cuaDriver.health";
import { callCuaDriverTool, stopCuaDriverMcpClientAndWait } from "./cuaDriver.mcpClient";
import { resolvePrivateStateHome } from "./cuaDriver.paths";
import { runCommand } from "./cuaDriver.process";
import { isInstalledProcessQuiescing } from "./installedProcessQuiescence";

const STARTUP_TIMEOUT_MS = 10_000;
const RESTART_BACKOFF_MAX_MS = 10_000;

interface DaemonState {
  readonly baseDir: string;
  readonly binaryPath: string;
  readonly endpoint: string;
  /** Private run directory holding the socket (Unix) and the PID file. */
  readonly runDir: string;
  /** `--pid-file` inside `runDir`; `null` when the Driver version does not honour it. */
  readonly pidFile: string | null;
  /** Installed `--cursor-theme` id; `null` keeps the Driver's default cursor. */
  readonly cursorTheme: string | null;
  readonly hostBundleId: string;
  readonly environment: NodeJS.ProcessEnv;
  child: ChildProcess.ChildProcess | null;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  reachable: boolean;
  ready: boolean;
  validated: boolean;
  lastError: string | null;
  healthReport: CuaDriverHealthReport | null;
}

export interface CuaDriverDaemonStatus {
  readonly state: "stopped" | "starting" | "ready" | "restarting" | "degraded";
  readonly binaryPath: string | null;
  readonly lastError: string | null;
  readonly healthSummary: string | null;
  readonly repairRequired: boolean;
}

let daemonState: DaemonState | null = null;
let startPromise: Promise<NodeJS.ProcessEnv> | null = null;
let stopPromise: Promise<void> | null = null;
let runtimeGeneration = 0;
let startGeneration = 0;

function spawnDaemon(state: DaemonState): void {
  if (state.stopping || isInstalledProcessQuiescing()) return;
  state.reachable = false;
  state.ready = false;
  state.validated = false;
  const child = ChildProcess.spawn(
    state.binaryPath,
    [
      ...cuaDriverServeArguments(state.endpoint, state.hostBundleId, {
        ...(state.pidFile ? { pidFile: state.pidFile } : {}),
        ...(state.cursorTheme ? { cursorTheme: state.cursorTheme } : {}),
      }),
    ],
    {
      env: makeCuaDriverChildEnvironment(process.env, state.environment),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    },
  );
  state.child = child;
  let stderrTail = "";
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2_048);
  });
  child.once("error", (error) => {
    state.lastError = error.message.slice(-1_024);
    console.error(`[desktop] cua-driver daemon failed: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    if (state.child === child) state.child = null;
    if (state.stopping) return;
    const detail = stderrTail.trim().slice(-512).replace(/\n/g, " ↵ ");
    state.reachable = false;
    state.ready = false;
    state.lastError = `code=${code ?? "null"}, signal=${signal ?? "null"}${detail ? `: ${detail}` : ""}`;
    console.error(
      `[desktop] cua-driver daemon exited (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : ""}`,
    );
    const delayMs = Math.min(500 * 2 ** state.restartAttempt, RESTART_BACKOFF_MAX_MS);
    state.restartAttempt += 1;
    state.restartTimer = setTimeout(() => {
      state.restartTimer = null;
      if (!state.stopping && !isInstalledProcessQuiescing()) {
        if (removeStaleDaemonSocket(state.endpoint, state.runDir) === "blocked") {
          state.lastError = `cua-driver endpoint ${state.endpoint} exists and is not a removable socket; not restarting.`;
          console.error(`[desktop] ${state.lastError}`);
          return;
        }
        spawnDaemon(state);
        void waitUntilReady(state).then((health) => {
          if (health && !state.stopping) {
            applyHealthReport(state, health);
            state.restartAttempt = 0;
          }
        });
      }
    }, delayMs);
    state.restartTimer.unref();
  });
}

function applyHealthReport(state: DaemonState, report: CuaDriverHealthReport): void {
  state.healthReport = report;
  state.reachable = true;
  state.ready = report.overall === "ok";
  state.lastError = report.repairRequired
    ? (report.diagnostics?.slice(-1_024) ?? `cua-driver health is ${report.overall}.`)
    : null;
}

async function readDaemonHealth(
  state: DaemonState,
  timeoutMs: number,
): Promise<CuaDriverHealthReport> {
  const child = state.child;
  if (state.stopping) throw new Error("Computer Use startup was stopped.");
  if (!state.validated) {
    await validateCuaDriverPolicyEnforcement(state.binaryPath, {
      socketPath: state.endpoint,
      environment: makeCuaDriverChildEnvironment(process.env, state.environment),
      timeoutMs: Math.max(1, Math.floor(timeoutMs / 2)),
    });
    if (state.stopping || state.child !== child)
      throw new Error("Computer Use startup was stopped.");
    state.validated = true;
  }
  const result = await callCuaDriverTool(
    state.binaryPath,
    "health_report",
    {},
    {
      socketPath: state.endpoint,
      environment: makeCuaDriverChildEnvironment(process.env, state.environment),
      timeoutMs: Math.max(1, Math.floor(timeoutMs / 2)),
    },
  );
  if (state.stopping || state.child !== child) throw new Error("Computer Use startup was stopped.");
  return parseCuaDriverHealthReport(result);
}

async function waitUntilReady(state: DaemonState): Promise<CuaDriverHealthReport | null> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!state.stopping && Date.now() < deadline) {
    if (state.child?.exitCode === null && state.child.signalCode === null) {
      try {
        const status = await runCommand(
          state.binaryPath,
          ["status", "--socket", state.endpoint],
          makeCuaDriverChildEnvironment(process.env, state.environment),
          1_000,
        );
        if (status.code === 0) {
          return await readDaemonHealth(state, Math.max(1, deadline - Date.now()));
        }
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        // The daemon is still starting; retry within the bounded deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function startCuaDriverDaemon(
  baseDir: string,
  hostBundleId: string,
): Promise<NodeJS.ProcessEnv> {
  if (isInstalledProcessQuiescing()) return {};
  if (stopPromise) await stopPromise;
  if (isInstalledProcessQuiescing()) return {};
  if (daemonState?.stopping) await stopCuaDriverDaemonAndWait();
  if (isInstalledProcessQuiescing()) return {};
  if (startPromise) return startPromise;
  if (daemonState && !daemonState.stopping)
    return daemonState.validated && daemonState.reachable ? daemonState.environment : {};

  const generation = ++startGeneration;
  const request = (async () => {
    const runtime = resolveComputerUseRuntime(baseDir);
    if (!runtime.binaryPath) return {};
    const key = cuaDriverRuntimeKey(baseDir, runtime.binaryPath, runtime.policyPath);
    setCuaDriverStartupFailure(key, null);
    const stateHome = resolvePrivateStateHome(baseDir);
    const compatibility = await inspectCuaDriverCompatibility(
      runtime.binaryPath,
      runtime.policyPath ?? undefined,
      stateHome,
    ).catch((error: unknown) => {
      if (generation === startGeneration) setCuaDriverStartupFailure(key, String(error));
      throw error;
    });
    if (generation !== startGeneration || isInstalledProcessQuiescing()) return {};
    const { endpoint, runDir, pidFile } = resolvePrivateEndpoint(baseDir);
    runtimeGeneration += 1;
    const environment = {
      BIGBUD_CUA_DRIVER_PATH: runtime.binaryPath,
      BIGBUD_CUA_RUNTIME_GENERATION: String(runtimeGeneration),
      ...(compatibility.version !== "0.9.1" && compatibility.version !== "0.38.0"
        ? { BIGBUD_CUA_VALIDATE_MCP: "1" }
        : {}),
      ...(runtime.policyPath ? { CUA_DRIVER_POLICY_FILE: runtime.policyPath } : {}),
      ...cuaDriverStateEnvironment(stateHome),
      ...cuaDriverEmbeddedEnvironment(endpoint, hostBundleId),
    };
    const state: DaemonState = {
      baseDir,
      binaryPath: runtime.binaryPath,
      endpoint,
      runDir,
      pidFile: compatibility.honoursPidFile ? pidFile : null,
      cursorTheme: prepareCuaCursorTheme(stateHome, compatibility.version),
      hostBundleId,
      environment,
      child: null,
      restartAttempt: 0,
      restartTimer: null,
      stopping: false,
      reachable: false,
      ready: false,
      validated: false,
      lastError: null,
      healthReport: null,
    };
    daemonState = state;
    spawnDaemon(state);
    const health = await waitUntilReady(state);
    if (health) {
      if (state.stopping || generation !== startGeneration) return {};
      applyHealthReport(state, health);
      state.restartAttempt = 0;
    } else {
      state.lastError ??= "Daemon did not become ready before the startup deadline.";
      if (generation === startGeneration) {
        setCuaDriverStartupFailure(key, state.lastError);
        await stopCuaDriverDaemonAndWait();
      }
      console.error("[desktop] cua-driver daemon did not become ready before the startup deadline");
    }
    return state.stopping || generation !== startGeneration || !health ? {} : environment;
  })();
  startPromise = request;
  const clearRequest = () => {
    if (startPromise === request) startPromise = null;
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

export function getCuaDriverDaemonStatus(): CuaDriverDaemonStatus {
  const state = daemonState;
  if (!state) {
    return {
      state: "stopped",
      binaryPath: null,
      lastError: null,
      healthSummary: null,
      repairRequired: true,
    };
  }
  const healthSummary = state.healthReport?.overall ?? null;
  const repairRequired = state.healthReport?.repairRequired ?? true;
  if (state.stopping) {
    return {
      state: "stopped",
      binaryPath: state.binaryPath,
      lastError: state.lastError,
      healthSummary,
      repairRequired,
    };
  }
  if (state.ready && state.child) {
    return {
      state: "ready",
      binaryPath: state.binaryPath,
      lastError: null,
      healthSummary,
      repairRequired: false,
    };
  }
  if (state.reachable && state.child) {
    return {
      state: "degraded",
      binaryPath: state.binaryPath,
      lastError: state.lastError,
      healthSummary,
      repairRequired,
    };
  }
  if (state.restartTimer) {
    return {
      state: "restarting",
      binaryPath: state.binaryPath,
      lastError: state.lastError,
      healthSummary,
      repairRequired: true,
    };
  }
  return {
    state: state.child ? "starting" : "degraded",
    binaryPath: state.binaryPath,
    lastError: state.lastError,
    healthSummary,
    repairRequired: true,
  };
}

export function getCuaDriverDaemonEnvironment(): NodeJS.ProcessEnv | undefined {
  return daemonState?.stopping || !daemonState?.validated || !daemonState.reachable
    ? undefined
    : daemonState.environment;
}

export async function refreshCuaDriverDaemonHealth(): Promise<CuaDriverHealthReport> {
  const state = daemonState;
  if (!state || state.stopping || !state.child) {
    throw new Error("The embedded cua-driver daemon is not running.");
  }
  const health = await readDaemonHealth(state, STARTUP_TIMEOUT_MS);
  applyHealthReport(state, health);
  return health;
}

export function stopCuaDriverDaemonAndWait(timeoutMs = 5_000): Promise<void> {
  if (stopPromise) return stopPromise;
  startGeneration += 1;
  startPromise = null;
  const mcpStop = stopCuaDriverMcpClientAndWait(timeoutMs);
  const state = daemonState;
  if (!state) return mcpStop;
  state.stopping = true;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
  const child = state.child;
  const request = (async () => {
    const daemonStop = child
      ? stopChildProcessTreeAndWait(child, new WeakSet(), timeoutMs)
      : Promise.resolve();
    const results = await Promise.allSettled([mcpStop, daemonStop]);
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "Could not confirm cua-driver process shutdown.");
    }
    if (state.child === child) state.child = null;
    if (daemonState === state) daemonState = null;
    FS.rmSync(state.runDir, { recursive: true, force: true });
  })();
  stopPromise = request;
  const clearRequest = () => {
    if (stopPromise === request) stopPromise = null;
  };
  void request.then(clearRequest, clearRequest);
  return request;
}

export function stopCuaDriverDaemon(): void {
  void stopCuaDriverDaemonAndWait().catch((error: unknown) => {
    console.error(`[desktop] Failed to confirm cua-driver daemon shutdown: ${String(error)}`);
  });
}
