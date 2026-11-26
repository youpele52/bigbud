import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";

import type { OwnerGitStreamLease } from "./GitCore.selectedStream.ts";

/**
 * One owner-created Unix-socket lease (U15 Git upload or receive) exposed as the stream lease
 * `bridgeOwnerGitLease` hands to local Git. The owner chooses the socket; this process only
 * dials it once and polls the lease's status.
 *
 * @module GitCore.ownerSocketLease
 */

const STATUS_POLL_MS = 100;
const CLOSE_TIMEOUT_MS = 2_000;

type LeaseState = { readonly phase: string } & { readonly socketPath?: string };

export interface OwnerSocketLeaseVerbs<S extends LeaseState> {
  readonly open: () => Promise<S>;
  readonly status: () => Promise<S>;
  readonly close: () => Promise<unknown>;
}

/** Poll until the lease leaves listening/streaming; an error or the deadline resolves too. */
export function waitLeaseSettled<S extends LeaseState>(
  status: () => Promise<S>,
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<S | "timedOut" | { readonly error: unknown }> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () =>
      status().then(
        (state) => {
          if (state.phase !== "listening" && state.phase !== "streaming") resolve(state);
          else if (Date.now() >= deadline) resolve("timedOut");
          else setTimeout(poll, STATUS_POLL_MS);
        },
        (error: unknown) => resolve({ error }),
      );
    poll();
  });
}

export async function openOwnerSocketLease<S extends LeaseState>(
  verbs: OwnerSocketLeaseVerbs<S>,
  label: string,
  signal: AbortSignal,
): Promise<OwnerGitStreamLease> {
  signal.throwIfAborted();
  const state = await verbs.open();
  if (state.phase !== "listening" || state.socketPath === undefined) {
    await verbs.close().catch(() => undefined);
    throw new Error(`The owner Git ${label} lease did not listen (${state.phase}).`);
  }
  const socketPath = state.socketPath;
  const socket: Socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = connect({ path: socketPath, allowHalfOpen: true });
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", reject);
  }).catch(async (cause: unknown) => {
    await verbs.close().catch(() => undefined);
    throw cause;
  });
  const stderr = new PassThrough();
  stderr.end();
  let exit: Promise<unknown> | undefined;
  return {
    pipes: { stdin: socket, stdout: socket, stderr },
    get exit() {
      exit ??= waitLeaseSettled(verbs.status);
      return exit;
    },
    async close({ mode, timeoutMs }) {
      if (mode === "terminate") socket.destroy();
      else socket.end();
      const closing = verbs.close().catch(() => undefined);
      await Promise.race([
        closing,
        new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, CLOSE_TIMEOUT_MS))),
      ]);
      socket.destroy();
    },
  };
}
