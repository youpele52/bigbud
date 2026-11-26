import type { Readable, Writable } from "node:stream";

import { validateRemoteAgentRuntime, type RemoteAgentRuntime } from "./remoteAgentRuntime.ts";

/** An installed, pinned runtime selected by backend admission. Never a bootstrap recipe. */
export interface RemoteAgentInstalledProxyTarget {
  readonly executionTargetId: string;
  readonly runtime: RemoteAgentRuntime;
}

export interface RemoteAgentProxyPipes {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
}

export interface RemoteAgentProxyExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface RemoteAgentProxyClose {
  readonly mode: "graceful" | "terminate";
  readonly timeoutMs: number;
}

export interface RemoteAgentProxyLease {
  /** Raw binary, backpressured stdin/stdout; diagnostic stderr stays separate. */
  readonly pipes: RemoteAgentProxyPipes;
  /** Settles after the final readable bytes; reject on transport loss without an exit status. */
  readonly exit: Promise<RemoteAgentProxyExit>;
  /**
   * Graceful mode half-closes stdin and allows drain before escalating. Terminate requests
   * immediate stop. Resolve only with confirmed teardown of this lease, not on delivery of a
   * stop request, EOF, or loss of the owner connection. Never stop a shared session.
   */
  readonly close: (request: RemoteAgentProxyClose) => Promise<void>;
}

export interface RemoteAgentProxyOwner {
  /**
   * Recheck target/installation approval and open only the pinned proxy. Honor cancellation
   * through acquisition and take responsibility for any lease not returned to the caller.
   * No caller SSH command, flags, or environment; no supervisor preparation or launch.
   */
  readonly openAgentProxy: (
    target: RemoteAgentInstalledProxyTarget,
    signal?: AbortSignal,
  ) => Promise<RemoteAgentProxyLease>;
}

export interface RemoteAgentOwnedSshInput extends RemoteAgentInstalledProxyTarget {
  readonly owner: RemoteAgentProxyOwner;
  readonly maxFrameBytes?: number;
  /** Apply only to acquisition; a returned lease belongs to the connection. */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly binaryPath?: never;
}

export const REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS = 2_000;

function validateProxyTimeout(timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("Invalid remote agent proxy deadline.");
  }
}

export async function openOwnedRemoteAgentProxy<A>(
  input: RemoteAgentOwnedSshInput,
  attach: (lease: RemoteAgentProxyLease) => A,
): Promise<A> {
  let signal = input.signal;
  if (input.timeoutMs !== undefined) {
    validateProxyTimeout(input.timeoutMs);
    const timeout = AbortSignal.timeout(Math.ceil(input.timeoutMs));
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
  signal?.throwIfAborted();
  const lease = await input.owner.openAgentProxy(
    {
      executionTargetId: input.executionTargetId,
      runtime: validateRemoteAgentRuntime(input.runtime),
    },
    signal,
  );
  try {
    signal?.throwIfAborted();
    return attach(lease);
  } catch (error) {
    // Cancellation or a failed attach must not orphan a lease already returned by the owner.
    void lease.exit.catch(() => {});
    const unconfirmed = await trackOwnedRemoteAgentProxy(lease)(
      "terminate",
      REMOTE_AGENT_PROXY_CLOSE_TIMEOUT_MS,
    ).catch((cause: unknown) => ({ cause }));
    if (unconfirmed) throw failedAcquisitionCleanup(error, unconfirmed.cause);
    throw error;
  }
}

function failedAcquisitionCleanup(error: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([error, cleanup], "Remote agent proxy acquisition cleanup failed.", {
    cause: error,
  });
}

export function trackOwnedRemoteAgentProxy(lease: RemoteAgentProxyLease) {
  let close: Promise<void> | undefined;
  return (mode: RemoteAgentProxyClose["mode"], timeoutMs: number): Promise<void> => {
    validateProxyTimeout(timeoutMs);
    // Send a single close for this lease. A later caller can bound its own confirmation wait.
    close ??= Promise.resolve().then(() => lease.close({ mode, timeoutMs }));
    return waitForOwnedProxyClose(close, timeoutMs);
  };
}

async function waitForOwnedProxyClose(close: Promise<void>, timeoutMs: number): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("Remote agent proxy cleanup could not confirm lease teardown.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}
