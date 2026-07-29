import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverServeArguments,
} from "@bigbud/shared/cua-driver/invocation";

import { resolveComputerUseRuntime } from "./cuaDriver";
import { parseCuaDriverHealthReport, type CuaDriverHealthReport } from "./cuaDriver.health";
import { callCuaDriverTool, stopCuaDriverMcpClient } from "./cuaDriver.mcpClient";
import { resolveManagedPaths } from "./cuaDriver.paths";
import { runCommand } from "./cuaDriver.process";

const STARTUP_TIMEOUT_MS = 10_000;
const RESTART_BACKOFF_MAX_MS = 10_000;

interface DaemonState {
  readonly baseDir: string;
  readonly binaryPath: string;
  readonly endpoint: string;
  readonly hostBundleId: string;
  readonly environment: NodeJS.ProcessEnv;
  child: ChildProcess.ChildProcess | null;
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  reachable: boolean;
  ready: boolean;
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
let runtimeGeneration = 0;
let startGeneration = 0;

function resolvePrivateEndpoint(baseDir: string): string {
  const suffix = Crypto.randomUUID();
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\bigbud-cua-${suffix}`;
  }
  const runDir = Path.join(resolveManagedPaths(baseDir).rootDir, "run", suffix);
  FS.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  FS.chmodSync(runDir, 0o700);
  return Path.join(runDir, "cua.sock");
}

function killProcessTree(child: ChildProcess.ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    ChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  child.kill(signal);
}

function spawnDaemon(state: DaemonState): void {
  state.reachable = false;
  state.ready = false;
  const child = ChildProcess.spawn(
    state.binaryPath,
    [...cuaDriverServeArguments(state.endpoint, state.hostBundleId)],
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
      if (!state.stopping) {
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
  const result = await callCuaDriverTool(
    state.binaryPath,
    "health_report",
    {},
    {
      socketPath: state.endpoint,
      environment: makeCuaDriverChildEnvironment(process.env, state.environment),
      timeoutMs,
    },
  );
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
      } catch {
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
  if (daemonState && !daemonState.stopping) return daemonState.environment;
  if (startPromise) return startPromise;

  const generation = ++startGeneration;
  const request = (async () => {
    const runtime = resolveComputerUseRuntime(baseDir);
    if (!runtime.binaryPath) return {};
    const endpoint = resolvePrivateEndpoint(baseDir);
    runtimeGeneration += 1;
    const environment = {
      BIGBUD_CUA_DRIVER_PATH: runtime.binaryPath,
      BIGBUD_CUA_RUNTIME_GENERATION: String(runtimeGeneration),
      ...(runtime.policyPath ? { CUA_DRIVER_POLICY_FILE: runtime.policyPath } : {}),
      ...cuaDriverEmbeddedEnvironment(endpoint, hostBundleId),
    };
    const state: DaemonState = {
      baseDir,
      binaryPath: runtime.binaryPath,
      endpoint,
      hostBundleId,
      environment,
      child: null,
      restartAttempt: 0,
      restartTimer: null,
      stopping: false,
      reachable: false,
      ready: false,
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
      state.lastError = "Daemon did not become ready before the startup deadline.";
      console.error("[desktop] cua-driver daemon did not become ready before the startup deadline");
    }
    return state.stopping || generation !== startGeneration ? {} : environment;
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
  return daemonState?.stopping ? undefined : daemonState?.environment;
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

export function stopCuaDriverDaemon(): void {
  startGeneration += 1;
  startPromise = null;
  stopCuaDriverMcpClient();
  const state = daemonState;
  daemonState = null;
  if (!state) return;
  state.stopping = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  const child = state.child;
  state.child = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    killProcessTree(child, "SIGTERM");
  }
  if (process.platform !== "win32") {
    FS.rmSync(Path.dirname(state.endpoint), { recursive: true, force: true });
  }
}
