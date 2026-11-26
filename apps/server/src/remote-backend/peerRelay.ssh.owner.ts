import type { Duplex } from "node:stream";

import { PeerGrantId } from "@bigbud/contracts/server/remotePeer.ts";
import { PeerPairing, type PeerPairingId } from "@bigbud/contracts/server/remotePeer.pairing.ts";
import * as Schema from "effect/Schema";

import { waitForClientRelayReap } from "./clientRelay.ssh.reap.ts";
import type { PeerRelayChannel, PeerRelayChannelOutcome } from "./peerRelay.ssh.ts";

const timestamp = Schema.String.check(Schema.isNonEmpty());
const Approval = Schema.Struct({
  ...PeerPairing.fields,
  hostKeyConfirmedAt: timestamp,
  grantId: PeerGrantId,
  grantRecordedAt: timestamp,
  grantRevokedAt: Schema.Null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
type PeerRelayApproval = typeof Approval.Type;
const decodeApproval = Schema.decodeUnknownSync(Approval);

export class PeerRelayAdmissionError extends Error {
  constructor(readonly code: "authorization-refused" | "authentication-refused") {
    super(
      code === "authorization-refused"
        ? "The approved peer pairing is missing, revoked, or changed."
        : "The dedicated coordinator identity no longer matches the peer grant.",
    );
    this.name = "PeerRelayAdmissionError";
  }
}

function approvedPairing(pairing: PeerPairing): PeerRelayApproval {
  try {
    // Project only persisted pairing fields (never args, env, key paths, or worker credentials).
    return Object.freeze(decodeApproval(pairing, { onExcessProperty: "ignore" }));
  } catch {
    throw new PeerRelayAdmissionError("authorization-refused");
  }
}

export interface PeerRelayOwnerRequest {
  readonly pairing: PeerRelayApproval;
  readonly recipe: "paired-peer-forced-command";
}

export type PeerRelayOwnerExit =
  | { readonly kind: "exited"; readonly code: number }
  | { readonly kind: "signaled"; readonly signal: string }
  | {
      readonly kind: "setup-refused";
      readonly reason: "host-identity-mismatch" | "authentication-refused";
    };

export interface PeerRelayOwnerLease {
  /** Backpressured binary stdin/stdout, with independent half-close and no stderr mixed in. */
  readonly stream: Duplex;
  /** Confirm local transport reap; reject when termination cannot be confirmed. */
  readonly exit: Promise<PeerRelayOwnerExit>;
  /** Terminate this lease only; acknowledgement is not exit confirmation. */
  readonly cancel: () => void | Promise<void>;
}

export interface PeerRelaySshOwner {
  /** Read the saved approval and fingerprint of the actual dedicated identity without creating a
   * key, scanning a host, releasing credentials, or consulting ordinary user SSH trust. */
  readonly resolvePeerRelayApproval: (
    pairingId: PeerPairingId,
    signal: AbortSignal,
  ) => Promise<
    | {
        readonly pairing: PeerPairing;
        readonly coordinatorKeyFingerprint: string;
      }
    | undefined
  >;
  /** At dispatch, recheck the exact current pairing and dedicated credential against this binding
   * (preflight is not a grant). Use only the fixed peer exec trigger, pinned worker key and
   * dedicated coordinator key, isolated from user configuration, masters, agents and forwarding.
   * Honor cancellation during acquisition and reap anything not returned. The worker still checks
   * its separate product grant. No fallback, credential repair, or replay. */
  readonly openPeerRelay: (
    request: PeerRelayOwnerRequest,
    signal: AbortSignal,
  ) => Promise<PeerRelayOwnerLease>;
}

function classifyExit(exit: PeerRelayOwnerExit): PeerRelayChannelOutcome {
  if (exit.kind === "setup-refused") return exit.reason;
  return exit.kind === "exited" && exit.code === 0 ? "closed" : "unreachable";
}

/** Explicitly selected peer-only path. The legacy launcher is not consulted. */
export function makeOwnedPeerRelaySshChannels(pairing: PeerPairing, owner: PeerRelaySshOwner) {
  const approved = approvedPairing(pairing);
  const keys = Object.keys(approved) as Array<keyof PeerRelayApproval>;
  const request: PeerRelayOwnerRequest = Object.freeze({
    pairing: approved,
    recipe: "paired-peer-forced-command",
  });
  const shutdown = new AbortController();
  const pending = new Set<Promise<PeerRelayChannel>>();
  const reaps = new Set<Promise<void>>();
  let unconfirmed = false;
  let disposal: Promise<void> | undefined;

  async function open(signal: AbortSignal): Promise<PeerRelayChannel> {
    signal.throwIfAborted();
    const current = await owner.resolvePeerRelayApproval(approved.pairingId, signal);
    signal.throwIfAborted();
    if (!current) throw new PeerRelayAdmissionError("authorization-refused");
    const currentApproval = approvedPairing(current.pairing);
    if (!keys.every((key) => approved[key] === currentApproval[key])) {
      throw new PeerRelayAdmissionError("authorization-refused");
    }
    if (current.coordinatorKeyFingerprint !== approved.coordinatorKeyFingerprint) {
      throw new PeerRelayAdmissionError("authentication-refused");
    }
    const lease = await owner.openPeerRelay(request, signal);
    const { stream } = lease;
    let confirmed = false;
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
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
    stream.on("error", () => {});
    const outcome = lease.exit.then(
      (exit): PeerRelayChannelOutcome => {
        confirmed = true;
        // Reap is not EOF; let buffered final stdout drain after stdin is closed.
        return classifyExit(exit);
      },
      (): PeerRelayChannelOutcome => {
        unconfirmed = true;
        stream.destroy(new Error("SSH peer relay lost exit confirmation."));
        cancel();
        return "unreachable";
      },
    );
    const reap = outcome.then(() => {});
    reaps.add(reap);
    void reap.then(() => reaps.delete(reap));
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
    return { stream, outcome };
  }

  return {
    openChannel(signal: AbortSignal): Promise<PeerRelayChannel> {
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
      shutdown.abort(new Error("Peer relay owner is disposed."));
      return (disposal ??= waitForClientRelayReap(
        (async () => {
          await Promise.allSettled(pending);
          await Promise.all(reaps);
          if (unconfirmed) throw new Error("SSH peer relay lost exit confirmation.");
        })(),
      ));
    },
  };
}
