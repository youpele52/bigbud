import type { Duplex } from "node:stream";

import { waitForClientRelayReap } from "./clientRelay.ssh.reap.ts";

export interface ClientRelayDeployment {
  readonly nodeBinary: string;
  readonly nodeSha256: string;
  readonly helperEntry: string;
  readonly helperSha256: string;
  readonly authorityId: string;
}

/** Private profile admission output, not a renderer request or a command specification. */
export interface ClientRelayOwnerRequest {
  readonly executionTargetId: string;
  readonly deployment: ClientRelayDeployment;
}

export type ClientRelayOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string };

export interface ClientRelayOwnerLease {
  /** Backpressured binary stdin/stdout only. Ending stdin must leave final stdout readable. */
  readonly stream: Duplex;
  /** Confirm only on reap of the owned transport. Reject on loss of confirmation, not on nonzero exit. */
  readonly exit: Promise<ClientRelayOwnerExit>;
  /** Request termination of this lease only; delivery does not confirm reap. */
  readonly cancel: () => void | Promise<void>;
}

export interface ClientRelaySshOwner {
  /** Recheck exact-target trust and the pinned installation; no local launch fallback. The owner
   * must honor cancellation during acquisition and reap any transport it does not return. */
  readonly openClientRelay: (
    request: ClientRelayOwnerRequest,
    signal: AbortSignal,
  ) => Promise<ClientRelayOwnerLease>;
}

export function makeOwnedClientRelaySshChannels(
  request: ClientRelayOwnerRequest,
  owner: ClientRelaySshOwner,
) {
  const shutdown = new AbortController();
  const pending = new Set<Promise<Duplex>>();
  const reaps = new Set<Promise<void>>();
  let unconfirmed = false;
  let disposal: Promise<void> | undefined;

  async function open(signal: AbortSignal) {
    signal.throwIfAborted();
    const lease = await owner.openClientRelay(request, signal);
    const stream = lease.stream;
    let confirmed = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      // A driver may acknowledge cancellation before the transport has actually stopped.
      cancellation ??= Promise.resolve()
        .then(() => {
          if (!confirmed) return lease.cancel();
        })
        .catch(() => {});
    };
    const abort = () => {
      stream.destroy();
      cancel();
    };
    const closed = () => {
      signal.removeEventListener("abort", abort);
      cancel();
    };
    // Keep startup/teardown errors handled even before an HTTP socket has attached.
    stream.on("error", () => {});
    const reap = lease.exit
      .then(() => {
        confirmed = true;
        // Waitpid does not imply stdout is drained; don't destroy the stream on exit.
      })
      .catch(() => {
        unconfirmed = true;
        const error = new Error("SSH backend relay lost exit confirmation.");
        stream.destroy(error);
        throw error;
      });
    reaps.add(reap);
    void reap.then(
      () => reaps.delete(reap),
      () => reaps.delete(reap),
    );
    if (stream.closed) closed();
    else {
      stream.once("close", closed);
      signal.addEventListener("abort", abort, { once: true });
    }
    if (signal.aborted) {
      abort();
      await waitForClientRelayReap(reap);
      signal.throwIfAborted();
    }
    return stream;
  }

  return {
    openChannel(signal: AbortSignal): Promise<Duplex> {
      const ownedSignal = AbortSignal.any([signal, shutdown.signal]);
      const acquisition = Promise.resolve().then(() => open(ownedSignal));
      pending.add(acquisition);
      void acquisition.then(
        () => pending.delete(acquisition),
        () => pending.delete(acquisition),
      );
      return acquisition;
    },
    dispose() {
      shutdown.abort(new Error("Backend relay owner is disposed."));
      return (disposal ??= waitForClientRelayReap(
        (async () => {
          await Promise.allSettled(pending);
          await Promise.allSettled(reaps);
          if (unconfirmed) throw new Error("SSH backend relay lost exit confirmation.");
        })(),
      ));
    },
  };
}
