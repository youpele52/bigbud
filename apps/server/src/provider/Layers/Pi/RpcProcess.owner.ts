import { posix } from "node:path";
import type { Readable, Writable } from "node:stream";

import type { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import type { ProviderRuntimeTarget } from "../../../provider-runtime/providerRuntimeTarget.ts";
import { parseSshExecutionTarget } from "../../../ssh/sshExecutionTarget.ts";
import type { WorkspaceTarget } from "../../../workspace-target/workspaceTarget.ts";
import {
  PI_VERSION_PROBE_MAX_BYTES,
  PI_VERSION_PROBE_TIMEOUT_MS,
  piVersionCapabilities,
} from "./RpcProcess.version.ts";

export const PI_OWNER_START_TIMEOUT_MS = 30_000;
export const PI_OWNER_CANCEL_TIMEOUT_MS = 2_000;
const MAX_OPERAND_BYTES = 4_096;

export interface PiOwnerRuntime {
  readonly provider: "pi";
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly executionTargetId: string;
  readonly binaryPath: string;
  readonly cwd?: string;
}

export interface PiOwnerStartRequest extends PiOwnerRuntime {
  readonly sessionFile?: string;
}

/** A selected owner port plus the exact fixture target it is authorized for. */
export interface SelectedPiRpcOwner {
  readonly targetId: string;
  readonly owner: PiRpcOwner;
}

/** The selected owner together with the provider session it may start for. */
export interface PiRpcOwnerBinding extends SelectedPiRpcOwner {
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
}

export type PiOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export interface PiOwnerSession {
  /** The owner must backpressure these pipes and keep diagnostics separate from RPC output. */
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles after final pipe data. Reject on transport loss without a verified exit. */
  readonly exit: Promise<PiOwnerExit>;
}

export interface PiOwnerStart {
  /** Pipe availability, not proof that Pi answered a readiness RPC. */
  readonly ready: Promise<PiOwnerSession>;
  /**
   * Cancel only this reservation/lease, even before ready. Resolve only if it cannot
   * start later and its transport is confirmed closed, not on cancel acknowledgement
   * or owner disconnect. This is not proof of remote process death or a Pi RPC abort.
   */
  readonly cancel: () => Promise<void>;
}

/** Private port for an already selected and authorized owner; not an authorization implementation. */
export interface PiRpcOwner {
  /**
   * Recheck the session/target/operands against the probe grant. Run only remote Pi
   * --version, 5 s and 4 KiB per stream, no stdin; fail on overflow or nonzero exit.
   */
  readonly probeProvider: (request: PiOwnerRuntime, signal: AbortSignal) => Promise<string>;
  /**
   * Recheck the session/target/operands against the start grant. Select only Pi
   * --mode rpc with optional --session file. Reserve before starting and return the exact
   * cancel handle synchronously, or throw without leaving any pending launch.
   */
  readonly startProvider: (request: PiOwnerStartRequest) => PiOwnerStart;
}

export interface OwnedPiRpcInput {
  readonly owner: PiRpcOwner;
  readonly threadId: ThreadId;
  readonly sessionEpoch: number;
  readonly providerRuntimeTarget: ProviderRuntimeTarget;
  readonly workspaceTarget: WorkspaceTarget;
  /** Resolved provider setting, not a program offered by Pi or a transport command. */
  readonly binaryPath: string;
  readonly sessionFile?: string;
  /**
   * The version already returned by this owner's typed probe for the same runtime. Supplying
   * it keeps one probe per launch on the product path; the start grant is rechecked regardless.
   */
  readonly probedVersion?: string;
  /** Cancels acquisition only; after handoff, use the returned lease's cancel. */
  readonly signal?: AbortSignal;
}

type OwnedPiRpcSession = PiOwnerSession &
  ReturnType<typeof piVersionCapabilities> & { readonly cancel: PiOwnerStart["cancel"] };

function validateOperand(value: string): void {
  if (!value.trim() || value.includes("\0") || Buffer.byteLength(value) > MAX_OPERAND_BYTES) {
    throw new Error("Invalid Pi SSH owner operand.");
  }
}

export function resolvePiOwnerRuntime(input: OwnedPiRpcInput): PiOwnerRuntime {
  const { providerRuntimeTarget, workspaceTarget, threadId, sessionEpoch, binaryPath } = input;
  const { cwd } = workspaceTarget;
  const { executionTargetId } = providerRuntimeTarget;
  validateOperand(executionTargetId);
  const target = parseSshExecutionTarget(executionTargetId);
  if (
    providerRuntimeTarget.location !== "remote" ||
    workspaceTarget.location !== "remote" ||
    workspaceTarget.executionTargetId !== executionTargetId ||
    !target ||
    target.transport === "agent"
  ) {
    throw new Error(
      "The Pi SSH owner requires a direct SSH runtime and workspace on the same target.",
    );
  }
  validateOperand(threadId);
  validateOperand(binaryPath);
  if (cwd !== undefined) validateOperand(cwd);
  if (input.sessionFile !== undefined) validateOperand(input.sessionFile);
  if (
    !Number.isSafeInteger(sessionEpoch) ||
    sessionEpoch < 0 ||
    binaryPath.startsWith("-") ||
    (cwd !== undefined && !posix.isAbsolute(cwd)) ||
    input.sessionFile?.startsWith("-")
  ) {
    throw new Error("Invalid Pi SSH owner operand.");
  }
  return {
    provider: "pi",
    threadId,
    sessionEpoch,
    executionTargetId,
    binaryPath,
    ...(cwd !== undefined ? { cwd } : {}),
  };
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

function failedStartCleanup(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "Pi SSH owner RPC start cleanup failed.", {
    cause: error,
  });
}

/**
 * Bounded typed probe: only `--version` through the owner port, five seconds, 4 KiB of stdout.
 * The owner enforces its own bound too; this one is the client-side deadline.
 */
export async function probePiOwnerVersion(
  owner: PiRpcOwner,
  runtime: PiOwnerRuntime,
  signal?: AbortSignal,
): Promise<string> {
  const version = await waitForOwner(
    (probeSignal) => owner.probeProvider(runtime, probeSignal),
    PI_VERSION_PROBE_TIMEOUT_MS,
    "Pi SSH owner version probe timed out.",
    signal,
  );
  if (Buffer.byteLength(version) > PI_VERSION_PROBE_MAX_BYTES) {
    throw new Error("Pi SSH owner version probe exceeded its output limit.");
  }
  return version;
}

/** Explicit owner-only launch seam. Does not select a graph or invoke the legacy launcher. */
export async function startOwnedPiRpcProcess(input: OwnedPiRpcInput): Promise<OwnedPiRpcSession> {
  const { owner, signal: acquisitionSignal, sessionFile } = input;
  acquisitionSignal?.throwIfAborted();
  const runtime = Object.freeze(resolvePiOwnerRuntime(input));
  const request = Object.freeze({
    ...runtime,
    ...(sessionFile !== undefined ? { sessionFile } : {}),
  });
  const version = await (input.probedVersion !== undefined
    ? Promise.resolve(input.probedVersion)
    : probePiOwnerVersion(owner, runtime, acquisitionSignal));
  if (Buffer.byteLength(version) > PI_VERSION_PROBE_MAX_BYTES) {
    throw new Error("Pi SSH owner version probe exceeded its output limit.");
  }
  const capabilities = piVersionCapabilities(version);
  acquisitionSignal?.throwIfAborted();
  const start = owner.startProvider(request);
  let closing: Promise<void> | undefined;
  const cancel = () =>
    (closing ??= waitForOwner(
      () => start.cancel(),
      PI_OWNER_CANCEL_TIMEOUT_MS,
      "Pi SSH owner could not confirm RPC transport teardown.",
    ));
  // Observe exit rejection even if readiness arrives after a cancelled or timed-out acquisition.
  const ready = start.ready.then((session) => {
    void session.exit.catch(() => undefined);
    return session;
  });
  void ready.catch(() => undefined);
  try {
    const session = await waitForOwner(
      () => ready,
      PI_OWNER_START_TIMEOUT_MS,
      "Pi SSH owner RPC start timed out.",
      acquisitionSignal,
    );
    acquisitionSignal?.throwIfAborted();
    const { stdin, stdout, stderr, exit } = session;
    return { stdin, stdout, stderr, exit, ...capabilities, cancel };
  } catch (error) {
    try {
      await cancel();
    } catch (cause) {
      throw failedStartCleanup(error, cause);
    }
    throw error;
  }
}
