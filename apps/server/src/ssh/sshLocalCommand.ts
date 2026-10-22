/**
 * Runs local `ssh`, `ssh-add`, `ssh-agent` and `ssh-keygen` commands with a
 * hard deadline. The asynchronous runner never blocks the event loop and is
 * used by every unlock path; the synchronous runner remains only for the
 * synchronous readiness checks and is bounded by a short timeout.
 *
 * @module sshLocalCommand
 */
import { spawn, spawnSync } from "node:child_process";

import { killProcessTree } from "../utils/killProcessTree.ts";

/** Overall deadline for one unlock, covering every command it runs. */
export const SSH_UNLOCK_DEADLINE_MS = 20_000;
/** `ssh -o ConnectTimeout` for connections opened while unlocking. */
export const SSH_CONNECT_TIMEOUT_SECONDS = 10;
/** Bound for local probes (control socket checks, agent listings, key inspection). */
export const SSH_LOCAL_PROBE_TIMEOUT_MS = 5_000;
/** Overall deadline for one asynchronous readiness check (key probe plus agent probes). */
export const SSH_READINESS_DEADLINE_MS = 10_000;

const MAX_OUTPUT_BYTES = 1024 * 1024;
/** After the process exits, wait this long for buffered output before settling. */
const OUTPUT_DRAIN_GRACE_MS = 250;
const FORCE_KILL_DELAY_MS = 1_000;

export interface SshLocalCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
  readonly timedOut: boolean;
}

export interface SshLocalCommandOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly timeoutMs: number;
}

/** Tracks one overall deadline across several commands. */
export function createSshDeadline(totalMs: number = SSH_UNLOCK_DEADLINE_MS) {
  const endsAt = performance.now() + totalMs;
  return {
    totalMs,
    remainingMs: (capMs = Number.POSITIVE_INFINITY) =>
      Math.max(0, Math.min(capMs, endsAt - performance.now())),
  };
}

/**
 * Settles when the process exits (not when its pipes close, because `ssh -f`
 * daemonizes a master that may inherit them), on spawn failure, or at the
 * deadline, whichever is first. A command still running at the deadline is
 * killed and reported as `timedOut`.
 */
export function runSshLocalCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: SshLocalCommandOptions,
): Promise<SshLocalCommandResult> {
  if (options.timeoutMs <= 0) {
    return Promise.resolve({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error(`The SSH deadline was spent before ${command} could run.`),
      timedOut: true,
    });
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString("utf8");

    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.env ? { env: options.env } : {}),
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const settle = (result: Omit<SshLocalCommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
    child.once("error", (error) => settle({ status: null, error, timedOut: false }));
    child.once("exit", (status) => {
      const drain = setTimeout(() => settle({ status, timedOut: false }), OUTPUT_DRAIN_GRACE_MS);
      child.once("close", () => {
        clearTimeout(drain);
        settle({ status, timedOut: false });
      });
    });

    const deadlineTimer = setTimeout(() => {
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MS).unref();
      settle({
        status: null,
        error: new Error(
          `${command} did not finish within ${Math.ceil(options.timeoutMs / 1000)} s.`,
        ),
        timedOut: true,
      });
    }, options.timeoutMs);
  });
}

/** Synchronous variant for synchronous readiness checks; always bounded by `timeoutMs`. */
export function runSshLocalCommandSync(
  command: string,
  args: ReadonlyArray<string>,
  options: SshLocalCommandOptions,
): SshLocalCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.env ? { env: options.env } : {}),
    shell: process.platform === "win32",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
    timedOut,
  };
}

export type SshDeadline = ReturnType<typeof createSshDeadline>;

/** Throws a timeout error, rather than a misleading probe result, when a command hit its deadline. */
export function assertSshLocalCommandFinished(
  result: SshLocalCommandResult,
  activity: string,
): void {
  if (result.timedOut) {
    throw new Error(`Timed out ${activity}. ${result.error?.message ?? ""}`.trim());
  }
}

/** Best human-readable detail from a failed command. */
export function describeSshLocalCommandFailure(result: SshLocalCommandResult): string {
  if (result.error) return result.error.message;
  return (
    result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.status}.`
  );
}
