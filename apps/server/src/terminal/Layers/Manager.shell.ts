import path from "node:path";

import { Data, Effect, Encoding } from "effect";

import { runProcess } from "../../utils/processRunner";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class TerminalSubprocessCheckError extends Data.TaggedError("TerminalSubprocessCheckError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly terminalPid: number;
  readonly command: "powershell" | "pgrep" | "ps";
}> {}

export class TerminalProcessSignalError extends Data.TaggedError("TerminalProcessSignalError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly signal: "SIGTERM" | "SIGKILL";
}> {}

// ---------------------------------------------------------------------------
// Subprocess checker type
// ---------------------------------------------------------------------------

export type TerminalSubprocessChecker = (
  terminalPid: number,
) => Effect.Effect<boolean, TerminalSubprocessCheckError>;

// ---------------------------------------------------------------------------
// Shell candidate types
// ---------------------------------------------------------------------------

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

// ---------------------------------------------------------------------------
// Shell resolution
// ---------------------------------------------------------------------------

export function defaultShellResolver(): string {
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

export function formatShellCandidate(candidate: ShellCandidate): string {
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

export function resolveShellCandidates(shellResolver: () => string): ShellCandidate[] {
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

// ---------------------------------------------------------------------------
// Retryable spawn error detection
// ---------------------------------------------------------------------------

export function isRetryableShellSpawnError(error: { message: string; cause?: unknown }): boolean {
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

// ---------------------------------------------------------------------------
// Subprocess activity checks
// ---------------------------------------------------------------------------

function checkWindowsSubprocessActivity(
  terminalPid: number,
): Effect.Effect<boolean, TerminalSubprocessCheckError> {
  const command = [
    `$children = Get-CimInstance Win32_Process -Filter "ParentProcessId = ${terminalPid}" -ErrorAction SilentlyContinue`,
    "if ($children) { exit 0 }",
    "exit 1",
  ].join("; ");
  return Effect.tryPromise({
    try: () =>
      runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
        timeoutMs: 1_500,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to check Windows terminal subprocess activity.",
        cause,
        terminalPid,
        command: "powershell",
      }),
  }).pipe(Effect.map((result) => result.code === 0));
}

const checkPosixSubprocessActivity = Effect.fn("terminal.checkPosixSubprocessActivity")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  const runPgrep = Effect.tryPromise({
    try: () =>
      runProcess("pgrep", ["-P", String(terminalPid)], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 32_768,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with pgrep.",
        cause,
        terminalPid,
        command: "pgrep",
      }),
  });

  const runPs = Effect.tryPromise({
    try: () =>
      runProcess("ps", ["-eo", "pid=,ppid="], {
        timeoutMs: 1_000,
        allowNonZeroExit: true,
        maxBufferBytes: 262_144,
        outputMode: "truncate",
      }),
    catch: (cause) =>
      new TerminalSubprocessCheckError({
        message: "Failed to inspect terminal subprocesses with ps.",
        cause,
        terminalPid,
        command: "ps",
      }),
  });

  const pgrepResult = yield* Effect.exit(runPgrep);
  if (pgrepResult._tag === "Success") {
    if (pgrepResult.value.code === 0) {
      return pgrepResult.value.stdout.trim().length > 0;
    }
    if (pgrepResult.value.code === 1) {
      return false;
    }
  }

  const psResult = yield* Effect.exit(runPs);
  if (psResult._tag === "Failure" || psResult.value.code !== 0) {
    return false;
  }

  for (const line of psResult.value.stdout.split(/\r?\n/g)) {
    const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
    const pid = Number(pidRaw);
    const ppid = Number(ppidRaw);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (ppid === terminalPid) {
      return true;
    }
  }
  return false;
});

export const defaultSubprocessChecker = Effect.fn("terminal.defaultSubprocessChecker")(function* (
  terminalPid: number,
): Effect.fn.Return<boolean, TerminalSubprocessCheckError> {
  if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
    return false;
  }
  if (process.platform === "win32") {
    return yield* checkWindowsSubprocessActivity(terminalPid);
  }
  return yield* checkPosixSubprocessActivity(terminalPid);
});

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

export function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("BIGBUD_")) {
    return true;
  }
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return spawnEnv;
}

export function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

// ---------------------------------------------------------------------------
// Session key / path helpers
// ---------------------------------------------------------------------------

export function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toSafeThreadId(threadId: string): string {
  return `terminal_${Encoding.encodeBase64Url(threadId)}`;
}

export function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

export function toSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}
