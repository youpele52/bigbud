import { type ChildProcess as ChildProcessHandle, spawn, spawnSync } from "node:child_process";
import path from "node:path";

export interface ShellCommandRunOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  maxBufferBytes?: number | undefined;
}

export interface ShellCommandRunResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  shell: string;
}

const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

interface ShellCandidate {
  shell: string;
  args?: string[];
}

function defaultShellResolver(): string {
  if (process.platform === "win32") {
    return process.env.ComSpec ?? "cmd.exe";
  }
  return process.env.SHELL ?? "bash";
}

function normalizeShellCommand(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (process.platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function shellCandidateFromCommand(command: string | null): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = path.basename(command).toLowerCase();
  if (process.platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
  const requested = shellCandidateFromCommand(normalizeShellCommand(shellResolver()));

  if (process.platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand(process.env.ComSpec ?? null),
      shellCandidateFromCommand("powershell.exe"),
      shellCandidateFromCommand("cmd.exe"),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(process.env.SHELL)),
    shellCandidateFromCommand("/bin/zsh"),
    shellCandidateFromCommand("/bin/bash"),
    shellCandidateFromCommand("/bin/sh"),
    shellCandidateFromCommand("zsh"),
    shellCandidateFromCommand("bash"),
    shellCandidateFromCommand("sh"),
  ]);
}

function isRetryableShellSpawnError(error: { message: string; cause?: unknown }): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        queue.push(cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function buildShellArgs(candidate: ShellCandidate, command: string): string[] {
  if (process.platform === "win32") {
    const shellName = path.basename(candidate.shell).toLowerCase();
    if (shellName.includes("powershell") || shellName === "pwsh.exe" || shellName === "pwsh") {
      return [...(candidate.args ?? []), "-NoProfile", "-NonInteractive", "-Command", command];
    }
    return [...(candidate.args ?? []), "/d", "/s", "/c", command];
  }

  return [...(candidate.args ?? []), "-lc", command];
}

function killChild(child: ChildProcessHandle, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // fallback to direct kill
    }
  }
  child.kill(signal);
}

async function runShellCommandWithCandidate(
  candidate: ShellCandidate,
  command: string,
  options: ShellCommandRunOptions,
): Promise<ShellCommandRunResult> {
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return new Promise<ShellCommandRunResult>((resolve, reject) => {
    const child = spawn(candidate.shell, buildShellArgs(candidate, command), {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      shell: false,
    });

    let output = "";
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        killChild(child, "SIGKILL");
      }, 1_000);
    }, timeoutMs);

    const finalize = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      callback();
    };

    const appendOutput = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      outputBytes += buffer.length;
      if (outputBytes > maxBufferBytes) {
        killChild(child, "SIGTERM");
        finalize(() => {
          reject(
            new Error(
              `${formatShellCandidate(candidate)} exceeded output buffer limit (${maxBufferBytes} bytes).`,
            ),
          );
        });
        return;
      }
      output += buffer.toString();
    };

    child.stdout.on("data", appendOutput);
    child.stderr.on("data", appendOutput);

    child.once("error", (error) => {
      finalize(() => reject(error));
    });

    child.once("close", (code, signal) => {
      finalize(() => {
        resolve({
          output,
          code,
          signal,
          timedOut,
          shell: formatShellCandidate(candidate),
        });
      });
    });
  });
}

export async function runShellCommand(
  command: string,
  options: ShellCommandRunOptions = {},
): Promise<ShellCommandRunResult> {
  const candidates = resolveShellCandidates(defaultShellResolver);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await runShellCommandWithCandidate(candidate, command, options);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && isRetryableShellSpawnError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Unable to resolve a shell command runner.");
}
