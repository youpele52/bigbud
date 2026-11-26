import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import type { PickerProofProductionProviderClient } from "./sshOwnerPickerProof.client.productionProvider.ts";
import type {
  ProviderLeaseScope,
  ProviderLeaseState,
} from "./sshOwnerPickerProof.codec.providerLease.ts";
import { PickerProofOwnerError } from "./sshOwnerPickerProof.codec.wire.ts";

/**
 * W2 T-prov: one production Pi/Codex owner lease exposed as the provider-neutral pipes, exit and
 * cancel handle the Pi and Codex owner ports already consume. Nothing here spawns or names a
 * program: the owner discovered and started the provider, and these are its two private sockets.
 *
 * Exit is event driven. The status verb is polled only after the provider's stdout has ended (or
 * on cancel), so a long session costs no owner round trips while it runs.
 *
 * @module sshOwnerProductionProviderLease
 */

export const PROVIDER_LEASE_CONNECT_TIMEOUT_MS = 5_000;
export const PROVIDER_LEASE_CLOSE_TIMEOUT_MS = 4_000;
const SETTLE_POLL_MS = 50;
const SETTLE_SLOW_POLL_MS = 500;
const SETTLE_FAST_POLLS = 100;

export type ProviderLeaseExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export interface ProviderLeaseSession {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles after final pipe data. Rejects when the owner cannot confirm an exit. */
  readonly exit: Promise<ProviderLeaseExit>;
}

export interface ProviderLeaseStart {
  readonly ready: Promise<ProviderLeaseSession>;
  /** Confirmed close of this exact lease, even before ready; idempotent. */
  readonly cancel: () => Promise<void>;
}

type LeaseClient = Pick<
  PickerProofProductionProviderClient,
  "openProviderLease" | "providerLeaseStatus" | "closeProviderLease"
>;

const settledPhase = (state: ProviderLeaseState) =>
  state.phase !== "listening" && state.phase !== "running";

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new PickerProofOwnerError("transportLost"));
    }, PROVIDER_LEASE_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const closed = (stream: Socket) =>
  stream.closed ? Promise.resolve() : new Promise<void>((resolve) => stream.once("close", resolve));

/** Opens the lease and returns its handle synchronously; acquisition continues in the background. */
export function startProductionProviderLease(
  client: LeaseClient,
  scope: ProviderLeaseScope,
  /** Runs before the open (for example the scope's own typed probe); a failure opens nothing. */
  preflight?: () => Promise<void>,
): ProviderLeaseStart {
  const lease = randomBytes(32);
  let cancelled = false;
  let sockets: Socket[] = [];
  let final: ProviderLeaseState | undefined;
  const opened = (preflight ? preflight() : Promise.resolve()).then(() =>
    client.openProviderLease(lease, scope),
  );
  void opened.catch(() => undefined);

  const pollSettled = async (): Promise<ProviderLeaseState> => {
    for (let poll = 0; ; poll += 1) {
      const state = await client.providerLeaseStatus(lease);
      if (settledPhase(state)) return (final = state);
      await new Promise((resolve) =>
        setTimeout(resolve, poll < SETTLE_FAST_POLLS ? SETTLE_POLL_MS : SETTLE_SLOW_POLL_MS),
      );
    }
  };

  const exitFrom = (state: ProviderLeaseState): ProviderLeaseExit => {
    if (state.phase === "exited") return { kind: "exited", code: state.exitCode };
    // Our own close settles as `closed`: the owner killed the session after stdin EOF.
    if (state.phase === "closed" && cancelled) return { kind: "signaled", signal: "SIGKILL" };
    throw new PickerProofOwnerError(
      state.phase === "unconfirmed" ? "outcomeUnknown" : "transportLost",
    );
  };

  const ready = (async (): Promise<ProviderLeaseSession> => {
    const state = await opened;
    if (state.phase !== "listening") throw new PickerProofOwnerError("protocolError");
    if (cancelled) throw new PickerProofOwnerError("outcomeUnknown");
    const connecting = [
      connectSocket(state.stdioSocketPath),
      connectSocket(state.stderrSocketPath),
    ] as const;
    const results = await Promise.allSettled(connecting);
    sockets = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    const [stdio, stderr] = sockets as [Socket, Socket];
    // Nothing is ever written to stderr: half-close it so it closes when the remote ends.
    stderr.end();
    if (cancelled) throw new PickerProofOwnerError("outcomeUnknown");
    const exit = Promise.all([closed(stdio), closed(stderr)])
      .then(pollSettled)
      .then(exitFrom);
    void exit.catch(() => undefined);
    return { stdin: stdio, stdout: stdio, stderr, exit };
  })();
  void ready.catch(() => undefined);

  let closing: Promise<void> | undefined;
  const cancel = () =>
    (closing ??= (async () => {
      cancelled = true;
      let state: ProviderLeaseState;
      try {
        state = await opened;
      } catch {
        // The owner refused the open: nothing was reserved or started.
        return;
      }
      await ready.catch(() => undefined);
      for (const socket of sockets) socket.end();
      // A lease the exit watcher already saw settle needs no second close.
      state = final ?? state;
      if (!settledPhase(state)) state = await client.closeProviderLease(lease);
      for (const socket of sockets) socket.destroy();
      if (state.phase === "unconfirmed" || !settledPhase(state))
        throw new PickerProofOwnerError("outcomeUnknown");
    })());

  return { ready, cancel };
}
