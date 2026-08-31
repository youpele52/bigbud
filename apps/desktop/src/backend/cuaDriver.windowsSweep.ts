import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  WINDOWS_CUA_SWEEP_DRY_RUN_ENV,
  WINDOWS_CUA_SWEEP_SCRIPT,
  WINDOWS_CUA_SWEEP_TARGET_PATH_ENV,
  WINDOWS_CUA_SWEEP_WAIT_TIMEOUT_ENV,
} from "./cuaDriver.windowsSweep.script";
import {
  resolveTrustedWindowsPowerShell,
  type TrustedWindowsPowerShell,
} from "./windowsPowerShell";

export { WINDOWS_CUA_SWEEP_SCRIPT } from "./cuaDriver.windowsSweep.script";

const DEFAULT_ATTEMPTS = 3;
// Windows PowerShell 5.1 can spend more than 15 seconds compiling the native helper on a cold host.
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_000;

interface SweepSuccess {
  readonly status: "ok";
  readonly matched: number;
  readonly terminated: number;
  readonly raced: number;
}

interface SweepFailure {
  readonly status: "error";
  readonly code: string;
  readonly pid?: number;
}

type SweepOutput = SweepSuccess | SweepFailure;

interface WindowsCuaSweepDeps {
  readonly platform: NodeJS.Platform;
  readonly canonicalize: (path: string) => string;
  readonly resolvePowerShell: () => TrustedWindowsPowerShell;
  readonly spawnSync: typeof ChildProcess.spawnSync;
}

const defaultDeps: WindowsCuaSweepDeps = {
  platform: process.platform,
  canonicalize: FS.realpathSync.native,
  resolvePowerShell: resolveTrustedWindowsPowerShell,
  spawnSync: ChildProcess.spawnSync,
};

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseSweepOutput(stdout: string): SweepOutput {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw new Error("Windows CUA process sweep returned malformed output.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("Windows CUA process sweep returned malformed output.");
  }
  const output = value as Record<string, unknown>;
  if (
    output.status === "ok" &&
    isNonNegativeInteger(output.matched) &&
    isNonNegativeInteger(output.terminated) &&
    isNonNegativeInteger(output.raced) &&
    output.terminated <= output.matched &&
    Object.keys(output).length === 4
  ) {
    return output as unknown as SweepSuccess;
  }
  if (
    output.status === "error" &&
    typeof output.code === "string" &&
    (output.pid === undefined || isNonNegativeInteger(output.pid)) &&
    Object.keys(output).every((key) => key === "status" || key === "code" || key === "pid")
  ) {
    return output as unknown as SweepFailure;
  }
  throw new Error("Windows CUA process sweep returned malformed output.");
}

export function windowsExecutablePathsEqual(left: string, right: string): boolean {
  const extendedUncPrefix = "\\\\?\\unc\\";
  const extendedPrefix = "\\\\?\\";
  const normalize = (value: string) => {
    const path = Path.win32.normalize(value);
    if (path.toLowerCase().startsWith(extendedUncPrefix)) {
      return `\\\\${path.slice(8)}`.toLowerCase();
    }
    if (path.startsWith(extendedPrefix)) return path.slice(4).toLowerCase();
    return path.toLowerCase();
  };
  return normalize(left) === normalize(right);
}

export function sweepWindowsCuaDriverProcesses(input: {
  readonly executablePath: string | null;
  readonly attempts?: number;
  readonly commandTimeoutMs?: number;
  readonly waitTimeoutMs?: number;
  readonly dryRun?: boolean;
  readonly deps?: WindowsCuaSweepDeps;
}): void {
  const deps = input.deps ?? defaultDeps;
  if (deps.platform !== "win32") return;
  if (!input.executablePath) {
    throw new Error("Could not resolve the packaged CUA driver executable for update preflight.");
  }
  const executablePath = deps.canonicalize(input.executablePath);
  const attempts = input.attempts ?? DEFAULT_ATTEMPTS;
  const commandTimeoutMs = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const waitTimeoutMs = input.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  if (attempts < 1 || commandTimeoutMs < 1 || waitTimeoutMs < 1) {
    throw new Error("Windows CUA process sweep received invalid timeout configuration.");
  }
  const powerShell = deps.resolvePowerShell();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = deps.spawnSync(
      powerShell.executablePath,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_CUA_SWEEP_SCRIPT,
      ],
      {
        cwd: powerShell.cwd,
        encoding: "utf8",
        env: {
          ...powerShell.env,
          [WINDOWS_CUA_SWEEP_TARGET_PATH_ENV]: executablePath,
          [WINDOWS_CUA_SWEEP_WAIT_TIMEOUT_ENV]: String(waitTimeoutMs),
          [WINDOWS_CUA_SWEEP_DRY_RUN_ENV]: input.dryRun ? "1" : "0",
        },
        maxBuffer: 64 * 1024,
        timeout: commandTimeoutMs,
        windowsHide: true,
      },
    );
    if (result.error) {
      const timedOut = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      throw new Error(
        timedOut
          ? "Windows CUA process sweep exceeded its command timeout."
          : "Windows CUA process sweep could not start PowerShell.",
      );
    }
    if (typeof result.stdout !== "string" || result.stderr?.trim()) {
      throw new Error("Windows CUA process sweep returned an unexpected command result.");
    }
    const output = parseSweepOutput(result.stdout);
    if (result.status !== 0 || output.status === "error") {
      const code = output.status === "error" ? output.code : "unexpected_status";
      const pid = output.status === "error" && output.pid !== undefined ? ` pid=${output.pid}` : "";
      throw new Error(
        `Windows CUA process sweep failed (${code})${pid}. Restart bigbud and try again; if this persists, run as administrator or install the update manually.`,
      );
    }
    if (output.matched === 0 && output.raced === 0) return;
  }
  throw new Error(
    "Windows CUA process sweep could not confirm that all exact-path matches exited.",
  );
}
