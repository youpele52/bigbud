import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../provider/codexCliVersion.ts";
import {
  acquireOwnedCodexAppServer,
  probeOwnedCodexVersion,
  requireCodexSshOwner,
  resolveCodexOwnerRuntime,
  type CodexOwnerSelection,
  type OwnedCodexAppServer,
} from "./codexAppServerManager.process.remote.owner.ts";
import {
  OwnedCodexAppServerProcess,
  type CodexAppServerProcess,
} from "./codexAppServerManager.processHandle.ts";
import { bindCodexProcessVersion } from "./codexAppServerManager.process.version.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";

/**
 * Remote app-server launches are always asynchronous. There is no synchronous SSH or version
 * probe on this path: it cannot be bounded without blocking the event loop, and the selected
 * owner only exposes an asynchronous typed probe.
 */
export const REMOTE_CODEX_SYNC_LAUNCH_REFUSED =
  "Remote Codex app-server requires the asynchronous launcher.";

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
 * Version check that never blocks the event loop. It runs only through the owner's typed
 * `probeProvider` port; there is no TypeScript SSH probe.
 */
export async function assertSupportedRemoteCodexCliVersionAsync(
  input: CodexAppServerStartSessionInput,
  selection: CodexOwnerSelection,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const owner = requireCodexSshOwner(selection);
  return acceptRemoteVersionCheck(
    await probeOwnedCodexVersion(owner, resolveCodexOwnerRuntime(input), signal),
  );
}

/**
 * An abort during the version check means the app-server is never spawned. The session runs
 * through the production owner as an owner lease process; there is no TypeScript SSH launch.
 */
export function startRemoteCodexAppServerProcessAsync(
  input: CodexAppServerStartSessionInput,
  signal?: AbortSignal,
): Promise<CodexAppServerProcess>;
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
): Promise<CodexAppServerProcess | OwnedCodexAppServer> {
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
  const { resolveProductionCodexOwnerSelection } =
    await import("./codexAppServerManager.process.remote.production.ts");
  const runtime = resolveCodexOwnerRuntime(input);
  const production = await resolveProductionCodexOwnerSelection(runtime.executionTargetId);
  const lease = await startRemoteCodexAppServerProcessAsync(input, signal, production);
  return bindCodexProcessVersion(new OwnedCodexAppServerProcess(lease), lease.version);
}

export function startRemoteCodexAppServerProcess(
  input: CodexAppServerStartSessionInput,
  selection?: CodexOwnerSelection,
): ChildProcessWithoutNullStreams {
  void input;
  void selection;
  throw new Error(REMOTE_CODEX_SYNC_LAUNCH_REFUSED);
}
