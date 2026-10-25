import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../provider/codexCliVersion.ts";
import { buildSshCommandInvocation } from "../ssh/sshCommand.ts";
import {
  createSshDeadline,
  runSshLocalCommand,
  SSH_CONNECT_TIMEOUT_SECONDS,
} from "../ssh/sshLocalCommand.ts";
import {
  assertSshExecutionTargetReady,
  assertSshExecutionTargetReadyAsync,
} from "../ssh/sshVerification.ts";
import { recordEarlySpawnError } from "./codexAppServerManager.process.spawnError.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

const remoteVersionCheckCache = new Set<string>();
const SSH_VERSION_CHECK_TIMEOUT_MS = 8_000;
/** Overall deadline for the async check: readiness probes plus `codex --version` over SSH. */
const SSH_VERSION_CHECK_DEADLINE_MS = 20_000;
const VERSION_CHECK_TRANSPORT_ARGS = ["-o", `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`];

export interface SshInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export function buildRemoteCodexSshInvocation(
  input: CodexAppServerStartSessionInput,
  commandArgs: ReadonlyArray<string>,
  transportArgs?: ReadonlyArray<string>,
): SshInvocation {
  const remoteCwd = input.cwd?.trim();
  if (!remoteCwd) {
    throw new Error("Remote Codex sessions require a remote workspace path.");
  }

  return buildSshCommandInvocation({
    executionTargetId: input.providerRuntimeExecutionTargetId ?? input.executionTargetId,
    cwd: remoteCwd,
    command: input.binaryPath,
    args: commandArgs,
    ...(input.homePath ? { env: { CODEX_HOME: input.homePath } } : {}),
    ...(transportArgs ? { transportArgs } : {}),
  });
}

function readRemoteVersionCacheKey(input: CodexAppServerStartSessionInput): string {
  return [
    input.providerRuntimeExecutionTargetId ?? input.executionTargetId ?? "",
    input.binaryPath,
    input.homePath ?? "",
  ].join("::");
}

interface VersionCheckOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
  readonly timedOut?: boolean;
}

function acceptRemoteVersionCheck(cacheKey: string, result: VersionCheckOutcome): void {
  if (result.timedOut) {
    throw new Error("Remote Codex CLI version check timed out. Check the SSH connection.");
  }
  if (result.error) {
    const lower = result.error.message.toLowerCase();
    const message =
      lower.includes("enoent") || lower.includes("not found")
        ? "SSH client (ssh) is not installed or not executable."
        : `Failed to execute remote Codex CLI version check: ${result.error.message || String(result.error)}`;
    throw new Error(message);
  }

  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Remote Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${result.stdout}\n${result.stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }

  remoteVersionCheckCache.add(cacheKey);
}

/**
 * Synchronous check, no longer on the session start path (`startSession` awaits
 * `startCodexAppServerProcessAsync`); it can block the event loop for up to
 * `SSH_VERSION_CHECK_TIMEOUT_MS` plus the readiness probes.
 */
export function assertSupportedRemoteCodexCliVersion(input: CodexAppServerStartSessionInput): void {
  const cacheKey = readRemoteVersionCacheKey(input);
  if (remoteVersionCheckCache.has(cacheKey)) {
    return;
  }

  assertSshExecutionTargetReady(input.providerRuntimeExecutionTargetId ?? input.executionTargetId);
  const invocation = buildRemoteCodexSshInvocation(
    input,
    ["--version"],
    VERSION_CHECK_TRANSPORT_ARGS,
  );
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SSH_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  acceptRemoteVersionCheck(cacheKey, {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  });
}

/** Version check that never blocks the event loop, bounded by one overall deadline. */
export async function assertSupportedRemoteCodexCliVersionAsync(
  input: CodexAppServerStartSessionInput,
): Promise<void> {
  const cacheKey = readRemoteVersionCacheKey(input);
  if (remoteVersionCheckCache.has(cacheKey)) {
    return;
  }

  const deadline = createSshDeadline(SSH_VERSION_CHECK_DEADLINE_MS);
  await assertSshExecutionTargetReadyAsync(
    input.providerRuntimeExecutionTargetId ?? input.executionTargetId,
    deadline,
  );
  const invocation = buildRemoteCodexSshInvocation(
    input,
    ["--version"],
    VERSION_CHECK_TRANSPORT_ARGS,
  );
  const result = await runSshLocalCommand(invocation.command, invocation.args, {
    timeoutMs: deadline.remainingMs(),
  });
  acceptRemoteVersionCheck(cacheKey, result);
}

function spawnRemoteCodexAppServer(
  input: CodexAppServerStartSessionInput,
): ChildProcessWithoutNullStreams {
  const invocation = buildRemoteCodexSshInvocation(input, [
    "app-server",
    ...(input.configArgs ?? []),
  ]);
  return recordEarlySpawnError(
    spawn(invocation.command, invocation.args, {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    }),
  );
}

/** An abort during the version check means the app-server is never spawned. */
export async function startRemoteCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  signal?: AbortSignal,
): Promise<ChildProcessWithoutNullStreams> {
  await assertSupportedRemoteCodexCliVersionAsync(input);
  signal?.throwIfAborted();
  return spawnRemoteCodexAppServer(input);
}

export function startRemoteCodexAppServerProcess(
  input: CodexAppServerStartSessionInput,
): ChildProcessWithoutNullStreams {
  assertSupportedRemoteCodexCliVersion(input);
  return spawnRemoteCodexAppServer(input);
}
