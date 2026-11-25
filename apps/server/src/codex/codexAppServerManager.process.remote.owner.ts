import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";

import { LOCAL_EXECUTION_TARGET_ID, type ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { resolveProviderExecutionContext } from "../provider/providerExecutionContext.ts";
import { parseSshExecutionTarget } from "../ssh/sshExecutionTarget.ts";
import type { CodexAppServerStartSessionInput } from "./codexAppServerManager.types.ts";
import { supportsCodexDefaultModeUserInput } from "./codexQuestionTool.ts";

export const REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS = 20_000;
export const REMOTE_CODEX_PROBE_MAX_BYTES = 1024 * 1024;
export const CODEX_OWNER_START_TIMEOUT_MS = 20_000;
export const CODEX_OWNER_CANCEL_TIMEOUT_MS = 2_000;
const MAX_OPERAND_BYTES = 4_096;

/** Backend-resolved operands. The owner must match them to the selected session grant. */
export interface CodexOwnerRuntime {
  readonly provider: "codex";
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly binaryPath: string;
  readonly homePath?: string;
}

export interface CodexOwnerStartRequest extends CodexOwnerRuntime {
  readonly enableDefaultModeUserInput: boolean;
}

export interface CodexOwnerProbeOutcome {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexOwnerSession {
  /** Separate backpressured JSON-RPC pipes and diagnostic stderr. */
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles after final pipe data. Reject on transport loss without verified exit. */
  readonly exit: Promise<
    | { readonly kind: "exited"; readonly code: number }
    | { readonly kind: "signaled"; readonly signal: string }
  >;
}

export interface CodexOwnerStart {
  /** Means the pipes are available, not that the app-server has initialized. */
  readonly ready: Promise<CodexOwnerSession>;
  /**
   * Cancel this exact reservation or lease, even before ready. Resolve only after
   * confirmed transport teardown and no possible late start, not on ack or disconnect.
   * This does not prove the remote process died.
   */
  readonly cancel: () => Promise<void>;
}

/** Private port for the selected owner, not a grant issuer or a wire implementation. */
export interface CodexSshOwner {
  /** Recheck the grant, run only Codex --version, no stdin, 20 s including readiness, 1 MiB per stream. */
  readonly probeProvider: (
    request: CodexOwnerRuntime,
    signal: AbortSignal,
  ) => Promise<CodexOwnerProbeOutcome>;
  /**
   * Recheck the start grant and the version-conditioned feature against the probe.
   * Run only the fixed app-server recipe. Reserve before dispatch and return the
   * exact cancel handle synchronously, or throw without leaving a pending start.
   */
  readonly startProvider: (request: CodexOwnerStartRequest) => CodexOwnerStart;
}

export interface CodexOwnerSelection {
  /** An unavailable selected owner is not permission to launch legacy SSH. */
  readonly owner: CodexSshOwner | undefined;
}

export interface OwnedCodexAppServer extends CodexOwnerSession {
  readonly version: string | undefined;
  /** After acquisition the caller owns cancellation of this exact lease. */
  readonly cancel: CodexOwnerStart["cancel"];
}

function validOperand(value: string): boolean {
  return (
    Boolean(value.trim()) && !value.includes("\0") && Buffer.byteLength(value) <= MAX_OPERAND_BYTES
  );
}

export function resolveCodexOwnerRuntime(
  input: CodexAppServerStartSessionInput,
): CodexOwnerRuntime {
  const { providerRuntimeTarget, workspaceTarget } = resolveProviderExecutionContext({
    providerRuntimeExecutionTargetId: input.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: input.workspaceExecutionTargetId,
    executionTargetId: input.executionTargetId,
    cwd: input.cwd,
    defaultProviderRuntimeExecutionTargetId: LOCAL_EXECUTION_TARGET_ID,
  });
  const { executionTargetId } = providerRuntimeTarget;
  const target = parseSshExecutionTarget(executionTargetId);
  if (
    providerRuntimeTarget.location !== "remote" ||
    workspaceTarget.location !== "remote" ||
    workspaceTarget.executionTargetId !== executionTargetId ||
    !target ||
    target.transport === "agent"
  ) {
    throw new Error(
      "The Codex SSH owner requires a direct SSH runtime and workspace on the same target.",
    );
  }
  const cwd = workspaceTarget.cwd?.trim();
  const { threadId, binaryPath, homePath } = input;
  const sessionEpoch = input.sessionEpoch ?? 0;
  if (
    !cwd ||
    !posix.isAbsolute(cwd) ||
    !validOperand(cwd) ||
    !validOperand(executionTargetId) ||
    !validOperand(threadId) ||
    !validOperand(binaryPath) ||
    binaryPath.trimStart().startsWith("-") ||
    (homePath !== undefined && !validOperand(homePath)) ||
    !Number.isSafeInteger(sessionEpoch) ||
    sessionEpoch < 0
  ) {
    throw new Error("Invalid Codex SSH owner operand.");
  }
  return Object.freeze({
    provider: "codex",
    threadId,
    sessionEpoch,
    executionTargetId,
    cwd,
    binaryPath,
    ...(homePath !== undefined ? { homePath } : {}),
  });
}

export function requireCodexSshOwner(selection: CodexOwnerSelection): CodexSshOwner {
  if (!selection.owner) throw new Error("The selected Codex SSH owner is unavailable.");
  return selection.owner;
}

async function waitForOwner<A>(
  operation: (signal: AbortSignal) => Promise<A>,
  timeoutMs: number,
  timeoutMessage: string,
  parent?: AbortSignal,
): Promise<A> {
  const deadline = new AbortController();
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => deadline.abort(new Error(timeoutMessage)), timeoutMs);
  try {
    const result = await Promise.race([
      aborted.promise,
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
    ]);
    signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function probeOwnedCodexVersion(
  owner: CodexSshOwner,
  runtime: CodexOwnerRuntime,
  signal?: AbortSignal,
): Promise<CodexOwnerProbeOutcome> {
  const result = await waitForOwner(
    (probeSignal) => owner.probeProvider(runtime, probeSignal),
    REMOTE_CODEX_ASYNC_PROBE_TIMEOUT_MS,
    "Remote Codex CLI version check timed out. Check the SSH connection.",
    signal,
  );
  if (
    Buffer.byteLength(result.stdout) > REMOTE_CODEX_PROBE_MAX_BYTES ||
    Buffer.byteLength(result.stderr) > REMOTE_CODEX_PROBE_MAX_BYTES
  ) {
    throw new Error("Remote Codex CLI version check exceeded its output limit.");
  }
  return result;
}

function failedStartCleanup(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "Codex SSH owner app-server start cleanup failed.", {
    cause: error,
  });
}

export async function acquireOwnedCodexAppServer(
  owner: CodexSshOwner,
  runtime: CodexOwnerRuntime,
  version: string | undefined,
  signal?: AbortSignal,
): Promise<OwnedCodexAppServer> {
  signal?.throwIfAborted();
  const start = owner.startProvider(
    Object.freeze({
      ...runtime,
      enableDefaultModeUserInput: supportsCodexDefaultModeUserInput(version),
    }),
  );
  let closing: Promise<void> | undefined;
  const cancel = () =>
    (closing ??= waitForOwner(
      () => start.cancel(),
      CODEX_OWNER_CANCEL_TIMEOUT_MS,
      "Codex SSH owner could not confirm app-server transport teardown.",
    ));
  const ready = start.ready.then((session) => {
    // A late lease can report transport loss even if no caller accepted its pipes.
    void session.exit.catch(() => undefined);
    return session;
  });
  void ready.catch(() => undefined);
  try {
    const { stdin, stdout, stderr, exit } = await waitForOwner(
      () => ready,
      CODEX_OWNER_START_TIMEOUT_MS,
      "Codex SSH owner timed out waiting for app-server pipes.",
      signal,
    );
    signal?.throwIfAborted();
    return { stdin, stdout, stderr, exit, version, cancel };
  } catch (error) {
    try {
      await cancel();
    } catch (cleanup) {
      throw failedStartCleanup(error, cleanup);
    }
    throw error;
  }
}
