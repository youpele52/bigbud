import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { killProcessTree } from "./killProcessTree.ts";

export interface ProcessRunOptions {
  shell?: boolean | undefined;
  signal?: AbortSignal | undefined;
  encoding?: BufferEncoding | undefined;
  /** Settle at the deadline even if the child's inherited pipes never close. */
  settleOnTimeout?: boolean | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdin?: string | undefined;
  allowNonZeroExit?: boolean | undefined;
  maxBufferBytes?: number | undefined;
  outputMode?: "error" | "truncate" | undefined;
  onStdoutChunk?: ((chunk: string) => void) | undefined;
}

export interface ProcessRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTruncated?: boolean | undefined;
  stderrTruncated?: boolean | undefined;
}

function commandLabel(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

function normalizeSpawnError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to run ${commandLabel(command, args)}.`);
  }

  const maybeCode = (error as NodeJS.ErrnoException).code;
  if (maybeCode === "ENOENT") {
    return new Error(`Command not found: ${command}`);
  }

  return new Error(`Failed to run ${commandLabel(command, args)}: ${error.message}`);
}

export function isWindowsCommandNotFound(code: number | null, stderr: string): boolean {
  if (process.platform !== "win32") return false;
  if (code === 9009) return true;
  return /is not recognized as an internal or external command/i.test(stderr);
}

function normalizeExitError(
  command: string,
  args: readonly string[],
  result: ProcessRunResult,
): Error {
  if (isWindowsCommandNotFound(result.code, result.stderr)) {
    return new Error(`Command not found: ${command}`);
  }

  const reason = result.timedOut
    ? "timed out"
    : `failed (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`;
  const stderr = result.stderr.trim();
  const detail = stderr.length > 0 ? ` ${stderr}` : "";
  return new Error(`${commandLabel(command, args)} ${reason}.${detail}`);
}

function normalizeStdinError(command: string, args: readonly string[], error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(`Failed to write stdin for ${commandLabel(command, args)}.`);
  }
  return new Error(`Failed to write stdin for ${commandLabel(command, args)}: ${error.message}`);
}

function normalizeBufferError(
  command: string,
  args: readonly string[],
  stream: "stdout" | "stderr",
  maxBufferBytes: number,
): Error {
  return new Error(
    `${commandLabel(command, args)} exceeded ${stream} buffer limit (${maxBufferBytes} bytes).`,
  );
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const outputMode = options.outputMode ?? "error";

  return new Promise<ProcessRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Process execution was cancelled."));
      return;
    }
    const startedAt = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: options.shell ?? process.platform === "win32",
    });
    const kill = (signal: NodeJS.Signals = "SIGTERM") => {
      if (options.shell === false) child.kill(signal);
      else killProcessTree(child, signal);
    };
    const stdoutDecoder = new StringDecoder(options.encoding ?? "utf8");
    const stderrDecoder = new StringDecoder(options.encoding ?? "utf8");

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(
      () => {
        timedOut = true;
        if (options.settleOnTimeout) {
          fail(new Error("Process execution timed out."));
          return;
        }
        kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          kill("SIGKILL");
        }, 1_000);
      },
      Math.max(0, timeoutMs - (performance.now() - startedAt)),
    );

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const fail = (error: Error): void => {
      if (settled) return;
      finalize(() => {
        reject(error);
      });
      kill("SIGTERM");
      if (options.settleOnTimeout || options.signal?.aborted) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    };
    const abort = () => fail(new Error("Process execution was cancelled."));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string): Error | null => {
      const chunkBuffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const text = (stream === "stdout" ? stdoutDecoder : stderrDecoder).write(chunkBuffer);
      const byteLength = chunkBuffer.length;
      if (stream === "stdout") {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunkBuffer, maxBufferBytes);
          stdout = appended.next;
          stdoutBytes = appended.nextBytes;
          stdoutTruncated = stdoutTruncated || appended.truncated;
          return null;
        }
        stdout += text;
        stdoutBytes += byteLength;
        if (stdoutBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stdout", maxBufferBytes);
        }
      } else {
        if (outputMode === "truncate") {
          const appended = appendChunkWithinLimit(stderr, stderrBytes, chunkBuffer, maxBufferBytes);
          stderr = appended.next;
          stderrBytes = appended.nextBytes;
          stderrTruncated = stderrTruncated || appended.truncated;
          return null;
        }
        stderr += text;
        stderrBytes += byteLength;
        if (stderrBytes > maxBufferBytes) {
          return normalizeBufferError(command, args, "stderr", maxBufferBytes);
        }
      }
      return null;
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const error = appendOutput("stdout", chunk);
      if (error) {
        fail(error);
        return;
      }
      try {
        options.onStdoutChunk?.(typeof chunk === "string" ? chunk : chunk.toString());
      } catch (cause) {
        fail(cause instanceof Error ? cause : new Error("Process output observer failed."));
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const error = appendOutput("stderr", chunk);
      if (error) {
        fail(error);
      }
    });

    child.once("error", (error) => {
      finalize(() => {
        reject(normalizeSpawnError(command, args, error));
      });
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      if (options.settleOnTimeout && performance.now() - startedAt >= timeoutMs) {
        fail(new Error("Process execution timed out."));
        return;
      }
      if (outputMode !== "truncate") {
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      const result: ProcessRunResult = {
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      };

      finalize(() => {
        if (!options.allowNonZeroExit && (timedOut || (code !== null && code !== 0))) {
          reject(normalizeExitError(command, args, result));
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      fail(normalizeStdinError(command, args, error));
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, (error) => {
        if (error) {
          fail(normalizeStdinError(command, args, error));
          return;
        }
        child.stdin.end();
      });
      return;
    }
    child.stdin.end();
  });
}
