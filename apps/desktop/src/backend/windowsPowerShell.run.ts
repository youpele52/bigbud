import * as ChildProcess from "node:child_process";

import type { TrustedWindowsPowerShell } from "./windowsPowerShell";

/**
 * Budgets for one logical Windows PowerShell native-helper operation.
 *
 * Every invocation starts a fresh Windows PowerShell 5.1 process that compiles its C# helper
 * with `Add-Type` (csc.exe, temp files, antivirus scans). On loaded GitHub windows-2022 runners
 * a single cold invocation was measured at 15-58 seconds, so a 60 second per-command limit had
 * almost no headroom. The per-command limit leaves room for a cold compile, one timeout-only
 * retry absorbs transient load spikes (the retry usually runs warm), and the total budget keeps
 * the synchronous update preflight bounded.
 */
export interface WindowsHelperTimeouts {
  readonly commandTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly timeoutRetries: number;
  readonly retryBackoffMs: number;
}

export const DEFAULT_WINDOWS_HELPER_TIMEOUTS: WindowsHelperTimeouts = {
  commandTimeoutMs: 90_000,
  totalTimeoutMs: 180_000,
  timeoutRetries: 1,
  retryBackoffMs: 1_000,
};

export interface WindowsHelperClockDeps {
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => void;
  readonly warn: (message: string) => void;
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const defaultClockDeps: WindowsHelperClockDeps = {
  now: () => performance.now(),
  sleep: sleepSync,
  warn: (message) => console.warn(message),
};

export interface WindowsHelperRunner {
  /**
   * Runs the script in trusted PowerShell. Timeouts are retried within the budget and surface
   * as an error that includes elapsed time; any other spawn error is returned to the caller.
   */
  readonly run: (input: {
    readonly script: string;
    readonly env: Readonly<Record<string, string>>;
  }) => ChildProcess.SpawnSyncReturns<string>;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function resolveWindowsHelperTimeouts(
  label: string,
  overrides: Partial<WindowsHelperTimeouts>,
): WindowsHelperTimeouts {
  const defaults = DEFAULT_WINDOWS_HELPER_TIMEOUTS;
  const timeouts: WindowsHelperTimeouts = {
    commandTimeoutMs: overrides.commandTimeoutMs ?? defaults.commandTimeoutMs,
    totalTimeoutMs: overrides.totalTimeoutMs ?? defaults.totalTimeoutMs,
    timeoutRetries: overrides.timeoutRetries ?? defaults.timeoutRetries,
    retryBackoffMs: overrides.retryBackoffMs ?? defaults.retryBackoffMs,
  };
  if (
    !isNonNegativeSafeInteger(timeouts.commandTimeoutMs) ||
    !isNonNegativeSafeInteger(timeouts.totalTimeoutMs) ||
    !isNonNegativeSafeInteger(timeouts.timeoutRetries) ||
    !isNonNegativeSafeInteger(timeouts.retryBackoffMs) ||
    timeouts.commandTimeoutMs < 1 ||
    timeouts.totalTimeoutMs < 1
  ) {
    throw new Error(`${label} received invalid timeout configuration.`);
  }
  return timeouts;
}

function isTimeoutError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

/**
 * Creates a runner whose budget spans every invocation made through it, so callers that loop
 * (for example the CUA sweep verification passes) share one bounded total.
 */
export function createWindowsHelperRunner(input: {
  readonly label: string;
  readonly powerShell: TrustedWindowsPowerShell;
  readonly timeouts: WindowsHelperTimeouts;
  readonly spawnSync: typeof ChildProcess.spawnSync;
  readonly clock?: {
    readonly [Key in keyof WindowsHelperClockDeps]?: WindowsHelperClockDeps[Key] | undefined;
  };
}): WindowsHelperRunner {
  const { label, powerShell, timeouts, spawnSync } = input;
  // Resolve each dependency individually so an explicit `undefined` keeps the default.
  const clock: WindowsHelperClockDeps = {
    now: input.clock?.now ?? defaultClockDeps.now,
    sleep: input.clock?.sleep ?? defaultClockDeps.sleep,
    warn: input.clock?.warn ?? defaultClockDeps.warn,
  };
  const startedAt = clock.now();
  const elapsed = () => Math.max(0, Math.round(clock.now() - startedAt));
  let retriesRemaining = timeouts.timeoutRetries;
  let invocations = 0;

  const timeoutFailure = (detail: string) =>
    new Error(
      `${label} exceeded its command timeout after ${elapsed()}ms (${invocations} invocation(s); ${detail}; per-command limit ${timeouts.commandTimeoutMs}ms, total limit ${timeouts.totalTimeoutMs}ms).`,
    );

  const run: WindowsHelperRunner["run"] = ({ script, env }) => {
    for (;;) {
      const remaining = timeouts.totalTimeoutMs - elapsed();
      if (remaining < 1) throw timeoutFailure("total budget exhausted");
      const timeout = Math.min(timeouts.commandTimeoutMs, remaining);
      const invokedAt = clock.now();
      invocations += 1;
      const result = spawnSync(
        powerShell.executablePath,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          script,
        ],
        {
          cwd: powerShell.cwd,
          encoding: "utf8",
          env: { ...powerShell.env, ...env },
          maxBuffer: 64 * 1024,
          timeout,
          windowsHide: true,
        },
      );
      if (!result.error || !isTimeoutError(result.error)) return result;
      const invocationMs = Math.max(0, Math.round(clock.now() - invokedAt));
      if (retriesRemaining < 1) {
        throw timeoutFailure(`last invocation ran ${invocationMs}ms of its ${timeout}ms limit`);
      }
      if (timeouts.totalTimeoutMs - elapsed() - timeouts.retryBackoffMs < 1) {
        throw timeoutFailure("no budget left to retry");
      }
      retriesRemaining -= 1;
      clock.warn(
        `[windows-helper] ${label} timed out after ${invocationMs}ms (limit ${timeout}ms, ${elapsed()}ms elapsed); retrying in ${timeouts.retryBackoffMs}ms.`,
      );
      clock.sleep(timeouts.retryBackoffMs);
    }
  };
  return { run };
}
