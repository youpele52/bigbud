import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
import { assertLegacySshLaunchAllowed } from "../ssh/sshOwnerDevMode.ts";
import { assertSshExecutionTargetReadyAsync } from "../ssh/sshVerification.ts";
import {
  acquireOwnedCodexAppServer,
  probeOwnedCodexVersion,
  REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS,
  requireCodexSshOwner,
  resolveCodexOwnerRuntime,
  type CodexOwnerSelection,
  type OwnedCodexAppServer,
} from "./codexAppServerManager.process.remote.owner.ts";
import { recordEarlySpawnError } from "./codexAppServerManager.process.spawnError.ts";
import { bindCodexProcessVersion } from "./codexAppServerManager.process.version.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";
import { codexQuestionToolConfigArgs } from "./codexQuestionTool.ts";

/**
 * Remote app-server launches are always asynchronous. There is no synchronous SSH or version
 * probe on this path: it cannot be bounded without blocking the event loop, and the selected
 * owner only exposes an asynchronous typed probe.
 */
export const REMOTE_CODEX_SYNC_LAUNCH_REFUSED =
  "Remote Codex app-server requires the asynchronous launcher.";

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

interface VersionCheckOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error | undefined;
  readonly timedOut?: boolean;
}

function acceptRemoteVersionCheck(result: VersionCheckOutcome): string | undefined {
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

  return parsedVersion ?? undefined;
}

/**
 * Version check that never blocks the event loop, bounded by one overall deadline. The selected
 * owner path runs only its typed `probeProvider` port.
 */
export async function assertSupportedRemoteCodexCliVersionAsync(
  input: CodexAppServerStartSessionInput,
  selection?: CodexOwnerSelection,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (selection !== undefined) {
    signal?.throwIfAborted();
    const owner = requireCodexSshOwner(selection);
    return acceptRemoteVersionCheck(
      await probeOwnedCodexVersion(owner, resolveCodexOwnerRuntime(input), signal),
    );
  }
  assertLegacySshLaunchAllowed();
  const deadline = createSshDeadline(REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS);
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
  return acceptRemoteVersionCheck(result);
}

function spawnRemoteCodexAppServer(
  input: CodexAppServerStartSessionInput,
  version: string | undefined,
): ChildProcessWithoutNullStreams {
  const invocation = buildRemoteCodexSshInvocation(input, [
    "app-server",
    ...(input.configArgs ?? []),
    ...codexQuestionToolConfigArgs(version),
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
export function startRemoteCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  signal?: AbortSignal,
): Promise<ChildProcessWithoutNullStreams>;
/** Owner-selected callers receive a lease, never a synthetic local child or PID. */
export function startRemoteCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  signal: AbortSignal | undefined,
  selection: CodexOwnerSelection,
): Promise<OwnedCodexAppServer>;
export async function startRemoteCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  signal?: AbortSignal,
  selection?: CodexOwnerSelection,
): Promise<ChildProcessWithoutNullStreams | OwnedCodexAppServer> {
  if (selection !== undefined) {
    signal?.throwIfAborted();
    const owner = requireCodexSshOwner(selection);
    // Never silently omit overrides or smuggle backend-built argv into the owner recipe.
    if (input.configArgs?.length) {
      throw new Error("Codex SSH owner app-server config requires a typed launch recipe.");
    }
    const runtime = resolveCodexOwnerRuntime(input);
    const version = acceptRemoteVersionCheck(await probeOwnedCodexVersion(owner, runtime, signal));
    // Keep one snapshot of the scope across probe and launch.
    return acquireOwnedCodexAppServer(owner, runtime, version, signal);
  }
  const version = await assertSupportedRemoteCodexCliVersionAsync(input);
  signal?.throwIfAborted();
  return bindCodexProcessVersion(spawnRemoteCodexAppServer(input, version), version);
}

export function startRemoteCodexAppServerProcess(
  input: CodexAppServerStartSessionInput,
  selection?: CodexOwnerSelection,
): ChildProcessWithoutNullStreams {
  void input;
  void selection;
  throw new Error(REMOTE_CODEX_SYNC_LAUNCH_REFUSED);
}
