import { posix } from "node:path";

import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { ProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { parseSshExecutionTarget } from "../../../ssh/sshExecutionTarget.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import { runWithAbortableDeadline } from "../../RequestDeadline.ts";
import type { RunningManagedServer } from "./ServerManager.ts";

export const OPENCODE_OWNER_START_TIMEOUT_MS = 8_000;
export const OPENCODE_OWNER_CANCEL_TIMEOUT_MS = 2_000;
export const OPENCODE_OWNER_START_OUTPUT_MAX_BYTES = 16_384;
const MAX_OPERAND_BYTES = 4_096;

export interface OpencodeOwnerStartRequest {
  readonly provider: "opencode";
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly executionTargetId: string;
  readonly cwd: string;
  readonly binaryPath: string;
}

export interface OpencodeOwnerLease {
  readonly ownerEpoch: string;
  /** Opaque native generation token, encoded as hex. */
  readonly targetGeneration: string;
  readonly leaseId: string;
}

export type OpencodeOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export interface OpencodeOwnerStart {
  readonly lease: OpencodeOwnerLease;
  /** Ready only after the leased v1 server and its listener are both usable. */
  readonly ready: Promise<{ readonly localPort: number }>;
  /** Ends when this server/tunnel is lost; reject on owner/transport loss without verified exit. */
  readonly exit: Promise<OpencodeOwnerExit>;
  /**
   * Cancel only this reservation/lease, including before readiness. Resolve only once its
   * listener and transport are confirmed closed and it cannot start later. Neither dispatch
   * acknowledgement nor disconnect alone qualifies, and this does not prove remote process death.
   */
  readonly cancel: () => Promise<void>;
}

/** Private port for a selected owner; this interface does not issue grants or define a wire verb. */
export interface OpencodeSshOwner {
  /**
   * Recheck the grant against all operands and reserve before starting (or throw without
   * dispatch). Run only v1 `serve` on remote IPv4 loopback with an owner-selected
   * loopback-to-loopback forward, no stdin or caller-supplied SSH options/config.
   * Enforce OPENCODE_OWNER_START_TIMEOUT_MS and OPENCODE_OWNER_START_OUTPUT_MAX_BYTES
   * (stdout + stderr), and drain later output without retaining it. Emit typed readiness
   * rather than forwarding logs or a URL from remote output.
   */
  readonly startProvider: (request: OpencodeOwnerStartRequest) => OpencodeOwnerStart;
}

export interface OwnedOpencodeServerInput {
  /** An unavailable selected owner is not permission to invoke the legacy launcher. */
  readonly owner: OpencodeSshOwner | undefined;
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly providerRuntimeTarget: ProviderRuntimeTarget;
  readonly workspaceTarget: WorkspaceTarget;
  /** Resolved provider setting, not a command offered by OpenCode. */
  readonly binaryPath: string;
  /** Cancels acquisition only; after handoff use close() on the exact lease. */
  readonly signal?: AbortSignal;
}

export interface OwnedOpencodeServer extends RunningManagedServer {
  readonly lease: OpencodeOwnerLease;
  readonly exit: Promise<OpencodeOwnerExit>;
  readonly client: ReturnType<typeof createOpencodeClient>;
  readonly close: () => Promise<void>;
}

function validOperand(value: string): boolean {
  return (
    Boolean(value.trim()) && !value.includes("\0") && Buffer.byteLength(value) <= MAX_OPERAND_BYTES
  );
}

function resolveRequest(input: OwnedOpencodeServerInput): OpencodeOwnerStartRequest {
  const { providerRuntimeTarget, workspaceTarget, threadId, sessionEpoch, binaryPath } = input;
  const { cwd } = workspaceTarget;
  const { executionTargetId } = providerRuntimeTarget;
  if (!validOperand(executionTargetId)) throw new Error("Invalid OpenCode SSH owner target.");
  const target = parseSshExecutionTarget(executionTargetId);
  if (
    providerRuntimeTarget.location !== "remote" ||
    workspaceTarget.location !== "remote" ||
    workspaceTarget.executionTargetId !== executionTargetId ||
    !target ||
    target.transport === "agent"
  ) {
    throw new Error(
      "The OpenCode SSH owner requires a direct SSH runtime and workspace on the same target.",
    );
  }
  if (
    !cwd ||
    !validOperand(cwd) ||
    !posix.isAbsolute(cwd) ||
    !validOperand(threadId) ||
    !validOperand(binaryPath) ||
    binaryPath.trimStart().startsWith("-") ||
    !Number.isSafeInteger(sessionEpoch) ||
    sessionEpoch < 0
  ) {
    throw new Error("Invalid OpenCode SSH owner operand.");
  }
  return Object.freeze({
    provider: "opencode",
    threadId,
    sessionEpoch,
    executionTargetId,
    cwd,
    binaryPath,
  });
}

function failedStartCleanup(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "OpenCode SSH owner start cleanup failed.", {
    cause: error,
  });
}

/** Isolated, per-grant launcher. Do not cache or share the SDK client across session grants. */
export async function startOwnedOpencodeServer(
  input: OwnedOpencodeServerInput,
): Promise<OwnedOpencodeServer> {
  const { owner, signal } = input;
  signal?.throwIfAborted();
  if (!owner) throw new Error("The selected OpenCode SSH owner is unavailable.");
  const request = resolveRequest(input);
  const start = owner.startProvider(request);
  const lifetime = new AbortController();
  const listeners = new Set<() => void>();
  let closing: Promise<void> | undefined;
  let lost = false;
  const close = () => {
    if (closing) return closing;
    listeners.clear();
    closing = runWithAbortableDeadline({
      operation: "OpenCode SSH owner tunnel teardown confirmation",
      timeoutMs: OPENCODE_OWNER_CANCEL_TIMEOUT_MS,
      run: () => start.cancel(),
    });
    lifetime.abort();
    return closing;
  };
  const onLoss = () => {
    lost = true;
    lifetime.abort();
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const ended = start.exit.then(
    () => {
      onLoss();
      throw new Error("OpenCode SSH owner server or tunnel ended before readiness.");
    },
    (error: unknown) => {
      onLoss();
      throw error;
    },
  );
  // Set up the race immediately, even when cancellation prevents the deadline body from running.
  const readiness = Promise.race([start.ready, ended]);
  void readiness.catch(() => undefined);
  try {
    const { localPort } = await runWithAbortableDeadline({
      operation: "OpenCode SSH owner readiness",
      timeoutMs: OPENCODE_OWNER_START_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      run: () => readiness,
    });
    signal?.throwIfAborted();
    if (lost) throw new Error("OpenCode SSH owner server or tunnel ended before readiness.");
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
      throw new Error("Invalid OpenCode SSH owner listener port.");
    }
    const url = `http://127.0.0.1:${localPort}`;
    const client = createOpencodeClient({
      baseUrl: url,
      directory: request.cwd,
      fetch: Object.assign(
        (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          lifetime.signal.throwIfAborted();
          const destination = new URL(request instanceof Request ? request.url : String(request));
          if (destination.origin !== url || destination.username || destination.password) {
            throw new Error("OpenCode SSH owner request escaped its listener.");
          }
          const requestSignal =
            init?.signal ?? (request instanceof Request ? request.signal : undefined);
          return fetch(request, {
            ...init,
            redirect: "error",
            signal: requestSignal
              ? AbortSignal.any([lifetime.signal, requestSignal])
              : lifetime.signal,
          });
        },
        // The SDK does not use Bun's speculative connection API.
        { preconnect: () => {} },
      ),
    });
    return {
      lease: start.lease,
      exit: start.exit,
      url,
      client,
      isRunning: () => !lifetime.signal.aborted,
      onUnexpectedDeath: (listener) => {
        if (closing) return () => undefined;
        if (lost) {
          listener();
          return () => undefined;
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw failedStartCleanup(error, cleanup);
    }
    throw error;
  }
}
